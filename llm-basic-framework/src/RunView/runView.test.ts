import { applyEvent, createEmptyState } from './replayCore';
import { computeSelfCheck, loadRunData, renderRunViewHtml, replayAll } from './runView';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

let counter = 0;
async function scratch(): Promise<string> {
  const key = crypto.createHash('sha256').update(`runview${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `runview-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

test('the reducer folds the full event vocabulary into a consistent state', () => {
  const state = createEmptyState();
  const events = [
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm', target: 'Sandworm', docId: 1 },
    { op: 'decision', decision: 'link', category: 'HackerGroup', mention: 'Voodoo Bear', target: 'Sandworm', docId: 2 },
    { op: 'decision', decision: 'defer', category: 'HackerGroup', mention: 'UAC-0002', target: null, mintedAs: 'UAC-0002', docId: 3 },
    { op: 'granularity-edge', category: 'HackerGroup', from: 'UAC-0002', to: 'Sandworm', kind: 'broadMatch', relation: 'part-of', similarityScore: 0.42, doc: 3 },
    { op: 'merge-canonical', category: 'HackerGroup', from: 'Sandworm Team', into: 'Sandworm', doc: -1 },
  ];
  // A pre-merge mint so the merge has something to fold.
  applyEvent(state, { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm Team', target: 'Sandworm Team', docId: 1 } as never);
  for (const event of events) applyEvent(state, event as never);

  const bucket = state.categories.HackerGroup;
  assert.deepEqual(Object.keys(bucket.entities).sort(), ['Sandworm', 'UAC-0002']);
  assert.ok(bucket.entities.Sandworm.aliases.includes('Voodoo Bear'));
  assert.ok(bucket.entities.Sandworm.aliases.includes('Sandworm Team'), 'merge folded aliases in');
  assert.equal(bucket.entities['UAC-0002'].deferred, true);
  assert.equal(bucket.edges.length, 1);
  assert.equal(bucket.edges[0].type, 'broaderPartitive', 'legacy relation normalized to the ISO 25964 type');
  assert.equal(bucket.edges[0].similarityScore, 0.42);
  assert.deepEqual(state.counts, { links: 1, mints: 2, defers: 1 });
});

test('merge rewrites edges to the survivor; split detaches aliases; category correction moves', () => {
  const state = createEmptyState();
  const seed = [
    { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'C', mention: 'B', target: 'B', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'C', mention: 'P', target: 'P', docId: 1 },
    { op: 'decision', decision: 'link', category: 'C', mention: 'a-alias', target: 'A', docId: 2 },
    { op: 'granularity-edge', category: 'C', from: 'B', to: 'P', kind: 'broadMatch', relation: 'narrower-of', doc: 2 },
  ];
  for (const event of seed) applyEvent(state, event as never);

  applyEvent(state, { op: 'merge-canonical', category: 'C', from: 'P', into: 'A', doc: -1 } as never);
  assert.equal(state.categories.C.edges[0].broader, 'A', 'edge followed the survivor');

  applyEvent(state, { op: 'split-canonical', category: 'C', canonical: 'A', detached: ['a-alias'], newCanonical: 'a-alias', doc: -1 } as never);
  assert.ok(state.categories.C.entities['a-alias'], 'detached alias became its own entity');
  assert.ok(!state.categories.C.entities.A.aliases.includes('a-alias'));

  applyEvent(state, {
    op: 'category-correction',
    from: { category: 'C', canonical: 'B' },
    into: { category: 'D', canonical: 'B' },
    doc: -1,
  } as never);
  assert.ok(state.categories.D.entities.B);
  assert.equal(state.categories.C.entities.B, undefined);
});

test('cross-category merge (StreamingRepairer): category-correction relocates under its OWN name, repair-merge finishes the fold even when canonicalPolicy keeps the MOVED name as survivor (T14 review fix)', () => {
  // Registry's real sequence: ConceptRegistry.move(a -> catB) keeps the name `a`, THEN applyMerges
  // picks the survivor by canonicalPolicy — which may be `a` itself, not the requested `into`. The
  // old fold pre-empted the merge under the requested name inside category-correction, so when
  // canonicalPolicy kept `a`, the following repair-merge fold found `bucket.entities[a]` undefined
  // and minted a fresh, empty duplicate instead of folding — two entities where the registry has one.
  const state = createEmptyState();
  const seed = [
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm', target: 'Sandworm', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'Organization', mention: 'Sandworm Team', target: 'Sandworm Team', docId: 2 },
    { op: 'decision', decision: 'link', category: 'HackerGroup', mention: 'Iron Viking', target: 'Sandworm', docId: 3 },
    { op: 'decision', decision: 'link', category: 'Organization', mention: 'Vorona', target: 'Sandworm Team', docId: 3 },
  ];
  for (const event of seed) applyEvent(state, event as never);

  // The judge's requested target was HackerGroup/Sandworm, but canonicalPolicy keeps the MOVED
  // entity's own name ('Sandworm Team') as survivor — repair-merge's from/into are therefore
  // identical (StreamingRepairer.ts:851/854: `from` is always the pre-merge non-survivor's name).
  applyEvent(state, {
    op: 'category-correction',
    doc: 4,
    from: { category: 'Organization', canonical: 'Sandworm Team' },
    into: { category: 'HackerGroup', canonical: 'Sandworm' },
    by: 'StreamingRepairer',
  } as never);
  applyEvent(state, {
    op: 'repair-merge', doc: 4, category: 'HackerGroup', from: 'Sandworm Team', into: 'Sandworm Team',
    confidence: 'high', evidence: null, by: 'StreamingRepairer',
  } as never);

  assert.deepEqual(state.categories.Organization.entities, {}, 'the record left its wrong category');
  assert.deepEqual(
    Object.keys(state.categories.HackerGroup.entities),
    ['Sandworm Team'],
    'one surviving entity, under the MOVED name — not two, and not the requested "into" name'
  );
  const survivor = state.categories.HackerGroup.entities['Sandworm Team'];
  assert.deepEqual(
    survivor.aliases.sort(),
    ['Iron Viking', 'Sandworm', 'Sandworm Team', 'Vorona'].sort(),
    'union of both sides\' aliases'
  );
});

test('repair-merge folds like merge-canonical: mint -> suspect -> repair-merge yields one entity (T11)', () => {
  const state = createEmptyState();
  const events = [
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm', target: 'Sandworm', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Voodoo Bear', target: 'Voodoo Bear', docId: 3 },
    {
      op: 'suspect', doc: 4, pair: ['Sandworm', 'Voodoo Bear'], categories: ['HackerGroup', 'HackerGroup'],
      signal: 'gloss-ann', score: 0.91,
    },
    {
      op: 'repair-merge', doc: 4, category: 'HackerGroup', from: 'Voodoo Bear', into: 'Sandworm',
      confidence: 'high', evidence: null, by: 'StreamingRepairer',
    },
  ];
  for (const event of events) applyEvent(state, event as never);

  const bucket = state.categories.HackerGroup;
  assert.deepEqual(Object.keys(bucket.entities), ['Sandworm'], 'one surviving entity, Voodoo Bear folded in');
  assert.ok(bucket.entities.Sandworm.aliases.includes('Voodoo Bear'), 'Voodoo Bear kept as an alias');
  assert.equal(bucket.entities['Voodoo Bear'], undefined, 'no separate Voodoo Bear node');
  assert.equal(state.repairCounts.suspects, 1, 'the suspect event accumulated');
});

test('rename-edge survives a following repair-merge untouched — the routine renamed-verdict path (review fix)', () => {
  // StreamingRepairer's `renamed` case logs rename-edge(A→B) immediately followed by
  // repair-merge(A→B) as dual-replayable history (design note). The merge fold must NOT project
  // rename edges through from→into: ConceptRegistry#rewriteAfterMerge deliberately never touches
  // rename edges in either direction (user ruling 2026-08-05), and a merge fold that did would turn
  // {from:A,to:B} into a B→B self-loop and the edge self-loop filter would then delete it —
  // silently erasing the rename from the Renames panel on the ROUTINE path, not an edge case.
  const state = createEmptyState();
  const events = [
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'A', target: 'A', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'B', target: 'B', docId: 2 },
    { op: 'rename-edge', doc: 3, category: 'HackerGroup', from: 'A', to: 'B', evidence: null, by: 'StreamingRepairer' },
    { op: 'repair-merge', doc: 3, category: 'HackerGroup', from: 'A', into: 'B', confidence: 'high', by: 'StreamingRepairer' },
  ];
  for (const event of events) applyEvent(state, event as never);

  const bucket = state.categories.HackerGroup;
  assert.deepEqual(Object.keys(bucket.entities), ['B'], 'A folded into B, one surviving entity');
  assert.equal(bucket.renames.length, 1, 'the rename edge survives the merge');
  assert.equal(bucket.renames[0].from, 'A', 'literal from endpoint — not rewritten to the survivor');
  assert.equal(bucket.renames[0].to, 'B', 'literal to endpoint');
});

test('repair-split folds like split-canonical (structural fields: canonical/detached/newCanonical)', () => {
  const state = createEmptyState();
  const seed = [
    { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 },
    { op: 'decision', decision: 'link', category: 'C', mention: 'a-alias', target: 'A', docId: 2 },
  ];
  for (const event of seed) applyEvent(state, event as never);

  applyEvent(state, {
    op: 'repair-split', doc: 5, category: 'C', canonical: 'A', detached: ['a-alias'],
    newCanonical: 'a-alias', evidence: null, by: 'StreamingRepairer',
  } as never);

  assert.ok(state.categories.C.entities['a-alias'], 'detached alias became its own entity');
  assert.ok(!state.categories.C.entities.A.aliases.includes('a-alias'), 'source entity lost the detached alias');
});

test('repair-move removes the alias from `from` and appends it to `to`, across categories', () => {
  const state = createEmptyState();
  const seed = [
    { op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm', target: 'Sandworm', docId: 1 },
    { op: 'decision', decision: 'link', category: 'HackerGroup', mention: 'Iron Viking', target: 'Sandworm', docId: 2 },
    { op: 'decision', decision: 'mint', category: 'MalwareFamily', mention: 'Industroyer', target: 'Industroyer', docId: 3 },
  ];
  for (const event of seed) applyEvent(state, event as never);

  applyEvent(state, {
    op: 'repair-move', doc: 6, alias: 'Iron Viking', from: 'Sandworm', to: 'Industroyer',
    categories: ['HackerGroup', 'MalwareFamily'], evidence: null, by: 'StreamingRepairer',
  } as never);

  assert.ok(!state.categories.HackerGroup.entities.Sandworm.aliases.includes('Iron Viking'), 'alias left the source');
  assert.ok(state.categories.MalwareFamily.entities.Industroyer.aliases.includes('Iron Viking'), 'alias arrived at the target');
});

test('suspect / repair-distinct / repair-spillover / gloss-flagged accumulate counters without touching entities', () => {
  const state = createEmptyState();
  applyEvent(state, { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 } as never);
  applyEvent(state, { op: 'decision', decision: 'mint', category: 'C', mention: 'B', target: 'B', docId: 1 } as never);

  applyEvent(state, {
    op: 'suspect', doc: 2, pair: ['A', 'B'], categories: ['C', 'C'], signal: 'coherence', score: 0.6,
  } as never);
  applyEvent(state, {
    op: 'repair-distinct', doc: 2, pair: ['A', 'B'], categories: ['C', 'C'], confidence: 'low',
    demotedFrom: 'merge', by: 'StreamingRepairer',
  } as never);
  applyEvent(state, { op: 'repair-spillover', doc: 2, size: 3, reason: 'token-cap' } as never);
  applyEvent(state, { op: 'repair-spillover', doc: 2, size: 2, reason: 'op-rejected' } as never);
  applyEvent(state, { op: 'gloss-flagged', doc: 2, mention: 'A', category: 'C', kind: 'too-short' } as never);

  assert.deepEqual(state.repairCounts, { suspects: 1, distinct: 1, spillover: 5, glossFlagged: 1 });
  // Telemetry events never mutate the registry fold.
  assert.deepEqual(Object.keys(state.categories.C.entities).sort(), ['A', 'B']);
});

test('self-check passes when the replay reproduces the registry, and localizes any drift', () => {
  const state = createEmptyState();
  applyEvent(state, { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 } as never);

  const ok = computeSelfCheck(state, { C: ['A'] });
  assert.equal(ok.ok, true);

  const drift = computeSelfCheck(state, { C: ['A', 'B'] });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingInReplay, { C: ['B'] });
});

test('loadRunData + renderRunViewHtml produce a self-contained page from a real run directory', async () => {
  const dir = await scratch();

  const registry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  await registry.save();

  await fs.writeFile(
    path.join(dir, 'artifacts', '1.json'),
    JSON.stringify({
      entities: [], relations: [], schemaProposals: { categories: [], relationTypes: [] },
      metadata: { id: 1, date: '2024-01-01', title: 'first <report> & more' },
    })
  );
  await fs.writeFile(
    path.join(dir, 'decisions.jsonl'),
    [
      JSON.stringify({ op: 'decision', decision: 'mint', category: 'HackerGroup', mention: 'Sandworm', target: 'Sandworm', docId: 1, candidates: [] }),
      JSON.stringify({ op: 'llm-call', doc: 1, kind: 'link-judge', seconds: 0.1 }),
    ].join('\n') + '\n'
  );

  const data = await loadRunData(dir);
  assert.equal(data.docOrder.length, 1);
  assert.equal(data.selfCheck.ok, true, 'replay matches the registry');

  const html = renderRunViewHtml(data);
  assert.ok(html.includes('SKEIN run playback'));
  assert.ok(html.includes('first \\u003creport>') || html.includes('first &lt;report&gt;'), 'titles escape');
  assert.ok(!/src\s*=\s*"http/.test(html) && !/href\s*=\s*"http/.test(html), 'no external resources');
  assert.ok(html.includes('var applyEvent'), 'the reducer ships inside the page');
  // The embedded reducer must be executable JS, exactly as the tests above ran it — and it must
  // actually RUN (a typeof check missed the compiled `exports.docOf` reference the browser hit).
  const source = html.match(/<script>\n([\s\S]*?)\nvar DATA =/)![1];
  const embedded = new Function(
    `${source};
     var s = createEmptyState();
     applyEvent(s, { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 });
     applyEvent(s, { op: 'granularity-edge', category: 'C', from: 'A', to: 'A2', kind: 'part-of', doc: 2 });
     return s;`
  )();
  assert.deepEqual(Object.keys(embedded.categories.C.entities).sort(), ['A', 'A2']);
});

test('the -1 chapter reads "batch-reference chapter" now that repair ops carry real doc ids (T11)', async () => {
  const dir = await fakeRun({
    condition: 'solo', provider: 'anthropic', model: 'claude-opus-5', canonical: 'Sandworm', docIds: [1],
  });
  const html = renderRunViewHtml(await loadRunData(dir));
  assert.ok(html.includes('after the batch-reference chapter'));
  assert.ok(html.includes('batch-reference chapter: consolidator operations'));
  assert.ok(html.includes('Batch-reference operations'));
  assert.ok(!html.includes('repair chapter:'), 'the old wording is gone');
  assert.ok(!html.includes("'after repair (consolidator)'"), 'the old wording is gone');
});

test('the per-document event renderer gained the new T11 repair-op kinds, not just the fallback row', async () => {
  const dir = await fakeRun({
    condition: 'solo', provider: 'anthropic', model: 'claude-opus-5', canonical: 'Sandworm', docIds: [1],
  });
  const html = renderRunViewHtml(await loadRunData(dir));
  for (const op of [
    'repair-merge', 'repair-split', 'repair-move', 'repair-distinct', 'repair-keep',
    'suspect', 'repair-spillover', 'gloss-flagged', 'repair-op-rejected', 'repair-op-skipped',
  ]) {
    assert.ok(html.includes(`'${op}'`), `${op} is matched by the per-document event renderer, not just the '<op>' fallback`);
  }
});

test('a real repair-move and repair-spillover event render with a description, not the bare op-name fallback', async () => {
  const dir = await fakeRun({
    condition: 'solo', provider: 'anthropic', model: 'claude-opus-5', canonical: 'Sandworm', docIds: [1],
  });
  const data = await loadRunData(dir);
  const html = renderRunViewHtml(data);

  // Run the SHIPPED renderDocEvents against a minimal fake DOM — a stronger check than grepping the
  // source for the op-name string, since it exercises the actual `desc`/`telemetry` branches.
  const reducerSource = html.match(/<script>\n([\s\S]*?)\nvar DATA =/)![1];
  const escSource = html.match(/var esc = function[\s\S]*?\n};\n/)![0];
  const renderDocEventsSource = html.match(/function renderDocEvents[\s\S]*?\n}\n/)![0];
  const events = [
    {
      op: 'repair-move', doc: 1, alias: 'Iron Viking', from: 'Sandworm', to: 'Industroyer',
      categories: ['HackerGroup', 'MalwareFamily'], evidence: null, by: 'StreamingRepairer',
    },
    { op: 'repair-spillover', doc: 1, size: 3, reason: 'token-cap' },
  ];
  const rendered = new Function(
    `${reducerSource}
     ${escSource}
     var elements = {};
     var document = { getElementById: function (id) {
       if (!elements[id]) elements[id] = { innerHTML: '', textContent: '' };
       return elements[id];
     } };
     var DATA = { events: ${JSON.stringify(events)} };
     ${renderDocEventsSource}
     renderDocEvents(1);
     return elements['doc-events'].innerHTML;`
  )();

  assert.match(rendered, /<span class="op repair">move<\/span>/, 'repair-move gets the repair chip, labeled "move"');
  assert.ok(rendered.includes('Iron Viking') && rendered.includes('Sandworm') && rendered.includes('Industroyer'),
    'repair-move description names the alias and both endpoints');
  assert.match(rendered, /<span class="op">repair-spillover<\/span>/, 'repair-spillover keeps its raw op name (telemetry bucket)');
  assert.ok(rendered.includes('3 suspect(s)') && rendered.includes('token-cap'),
    'repair-spillover description carries size and reason');
});

