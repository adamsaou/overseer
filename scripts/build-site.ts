import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { GOALS } from "../lib/goals.ts";
import { MODELS } from "../lib/models.ts";

// Builds dist/ for the Cloudflare site. The site (site/) at the root, bundled with esbuild, every number
// prerendered from the same JSON Overseer writes; the saved runs, study results and scans as static JSON
// in /data/; and the study page at /study. Wrangler runs this before every deploy (see wrangler.jsonc),
// and `npm run preview` before serving dist/ locally.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(ROOT, "dist");
const read = (file: string) => fs.readFile(file, "utf8");
const readJson = async (file: string) => JSON.parse(await read(file));
const exists = (file: string) => existsSync(file);
const jsonFiles = async (dir: string) =>
  (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse();

type Run = {
  id: string;
  auditor: string;
  target: string;
  budget?: number;
  objective?: string;
  events: { type: string; t: number }[];
  result?: { grade?: { label?: string }; stats?: { targetMessages?: number; scans?: number; seconds?: number; costUsd?: number } };
};

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(path.join(DIST, "data", "runs"), { recursive: true });
await fs.mkdir(path.join(DIST, "data", "scans"), { recursive: true });

// Saved audits, newest first. runs.json keeps the fields the site reads.
const runs: Run[] = [];
const metas = [];
for (const file of await jsonFiles(path.join(ROOT, "runs"))) {
  const raw = await read(path.join(ROOT, "runs", file));
  const run: Run = JSON.parse(raw);
  runs.push(run);
  const stats = run.result?.stats ?? {};
  metas.push({
    id: run.id,
    auditor: run.auditor,
    target: run.target,
    label: run.result?.grade?.label,
    budget: run.budget,
    messages: stats.targetMessages,
    scans: stats.scans,
    seconds: stats.seconds,
    costUsd: stats.costUsd,
  });
  await fs.writeFile(path.join(DIST, "data", "runs", file), raw);
}
await fs.writeFile(path.join(DIST, "data", "runs.json"), JSON.stringify(metas));

const summaryFile = path.join(ROOT, "results", "summary.json");
const summary = exists(summaryFile) ? await readJson(summaryFile) : null;
if (summary) await fs.copyFile(summaryFile, path.join(DIST, "data", "summary.json"));

// Entropy scans saved on their own (results/scans/), with their objective's summary.
const scans = [];
for (const file of await jsonFiles(path.join(ROOT, "results", "scans"))) {
  const raw = await read(path.join(ROOT, "results", "scans", file));
  const scan = JSON.parse(raw);
  scans.push(scan);
  await fs.writeFile(path.join(DIST, "data", "scans", file), raw);
}
const goalOf = (id: string) => GOALS.find((g) => g.id === id);
await fs.writeFile(
  path.join(DIST, "data", "scans", "index.json"),
  JSON.stringify(
    scans.map((s) => ({ id: s.id, createdAt: s.createdAt, target: s.target, reference: s.reference, objective: s.objective, summary: goalOf(s.objective)?.summary ?? null, n: s.n, divergence: s.divergence })),
  ),
);

// The page's config: the featured replay, the plates and the worked-example scan. A missing id falls
// back to the newest caught run, or the newest scan.
const wanted = await readJson(path.join(SITE, "config.json"));
const byId = new Map(runs.map((r) => [r.id, r]));
const featured = byId.get(wanted.featured) ?? runs.find((r) => r.result?.grade?.label === "caught") ?? runs[0];
if (!featured) throw new Error("The site needs at least one saved run in runs/.");
const plates = [featured, ...(wanted.plates as string[]).filter((id) => id !== featured.id).flatMap((id) => byId.get(id) ?? [])];
const scan = scans.find((s) => s.id === wanted.scan) ?? scans[0];
if (!scan) throw new Error("The site needs an entropy scan in results/scans/ for its worked example.");
const labels = Object.fromEntries(Object.entries(MODELS).map(([key, m]) => [key, m.label]));
// What each plate's sealed envelope may say about its objective: whether it is one of the presets.
const { sealedLabel } = await import(pathToFileURL(path.join(SITE, "js", "lib", "format.js")).href);
const presets = GOALS.map((g) => g.objective);
const sealed = Object.fromEntries(plates.map((r) => [r.id, sealedLabel(r.objective, presets)]));
const config = { origin: wanted.origin, featured: featured.id, plates: plates.map((r) => r.id), scan: scan.id, labels, sealed };
await fs.writeFile(path.join(DIST, "data", "config.json"), JSON.stringify(config));
for (const [kind, id] of [["featured", wanted.featured], ["scan", wanted.scan]]) {
  if (id !== (kind === "featured" ? featured.id : scan.id)) console.warn(`site/config.json: ${kind} "${id}" wasn't found, so the site uses ${kind === "featured" ? featured.id : scan.id}.`);
}

// Scripts and styles. boot.js stays small; replay.js, data.js and the world are lazy chunks. Until the
// world exists, ./world/index.js resolves to a stub whose start() throws, so the stills stay.
// SITE_WORLD=<file> builds with another world module instead, for testing the page against a harness.
const worldStub: esbuild.Plugin = {
  name: "world-stub",
  setup(build) {
    build.onResolve({ filter: /^\.\/world\/index\.js$/ }, (args) => {
      if (process.env.SITE_WORLD) return { path: path.resolve(process.env.SITE_WORLD) };
      return exists(path.join(args.resolveDir, args.path)) ? undefined : { path: "world-stub", namespace: "world-stub" };
    });
    build.onLoad({ filter: /.*/, namespace: "world-stub" }, () => ({
      contents: 'export async function start() { throw new Error("site/js/world/ isn\'t built yet"); }',
      loader: "js",
    }));
  },
};
const result = await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: { boot: "site/js/boot.js", main: "site/css/main.css" },
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: ["chrome111", "firefox113", "safari16.4"],
  outdir: DIST,
  entryNames: "assets/[name]-[hash]",
  chunkNames: "assets/[name]-[hash]",
  assetNames: "fonts/[name]-[hash]",
  loader: { ".woff2": "file" },
  external: ["/img/*"],
  publicPath: "/",
  metafile: true,
  logLevel: "warning",
  plugins: [worldStub],
});
const outputs = Object.entries(result.metafile.outputs);
const outputFor = (entry: string) => outputs.find(([, o]) => o.entryPoint === entry);
const boot = outputFor("site/js/boot.js");
const css = outputFor("site/css/main.css");
if (!boot || !css) throw new Error("esbuild didn't produce the boot script and the stylesheet.");
const publicUrl = (file: string) => `/${path.relative(DIST, path.join(ROOT, file)).split(path.sep).join("/")}`;
const fontUrl = (name: string) => {
  const hit = outputs.find(([file]) => path.basename(file).startsWith(`${name}-`) && file.endsWith(".woff2"));
  if (!hit) throw new Error(`No bundled font for ${name}.`);
  return publicUrl(hit[0]);
};
const cssText = (await read(path.join(ROOT, css[0]))).trim();
await fs.rm(path.join(ROOT, css[0]));
const preloads = boot[1].imports.filter((i) => i.kind === "import-statement").map((i) => `<link rel="modulepreload" href="${publicUrl(i.path)}">`);
const sizes = Object.fromEntries(outputs.filter(([f]) => f.endsWith(".js")).map(([f, o]) => [path.basename(f), o.bytes]));

