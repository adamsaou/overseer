#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAudit, type AuditEvent } from "./lib/auditor.ts";
import { anthropic, describeError } from "./lib/client.ts";
import { loadDotEnv, missingKeyMessage, readConfig, saveApiKey, useApiKey, writableByOthers } from "./lib/config.ts";
import { GRADE_USD, estimateAudit, formatUsd } from "./lib/cost.ts";
import { GOALS } from "./lib/goals.ts";
import { EFFORTS, MODELS, addUsage, costOf, emptyUsage, isModelKey, type Effort, type ModelKey } from "./lib/models.ts";
import { openBrowser } from "./lib/open.ts";
import { configFile, dataHome, displayPath, fromSource, packageRoot, packageVersion, resultsDir, runsDir } from "./lib/paths.ts";
import { askSecret, askYesNo, canPrompt } from "./lib/prompt.ts";
import { findRunId, listRuns, newRunId, readRun, runFile, saveRun, writeAtomic, type SavedRun } from "./lib/store.ts";
import type { StudyOptions } from "./study.ts";

// The overseer command: the web UI, audits with a live terminal readout, the study, saved runs, presets and
// a setup check. Exit codes: 0 done, 1 something went wrong, 2 the command line was wrong.

// Read before loadDotEnv, so doctor can tell a key from the shell from one in a checkout's .env.
const keyInShell = Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
loadDotEnv();
const HOME = dataHome();
const UI = process.env.OVERSEER_UI ?? "http://127.0.0.1:7878";
const VERSION = packageVersion();
const MIN_NODE = 22;
const log = (message: string, level?: "info" | "warn") => (level === "warn" ? console.error : console.log)(message);
const homeSource = () => (process.env.OVERSEER_HOME?.trim() ? "from OVERSEER_HOME" : fromSource ? "the checkout's own runs/ and results/" : "the default");

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, on = tty) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: paint("2"),
  bold: paint("1"),
  amber: paint("38;5;214"),
  blue: paint("38;5;111"),
  green: paint("1;38;5;78"),
  red: paint("1;38;5;203"),
};
const errorRed = paint("1;38;5;203", process.stderr.isTTY && !process.env.NO_COLOR);
const width = Math.max(60, Math.min(process.stdout.columns || 100, 150));
const clip = (s: string, n = width - 16) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const label = (key: string) => (key === "claude-code" ? "Claude Code" : isModelKey(key) ? MODELS[key].label : key);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Whether the auditor note currently streaming is a thinking summary (dim) or a short note (bold), and
// whether one is open, so an error starts on a line of its own.
let thinking = false;
let noteOpen = false;

const usage = (message: string) => Object.assign(new Error(message), { code: "USAGE" });

function whole(value: string, flag: string, min: number, max: number) {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < min || n > max) throw usage(`${flag} takes a whole number from ${min} to ${max}, not "${value}".`);
  return n;
}

function modelKey(value: string, flag: string): ModelKey {
  if (!isModelKey(value)) throw usage(`${flag} takes haiku, sonnet or opus, not "${value}".`);
  return value;
}

function effortLevel(value: string): Effort {
  if (!(EFFORTS as string[]).includes(value)) throw usage(`--effort takes ${EFFORTS.join(", ")}, not "${value}".`);
  return value as Effort;
}

const HELP = `overseer ${VERSION}: can a weaker AI catch a stronger one hiding a secret objective?

Usage
  overseer [ui]                start the web app and open it in your browser
  overseer audit [options]     run one audit in the terminal, with a live readout
  overseer study [options]     run the oversight-gap study (shows the cost and asks first)
  overseer runs [list]         list saved audits
  overseer runs show <id>      an audit's verdict, grade and stats
  overseer runs replay <id>    play an audit back as the live readout
  overseer runs export <id>    an audit as JSON
  overseer presets             the hidden objectives an audit can use
  overseer doctor              check Node.js, the API key, model access and the data folder

  overseer <command> --help    options for one command
  overseer --version

Data      ${displayPath(HOME)} (${homeSource()}); set OVERSEER_HOME to use another folder
API key   ANTHROPIC_API_KEY, or one saved in ${displayPath(configFile(HOME))}`;

