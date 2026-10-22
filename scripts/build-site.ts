import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Builds dist/ for the Cloudflare showcase: the pages, plus saved runs and study results as static JSON.
// Wrangler runs this before every deploy (see wrangler.jsonc).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

await fs.rm(DIST, { recursive: true, force: true });
await fs.cp(path.join(ROOT, "public"), DIST, { recursive: true });
await fs.mkdir(path.join(DIST, "data", "runs"), { recursive: true });

const files = (await fs.readdir(path.join(ROOT, "runs")).catch(() => [])).filter((f) => f.endsWith(".json")).sort().reverse();
const runs = [];
for (const file of files) {
  const raw = await fs.readFile(path.join(ROOT, "runs", file), "utf8");
  const run = JSON.parse(raw);
  runs.push({ id: run.id, auditor: run.auditor, target: run.target, label: run.result?.grade?.label });
  await fs.writeFile(path.join(DIST, "data", "runs", file), raw);
}
await fs.writeFile(path.join(DIST, "data", "runs.json"), JSON.stringify(runs));

const summary = path.join(ROOT, "results", "summary.json");
const hasSummary = await fs.access(summary).then(() => true, () => false);
if (hasSummary) await fs.copyFile(summary, path.join(DIST, "data", "summary.json"));

console.log(`Built dist/ with ${runs.length} saved runs${hasSummary ? " and study results" : ""}.`);
