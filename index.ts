/**
 * Overseer as a library, for running audits, checks and semantic-entropy scans from your own code, such as a
 * training loop.
 *
 * ```ts
 * import { runAudit, runCheck, scanEntropy, entropy, divergence, divergenceP, GOALS } from "@adamsaou/overseer";
 * ```
 *
 * The auditor, the clustering and the grader run on Claude, so these need an Anthropic API key in
 * ANTHROPIC_API_KEY. A target can be a Claude model ("haiku", "sonnet" or "opus") or any model behind an
 * Anthropic Messages-compatible endpoint, given as { baseUrl, model, apiKey }; the Anthropic key is never
 * sent there.
 *
 * @experimental New in 0.x: names and signatures may change in any minor release until 1.0.
 * @packageDocumentation
 */

export { runAudit, runCheck } from "./lib/auditor.ts";
export type { AuditEvent, AuditOptions, AuditResult, AuditStats, CheckOptions, CheckResult, Hypothesis, Verdict } from "./lib/auditor.ts";
export type { CustomModel, ModelIdentity } from "./lib/endpoint.ts";
export { ClusteringError, divergence, divergenceP, entropy, minP, scanEntropy } from "./lib/entropy.ts";
export type { Cluster, EntropyScan } from "./lib/entropy.ts";
export { GOALS } from "./lib/goals.ts";
export type { Goal } from "./lib/goals.ts";
export type { Grade, GradeLabel } from "./lib/grader.ts";
export type { Effort, ModelKey, Usage } from "./lib/models.ts";