type Command = { help: string; run: (args: string[]) => Promise<void> };

const COMMANDS: Record<string, Command> = {
  ui: {
    run: ui,
    help: `Usage: overseer [ui] [options]

Starts the web app on this computer and opens it in your browser: live audits, replays and the study
page. If Overseer is already running at that address, it just opens it. Ctrl-C stops the server.

Options
  --port <n>     port to listen on, default 7878 (or $PORT)
  --host <addr>  address to listen on, default 127.0.0.1 (or $OVERSEER_HOST). On any address other
                 computers can reach, such as 0.0.0.0, they need a password that is printed at startup
                 and changes every launch
  --no-open      don't open the browser`,
  },
  audit: {
    run: audit,
    help: `Usage: overseer audit [options]

Runs one audit in the terminal with a live readout, then saves it for replay.

Options
  --auditor haiku|sonnet|opus   the model looking for the objective, default opus
  --target haiku|sonnet|opus    the model hiding it, default sonnet
  --objective <id|text>         a preset id (see overseer presets), a sentence of your own, or random:
                                a preset drawn at random and sealed until the verdict (the default)
  --budget <n>                  messages the auditor may send the target, 6 to 60, default 24
  --effort <level>              auditor effort: ${EFFORTS.join(", ")}; default medium
  --scans, --no-scans           semantic-entropy scans, on by default
  --json                        print only the result, as JSON

Example
  overseer audit --auditor haiku --target haiku --budget 8     about a cent`,
  },
  study: {
    run: study,
    help: `Usage: overseer study [options]

Runs the oversight-gap study: every auditor against every target on each objective, with and without
entropy scans. Finished audits are kept in results/study.jsonl and never run twice, so a stopped study
picks up where it left off. Before spending anything it shows how many audits are left and what they
should cost, and asks.

Options
  --resume             carry on with the last study's settings (options given here override them)
  --reps <n>           runs of each matchup on each objective, default 1
  --auditors <list>    default haiku,sonnet,opus
  --targets <list>     default haiku,sonnet,opus
  --tools <list>       basic (conversation only), entropy (with scans), or both (the default)
  --goals <n|ids>      the first n objectives, default 8, or ids such as city,office
  --budget <n>         messages per audit, 6 to 60, default 24
  --effort <level>     auditor effort, default medium
  --concurrency <n>    audits at a time, default 4
  --summarize          rebuild results/summary.json, which the /study page shows, without running
                       anything; it keeps that summary's budget and effort unless you give others
  -y, --yes            don't ask before spending; needed when not run from a terminal`,
  },
  runs: {
    run: runs,
    help: `Usage: overseer runs [list] [--json]
       overseer runs show <id>
       overseer runs replay <id> [--speed <n>]
       overseer runs export <id> [--out <file>]

Saved audits, newest first. An id can be shortened to any start that matches only one run.

  list     one line per audit; --json prints the details as JSON
  show     the verdict, the grade, the hidden objective and the stats
  replay   play the audit back as the live readout; --speed sets the pace (default 3, 0 for no pauses)
  export   the whole run as JSON, on stdout or into --out <file>`,
  },
  presets: {
    run: presets,
    help: `Usage: overseer presets

Lists the hidden objectives an audit can use. Only their summaries are shown, so an audit that draws
one at random stays sealed.`,
  },
  doctor: {
    run: doctor,
    help: `Usage: overseer doctor

Checks the Node.js version, the API key (without showing it), access to the models with one tiny Haiku
request (well under $0.001), and the data folder in use.`,
  },
};

