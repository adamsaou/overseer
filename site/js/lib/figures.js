import { LN2, esc, fixed } from "./format.js";
import { buildLayout } from "../world/layout.js";
import { density, entropyGeometry, LEVELS, plateMarks, PLATE } from "../world/compose.js";

// SVG figures drawn from the real data. scripts/build-site.ts prerenders them into the page as the
// stills that stay when WebGL doesn't run; the replay draws its bench with threadsFigure() at runtime.
// Every mark measures something: sample marks are answers, contours are clusters, bars are scores.
// Positions in meaning-space are illustrative (a scan records which cluster an answer fell into, never
// where clusters sit), laid out the way the world lays them out: the target's clusters to the left,
// the reference's to the right, on an axis that rises slightly to the right.

const r1 = (x) => Math.round(x * 10) / 10;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// The scan's clusters with each model's share, the side of the plate they belong to, and the letters
// the page uses for them: the target's clusters first (heaviest first), then shared, then the reference's.
export function scanGroups(scan) {
  const nT = scan.clusters.reduce((s, c) => s + c.target, 0) || 1;
  const nR = scan.clusters.reduce((s, c) => s + c.reference, 0) || 1;
  const clusters = scan.clusters.map((c, i) => {
    const p = c.target / nT;
    const q = c.reference / nR;
    const own = (p - q) / (p + q || 1);
    return { i, label: c.label, target: c.target, reference: c.reference, p, q, own, mass: Math.max(p, q), side: own > 0.34 ? "target" : own < -0.34 ? "reference" : "shared" };
  });
  const order = ["target", "shared", "reference"].flatMap((side) =>
    clusters.filter((c) => c.side === side).sort((a, b) => b.mass - a.mass || a.i - b.i),
  );
  order.forEach((c, k) => (c.letter = "ABCDEFGH"[k] ?? String(k + 1)));
  return { clusters, order, nT, nR };
}

// Lobe centres in meaning-space units: the world's own layout (world/layout.js), so a still drawn here
// and the live plate agree. Positions are centred on the layout's frame.
function lobes(scan) {
  const { order } = scanGroups(scan);
  const layout = buildLayout(scan);
  const f = layout.frame;
  return order.map((c) => {
    const l = layout.lobes[c.i];
    return { ...c, x: l.center[0] - f.x, y: l.center[1] - f.y, sigma: l.sigma };
  });
}

// Dots as zero-length round-capped segments in one path per brightness level: a few kilobytes for
// hundreds of particles.
function stipple(points, { color, width, levels = [0.3, 0.55, 0.9], opacity = 1 }) {
  const paths = levels.map(() => []);
  for (const [x, y, level] of points) paths[level].push(`M${r1(x)} ${r1(y)}h0`);
  return paths
    .map((d, k) => (d.length ? `<path d="${d.join("")}" stroke="${color}" stroke-opacity="${r1(levels[k] * opacity * 100) / 100}" stroke-width="${width}" stroke-linecap="round" fill="none"/>` : ""))
    .join("");
}

function body(rand, { x, y, sx, sy, angle = 0, count }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pts = [];
  for (let k = 0; k < count; k++) {
    const a = gauss(rand) * sx;
    const b = gauss(rand) * sy;
    const roll = rand();
    pts.push([x + a * cos - b * sin, y + a * sin + b * cos, roll < 0.55 ? 0 : roll < 0.87 ? 1 : 2]);
  }
  return pts;
}

const star = (x, y, s, fill) =>
  `<path d="M${r1(x)} ${r1(y - s)}L${r1(x + s * 0.28)} ${r1(y - s * 0.28)}L${r1(x + s)} ${r1(y)}L${r1(x + s * 0.28)} ${r1(y + s * 0.28)}L${r1(x)} ${r1(y + s)}L${r1(x - s * 0.28)} ${r1(y + s * 0.28)}L${r1(x - s)} ${r1(y)}L${r1(x - s * 0.28)} ${r1(y - s * 0.28)}Z" fill="${fill}"/>`;
