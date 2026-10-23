import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { ModelIdentity } from "./endpoint.ts";
import { scanEntropy, type Cluster, type EntropyScan } from "./entropy.ts";
import { costOf, emptyUsage } from "./models.ts";
import { Target, modelIdentity, type TargetModel } from "./target.ts";

// overseer scan, the batch semantic-entropy monitor. Each probe's question goes n times to the target and n
// times to the reference, each time in a fresh conversation, and Opus clusters all the answers by meaning on
// the probe's aspect, as an audit's entropy scan does. Scanning every checkpoint of a training run with the
// same probes and a tag such as step=1200 gives one line per probe and checkpoint: a series to watch.

export type Probe = { question: string; aspect: string; id?: string };
// A deployment: its model, its system prompt ("" for none) and, when it was given one, the objective.
export type Side = { model: TargetModel; system: string; objective?: string };
// system is a short hash of the system prompt, so lines say which deployment they measured without
// carrying the prompt.
export type SideIdentity = ModelIdentity & { system: string | null; objective?: string };

export type ScanLine = {
  question: string;
  aspect: string;
  id?: string;
  n: number;
  target: SideIdentity;
  reference: SideIdentity;
  targetEntropy: number;
  referenceEntropy: number;
  divergence: number;
  clusters: Cluster[];
  tags: Record<string, string>;
  createdAt: string;
  costUsd: number;
};

export type ProbeOutcome = { scan: EntropyScan; costUsd: number } | { error: unknown; costUsd: number };

const MAX_PROBES = 5000;
const usage = (message: string) => Object.assign(new Error(message), { code: "USAGE" });

// One probe per line: question | aspect, split at the last |, or a JSON object with question, aspect and an
// optional id. Blank lines and lines starting with # are skipped.
export async function readProbes(file: string): Promise<Probe[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw usage(`--questions: couldn't read ${file}${errno === "ENOENT" ? ": no such file" : errno === "EISDIR" ? ": it's a folder" : ""}.`);
  }
  const probes: Probe[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const where = `${file} line ${i + 1}`;
    let question: unknown;
    let aspect: unknown;
    let id: unknown;
    if (line.startsWith("{")) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line);
      } catch {
        throw usage(`${where} starts like JSON but isn't valid JSON.`);
      }
      ({ question, aspect, id } = row ?? {});
      if (typeof question !== "string" || typeof aspect !== "string") throw usage(`${where} needs "question" and "aspect", both as text.`);
    } else {
      const bar = line.lastIndexOf("|");
      if (bar < 0) throw usage(`${where} has no aspect. Write it as question | aspect, or as JSON with question and aspect.`);
      question = line.slice(0, bar);
      aspect = line.slice(bar + 1);
    }
    const q = String(question).trim();
    const a = String(aspect).trim();
    if (!q || !a) throw usage(`${where} needs both a question and an aspect.`);
    if (q.length > 4000 || a.length > 300) throw usage(`${where} is too long: a question takes up to 4000 characters and an aspect up to 300.`);
    probes.push({ question: q, aspect: a, ...(typeof id === "string" || typeof id === "number" ? { id: String(id) } : {}) });
  }
  if (!probes.length) throw usage(`${file} has no questions. Write one per line as question | aspect, or as JSON with question and aspect.`);
  if (probes.length > MAX_PROBES) throw usage(`${file} has ${probes.length} questions; a scan takes up to ${MAX_PROBES}. Split it into several files.`);
  return probes;
}

export function sideIdentity(side: Side): SideIdentity {
  const system = side.system ? `sha256:${createHash("sha256").update(side.system).digest("hex").slice(0, 16)}` : null;
  return { ...modelIdentity(side.model), system, ...(side.objective ? { objective: side.objective } : {}) };
}

// The answers all come back before anything is reported, so the cost counts every call made, even for a
// probe that failed. When one side is a custom endpoint and the other a Claude model, the endpoint answers
// first and the Claude model is asked only once it has, so a question the endpoint fails costs nothing on
// the Anthropic side.
export async function scanProbe(probe: Probe, n: number, target: Side, reference: Side, signal?: AbortSignal): Promise<ProbeOutcome> {
  const deployed = Target.withSystem(target.model, target.system, "low", signal);
  const clean = Target.withSystem(reference.model, reference.system, "low", signal);
  const clustering = emptyUsage();
  const cost = () => Number((deployed.costUsd() + clean.costUsd() + costOf("opus", clustering)).toFixed(6));
  const threads = Array.from({ length: n }, (_, i) => `scan.${i + 1}`);
  const ask = (side: Target) => Promise.allSettled(threads.map((thread) => side.send(thread, probe.question)));
  const failure = (settled: PromiseSettledResult<string>[]) => settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  const custom = (side: Target) => typeof side.model !== "string";
  let targetAnswers: PromiseSettledResult<string>[];
  let referenceAnswers: PromiseSettledResult<string>[];
  if (custom(deployed) === custom(clean)) [targetAnswers, referenceAnswers] = await Promise.all([ask(deployed), ask(clean)]);
  else if (custom(deployed)) {
    targetAnswers = await ask(deployed);
    referenceAnswers = failure(targetAnswers) ? [] : await ask(clean);
  } else {
    referenceAnswers = await ask(clean);
    targetAnswers = failure(referenceAnswers) ? [] : await ask(deployed);
  }
  const failed = failure([...targetAnswers, ...referenceAnswers]);
  if (failed) return { error: failed.reason, costUsd: cost() };
  const texts = (settled: PromiseSettledResult<string>[]) => settled.map((s) => (s.status === "fulfilled" ? s.value : ""));
  try {
    const scan = await scanEntropy(probe.question, probe.aspect, texts(targetAnswers), texts(referenceAnswers), clustering, signal);
    return { scan, costUsd: cost() };
  } catch (err) {
    return { error: err, costUsd: cost() };
  }
}

export function scanLine(probe: Probe, scan: EntropyScan, target: Side, reference: Side, tags: Record<string, string>, costUsd: number): ScanLine {
  return {
    question: probe.question,
    aspect: probe.aspect,
    ...(probe.id !== undefined ? { id: probe.id } : {}),
    n: scan.n,
    target: sideIdentity(target),
    reference: sideIdentity(reference),
    targetEntropy: scan.targetEntropy,
    referenceEntropy: scan.referenceEntropy,
    divergence: scan.divergence,
    clusters: scan.clusters,
    tags,
    createdAt: new Date().toISOString(),
    costUsd,
  };
}
