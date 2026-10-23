import { randomBytes, timingSafeEqual } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { runAudit, type AuditEvent } from "./lib/auditor.ts";
import { describeError } from "./lib/client.ts";
import { apiKeySource, loadDotEnv, missingKeyMessage, useApiKey } from "./lib/config.ts";
import { GOALS } from "./lib/goals.ts";
import { liveFile, writerAlive } from "./lib/live.ts";
import { EFFORTS, MODELS, MODEL_KEYS, isModelKey, type Effort } from "./lib/models.ts";
import { dataHome, homeId, isMain, publicDir, resultsDir } from "./lib/paths.ts";
import { listRuns, newRunId, runFile, saveRun } from "./lib/store.ts";

// The local web app: the live audit and replay page, the study page, and the API they use, including
// GET /api/live/<id>, which follows an audit that the MCP server is running, from its live log.

export type ServerOptions = {
  home: string;
  port?: number;
  host?: string;
  // Nothing is printed unless a logger is passed: the MCP server shares stdout with its protocol.
  log?: (message: string, level?: "info" | "warn") => void;
};

const MAX_BODY = 64 * 1024;
// How often a caught-up live stream looks for new events, and how long it waits before checking that the
// process writing the log is still there.
const LIVE_POLL_MS = 250;
const LIVE_QUIET_MS = 10000;

export async function startServer({ home, port = 7878, host = "127.0.0.1", log = () => {} }: ServerOptions) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`The port must be a number from 0 to 65535, not ${port}.`);
  const pages = publicDir();
  // A damaged config.json is reported once at startup; requests then just see no key.
  const hasKey = () => apiKeySource(home).then(Boolean, () => false);
  // Anyone who can reach a non-loopback address could start audits on the API key and read saved runs,
  // so other computers need a password, made fresh for every launch. Browsers ask for it once.
  const password = loopback(host) ? null : randomBytes(12).toString("base64url");

  const server = http.createServer(async (req, res) => {
    // Never inside a frame on another site, where a couple of lured clicks could start an audit.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // A DNS-rebinding page reaches this server under its own domain name. Overseer itself is opened as
    // localhost, by IP address or by the name it was told to listen on, so any other name is refused.
    if (!localName(req.headers.host, host)) return sendJson(res, 403, { error: "Open Overseer at localhost or by its IP address." });
    if (password && !loopback(req.socket.remoteAddress) && !authorized(req, password)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Overseer", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Overseer needs the password shown in the terminal where it was started.\n");
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return await sendFile(res, path.join(pages, "index.html"), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/study") return await sendFile(res, path.join(pages, "study.html"), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/config") {
        const apiKey = await hasKey();
        return sendJson(res, 200, {
          models: MODEL_KEYS.map((key) => ({ key, label: MODELS[key].label })),
          goals: GOALS,
          apiKey,
          ...(apiKey ? {} : { apiKeyHelp: missingKeyMessage(home) }),
          // Lets the MCP server reuse this server only when it shows the same data folder.
          homeId: homeId(home),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/audit") return await audit(req, res);
      if (req.method === "GET" && url.pathname === "/api/runs") {
        const { runs } = await listRuns(home, 50);
        return sendJson(res, 200, runs.map(({ id, auditor, target, label }) => ({ id, auditor, target, label })));
      }
      const run = url.pathname.match(/^\/api\/runs\/([\w-]{1,200})$/);
      if (req.method === "GET" && run) return await sendFile(res, runFile(home, run[1]), "application/json");
      const live = url.pathname.match(/^\/api\/live\/([\w-]{1,200})$/);
      if (req.method === "GET" && live) return await follow(res, live[1]);
      if (req.method === "GET" && url.pathname === "/api/study") return await sendFile(res, path.join(resultsDir(home), "summary.json"), "application/json");
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: describeError(err) });
      else res.end();
    }
  });

  async function audit(req: http.IncomingMessage, res: http.ServerResponse) {
    const refused = crossSite(req);
    if (refused) return sendJson(res, refused.status, { error: refused.error });
    if (Number(req.headers["content-length"]) > MAX_BODY) return sendJson(res, 413, { error: "The request is too large." });
    const text = await readBody(req, MAX_BODY);
    if (text === null) return sendJson(res, 413, { error: "The request is too large." });
    let body: Record<string, any>;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      return sendJson(res, 400, { error: "The request isn't valid JSON." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "The request should be a JSON object." });
    const objective = String(body.objective ?? "").trim().slice(0, 1500);
    if (!objective) return sendJson(res, 400, { error: "Write a hidden objective first." });
    if (!(await useApiKey(home).catch(() => null))) return sendJson(res, 400, { error: missingKeyMessage(home) });
    const target = isModelKey(body.target) ? body.target : "sonnet";
    const auditor = isModelKey(body.auditor) ? body.auditor : "opus";
    const budget = Math.min(60, Math.max(6, Math.round(Number(body.budget)) || 24));
    const effort: Effort = EFFORTS.includes(body.effort) ? body.effort : "medium";
    const entropyTool = body.entropy !== false;

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const started = Date.now();
    const events: (AuditEvent & { t: number })[] = [];
    const send = (data: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const emit = (event: AuditEvent) => {
      const entry = { ...event, t: Date.now() - started };
      events.push(entry);
      send(entry);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 15000);

    try {
      const result = await runAudit({ objective, target, auditor, budget, effort, targetEffort: "low", entropyTool, signal: controller.signal }, emit);
      const id = await saveRun(home, { id: newRunId(auditor, target, started), objective, target, auditor, budget, effort, entropyTool, result, events });
      send({ type: "saved", id });
    } catch (err) {
      if (!controller.signal.aborted) emit({ type: "error", message: describeError(err) });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  // Streams a live log as server-sent events, the same frames POST /api/audit sends, from its first line
  // until its end line. A log whose writer died without one ends with an error. Without a log the audit
  // isn't running, and the page falls back to its saved run.
  async function follow(res: http.ServerResponse, id: string) {
    let handle: FileHandle;
    try {
      handle = await fs.open(liveFile(home, id), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return sendJson(res, 404, { error: "No audit with that id is running." });
      throw err;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    let connected = true;
    res.on("close", () => (connected = false));
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 15000);
    const send = (line: string) => {
      if (!res.writableEnded) res.write(`data: ${line}\n\n`);
    };
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    let partial = "";
    let quiet = 0;
    let writer: { pid?: unknown; start?: unknown; started?: unknown } = {};
    let latest = 0;
    try {
      while (connected) {
        // Read through the open file, which stays readable when the log is removed after the run is saved.
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead) {
          position += bytesRead;
          quiet = 0;
          const lines = (partial + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            let event: { type?: unknown; pid?: unknown; start?: unknown; started?: unknown; t?: unknown };
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event?.type === "live") writer = event;
            else if (typeof event?.t === "number" && event.t > latest) latest = event.t;
            send(line);
            if (event?.type === "end") return;
          }
          continue;
        }
        if (quiet >= LIVE_QUIET_MS && !writerAlive(writer, (Number(writer.started) || 0) + latest)) {
          send(JSON.stringify({ type: "error", message: "The process running this audit stopped before the audit finished." }));
          send(JSON.stringify({ type: "end", status: "failed" }));
          return;
        }
        await sleep(LIVE_POLL_MS);
        quiet += LIVE_POLL_MS;
      }
    } finally {
      clearInterval(heartbeat);
      await handle.close();
      res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      reject(Object.assign(new Error(`Port ${port} on ${host} is already in use, perhaps by another Overseer. Stop it or choose another port.`), { code: err.code }));
    };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      resolve();
    });
  });
  server.on("error", (err) => log(`Server error: ${describeError(err)}`, "warn"));

  const address = server.address();
  const bound = address && typeof address === "object" ? address.port : port;
  const url = `http://${urlHost(host)}:${bound}`;
  log(`Overseer is running at ${url}`);
  if (password) {
    const everywhere = host === "0.0.0.0" || host === "::";
    const others = everywhere ? lanUrls(bound) : [url];
    log(
      `Warning: it's listening on ${everywhere ? "all network interfaces" : host}, so other computers can reach it${others.length ? ` at ${others.join(", ")}` : ""}. They need this password, new for every launch: ${password} (any user name). Anyone who has it can start audits on your API key and read your saved runs.`,
      "warn",
    );
  }
  try {
    if (!(await apiKeySource(home))) log(missingKeyMessage(home), "warn");
  } catch (err) {
    log(describeError(err), "warn");
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { url, port: bound, server, close };
}