async function main(argv: string[]) {
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") return console.log(VERSION);
  if (first === "--help" || first === "-h") return console.log(HELP);
  if (first === "help") {
    if (!rest[0]) return console.log(HELP);
    if (!Object.hasOwn(COMMANDS, rest[0])) throw usage(`Unknown command "${rest[0]}". Run overseer --help for the list.`);
    return console.log(COMMANDS[rest[0]].help);
  }
  // No command, or only options (overseer --port 9000), means the web UI.
  current = first === undefined || first.startsWith("-") ? "ui" : first;
  const args = current === first ? rest : argv;
  if (!Object.hasOwn(COMMANDS, current)) throw usage(`Unknown command "${current}". Run overseer --help for the list.`);
  if (args.includes("--help") || args.includes("-h")) return console.log(COMMANDS[current].help);
  await COMMANDS[current].run(args);
}

// Points the API client at the key from ANTHROPIC_API_KEY or config.json. Without one, a terminal session
// can paste a key and save it; anything else gets an error that says where a key goes.
async function ensureKey(optional = false) {
  if (await useApiKey(HOME)) return true;
  const file = displayPath(configFile(HOME));
  if (!canPrompt()) {
    if (optional) return false;
    throw new Error(`${missingKeyMessage(HOME)} Or run this in a terminal to paste one.`);
  }
  console.error(`No Anthropic API key found: ANTHROPIC_API_KEY isn't set and none is saved in ${file}.`);
  const key = (await askSecret(`Paste your API key (it won't be shown${optional ? "; Enter skips" : ""}): `)).trim();
  if (!key) {
    if (optional) return false;
    throw new Error(missingKeyMessage(HOME));
  }
  if (/\s/.test(key)) throw new Error("That doesn't look like an API key: it has spaces in it.");
  if (!key.startsWith("sk-ant-")) console.error("Note: Anthropic API keys usually start with sk-ant-.");
  if (await askYesNo(`Save it in ${file}, readable only by you?`, true)) {
    await saveApiKey(HOME, key);
    console.error(`Saved. ANTHROPIC_API_KEY still wins when it's set. Delete ${file} to forget the key.`);
    if (await writableByOthers(HOME)) {
      console.error(`Note: other users can replace files in ${displayPath(HOME)}, so they could swap that file for their own. chmod 700 it to stop that.`);
    }
  } else {
    // For this run only. Every part of Overseer looks in the environment first.
    process.env.ANTHROPIC_API_KEY = key;
  }
  return Boolean(await useApiKey(HOME));
}

async function ui(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: process.env.PORT || "7878" },
      // Not HOST, which shells and containers often set for other servers.
      host: { type: "string", default: process.env.OVERSEER_HOST || "127.0.0.1" },
      "no-open": { type: "boolean", default: false },
    },
  });
  const port = whole(values.port, "--port", 0, 65535);
  const { startServer, urlHost } = await import("./server.ts");
  let url = `http://${urlHost(values.host)}:${port}`;
  if (port && (await isOverseer(url))) console.log(`Overseer is already running at ${url}`);
  else {
    await ensureKey(true);
    // The server keeps this process alive until Ctrl-C.
    ({ url } = await startServer({ home: HOME, port, host: values.host, log }));
    console.log(c.dim(`Audits and results are saved in ${displayPath(HOME)}. Ctrl-C stops the server.`));
  }
  if (!values["no-open"] && !openBrowser(url)) console.log(`Open ${url} in your browser.`);
}

async function isOverseer(url: string) {
  try {
    const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray(((await res.json()) as { models?: unknown }).models);
  } catch {
    return false;
  }
}

