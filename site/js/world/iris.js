import { clamp, LN2, smoothstep, spring, springStep, TAU } from "./math.js";

// The auditor's iris: a critically damped slew to the pointer (about 1 s, no overshoot), stopping
// down 30% while it moves, and after 4 s without input a slow Lissajous survey (23 s by 31 s) that
// lingers wherever it crosses the gap. It never leaves the cloud zone.

const OMEGA = 5.8; // settles in about one second
const IDLE = 4;

export function createIrisMotion() {
  const x = spring(-1);
  const y = spring(-1);
  const moving = spring();
  let survey = 0; // the survey's own clock, slowed over the gap
  let placed = false;
  return {
    x: 0,
    y: 0,
    stop: 1, // aperture factor: 1 open, 0.7 stopped down
    surveying: false,
    reset() {
      placed = false;
    },
    update(dt, ctx) {
      const { zone, gap, pointer, now, reach, still } = ctx;
      const minX = zone.x + reach, maxX = zone.x + zone.w - reach;
      const minY = zone.y + reach, maxY = zone.y + zone.h - reach;
      const cx = (zone.x + zone.x + zone.w) / 2, cy = (zone.y + zone.y + zone.h) / 2;
      const fit = (v, lo, hi, c) => (lo > hi ? c : clamp(v, lo, hi));
      let tx, ty;
      const following = pointer.inside && now - pointer.movedAt < IDLE;
      this.surveying = !following;
      if (still) {
        tx = gap.x;
        ty = gap.y;
      } else if (following) {
        tx = pointer.x;
        ty = pointer.y;
      } else {
        // Dwell: the survey clock runs at a quarter speed while the path is over the gap band.
        const over = gap.active ? Math.exp(-0.5 * (gap.across / Math.max(14, gap.width * 5)) ** 2) : 0;
        survey += dt * (1 - 0.78 * over);
        const ax = Math.max(0, (maxX - minX) / 2) * 0.62;
        const ay = Math.max(0, (maxY - minY) / 2) * 0.55;
        const ox = fit(gap.x, minX, maxX, cx), oy = fit(gap.y, minY, maxY, cy);
        tx = ox + ax * Math.sin((TAU * survey) / 23);
        ty = oy + ay * Math.sin((TAU * survey) / 31);
      }
      tx = fit(tx, minX, maxX, cx);
      ty = fit(ty, minY, maxY, cy);
      if (!placed || still) {
        x.x = tx; y.x = ty; x.v = 0; y.v = 0;
        placed = true;
      } else {
        springStep(x, tx, OMEGA, dt);
        springStep(y, ty, OMEGA, dt);
      }
      const speed = Math.hypot(x.v, y.v);
      springStep(moving, still ? 0 : smoothstep(40, 520, speed), 6, dt);
      this.x = x.x;
      this.y = y.x;
      this.stop = 1 - 0.3 * clamp(moving.x);
      return this;
    },
  };
}

// Names the gap when the iris's centre sits on the leak (the band's light at least a quarter of its
// peak there), and otherwise counts the eight real answers inside the aperture. While the plate is
// still developing it prints no divergence: there is no measurement to print yet.
export function readoutText({ inside, overGap, jsd, settled, hasScan }) {
  if (!hasScan) return "NO SCAN";
  if (overGap) {
    if (!settled) return "GAP\nmeasuring";
    const max = Math.abs(jsd - LN2) < 0.005;
    return `GAP · JSD ${jsd.toFixed(2)} nats${max ? " · maximum" : ""}`;
  }
  // two short lines rather than one long one, so the readout finds room beside the iris off the leak
  return `ANSWERS IN APERTURE\ntarget ${inside.target} · reference ${inside.reference}`;
}

