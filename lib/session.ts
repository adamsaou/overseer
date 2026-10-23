import type { Hypothesis, Verdict } from "./auditor.ts";
import { describeError } from "./client.ts";
import { formatScan, scanEntropy } from "./entropy.ts";
import { grade, type Grade } from "./grader.ts";
import type { LiveLog } from "./live.ts";
import { costOf, emptyUsage, type ModelKey } from "./models.ts";
import { newRunId, saveRun } from "./store.ts";
import { Target } from "./target.ts";

// An audit driven from outside (Claude Code, through the MCP server) instead of runAudit's own loop.
// Target, reference, budget and grading work the same way, and events are recorded in the replay
// format, so a Claude Code audit replays like any other run. With a live log, every event is also written
// to it as it happens, so the audit can be reported on while it runs.

export type Outcome = {
  grade: Grade;
  objective: string;
  runId: string;
  stats: { turns: number; targetMessages: number; scans: number; seconds: number; costUsd: number; fallbackUsed: boolean };
};

const clamp01 = (value: unknown) => Math.min(1, Math.max(0, Number(value) || 0));

export class AuditSession {
  id: string;
  target: ModelKey;
  objective: string;
  budget: number;
  home: string;
  used = 0;
  calls = 0;
  probes = 0;
  samples = 0;
  scanBatches = 0;
  scans = 0;
  board: Hypothesis[] = [];
  verdict: Verdict | null = null;
  // Set when the verdict was graded but the run couldn't be saved: the one way a verdict ends an audit
  // without a run to replay.
  saveError: string | null = null;
  started = Date.now();
  events: Record<string, unknown>[] = [];
  scanUsage = emptyUsage();
  model: Target;
  reference: Target | null;
  live: LiveLog | null;
  #grading = false;
  #stopped: string | null = null;

  constructor(target: ModelKey, objective: string, budget: number, scans: boolean, home: string, live: LiveLog | null = null) {
    this.target = target;
    this.objective = objective;
    this.budget = budget;
    this.home = home;
    this.live = live;
    if (live) this.started = live.started;
    this.id = live?.id ?? newRunId("claude-code", target, this.started);
    this.model = new Target(target, objective, "low");
    this.reference = scans ? new Target(target, null, "low") : null;
    this.emit({ type: "start", auditor: "claude-code", target, budget, effort: "n/a", entropyTool: scans });
    this.emit({ type: "budget", used: 0, budget });
  }

  emit(event: Record<string, unknown>) {
    const entry = { ...event, t: Date.now() - this.started };
    this.events.push(entry);
    this.live?.write(entry);
  }

  // The server can't see Claude Code's reasoning; the one-line note sent with each call fills the
  // replay's reasoning panel instead.
  note(text: string | undefined) {
    const line = text?.trim();
    if (!line) return;
    this.emit({ type: "note_start", kind: "text" });
    this.emit({ type: "note_delta", text: line });
    this.emit({ type: "note_end" });
  }

  left() {
    return this.budget - this.used;
  }

  get grading() {
    return this.#grading;
  }

  #open() {
    if (this.verdict) {
      const after = this.saveError ? "It was graded, but its run couldn't be saved." : "overseer_get_run shows its grade and replay link.";
      throw new Error(`Audit ${this.id} is already over. ${after} overseer_begin_audit starts a new one.`);
    }
    if (this.#stopped) throw new Error(`Audit ${this.id} was stopped before its verdict, so it wasn't graded. overseer_begin_audit starts a new one.`);
    if (this.#grading) throw new Error(`Audit ${this.id}'s verdict is being graded. Wait for final_verdict's result.`);
  }

  #spend(n: number) {
    this.#open();
    if (this.left() < n) throw new Error(`Not enough budget: ${this.left()} of ${this.budget} target messages left. Call final_verdict.`);
    this.used += n;
    this.calls++;
    this.emit({ type: "budget", used: this.used, budget: this.budget });
  }

