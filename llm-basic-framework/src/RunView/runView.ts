import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { REPLAY_SOURCE, ReplayState, applyEvent, createEmptyState, docOf } from './replayCore';
import { sortByNumericId } from '../utils/fsUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

/**
 * Run playback viewer (SKEIN v2): one self-contained HTML file that replays, document by
 * document, how each processed report changed the ladders and the registry.
 *
 * Follows the gold-view idiom (`src/Gold/registryView.ts`): no dependencies, light/dark, every
 * member string escaped, data embedded as JSON — works from `file://`.
 *
 * The replay journal is `decisions.jsonl` (requires the run to have set `DECISIONS_LOG=1`);
 * the scrubber axis is derived from the artifacts directory (numeric-id order — the stream
 * order), so it can never drift from what actually ran. The final replayed frame is diffed
 * against `registry.json` at generation time; any mismatch renders as a warning banner.
 */

export interface DocRef {
  id: number;
  date: string;
  title: string;
}

export interface RunViewData {
  runId: string;
  /** Arm identity, read from the run card — what the model switcher labels this run with. */
  arm: ArmId;
  docOrder: DocRef[];
  events: Array<Record<string, unknown>>;
  /** Per-category canonical names of the final on-disk registry, for the self-check. */
  registryFinal: Record<string, string[]>;
  /** category → canonical → rung, from the final registry (see loadRunData). */
  registryRungs: Record<string, Record<string, string>>;
  selfCheck: SelfCheck;
}

/**
 * Which arm a run is, in the terms the experiment varies along: the condition label, the model
 * that answered the per-document judge calls, and the (possibly different) ladder ensemble. A
 * mixed-window local arm runs `gemma4:e2b-8k` for the judge and `…-16k` for the ladder, so the
 * two are recorded separately rather than collapsed into one "model" string.
 */
export interface ArmId {
  condition: string;
  provider: string;
  model: string;
  ladderModels: string | null;
}

export interface SelfCheck {
  ok: boolean;
  /** category → canonicals the replay has but the registry lacks, and vice versa. */
  extraInReplay: Record<string, string[]>;
  missingInReplay: Record<string, string[]>;
}

