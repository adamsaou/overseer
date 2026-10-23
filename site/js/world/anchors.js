// Projected labels: DOM elements with data-anchor="<name>" that follow points in the world. They
// move with translate3d only, and nothing reads layout in the loop: each label's box (its body's
// offset and size around its point) is measured when the layout is, on resize. Positions are clamped
// inside the viewport (16 px margin) so a label stays readable at the sides, and a label that would
// print over one placed before it (page order is priority) moves up or down out of its way, or stays
// hidden. A point that has scrolled off the top or bottom takes its label with it: pinned to the edge,
// it would print over whatever text is there (a plate below the fold, its letters on the caption
// above it). Only a point marked `pin` (the hover readout) is kept on screen. The names are the
// page's (see the comment in js/bus.js); the stations work out where they go.

const MAX_VISIBLE = 24;
const MARGIN = 16;
const PAD = 3;

export function createAnchors(doc) {
  let elements = [];
  const state = new Map();
  const boxes = new Map();
  const extra = new Map(); // name -> fn() returning { x, y, visible? } or null, registered by stations
  const overlaps = (a, b) => a.l < b.r + PAD && b.l < a.r + PAD && a.t < b.b + PAD && b.t < a.b + PAD;
  return {
    extra,
    refresh() {
      elements = [...doc.querySelectorAll("[data-anchor]")];
      boxes.clear();
      for (const el of elements) {
        const body = el.firstElementChild;
        // the hover readout changes size with its text; it sits above the rest anyway
        if (!body || el.dataset.anchor === "gap:readout") continue;
        const a = el.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) boxes.set(el, { dx: b.left - a.left, dy: b.top - a.top, w: b.width, h: b.height });
      }
    },
    // points: Map of name -> { x, y, visible } in css px
    write(points, view) {
      let shown = 0;
      const placed = [];
      for (const el of elements) {
        const p = points.get(el.dataset.anchor);
        let visible = !!p && p.visible && shown < MAX_VISIBLE && (p.pin || (p.y >= 0 && p.y <= view.h));
        let s = state.get(el);
        if (!s) state.set(el, (s = { visible: null, transform: "" }));
        let x = 0;
        let y = 0;
        if (visible) {
          x = Math.min(view.w - MARGIN, Math.max(MARGIN, p.x));
          y = Math.min(view.h - MARGIN, Math.max(MARGIN, p.y));
          const b = boxes.get(el);
          if (b) {
            let box = { l: x + b.dx, t: y + b.dy, r: x + b.dx + b.w, b: y + b.dy + b.h };
            const hit = placed.find((o) => overlaps(o, box));
            if (hit) {
              const down = hit.b + PAD - box.t;
              const up = box.b + PAD - hit.t;
              const dy = down <= up ? down : -up;
              const moved = { l: box.l, r: box.r, t: box.t + dy, b: box.b + dy };
              if (Math.abs(dy) <= 36 && !placed.some((o) => overlaps(o, moved))) {
                y += dy;
                box = moved;
              } else visible = false;
            }
            if (visible) placed.push(box);
          }
        }
        if (visible) {
          shown++;
          const transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
          if (transform !== s.transform) {
            s.transform = transform;
            el.style.transform = transform;
          }
        }
        if (visible !== s.visible) {
          s.visible = visible;
          el.dataset.anchorVisible = visible ? "true" : "false";
          // parked off-screen like the page's own CSS does, so a hidden label never lingers in place
          if (!visible) {
            el.style.transform = "translate3d(-200vw, 0, 0)";
            s.transform = "";
          }
        }
      }
    },
    dispose() {
      for (const el of elements) {
        delete el.dataset.anchorVisible;
        el.style.transform = "";
      }
      elements = [];
      state.clear();
      boxes.clear();
      extra.clear();
    },
  };
}