const ring = (x, y, r, stroke, width = 1.5) => `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;

// Sample marks sit on a small ring inside their cluster, one per answer.
function marks(n, x, y, radius, draw) {
  if (n === 1) return draw(x, y);
  let out = "";
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n + 0.35;
    out += draw(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  return out;
}

// The reseau: a cross every step units, as a pattern so each figure carries a few bytes, not hundreds.
const reseau = (id, w, h, step, color, size = 4) =>
  `<pattern id="${id}-reseau" width="${step}" height="${step}" patternUnits="userSpaceOnUse"><path d="M${step / 2 - size} ${step / 2}h${size * 2}M${step / 2} ${step / 2 - size}v${size * 2}" stroke="${color}" stroke-width="1" fill="none"/></pattern><rect width="${w}" height="${h}" fill="url(#${id}-reseau)"/>`;

const registration = (x, y, r, color) =>
  `<g stroke="${color}" stroke-width="1" fill="none"><circle cx="${x}" cy="${y}" r="${r}"/><path d="M${x - r * 2} ${y}h${r}M${x + r} ${y}h${r}M${x} ${y - r * 2}v${r}M${x} ${y + r}v${r}"/></g>`;

// The hero's plate: both clouds at the scan's masses, and the light leak in the gap between them:
// a soft band through the midpoint, across the line between the clouds, faded where either cloud is
// dense. Its intensity is (JSD / ln 2)^1.2, peaking at 35% of ink; at JSD 0 nothing glows.
export function heroPlate(scan, { w = 900, h = 680 } = {}) {
  const scale = 205;
  const map = (l) => [w / 2 + l.x * scale, h / 2 - l.y * scale];
  const rand = mulberry32(20261022);
  const ls = lobes(scan);
  let target = [];
  let reference = [];
  for (const l of ls) {
    const [x, y] = map(l);
    const s = l.sigma * scale;
    if (l.p > 0) target = target.concat(body(rand, { x, y, sx: s * 1.08, sy: s * 0.9, angle: -0.35, count: Math.round(560 * l.p) }));
    if (l.q > 0) reference = reference.concat(body(rand, { x, y, sx: s * 1.02, sy: s * 0.94, angle: 0.4, count: Math.round(480 * l.q) }));
  }
  const centroid = (key) => {
    let x = 0;
    let y = 0;
    for (const l of ls) {
      const [px, py] = map(l);
      x += px * l[key];
      y += py * l[key];
    }
    return [x, y];
  };
  const [tx, ty] = centroid("p");
  const [qx, qy] = centroid("q");
  const glow = Math.pow(Math.min(1, Math.max(0, scan.divergence) / LN2), 1.2);
  const mx = r1((tx + qx) / 2);
  const my = r1((ty + qy) / 2);
  const dist = Math.max(40, Math.hypot(qx - tx, qy - ty));
  const across = r1((Math.atan2(qy - ty, qx - tx) * 180) / Math.PI + 90);
  const fades = ls.map((l) => {
    const [x, y] = map(l);
    return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(l.sigma * scale * 1.6)}" fill="url(#hp-fade)"/>`;
  });
  // the band fills the gap (the world's gap.js): about as long as the clouds are tall, never more than
  // 0.6 of the distance between them, a quarter of it wide, with faint streaks along it
  const long = r1(dist * 0.55);
  const streaks = [-0.07, 0.015, 0.09]
    .map((o, k) => `<path d="M${r1(mx - long * (0.8 - k * 0.12))} ${r1(my + o * dist)}H${r1(mx + long * (0.7 + k * 0.1))}" stroke="var(--warm)" stroke-opacity="${r1(glow * 6) / 100}" stroke-width=".8"/>`)
    .join("");
  const leak =
    glow > 0.001
      ? `<g mask="url(#hp-mask)"><g transform="rotate(${across} ${mx} ${my})"><ellipse cx="${mx}" cy="${my}" rx="${long}" ry="${r1(dist * 0.26)}" fill="url(#hp-band)"/>${streaks}</g></g>`
      : "";
  const halos = ls
    .filter((l) => l.p > l.q && glow > 0.001)
    .map((l) => {
      const [x, y] = map(l);
      return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(l.sigma * scale * 2.1 * Math.sqrt((l.p - l.q) / l.p))}" fill="url(#hp-halo)"/>`;
    })
    .join("");
  const samples = ls
    .map((l) => {
      const [x, y] = map(l);
      return marks(l.target, x - 6, y - 4, 11, (a, b) => star(a, b, 6, "var(--ink)")) + marks(l.reference, x + 6, y + 4, 11, (a, b) => ring(a, b, 4.5, "var(--cool)", 1.4));
    })
    .join("");
  return `<svg class="plate-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
<defs>
<radialGradient id="hp-band"><stop offset="0" stop-color="var(--warm)" stop-opacity="${r1(glow * 28) / 100}"/><stop offset=".5" stop-color="var(--warm)" stop-opacity="${r1(glow * 14) / 100}"/><stop offset="1" stop-color="var(--warm)" stop-opacity="0"/></radialGradient>
<radialGradient id="hp-fade"><stop offset="0" stop-color="#000"/><stop offset=".5" stop-color="#000" stop-opacity=".8"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="hp-halo"><stop offset="0" stop-color="var(--warm)" stop-opacity="${r1(glow * 12) / 100}"/><stop offset="1" stop-color="var(--warm)" stop-opacity="0"/></radialGradient>
<mask id="hp-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${fades.join("")}</mask>
</defs>
${reseau("hp", w, h, 64, "var(--reseau)")}
${halos}
${leak}
${stipple(reference, { color: "var(--cool)", width: 2.6, opacity: 0.7 })}
${stipple(target, { color: "var(--ink)", width: 2.4 })}
${samples}
</svg>`;
}

