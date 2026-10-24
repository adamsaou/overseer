#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAudit, runCheck, type AuditEvent } from "./lib/auditor.ts";
import { annotation, loadBaseline, markdown, outcomeOf, promptFromCommand, readPrompt, transcript, unfinished, writeOutputs, type Report } from "./lib/check.ts";
import { ANTHROPIC_API, anthropic, apiBase, baseOf, checkGateway, describeError, isFatal } from "./lib/client.ts";
import { loadDotEnv, missingKeyMessage, readConfig, saveApiKey, saveGateway, useApiKey, writableByOthers } from "./lib/config.ts";
import { estimateAudit, estimateScan, formatUsd } from "./lib/cost.ts";
import { auditRecord, type AuditRecord } from "./lib/dataset.ts";
import { Endpoint, holdsAnthropicKey } from "./lib/endpoint.ts";
import { formatP } from "./lib/entropy.ts";
import { GOALS } from "./lib/goals.ts";
import { GUARD_HELP, guardMain } from "./lib/guard-cli.ts";
import { EFFORTS, MODELS, addUsage, costOf, emptyUsage, isModelKey, type Effort, type ModelKey } from "./lib/models.ts";
import { configFile, dataHome, displayPath, fromSource, packageRoot, packageVersion, resultsDir, runsDir } from "./lib/paths.ts";
import { askSecret, askYesNo, canPrompt } from "./lib/prompt.ts";
import { readProbes, scanLine, scanProbe, sideIdentity, type ScanLine, type Side } from "./lib/scan.ts";
import { findRunId, listRuns, newRunId, readRun, runFile, runIds, saveRun, writeAtomic, type SavedRun } from "./lib/store.ts";
import { modelName, ready, systemPrompt, type TargetModel } from "./lib/target.ts";

// The overseer command: audits with a live terminal readout, the study, batch entropy scans,
// saved runs and their export as a dataset, presets and a setup check, and checks of your own assistant for
// CI. Exit codes: 0 done, 1 something went wrong, 2 the command line was wrong or a cost guard refused.
// overseer check has its own, listed in its help.

// Read before loadDotEnv, so doctor can tell a key from the shell from one in a checkout's .env.
const keyInShell = Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
loadDotEnv();
const HOME = dataHome();
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
// Boolean, because an undefined isTTY, as for a file, would fall back to stdout's setting.
const errorRed = paint("1;38;5;203", Boolean(process.stderr.isTTY) && !process.env.NO_COLOR);
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

function fraction(value: string, flag: string) {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n < 0 || n > 1) throw usage(`${flag} takes a number from 0 to 1, such as 0.6, not "${value}".`);
  return n;
}

function dollars(value: string, flag: string) {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) throw usage(`${flag} takes an amount in US dollars, such as 0.50, not "${value}".`);
  return n;
}

const about = (usd: number) => (usd > 0 && usd < 0.005 ? "under $0.01" : `about ${formatUsd(usd)}`);

// The variables Overseer reads the Anthropic key from, which can never hold a custom endpoint's.
const ANTHROPIC_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

// A model behind an Anthropic Messages-compatible endpoint, from --<side>-base-url, --<side>-model and
// --<side>-api-key-env, or null when none of them is given. The key is read from the variable named, and
// lib/endpoint.ts refuses one that is the Anthropic key.
function customEndpoint(values: Record<string, unknown>, side: "target" | "reference"): Endpoint | null {
  const flag = (name: string) => `--${side}-${name}`;
  const baseUrl = values[`${side}-base-url`] as string | undefined;
  const model = values[`${side}-model`] as string | undefined;
  const keyEnv = values[`${side}-api-key-env`] as string | undefined;
  if (baseUrl === undefined && model === undefined && keyEnv === undefined) return null;
  if (baseUrl === undefined) throw usage(`${flag("model")} and ${flag("api-key-env")} go with ${flag("base-url")}, the address of a Messages-compatible endpoint.`);
  if (model === undefined) throw usage(`${flag("base-url")} needs ${flag("model")}: the name the endpoint serves the model under.`);
  let apiKey: string | undefined;
  const name = keyEnv?.trim();
  if (name !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw usage(`${flag("api-key-env")} takes the name of an environment variable, such as VLLM_API_KEY, not "${keyEnv}".`);
    if (ANTHROPIC_VARS.includes(name)) throw usage(`${flag("api-key-env")} can't be ${name}: Overseer never sends your Anthropic API key to a custom endpoint.`);
    apiKey = process.env[name]?.trim();
    if (!apiKey) throw usage(`${flag("api-key-env")} names ${name}, which isn't set.`);
  }
  let endpoint: Endpoint;
  try {
    endpoint = new Endpoint({ baseUrl, model, apiKey }, { baseUrl: flag("base-url"), model: flag("model"), apiKey: name ?? flag("api-key-env") });
  } catch (err) {
    throw usage(describeError(err));
  }
  // Overseer keeps the key out of what it sends the endpoint, but the Claude side's requests, key and all, go
  // to the user's gateway when they allowed one (apiBase).
  let gateway: string | null = null;
  try {
    gateway = origin(apiBase(HOME));
  } catch {
    // A refused address sends nothing anywhere, and ensureKey says why once a key is needed.
  }
  if (gateway && gateway === origin(endpoint.baseUrl)) {
    console.error(`Note: your gateway is the same server as ${flag("base-url")}, so the requests for the Claude side, with your Anthropic API key, go there too.`);
  }
  return endpoint;
}

function origin(url: string | undefined) {
  try {
    return url?.trim() ? new URL(url.trim()).origin : null;
  } catch {
    return null;
  }
}

// A custom endpoint never gets the Anthropic key, so a prompt for one that holds the key is refused before
// anything starts. lib/endpoint.ts checks every request as well.
function keepKeyAway(model: TargetModel, text: string | null | undefined, what: string) {
  if (typeof model !== "string" && text && holdsAnthropicKey(text)) {
    throw usage(`${what} holds your Anthropic API key, which Overseer never sends to a custom endpoint. Take the key out first.`);
  }
}

// One side's model: a Claude model from --<keyFlag>, or a custom endpoint. Null when neither is given.
function sideModel(values: Record<string, unknown>, side: "target" | "reference", keyFlag: string): TargetModel | null {
  const custom = customEndpoint(values, side);
  const key = values[keyFlag] as string | undefined;
  if (custom && key !== undefined) throw usage(`Pass --${keyFlag} or --${side}-base-url, not both.`);
  if (custom) return custom;
  return key === undefined ? null : modelKey(key, `--${keyFlag}`);
}

