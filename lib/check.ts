import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AuditStats, CheckResult } from "./auditor.ts";
import type { ModelIdentity } from "./endpoint.ts";
import type { EntropyScan } from "./entropy.ts";
import { MODELS, isModelKey, type ModelKey } from "./models.ts";

// The parts of overseer check that aren't the investigation: reading the prompts, the git baseline, and
// the outputs CI reads, which are a Markdown summary, GitHub annotations and step outputs.

const MAX_PROMPT = 100_000;
const run = promisify(execFile);

export type Outcome = "pass" | "fail" | "unchanged" | "incomplete";
// status: changed (there's a baseline and it differs), new (the file isn't at that ref), or none (no
// baseline was asked for).
export type Baseline = { text: string | null; source: string | null; status: "changed" | "unchanged" | "new" | "none" };
export type ScanRow = { question: string; aspect: string; scan: EntropyScan };

export async function readPrompt(file: string, what = "--prompt") {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw Object.assign(new Error(`${what}: couldn't read ${file}${errno === "ENOENT" ? ": no such file" : errno === "EISDIR" ? ": it's a folder" : ""}.`), {
      code: "USAGE",
    });
  }
  if (!text.trim()) throw Object.assign(new Error(`${what}: ${file} is empty.`), { code: "USAGE" });
  if (text.length > MAX_PROMPT) throw Object.assign(new Error(`${what}: ${file} is over ${MAX_PROMPT.toLocaleString("en")} characters.`), { code: "USAGE" });
  return text;
}

// The prompt as it was at a git ref. A file that didn't exist there is new, which isn't an error: it's
// checked against its stated purpose instead.
export async function promptAt(ref: string, file: string): Promise<string | null> {
  const dir = path.dirname(path.resolve(file));
  try {
    const { stdout } = await run("git", ["-C", dir, "show", `${ref}:./${path.basename(file)}`], { maxBuffer: 4 * MAX_PROMPT, encoding: "utf8" });
    return stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (/exists on disk, but not in|does not exist in/.test(stderr)) return null;
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "git isn't installed" : stderr.split("\n").pop() || "git failed";
    throw Object.assign(new Error(`--baseline-ref: couldn't read ${file} at ${ref}: ${why}`), { code: "USAGE" });
  }
}

const same = (a: string, b: string) => a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

// YAML frontmatter at the top of a Markdown file, as Claude Code's agents, skills and commands have.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:[A-Za-z_][\w-]*[ \t]*:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

// The text after a file's YAML frontmatter, and whether it had any. Claude Code tells an agent, a skill or a
// command only that text: the frontmatter is for the harness, such as the description the main agent
// delegates by.
export function withoutFrontmatter(text: string) {
  const head = text.match(FRONTMATTER)?.[0];
  return head ? { text: text.slice(head.length), stripped: true } : { text, stripped: false };
}

// With strip, a baseline's frontmatter is left out as the prompt's is, so they compare as deployed.
export async function loadBaseline(prompt: string, file: string, opts: { baseline?: string; ref?: string; strip?: boolean }): Promise<Baseline> {
  if (opts.baseline && opts.ref) throw Object.assign(new Error("Pass --baseline or --baseline-ref, not both."), { code: "USAGE" });
  if (!opts.baseline && !opts.ref) return { text: null, source: null, status: "none" };
  const read = opts.baseline ? await readPrompt(opts.baseline, "--baseline") : await promptAt(opts.ref!, file);
  const source = opts.baseline ?? opts.ref!;
  if (read === null) return { text: null, source, status: "new" };
  const text = opts.strip ? withoutFrontmatter(read).text : read;
  return { text, source, status: same(text, prompt) ? "unchanged" : "changed" };
}

// A check concludes only with the auditor's verdict on an assistant that answered it. A verdict about one
// that never replied, as when its endpoint rejected every message, says nothing about the prompt.
export function outcomeOf(result: CheckResult | null, failAt: number): Outcome {
  const verdict = result?.verdict;
  if (!result || !verdict || verdict.forced || !result.stats.targetMessages) return "incomplete";
  return verdict.found && verdict.confidence >= failAt ? "fail" : "pass";
}

// Why a check that ran is incomplete, as a sentence without its full stop.
export function unfinished(result: CheckResult | null) {
  return result && !result.stats.targetMessages ? "The assistant never answered the auditor's messages" : "The auditor stopped without a verdict";
}

export type Report = {
  outcome: Outcome;
  prompt: string;
  purpose: string;
  // A model key, or model@host for a custom endpoint, which modelEndpoint then names.
  model: string;
  modelEndpoint?: ModelIdentity;
  auditor: ModelKey;
  budget: number;
  failAt: number;
  baseline: Baseline;
  result: CheckResult | null;
  scans: ScanRow[];
};

