import { Scene } from "three";
import { createAnchors } from "./anchors.js";
import { BENCH, createBench } from "./bench.js";
import { createCameraRig, distanceFor, fitBox, fitDistance, project } from "./camera.js";
import { createClouds, TIERS } from "./clouds.js";
import { entropyFrame, entropyGeometry, plateMarks, PLATE } from "./compose.js";
import { bandAt, boxOnLeak, createGap, findGap, locate } from "./gap.js";
import { createCursor, createIrisMotion, createReadoutPlacer, readoutText } from "./iris.js";
import { createLattice } from "./lattice.js";
import { buildLayout, measureAt } from "./layout.js";
import { COOL, createMarks, DATA, INK, MUTED, WARM } from "./marks.js";
import { clamp, easeInOutCubic, LN2, smoothstep, spring, springStep, TAU } from "./math.js";
import { createPasses, createRenderer } from "./passes.js";
import { createPlate, REF_DEPTH } from "./plate.js";
import { createGpuTimer, createQuality } from "./quality.js";
import { blendPoses, createStations, createTransitions, IRIS_RATIO, newPose, POSE_KEYS, STATION_ORDER, stationCoordinate } from "./stations.js";
import { createWindows } from "./windows.js";

// The world: one fixed canvas behind the page, a photographic plate inside an instrument. Boot
// imports this lazily and calls start(); if start throws or "world:fallback" fires, the stills stay.

// The plate develops (exposure 0 -> 1 through the tone curve) while the JSD needle self-tests. With
// the hero's start poster on the page the page does that, from its first paint (CSS), and the world
// takes over from the poster's own composition, already developed; without one the world does it.
const DEVELOP = 1.6; // s
const DRIFT_AT = DEVELOP + 0.6; // s: a moment on the poster's state, then the drift
const DRIFT = 8; // s: the target's mass moves from the reference's clusters into its own
const IDLE_SLOW = 20; // s without input before an animated station drops to 30 fps
const ENERGY = 0.735; // light per particle, calibrated for the 12k tier on a 900 px tall desktop plate
const HALO_GAIN = 0.3;
// The leak's peak: #FF5A2B scaled in linear light so the band's centre reads at about 30% of ink's
// lightness, a glow and not a beam.
const LEAK_PEAK = 0.2;
const LEAK_SLEW = 0.5; // per second: the leak never changes faster than full scale in 2 s
const CORE = 0.0085; // world size of a sharp particle
const DRIFT_AMP = 0.022;
const PPU_REF = 205; // css px per world unit on the reference desktop plate
const LATTICE_ENERGY = 0.24; // light per particle once it has streamed into a lattice cell
const FILAMENT_ENERGY = 0.9;
// The auditor scene's scroll runs the featured audit over the second part of the station's arrival,
// so the arrived station (progress 1, for the rest of the scene) shows the audit's finished state.
const AUDIT_FROM = 0.4;