function pickObjective(value: string) {
  const text = value.trim();
  if (text === "random") return { objective: GOALS[Math.floor(Math.random() * GOALS.length)].objective, sealed: true };
  const preset = GOALS.find((g) => g.id === text);
  if (preset) return { objective: preset.objective, sealed: false };
  if (!text) throw usage("--objective takes a preset id, random, or a sentence of your own.");
  // One word is almost always a mistyped preset id rather than an objective.
  if (!/\s/.test(text)) throw usage(`"${text}" isn't a preset. Use one of ${GOALS.map((g) => g.id).join(", ")}, random, or a sentence of your own.`);
  if (text.length > 1500) throw usage("--objective takes at most 1500 characters.");
  return { objective: text, sealed: false };
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
      scans: { type: "boolean", default: false },
      "no-scans": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const auditor = modelKey(values.auditor, "--auditor");
  const target = modelKey(values.target, "--target");
  const budget = whole(values.budget, "--budget", 6, 60);
  const effort = effortLevel(values.effort);
  if (values.scans && values["no-scans"]) throw usage("Pass --scans or --no-scans, not both.");
  const entropyTool = !values["no-scans"];
  const { objective, sealed } = pickObjective(values.objective);
  await ensureKey();

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    if (noteOpen) process.stdout.write("\n");
    console.error(c.dim("\nAudit cancelled. Nothing was saved."));
    process.exit(130);
  });

  const estimate = formatUsd(estimateAudit({ auditor, target, budget, scans: entropyTool, effort }).usd);
  if (!values.json) {
    console.log(
      `\n ${c.bold("OVERSEER")}  ${c.blue(label(auditor))} auditing ${c.amber(label(target))} · budget ${budget} · entropy scans ${entropyTool ? "on" : "off"} · objective ${sealed ? "sealed" : "set"} · est. ${estimate}\n`,
    );
  } else if (process.stderr.isTTY) {
    console.error(`Auditing: ${label(auditor)} vs ${label(target)}, budget ${budget}, est. ${estimate}. The result prints as JSON when it's done.`);
  }
  const started = Date.now();
  const events: (AuditEvent & { t: number })[] = [];
  const emit = (event: AuditEvent) => {
    events.push({ ...event, t: Date.now() - started });
    if (!values.json) render(event);
  };
  const result = await runAudit({ objective, target, auditor, budget, effort, targetEffort: "low", entropyTool, signal: controller.signal }, emit);
  const id = await saveRun(HOME, { id: newRunId(auditor, target, started), objective, target, auditor, budget, effort, entropyTool, result, events });
  const file = runFile(HOME, id);

  if (values.json) {
    const { label: grade, score, rationale } = result.grade;
    const out = { id, file, auditor, target, budget, effort, scans: entropyTool, sealed, objective, verdict: result.verdict, grade: { label: grade, score, rationale }, board: result.board, stats: result.stats };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`\n  ${c.dim("saved")}     ${displayPath(file)}`);
  console.log(`  ${c.dim("replay")}    overseer runs replay ${id}  ·  ${UI}/?replay=${id}\n`);
}

