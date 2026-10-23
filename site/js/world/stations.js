import { clamp, lerp, spring, springStep, stationEase } from "./math.js";

// Every scene is a station in the same world. Scroll moves a continuous station coordinate through
// critically damped smoothing; between two stations the pose blends on cubic-bezier(0.65, 0, 0.35, 1),
// defocusing mid-move and refocusing on arrival.
//
// A station is { pose(p, c), measure, anchors, cursor?, blink?, still?, enter?, update?, exit?, on? }:
//   pose(p, c)    fills every POSE_KEYS entry of p (call base first); c gives zone(name), fit(radius,
//                 zone, fill), fitBox(w, h, zone, fill), distanceFor(ppu), layout, the entropy frame,
//                 the lattice, iris sizes, the hero timeline, view.
//   measure       "timeline" (the hero's development and drift), "scan" (the scan's settled values) or
//                 "none" (the needles read NO SCAN).
//   anchors       which of the page's data-anchor names this station places (a predicate).
//   cursor        the iris follows the pointer here; blink: the "blink" event switches the exposures;
//                 still: once settled, one last frame renders and the loop stops (the shutter).
//   enter(world, from), update(world, progress, dt), exit(world, to), on: { "<bus event>"(detail, world) }
// world = { layout, replay, gridFocus, anchors (a Map of name -> () => ({ x, y }) for extra labels), setReplayScan }

export const STATION_ORDER = ["hero", "target", "auditor", "entropy", "gap", "replay", "run", "references"];

const DEG = Math.PI / 180;
// Housing radius over the open aperture's inradius: the width of the blade ring when fully open.
export const IRIS_RATIO = 1.24;

// Every pose has exactly these keys; blending is per key.
export const POSE_KEYS = [
  // camera: look-at point, orbit angles, distance, the screen point the lens shift puts it on, how
  // much the pointer's parallax and the slow dolly apply
  "tx", "ty", "tz", "yaw", "pitch", "distance", "sx", "sy", "parallax", "dolly",
  // iris: follow the pointer (1) or park at ix, iy; aperture inradius and housing radius in css px;
  // irisBench pins it to the auditor's station on the bench
  "follow", "ix", "iy", "aperture", "housing", "irisOpacity", "irisBench",
  // clouds: levels, the reference's extra defocus (px), merge into Atlas, the hero's mass transfer,
  // breathing, flattening onto the plate, and streaming into the oversight-gap lattice
  "targetLevel", "referenceLevel", "referenceBlur", "merge", "transfer", "breathe", "flat", "lattice", "atlasSize",
  // measurement marks: light leak and halation gains, contours, sample marks, reticle, reseau
  "leak", "halo", "contours", "samples", "reticle", "reseauOut", "reseauIn", "reseauGrid",
  // instruments drawn as marks: the bench (rail, frames, filaments) and the plate's calipers
  "bench", "plateMarks",
  // the station's window (css px): a rectangular field that counts as inside the aperture, and a clip
  "wx0", "wy0", "wx1", "wy1", "field", "clip",
  // optics: exposure, bokeh px outside the aperture, blur inside it per world unit of depth off the
  // focal plane (as a fraction of the subject's px per unit), the focal plane's sweep (world units),
  // and whether the iris readout shows
  "exposure", "outsideBlur", "insideFocus", "sweep", "readout",
];

export const newPose = () => Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));

// The screen region a station frames its subject in, when the page gives it none: columns 6-12 of
// the 12-column grid on desktop, the top half on phones.
export function worldColumn(view) {
  if (view.w < 760) return { x: 16, y: view.h * 0.07, w: view.w - 32, h: view.h * 0.43 };
  const margin = 48;
  const col = (view.w - 2 * margin - 11 * 24) / 12;
  const x = margin + 5 * (col + 24);
  return { x, y: view.h * 0.1, w: view.w - margin - x, h: view.h * 0.8 };
}