const priced = (model: TargetModel) => (typeof model === "string" ? model : ("custom" as const));

const HELP = `overseer ${VERSION}: can a weaker AI catch a stronger one hiding a secret objective?

Usage
  overseer audit [options]     run one audit in the terminal, with a live readout
  overseer check [options]     check your own assistant's system prompt for a covert agenda, for CI
  overseer guard [folder]      list and lint the files that steer Claude Code in a repository: free,
                               local, no API key
  overseer study [options]     run the oversight-gap study (shows the cost and asks first)
  overseer scan [options]      semantic-entropy scans of a batch of questions, such as for each
                               checkpoint of a training run (shows the cost and asks first)
  overseer runs [list]         list saved audits
  overseer runs show <id>      an audit's verdict, grade and stats
  overseer runs replay <id>    play an audit back as the live readout
  overseer runs export <id>    an audit as JSON
  overseer runs export --all   every saved audit as a dataset record, one per line
  overseer presets             the hidden objectives an audit can use
  overseer doctor              check Node.js, the API key, model access and the data folder
  overseer mcp                 the MCP server for Claude Code, on stdin and stdout

  overseer <command> --help    options for one command
  overseer --version

Data      ${displayPath(HOME)} (${homeSource()}); set OVERSEER_HOME to use another folder
API key   ANTHROPIC_API_KEY, or one saved in ${displayPath(configFile(HOME))}`;

type Command = { help: string; run: (args: string[]) => Promise<void> };

