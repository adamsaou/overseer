import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

// Serves dist/ the way Workers static assets do with this project's wrangler.jsonc: HTML handling
// "auto-trailing-slash", the 404 page for anything missing, _headers, ETags and edge-style
// compression, with /api/* run through worker.ts's fetch first. `npm run preview` builds, then runs this.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 8787;
const HOST = "127.0.0.1";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;

type File = { body: Buffer; type: string; etag: string; mtime: number; encoded: Map<string, Buffer> };
const files = new Map<string, File>();

// Files are read once and kept, with their compressed forms, until a rebuild changes them.
async function load(rel: string): Promise<File | null> {
  const full = path.join(DIST, rel);
  if (!full.startsWith(DIST + path.sep)) return null;
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) return null;
  const cached = files.get(rel);
  if (cached && cached.mtime === stat.mtimeMs) return cached;
  const body = await fs.readFile(full);
  const type = TYPES[path.extname(rel)] ?? "application/octet-stream";
  const file = { body, type, mtime: stat.mtimeMs, etag: `"${createHash("sha1").update(body).digest("hex").slice(0, 20)}"`, encoded: new Map() };
  files.set(rel, file);
  return file;
}

// _headers: a path pattern line, then indented "Name: value" lines.
const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
const headersFile = await fs.readFile(path.join(DIST, "_headers"), "utf8").catch(() => "");
for (const line of headersFile.split("\n")) {
  if (!line.trim()) continue;
  if (!/^\s/.test(line)) rules.push({ pattern: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`), headers: [] });
  else {
    const at = line.indexOf(":");
    rules.at(-1)?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
}

const exists = async (rel: string) => Boolean(await load(rel));
const redirect = (to: string) => new Response(null, { status: 307, headers: { Location: to } });

// One request against the assets, as a Response, the way the ASSETS binding answers it.
async function assets(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  const query = url.search;
  let rel: string | null = null;
  // Workers static assets read these files and never serve them.
  if (pathname === "/_headers" || pathname === "/_redirects") pathname = "/404-not-served";
  if (pathname.endsWith("/index.html")) return redirect(pathname.slice(0, -"index.html".length) + query);
  if (pathname.endsWith(".html")) {
    const bare = pathname.slice(0, -".html".length);
    if (await exists(pathname.slice(1))) return redirect(bare + query);
  }
  if (pathname.endsWith("/")) {
    if (await exists(`${pathname.slice(1)}index.html`)) rel = `${pathname.slice(1)}index.html`;
    else if (pathname !== "/" && (await exists(`${pathname.slice(1, -1)}.html`))) return redirect(pathname.slice(0, -1) + query);
  } else if (await exists(pathname.slice(1))) rel = pathname.slice(1);
  else if (await exists(`${pathname.slice(1)}.html`)) rel = `${pathname.slice(1)}.html`;
  else if (await exists(`${pathname.slice(1)}/index.html`)) return redirect(`${pathname}/${query}`);

  let status = 200;
  if (!rel) {
    rel = "404.html";
    status = 404;
  }
  const file = await load(rel);
  if (!file) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "Content-Type": file.type, ETag: file.etag, "Cache-Control": "public, max-age=0, must-revalidate" });
  for (const rule of rules) if (rule.pattern.test(pathname)) for (const [k, v] of rule.headers) headers.set(k, v);
  if (status === 200 && request.headers.get("If-None-Match") === file.etag) return new Response(null, { status: 304, headers });

  let body = file.body;
  const accept = request.headers.get("Accept-Encoding") ?? "";
  const encoding = COMPRESSIBLE.test(file.type) && body.length > 512 ? (/\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null) : null;
  if (encoding) {
    if (!file.encoded.has(encoding)) file.encoded.set(encoding, encoding === "br" ? zlib.brotliCompressSync(body) : zlib.gzipSync(body, { level: 9 }));
    body = file.encoded.get(encoding)!;
    headers.set("Content-Encoding", encoding);
    headers.set("Vary", "Accept-Encoding");
  }
  headers.set("Content-Length", String(body.length));
  return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { status, headers });
}

// The Worker, loaded by path so this script type-checks without the Workers types.
const worker = (await import(pathToFileURL(path.join(ROOT, "worker.ts")).href)).default as {
  fetch: (request: Request, env: { ASSETS: { fetch: (input: Request | URL | string) => Promise<Response> } }) => Promise<Response>;
};
const env = { ASSETS: { fetch: (input: Request | URL | string) => assets(input instanceof Request ? input : new Request(input)) } };

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${HOST}:${PORT}${req.url ?? "/"}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]])),
      body: hasBody ? (req as unknown as ReadableStream) : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    const response = new URL(url).pathname.startsWith("/api/") ? await worker.fetch(request, env) : await assets(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Preview error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
server.listen(PORT, HOST, () => console.log(`Previewing dist/ at http://${HOST}:${PORT} (Ctrl-C stops it).`));
