import { bus, state } from "./bus.js";

// The hero: its poster, the registration-target cursor and the readout that rides beside the iris.
// The cursor and the readout exist only while the world runs: without it there is no iris to steer.
export function initHero() {
  const root = document.documentElement;
  const zone = document.querySelector("[data-cloud-zone]");
  const cursor = document.getElementById("cursor");
  const readout = document.getElementById("iris-readout");
  const fine = matchMedia("(pointer: fine)");

  // The cursor follows the world's own state, from the event itself, so it doesn't matter which
  // module hears "world:ready" first.
  let running = false;
  const sync = () => {
    root.dataset.cursor = running && fine.matches ? "on" : "off";
    if (root.dataset.cursor === "off") cursor?.classList.remove("is-on");
  };
  bus.on("world:ready", () => {
    running = true;
    sync();
  });
  bus.on("world:fallback", () => {
    running = false;
    sync();
  });
  fine.addEventListener?.("change", sync);
  sync();

  if (zone && cursor) {
    zone.addEventListener(
      "pointermove",
      (e) => {
        if (root.dataset.cursor !== "on") return;
        cursor.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
        cursor.classList.add("is-on");
      },
      { passive: true },
    );
    zone.addEventListener("pointerleave", () => cursor.classList.remove("is-on"));
  }

  // The poster. With motion on, the world takes over from the scan's first state, so the poster shows
  // that and develops in (the plate's characteristic curve, in CSS, while the JSD needle self-tests);
  // with motion off, or once the world can't run, it shows the settled plate the readouts describe.
  // The <picture> follows the system setting by itself; this covers the MOTION switch and the fallback.
  const poster = document.querySelector(".still__poster[data-poster]");
  const show = (kind) => {
    if (!poster || poster.dataset.poster === kind) return;
    poster.dataset.poster = kind;
    for (const s of poster.querySelectorAll("source[data-reduced]")) s.media = kind === "start" ? "not all" : "(prefers-reduced-motion: reduce)";
    for (const el of poster.querySelectorAll("[data-start]")) el.srcset = kind === "start" ? el.dataset.start : el.dataset.settled;
  };
  // The first development is CSS alone, from the first paint; a fallback develops the settled plate.
  const develop = () => {
    if (!poster || state.reducedMotion) return;
    poster.classList.remove("is-developing");
    void poster.offsetWidth; // restart the animation
    poster.classList.add("is-developing");
  };
  let worldGone = false;
  if (poster) {
    show(state.reducedMotion ? "settled" : "start");
    // The world takes over from the poster once the plate has developed, not part way through.
    const img = poster.querySelector("img");
    if (img?.getAnimations?.().some((a) => a.playState === "running")) {
      root.dataset.posterDeveloping = "";
      const done = () => delete root.dataset.posterDeveloping;
      img.addEventListener("animationend", done, { once: true });
      img.addEventListener("animationcancel", done, { once: true });
    }
    bus.on("motion", ({ reduced }) => {
      if (!state.worldActive) show(reduced || worldGone ? "settled" : "start");
    });
  }
  bus.on("world:fallback", () => {
    worldGone = true;
    if (poster?.dataset.poster === "start") {
      show("settled");
      develop();
    }
  });

  // The readout rides beside the iris: where the world says (readout.x, readout.y), or else on
  // whichever side keeps it inside the cloud zone. Empty text, or visible: false, hides it.
  if (readout) {
    let width = 0;
    let right = innerWidth;
    const measure = () => (right = zone?.getBoundingClientRect().right ?? innerWidth);
    addEventListener("resize", measure);
    requestAnimationFrame(() => setTimeout(measure, 0));
    bus.on("iris", ({ x, y, r = 0, reach, text = "", readout: at, visible } = {}) => {
      readout.hidden = !text || visible === false;
      if (readout.hidden) return;
      if (readout.textContent !== text) {
        readout.textContent = text;
        width = readout.offsetWidth;
      }
      const placed = at && Number.isFinite(at.x) && Number.isFinite(at.y);
      const ring = reach ?? r;
      const left = placed ? at.x : x + ring + 16 + width > right ? x - ring - 16 - width : x + ring + 16;
      const top = placed ? at.y : y - 8;
      readout.style.transform = `translate3d(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px, 0)`;
    });
  }
}
