import { applyEvent, createEmptyState } from './replayCore';
import { computeSelfCheck, loadRunData, renderRunViewHtml, replayAll } from './runView';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
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
    { op: 'granularity-edge', category: 'HackerGroup', from: 'UAC-0002', to: 'Sandworm', kind: 'part-of', doc: 3 },
    { op: 'discover-ladder', category: 'HackerGroup', outcome: 'cached', version: 1, doc: 3,
      ladder: { version: 1, rungs: [{ g: 0, alias: 'designator', example: 'UAC-0002', disputed: false }] } },
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
  assert.equal(state.ladders.HackerGroup.length, 1);
  assert.deepEqual(state.counts, { links: 1, mints: 2, defers: 1 });
});

test('merge rewrites edges to the survivor; split detaches aliases; category correction moves', () => {
  const state = createEmptyState();
  const seed = [
    { op: 'decision', decision: 'mint', category: 'C', mention: 'A', target: 'A', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'C', mention: 'B', target: 'B', docId: 1 },
    { op: 'decision', decision: 'mint', category: 'C', mention: 'P', target: 'P', docId: 1 },
    { op: 'decision', decision: 'link', category: 'C', mention: 'a-alias', target: 'A', docId: 2 },
    { op: 'granularity-edge', category: 'C', from: 'B', to: 'P', kind: 'coarsens-to', doc: 2 },
  ];
  for (const event of seed) applyEvent(state, event as never);

  applyEvent(state, { op: 'merge-canonical', category: 'C', from: 'P', into: 'A', doc: -1 } as never);
  assert.equal(state.categories.C.edges[0].to, 'A', 'edge followed the survivor');

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

  const registry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
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