export function urlHost(host: string) {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return isIP(host) === 6 ? `[${host}]` : host;
}

// A listening address, or a client's, that only this computer can use.
function loopback(address: string | undefined) {
  return address?.toLowerCase() === "localhost" || address === "::1" || /^(::ffff:)?127\./.test(address ?? "");
}

// Where other computers find a server that listens on all interfaces: this computer's IPv4 addresses.
function lanUrls(port: number) {
  const addresses = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []);
  return addresses.filter((a) => a.family === "IPv4" && !a.internal).map((a) => `http://${a.address}:${port}`);
}

// The Host header names localhost, an IP address or the name the server was told to listen on. Without
// one the request didn't come from a browser.
function localName(host: string | undefined, listening: string) {
  if (host === undefined) return true;
  try {
    const name = new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, "$1");
    return name === "localhost" || name === listening.toLowerCase() || isIP(name) !== 0;
  } catch {
    return false;
  }
}

// HTTP Basic credentials with this launch's password, under any user name.
function authorized(req: http.IncomingMessage, password: string) {
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;
  const given = Buffer.from(Buffer.from(encoded, "base64").toString("utf8").replace(/^[^:]*:/, ""));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Audits spend the user's API key, so other websites mustn't be able to start one. The page posts JSON:
// a cross-site form or text/plain fetch is refused here, a cross-site JSON fetch needs a CORS preflight
// this server never grants, and a browser's Origin must be this server itself.
function crossSite(req: http.IncomingMessage): { status: number; error: string } | null {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Send the audit request as application/json." };
  const origin = req.headers.origin;
  if (origin !== undefined && !localOrigin(origin, req.headers.host)) return { status: 403, error: "Audits can only be started from the Overseer page itself." };
  return null;
}

// The same host and port the request came to, which the Host check already limited to localhost and IP
// addresses.
function localOrigin(origin: string, host: string | undefined) {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host === host?.toLowerCase();
  } catch {
    return false;
  }
}

async function sendFile(res: http.ServerResponse, file: string, type: string) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return sendJson(res, 404, { error: "Not found" });
    throw err;
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Null when the body is larger than limit.
async function readBody(req: http.IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (isMain(import.meta)) {
  loadDotEnv();
  try {
    await startServer({
      home: dataHome(),
      port: Number(process.env.PORT || 7878),
      // Not HOST, which shells and containers often set for other servers.
      host: process.env.OVERSEER_HOST || "127.0.0.1",
      log: (message, level) => (level === "warn" ? console.error : console.log)(message),
    });
  } catch (err) {
    console.error(describeError(err));
    process.exit(1);
  }
}