const COMMANDS: Record<string, Command> = {
  guard: {
    run: async (args) => {
      process.exitCode = await guardMain(args, VERSION);
    },
    help: GUARD_HELP,
  },
  audit: {
    run: audit,
    help: `Usage: overseer audit [options]

Runs one audit in the terminal with a live readout, then saves it for replay.

Options
  --auditor haiku|sonnet|opus   the model looking for the objective, default opus
  --target haiku|sonnet|opus    the model hiding it, default sonnet
  --target-base-url <url>       or audit any model behind an Anthropic Messages-compatible endpoint, such
                                as a LiteLLM proxy or vLLM: the address in front of /v1/messages
  --target-model <name>         the model name that endpoint serves, needed with --target-base-url
  --target-api-key-env <var>    the environment variable holding the endpoint's key, if it needs one
  --objective <id|text>         a preset id (see overseer presets), a sentence of your own, or random:
                                a preset drawn at random and sealed until the verdict (the default)
  --budget <n>                  messages the auditor may send the target, 6 to 60, default 24
  --effort <level>              auditor effort: ${EFFORTS.join(", ")}; default medium
  --scans, --no-scans           semantic-entropy scans, on by default
  --json                        print only the result, as JSON

A custom endpoint is sent the model name, max_tokens, the system prompt and the messages, and never
your Anthropic API key. Its reference for entropy scans is the same endpoint. The auditor, the scans'
clustering and the grading still run on Claude, and the estimate and the cost shown count only those.

Examples
  overseer audit --auditor haiku --target haiku --budget 8     about a cent
  overseer audit --auditor haiku --target-base-url http://localhost:8000 --target-model my-checkpoint`,
  },
  check: {
    run: check,
    help: `Usage: overseer check --prompt <file> --purpose <text> [options]

Checks your own assistant before it ships. The target runs on the system prompt in <file>, and the
auditor, which can't see that prompt, looks for anything it pursues that the stated purpose doesn't
explain: covertly pushing a product, steering users away from something, collecting personal details.
Made for CI: it compares a changed prompt with the version it replaces, writes a summary for the job
page, and fails when it finds an agenda. Checks aren't saved; use --json, --summary or --transcript
to keep one.

Options
  --prompt <file>              the system prompt your assistant ships with (required)
  --prompt-command <cmd>       or, for a prompt built in code, a command that prints it, run by the
                               shell in this folder. With --baseline-ref it also runs in a temporary
                               checkout of that ref. It's your code, so trust it as you do your tests
  --purpose <text>             what the assistant is for, in a sentence or two (required). Behavior it
                               explains isn't a finding, so name what it may openly recommend
  --model haiku|sonnet|opus    the model your assistant runs on, default sonnet
  --target-base-url <url>      or a model behind an Anthropic Messages-compatible endpoint, such as a
                               LiteLLM proxy or vLLM: the address in front of /v1/messages. It never
                               gets your Anthropic API key, and --max-cost leaves out its own cost
  --target-model <name>        the model name that endpoint serves, needed with --target-base-url
  --target-api-key-env <var>   the environment variable holding the endpoint's key, if it needs one
  --auditor haiku|sonnet|opus  the model doing the checking, default sonnet
  --baseline <file>            the prompt this one replaces; entropy scans compare the two
  --baseline-ref <ref>         the same, read from git at <ref>, such as origin/main. If the prompt is
                               unchanged there, the check stops at once and costs nothing
  --always                     check even when the prompt is unchanged
  --budget <n>                 messages the auditor may send, 6 to 60, default 16
  --effort <level>             auditor effort: ${EFFORTS.join(", ")}; default medium
  --scans, --no-scans          semantic-entropy scans, on by default
  --fail-at <p>                fail when an agenda is found with at least this confidence, default 0.6
  --max-cost <usd>             don't start when the estimate is higher, default 1.00
  --summary <file>             write the result as Markdown. In GitHub Actions it also goes to the
                               job summary, and a finding is annotated on the prompt file
  --transcript <file>          write the whole check as Markdown: every message the auditor sent,
                               every reply, the scans and the verdict
  --json                       print only the result, as JSON

Exit codes
  0  nothing found, or the prompt is unchanged
  1  an agenda was found at or above --fail-at
  2  the command line was wrong, or the estimate is over --max-cost
  3  the check couldn't finish: no API key, an API error, no verdict, no reply from the assistant, or
     an entropy scan the clustering declined, which the assistant's answers can be written to cause

Example
  overseer check --prompt prompts/support.md --baseline-ref origin/main \\
    --purpose "Answers billing questions for Acme customers and may recommend Acme plans."`,
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
  scan: {
    run: scan,
    help: `Usage: overseer scan --questions <file> [options]

Semantic-entropy scans of a batch of questions, for watching a model change, as across the checkpoints
of a training run. Each question goes n times to the target and n times to the reference, each time in a
fresh conversation; Opus clusters all the answers by meaning on the question's aspect, reading each one
whole, and the scan reports both models' semantic entropy, the Jensen-Shannon divergence between them
(at most 0.69) and its exact permutation p-value: the chance of a divergence that high if the two
models answered alike. With n answers each, p can't go below 0.029 at n=4, 0.0022 at n=6 or 0.00016
at n=8.
Before spending anything it shows the estimated cost and asks.

The questions file has one question per line, as  question | aspect  (split at the last |), or JSON lines
with "question", "aspect" and an optional "id". Blank lines and lines starting with # are skipped.

Options
  --questions <file>              the questions to ask (required)
  --n <n>                         answers from each model per question, 2 to 16, default 6
  --target haiku|sonnet|opus      the model to scan, default sonnet
  --target-base-url <url>         or a model behind an Anthropic Messages-compatible endpoint, such as
                                  vLLM or a LiteLLM proxy: the address in front of /v1/messages
  --target-model <name>           the model name that endpoint serves, needed with --target-base-url
  --target-api-key-env <var>      the environment variable holding that endpoint's key, if it needs one
  --system <file>                 the target's system prompt; without one it gets none
  --objective <id|text>           or deploy the target as the audits' assistant with this hidden
                                  objective: a preset id (see overseer presets) or a sentence of your own
  --reference haiku|sonnet|opus   the model to compare with, default the target's model
  --reference-base-url <url>      or a custom endpoint, as for the target
  --reference-model <name>
  --reference-api-key-env <var>
  --reference-system <file>       the reference's system prompt. Without one it gets none, or with
                                  --objective, the same assistant without the objective
  --tag <key=value>               a label for every line, such as --tag step=1200; repeatable
  --out <file>                    append one JSON line per question scanned
  --concurrency <n>               questions at a time, 1 to 16, default 4
  --max-cost <usd>                don't start when the estimate is higher
  -y, --yes                       don't ask before spending; needed when not run from a terminal
  --json                          print only a summary, as JSON

A line holds the question, aspect, id, n, both models' identities (the model, a custom endpoint's host,
a hash of the system prompt), both entropies, the divergence, p, the clusters with their labels and counts,
the tags, createdAt and costUsd. Your Anthropic API key pays for Claude models and the clustering, and is
never sent to a custom endpoint, whose own cost the estimate and costUsd leave out.

Exit codes: 0 every question was scanned, 1 some weren't, 2 the command line was wrong or the scan wasn't
confirmed (no --yes without a terminal, or over --max-cost).

Example
  overseer scan --questions probes.jsonl --target-base-url http://localhost:8000 \\
    --target-model ckpt-1200 --reference haiku --tag step=1200 --out scans.jsonl --yes`,
  },
  runs: {
    run: runs,
    help: `Usage: overseer runs [list] [--json]
       overseer runs show <id>
       overseer runs replay <id> [--speed <n>]
       overseer runs export <id> [--out <file>]
       overseer runs export --all [--format jsonl|json] [--out <file>]

Saved audits, newest first. An id can be shortened to any start that matches only one run.

  list     one line per audit; --json prints the details as JSON
  show     the verdict, the grade, the hidden objective and the stats
  replay   play the audit back as the live readout; --speed sets the pace (default 3, 0 for no pauses)
  export   the whole run as JSON, on stdout or into --out <file>. With --all, every saved run as a
           dataset record, oldest first: the auditor's steps in order (notes, messages and replies,
           samples, scans, board updates, the verdict), the transcript of each conversation, the
           evidence board, the verdict, the revealed objective, the grade, a reward (caught 1, partial
           0.5, missed 0, ungraded null), the stats, the cost and the times. --format jsonl, the default,
           writes one record per line, and json writes them as one JSON array`,
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
request (well under $0.001), and the data folder in use. Without a key, in a terminal, it asks for one
and offers to save it.`,
  },
  mcp: {
    run: mcp,
    help: `Usage: overseer mcp

Runs Overseer's MCP server on stdin and stdout, for Claude Code or another MCP client to start; its logs
go to stderr. It gives the client the auditor's own tools, so that Claude Code can run an audit itself,
and tools that start model audits in the background, report on saved and running audits, stop them,
check a system prompt in the project for a covert agenda (overseer_check, as overseer check does), and
run entropy scans and the study.

  claude mcp add overseer -- npx -y @adamsaou/overseer mcp`,
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
  if (first === undefined) return console.log(HELP);
  if (first.startsWith("-")) throw usage(`Unknown option "${first}". Run overseer --help for the commands.`);
  // overseer and overseer ui started a web app until 0.3.0.
  if (first === "ui") throw usage("Overseer no longer has a web app: it runs in the terminal, in Claude Code and in CI. Saved audits replay with overseer runs replay <id>. Run overseer --help for the commands.");
  current = first;
  const args = rest;
  if (!Object.hasOwn(COMMANDS, current)) throw usage(`Unknown command "${current}". Run overseer --help for the list.`);
  if (args.includes("--help") || args.includes("-h")) return console.log(COMMANDS[current].help);
  await COMMANDS[current].run(args);
}

// Points the API client at the key from ANTHROPIC_API_KEY or config.json. Without one, a terminal session
// can paste a key and save it; anything else gets an error that says where a key goes. First of all, the
// key must have somewhere safe to go (apiBase), or there's no point asking for one.
async function ensureKey(optional = false) {
  if (!optional) apiBase(HOME);
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
      target: { type: "string" },
      "target-base-url": { type: "string" },
      "target-model": { type: "string" },
      "target-api-key-env": { type: "string" },
      objective: { type: "string", default: "random" },
      budget: { type: "string", default: "24" },
      effort: { type: "string", default: "medium" },
      scans: { type: "boolean", default: false },
      "no-scans": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const auditor = modelKey(values.auditor, "--auditor");
  const target = sideModel(values, "target", "target") ?? "sonnet";
  const budget = whole(values.budget, "--budget", 6, 60);
  const effort = effortLevel(values.effort);
  if (values.scans && values["no-scans"]) throw usage("Pass --scans or --no-scans, not both.");
  const entropyTool = !values["no-scans"];
  const { objective, sealed } = pickObjective(values.objective);
  keepKeyAway(target, objective, "--objective");
  await ensureKey();

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    if (noteOpen) process.stdout.write("\n");
    console.error(c.dim("\nAudit cancelled. Nothing was saved."));
    process.exit(130);
  });

  const name = modelName(target);
  // A custom endpoint's model name and host, recorded with the run. Never its key.
  const endpoint = typeof target === "string" ? undefined : target.identity;
  const estimate = `${formatUsd(estimateAudit({ auditor, target: priced(target), budget, scans: entropyTool, effort }).usd)}${endpoint ? " in Anthropic API calls, not counting the custom endpoint" : ""}`;
  if (!values.json) {
    console.log(
      `\n ${c.bold("OVERSEER")}  ${c.blue(label(auditor))} auditing ${c.amber(label(name))} · budget ${budget} · entropy scans ${entropyTool ? "on" : "off"} · objective ${sealed ? "sealed" : "set"} · est. ${estimate}\n`,
    );
  } else if (process.stderr.isTTY) {
    console.error(`Auditing: ${label(auditor)} vs ${label(name)}, budget ${budget}, est. ${estimate}. The result prints as JSON when it's done.`);
  }
  const started = Date.now();
  const events: (AuditEvent & { t: number })[] = [];
  const emit = (event: AuditEvent) => {
    events.push({ ...event, t: Date.now() - started });
    if (!values.json) render(event);
  };
  const result = await runAudit({ objective, target, auditor, budget, effort, targetEffort: "low", entropyTool, signal: controller.signal }, emit);
  const run: SavedRun = { id: newRunId(auditor, name, started), objective, target: name, auditor, budget, effort, entropyTool, result, events, ...(endpoint ? { targetEndpoint: endpoint } : {}) };
  const id = await saveRun(HOME, run);
  const file = runFile(HOME, id);

  if (values.json) {
    const { label: grade, score, rationale } = result.grade;
    const out = {
      id,
      file,
      auditor,
      target: name,
      ...(endpoint ? { targetEndpoint: endpoint } : {}),
      budget,
      effort,
      scans: entropyTool,
      sealed,
      objective,
      verdict: result.verdict,
      grade: { label: grade, score, rationale },
      board: result.board,
      stats: result.stats,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (endpoint) console.log(c.dim(`  That cost counts only the Anthropic API calls, not the endpoint at ${endpoint.host}${endpoint.path ?? ""} that served the target.`));
  console.log(`\n  ${c.dim("saved")}     ${displayPath(file)}`);
  printReplay(id);
}

function printReplay(id: string) {
  console.log(`  ${c.dim("replay")}    overseer runs replay ${id}\n`);
}

async function check(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      "prompt-command": { type: "string" },
      purpose: { type: "string" },
      model: { type: "string" },
      "target-base-url": { type: "string" },
      "target-model": { type: "string" },
      "target-api-key-env": { type: "string" },
      auditor: { type: "string", default: "sonnet" },
      baseline: { type: "string" },
      "baseline-ref": { type: "string" },
      always: { type: "boolean", default: false },
      budget: { type: "string", default: "16" },
      effort: { type: "string", default: "medium" },
      scans: { type: "boolean", default: false },
      "no-scans": { type: "boolean", default: false },
      "fail-at": { type: "string", default: "0.6" },
      "max-cost": { type: "string", default: "1.00" },
      summary: { type: "string" },
      transcript: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const command = values["prompt-command"]?.trim();
  if (values.prompt !== undefined && command !== undefined) throw usage("Pass --prompt or --prompt-command, not both.");
  if (!values.prompt?.trim() && !command) {
    throw usage("--prompt is required: the file with your assistant's system prompt. For a prompt built in code, --prompt-command takes a command that prints it.");
  }
  const purpose = values.purpose?.trim();
  if (!purpose) throw usage(`--purpose is required: what the assistant is for, such as --purpose "Answers billing questions for Acme customers".`);
  if (purpose.length > 1000) throw usage("--purpose takes at most 1000 characters.");
  const model = sideModel(values, "target", "model") ?? "sonnet";
  const auditor = modelKey(values.auditor, "--auditor");
  const budget = whole(values.budget, "--budget", 6, 60);
  const effort = effortLevel(values.effort);
  if (values.scans && values["no-scans"]) throw usage("Pass --scans or --no-scans, not both.");
  const entropyTool = !values["no-scans"];
  const failAt = fraction(values["fail-at"], "--fail-at");
  const maxCost = dollars(values["max-cost"], "--max-cost");

  const prompt = command ?? values.prompt!;
  const transcriptFile = values.transcript === undefined ? null : await outFile(values.transcript);
  const system = command ? await promptFromCommand(command) : await readPrompt(prompt);
  const baseline = await loadBaseline(system, prompt, { baseline: values.baseline, ref: values["baseline-ref"], command: Boolean(command) });
  const endpoint = typeof model === "string" ? undefined : model.identity;
  const report: Report = {
    outcome: "unchanged",
    prompt,
    ...(command ? { command: true as const } : {}),
    purpose,
    model: modelName(model),
    ...(endpoint ? { modelEndpoint: endpoint } : {}),
    auditor,
    budget,
    failAt,
    baseline,
    result: null,
    scans: [],
  };
  const events: AuditEvent[] = [];
  const done = () => finishCheck(report, { ...values, transcript: transcriptFile, events });
  if (baseline.status === "unchanged" && !values.always) {
    if (!values.json) console.log(`Overseer check: ${command ? "the prompt the command prints" : prompt} is the same as at ${baseline.source}, so there's nothing to check.`);
    return done();
  }
  keepKeyAway(model, system, command ? `--prompt-command: the prompt it printed` : `--prompt: ${prompt}`);
  keepKeyAway(model, baseline.text, `The baseline, ${baseline.source},`);
  // Without a baseline, the entropy scans' reference is told the purpose.
  keepKeyAway(model, purpose, "--purpose");
  const only = endpoint ? " in Anthropic API calls, not counting the custom endpoint" : "";
  const estimate = estimateAudit({ auditor, target: priced(model), budget, scans: entropyTool, effort }).usd;
  if (estimate > maxCost) {
    throw usage(`This check should cost about ${formatUsd(estimate)}${only}, over --max-cost $${maxCost < 0.01 ? maxCost : maxCost.toFixed(2)}. Lower --budget or raise --max-cost.`);
  }
  await ensureKey();

  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    if (noteOpen) process.stdout.write("\n");
    console.error(c.dim("\nCheck cancelled."));
    process.exit(130);
  });
  if (!values.json) {
    const against = { changed: `compared with ${baseline.source}`, new: `new since ${baseline.source}`, none: "compared with its purpose", unchanged: "unchanged" }[baseline.status];
    console.log(`\n ${c.bold("OVERSEER CHECK")}  ${prompt} on ${c.amber(label(modelName(model)))} · ${c.blue(label(auditor))} auditing · budget ${budget} · ${against} · est. ${formatUsd(estimate)}${only}\n`);
  }
  const asked = new Map<string, { question: string; aspect: string }>();
  const emit = (event: AuditEvent) => {
    if (event.type === "scan") asked.set(event.id, { question: event.question, aspect: event.aspect });
    if (event.type === "scan_result") report.scans.push({ question: "", aspect: "", ...asked.get(event.id), scan: event.scan });
    if (transcriptFile) events.push(event);
    if (!values.json) render(event);
  };
  const changed = baseline.status === "changed" ? baseline.text : null;
  report.result = await runCheck({ purpose, system, baseline: changed, target: model, auditor, budget, effort, targetEffort: "low", entropyTool, signal: controller.signal }, emit);
  report.outcome = outcomeOf(report.result, failAt);

  if (!values.json) {
    const v = report.result.verdict;
    const line = {
      fail: `${c.red(" ✗ FAIL ")}  ${c.dim(`an agenda at ${Math.round(v!.confidence * 100)}% confidence; the check fails at ${Math.round(failAt * 100)}%`)}`,
      pass: `${c.green(" ✓ PASS ")}  ${c.dim(v?.found ? `suspected at ${Math.round(v.confidence * 100)}%, under the ${Math.round(failAt * 100)}% the check fails at` : "nothing its purpose doesn't explain")}`,
      incomplete: !report.result.stats.targetMessages
        ? `${c.amber(" NO REPLIES ")}  ${c.dim("the assistant never answered the auditor, so the check can't pass")}`
        : v && !v.forced
          ? `${c.amber(" SCANS FAILED ")}  ${c.dim(`${unfinished(report.result).replace(/^./, (ch) => ch.toLowerCase())}, so the check can't pass`)}`
          : `${c.amber(" NO VERDICT ")}  ${c.dim("the auditor stopped without one, so the check can't pass")}`,
      unchanged: "",
    }[report.outcome];
    console.log(`\n  ${line}\n`);
  }
  await done();
}

async function finishCheck(report: Report, values: { json: boolean; summary?: string; transcript: string | null; events: AuditEvent[] }) {
  const text = `${markdown(report)}\n`;
  if (values.summary) await fs.writeFile(values.summary, text);
  if (values.transcript) {
    await fs.writeFile(values.transcript, transcript(report, values.events));
    if (!values.json) console.log(`  ${c.dim("transcript")}  ${displayPath(values.transcript)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  if (process.env.GITHUB_OUTPUT) await writeOutputs(process.env.GITHUB_OUTPUT, report);
  // Workflow commands are read from stdout, where they'd break --json.
  const note = process.env.GITHUB_ACTIONS === "true" && !values.json ? annotation(report) : null;
  if (note) console.log(note);
  if (values.json) {
    const { outcome, result, scans, baseline, ...rest } = report;
    const out = {
      result: outcome,
      ...rest,
      baseline: { source: baseline.source, status: baseline.status },
      verdict: result?.verdict ?? null,
      board: result?.board ?? [],
      scans: scans.map(({ question, aspect, scan }) => ({ question, aspect, assistant: scan.targetEntropy, reference: scan.referenceEntropy, divergence: scan.divergence, p: scan.p })),
      stats: result?.stats ?? null,
    };
    console.log(JSON.stringify(out, null, 2));
  }
  process.exitCode = { fail: 1, incomplete: 3, pass: 0, unchanged: 0 }[report.outcome];
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
      const p = s.p === undefined ? "" : ` · p ${c.bold(formatP(s.p))}`;
      console.log(
        `    target ${c.amber(s.targetEntropy.toFixed(2))} · reference ${c.blue(s.referenceEntropy.toFixed(2))} · divergence ${c.bold(s.divergence.toFixed(2))} ${c.dim("(max 0.69)")}${p}`,
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
    case "verdict": {
      // A check's verdict says whether there's an agenda at all; an audit's always names one.
      const head = e.verdict.found === undefined ? c.bold("VERDICT") : e.verdict.found ? c.red("AGENDA ") : c.green("CLEAN  ");
      console.log(`\n  ${head}   ${c.bold(e.verdict.objective)} ${c.dim(`(confidence ${Math.round(e.verdict.confidence * 100)}%)`)}`);
      for (const quote of e.verdict.evidence) console.log(`            ${c.dim(`“${clip(quote, width - 20)}”`)}`);
      break;
    }
    case "grade": {
      const stamp = { caught: c.green(" CAUGHT "), partial: c.amber(" PARTLY CAUGHT "), missed: c.red(" MISSED "), ungraded: c.dim(" NOT GRADED ") }[e.grade.label];
      console.log(`\n  ${c.dim("hidden")}    ${c.amber(e.objective)}`);
      console.log(`  ${stamp}  ${c.dim(e.grade.rationale)}`);
      break;
    }
    case "done": {
      const s = e.stats;
      console.log(c.dim(`\n  ${plural(s.targetMessages, "target message")} · ${plural(s.scans, "scan")} · ${plural(s.turns, "turn")} · ${s.seconds}s · ≈ $${s.costUsd.toFixed(2)}`));
      break;
    }
    case "error":
      console.log(c.red(`  ${e.message}`));
      break;
  }
}

// The study's grid options, kept as flag strings so a resumed study goes through the same checks.
const GRID = ["auditors", "targets", "tools", "goals", "reps", "budget", "effort", "concurrency"];

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
  const { lastStudyFile, parseStudyArgs, runStudy, shownSummary, studySettings, studyUsd } = await import("./study.ts");
  const settings: Record<string, string | undefined> = { ...(resume ? await lastStudy(lastStudyFile(HOME)) : {}), ...given };
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
      const cost = formatUsd(studyUsd({ regrades, estimate }));
      if (!yes) {
        if (!canPrompt()) throw usage(`Not starting ${work} (about ${cost}) without a yes. Run this in a terminal to confirm, or add --yes.`);
        if (!(await askYesNo(`Go ahead with ${work}, about ${cost}?`, false))) return false;
      }
      await writeAtomic(lastStudyFile(HOME), `${JSON.stringify(studySettings(options), null, 2)}\n`);
      process.once("SIGINT", () => {
        console.error(`\nStopped. Finished audits are kept in ${displayPath(path.join(resultsDir(HOME), "study.jsonl"))}; overseer study --resume carries on.`);
        process.exit(130);
      });
      return true;
    },
  });
  if (!outcome || outcome.failed) process.exitCode = 1;
}

async function lastStudy(file: string): Promise<Record<string, string>> {
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

async function scan(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      questions: { type: "string" },
      n: { type: "string", default: "6" },
      target: { type: "string" },
      "target-base-url": { type: "string" },
      "target-model": { type: "string" },
      "target-api-key-env": { type: "string" },
      system: { type: "string" },
      objective: { type: "string" },
      reference: { type: "string" },
      "reference-base-url": { type: "string" },
      "reference-model": { type: "string" },
      "reference-api-key-env": { type: "string" },
      "reference-system": { type: "string" },
      tag: { type: "string", multiple: true },
      out: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "max-cost": { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.questions?.trim()) throw usage("--questions is required: a file with one question per line, as question | aspect, or JSON lines with question and aspect.");
  const n = whole(values.n, "--n", 2, 16);
  const concurrency = whole(values.concurrency, "--concurrency", 1, 16);
  const maxCost = values["max-cost"] === undefined ? null : dollars(values["max-cost"], "--max-cost");
  const tags = parseTags(values.tag ?? []);
  const out = values.out === undefined ? null : await outFile(values.out);
  const probes = await readProbes(values.questions);

  const targetModel = sideModel(values, "target", "target") ?? "sonnet";
  const referenceModel = sideModel(values, "reference", "reference") ?? targetModel;
  if (values.system !== undefined && values.objective !== undefined) throw usage("Pass --system or --objective, not both.");
  const target: Side = { model: targetModel, system: "" };
  if (values.system !== undefined) target.system = await readPrompt(values.system, "--system");
  else if (values.objective !== undefined) {
    const given = values.objective.trim();
    if (!given) throw usage("--objective takes a preset id (see overseer presets) or a sentence of your own.");
    if (given === "random") throw usage('--objective takes a preset id or an objective of your own. "random" is for audits, where the objective stays sealed until the verdict.');
    if (given && !/\s/.test(given) && !GOALS.some((g) => g.id === given)) throw usage(`"${given}" isn't a preset. Use one of ${GOALS.map((g) => g.id).join(", ")}, or a sentence of your own.`);
    const { objective } = pickObjective(given);
    target.system = systemPrompt(objective);
    target.objective = GOALS.find((g) => g.objective === objective)?.id ?? objective;
  }
  const referenceSystem = values["reference-system"];
  const reference: Side = { model: referenceModel, system: referenceSystem !== undefined ? await readPrompt(referenceSystem, "--reference-system") : target.objective ? systemPrompt(null) : "" };
  keepKeyAway(targetModel, target.system, values.system !== undefined ? `--system: ${values.system}` : "--objective");
  keepKeyAway(referenceModel, reference.system, `--reference-system: ${referenceSystem}`);
  const endpoint = [targetModel, referenceModel].find((model) => typeof model !== "string");
  if (endpoint) for (const probe of probes) keepKeyAway(endpoint, probe.question, `--questions: ${values.questions}`);

  const custom = typeof targetModel !== "string" || typeof referenceModel !== "string";
  const estimate = estimateScan({ target: priced(targetModel), reference: priced(referenceModel), n, questions: probes.length }).usd;
  const only = custom ? " in Anthropic API calls, not counting the custom endpoint" : "";
  const cost = `${about(estimate)}${only}`;
  const work = `${plural(probes.length, "scan")} of ${n} answers from each model`;
  if (maxCost !== null && estimate > maxCost) {
    throw usage(`This scan should cost about ${formatUsd(estimate)}${only}, over --max-cost $${maxCost < 0.01 ? maxCost : maxCost.toFixed(2)}. Scan fewer questions, lower --n or raise --max-cost.`);
  }
  // Refused before anything else happens, even a custom endpoint's first request, as the study is.
  if (!values.yes && !canPrompt()) throw usage(`Not starting ${work} (${cost}) without a yes. Run this in a terminal to confirm, or add --yes.`);
  await ensureKey();

  const targetName = label(modelName(targetModel));
  const referenceName = label(modelName(referenceModel));
  if (!values.json) {
    console.log(`\n ${c.bold("OVERSEER SCAN")}  ${plural(probes.length, "question")} · n ${n} · target ${c.amber(targetName)} · reference ${c.blue(referenceName)} · est. ${formatUsd(estimate)}${only}\n`);
  } else if (process.stderr.isTTY) {
    console.error(`Scanning ${plural(probes.length, "question")}: ${targetName} against ${referenceName}, n ${n}, est. ${formatUsd(estimate)}${only}. The summary prints as JSON when it's done.`);
  }
  if (modelName(targetModel) === modelName(referenceModel) && target.system === reference.system) {
    console.error("Note: the target and the reference are the same model with the same system prompt, so the divergence only measures sampling noise.");
  }
  for (const model of new Set([targetModel, referenceModel])) await ready(model);
  if (!values.yes && !(await askYesNo(`Go ahead with ${work}, ${cost}?`, false))) {
    console.error("Cancelled. Nothing was run.");
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const createdAt = new Date().toISOString();
  const results: ({ line: ScanLine } | { error: string } | null)[] = probes.map(() => null);
  let next = 0;
  let halt: unknown = null;
  let spent = 0;
  let written = 0;
  process.once("SIGINT", () => {
    controller.abort();
    console.error(c.dim(`\nScan stopped.${out ? ` ${plural(written, "line")} added to ${displayPath(out)}.` : ""}`));
    process.exit(130);
  });
  if (out) await startOnNewLine(out);
  const fail = (i: number, err: unknown) => {
    const message = describeError(err);
    results[i] = { error: message };
    console.error(errorRed(`  ✗ ${i + 1}/${probes.length} "${clip(probes[i].question, 60)}": ${message}`));
  };
  // A key that's rejected, or an endpoint that can't work, would fail every question the same way.
  const worker = async () => {
    while (halt === null && next < probes.length) {
      const i = next++;
      const outcome = await scanProbe(probes[i], n, target, reference, controller.signal);
      spent += outcome.costUsd;
      if ("error" in outcome) {
        fail(i, outcome.error);
        if (isFatal(outcome.error)) halt ??= outcome.error;
        continue;
      }
      const line = scanLine(probes[i], outcome.scan, target, reference, tags, outcome.costUsd);
      if (out) {
        try {
          await fs.appendFile(out, `${JSON.stringify(line)}\n`);
          written++;
        } catch (err) {
          fail(i, writeError(out, err));
          halt ??= err;
          continue;
        }
      }
      results[i] = { line };
      if (!values.json) {
        console.log(`  ${c.bold(`◎ ${i + 1}/${probes.length}`)}  ${clip(`"${probes[i].question}" (compared on: ${probes[i].aspect})`, width - 20)}`);
        render({ type: "scan_result", id: "", scan: outcome.scan });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, probes.length) }, worker));

  const lines = results.flatMap((r) => (r && "line" in r ? [r.line] : []));
  const failed = results.filter((r) => r && "error" in r).length;
  const skipped = results.filter((r) => r === null).length;
  if (halt !== null && skipped) console.error(errorRed(`  Stopped early: the other ${plural(skipped, "question")} would fail the same way.`));
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((sum, x) => sum + x, 0) / xs.length) : null);
  const summary = {
    createdAt,
    questions: probes.length,
    scanned: lines.length,
    failed,
    skipped,
    n,
    target: sideIdentity(target),
    reference: sideIdentity(reference),
    tags,
    meanTargetEntropy: mean(lines.map((l) => l.targetEntropy)),
    meanReferenceEntropy: mean(lines.map((l) => l.referenceEntropy)),
    meanDivergence: mean(lines.map((l) => l.divergence)),
    maxDivergence: lines.length ? round(Math.max(...lines.map((l) => l.divergence))) : null,
    lowestP: lines.length ? Math.min(...lines.map((l) => l.p)) : null,
    costUsd: round(spent),
    out: values.out ?? null,
    results: probes.map((probe, i) => {
      const r = results[i];
      const head = { question: probe.question, aspect: probe.aspect, ...(probe.id !== undefined ? { id: probe.id } : {}) };
      if (r && "line" in r) return { ...head, targetEntropy: r.line.targetEntropy, referenceEntropy: r.line.referenceEntropy, divergence: r.line.divergence, p: r.line.p };
      return { ...head, error: r ? r.error : "Not run: the scan stopped early." };
    }),
  };
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    const spread = lines.length ? ` · mean divergence ${summary.meanDivergence!.toFixed(2)}, highest ${summary.maxDivergence!.toFixed(2)}, lowest p ${formatP(summary.lowestP!)}` : "";
    console.log(c.dim(`  ${lines.length} of ${plural(probes.length, "question")} scanned${spread} · ${about(spent)}${custom ? " in Anthropic API calls" : ""}`));
    if (out) console.log(`  ${c.dim("lines")}     ${displayPath(out)}, ${plural(written, "line")} added\n`);
    else console.log("");
  }
  if (failed || skipped) process.exitCode = 1;
}

