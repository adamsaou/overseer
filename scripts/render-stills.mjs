// Renders the website's stills from the live world, so the page without WebGL shows the same plates:
//   site/img/poster-hero.avif, .webp   the settled hero (motion off, and without WebGL), iris over the gap
//   site/img/poster-hero-start.avif    the hero's first state, the clouds on top of each other and nothing
//                                      measured yet: the poster the world takes over from with motion on
//   site/img/poster-hero-720.avif, ... and smaller ones for phones (still-*-600 too)
//   site/img/still-target.avif, .webp  Atlas and the sealed sleeve
//   site/img/still-auditor.avif, .webp the bench with the featured audit's conversations drawn
//   site/img/blink-target.avif         the worked example's two exposures, field only: the SVG plate
//   site/img/blink-reference.avif      draws the contours, answers and calipers over them
//   site/img/og.png                    1200 x 630, for link previews
//   site/img/anchors.json              where each still's labels sit, as fractions of its figure, and
//                                      what the stills were drawn from (scripts/build-site.ts checks it)
// The oversight gap has no still: without WebGL its two 3 x 3 small multiples are clearer.
//
// Run it after changing the world (site/js/world/) or the data it draws, then rebuild the site:
//
//   npm install --prefix /tmp/stills playwright-core    # once; it is not a dependency of the package
//   PLAYWRIGHT_CORE=/tmp/stills/node_modules/playwright-core node scripts/render-stills.mjs
//
// It builds dist/, serves it with scripts/preview-site.ts on 127.0.0.1:$PORT (8790 by default),
// renders in Chromium on the machine's GPU (CHROME=<binary> picks the browser, CHROME_ARGS adds
// flags; a software renderer is refused, as the site refuses it), encodes with avifenc and
// ImageMagick (both must be on PATH), and stops the server it started.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stillsSource } from "../site/render/stills.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMG = path.join(ROOT, "site", "img");
const PORT = Number(process.env.PORT) || 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const SCALE = 2; // device pixels per css pixel: stills stay sharp on dense screens
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "overseer-stills-"));

const { chromium } = await loadPlaywright();
for (const tool of ["avifenc", "magick"]) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    fail(`${tool} isn't on PATH; it encodes the stills.`);
  }
}
class Refused extends Error {}

