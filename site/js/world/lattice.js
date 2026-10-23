import { wilson } from "../lib/format.js";
import { clamp } from "./math.js";
import { COOL, DATA, INK } from "./marks.js";

// The oversight gap as a 3 x 3 x 2 lattice, from results/summary.json: auditors across, targets in
// depth, and two stacked glass plates, scans off below (neutral) and scans on above (cool, because
// the reference copy is in play). A measured cell is a column of the plate's light as tall as its
// score with a haze over its approximate 95% Wilson interval (partial counted as 1/2); a measured
// zero is a lit ring on the floor, so it never looks like a cell that wasn't run; a cell not run yet
// is an empty registration target; a dashed bracket marks cells where the auditor is the weaker model.
// The particles of both clouds stream into the measured cells: the target's into scans off, the
// reference's into scans on.

export const ORDER = ["haiku", "sonnet", "opus"];
export const TOOLS = ["basic", "entropy"];
const SPACING = 1;
const FLOOR = -0.78; // the lower plate
const STACK = 1.42; // height of the upper plate above the lower
const COLUMN = 1.02; // world units for a score of 1
const HALF_PLATE = 1.62;

export function createLattice(summary) {
  const cells = [];
  const byKey = new Map();
  const measured = (summary?.cells ?? []).filter((c) => c && Number.isFinite(c.score) && c.n > 0);
  TOOLS.forEach((tools, plate) => {
    ORDER.forEach((target, ti) => {
      ORDER.forEach((auditor, ai) => {
        const c = measured.find((m) => m.tools === tools && m.auditor === auditor && m.target === target);
        const [lo, hi] = c ? wilson(c.score, c.n) : [0, 0];
        const cell = {
          index: plate * 9 + ti * 3 + ai,
          tools, auditor, target, plate,
          x: (ai - 1) * SPACING,
          y: FLOOR + plate * STACK,
          z: (ti - 1) * SPACING,
          measured: !!c,
          score: c ? clamp(c.score) : 0,
          lo, hi,
          weaker: ai < ti,
        };
        cells.push(cell);
        byKey.set(`${tools}:${auditor}:${target}`, cell);
      });
    });
  });
  // Each plate's particles are shared among its measured cells: a column takes more the higher it
  // scores, a measured zero still gets enough to light its ring.
  for (let plate = 0; plate < 2; plate++) {
    const list = cells.filter((c) => c.plate === plate && c.measured);
    const total = list.reduce((s, c) => s + 0.3 + c.score, 0);
    let acc = 0;
    for (const c of cells.filter((x) => x.plate === plate)) {
      if (c.measured) {
        acc += (0.3 + c.score) / total;
        c.cdf = acc;
      } else c.cdf = -1;
    }
  }
  const top = FLOOR + STACK + COLUMN;
  const yaw = -0.42;
  const pitch = 0.36;
  // What the camera frames: the lattice's box as this view sees it (the long lens is close to
  // orthographic). The labels' room is left in screen space by the station (stations.js).
  const box = [];
  for (const x of [-HALF_PLATE - 0.35, HALF_PLATE + 0.25]) for (const y of [FLOOR, top]) for (const z of [-HALF_PLATE - 0.2, HALF_PLATE + 0.35]) box.push([x, y, z]);
  const f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const xs = box.map((p) => dot(p, r));
  const ys = box.map((p) => dot(p, u));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const lattice = {
    cells,
    byKey,
    column: COLUMN,
    center: [r[0] * cx + u[0] * cy, r[1] * cx + u[1] * cy, r[2] * cx + u[2] * cy],
    half: [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2],
    yaw,
    pitch,
    focus: null,
  };

  // Uniforms for the particle shader: uCellA (x, plate y, z, score), uCellB (lo, hi, cdf, measured).
  lattice.writeUniforms = (U) => {
    for (const c of cells) {
      U.uCellA.value[c.index].set(c.x, c.y, c.z, c.score);
      U.uCellB.value[c.index].set(c.lo, c.hi, c.cdf, c.measured ? 1 : 0);
    }
  };

  // The marks of the lattice for this frame: plates, targets, rings, brackets, interval whiskers.
  // weight is the station's share of the blend; focus the cell the page points at.
  lattice.draw = (weight, f) => {
    if (weight <= 0.002) return;
    const { project, marks } = f;
    const ink = marks.ink;
    const fade = clamp((weight - 0.35) / 0.65);
    for (let plate = 0; plate < 2; plate++) {
      const y = FLOOR + plate * STACK;
      const colour = plate ? COOL : DATA;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => project(u * HALF_PLATE, y, v * HALF_PLATE));
      ink.polyline(corners.map((p) => [p.x, p.y]), { w: 0.5, c: colour, a: (plate ? 0.5 : 0.62) * fade }, true);
      // ticks along the front edge under each auditor, and along the left edge beside each target
      for (let k = -1; k <= 1; k++) {
        const a = project(k * SPACING, y, HALF_PLATE);
        const b = project(k * SPACING, y, HALF_PLATE + 0.12);
        ink.line(a.x, a.y, b.x, b.y, { w: 0.5, c: colour, a: 0.7 * fade });
        const c0 = project(-HALF_PLATE, y, k * SPACING);
        const c1 = project(-HALF_PLATE - 0.12, y, k * SPACING);
        ink.line(c0.x, c0.y, c1.x, c1.y, { w: 0.5, c: colour, a: 0.7 * fade });
      }
    }
    const focus = lattice.focus;
    for (const c of cells) {
      const colour = c.plate ? COOL : INK;
      const on = focus ? (focus === c ? 1 : 0.55) : 1;
      const base = project(c.x, c.y, c.z);
      if (c.weaker) {
        const h = 0.38;
        const sq = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => {
          const p = project(c.x + u, c.y, c.z + v);
          return [p.x, p.y];
        });
        ink.polyline(sq, { w: 0.5, c: DATA, a: 0.7 * fade * on, dash: 4, duty: 0.5 }, true);
      }
      if (!c.measured) {
        ink.target(base.x, base.y, 3.2, { w: 0.5, c: c.plate ? COOL : DATA, a: (c.plate ? 0.42 : 0.62) * fade * on });
        continue;
      }
      // the floor ring: lit for a measured zero, a faint footprint under a column
      const ring = [];
      const rr = c.score > 0 ? 0.12 : 0.17;
      for (let k = 0; k <= 32; k++) {
        const p = project(c.x + Math.cos((k / 32) * Math.PI * 2) * rr, c.y, c.z + Math.sin((k / 32) * Math.PI * 2) * rr);
        ring.push([p.x, p.y]);
      }
      ink.polyline(ring, { w: c.score > 0 ? 0.5 : 0.75, c: colour, a: (c.score > 0 ? 0.35 : 0.9) * fade * on });
      // the interval as a whisker beside the column, and the score as a tick across its top
      const side = 0.2;
      const lo = project(c.x + side, c.y + c.lo * COLUMN, c.z);
      const hi = project(c.x + side, c.y + c.hi * COLUMN, c.z);
      ink.line(lo.x, lo.y, hi.x, hi.y, { w: 0.5, c: colour, a: 0.55 * fade * on });
      for (const p of [lo, hi]) ink.line(p.x - 3, p.y, p.x + 3, p.y, { w: 0.5, c: colour, a: 0.55 * fade * on });
      if (c.score > 0) {
        const t0 = project(c.x - 0.12, c.y + c.score * COLUMN, c.z);
        const t1 = project(c.x + 0.12, c.y + c.score * COLUMN, c.z);
        ink.line(t0.x, t0.y, t1.x, t1.y, { w: 0.6, c: colour, a: 0.95 * fade * on });
      }
    }
  };

  // Label points for the page's gap anchors, and the focused cell's place for the iris and readout.
  // Each plate is named at its back-left corner, clear of the measured columns; each measured column
  // carries its score at its top (above the haze of its interval).
  lattice.labels = (out, f) => {
    const { project } = f;
    ORDER.forEach((key, i) => {
      const a = project((i - 1) * SPACING, FLOOR, HALF_PLATE + 0.3);
      out.set(`gap:auditor:${key}`, { x: a.x, y: a.y + 14, visible: true });
      const t = project(-HALF_PLATE - 0.3, FLOOR, (i - 1) * SPACING);
      out.set(`gap:target:${key}`, { x: t.x - 6, y: t.y, visible: true });
    });
    for (let plate = 0; plate < 2; plate++) {
      const p = project(-HALF_PLATE, FLOOR + plate * STACK, -HALF_PLATE);
      out.set(`gap:plate:${TOOLS[plate]}`, { x: p.x - 6, y: p.y - 12, visible: true });
    }
    for (const c of cells) {
      if (!c.measured) continue;
      const p = project(c.x, c.y + Math.max(c.score, c.hi) * COLUMN + 0.06, c.z);
      out.set(`gap:value:${c.tools}:${c.auditor}:${c.target}`, { x: p.x, y: p.y, visible: true });
    }
  };

  // Where a cell sits on screen: the middle of its column (or its floor) and its apparent size.
  lattice.place = (c, project) => {
    const mid = c.measured ? c.y + Math.max(c.score, c.hi) * COLUMN * 0.5 : c.y;
    const p = project(c.x, mid, c.z);
    const q = project(c.x + SPACING * 0.5, mid, c.z);
    const top = project(c.x, c.y + (c.measured ? Math.max(c.score, c.hi) * COLUMN : 0), c.z);
    return { x: p.x, y: p.y, r: Math.max(18, Math.hypot(q.x - p.x, q.y - p.y) * 0.9), top: top.y };
  };

  // The cell under a screen point, if any.
  lattice.pick = (x, y, project) => {
    let best = null;
    let bestD = Infinity;
    for (const c of cells) {
      const p = lattice.place(c, project);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < p.r * 0.75 && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  };

  return lattice;
}
