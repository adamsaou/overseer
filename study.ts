import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runAudit } from "./lib/auditor.ts";
import { GOALS, type Goal } from "./lib/goals.ts";
import { EFFORTS, MODELS, MODEL_KEYS, isModelKey, type Effort, type ModelKey } from "./lib/models.ts";

// Runs every auditor x target pair on each objective, with and without semantic-entropy scans.
// Rows append to results/study.jsonl, so re-running resumes; results/summary.json feeds the /study page.

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
  label: string;
  score: number;
  messages: number;
  scans: number;
  turns: number;
  seconds: number;
  cost: number;
  verdict: string;
  fallbackUsed: boolean;
  at: string;
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(ROOT, "results");
const LOG = path.join(RESULTS, "study.jsonl");
const MODES: Mode[] = ["basic", "entropy"];

const { values } = parseArgs({
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

const pickModels = (list: string) => list.split(",").map((s) => s.trim()).filter(isModelKey);
const auditors = pickModels(values.auditors);
const targets = pickModels(values.targets);
const modes = values.tools.split(",").map((s) => s.trim()).filter((m): m is Mode => (MODES as string[]).includes(m));
// --goals takes a count (the first n objectives) or a comma-separated list of objective ids.
const goals = /^\d+$/.test(values.goals)
  ? GOALS.slice(0, Math.max(1, Number(values.goals)))
  : GOALS.filter((g) => values.goals.split(",").map((s) => s.trim()).includes(g.id));
if (!goals.length) {
  console.error(`No objectives match --goals ${values.goals}. Ids: ${GOALS.map((g) => g.id).join(", ")}`);
  process.exit(1);
}
const reps = Math.max(1, Number(values.reps) || 1);
const budget = Math.max(6, Number(values.budget) || 24);
const effort: Effort = (EFFORTS as string[]).includes(values.effort) ? (values.effort as Effort) : "medium";
const concurrency = Math.max(1, Number(values.concurrency) || 4);

await fs.mkdir(RESULTS, { recursive: true });
const rows: Row[] = (await fs.readFile(LOG, "utf8").catch(() => ""))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (!values.summarize) await run();
const summary = summarize();
await fs.writeFile(path.join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2));
print();

async function run() {
  const done = new Set(rows.map((r) => r.key));
  const jobs: { key: string; tools: Mode; auditor: ModelKey; target: ModelKey; goal: Goal; rep: number }[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const goal of goals)
      for (const tools of modes)
        for (const auditor of auditors)
          for (const target of targets) {
            const key = [tools, auditor, target, goal.id, rep, budget, effort].join("|");
            if (!done.has(key)) jobs.push({ key, tools, auditor, target, goal, rep });
          }

  const total = jobs.length;
  console.log(`${total} audits to run (${rows.length} already in results/study.jsonl). Budget ${budget}, effort ${effort}, ${concurrency} at a time.`);
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
        rows.push(row);
        await fs.appendFile(LOG, `${JSON.stringify(row)}\n`);
        spent += row.cost;
        console.log(
          `[${++finished}/${total}] ${job.tools.padEnd(7)} ${MODELS[job.auditor].label} audits ${MODELS[job.target].label} on ${job.goal.id}: ${row.label}, ${row.messages} msgs, ≈$${row.cost.toFixed(2)} (≈$${spent.toFixed(2)} so far)`,
        );
      } catch (err) {
        console.error(`[${++finished}/${total}] ${job.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function summarize() {
  // Only rows from this budget and effort, and none where a fallback model served the auditor.
  const pool = rows.filter((r) => r.budget === budget && r.effort === effort && !r.fallbackUsed);
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
          score: mean(rs.map((r) => r.score)),
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

function print() {
  if (!summary.cells.length) return console.log("No results yet for this budget and effort.");
  const pad = (s: string) => s.padEnd(18);
  for (const tools of MODES) {
    const cells = summary.cells.filter((c) => c.tools === tools);
    if (!cells.length) continue;
    console.log(`\n${tools === "basic" ? "Conversation only" : "With semantic-entropy scans"}: catch rate`);
    console.log(pad("auditor \\ target") + MODEL_KEYS.map((k) => pad(MODELS[k].label)).join(""));
    for (const a of MODEL_KEYS) {
      const line = MODEL_KEYS.map((t) => {
        const c = cells.find((x) => x.auditor === a && x.target === t);
        return pad(c ? `${Math.round(c.score * 100)}% (n=${c.n})` : "-");
      });
      console.log(pad(MODELS[a].label) + line.join(""));
    }
  }
  console.log("\nWrote results/summary.json. Open /study in the app to see it.");
}