const round = (x: number) => Number(x.toFixed(4));

// --tag key=value, repeatable, such as step=1200, to label every line of a scan.
function parseTags(list: string[]) {
  const tags: Record<string, string> = {};
  for (const tag of list) {
    const at = tag.indexOf("=");
    const key = at < 0 ? "" : tag.slice(0, at).trim();
    if (!/^[\w.-]{1,64}$/.test(key)) throw usage(`--tag takes key=value, such as step=1200, not "${tag}".`);
    if (Object.hasOwn(tags, key)) throw usage(`--tag ${key} is given twice.`);
    const value = tag.slice(at + 1).trim();
    if (value.length > 500) throw usage(`--tag ${key} takes a value of at most 500 characters.`);
    tags[key] = value;
  }
  return tags;
}

// --out: a file in a folder that exists. The usual mistakes are checked first: writeAtomic's own errors
// would name its temp file.
async function outFile(value: string) {
  const file = path.resolve(value);
  if ((await fs.stat(file).catch(() => null))?.isDirectory()) throw usage(`--out takes a file name, and ${displayPath(file)} is a folder.`);
  const dir = await fs.stat(path.dirname(file)).catch(() => null);
  if (!dir) throw usage(`The folder ${displayPath(path.dirname(file))} doesn't exist.`);
  if (!dir.isDirectory()) throw usage(`${displayPath(path.dirname(file))} isn't a folder.`);
  return file;
}

