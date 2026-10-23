// Which replies a verdict's evidence quotes came from. The replay's log underlines the quotes in
// place and the world turns those conversations' filaments warm, so both read the run the same way.

// Model replies are Markdown; the log shows them as plain text, keeping line breaks and list marks.
export function plainText(md) {
  return String(md ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

// Finds a quote in a reply, ignoring case, spacing and curly quotes, and returns its range in the reply.
export function locate(text, quote) {
  const fold = (c) => (/[‘’]/.test(c) ? "'" : /[“”]/.test(c) ? '"' : /[–—]/.test(c) ? "-" : c.toLowerCase());
  const map = [];
  let norm = "";
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!space && norm) {
        norm += " ";
        map.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    norm += fold(c);
    map.push(i);
  }
  let q = "";
  for (const c of String(quote).replace(/[.…\s]+$/, "")) q += /\s/.test(c) ? " " : fold(c);
  q = q.replace(/ +/g, " ").trim();
  if (q.length < 8) return null;
  let at = norm.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const head = q.slice(0, 48);
    at = norm.indexOf(head);
    len = head.length;
  }
  if (at < 0) return null;
  return [map[at], map[at + len - 1] + 1];
}

// Whether the verdict's quotes turned out to carry the objective: not when the audit missed it.
export const carriesObjective = (run) => (run?.events?.findLast((e) => e.type === "grade")?.grade?.label ?? run?.result?.grade?.label) !== "missed";

// The conversations whose replies the (last) verdict quotes as evidence of the objective, and when
// that is known: at the grade, which says whether the quotes carried it. Warm marks hidden intent, so
// a missed audit's quotes don't count, and nothing turns warm before the stamp lands.
export function evidenceThreads(run) {
  const verdict = run?.events?.findLast((e) => e.type === "verdict");
  const grade = run?.events?.findLast((e) => e.type === "grade");
  const threads = new Set();
  const quotes = verdict?.verdict?.evidence ?? [];
  if (!quotes.length || !carriesObjective(run)) return { threads, t: Infinity };
  for (const e of run.events) {
    if (e.type !== "reply" || e.t > verdict.t) continue;
    const plain = plainText(e.text);
    if (quotes.some((q) => locate(plain, q))) threads.add(e.thread);
  }
  return { threads, t: Math.max(verdict.t, grade?.t ?? verdict.t) };
}