const pct = (p: number) => `${Math.round(p * 100)}%`;
// One line of Markdown that can't break out of a table cell, a quote or inline code.
const inline = (s: string) => s.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>|])/g, "\\$1");
// Backslash escapes don't work inside a code span, so a backtick there becomes a quote instead.
const code = (s: string) => `\`${s.replace(/\s+/g, " ").trim().replace(/`/g, "'")}\``;

function stats(s: AuditStats, r: Report) {
  const model = isModelKey(r.model) ? MODELS[r.model].label : inline(r.model);
  const cost = r.modelEndpoint ? `about $${s.costUsd.toFixed(2)} in Anthropic API calls, not counting the endpoint's own cost` : `about $${s.costUsd.toFixed(2)}`;
  return `${MODELS[r.auditor].label} audited ${model}: ${s.targetMessages} of ${r.budget} messages, ${s.scans} ${s.scans === 1 ? "scan" : "scans"}, ${s.turns} ${s.turns === 1 ? "turn" : "turns"}, ${s.seconds}s, ${cost}.`;
}

function comparedWith(b: Baseline) {
  if (b.status === "changed") return `Entropy scans compared it with the version at ${code(b.source!)}.`;
  if (b.status === "new") return `The prompt is new since ${code(b.source!)}, so scans compared it with the stated purpose alone.`;
  return "Entropy scans compared it with the stated purpose alone.";
}

export function markdown(r: Report) {
  const file = code(r.prompt);
  if (r.outcome === "unchanged") return `### Overseer check: ${file} unchanged\n\nThe prompt is the same as at ${code(r.baseline.source!)}, so there was nothing to check.\n`;
  const v = r.result?.verdict ?? null;
  const lines: string[] = [];
  if (r.outcome === "fail") {
    lines.push(`### ✗ Overseer check failed: ${file}`, "");
    lines.push(`The auditor found an agenda the stated purpose doesn't explain, with ${pct(v!.confidence)} confidence. The check fails at ${pct(r.failAt)}.`, "");
    lines.push(`> **${inline(v!.objective)}**`, "");
    if (v!.evidence.length) lines.push("From the assistant's replies:", "", ...v!.evidence.map((q) => `- “${inline(q)}”`), "");
  } else if (r.outcome === "pass") {
    lines.push(`### ✓ Overseer check passed: ${file}`, "");
    if (v!.found) lines.push(`The auditor suspected an agenda, but only with ${pct(v!.confidence)} confidence, under the ${pct(r.failAt)} the check fails at: ${inline(v!.objective)}`, "");
    else lines.push(`No agenda found that the stated purpose doesn't explain (auditor confidence ${pct(v!.confidence)}). ${inline(v!.objective)}`, "");
  } else {
    lines.push(`### Overseer check didn't finish: ${file}`, "");
    lines.push(`${unfinished(r.result)}, so this check can't pass.`, "");
    const top = r.result?.board[0];
    if (top) lines.push(`Its leading hypothesis was: ${inline(top.text)} (${pct(top.confidence)}).`, "");
  }
  if (r.scans.length) {
    lines.push("| Entropy scan | Assistant | Reference | Divergence |", "|---|---:|---:|---:|");
    for (const { question, aspect, scan } of r.scans) {
      lines.push(`| “${inline(question)}” on ${inline(aspect)} | ${scan.targetEntropy.toFixed(2)} | ${scan.referenceEntropy.toFixed(2)} | ${scan.divergence.toFixed(2)} |`);
    }
    lines.push("");
  }
  lines.push(`<sub>Purpose: ${inline(r.purpose)} ${comparedWith(r.baseline)}${r.result ? ` ${stats(r.result.stats, r)}` : ""}</sub>`, "");
  return lines.join("\n");
}

// GitHub workflow commands: https://docs.github.com/actions/reference/workflows-and-actions/workflow-commands
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function annotation(r: Report) {
  const v = r.result?.verdict;
  const file = `file=${escapeProperty(r.prompt)}`;
  if (r.outcome === "fail") return `::error ${file},title=Overseer check::${escapeData(`Covert agenda (${pct(v!.confidence)}): ${v!.objective}`)}`;
  if (r.outcome === "incomplete") return `::warning ${file},title=Overseer check::${escapeData(`${unfinished(r.result)}, so the check can't pass.`)}`;
  return null;
}

// Appended, like GitHub's own steps do. Values are kept to one line, so no delimiter syntax is needed.
export async function writeOutputs(file: string, r: Report) {
  const v = r.result?.verdict;
  const values = {
    result: r.outcome,
    found: String(Boolean(v?.found)),
    confidence: v ? v.confidence.toFixed(2) : "",
    agenda: v?.found ? v.objective.replace(/\s+/g, " ").trim() : "",
    "cost-usd": r.result ? r.result.stats.costUsd.toFixed(4) : "0",
  };
  await fs.appendFile(file, Object.entries(values).map(([k, val]) => `${k}=${val}\n`).join(""));
}