export async function loadRunData(runDir: string): Promise<RunViewData> {
  const decisionsPath = path.join(runDir, 'decisions.jsonl');
  if (!existsSync(decisionsPath)) {
    throw new Error(
      `${decisionsPath} not found — playback needs a run made with DECISIONS_LOG=1`
    );
  }
  const events = (await fs.readFile(decisionsPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const artifactsDir = path.join(runDir, 'artifacts');
  const docOrder: DocRef[] = [];
  if (existsSync(artifactsDir)) {
    for (const file of sortByNumericId(await fs.readdir(artifactsDir))) {
      try {
        const artifact = JSON.parse(await fs.readFile(path.join(artifactsDir, file), 'utf8'));
        docOrder.push({
          id: Number(artifact.metadata?.id) || parseInt(file, 10) || 0,
          date: String(artifact.metadata?.date ?? 'unknown'),
          title: String(artifact.metadata?.title ?? file),
        });
      } catch {
        // an unreadable artifact loses its title, not the whole page
        docOrder.push({ id: parseInt(file, 10) || 0, date: 'unknown', title: file });
      }
    }
  } else {
    // No artifacts (log-only input): derive the axis from the events themselves.
    const seen = new Set<number>();
    for (const event of events) {
      const doc = docOf(event);
      if (doc >= 0 && !seen.has(doc)) {
        seen.add(doc);
        docOrder.push({ id: doc, date: 'unknown', title: `doc ${doc}` });
      }
    }
  }

  const registryFinal: Record<string, string[]> = {};
  const registryRungs: Record<string, Record<string, string>> = {};
  const registryPath = path.join(runDir, 'registry.json');
  if (existsSync(registryPath)) {
    const registry = new EntityRegistry({ filePath: registryPath });
    await registry.load();
    for (const category of registry.categories()) {
      const records = registry.records(category);
      registryFinal[category] = Object.keys(records).sort();
      // Rungs mostly reach the registry through retroactive ladder binding, which emits no
      // journal event — so the replay alone knows a rung only for the ~114 entities whose
      // granularity-edge event happened to carry `mentionRung`, out of ~1700 that have one.
      // Carrying the registry's rungs lets every entity show its level; the page marks these as
      // final-state, because unlike journal events they are not attributable to a document.
      for (const [canonical, record] of Object.entries(records)) {
        const rung = (record as { rung?: unknown }).rung;
        if (typeof rung === 'string' && rung) (registryRungs[category] ??= {})[canonical] = rung;
      }
    }
  }

  let runId = path.basename(runDir);
  const arm: ArmId = { condition: runId, provider: 'unknown', model: 'unknown', ladderModels: null };
  const cardPath = path.join(runDir, 'run-card.json');
  if (existsSync(cardPath)) {
    try {
      const card = JSON.parse(await fs.readFile(cardPath, 'utf8'));
      runId = String(card.runId ?? runId);
      arm.condition = String(card.condition ?? card.config?.condition ?? runId);
      arm.provider = String(card.config?.llm?.provider ?? 'unknown');
      arm.model = String(card.config?.llm?.model ?? 'unknown');
      const ladderModels = card.config?.extra?.ladder?.ensembleModels;
      arm.ladderModels = ladderModels ? String(ladderModels) : null;
    } catch {
      /* keep directory name */
    }
  }

  const selfCheck = computeSelfCheck(replayAll(events), registryFinal);
  return { runId, arm, docOrder, events, registryFinal, registryRungs, selfCheck };
}

export function replayAll(events: Array<Record<string, unknown>>): ReplayState {
  const state = createEmptyState();
  for (const event of events) applyEvent(state, event as Record<string, never>);
  return state;
}

/**
 * Generation-time cross-check: the final replayed frame must reproduce the on-disk registry's
 * canonical sets. A mismatch means the journal is incomplete for some operation — surfaced as a
 * banner, never silently.
 */
export function computeSelfCheck(
  state: ReplayState,
  registryFinal: Record<string, string[]>
): SelfCheck {
  const extraInReplay: Record<string, string[]> = {};
  const missingInReplay: Record<string, string[]> = {};
  if (Object.keys(registryFinal).length === 0) {
    return { ok: true, extraInReplay, missingInReplay };
  }

  const categories = new Set([...Object.keys(registryFinal), ...Object.keys(state.categories)]);
  for (const category of categories) {
    const replayed = new Set(Object.keys(state.categories[category]?.entities ?? {}));
    const onDisk = new Set(registryFinal[category] ?? []);
    const extra = [...replayed].filter((name) => !onDisk.has(name)).sort();
    const missing = [...onDisk].filter((name) => !replayed.has(name)).sort();
    if (extra.length > 0) extraInReplay[category] = extra;
    if (missing.length > 0) missingInReplay[category] = missing;
  }
  return {
    ok: Object.keys(extraInReplay).length === 0 && Object.keys(missingInReplay).length === 0,
    extraInReplay,
    missingInReplay,
  };
}

const esc = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Renders the playback page for one run, or for several arms in ONE page with a model switcher.
 *
 * Multi-arm mode exists to compare arms on the same document: every arm replays the same frozen
 * extractions, so the switcher carries the scrub position across by document id (not by frame
 * index, which would drift if an arm produced fewer artifacts). Each arm keeps its own journal,
 * frame count and self-check banner — nothing is merged, so a claim can always be traced to the
 * run that produced it.
 */
export function renderRunViewHtml(input: RunViewData | RunViewData[]): string {
  const runs = Array.isArray(input) ? input : [input];
  if (runs.length === 0) throw new Error('renderRunViewHtml needs at least one run');

  const payload = JSON.stringify(
    runs.map((data) => ({
      runId: data.runId,
      arm: data.arm,
      registryRungs: data.registryRungs,
      docOrder: data.docOrder,
      events: data.events,
      selfCheck: data.selfCheck,
    }))
  ).replace(/</g, '\\u003c'); // </script> can never terminate the block

  const title =
    runs.length === 1
      ? `SKEIN run playback — ${esc(runs[0].runId)}`
      : `SKEIN run playback — ${runs.length} arms (${esc(runs.map((r) => r.arm.model).join(' vs '))})`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${title}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --panel: #f6f8fa;
    --chip1: #0969da; --chip2: #9a6700; --chip3: #8250df; --warn-bg: #fff8c5; --warn-line: #d4a72c;
    --hl: #fff3b8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --panel: #161b22;
      --chip1: #58a6ff; --chip2: #d29922; --chip3: #bc8cff; --warn-bg: #3a2d12; --warn-line: #9e6a03;
      --hl: #4d3800;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
           background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0 0 6px; }
  header .sub { color: var(--muted); font-size: 12px; }
  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .controls input[type=range] { flex: 1; min-width: 200px; }
  .controls button { background: var(--panel); color: var(--fg); border: 1px solid var(--line);
                     border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 13px; }
  .controls .pos { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
  .armrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px;
            padding-bottom: 8px; border-bottom: 1px dashed var(--line); }
  .armrow label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
                  color: var(--muted); }
  .armrow select { background: var(--panel); color: var(--fg); border: 1px solid var(--line);
                   border-radius: 6px; padding: 3px 8px; font-size: 13px; max-width: 100%; }
  .armrow .armmeta { color: var(--muted); font-size: 12px; }
  .armrow .armmeta code { color: var(--fg); }
  .banner { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 6px;
            padding: 8px 12px; margin: 10px 16px; font-size: 13px; }
  main { display: grid; grid-template-columns: 220px 1fr 340px; gap: 0; min-height: 0; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  nav { border-right: 1px solid var(--line); padding: 10px; }
  nav .cat { display: flex; justify-content: space-between; padding: 4px 8px; border-radius: 6px;
             cursor: pointer; }
  nav .cat.active { background: var(--panel); font-weight: 600; }
  nav .cat .n { color: var(--muted); font-variant-numeric: tabular-nums; }
  section.middle { padding: 12px 16px; min-width: 0; }
  aside { border-left: 1px solid var(--line); padding: 12px; font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
       margin: 14px 0 6px; }
  .ladder { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
  .rung { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
  .g { font-weight: 700; font-variant-numeric: tabular-nums; width: 26px; }
  .chip { font-size: 11px; border-radius: 10px; padding: 0 8px; border: 1px solid var(--line); }
  .chip.preserving { color: var(--chip1); border-color: var(--chip1); }
  .chip.widening { color: var(--chip2); border-color: var(--chip2); }
  .chip.disputed { color: var(--chip3); border-color: var(--chip3); }
  .foldtest { color: var(--muted); font-size: 12px; width: 100%; padding-left: 34px; }
  ul.forest { list-style: none; padding-left: 18px; margin: 4px 0; }
  ul.forest > li { padding: 2px 0; }
  .ent { border-radius: 4px; padding: 1px 4px; }
  .ent.changed { background: var(--hl); }
  .ent .rungtag { color: var(--muted); font-size: 11px; margin-left: 4px; }
  /* Dotted = read from the final registry, not from a journal event at this frame. */
  .ent .rungtag.final { border-bottom: 1px dotted var(--muted); cursor: help; opacity: .75; }
  .ent .deferred { color: var(--chip2); font-size: 11px; margin-left: 4px; }
  .aliases { color: var(--muted); font-size: 12px; padding-left: 12px; overflow-wrap: anywhere; }
  .edgekind { font-size: 11px; margin-left: 6px; }
  .edgekind.coarsens-to { color: var(--chip1); }
  .edgekind.part-of { color: var(--chip2); }
  .repeat { color: var(--muted); font-style: italic; }
  input.filter { width: 100%; margin: 4px 0 8px; padding: 5px 8px; border: 1px solid var(--line);
                 border-radius: 6px; background: var(--bg); color: var(--fg); }
  .event { border-bottom: 1px solid var(--line); padding: 5px 0; overflow-wrap: anywhere; }
  .event .op { font-weight: 600; }
  .event .op.link { color: var(--chip1); }
  .event .op.mint { color: var(--fg); }
  .event .op.defer { color: var(--chip2); }
  .event .op.repair { color: var(--chip3); }
  .event .why { color: var(--muted); font-size: 12px; }
  details.singletons summary { color: var(--muted); cursor: pointer; }
  .renames { color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>SKEIN run playback — <code id="runid"></code></h1>
  <div class="armrow" id="armrow" hidden>
    <label for="arm">model / arm</label>
    <select id="arm"></select>
    <span class="armmeta" id="armmeta"></span>
  </div>
  <div class="sub" id="docline"></div>
  <div class="controls">
    <button id="step-back" title="one document back">⏮</button>
    <button id="play">▶</button>
    <button id="step-fwd" title="one document forward">⏭</button>
    <input type="range" id="scrubber" min="0" value="0">
    <span class="pos" id="pos"></span>
    <select id="speed"><option value="600">slow</option><option value="250" selected>normal</option><option value="80">fast</option></select>
  </div>
</header>
<div id="banner"></div>
<main>
  <nav id="cats"></nav>
  <section class="middle">
    <input class="filter" id="filter" placeholder="filter entity names…">
    <h2>Granularity ladder</h2>
    <div id="ladder"></div>
    <h2>Registry (granularity forest)</h2>
    <div id="forest"></div>
  </section>
  <aside>
    <h2 id="doc-events-title">This document</h2>
    <div id="doc-events"></div>
  </aside>
</main>
<script>
${REPLAY_SOURCE}

var DATA = null; // the active arm — bound by bindArm() below
var RUNS = ${payload};
var runIndex = 0;

// Frame f = state after processing docOrder[f-1]; frame 0 = empty; the last frame appends the
// consolidator's batch-reference chapter (doc -1 events logged after the stream — T11: per-document
// repair ops now carry their own real doc id, so this trailing frame is specific to the older
// whole-corpus consolidator pass). Every arm has its own journal and therefore its own frame axis,
// so these are rebound on each arm switch.
var repairEvents = [];
var frameCount = 0;
var frame = 0;
var activeCategory = null;
var playTimer = null;

/**
 * Switch arms, carrying the reading position across by DOCUMENT ID rather than frame index —
 * arms can differ in how many artifacts they produced, so index 57 need not be the same report.
 * An arm that never saw the current document clamps instead of jumping somewhere arbitrary.
 */
function bindArm(index, keepDocId) {
  runIndex = index;
  DATA = RUNS[index];
  repairEvents = DATA.events.filter(function (e) { return docOf(e) < 0; });
  var previous = frame;
  frameCount = DATA.docOrder.length + (repairEvents.length > 0 ? 1 : 0);
  if (keepDocId === undefined || keepDocId === null || keepDocId === -1) {
    frame = frameCount;
    return;
  }
  for (var i = 0; i < DATA.docOrder.length; i++) {
    if (DATA.docOrder[i].id === keepDocId) { frame = i + 1; return; }
  }
  frame = Math.min(previous, frameCount);
}

/** "a,a,a" → "a ×3" — the ladder ensemble spec repeats one model per member. */
function collapseModelSpec(spec) {
  var counts = {}; var order = [];
  spec.split(',').forEach(function (entry) {
    var name = entry.trim();
    if (!name) return;
    if (counts[name] === undefined) { counts[name] = 0; order.push(name); }
    counts[name] += 1;
  });
  return order.map(function (n) { return counts[n] > 1 ? n + ' \\u00d7' + counts[n] : n; }).join(', ');
}

function renderArmBar() {
  if (RUNS.length < 2) return;
  var row = document.getElementById('armrow');
  row.hidden = false;
  document.getElementById('arm').innerHTML = RUNS.map(function (r, i) {
    return '<option value="' + i + '"' + (i === runIndex ? ' selected' : '') + '>' +
      esc(r.arm.condition) + ' \\u2014 ' + esc(r.arm.provider) + '/' + esc(r.arm.model) + '</option>';
  }).join('');
  var meta = '<code>' + esc(DATA.runId) + '</code> \\u00b7 ' + DATA.docOrder.length + ' doc(s)';
  if (DATA.arm.ladderModels) {
    meta += ' \\u00b7 ladder: <code>' + esc(collapseModelSpec(DATA.arm.ladderModels)) + '</code>';
  }
  if (!DATA.selfCheck.ok) meta += ' \\u00b7 \\u26a0 journal incomplete';
  document.getElementById('armmeta').innerHTML = meta;
}

function eventsUpTo(f) {
  var docsIncluded = {};
  var limit = Math.min(f, DATA.docOrder.length);
  for (var i = 0; i < limit; i++) docsIncluded[DATA.docOrder[i].id] = true;
  var includeRepair = f > DATA.docOrder.length || (f === frameCount && repairEvents.length > 0 && f > DATA.docOrder.length - 1 && frameCount > DATA.docOrder.length);
  return DATA.events.filter(function (e) {
    var d = docOf(e);
    if (d < 0) return includeRepair;
    return docsIncluded[d] === true;
  });
}

function stateAt(f) {
  var state = createEmptyState();
  eventsUpTo(f).forEach(function (e) { applyEvent(state, e); });
  return state;
}

function currentDocId(f) {
  if (f === 0) return null;
  if (f > DATA.docOrder.length) return -1;
  return DATA.docOrder[f - 1].id;
}

var esc = function (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

function render() {
  var state = stateAt(frame);
  var docId = currentDocId(frame);
  document.getElementById('runid').textContent = DATA.runId;
  renderArmBar();
  document.getElementById('scrubber').max = String(frameCount);
  document.getElementById('scrubber').value = String(frame);

  var posLabel = frame === 0 ? 'before first document'
    : frame > DATA.docOrder.length ? 'after batch-reference chapter'
    : 'after doc ' + frame + '/' + DATA.docOrder.length;
  document.getElementById('pos').textContent = posLabel +
    ' · links ' + state.counts.links + ' · mints ' + state.counts.mints + ' · defers ' + state.counts.defers;

  var docline = '';
  if (docId !== null && docId >= 0) {
    var ref = DATA.docOrder[frame - 1];
    docline = 'doc ' + ref.id + ' — ' + esc(ref.title) + ' (' + esc(ref.date) + ')';
  } else if (docId === -1) {
    docline = 'batch-reference chapter: consolidator operations (merge / split / edge / rename / category correction)';
  }
  document.getElementById('docline').innerHTML = docline;

  renderBanner();
  renderCategories(state);
  renderLadder(state);
  renderForest(state, docId);
  renderDocEvents(docId);
}

function renderBanner() {
  var el = document.getElementById('banner');
  if (DATA.selfCheck.ok) { el.innerHTML = ''; return; }
  var parts = [];
  Object.keys(DATA.selfCheck.missingInReplay).forEach(function (cat) {
    parts.push(cat + ': ' + DATA.selfCheck.missingInReplay[cat].length + ' canonical(s) on disk but not replayable');
  });
  Object.keys(DATA.selfCheck.extraInReplay).forEach(function (cat) {
    parts.push(cat + ': ' + DATA.selfCheck.extraInReplay[cat].length + ' replayed but not on disk');
  });
  el.innerHTML = '<div class="banner">⚠ journal incomplete — the replayed final state differs from registry.json (' +
    esc(parts.join('; ')) + '). Playback is still usable, but treat per-frame states as approximate.</div>';
}

function renderCategories(state) {
  var cats = Object.keys(state.categories).sort();
  if (activeCategory === null || cats.indexOf(activeCategory) === -1) activeCategory = cats[0] || null;
  document.getElementById('cats').innerHTML = cats.map(function (cat) {
    var n = Object.keys(state.categories[cat].entities).length;
    return '<div class="cat' + (cat === activeCategory ? ' active' : '') + '" data-cat="' + esc(cat) + '">' +
      '<span>' + esc(cat) + '</span><span class="n">' + n + '</span></div>';
  }).join('') || '<div class="empty">no categories yet</div>';
  Array.prototype.forEach.call(document.querySelectorAll('#cats .cat'), function (el) {
    el.addEventListener('click', function () { activeCategory = el.getAttribute('data-cat'); render(); });
  });
}

function renderLadder(state) {
  var el = document.getElementById('ladder');
  var versions = (activeCategory && state.ladders[activeCategory]) || [];
  if (versions.length === 0) {
    el.innerHTML = '<div class="empty">no ladder discovered yet' +
      (activeCategory ? ' for ' + esc(activeCategory) : '') + ' — flat g0 mode</div>';
    return;
  }
  var ladder = versions[versions.length - 1];
  var html = '<div class="ladder"><div class="sub">version ' + esc(ladder.version) +
    ' · ' + esc(ladder.runs) + ' run(s) · discovered at doc ' + esc(ladder.discoveredAtDoc) +
    (versions.length > 1 ? ' · ' + (versions.length - 1) + ' earlier version(s)' : '') + '</div>';
  (ladder.rungs || []).forEach(function (rung) {
    var chips = '';
    if (rung.g > 0) {
      chips += rung.preserving
        ? '<span class="chip preserving">preserving · coarsens-to</span>'
        : '<span class="chip widening">widening · part-of</span>';
    }
    if (rung.disputed) chips += ' <span class="chip disputed">disputed</span>';
    if (rung.move) chips += ' <span class="chip">' + esc(rung.move) + '</span>';
    html += '<div class="rung"><span class="g">g' + esc(rung.g) + '</span>' +
      '<span>' + esc(rung.example) + '</span> <span class="sub">(' + esc(rung.alias) + ')</span> ' + chips;
    if (rung.foldTest) html += '<div class="foldtest">' + esc(rung.foldTest) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  if ((ladder.rejected || []).length > 0) {
    html += '<div class="sub">rejected: ' + ladder.rejected.map(function (r) {
      return esc(r.candidate) + ' (gate ' + esc(r.gate) + ')';
    }).join(' · ') + '</div>';
  }
  el.innerHTML = html;
}

function renderForest(state, docId) {
  var el = document.getElementById('forest');
  var bucket = activeCategory ? state.categories[activeCategory] : null;
  if (!bucket) { el.innerHTML = '<div class="empty">nothing here yet</div>'; return; }
  var filter = document.getElementById('filter').value.trim().toLowerCase();

  var children = {}; var hasParent = {};
  bucket.edges.forEach(function (edge) {
    (children[edge.to] = children[edge.to] || []).push(edge);
    hasParent[edge.from] = true;
  });
  var inHierarchy = {};
  bucket.edges.forEach(function (edge) { inHierarchy[edge.from] = true; inHierarchy[edge.to] = true; });

  var touched = {};
  if (docId !== null) {
    DATA.events.forEach(function (e) {
      if (docOf(e) !== docId || (e.category || (e.into && e.into.category)) !== activeCategory) return;
      [e.target, e.mintedAs, e.from, e.to, e.into, e.canonical, e.newCanonical].forEach(function (name) {
        if (typeof name === 'string') touched[name] = true;
        else if (name && name.canonical) touched[name.canonical] = true;
      });
    });
  }

  function matches(name) {
    if (!filter) return true;
    var entity = bucket.entities[name];
    if (name.toLowerCase().indexOf(filter) !== -1) return true;
    return entity && entity.aliases.some(function (a) { return a.toLowerCase().indexOf(filter) !== -1; });
  }

  function nodeHtml(name, edge, seen) {
    var entity = bucket.entities[name] || { aliases: [name] };
    var repeated = seen[name] === true;
    seen[name] = true;
    var cls = 'ent' + (touched[name] ? ' changed' : '');
    var html = '<li><span class="' + cls + '">' + esc(name);
    // Journal rung when the stream carried one; otherwise the registry's final rung, marked
    // "final" because it is not attributable to this document — most rungs are bound
    // retroactively by the ladder and never appear as an event.
    var journalRung = entity.rung;
    var finalRung = (DATA.registryRungs[activeCategory] || {})[name];
    if (journalRung) {
      html += '<span class="rungtag">[' + esc(journalRung) + ']</span>';
    } else if (finalRung) {
      html += '<span class="rungtag final" title="final rung from registry.json — bound ' +
        'retroactively by the ladder, not journalled per document">[' + esc(finalRung) + ']</span>';
    }
    if (entity.deferred) html += '<span class="deferred">deferred</span>';
    html += '</span>';
    if (edge) html += '<span class="edgekind ' + esc(edge.kind) + '">' + esc(edge.kind) +
      (edge.by ? ' · ' + esc(edge.by) : '') + '</span>';
    var extraAliases = entity.aliases.filter(function (a) { return a !== name; });
    if (extraAliases.length > 0) html += '<div class="aliases">' + esc(extraAliases.join(' · ')) + '</div>';
    if (repeated) { html += ' <span class="repeat">↻ repeated</span></li>'; return html; }
    var kids = (children[name] || []).slice().sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    if (kids.length > 0) {
      html += '<ul class="forest">' + kids.map(function (kid) {
        return nodeHtml(kid.from, kid, seen);
      }).join('') + '</ul>';
    }
    return html + '</li>';
  }

  var names = Object.keys(bucket.entities).sort();
  var roots = names.filter(function (name) { return inHierarchy[name] && !hasParent[name]; });
  var flat = names.filter(function (name) { return !inHierarchy[name] && bucket.entities[name].aliases.length > 1; });
  var singles = names.filter(function (name) { return !inHierarchy[name] && bucket.entities[name].aliases.length <= 1; });

  var seen = {};
  var html = '';
  var shownRoots = roots.filter(matches);
  if (shownRoots.length > 0) {
    html += '<ul class="forest">' + shownRoots.map(function (root) { return nodeHtml(root, null, seen); }).join('') + '</ul>';
  }
  if (bucket.renames.length > 0) {
    html += '<h2>Renames</h2><div class="renames">' + bucket.renames.map(function (edge) {
      return esc(edge.from) + ' → ' + esc(edge.to);
    }).join('<br>') + '</div>';
  }
  var shownFlat = flat.filter(matches);
  if (shownFlat.length > 0) {
    html += '<h2>Merged (no hierarchy)</h2><ul class="forest">' +
      shownFlat.map(function (name) { return nodeHtml(name, null, {}); }).join('') + '</ul>';
  }
  var shownSingles = singles.filter(matches);
  if (shownSingles.length > 0) {
    html += '<details class="singletons"><summary>' + shownSingles.length + ' singleton(s)</summary><ul class="forest">' +
      shownSingles.map(function (name) { return nodeHtml(name, null, {}); }).join('') + '</ul></details>';
  }
  el.innerHTML = html || '<div class="empty">no matching entities</div>';
}

function renderDocEvents(docId) {
  var el = document.getElementById('doc-events');
  var title = document.getElementById('doc-events-title');
  if (docId === null) { title.textContent = 'This document'; el.innerHTML = '<div class="empty">scrub forward to see per-document changes</div>'; return; }
  // T11: "Repair operations" would now be misleading here — per-document repairs render under their
  // own doc id ('Changes from doc N'); this frame is specifically the older batch consolidator pass.
  title.textContent = docId === -1 ? 'Batch-reference operations' : 'Changes from doc ' + docId;
  var rows = DATA.events.filter(function (e) { return docOf(e) === docId && e.op !== 'llm-call'; });
  var calls = DATA.events.filter(function (e) { return docOf(e) === docId && e.op === 'llm-call'; });
  var html = rows.map(function (e) {
    if (e.op === 'decision') {
      // Class names are a closed set; anything else in the log renders as plain 'mint' styling.
      var cls = e.decision === 'link' || e.decision === 'defer' ? e.decision : 'mint';
      var what = e.decision === 'link' ? esc(e.mention) + ' → ' + esc(e.target)
        : e.decision === 'defer' ? esc(e.mention) + ' (provisional: ' + esc(e.mintedAs || '?') + ')'
        : esc(e.mention);
      return '<div class="event"><span class="op ' + cls + '">' + esc(e.decision) + '</span> ' + what +
        ' <span class="why">' + esc(e.category || '') + '</span></div>';
    }
    if (e.op === 'granularity-edge') {
      return '<div class="event"><span class="op">edge</span> ' + esc(e.from) + ' —[' + esc(e.kind) + ']→ ' +
        esc(e.to) + ' <span class="why">' + esc(e.category || '') + (e.by ? ' · ' + esc(e.by) : '') + '</span></div>';
    }
    if (e.op === 'discover-ladder') {
      return '<div class="event"><span class="op">ladder</span> ' + esc(e.category) + ' v' + esc(e.version) +
        ' — ' + esc(e.outcome) + '</div>';
    }
    // T11: repair-merge/repair-split/repair-move/repair-distinct/repair-keep are the StreamingRepairer's
    // structural verdicts — same "repair" chip as the older consolidator ops they sit alongside (a T9
    // review flagged that leaving them out of this list makes them fall through to the generic
    // '<op>' row below, with no description).
    if (e.op === 'merge-canonical' || e.op === 'split-canonical' || e.op === 'rename-edge' || e.op === 'category-correction' ||
        e.op === 'repair-merge' || e.op === 'repair-split' || e.op === 'repair-move' || e.op === 'repair-distinct' || e.op === 'repair-keep') {
      var desc = e.op === 'merge-canonical' || e.op === 'repair-merge' ? esc(e.from) + ' ⇒ ' + esc(e.into)
        : e.op === 'split-canonical' || e.op === 'repair-split' ? esc(e.canonical) + ' ⇏ ' + esc((e.detached || []).join(', '))
        : e.op === 'rename-edge' ? esc(e.from) + ' → ' + esc(e.to)
        : e.op === 'repair-move' ? esc(e.alias) + ': ' + esc(e.from) + ' → ' + esc(e.to)
        : e.op === 'repair-distinct' ? esc((e.pair || []).join(' ≠ '))
        : e.op === 'repair-keep' ? esc(e.entity)
        : esc(e.from && e.from.category) + '/' + esc(e.from && e.from.canonical) + ' ⇒ ' + esc(e.into && e.into.category);
      var label = e.op.replace('-canonical', '').replace('-edge', '').replace('repair-', '');
      return '<div class="event"><span class="op repair">' + esc(label) +
        '</span> ' + desc + ' <span class="why">' + esc(e.category || '') + '</span></div>';
    }
    // T11 telemetry: no structural fold, but still worth surfacing as low-key rows rather than
    // falling through to the bare '<op>' default.
    if (e.op === 'suspect' || e.op === 'repair-spillover' || e.op === 'gloss-flagged' ||
        e.op === 'repair-op-rejected' || e.op === 'repair-op-skipped') {
      var telemetry = e.op === 'suspect' ? esc((e.pair || []).join(' ~ ')) + ' <span class="why">' + esc(e.signal) + ' ' + esc(e.score) + '</span>'
        : e.op === 'repair-spillover' ? esc(e.size) + ' suspect(s) <span class="why">' + esc(e.reason) + '</span>'
        : e.op === 'gloss-flagged' ? esc(e.mention) + ' <span class="why">' + esc(e.kind) + '</span>'
        : esc(e.verdict) + ' <span class="why">' + esc(e.reason) + (e.detail ? ': ' + esc(e.detail) : '') + '</span>';
      return '<div class="event"><span class="op">' + esc(e.op) + '</span> ' + telemetry + '</div>';
    }
    return '<div class="event"><span class="op">' + esc(e.op) + '</span></div>';
  }).join('');
  if (calls.length > 0) {
    html += '<div class="event why">' + calls.length + ' LLM call(s): ' + calls.map(function (c) { return esc(c.kind); }).join(', ') + '</div>';
  }
  el.innerHTML = html || '<div class="empty">no state changes from this document</div>';
}

document.getElementById('arm').addEventListener('change', function (e) {
  if (playTimer) {
    clearInterval(playTimer); playTimer = null;
    document.getElementById('play').textContent = '\\u25b6';
  }
  bindArm(Number(e.target.value), currentDocId(frame));
  render();
});
document.getElementById('scrubber').addEventListener('input', function (e) {
  frame = Number(e.target.value); render();
});
document.getElementById('step-back').addEventListener('click', function () {
  frame = Math.max(0, frame - 1); render();
});
document.getElementById('step-fwd').addEventListener('click', function () {
  frame = Math.min(frameCount, frame + 1); render();
});
document.getElementById('filter').addEventListener('input', function () { render(); });
document.getElementById('play').addEventListener('click', function () {
  var btn = document.getElementById('play');
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; return; }
  if (frame >= frameCount) frame = 0;
  btn.textContent = '⏸';
  playTimer = setInterval(function () {
    frame += 1;
    if (frame >= frameCount) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; frame = frameCount; }
    render();
  }, Number(document.getElementById('speed').value));
});

bindArm(0);
render();
</script>
</body>
</html>
`;
}
