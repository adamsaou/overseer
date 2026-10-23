import { bus, state } from "./bus.js";

const LN2 = Math.log(2);
// What a readout shows while it measures: dashes in the digits' own places, so nothing moves.
const DASH = "–.––";

// The scales' needles and readouts follow "measure". A readout prints only what the scan measured:
// while the hero's plate develops ("settling") the needles move with the plate but the readouts say
// MEASURING, and the digits print once the plate has settled on the scan's real values. Without the
// world they're set straight to what each scene measures: the real scan in the hero and the entropy
// scene, nothing elsewhere. The phone's one-line readout follows the same events.
export function initNeedles() {
  const scales = document.querySelector(".scales");
  if (!scales) return;
  let real;
  try {
    real = JSON.parse(scales.dataset.measure);
  } catch {
    return;
  }
  const jsdSvg = scales.querySelector(".jsd-svg");
  const hSvg = scales.querySelector(".h-svg");
  const y0 = Number(jsdSvg.dataset.y0);
  const y1 = Number(jsdSvg.dataset.y1);
  const x0 = Number(hSvg.dataset.x0);
  const x1 = Number(hSvg.dataset.x1);
  const max = Number(hSvg.dataset.max);
  const needle = document.getElementById("jsd-needle");
  const tMark = document.getElementById("h-target-mark");
  const rMark = document.getElementById("h-reference-mark");
  const values = {
    jsd: [document.getElementById("jsd-value"), ...document.querySelectorAll('.readout-line [data-measure="jsd"]')],
    hTarget: [document.getElementById("h-target-value"), ...document.querySelectorAll('.readout-line [data-measure="hTarget"]')],
    hReference: [document.getElementById("h-reference-value"), ...document.querySelectorAll('.readout-line [data-measure="hReference"]')],
  };
  const modeLabel = document.getElementById("scale-mode");
  scales.style.setProperty("--full", `${(-(y0 - y1)).toFixed(1)}px`);

  function set({ jsd = 0, hTarget = 0, hReference = 0, mode = "settled" } = {}) {
    const none = mode === "no-scan";
    const measuring = mode === "settling";
    const m = { jsd: none ? 0 : clamp(jsd, LN2), hTarget: none ? 0 : clamp(hTarget, max), hReference: none ? 0 : clamp(hReference, max) };
    needle.style.transform = `translateY(${(-(m.jsd / LN2) * (y0 - y1)).toFixed(2)}px)`;
    tMark.style.transform = `translateX(${((m.hTarget / max) * (x1 - x0)).toFixed(2)}px)`;
    rMark.style.transform = `translateX(${((m.hReference / max) * (x1 - x0)).toFixed(2)}px)`;
    for (const key of Object.keys(values)) {
      const text = measuring ? DASH : m[key].toFixed(2);
      for (const el of values[key]) write(el, text);
    }
    scales.dataset.mode = mode;
    scales.setAttribute("aria-busy", String(measuring));
    const word = none ? "No scan" : measuring ? "Measuring" : "";
    if (modeLabel.textContent !== word) modeLabel.textContent = word;
  }

  // Motion on: until the world takes over, the plate is the poster of its first state (the target's
  // answers still where the reference's are), so the scales measure nothing yet and the JSD needle
  // runs its one self-test sweep.
  const waiting = () => set({ ...real, jsd: 0, hTarget: real.hReference, mode: "settling" });
  const developing = !state.reducedMotion && document.querySelector('.still__poster[data-poster="start"]');
  if (developing) {
    waiting();
    scales.classList.add("is-selftest");
    needle.addEventListener("animationend", () => scales.classList.remove("is-selftest"), { once: true });
  }

  let scene = null;
  let fellBack = false;
  const fallback = () => {
    if (state.worldActive) return;
    // before the world starts, the hero's plate is still its first state: nothing measured yet
    if (state.scene === "hero" && developing && !fellBack && !state.reducedMotion) return waiting();
    const measuring = state.scene === "hero" || state.scene === "entropy";
    set(measuring ? { ...real, mode: "settled" } : { mode: "no-scan" });
  };
  bus.on("measure", set);
  bus.on("scroll", (e) => {
    if (e.scene === scene) return;
    scene = e.scene;
    fallback();
  });
  bus.on("world:fallback", () => {
    fellBack = true;
    fallback();
  });
  bus.on("motion", () => fallback());
}

// The value's text with its decimal point drawn narrow, as the build writes it (render/page.js).
function write(el, text) {
  if (!el || el.value === text) return;
  el.value = text;
  const dot = text.indexOf(".");
  if (dot < 0) {
    el.textContent = text;
    return;
  }
  const dp = document.createElement("span");
  dp.className = "dp";
  dp.textContent = ".";
  el.replaceChildren(text.slice(0, dot), dp, text.slice(dot + 1));
}

const clamp = (x, hi) => Math.max(0, Math.min(hi, Number(x) || 0));
