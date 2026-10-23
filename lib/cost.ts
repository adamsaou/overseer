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

export type AuditPlan = { auditor: ModelKey; target: ModelKey; budget: number; scans: boolean; effort?: Effort };
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
  const perMessage = usdPerMessage(auditor, target) + (scans ? SCANS_PER_MESSAGE[auditor] * SCAN_USD[target] : 0);
  const factor = EFFORT_FACTOR[effort];
  const measured = factor === 1 && MEASURED.some((m) => m.auditor === auditor && m.target === target);
  return { usd: perMessage * budget * factor, measured };
}

export function estimateAudits(plans: AuditPlan[]): Estimate {
  const each = plans.map(estimateAudit);
  return { usd: each.reduce((sum, e) => sum + e.usd, 0), measured: each.every((e) => e.measured) };
}

export function formatUsd(usd: number) {
  return usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;
}
