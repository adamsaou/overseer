import { TIERS } from "./clouds.js";

// The adaptive ladder: device pixel ratio (1.5, 1.25, 1.0, 0.75), then the particle tier (2x12k,
// 2x6k, 2x3k). It reads what a frame costs, not how often frames arrive: the time update and render
// take on the main thread and, where EXT_disjoint_timer_query_webgl2 exists, on the GPU, against the
// display's own frame period. A display that delivers frames at 30, 48 or 50 Hz (low-power modes,
// capped or remote screens) is not a slow GPU, and a hitch from a script or a fast scroll is not one
// either. Every second (or 60 frames) it looks at the window:
//   - steps down when, two windows running, the work takes more than 80% of the period, or frames
//     keep missing their deadline (a quarter of them late by half a period) and the GPU isn't known
//     to be mostly idle;
//   - steps up after 5 s of work under 45% of the period with almost no late frames, no sooner than
//     10 s after a drop; a rung that dropped again within 10 s of being climbed to is not tried again.
// Frames slower than a quarter second count (as late frames), so a very slow renderer steps down too.

const STEP_DOWN = 0.8;
const STEP_UP = 0.45;
const LATE = 1.5;
const WINDOW_MS = 1000;
const WINDOW_FRAMES = 60;
const RECOVER = 5000;
const SETTLE_AFTER_DROP = 10000;

