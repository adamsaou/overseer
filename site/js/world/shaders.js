// GLSL ES 3.00 sources. three adds `#version 300 es` (glslVersion GLSL3) and nothing else, since
// every material here is a RawShaderMaterial.

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
`;

// One THREE.Points object draws both clouds. All motion lives here, driven by per-particle seeds and
// a few small uniform arrays; no buffer is uploaded after the first frame.
export const particleVertex = HEADER + /* glsl */ `
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform vec4 uLobe[8];   // centre xyz, sigma (world units)
uniform vec4 uShape[8];  // stretch x, y, z, angle in the plate plane
uniform vec4 uAtlas;     // the merged body: centre xyz, sigma
uniform vec4 uAtlasShape;
uniform vec4 uClock;     // time s, breath sine, drift amplitude, mass transfer 0..1
uniform vec4 uView;      // css width, css height, particle px per css px, css px per world unit at the subject
uniform vec4 uIris;      // centre xy (css px), aperture radius, housing radius
uniform vec4 uFocus;     // focal depth, coc px per unit inside, coc px outside, coc px per unit outside
uniform vec4 uLevel;     // target level, reference level, reference extra coc px, global coc px (mid-move)
uniform vec4 uMix;       // merge into Atlas, show target, show reference, energy scale
uniform vec4 uExtra;     // reference depth offset, warm factor, subject depth, core size (world units)
uniform vec4 uForm;      // flatten onto the plate, lattice amount, focused lattice cell (-1 none), focus amount
uniform vec4 uField;     // the station's field rect x0, y0, x1, y1 (css px): inside it counts as the aperture
uniform vec4 uFormB;     // field amount, column height per unit score, lattice energy, unused
uniform vec4 uCellA[18]; // lattice cells: x, plate y, z, score
uniform vec4 uCellB[18]; // interval lo, hi, cumulative share of the plate's particles, measured

in vec3 position;        // N(0, 1) offset inside the lobe
in vec4 aSeed;           // four uniforms: drift phase, size, brightness, transfer stagger
in vec4 aInfo;           // cloud (0 target, 1 reference), home lobe, start lobe, warm share of home lobe

out vec3 vColor;
out float vEnergy;
out float vWarm;
out float vBokeh;
out float vAA;
out float vStar;

const vec3 INK = vec3(0.807, 0.823, 0.791);
const vec3 COOL = vec3(0.332, 0.578, 0.644);

vec3 lobePoint(int i, vec3 g) {
  vec4 s = uShape[i];
  vec3 o = g * s.xyz;
  float c = cos(s.w), n = sin(s.w);
  o.xy = vec2(c * o.x - n * o.y, n * o.x + c * o.y);
  return uLobe[i].xyz + o * uLobe[i].w;
}

float rnd(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return float((w >> 22u) ^ w) / 4294967295.0;
}

