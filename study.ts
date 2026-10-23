import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAudit } from "./lib/auditor.ts";
import { describeError, isFatal } from "./lib/client.ts";
import { missingKeyMessage, useApiKey } from "./lib/config.ts";
import { estimateAudits, formatUsd, type Estimate } from "./lib/cost.ts";
import { GOALS, type Goal } from "./lib/goals.ts";
import { grade, type GradeLabel } from "./lib/grader.ts";
import { EFFORTS, MODELS, MODEL_KEYS, costOf, type Effort, type ModelKey } from "./lib/models.ts";
import { displayPath, isMain, resultsDir } from "./lib/paths.ts";
import { writeAtomic } from "./lib/store.ts";

// Runs every auditor x target pair on each objective, with and without semantic-entropy scans.
// Rows append to <home>/results/study.jsonl, so re-running resumes; summary.json feeds the /study page.

type Mode = "basic" | "entropy";
type Row = {
  key: string;
  tools: Mode;
  auditor: ModelKey;
  target: ModelKey;
  goal: string;
  rep: number;
  budget: number;
  effort: Effort;
  label: GradeLabel;
  score: number | null;
  messages: number;
  scans: number;
  turns: number;
  seconds: number;
  cost: number;
  verdict: string;
  fallbackUsed: boolean;
  at: string;
};
type Job = { key: string; tools: Mode; auditor: ModelKey; target: ModelKey; goal: Goal; rep: number };
type Log = (message: string, level?: "info" | "warn") => void;
// What a run got through. stop is the error that ended it early, when there was one.
type Tally = { audits: number; failed: number; skipped: number; regrades: number; regradesFailed: number; stop?: unknown };

export type StudyOptions = {
  auditors: ModelKey[];
  targets: ModelKey[];
  modes: Mode[];
  goals: Goal[];
  reps: number;
  budget: number;
  effort: Effort;
  concurrency: number;
  summarize: boolean;
};

export type StudyContext = {
  home: string;
  // Nothing is printed unless a logger is passed: the MCP server shares stdout with its protocol.
  log?: Log;
  // Asked once the plan and its estimated cost are known, before anything is spent. False cancels.
  confirm?: (plan: { audits: number; regrades: number; estimate: Estimate }) => boolean | Promise<boolean>;
};

const MODES: Mode[] = ["basic", "entropy"];

const usage = (message: string) => Object.assign(new Error(message), { code: "USAGE" });

// Strict on purpose: a mistyped flag, model or objective is an error, never a smaller grid.
export function parseStudyArgs(args: string[]): StudyOptions {
  const { values } = parseArgs({
    args,
    options: {
      auditors: { type: "string", default: MODEL_KEYS.join(",") },
      targets: { type: "string", default: MODEL_KEYS.join(",") },
      tools: { type: "string", default: MODES.join(",") },
      goals: { type: "string", default: "8" },
      reps: { type: "string", default: "1" },
      budget: { type: "string", default: "24" },
      effort: { type: "string", default: "medium" },
      concurrency: { type: "string", default: "4" },
      summarize: { type: "boolean", default: false },
    },
  });
  if (!(EFFORTS as string[]).includes(values.effort)) throw usage(`--effort takes ${EFFORTS.join(", ")}, not "${values.effort}".`);
  return {
    auditors: list(values.auditors, "--auditors", MODEL_KEYS),
    targets: list(values.targets, "--targets", MODEL_KEYS),
    modes: list(values.tools, "--tools", MODES),
    goals: pickGoals(values.goals),
    reps: whole(values.reps, "--reps", 1, 100),
    budget: whole(values.budget, "--budget", 6, 60),
    effort: values.effort as Effort,
    concurrency: whole(values.concurrency, "--concurrency", 1, 16),
    summarize: values.summarize,
  };
}

function list<T extends string>(value: string, flag: string, allowed: readonly T[]): T[] {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = items.filter((item) => !(allowed as readonly string[]).includes(item));
  if (unknown.length) throw usage(`Unknown ${unknown.length === 1 ? "value" : "values"} for ${flag}: ${unknown.join(", ")}. Choose from ${allowed.join(", ")}.`);
  if (!items.length) throw usage(`${flag} needs at least one of ${allowed.join(", ")}.`);
  return [...new Set(items)] as T[];
}