/** Minimal run directory: one document, one mint, and a run card naming the arm. */
async function fakeRun(options: {
  condition: string;
  provider: string;
  model: string;
  canonical: string;
  docIds: number[];
}): Promise<string> {
  const dir = await scratch();
  const registry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('HackerGroup', options.canonical, { doc: options.docIds[0], date: '01.01.2024' });
  await registry.save();

  for (const docId of options.docIds) {
    await fs.writeFile(
      path.join(dir, 'artifacts', `${docId}.json`),
      JSON.stringify({
        entities: [], relations: [], schemaProposals: { categories: [], relationTypes: [] },
        metadata: { id: docId, date: '2024-01-01', title: `report ${docId}` },
      })
    );
  }
  await fs.writeFile(
    path.join(dir, 'decisions.jsonl'),
    JSON.stringify({
      op: 'decision', decision: 'mint', category: 'HackerGroup',
      mention: options.canonical, target: options.canonical, docId: options.docIds[0], candidates: [],
    }) + '\n'
  );
  await fs.writeFile(
    path.join(dir, 'run-card.json'),
    JSON.stringify({
      runId: `${options.condition}-abc123`,
      condition: options.condition,
      config: {
        llm: { provider: options.provider, model: options.model },
      },
    })
  );
  return dir;
}

