import { LN2, esc, fixed, bound, wilson, sealedLabel, modelLabel, money, seconds, clock } from "../js/lib/format.js";
import { scanGroups, heroPlate, atlasPlate, sleeve, threadsFigure, scanPlate, gapPlate, jsdScale, entropyScale, miniScale, shutterFigure } from "../js/lib/figures.js";

// Build-time only: scripts/build-site.ts calls pageValues() with the data it read from runs/, results/
// and lib/, and fills the {{ key }} slots in site/index.html. Nothing here ships to the browser, so every
// number on the page is the one in the JSON at build time, and a rebuild after a new study updates them.

const ORDER = ["haiku", "sonnet", "opus"];
const TOOLS = { basic: "scans off", entropy: "scans on" };
// What the page calls each preset objective in a sentence ("the electric-car objective").
const NAMES = { ev: "electric-car", hydration: "hydration", pennywise: "Pennywise", city: "home-city", python: "Python", books: "paper-books", office: "office", newsletter: "newsletter", cats: "cats", nuclear: "nuclear-power" };
export const INTERVAL = "approx. 95% interval";

// Azeret Mono gives the decimal point a whole cell, which opens "0 . 69": the point is drawn narrow.
export const digits = (text) => esc(text).replace(/(\d)\.(\d)/g, '$1<span class="dp">.</span>$2');
const data = (value, text = value) => `<data value="${esc(value)}">${digits(text)}</data>`;
// Symbols keep their case inside uppercase labels: n is a sample size, ln a logarithm.
export const sym = (html) => html.replace(/\b(n|ln)(?= (?:=|\d))/g, '<span class="sym">$1</span>');

// Anchor positions are fractions of their figure. A rendered still can bring its own positions in
// site/img/anchors.json ({ "<anchor name>": { "x": 0.61, "y": 0.42 } }), which win over the SVG layout's.
// They are the figures' labels, placed for the eye: what they say is in the page's text too (the
// captions, the cluster list), where screen readers find it whatever scene is on screen.
let overrides = {};
const anchor = (name, pos, body, cls = "") => {
  const at = { ...pos, ...overrides[name] };
  return `<div class="anchor${cls ? ` ${cls}` : ""}" data-anchor="${esc(name)}" style="--x: ${(at.x * 100).toFixed(2)}%; --y: ${(at.y * 100).toFixed(2)}%" aria-hidden="true">${body}</div>`;
};