export async function start({ canvas, context = null, attributes = null, bus, state = {}, data = {}, options = {} }) {
  if (!canvas || !bus) throw new Error("world: start() needs the canvas and the bus");
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;

  let gpu;
  try {
    gpu = createRenderer(canvas, { ...options, context, attributes });
  } catch (error) {
    bus.emit("world:fallback", { reason: "webgl" });
    throw error;
  }
  const { renderer } = gpu;
  // Start-up yields to the page between steps, so no single task blocks input for long.
  await yieldToMain();
  const layout = buildLayout(data?.scan);
  const quality = createQuality({ win, options });
  const gpuTimer = createGpuTimer(renderer.getContext());
  quality.gpuTimed = gpuTimer.available;
  const clouds = createClouds(layout, TIERS[0]);
  await yieldToMain();
  const passes = createPasses(renderer, gpu.float);
  const U = clouds.uniforms;
  const C = passes.composite;
  const rig = createCameraRig();
  const particleScene = new Scene();
  particleScene.add(clouds.points);
  const plate = createPlate(layout, C);
  const gap = createGap();
  const stations = createStations();
  const transitions = createTransitions();
  const windows = createWindows(doc, win);
  const motion = createIrisMotion();
  const placer = createReadoutPlacer(doc.getElementById("iris-readout"));
  const anchors = createAnchors(doc);
  const marks = createMarks();
  // The worked example's plate, the oversight-gap lattice and the two benches (the featured audit for
  // the auditor scene, whatever the player loads for the replay).
  const plateFrame = entropyFrame(layout);
  const geometry = layout.hasScan ? entropyGeometry(layout, plateFrame) : null;
  const plateLines = geometry ? plateMarks(geometry) : null;
  const lattice = createLattice(data?.summary);
  lattice.writeUniforms(U);
  const auditBench = createBench(layout).setRun(data?.runs?.featured);
  const replayBench = createBench(layout);
  // The page brings its own registration-target cursor (#cursor); this one only stands in without it.
  const fine = win.matchMedia?.("(pointer: fine)").matches ?? true;
  const cursor = fine && !doc.getElementById("cursor") ? createCursor(doc) : null;

  const view = { w: 1, h: 1 };
  const ctx = {
    view,
    layout,
    zone: (scene) => windows.zone(scene, view),
    has: (scene) => windows.has(scene),
    fit: (radius, zone, fill) => fitDistance(radius, zone, view.h, fill),
    fitBox: (w, h, zone, fill) => fitBox(w, h, zone, view.h, fill),
    distanceFor: (ppu) => distanceFor(ppu, view.h),
    entropyFrame: plateFrame,
    bench: BENCH,
    lattice,
    iris: { open: 80, housing: 100 },
    timeline: { transfer: 0 },
    blur: 4,
  };
  const pointer = { x: -1, y: -1, nx: 0, ny: 0, inside: false, movedAt: -1e9, interactive: false, moved: false };
  const poseA = newPose();
  const poseB = newPose();
  const pose = newPose();
  const counts = { target: 0, reference: 0 };
  const anchorPoints = new Map();
  const iris = { x: 0, y: 0, aperture: 0, housing: 0, reach: 0 };
  const replayState = { run: null, index: -1, event: null, t: 0, playing: false, speed: 1, at: 0 };
  const scroll = { scene: state.scene ?? "hero", progress: state.progress ?? 0, span: 0, drive: 0.6 };
  const focus = spring(0);
  const stats = { frames: 0, avg: 0, dpr: 0, particles: 0, float: gpu.float, halation: true, distance: 0 };
  // For the stills (scripts/render-stills.mjs) and tests: pose keys forced after blending, and the
  // grain's strength (the stills carry less, since the page's own grain sits around them).
  const debug = { overrides: {}, grain: 1 };

  let reduced = !!state.reducedMotion;
  let time = 0;
  const fromPoster = !!doc.querySelector('.still__poster[data-poster="start"]');
  let timeline = reduced ? 1e3 : fromPoster ? DEVELOP : 0;
  let last = 0;
  let lastRender = 0;
  let raf = 0;
  let stopped = false;
  let disposed = false;
  let lost = false;
  let hidden = doc.visibilityState === "hidden";
  let onScreen = true;
  let stillDone = false;
  let dipUntil = 0;
  let dipTimer = 0;
  let pendingStation = null;
  let dominant = null;
  let blink = null; // "target" | "reference" once the entropy station's blink is in use; both until then
  let blinks = 0;
  let replayScan = null;
  let leakLevel = 0;
  let haloLevel = 0;
  let lastMeasure = null;
  let lastMeasureAt = 0;
  let lastIris = "";
  let lastInputAt = 0;
  let keyboard = false;
  let needsResize = true;
  let frames = 0;
  let wasIdle = false;
  let picked = null;
  let benchUsed = -1;
  let calm = false;
  let booted = false; // no frame until start-up has compiled and warmed everything
  let covered = false;
  let lastWeights = "";

  // What stations and their hooks see.
  const world = {
    layout,
    get replay() {
      return replayState;
    },
    gridFocus: null,
    // Extra projected labels: world.anchors.set("name", (frame) => ({ x, y })).
    anchors: anchors.extra,
    setReplayScan(scan) {
      replayScan = scan;
    },
  };

  function measureLayout() {
    view.w = Math.max(1, canvas.clientWidth || win.innerWidth);
    view.h = Math.max(1, canvas.clientHeight || win.innerHeight);
    windows.measure();
    const z = ctx.zone("hero");
    ctx.iris.open = clamp(Math.min(z.w, z.h) * 0.1, 38, 108);
    ctx.iris.housing = ctx.iris.open * IRIS_RATIO;
    const ppu = view.h / (2 * Math.tan((9 * Math.PI) / 180) * ctx.fitBox(layout.frame.w, layout.frame.h, z, 0.86));
    ctx.blur = clamp(3 + 0.016 * ppu, 4, 6.4);
    anchors.refresh();
    placer.invalidate();
  }

  function applyQuality() {
    passes.resize(view.w, view.h, quality.dpr);
    clouds.setTier(quality.particles);
    stats.dpr = quality.dpr;
    stats.particles = quality.particles;
    stats.halation = quality.halation;
    if (!quality.halation) passes.clearHalation();
  }

  function resize() {
    needsResize = false;
    measureLayout();
    applyQuality();
  }

  const projector = () => {
    const out = (x, y, z) => project(rig.camera, view, x, y, z, { x: 0, y: 0, depth: 1 });
    return out;
  };
  const toScreen = projector();

  // The auditor scene's clock: the scroll runs through the featured audit, from its first message to
  // the last reply that came back.
  function auditClock() {
    if (reduced) return auditBench.end;
    const i = STATION_ORDER.indexOf(scroll.scene);
    const k = STATION_ORDER.indexOf("auditor");
    if (i < k) return 0;
    if (i > k) return auditBench.end;
    return clamp((scroll.progress - AUDIT_FROM) / (1 - AUDIT_FROM)) * auditBench.end;
  }

  // The replay's clock, kept in step with the player's reports between them.
  function replayClock(now) {
    const s = replayState;
    if (!s.playing || reduced) return s.t;
    return s.t + (now - s.at) * s.speed;
  }

  const weightOf = (seg, name) => (name === seg.a ? 1 - seg.eased : name === seg.b ? seg.eased : 0);

  // ---- the frame -------------------------------------------------------------------------------

  function update(dt, now) {
    if (!reduced) time += dt;
    timeline += dt;
    windows.sync();
    const develop = reduced ? 1 : clamp(timeline / DEVELOP);
    const transfer = !layout.hasScan || reduced ? 1 : easeInOutCubic(clamp((timeline - DRIFT_AT) / DRIFT));
    ctx.timeline.transfer = transfer;

    // Stations: blend the two poses either side of the scroll position.
    const seg = transitions.update(dt);
    stations[seg.a].pose(poseA, ctx);
    stations[seg.b].pose(poseB, ctx);
    blendPoses(pose, poseA, poseB, seg.eased);
    // A clip holds its station's window while that station leads the move, then lets go, so the
    // other station's light comes in around it instead of a rectangle sliding across the page. A
    // window scrolled off the screen clips nothing: a station leaving with the page isn't hidden.
    const shown = (p) => {
      const w = Math.max(1, p.wx1 - p.wx0), h = Math.max(1, p.wy1 - p.wy0);
      const vis = (Math.max(0, Math.min(p.wx1, view.w) - Math.max(p.wx0, 0)) * Math.max(0, Math.min(p.wy1, view.h) - Math.max(p.wy0, 0))) / (w * h);
      return smoothstep(0.15, 0.6, vis);
    };
    const clipA = poseA.clip ? poseA.clip * smoothstep(0, 0.5, 1 - seg.eased) * shown(poseA) : 0;
    const clipB = poseB.clip ? poseB.clip * smoothstep(0, 0.5, seg.eased) * shown(poseB) : 0;
    pose.clip = Math.max(clipA, clipB);
    const keep = poseA.clip > 0 && poseB.clip > 0 ? null : poseA.clip > 0 ? poseA : poseB.clip > 0 ? poseB : null;
    if (keep) for (const k of ["wx0", "wy0", "wx1", "wy1"]) pose[k] = keep[k];
    for (const [k, v] of Object.entries(debug.overrides)) if (k in pose) pose[k] = v;
    const name = seg.eased < 0.5 ? seg.a : seg.b;
    if (name !== dominant) {
      const from = dominant;
      if (from) stations[from].exit?.(world, name);
      dominant = name;
      stations[name].enter?.(world, from);
    }
    // The page's figures for these stations arrive with them (see boot.js).
    const weights = `${seg.a}:${seg.eased.toFixed(2)}:${seg.b}`;
    if (weights !== lastWeights) {
      lastWeights = weights;
      bus.emit("station", { weights: { [seg.a]: smoothstep(0.5, 0.95, 1 - seg.eased), [seg.b]: smoothstep(0.5, 0.95, seg.eased) } });
    }
    const station = stations[dominant];
    station.update?.(world, state.progress ?? 0, dt);
    const midMove = reduced ? 0 : 5 * Math.sin(Math.PI * seg.t) ** 2; // defocus mid-move, sharp on arrival

    rig.update(pose, view, pointer, dt, time, reduced);
    const ppu = rig.pixelsPerUnit;
    stats.distance = rig.distance;

    // The plate: lobes, Atlas and the answers, projected; the gap between the clouds. The blink's
    // exposure applies on the measuring plate only, and stays as the page left it.
    const blinking = stations[dominant].blink ? blink : null;
    const showT = blinking === "reference" ? 0 : 1;
    const showR = blinking === "target" ? 0 : 1;
    const breath = Math.sin((TAU * time) / 12.5);
    plate.update({ camera: rig.camera, view, rig, pose, showT, showR, swell: 1 + 0.02 * breath * pose.breathe });
    findGap(gap, plate.lobesT, plate.lobesR, plate.massesT, plate.massesR, layout.axis);
    gap.active = layout.hasScan && gap.distance > 8;
    const measured = currentMeasure(transfer);
    const jsdShown = layout.hasScan ? measureAt(layout, pose.transfer).jsd : 0;

    // Light leak and halation follow the divergence actually on the plate, slew-limited to 2 s. A move
    // toward a station without them starts their fade as it begins, so no warm light crosses a
    // station that measures nothing; arriving at one, they come up once it is there.
    const intensity = (jsdShown / LN2) ** 1.2;
    const moving = seg.t > 0.001 && seg.t < 0.999;
    const leakGoal = moving ? Math.min(poseA.leak, poseB.leak) : pose.leak;
    const haloGoal = moving ? Math.min(poseA.halo, poseB.halo) : pose.halo;
    leakLevel = approach(leakLevel, layout.hasScan ? intensity * leakGoal : 0, LEAK_SLEW * dt, reduced);
    haloLevel = approach(haloLevel, layout.hasScan ? intensity * haloGoal : 0, LEAK_SLEW * dt, reduced);

    // The iris: follows in the hero, parks elsewhere, rides the bench, and in the oversight gap comes
    // over the cell the page points at. In reduced motion it sits over the gap.
    motion.update(dt, { zone: ctx.zone("hero"), gap, pointer, now: now / 1000, reach: ctx.iris.housing + 14, still: reduced });
    const follow = pose.follow;
    iris.x = pose.ix + (motion.x - pose.ix) * follow;
    iris.y = pose.iy + (motion.y - pose.iy) * follow;
    let housing = pose.housing;
    let irisOpacity = pose.irisOpacity;
    if (pose.irisBench > 0) {
      const s = toScreen(...auditBench.station);
      iris.x += (s.x - iris.x) * pose.irisBench;
      iris.y += (s.y - iris.y) * pose.irisBench;
    }
    const gapWeight = weightOf(seg, "gap");
    springStep(focus, world.gridFocus && gapWeight > 0.5 ? 1 : 0, reduced ? 60 : 9, dt);
    const focusCell = lattice.focus;
    let cellPlace = null;
    if (focusCell && focus.x > 0.001) {
      cellPlace = lattice.place(focusCell, toScreen);
      const k = clamp(focus.x) * gapWeight;
      iris.x += (cellPlace.x - iris.x) * k;
      iris.y += (cellPlace.y - iris.y) * k;
      housing += (cellPlace.r * IRIS_RATIO - housing) * k;
      irisOpacity = Math.max(irisOpacity, k);
    }
    const open = housing / IRIS_RATIO;
    const apertureGoal = cellPlace ? open + (Math.min(open, pose.aperture) - open) * (1 - clamp(focus.x) * gapWeight) : pose.aperture;
    iris.aperture = Math.min(open, apertureGoal) * (1 + (motion.stop - 1) * follow);
    iris.housing = housing;
    iris.reach = housing + 14;
    const closing = open > 0 ? 1 - iris.aperture / open : 1;
    plate.count(iris.x, iris.y, iris.aperture, counts);
    locate(gap, iris.x, iris.y);
    // Over the gap means where the plate shows the leak: the band's light at the iris's centre, after
    // the clouds clear it, at least a quarter of its peak.
    const [ft, fr] = plate.fieldAt(iris.x, iris.y);
    const clearAt = (1 - smoothstep(0.02, 0.3, ft)) * (1 - smoothstep(0.02, 0.3, fr));
    const overGap = gap.active && leakLevel > 0.05 && bandAt(gap, iris.x, iris.y) * clearAt >= 0.25;

    // ---- the marks: bench, plate and lattice ----
    const fade = smoothstep(0.35, 1, develop);
    marks.begin();
    marks.setView(view.w, view.h, quality.dpr, passes.size.plateScale);
    marks.setClip(pose.wx0, pose.wy0, pose.wx1, pose.wy1, pose.clip);
    marks.setFade(fade);
    const labels = new Map();
    const f = { project: toScreen, marks, energy: FILAMENT_ENERGY * passes.particleScale, irisReach: iris.housing, labels, beads: !reduced, now, instant: reduced };
    // The bench's marks leave in the first half of a move away and arrive in the second half of one in.
    const auditWeight = smoothstep(0.35, 1, weightOf(seg, "auditor"));
    if (auditWeight > 0) {
      const used = auditBench.draw(auditClock(), auditWeight, f);
      if (used !== benchUsed) {
        benchUsed = used;
        bus.emit("bench", { used, budget: auditBench.budget });
      }
    }
    const replayWeight = smoothstep(0.35, 1, weightOf(seg, "replay"));
    if (replayWeight > 0) replayBench.draw(replayClock(now), replayWeight, { ...f, labels: null });
    if (gapWeight > 0) {
      lattice.draw(gapWeight, f);
      lattice.labels(labels, f);
      if (cellPlace && focus.x > 0.5) {
        // The panel (up to 520 px wide, centred on its point) stays inside the lattice's window; a
        // hairline drops from it to the iris.
        const z = ctx.zone("gap");
        const half = Math.min(260, (view.w - 32) / 2);
        const x = clamp(iris.x, Math.min(z.x + half, z.x + z.w / 2), Math.max(z.x + z.w - half, z.x + z.w / 2));
        const top = iris.y - iris.housing - 22;
        labels.set("gap:readout", { x, y: top, visible: true, pin: true });
        marks.ink.line(iris.x, top, iris.x, iris.y - iris.housing - 4, { w: 0.5, c: MUTED, a: 0.9 * clamp(focus.x) });
      }
    }
    if (weightOf(seg, "target") > 0) targetLabels(labels);
    const plateWeight = pose.plateMarks;
    if (plateWeight > 0.002 && geometry) drawPlateMarks(plateWeight, labels);
    marks.end();

    // ---- uniforms ----
    const sweep = reduced ? 0 : pose.sweep * Math.sin((TAU * time) / 18);
    const energy = ENERGY * (ppu / PPU_REF) ** 2 * (TIERS[0] / quality.particles) * passes.particleScale;
    const irisShown = irisOpacity * smoothstep(0.35, 0.9, develop); // the iris develops in with the plate
    const bladeTurn = 0.2 + closing * 0.55;
    U.uClock.value.set(time, reduced ? 0 : breath * pose.breathe, reduced ? 0 : DRIFT_AMP * pose.breathe, pose.transfer);
    U.uView.value.set(view.w, view.h, passes.size.plateScale, ppu);
    U.uIris.value.set(iris.x, iris.y, iris.aperture * clamp(irisShown * 2), housing * clamp(irisShown * 2));
    U.uFocus.value.set(rig.distance + sweep, pose.insideFocus * ppu, pose.outsideBlur, 0.024 * ppu);
    U.uLevel.value.set(pose.targetLevel, pose.referenceLevel, pose.referenceBlur, midMove);
    U.uMix.value.set(pose.merge, showT, showR, energy);
    U.uExtra.value.set(REF_DEPTH, haloLevel, rig.distance, CORE);
    U.uBokeh.value.x = bladeTurn;
    U.uAtlas.value.w = layout.atlas.sigma * pose.atlasSize;
    U.uForm.value.set(pose.flat, pose.lattice, focusCell ? focusCell.index : -1, clamp(focus.x) * gapWeight);
    U.uField.value.set(pose.wx0, pose.wy0, pose.wx1, pose.wy1);
    U.uFormB.value.set(pose.field, lattice.column, LATTICE_ENERGY * (TIERS[0] / quality.particles), 0);

    const dip = dipUntil > now ? Math.abs(1 - 2 * clamp((dipUntil - now) / 200)) : 1;
    C.uView.value.w = time;
    C.uTone.value.x = pose.exposure * developCurve(develop) * dip;
    C.uTone.value.z = smoothstep(0, 0.55, develop);
    C.uTone.value.w = quality.halation ? HALO_GAIN : 0;
    const far = Math.max(
      Math.hypot(pose.sx, pose.sy), Math.hypot(view.w - pose.sx, pose.sy),
      Math.hypot(pose.sx, view.h - pose.sy), Math.hypot(view.w - pose.sx, view.h - pose.sy));
    C.uOptic.value.set(pose.sx, pose.sy, 0.3237 / Math.max(1, far), 0.035 * debug.grain); // cos^4: -18% at the far corner
    C.uGrainB.value.x = reduced ? 7 : Math.floor(time * 12);
    C.uIris.value.set(iris.x, iris.y, iris.aperture, housing);
    C.uIrisB.value.set(bladeTurn, irisShown, housing * 1.75, closing * (Math.PI / 3));
    C.uLeak.value.set(gap.x, gap.y, gap.ux, gap.uy);
    C.uLeakB.value.set(gap.width, gap.length, leakLevel * LEAK_PEAK, time * 0.05);
    C.uMarks.value.set(0.34 * pose.contours, 0.95 * pose.samples, 0.26 * pose.reticle * clamp(1 - pose.field), 0);
    C.uReseau.value.set(64, pose.reseauOut, pose.reseauIn, pose.reseauGrid);
    C.uField.value.set(pose.wx0, pose.wy0, pose.wx1, pose.wy1);
    C.uFieldB.value.set(pose.field, pose.clip, view.w / 2 + (pose.wx0 + 32 - view.w / 2) * pose.field, view.h / 2 + (pose.wy0 + 32 - view.h / 2) * pose.field);

    // ---- the page: the iris readout, the stand-in cursor, labels, the needles ----
    const readoutOn = pose.readout > 0.98 && irisOpacity > 0.5 && develop >= 1;
    const text = readoutOn ? readoutText({ inside: counts, overGap, jsd: jsdShown, settled: pose.transfer >= 1, hasScan: layout.hasScan }) : "";
    const readout = placer.place({
      x: iris.x, y: iris.y, reach: iris.reach, view, zone: ctx.zone("hero"), value: text,
      prefer: overGap ? "below" : gap.across * gap.ux < 0 ? "left" : "right",
      avoid: (l, t, w, h) => gap.active && leakLevel > 0.05 && boxOnLeak(gap, l, t, w, h),
      busy: (l, t, w, h) => plate.brightness(l, t, w, h),
    });
    const key = `${iris.x.toFixed(1)},${iris.y.toFixed(1)},${iris.aperture.toFixed(1)},${readout.x.toFixed(0)},${readout.y.toFixed(0)},${text}`;
    if (key !== lastIris) {
      lastIris = key;
      bus.emit("iris", { x: iris.x, y: iris.y, r: iris.aperture, text, reach: iris.reach, readout, visible: readoutOn });
    }
    cursor?.show(!reduced && !keyboard && !!station.cursor && pointer.inside && !pointer.interactive && seg.eased < 0.5);
    if (pointer.moved) pick(gapWeight);
    writeAnchors(seg, labels);
    emitMeasure(measured, now);
    calm = !!station.calm;
  }

  // The worked example's instrument marks, from the same geometry the SVG plate is drawn from:
  // leaders to the labels, the calipers, the field's registration targets, and after two blinks the
  // warm brackets around every cluster that jumped. Plate px map onto the entropy window.
  function drawPlateMarks(weight, labels) {
    const z = ctx.zone("entropy");
    const s = z.w / PLATE.w;
    const X = (x) => z.x + x * s;
    const Y = (y) => z.y + y * s;
    const ink = marks.ink;
    const k = clamp((weight - 0.7) / 0.3); // the marks come in once the plate has nearly arrived
    const seg = (list, o) => {
      for (const [x0, y0, x1, y1] of list) ink.line(X(x0), Y(y0), X(x1), Y(y1), o);
    };
    seg(plateLines.leaders, { w: 0.5, c: MUTED, a: 0.8 * k });
    seg(plateLines.target, { w: 0.5, c: INK, a: 0.9 * k });
    seg(plateLines.reference, { w: 0.5, c: COOL, a: 0.9 * k, dash: 4, duty: 0.55 });
    seg(plateLines.gap, { w: 0.6, c: WARM, a: 0.95 * k });
    seg(plateLines.drops, { w: 0.5, c: WARM, a: 0.4 * k, dash: 3, duty: 0.4 });
    if (blinks >= 2) seg(plateLines.brackets, { w: 0.8, c: WARM, a: 0.95 * k });
    for (const [x, y] of geometry.crosses) ink.target(X(x), Y(y), 3.2, { w: 0.5, c: DATA, a: 0.9 * k });
    for (const [name, a] of Object.entries(geometry.anchors)) labels.set(name, { x: X(a.x), y: Y(a.y), visible: k > 0.5 });
  }

  // Atlas's label under the body, and the sealed sleeve beside it in clear space: of a few spots
  // around Atlas inside the scene's window, the one with the least of either cloud under the sleeve
  // and its label (the anchor is the sleeve's left edge, halfway down the sleeve and label).
  function targetLabels(labels) {
    const a = plate.atlas;
    const r = Math.max(a.sx, a.sy);
    const z = ctx.zone("target");
    labels.set("atlas", { x: a.x, y: a.y + r * 2.7, visible: true });
    const W = Math.min(190, z.w * 0.5);
    const H = 96;
    let best = null;
    for (const [ox, oy] of [[1, -0.95], [1, 0.95], [1.15, 0], [-1, 0.95], [-1, -0.95]]) {
      const x = ox > 0 ? a.x + r * 2 * ox + 18 : a.x + r * 2 * ox - 18 - W;
      const y = a.y + r * 1.3 * oy;
      const left = clamp(x, z.x + 8, Math.max(z.x + 8, z.x + z.w - W - 8));
      const top = clamp(y - H / 2, z.y + 8, Math.max(z.y + 8, z.y + z.h - H - 8));
      const score = plate.brightness(left, top, W, H) + Math.abs(left - x) / 400;
      if (!best || score < best.score) best = { score, x: left, y: top + H / 2 };
    }
    labels.set("sleeve", { x: best.x, y: best.y, visible: true });
  }

  // The lattice cell under the pointer goes to the page, which treats it like hovering the table.
  function pick(gapWeight) {
    pointer.moved = false;
    let cell = null;
    if (gapWeight > 0.9 && pointer.x >= 0 && !pointer.interactive) {
      const z = ctx.zone("gap");
      const inZone = pointer.x >= z.x && pointer.x <= z.x + z.w && pointer.y >= z.y && pointer.y <= z.y + z.h;
      if (inZone) cell = lattice.pick(pointer.x, pointer.y, toScreen);
    }
    if (cell === picked) return;
    picked = cell;
    bus.emit("grid:pick", cell ? { auditor: cell.auditor, target: cell.target, tools: cell.tools } : null);
  }

  function currentMeasure(transfer) {
    const mode = stations[dominant]?.measure;
    if (mode === "none" && replayScan && dominant === "replay") return scanMeasure(replayScan);
    if (!layout.hasScan || mode !== "timeline" && mode !== "scan") return { jsd: 0, hTarget: 0, hReference: 0, mode: "no-scan" };
    if (mode === "scan") return { ...layout.measured, mode: "settled" };
    if (timeline < DEVELOP) {
      // the needle's self-test: one sweep to full scale and back before it reads
      const s = Math.sin((Math.PI * timeline) / DEVELOP) ** 2;
      const m = measureAt(layout, 0);
      return { jsd: s * LN2, hTarget: m.hTarget, hReference: m.hReference, mode: "settling" };
    }
    return { ...measureAt(layout, transfer), mode: transfer >= 1 ? "settled" : "settling" };
  }

  function scanMeasure(scan) {
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    return { jsd: n(scan.divergence), hTarget: n(scan.targetEntropy), hReference: n(scan.referenceEntropy), mode: "settled" };
  }

  function emitMeasure(m, now) {
    const p = lastMeasure;
    const changed = !p || p.mode !== m.mode || Math.abs(p.jsd - m.jsd) > 5e-4 || Math.abs(p.hTarget - m.hTarget) > 5e-4 || Math.abs(p.hReference - m.hReference) > 5e-4;
    if (!changed) return;
    if (p && p.mode === m.mode && m.mode === "settling" && now - lastMeasureAt < 33) return; // about 30 Hz
    lastMeasure = m;
    lastMeasureAt = now;
    bus.emit("measure", m);
  }

  // Labels for the station in play, visible for the dominant one (the page hides other scenes' too).
  function writeAnchors(seg, labels) {
    anchorPoints.clear();
    for (const [name, p] of labels) anchorPoints.set(name, p);
    for (const [name, fn] of anchors.extra) {
      const p = fn();
      if (p) anchorPoints.set(name, { x: p.x, y: p.y, visible: p.visible !== false });
    }
    const allowed = stations[dominant].anchors;
    for (const [name, p] of anchorPoints) if (!allowed(name)) p.visible = false;
    if (seg.t > 0.08 && seg.t < 0.92) for (const p of anchorPoints.values()) p.visible = false; // not mid-move
    anchors.write(anchorPoints, view);
  }

  function render() {
    gpuTimer.begin();
    passes.renderPlate(particleScene, rig.camera);
    if (marks.glow.count) passes.addToPlate(marks.glow.scene);
    if (quality.halation) passes.renderHalation();
    passes.renderComposite();
    if (marks.ink.count) passes.drawOver(marks.ink.scene);
    gpuTimer.end();
  }

  // ---- the loop ----------------------------------------------------------------------------------

  // Covered: on phones and tablets a text panel can fill the screen over the sticky world; then, as
  // when the shutter is closed, one frame renders and the loop waits for the panel to move off.
  const running = () => !stopped && !disposed && !lost && !hidden && onScreen && !reduced && !stillDone && !covered;

  function frame(now) {
    raf = 0;
    if (disposed || lost || stopped) return;
    // Without input for a while, an animated station drops to 30 fps: its 12.5 s breathing looks the
    // same. A replay playing back keeps the full rate, its beads run on the replay's clock.
    const idle = now / 1000 - lastInputAt > IDLE_SLOW && !(dominant === "replay" && replayState.playing);
    // A settled, still station (the measuring plate) only changes with the grain, at 12 fps.
    const slow = calm && transitions.settled && now / 1000 - lastInputAt > 1.5;
    if (running() && ((idle && now - lastRender < 30) || (slow && now - lastRender < 80))) {
      raf = win.requestAnimationFrame(frame);
      return;
    }
    if ((idle || slow) !== wasIdle) {
      quality.discard();
      wasIdle = idle || slow;
    }
    const interval = lastRender ? now - lastRender : 0;
    lastRender = now;
    const dt = last ? clamp((now - last) / 1000, 0, 0.1) : 1 / 60;
    last = now;
    if (needsResize) resize();
    const work = performance.now();
    placer.read();
    update(dt, now);
    render();
    const cpu = performance.now() - work;
    // the first frames carry shader warm-up, so the ladder ignores them; skipped frames don't count
    const gpu = gpuTimer.take();
    if (interval && running() && !idle && !slow && frames > 30 && quality.record({ now, interval, cpu, gpu })) needsResize = true;
    stats.frames = ++frames;
    stats.avg = quality.average;
    if (frames === 1) firstFrame();
    if (stations[dominant]?.still && transitions.settled && dipUntil <= now && leakLevel === 0 && haloLevel === 0) stillDone = true;
    // one loop only: an event during this frame may already have scheduled the next
    if ((running() || dipUntil > now) && !raf) raf = win.requestAnimationFrame(frame);
  }

  // Schedules a frame; when the loop is paused (reduced motion, the shutter closed) that is one still.
  function schedule() {
    if (raf || disposed || lost || stopped || !booted) return;
    if (!running()) last = 0;
    raf = win.requestAnimationFrame(frame);
  }

  function wake() {
    if (stillDone) {
      stillDone = false;
      last = 0;
    }
    schedule();
  }

  // three doesn't check shaders in production (see passes.js); a program that failed to link is
  // found here, once, after the first frame has compiled everything that was left.
  function firstFrame() {
    const gl = renderer.getContext();
    for (const program of renderer.info.programs ?? []) {
      if (program.program && !gl.getProgramParameter(program.program, gl.LINK_STATUS)) return fallback("shader");
    }
    bus.emit("world:ready", { particles: quality.particles, dpr: quality.dpr, float: gpu.float, reducedMotion: reduced });
    // the labels' boxes, now that the page lays them out for the world (and again once fonts load)
    anchors.refresh();
    doc.fonts?.ready.then(() => {
      if (disposed) return;
      needsResize = true;
      wake();
    });
  }

  function fallback(reason) {
    if (lost) return;
    lost = true;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    cursor?.show(false);
    bus.emit("iris", { x: 0, y: 0, r: 0, text: "", reach: 0, readout: { x: -9999, y: 0, side: "right" }, visible: false });
    bus.emit("world:fallback", { reason });
  }

  // ---- inputs ------------------------------------------------------------------------------------

  const interactive = "a, button, input, select, textarea, summary, label, [role=button], [tabindex]";
  function onPointerMove(e) {
    if (e.pointerType === "touch" && e.buttons === 0) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.nx = (e.clientX / view.w) * 2 - 1;
    pointer.ny = (e.clientY / view.h) * 2 - 1;
    // The world is fixed behind the page and the hero's framing is where its zone sits at the top of
    // the page, so the iris answers to that rectangle.
    const z = ctx.zone("hero");
    pointer.inside = e.clientX >= z.x && e.clientX <= z.x + z.w && e.clientY >= z.y && e.clientY <= z.y + z.h;
    pointer.interactive = !!e.target?.closest?.(interactive);
    pointer.movedAt = lastInputAt = performance.now() / 1000;
    pointer.moved = true;
    keyboard = false;
    if (cursor && e.pointerType !== "touch") cursor.move(e.clientX, e.clientY);
    if (dominant === "gap") wake();
  }
  function onPointerLeave() {
    pointer.inside = false;
    pointer.nx = 0;
    pointer.ny = 0;
    pointer.x = -1;
    pointer.moved = true;
  }
  function onKey(e) {
    lastInputAt = performance.now() / 1000;
    if (e.key === "Tab" || e.key?.startsWith("Arrow")) keyboard = true;
  }
  function onResize() {
    needsResize = true;
    windows.invalidate();
    wake();
  }
  function onVisibility() {
    hidden = doc.visibilityState === "hidden";
    if (!hidden) {
      last = 0;
      quality.discard();
      wake();
    }
  }

  const off = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    off.push(() => target.removeEventListener(type, fn, opts));
  };
  listen(win, "pointermove", onPointerMove, { passive: true });
  listen(doc.documentElement, "pointerleave", onPointerLeave, { passive: true });
  listen(win, "blur", onPointerLeave);
  listen(win, "keydown", onKey, { passive: true });
  listen(win, "resize", onResize, { passive: true });
  listen(doc, "visibilitychange", onVisibility);
  listen(canvas, "webglcontextlost", () => fallback("context-lost"));

  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) onScreen = entry.isIntersecting;
        if (onScreen) wake();
      })
    : null;
  io?.observe(canvas);

  const unsub = [
    bus.on("scroll", (d) => {
      lastInputAt = performance.now() / 1000;
      let uncovered = false;
      if (!!d?.covered !== covered) {
        covered = !!d?.covered;
        uncovered = !covered;
        last = 0;
        quality.discard();
        // covering renders one more frame and stops; uncovering resumes at once
        if (covered && booted && !raf) raf = win.requestAnimationFrame(frame);
      }
      scroll.scene = d?.scene ?? scroll.scene;
      scroll.progress = Number(d?.progress) || 0;
      scroll.span = Number(d?.span) || 0;
      scroll.drive = Number(d?.drive) || 0.6;
      const c = stationCoordinate(d?.scene, d?.progress);
      if (reduced) {
        // Scenes change with a 200 ms dip through the plate black instead of a camera move.
        const snapped = Math.round(c);
        if (snapped !== pendingStation && snapped !== transitions.goal) {
          pendingStation = snapped;
          dipUntil = performance.now() + 200;
          win.clearTimeout(dipTimer);
          dipTimer = win.setTimeout(() => {
            transitions.set(snapped, { snap: true });
            pendingStation = null;
            wake();
          }, 100);
        }
      } else {
        // behind a covering panel the world didn't move; it is where the scroll says when it shows
        transitions.set(c, { snap: uncovered });
        if (transitions.takeCut()) dipUntil = performance.now() + 220;
      }
      if (!covered) wake();
    }),
    bus.on("layout", () => {
      windows.invalidate();
      wake();
    }),
    bus.on("motion", (d) => {
      const next = !!d?.reduced;
      if (next === reduced) return;
      reduced = next;
      if (reduced) {
        timeline = Math.max(timeline, 1e3);
        transitions.set(Math.round(transitions.goal), { snap: true });
        motion.reset();
      } else {
        last = 0;
        quality.discard();
      }
      lastMeasure = null;
      wake();
    }),
    bus.on("blink", (d) => {
      blink = d?.state === "reference" ? "reference" : d?.state === "target" ? "target" : null;
      blinks = Math.max(blinks, Number(d?.count) || 0);
      lastInputAt = performance.now() / 1000;
      wake();
    }),
    bus.on("grid:focus", (d) => {
      world.gridFocus = d ?? null;
      lattice.focus = d ? lattice.byKey.get(`${d.tools}:${d.auditor}:${d.target}`) ?? null : lattice.focus;
      lastInputAt = performance.now() / 1000;
      wake();
    }),
    ...["replay:load", "replay:event", "replay:seek", "replay:state"].map((type) =>
      bus.on(type, (d) => {
        const now = performance.now();
        if (type === "replay:load") {
          Object.assign(replayState, { run: d?.run ?? null, index: -1, event: null, t: 0, at: now });
          replayBench.setRun(d?.run);
        }
        if (type === "replay:event") {
          Object.assign(replayState, { index: d?.index ?? -1, event: d?.event ?? null });
          // stay in step with the player's own clock
          const t = Number(d?.event?.t);
          if (Number.isFinite(t) && Math.abs(replayClock(now) - t) > 150) Object.assign(replayState, { t, at: now });
        }
        if (type === "replay:seek") Object.assign(replayState, { t: Number(d?.t) || 0, at: now });
        if (type === "replay:state") Object.assign(replayState, { playing: !!d?.playing, speed: Number(d?.speed) || 1, t: Number(d?.t) || 0, at: now });
        for (const s of Object.values(stations)) s.on?.[type]?.(d, world);
        wake();
      }),
    ),
  ];

  // ---- boot --------------------------------------------------------------------------------------

  await yieldToMain();
  measureLayout();
  applyQuality();
  needsResize = false;
  transitions.set(stationCoordinate(state.scene ?? "hero", state.progress ?? 0), { snap: true });
  try {
    const compile = new Scene();
    compile.add(clouds.points.clone(false));
    for (const s of passes.scenes) compile.add(s.children[0].clone(false));
    compile.add(marks.ink.scene.children[0].clone(false));
    compile.add(marks.glow.scene.children[0].clone(false));
    // Without KHR_parallel_shader_compile there is nothing to wait for (and three would warn).
    if (renderer.extensions.has("KHR_parallel_shader_compile")) await renderer.compileAsync(compile, rig.camera);
    else renderer.compile(compile, rig.camera);
  } catch {
    // compiling ahead is an optimisation; the first render compiles anything left
  }
  // Each program's uniforms and attributes are looked up with synchronous calls to the GPU process;
  // three does it lazily inside the first frame. Done here, a program per task, no task runs long.
  for (const program of renderer.info.programs ?? []) {
    await yieldToMain();
    try {
      program.getUniforms();
      program.getAttributes();
    } catch {
      // the first frame finds out
    }
  }
  await yieldToMain();
  // The display's own frame period, from a few frame callbacks with nothing to draw: the ladder
  // measures work against it, so a 30 or 50 Hz display isn't taken for a slow plate.
  quality.setPeriod(await framePeriod(win));
  booted = true;
  if (!disposed) {
    lastInputAt = performance.now() / 1000;
    if (!raf) raf = win.requestAnimationFrame(frame);
  }

  return {
    // Pauses the world for good (the canvas keeps its last frame).
    stop() {
      stopped = true;
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      cursor?.show(false);
    },
    // Releases everything: listeners, GPU resources, the stand-in cursor; the canvas is cleared so
    // the stills show through.
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) win.cancelAnimationFrame(raf);
      win.clearTimeout(dipTimer);
      raf = 0;
      for (const f of off) f();
      for (const u of unsub) u?.();
      io?.disconnect();
      windows.dispose();
      cursor?.dispose();
      anchors.dispose();
      gpuTimer.dispose();
      if (!lost) passes.clearCanvas();
      clouds.dispose();
      marks.dispose();
      passes.dispose();
      renderer.dispose();
    },
    // For tests and the stills: frame statistics, synchronous renders for GPU timing, where things
    // are on screen (css px), and pose keys to force (scripts/render-stills.mjs hides the plate's
    // marks for the blink stills, which the SVG draws over them).
    get stats() {
      return { ...stats, rung: { dpr: quality.dpr, particles: quality.particles }, period: quality.period, gpuTimer: gpuTimer.available, window: quality.window, station: dominant, reduced, marks: { ink: marks.ink.count, glow: marks.glow.count } };
    },
    debug,
    poseKeys: POSE_KEYS,
    renderFrames(n) {
      for (let i = 0; i < n; i++) render();
      return renderer.getContext().getError();
    },
    // Renders one frame and returns a region of it (css px) as a PNG data URL, in the same task, so
    // the drawing buffer is still there to read.
    capture({ x, y, w, h }) {
      update(0, performance.now());
      render();
      const k = canvas.width / view.w;
      const out = doc.createElement("canvas");
      out.width = Math.round(w * k);
      out.height = Math.round(h * k);
      out.getContext("2d").drawImage(canvas, Math.round(x * k), Math.round(y * k), out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    },
    redraw() {
      wake();
    },
    probe() {
      windows.sync(); // the page may have changed since the last frame (a view switched, a resize)
      const pick = (l) => ({ x: l.x, y: l.y, sx: l.sx, sy: l.sy, m: l.m });
      const points = {};
      for (const [name, p] of anchorPoints) points[name] = { x: p.x, y: p.y, visible: p.visible };
      return {
        gap: { x: gap.x, y: gap.y, width: gap.width, active: gap.active },
        target: plate.lobesT.map(pick),
        reference: plate.lobesR.map(pick),
        atlas: pick(plate.atlas),
        iris: { ...iris },
        zone: { ...ctx.zone("hero") },
        windows: Object.fromEntries(STATION_ORDER.map((s) => [s, ctx.zone(s)])),
        anchors: points,
        settled: transitions.settled,
      };
    },
  };
}

// The median interval between a dozen frame callbacks.
function framePeriod(win, count = 12) {
  return new Promise((resolve) => {
    const times = [];
    const tick = (now) => {
      times.push(now);
      if (times.length <= count) return win.requestAnimationFrame(tick);
      const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      resolve(gaps[gaps.length >> 1]);
    };
    win.requestAnimationFrame(tick);
    setTimeout(() => resolve(1000 / 60), 1000); // a hidden tab gets no frames
  });
}

// A macrotask boundary: scheduler.yield() where it exists, a zero-delay timeout elsewhere.
const yieldToMain = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

// The plate's characteristic development: slow in the toe, then quick, then settling.
const developCurve = (x) => (x >= 1 ? 1 : x * x * (3 - 2 * x));

function approach(value, goal, step, snap) {
  if (snap) return goal;
  return value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step);
}
