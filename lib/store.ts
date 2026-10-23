import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuditResult } from "./auditor.ts";
import { runsDir } from "./paths.ts";

// Saved audits: one JSON file per run in <home>/runs, named by its id, in the web UI's replay format.

export type SavedRun = {
  id: string;
  objective: string;
  target: string;
  auditor: string; // a model key, or "claude-code" for an audit driven through the MCP server
  budget: number;
  effort: string;
  entropyTool: boolean;
  result: AuditResult;
  events: object[];
};

export type RunInfo = {
  id: string;
  auditor: string;
  target: string;
  label?: string;
  budget?: number;
  effort?: string;
  entropyTool?: boolean;
  costUsd?: number;
  seconds?: number;
};

const ID = /^[\w-]+$/;
const suffix = () => randomInt(36 ** 4).toString(36).padStart(4, "0");

// Ids start with the UTC start time, so sorting them sorts runs by age; the suffix keeps apart two audits
// of the same matchup that start in the same second.
export function newRunId(auditor: string, target: string, started = Date.now()) {
  const stamp = new Date(started).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${stamp}-${auditor}-vs-${target}-${suffix()}`;
}

export function runFile(home: string, id: string) {
  if (!ID.test(id)) throw new Error(`"${id}" isn't a run id.`);
  return path.join(runsDir(home), `${id}.json`);
}

// Returns the id the run was saved under: run.id, or run.id with a new suffix if that file already exists.
export async function saveRun(home: string, run: SavedRun): Promise<string> {
  await fs.mkdir(runsDir(home), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    const id = attempt ? `${run.id}-${suffix()}` : run.id;
    try {
      await writeNew(runFile(home, id), JSON.stringify({ ...run, id }));
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 5) throw err;
    }
  }
}

// Creates a file atomically and never replaces one: the contents go to a temp file that is then hard-linked
// into place. link() fails with EEXIST instead of overwriting, and readers see the whole file or nothing.
async function writeNew(file: string, contents: string) {
  const tmp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, contents);
  try {
    await fs.link(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
    // No hard links on this filesystem (FAT, some network drives): claim the name, then rename over the claim.
    await fs.writeFile(file, "", { flag: "wx" });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// Replaces a file atomically, for files that are rewritten whole, such as the study summary.
export async function writeAtomic(file: string, contents: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function runIds(home: string) {
  const names = await fs.readdir(runsDir(home)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  // Sorted by file name, as the run list always has been, newest first.
  return names
    .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
    .sort()
    .reverse()
    .map((name) => name.slice(0, -5));
}

// Newest first, up to limit. A file that can't be read or parsed is skipped and named in skipped, so one
// damaged file can't hide the others.
export async function listRuns(home: string, limit = Infinity): Promise<{ runs: RunInfo[]; skipped: string[] }> {
  const runs: RunInfo[] = [];
  const skipped: string[] = [];
  for (const id of await runIds(home)) {
    if (runs.length >= limit) break;
    try {
      const run = JSON.parse(await fs.readFile(runFile(home, id), "utf8"));
      if (typeof run?.auditor !== "string" || typeof run.target !== "string") throw new Error("not a run");
      const stats = run.result?.stats;
      runs.push({
        id,
        auditor: run.auditor,
        target: run.target,
        label: run.result?.grade?.label,
        budget: run.budget,
        effort: run.effort,
        entropyTool: run.entropyTool,
        costUsd: stats?.costUsd,
        seconds: stats?.seconds,
      });
    } catch {
      skipped.push(id);
    }
  }
  return { runs, skipped };
}

export async function readRun(home: string, id: string): Promise<SavedRun> {
  let text: string;
  try {
    text = await fs.readFile(runFile(home, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No saved run ${id}.`);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The file for run ${id} is damaged: it isn't valid JSON.`);
  }
}

// An exact id, or the start of exactly one, so people can type just the first few characters.
export async function findRunId(home: string, query: string): Promise<string> {
  const ids = await runIds(home);
  if (ids.includes(query)) return query;
  const matches = ids.filter((id) => id.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No saved run matches "${query}".`);
  throw new Error(`"${query}" matches ${matches.length} runs. Type more of the id: ${matches.slice(0, 3).join(", ")}${matches.length > 3 ? ", ..." : ""}`);
}
