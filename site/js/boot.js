import { bus, state } from "./bus.js";
import { initMotion } from "./motion.js";
import { initNeedles } from "./needles.js";
import { initScroll } from "./scroll.js";
import { initBlink } from "./blink.js";
import { initHero } from "./hero.js";

// The page is complete without WebGL: these wire up the DOM, and the world (three.js) arrives later as
// progressive enhancement, after the load event, on an idle moment.
const root = document.documentElement;

// The world's state comes first, so every module listening for it reads it already updated.
let world = null;
bus.on("world:ready", () => {
  state.worldActive = true;
  root.dataset.world = "on";
});
bus.on("world:fallback", ({ reason } = {}) => {
  if (reason) console.info(`Overseer: showing the stills (${reason}).`);
  stopWorld();
  railCount(null);
  for (const el of arriving) el.style.removeProperty("--arrive");
});

initMotion();
initNeedles();
initScroll();
initBlink();
initHero();

// The replay loads when its scene is a viewport away, or at once when someone asks to watch.
let replay = null;
const loadReplay = () => (replay ??= import("./replay.js").then((m) => m.initReplay()));
const player = document.getElementById("replay");
if (player) {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      loadReplay();
    },
    { rootMargin: "100% 0px" },
  );
  io.observe(player);
}
for (const link of document.querySelectorAll("[data-watch]")) {
  link.addEventListener("click", () => loadReplay().then((api) => api?.requestPlay()));
}

// The rail's counter in the auditor scene follows the bench as the scroll runs the audit.
const railUsed = document.querySelector("[data-rail-used]");
const railFinal = railUsed?.textContent;
const railCount = (used) => {
  if (!railUsed) return;
  const text = used == null ? railFinal : String(used);
  if (railUsed.textContent !== text) {
    railUsed.textContent = text;
    railUsed.value = text;
  }
};
bus.on("bench", (d) => railCount(d?.used));

// A station's DOM figure arrives with the world's station, not ahead of it: its readouts and controls
// fade in as the plate (or the lattice) does, and leave with it.
const arriving = [...document.querySelectorAll("#entropy .scene__world, #gap .scene__world")];
bus.on("station", ({ weights } = {}) => {
  for (const el of arriving) {
    const w = weights?.[el.closest("section")?.dataset.scene] ?? 0;
    el.style.setProperty("--arrive", w.toFixed(2));
  }
});

function stopWorld() {
  state.worldActive = false;
  root.dataset.world = "off";
  try {
    world?.dispose();
  } catch {
    // Already gone.
  }
  world = null;
}

// WebGL 2 on a real GPU, on the plate's own canvas: the world takes this context over, so the page
// creates one context, not a throwaway probe and then the real one. Software renderers (SwiftShader,
// llvmpipe) don't always report a major performance caveat, and the plate would run at a few frames a
// second on them, so they get the stills (?instrument lets tests and the stills script through).
const instrument = /[?&]instrument\b/.test(location.search);
const ATTRIBUTES = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
  failIfMajorPerformanceCaveat: !instrument,
};
function webgl2(canvas) {
  try {
    const gl = canvas.getContext("webgl2", ATTRIBUTES);
    if (!gl) return null;
    let renderer = String(gl.getParameter(gl.RENDERER));
    // Chrome and Safari mask RENDERER; Firefox doesn't, and warns about the debug extension.
    if (/^webkit webgl$/i.test(renderer)) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    }
    if (!instrument && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    }
    return gl;
  } catch {
    return null;
  }
}

// scripts/render-stills.mjs (and tests) open the page with ?instrument to reach the bus and the world.
if (instrument) window.__overseer = { bus, state, get world() { return world; } };

async function startWorld() {
  const canvas = document.getElementById("plate");
  const gl = navigator.connection?.saveData ? null : webgl2(canvas);
  if (!gl) {
    bus.emit("world:fallback", { reason: navigator.connection?.saveData ? "save-data" : "no-webgl" });
    return;
  }
  try {
    const [{ start }, { loadData }] = await Promise.all([import("./world/index.js"), import("./data.js")]);
    const data = await loadData();
    world = await start({ canvas, context: gl, attributes: ATTRIBUTES, bus, state, data, options: instrument ? { allowSoftware: true } : {} });
  } catch (err) {
    console.info("Overseer: the 3D plate didn't start, so the stills stay.", err?.message ?? err);
    bus.emit("world:fallback", { reason: "start" });
  }
}

const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1));
const afterLoad = (fn) => (document.readyState === "complete" ? fn() : addEventListener("load", fn, { once: true }));
// The copy buttons and the oversight-gap table's hover come after the load event: they are far down
// the page, and the boot script stays small.
afterLoad(() =>
  idle(() => {
    import("./copy.js").then((m) => m.initCopy());
    import("./gap.js").then((m) => m.initGap());
  }),
);
afterLoad(() => {
  if (!matchMedia("(pointer: coarse)").matches) return idle(startWorld);
  // Phones: after the first interaction or three seconds, whichever comes first.
  const kinds = ["pointerdown", "keydown", "touchstart", "wheel"];
  let timer = 0;
  const go = () => {
    clearTimeout(timer);
    for (const type of kinds) removeEventListener(type, go);
    idle(startWorld);
  };
  for (const type of kinds) addEventListener(type, go, { passive: true, once: true });
  timer = setTimeout(go, 3000);
});
