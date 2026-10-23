import {
  AddEquation, BufferAttribute, CustomBlending, DoubleSide, DynamicDrawUsage, GLSL3, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, OneFactor, OneMinusSrcAlphaFactor, RawShaderMaterial, Scene, Vector4,
} from "three";
import { marksFragment, marksVertex } from "./shaders.js";

// The instrument's marks: hairlines, dashes, dots, calipers, frames and filaments, each one a
// screen-space capsule (a segment with a half-width) in css px, instanced. Stations write them every
// frame from projected points. Two layers share the primitive:
//   ink   drawn over the finished plate at the canvas's full resolution, so a 1 px rule stays 1 px;
//   glow  added into the plate before the composite as light, so filaments and lattice columns are
//         exposed like everything else: tone-mapped, grained, and haloed when warm.

const MAX = 3072;

// Colours by role. Ink marks take display colours with an alpha; glow marks take light in linear
// units, with the warm share in the fourth channel (the composite turns that into halation).
export const INK = [0.9098, 0.9176, 0.902];
export const WARM = [1, 0.3529, 0.1686];
export const COOL = [0.6118, 0.7843, 0.8235];
export const DATA = [0.4157, 0.4549, 0.4392]; // #6A7470, ticks and axes that carry data
export const MUTED = [0.6392, 0.6667, 0.651];
export const RESEAU = [0.1725, 0.2039, 0.1922];
export const LIGHT_INK = [0.807, 0.823, 0.791];
export const LIGHT_COOL = [0.332, 0.578, 0.644];

export function createMarks() {
  const ink = layer({
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
  }, 0);
  const glow = layer({
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  }, 1);
  return {
    ink,
    glow,
    begin() {
      ink.begin();
      glow.begin();
    },
    end() {
      ink.end();
      glow.end();
    },
    // view: css size; inkScale: canvas px per css px; glowScale: plate px per css px
    setView(w, h, inkScale, glowScale) {
      ink.uniforms.uView.value.set(w, h, inkScale, 0);
      glow.uniforms.uView.value.set(w, h, glowScale, 1);
    },
    // a rectangle (css px) outside which marks fade by `amount`; amount 0 leaves them unclipped
    setClip(x0, y0, x1, y1, amount) {
      for (const l of [ink, glow]) {
        l.uniforms.uClip.value.set(x0, y0, x1, y1);
        l.uniforms.uClipAmount.value = amount;
      }
    },
    setFade(value) {
      ink.uniforms.uFade.value = value;
      glow.uniforms.uFade.value = value;
    },
    dispose() {
      ink.dispose();
      glow.dispose();
    },
  };
}

function layer(blend, glow) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("corner", new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const seg = new Float32Array(MAX * 4);
  const style = new Float32Array(MAX * 4);
  const color = new Float32Array(MAX * 4);
  const attrs = [
    ["aSeg", seg],
    ["aStyle", style],
    ["aColor", color],
  ].map(([name, array]) => {
    const a = new InstancedBufferAttribute(array, 4);
    a.setUsage(DynamicDrawUsage);
    geometry.setAttribute(name, a);
    return a;
  });
  geometry.instanceCount = 0;
  const uniforms = {
    uView: { value: new Vector4(1, 1, 1, glow) },
    uClip: { value: new Vector4(-1e5, -1e5, 1e5, 1e5) },
    uClipAmount: { value: 0 },
    uFade: { value: 1 },
  };
  const material = new RawShaderMaterial({
    name: glow ? "overseer-marks-glow" : "overseer-marks-ink",
    glslVersion: GLSL3,
    vertexShader: marksVertex,
    fragmentShader: marksFragment,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // the quads are built in y-down css px, which flips their winding
    side: DoubleSide,
    ...blend,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.add(mesh);
  let n = 0;

  const api = {
    scene,
    uniforms,
    get count() {
      return n;
    },
    begin() {
      n = 0;
    },
    // A segment from (ax, ay) to (bx, by), css px. o: { w half-width (css px), c colour, a alpha,
    // dash period px, duty 0..1, offset px, butt caps, sigma (glow spread px) }
    line(ax, ay, bx, by, o) {
      if (n >= MAX || !(o.a > 0.002)) return api;
      if (!Number.isFinite(ax + ay + bx + by)) return api;
      const i = n * 4;
      seg[i] = ax; seg[i + 1] = ay; seg[i + 2] = bx; seg[i + 3] = by;
      style[i] = o.w ?? 0.5;
      style[i + 1] = o.dash ?? 0;
      style[i + 2] = o.duty ?? 0.5;
      // the sign carries the cap style, the magnitude the glow spread (or the dash offset for ink)
      style[i + 3] = (o.butt ? -1 : 1) * (glow ? Math.max(0.5, o.sigma ?? 2) : 1 + Math.abs(o.offset ?? 0));
      const c = o.c ?? INK;
      if (glow) {
        const e = o.a;
        color[i] = c[0] * e; color[i + 1] = c[1] * e; color[i + 2] = c[2] * e; color[i + 3] = (o.warm ?? 0) * e;
      } else {
        color[i] = c[0] * o.a; color[i + 1] = c[1] * o.a; color[i + 2] = c[2] * o.a; color[i + 3] = o.a;
      }
      n++;
      return api;
    },
    dot(x, y, r, o) {
      return api.line(x, y, x, y, { ...o, w: r });
    },
    // A run of butt-ended segments: seamless, since no two of them cover the same pixels.
    polyline(points, o, closed = false) {
      const seg = { ...o, butt: true };
      for (let k = 1; k < points.length; k++) api.line(points[k - 1][0], points[k - 1][1], points[k][0], points[k][1], seg);
      if (closed && points.length > 2) api.line(points.at(-1)[0], points.at(-1)[1], points[0][0], points[0][1], seg);
      return api;
    },
    // A registration target: a ring with a cross broken at the ring.
    target(x, y, r, o) {
      const ring = [];
      for (let k = 0; k <= 24; k++) ring.push([x + Math.cos((k / 24) * Math.PI * 2) * r, y + Math.sin((k / 24) * Math.PI * 2) * r]);
      api.polyline(ring, o);
      api.line(x - r * 2.2, y, x - r * 1.25, y, o).line(x + r * 1.25, y, x + r * 2.2, y, o);
      api.line(x, y - r * 2.2, x, y - r * 1.25, o).line(x, y + r * 1.25, x, y + r * 2.2, o);
      return api;
    },
    end() {
      geometry.instanceCount = n;
      for (const a of attrs) {
        a.clearUpdateRanges();
        if (n) {
          a.addUpdateRange(0, n * 4);
          a.needsUpdate = true;
        }
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
  return api;
}
