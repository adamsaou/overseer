import { STATION_ORDER, worldColumn } from "./stations.js";

// Where each station frames its subject, in viewport px. The page marks one rectangle per scene with
// [data-world-window="<scene>"] (the hero's is its [data-cloud-zone]):
//   - the hero keeps the rectangle it has at the top of the page, so the clouds hold still while the
//     headline scrolls away and the next scene takes over; on stacked layouts (phones, tablets), where
//     the headline sits under the clouds, they scroll away together instead;
//   - a window in a sticky column is followed as the column comes in and sticks; when the next scene
//     is sticky too it is held where it stuck once the column scrolls away, so the leaving station
//     stays on screen while the camera moves to the next one, and otherwise (notes or a scene that
//     scrolls follow) it leaves with its column, exactly as the page moves it;
//   - any other window (the entropy plate on phones, the replay's bench) follows the page exactly.
// None of this reads layout per frame: layout is measured on resize (and when the page's size
// changes), and each frame works out the window's place from scrollY.
// Scenes without a window use columns 6-12 on desktop and the top half on phones.

export function createWindows(doc, win) {
  const found = new Map();
  let dirty = true;
  // scrollY once a frame: read after the page has written styles in the same frame, it would make
  // the browser restyle there and then
  let scroll = win.scrollY;
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => (dirty = true)) : null;
  const main = doc.querySelector("main");
  if (main) observer?.observe(main);

  function element(scene) {
    if (scene === "hero") return doc.querySelector("#hero [data-cloud-zone]") ?? doc.querySelector('[data-world-window="hero"]');
    return doc.querySelector(`[data-world-window="${scene}"]`);
  }

  function stickyAncestor(el) {
    for (let node = el.parentElement; node && node !== doc.body; node = node.parentElement) {
      if (win.getComputedStyle(node).position === "sticky") return node;
    }
    return null;
  }

  // Reads layout: only on resize and when the page's size changed.
  function measure() {
    dirty = false;
    found.clear();
    const y = win.scrollY;
    for (const scene of STATION_ORDER) {
      const el = element(scene);
      if (!el) continue;
      // a window that is hidden now (the entropy plate in the side-by-side view) may come back
      observer?.observe(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (scene === "hero") {
        const stacked = win.innerWidth < 1100;
        found.set(scene, { kind: stacked ? "page" : "held", x: r.left, top: r.top + y, w: r.width, h: r.height });
        continue;
      }
      const sticky = stickyAncestor(el);
      if (sticky) {
        // A sticky box sits at its natural place (the top of its block here) until it reaches its
        // `top`, holds there, and leaves with the block's bottom edge.
        const s = sticky.getBoundingClientRect();
        const block = sticky.parentElement;
        const parent = block.getBoundingClientRect();
        const next = block.nextElementSibling ?? block.closest("section")?.nextElementSibling ?? null;
        const holds = !!next?.classList.contains("scene--sticky");
        found.set(scene, {
          kind: "sticky",
          x: r.left,
          w: r.width,
          h: r.height,
          inside: r.top - s.top,
          natural: parent.top + y,
          stick: parseFloat(win.getComputedStyle(sticky).top) || 0,
          // where the column's top is (page px) when its block lets it go, unless it is held
          release: holds ? Infinity : parent.bottom + y - s.height,
        });
      } else {
        found.set(scene, { kind: "page", x: r.left, top: r.top + y, w: r.width, h: r.height });
      }
    }
  }

  return {
    measure,
    // Cheap, per frame: re-measures only after a resize of the page.
    sync() {
      scroll = win.scrollY;
      if (dirty) measure();
    },
    invalidate() {
      dirty = true;
    },
    // Whether the page shows this scene's window at all right now.
    has(scene) {
      return found.has(scene);
    },
    zone(scene, view) {
      const w = found.get(scene);
      if (!w) return scene === "hero" ? heroFallback(view) : worldColumn(view);
      const y = scroll;
      if (w.kind === "held") return { x: w.x, y: w.top, w: w.w, h: w.h };
      if (w.kind === "page") return { x: w.x, y: w.top - y, w: w.w, h: w.h };
      // A sticky window is followed as it comes in and holds where it stuck as its column leaves,
      // so the subject stays on screen while the camera moves on to the next station.
      const top = Math.min(Math.max(w.natural - y, w.stick), w.release - y);
      return { x: w.x, y: top + w.inside, w: w.w, h: w.h };
    },
    dispose() {
      observer?.disconnect();
    },
  };
}

// Without the page's zone: the right 60% on desktop, the top 55% on phones.
function heroFallback(view) {
  return view.w < 760 ? { x: 0, y: 0, w: view.w, h: view.h * 0.55 } : { x: view.w * 0.4, y: 0, w: view.w * 0.6, h: view.h };
}
