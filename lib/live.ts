import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describeError } from "./client.ts";
import { liveDir, runsDir } from "./paths.ts";
import { newRunId } from "./store.ts";

// The event log of an audit started through the MCP server, written as each event happens: one JSON event
// per line in <home>/live/<id>.jsonl. The web UI follows it with GET /api/live/<id>, from this process or
// another one. The first line describes the run and the last one says how it ended. The log of a saved
// run is removed, since runs/<id>.json then holds the same events; a failed run's log is kept as its
// only record.

export type LiveInfo = { auditor: string; target: string; budget: number; effort: string; entropyTool: boolean; sealed: boolean };
export type LiveHeader = LiveInfo & { type: "live"; id: string; started: number; pid: number; start?: string };
export type LiveStatus = "done" | "failed";
// last is when the log's latest event happened.
export type LiveRun = { header: LiveHeader; events: Record<string, unknown>[]; end: LiveStatus | null; last: number };

const ID = /^[\w-]+$/;

export function liveFile(home: string, id: string) {
  if (!ID.test(id)) throw new Error(`"${id}" isn't a run id.`);
  return path.join(liveDir(home), `${id}.jsonl`);
}

// Writes are synchronous: events then reach the file in order, and the log can still be closed off from a
// signal handler in the moment before the process exits.
export class LiveLog {
  readonly id: string;
  readonly started: number;
  readonly file: string;
  #fd: number | null;

  constructor(home: string, info: LiveInfo) {
    fs.mkdirSync(liveDir(home), { recursive: true, mode: 0o700 });
    this.started = Date.now();
    const { id, fd } = claim(home, info, this.started);
    this.id = id;
    this.file = liveFile(home, id);
    this.#fd = fd;
    this.write({ type: "live", id, ...info, started: this.started, pid: process.pid, start: processStart(process.pid) });
  }

  get open() {
    return this.#fd !== null;
  }

  // A log that can't be written to (a full disk) stops, rather than taking the audit down with it.
  write(event: object) {
    if (this.#fd === null) return;
    try {
      fs.writeSync(this.#fd, `${JSON.stringify(event)}\n`);
    } catch (err) {
      console.error(`Overseer: stopped writing ${this.file}: ${describeError(err)}`);
      this.#close();
    }
  }

  end(status: LiveStatus, last: object[] = []) {
    for (const event of last) this.write(event);
    this.write({ type: "end", status });
    this.#close();
  }

  remove() {
    this.#close();
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      // A log that stays behind ends with its saved event, so readers still find the saved run.
      console.error(`Overseer: couldn't remove ${this.file}: ${describeError(err)}`);
    }
  }

  #close() {
    if (this.#fd === null) return;
    const fd = this.#fd;
    this.#fd = null;
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone: nothing more will be written either way.
    }
  }
}

// The id names the saved run as well, so it mustn't belong to a saved run or to another live one. Creating
// the log with O_EXCL claims it.
function claim(home: string, info: LiveInfo, started: number) {
  for (let attempt = 0; ; attempt++) {
    const id = newRunId(info.auditor, info.target, started);
    try {
      if (fs.existsSync(path.join(runsDir(home), `${id}.json`))) throw Object.assign(new Error(`Run ${id} already exists.`), { code: "EEXIST" });
      return { id, fd: fs.openSync(liveFile(home, id), "wx", 0o600) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 5) throw err;
    }
  }
}

// Null when there's no such log. A line that isn't JSON, such as one cut off by a crash, is skipped.
export async function readLive(home: string, id: string): Promise<LiveRun | null> {
  let text: string;
  try {
    text = await fsp.readFile(liveFile(home, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let header: LiveHeader | null = null;
  let end: LiveStatus | null = null;
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "live") header = event as LiveHeader;
    else if (event?.type === "end") end = event.status === "done" ? "done" : "failed";
    else if (event && typeof event === "object") events.push(event);
  }
  if (!header) return null;
  const last = header.started + events.reduce((latest: number, e) => (typeof e.t === "number" && e.t > latest ? e.t : latest), 0);
  return { header, events, end, last };
}

// Newest first, like the saved runs.
export async function liveIds(home: string): Promise<string[]> {
  const names = await fsp.readdir(liveDir(home)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  return names
    .filter((name) => name.endsWith(".jsonl") && ID.test(name.slice(0, -6)))
    .map((name) => name.slice(0, -6))
    .sort()
    .reverse();
}

// When a process started, in clock ticks since boot, from /proc on Linux; undefined elsewhere. A process
// with the same pid but another start time is a newer one that reused the number, as after a reboot.
export function processStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name in parentheses can hold spaces, so fields are counted from after it: starttime is field 22.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
  } catch {
    return undefined;
  }
}

// Whether the process that writes a log, or holds a lock, is still running, so one left behind by a crash
// isn't taken for work in progress. start is the processStart it recorded, when it could.
export function ownerAlive(pid: unknown, start?: unknown) {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const now = typeof start === "string" ? processStart(pid as number) : undefined;
  return now === undefined || now === start;
}

// A header without a start time, from a system without /proc, can't tell its writer from a newer process
// with the same pid, so a log that has had no event for this long is taken to have lost its writer.
const QUIET_LIMIT_MS = 6 * 3600 * 1000;

// Whether the process writing a log is still at it. last is when the log's latest event happened.
export function writerAlive(header: { pid?: unknown; start?: unknown }, last: number) {
  if (!ownerAlive(header.pid, header.start)) return false;
  return typeof header.start === "string" || Date.now() - last < QUIET_LIMIT_MS;
}