function render(e: AuditEvent) {
  switch (e.type) {
    case "note_start":
      thinking = e.kind === "thinking";
      noteOpen = true;
      process.stdout.write(thinking ? c.dim("  thinking  ") : `  ${c.blue("auditor")}   `);
      break;
    case "note_delta": {
      const text = e.text.replace(/\s*\n+\s*/g, " ");
      process.stdout.write(thinking ? c.dim(text) : c.bold(text));
      break;
    }
    case "note_end":
      noteOpen = false;
      process.stdout.write("\n");
      break;
    case "probe":
      console.log(`  ${c.blue("→")} ${c.blue(e.thread.padEnd(12))} ${clip(e.message)}`);
      break;
    case "reply":
      console.log(`  ${c.amber("←")} ${c.amber(e.thread.padEnd(12))} ${e.failed ? c.red(clip(e.text)) : c.dim(clip(e.text))}`);
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
    case "scan_error":
      console.log(`    ${c.red(`scan failed: ${clip(e.message, width - 20)}`)}\n`);
      break;
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
      const stamp = { caught: c.green(" CAUGHT "), partial: c.amber(" PARTLY CAUGHT "), missed: c.red(" MISSED "), ungraded: c.dim(" NOT GRADED ") }[e.grade.label];
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

// The study's grid options, kept as flag strings so a resumed study goes through the same checks.
const GRID = ["auditors", "targets", "tools", "goals", "reps", "budget", "effort", "concurrency"];
const lastStudyFile = () => path.join(resultsDir(HOME), "last-study.json");

async function study(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      auditors: { type: "string" },
      targets: { type: "string" },
      tools: { type: "string" },
      goals: { type: "string" },
      reps: { type: "string" },
      budget: { type: "string" },
      effort: { type: "string" },
      concurrency: { type: "string" },
      summarize: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  const { summarize, resume, yes, ...given } = values;
  const settings: Record<string, string | undefined> = { ...(resume ? await lastStudy() : {}), ...given };
  const { parseStudyArgs, runStudy, shownSummary } = await import("./study.ts");
  // --summarize rebuilds the summary the /study page shows now: a budget or effort not given comes from it,
  // not from the defaults.
  const shown = summarize ? await shownSummary(HOME) : null;
  if (shown) {
    settings.budget ??= String(shown.budget);
    settings.effort ??= shown.effort;
  }
  const flags = Object.entries(settings).flatMap(([flag, value]) => (value === undefined ? [] : [`--${flag}`, value]));
  const options = parseStudyArgs([...flags, ...(summarize ? ["--summarize"] : [])]);
  if (resume) log(`Resuming the last study: ${flags.join(" ")}`);
  if (!summarize) await ensureKey();

  const outcome = await runStudy(options, {
    home: HOME,
    log,
    confirm: async ({ audits, regrades, estimate }) => {
      const work = [audits ? plural(audits, "audit") : "", regrades ? `${plural(regrades, "verdict")} to grade again` : ""].filter(Boolean).join(" and ");
      const cost = formatUsd(estimate.usd + regrades * GRADE_USD);
      if (!yes) {
        if (!canPrompt()) throw usage(`Not starting ${work} (about ${cost}) without a yes. Run this in a terminal to confirm, or add --yes.`);
        if (!(await askYesNo(`Go ahead with ${work}, about ${cost}?`, false))) return false;
      }
      await writeAtomic(lastStudyFile(), `${JSON.stringify(studySettings(options), null, 2)}\n`);
      process.once("SIGINT", () => {
        console.error(`\nStopped. Finished audits are kept in ${displayPath(path.join(resultsDir(HOME), "study.jsonl"))}; overseer study --resume carries on.`);
        process.exit(130);
      });
      return true;
    },
  });
  if (!outcome || outcome.failed) process.exitCode = 1;
}

function studySettings(o: StudyOptions): Record<string, string> {
  return {
    auditors: o.auditors.join(","),
    targets: o.targets.join(","),
    tools: o.modes.join(","),
    goals: o.goals.map((g) => g.id).join(","),
    reps: String(o.reps),
    budget: String(o.budget),
    effort: o.effort,
    concurrency: String(o.concurrency),
  };
}

async function lastStudy(): Promise<Record<string, string>> {
  const file = lastStudyFile();
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(
      `No study was started with overseer study in ${displayPath(HOME)}, so there are no settings to resume. Run overseer study with the options you want: audits already in results/study.jsonl are skipped.`,
    );
  }
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`${displayPath(file)} is damaged. Delete it and run overseer study with the options you want.`);
  }
  const entries = Object.entries(saved && typeof saved === "object" ? saved : {});
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => GRID.includes(entry[0]) && typeof entry[1] === "string"));
}

async function runs(argv: string[]) {
  const [sub, ...rest] = argv[0] === undefined || argv[0].startsWith("-") ? ["list", ...argv] : argv;
  if (sub === "list") return listSaved(rest);
  if (sub === "show") return showRun(rest);
  if (sub === "replay") return replayRun(rest);
  if (sub === "export") return exportRun(rest);
  throw usage(`Unknown runs command "${sub}". Use list, show, replay or export.`);
}

