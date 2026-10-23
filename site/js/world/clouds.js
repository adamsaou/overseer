import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, GLSL3, OneFactor, Points, RawShaderMaterial, Vector4 } from "three";
import { lowDiscrepancyAssign, MAX_LOBES } from "./layout.js";
import { mulberry32, TAU } from "./math.js";
import { particleFragment, particleVertex } from "./shaders.js";

// Particles per cloud for each tier. Targets and references alternate in the buffer and every
// prefix keeps the scan's cluster ratios, so a lower tier is only a shorter draw range.
export const TIERS = [12000, 6000, 3000];

const vec4s = (n) => Array.from({ length: n }, () => new Vector4());

export function createClouds(layout, perCloud = TIERS[0]) {
  const count = perCloud * 2;
  const offsets = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  const info = new Float32Array(count * 4);
  const rand = mulberry32(0x0b5e55);
  const homeT = lowDiscrepancyAssign(layout.P, perCloud, 0.11);
  const startT = lowDiscrepancyAssign(layout.Q, perCloud, 0.57);
  const homeR = lowDiscrepancyAssign(layout.Q, perCloud, 0.83);
  for (let i = 0; i < perCloud; i++) {
    for (let cloud = 0; cloud < 2; cloud++) {
      const j = i * 2 + cloud;
      // Most answers sit in the lobe's core; one in seven scatters wider, so lobes fade like matter.
      // Points past 3 sigma are drawn again (not clamped, which would pile them into a visible shell),
      // so the clouds stay inside the zone the page gives them. Box-Muller, inlined: this runs 24k times
      // on the main thread at start.
      const scatter = rand() < 0.14 ? 1.6 : 1;
      const limit = 9 / (scatter * scatter);
      let a, b, c;
      do {
        const r1 = Math.sqrt(-2 * Math.log(1 - rand()));
        const t1 = TAU * rand();
        const r2 = Math.sqrt(-2 * Math.log(1 - rand()));
        a = r1 * Math.cos(t1);
        b = r1 * Math.sin(t1);
        c = r2 * Math.cos(TAU * rand());
      } while (a * a + b * b + c * c > limit);
      offsets[j * 3] = a * scatter;
      offsets[j * 3 + 1] = b * scatter;
      offsets[j * 3 + 2] = c * scatter;
      for (let k = 0; k < 4; k++) seeds[j * 4 + k] = rand();
      const home = cloud === 0 ? homeT[i] : homeR[i];
      info[j * 4] = cloud;
      info[j * 4 + 1] = home;
      info[j * 4 + 2] = cloud === 0 ? startT[i] : home;
      info[j * 4 + 3] = cloud === 0 ? layout.lobes[home].warm : 0;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(offsets, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 4));
  geometry.setAttribute("aInfo", new BufferAttribute(info, 4));

  const uniforms = {
    uLobe: { value: vec4s(MAX_LOBES) },
    uShape: { value: vec4s(MAX_LOBES) },
    uAtlas: { value: new Vector4() },
    uAtlasShape: { value: new Vector4() },
    uClock: { value: new Vector4() },
    uView: { value: new Vector4(1, 1, 1, 1) },
    uIris: { value: new Vector4() },
    uFocus: { value: new Vector4() },
    uLevel: { value: new Vector4(1, 0.7, 0, 0) },
    uMix: { value: new Vector4(0, 1, 1, 1) },
    uExtra: { value: new Vector4() },
    uBokeh: { value: new Vector4(0, 0.62, 0.1, 0) },
    uForm: { value: new Vector4(0, 0, -1, 0) },
    uField: { value: new Vector4(0, 0, 0, 0) },
    uFormB: { value: new Vector4(0, 1, 1, 0) },
    uCellA: { value: vec4s(18) },
    uCellB: { value: vec4s(18) },
  };
  layout.lobes.forEach((lobe, i) => {
    uniforms.uLobe.value[i].set(...lobe.center, lobe.sigma);
    uniforms.uShape.value[i].set(...lobe.shape);
  });
  uniforms.uAtlas.value.set(...layout.atlas.center, layout.atlas.sigma);
  uniforms.uAtlasShape.value.set(...layout.atlas.shape);

  const material = new RawShaderMaterial({
    name: "overseer-clouds",
    glslVersion: GLSL3,
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    uniforms,
    perCloud,
    setTier(particles) {
      geometry.setDrawRange(0, Math.min(perCloud, particles) * 2);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