// Scene 1: the target's mass merged into one body, Atlas, with the reference dimmed to 15%.
export function atlasPlate(scan, { w = 900, h = 680 } = {}) {
  const scale = 205;
  const rand = mulberry32(5);
  const ls = lobes(scan);
  let reference = [];
  let cx = 0;
  let cy = 0;
  for (const l of ls) {
    const x = w / 2 + l.x * scale;
    const y = h / 2 - l.y * scale;
    cx += x * l.p;
    cy += y * l.p;
    if (l.q > 0) reference = reference.concat(body(rand, { x, y, sx: l.sigma * scale * 1.3, sy: l.sigma * scale * 1.2, count: Math.round(300 * l.q) }));
  }
  const atlas = body(rand, { x: cx, y: cy, sx: 0.48 * scale * 0.92, sy: 0.48 * scale * 1.1, angle: 0.18, count: 820 });
  return {
    svg: `<svg class="plate-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
${reseau("at", w, h, 64, "var(--reseau)")}
${stipple(reference, { color: "var(--cool)", width: 2.8, opacity: 0.15 })}
${stipple(atlas, { color: "var(--ink)", width: 2.6 })}
</svg>`,
    // Where the sleeve sits beside Atlas, as a fraction of the plate.
    sleeve: { x: (cx + 0.48 * scale * 1.7) / w, y: (cy - 0.48 * scale * 0.9) / h },
    atlas: { x: cx / w, y: (cy + 0.48 * scale * 2.1) / h },
  };
}

// The glassine negative sleeve the objective is sealed in: an open-topped sleeve of translucent paper
// with the plate card faint inside it, a fold seam a quarter of the way down, a straight flap folded
// over the opening and the warm seal across the flap's edge. The replay opens it by lifting the flap
// and sliding the card up out of the sleeve.
export function sleeve({ cls = "sleeve-svg" } = {}) {
  const line = 'stroke-width="1" vector-effect="non-scaling-stroke"';
  return `<svg class="${cls}" viewBox="-2 -2 76 52" aria-hidden="true" focusable="false"><g class="sleeve-card"><rect x="8" y="15" width="56" height="31" fill="var(--raised)" stroke="var(--muted)" ${line}/><path d="M36 24v12M30 30h12" stroke="var(--axis)" ${line}/></g><path d="M0 12V48H72V12" fill="var(--plate)" fill-opacity=".78" stroke="var(--ink)" ${line}/><path class="sleeve-seam" d="M0 12H72" stroke="var(--axis)" ${line}/><g class="sleeve-flap"><path d="M0 12V21H72V12" fill="var(--plate)" fill-opacity=".9" stroke="var(--ink)" ${line}/><circle class="sleeve-seal" cx="36" cy="21" r="3.5" fill="var(--warm)"/></g></svg>`;
}

// The run scene's closed shutter, for the page without WebGL: nine blades shut over the plate inside
// the housing and its ring of 72 ticks, as the world draws it when the loop stops.
export function shutterFigure({ size = 300 } = {}) {
  const c = size / 2;
  const R = size * 0.36;
  let ticks = "";
  for (let k = 0; k < 72; k++) {
    const a = (k * Math.PI) / 36;
    const r2 = R + (k % 6 === 0 ? 14 : 8);
    ticks += `M${r1(c + Math.cos(a) * (R + 5))} ${r1(c + Math.sin(a) * (R + 5))}L${r1(c + Math.cos(a) * r2)} ${r1(c + Math.sin(a) * r2)}`;
  }
  // each blade's edge runs from the rim to the centre on an arc, as the iris draws them closed
  let blades = "";
  for (let k = 0; k < 9; k++) {
    const a = (k * 2 * Math.PI) / 9 - Math.PI / 2;
    const b = a + 1.1;
    blades += `M${r1(c + Math.cos(a) * R)} ${r1(c + Math.sin(a) * R)}Q${r1(c + Math.cos(b) * R * 0.52)} ${r1(c + Math.sin(b) * R * 0.52)} ${r1(c)} ${r1(c)}`;
  }
  return `<svg class="shutter-svg" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><circle cx="${c}" cy="${c}" r="${R}" fill="var(--raised)" stroke="var(--axis)" stroke-width="1"/><path d="${blades}" fill="none" stroke="var(--axis)" stroke-width="1"/><path d="${ticks}" fill="none" stroke="var(--axis)" stroke-width="1"/><path d="M${c} ${r1(c - R - 26)}v9" stroke="var(--muted)" stroke-width="1"/></svg>`;
}

