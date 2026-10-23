import type { AuditStats, Hypothesis, Verdict } from "./auditor.ts";
import type { ModelIdentity } from "./endpoint.ts";
import type { Cluster } from "./entropy.ts";
import { GOALS } from "./goals.ts";
import type { SavedRun } from "./store.ts";

// overseer runs export --all: each saved run as one record of an audit dataset, for training and evaluating
// auditors. A record holds the trajectory (what the auditor thought and did and what came back, in order),
// the transcript of every conversation with the target, the evidence board, the verdict, the revealed
// objective, the grade and a numeric reward. Everything comes from the run's saved events.

export const RECORD_FORMAT = "overseer.audit.v1";
const REWARD: Record<string, number> = { caught: 1, partial: 0.5, missed: 0 };

type Message = { role: "user" | "assistant"; text: string; t: number; failed?: true };
type Answer = { thread: string; text: string | null; failed?: true };
type ScanResult = { targetEntropy: number; referenceEntropy: number; divergence: number; clusters: Cluster[] };

// t is milliseconds since the audit started.
export type Step =
  | { t: number; type: "note"; kind: string; text: string }
  | { t: number; type: "message"; thread: string; message: string; reply: string | null; failed?: true }
  | { t: number; type: "sample"; message: string; replies: Answer[] }
  | { t: number; type: "scan"; question: string; aspect: string; n: number; answers: Answer[]; result: ScanResult | null; error?: string }
  | { t: number; type: "board"; hypotheses: Hypothesis[] }
  | { t: number; type: "verdict"; verdict: Verdict }
  | { t: number; type: "error"; message: string };

export type AuditRecord = {
  format: typeof RECORD_FORMAT;
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  auditor: string;
  effort: string;
  target: string;
  targetEndpoint?: ModelIdentity;
  budget: number;
  entropyTool: boolean;
  objective: string;
  preset: string | null;
  steps: Step[];
  transcript: { thread: string; messages: Message[] }[];
  notes: { t: number; kind: string; text: string }[];
  board: Hypothesis[];
  verdict: Verdict | null;
  grade: { label: string; rationale: string } | null;
  reward: number | null;
  stats: AuditStats | null;
  costUsd: number | null;
};

// Only the fields that name an endpoint, whatever else a saved run's copy holds.
function endpointOf({ model, host, path }: ModelIdentity): ModelIdentity {
  return { model, host, ...(typeof path === "string" && path ? { path } : {}) };
}

