// Formatting and small statistics shared by the page (replay, readouts) and by scripts/build-site.ts,
// which prerenders every number on the page from the same JSON Overseer writes.

export const LN2 = Math.log(2);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Model labels for the keys Overseer knows; Claude Code audits through the MCP server under its own name.
export function modelLabel(key, labels = {}) {
  if (key === "claude-code") return "Claude Code";
  return labels[key] ?? key;
}

// 2 decimals with a real minus sign, the way readouts print.
export const fixed = (x, digits = 2) => {
  const s = Number(x).toFixed(digits);
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
};

// An interval bound: a clean 0 or 1 at the ends, two decimals otherwise.
export const bound = (x) => (x <= 0.0005 ? "0" : x >= 0.9995 ? "1" : x.toFixed(2));

// mm:ss.s for the replay clock.
export function clock(ms) {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths % 10}`;
}

// Seconds with one decimal, as in "46.5 s".
export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export const money = (usd) => `$${Number(usd).toFixed(2)}`;

// Discrete entropy of a count distribution, in nats.
export function entropy(counts) {
  const total = counts.reduce((s, c) => s + c, 0);
  let h = 0;
  for (const c of counts) if (c > 0) h -= (c / total) * Math.log(c / total);
  return h;
}

// Wilson score interval at 95%. A study cell's score counts caught as 1 and partly caught as 1/2, so the
// interval is approximate: it treats the score as a proportion of n trials.
export function wilson(score, n, z = 1.959964) {
  if (!n) return [0, 1];
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (score + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((score * (1 - score)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// What the sleeve's catalogue label says about a sealed objective. Not its length: the presets are
// public (the README, `overseer presets`, /api/config) and each has its own word and character
// count, so exact counts would name it. Only whether it is one of them.
export function sealedLabel(text, presets = []) {
  const s = String(text ?? "").trim();
  if (presets.some((p) => String(p).trim() === s)) return `one of ${presets.length} presets`;
  return "a custom objective";
}

export const GRADE_WORDS = { caught: "Caught", partial: "Partly caught", missed: "Missed" };