test('loadRunData reads the arm identity off the run card', async () => {
  const dir = await fakeRun({
    condition: 'psi-link-gemma', provider: 'ollama', model: 'gemma4:e2b-8k',
    canonical: 'Sandworm', docIds: [1],
  });
  const data = await loadRunData(dir);
  assert.equal(data.arm.condition, 'psi-link-gemma');
  assert.equal(data.arm.provider, 'ollama');
  assert.equal(data.arm.model, 'gemma4:e2b-8k');
});

test('several arms render into one page behind a switcher, each keeping its own journal', async () => {
  // Different document counts on purpose: the local arm is missing doc 1, so frame index and
  // document id diverge and a switcher that carried the raw index would land on the wrong report.
  const cloud = await loadRunData(await fakeRun({
    condition: 'psi-link-default', provider: 'anthropic', model: 'claude-opus-5',
    canonical: 'Sandworm', docIds: [1, 2, 3],
  }));
  const local = await loadRunData(await fakeRun({
    condition: 'psi-link-gemma', provider: 'ollama', model: 'gemma4:e2b-8k',
    canonical: 'SandwormLocal', docIds: [2, 3],
  }));

  const html = renderRunViewHtml([cloud, local]);
  assert.ok(html.includes('claude-opus-5') && html.includes('gemma4:e2b-8k'), 'both arms present');
  assert.ok(html.includes('id="arm"'), 'the switcher exists');
  assert.ok(!/src\s*=\s*"http/.test(html) && !/href\s*=\s*"http/.test(html), 'still self-contained');

  // The payload is an array of arms — neither journal is merged into the other.
  const runs = JSON.parse(html.match(/\nvar RUNS = (\[[\s\S]*?\]);\n/)![1].replace(/\\u003c/g, '<'));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].arm.model, 'claude-opus-5');
  assert.equal(runs[1].arm.model, 'gemma4:e2b-8k');
  assert.notDeepEqual(runs[0].events, runs[1].events);

  // bindArm carries position across by document id, so the same report is read under each arm.
  const script = html.match(/<script>\n([\s\S]*?)\nvar DATA =/)![1];
  const run = (body: string) =>
    new Function(
      `${script};
       var RUNS = ${JSON.stringify(runs)};
       var DATA = null, runIndex = 0, repairEvents = [], frameCount = 0, frame = 0;
       ${html.match(/function bindArm[\s\S]*?\n}\n/)![0]}
       ${body}`
    )();

  // Cloud doc 3 is frame 3; in the local arm doc 3 is only the SECOND document, so frame 2.
  assert.equal(
    run('bindArm(0); frame = 3; bindArm(1, 3); return frame;'),
    2,
    'the switch followed the document id, not the frame index'
  );
  // Doc 1 does not exist in the local arm — clamp rather than jump somewhere arbitrary.
  assert.equal(
    run('bindArm(0); frame = 1; bindArm(1, 1); return frame;'),
    1,
    'a document the other arm never saw clamps into range'
  );
  assert.equal(
    run('bindArm(1); return frameCount;'),
    2,
    'each arm keeps its own frame axis'
  );
});

test('a single run still renders exactly as before, with no switcher shown', async () => {
  const data = await loadRunData(await fakeRun({
    condition: 'solo', provider: 'anthropic', model: 'claude-opus-5', canonical: 'Sandworm', docIds: [1],
  }));
  const html = renderRunViewHtml(data);
  assert.ok(html.includes('id="armrow" hidden'), 'switcher row starts hidden for one arm');
  const runs = JSON.parse(html.match(/\nvar RUNS = (\[[\s\S]*?\]);\n/)![1].replace(/\\u003c/g, '<'));
  assert.equal(runs.length, 1, 'one-run input still produces a one-element payload');
});

test('loadRunData refuses a directory without a decisions log', async () => {
  const dir = await scratch();
  await assert.rejects(() => loadRunData(dir), /DECISIONS_LOG=1/);
});

test('replayAll of the full journal equals the incremental fold', () => {
  const events = [
    { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 },
    { op: 'decision', decision: 'link', category: 'C', mention: 'a2', target: 'A', docId: 2 },
  ];
  const whole = replayAll(events as never);
  const stepped = createEmptyState();
  for (const event of events) applyEvent(stepped, event as never);
  assert.deepEqual(whole, stepped, 'backward scrubbing (replay from zero) is deterministic');
});
