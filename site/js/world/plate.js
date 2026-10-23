import { project } from "./camera.js";
import { massesAt, samplePoint } from "./layout.js";
import { clamp } from "./math.js";

// What lies on the plate this frame, in screen space: each lobe of both clouds (projected centre,
// spread and current mass), Atlas when the lobes merge, and the scan's real answers as sample points.
// It writes the composite's lobe and sample uniforms; the particles move on their own in the shader.

export const REF_DEPTH = -0.34; // the reference sits slightly behind the target
const HAZE = 0.042; // the density haze under the particles, per unit of world density

export function createPlate(layout, C) {
  const n = layout.lobes.length;
  const lobe = () => ({ x: 0, y: 0, depth: 1, sx: 1, sy: 1, m: 0 });
  const lobesT = layout.lobes.map(lobe);
  const lobesR = layout.lobes.map(lobe);
  const atlas = lobe();
  // Atlas joins the target's density field as one more lobe, when the uniform arrays have room.
  const atlasSlot = n < 8 ? n : -1;
  const samples = layout.samples.map(() => ({ x: 0, y: 0, visible: 0 }));
  const massesR = layout.Q;
  const p = { x: 0, y: 0, depth: 1 };
  const plate = { lobesT, lobesR, atlas, samples, massesT: massesAt(layout, 0), massesR };

  // The order the answers drop onto the plate in the entropy scene: the target's first, then the
  // reference's, each in the order the scan's clusters list them.
  const dropOrder = layout.samples.map((s, i) => [s.cloud, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);
  const dropRank = new Map(dropOrder.map((i, rank) => [i, rank]));

  function place(o, camera, view, rig, centre, dz, sigma, shape, swell, mass, flat) {
    project(camera, view, centre[0], centre[1], (centre[2] + dz) * (1 - flat), p);
    const k = (rig.projectionScale / Math.max(0.1, p.depth)) * sigma * swell;
    o.x = p.x;
    o.y = p.y;
    o.depth = p.depth;
    o.sx = Math.max(1, k * shape[0]);
    o.sy = Math.max(1, k * shape[1]);
    o.m = mass;
  }

  // showT and showR are the blink's exposures: they hide one cloud's light and answers, never the
  // contours, which belong to the field and stay registered.
  plate.update = ({ camera, view, rig, pose, showT, showR, swell }) => {
    const masses = (plate.massesT = massesAt(layout, pose.transfer));
    const flat = pose.flat;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      const l = layout.lobes[i];
      place(lobesT[i], camera, view, rig, l.center, 0, l.sigma, l.shape, swell, masses[i] * (1 - pose.merge), flat);
      place(lobesR[i], camera, view, rig, l.center, REF_DEPTH, l.sigma, l.shape, swell, massesR[i], flat);
      // contours are normalised to the densest lobe the settled scan has, so levels don't wander
      peak = Math.max(peak, Math.max(l.p, l.q) / (lobesT[i].sx * lobesT[i].sy));
    }
    const a = layout.atlas;
    place(atlas, camera, view, rig, a.center, 0, a.sigma * pose.atlasSize, a.shape, swell, pose.merge, flat);
    const haze = (sigma, shape) => (HAZE * (1 - pose.lattice)) / (sigma * sigma * shape[0] * shape[1]);
    for (let i = 0; i < 8; i++) {
      const tA = C.uLobeT.value[i], tB = C.uLobeTB.value[i], rA = C.uLobeR.value[i], rB = C.uLobeRB.value[i];
      if (i === atlasSlot) {
        tA.set(atlas.x, atlas.y, atlas.sx, atlas.sy);
        tB.set(Math.cos(a.shape[3]), -Math.sin(a.shape[3]), atlas.m / (atlas.sx * atlas.sy) / peak, atlas.m * showT * haze(a.sigma * pose.atlasSize, a.shape) * pose.targetLevel);
        rA.set(0, 0, 1, 1);
        rB.set(1, 0, 0, 0);
        continue;
      }
      if (i >= n) {
        tB.z = tB.w = rB.z = rB.w = 0;
        continue;
      }
      const l = layout.lobes[i], t = lobesT[i], r = lobesR[i];
      // screen y points down, so the plate's rotation flips sign
      const cos = Math.cos(l.shape[3]), sin = -Math.sin(l.shape[3]);
      const h = haze(l.sigma, l.shape);
      tA.set(t.x, t.y, t.sx, t.sy);
      tB.set(cos, sin, t.m / (t.sx * t.sy) / peak, t.m * showT * h * pose.targetLevel);
      rA.set(r.x, r.y, r.sx, r.sy);
      rB.set(cos, sin, r.m / (r.sx * r.sy) / peak, r.m * showR * h * pose.referenceLevel * (1 - pose.referenceBlur / 12));
    }
    C.uLobeCount.value = atlasSlot >= 0 ? n + 1 : n;

    // The answers travel with the transfer exactly as the particles do (same stagger curve), and in
    // the entropy scene they drop onto the plate one after another as the station arrives.
    layout.samples.forEach((s, i) => {
      let k = 1;
      if (s.cloud === 0) {
        k = clamp((pose.transfer - s.tau * 0.7) / 0.3);
        k = k * k * (3 - 2 * k);
      }
      const home = samplePoint(layout.lobes[s.home], s.angle);
      const from = samplePoint(layout.lobes[s.start], s.angle);
      const dz = s.cloud === 1 ? REF_DEPTH : 0;
      const z = (from[2] + (home[2] - from[2]) * k + dz) * (1 - flat);
      project(camera, view, from[0] + (home[0] - from[0]) * k, from[1] + (home[1] - from[1]) * k, z, p);
      const delay = (0.5 * (dropRank.get(i) ?? 0)) / Math.max(1, layout.samples.length - 1);
      let drop = clamp((pose.samples - delay) / 0.5);
      drop = drop * drop * (3 - 2 * drop);
      const o = samples[i];
      o.x = p.x;
      o.y = p.y;
      o.visible = (s.cloud === 0 ? showT * (1 - pose.merge) : showR) * drop;
      C.uSample.value[i].set(o.x, o.y, s.cloud, o.visible);
      C.uSampleB.value[i].x = drop;
    });
    for (let i = layout.samples.length; i < 8; i++) C.uSample.value[i].w = 0;
  };

  // How lit a box of the plate is (0 dark, about 1 at a lobe's core): the peak of the clouds' density
  // over five points of it, so labels can stay off the bright parts.
  plate.brightness = (l, t, w, h) => {
    let peak = 0;
    for (const [x, y] of [[l, t], [l + w, t], [l, t + h], [l + w, t + h], [l + w / 2, t + h / 2]]) {
      let v = 0;
      for (let i = 0; i < n; i++) v += lit(lobesT[i], x, y) + lit(lobesR[i], x, y) * 0.7;
      v += lit(atlas, x, y);
      peak = Math.max(peak, v);
    }
    return peak;
  };

  // Each cloud's density at a point, normalised the way the composite's contours and leak see it
  // (from the same uniforms), so the page's logic about the plate agrees with what it shows.
  plate.fieldAt = (x, y) => [field(C.uLobeT.value, C.uLobeTB.value, C.uLobeCount.value, x, y), field(C.uLobeR.value, C.uLobeRB.value, C.uLobeCount.value, x, y)];

  // The readout's count: how many of the real answers lie inside the aperture right now.
  plate.count = (ix, iy, aperture, out) => {
    out.target = 0;
    out.reference = 0;
    layout.samples.forEach((s, i) => {
      const o = samples[i];
      if (o.visible > 0.5 && Math.hypot(o.x - ix, o.y - iy) < aperture) out[s.cloud === 0 ? "target" : "reference"]++;
    });
    return out;
  };

  return plate;
}

function lit(o, x, y) {
  if (o.m <= 0) return 0;
  const dx = (x - o.x) / o.sx, dy = (y - o.y) / o.sy;
  return Math.min(1, o.m * 1.6) * Math.exp(-0.5 * (dx * dx + dy * dy));
}

// The shader's field(): lobes as (x, y, sigma x, sigma y) and (cos, sin, normalised peak, haze).
function field(A, B, n, x, y) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const l = A[i], m = B[i];
    if (m.z <= 0 && m.w <= 0) continue;
    const dx = x - l.x, dy = y - l.y;
    const u = (m.x * dx + m.y * dy) / l.z, w = (-m.y * dx + m.x * dy) / l.w;
    const q = u * u + w * w;
    if (q <= 20) v += m.z * Math.exp(-0.5 * q);
  }
  return v;
}
