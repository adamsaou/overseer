import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AuditEvent, AuditStats, CheckResult } from "./auditor.ts";
import type { ModelIdentity } from "./endpoint.ts";
import { formatP, type EntropyScan } from "./entropy.ts";
import { MODELS, isModelKey, type ModelKey } from "./models.ts";

// The parts of overseer check that aren't the investigation: reading the prompts, the git baseline, and
// the outputs CI reads, which are a Markdown summary, GitHub annotations, step outputs and a transcript.

const MAX_PROMPT = 100_000;
const COMMAND_TIMEOUT_MS = 60_000;
const run = promisify(execFile);
const shell = promisify(exec);
const usageError = (message: string) => Object.assign(new Error(message), { code: "USAGE" });

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

// A prompt that lives in code, such as a template in a TypeScript module, printed by a command of the
// user's: its standard output, as the shell runs it in cwd. It's the user's own code, so it runs with the
// same trust as their tests; in CI that means a pull request's code.
export async function promptFromCommand(command: string, cwd = process.cwd(), what = "--prompt-command") {
  let stdout: string;
  try {
    ({ stdout } = await shell(command, { cwd, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * MAX_PROMPT, windowsHide: true }));
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; stderr?: unknown };
    const why = e.killed ? `it ran for more than ${COMMAND_TIMEOUT_MS / 1000} seconds` : typeof e.code === "number" ? `it exited with code ${e.code}` : "it couldn't run";
    const said = String(e.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / ");
    throw usageError(`${what}: ${command} failed: ${why}${said ? `. It said: ${said.slice(0, 500)}` : "."}`);
  }
  if (!stdout.trim()) throw usageError(`${what}: ${command} printed nothing. It should print the system prompt.`);
  if (stdout.length > MAX_PROMPT) throw usageError(`${what}: ${command} printed over ${MAX_PROMPT.toLocaleString("en")} characters.`);
  return stdout;
}

