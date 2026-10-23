import { bus } from "./bus.js";

// The oversight-gap table and the small-multiple plates share cell keys (tools:auditor:target).
// Hover or focus on either opens the readout panel and tells the world which 3D cell to light.
export function initGap() {
  const section = document.getElementById("gap");
  const panel = document.getElementById("gap-readout");
  if (!section || !panel) return;
  const cells = [...section.querySelectorAll("[data-cell]")];
  const readouts = new Map(cells.filter((el) => el.dataset.readout).map((el) => [el.dataset.cell, el.dataset.readout]));
  let current = null;
  let timer = 0;

  const focus = (el) => {
    clearTimeout(timer);
    const key = el?.dataset.cell ?? null;
    if (key === current) return;
    current = key;
    for (const c of section.querySelectorAll(".is-focus")) c.classList.remove("is-focus");
    if (!key) {
      panel.classList.remove("is-on");
      bus.emit("grid:focus", null);
      return;
    }
    for (const c of section.querySelectorAll(`[data-cell="${key}"]`)) c.classList.add("is-focus");
    panel.replaceChildren(...labelNodes(readouts.get(key) ?? ""));
    panel.classList.toggle("is-on", Boolean(panel.textContent));
    bus.emit("grid:focus", { auditor: el.dataset.auditor, target: el.dataset.target, tools: el.dataset.tools });
  };
  const leave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => focus(null), 140);
  };
  for (const el of cells) {
    el.addEventListener("pointerenter", () => focus(el));
    el.addEventListener("pointerleave", leave);
    // Only the table's buttons take focus: Chrome makes any SVG element with a focus listener a tab stop.
    if (el instanceof HTMLButtonElement) {
      el.addEventListener("focus", () => focus(el));
      el.addEventListener("blur", leave);
    }
  }
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) focus(null);
  });
  // The 3D lattice under the pointer (the world reports the cell it hits) works like the table.
  bus.on("grid:pick", (d) => {
    if (!d) return leave();
    const el = section.querySelector(`[data-cell="${d.tools}:${d.auditor}:${d.target}"]`);
    if (el) focus(el);
  });
}

// The readout as label text, with its symbols (the sample size n) kept lowercase in the uppercase label.
function labelNodes(text) {
  return text.split(/\b(n)(?= = )/).map((part, i) => {
    if (i % 2 === 0) return part;
    const span = document.createElement("span");
    span.className = "sym";
    span.textContent = part;
    return span;
  });
}
