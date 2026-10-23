import Anthropic from "@anthropic-ai/sdk";

let instance: Anthropic | undefined;
let apiKey: string | undefined;

// The SDK logs with console by default, and its info and debug levels (ANTHROPIC_LOG) go to stdout, which
// carries the MCP protocol and overseer audit --json. Every level goes to stderr instead.
const logger = { error: console.error, warn: console.error, info: console.error, debug: console.error };

// Created on first use so the server can start, and explain what's missing, without credentials.
export function anthropic(): Anthropic {
  instance ??= new Anthropic({ apiKey, maxRetries: 4, logger });
  return instance;
}

// A key read from config.json. Without one, the SDK reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN itself.
export function setApiKey(key: string | undefined) {
  if (key === apiKey) return;
  apiKey = key;
  instance = undefined;
}

// Errors that no retry or fresh thread can fix (a cancelled audit, a rejected key, a model this key can't
// use), so an audit stops instead of carrying on without its target.
export function isFatal(err: unknown) {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError
  );
}

// A one-line explanation for people, logs and the auditor's tool results.
export function describeError(err: unknown): string {
  let text: string;
  if (err instanceof Anthropic.AuthenticationError) text = "The API key was rejected (401). Check ANTHROPIC_API_KEY or the key in config.json.";
  else if (err instanceof Anthropic.RateLimitError) text = "Rate limited by the API (429). Wait a moment and try again.";
  else if (err instanceof Anthropic.APIConnectionTimeoutError) text = "The request to the Anthropic API timed out.";
  else if (err instanceof Anthropic.APIUserAbortError) text = "The request was cancelled.";
  else if (err instanceof Anthropic.APIConnectionError) text = "Couldn't reach the Anthropic API. Check the network connection.";
  else if (err instanceof Anthropic.APIError) text = apiErrorText(err);
  else text = (err instanceof Error ? err.message : String(err)) || "Unknown error.";
  return redact(text);
}

// The SDK's message is the whole error body as JSON; the API's own sentence is inside it.
function apiErrorText(err: InstanceType<typeof Anthropic.APIError>) {
  const detail = (err.error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof detail === "string" && err.status ? `API error ${err.status}: ${detail}` : `API error ${err.message}`;
}

// Error text can quote what was sent, so strip anything shaped like a key, and the key itself, before it
// reaches a log, a tool result or the browser.
export function redact(text: string): string {
  let out = text.replace(/sk-ant-[\w-]+/g, "sk-ant-[redacted]");
  for (const secret of [apiKey, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN]) {
    const value = secret?.trim();
    if (value && value.length >= 8) out = out.replaceAll(value, "[redacted]");
  }
  return out;
}
