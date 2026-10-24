import { readFileSync } from "node:fs";
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { configFile, dataHome } from "./paths.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";

let instance: Anthropic | undefined;
let instanceBase: string | undefined;
let apiKey: string | undefined;
let logLevel: ClientOptions["logLevel"];

// The SDK logs with console by default, and its info and debug levels (ANTHROPIC_LOG) go to stdout, which
// carries the MCP protocol and overseer audit --json. Every level goes to stderr instead.
const logger = { error: console.error, warn: console.error, info: console.error, debug: console.error };

// Created on first use so the server can start, and explain what's missing, without credentials. The
// address is passed in, never left to the SDK, which would take ANTHROPIC_BASE_URL or a profile's; see
// apiBase. A redirect is an error, so a gateway can't send the key on to somewhere else.
export function anthropic(): Anthropic {
  const base = apiBase();
  if (!instance || base !== instanceBase) {
    instance = new Anthropic({ apiKey, baseURL: base, maxRetries: 4, logger, logLevel, fetchOptions: { redirect: "error" } });
    instanceBase = base;
  }
  return instance;
}

// Refusals name what to change, and stop an audit like any error no retry can fix.
const refusal = (message: string) => Object.assign(new Error(message), { code: "UNSAFE_ENV", fatal: true });
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// An address in front of /v1/messages, as origin and path with no trailing slash, or null for anything else.
export function baseOf(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The gateway address the key may go to, normalized, or an error saying why it can't be one. */
export function checkGateway(text: string, where: string): string {
  const base = baseOf(text);
  if (!base) throw refusal(`${where} isn't the web address in front of /v1/messages, such as https://llm.example.com.`);
  const { protocol, hostname } = new URL(base);
  if (protocol === "http:" && !LOOPBACK.has(hostname)) {
    throw refusal(`${where} has to start with https://, so the key isn't sent in the clear. http:// is only for a gateway on this machine.`);
  }
  return base;
}

/**
 * "gateway" in config.json: an LLM gateway the user allows the key to go to instead of the Anthropic API,
 * as the address in front of /v1/messages. null when there's none, or config.json is missing or unreadable.
 */
export function savedGateway(home = dataHome()): string | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configFile(home), "utf8"))?.gateway;
  } catch {
    return null;
  }
  if (value === undefined || value === null || value === "") return null;
  return checkGateway(typeof value === "string" ? value : "", `"gateway" in ${configFile(home)}`);
}

/**
 * Where requests with the key go: the Anthropic API, or the gateway in config.json. ANTHROPIC_BASE_URL
 * can't choose on its own, because a repository's .claude/settings.json can set it for every process Claude
 * Code starts, this one included, and point the key at a server of its own. So one naming any other address
 * is refused, as is a process that doesn't check certificates.
 */
export function apiBase(home = dataHome()): string {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw refusal(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks, so anyone between you and the API could read your key, and Overseer won't send it. Unset it. For a proxy with its own certificate, give Node.js the certificate with NODE_EXTRA_CA_CERTS instead.",
    );
  }
  const gateway = savedGateway(home);
  const asked = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!asked) return gateway ?? ANTHROPIC_API;
  const base = baseOf(asked);
  if (base === ANTHROPIC_API || (base && base === gateway)) return base;
  const allowed = gateway ? `${ANTHROPIC_API} or your gateway, ${gateway}` : ANTHROPIC_API;
  throw refusal(
    `ANTHROPIC_BASE_URL is set to ${asked}, so your API key would go there, and Overseer only sends it to ${allowed}. A repository's .claude/settings.json can set ANTHROPIC_BASE_URL to collect keys, so unset it unless you set it yourself. If it's your gateway, allow it: run overseer doctor in a terminal, or put "gateway": "${base ?? asked}" in ${configFile(home)}.`,
  );
}

// At info and debug the SDK logs every request, the target's system prompt and its hidden objective
// included. The MCP server stays at warn whatever ANTHROPIC_LOG says, since Claude Code keeps its stderr
// in logs that the auditor could read while the objective is sealed.
export function capLogLevel() {
  logLevel = "warn";
  instance = undefined;
}

// A key read from config.json. Without one, the SDK reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN itself.
export function setApiKey(key: string | undefined) {
  if (key === apiKey) return;
  apiKey = key;
  instance = undefined;
}

// The Anthropic key as this process knows it: from the environment, or from config.json once useApiKey has
// read it. lib/endpoint.ts makes sure none of them goes to a custom endpoint.
export function anthropicKeys(): string[] {
  return [apiKey, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN].flatMap((key) => (key?.trim() ? [key.trim()] : []));
}

// Custom endpoints' keys, redacted from error text like the Anthropic key. Each is a known value, so it's
// redacted however short it is, from 4 characters up.
const secrets = new Set<string>();

export function addSecret(key: string) {
  if (key.trim().length >= 4) secrets.add(key.trim());
}

// Errors that no retry or fresh thread can fix (a cancelled audit, a rejected key, a model this key can't
// use, a custom endpoint that can't work), so an audit stops instead of carrying on without its target.
export function isFatal(err: unknown) {
  return (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    (err instanceof Error && (err as { fatal?: unknown }).fatal === true)
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
  // The floor of 8 keeps a placeholder Anthropic key, such as "test", from redacting ordinary words. Longest
  // first, so a short key that happens to be part of a longer one can't leave the rest of it showing.
  const values = [...anthropicKeys().filter((key) => key.length >= 8), ...secrets].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replaceAll(value, "[redacted]");
  return out;
}
