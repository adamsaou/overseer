import { setTimeout as sleep } from "node:timers/promises";
import { addSecret, anthropicKeys, redact } from "./client.ts";
import { savedApiKey } from "./config.ts";
import { emptyUsage, type Usage } from "./models.ts";
import { dataHome } from "./paths.ts";

// A model served behind any Anthropic Messages-compatible endpoint (a LiteLLM proxy, vLLM, a team's own
// gateway), as the target of an audit or a check, or either side of a scan. The auditor, the clustering and
// the grader stay on Claude through the Anthropic API.
//
// Requests go out with fetch, not the SDK, because the SDK adds credentials of its own: ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, a profile on disk, ANTHROPIC_CUSTOM_HEADERS. The Anthropic key never goes to a custom
// endpoint, and a request carries only what any Messages-compatible server accepts: model, max_tokens,
// system and messages, with no thinking, effort, betas, fallbacks or cache_control.

export type CustomModel = {
  /** The address in front of /v1/messages, such as http://localhost:8000. */
  baseUrl: string;
  /** The name the endpoint serves the model under. */
  model: string;
  /** The endpoint's own key, if it needs one, sent as x-api-key and as a bearer token. Never the Anthropic key. */
  apiKey?: string;
};
// How saved runs and scan lines name a model. A custom endpoint's path is there when its address has one,
// since two models on one gateway can differ by path alone. Never with a key.
export type ModelIdentity = { model: string; host?: string; path?: string };
export type Turn = { role: "user" | "assistant"; content: string };
export type Reply = { text: string; stopReason: string | null };
// What error messages call the settings: the option names for the library, the flags in the CLI.
export type SettingNames = { baseUrl: string; model: string; apiKey: string };

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 300_000;
const RETRIES = 3;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
// A wrong address, model or key fails every request the same way.
const FATAL_STATUS = new Set([401, 403, 404, 405]);
// An endpoint that went away, or that rejects every request, fails each one. After this many failed requests
// in a row, with none answered in between, an error is fatal: an audit stops instead of spending the
// auditor's turns on a target that can't answer, and a scan stops instead of trying every question.
const FAILURES_IN_A_ROW = 5;
const MAX_RESPONSE = 4 * 1024 * 1024;
const OPTIONS: SettingNames = { baseUrl: "baseUrl", model: "model", apiKey: "apiKey" };

// fatal means no retry or fresh conversation can fix it, so an audit stops instead of carrying on without its
// target (see isFatal in client.ts).
export class EndpointError extends Error {
  readonly fatal: boolean;
  readonly status: number | null;

  constructor(message: string, { fatal = false, status = null }: { fatal?: boolean; status?: number | null } = {}) {
    super(redact(message));
    this.name = "EndpointError";
    this.fatal = fatal;
    this.status = status;
  }
}

// The Anthropic key in every place Overseer reads one: the environment and config.json.
const anthropicSecrets = () => [...anthropicKeys(), savedApiKey(dataHome())].filter((key): key is string => Boolean(key));

// Values under 8 characters can't be a key, and looking for them would match ordinary words.
function keyIn(texts: string[]) {
  const keys = anthropicSecrets().filter((key) => key.length >= 8);
  return texts.some((text) => keys.some((key) => text.includes(key)));
}

/** Whether text holds the Anthropic API key, from the environment or config.json, which never goes to a custom endpoint. */
export function holdsAnthropicKey(text: string) {
  return keyIn([text]);
}