console.log("Building dist/ ...");
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-site.ts")], { cwd: ROOT, stdio: "inherit" });
const server = spawn(process.execPath, [path.join(ROOT, "scripts", "preview-site.ts")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("Previewing") && resolve());
    server.on("exit", (code) => reject(new Error(`the preview server exited (${code})`)));
  });
  const args = ["--ignore-gpu-blocklist", "--enable-gpu", ...(process.platform === "linux" ? ["--use-angle=gl"] : []), ...(process.env.CHROME_ARGS?.split(" ").filter(Boolean) ?? [])];
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined, args });
  const anchors = {};

  // What the stills are drawn from: the scan and the featured run the build will pick.
  const config = await (await fetch(`${BASE}/data/config.json`)).json();
  const scan = await (await fetch(`${BASE}/data/scans/${config.scan}.json`)).json();
  const featured = await (await fetch(`${BASE}/data/runs/${config.featured}.json`)).json();
  anchors._source = stillsSource(scan, featured);

  // The stations, at the reference desktop layout, in reduced motion: every station is then one
  // composed, settled still, and the iris rests over the gap.
  const page = await open({ width: 1440, height: 900 });
  const shots = [
    { name: "poster-hero", scene: "hero", window: "hero", width: 1180, budget: 58 },
    { name: "still-target", scene: "target", window: "target", width: 1180, budget: 60, labels: ["sleeve", "atlas"] },
    { name: "still-auditor", scene: "auditor", window: "auditor", width: 1180, budget: 64, labels: (n) => n.startsWith("thread:") || n.startsWith("station:") || n === "rail" },
  ];
  for (const shot of shots) {
    await goTo(page, shot.scene);
    const { png, probe, rect } = await capture(page, shot.window, null, shot.name === "poster-hero");
    await encode(png, shot.name, shot.width, shot.budget, true);
    // phones get smaller ones: the poster is the first thing they paint
    if (shot.name === "poster-hero") await encode(png, `${shot.name}-720`, 720, 26, true);
    else await encode(png, `${shot.name}-600`, 600, 22, true);
    if (shot.name === "poster-hero") {
      // The first state: the target's answers still in the reference's clusters (JSD 0), so no leak,
      // and the iris where the world's first frame puts it, on the clouds' common centre.
      await page.evaluate(() => (window.__overseer.world.debug.overrides = { transfer: 0 }));
      await settle(page);
      const start = await capture(page, shot.window, null, true);
      await encode(start.png, "poster-hero-start", shot.width, shot.budget, true);
      await encode(start.png, "poster-hero-start-720", 720, 26, true);
      await page.evaluate(() => (window.__overseer.world.debug.overrides = {}));
      await settle(page);
    }
    if (shot.labels) {
      const keep = typeof shot.labels === "function" ? shot.labels : (n) => shot.labels.includes(n);
      for (const [name, p] of Object.entries(probe.anchors)) {
        if (!keep(name)) continue;
        anchors[name] = { x: round((p.x - rect.x) / rect.w), y: round((p.y - rect.y) / rect.h) };
      }
    }
  }

  // The blink: the measuring field alone, once per exposure. The SVG plate over it draws the rest, so
  // both exposures are captured from one rectangle, the plate's own (960:560), measured once the
  // blink view shows it, and must come out the same size.
  await goTo(page, "entropy");
  await page.click('#blink-controls [role="radio"][data-view="blink"]');
  await page.evaluate(() => {
    const { world } = window.__overseer;
    world.debug.overrides = { contours: 0, samples: 0, plateMarks: 0 };
  });
  // the blink view's layout differs from the side-by-side one, so the scene's hold moved
  await goTo(page, "entropy");
  await page.waitForFunction(() => {
    const r = window.__overseer.world.probe().windows.entropy;
    const p = document.querySelector("#entropy .fig__plate").getBoundingClientRect();
    const same = r && Math.abs(r.x - p.x) < 1 && Math.abs(r.y - p.y) < 1 && Math.abs(r.w - p.width) < 1 && Math.abs(r.h - p.height) < 1;
    return same && Math.abs(r.w / r.h / (960 / 560) - 1) < 0.005 && r.y >= 0 && r.y + r.h <= innerHeight;
  }, null, { timeout: 10000 }).catch(() => {
    throw new Refused("The entropy plate's window never sat whole on screen in the plate's 960:560 shape.");
  });
  const plateRect = await page.evaluate(() => window.__overseer.world.probe().windows.entropy);
  const sizes = [];
  for (const exposure of ["target", "reference"]) {
    await page.evaluate((state) => window.__overseer.bus.emit("blink", { state, count: 0 }), exposure);
    await settle(page);
    const { png } = await capture(page, "entropy", plateRect);
    await encode(png, `blink-${exposure}`, 1280, 44, false);
    sizes.push(execFileSync("magick", ["identify", "-format", "%w %h", png]).toString().trim());
  }
  const [w, h] = sizes[0].split(" ").map(Number);
  if (sizes[0] !== sizes[1] || Math.abs(w / h / (960 / 560) - 1) > 0.005) throw new Refused(`The blink exposures don't register: ${sizes.join(" and ")} px.`);
  await page.close();

  // The link preview: the hero as it stands, headline and readouts included, without the navigation.
  const og = await open({ width: 1200, height: 630 });
  await og.addStyleTag({
    content: ".masthead__nav, .vernier, .footnote, .legend, .actions, .scale--h { visibility: hidden !important; } .scene--hero { min-height: 630px !important; } .hero__copy { padding-bottom: 72px !important; }",
  });
  await settle(og, 1500);
  const ogPng = path.join(tmp, "og-2x.png");
  await og.screenshot({ path: ogPng });
  execFileSync("magick", [ogPng, "-filter", "Lanczos", "-resize", "1200x630!", "-strip", "-define", "png:compression-level=9", path.join(IMG, "og.png")]);
  await og.close();

  await fs.writeFile(path.join(IMG, "anchors.json"), `${JSON.stringify(anchors, null, 2)}\n`);
  console.log(`Wrote site/img/anchors.json (${Object.keys(anchors).length} labels).`);
  for (const f of (await fs.readdir(IMG)).sort()) console.log(`  ${f.padEnd(24)} ${((await fs.stat(path.join(IMG, f))).size / 1024).toFixed(1)} KB`);
  console.log("Done. Rebuild the site (npm run build:site) to use them.");
} catch (err) {
  console.error(err instanceof Refused ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
}

async function open(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.warn(`page error: ${e.message}`));
  await page.goto(`${BASE}/?instrument`, { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.dataset.world === "on" && window.__overseer?.world, null, { timeout: 30000 }).catch(() => {
    throw new Refused("The world didn't start in this browser: it needs WebGL 2 on a GPU. Set CHROME and CHROME_ARGS for one that has it.");
  });
  await page.evaluate(() => {
    window.__overseer.world.debug.grain = 0.6;
    return document.fonts.ready;
  });
  return page;
}

// Scrolls to where a scene's station has arrived and holds, then waits for the world to settle.
async function goTo(page, scene) {
  await page.evaluate((scene) => {
    const el = document.getElementById(scene);
    const top = el.getBoundingClientRect().top + scrollY;
    const y = scene === "hero" ? 0 : el.classList.contains("scene--sticky") ? top + innerHeight * 0.62 : top - 40;
    scrollTo({ top: y, behavior: "instant" });
  }, scene);
  await settle(page);
}

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
  await page.waitForFunction(() => window.__overseer.world.probe().settled, null, { timeout: 10000 });
  await page.waitForTimeout(300);
}