// Threads of an audit: one line per conversation from the auditor's station to Atlas, in the order
// they were opened, and the budget as a roll of frames. Returns the label positions as fractions.
export function threadsFigure(run, { w = 900, h = 560, upTo = Infinity, id = "th" } = {}) {
  const threads = [];
  let used = 0;
  for (const e of run.events) {
    if (e.t > upTo) break;
    if (e.type === "budget") used = e.used;
    if (e.type === "probe") {
      let th = threads.find((x) => x.name === e.thread);
      if (!th) threads.push((th = { name: e.thread, t: e.t, probes: 0, replies: 0 }));
      th.probes++;
    }
    if (e.type === "reply") {
      const th = threads.find((x) => x.name === e.thread);
      if (th) th.replies++;
    }
  }
  const budget = run.budget || used || 1;
  const A = [130, Math.round(h * 0.42)];
  const B = [w - 130, Math.round(h * 0.42)];
  const curves = threads.map((th, i) => {
    const off = (i % 2 ? 1 : -1) * (30 + Math.floor(i / 2) * 34);
    const c1 = [A[0] + 210, A[1] + off * 1.25];
    const c2 = [B[0] - 210, B[1] + off * 1.25];
    const apex = [(A[0] + 3 * c1[0] + 3 * c2[0] + B[0]) / 8, (A[1] + 3 * c1[1] + 3 * c2[1] + B[1]) / 8];
    const d = `M${A[0]} ${A[1]}C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${B[0]} ${B[1]}`;
    return { ...th, d, apex: { x: apex[0] / w, y: apex[1] / h }, off };
  });
  let ticks = "";
  for (let k = 0; k < 72; k++) {
    const a = (k * Math.PI) / 36;
    const long = k % 6 === 0;
    const r0 = 40;
    const r2 = long ? 49 : 44;
    ticks += `M${r1(A[0] + Math.cos(a) * r0)} ${r1(A[1] + Math.sin(a) * r0)}L${r1(A[0] + Math.cos(a) * r2)} ${r1(A[1] + Math.sin(a) * r2)}`;
  }
  let blades = "";
  for (let k = 0; k < 9; k++) {
    const a = (k * 2 * Math.PI) / 9;
    const b = a + (2 * Math.PI) / 9;
    blades += `M${r1(A[0] + Math.cos(a) * 14)} ${r1(A[1] + Math.sin(a) * 14)}Q${r1(A[0] + Math.cos((a + b) / 2) * 30)} ${r1(A[1] + Math.sin((a + b) / 2) * 30)} ${r1(A[0] + Math.cos(b + 0.5) * 34)} ${r1(A[1] + Math.sin(b + 0.5) * 34)}`;
  }
  const rand = mulberry32(9);
  const atlas = body(rand, { x: B[0], y: B[1], sx: 26, sy: 30, angle: 0.2, count: 220 });
  const railX = A[0];
  const railW = B[0] - A[0];
  const gap = 4;
  const fw = (railW - gap * (budget - 1)) / budget;
  let frames = "";
  for (let k = 0; k < budget; k++) {
    const x = railX + k * (fw + gap);
    frames += k < used ? `<rect x="${r1(x)}" y="${h - 64}" width="${r1(fw)}" height="14" fill="var(--ink)"/>` : `<rect x="${r1(x + 0.5)}" y="${h - 63.5}" width="${r1(fw - 1)}" height="13" fill="none" stroke="var(--axis)" stroke-width="1"/>`;
  }
  const svg = `<svg class="plate-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
${reseau(id, w, h - 80, 64, "var(--reseau)")}
<g fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-opacity=".62">${curves.map((c) => `<path d="${c.d}"/>`).join("")}</g>
<g fill="var(--ink)">${curves.map((c) => `<circle cx="${r1(c.apex.x * w)}" cy="${r1(c.apex.y * h)}" r="2.2"/>`).join("")}</g>
<g fill="none" stroke="var(--ink)" stroke-width="1"><circle cx="${A[0]}" cy="${A[1]}" r="36"/><circle cx="${A[0]}" cy="${A[1]}" r="14"/><path d="${blades}" stroke-opacity=".55"/><path d="M${A[0] - 6} ${A[1]}h12M${A[0]} ${A[1] - 6}v12" stroke-opacity=".8"/></g>
<path d="${ticks}" stroke="var(--axis)" stroke-width="1" fill="none"/>
${stipple(atlas, { color: "var(--ink)", width: 2 })}
<path d="M${railX} ${h - 72}h${railW}" stroke="var(--axis)" stroke-width="1"/>
${frames}
</svg>`;
  return {
    svg,
    threads: curves.map((c) => ({ name: c.name, t: c.t, probes: c.probes, x: c.apex.x, y: c.apex.y - (c.off < 0 ? 0.035 : -0.035) })),
    used,
    budget,
    // Station labels hang inward from the stations' outer edges, so they never leave the figure.
    stations: { auditor: { x: (A[0] - 49) / w, y: (A[1] + 66) / h }, atlas: { x: (B[0] + 40) / w, y: (B[1] + 66) / h }, rail: { x: railX / w, y: (h - 34) / h } },
  };
}