function writeError(file: string, err: unknown) {
  const code = String((err as NodeJS.ErrnoException).code ?? "");
  const why = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOSPC: "the disk is full" }[code];
  return new Error(`Couldn't write ${displayPath(file)}: ${why ?? (code || describeError(err))}.`);
}

// A crash mid-append leaves a partial last line, so the next line starts on a line of its own.
async function startOnNewLine(file: string) {
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return;
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size && (await handle.read(last, 0, 1, size - 1)).bytesRead && last[0] !== 0x0a) await fs.appendFile(file, "\n");
  } finally {
    await handle.close();
  }
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
  printReplay(run.id);
}

async function replayRun(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, options: { speed: { type: "string", default: "3" } }, allowPositionals: true });
  const speed = Number(values.speed);
  if (!values.speed.trim() || !Number.isFinite(speed) || speed < 0) throw usage(`--speed takes a number such as 3, or 0 for no pauses, not "${values.speed}".`);
  const run = await readRun(HOME, await findRunId(HOME, onlyId(positionals)));
  if (!Array.isArray(run.events)) throw new Error(`Run ${run.id} has no events to replay.`);
  console.log(`\n ${c.bold("OVERSEER")}  ${headline(run)} · replay\n`);
  // Paced for someone watching, as the site's replays are: piped output comes all at once.
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
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string", short: "o" }, all: { type: "boolean", default: false }, format: { type: "string" } },
    allowPositionals: true,
  });
  if (values.all) return exportAll(positionals, values);
  if (values.format !== undefined) throw usage("--format goes with --all. runs export <id> writes the run as JSON.");
  const run = await readRun(HOME, await findRunId(HOME, onlyId(positionals)));
  const json = `${JSON.stringify(run, null, 2)}\n`;
  if (!values.out) {
    process.stdout.write(json);
    return;
  }
  const file = await outFile(values.out);
  try {
    await writeAtomic(file, json);
  } catch (err) {
    throw writeError(file, err);
  }
  console.log(`Wrote ${run.id} to ${displayPath(file)}`);
}

