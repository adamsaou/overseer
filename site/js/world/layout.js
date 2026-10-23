import { entropy, jsd, mulberry32, hashString, clamp } from "./math.js";

// Meaning-space for the hero, built from one real scan (results/scans/*.json).
//
// The cluster POSITIONS are an illustrative layout of meaning-space, not measured coordinates: a scan
// records which cluster each answer fell into, never where the clusters sit relative to each other.
// The layout only encodes what the scan does measure. Clusters only the target used sit on one side,
// clusters only the reference used sit on the other, shared clusters sit between them, and each
// cloud's MASS per cluster is exactly its share of the scan's answers (3:1 for the target and 2:2 for
// the reference in the Tesla worked example). The DOM caption should say the same.

export const MAX_LOBES = 8;

const TILT = (14 * Math.PI) / 180; // the divergence axis rises slightly to the right
const SPREAD = 1.06; // half the distance between a target-only and a reference-only cluster
const SIGMA = 0.29;
// Slots along the axis perpendicular to the divergence, heaviest cluster first (ties by index), so the
// first cluster of each side is the upper one, as the page's labels expect. The sides use different
// offsets so the plate never reads as a symmetric diagram.
const SLOTS = { target: [0.36, -0.8, 1.1, -1.3], reference: [0.7, -0.36, 1.3, -1.2], shared: [0, 0.85, -0.85, 1.3] };

export function buildLayout(scan) {
  const clusters = readClusters(scan);
  if (!clusters) return neutralLayout();
  const nT = clusters.reduce((s, c) => s + c.target, 0);
  const nR = clusters.reduce((s, c) => s + c.reference, 0);
  const P = clusters.map((c) => c.target / nT);
  const Q = clusters.map((c) => c.reference / nR);
  const maxMass = Math.max(...P, ...Q);

  const u = [Math.cos(TILT), Math.sin(TILT)];
  const v = [-Math.sin(TILT), Math.cos(TILT)];
  const groups = { target: [], reference: [], shared: [] };
  clusters.forEach((c, i) => {
    const own = (P[i] - Q[i]) / (P[i] + Q[i] || 1);
    const side = own > 0.34 ? "target" : own < -0.34 ? "reference" : "shared";
    groups[side].push({ i, own, mass: Math.max(P[i], Q[i]) });
  });

  const lobes = new Array(clusters.length);
  for (const [side, list] of Object.entries(groups)) {
    list.sort((a, b) => b.mass - a.mass || a.i - b.i);
    list.forEach(({ i, own, mass }, slot) => {
      const rand = mulberry32(hashString(clusters[i].label) ^ (i * 2654435761));
      const along = -own * SPREAD + (rand() - 0.5) * 0.16;
      const across = (SLOTS[side][slot] ?? (slot % 2 ? -1 : 1) * (0.6 + slot * 0.3)) * 0.9 + (rand() - 0.5) * 0.12;
      const z = (rand() - 0.5) * 0.36 + (own > 0 ? 0.12 : 0);
      const sigma = SIGMA * (0.7 + 0.3 * Math.sqrt(mass / maxMass));
      const stretch = 1.06 + rand() * 0.16;
      lobes[i] = {
        index: i,
        label: clusters[i].label,
        counts: { target: clusters[i].target, reference: clusters[i].reference },
        center: [along * u[0] + across * v[0], along * u[1] + across * v[1], z],
        sigma,
        // per-lobe anisotropy in the plate plane, so the clouds read as matter rather than spheres
        shape: [stretch, 1 / stretch, 0.92, (rand() - 0.5) * 1.6],
        p: P[i],
        q: Q[i],
        // share of the target's mass here that the reference doesn't match: what halation lights up
        warm: P[i] > 0 ? clamp((P[i] - Q[i]) / P[i]) : 0,
      };
    });
  }

  // Centre the whole field on the origin so the camera frames it symmetrically.
  const c = [0, 0, 0];
  for (const l of lobes) for (let k = 0; k < 3; k++) c[k] += l.center[k] / lobes.length;
  for (const l of lobes) for (let k = 0; k < 3; k++) l.center[k] -= c[k];

  let extent = 0;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of lobes) {
    extent = Math.max(extent, Math.hypot(l.center[0], l.center[1]) + 2.6 * l.sigma);
    const r = 2.7 * l.sigma * Math.max(l.shape[0], l.shape[1]);
    box[0] = Math.min(box[0], l.center[0] - r); box[1] = Math.min(box[1], l.center[1] - r);
    box[2] = Math.max(box[2], l.center[0] + r); box[3] = Math.max(box[3], l.center[1] + r);
  }

  const atlas = { center: [0, 0, 0.1], sigma: 0.4, shape: [0.94, 1.08, 0.95, 0.18] };
  for (let i = 0; i < lobes.length; i++) for (let k = 0; k < 2; k++) atlas.center[k] += P[i] * lobes[i].center[k];

  return {
    hasScan: true,
    question: String(scan.question ?? ""),
    aspect: String(scan.aspect ?? ""),
    n: Number(scan.n) || Math.max(nT, nR),
    lobes,
    P,
    Q,
    measured: {
      jsd: finite(scan.divergence, jsd(P, Q)),
      hTarget: finite(scan.targetEntropy, entropy(P)),
      hReference: finite(scan.referenceEntropy, entropy(Q)),
    },
    samples: buildSamples(clusters, P, Q),
    atlas,
    extent,
    // the plate-plane bounding box of every lobe out to 2.7 sigma: centre and half sizes
    frame: { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, w: (box[2] - box[0]) / 2, h: (box[3] - box[1]) / 2 },
    axis: u,
  };
}