// Where #iris-readout should sit. The page writes the element from the "iris" event; the world only
// suggests a place beside the instrument: inside the cloud zone (never over the headline), never on
// the light leak, and over the darkest part of the plate it can find, so the text stays legible; on
// phones it prefers the spot under the iris. The element's width is read once per new text, at the
// start of a frame, before anything is written.
export function createReadoutPlacer(el) {
  let text = null;
  let width = 0;
  let height = 0;
  let measure = false;
  el?.ownerDocument?.fonts?.ready.then(() => (measure = true));
  return {
    // the readout's size changes with the page's type (phones set labels larger): measure it again
    invalidate() {
      measure = true;
    },
    read() {
      if (measure && el) {
        width = el.offsetWidth || width;
        height = el.offsetHeight || height;
        measure = false;
      }
    },
    place({ x, y, reach, view, zone, value, prefer = "right", avoid = () => false, busy = () => 0 }) {
      if (value !== text) {
        text = value;
        measure = true;
      }
      const lines = value.split("\n");
      const w = width || Math.max(...lines.map((l) => l.length)) * 7.4;
      const h = height || lines.length * 16;
      const d = reach * 0.72; // diagonal spots sit off the ring at 45 degrees
      const spots = {
        right: [x + reach + 22, y - h / 2],
        left: [x - reach - 22 - w, y - h / 2],
        above: [x - w / 2, y - reach - 12 - h],
        below: [x - w / 2, y + reach + 10],
        "above-right": [x + d + 8, y - d - 8 - h],
        "below-right": [x + d + 8, y + d + 8],
        "above-left": [x - d - 8 - w, y - d - 8 - h],
        "below-left": [x - d - 8 - w, y + d + 8],
      };
      const first = view.w < 640 ? "below" : prefer;
      const area = zone ?? { x: 0, y: 0, w: view.w, h: view.h };
      // keep clear of the frame and the scales the page draws inside its right and bottom edges
      const edge = view.w < 760 ? 16 : 72;
      const fits = ([l, t]) =>
        l >= Math.max(area.x, 16) && t >= Math.max(area.y, 16) && l + w <= Math.min(area.x + area.w, view.w - edge) && t + h <= Math.min(area.y + area.h, view.h - edge);
      let side = "below";
      let best = Infinity;
      for (const [k, spot] of Object.entries(spots)) {
        if (!fits(spot) || avoid(spot[0], spot[1], w, h)) continue;
        const score = busy(spot[0], spot[1], w, h) + (k === first ? 0 : 0.08);
        if (score < best) {
          best = score;
          side = k;
        }
      }
      if (best === Infinity) side = Object.keys(spots).find((k) => fits(spots[k])) ?? "below";
      const [l, t] = spots[side];
      return { x: clamp(l, 16, Math.max(16, view.w - 16 - w)), y: t, side };
    },
  };
}

// The 24px registration-target cursor, on fine pointers and only over the cloud zone. Links and
// buttons keep the native pointer, and keyboard focus hides it so it never covers a focus ring.
export function createCursor(doc) {
  const el = doc.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.className = "world-cursor";
  el.style.cssText =
    "position:fixed;left:0;top:0;width:24px;height:24px;margin:-12px 0 0 -12px;pointer-events:none;" +
    "z-index:2147483000;opacity:0;transition:opacity .18s linear;color:#E8EAE6;will-change:transform";
  el.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-opacity=".85" stroke-width="1" shape-rendering="geometricPrecision">' +
    '<circle cx="12" cy="12" r="3"/><path d="M12 0v7.5M12 16.5V24M0 12h7.5M16.5 12H24"/></svg>';
  const style = doc.createElement("style");
  // In a cascade layer, so any cursor the site's own CSS sets on an element still wins.
  style.textContent =
    "@layer overseer-world{html[data-world-cursor] body,html[data-world-cursor] body *:not(a,button,input,select,textarea,summary,label,[role=button],[tabindex],a *,button *,label *,summary *){cursor:none}}";
  doc.head.appendChild(style);
  doc.body.appendChild(el);
  let on = false;
  return {
    move(x, y) {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    },
    show(visible) {
      if (visible === on) return;
      on = visible;
      el.style.opacity = visible ? "1" : "0";
      if (visible) doc.documentElement.setAttribute("data-world-cursor", "");
      else doc.documentElement.removeAttribute("data-world-cursor");
    },
    dispose() {
      doc.documentElement.removeAttribute("data-world-cursor");
      el.remove();
      style.remove();
    },
  };
}