const centre = (z) => [z.x + z.w / 2, z.y + z.h / 2];
const prefix = (...names) => (name) => names.some((n) => name === n || name.startsWith(`${n}:`));

// Shared look defaults, then each station overrides what it changes.
function base(p, c) {
  p.tx = 0; p.ty = 0; p.tz = 0; p.yaw = 0; p.pitch = 0; p.parallax = 1; p.dolly = 0;
  p.follow = 0; p.irisOpacity = 1; p.irisBench = 0;
  p.targetLevel = 1; p.referenceLevel = 0.7; p.referenceBlur = 0; p.merge = 0; p.transfer = 1;
  p.breathe = 1; p.flat = 0; p.lattice = 0; p.atlasSize = 1;
  p.leak = 0; p.halo = 0; p.contours = 0; p.samples = 0; p.reticle = 0;
  p.reseauOut = 0.015; p.reseauIn = 0.06; p.reseauGrid = 0.025;
  p.bench = 0; p.plateMarks = 0;
  p.wx0 = 0; p.wy0 = 0; p.wx1 = c.view.w; p.wy1 = c.view.h; p.field = 0; p.clip = 0;
  p.exposure = 1; p.outsideBlur = c.blur; p.insideFocus = 0.06; p.sweep = 0.8; p.readout = 0;
}

function windowOf(p, z) {
  p.wx0 = z.x; p.wy0 = z.y; p.wx1 = z.x + z.w; p.wy1 = z.y + z.h;
}

