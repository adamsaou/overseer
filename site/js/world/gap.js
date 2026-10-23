import { clamp } from "./math.js";

// The gap between the two clouds on screen: the least dense point on the segment between their
// centroids, the axis from the target to the reference, and the band the light leak fills. The band
// is a soft gaussian across the axis, as long as the clouds are tall (never longer than 0.6 of the
// distance between them) and falling off fast past that; bandAt() is the shader's leakBand() without
// the density clearing, so what the iris readout calls the gap is what the plate shows as the gap.

export function createGap() {
  return { x: 0, y: 0, ux: 1, uy: 0, width: 20, length: 100, distance: 0, across: 1e9, along: 1e9, active: false };
}

// lobesT and lobesR are projected lobes { x, y, sx, sy }; massesT and massesR their current masses.
export function findGap(gap, lobesT, lobesR, massesT, massesR, fallbackAxis) {
  let tx = 0, ty = 0, tw = 0, rx = 0, ry = 0, rw = 0;
  for (let i = 0; i < lobesT.length; i++) {
    tx += lobesT[i].x * massesT[i]; ty += lobesT[i].y * massesT[i]; tw += massesT[i];
    rx += lobesR[i].x * massesR[i]; ry += lobesR[i].y * massesR[i]; rw += massesR[i];
  }
  tx /= tw || 1; ty /= tw || 1; rx /= rw || 1; ry /= rw || 1;
  let dx = rx - tx, dy = ry - ty;
  const d = Math.hypot(dx, dy);
  if (d < 1) {
    dx = fallbackAxis[0];
    dy = -fallbackAxis[1];
  } else {
    dx /= d;
    dy /= d;
  }
  let best = 0.5;
  let lowest = Infinity;
  for (let k = 1; k < 24; k++) {
    const f = k / 24;
    const x = tx + (rx - tx) * f, y = ty + (ry - ty) * f;
    let v = 0;
    for (let i = 0; i < lobesT.length; i++) v += gauss(lobesT[i], x, y) * massesT[i] + gauss(lobesR[i], x, y) * massesR[i];
    if (v < lowest) {
      lowest = v;
      best = f;
    }
  }
  gap.x = tx + (rx - tx) * best;
  gap.y = ty + (ry - ty) * best;
  gap.ux = dx;
  gap.uy = dy;
  // The band's gaussian across, wide enough to fill the gap between the clouds rather than draw a line
  // through it (the clouds' density clears it where they are); its skirt is 2.2 times wider.
  gap.width = clamp(0.12 * d, 8, 72);
  // Along the band: the clouds' own extent across the axis, so the light stays between them.
  let reach = 0;
  for (let i = 0; i < lobesT.length; i++) {
    for (const [l, m] of [[lobesT[i], massesT[i]], [lobesR[i], massesR[i]]]) {
      if (m <= 0.02) continue;
      const along = Math.abs(-(l.x - gap.x) * dy + (l.y - gap.y) * dx);
      reach = Math.max(reach, along + 1.1 * Math.max(l.sx, l.sy));
    }
  }
  gap.length = Math.max(24, Math.min(reach, 0.6 * d));
  gap.distance = d;
  return gap;
}

// Where a point sits relative to the band: across it (along the axis) and along it.
export function locate(gap, x, y) {
  gap.across = (x - gap.x) * gap.ux + (y - gap.y) * gap.uy;
  gap.along = -(x - gap.x) * gap.uy + (y - gap.y) * gap.ux;
  return gap;
}

// The band's light at a point, as a fraction of its peak, before the clouds' density clears it.
export function bandAt(gap, x, y) {
  const across = (x - gap.x) * gap.ux + (y - gap.y) * gap.uy;
  const along = -(x - gap.x) * gap.uy + (y - gap.y) * gap.ux;
  const a2 = (across * across) / (gap.width * gap.width);
  const band = 0.9 * Math.exp(-0.5 * a2) + 0.1 * Math.exp((-0.5 * a2) / 4.84);
  const q = along / gap.length;
  return band * Math.exp(-(q * q * q * q));
}

// True when a box (css px) touches the leak's visible band (its light above about 5% of the peak).
export function boxOnLeak(gap, l, t, w, h) {
  const vx = -gap.uy, vy = gap.ux;
  let lo = Infinity, hi = -Infinity, alo = Infinity, ahi = -Infinity;
  for (const [x, y] of [[l, t], [l + w, t], [l, t + h], [l + w, t + h]]) {
    const across = (x - gap.x) * gap.ux + (y - gap.y) * gap.uy;
    const along = (x - gap.x) * vx + (y - gap.y) * vy;
    lo = Math.min(lo, across); hi = Math.max(hi, across);
    alo = Math.min(alo, along); ahi = Math.max(ahi, along);
  }
  const band = gap.width * 2.6;
  return lo < band && hi > -band && alo < gap.length * 1.2 && ahi > -gap.length * 1.2;
}

function gauss(l, x, y) {
  const dx = (x - l.x) / l.sx, dy = (y - l.y) / l.sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}
