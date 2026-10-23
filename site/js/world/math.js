// Small numeric helpers shared by the world modules. Everything animates from elapsed time, never
// from frame counts, so 120 Hz screens and iOS low-power 30 fps look the same.

export const LN2 = Math.LN2;
export const TAU = Math.PI * 2;

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Critically damped spring, solved in closed form so it is stable at any dt and never overshoots.
// omega ≈ 5.8 / settle-time-in-seconds reaches 98% of the way.
export function springStep(s, target, omega, dt) {
  const d = s.x - target;
  const e = Math.exp(-omega * dt);
  const k = (s.v + omega * d) * dt;
  s.x = target + (d + k) * e;
  s.v = (s.v - omega * k) * e;
  return s.x;
}
export const spring = (x = 0) => ({ x, v: 0 });

// CSS cubic-bezier(x1, y1, x2, y2) as a function of progress, solved like browsers do.
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

// The camera's station moves use the art direction's curve.
export const stationEase = cubicBezier(0.65, 0, 0.35, 1);

// Discrete distributions, in nats, the same way lib/entropy.ts reports them.
export function entropy(p) {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return h;
}

export function jsd(p, q) {
  const m = p.map((x, i) => (x + q[i]) / 2);
  return Math.max(0, entropy(m) - (entropy(p) + entropy(q)) / 2);
}

// Deterministic randomness, so every visit (and the poster render) shows the same plate.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