// The cloud masses part-way through the hero's transfer: the target starts on top of the reference
// (JSD 0) and its mass moves into its own clusters as s goes from 0 to 1.
export function massesAt(layout, s) {
  return layout.P.map((p, i) => (1 - s) * layout.Q[i] + s * p);
}

export function measureAt(layout, s) {
  if (!layout.hasScan) return { jsd: 0, hTarget: 0, hReference: 0 };
  if (s >= 1) return { ...layout.measured };
  const P = massesAt(layout, s);
  return { jsd: jsd(P, layout.Q), hTarget: entropy(P), hReference: entropy(layout.Q) };
}

// The 2n real answers as sample points: each sits in the cluster the scan put it in. Target answers
// begin in the reference's clusters (that is the JSD 0 opening state) and travel to their own.
function buildSamples(clusters, P, Q) {
  const samples = [];
  const startOrder = lowDiscrepancyAssign(Q, clusters.reduce((s, c) => s + c.target, 0), 0.31);
  let t = 0;
  clusters.forEach((c, i) => {
    for (let k = 0; k < c.target; k++) {
      samples.push({ cloud: 0, home: i, start: startOrder[t] ?? i, angle: ringAngle(k, c.target, i), tau: (t + 0.5) / 8 });
      t++;
    }
    for (let k = 0; k < c.reference; k++) {
      samples.push({ cloud: 1, home: i, start: i, angle: ringAngle(k, c.reference, i + 0.5), tau: 0 });
    }
  });
  return samples.slice(0, 8);
}

const ringAngle = (k, count, phase) => (Math.PI * 2 * k) / Math.max(1, count) + 0.9 + phase * 1.3;

// Where an answer sits inside its cluster: a fixed point on a small ring in the lobe's own frame.
export function samplePoint(lobe, angle) {
  const r = 0.42 * lobe.sigma;
  const [sx, sy, , rot] = lobe.shape;
  const x = Math.cos(angle) * r * sx, y = Math.sin(angle) * r * sy;
  const c = Math.cos(rot), s = Math.sin(rot);
  return [lobe.center[0] + c * x - s * y, lobe.center[1] + s * x + c * y, lobe.center[2] + 0.12 * lobe.sigma * Math.sin(angle * 1.7)];
}

// Assigns `count` items to bins in proportion to `weights`, evenly for any prefix (golden-ratio steps),
// so a smaller particle tier keeps the scan's exact ratios.
export function lowDiscrepancyAssign(weights, count, offset = 0) {
  const cdf = [];
  let acc = 0;
  for (const w of weights) cdf.push((acc += w));
  const total = acc || 1;
  const out = new Uint8Array(count);
  const last = weights.length - 1;
  for (let k = 0; k < count; k++) {
    const x = ((offset + k * 0.6180339887498949) % 1) * total;
    let bin = 0;
    while (bin < last && x >= cdf[bin]) bin++;
    out[k] = bin;
  }
  return out;
}

function readClusters(scan) {
  if (!scan || !Array.isArray(scan.clusters)) return null;
  const clusters = scan.clusters.slice(0, MAX_LOBES).map((c) => ({
    label: String(c?.label ?? ""),
    target: Math.max(0, Math.round(Number(c?.target) || 0)),
    reference: Math.max(0, Math.round(Number(c?.reference) || 0)),
  }));
  const nT = clusters.reduce((s, c) => s + c.target, 0);
  const nR = clusters.reduce((s, c) => s + c.reference, 0);
  return nT > 0 && nR > 0 ? clusters : null;
}

function finite(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// Without a scan nothing is measured: one shared body, no gap, and the needles read NO SCAN.
function neutralLayout() {
  const lobe = { index: 0, label: "", counts: { target: 1, reference: 1 }, center: [0, 0, 0], sigma: 0.55, shape: [1.08, 0.92, 0.95, 0.3], p: 1, q: 1, warm: 0 };
  return {
    hasScan: false,
    question: "",
    aspect: "",
    n: 0,
    lobes: [lobe],
    P: [1],
    Q: [1],
    measured: { jsd: 0, hTarget: 0, hReference: 0 },
    samples: [],
    atlas: { center: [0, 0, 0.1], sigma: 0.44, shape: [0.94, 1.08, 0.95, 0.18] },
    extent: 1.6,
    frame: { x: 0, y: 0, w: 1.6, h: 1.6 },
    axis: [1, 0],
  };
}