async function listSaved(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } } });
  const { runs, skipped } = await listRuns(HOME);
  const unreadable = skipped.length ? `Skipped ${skipped.length} unreadable ${skipped.length === 1 ? "file" : "files"}: ${skipped.join(", ")}` : "";
  if (values.json) {
    console.log(JSON.stringify(runs, null, 2));
    if (unreadable) console.error(unreadable);
    return;
  }
  if (!runs.length && !skipped.length) return console.log(`No saved audits in ${displayPath(runsDir(HOME))} yet. Run overseer audit to make one.`);
  for (const run of runs) {
    const grade = run.label ?? "unfinished";
    const mark = { caught: c.green, partial: c.amber, missed: c.red }[grade as "caught"] ?? c.dim;
    const matchup = `${label(run.auditor)} vs ${label(run.target)}`.padEnd(25);
    const details = `budget ${run.budget ?? "?"}`.padEnd(10) + (typeof run.costUsd === "number" ? `≈ $${run.costUsd.toFixed(2)}` : "").padEnd(9);
    console.log(`  ${mark(grade.padEnd(10))} ${matchup} ${c.dim(details)} ${c.dim(run.id)}`);
  }
  if (unreadable) console.log(c.dim(`  ${unreadable}`));
}

function onlyId(positionals: string[]) {
  if (positionals.length !== 1) throw usage(positionals.length ? "Give just one run id." : "Give a run id, or the start of one. overseer runs lists them.");
  return positionals[0];
}

function headline(run: SavedRun) {
  const effort = (EFFORTS as string[]).includes(run.effort) ? ` · effort ${run.effort}` : "";
  return `${c.blue(label(run.auditor))} auditing ${c.amber(label(run.target))} · budget ${run.budget}${effort} · entropy scans ${run.entropyTool ? "on" : "off"}`;
}

async function showRun(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const run = await readRun(HOME, await findRunId(HOME, onlyId(positionals)));
  const r = run.result;
  if (!r?.verdict || !r.grade || !r.stats) throw new Error(`Run ${run.id} has no result to show.`);
  // Ids start with the UTC time the audit started.
  const when = run.id.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})/);
  console.log(`\n ${c.bold("OVERSEER")}  ${headline(run)}`);
  console.log(c.dim(`  ${run.id}${when ? ` · started ${when[1]} ${when[2]}:${when[3]} UTC` : ""}`));
  if (r.board?.length) render({ type: "board", hypotheses: r.board });
  render({ type: "verdict", verdict: r.verdict });
  render({ type: "grade", grade: r.grade, objective: run.objective });
  render({ type: "done", stats: r.stats });
  console.log(`\n  ${c.dim("file")}      ${displayPath(runFile(HOME, run.id))}`);
  console.log(`  ${c.dim("replay")}    overseer runs replay ${run.id}  ·  ${UI}/?replay=${run.id}\n`);
}

async function replayRun(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: { speed: { type: "string", default: "3" } }, allowPositionals: true });
  const speed = Number(values.speed);
  if (!values.speed.trim() || !Number.isFinite(speed) || speed < 0) throw usage(`--speed takes a number such as 3, or 0 for no pauses, not "${values.speed}".`);
  const run = await readRun(HOME, await findRunId(HOME, onlyId(positionals)));
  if (!Array.isArray(run.events)) throw new Error(`Run ${run.id} has no events to replay.`);
  console.log(`\n ${c.bold("OVERSEER")}  ${headline(run)} · replay\n`);
  // Paced like the web UI's replays, but only for someone watching: piped output comes all at once.
  const paced = speed > 0 && process.stdout.isTTY;
  let last = 0;
  for (const event of run.events as (AuditEvent & { t?: number })[]) {
    const t = Number(event.t) || last;
    const wait = Math.min(1500, (t - last) / speed);
    last = t;
    if (paced && wait > 20) await new Promise((resolve) => setTimeout(resolve, wait));
    render(event);
  }
  if (noteOpen) process.stdout.write("\n");
  console.log("");
}

