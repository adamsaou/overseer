import { bus, state } from "./bus.js";

// The one scroll reader. Layout is measured on resize only (after the first paint, never while the
// boot script runs); a scroll costs one rAF that reads scrollY.
export function initScroll() {
  const root = document.documentElement;
  const sections = [...document.querySelectorAll("main > section[data-scene]")];
  const vernier = document.querySelector(".vernier");
  const needle = vernier?.querySelector(".vernier__needle");
  const links = new Map([...document.querySelectorAll(".vernier a[data-for]")].map((a) => [a.dataset.for, a]));
  const columns = [...document.querySelectorAll(".scene__text, .scene__world")];
  let spans = [];
  let panels = [];
  let docH = 1;
  let vh = 0;
  let ruler = 0;
  let readQueued = false;
  let measureQueued = false;
  let current = null;

  function measure() {
    measureQueued = false;
    vh = innerHeight;
    // All reads first, then the writes, so measuring costs one layout.
    const y = scrollY;
    const heights = columns.map((col) => col.offsetHeight);
    // Stacked layouts (phones and tablets): the text panels slide over the sticky world, so a station
    // has to have arrived by the time its section reaches the top of the screen.
    const stacked = innerWidth < 1100;
    spans = sections.map((el) => {
      const r = el.getBoundingClientRect();
      const drive = Number(el.dataset.drive) || 0.6;
      // A scene with notes drives its station over its stage, not over the notes that follow it.
      const stage = el.querySelector(":scope > .scene__stage");
      return {
        name: el.dataset.scene,
        top: r.top + y,
        height: r.height,
        driving: stage ? stage.offsetHeight : 0,
        drive: stacked && el.classList.contains("scene--sticky") ? Math.min(drive, 0.25) : drive,
      };
    });
    // Stacked layouts: where the solid text panels lie, run together where one follows another, to
    // tell when they cover the whole screen and nothing of the world shows.
    panels = [];
    if (stacked) {
      const boxes = [...document.querySelectorAll(".hero__copy, .scene__text, .scene__notes")]
        .map((p) => p.getBoundingClientRect())
        .filter((b) => b.height > 0)
        .map((b) => [b.top + y, b.bottom + y])
        .sort((a, b) => a[0] - b[0]);
      for (const b of boxes) {
        const last = panels.at(-1);
        if (last && b[0] <= last[1] + 2) last[1] = Math.max(last[1], b[1]);
        else panels.push([...b]);
      }
    }
    docH = Math.max(1, root.scrollHeight);
    ruler = vernier?.clientHeight ?? 0;
    // A sticky column taller than the viewport sticks by its bottom edge, so all of it can be seen.
    columns.forEach((col, i) => col.style.setProperty("--stick", `${Math.min(0, vh - heights[i])}px`));
    for (const s of spans) links.get(s.name)?.parentElement.style.setProperty("--at", `${((100 * s.top) / docH).toFixed(3)}%`);
    // The world measures its windows from this layout too, a frame later: a sticky column's new
    // offset only shows in the geometry the page reports once a frame has been drawn with it.
    requestAnimationFrame(() => bus.emit("layout"));
    read();
  }

  function read() {
    readQueued = false;
    if (!spans.length) return;
    const y = scrollY;
    const mid = y + vh / 2;
    let i = 0;
    for (let k = 0; k < spans.length; k++) if (spans[k].top <= mid) i = k;
    const s = spans[i];
    const start = i === 0 ? 0 : s.top - vh / 2;
    const next = spans[i + 1];
    const end = Math.min(next ? next.top - vh / 2 : docH - vh, docH - vh);
    const range = Math.max(1, end - start);
    const span = clamp((y - start) / range);
    const progress = clamp((y - start) / Math.max(1, (s.driving || range) * s.drive));
    // On stacked layouts text panels can fill the whole screen; nothing of the world shows then.
    const covered = panels.some(([top, bottom]) => top <= y && bottom >= y + vh);
    state.progress = progress;
    if (s.name !== current) {
      current = s.name;
      state.scene = current;
      root.dataset.scene = current;
      for (const [name, a] of links) {
        if (name === current) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      }
    }
    if (needle) needle.style.setProperty("--needle", `${((mid / docH) * ruler).toFixed(1)}px`);
    bus.emit("scroll", { scene: current, progress, span, drive: s.drive, y, vh, covered });
  }

  const queueRead = () => {
    if (readQueued) return;
    readQueued = true;
    requestAnimationFrame(read);
  };
  // Measurements wait until after the next paint, when the layout they read is already done.
  const queueMeasure = () => {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => setTimeout(measure, 0));
  };
  addEventListener("scroll", queueRead, { passive: true });
  addEventListener("resize", queueMeasure);
  // the page's height, and each sticky column's (its --stick depends on it: the worked example's
  // column changes height with its view)
  const resized = new ResizeObserver(queueMeasure);
  resized.observe(document.querySelector("main"));
  for (const col of columns) resized.observe(col);
  queueMeasure();
  // once fonts settle the text has its final size; asking for document.fonts while the boot script
  // runs would make the browser style the whole page there and then, so it waits for a frame
  requestAnimationFrame(() => setTimeout(() => document.fonts?.ready.then(queueMeasure), 0));
}

const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
