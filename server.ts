import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { runAudit, type AuditEvent } from "./lib/auditor.ts";
import { GOALS } from "./lib/goals.ts";
import { EFFORTS, MODELS, MODEL_KEYS, isModelKey, type Effort } from "./lib/models.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, "runs");
const PORT = Number(process.env.PORT ?? 7878);
const HOST = process.env.HOST ?? "127.0.0.1";
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

await fs.mkdir(RUNS, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") return await sendFile(res, "public/index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/study") return await sendFile(res, "public/study.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, { models: MODEL_KEYS.map((key) => ({ key, label: MODELS[key].label })), goals: GOALS, apiKey: hasKey() });
    }
    if (req.method === "POST" && url.pathname === "/api/audit") return await audit(req, res);
    if (req.method === "GET" && url.pathname === "/api/runs") return await listRuns(res);
    const run = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
    if (req.method === "GET" && run) return await sendFile(res, `runs/${run[1]}.json`, "application/json");
    if (req.method === "GET" && url.pathname === "/api/study") return await sendFile(res, "results/summary.json", "application/json");
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: describe(err) });
    else res.end();
  }
});

async function audit(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = JSON.parse((await readBody(req)) || "{}");
  const objective = String(body.objective ?? "").trim().slice(0, 1500);
  if (!objective) return sendJson(res, 400, { error: "Write a hidden objective first." });
  if (!hasKey()) return sendJson(res, 400, { error: "No ANTHROPIC_API_KEY found. Add it to the .env file in the project folder, then restart the server." });
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
    const id = `${new Date(started).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${auditor}-vs-${target}`;
    await fs.writeFile(path.join(RUNS, `${id}.json`), JSON.stringify({ id, objective, target, auditor, budget, effort, entropyTool, result, events }));
    send({ type: "saved", id });
  } catch (err) {
    if (!controller.signal.aborted) emit({ type: "error", message: describe(err) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

async function listRuns(res: http.ServerResponse) {
  const files = (await fs.readdir(RUNS)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 50);
  const runs = await Promise.all(
    files.map(async (file) => {
      const run = JSON.parse(await fs.readFile(path.join(RUNS, file), "utf8"));
      return { id: run.id, auditor: run.auditor, target: run.target, label: run.result?.grade?.label };
    }),
  );
  sendJson(res, 200, runs);
}

async function sendFile(res: http.ServerResponse, relative: string, type: string) {
  try {
    const body = await fs.readFile(path.join(ROOT, relative));
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

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function describe(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "The API key is missing or was rejected. Put ANTHROPIC_API_KEY=... in .env and restart the server.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

server.listen(PORT, HOST, () => {
  console.log(`Overseer is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (!hasKey()) console.log("No ANTHROPIC_API_KEY found. Add it to .env, then restart.");
});