void main() {
  float isRef = aInfo.x;
  float breath = 1.0 + 0.02 * uClock.y;
  vec3 g = position * breath;
  vec3 p = lobePoint(int(aInfo.y), g);
  float arrived = 1.0;
  if (isRef < 0.5) {
    // The target's answers leave the reference's clusters for their own as the scan's mass transfers.
    float k = clamp((uClock.w - aSeed.w * 0.7) / 0.3, 0.0, 1.0);
    arrived = k * k * (3.0 - 2.0 * k);
    vec3 from = lobePoint(int(aInfo.z), g);
    p = mix(from, p, arrived);
    p.z += 0.3 * sin(3.14159265 * arrived) * (aSeed.x - 0.5);
    vec4 s = uAtlasShape;
    vec3 o = g * s.xyz;
    float c = cos(s.w), n = sin(s.w);
    o.xy = vec2(c * o.x - n * o.y, n * o.x + c * o.y);
    p = mix(p, uAtlas.xyz + o * uAtlas.w, uMix.x);
  } else {
    p.z += uExtra.x;
  }
  // Laid flat on the measuring plate (the entropy station), so the blink is registered.
  p.z *= 1.0 - uForm.x;

  // The oversight-gap lattice: each particle streams into one measured cell of its cloud's plate (the
  // target's into scans off, the reference's into scans on), into the column, its interval's haze or,
  // for a measured zero, the ring on the floor. Cells that weren't run take none.
  float lattice = 0.0;
  float gain = 1.0;
  int cell = -1;
  if (uForm.y > 0.0) {
    uint id = uint(gl_VertexID) * 3u;
    float r1 = rnd(id + 1u), r2 = rnd(id + 2u), r3 = rnd(id + 3u);
    int first = isRef > 0.5 ? 9 : 0;
    for (int c = 0; c < 9; c++) {
      vec4 b = uCellB[first + c];
      if (b.w > 0.5 && r1 < b.z) { cell = first + c; break; }
    }
    lattice = clamp((uForm.y - aSeed.w * 0.45) / 0.55, 0.0, 1.0);
    lattice = lattice * lattice * (3.0 - 2.0 * lattice);
    vec3 dest = p;
    float g = 0.0;
    if (cell >= 0) {
      vec4 a = uCellA[cell];
      vec4 b = uCellB[cell];
      if (r2 < 0.3) {
        dest = vec3(a.x + position.x * 0.07, a.y + mix(b.x, b.y, r3) * uFormB.y, a.z + position.z * 0.07);
        g = 0.32;
      } else if (a.w > 0.001) {
        dest = vec3(a.x + position.x * 0.026, a.y + r3 * a.w * uFormB.y, a.z + position.z * 0.026);
        g = 1.0;
      } else {
        float ang = r3 * 6.2831853;
        dest = vec3(a.x + cos(ang) * (0.17 + 0.006 * position.x), a.y + 0.004 * position.y, a.z + sin(ang) * (0.17 + 0.006 * position.z));
        g = 0.42;
      }
      if (uForm.w > 0.0) g *= cell == int(uForm.z + 0.5) ? 1.0 + 0.6 * uForm.w : 1.0 - 0.45 * uForm.w;
    }
    p = mix(p, dest, lattice);
    gain = mix(1.0, g * uFormB.z, lattice);
  }
  float t = uClock.x;
  p += uClock.z * vec3(
    sin(t * 0.21 + aSeed.x * 6.2831853 + p.y * 1.9),
    sin(t * 0.17 + aSeed.y * 6.2831853 + p.z * 2.3),
    sin(t * 0.13 + aSeed.z * 6.2831853 + p.x * 1.7));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vec2 ndc = gl_Position.xy / gl_Position.w;
  vec2 px = vec2((ndc.x * 0.5 + 0.5) * uView.x, (0.5 - 0.5 * ndc.y) * uView.y);
  float depth = -mv.z;

  // Sharp inside the iris (or the station's field), nine-sided bokeh outside it; the change happens
  // under the blades.
  float inside = 1.0 - smoothstep(uIris.z * 0.85, max(uIris.w, uIris.z * 0.85 + 1.0), length(px - uIris.xy));
  vec2 inField = step(uField.xy, px) * step(px, uField.zw);
  inside = max(inside, uFormB.x * inField.x * inField.y);
  float dz = abs(depth - uFocus.x);
  float coc = mix(min(uFocus.z + dz * uFocus.w, 8.0), dz * uFocus.y, inside);
  coc += uLevel.w + isRef * uLevel.z;
  float scale = uExtra.z / depth;
  float core = uExtra.w * uView.w * scale * (0.75 + 0.5 * aSeed.y);
  float size = clamp(max(core, coc), 1.25, 8.0);
  gl_PointSize = size * uView.z;

  float level = mix(uLevel.x * uMix.y, uLevel.y * uMix.z, isRef);
  float bokeh = smoothstep(2.3, 4.0, size);
  float star = step(0.992, aSeed.z);
  // Resolved points vary like stars; defocused ones merge into an even haze, except the brightest,
  // which stay visible as nine-sided discs the way bright points do on a real out-of-focus plate.
  float bright = mix(0.55 + 0.9 * aSeed.z * aSeed.z, 0.92 + 0.16 * aSeed.z, bokeh) + star * 2.6;
  vEnergy = level * bright * gain * (1.0 + 0.05 * uClock.y) * uMix.w * scale * scale / (size * size);
  vColor = mix(INK, COOL, isRef);
  vWarm = (1.0 - isRef) * aInfo.w * arrived * (1.0 - uMix.x) * uExtra.y * (1.0 - lattice);
  vBokeh = bokeh;
  vStar = star;
  vAA = 1.6 / max(gl_PointSize, 1.0);
}
`;

export const particleFragment = HEADER + /* glsl */ `
uniform vec4 uBokeh;     // rotation, roundness, rim, unused