// Images: the stills the world renders are optional; the page only references the ones that exist,
// and only the ones rendered from the data the page has now (scripts/render-stills.mjs records what it
// drew in anchors.json). A still from another scan or featured run gives way to the SVG figures.
await fs.cp(path.join(SITE, "img"), path.join(DIST, "img"), { recursive: true, filter: (src) => !src.endsWith(".json") });
// The painted mark from brand/, for browser tabs and home screens.
for (const f of ["favicon-32.png", "favicon-64.png", "apple-touch-icon.png"]) await fs.copyFile(path.join(ROOT, "brand", f), path.join(DIST, f));
for (const f of await fs.readdir(path.join(SITE, "fonts"))) if (f.endsWith(".txt")) await fs.copyFile(path.join(SITE, "fonts", f), path.join(DIST, "fonts", f));
const img = (name: string) => exists(path.join(SITE, "img", name));
const both = (name: string) => img(`${name}.avif`) && img(`${name}.webp`);
const stills: Record<string, boolean> = {
  poster: both("poster-hero"),
  poster720: both("poster-hero-720"),
  posterStart: both("poster-hero-start"),
  posterStart720: both("poster-hero-start-720"),
  blink: img("blink-target.avif") && img("blink-reference.avif"),
  og: img("og.png"),
};
for (const scene of ["target", "auditor", "gap"]) {
  stills[scene] = both(`still-${scene}`);
  stills[`${scene}600`] = both(`still-${scene}-600`);
}
const { stillsSource } = await import(pathToFileURL(path.join(SITE, "render", "stills.js")).href);
let anchors: Record<string, unknown> = img("anchors.json") ? await readJson(path.join(SITE, "img", "anchors.json")) : {};
const drawn = (anchors as { _source?: { scan?: string; featured?: string } })._source ?? {};
const source = stillsSource(scan, featured);
if (Object.values(stills).some(Boolean) && drawn.scan !== source.scan) {
  console.warn("site/img/: the stills weren't rendered from this scan, so the page uses its SVG figures. Run scripts/render-stills.mjs.");
  for (const key of Object.keys(stills)) stills[key] = false;
  anchors = {};
} else if (stills.auditor && drawn.featured !== source.featured) {
  console.warn("site/img/: the auditor still wasn't rendered from this featured run, so the page uses its SVG figure. Run scripts/render-stills.mjs.");
  stills.auditor = stills.auditor600 = false;
  anchors = Object.fromEntries(Object.entries(anchors).filter(([k]) => !/^(thread|station):|^rail$/.test(k)));
}
// The two blink exposures register to the pixel over the SVG plate only if they share its frame.
if (stills.blink) {
  const sizes = ["target", "reference"].map((layer) => avifSize(path.join(SITE, "img", `blink-${layer}.avif`)));
  const [a, b] = sizes;
  if (!a || !b || a.w !== b.w || a.h !== b.h || Math.abs(a.w / a.h / (960 / 560) - 1) > 0.005) {
    throw new Error(`site/img/blink-*.avif must share one size with the plate's 960:560 aspect (got ${sizes.map((x) => (x ? `${x.w}x${x.h}` : "?")).join(" and ")}). Run scripts/render-stills.mjs again.`);
  }
}
delete (anchors as Record<string, unknown>)._source;