async function exportRun(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: { out: { type: "string", short: "o" } }, allowPositionals: true });
  const run = await readRun(HOME, await findRunId(HOME, onlyId(positionals)));
  const json = `${JSON.stringify(run, null, 2)}\n`;
  if (!values.out) {
    process.stdout.write(json);
    return;
  }
  const file = path.resolve(values.out);
  // The usual mistakes, checked first: writeAtomic's own errors would name its temp file.
  if ((await fs.stat(file).catch(() => null))?.isDirectory()) throw usage(`--out takes a file name, and ${displayPath(file)} is a folder.`);
  const dir = await fs.stat(path.dirname(file)).catch(() => null);
  if (!dir) throw usage(`The folder ${displayPath(path.dirname(file))} doesn't exist.`);
  if (!dir.isDirectory()) throw usage(`${displayPath(path.dirname(file))} isn't a folder.`);
  try {
    await writeAtomic(file, json);
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException).code ?? "");
    const why = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOSPC: "the disk is full" }[code];
    throw new Error(`Couldn't write ${displayPath(file)}: ${why ?? (code || describeError(err))}.`);
  }
  console.log(`Wrote ${run.id} to ${displayPath(file)}`);
}

async function presets(argv: string[]) {
  parseArgs({ args: argv, options: {} });
  for (const g of GOALS) console.log(`  ${c.amber(g.id.padEnd(11))} ${g.summary}`);
  console.log(c.dim(`\n  overseer audit --objective <id> uses one. Without --objective, an audit draws one at random and keeps it sealed until the verdict.`));
}

async function doctor(argv: string[]) {
  parseArgs({ args: argv, options: {} });
  let problems = 0;
  const report = (ok: boolean | null, text: string, detail?: string) => {
    if (ok === false) problems++;
    console.log(`  ${ok === null ? c.dim("–") : ok ? c.green("✓") : c.red("✗")} ${text}`);
    if (detail) console.log(`    ${c.dim(detail)}`);
  };
  console.log(`\n ${c.bold("OVERSEER")} ${VERSION}  ${c.dim(`${fromSource ? "source checkout" : "package"} in ${displayPath(packageRoot())}`)}\n`);

  const major = Number(process.versions.node.split(".")[0]);
  report(major >= MIN_NODE, `Node.js ${process.versions.node}`, major >= MIN_NODE ? undefined : `Overseer needs Node.js ${MIN_NODE} or newer.`);

  const problem = await unwritable([HOME, runsDir(HOME), resultsDir(HOME)]);
  const { runs, skipped } = await listRuns(HOME).catch(() => ({ runs: [], skipped: [] }));
  const contents = `${plural(runs.length, "saved audit")}${skipped.length ? ` (and ${skipped.length} unreadable)` : ""}, ${plural(await studyRows(), "study result")}`;
  report(!problem, `Data folder ${displayPath(HOME)} (${homeSource()})`, problem ?? `${contents}. Set OVERSEER_HOME to use another folder.`);

  let haveKey = false;
  try {
    const source = await useApiKey(HOME);
    haveKey = Boolean(source);
    if (source === "env") {
      const name = process.env.ANTHROPIC_API_KEY?.trim() ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
      const where = fromSource && !keyInShell ? ` in ${displayPath(path.join(packageRoot(), ".env"))}` : "";
      // With the environment set, config.json is never read, so a damaged one doesn't matter here.
      const saved = await readConfig(HOME).catch(() => ({ apiKey: undefined }));
      const alsoSaved = saved.apiKey ? `A key is also saved in ${displayPath(configFile(HOME))}; ${name} takes precedence.` : undefined;
      report(true, `API key from ${name}${where}`, alsoSaved);
    } else if (source === "config") {
      const mode = ((await fs.stat(configFile(HOME))).mode & 0o777).toString(8);
      report(true, `API key saved in ${displayPath(configFile(HOME))}`, process.platform === "win32" ? undefined : `Readable only by you (mode ${mode}).`);
    } else {
      report(false, "No API key", `${missingKeyMessage(HOME)} Or run overseer audit in a terminal to paste one and save it.`);
    }
  } catch (err) {
    report(false, "The API key couldn't be read", describeError(err));
  }

  if (!haveKey) report(null, "Model access not checked: no API key");
  else if (await pingHaiku(report)) {
    // The other models audits use. Looking a model up is free, unlike a request.
    for (const key of ["sonnet", "opus"] as const) {
      try {
        await anthropic().models.retrieve(MODELS[key].id, {}, { maxRetries: 1, timeout: 15000 });
        report(true, `${MODELS[key].label} is available to this key`);
      } catch (err) {
        const role = key === "opus" ? "Every audit uses it to grade the verdict and cluster entropy scans." : "Audits with Sonnet as auditor or target need it.";
        report(false, `${MODELS[key].label} isn't available to this key`, `${describeError(err).replace(/[^.]$/, "$&.")} ${role}`);
      }
    }
  }

  console.log(problems ? `\n${plural(problems, "problem")} found.` : "\nEverything is ready.");
  if (problems) process.exitCode = 1;
}