in vec3 vColor;
in float vEnergy;
in float vWarm;
in float vBokeh;
in float vAA;
in float vStar;

out vec4 fragColor;

const float SEG = 0.6981317008;   // 2π / 9
const float INRADIUS = 0.9396926; // cos(π / 9)

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  float star = exp(-4.0 * r * r) * 5.1;                      // normalised to unit mean over the sprite
  float a = atan(uv.y, uv.x) + uBokeh.x;
  float poly = r * cos(SEG * floor(a / SEG + 0.5) - a) / INRADIUS;
  float shape = mix(r, poly, uBokeh.y);
  // Most defocused points are soft nonagons that merge into haze; the brightest keep a hard edge
  // and a faint rim, which is all a real lens shows of individual points out of focus.
  float edge = mix(0.32, vAA, vStar);
  float disc = 1.0 - smoothstep(0.86 - edge, 0.86 + edge * 0.4, shape);
  disc *= 1.0 + uBokeh.z * vStar * smoothstep(0.42, 0.86, shape);
  float k = mix(star, disc * mix(2.2, 1.48, vStar), vBokeh);
  if (k < 0.004) discard;
  float e = vEnergy * k;
  fragColor = vec4(vColor * e, vWarm * e);
}
`;

// The marks: screen-space capsules (marks.js). The quad covers the segment plus its half-width and
// a margin for antialiasing or glow; the fragment measures the distance to the segment.
export const marksVertex = HEADER + /* glsl */ `
uniform vec4 uView;   // css width, css height, target px per css px, glow layer (1) or ink (0)
in vec2 corner;
in vec4 aSeg;         // a.xy, b.xy (css px)
in vec4 aStyle;       // half-width, dash period, dash duty, cap sign * (glow: sigma | ink: 1 + dash offset)
in vec4 aColor;
out vec2 vLocal;      // along the segment from a, across it (css px)
out vec2 vPx;         // css px, for the clip
out float vLen;
out vec4 vStyle;
out vec4 vColor;
void main() {
  vec2 a = aSeg.xy, b = aSeg.zw;
  vec2 d = b - a;
  float len = length(d);
  vec2 t = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float spread = uView.w > 0.5 ? abs(aStyle.w) * 3.0 : 1.5 / max(uView.z, 0.5);
  float pad = aStyle.x + spread + 1.0;
  vec2 p = (corner.x < 0.0 ? a - t * pad : b + t * pad) + n * corner.y * pad;
  vLocal = vec2(dot(p - a, t), dot(p - a, n));
  vPx = p;
  vLen = len;
  vStyle = aStyle;
  vColor = aColor;
  gl_Position = vec4(p.x / uView.x * 2.0 - 1.0, 1.0 - p.y / uView.y * 2.0, 0.0, 1.0);
}
`;

export const marksFragment = HEADER + /* glsl */ `
uniform vec4 uView;
uniform vec4 uClip;      // x0, y0, x1, y1 (css px)
uniform float uClipAmount;
uniform float uFade;
in vec2 vLocal;
in vec2 vPx;
in float vLen;
in vec4 vStyle;
in vec4 vColor;
out vec4 fragColor;
void main() {
  // Butt-ended segments cover exactly their own length, so a polyline made of them has no doubled
  // joints; round-capped ones are capsules (dots, single strokes).
  bool butt = vStyle.w < 0.0;
  if (butt && (vLocal.x < 0.0 || vLocal.x >= max(vLen, 0.001))) discard;
  float along = clamp(vLocal.x, 0.0, vLen);
  float d = butt ? abs(vLocal.y) : length(vec2(vLocal.x - along, vLocal.y));
  float k;
  if (uView.w > 0.5) {
    float s = abs(vStyle.w);
    float e = max(0.0, d - vStyle.x);
    k = exp(-0.5 * e * e / (s * s));
  } else {
    float aa = 0.5 / max(uView.z, 0.5);
    k = clamp((vStyle.x - d) / (2.0 * aa) + 0.5, 0.0, 1.0);
    // hairlines thinner than a device pixel keep their weight as coverage
    k *= min(1.0, vStyle.x * 2.0 * uView.z);
  }
  if (vStyle.y > 0.0) {
    float offset = uView.w > 0.5 ? 0.0 : abs(vStyle.w) - 1.0;
    k *= step(fract((vLocal.x + offset) / vStyle.y), vStyle.z);
  }
  vec2 inside = step(uClip.xy, vPx) * step(vPx, uClip.zw);
  k *= mix(1.0, inside.x * inside.y, uClipAmount) * uFade;
  if (k < 0.002) discard;
  fragColor = vColor * k;
}
`;

export const fullscreenVertex = HEADER + /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 4x4 box average of the plate's warm channel into the quarter-resolution halation buffer.
export const downsampleFragment = HEADER + /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float a = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).a
    + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).a
    + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).a
    + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).a;
  fragColor = vec4(a * 0.25, 0.0, 0.0, 1.0);
}
`;