// The page: every {{ slot }} filled from the data. site/render/page.js is plain JS shared with the page's
// own modules, so it's loaded by URL rather than through the type checker.
const pkg = await readJson(path.join(ROOT, "package.json"));
const three = (await readJson(path.join(ROOT, "node_modules", "three", "package.json"))).version as string;
const { pageValues, studyValues, posterSet, POSTER_SIZES, REDUCED } = await import(pathToFileURL(path.join(SITE, "render", "page.js")).href);
const values: Record<string, string> = {
  ...pageValues({ summary, scan: { ...scan, goal: goalOf(scan.objective) }, featured, plates, runs: metas, scans, labels, stills, anchors, presets, three, node: nodeRequirement(pkg.engines?.node) }),
  origin: config.origin,
  css: `<style>${cssText}</style>`,
  preload: [
    `<link rel="preload" href="${fontUrl("plate-serif-display-300")}" as="font" type="font/woff2" crossorigin>`,
    // the poster the <picture> will pick: the plate's first state with motion on, the settled one without
    ...(stills.poster && stills.posterStart
      ? [
          `<link rel="preload" as="image" type="image/avif" imagesrcset="${posterSet(stills, "avif", "-start")}" imagesizes="${POSTER_SIZES}" media="(prefers-reduced-motion: no-preference)" fetchpriority="high">`,
          `<link rel="preload" as="image" type="image/avif" imagesrcset="${posterSet(stills, "avif")}" imagesizes="${POSTER_SIZES}" media="${REDUCED}" fetchpriority="high">`,
        ]
      : [stills.poster ? `<link rel="preload" as="image" type="image/avif" imagesrcset="${posterSet(stills, "avif")}" imagesizes="${POSTER_SIZES}" fetchpriority="high">` : ""]),
  ]
    .filter(Boolean)
    .join("\n"),
  og_image: stills.og
    ? `<meta property="og:image" content="${config.origin}/img/og.png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">`
    : '<meta name="twitter:card" content="summary">',
  scripts: [
    `<script type="application/json" id="site-config">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>`,
    ...preloads,
    `<script type="module" src="${publicUrl(boot[0])}"></script>`,
  ].join("\n"),
};
const fill = (template: string, file: string, slots: Record<string, string> = values) =>
  template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in slots)) throw new Error(`${file}: nothing fills {{ ${key} }}.`);
    return slots[key];
  });
await fs.writeFile(path.join(DIST, "index.html"), fill(await read(path.join(SITE, "index.html")), "site/index.html"));
await fs.writeFile(path.join(DIST, "404.html"), fill(await read(path.join(SITE, "404.html")), "site/404.html"));
// The study page, in the site's own type and from the same summary.json: every audit, objective by
// objective.
await fs.writeFile(
  path.join(DIST, "study.html"),
  fill(await read(path.join(SITE, "study.html")), "site/study.html", {
    ...studyValues({ summary, labels }),
    origin: config.origin,
    css: values.css,
    font_preload: `<link rel="preload" href="${fontUrl("plate-serif-display-300")}" as="font" type="font/woff2" crossorigin>`,
  }),
);

// Cache rules for Workers static assets: hashed files forever, data briefly, pages always revalidated.
await fs.writeFile(
  path.join(DIST, "_headers"),
  [
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/fonts/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/img/*",
    "  Cache-Control: public, max-age=86400",
    "/data/*",
    "  Cache-Control: public, max-age=300",
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "",
  ].join("\n"),
);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const eager = boot[1].bytes + boot[1].imports.filter((i) => i.kind === "import-statement").reduce((s, i) => s + (result.metafile.outputs[i.path]?.bytes ?? 0), 0);
console.log(
  `Built dist/: the site (boot ${kb(eager)} before the load event${exists(path.join(SITE, "js", "world", "index.js")) ? "" : ", world not built yet"}), ` +
    `${runs.length} saved runs, ${scans.length} scan${scans.length === 1 ? "" : "s"}${summary ? ", study results" : ""} and the study page at /study.`,
);
if (process.env.SITE_SIZES) console.log(sizes);

// An AVIF's width and height, from its image spatial extents ('ispe') box.
function avifSize(file: string) {
  const buf = readFileSync(file);
  const at = buf.indexOf("ispe");
  return at < 0 ? null : { w: buf.readUInt32BE(at + 8), h: buf.readUInt32BE(at + 12) };
}

function nodeRequirement(range: string | undefined) {
  const m = /^>=\s*(\d+(?:\.\d+)*)$/.exec(range ?? "");
  return m ? `${m[1]} or newer` : (range ?? "22 or newer");
}