// A window's pixels, from the rectangle given or the window's place now. With light, the plate's own
// black (#070908) is taken out and the image keeps only the light, as alpha (and no grain of its
// own): the hero's posters sit on the page's plate and grain, and develop in without a darker
// rectangle around them.
async function capture(page, scene, at = null, light = false) {
  const { url, probe, rect } = await page.evaluate(async ([scene, at, light]) => {
    const { world } = window.__overseer;
    const probe = world.probe();
    const rect = at ?? probe.windows[scene];
    if (!light) return { url: world.capture(rect), probe, rect };
    // without the world's grain: the page's own grain shows through, and the light stays smooth
    const grain = world.debug.grain;
    world.debug.grain = 0;
    const shot = world.capture(rect);
    world.debug.grain = grain;
    const img = new Image();
    img.src = shot;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    const P = [7, 9, 8];
    for (let i = 0; i < d.data.length; i += 4) {
      // the least alpha that explains the pixel as some colour over the plate
      let a = 0;
      for (let k = 0; k < 3; k++) {
        const v = d.data[i + k];
        a = Math.max(a, v >= P[k] ? (v - P[k]) / (255 - P[k]) : (P[k] - v) / P[k]);
      }
      if (a <= 0) {
        d.data[i + 3] = 0;
        continue;
      }
      for (let k = 0; k < 3; k++) d.data[i + k] = Math.round((d.data[i + k] - (1 - a) * P[k]) / a);
      d.data[i + 3] = Math.round(a * 255);
    }
    g.putImageData(d, 0, 0);
    return { url: c.toDataURL("image/png"), probe, rect };
  }, [scene, at, light]);
  const png = path.join(tmp, `${scene}-${Date.now()}.png`);
  await fs.writeFile(png, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  return { png, probe, rect };
}

// AVIF at the best quality that fits the budget (KB), and a WebP beside it for older browsers.
async function encode(png, name, width, budget, webp) {
  const sized = path.join(tmp, `${name}.png`);
  execFileSync("magick", [png, "-filter", "Lanczos", "-resize", `${width}x`, "-strip", sized]);
  const avif = path.join(IMG, `${name}.avif`);
  let chosen = null;
  for (const q of [86, 82, 78, 74, 70, 65, 60, 55, 50, 45, 40]) {
    execFileSync("avifenc", ["-q", String(q), "-s", "3", "-y", "420", "--depth", "8", sized, avif], { stdio: "ignore" });
    const kb = (await fs.stat(avif)).size / 1024;
    chosen = { q, kb };
    if (kb <= budget) break;
  }
  console.log(`  ${name}.avif  q ${chosen.q}, ${chosen.kb.toFixed(1)} KB`);
  if (!webp) return;
  const out = path.join(IMG, `${name}.webp`);
  for (const q of [70, 62, 55, 48, 40]) {
    execFileSync("magick", [sized, "-quality", String(q), "-define", "webp:method=6", out]);
    if ((await fs.stat(out)).size / 1024 <= budget * 1.6) break;
  }
  console.log(`  ${name}.webp  ${((await fs.stat(out)).size / 1024).toFixed(1)} KB`);
}

async function loadPlaywright() {
  try {
    if (process.env.PLAYWRIGHT_CORE) return await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href);
    return await import("playwright-core");
  } catch {
    fail("This script needs playwright-core, which isn't a dependency of the package:\n  npm install --prefix /tmp/stills playwright-core\n  PLAYWRIGHT_CORE=/tmp/stills/node_modules/playwright-core node scripts/render-stills.mjs");
  }
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