export function pageValues(model) {
  const { summary, scan, featured, plates, labels, stills } = model;
  overrides = model.anchors ?? {};
  const label = (key) => modelLabel(key, labels);
  const presets = model.presets ?? [];
  const values = {};

  // Readouts: the worked-example scan the hero and the entropy scene measure.
  const n = scan.n;
  const hT = scan.targetEntropy;
  const hR = scan.referenceEntropy;
  const jsd = scan.divergence;
  const atMax = jsd >= LN2 - 0.005;
  const groups = scanGroups(scan);
  const shared = groups.clusters.filter((c) => c.target > 0 && c.reference > 0).length;
  values.h_target = fixed(hT);
  values.h_reference = fixed(hR);
  values.jsd = fixed(jsd);
  values.h_target_html = digits(fixed(hT));
  values.h_reference_html = digits(fixed(hR));
  values.jsd_html = digits(fixed(jsd));
  values.scan_n = String(n);
  values.jsd_scale = jsdScale({ value: jsd });
  values.h_scale = entropyScale({ target: hT, reference: hR, n });
  values.measure_json = esc(JSON.stringify({ jsd, hTarget: hT, hReference: hR, n }));
  values.hero_plate = stills.poster ? "" : heroPlate(scan);
  values.hero_poster = heroPoster(stills);

  // Scene 1: Atlas and the sealed sleeve. The label says only whether the featured run's objective is
  // one of the public presets; the text itself never reaches the page.
  const sealed = sealedLabel(featured.objective, presets);
  const atlas = atlasPlate(scan);
  values.atlas_figure = [
    picture("target", stills),
    stills.target ? "" : atlas.svg,
    anchor(
      "sleeve",
      atlas.sleeve,
      `<div class="anchor__body sleeve">${sleeve()}<p class="label sleeve__label"><span>Objective · sealed</span> <span>${esc(sealed)}</span></p></div>`,
    ),
    anchor("atlas", atlas.atlas, `<p class="anchor__body label anchor__center">Atlas · ${esc(label(featured.target))}</p>`),
  ].join("");
  values.atlas_model = esc(label(featured.target));

  // Scene 2: the featured run's threads up to the moment its auditor stopped probing.
  const threads = threadsFigure(featured);
  const lastProbe = Math.max(...featured.events.filter((e) => e.type === "probe").map((e) => e.t));
  values.budget = String(featured.budget);
  values.threads_figure = [
    picture("auditor", stills),
    stills.auditor ? "" : threads.svg,
    ...threads.threads.map((th) => anchor(`thread:${th.name}`, th, `<p class="anchor__body label anchor__center">${esc(th.name)}</p>`, "anchor--thread")),
    anchor("station:auditor", threads.stations.auditor, `<p class="anchor__body label station"><span>Auditor</span> <span>${esc(label(featured.auditor))}</span></p>`),
    anchor("station:atlas", threads.stations.atlas, `<p class="anchor__body label anchor__end station"><span>Atlas</span> <span>${esc(label(featured.target))}</span></p>`),
    anchor("rail", threads.stations.rail, `<p class="anchor__body label">Messages <data value="${threads.used}" data-rail-used>${threads.used}</data> / ${data(threads.budget)}</p>`),
  ].join("");
  const groupsByTime = [];
  for (const th of threads.threads) {
    const g = groupsByTime.find((x) => Math.abs(x.t - th.t) < 500);
    if (g) g.names.push(th.name);
    else groupsByTime.push({ t: th.t, names: [th.name] });
  }
  values.threads_caption = `Threads of the audit replayed below, ${esc(label(featured.auditor))} auditing ${esc(label(featured.target))}: ${groupsByTime
    .map((g) => `${esc(listJoin(g.names))} at ${data((g.t / 1000).toFixed(1), `${(g.t / 1000).toFixed(1)} s`)}`)
    .join("; ")}. ${data(threads.used)} of ${data(threads.budget)} messages used by ${data((lastProbe / 1000).toFixed(1), `${(lastProbe / 1000).toFixed(1)} s`)}.`;

  // Scene 3: the worked example, in words and on the plate.
  const goal = scan.goal;
  const objectiveName = NAMES[scan.objective] ? `the ${NAMES[scan.objective]} objective` : "its objective";
  const tCounts = groups.order.filter((c) => c.target > 0).map((c) => c.target);
  const rCounts = groups.order.filter((c) => c.reference > 0).map((c) => c.reference);
  const overlap = shared === 0 ? "share no group" : shared === 1 ? "share one group" : `share ${shared} groups`;
  const close = Math.abs(hT - hR) < 0.25;
  const apart = jsd >= 0.35;
  values.entropy_statement = close
    ? apart
      ? "The secret barely changed how much Atlas varied. It changed where."
      : "In this scan the secret barely changed Atlas’s answers."
    : `The secret made Atlas ${hT < hR ? "less" : "more"} varied${apart ? ", and moved its answers somewhere else" : ""}.`;
  values.scan_paragraph =
    `Here Atlas was ${esc(label(scan.target))} with ${objectiveName}. Asked the same question ${data(n)} times, it answered in ${groupCount(tCounts)}; ` +
    `the clean copy answered in ${groupCount(rCounts, shared === 0)}. The entropies are ${close ? "close" : "far apart"}, ${data(fixed(hT))} against ${data(fixed(hR))} nats, ` +
    `but the two ${overlap}, so the divergence is ${data(fixed(jsd))} nats${atMax ? ", the maximum" : ""}.`;
  values.scan_question = esc(scan.question);
  values.scan_aspect = esc(scan.aspect);
  values.scan_objective = esc(goal?.objective ?? "");
  values.scan_caption = `${data(n, `n = ${n}`)} per model, one scan: an illustration, not a result.`;
  values.scan_note = esc(curly(String(scan.note ?? "").replace(new RegExp(`\\bthe ${scan.objective} objective\\b`, "g"), objectiveName)));
  values.jsd_caption = atMax ? "maximum: no cluster in common" : shared === 0 ? "no cluster in common" : `${shared} cluster${shared === 1 ? "" : "s"} in common`;
  const plate = scanPlate(scan, { id: "sp", photo: stills.blink });
  const anchors = plate.positions.clusters.map((c) =>
    anchor(
      `cluster:${c.i}`,
      c,
      `<div class="anchor__body cluster cluster--${c.align}"><p class="label"><span class="cluster__key">${esc(c.letter)}</span><span class="cluster__counts"> · target ${data(c.target)} · reference ${data(c.reference)}</span></p><p class="cluster__name">${esc(c.label)}</p></div>`,
      "anchor--cluster",
    ),
  );
  const cal = plate.positions.calipers;
  if (cal.target) anchors.push(anchor("caliper:target", cal.target, `<p class="anchor__body label anchor__center caliper-label">H ${data(fixed(hT))}</p>`));
  if (cal.reference) anchors.push(anchor("caliper:reference", cal.reference, `<p class="anchor__body label label--cool anchor__center caliper-label">H ${data(fixed(hR))}</p>`));
  if (cal.gap) anchors.push(anchor("caliper:gap", cal.gap, `<p class="anchor__body label label--warm anchor__center caliper-label">JSD ${data(fixed(jsd))}</p>`));
  values.scan_plate = [blinkStills(stills), plate.svg, ...anchors].join("");
  // The same clusters as a list: under the plate on phones and on narrow plates, and for screen
  // readers everywhere, since the plate's own labels come and go with the scene.
  values.scan_legend = `<ol class="cluster-legend">${[...plate.positions.clusters]
    .sort((a, b) => a.letter.localeCompare(b.letter))
    .map((c) => `<li><span class="label${c.side === "reference" ? " label--cool" : ""}">${esc(c.letter)} · target ${data(c.target)} · reference ${data(c.reference)}</span> ${esc(c.label)}</li>`)
    .join("")}</ol>`;
  values.scan_pair = ["target", "reference"]
    .map(
      (layer) =>
        `<figure class="pair__plate pair__plate--${layer}"><div class="pair__field">${stills.blink ? `<img class="pair__img" src="/img/blink-${layer}.avif" alt="" loading="lazy" decoding="async">` : ""}${scanPlate(scan, { layer, id: `sp-${layer}`, photo: stills.blink }).svg}${plate.positions.keys.map((k) => `<span class="pair__key label" style="--x: ${(k.x * 100).toFixed(2)}%; --y: ${(k.y * 100).toFixed(2)}%" aria-hidden="true">${esc(k.letter)}</span>`).join("")}</div><figcaption class="label${layer === "reference" ? " label--cool" : ""}">${layer === "target" ? "Target · Atlas" : "Reference · clean copy"}</figcaption></figure>`,
    )
    .join("");
  const lnN = Math.log(Math.max(2, n));
  values.mini_target = miniScale(hT, lnN);
  values.mini_reference = miniScale(hR, lnN, { solid: false, ends: `ln ${n}` });
  values.blink_readout = `JSD ${fixed(jsd)} nats${atMax ? " · maximum" : ""} · ${shared === 0 ? "no cluster in common" : overlap}`;
  values.second_scan = secondScan(plates, label);

  // Scene 4: the oversight-gap study.
  Object.assign(values, gapValues(summary, label));
  values.gap_still = picture("gap", stills);

  // Scene 5: the replay's plates. Outcomes stay off the picker, so the stamp is news when it lands.
  values.featured_id = esc(featured.id);
  values.replay_plates = plates
    .map((run, i) => {
      const done = run.events.findLast((e) => e.type === "done") ?? run.events.at(-1);
      const scans = run.result?.stats?.scans ?? 0;
      const msgs = run.result?.stats?.targetMessages ?? run.events.filter((e) => e.type === "probe").length;
      const meta = `${msgs} messages${scans ? ` · ${scans} scan${scans === 1 ? "" : "s"}` : ""} · ${seconds(done?.t ?? 0)}`;
      return `<label class="plate-pick"><input type="radio" name="rp-plate" value="${esc(run.id)}"${i === 0 ? " checked" : ""}><span class="plate-pick__body"><span class="plate-pick__match">${esc(label(run.auditor))} → ${esc(label(run.target))}</span><span class="plate-pick__meta">${esc(meta)}</span></span></label>`;
    })
    .join("");
  const fDone = featured.events.findLast((e) => e.type === "done") ?? featured.events.at(-1);
  values.replay_total = clock(fDone?.t ?? 0);
  values.replay_budget = String(featured.budget);
  values.replay_matchup = `${esc(label(featured.auditor))} auditing ${esc(label(featured.target))}`;
  values.replay_sealed = `Sealed · ${esc(sealed)}`;
  // Without WebGL the bench is drawn live from the run (threadsFigure), so it needs no still.
  values.sleeve_large = sleeve({ cls: "sleeve-svg sleeve-svg--large" });

  // Scene 6: what an audit costs, from the study's own cells and the saved runs.
  values.costs = costSentence(summary, model.runs, label);
  values.node = esc(model.node);
  values.shutter_still = shutterFigure();

  // Scene 7 and the colophon.
  values.references = references();
  values.colophon = colophon(model);
  values.generated = summary ? esc(utc(summary.generatedAt)) : "not yet";
  return values;
}

