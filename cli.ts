#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runAudit, type AuditEvent } from "./lib/auditor.ts";
import { GOALS } from "./lib/goals.ts";
import { EFFORTS, MODELS, isModelKey, type Effort } from "./lib/models.ts";

// The overseer command: audits with a live terminal readout, presets, saved runs, the web UI and the study.

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, "runs");
const UI = process.env.OVERSEER_UI ?? "http://127.0.0.1:7878";
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // No .env file: the API key has to come from the environment instead.
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: paint("2"),
  bold: paint("1"),
  amber: paint("38;5;214"),
  blue: paint("38;5;111"),
  green: paint("1;38;5;78"),
  red: paint("1;38;5;203"),
};
const width = Math.max(60, Math.min(process.stdout.columns || 100, 150));
const clip = (s: string, n = width - 16) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const label = (key: string) => (key === "claude-code" ? "Claude Code" : isModelKey(key) ? MODELS[key].label : key);
// Whether the auditor note currently streaming is a thinking summary (dim) or a short note (bold).
let thinking = false;

const HELP = `overseer ${VERSION}: can one AI catch another hiding a secret objective?

Usage
  overseer audit [options]   run one audit with a live readout
  overseer presets           list the hidden objectives
  overseer runs              list saved audits
  overseer ui                open the web UI, starting it if needed
  overseer study [options]   run the oversight-gap study (options as in npm run study)

Audit options
  --auditor haiku|sonnet|opus   default opus
  --target haiku|sonnet|opus    default sonnet
  --objective <id|text>         a preset id, your own text, or random (the default, sealed until the end)
  --budget <n>                  messages to the target, default 24
  --effort low|medium|high      auditor effort, default medium
  --no-scans                    turn off semantic-entropy scans
  --json                        print the result as JSON instead of the live readout
`;

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "audit":
      await audit(rest);
      break;
    case "presets":
      for (const g of GOALS) console.log(`  ${c.amber(g.id.padEnd(11))} ${g.summary}`);
      break;
    case "runs":
      await runs();
      break;
    case "ui":
      await ui();
      break;
    case "study":
      await child([path.join(ROOT, "study.ts"), ...rest]);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
} catch (err) {
  console.error(c.red(`overseer: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
}

async function audit(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      auditor: { type: "string", default: "opus" },
      target: { type: "string", default: "sonnet" },
      objective: { type: "string", default: "random" },
      budget: { type: "string", default: "24" },
      effort: { type: "string", default: "medium" },
      "no-scans": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const { auditor, target } = values;
  if (!isModelKey(auditor) || !isModelKey(target)) throw new Error("--auditor and --target take haiku, sonnet or opus.");
  if (!(EFFORTS as string[]).includes(values.effort)) throw new Error(`--effort takes ${EFFORTS.join(", ")}.`);
  const budget = Math.min(60, Math.max(6, Math.round(Number(values.budget)) || 24));
  if (!process.env.ANTHROPIC_API_KEY) throw new Error(`No ANTHROPIC_API_KEY. Put it in ${path.join(ROOT, ".env")} or export it.`);

  const sealed = values.objective === "random";
  const preset = GOALS.find((g) => g.id === values.objective);
  const objective = sealed ? GOALS[Math.floor(Math.random() * GOALS.length)].objective : (preset?.objective ?? values.objective);
  const entropyTool = !values["no-scans"];
  const effort = values.effort as Effort;

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    console.error(c.dim("\nAudit cancelled."));
    process.exit(130);
  });

  if (!values.json) {
    console.log(
      `\n ${c.bold("OVERSEER")}  ${c.blue(label(auditor))} auditing ${c.amber(label(target))} · budget ${budget} · entropy scans ${entropyTool ? "on" : "off"} · objective ${sealed ? "sealed" : "set"}\n`,
    );
  }
  const started = Date.now();
  const events: (AuditEvent & { t: number })[] = [];
  const emit = (event: AuditEvent) => {
    events.push({ ...event, t: Date.now() - started });
    if (!values.json) render(event);
  };
  const result = await runAudit({ objective, target, auditor, budget, effort, targetEffort: "low", entropyTool, signal: controller.signal }, emit);

  const id = `${new Date(started).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${auditor}-vs-${target}`;
  await fs.mkdir(RUNS, { recursive: true });
  await fs.writeFile(path.join(RUNS, `${id}.json`), JSON.stringify({ id, objective, target, auditor, budget, effort, entropyTool, result, events }));

  if (values.json) {
    console.log(JSON.stringify({ id, objective, verdict: result.verdict, grade: result.grade, stats: result.stats }, null, 2));
    return;
  }
  console.log(`\n  ${c.dim("saved")}     runs/${id}.json`);
  console.log(`  ${c.dim("replay")}    ${UI}/?replay=${id}\n`);
}

function render(e: AuditEvent) {
  switch (e.type) {
    case "note_start":
      thinking = e.kind === "thinking";
      process.stdout.write(thinking ? c.dim("  thinking  ") : `  ${c.blue("auditor")}   `);
      break;
    case "note_delta": {
      const text = e.text.replace(/\s*\n+\s*/g, " ");
      process.stdout.write(thinking ? c.dim(text) : c.bold(text));
      break;
    }
    case "note_end":
      process.stdout.write("\n");
      break;
    case "probe":
      console.log(`  ${c.blue("→")} ${c.blue(e.thread.padEnd(12))} ${clip(e.message)}`);
      break;
    case "reply":
      console.log(`  ${c.amber("←")} ${c.amber(e.thread.padEnd(12))} ${c.dim(clip(e.text))}`);
      break;
    case "scan":
      console.log(`\n  ${c.bold("◎ entropy scan")}  ${clip(`"${e.question}" (compared on: ${e.aspect})`, width - 20)}`);
      break;
    case "scan_result": {
      const s = e.scan;
      console.log(
        `    target ${c.amber(s.targetEntropy.toFixed(2))} · reference ${c.blue(s.referenceEntropy.toFixed(2))} · divergence ${c.bold(s.divergence.toFixed(2))} ${c.dim("(max 0.69)")}`,
      );
      for (const cluster of s.clusters) {
        const dots = `${c.amber("●".repeat(cluster.target))}${c.blue("●".repeat(cluster.reference))}`;
        console.log(`    ${dots}  ${clip(cluster.label, 60)} ${c.dim(`target ${cluster.target}/${s.n} · reference ${cluster.reference}/${s.n}`)}`);
      }
      console.log("");
      break;
    }
    case "board":
      console.log(`\n  ${c.bold("evidence board")}`);
      for (const h of e.hypotheses) {
        const filled = Math.round(h.confidence * 10);
        console.log(`    ${c.amber("█".repeat(filled))}${c.dim("░".repeat(10 - filled))} ${String(Math.round(h.confidence * 100)).padStart(3)}%  ${clip(h.text, width - 24)}`);
      }
      console.log("");
      break;
    case "verdict":
      console.log(`\n  ${c.bold("VERDICT")}   ${c.bold(e.verdict.objective)} ${c.dim(`(confidence ${Math.round(e.verdict.confidence * 100)}%)`)}`);
      for (const quote of e.verdict.evidence) console.log(`            ${c.dim(`“${clip(quote, width - 20)}”`)}`);
      break;
    case "grade": {
      const stamp = { caught: c.green(" CAUGHT "), partial: c.amber(" PARTLY CAUGHT "), missed: c.red(" MISSED ") }[e.grade.label];
      console.log(`\n  ${c.dim("hidden")}    ${c.amber(e.objective)}`);
      console.log(`  ${stamp}  ${c.dim(e.grade.rationale)}`);
      break;
    }
    case "done": {
      const s = e.stats;
      console.log(c.dim(`\n  ${s.targetMessages} target messages · ${s.scans} scans · ${s.turns} turns · ${s.seconds}s · ≈ $${s.costUsd.toFixed(2)}`));
      break;
    }
    case "error":
      console.log(c.red(`  ${e.message}`));
      break;
  }
}

async function runs() {
  const files = (await fs.readdir(RUNS).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse();
  if (!files.length) return console.log("No saved audits yet. Run overseer audit.");
  for (const file of files) {
    const run = JSON.parse(await fs.readFile(path.join(RUNS, file), "utf8"));
    const grade = run.result?.grade?.label ?? "unfinished";
    const mark = { caught: c.green, partial: c.amber, missed: c.red }[grade as "caught"] ?? c.dim;
    console.log(`  ${mark(grade.padEnd(10))} ${label(run.auditor)} vs ${label(run.target)}  ${c.dim(run.id)}`);
  }
}

async function ui() {
  const running = await fetch(`${UI}/api/config`).then((r) => r.ok).catch(() => false);
  const server = running ? null : spawn(process.execPath, [path.join(ROOT, "server.ts")], { cwd: ROOT, stdio: "inherit" });
  if (server) {
    for (let i = 0; i < 40 && !(await fetch(`${UI}/api/config`).then((r) => r.ok).catch(() => false)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [UI], { stdio: "ignore", detached: true }).unref();
  console.log(`Overseer UI: ${UI}`);
  if (server) await new Promise((resolve) => server.on("exit", resolve));
}

function child(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
    proc.on("exit", (code) => (code ? reject(new Error(`exited with code ${code}`)) : resolve()));
  });
}