export function createQuality({ win = globalThis, options = {} } = {}) {
  const deviceDpr = Math.max(0.5, win.devicePixelRatio || 1);
  const coarse = win.matchMedia?.("(pointer: coarse)").matches ?? false;
  const cores = win.navigator?.hardwareConcurrency || 4;
  const memory = win.navigator?.deviceMemory || 8;

  // The art direction's top rung is 1.5: a 2x screen renders at 1.5 and the composite upsamples.
  const top = Math.min(deviceDpr, 1.5);
  const dprs = [...new Set([top, 1.25, 1, 0.75].filter((d) => d <= top + 1e-6))];
  const pick = (cap) => Math.max(0, dprs.findIndex((d) => d <= cap + 1e-6));

  let d = 0;
  let t = 0;
  if (coarse) {
    t = cores >= 6 && memory >= 4 ? 1 : 2;
    d = pick(1.5);
  } else if (cores < 4 || memory < 4) {
    t = 1;
    d = pick(1.25);
  }
  if (options.tier != null) t = Math.max(0, Math.min(TIERS.length - 1, options.tier));
  if (options.dpr != null) d = pick(options.dpr);
  const adaptive = options.ladder !== false;

  // One rung index over both ladders: 0 is the best, the last is 0.75 DPR with the smallest tier.
  const rungs = dprs.length + TIERS.length - 1;
  const rung = () => d + t;
  const setRung = (r) => {
    d = Math.min(r, dprs.length - 1);
    t = r - d;
  };

  let period = 1000 / 60;
  let ceiling = 0; // the best rung still worth trying
  let lastDrop = -Infinity;
  let lastClimb = -Infinity;
  let climbedFrom = -1;
  let goodFor = 0;
  let strikes = 0;
  let w = fresh();
  let average = 0;

  function fresh() {
    return { start: -1, frames: 0, late: 0, cpu: 0, gpu: 0, gpuFrames: 0, intervals: [] };
  }

  function step(now, by) {
    const before = rung();
    const next = Math.max(ceiling, Math.min(rungs - 1, before + by));
    if (next === before) return false;
    if (by > 0) {
      // a rung that drops again right after being climbed to isn't tried again
      if (now - lastClimb < SETTLE_AFTER_DROP && climbedFrom === next) ceiling = Math.max(ceiling, next);
      lastDrop = now;
    } else {
      lastClimb = now;
      climbedFrom = before;
    }
    setRung(next);
    goodFor = 0;
    return true;
  }

  const quality = {
    coarse,
    // set by the world when the context can time the GPU: late frames then aren't read as GPU cost
    gpuTimed: false,
    // the last window's figures, for the stats
    window: null,
    get dpr() {
      return options.dpr != null ? Math.min(options.dpr, deviceDpr) : dprs[d];
    },
    get tier() {
      return t;
    },
    get particles() {
      return TIERS[t];
    },
    // The lowest tier drops halation: the analytic light leak carries the measurement there.
    get halation() {
      return t < TIERS.length - 1;
    },
    get period() {
      return period;
    },
    // The last window's work per frame (ms): the GPU's where it was measured, else the main thread's.
    get average() {
      return average;
    },
    // The display's frame period, from frame callbacks with nothing to draw.
    setPeriod(ms) {
      if (ms > 4 && ms < 70) period = ms;
    },
    // One rendered frame: interval since the last one, main-thread work, and GPU time when known (it
    // arrives a few frames late; null otherwise). Returns true when the rung changed.
    record({ now, interval, cpu, gpu = null }) {
      if (!adaptive || !(interval > 0)) return false;
      if (interval > 2000) return quality.discard(), false; // a stall or a background tab, not a frame
      if (w.start < 0) w.start = now;
      w.frames++;
      w.cpu += cpu;
      if (gpu != null) {
        w.gpu += gpu;
        w.gpuFrames++;
      }
      if (interval > period * LATE) w.late++;
      w.intervals.push(interval);
      if (w.frames < WINDOW_FRAMES && now - w.start < WINDOW_MS) return false;
      const span = now - w.start;
      const cpuAvg = w.cpu / w.frames;
      const gpuAvg = w.gpuFrames ? w.gpu / w.gpuFrames : null;
      // with a GPU timer, a window it hasn't reported on yet (the first frames) says nothing
      if (quality.gpuTimed && gpuAvg == null) {
        w = fresh();
        return false;
      }
      const late = w.late / w.frames;
      const median = w.intervals.sort((a, b) => a - b)[w.intervals.length >> 1];
      w = fresh();
      average = gpuAvg ?? cpuAvg;
      quality.window = { cpu: +cpuAvg.toFixed(2), gpu: gpuAvg == null ? null : +gpuAvg.toFixed(2), late: +late.toFixed(2), median: +median.toFixed(1), period: +period.toFixed(1) };
      const load = Math.max(cpuAvg, gpuAvg ?? 0) / period;
      // A steady cadence slower than the period with light work is the display, not the plate.
      if (late > 0.75 && load < STEP_UP && gpuAvg != null) {
        period = median;
        return false;
      }
      // ...and a faster one means the display got faster (another screen, power restored).
      if (median < period * 0.8) period = median;
      const gpuBusy = gpuAvg == null || gpuAvg / period > 0.6;
      // two slow windows in a row, so a burst of contention (a scroll, another tab) isn't a slow plate
      if (load > STEP_DOWN || (late > 0.25 && gpuBusy)) {
        if (++strikes >= 2) return (strikes = 0), step(now, 1);
        return false;
      }
      strikes = 0;
      if (load < STEP_UP && late < 0.05) {
        goodFor += span;
        if (goodFor >= RECOVER && now - lastDrop >= SETTLE_AFTER_DROP && rung() > ceiling) return step(now, -1);
      } else goodFor = 0;
      return false;
    },
    // Frames that were deliberately skipped (idle 30 fps) or interrupted must not count.
    discard() {
      w = fresh();
      goodFor = 0;
      strikes = 0;
    },
  };
  return quality;
}

// GPU time per frame from EXT_disjoint_timer_query_webgl2, where the context has it: a few queries in
// flight, read back without blocking once the GPU has finished them. measure() wraps one frame's
// draws; take() returns the newest result (ms) or null.
export function createGpuTimer(gl) {
  const ext = gl?.getExtension?.("EXT_disjoint_timer_query_webgl2");
  if (!ext) return { available: false, begin() {}, end() {}, take: () => null, dispose() {} };
  const pending = [];
  const free = [];
  let active = null;
  let latest = null;
  return {
    available: true,
    begin() {
      if (active || pending.length > 4) return;
      active = free.pop() ?? gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      // send the frame's commands now: if they wait for the end of a busy task, the GPU's clock
      // runs on through the wait and the frame reads as GPU work
      gl.flush();
      pending.push(active);
      active = null;
    },
    take() {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift();
        if (!disjoint) latest = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        free.push(q);
      }
      const out = latest;
      latest = null;
      return out;
    },
    dispose() {
      for (const q of [...pending, ...free]) gl.deleteQuery(q);
      if (active) gl.deleteQuery(active);
      pending.length = 0;
      free.length = 0;
    },
  };
}
