import { evidenceThreads } from "../lib/evidence.js";
import { clamp, smoothstep } from "./math.js";
import { DATA, INK, LIGHT_INK, WARM } from "./marks.js";

// The optical bench of the auditor and replay scenes: the auditor's station at the left end of a rail,
// Atlas at the right, the run's message budget as a roll of frames along the rail, and the run's real
// conversations as luminous ink filaments between the two. Each filament is drawn when its first
// message was sent, a bead runs out along it for every message and back for every reply, and when the
// verdict lands the filaments whose replies it quotes as evidence turn warm. Time is the run's own
// clock: the scroll drives it in the auditor scene, the replay player in the replay scene.

export const BENCH = { length: 2.6, drop: 0.62, half: [1.75, 0.95] };
const TRAVEL = 1400; // ms for a bead to run the length of a filament
const SEGMENTS = 30;
const GOLDEN = 2.399963229728653;

export function createBench(layout) {
  const A = layout.atlas.center;
  const S = [A[0] - BENCH.length, A[1], A[2]];
  const railY = A[1] - BENCH.drop;
  const bench = { station: S, atlas: A, threads: [], budget: 0, used: 0, end: 0, evidence: null, run: null };

  // Threads in the order they were opened. Sampling threads (sample1.1, sample1.2...) share a bundle:
  // asking the same question several times reads as filaments running side by side.
  bench.setRun = (run) => {
    bench.run = run ?? null;
    bench.warmSince = null;
    bench.threads = [];
    bench.budget = 0;
    bench.steps = [];
    bench.evidence = null;
    bench.end = 0;
    if (!run?.events?.length) return bench;
    const byName = new Map();
    const messages = new Map();
    for (const e of run.events) {
      if (e.type === "probe") {
        let th = byName.get(e.thread);
        if (!th) byName.set(e.thread, (th = { name: e.thread, first: e.t, messages: [] }));
        const m = { out: e.t, back: Infinity };
        th.messages.push(m);
        if (e.id) messages.set(e.id, m);
      } else if (e.type === "reply") {
        const m = messages.get(e.id) ?? byName.get(e.thread)?.messages.findLast((x) => x.back === Infinity);
        if (m) m.back = e.t;
      } else if (e.type === "budget") {
        bench.steps.push({ t: e.t, used: e.used });
        bench.budget = e.budget ?? bench.budget;
      }
    }
    bench.budget = run.budget || bench.budget || 1;
    const threads = [...byName.values()].sort((a, b) => a.first - b.first);
    const bundles = [];
    for (const th of threads) {
      const key = th.name.replace(/\.\d+$/, "");
      let b = bundles.find((x) => x.key === key);
      if (!b) bundles.push((b = { key, members: [] }));
      b.members.push(th);
    }
    bundles.forEach((b, i) => {
      const angle = Math.PI / 2 + 0.35 + i * GOLDEN;
      const radius = 0.5 + 0.09 * (i % 3);
      b.members.forEach((th, k) => {
        const off = k - (b.members.length - 1) / 2;
        th.stack = k;
        th.angle = angle + off * 0.09;
        th.radius = radius + off * 0.035;
        th.controls = controls(th.angle, th.radius);
      });
    });
    bench.threads = threads;
    let end = 0;
    for (const th of threads) for (const m of th.messages) end = Math.max(end, Number.isFinite(m.back) ? m.back : m.out + TRAVEL);
    bench.end = end;
    const ev = evidenceThreads(run);
    bench.evidence = ev.threads.size ? ev : null;
    return bench;
  };

  function controls(angle, radius) {
    const oy = Math.cos(angle) * radius;
    const oz = Math.sin(angle) * radius;
    const L = BENCH.length;
    return [
      S,
      [S[0] + L * 0.3, S[1] + oy * 0.92, S[2] + oz * 0.92],
      [A[0] - L * 0.34, A[1] + oy * 1.06, A[2] + oz * 1.06],
      A,
    ];
  }

  // Draws the bench for clock t (ms) with the weight its station has in the blend. f gives the
  // projection, the marks, the iris and the anchor map; returns the frames used so far.
  bench.draw = (t, weight, f) => {
    if (weight <= 0.002 || !bench.run) return 0;
    const { project, marks, energy } = f;
    const ink = marks.ink;
    const glow = marks.glow;
    const used = bench.steps.reduce((u, s) => (s.t <= t ? s.used : u), 0);
    bench.used = used;

    // The rail and its two posts.
    const r0 = project(S[0] - 0.16, railY, S[2]);
    const r1 = project(A[0] + 0.3, railY, A[2]);
    ink.line(r0.x, r0.y, r1.x, r1.y, { w: 0.5, c: DATA, a: 0.95 * weight });
    const s = project(...S);
    const sBase = project(S[0], railY, S[2]);
    const aBase = project(A[0], railY, A[2]);
    const aLow = project(A[0], A[1] - 0.46, A[2]);
    ink.line(sBase.x, sBase.y, s.x, s.y + f.irisReach, { w: 0.5, c: DATA, a: 0.55 * weight });
    ink.line(aBase.x, aBase.y, aLow.x, aLow.y, { w: 0.5, c: DATA, a: 0.55 * weight });

    // The roll: one frame per message of the budget, filled as messages are spent.
    const n = bench.budget;
    const dx = (r1.x - r0.x), dy = (r1.y - r0.y);
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    for (let k = 0; k < n; k++) {
      const x0 = S[0] + (k + 0.12) * (BENCH.length / n);
      const x1 = S[0] + (k + 0.88) * (BENCH.length / n);
      const p0 = project(x0, railY, S[2]);
      const p1 = project(x1, railY, S[2]);
      const h = 3.5;
      if (k < used) {
        ink.line(p0.x, p0.y - 5, p1.x, p1.y - 5, { w: h, c: INK, a: 0.92 * weight, butt: true });
      } else {
        const nx = -uy * h, ny = ux * h;
        const a = 0.75 * weight;
        ink.line(p0.x + nx, p0.y - 5 + ny, p1.x + nx, p1.y - 5 + ny, { w: 0.5, c: DATA, a });
        ink.line(p0.x - nx, p0.y - 5 - ny, p1.x - nx, p1.y - 5 - ny, { w: 0.5, c: DATA, a });
        ink.line(p0.x + nx, p0.y - 5 + ny, p0.x - nx, p0.y - 5 - ny, { w: 0.5, c: DATA, a });
        ink.line(p1.x + nx, p1.y - 5 + ny, p1.x - nx, p1.y - 5 - ny, { w: 0.5, c: DATA, a });
      }
    }

    // Filaments, drawn out behind their first bead, and the beads themselves. The evidence turns warm
    // over 700 ms of wall-clock time once the run's clock reaches the grade, so it does even when the
    // grade is the run's last event and the clock stops there.
    const warmAt = bench.evidence ? bench.evidence.t : Infinity;
    if (t < warmAt) bench.warmSince = null;
    else bench.warmSince ??= f.now ?? 0;
    const warmK = bench.warmSince == null ? 0 : f.instant ? 1 : smoothstep(0, 700, (f.now ?? 0) - bench.warmSince);
    const labels = f.labels;
    for (const th of bench.threads) {
      if (t < th.first) continue;
      const drawn = easeOut(clamp((t - th.first) / TRAVEL));
      const warm = bench.evidence?.threads.has(th.name) ? warmK : 0;
      const colour = warm > 0 ? mix(INK, WARM, warm) : INK;
      const pts = [];
      const steps = Math.max(2, Math.ceil(SEGMENTS * drawn));
      for (let i = 0; i <= steps; i++) pts.push(project(...bezier(th.controls, (i / steps) * drawn)));
      // Light first (it goes through the tone curve and the halation), then the crisp core over it.
      const path = pts.map((p) => [p.x, p.y]);
      glow.polyline(path, { w: 0.3, sigma: 1.6, c: LIGHT_INK, a: energy * (0.16 - 0.08 * warm) * weight, warm: energy * 0.9 * warm * weight });
      ink.polyline(path, { w: 0.5 + 0.1 * warm, c: colour, a: (0.58 + 0.34 * warm) * weight });
      for (const m of f.beads === false ? [] : th.messages) {
        const back = Number.isFinite(m.back) ? m.back : Infinity;
        const travel = Math.min(TRAVEL, (back - m.out) / 2);
        let u = -1;
        if (t >= m.out && t <= m.out + travel) u = easeInOut((t - m.out) / travel);
        else if (t >= back - travel && t <= back) u = 1 - easeInOut((t - (back - travel)) / travel);
        if (u < 0) continue;
        const b = project(...bezier(th.controls, u));
        glow.dot(b.x, b.y, 1, { sigma: 3.5, c: LIGHT_INK, a: energy * 0.5 * weight });
        ink.dot(b.x, b.y, 2.2, { c: INK, a: 0.95 * weight });
      }
      if (labels && drawn > 0.45) {
        const apex = project(...bezier(th.controls, 0.5));
        const mid = project((S[0] + A[0]) / 2, (S[1] + A[1]) / 2, (S[2] + A[2]) / 2);
        const ox = apex.x - mid.x, oy = apex.y - mid.y;
        const d = Math.hypot(ox, oy) || 1;
        // a bundle's labels stack outward from the apex, one line each
        const stack = (th.stack ?? 0) * 15 * (oy < 0 ? -1 : 1);
        labels.set(`thread:${th.name}`, { x: apex.x + (ox / d) * 14, y: apex.y + (oy / d) * 14 + stack, visible: true });
      }
    }
    if (labels) {
      labels.set("station:auditor", { x: s.x - f.irisReach, y: s.y + f.irisReach + 16, visible: true });
      labels.set("station:atlas", { x: r1.x, y: r1.y + 12, visible: true });
      const rail = project(S[0] + BENCH.length / 2, railY, S[2]);
      labels.set("rail", { x: r0.x, y: Math.max(r0.y, rail.y) + 14, visible: true });
    }
    return used;
  };

  return bench;
}

function bezier(c, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [
    a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
    a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
    a * c[0][2] + b * c[1][2] + d * c[2][2] + e * c[3][2],
  ];
}

const easeOut = (x) => 1 - (1 - x) * (1 - x);
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
