import { bus, state } from "./bus.js";

// The MOTION switch overrides the OS setting and is remembered per browser. Until someone uses it,
// the page follows prefers-reduced-motion, live.
const KEY = "overseer:motion";

export function initMotion() {
  const root = document.documentElement;
  const button = document.getElementById("motion");
  const query = matchMedia("(prefers-reduced-motion: reduce)");
  const stored = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const apply = (reduced) => {
    root.dataset.motion = reduced ? "off" : "on";
    button?.setAttribute("aria-pressed", String(!reduced));
    if (state.reducedMotion === reduced) return;
    state.reducedMotion = reduced;
    bus.emit("motion", { reduced });
  };
  state.reducedMotion = root.dataset.motion === "off";
  button?.setAttribute("aria-pressed", String(!state.reducedMotion));
  button?.addEventListener("click", () => {
    const reduced = !state.reducedMotion;
    try {
      localStorage.setItem(KEY, reduced ? "off" : "on");
    } catch {
      // Private windows can refuse storage; the switch still works for this visit.
    }
    apply(reduced);
  });
  query.addEventListener("change", () => {
    const saved = stored();
    if (saved !== "on" && saved !== "off") apply(query.matches);
  });
}