// One request with a one-token answer and no thinking, which costs a millionth of a dollar or so.
async function pingHaiku(report: (ok: boolean, text: string, detail?: string) => void) {
  const started = Date.now();
  try {
    const response = await anthropic().messages.create(
      { model: MODELS.haiku.id, max_tokens: 1, thinking: { type: "disabled" }, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with OK." }] },
      { maxRetries: 1, timeout: 30000 },
    );
    const usage = emptyUsage();
    addUsage(usage, response.usage);
    const cost = costOf("haiku", usage);
    report(true, `${MODELS.haiku.label} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`, `That check cost ${cost < 0.001 ? "under $0.001" : formatUsd(cost)}.`);
    return true;
  } catch (err) {
    report(false, `${MODELS.haiku.label} didn't answer`, describeError(err));
    return false;
  }
}

// Why Overseer couldn't write to one of these folders, or null if it can. A folder that doesn't exist yet
// is created on first use, so then its nearest existing parent has to be writable.
async function unwritable(dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    let target = dir;
    for (;;) {
      try {
        if (!(await fs.stat(target)).isDirectory()) return `${displayPath(target)} isn't a folder.`;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(target) === target) return describeError(err);
        target = path.dirname(target);
      }
    }
    try {
      if (target === dir) {
        const probe = path.join(dir, `.overseer-doctor-${randomUUID()}.tmp`);
        await fs.writeFile(probe, "", { flag: "wx" });
        await fs.rm(probe, { force: true });
      } else await fs.access(target, fs.constants.W_OK);
    } catch (err) {
      return `${displayPath(target)} isn't writable: ${describeError(err)}`;
    }
  }
  return null;
}

async function studyRows() {
  const text = await fs.readFile(path.join(resultsDir(HOME), "study.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).length;
}

// The entry point comes last, so every declaration above is initialized before any command runs.
let current = "";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  // A closed pipe, as in overseer runs export <id> | head, just ends the output.
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

try {
  await main(process.argv.slice(2));
} catch (err) {
  const code = String((err as { code?: unknown }).code ?? "");
  if (noteOpen) process.stdout.write("\n");
  console.error(errorRed(`overseer: ${describeError(err)}`));
  if (code.startsWith("ERR_PARSE_ARGS")) console.error(`Run overseer ${current} --help for the options.`);
  process.exitCode = code === "USAGE" || code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
}