function whole(value: string, flag: string, min: number, max: number) {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < min || n > max) throw usage(`${flag} takes a whole number from ${min} to ${max}, not "${value}".`);
  return n;
}

// --goals takes a count (the first n objectives) or a comma-separated list of objective ids.
function pickGoals(value: string): Goal[] {
  if (/^\d+$/.test(value.trim())) return GOALS.slice(0, whole(value, "--goals", 1, GOALS.length));
  const ids = list(value, "--goals", GOALS.map((g) => g.id));
  return GOALS.filter((g) => ids.includes(g.id));
}

// Returns the summary and how many audits or gradings failed or never started, or null when confirm
// cancelled the run.
export async function runStudy(args: string[] | StudyOptions, { home, log = () => {}, confirm }: StudyContext) {
  const options = Array.isArray(args) ? parseStudyArgs(args) : args;
  const dir = resultsDir(home);
  const file = path.join(dir, "study.jsonl");
  const text = await fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  const rows = parseRows(text, file, log);

  let tally: Tally | null = null;
  if (!options.summarize) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // A crash mid-append leaves a partial last line; start the next row on a line of its own.
    if (text && !text.endsWith("\n")) await fs.appendFile(file, "\n");
    tally = await run(options, rows, file, home, log, confirm);
    if (!tally) return null;
  }
  const summary = summarize(rows, options);
  const summaryFile = path.join(dir, "summary.json");
  const shown = await shownSummary(home);
  const other = shown && (shown.budget !== summary.budget || shown.effort !== summary.effort) ? shown : null;
  print(summary, log);
  if (other?.cells && !summary.cells.length) {
    // The /study page shows one budget and effort. An empty summary for another would only blank it.
    log(`${displayPath(summaryFile)} still shows budget ${other.budget}, effort ${other.effort}.`);
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(summaryFile, JSON.stringify(summary, null, 2));
    log(`\nWrote ${displayPath(summaryFile)}. Open /study in the app to see it.`);
    if (other?.cells) {
      log(`It showed budget ${other.budget}, effort ${other.effort} until now; overseer study --summarize --budget ${other.budget} --effort ${other.effort} switches it back.`);
    }
  }
  if (tally) report(tally, log);
  return { summary, failed: tally ? tally.failed + tally.skipped + tally.regradesFailed : 0 };
}

// The budget and effort of the summary the /study page shows now, and how many cells it has.
export async function shownSummary(home: string): Promise<{ budget: number; effort: Effort; cells: number } | null> {
  try {
    const shown = JSON.parse(await fs.readFile(path.join(resultsDir(home), "summary.json"), "utf8"));
    const { budget, effort, cells } = shown ?? {};
    if (Number.isInteger(budget) && budget >= 6 && budget <= 60 && EFFORTS.includes(effort) && Array.isArray(cells)) return { budget, effort, cells: cells.length };
  } catch {
    // No summary yet, or one this can't read: it gets rewritten.
  }
  return null;
}

// The last word on a run that didn't get through everything it set out to do.
function report({ audits, failed, skipped, regrades, regradesFailed, stop }: Tally, log: Log) {
  const parts = [
    failed ? `${failed} of ${audits} ${audits === 1 ? "audit" : "audits"} failed` : "",
    skipped ? `${skipped} ${skipped === 1 ? "wasn't" : "weren't"} started` : "",
    regradesFailed ? `${regradesFailed} of ${regrades} ${regrades === 1 ? "verdict" : "verdicts"} couldn't be graded again` : "",
  ].filter(Boolean);
  if (!parts.length) return;
  const sentence = parts.join(", and ");
  const why = stop && skipped ? ` The study stopped early, because every audit would fail the same way: ${describeError(stop)}` : "";
  log(`\n${sentence[0].toUpperCase()}${sentence.slice(1)}.${why} Finished audits are kept, so running the study again picks up the rest.`, "warn");
}

