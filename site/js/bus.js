/* The contract between the page (DOM) and the world (site/js/world/, WebGL). Both sides only talk
   through this bus and these DOM hooks.

   bus.on(type, fn) returns an unsubscribe function; bus.emit(type, detail) calls every listener in
   order, synchronously. state is plain data either side may read; the DOM side writes it.

   state
     scene          "hero" | "target" | "auditor" | "entropy" | "gap" | "replay" | "run" | "references"
     progress       0..1 through the current scene's driving range (see "scroll")
     reducedMotion  true when motion is off, from the MOTION switch or prefers-reduced-motion
     worldActive    true from "world:ready" until "world:fallback"

   Events the DOM emits
     "scroll"        { scene, progress, span, drive, y, vh, covered }  one passive, rAF-throttled
                     reader, also emitted once at start and on resize. A scene is current while its
                     section covers the middle of the viewport. progress runs 0..1 over the first 60% of
                     that range (or the section's data-drive fraction, `drive`; a scene with notes drives
                     over its stage alone: the tall replay, run and references scenes arrive sooner, and
                     on phones and tablets every sticky scene arrives by the time its section reaches
                     the top, before its text panel slides over the world) and holds at 1 for the rest;
                     span is the raw 0..1 over the whole range. covered: on stacked layouts, text panels
                     fill the screen and nothing of the world shows (it renders one frame and waits).
     "layout"        the page's layout changed (resize, a column's height, a view switched): measured
                     after the change, so the world re-measures its windows then.
     "motion"        { reduced }
     "blink"         { state: "target" | "reference", count }  count is completed blinks so far.
     "grid:focus"    { auditor, target, tools } or null. tools is "basic" (scans off) or "entropy".
                     The world brings the iris over that lattice cell and places gap:readout above it.
     "replay:load"   { run }      the full run JSON, sealed objective included: never draw its text.
     "replay:event"  { index, event }  each event as playback reaches it (not during seeks).
     "replay:seek"   { t }        ms; rebuild state from run.events with e.t <= t.
     "replay:state"  { playing, speed, t }

   Events the world emits
     "world:ready"     first frame is on screen; the DOM hides the stills (html[data-world="on"]),
                       the hero's poster once it has developed.
     "world:fallback"  { reason }  the stills come back and stay.
     "measure"         { jsd, hTarget, hReference, mode: "settling" | "settled" | "no-scan" }
                       the scales' needles follow it; the readouts print digits only when settled (the
                       scan's own values) and MEASURING while the plate develops. Without the world, the
                       DOM sets them per scene: the scan's real values in hero and entropy, NO SCAN in
                       the target scene.
     "iris"            { x, y, r, reach, text, readout?, visible? }  viewport px; r is the aperture
                       radius, reach the outer edge of the tick ring. The DOM writes #iris-readout
                       from it: the text, at readout.x/readout.y (the box's top left) when the world
                       gives a spot, else beside the ring on whichever side stays in the cloud zone.
                       Empty text or visible: false hides it.
     "bench"           { used, budget }  messages spent on the auditor scene's bench at the scroll's
                       point in the audit; the rail label's [data-rail-used] follows it.
     "station"         { weights: { <scene>: 0..1 } }  how far the two stations in the blend have
                       arrived; the entropy and gap figures' DOM parts fade with it (--arrive).
     "grid:pick"       { auditor, target, tools } or null: the lattice cell under the pointer. The
                       DOM treats it like hovering the table (and emits "grid:focus").

   DOM hooks
     canvas#plate                  fixed, inset 0, behind everything, aria-hidden. The world owns it.
     html[data-world]              "off" | "on". html[data-scene], html[data-motion] ("on" | "off").
     section#<scene>[data-scene]   one per scene, in the order above.
     [data-world-window="<scene>"] one per scene: the rectangle the world should frame that scene's
                                   subject in. The world measures them on resize (and when main's size
                                   changes) and follows them per frame from scrollY, sticky clamping
                                   included. Desktop: columns 6-12. Phones: the sticky top half, except
                                   entropy, whose plate scrolls with the page. A hidden window (the
                                   entropy plate in the side-by-side view) leaves its scene plain.
     #hero [data-cloud-zone]       the rectangle the clouds and the iris live in; never over the headline.
     #iris-readout                 shown only while the world runs.
     #cursor                       the hero's registration-target cursor (fine pointers, world running).
     .scales[data-measure]         JSON of the scan's real readouts { jsd, hTarget, hReference, n }.
       #jsd-needle, #jsd-value     JSD scale (0 to ln 2), right edge.
       #h-target-mark, #h-reference-mark, #h-target-value, #h-reference-value
                                   entropy scale (0 to ln n), bottom right. #scale-mode prints NO SCAN.
     [data-anchor="<name>"]        labels the world may place: set style.transform to
                                   translate3d(x, y, 0) in viewport px. While the world runs they are
                                   position: fixed at the viewport origin and parked off-screen until
                                   placed; anchors outside the current scene are hidden by CSS.
                                   Keep at most 12 on screen. Names:
         target    sleeve (the sealed envelope beside Atlas), atlas
         auditor   thread:<name> for each thread of the featured run (money, health, tech, everyday,
                   sample1.1, sample1.2, sample1.3, compare), station:auditor, station:atlas, rail
         entropy   cluster:<i> (i = the cluster's index in the scan file), caliper:target,
                   caliper:reference, caliper:gap. Their places come from world/compose.js, which
                   the build's SVG plate and the world's entropy station both use.
         gap       gap:readout (the hover readout panel, shown on "grid:focus"), and for the 3D
                   lattice only (.anchor--world): gap:auditor:<model>, gap:target:<model>,
                   gap:plate:basic, gap:plate:entropy
     #blink-figure[data-blink]     "target" | "reference"; .is-marked after two blinks. #blink-auto is
                                   the opt-in 1 Hz auto-blink.
     #player                       the replay; #rp-bench is its no-WebGL bench drawing.
     .run__shutter                 the run scene's window, where the world closes the shutter.

   ?instrument in the page's URL exposes window.__overseer = { bus, state, world } for
   scripts/render-stills.mjs and tests. */

const listeners = new Map();

export const bus = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  },
  emit(type, detail) {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      try {
        fn(detail);
      } catch (err) {
        console.error(err);
      }
    }
  },
};

export const state = {
  scene: "hero",
  progress: 0,
  reducedMotion: document.documentElement.dataset.motion === "off",
  worldActive: false,
};
