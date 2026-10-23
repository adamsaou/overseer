import { bus, state } from "./bus.js";

// Hold to blink: the plate arrives with both exposures on it; while the button is held it shows the
// clean reference's exposure alone, and on release Atlas's. The field never moves, only the answers
// do. After two blinks the warm brackets lock on and the readout prints. With motion off the button
// flips on each press instead, and the default view is the two plates side by side.
export function initBlink() {
  const fig = document.getElementById("blink-figure");
  const controls = document.getElementById("blink-controls");
  const button = document.getElementById("blink");
  if (!fig || !controls || !button) return;
  const plate = fig.querySelector(".fig__plate");
  const readout = document.getElementById("blink-readout");
  const text = document.getElementById("blink-readout-text")?.content.textContent.trim() ?? "";
  const radios = [...controls.querySelectorAll(".view-switch [role=radio]")];
  const toggle = button.querySelector(".blink__toggle");
  const auto = document.getElementById("blink-auto");
  let autoTimer = 0;
  let showing = fig.dataset.blink || "both";
  let count = 0;
  let chosenView = false;

  // The figure's own changes move the plate inside its column without resizing anything the page
  // watches, so the world is told to measure its window again.
  const relayout = () => requestAnimationFrame(() => bus.emit("layout"));
  const mark = () => {
    if (fig.classList.contains("is-marked")) return;
    fig.classList.add("is-marked");
    if (readout) readout.textContent = text;
    relayout();
  };

  const show = (which) => {
    if (which === showing) return;
    // a blink is complete when the plate comes back from the reference to the target
    if (showing === "reference" && which === "target") count++;
    showing = which;
    fig.dataset.blink = which;
    button.setAttribute("aria-pressed", String(which === "reference"));
    if (toggle) toggle.textContent = which === "reference" ? "Show target" : "Show reference";
    bus.emit("blink", { state: which, count });
    if (count >= 2) mark();
  };
  const flip = () => show(showing === "reference" ? "target" : "reference");
  const holding = () => !state.reducedMotion && fig.dataset.view !== "pair";

  // Auto-blink, only on request: one exposure each half second, so 1 Hz, well under three flashes a
  // second. It stops when the scene leaves, when motion goes off, and at any blink by hand.
  const stopAuto = () => {
    if (!autoTimer) return;
    clearInterval(autoTimer);
    autoTimer = 0;
    auto?.setAttribute("aria-pressed", "false");
    show("target");
  };
  auto?.addEventListener("click", () => {
    if (autoTimer) return stopAuto();
    auto.setAttribute("aria-pressed", "true");
    flip();
    autoTimer = setInterval(() => {
      if (state.scene !== "entropy" || !holding()) return stopAuto();
      flip();
    }, 500);
  });

  button.setAttribute("aria-pressed", "false");
  button.addEventListener("pointerdown", (e) => {
    stopAuto();
    if (!holding() || e.button !== 0) return;
    button.setPointerCapture?.(e.pointerId);
    show("reference");
  });
  const release = () => holding() && showing === "reference" && show("target");
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, release);
  button.addEventListener("click", () => {
    if (!holding()) flip();
  });
  button.addEventListener("keydown", (e) => {
    if (!holding() || (e.key !== " " && e.key !== "Enter")) return;
    e.preventDefault();
    if (!e.repeat) show("reference");
  });
  button.addEventListener("keyup", (e) => {
    if (!holding() || (e.key !== " " && e.key !== "Enter")) return;
    e.preventDefault();
    release();
  });
  button.addEventListener("blur", release);

  // B, while focus is in the figure (its button or switches): a single-key shortcut that only works
  // where it's announced, so it never fires while someone types or reads elsewhere (WCAG 2.1.4).
  const typing = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  addEventListener("keydown", (e) => {
    if ((e.key !== "b" && e.key !== "B") || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if (!fig.contains(document.activeElement) || fig.dataset.view === "pair" || e.repeat) return;
    stopAuto();
    if (holding()) show("reference");
    else flip();
  });
  addEventListener("keyup", (e) => {
    if ((e.key === "b" || e.key === "B") && holding() && showing === "reference") show("target");
  });

  // Phones: press and hold the plate. A short delay keeps ordinary scrolling free.
  let timer = 0;
  let down = null;
  let held = false;
  plate.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || fig.dataset.view === "pair") return;
    down = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      held = true;
      if (holding()) show("reference");
      else flip();
    }, 260);
  });
  plate.addEventListener("pointermove", (e) => {
    if (down && !held && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) clearTimeout(timer);
  });
  const letGo = () => {
    clearTimeout(timer);
    if (held) release();
    held = false;
    down = null;
  };
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) plate.addEventListener(type, letGo);
  plate.addEventListener("contextmenu", (e) => e.preventDefault());

  // Blink or side by side. Motion off starts side by side; the choice sticks once someone makes it.
  const column = fig.closest(".scene__world");
  const setView = (view) => {
    fig.dataset.view = view;
    controls.dataset.view = view;
    if (column) column.dataset.view = view;
    for (const r of radios) {
      const on = r.dataset.view === view;
      r.setAttribute("aria-checked", String(on));
      r.tabIndex = on ? 0 : -1;
    }
    if (view === "pair") {
      stopAuto();
      show("target");
      mark();
    }
    relayout();
  };
  radios.forEach((r, i) => {
    r.addEventListener("click", () => {
      chosenView = true;
      setView(r.dataset.view);
    });
    r.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const next = radios[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? radios.length - 1 : 1)) % radios.length];
      next.focus();
      chosenView = true;
      setView(next.dataset.view);
    });
  });
  const syncMotion = () => {
    if (state.reducedMotion) stopAuto();
    if (!chosenView) setView(state.reducedMotion ? "pair" : "blink");
  };
  bus.on("motion", syncMotion);
  syncMotion();

  // A plate narrower than its labels need lists its clusters underneath instead, as phones do.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0 && fig.dataset.compact !== String(w < 640)) {
        fig.dataset.compact = String(w < 640);
        relayout();
      }
    }).observe(plate);
  }
}
