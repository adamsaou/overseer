// Model registry, refusal-fallback params, and approximate cost accounting.

export const MODELS = {
  haiku: { id: "claude-haiku-5-5", label: "Haiku 5.5", fallback: false, price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", fallback: true, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  opus: { id: "claude-opus-5-5", label: "Opus 5.5", fallback: true, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
};

export type ModelKey = keyof typeof MODELS;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function isModelKey(value: unknown): value is ModelKey {
  return typeof value === "string" && Object.hasOwn(MODELS, value);
}

// Opus 5.5 and Sonnet 5.5 retry classifier refusals server-side with fallbacks: "default".
// Haiku 5.5 has no server-side fallback, so it gets no extra params.
export function fallbackParams(key: ModelKey) {
  return MODELS[key].fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(
  total: Usage,
  usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
) {
  total.input += usage.input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
}

// Approximate list-price cost in USD; cache writes are priced at the 5-minute TTL.
export function costOf(key: ModelKey, usage: Usage) {
  const p = MODELS[key].price;
  return (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite) / 1e6;
}
