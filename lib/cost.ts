import { MAX_ANSWER } from "./entropy.ts";
import { MODELS, type Effort, type ModelKey } from "./models.ts";

// Cost estimates, shown before a study or any batch of audits, from audits actually run in this repo
// (runs/*.json and results/study.jsonl, October 2026). Each matchup's measured spend per target message is
// charged for the whole budget: study audits used 93-99% of theirs, and the one Opus-vs-Sonnet run ($0.11)
// stopped after 8 of its 24 messages, so this errs high rather than low.

// Conversation-only audits, and audits that had the entropy tool but made no scan.
const MEASURED: { auditor: ModelKey; target: ModelKey; audits: number; usd: number; messages: number }[] = [
  { auditor: "haiku", target: "haiku", audits: 2, usd: 0.0168, messages: 19 },
  { auditor: "opus", target: "sonnet", audits: 1, usd: 0.1068, messages: 8 },
  { auditor: "haiku", target: "opus", audits: 4, usd: 1.1053, messages: 95 },
  { auditor: "opus", target: "opus", audits: 4, usd: 1.5793, messages: 89 },
];

// What one entropy scan adds: n answers from the reference model plus an Opus clustering call. Against Opus
// the study's scans came to $0.033-0.046 each; against Haiku about $0.012 (the Claude Code run). Sonnet
// isn't measured and is priced like Opus.
const SCAN_USD: Record<ModelKey, number> = { haiku: 0.02, sonnet: 0.04, opus: 0.04 };

// Scans per target message in the study's entropy condition: Haiku auditors made 5 in 94 messages, Opus 10
// in 91. Sonnet isn't measured and is priced like Opus, the keener scanner.
const SCANS_PER_MESSAGE: Record<ModelKey, number> = { haiku: 5 / 94, sonnet: 10 / 91, opus: 10 / 91 };

// Grading a verdict again, one Opus 5.5 call at low effort: the saved runs' gradings cost $0.0036-0.0043.
export const GRADE_USD = 0.005;

// Only low and medium auditor effort were measured. Higher effort means more thinking, so it's priced up.
const EFFORT_FACTOR: Record<Effort, number> = { low: 1, medium: 1, high: 1.5, xhigh: 2, max: 3 };

// target is "custom" for a model behind a custom endpoint, whose own cost isn't Overseer's to know. It's
// priced as Haiku, whose share of a measured audit is a fraction of a cent, so the estimate is the Anthropic
// side's: the auditor, the scans' clustering and the grading.
export type AuditPlan = { auditor: ModelKey; target: ModelKey | "custom"; budget: number; scans: boolean; effort?: Effort };
// measured is false when the matchup or the effort level has never been run, so the figure is a fill-in.
export type Estimate = { usd: number; measured: boolean };

const price = (key: ModelKey) => MODELS[key].price.output;

// A matchup that hasn't been run is priced like the cheapest measured one whose models cost at least as
// much in both seats. Opus vs Opus is measured, so there always is one.
function usdPerMessage(auditor: ModelKey, target: ModelKey) {
  const exact = MEASURED.find((m) => m.auditor === auditor && m.target === target);
  if (exact) return exact.usd / exact.messages;
  const dearer = MEASURED.filter((m) => price(m.auditor) >= price(auditor) && price(m.target) >= price(target));
  return Math.min(...dearer.map((m) => m.usd / m.messages));
}

export function estimateAudit({ auditor, target, budget, scans, effort = "medium" }: AuditPlan): Estimate {
  const priced = target === "custom" ? "haiku" : target;
  const perMessage = usdPerMessage(auditor, priced) + (scans ? SCANS_PER_MESSAGE[auditor] * SCAN_USD[priced] : 0);
  const factor = EFFORT_FACTOR[effort];
  const measured = factor === 1 && MEASURED.some((m) => m.auditor === auditor && m.target === target);
  return { usd: perMessage * budget * factor, measured };
}

// overseer scan, per question: n answers from the target, n from the reference, and one Opus clustering call
// that reads them all. A scan's models may have no system prompt to keep them short, so a Claude model's
// answers are priced at 800 output tokens, three times the audits' assistant's. The clustering reads each
// answer up to MAX_ANSWER characters (lib/entropy.ts), about 1,000 tokens, and is priced as if every answer
// were that long, since a custom endpoint's can run to its 4,000-token cap; the call itself, measured in
// audits at $0.011-0.02 for about ten short answers, is the base. Custom endpoints' own cost isn't Overseer's
// to know. The first scan measured, n 3 with Haiku answering both sides, cost $0.012 a question.
const ANSWER_USD: Record<ModelKey, number> = { haiku: 0.0005, sonnet: 0.0091, opus: 0.0182 };
const CLUSTER_USD = { base: 0.006, perAnswer: ((MAX_ANSWER / 4) * MODELS.opus.price.input) / 1e6 };

export type ScanPlan = { target: ModelKey | "custom"; reference: ModelKey | "custom"; n: number; questions: number };

export function estimateScan({ target, reference, n, questions }: ScanPlan): Estimate {
  const answers = (model: ModelKey | "custom") => (model === "custom" ? 0 : n * ANSWER_USD[model]);
  const clustering = CLUSTER_USD.base + 2 * n * CLUSTER_USD.perAnswer;
  return { usd: questions * (answers(target) + answers(reference) + clustering), measured: false };
}

export function estimateAudits(plans: AuditPlan[]): Estimate {
  const each = plans.map(estimateAudit);
  return { usd: each.reduce((sum, e) => sum + e.usd, 0), measured: each.every((e) => e.measured) };
}

export function formatUsd(usd: number) {
  return usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;
}
