import {
  BufferAttribute, BufferGeometry, Camera, GLSL3, HalfFloatType, LinearFilter, Mesh, NoBlending, RawShaderMaterial,
  RGBAFormat, Scene, UnsignedByteType, Vector2, Vector4, WebGLRenderer, WebGLRenderTarget,
} from "three";
import { blurFragment, compositeFragment, downsampleFragment, fullscreenVertex } from "./shaders.js";

const PLATE_PIXELS = 2.0e6; // particles render at min(DPR, 1.5), capped near 2 megapixels
const HALO_SIGMA = 22; // css px
// Without a float target the plate is 8-bit: particles write a third of their light and the
// composite scales it back, so cores don't clip; the grain hides the banding.
const EIGHT_BIT_SCALE = 1 / 3;

// The page creates the context (boot.js, on this canvas, with these attributes) and hands it over, so
// there is one context for the whole visit; without one this creates it. A missing WebGL2 is a quiet
// fallback. The extensions three asks for lazily are enabled here, at once: on some drivers the first
// query costs a long stall in the middle of the first frame. three's per-shader error checks (several
// synchronous calls a program) are off; the world checks link status once after its first frame.
export function createRenderer(canvas, { allowSoftware = false, float: allowFloat = true, context = null, attributes = null } = {}) {
  const attrs = attributes ?? {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
    failIfMajorPerformanceCaveat: !allowSoftware,
  };
  const gl = context ?? canvas.getContext("webgl2", attrs);
  if (!gl) throw new Error("world: WebGL2 is unavailable");
  for (const name of ["EXT_texture_filter_anisotropic", "EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear", "KHR_parallel_shader_compile"]) gl.getExtension(name);
  const renderer = new WebGLRenderer({ canvas, context: gl, ...attrs });
  renderer.debug.checkShaderErrors = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  const ext = renderer.extensions;
  const float = allowFloat && (ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"));
  return { renderer, float };
}

export function createPasses(renderer, float) {
  const type = float ? HalfFloatType : UnsignedByteType;
  const target = () =>
    new WebGLRenderTarget(1, 1, {
      type, format: RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
    });
  const plate = target();
  const haloA = target();
  const haloB = target();

  const triangle = new BufferGeometry();
  triangle.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const camera = new Camera();
  const pass = (name, fragmentShader, uniforms) => {
    const material = new RawShaderMaterial({
      name, glslVersion: GLSL3, vertexShader: fullscreenVertex, fragmentShader, uniforms,
      depthTest: false, depthWrite: false, blending: NoBlending,
    });
    const mesh = new Mesh(triangle, material);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.add(mesh);
    return { scene, material, uniforms };
  };

  const down = pass("overseer-halation-down", downsampleFragment, { tSrc: { value: plate.texture }, uTexel: { value: new Vector2() } });
  const blurUniforms = () => ({
    tSrc: { value: null }, uDir: { value: new Vector2() },
    uOffset: { value: new Array(12).fill(0) }, uWeight: { value: new Array(12).fill(0) }, uCenter: { value: 1 },
  });
  const blurH = pass("overseer-halation-h", blurFragment, blurUniforms());
  const blurV = pass("overseer-halation-v", blurFragment, blurUniforms());
  blurH.uniforms.tSrc.value = haloA.texture;
  blurV.uniforms.tSrc.value = haloB.texture;

  const vec4s = (n) => Array.from({ length: n }, () => new Vector4());
  const composite = pass("overseer-composite", compositeFragment, {
    tPlate: { value: plate.texture },
    tHalo: { value: haloA.texture },
    uView: { value: new Vector4(1, 1, 1, 0) },
    uTone: { value: new Vector4(0, float ? 1 : 1 / EIGHT_BIT_SCALE, 0, 0) },
    uOptic: { value: new Vector4() },
    uGrainB: { value: new Vector4(0, 2.2, 1, 0) },
    uIris: { value: new Vector4() },
    uIrisB: { value: new Vector4() },
    uLobeT: { value: vec4s(8) },
    uLobeTB: { value: vec4s(8) },
    uLobeR: { value: vec4s(8) },
    uLobeRB: { value: vec4s(8) },
    uLobeCount: { value: 0 },
    uLeak: { value: new Vector4(0, 0, 1, 0) },
    uLeakB: { value: new Vector4(1, 1, 0, 0) },
    uSample: { value: vec4s(8) },
    uMarks: { value: new Vector4() },
    uLevels: { value: new Vector4(0.16, 0.38, 0.62, 7) },
    uReseau: { value: new Vector4(64, 0.015, 0.06, 0.025) },
    uField: { value: new Vector4(0, 0, 1e5, 1e5) },
    uFieldB: { value: new Vector4(0, 0, 0, 0) },
    uSampleB: { value: vec4s(8) },
  });

  const size = { cssW: 1, cssH: 1, dpr: 1, plateScale: 1, plateW: 1, plateH: 1 };

  function resize(cssW, cssH, dpr) {
    size.cssW = cssW;
    size.cssH = cssH;
    size.dpr = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssW, cssH, false);
    let scale = Math.min(dpr, 1.5);
    if (cssW * cssH * scale * scale > PLATE_PIXELS) scale = Math.sqrt(PLATE_PIXELS / (cssW * cssH));
    size.plateScale = scale;
    size.plateW = Math.max(1, Math.round(cssW * scale));
    size.plateH = Math.max(1, Math.round(cssH * scale));
    plate.setSize(size.plateW, size.plateH);
    const qw = Math.max(1, Math.ceil(size.plateW / 4));
    const qh = Math.max(1, Math.ceil(size.plateH / 4));
    haloA.setSize(qw, qh);
    haloB.setSize(qw, qh);
    down.uniforms.uTexel.value.set(1 / size.plateW, 1 / size.plateH);
    const sigma = (HALO_SIGMA * scale) / 4;
    const kernel = gaussianKernel(sigma);
    for (const blur of [blurH, blurV]) {
      blur.uniforms.uOffset.value = kernel.offsets;
      blur.uniforms.uWeight.value = kernel.weights;
      blur.uniforms.uCenter.value = kernel.center;
    }
    blurH.uniforms.uDir.value.set(kernel.stride / qw, 0);
    blurV.uniforms.uDir.value.set(0, kernel.stride / qh);
    composite.uniforms.uView.value.set(cssW, cssH, dpr, composite.uniforms.uView.value.w);
  }

  function renderPlate(scene, sceneCamera) {
    renderer.setRenderTarget(plate);
    renderer.clear(true, false, false);
    renderer.render(scene, sceneCamera);
  }

  function renderHalation() {
    renderer.setRenderTarget(haloA);
    renderer.render(down.scene, camera);
    renderer.setRenderTarget(haloB);
    renderer.render(blurH.scene, camera);
    renderer.setRenderTarget(haloA);
    renderer.render(blurV.scene, camera);
  }

  function clearHalation() {
    renderer.setRenderTarget(haloA);
    renderer.clear(true, false, false);
  }

  function renderComposite() {
    renderer.setRenderTarget(null);
    renderer.render(composite.scene, camera);
  }

  // Extra light added into the plate after the particles (the glow marks), and marks drawn over the
  // finished canvas (the ink marks). Neither clears.
  function addToPlate(scene) {
    renderer.setRenderTarget(plate);
    renderer.render(scene, camera);
  }
  function drawOver(scene) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  function clearCanvas() {
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
  }

  return {
    size,
    float,
    composite: composite.uniforms,
    scenes: [down.scene, blurH.scene, blurV.scene, composite.scene],
    camera,
    resize,
    renderPlate,
    renderHalation,
    clearHalation,
    renderComposite,
    addToPlate,
    drawOver,
    clearCanvas,
    particleScale: float ? 1 : EIGHT_BIT_SCALE,
    dispose() {
      for (const t of [plate, haloA, haloB]) t.dispose();
      for (const p of [down, blurH, blurV, composite]) p.material.dispose();
      triangle.dispose();
    },
  };
}

// A 1D gaussian as 12 bilinear taps per side (two texels each). Wider kernels spread the taps; the
// 4x4 box downsample has already removed what that would alias.
function gaussianKernel(sigma) {
  const stride = Math.max(1, sigma / 8.5);
  const s = sigma / stride;
  const w = [];
  let total = 0;
  for (let k = 0; k <= 24; k++) {
    w[k] = Math.exp((-k * k) / (2 * s * s));
    total += k === 0 ? w[k] : 2 * w[k];
  }
  const offsets = [];
  const weights = [];
  for (let m = 1; m <= 12; m++) {
    const a = w[2 * m - 1] / total;
    const b = w[2 * m] / total;
    weights.push(a + b);
    offsets.push(a + b > 0 ? ((2 * m - 1) * a + 2 * m * b) / (a + b) : 0);
  }
  return { center: w[0] / total, offsets, weights, stride };
}