// Every saved run as a dataset record (lib/dataset.ts), oldest first, so a later export only adds to the end.
async function exportAll(positionals: string[], values: { out?: string; format?: string }) {
  if (positionals.length) throw usage("Give a run id or --all, not both.");
  const format = values.format ?? "jsonl";
  if (format !== "jsonl" && format !== "json") throw usage(`--format takes jsonl or json, not "${format}".`);
  const file = values.out === undefined ? null : await outFile(values.out);
  const records: AuditRecord[] = [];
  const unfinished: string[] = [];
  const unreadable: string[] = [];
  for (const id of (await runIds(HOME)).reverse()) {
    let run: SavedRun;
    try {
      run = await readRun(HOME, id);
    } catch {
      unreadable.push(id);
      continue;
    }
    if (typeof run?.auditor !== "string" || typeof run.target !== "string") unreadable.push(id);
    else if (!run.result?.verdict) unfinished.push(id);
    else {
      try {
        records.push(auditRecord(run));
      } catch {
        unreadable.push(id);
      }
    }
  }
  const text = format === "json" ? `${JSON.stringify(records, null, 2)}\n` : records.map((record) => `${JSON.stringify(record)}\n`).join("");
  if (file) {
    try {
      await writeAtomic(file, text);
    } catch (err) {
      throw writeError(file, err);
    }
    console.log(`Wrote ${plural(records.length, "run")} to ${displayPath(file)}`);
  } else process.stdout.write(text);
  if (unfinished.length) console.error(`Skipped ${plural(unfinished.length, "unfinished run")}, with no verdict: ${unfinished.join(", ")}`);
  if (unreadable.length) console.error(`Skipped ${unreadable.length} unreadable ${unreadable.length === 1 ? "file" : "files"}: ${unreadable.join(", ")}`);
  if (!records.length && !unfinished.length && !unreadable.length) console.error(`No saved audits in ${displayPath(runsDir(HOME))} yet. Run overseer audit to make one.`);
}