// The worked example on its measuring plate, drawn from the same geometry the world frames its
// entropy station by (world/compose.js): the contours are traced from the same density field the
// world's composite draws them from, so the SVG, the live plate and the blink stills register. The
// target's answers are ink stars and the reference's hollow cool rings; calipers for spread
// (entropy) and gap (divergence); warm brackets for the clusters whose occupancy jumps between the
// two exposures. With `photo`, the field itself (reseau and leak) comes from a still under the SVG.
export function scanPlate(scan, { layer = "both", id = "sp", photo = false } = {}) {
  const { w, h } = PLATE;
  const g = entropyGeometry(buildLayout(scan));
  const lines = plateMarks(g);
  const { order } = scanGroups(scan);
  const letter = new Map(order.map((c) => [c.i, c.letter]));
  const seg = (list) => list.map(([x0, y0, x1, y1]) => `M${r1(x0)} ${r1(y0)}L${r1(x1)} ${r1(y1)}`).join("");
  const iso = (cloud) => LEVELS.map((level, k) => `<path d="${isoline(g, cloud, level)}" stroke-opacity="${[0.85, 0.5, 0.32][k]}"/>`).join("");
  const targetMarks = g.samples.filter((s) => s.cloud === 0).map((s) => star(s.x, s.y, 7, "var(--ink)")).join("");
  const referenceMarks = g.samples.filter((s) => s.cloud === 1).map((s) => ring(s.x, s.y, 4.6, "var(--cool)", 1.4)).join("");
  // Each cluster's letter sits off its contour's upper left; the page sets it as text over the
  // plate (positions.keys), so it stays legible at every size.
  const keys = g.lobes.map((l) => ({ letter: letter.get(l.i) ?? "", x: (l.x - l.rx * 0.78) / w, y: (l.y - l.ry * 0.78) / h, side: l.side }));
  const intensity = 0.35 * Math.pow(Math.min(1, Math.max(0, scan.divergence) / LN2), 1.2);
  const gap = g.calipers.gap;
  const band = !photo && gap
    ? `<defs><radialGradient id="${id}-band"><stop offset="0" stop-color="var(--warm)" stop-opacity="${r1(intensity * 100) / 100}"/><stop offset=".4" stop-color="var(--warm)" stop-opacity="${r1(intensity * 36) / 100}"/><stop offset="1" stop-color="var(--warm)" stop-opacity="0"/></radialGradient></defs><ellipse cx="${r1((gap.x0 + gap.x1) / 2)}" cy="${r1(h / 2)}" rx="${r1(Math.max(24, (gap.x1 - gap.x0) * 0.7))}" ry="${r1(h * 0.36)}" fill="url(#${id}-band)"/>`
    : "";
  const positions = {
    clusters: g.labels.map((l) => {
      const c = order.find((x) => x.i === l.i);
      return { i: l.i, letter: letter.get(l.i), side: c.side, label: c.label, target: c.target, reference: c.reference, x: l.x / w, y: l.y / h, align: l.align };
    }),
    calipers: Object.fromEntries(["target", "reference", "gap"].map((k) => [k, g.anchors[`caliper:${k}`] ? { x: g.anchors[`caliper:${k}`].x / w, y: g.anchors[`caliper:${k}`].y / h } : null])),
    keys,
  };
  const svg = `<svg class="plate-svg scan-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false" data-layer="${layer}">
<g class="field">
${photo ? "" : reseau(id, w, h, 64, "var(--reseau)")}
${band}
<g fill="none" stroke="var(--ink)" stroke-width="1" vector-effect="non-scaling-stroke">${iso("target")}</g>
<g fill="none" stroke="var(--cool)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke">${iso("reference")}</g>
<path d="${seg(lines.leaders)}" stroke="var(--muted)" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/>
<path d="${seg(lines.target)}" stroke="var(--ink)" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/>
<path d="${seg(lines.reference)}" stroke="var(--cool)" stroke-width="1" stroke-dasharray="4 3" fill="none" vector-effect="non-scaling-stroke"/>
<path d="${seg(lines.gap)}" stroke="var(--warm)" stroke-width="1.2" fill="none" vector-effect="non-scaling-stroke"/>
<path d="${seg(lines.drops)}" stroke="var(--warm)" stroke-opacity=".4" stroke-dasharray="2 4" stroke-width="1" fill="none" vector-effect="non-scaling-stroke"/>
${g.crosses.map(([x, y]) => registration(x, y, 6, "var(--axis)")).join("")}
</g>
${layer !== "reference" ? `<g class="answers answers-target">${targetMarks}</g>` : ""}
${layer !== "target" ? `<g class="answers answers-reference">${referenceMarks}</g>` : ""}
<path class="brackets" d="${seg(lines.brackets)}" stroke="var(--warm)" stroke-width="1.6" fill="none" vector-effect="non-scaling-stroke"/>
</svg>`;
  return { svg, positions, jumped: g.brackets.length };
}