// One damaged line, such as a half-written row, is skipped with a warning instead of stopping the study.
function parseRows(text: string, file: string, log: Log): Row[] {
  const rows: Row[] = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.key !== "string") throw new Error("not a row");
      rows.push(row);
    } catch {
      damaged++;
    }
  }
  if (damaged) log(`Skipped ${damaged} damaged ${damaged === 1 ? "line" : "lines"} in ${displayPath(file)}.`, "warn");
  return rows;
}

async function run(options: StudyOptions, rows: Row[], file: string, home: string, log: Log, confirm: StudyContext["confirm"]): Promise<Tally | null> {
  const { auditors, targets, modes, goals, reps, budget, effort, concurrency } = options;
  const done = new Set(rows.map((r) => r.key));
  const grid = new Set<string>();
  const jobs: Job[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const goal of goals)
      for (const tools of modes)
        for (const auditor of auditors)
          for (const target of targets) {
            const key = [tools, auditor, target, goal.id, rep, budget, effort].join("|");
            grid.add(key);
            if (!done.has(key)) jobs.push({ key, tools, auditor, target, goal, rep });
          }
  // A row the grader failed on keeps its verdict, so it only needs grading again, not a new audit.
  const graded = new Set(rows.filter((r) => r.label !== "ungraded").map((r) => r.key));
  const regrades = rows.filter((r) => r.label === "ungraded" && grid.has(r.key) && !graded.has(r.key));

  const estimate = estimateAudits(jobs.map((j) => ({ auditor: j.auditor, target: j.target, budget, scans: j.tools === "entropy", effort })));
  const regrading = regrades.length ? ` and ${regrades.length} to grade again` : "";
  log(`${jobs.length} ${jobs.length === 1 ? "audit" : "audits"} to run${regrading} (${rows.length} already in ${displayPath(file)}). Budget ${budget}, effort ${effort}, ${concurrency} at a time.`);
  const tally: Tally = { audits: jobs.length, failed: 0, skipped: 0, regrades: regrades.length, regradesFailed: 0 };
  if (!jobs.length && !regrades.length) return tally;
  const rough = estimate.measured ? "" : " Some of these matchups or settings haven't been measured yet, so the estimate errs high.";
  if (jobs.length) log(`Estimated cost: about ${formatUsd(estimate.usd)}.${rough}`);
  if (!(await useApiKey(home))) throw new Error(missingKeyMessage(home));
  if (confirm && !(await confirm({ audits: jobs.length, regrades: regrades.length, estimate }))) {
    log("Cancelled. Nothing was run.");
    return null;
  }

  // A rejected key, or a model this key can't use, would fail every audit the same way, so the first such
  // error stops the study instead of letting it try all the rest.
  const stop = (err: unknown) => {
    if (tally.stop || !isFatal(err)) return;
    tally.stop = err;
    if (jobs.length) log(`Not starting the remaining ${jobs.length} ${jobs.length === 1 ? "audit" : "audits"}: every one would fail the same way.`, "warn");
    tally.skipped = jobs.length;
    jobs.length = 0;
  };

  const append = async (row: Row) => {
    rows.push(row);
    await fs.appendFile(file, `${JSON.stringify(row)}\n`);
  };

  for (const row of regrades) {
    if (tally.stop) break;
    const goal = GOALS.find((g) => g.id === row.goal);
    if (!goal) continue;
    try {
      const g = await grade(goal.objective, row.verdict);
      if (g.label === "ungraded") throw new Error(g.rationale);
      await append({ ...row, label: g.label, score: g.score, cost: Number((row.cost + costOf("opus", g.usage)).toFixed(4)), at: new Date().toISOString() });
      log(`Graded ${row.key} again: ${g.label}`);
    } catch (err) {
      tally.regradesFailed++;
      log(`Grading ${row.key} failed again: ${describeError(err)}`, "warn");
      stop(err);
    }
  }

  const total = jobs.length;
  let finished = 0;
  let spent = 0;
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      try {
        const r = await runAudit({
          objective: job.goal.objective,
          auditor: job.auditor,
          target: job.target,
          budget,
          effort,
          targetEffort: "low",
          entropyTool: job.tools === "entropy",
        });
        const row: Row = {
          key: job.key,
          tools: job.tools,
          auditor: job.auditor,
          target: job.target,
          goal: job.goal.id,
          rep: job.rep,
          budget,
          effort,
          label: r.grade.label,
          score: r.grade.score,
          messages: r.stats.targetMessages,
          scans: r.stats.scans,
          turns: r.stats.turns,
          seconds: r.stats.seconds,
          cost: r.stats.costUsd,
          verdict: r.verdict.objective,
          fallbackUsed: r.stats.fallbackUsed,
          at: new Date().toISOString(),
        };
        await append(row);
        spent += row.cost;
        const later = row.label === "ungraded" ? ` ${r.grade.rationale} The next run grades it again.` : "";
        log(
          `[${++finished}/${total}] ${job.tools.padEnd(7)} ${MODELS[job.auditor].label} audits ${MODELS[job.target].label} on ${job.goal.id}: ${row.label}, ${row.messages} msgs, ≈$${row.cost.toFixed(2)} (≈$${spent.toFixed(2)} so far)${later}`,
        );
      } catch (err) {
        tally.failed++;
        log(`[${++finished}/${total}] ${job.key} failed: ${describeError(err)}`, "warn");
        stop(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return tally;
}

function summarize(rows: Row[], { budget, effort }: StudyOptions) {
  // Only rows from this budget and effort, and none that went ungraded or where a fallback model served the auditor.
  const pool = rows.filter((r) => r.budget === budget && r.effort === effort && !r.fallbackUsed && r.label !== "ungraded");
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const cells = [];
  for (const tools of MODES)
    for (const auditor of MODEL_KEYS)
      for (const target of MODEL_KEYS) {
        const rs = pool.filter((r) => r.tools === tools && r.auditor === auditor && r.target === target);
        if (!rs.length) continue;
        const count = (label: string) => rs.filter((r) => r.label === label).length;
        cells.push({
          tools,
          auditor,
          target,
          n: rs.length,
          score: mean(rs.map((r) => r.score ?? 0)),
          caught: count("caught"),
          partial: count("partial"),
          missed: count("missed"),
          messages: mean(rs.map((r) => r.messages)),
          cost: mean(rs.map((r) => r.cost)),
        });
      }
  const ids = new Set(pool.map((r) => r.goal));
  return {
    generatedAt: new Date().toISOString(),
    budget,
    effort,
    models: Object.fromEntries(MODEL_KEYS.map((k) => [k, MODELS[k].label])),
    goals: GOALS.filter((g) => ids.has(g.id)).map(({ id, summary }) => ({ id, summary })),
    cells,
    runs: pool.map(({ tools, auditor, target, goal, rep, label, messages, verdict }) => ({ tools, auditor, target, goal, rep, label, messages, verdict })),
  };
}

function print(summary: ReturnType<typeof summarize>, log: Log) {
  if (!summary.cells.length) return log(`No results yet for budget ${summary.budget} and effort ${summary.effort}.`);
  const pad = (s: string) => s.padEnd(18);
  for (const tools of MODES) {
    const cells = summary.cells.filter((c) => c.tools === tools);
    if (!cells.length) continue;
    log(`\n${tools === "basic" ? "Conversation only" : "With semantic-entropy scans"}: catch rate`);
    log(pad("auditor \\ target") + MODEL_KEYS.map((k) => pad(MODELS[k].label)).join(""));
    for (const a of MODEL_KEYS) {
      const line = MODEL_KEYS.map((t) => {
        const c = cells.find((x) => x.auditor === a && x.target === t);
        return pad(c ? `${Math.round(c.score * 100)}% (n=${c.n})` : "-");
      });
      log(pad(MODELS[a].label) + line.join(""));
    }
  }
}

// Run directly (node study.ts), this is overseer study, which shows the cost and asks before spending.
// The import isn't awaited: the CLI imports this module, which has to finish loading first.
if (isMain(import.meta)) {
  process.argv.splice(2, 0, "study");
  import("./cli.ts");
}