// The hero poster, in two widths: the hero zone is half the viewport on desktop, all of it on phones.
// With motion on, the world starts from the scan's first state (the two clouds on top of each other,
// nothing measured yet) and develops from there, so that is the poster it takes over from; with
// motion off it holds the settled plate, and so does its poster. boot.js swaps them when the page's
// own MOTION switch disagrees with the system setting, and settles the poster when the world can't run.
export const POSTER_SIZES = "(max-width: 719px) calc(100vw - 32px), 50vw";
export function posterSet(stills, ext, kind = "") {
  const name = `poster-hero${kind}`;
  return [stills[`poster${kind ? "Start" : ""}720`] ? `/img/${name}-720.${ext} 720w` : "", `/img/${name}.${ext} 1180w`].filter(Boolean).join(", ");
}
export const REDUCED = "(prefers-reduced-motion: reduce)";
function heroPoster(stills) {
  if (!stills.poster) return "";
  const settled = (ext) => posterSet(stills, ext);
  const sizes = `sizes="${POSTER_SIZES}"`;
  if (!stills.posterStart) {
    return `<picture class="still__img still__poster"><source srcset="${settled("avif")}" ${sizes} type="image/avif"><img src="/img/poster-hero.webp" srcset="${settled("webp")}" ${sizes} alt="" fetchpriority="high" decoding="async"></picture>`;
  }
  const start = (ext) => posterSet(stills, ext, "-start");
  return (
    `<picture class="still__img still__poster" data-poster="start">` +
    `<source media="${REDUCED}" srcset="${settled("avif")}" ${sizes} type="image/avif" data-reduced>` +
    `<source media="${REDUCED}" srcset="${settled("webp")}" ${sizes} type="image/webp" data-reduced>` +
    `<source srcset="${start("avif")}" ${sizes} type="image/avif" data-start="${start("avif")}" data-settled="${settled("avif")}">` +
    `<img src="/img/poster-hero-start.webp" srcset="${start("webp")}" ${sizes} data-start="${start("webp")}" data-settled="${settled("webp")}" alt="" fetchpriority="high" decoding="async">` +
    `</picture>`
  );
}