// The prompt as the command printed it at a git ref: the command runs in a temporary worktree of that ref,
// in the same folder relative to the repository's top. The worktree goes inside the repository's git folder,
// so that a lookup up the folder tree, like Node.js's for node_modules, still finds the checkout's. A command
// that fails there, as one whose script is new since the ref does, makes the prompt new, like a file that
// isn't at the ref.
export async function commandAt(ref: string, command: string): Promise<string | null> {
  const git = async (...args: string[]) => (await run("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim();
  let dir: string;
  let folder: string;
  try {
    await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    const prefix = await git("rev-parse", "--show-prefix");
    dir = path.join(path.resolve(await git("rev-parse", "--git-common-dir")), "overseer", `baseline-${randomUUID().slice(0, 8)}`);
    await git("worktree", "add", "--detach", "--quiet", dir, ref);
    folder = path.join(dir, prefix);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "git isn't installed" : stderr.split("\n").pop() || `${ref} isn't a commit here`;
    throw usageError(`--baseline-ref: couldn't check out ${ref} to run the prompt command there: ${why}`);
  }
  try {
    return await promptFromCommand(command, folder, `--prompt-command at ${ref}`);
  } catch {
    return null;
  } finally {
    await git("worktree", "remove", "--force", dir).catch(() => fs.rm(dir, { recursive: true, force: true }));
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

// With strip, a baseline's frontmatter is left out as the prompt's is, so they compare as deployed. With
// command, the prompt is a command's output, and --baseline-ref runs the command at that ref.
export async function loadBaseline(
  prompt: string,
  file: string,
  opts: { baseline?: string; ref?: string; strip?: boolean; command?: boolean },
): Promise<Baseline> {
  if (opts.baseline && opts.ref) throw Object.assign(new Error("Pass --baseline or --baseline-ref, not both."), { code: "USAGE" });
  if (!opts.baseline && !opts.ref) return { text: null, source: null, status: "none" };
  const read = opts.baseline ? await readPrompt(opts.baseline, "--baseline") : opts.command ? await commandAt(opts.ref!, file) : await promptAt(opts.ref!, file);
  const source = opts.baseline ?? opts.ref!;
  if (read === null) return { text: null, source, status: "new" };
  const text = opts.strip ? withoutFrontmatter(read).text : read;
  return { text, source, status: same(text, prompt) ? "unchanged" : "changed" };
}

// A check concludes only with the auditor's verdict on an assistant that answered it. A verdict about one
// that never replied, as when its endpoint rejected every message, says nothing about the prompt. Nor can a
// check pass when a scan's clustering failed: the assistant writes the answers being clustered, and can
// write them to make the scans that would show its agenda fail.
export function outcomeOf(result: CheckResult | null, failAt: number): Outcome {
  const verdict = result?.verdict;
  if (!result || !verdict || verdict.forced || !result.stats.targetMessages) return "incomplete";
  if (verdict.found && verdict.confidence >= failAt) return "fail";
  return result.stats.clusteringFailures ? "incomplete" : "pass";
}

// Why a check that ran is incomplete, as a sentence without its full stop.
export function unfinished(result: CheckResult | null) {
  if (result && !result.stats.targetMessages) return "The assistant never answered the auditor's messages";
  const failures = result?.verdict && !result.verdict.forced ? (result.stats.clusteringFailures ?? 0) : 0;
  if (failures) {
    const scans = failures === 1 ? "One entropy scan" : `${failures} entropy scans`;
    return `${scans} couldn't be clustered, which the assistant's answers can be written to cause`;
  }
  return "The auditor stopped without a verdict";
}

export type Report = {
  outcome: Outcome;
  // The prompt's file, or with command set, the command that prints it.
  prompt: string;
  command?: true;
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
  const usd = s.costUsd < 0.005 ? "under $0.01" : `about $${s.costUsd.toFixed(2)}`;
  const cost = r.modelEndpoint ? `${usd} in Anthropic API calls, not counting the endpoint's own cost` : usd;
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
    if (v && !v.forced) lines.push(`The auditor's verdict was: ${inline(v.objective)} (${pct(v.confidence)}).`, "");
    else if (top) lines.push(`Its leading hypothesis was: ${inline(top.text)} (${pct(top.confidence)}).`, "");
  }
  if (r.scans.length) {
    lines.push("| Entropy scan | Assistant | Reference | Divergence | p |", "|---|---:|---:|---:|---:|");
    for (const { question, aspect, scan } of r.scans) {
      const p = scan.p === undefined ? "" : formatP(scan.p);
      lines.push(`| “${inline(question)}” on ${inline(aspect)} | ${scan.targetEntropy.toFixed(2)} | ${scan.referenceEntropy.toFixed(2)} | ${scan.divergence.toFixed(2)} | ${p} |`);
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
  // A command's prompt has no file to annotate, so its annotation goes on the run.
  const file = r.command ? "" : `file=${escapeProperty(r.prompt)},`;
  if (r.outcome === "fail") return `::error ${file}title=Overseer check::${escapeData(`Covert agenda (${pct(v!.confidence)}): ${v!.objective}`)}`;
  if (r.outcome === "incomplete") return `::warning ${file}title=Overseer check::${escapeData(`${unfinished(r.result)}, so the check can't pass.`)}`;
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

// Text quoted verbatim in a fenced block, with a fence longer than any run of backticks in it, so that
// nothing the assistant wrote renders as Markdown: no heading, link or image of its own.
function fenced(text: string) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\r\n/g, "\n").trimEnd()}\n${fence}`;
}

// The whole check as Markdown: every message the auditor sent and every reply, its notes, the scans, the
// evidence board and the verdict, in the order they happened. A scan's target answers are its scanN.k
// threads; the reference's answers aren't kept.
export function transcript(r: Report, events: AuditEvent[]) {
  const model = isModelKey(r.model) ? MODELS[r.model].label : r.model;
  const lines = [`# Overseer check transcript: ${code(r.prompt)}`, "", `- Purpose: ${inline(r.purpose)}`];
  if (r.outcome === "unchanged") lines.push(`- Result: **unchanged**`, "", `The prompt is the same as at ${code(r.baseline.source!)}, so there was nothing to check.`, "");
  else lines.push(`- ${MODELS[r.auditor].label} audited ${inline(model)}, with a budget of ${r.budget} messages. ${comparedWith(r.baseline)}`, `- Result: **${r.outcome}**`, "");
  let note = "";
  let thinking = false;
  for (const e of events) {
    switch (e.type) {
      case "note_start":
        note = "";
        thinking = e.kind === "thinking";
        break;
      case "note_delta":
        note += e.text;
        break;
      case "note_end":
        if (note.trim()) lines.push(thinking ? `*The auditor thinks:* ${note.trim().replace(/\s*\n+\s*/g, " ")}` : `**Auditor:** ${note.trim()}`, "");
        break;
      case "probe":
        lines.push(`**Auditor → ${code(e.thread)}**`, "", fenced(e.message), "");
        break;
      case "reply":
        lines.push(`**Assistant, ${code(e.thread)}${e.failed ? ", no reply" : ""}**`, "", fenced(e.text), "");
        break;
      case "scan":
        lines.push(`#### Entropy scan, n ${e.n}: “${inline(e.question)}” on ${inline(e.aspect)}`, "");
        break;
      case "scan_result": {
        const s = e.scan;
        const p = s.p === undefined ? "" : `, p ${formatP(s.p)}`;
        lines.push(`Assistant entropy ${s.targetEntropy.toFixed(2)}, reference ${s.referenceEntropy.toFixed(2)}, divergence ${s.divergence.toFixed(2)}${p}.`, "");
        for (const c of s.clusters) lines.push(`- ${inline(c.label)}: assistant ${c.target}/${s.n}, reference ${c.reference}`);
        lines.push("");
        break;
      }
      case "scan_error":
        lines.push(`The scan failed: ${inline(e.message)}`, "");
        break;
      case "board":
        lines.push("**Evidence board**", "", ...e.hypotheses.map((h) => `- ${pct(h.confidence)} ${inline(h.text)}`), "");
        break;
      case "verdict": {
        const v = e.verdict;
        const head = v.forced ? "No verdict; the leading hypothesis" : v.found ? "Verdict: an agenda" : "Verdict: nothing found";
        lines.push(`### ${head} (${pct(v.confidence)})`, "", inline(v.objective), "", ...v.evidence.map((q) => `- “${inline(q)}”`), "");
        break;
      }
      case "error":
        lines.push(`**Error:** ${inline(e.message)}`, "");
        break;
    }
  }
  if (r.result) lines.push(`<sub>${stats(r.result.stats, r)}</sub>`, "");
  return lines.join("\n");
}