export class Endpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly host: string;
  // The address's path in front of /v1/messages, such as /team-a, or "" for none.
  readonly path: string;
  readonly #url: string;
  readonly #key: string | undefined;
  readonly #names: SettingNames;
  #ready: Promise<void> | null = null;
  #failures = 0;

  constructor({ baseUrl, model, apiKey }: CustomModel, names: SettingNames = OPTIONS) {
    this.#names = names;
    let url: URL;
    try {
      url = new URL(String(baseUrl ?? "").trim());
    } catch {
      throw new Error(`${names.baseUrl} isn't a web address: "${baseUrl}". Give the address in front of /v1/messages, such as http://localhost:4000.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${names.baseUrl} has to start with http:// or https://, not ${url.protocol}//.`);
    if (url.username || url.password) throw new Error(`${names.baseUrl} can't hold a user name or password. Pass the endpoint's key with ${names.apiKey} instead.`);
    if (url.search || url.hash) throw new Error(`${names.baseUrl} can't have a query string or a fragment: give the address in front of /v1/messages.`);
    if (holdsAnthropicKey(url.href)) throw new EndpointError(`${names.baseUrl} holds your Anthropic API key, which Overseer never sends to a custom endpoint.`, { fatal: true });
    // The address in front of /v1/messages, as for the Anthropic SDK and ANTHROPIC_BASE_URL. A pasted
    // endpoint address is cut back to it.
    this.path = url.pathname.replace(/\/+$/, "").replace(/\/v1(\/messages)?$/, "");
    this.baseUrl = `${url.origin}${this.path}`;
    this.#url = `${this.baseUrl}/v1/messages`;
    this.host = url.host;

    const name = typeof model === "string" ? model.trim() : "";
    if (!name) throw new Error(`${names.model} is required: the name the endpoint serves the model under.`);
    if (name.length > 200 || /[\x00-\x1f]/.test(name)) throw new Error(`${names.model} should be a model name on one line, at most 200 characters.`);
    if (holdsAnthropicKey(name)) throw new EndpointError(`${names.model} holds your Anthropic API key, which Overseer never sends to a custom endpoint.`, { fatal: true });
    this.model = name;

    const key = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
    if (key !== undefined) {
      if (/\s/.test(key) || key.length > 4096) throw new Error(`${names.apiKey} doesn't hold a usable key: it has spaces or line breaks in it.`);
      if (anthropicSecrets().includes(key)) {
        throw new EndpointError(`${names.apiKey} holds your Anthropic API key, which Overseer never sends to a custom endpoint. Give the endpoint a key of its own.`, { fatal: true });
      }
      addSecret(key);
    }
    this.#key = key;
  }

  // The host and the path, as error messages name the endpoint.
  get address() {
    return `${this.host}${this.path}`;
  }

  // model@host can't be mistaken for a Claude model's key.
  get name() {
    return `${this.model}@${this.address}`;
  }

  get identity(): ModelIdentity {
    return { model: this.model, host: this.host, ...(this.path ? { path: this.path } : {}) };
  }

  // So that an endpoint written out anywhere, as in a saved run, shows only what identifies it.
  toJSON(): ModelIdentity {
    return this.identity;
  }

  // For a system prompt deployed on this endpoint, before anything is spent on the Anthropic side. Every
  // request is checked again as it goes out.
  refuseKey(text: string, what = "The system prompt") {
    if (holdsAnthropicKey(text)) throw new EndpointError(`${what} holds your Anthropic API key, which Overseer never sends to a custom endpoint. Take the key out first.`, { fatal: true });
  }

  // One request before the first real one, with the same max_tokens, so that a wrong address, model or key,
  // a server that doesn't speak the Messages API, or a context too small for max_tokens is reported before
  // anything is spent on the Anthropic side. Made once.
  ready(signal?: AbortSignal): Promise<void> {
    this.#ready ??= this.create("", [{ role: "user", content: "Reply with OK." }], emptyUsage(), signal).then(
      () => undefined,
      (err) => {
        this.#ready = null;
        if (signal?.aborted || !(err instanceof EndpointError)) throw err;
        throw new EndpointError(err.message, { fatal: true, status: err.status });
      },
    );
    return this.#ready;
  }

  // One request. The caller keeps the conversation and passes all of it.
  async create(system: string, messages: Turn[], usage: Usage, signal?: AbortSignal): Promise<Reply> {
    const turns = messages.map(({ role, content }) => ({ role, content }));
    const body = JSON.stringify({ model: this.model, max_tokens: MAX_TOKENS, ...(system ? { system } : {}), messages: turns });
    // Whatever a caller checked before: a system prompt or a message that holds the Anthropic key would carry
    // it to this endpoint, so nothing is sent.
    if (keyIn([body, system, ...turns.map((turn) => turn.content)])) {
      throw new EndpointError(
        `Nothing was sent to the endpoint at ${this.address}: the request held your Anthropic API key, in the system prompt or a message, and Overseer never sends that key to a custom endpoint. Take the key out of the prompt.`,
        { fatal: true },
      );
    }
    try {
      const reply = await this.#exchange(body, usage, signal);
      this.#failures = 0;
      return reply;
    } catch (err) {
      if (signal?.aborted || !(err instanceof EndpointError) || err.fatal || ++this.#failures < FAILURES_IN_A_ROW) throw err;
      throw new EndpointError(`${err.message} That's ${this.#failures} failed requests in a row, so Overseer stopped.`, { fatal: true, status: err.status });
    }
  }

  async #exchange(body: string, usage: Usage, signal?: AbortSignal): Promise<Reply> {
    const res = await this.#post(body, signal);
    const where = `The endpoint at ${this.address}`;

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const to = res.headers.get("location");
      throw new EndpointError(`${where} redirected the request (HTTP ${res.status}${to ? ` to ${clip(to)}` : ""}). Use the address it redirects to as ${this.#names.baseUrl}.`, {
        fatal: true,
        status: res.status,
      });
    }
    const text = await readBody(res, where);
    const data = parseJson(text);
    if (!res.ok) {
      const detail = errorDetail(data) ?? clip(text);
      throw new EndpointError(`${where} answered HTTP ${res.status}${detail ? `: ${detail.replace(/[.\s]+$/, "")}` : ""}.${this.#hint(res.status)}`, {
        fatal: FATAL_STATUS.has(res.status),
        status: res.status,
      });
    }
    if (data === undefined) {
      const type = res.headers.get("content-type")?.split(";")[0].trim();
      throw new EndpointError(
        `${where} answered with something that isn't JSON${type ? ` (${type})` : ""}, so it isn't serving the Messages API there. Check ${this.#names.baseUrl}: it's the address in front of /v1/messages.`,
        { fatal: true, status: res.status },
      );
    }
    if (isObject(data) && data.type === "error") throw new EndpointError(`${where} answered with an error: ${errorDetail(data) ?? "it gave no details"}.`, { status: res.status });
    const content = isObject(data) ? data.content : undefined;
    if (!isObject(data) || !Array.isArray(content)) {
      throw new EndpointError(`${where} answered, but not in the Messages API's format: there's no content list. Check that ${this.#names.baseUrl} serves Anthropic's /v1/messages.`, {
        fatal: true,
        status: res.status,
      });
    }
    const reply = content.flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n").trim();
    const counts = isObject(data.usage) ? data.usage : {};
    usage.input += tokens(counts.input_tokens);
    usage.output += tokens(counts.output_tokens);
    return { text: reply, stopReason: typeof data.stop_reason === "string" ? data.stop_reason : null };
  }

  #hint(status: number) {
    if (status === 401 || status === 403) return this.#key ? ` Check the key in ${this.#names.apiKey}.` : ` If it needs a key, pass one with ${this.#names.apiKey}.`;
    if (status === 404 || status === 405) return ` Check ${this.#names.baseUrl}, the address in front of /v1/messages, and ${this.#names.model}.`;
    return "";
  }

  #headers() {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", "anthropic-version": "2023-06-01" };
    if (!this.#key) return headers;
    // Checked on every request as well, for an Anthropic key that was set or saved after this endpoint was made.
    if (anthropicSecrets().includes(this.#key)) {
      throw new EndpointError(`The key for ${this.address} is your Anthropic API key, which Overseer never sends to a custom endpoint.`, { fatal: true });
    }
    // Servers differ in which of the two they read, and both carry the endpoint's own key.
    headers["x-api-key"] = this.#key;
    headers.authorization = `Bearer ${this.#key}`;
    return headers;
  }

  // Retries what a retry can fix, as the SDK does for the Anthropic API: a dropped connection, a timeout,
  // rate limits and server errors. Redirects aren't followed, so the endpoint's key only goes to its host.
  async #post(body: string, signal?: AbortSignal): Promise<Response> {
    const headers = this.#headers();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        res = await fetch(this.#url, { method: "POST", headers, body, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < RETRIES) {
          await sleep(backoff(attempt), undefined, { signal });
          continue;
        }
        const why = (err as Error)?.name === "TimeoutError" ? `didn't answer within ${TIMEOUT_MS / 1000} seconds` : `couldn't be reached at ${this.#url} (${networkCause(err)})`;
        throw new EndpointError(`The endpoint at ${this.address} ${why}.`);
      }
      if (!RETRY_STATUS.has(res.status) || attempt >= RETRIES) return res;
      await res.body?.cancel();
      await sleep(retryAfter(res) ?? backoff(attempt), undefined, { signal });
    }
  }
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const tokens = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const clip = (text: string, n = 300) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The server's own sentence, from the error shapes Messages-compatible servers use: Anthropic's and OpenAI's
// { error: { message } }, vLLM's { message }, FastAPI's { detail }.
function errorDetail(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  const found = isObject(data.error) ? data.error.message : (data.error ?? data.message ?? data.detail);
  if (found === undefined || found === null || found === "") return undefined;
  return clip(typeof found === "string" ? found : JSON.stringify(found));
}

// Seconds or an HTTP date, kept to half a minute.
function retryAfter(res: Response) {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 30_000) : undefined;
}

function networkCause(err: unknown) {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const named: Record<string, string> = { ECONNREFUSED: "connection refused", ENOTFOUND: "no such host", ECONNRESET: "the connection was reset", EHOSTUNREACH: "host unreachable", ETIMEDOUT: "timed out" };
  if (named[code]) return named[code];
  const message = typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err);
  return clip(message, 160) || "network error";
}

async function readBody(res: Response, where: string) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE) {
      await reader.cancel();
      throw new EndpointError(`${where} answered with more than ${MAX_RESPONSE / 1024 / 1024} MB, which no reply needs.`, { fatal: true, status: res.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