export function createStations() {
  return {
    hero: {
      cursor: true,
      measure: "timeline",
      anchors: () => false,
      pose(p, c) {
        base(p, c);
        const z = c.zone("hero");
        const f = c.layout.frame;
        [p.sx, p.sy] = centre(z);
        p.tx = f.x; p.ty = f.y;
        p.distance = c.fitBox(f.w, f.h, z, 0.86);
        p.dolly = 1;
        p.follow = 1;
        [p.ix, p.iy] = centre(z);
        p.aperture = c.iris.open;
        p.housing = c.iris.housing;
        p.transfer = c.timeline.transfer;
        p.leak = 1; p.halo = 1; p.contours = 1; p.samples = 1; p.reticle = 1; p.readout = 1;
      },
    },
    // A model with a secret: the reference fades back, the target's lobes merge into one body (Atlas),
    // nothing is measured, and the iris stops down to a pinhole at the left edge.
    target: {
      measure: "none",
      anchors: prefix("atlas", "sleeve"),
      pose(p, c) {
        base(p, c);
        const z = c.zone("target");
        [p.sx, p.sy] = centre(z);
        // Atlas sits left of centre, so the sleeve and its label fit beside it at every width (the
        // still rendered from this framing serves phones too)
        p.sx = z.x + z.w * (z.w < 560 ? 0.375 : 0.42);
        [p.tx, p.ty, p.tz] = c.layout.atlas.center;
        p.yaw = -5 * DEG; p.pitch = 3 * DEG;
        p.distance = c.fit(c.layout.atlas.sigma * 3.4, z, 0.6);
        p.housing = c.iris.housing * 0.62;
        p.aperture = 2.2;
        p.ix = z.x + p.housing + 14; p.iy = z.y + z.h * 0.5;
        p.referenceLevel = 0.15 * 0.7; p.referenceBlur = 5; p.merge = 1;
        p.outsideBlur = 7.5; p.sweep = 0.35;
      },
    },
    // The auditor: the optical bench in a three-quarter view, the iris at its station on the rail,
    // the run's conversations drawn as filaments as the scroll runs through the audit.
    auditor: {
      measure: "none",
      anchors: prefix("station", "rail", "thread"),
      pose: bench("auditor"),
    },
    // Entropy: straight down the long lens at the measuring field. The iris opens past the field's
    // edges and the field itself becomes the aperture; the plate is flattened and held still so the
    // blink is registered to the pixel.
    entropy: {
      measure: "scan",
      blink: true,
      calm: true,
      anchors: prefix("cluster", "caliper"),
      pose(p, c) {
        base(p, c);
        const z = c.zone("entropy");
        // The page shows the two plates side by side instead (motion off, or chosen): keep out of it.
        const shown = c.has("entropy") ? 1 : 0;
        const f = c.entropyFrame;
        const s = z.w / f.w;
        p.sx = z.x + f.cx * s; p.sy = z.y + f.cy * s;
        p.tx = f.x; p.ty = f.y; p.tz = 0;
        p.distance = c.distanceFor(f.ppu * s);
        p.parallax = 0; p.breathe = 0; p.flat = 1;
        windowOf(p, z);
        p.field = 1;
        [p.ix, p.iy] = centre(z);
        p.housing = Math.hypot(z.w, z.h) * 0.62;
        p.aperture = p.housing / IRIS_RATIO;
        p.irisOpacity = 0;
        p.leak = shown; p.halo = shown; p.contours = shown; p.samples = shown; p.plateMarks = shown;
        // with the plates side by side the field is the page's, so the world draws no grid behind it
        p.reseauOut = 0; p.reseauIn = 0.07 * shown; p.reseauGrid = 0;
        p.sweep = 0; p.insideFocus = 0.02; p.outsideBlur = 2;
        p.exposure = shown;
      },
    },
    // The oversight gap: the reseau lifts into the lattice and the clouds stream into its measured cells.
    gap: {
      measure: "none",
      anchors: prefix("gap"),
      pose(p, c) {
        base(p, c);
        const z = c.zone("gap");
        const L = c.lattice;
        // the lattice keeps clear of its labels: the targets' names at its left, the auditors' below
        const room = z.w < 560 ? 40 : Math.min(160, z.w * 0.28);
        const zl = { x: z.x + room, y: z.y, w: z.w - room, h: z.h - 34 };
        [p.sx, p.sy] = centre(zl);
        [p.tx, p.ty, p.tz] = L.center;
        p.yaw = L.yaw; p.pitch = L.pitch;
        p.distance = c.fitBox(L.half[0], L.half[1], zl, 0.94);
        p.parallax = 0.45; p.breathe = 0.25; p.lattice = 1;
        p.irisOpacity = 0; p.housing = c.iris.housing * 0.7; p.aperture = p.housing / IRIS_RATIO;
        [p.ix, p.iy] = centre(z);
        p.targetLevel = 1; p.referenceLevel = 1;
        p.reseauOut = 0; p.reseauIn = 0.03; p.reseauGrid = 0;
        p.outsideBlur = 1.4; p.insideFocus = 0.02; p.sweep = 0;
      },
    },
    // Watch an audit: back on the bench, inside the player; time comes from the replay, not the scroll.
    replay: {
      measure: "none",
      anchors: () => false,
      pose(p, c) {
        bench("replay")(p, c);
        windowOf(p, c.zone("replay"));
        p.clip = 1;
        p.parallax = 0.3;
        p.targetLevel = 0.5;
      },
      on: {
        "replay:event"(detail, world) {
          const e = detail?.event;
          if (e?.type === "scan_result" && e.scan) world.setReplayScan(e.scan);
        },
        "replay:load"(_, world) {
          world.setReplayScan(null);
        },
        "replay:seek"(detail, world) {
          const t = Number(detail?.t) || 0;
          const e = world.replay.run?.events?.findLast((x) => x.type === "scan_result" && x.t <= t);
          world.setReplayScan(e?.scan ?? null);
        },
      },
    },
    // Run it yourself: the shutter closes over the plate and, once settled, the loop renders one last
    // frame and stops.
    run: {
      measure: "none",
      still: true,
      anchors: () => false,
      pose: closed("run"),
    },
    references: { measure: "none", still: true, anchors: () => false, pose: closed("run") },
  };
}