  // Calls the target never answered aren't charged.
  #refund(n: number) {
    this.used -= n;
    this.emit({ type: "budget", used: this.used, budget: this.budget });
  }

  #budgetNote() {
    return `[${this.left()} of ${this.budget} target messages left]`;
  }

  async #probe(thread: string, message: string) {
    const id = `p${++this.probes}`;
    this.emit({ type: "probe", id, thread, message });
    try {
      const text = await this.model.send(thread, message);
      this.emit({ type: "reply", id, thread, text });
      return text;
    } catch (err) {
      this.emit({ type: "reply", id, thread, text: `[No reply: ${describeError(err)}]`, failed: true });
      throw err;
    }
  }

  async send(thread: string, message: string, note?: string) {
    this.#spend(1);
    this.note(note);
    const name = thread.trim().slice(0, 40) || "main";
    try {
      const reply = await this.#probe(name, message);
      return `Reply in thread "${name}":\n${reply}\n\n${this.#budgetNote()}`;
    } catch (err) {
      this.#refund(1);
      throw new Error(`The target didn't reply: ${describeError(err)} This message wasn't charged; you can send it again.`);
    }
  }

  async sample(message: string, n: number, note?: string) {
    this.#spend(n);
    this.note(note);
    const batch = ++this.samples;
    const threads = Array.from({ length: n }, (_, i) => `sample${batch}.${i + 1}`);
    const settled = await Promise.allSettled(threads.map((thread) => this.#probe(thread, message)));
    const failed = settled.filter((s) => s.status === "rejected").length;
    if (failed) this.#refund(failed);
    if (failed === n) throw new Error(`None of the ${n} conversations got a reply: ${describeError((settled[0] as PromiseRejectedResult).reason)} They weren't charged.`);
    const body = settled
      .map((s, i) => `#${i + 1} (thread "${threads[i]}"):\n${s.status === "fulfilled" ? s.value : `[No reply: ${describeError(s.reason)}]`}`)
      .join("\n\n---\n\n");
    const charged = failed ? `${failed} of ${n} conversations got no reply and weren't charged.\n` : "";
    return `${body}\n\n${charged}${this.#budgetNote()}`;
  }

  async entropyScan(question: string, aspect: string, n: number, note?: string) {
    const reference = this.reference;
    if (!reference) throw new Error("Entropy scans are off for this audit.");
    this.#spend(n);
    this.note(note);
    const batch = ++this.scanBatches;
    const id = `scan${batch}`;
    this.emit({ type: "scan", id, question, aspect, n });
    const threads = Array.from({ length: n }, (_, i) => `scan${batch}.${i + 1}`);
    try {
      const [targetAnswers, referenceAnswers] = await Promise.all([
        Promise.allSettled(threads.map((thread) => this.#probe(thread, question))),
        Promise.allSettled(threads.map((thread) => reference.send(thread, question))),
      ]);
      const missing = [...targetAnswers, ...referenceAnswers].find((s) => s.status === "rejected");
      if (missing) throw missing.reason;
      const answers = (settled: PromiseSettledResult<string>[]) => settled.map((s) => (s.status === "fulfilled" ? s.value : ""));
      const scan = await scanEntropy(question, aspect, answers(targetAnswers), answers(referenceAnswers), this.scanUsage);
      this.scans++;
      this.emit({ type: "scan_result", id, scan });
      return `${formatScan(scan, threads)}\n\n${this.#budgetNote()}`;
    } catch (err) {
      this.#refund(n);
      this.emit({ type: "scan_error", id, message: describeError(err) });
      throw new Error(`The scan failed: ${describeError(err)} It wasn't charged.`);
    }
  }

  updateBoard(hypotheses: { text: string; confidence: number }[]) {
    this.#open();
    this.board = hypotheses
      .map((h) => ({ text: h.text.trim(), confidence: clamp01(h.confidence) }))
      .filter((h) => h.text)
      .slice(0, 4);
    this.emit({ type: "board", hypotheses: this.board });
    return "Board updated.";
  }

  async finish(objective: string, confidence: number, evidence: string[]): Promise<Outcome> {
    this.#open();
    const verdict: Verdict = { objective: objective.trim(), confidence: clamp01(confidence), evidence: evidence.slice(0, 4), forced: false };
    // Claimed before grading, so a second call can't grade the audit again, and closed only after it, so a
    // failed grading call can simply be retried. A grader that declines or answers unreadably closes it as
    // ungraded.
    this.#grading = true;
    let result: Grade;
    try {
      result = await grade(this.objective, verdict.objective);
    } finally {
      this.#grading = false;
    }
    this.#open();
    this.verdict = verdict;
    // An auditor that never updated the board still leaves its answer on it, for the replay.
    if (!this.board.length) {
      this.board = [{ text: verdict.objective, confidence: verdict.confidence }];
      this.emit({ type: "board", hypotheses: this.board });
    }
    this.emit({ type: "verdict", verdict });
    this.emit({ type: "grade", grade: result, objective: this.objective });

    const cost =
      costOf(this.target, this.model.usage) +
      (this.reference ? costOf(this.target, this.reference.usage) : 0) +
      costOf("opus", this.scanUsage) +
      costOf("opus", result.usage);
    const stats = {
      turns: this.calls,
      targetMessages: this.used,
      scans: this.scans,
      seconds: Math.round((Date.now() - this.started) / 1000),
      costUsd: Number(cost.toFixed(4)),
      fallbackUsed: false,
    };
    this.emit({ type: "done", stats });

    let runId: string;
    try {
      runId = await saveRun(this.home, {
        id: this.id,
        objective: this.objective,
        target: this.target,
        auditor: "claude-code",
        budget: this.budget,
        effort: "n/a",
        entropyTool: Boolean(this.reference),
        result: { verdict, grade: result, board: this.board, stats },
        events: this.events,
      });
    } catch (err) {
      this.saveError = `The audit was graded but couldn't be saved: ${describeError(err)}`;
      this.live?.end("failed", [{ type: "error", message: this.saveError }]);
      throw err;
    }
    // The saved run now holds every event, so the live log has done its job.
    this.live?.end("done", [{ type: "saved", id: runId }]);
    this.live?.remove();
    return { grade: result, objective: this.objective, runId, stats };
  }

  // For an audit that will never get its verdict, because it was stopped or the Claude Code session ended:
  // it takes no more calls, and its live log ends with why.
  abandon(message: string) {
    if (this.verdict || this.#stopped) return;
    this.#stopped = message;
    if (this.live?.open) this.live.end("failed", [{ type: "error", message }]);
  }
}
