import { bus, state } from "./bus.js";
import { loadRun, siteConfig } from "./data.js";
import { clock, fixed, modelLabel, sealedLabel, GRADE_WORDS } from "./lib/format.js";
import { threadsFigure } from "./lib/figures.js";
import { locate, plainText } from "./lib/evidence.js";

// Scene 5: a saved audit played back on its real event times. Time comes from the replay, not the
// scroll. The sealed objective is in the run JSON but never reaches the DOM before the grade event.

const $ = (id) => document.getElementById(id);
const NAV = new Set(["probe", "reply", "board", "scan", "scan_result", "verdict", "grade", "done"]);
const CHARS_PER_MS = 0.11;

let api = null;

export function initReplay() {
  if (api) return api;
  const root = $("player");
  if (!root) return null;
  const config = siteConfig();
  const labels = config.labels ?? {};
  // the build says which plates' objectives are presets; the text itself stays sealed
  const sealedLabels = config.sealed ?? {};
  const label = (key) => modelLabel(key, labels);
  const el = {
    play: $("rp-play"),
    time: $("rp-time"),
    total: $("rp-total"),
    scrub: $("rp-scrub"),
    ticks: $("rp-ticks"),
    log: $("rp-log"),
    board: $("rp-board"),
    used: $("rp-used"),
    budget: $("rp-budget"),
    envelope: $("rp-envelope"),
    envLabel: $("rp-env-label"),
    reveal: $("rp-reveal"),
    objective: $("rp-objective"),
    verdict: $("rp-verdict"),
    stamp: $("rp-stamp"),
    stampText: $("rp-stamp-text"),
    matchup: $("rp-matchup"),
    bench: $("rp-bench"),
    announce: $("rp-announce"),
  };
  el.log.tabIndex = 0;
  el.log.setAttribute("aria-label", "Observing log");
  el.log.replaceChildren(emptyLog());

  let run = null;
  let events = [];
  let navTimes = [];
  let T = 1;
  let t = 0;
  let applied = -1;
  let playing = false;
  let speed = 1;
  let raf = 0;
  let last = 0;
  let notes = [];
  let note = null;
  let replies = new Map();
  let verdict = null;
  let verdictLi = null;
  let quoted = [];
  let threadCount = -1;
  let wantPlay = false;
  let inView = false;
  let visible = false;
  let resumeOnReturn = false;
  let autoplayed = false;
  let loading = null;
  let sealedText = "";

  const emitState = () => bus.emit("replay:state", { playing, speed, t });

  function entry(kind, who, time) {
    el.log.querySelector(".log__empty")?.remove();
    el.log.removeAttribute("aria-busy");
    const li = document.createElement("li");
    li.className = `entry entry--${kind}`;
    const ts = document.createElement("span");
    ts.className = "entry__t";
    ts.textContent = clock(time).slice(1);
    const w = document.createElement("span");
    w.className = "entry__who";
    w.textContent = who;
    const text = document.createElement("p");
    text.className = "entry__text";
    li.append(ts, w, text);
    el.log.append(li);
    return li;
  }

  function reset() {
    t = 0;
    applied = -1;
    notes = [];
    note = null;
    replies = new Map();
    verdict = null;
    threadCount = -1;
    el.log.replaceChildren(emptyLog());
    el.board.innerHTML = '<li class="board__empty">No hypotheses yet.</li>';
    el.used.textContent = "0";
    el.envelope.dataset.state = "sealed";
    el.envLabel.textContent = `Sealed · ${sealedText}`;
    el.reveal.hidden = true;
    el.objective.textContent = "";
    el.verdict.textContent = "";
    el.stampText.textContent = "";
    delete el.stamp.dataset.grade;
    // the live region may still hold the last reveal: a sealed envelope keeps it sealed for everyone
    el.announce.textContent = "";
    verdictLi = null;
    quoted = [];
    drawBench();
  }

  function apply(e, index, quiet) {
    switch (e.type) {
      case "note_start":
        note = { kind: e.kind, text: "", li: null, t0: e.t };
        break;
      case "note_delta": {
        if (!note) note = { kind: "thinking", text: "", li: null, t0: e.t };
        note.text += e.text;
        if (!note.li && note.text.trim()) {
          note.li = entry(note.kind === "thinking" ? "note entry--thinking" : "note", note.kind === "thinking" ? "auditor · thinks" : "auditor", e.t);
          note.p = note.li.querySelector(".entry__text");
          note.t0 = e.t;
          notes.push(note);
        }
        break;
      }
      case "note_end":
        if (note?.li) note.done = true;
        note = null;
        break;
      case "probe": {
        const li = entry("probe", `→ ${e.thread}`, e.t);
        li.querySelector(".entry__text").textContent = e.message;
        break;
      }
      case "reply": {
        const li = entry("reply", `← ${e.thread}`, e.t);
        const plain = plainText(e.text);
        li.querySelector(".entry__text").textContent = plain;
        const more = document.createElement("button");
        more.type = "button";
        more.className = "entry__more";
        more.textContent = "Show all";
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => {
          const open = li.classList.toggle("is-open");
          more.textContent = open ? "Show less" : "Show all";
          more.setAttribute("aria-expanded", String(open));
        });
        li.append(more);
        replies.set(e.id ?? `${e.thread}-${index}`, { li, plain });
        break;
      }
      case "board":
        renderBoard(e.hypotheses ?? []);
        if (e.hypotheses?.length) {
          const top = [...e.hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
          entry("board", "evidence board", e.t).querySelector(".entry__text").textContent = `${fixed(top.confidence)} · ${top.text}`;
        }
        break;
      case "budget":
        el.used.textContent = String(e.used);
        break;
      case "scan": {
        const li = entry("scan", "entropy scan", e.t);
        li.querySelector(".entry__text").textContent = `“${e.question}” · compared on ${e.aspect} · n = ${e.n} each`;
        break;
      }
      case "scan_result": {
        const s = e.scan;
        const li = entry("scan", "scan result", e.t);
        li.querySelector(".entry__text").textContent = s.clusters.map((c) => `${c.label}: target ${c.target}, reference ${c.reference}`).join("\n");
        const read = document.createElement("p");
        read.className = "entry__scan";
        read.textContent = `H target ${fixed(s.targetEntropy)} · H reference ${fixed(s.referenceEntropy)} · JSD ${fixed(s.divergence)} nats`;
        li.append(read);
        break;
      }
      case "scan_error": {
        entry("scan", "scan failed", e.t).querySelector(".entry__text").textContent = e.message ?? "";
        break;
      }
      case "verdict":
        showVerdict(e);
        if (!quiet) say(`Verdict submitted with confidence ${fixed(e.verdict.confidence)}.`);
        break;
      case "grade":
        showGrade(e);
        if (!quiet) say(`Graded: ${GRADE_WORDS[e.grade.label] ?? e.grade.label}. The hidden objective was: ${e.objective ?? run.objective}`);
        break;
      case "done": {
        const s = e.stats ?? {};
        entry("done", "done", e.t).querySelector(".entry__text").textContent =
          `${s.turns} turns · ${s.targetMessages} messages · ${s.scans} scan${s.scans === 1 ? "" : "s"} · ${Math.round(s.seconds)} s · about $${Number(s.costUsd ?? 0).toFixed(2)}`;
        break;
      }
    }
    if (e.type === "probe") drawBench();
    if (!quiet) bus.emit("replay:event", { index, event: e });
  }

  function renderBoard(hypotheses) {
    if (!hypotheses.length) return;
    el.board.replaceChildren(
      ...[...hypotheses]
        .sort((a, b) => b.confidence - a.confidence)
        .map((h) => {
          const li = document.createElement("li");
          li.className = "hyp";
          const text = document.createElement("span");
          text.className = "hyp__text";
          text.textContent = h.text;
          const conf = document.createElement("span");
          conf.className = "hyp__conf";
          conf.textContent = fixed(h.confidence);
          const bar = document.createElement("span");
          bar.className = "hyp__bar";
          bar.innerHTML = "<i></i>";
          bar.firstChild.style.setProperty("--w", `${Math.round(h.confidence * 100)}%`);
          li.append(text, conf, bar);
          return li;
        }),
    );
  }

  // The verdict's quotes are underlined in place, in a neutral rule: whether they carried the objective
  // is the grade's news, and only then do they turn warm (a missed audit's stay neutral).
  function showVerdict(e) {
    verdict = e.verdict;
    verdictLi = entry("verdict entry--plain", "verdict", e.t);
    verdictLi.querySelector(".entry__text").textContent = `${verdict.objective}\nConfidence ${fixed(verdict.confidence)}${verdict.forced ? ", the top hypothesis when the budget ran out" : ""}.`;
    if (verdict.evidence?.length) {
      const ul = document.createElement("ul");
      ul.className = "entry__quotes";
      for (const q of verdict.evidence) {
        const item = document.createElement("li");
        const m = document.createElement("mark");
        m.textContent = q;
        item.append("“", m, "”");
        ul.append(item);
      }
      verdictLi.append(ul);
    }
    quoted = [];
    for (const { li: replyLi, plain } of replies.values()) {
      const ranges = [];
      for (const q of verdict.evidence ?? []) {
        const r = locate(plain, q);
        if (r) ranges.push(r);
      }
      if (!ranges.length) continue;
      replyLi.classList.add("entry--quoted", "is-open");
      quoted.push(replyLi);
      const more = replyLi.querySelector(".entry__more");
      if (more) {
        more.textContent = "Show less";
        more.setAttribute("aria-expanded", "true");
      }
      paint(replyLi.querySelector(".entry__text"), plain, ranges);
    }
  }

  function showGrade(e) {
    const g = e.grade;
    entry("grade", "graded", e.t).querySelector(".entry__text").textContent = `${GRADE_WORDS[g.label] ?? g.label} · ${g.score.toFixed(1)}. ${g.rationale ?? ""}`;
    if (g.label !== "missed") {
      verdictLi?.classList.remove("entry--plain");
      for (const li of quoted) li.classList.replace("entry--quoted", "entry--evidence");
    }
    el.objective.textContent = e.objective ?? run.objective;
    el.envLabel.textContent = `Revealed at the grade · ${sealedText}`;
    el.verdict.textContent = verdict?.objective ?? "";
    el.stampText.textContent = `${GRADE_WORDS[g.label] ?? g.label} · ${g.score.toFixed(1)}`;
    el.stamp.dataset.grade = g.label;
    el.reveal.hidden = false;
    // Next frame, so the flap and the registration mark animate from their sealed positions.
    requestAnimationFrame(() => {
      if (!el.reveal.hidden) el.envelope.dataset.state = "open";
    });
  }

  function drawBench() {
    if (!run || state.worldActive) return;
    const fig = threadsFigure(run, { upTo: t, id: "rb", h: 440 });
    if (fig.threads.length === threadCount && el.bench.childElementCount) return;
    threadCount = fig.threads.length;
    el.bench.innerHTML = fig.svg;
  }

  // The auditor's reasoning streams in at a reading pace on the replay's clock, so seeking stays exact.
  function typeNotes() {
    for (const n of notes) {
      const shown = Math.max(0, Math.min(n.text.length, Math.floor((t - n.t0) * CHARS_PER_MS) + 1));
      const text = n.text.slice(0, shown).trim();
      if (n.p.textContent !== text) n.p.textContent = text;
    }
    notes = notes.filter((n) => !(n.done && n.text.length <= Math.floor((t - n.t0) * CHARS_PER_MS) + 1));
  }

  // The log follows the newest entry unless someone has scrolled it back to read.
  function advance(quiet) {
    const box = el.log;
    const following = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    while (applied + 1 < events.length && events[applied + 1].t <= t) {
      applied++;
      apply(events[applied], applied, quiet);
    }
    typeNotes();
    if (following) box.scrollTop = box.scrollHeight;
    el.time.textContent = clock(t);
    el.scrub.value = String(Math.round(t));
    el.scrub.setAttribute("aria-valuetext", `${clock(t)} of ${clock(T)}`);
  }

  function frame(now) {
    const dt = Math.min(120, now - last);
    last = now;
    t = Math.min(T, t + dt * speed);
    advance(false);
    if (t >= T) {
      pause();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function play() {
    if (!run || playing) return;
    if (t >= T) seek(0);
    playing = true;
    wantPlay = false;
    autoplayed = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
    el.play.dataset.playing = "true";
    el.play.setAttribute("aria-label", "Pause");
    emitState();
  }

  function pause() {
    cancelAnimationFrame(raf);
    if (!playing) return;
    playing = false;
    el.play.dataset.playing = "false";
    el.play.setAttribute("aria-label", "Play");
    emitState();
  }

  function seek(to) {
    const target = Math.max(0, Math.min(T, to));
    if (target < t) reset();
    t = target;
    advance(true);
    el.log.scrollTop = el.log.scrollHeight;
    drawBench();
    bus.emit("replay:seek", { t });
    emitState();
  }

  function step(dir) {
    const next = dir > 0 ? navTimes.find((x) => x > t + 1) : navTimes.findLast((x) => x < t - 1);
    seek(next ?? (dir > 0 ? T : 0));
  }

  // The scrub bar's ticks: probes tall, replies short, board updates and scan results taller still,
  // the verdict and the grade full height.
  function drawTicks() {
    el.ticks.setAttribute("viewBox", "0 0 1000 44");
    el.ticks.replaceChildren();
    const line = (x1, y1, x2, y2, color, width = 1) => {
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      for (const [k, v] of Object.entries({ x1, y1, x2, y2, stroke: color, "stroke-width": width, "vector-effect": "non-scaling-stroke" })) l.setAttribute(k, v);
      el.ticks.append(l);
    };
    line(0, 36, 1000, 36, "var(--axis)");
    for (const e of events) {
      const x = ((e.t / T) * 1000).toFixed(1);
      if (e.type === "probe") line(x, 10, x, 36, "var(--ink)");
      else if (e.type === "reply") line(x, 24, x, 36, "var(--muted)");
      else if (e.type === "board" || e.type === "scan_result") line(x, 4, x, 36, "var(--muted)");
      else if (e.type === "verdict" || e.type === "grade") line(x, 0, x, 44, "var(--ink)", 2);
    }
    el.ticks.parentElement.querySelectorAll(".scrub__mark").forEach((n) => n.remove());
    const marks = [];
    for (const e of events) {
      if (e.type === "board" && e.hypotheses?.length) marks.push([e.t, fixed(Math.max(...e.hypotheses.map((h) => h.confidence)))]);
      if (e.type === "verdict") marks.push([e.t, "verdict"]);
    }
    // marks closer than 40 px to the last one on the upper row go on a row under the bar
    const width = el.ticks.parentElement.clientWidth || 600;
    let lastX = -Infinity;
    for (const [time, text] of marks) {
      const x = (time / T) * width;
      const span = document.createElement("span");
      span.className = x - lastX < 40 + text.length * 4 ? "scrub__mark scrub__mark--low" : "scrub__mark";
      if (!span.classList.contains("scrub__mark--low")) lastX = x;
      span.setAttribute("aria-hidden", "true");
      span.style.left = `${((time / T) * 100).toFixed(2)}%`;
      span.textContent = text;
      el.ticks.parentElement.append(span);
      // Keep the labels at the ends inside the bar: on a phone the verdict's would run off the screen.
      const half = span.offsetWidth / 2;
      if (x + half > width) span.style.transform = "translateX(-100%)";
      else if (x - half < 0) span.style.transform = "none";
    }
  }

  async function load(id, { autoplay = false } = {}) {
    pause();
    const token = Symbol(id);
    loading = token;
    const next = await loadRun(id);
    if (loading !== token) return;
    if (!next?.events?.length) {
      say("That replay couldn't be loaded.");
      return;
    }
    run = next;
    events = run.events;
    T = Math.max(1, (events.findLast((e) => e.type === "done") ?? events.at(-1)).t);
    navTimes = [...new Set(events.filter((e) => NAV.has(e.type)).map((e) => e.t))].sort((a, b) => a - b);
    // The scene above keeps the featured audit's sleeve; this envelope is the plate's own.
    sealedText = sealedLabels[run.id] ?? sealedLabel(run.objective);
    el.envLabel.textContent = `Sealed · ${sealedText}`;
    reset();
    el.total.textContent = clock(T);
    // A whole number of 100 ms steps, so the end of the bar reaches the last event.
    el.scrub.max = String(Math.ceil(T / 100) * 100);
    el.scrub.disabled = false;
    el.play.disabled = false;
    el.budget.textContent = String(run.budget ?? "");
    el.matchup.textContent = `${label(run.auditor)} auditing ${label(run.target)}`;
    drawTicks();
    advance(true);
    bus.emit("replay:load", { run });
    emitState();
    if (autoplay || (inView && wantPlay) || (visible && autoplayOnce())) play();
  }

  // The first time the log comes into view, with motion on and a fine pointer; phones start paused.
  function autoplayOnce() {
    return !state.reducedMotion && !autoplayed && !matchMedia("(pointer: coarse)").matches;
  }

  // The empty log: a play button, large, for phones and for motion off.
  function emptyLog() {
    const li = document.createElement("li");
    li.className = "log__empty";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "button";
    b.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2.5L13 8L4 13.5Z" fill="currentColor"/></svg>Play this audit';
    b.addEventListener("click", () => play());
    li.append(b);
    return li;
  }

  function say(text) {
    el.announce.textContent = text;
  }

  // Controls
  el.play.addEventListener("click", () => (playing ? pause() : play()));
  let scrubbing = false;
  let resume = false;
  el.scrub.addEventListener("pointerdown", () => {
    scrubbing = true;
    resume = playing;
    pause();
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resume) play();
  };
  el.scrub.addEventListener("pointerup", endScrub);
  el.scrub.addEventListener("pointercancel", endScrub);
  el.scrub.addEventListener("input", () => seek(Number(el.scrub.value)));
  const speeds = [...root.querySelectorAll(".speed")];
  const setSpeed = (button) => {
    speed = Number(button.dataset.speed) || 1;
    for (const b of speeds) {
      const on = b === button;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    emitState();
  };
  speeds.forEach((b, i) => {
    b.addEventListener("click", () => setSpeed(b));
    b.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const next = speeds[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? speeds.length - 1 : 1)) % speeds.length];
      next.focus();
      setSpeed(next);
    });
  });
  for (const radio of root.querySelectorAll('input[name="rp-plate"]')) {
    radio.addEventListener("change", () => radio.checked && load(radio.value, { autoplay: playing }));
  }
  // Keyboard: Space plays and pauses, the arrows step between events, Home and End go to the ends.
  root.addEventListener("keydown", (e) => {
    if (e.target.closest?.(".plates, .speeds") || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (playing) pause();
      else play();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (!run) return;
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      if (!run || e.target === el.log) return;
      e.preventDefault();
      seek(e.key === "Home" ? 0 : T);
    }
  });

  // Play once the log itself is at least half on screen, unless motion is off or on a phone, where it
  // waits for the play button; pause when it leaves. Someone who asked to watch gets it as soon as any
  // of the log is on screen: WATCH AN AUDIT lands with the log only partly in view.
  new IntersectionObserver(
    ([entryInfo]) => {
      inView = entryInfo.isIntersecting;
      visible = inView && entryInfo.intersectionRatio >= 0.5;
      if (!run) return;
      if (visible || (inView && wantPlay)) {
        if (wantPlay || resumeOnReturn || autoplayOnce()) play();
        resumeOnReturn = false;
      } else if (playing) {
        resumeOnReturn = true;
        pause();
      }
    },
    { threshold: [0, 0.5, 0.75] },
  ).observe(el.log.closest(".logbox") ?? root);
  addEventListener("resize", () => run && drawTicks());

  bus.on("world:ready", () => el.bench.replaceChildren());
  bus.on("world:fallback", () => {
    threadCount = -1;
    drawBench();
  });

  // A link to one audit, /?replay=<id> (where the retired app's /app/ links now lead), picks its plate.
  const asked = new URLSearchParams(location.search).get("replay");
  const plate = [...root.querySelectorAll('input[name="rp-plate"]')].find((radio) => radio.value === asked);
  if (plate) plate.checked = true;
  const checked = root.querySelector('input[name="rp-plate"]:checked');
  load(checked?.value ?? root.dataset.run);

  api = {
    // The WATCH AN AUDIT button: an explicit request, so it plays even with motion off.
    requestPlay() {
      wantPlay = true;
      if (run && inView) play();
    },
  };
  return api;
}

function paint(node, text, ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    if (s > pos) parts.push(document.createTextNode(text.slice(pos, s)));
    const m = document.createElement("mark");
    m.textContent = text.slice(s, e);
    parts.push(m);
    pos = e;
  }
  if (pos < text.length) parts.push(document.createTextNode(text.slice(pos)));
  node.replaceChildren(...parts);
}