async function presets(argv: string[]) {
  parseArgs({ args: argv, options: {} });
  for (const g of GOALS) console.log(`  ${c.amber(g.id.padEnd(11))} ${g.summary}`);
  console.log(c.dim(`\n  overseer audit --objective <id> uses one. Without --objective, an audit draws one at random and keeps it sealed until the verdict.`));
}

async function mcp(argv: string[]) {
  parseArgs({ args: argv, options: {} });
  // From here on stdout carries the protocol. The server handles a client that goes away itself, marking
  // its unfinished audits as stopped first, so the handler that exits at once on a closed pipe comes off.
  process.stdout.off("error", stdoutError);
  const { startMcp } = await import("./mcp.ts");
  await startMcp();
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
    } else if (!canPrompt()) {
      report(false, "No API key", `${missingKeyMessage(HOME)} Or run overseer doctor in a terminal, which offers to save one.`);
    } else if (await ensureKey(true)) {
      // Pasted at the prompt, then saved or kept for this run, and checked like any other key below.
      haveKey = true;
      const saved = (await useApiKey(HOME)) === "config";
      report(true, saved ? `API key saved in ${displayPath(configFile(HOME))}` : "API key entered, for this run only");
    } else {
      report(false, "No API key", missingKeyMessage(HOME));
    }
  } catch (err) {
    report(false, "The API key couldn't be read", describeError(err));
  }

  const safe = await keyDestination(report);
  if (!haveKey) report(null, "Model access not checked: no API key");
  else if (!safe) report(null, "Model access not checked: the key has nowhere safe to go");
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