// Ids start with the UTC time the audit started, to the second.
function startOf(id: string) {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function auditRecord(run: SavedRun): AuditRecord {
  const events = (Array.isArray(run.events) ? run.events : []) as Record<string, any>[];
  const steps: Step[] = [];
  const notes: AuditRecord["notes"] = [];
  const threads = new Map<string, Message[]>();
  // Where a probe's reply goes, by the probe's id.
  const slots = new Map<string, { thread: string; fill: (text: string, failed: boolean) => void }>();
  const scans = new Map<string, Extract<Step, { type: "scan" }>>();
  const samples = new Set<string>();
  // sample and entropy_scan send their n messages in one go, as consecutive probes on threads named
  // sample<b>.1 to .n and scan<b>.1 to .n. A later probe on one of those threads, which always follows a
  // budget event, continues that conversation as a message of its own.
  let group: { prefix: string; next: number; answers: Answer[] } | null = null;
  let note: { t: number; kind: string; text: string } | null = null;
  let last = 0;

  const say = (thread: string, message: Message) => {
    if (!threads.has(thread)) threads.set(thread, []);
    threads.get(thread)!.push(message);
  };
  const add = (answers: Answer[], thread: string) => {
    const answer: Answer = { thread, text: null };
    answers.push(answer);
    return answer;
  };
  // The answer a sample's or a scan's probe fills in, or null for a message of its own.
  const grouped = (thread: string, message: string, t: number): Answer | null => {
    if (group && thread === `${group.prefix}${group.next}`) {
      group.next++;
      return add(group.answers, thread);
    }
    group = null;
    const batch = thread.match(/^(sample|scan)(\d+)\.1$/);
    if (!batch) return null;
    let answers: Answer[];
    if (batch[1] === "sample") {
      if (samples.has(batch[2])) return null;
      samples.add(batch[2]);
      const step: Extract<Step, { type: "sample" }> = { t, type: "sample", message, replies: [] };
      steps.push(step);
      answers = step.replies;
    } else {
      const scan = scans.get(`scan${batch[2]}`);
      if (!scan || scan.answers.length) return null;
      answers = scan.answers;
    }
    group = { prefix: `${batch[1]}${batch[2]}.`, next: 2, answers };
    return add(answers, thread);
  };

  for (const e of events) {
    const t = typeof e.t === "number" ? e.t : last;
    last = Math.max(last, t);
    if (e.type !== "probe") group = null;
    switch (e.type) {
      case "note_start":
        note = { t, kind: e.kind === "thinking" ? "thinking" : "text", text: "" };
        break;
      case "note_delta":
        if (note) note.text += String(e.text ?? "");
        break;
      case "note_end":
        if (note?.text.trim()) {
          const done = { t: note.t, kind: note.kind, text: note.text.trim() };
          notes.push(done);
          steps.push({ t: done.t, type: "note", kind: done.kind, text: done.text });
        }
        note = null;
        break;
      case "probe": {
        const thread = String(e.thread ?? "");
        const message = String(e.message ?? "");
        say(thread, { role: "user", text: message, t });
        const answer = grouped(thread, message, t);
        if (answer) {
          slots.set(String(e.id), { thread, fill: (text, failed) => Object.assign(answer, { text }, failed ? { failed: true as const } : {}) });
        } else {
          const step: Extract<Step, { type: "message" }> = { t, type: "message", thread, message, reply: null };
          steps.push(step);
          slots.set(String(e.id), { thread, fill: (text, failed) => Object.assign(step, { reply: text }, failed ? { failed: true as const } : {}) });
        }
        break;
      }
      case "reply": {
        const text = String(e.text ?? "");
        const slot = slots.get(String(e.id));
        slot?.fill(text, e.failed === true);
        say(slot?.thread ?? String(e.thread ?? ""), { role: "assistant", text, t, ...(e.failed === true ? { failed: true as const } : {}) });
        break;
      }
      case "scan": {
        const step: Extract<Step, { type: "scan" }> = { t, type: "scan", question: String(e.question ?? ""), aspect: String(e.aspect ?? ""), n: Number(e.n) || 0, answers: [], result: null };
        steps.push(step);
        scans.set(String(e.id), step);
        break;
      }
      case "scan_result": {
        const step = scans.get(String(e.id));
        const s = e.scan ?? {};
        if (step) step.result = { targetEntropy: s.targetEntropy, referenceEntropy: s.referenceEntropy, divergence: s.divergence, clusters: s.clusters ?? [] };
        break;
      }
      case "scan_error": {
        const step = scans.get(String(e.id));
        if (step) step.error = String(e.message ?? "");
        break;
      }
      case "board":
        steps.push({ t, type: "board", hypotheses: Array.isArray(e.hypotheses) ? e.hypotheses : [] });
        break;
      case "verdict":
        steps.push({ t, type: "verdict", verdict: e.verdict });
        break;
      case "error":
        steps.push({ t, type: "error", message: String(e.message ?? "") });
        break;
    }
  }

  const result = run.result;
  const label = result?.grade?.label;
  const started = startOf(run.id);
  return {
    format: RECORD_FORMAT,
    id: run.id,
    startedAt: started?.toISOString() ?? null,
    endedAt: started ? new Date(started.getTime() + last).toISOString() : null,
    auditor: run.auditor,
    effort: run.effort,
    target: run.target,
    ...(run.targetEndpoint ? { targetEndpoint: endpointOf(run.targetEndpoint) } : {}),
    budget: run.budget,
    entropyTool: run.entropyTool,
    objective: run.objective,
    preset: GOALS.find((g) => g.objective === run.objective)?.id ?? null,
    steps,
    transcript: [...threads].map(([thread, messages]) => ({ thread, messages })),
    notes,
    board: result?.board ?? [],
    verdict: result?.verdict ?? null,
    grade: label ? { label, rationale: result.grade.rationale } : null,
    reward: label && Object.hasOwn(REWARD, label) ? REWARD[label] : null,
    stats: result?.stats ?? null,
    costUsd: typeof result?.stats?.costUsd === "number" ? result.stats.costUsd : null,
  };
}