// One direction of the separable gaussian, with bilinear taps carrying two texels each.
export const blurFragment = HEADER + /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
uniform float uOffset[12];
uniform float uWeight[12];
uniform float uCenter;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float s = texture(tSrc, vUv).r * uCenter;
  for (int i = 0; i < 12; i++) {
    vec2 o = uDir * uOffset[i];
    s += (texture(tSrc, vUv + o).r + texture(tSrc, vUv - o).r) * uWeight[i];
  }
  fragColor = vec4(s, 0.0, 0.0, 1.0);
}
`;

// The density field of one cloud, from its projected lobes, with its analytic gradient so the
// contour lines keep a constant pixel width without derivatives.
const field = (name, a, b) => /* glsl */ `
vec4 ${name}(vec2 p) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uLobeCount) break;
    vec4 l = ${a}[i];
    vec4 m = ${b}[i];
    if (m.z <= 0.0 && m.w <= 0.0) continue;
    vec2 d = p - l.xy;
    vec2 r = vec2(m.x * d.x + m.y * d.y, -m.y * d.x + m.x * d.y);
    vec2 s = r / l.zw;
    float q = dot(s, s);
    if (q > 20.0) continue;
    float e = exp(-0.5 * q);
    float g = m.z * e;
    vec2 gr = -g * r / (l.zw * l.zw);
    acc += vec4(g, m.x * gr.x - m.y * gr.y, m.y * gr.x + m.x * gr.y, m.w * e);
  }
  return acc;
}
`;

export const compositeFragment = HEADER + /* glsl */ `
uniform sampler2D tPlate;
uniform sampler2D tHalo;