// An iso-density line of one cloud as an SVG path: marching squares over the plate, with each
// crossing interpolated along its cell edge, stitched into polylines and thinned.
function isoline(g, cloud, level, step = 5) {
  const { w, h } = PLATE;
  const nx = Math.ceil(w / step) + 1;
  const ny = Math.ceil(h / step) + 1;
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = density(g, cloud, i * step, j * step) - level;
  const segments = [];
  const cross = (i0, j0, i1, j1) => {
    const a = v[j0 * nx + i0];
    const b = v[j1 * nx + i1];
    const t = a / (a - b);
    return [(i0 + (i1 - i0) * t) * step, (j0 + (j1 - j0) * t) * step];
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const c = (v[j * nx + i] > 0 ? 8 : 0) | (v[j * nx + i + 1] > 0 ? 4 : 0) | (v[(j + 1) * nx + i + 1] > 0 ? 2 : 0) | (v[(j + 1) * nx + i] > 0 ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const top = () => cross(i, j, i + 1, j);
      const right = () => cross(i + 1, j, i + 1, j + 1);
      const bottom = () => cross(i, j + 1, i + 1, j + 1);
      const left = () => cross(i, j, i, j + 1);
      const pairs = {
        1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]],
        5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]],
        9: [[top, bottom]], 10: [[top, right], [left, bottom]], 11: [[top, right]], 12: [[left, right]],
        13: [[bottom, right]], 14: [[left, bottom]],
      }[c];
      for (const [p, q] of pairs) segments.push([p(), q()]);
    }
  }
  // stitch segments that share endpoints into polylines
  const key = ([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const ends = new Map();
  segments.forEach((s, k) => {
    for (const e of [0, 1]) {
      const kk = key(s[e]);
      if (!ends.has(kk)) ends.set(kk, []);
      ends.get(kk).push(k);
    }
  });
  const used = new Uint8Array(segments.length);
  const lines = [];
  for (let k = 0; k < segments.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const line = [segments[k][0], segments[k][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? line.at(-1) : line[0];
        const next = (ends.get(key(tip)) ?? []).find((n) => !used[n]);
        if (next === undefined) break;
        used[next] = 1;
        const [a, b] = segments[next];
        const p = key(a) === key(tip) ? b : a;
        if (dir) line.push(p);
        else line.unshift(p);
      }
    }
    lines.push(thin(line, 0.35));
  }
  return lines
    .map((line) => {
      const closed = line.length > 3 && key(line[0]) === key(line.at(-1));
      const pts = closed ? line.slice(0, -1) : line;
      return `M${pts.map(([x, y]) => `${r1(x)} ${r1(y)}`).join("L")}${closed ? "Z" : ""}`;
    })
    .join("");
}

// Douglas-Peucker: drop points that sit within `tol` px of the line through their neighbours.
function thin(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      // a closed loop starts and ends on the same point: measure from that point instead
      const d = len < 1e-6
        ? Math.hypot(points[i][0] - ax, points[i][1] - ay)
        : Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
      if (d > far) {
        far = d;
        at = i;
      }
    }
    if (far > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// The oversight-gap grid as a small multiple: auditors across, targets down, one plate per tool
// condition. A measured cell is a column as tall as its score with its approximate 95% interval as a
// haze; a measured zero is a lit floor ring so it never reads as a cell that wasn't run.
export function gapPlate(cells, { tools, models, color, title, w = 430, h = 456 }) {
  const ox = 104;
  const oy = 80;
  const cw = (w - ox - 10) / 3;
  const ch = (h - oy - 20) / 3;
  const keys = models.map((m) => m.key);
  const rank = Object.fromEntries(keys.map((m, i) => [m, i]));
  let out = "";
  keys.forEach((target, row) => {
    keys.forEach((auditor, col) => {
      const x = ox + col * cw;
      const y = oy + row * ch;
      const cx = x + cw / 2;
      const base = y + ch - 22;
      const c = cells.find((k) => k.tools === tools && k.auditor === auditor && k.target === target);
      const key = `${tools}:${auditor}:${target}`;
      let mark = "";
      if (!c) {
        mark = `${registration(r1(cx), r1(y + ch / 2 - 6), 4, "var(--axis)")}<text x="${r1(cx)}" y="${r1(y + ch / 2 + 20)}" class="svg-note" text-anchor="middle">not run</text>`;
      } else {
        const top = base - c.score * 58;
        const [lo, hi] = c.interval;
        mark += `<rect x="${r1(cx - 17)}" y="${r1(base - hi * 58)}" width="34" height="${r1(Math.max(1, (hi - lo) * 58))}" fill="${color}" fill-opacity=".14"/>`;
        mark += c.score > 0 ? `<rect x="${r1(cx - 5)}" y="${r1(top)}" width="10" height="${r1(base - top)}" fill="${color}"/>` : `<ellipse cx="${r1(cx)}" cy="${base}" rx="16" ry="4.5" fill="none" stroke="${color}" stroke-width="1.4"/>`;
        mark += `<text x="${r1(cx)}" y="${r1(Math.min(top, base - hi * 58) - 8)}" class="svg-value" text-anchor="middle">${fixed(c.score)}</text>`;
      }
      if (rank[auditor] < rank[target]) {
        const k = 9;
        const x0 = x + 6;
        const x1 = x + cw - 6;
        const y0 = y + 6;
        const y1 = y + ch - 6;
        mark += `<path d="M${r1(x0)} ${r1(y0 + k)}V${r1(y0)}H${r1(x0 + k)}M${r1(x1 - k)} ${r1(y0)}H${r1(x1)}V${r1(y0 + k)}M${r1(x1)} ${r1(y1 - k)}V${r1(y1)}H${r1(x1 - k)}M${r1(x0 + k)} ${r1(y1)}H${r1(x0)}V${r1(y1 - k)}" stroke="var(--axis)" stroke-dasharray="3 3" fill="none"/>`;
      }
      out += `<g class="gap-cell" data-cell="${key}" data-tools="${tools}" data-auditor="${auditor}" data-target="${target}"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(cw)}" height="${r1(ch)}" fill="transparent"/>${mark}<path d="M${r1(x + 12)} ${base}H${r1(x + cw - 12)}" stroke="var(--rule)"/></g>`;
    });
  });
  // The family's names (the version is the same for all, and the table beside says it), and
  // initials for phones, where the plates are too small for names.
  const name = (m) => esc(m.label.trim().split(/\s+/)[0]);
  const initial = (m) => esc(m.label.trim()[0] ?? "");
  const heads = models
    .map((m, i) => `<text x="${r1(ox + i * cw + cw / 2)}" y="${oy - 12}" class="svg-label" text-anchor="middle"><tspan class="svg-full">${name(m)}</tspan><tspan class="svg-short">${initial(m)}</tspan></text>`)
    .join("");
  const rows = models
    .map((m, i) => `<text x="${ox - 12}" y="${r1(oy + i * ch + ch / 2)}" class="svg-label" text-anchor="end" dominant-baseline="middle"><tspan class="svg-full">${name(m)}</tspan><tspan class="svg-short">${initial(m)}</tspan></text>`)
    .join("");
  return `<svg class="gap-svg" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">
<text x="10" y="20" class="svg-title">${esc(title)}</text>
<text x="${ox}" y="${oy - 38}" class="svg-note">AUDITOR →</text>
<text x="10" y="${oy - 12}" class="svg-note">TARGET ↓</text>
${heads}${rows}
<path d="M${ox} ${oy - 4}H${w - 10}" stroke="var(--rule)"/>
${out}
</svg>`;
}

// The JSD scale on the right edge: 0 to ln 2 with a tick every 0.01, and the warm needle.
export function jsdScale({ value = 0, height = 380 } = {}) {
  const y0 = height - 12;
  const y1 = 22;
  const yOf = (v) => y0 - (v / LN2) * (y0 - y1);
  let ticks = "";
  for (let k = 0; k <= 69; k++) {
    const len = k % 10 === 0 ? 10 : k % 5 === 0 ? 7 : 4;
    ticks += `M${30 - len} ${r1(yOf(k / 100))}h${len}`;
  }
  ticks += `M18 ${y1}h12`;
  let labels = "";
  for (let k = 0; k <= 6; k++) labels += `<text x="36" y="${r1(yOf(k / 10))}" class="svg-tick" dominant-baseline="middle">${k ? `0.${k}` : "0"}</text>`;
  return `<svg class="scale-svg jsd-svg" width="78" height="${height}" viewBox="0 0 78 ${height}" data-y0="${y0}" data-y1="${y1}" aria-hidden="true" focusable="false">
<path d="M30 ${y1}V${y0}" stroke="var(--axis)"/>
<path d="${ticks}" stroke="var(--axis)"/>
${labels}<text x="36" y="${y1}" class="svg-tick" dominant-baseline="middle">ln 2</text>
<g class="needle" id="jsd-needle" style="transform: translateY(${r1(yOf(value) - y0)}px)"><path d="M0 ${y0}H28" stroke="var(--warm)" stroke-width="1.6"/><path d="M22 ${y0 - 4}L29 ${y0}L22 ${y0 + 4}Z" fill="var(--warm)"/></g>
</svg>`;
}

// The entropy scale along the bottom: 0 to ln n, a solid ink tick for the target, a hollow cool tick
// for the reference.
export function entropyScale({ target = 0, reference = 0, n = 4, width = 380 } = {}) {
  const max = Math.log(Math.max(2, n));
  const x0 = 8;
  const x1 = width - 8;
  const xOf = (v) => x0 + (v / max) * (x1 - x0);
  let ticks = "";
  const steps = Math.floor(max / 0.02);
  for (let k = 0; k <= steps; k++) {
    const len = k % 25 === 0 ? 9 : k % 5 === 0 ? 6 : 3;
    ticks += `M${r1(xOf(k * 0.02))} 30v-${len}`;
  }
  ticks += `M${x1} 30v-9`;
  return `<svg class="scale-svg h-svg" width="${width}" height="54" viewBox="0 0 ${width} 54" data-x0="${x0}" data-x1="${x1}" data-max="${max}" aria-hidden="true" focusable="false">
<path d="M${x0} 30H${x1}" stroke="var(--axis)"/>
<path d="${ticks}" stroke="var(--axis)"/>
<text x="${x0}" y="46" class="svg-tick">0</text><text x="${x1}" y="46" class="svg-tick" text-anchor="end">ln ${n}</text>
<g class="needle" id="h-target-mark" style="transform: translateX(${r1(xOf(target) - x0)}px)"><rect x="${x0 - 1.5}" y="12" width="3" height="18" fill="var(--ink)"/></g>
<g class="needle" id="h-reference-mark" style="transform: translateX(${r1(xOf(reference) - x0)}px)"><rect x="${x0 - 2.5}" y="12.5" width="5" height="17" fill="none" stroke="var(--cool)" stroke-width="1.2"/></g>
</svg>`;
}

// Small calibrated scale for one entropy readout in the worked example, 0 to ln n. The last one
// carries the axis's end labels itself, so they can't drift from the ticks they name.
export function miniScale(value, max, { solid = true, width = 180, ends = null } = {}) {
  const x = 4 + (Math.min(value, max) / max) * (width - 8);
  let ticks = "";
  for (let k = 0; k <= 10; k++) ticks += `M${r1(4 + (k / 10) * (width - 8))} 16v-${k % 5 ? 3 : 6}`;
  const mark = solid ? `<rect x="${r1(x - 1.5)}" y="2" width="3" height="14" fill="var(--ink)"/>` : `<rect x="${r1(x - 2.5)}" y="2.5" width="5" height="13" fill="none" stroke="var(--cool)" stroke-width="1.2"/>`;
  const h = ends ? 32 : 18;
  const labels = ends ? `<text x="4" y="30" class="svg-tick">0</text><text x="${width - 4}" y="30" class="svg-tick" text-anchor="end">${esc(ends)}</text>` : "";
  return `<svg class="mini-scale" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true" focusable="false"><path d="M4 16H${width - 4}" stroke="var(--axis)"/><path d="${ticks}" stroke="var(--axis)"/>${mark}${labels}</svg>`;
}