// A station's still, with a phone size when there is one: the figure is the world's columns on
// desktop (about two fifths of the viewport) and the whole width on phones. They load late and
// quietly: with the world running they stay hidden behind it.
const STILL_SIZES = "(max-width: 719px) calc(100vw - 32px), 40vw";
function picture(name, stills) {
  if (!stills[name]) return "";
  const set = (ext) => [stills[`${name}600`] ? `/img/still-${name}-600.${ext} 600w` : "", `/img/still-${name}.${ext} 1180w`].filter(Boolean).join(", ");
  return `<picture class="still__img"><source srcset="${set("avif")}" sizes="${STILL_SIZES}" type="image/avif"><img src="/img/still-${name}.webp" srcset="${set("webp")}" sizes="${STILL_SIZES}" alt="" loading="lazy" decoding="async" fetchpriority="low"></picture>`;
}

function blinkStills(stills) {
  if (!stills.blink) return "";
  return `<img class="still__img blink__img blink__img--target" src="/img/blink-target.avif" alt="" loading="lazy" decoding="async" fetchpriority="low"><img class="still__img blink__img blink__img--reference" src="/img/blink-reference.avif" alt="" loading="lazy" decoding="async" fetchpriority="low">`;
}

const listJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// The page's text, typeset: curly apostrophes and quotes wherever the data has straight ones.
const curly = (text) =>
  text
    .replace(/(\w)'(\w)/g, "$1’$2")
    .replace(/(^|[\s(])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/(^|[\s(])"/g, "$1“")
    .replace(/"/g, "”");

function groupCount(counts, others = false) {
  const words = ["no groups", "one group", "two groups", "three groups", "four groups"];
  const k = counts.length;
  const word = others && k > 1 ? (["", "", "two others", "three others", "four others"][k] ?? `${k} others`) : (words[k] ?? `${k} groups`);
  return `${word}${k > 1 ? `, ${counts.map((c) => data(c)).join(" and ")}` : ""}`;
}

// A scan inside one of the replay's runs, when there is one: in the Claude Code audit both models are
// perfectly consistent and still share nothing.
function secondScan(plates, label) {
  for (const run of plates) {
    const e = run.events.find((x) => x.type === "scan_result");
    if (!e) continue;
    const s = e.scan;
    const steady = s.targetEntropy < 0.005 && s.referenceEntropy < 0.005;
    return (
      `A scan in the ${esc(label(run.auditor))} audit below (${data(s.n, `n = ${s.n}`)} per model, one scan) makes the same point more sharply. ` +
      (steady
        ? `Both models gave the same kind of answer every time, H ${data("0.00")} nats each, and still had none in common: JSD ${data(fixed(s.divergence))} nats.`
        : `It read H ${data(fixed(s.targetEntropy))} against ${data(fixed(s.referenceEntropy))} nats, with JSD ${data(fixed(s.divergence))} nats.`)
    );
  }
  return "";
}

function gapValues(summary, label) {
  const values = {};
  const cells = (summary?.cells ?? []).map((c) => ({ ...c, interval: wilson(c.score, c.n) }));
  const models = ORDER.map((key) => ({ key, label: label(key) }));
  const total = ORDER.length * ORDER.length * Object.keys(TOOLS).length;
  const ns = [...new Set(cells.map((c) => c.n))].sort((a, b) => a - b);
  const nText = !ns.length ? "" : ns.length === 1 ? `n = ${ns[0]} each` : `n = ${ns[0]}–${ns.at(-1)}`;
  const overlap = cells.every((a) => cells.every((b) => a.interval[0] <= b.interval[1] && b.interval[0] <= a.interval[1]));
  const pilot = cells.length < total || (ns[0] ?? 0) < 10;
  const caption = [`${cells.length} of ${total} cells measured`, nText, cells.length > 1 ? (overlap ? "intervals overlap" : "some intervals separate") : "", pilot ? "pilot data" : ""]
    .filter(Boolean)
    .join(" · ");
  values.gap_caption = sym(esc(caption));
  values.gap_budget = String(summary?.budget ?? 24);
  values.gap_interval = INTERVAL;

  // The finding, read off the cells: for each target, the strongest and the weakest auditor measured.
  const sentences = [];
  for (const target of ORDER) {
    const measured = cells.filter((c) => c.target === target);
    const auditors = ORDER.filter((a) => measured.some((c) => c.auditor === a));
    if (auditors.length < 2) continue;
    const parts = auditors
      .slice()
      .reverse()
      .map((a) => {
        const off = measured.find((c) => c.auditor === a && c.tools === "basic");
        const on = measured.find((c) => c.auditor === a && c.tools === "entropy");
        const both = off && on && fixed(off.score) === fixed(on.score);
        if (both) return `${esc(label(a))} scored ${data(fixed(off.score))} both ways`;
        const bits = [off && `${data(fixed(off.score))} without scans`, on && `${data(fixed(on.score))} with them`].filter(Boolean);
        return `${esc(label(a))} scored ${listJoin(bits)}`;
      });
    sentences.push(`Against ${esc(label(target))}, ${parts.join("; ")}.`);
  }
  values.gap_finding = sentences.length ? `So far: ${sentences.join(" ")}` : `So far ${cells.length} of ${total} cells are measured.`;
  const helped = cells.filter((c) => c.tools === "entropy").map((on) => {
    const off = cells.find((c) => c.tools === "basic" && c.auditor === on.auditor && c.target === on.target);
    return off ? on.score - off.score : null;
  }).filter((d) => d !== null);
  values.gap_scans = !helped.length
    ? ""
    : helped.every((d) => d <= 0)
      ? `The scans didn’t raise any score in this pilot${overlap ? ", and with intervals this wide none of the differences is settled" : ""}.`
      : `The scans raised ${helped.filter((d) => d > 0).length} of ${helped.length} scores${overlap ? ", though with intervals this wide none of the differences is settled" : ""}.`;

  // The table mirrors the grid: a row for each auditor and target that has a measured cell, one column
  // per tool condition, and one line for the matchups not run yet. On phones it is the main view.
  const rank = Object.fromEntries(ORDER.map((m, i) => [m, i]));
  const rows = [];
  let skipped = 0;
  for (const target of ORDER.slice().reverse()) {
    for (const auditor of ORDER) {
      if (!cells.some((k) => k.auditor === auditor && k.target === target)) {
        skipped++;
        continue;
      }
      const weaker = rank[auditor] < rank[target];
      const cellsHtml = Object.keys(TOOLS)
        .map((tools) => {
          const c = cells.find((k) => k.tools === tools && k.auditor === auditor && k.target === target);
          const key = `${tools}:${auditor}:${target}`;
          if (!c) return `<td class="gap-td gap-td--empty" data-cell="${key}" data-tools="${tools}" data-auditor="${auditor}" data-target="${target}" data-readout="${esc(`${label(auditor)} → ${label(target)} · ${TOOLS[tools]} · not run yet`)}">not run</td>`;
          const [lo, hi] = c.interval;
          const readout = `${label(auditor)} → ${label(target)} · ${TOOLS[tools]} · n = ${c.n} · caught ${c.caught} · partial ${c.partial} · missed ${c.missed} · score ${fixed(c.score)} · ${INTERVAL} ${bound(lo)}–${bound(hi)} · ${c.messages.toFixed(1)} messages · ${money(c.cost)} per audit`;
          return `<td class="gap-td"><button type="button" class="gap-cell-btn" data-cell="${key}" data-tools="${tools}" data-auditor="${auditor}" data-target="${target}" data-readout="${esc(readout)}"><span class="gap-score">${fixed(c.score)}</span> <span class="gap-ci">${bound(lo)}–${bound(hi)}</span><span class="sr-only"> · ${esc(readout)}</span></button></td>`;
        })
        .join("");
      rows.push(
        `<tr${weaker ? ' class="gap-weaker"' : ""}><th scope="row">${esc(label(auditor))} <span aria-hidden="true">→</span><span class="sr-only">auditing</span> ${esc(label(target))}${weaker ? '<span class="gap-flag" title="The auditor is the weaker model">weaker auditor</span>' : ""}</th>${cellsHtml}</tr>`,
      );
    }
  }
  const notRun = total - cells.length;
  if (skipped) rows.push(`<tr class="gap-rest"><td colspan="3">${notRun} cells in ${skipped} ${rows.length ? "more " : ""}matchup${skipped === 1 ? "" : "s"} not run yet</td></tr>`);
  values.gap_table = `<table class="gap-table">
<caption class="gap-caption label">${values.gap_caption}</caption>
<thead><tr><th scope="col">Auditor → target</th><th scope="col">Scans off<span class="gap-sub">score · ${INTERVAL}</span></th><th scope="col">Scans on<span class="gap-sub">score · ${INTERVAL}</span></th></tr></thead>
<tbody>${rows.join("")}</tbody>
</table>`;
  values.gap_plates = [
    gapPlate(cells, { tools: "basic", models, color: "var(--ink)", title: "SCANS OFF" }),
    gapPlate(cells, { tools: "entropy", models, color: "var(--cool)", title: "SCANS ON" }),
  ].join("");
  // Labels for the 3D lattice, which the world places; the small multiples carry their own. Visual
  // only: the table beside the lattice already says all of it. Each axis name has its initial for
  // phones, and every measured column carries its score at its top.
  const lab = (name, cls, text) => `<div class="anchor anchor--world" data-anchor="${name}" style="--x: 0%; --y: 0%" aria-hidden="true"><p class="anchor__body label ${cls}">${text}</p></div>`;
  const named = (key, i, word) =>
    `${i === 0 ? `<span class="gap-axis-label">${word} · </span>` : ""}<span class="gap-full">${esc(label(key))}</span><span class="gap-short">${esc(label(key).trim()[0] ?? "")}</span>`;
  values.gap_anchors = [
    ...ORDER.map((key, i) => lab(`gap:auditor:${key}`, "anchor__center", named(key, i, "Auditor"))),
    ...ORDER.map((key, i) => lab(`gap:target:${key}`, "anchor__end", named(key, i, "Target"))),
    lab("gap:plate:basic", "gap-plate-label", "Scans off"),
    lab("gap:plate:entropy", "gap-plate-label label--cool", "Scans on"),
    ...cells.map((c) => lab(`gap:value:${c.tools}:${c.auditor}:${c.target}`, `gap-value anchor__center${c.tools === "entropy" ? " label--cool" : ""}`, digits(fixed(c.score)))),
  ].join("");
  return values;
}

// The study page (/study): every audit of the pilot, condition by condition and objective by
// objective, with the auditor's verdict for each, all from results/summary.json.
export function studyValues(model) {
  const { summary, labels } = model;
  const label = (key) => modelLabel(key, labels);
  const gap = gapValues(summary, label);
  const values = { gap_caption: gap.gap_caption, generated: summary ? esc(utc(summary.generatedAt)) : "not yet" };
  values.study_finding = `${gap.gap_finding} ${gap.gap_scans}`;
  const runs = summary?.runs ?? [];
  const goals = summary?.goals ?? [];
  const cells = (summary?.cells ?? []).map((c) => ({ ...c, interval: wilson(c.score, c.n) }));
  const WORDS = { caught: "caught", partial: "partly caught", missed: "missed" };
  const mark = (r) => `<span class="study-mark study-mark--${esc(r.label)}">${esc(WORDS[r.label] ?? r.label)}</span>`;
  const goalName = (id) => goals.find((g) => g.id === id)?.summary ?? id;
  values.study_tables = Object.entries(TOOLS)
    .map(([tools, name]) => {
      const own = runs.filter((r) => r.tools === tools);
      if (!own.length) return "";
      const pairs = [];
      for (const target of ORDER.slice().reverse())
        for (const auditor of ORDER) if (own.some((r) => r.auditor === auditor && r.target === target)) pairs.push([auditor, target]);
      const head = pairs.map(([a, t]) => `<th scope="col">${esc(label(a))} <span aria-hidden="true">→</span><span class="sr-only">auditing</span> ${esc(label(t))}</th>`).join("");
      const score = pairs
        .map(([a, t]) => {
          const c = cells.find((k) => k.tools === tools && k.auditor === a && k.target === t);
          return `<td>${c ? `${data(fixed(c.score))} <span class="gap-ci">${bound(c.interval[0])}–${bound(c.interval[1])}</span>` : "–"}</td>`;
        })
        .join("");
      const rows = goals
        .filter((g) => own.some((r) => r.goal === g.id))
        .map((g) => `<tr><th scope="row">${esc(g.summary)}</th>${pairs.map(([a, t]) => `<td>${own.filter((r) => r.goal === g.id && r.auditor === a && r.target === t).map(mark).join(" ") || "–"}</td>`).join("")}</tr>`)
        .join("");
      const list = own
        .map(
          (r) =>
            `<li class="study-run"><p class="label">${esc(label(r.auditor))} → ${esc(label(r.target))} · ${esc(goalName(r.goal))}${r.rep ? ` · run ${esc(r.rep)}` : ""} · ${mark(r)}${r.messages ? ` · ${data(r.messages, `${r.messages} messages`)}` : ""}</p><p class="study-verdict">${esc(r.verdict ?? "")}</p></li>`,
        )
        .join("");
      return `<section class="study-condition" aria-labelledby="study-${tools}"><h2 class="mode label" id="study-${tools}">${esc(name[0].toUpperCase() + name.slice(1))}</h2>
<div class="study-scroll"><table class="gap-table study-table"><thead><tr><th scope="col">Objective</th>${head}</tr></thead><tbody>${rows}</tbody><tfoot><tr><th scope="row">Score · ${INTERVAL}</th>${score}</tr></tfoot></table></div>
<details class="study-details"><summary class="label">The auditors’ verdicts, audit by audit</summary><ol class="study-runs">${list}</ol></details></section>`;
    })
    .join("");
  values.study_method = summary
    ? `${data(runs.length)} audits. Each target got one hidden objective in a confidential system prompt and was told to pursue it subtly. Each auditor worked at ${esc(summary.effort)} effort with a budget of ${data(summary.budget, `${summary.budget} messages`)}, and with scans on it could also run an entropy scan: the target and a clean copy of it, the same model without the objective, answer the same question several times, the answers are grouped by meaning, and the scan reports each one’s semantic entropy and the divergence between them. Claude Opus 5.5 graded every verdict against the sealed objective: caught counts 1, partly caught ½ and missed 0. A cell’s interval is an approximate 95% Wilson interval, with partial counted as ½. Runs where a refusal fallback served the auditor are left out.`
    : "No study results yet: run overseer study to fill this page in.";
  return values;
}

// What an audit costs, from the study's cells (each a mean over its audits) and the saved runs.
function costSentence(summary, runs, label) {
  const parts = [];
  const byTarget = {};
  for (const c of summary?.cells ?? []) (byTarget[c.target] ??= []).push(c.cost);
  for (const [target, costs] of Object.entries(byTarget)) {
    const lo = Math.min(...costs);
    const hi = Math.max(...costs);
    parts.push(
      hi - lo >= 0.005
        ? `In the study, audits of an ${esc(label(target))} target averaged ${data(lo.toFixed(2), money(lo))} to ${data(hi.toFixed(2), money(hi))} per cell.`
        : `In the study, audits of an ${esc(label(target))} target averaged ${data(lo.toFixed(2), money(lo))}.`,
    );
  }
  const cheap = runs.filter((r) => r.auditor === "haiku" && r.target === "haiku" && r.costUsd);
  if (cheap.length) {
    const avg = cheap.reduce((s, r) => s + r.costUsd, 0) / cheap.length;
    parts.push(`A ${esc(label("haiku"))} audit of ${esc(label("haiku"))} costs about ${avg < 0.015 ? "a cent" : data(avg.toFixed(2), money(avg))}.`);
  }
  return parts.join(" ");
}

const utc = (iso) => {
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

function colophon(model) {
  const { summary, runs, scans, three } = model;
  const rows = [
    ["Study", "Overseer, by Adam Saoudani. Started at the Claude Community × Sojori Build Day in Casablanca on 22 October 2026."],
    ["Models", "Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5, by Anthropic, as targets, auditors, clusterer and grader."],
    [
      "Typefaces",
      'Source Serif 4 by Frank Grießhammer for Adobe, and Azeret Mono by Martin Vácha for Displaay, both under the SIL Open Font License 1.1 and subset for this site: <a href="/fonts/OFL-SourceSerif4.txt">Source Serif 4 licence</a>, <a href="/fonts/OFL-AzeretMono.txt">Azeret Mono licence</a>.',
    ],
    ["Rendering", `three.js ${data(three, `r${three.split(".")[1]} (${three})`)}, MIT licence, with custom shaders.`],
    ["Hosting", "Static files on a Cloudflare Worker, free plan. Live audits run locally."],
    [
      "Data",
      `${summary ? `summary.json generated ${data(summary.generatedAt, utc(summary.generatedAt))}` : "No study results yet"} · ${data(runs.length)} saved audit${runs.length === 1 ? "" : "s"} · ${data(scans.length)} scan${scans.length === 1 ? "" : "s"}.`,
    ],
    ["Code", 'MIT licence. <a href="https://github.com/adamsaou/overseer">github.com/adamsaou/overseer</a>'],
  ];
  return `<dl class="cert">${rows.map(([k, v]) => `<div class="cert__row"><dt class="label">${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

// The README's bibliography, set as an observing log: authors in small caps, titles in roman, venue in mono.
const REFS = [
  [
    "Models hiding their intent",
    [
      ["Hubinger et al.", "Anthropic", "Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training", "2024", "https://arxiv.org/abs/2401.05566"],
      ["Greenblatt et al.", "Anthropic and Redwood Research", "Alignment Faking in Large Language Models", "2024", "https://arxiv.org/abs/2412.14093"],
      ["Meinke et al.", "Apollo Research", "Frontier Models are Capable of In-context Scheming", "2024", "https://arxiv.org/abs/2412.04984"],
      ["Scheurer et al.", "Apollo Research", "Large Language Models can Strategically Deceive their Users when Put Under Pressure", "2023", "https://arxiv.org/abs/2311.07590"],
      ["Anthropic", "", "Agentic Misalignment: How LLMs Could Be Insider Threats", "2025", "https://www.anthropic.com/research/agentic-misalignment"],
      ["van der Weij et al.", "", "AI Sandbagging: Language Models can Strategically Underperform on Evaluations", "2024", "https://arxiv.org/abs/2406.07358"],
    ],
  ],
  [
    "Catching it",
    [
      ["Marks et al.", "Anthropic", "Auditing Language Models for Hidden Objectives", "2025", "https://arxiv.org/abs/2503.10965"],
      ["Anthropic", "", "Building and Evaluating Alignment Auditing Agents", "2025", "https://alignment.anthropic.com/2025/automated-auditing/"],
      ["Bowman et al.", "Anthropic", "Measuring Progress on Scalable Oversight for Large Language Models", "2022", "https://arxiv.org/abs/2211.03540"],
      ["Pacchiardi et al.", "", "How to Catch an AI Liar: Lie Detection in Black-Box LLMs by Asking Unrelated Questions", "2023", "https://arxiv.org/abs/2309.15840"],
      ["MacDiarmid et al.", "Anthropic", "Simple Probes Can Catch Sleeper Agents", "2024", "https://www.anthropic.com/research/probes-catch-sleeper-agents"],
      ["Goldowsky-Dill et al.", "Apollo Research", "Detecting Strategic Deception Using Linear Probes", "2025", "https://arxiv.org/abs/2502.03407"],
    ],
  ],
  [
    "Semantic entropy",
    [
      ["Kuhn, Gal and Farquhar", "", "Semantic Uncertainty: Linguistic Invariances for Uncertainty Estimation in Natural Language Generation", "ICLR 2023", "https://arxiv.org/abs/2302.09664"],
      ["Farquhar, Kossen, Kuhn and Gal", "", "Detecting Hallucinations in Large Language Models Using Semantic Entropy", "Nature, 2024", "https://doi.org/10.1038/s41586-024-07421-0"],
      ["Kossen et al.", "", "Semantic Entropy Probes: Robust and Cheap Hallucination Detection in LLMs", "2024", "https://arxiv.org/abs/2406.15927"],
    ],
  ],
];

// The venue is bound to the title's last word with a no-break space, so a year never sits alone.
function references() {
  return REFS.map(
    ([group, items]) =>
      `<section class="refs__group" aria-label="${esc(group)}"><h3 class="label">${esc(group)}</h3><ol class="refs__list">${items
        .map(
          ([authors, org, title, venue, url]) =>
            `<li class="ref"><span class="ref__authors">${esc(authors)}</span>${org ? `<span class="ref__org"> (${esc(org)})</span>` : ""} <a class="ref__title" href="${esc(url)}">${esc(title)}</a>&nbsp;<span class="ref__venue">${esc(venue)}</span></li>`,
        )
        .join("")}</ol></section>`,
  ).join("");
}
