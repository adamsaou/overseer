import { samplePoint } from "./layout.js";

// The worked example as a measuring plate: the scan's clusters laid flat and seen straight down the
// long lens. This is the one description of where everything on that plate sits, in the plate's own
// units (the page's .fig__plate box, 960 by 560, y down). The world's entropy station frames its
// camera so the plate lands exactly here, the build draws the SVG plate and its marks from it
// (figures.js), and the blink stills are rendered from the world in the same frame, so all three
// register. Labels are sized in container units, so the composition holds at every width.

export const PLATE = { w: 960, h: 560 };
// Contour levels, as fractions of the densest lobe's peak; the world's composite uses the same.
export const LEVELS = [0.16, 0.38, 0.62];
// Where the lobes' frame fits: the middle of the plate, leaving the sides to the cluster labels
// (20% of the plate's width each, see .anchor--cluster in main.css), the top to the gap caliper and
// the bottom to the entropy readings.
const FIELD = { left: 0.255, right: 0.745, top: 0.13, bottom: 0.87 };
const LEADER = 16; // plate px between a cluster's outer contour and its label

export function entropyFrame(layout, w = PLATE.w, h = PLATE.h) {
  const f = layout.frame;
  const ppu = Math.min(((FIELD.right - FIELD.left) * w) / (2 * f.w), ((FIELD.bottom - FIELD.top) * h) / (2 * f.h));
  return { w, h, ppu, cx: ((FIELD.left + FIELD.right) / 2) * w, cy: ((FIELD.top + FIELD.bottom) / 2) * h, x: f.x, y: f.y };
}

export const toPlate = (frame, x, y) => [frame.cx + (x - frame.x) * frame.ppu, frame.cy - (y - frame.y) * frame.ppu];

// Everything the plate shows, in plate px: each cluster's lobe for both clouds (the densities the
// contours are drawn from), the eight answers, the label points, the calipers and the brackets.
export function entropyGeometry(layout, frame = entropyFrame(layout)) {
  const lobes = layout.lobes.map((l) => {
    const [x, y] = toPlate(frame, l.center[0], l.center[1]);
    const k = frame.ppu * l.sigma;
    // screen y points down, so the plate's rotation flips sign (as in plate.js)
    return { i: l.index, x, y, sx: k * l.shape[0], sy: k * l.shape[1], cos: Math.cos(l.shape[3]), sin: -Math.sin(l.shape[3]), p: l.p, q: l.q };
  });
  let peak = 1e-9;
  for (const l of lobes) peak = Math.max(peak, Math.max(l.p, l.q) / (l.sx * l.sy));
  for (const l of lobes) {
    l.dT = l.p / (l.sx * l.sy) / peak;
    l.dR = l.q / (l.sx * l.sy) / peak;
    // The outer contour of this lobe on its own, as half extents of its bounding box.
    const d = Math.max(l.dT, l.dR);
    const m = d > LEVELS[0] ? Math.sqrt(2 * Math.log(d / LEVELS[0])) : 0;
    const a = m * l.sx, b = m * l.sy;
    l.rx = Math.hypot(a * l.cos, b * l.sin);
    l.ry = Math.hypot(a * l.sin, b * l.cos);
    l.side = l.p > l.q * 1.5 ? "target" : l.q > l.p * 1.5 ? "reference" : "shared";
  }
  const samples = layout.samples.map((s) => {
    const [x, y] = toPlate(frame, ...samplePoint(layout.lobes[s.home], s.angle).slice(0, 2));
    return { x, y, cloud: s.cloud, home: s.home };
  });

  // Calipers: each cloud's spread (its entropy) is an ink spine down its outer side, solid for the
  // target and dashed cool for the reference, with a tick to every cluster it covers; the cluster
  // labels hang off those ticks, outside, so the gap between the clouds stays clear for the leak. A
  // warm caliper spans that gap (distance is divergence), raised above both clouds.
  const span = (side) => {
    const list = lobes.filter((l) => (side === "target" ? l.side === "target" : l.side === "reference"));
    if (!list.length) return null;
    return {
      list,
      top: Math.min(...list.map((l) => l.y - l.ry)),
      bottom: Math.max(...list.map((l) => l.y + l.ry)),
      outer: side === "target" ? Math.min(...list.map((l) => l.x - l.rx)) : Math.max(...list.map((l) => l.x + l.rx)),
      inner: side === "target" ? Math.max(...list.map((l) => l.x + l.rx)) : Math.min(...list.map((l) => l.x - l.rx)),
    };
  };
  const t = span("target");
  const r = span("reference");
  const calipers = {};
  if (t) calipers.target = { x: t.outer - LEADER, top: t.top, bottom: t.bottom, ticks: t.list.map((l) => ({ i: l.i, y: l.y, to: l.x - l.rx - 3 })) };
  if (r) calipers.reference = { x: r.outer + LEADER, top: r.top, bottom: r.bottom, ticks: r.list.map((l) => ({ i: l.i, y: l.y, to: l.x + l.rx + 3 })) };
  if (t && r) {
    const y = Math.max(22, Math.min(t.top, r.top) - 30);
    calipers.gap = { y, x0: t.inner + 4, x1: r.inner - 4, drop0: t.top, drop1: r.top };
  }

  // Labels: off their caliper's tick for the two clouds' own clusters, above or below for shared ones.
  const shared = lobes.filter((l) => l.side === "shared").sort((a, b) => a.y - b.y);
  const labels = lobes.map((l) => {
    if (l.side === "target" && calipers.target) return { i: l.i, align: "end", x: calipers.target.x - 10, y: l.y };
    if (l.side === "reference" && calipers.reference) return { i: l.i, align: "start", x: calipers.reference.x + 10, y: l.y };
    const above = shared.indexOf(l) % 2 === 0;
    return above ? { i: l.i, align: "above", x: l.x, y: l.y - l.ry - LEADER } : { i: l.i, align: "below", x: l.x, y: l.y + l.ry + LEADER };
  });
  const anchors = {};
  if (calipers.target) anchors["caliper:target"] = { x: calipers.target.x, y: calipers.target.bottom + 16, align: "center" };
  if (calipers.reference) anchors["caliper:reference"] = { x: calipers.reference.x, y: calipers.reference.bottom + 16, align: "center" };
  if (calipers.gap) anchors["caliper:gap"] = { x: (calipers.gap.x0 + calipers.gap.x1) / 2, y: calipers.gap.y - 14, align: "center" };
  for (const l of labels) anchors[`cluster:${l.i}`] = { x: l.x, y: l.y, align: l.align };

  // What jumps between the two exposures: every cluster whose share differs, boxed by warm brackets.
  const brackets = lobes
    .filter((l) => Math.abs(l.p - l.q) > 1e-9)
    .map((l) => ({ x0: l.x - l.rx - 7, y0: l.y - l.ry - 7, x1: l.x + l.rx + 7, y1: l.y + l.ry + 7 }));
  const crosses = [
    [26, 26],
    [frame.w - 26, 26],
    [26, frame.h - 26],
    [frame.w - 26, frame.h - 26],
  ];
  return { frame, lobes, samples, labels, calipers, anchors, brackets, crosses };
}