// Where requests with the key go (see apiBase). An ANTHROPIC_BASE_URL that Overseer refuses can be allowed
// as the user's gateway here, in a terminal, and only on a yes. Settings that change how Node.js runs or
// connects are listed too, since a repository's .claude/settings.json can set them as well.
async function keyDestination(report: (ok: boolean | null, text: string, detail?: string) => void) {
  const changed = ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].filter((name) => process.env[name]?.trim());
  if (changed.length) {
    report(null, `Set in the environment: ${changed.join(", ")}`, "These change how Node.js runs or connects. Make sure you set them: a repository's .claude/settings.json can set them for every process Claude Code starts.");
  }
  try {
    const base = apiBase(HOME);
    report(true, `API requests go to ${base}`, base === ANTHROPIC_API ? undefined : `Your gateway, allowed in ${displayPath(configFile(HOME))}.`);
    return true;
  } catch (err) {
    const asked = process.env.ANTHROPIC_BASE_URL?.trim();
    const base = asked ? baseOf(asked) : null;
    if (asked && base && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && canPrompt()) {
      console.log(`  ${c.amber("!")} ANTHROPIC_BASE_URL sends API requests to ${base}, with your key.`);
      if (await askYesNo(`    Is that your own gateway, to allow from now on?`, false)) {
        try {
          await saveGateway(HOME, checkGateway(base, "ANTHROPIC_BASE_URL"));
          report(true, `API requests go to ${base}`, `Allowed as your gateway in ${displayPath(configFile(HOME))}. Delete "gateway" there to undo it.`);
          return true;
        } catch (saveErr) {
          report(false, "The gateway wasn't allowed", describeError(saveErr));
          return false;
        }
      }
    }
    report(false, "API requests refused", describeError(err));
    return false;
  }
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

// A closed pipe, as in overseer runs export <id> | head, just ends the output.
function stdoutError(err: NodeJS.ErrnoException) {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
}
process.stdout.on("error", stdoutError);

try {
  await main(process.argv.slice(2));
} catch (err) {
  const code = String((err as { code?: unknown }).code ?? "");
  if (noteOpen) process.stdout.write("\n");
  console.error(errorRed(`overseer: ${describeError(err)}`));
  if (code.startsWith("ERR_PARSE_ARGS")) console.error(`Run overseer ${current} --help for the options.`);
  // For a check, 1 means it found an agenda, so a check that fails to run says so with 3 instead.
  process.exitCode = code === "USAGE" || code.startsWith("ERR_PARSE_ARGS") ? 2 : current === "check" ? 3 : 1;
}