uniform vec4 uView;      // css width, css height, canvas px per css px, time s
uniform vec4 uTone;      // exposure, plate gain, cover (canvas alpha), halation gain
uniform vec4 uOptic;     // principal point xy (css), cos^4 falloff scale, grain amplitude
uniform vec4 uGrainB;    // grain seed (changes at 12 fps), coarse cell css px, fine cell css px, unused
uniform vec4 uIris;      // centre xy, aperture inradius, housing radius
uniform vec4 uIrisB;     // blade rotation, opacity, blade arc radius, ring rotation
uniform vec4 uLobeT[8];  // projected target lobes: centre xy, sigma x, sigma y (css px)
uniform vec4 uLobeTB[8]; // cos, sin, normalised peak density (contours), haze peak (linear light)
uniform vec4 uLobeR[8];
uniform vec4 uLobeRB[8];
uniform int uLobeCount;
uniform vec4 uLeak;      // gap midpoint xy, unit axis from the target to the reference
uniform vec4 uLeakB;     // core width, half-length, intensity, streak phase
uniform vec4 uSample[8]; // centre xy, kind (0 target, 1 reference), opacity
uniform vec4 uMarks;     // contour opacity, sample opacity, reticle opacity, unused
uniform vec4 uLevels;    // three contour levels, dash length px
uniform vec4 uReseau;    // spacing css px, opacity outside, opacity inside, grid-line opacity inside
uniform vec4 uField;     // the station's window: x0, y0, x1, y1 (css px)
uniform vec4 uFieldB;    // the window counts as aperture, clip to the window, reseau origin x, y
uniform vec4 uSampleB[8];// per answer: how far it has dropped onto the plate (1 = settled)

in vec2 vUv;
out vec4 fragColor;

const vec3 INK = vec3(0.9098, 0.9176, 0.9020);       // #E8EAE6
const vec3 COOL = vec3(0.6118, 0.7843, 0.8235);      // #9CC8D2
const vec3 DATA = vec3(0.4157, 0.4549, 0.4392);      // #6A7470, ticks that carry data
const vec3 HAIR = vec3(0.1725, 0.2039, 0.1922);      // #2C3431, registration greys
const vec3 BLADE = vec3(0.0510, 0.0627, 0.0588);     // #0D100F
const vec3 WARM_LIN = vec3(1.0, 0.10224, 0.02416);   // #FF5A2B in linear light
const vec3 INK_LIN = vec3(0.807, 0.823, 0.791);
const vec3 COOL_LIN = vec3(0.332, 0.578, 0.644);
const vec3 BLACK_LIN = vec3(0.002125, 0.002732, 0.002428); // #070908
const float SEG = 0.6981317008;
const float TICK = 0.0872664626;                    // 5 degrees: 72 ticks

${field("densityT", "uLobeT", "uLobeTB")}
${field("densityR", "uLobeR", "uLobeRB")}