// The density one cloud puts at a plate point, normalised so the densest lobe peaks at 1: the same
// field the world's composite draws its contours from.
export function density(geometry, cloud, x, y) {
  let v = 0;
  for (const l of geometry.lobes) {
    const m = cloud === "target" ? l.dT : l.dR;
    if (m <= 0) continue;
    const dx = x - l.x, dy = y - l.y;
    const u = (l.cos * dx + l.sin * dy) / l.sx;
    const w = (-l.sin * dx + l.cos * dy) / l.sy;
    const q = u * u + w * w;
    if (q < 40) v += m * Math.exp(-0.5 * q);
  }
  return v;
}

// The hairline marks of the plate as segments [x0, y0, x1, y1] in plate px, by role: what the world
// draws over its field and what the SVG plate draws, from the same numbers.
export function plateMarks(g) {
  const c = g.calipers;
  // leaders: from each caliper tick to its cluster's outer contour; shared clusters' short drops
  const leaders = [];
  for (const side of ["target", "reference"]) {
    const cal = c[side];
    if (!cal) continue;
    const dir = side === "target" ? -1 : 1;
    for (const tk of cal.ticks) leaders.push([cal.x + dir * 6, tk.y, tk.to, tk.y]);
  }
  for (const l of g.labels) {
    if (l.align === "above") leaders.push([l.x, l.y + 4, l.x, l.y + LEADER - 3]);
    if (l.align === "below") leaders.push([l.x, l.y - 4, l.x, l.y - LEADER + 3]);
  }
  const caliper = (cal) =>
    cal
      ? [
          [cal.x, cal.top, cal.x, cal.bottom],
          [cal.x - 6, cal.top, cal.x + 6, cal.top],
          [cal.x - 6, cal.bottom, cal.x + 6, cal.bottom],
        ]
      : [];
  const gap = c.gap
    ? [
        [c.gap.x0, c.gap.y, c.gap.x1, c.gap.y],
        [c.gap.x0, c.gap.y - 6, c.gap.x0, c.gap.y + 6],
        [c.gap.x1, c.gap.y - 6, c.gap.x1, c.gap.y + 6],
      ]
    : [];
  const drops = c.gap
    ? [
        [c.gap.x0, c.gap.y + 9, c.gap.x0, c.gap.drop0 - 4],
        [c.gap.x1, c.gap.y + 9, c.gap.x1, c.gap.drop1 - 4],
      ]
    : [];
  const k = 11;
  const brackets = g.brackets.flatMap(({ x0, y0, x1, y1 }) => [
    [x0, y0 + k, x0, y0], [x0, y0, x0 + k, y0],
    [x1 - k, y0, x1, y0], [x1, y0, x1, y0 + k],
    [x1, y1 - k, x1, y1], [x1, y1, x1 - k, y1],
    [x0 + k, y1, x0, y1], [x0, y1, x0, y1 - k],
  ]);
  return { leaders, target: caliper(c.target), reference: caliper(c.reference), gap, drops, brackets };
}