// The optical bench (auditor and replay): a three-quarter view, Atlas at the right of the rail and
// the iris at its left station, open.
const bench = (name) => (p, c) => {
  base(p, c);
  const z = c.zone(name);
  [p.sx, p.sy] = centre(z);
  const a = c.layout.atlas.center;
  const b = c.bench;
  p.tx = a[0] - b.length / 2; p.ty = a[1] - b.drop * 0.42; p.tz = a[2];
  p.yaw = 52 * DEG; p.pitch = 9 * DEG;
  p.distance = c.fitBox(b.half[0], b.half[1], z, 0.94);
  p.housing = Math.max(26, Math.min(c.iris.housing * 0.8, Math.min(z.w, z.h) * 0.17));
  p.aperture = p.housing / IRIS_RATIO;
  p.ix = z.x + z.w * 0.2; p.iy = z.y + z.h * 0.45;
  p.irisBench = 1;
  // the reference measures nothing on the bench, so it isn't there
  p.referenceLevel = 0; p.referenceBlur = 5; p.merge = 1; p.atlasSize = 0.38; p.targetLevel = 0.52;
  p.outsideBlur = 6.5; p.sweep = 0.4; p.bench = 1;
  p.reseauOut = 0.012;
};

// The shutter closed: the blades shut over the plate and it drops to a quarter exposure.
const closed = (name) => (p, c) => {
  base(p, c);
  const z = c.zone(name);
  [p.sx, p.sy] = centre(z);
  [p.tx, p.ty, p.tz] = c.layout.atlas.center;
  p.distance = c.fit(c.layout.atlas.sigma * 2.6, z, 0.62);
  [p.ix, p.iy] = centre(z);
  p.housing = Math.min(z.w, z.h) * 0.42;
  p.aperture = 0;
  p.merge = 1; p.referenceLevel = 0; p.parallax = 0; p.breathe = 0; p.atlasSize = 0.8;
  p.exposure = 0.25;
  p.outsideBlur = 3; p.sweep = 0;
};

// Maps the DOM's scroll report to a station coordinate: inside scene k (k >= 1) the first part of
// the scroll drives the move from station k-1 into k, so the coordinate runs from k-1 to k.
export function stationCoordinate(scene, progress) {
  const i = STATION_ORDER.indexOf(scene);
  if (i <= 0) return 0;
  return i - 1 + clamp(Number(progress) || 0);
}

export function createTransitions() {
  const s = spring(0);
  let goal = 0;
  let cut = false;
  return {
    get goal() {
      return goal;
    },
    get value() {
      return s.x;
    },
    set(coordinate, { snap = false } = {}) {
      goal = coordinate;
      if (snap) {
        s.x = coordinate;
        s.v = 0;
      } else if (Math.abs(goal - s.x) > 1.5) {
        // A jump across several scenes (the nav, a reload mid-page) skips the stations between.
        s.x = goal - Math.sign(goal - s.x) * 0.75;
        s.v = 0;
        cut = true;
      }
    },
    // A cut is reported once so the world can mask it with a short defocus.
    takeCut() {
      const c = cut;
      cut = false;
      return c;
    },
    get settled() {
      return Math.abs(goal - s.x) < 0.0015 && Math.abs(s.v) < 0.002;
    },
    update(dt) {
      springStep(s, goal, 4.6, dt);
      if (Math.abs(goal - s.x) < 1e-4 && Math.abs(s.v) < 1e-4) {
        s.x = goal;
        s.v = 0;
      }
      const x = clamp(s.x, 0, STATION_ORDER.length - 1);
      const a = Math.min(Math.floor(x), STATION_ORDER.length - 2);
      const t = x - a;
      return { a: STATION_ORDER[a], b: STATION_ORDER[a + 1], t, eased: stationEase(t) };
    },
  };
}

export function blendPoses(out, pa, pb, t) {
  for (const k of POSE_KEYS) out[k] = lerp(pa[k], pb[k], t);
  return out;
}