vec3 hbd(vec3 c) {
  vec3 x = max(vec3(0.0), c - 0.004);
  return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06);
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toDisplay(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
// Approaches 1 smoothly so the warm tails never clip and never shift hue.
float softLimit(float w) {
  return w < 0.85 ? w : 0.85 + 0.15 * (1.0 - exp(-(w - 0.85) / 0.15));
}

// A hairline of half-width h (css px), antialiased over one device pixel.
float hair(float d, float h) {
  float aa = 0.5 / uView.z;
  return 1.0 - smoothstep(h - aa, h + aa, d);
}

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float hash(vec2 c, float seed) {
  uvec2 u = uvec2(ivec2(floor(c)) + 65536);
  return float(pcg(u.x + pcg(u.y + pcg(uint(seed))))) / 4294967295.0;
}
float valueNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i, seed), b = hash(i + vec2(1.0, 0.0), seed);
  float c = hash(i + vec2(0.0, 1.0), seed), d = hash(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float leakBand(vec2 p, vec4 ft, vec4 fr) {
  vec2 d = p - uLeak.xy;
  float across = dot(d, uLeak.zw);
  float along = dot(d, vec2(-uLeak.w, uLeak.z));
  float w = uLeakB.x;
  float a2 = across * across / (w * w);
  // A soft band through the gap: a gaussian across it with a fainter skirt 2.2 times wider, faint
  // streaks along its length, as long as the clouds are tall and falling off fast past them, and
  // cleared wherever either cloud is dense. world/gap.js bandAt() is the same band, for the readout.
  float band = 0.9 * exp(-0.5 * a2) + 0.1 * exp(-0.5 * a2 / 4.84);
  float streaks = 0.92 + 0.08 * sin(across * 0.5 + 1.3 * sin(across * 0.07 + uLeakB.w));
  float q = along / uLeakB.y;
  float extent = exp(-q * q * q * q);
  float clear = (1.0 - smoothstep(0.02, 0.3, ft.x)) * (1.0 - smoothstep(0.02, 0.3, fr.x));
  return band * streaks * extent * clear * uLeakB.z;
}

float contour(vec4 f, float level) {
  float g = max(length(f.yz), 1e-5);
  return hair(abs(f.x - level) / g, 0.5);
}

float rectMask(vec2 p, vec4 r) {
  vec2 a = smoothstep(r.xy - 0.5, r.xy + 0.5, p) * (1.0 - smoothstep(r.zw - 0.5, r.zw + 0.5, p));
  return a.x * a.y;
}

float reseauCross(vec2 p, float spacing) {
  vec2 c = p - uFieldB.zw;
  vec2 m = abs(mod(c + spacing * 0.5, spacing) - spacing * 0.5);
  return max(hair(m.y, 0.5) * step(m.x, 5.0), hair(m.x, 0.5) * step(m.y, 5.0));
}
float reseauGrid(vec2 p, float spacing) {
  vec2 c = p - uFieldB.zw;
  vec2 m = abs(mod(c + spacing * 0.5, spacing) - spacing * 0.5);
  return max(hair(m.x, 0.5), hair(m.y, 0.5));
}

// The eyepiece reticle: a broken crosshair with ticks every 8 px, long ones every 32 px (half a
// reseau cell), so positions inside the aperture can be read against the plate's grid.
float reticle(vec2 q, float radius) {
  vec2 a = abs(q);
  float lim = radius - 9.0;
  float hx = step(7.0, a.x) * step(a.x, lim);
  float vy = step(7.0, a.y) * step(a.y, lim);
  float lines = max(hair(a.y, 0.5) * hx, hair(a.x, 0.5) * vy);
  vec2 t = abs(mod(q + 4.0, 8.0) - 4.0);
  vec2 l = step(abs(mod(q + 16.0, 32.0) - 16.0), vec2(0.6));
  float ticks = max(hair(t.x, 0.5) * step(a.y, mix(2.0, 4.5, l.x)) * hx, hair(t.y, 0.5) * step(a.x, mix(2.0, 4.5, l.y)) * vy);
  return max(lines, ticks);
}

float starMark(vec2 d) {
  vec2 a = abs(d);
  float w = 0.5 + 0.5 / uView.z;
  float arms = max((1.0 - smoothstep(2.0, 6.5, a.x)) * hair(a.y, w), (1.0 - smoothstep(2.0, 6.5, a.y)) * hair(a.x, w));
  return max(arms, hair(length(d), 1.4));
}
float ringMark(vec2 d) {
  return hair(abs(length(d) - 3.6), 0.65);
}
// A dark margin behind each mark, as on a printed chart, so it reads over a dense star field.
float knockout(vec2 d, float kind) {
  float r = length(d);
  return kind < 0.5 ? 1.0 - smoothstep(4.0, 8.0, r) : 1.0 - smoothstep(5.0, 7.5, r);
}

// The auditor's 9-blade iris: the opening is the intersection of nine discs (curved blade edges),
// each blade's edge continues past its corner as the arc that reads as overlapping blades, then the
// housing and its engraved ring of 72 ticks, which turns as the aperture changes.
vec4 iris(vec2 p, out float aperture) {
  aperture = 0.0;
  vec2 q = p - uIris.xy;
  float r = length(q);
  float ra = uIris.z;
  float R = uIris.w;
  float opacity = uIrisB.y;
  if (opacity <= 0.001 || r > R + 24.0) return vec4(0.0);
  float rho = uIrisB.z;
  float off = rho - ra;
  float ang = atan(q.y, q.x) - uIrisB.x;
  float local = ang - SEG * floor(ang / SEG + 0.5);
  vec2 ql = r * vec2(cos(local), sin(local));
  float dOpen = length(ql + vec2(off, 0.0)) - rho;
  float aa = 0.5 / uView.z;
  // everything seen through the iris fades in with it
  aperture = (1.0 - smoothstep(-aa, aa, dOpen)) * step(r, R) * opacity;

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (r < R + aa && dOpen > -aa) {
    float edge = 1e4;
    for (int k = 1; k <= 3; k++) {
      float a = -float(k) * SEG;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 rel = ql + off * dir;
      float d = length(rel) - rho;
      if (dir.x * rel.y - dir.y * rel.x > 0.0 && abs(d) < abs(edge)) edge = d;
    }
    float lift = edge > 0.0 ? 0.03 * exp(-edge / 5.0) : -0.022 * exp(edge / 3.0);
    col = BLADE * (1.0 + lift * 18.0) + vec3(lift * 0.4);
    col = mix(col, INK, 0.2 * hair(abs(edge), 0.5));
    float inBlade = smoothstep(-aa, aa, dOpen) * (1.0 - smoothstep(R - aa, R + aa, r));
    alpha = 0.94 * inBlade;
  }
  // the aperture rim and the housing
  float rim = hair(abs(dOpen), 0.55) * step(r, R);
  col = mix(col, INK, 0.5 * rim);
  alpha = max(alpha, 0.5 * rim);
  float housing = hair(abs(r - R), 0.5);
  col = mix(col, DATA, housing);
  alpha = max(alpha, housing);
  // engraved ring: 72 ticks, a long one every 30 degrees, plus a fixed index at the top
  float ringAng = atan(q.y, q.x) - uIrisB.w;
  float tk = floor(ringAng / TICK + 0.5);
  float tick = hair(abs(ringAng - tk * TICK) * r, 0.5);
  float isLong = step(mod(tk, 6.0), 0.5);
  float r0 = R + 5.0;
  tick *= step(r0, r) * step(r, r0 + mix(3.5, 8.5, isLong));
  float index = hair(abs(q.x), 0.5) * step(r0 + 11.0, -q.y) * step(-q.y, r0 + 17.0);
  float marks = max(tick, index);
  col = mix(col, mix(DATA, INK, index), marks);
  alpha = max(alpha, marks);
  return vec4(col, alpha * opacity);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uView.y * uView.z - gl_FragCoord.y) / uView.z;
  vec4 plate = texture(tPlate, vUv) * uTone.y;
  float halo = texture(tHalo, vUv).r * uTone.y * uTone.w;

  vec2 dc = (p - uOptic.xy) * uOptic.z;
  float c2 = 1.0 + dot(dc, dc);
  float exposure = uTone.x / (c2 * c2);   // cos^4 of the field angle

  float aperture;
  vec4 instrument = iris(p, aperture);
  float window = rectMask(p, uField);
  aperture = max(aperture, uFieldB.x * window);

  // The density of answers, from the projected lobes: a faint haze under the particles (the
  // particles are samples of it), the contours in the aperture, and where the leak may shine.
  vec4 ft = densityT(p);
  vec4 fr = densityR(p);
  float leak = 0.0;
  vec2 dl = p - uLeak.xy;
  if (uLeakB.z > 0.0005 && abs(dot(dl, uLeak.zw)) < 9.0 * uLeakB.x && abs(dot(dl, vec2(-uLeak.w, uLeak.z))) < 1.6 * uLeakB.y) {
    leak = leakBand(p, ft, fr);
  }
  vec3 light = plate.rgb + ft.w * INK_LIN + fr.w * COOL_LIN;
  vec3 img = hbd(light * exposure);
  // Halation only shows where the plate isn't already lit: a warm fringe around the divergent lobes.
  float lit = dot(img, vec3(0.2126, 0.7152, 0.0722));
  halo *= 1.0 - smoothstep(0.04, 0.32, lit);
  vec3 lin = toLinear(img) + BLACK_LIN;
  lin += WARM_LIN * softLimit((leak + halo) * exposure);
  vec3 col = toDisplay(lin);

  // Reseau crosses are exposed on the plate: faint everywhere, stronger and gridded in the aperture.
  float cross = reseauCross(p, uReseau.x);
  col = mix(col, INK, cross * mix(uReseau.y, uReseau.z, aperture));

  if (aperture > 0.0) {
    vec2 q = p - uIris.xy;
    float grid = reseauGrid(p, uReseau.x) * uReseau.w;
    col = mix(col, INK, grid * aperture);
    float ct = max(max(contour(ft, uLevels.x), contour(ft, uLevels.y)), contour(ft, uLevels.z));
    float cr = max(max(contour(fr, uLevels.x), contour(fr, uLevels.y)), contour(fr, uLevels.z));
    // reference lines are dashed: dash along the arc around the nearest reference lobe
    float best = -1.0;
    vec2 centre = uIris.xy;
    for (int i = 0; i < 8; i++) {
      if (i >= uLobeCount) break;
      if (uLobeRB[i].z <= 0.0) continue;
      vec2 d = p - uLobeR[i].xy;
      float g = uLobeRB[i].z * exp(-0.5 * dot(d, d) / (uLobeR[i].z * uLobeR[i].w));
      if (g > best) { best = g; centre = uLobeR[i].xy; }
    }
    vec2 dv = p - centre;
    float arc = atan(dv.y, dv.x) * length(dv);
    cr *= step(0.45, fract(arc / uLevels.w));
    col = mix(col, INK, ct * uMarks.x * aperture);
    col = mix(col, COOL, cr * uMarks.x * 1.3 * aperture);
    for (int i = 0; i < 8; i++) {
      vec4 s = uSample[i];
      if (s.w <= 0.0) continue;
      // An answer drops onto the plate: large and soft while it falls, sharp when it lands.
      float fall = 1.0 + 2.6 * (1.0 - uSampleB[i].x);
      vec2 d = (p - s.xy) / fall;
      if (dot(d, d) > 64.0) continue;
      float m = s.z < 0.5 ? starMark(d) : ringMark(d);
      float k = s.w * uMarks.y * aperture / fall;
      col = mix(col, vec3(0.027, 0.035, 0.031), 0.72 * knockout(d, s.z) * k);
      col = mix(col, s.z < 0.5 ? INK : COOL, m * k);
    }
    col = mix(col, INK, reticle(q, uIris.z) * uMarks.z * aperture);
  }

  col = mix(col, instrument.rgb, instrument.a);

  // Film grain at 12 fps, weighted toward the midtones; coarse on the plate, fine in the eyepiece.
  float coarse = valueNoise(p / uGrainB.y, uGrainB.x);
  float fine = hash(gl_FragCoord.xy, uGrainB.x + 17.0);
  float n = mix(coarse, fine, aperture);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float amp = uOptic.w * (0.32 + 2.7 * luma * (1.0 - luma)) * mix(1.0, 0.75, aperture);
  col += (n - 0.5) * 2.0 * amp;

  float cover = uTone.z * mix(1.0, window, uFieldB.y);
  fragColor = vec4(clamp(col, 0.0, 1.0) * cover, cover);
}
`;
