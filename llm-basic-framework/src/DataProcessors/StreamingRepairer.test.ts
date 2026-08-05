import { StreamingRepairer, assertCallBudget, assertSuspectsAccounted, suspectPairKey } from './StreamingRepairer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry, type EntityRef, type SuspectPair } from '../EntityRegistry/EntityRegistry';
import type { GlossIndex } from '../Repair/GlossIndex';
import type { SuspectThresholds } from '../Repair/SuspectGenerator';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import type { Candidate, CandidateGenerator, CandidateQuery, RegistryChange } from '../Normalization/types';
import type { LlmClient } from '../LlmClient/LlmClient';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

/**
 * TDD for T9 `StreamingRepairer` — the synchronous per-document repair pass.
 *
 * Real `EntityRegistry`/`SchemaRegistry` (state assertions are the point), canned LLM replies in
 * call order (`RegistryConsolidator.test.ts:28-44`), and fakes for the two collaborators whose real
 * implementations need an embeddings backend or a prepared index (`GlossIndex`, `CandidateGenerator`
 * blocker) — the same fakes T6's `SuspectGenerator.test.ts` uses, since suspect generation is the
 * component this class drives.
 */

let counter = 0;
async function scratchDir(): Promise<string> {
  const key = crypto.createHash('sha256').update(`repairer${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `repairer-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

/** Replays canned responses in call order; repeats the last one when calls exceed replies. */
function cannedLlm(replies: string[]) {
  let call = 0;
  const prompts: string[] = [];
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, calls: () => call, prompts };
}

/** Table-driven fake blocker (T6's) — filters its own table on the caller's `minSim`. */
function fakeBlocker(
  table: Record<string, Array<{ canonical: string; sim: number }>>
): CandidateGenerator {
  return {
    id: 'fake-blocker',
    config: {},
    async prepare() {},
    onRegistryChange() {},
    async candidates(query: CandidateQuery): Promise<Candidate[]> {
      return (table[query.category] ?? [])
        .filter((c) => c.sim >= query.minSim)
        .map((c) => ({ canonical: c.canonical, sim: c.sim, surfaces: [c.canonical], channel: 'fake-blocker' }));
    },
  };
}

function fakeGlossIndex(opts: {
  nearest?: (ref: EntityRef, k: number) => Array<{ ref: EntityRef; sim: number }>;
  aliasCoherence?: (ref: EntityRef, alias: string) => number;
} = {}): GlossIndex {
  return {
    async sync() {},
    async nearest(ref: EntityRef, k: number) {
      return opts.nearest ? opts.nearest(ref, k) : [];
    },
    async aliasCoherence(ref: EntityRef, alias: string) {
      return opts.aliasCoherence ? opts.aliasCoherence(ref, alias) : 1;
    },
  } as unknown as GlossIndex;
}

const thresholds = (over: Partial<SuspectThresholds> = {}): SuspectThresholds => ({
  glossAnn: new Map([['default', 0.9]]),
  blocker: new Map([['default', 0.9]]),
  coherence: 0.5,
  ...over,
});

interface SetupOptions {
  replies?: string[];
  blocker?: Record<string, Array<{ canonical: string; sim: number }>>;
  glossIndex?: GlossIndex;
  thresholds?: SuspectThresholds;
  tokenCap?: number;
}

async function setup(options: SetupOptions = {}) {
  const dir = await scratchDir();
  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();

  const llm = cannedLlm(options.replies ?? ['{"reviews":[]}']);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const changes: RegistryChange[] = [];

  const repairer = new StreamingRepairer({
    artifactsDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    decisionLog,
    glossIndex: options.glossIndex ?? fakeGlossIndex(),
    blocker: fakeBlocker(options.blocker ?? {}),
    thresholds: options.thresholds ?? thresholds(),
    tokenCap: options.tokenCap,
    onRegistryChange: (event) => changes.push(event),
  });

  return { dir, schemaRegistry, entityRegistry, decisionLog, repairer, llm, changes };
}

async function readLog(dir: string) {
  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8').catch(() => '');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function artifact(entities: unknown[], relations: unknown[] = [], id = 1) {
  return {
    entities,
    relations,
    schemaProposals: { categories: [], relationTypes: [] },
    metadata: { id },
  };
}

async function writeArtifact(dir: string, file: string, data: unknown) {
  await fs.writeFile(path.join(dir, 'artifacts', file), JSON.stringify(data, undefined, 2));
}

async function readArtifact(dir: string, file: string) {
  return JSON.parse(await fs.readFile(path.join(dir, 'artifacts', file), 'utf8'));
}

const review = (ops: Array<Record<string, unknown>>, component = 1) =>
  JSON.stringify({ reviews: [{ component, ops }] });

/**
 * The recurring fixture: `Sandworm` minted on d1, a second HackerGroup canonical minted on d2, and a
 * blocker that pairs anything in HackerGroup with everything else in it. Doc 2's mint is therefore
 * exactly one suspect pair.
 */
async function twoHackerGroups(options: SetupOptions & { second?: string } = {}) {
  const second = options.second ?? 'Voodoo Bear';
  const context = await setup({
    ...options,
    blocker: options.blocker ?? {
      HackerGroup: [
        { canonical: 'Sandworm', sim: 0.95 },
        { canonical: second, sim: 0.95 },
      ],
    },
  });
  context.schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  context.entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' }, { gloss: 'GRU-attributed group' });
  context.entityRegistry.mint('HackerGroup', second, { doc: 2, date: '02.01.2024' }, { gloss: 'Russian state-sponsored group' });
  await context.entityRegistry.save();
  await context.schemaRegistry.save();
  return { ...context, second };
}

// --- the quiet path ----------------------------------------------------------------------------

test('no suspects: zero LLM calls, repairedThrough still advances', async () => {
  const { dir, entityRegistry, repairer, llm } = await setup({ blocker: {} });
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  await entityRegistry.save();
  await writeArtifact(dir, '1.json', artifact([{ name: 'Sandworm', category: 'HackerGroup', role: 'Attacker' }]));

  await repairer.processDoc('1.json', 1);

  assert.equal(llm.calls(), 0, 'no due components means no call');
  assert.equal(entityRegistry.repairState().repairedThrough, 1);
  assert.equal(repairer.callsForDoc(1), 0);
});

// --- the rendered component block ----------------------------------------------------------------

test('a component renders in the design-note block shape, with evidence read from the artifacts', async () => {
  const { dir, repairer, llm } = await twoHackerGroups({ replies: ['{"reviews":[]}', '{"reviews":[]}'] });

  await writeArtifact(
    dir,
    '1.json',
    artifact([{ name: 'Sandworm', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Sandworm', normalizedName: 'Sandworm' }], [], 1)
  );
  await writeArtifact(
    dir,
    '2.json',
    artifact(
      [{ name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear', normalizedName: 'Voodoo Bear' }],
      [
        {
          head: 'Voodoo Bear',
          headCategory: 'HackerGroup',
          type: 'attacks',
          tail: 'Ukrenergo',
          tailCategory: 'Organization',
          normalizedHead: 'Voodoo Bear',
          normalizedTail: 'Ukrenergo',
        },
      ],
      2
    )
  );

  await repairer.processDoc('2.json', 2);

  const block = [
    'Component 1 of 1 · signal: union-blocker 0.95',
    '  A. Sandworm (HackerGroup)',
    '     aliases: []  · minted d1',
    '     gloss: "GRU-attributed group"',
    '     evidence: d1 "Sandworm"',
    '  B. Voodoo Bear (HackerGroup)',
    '     aliases: []  · minted d2',
    '     gloss: "Russian state-sponsored group"',
    '     evidence: d2 "Voodoo Bear" — Voodoo Bear -[attacks]-> Ukrenergo',
    '  pairs to adjudicate: A–B (union-blocker 0.95)',
  ].join('\n');
  assert.ok(llm.prompts[0].includes(block), `rendered block:\n${llm.prompts[0]}`);
});

// --- merge -------------------------------------------------------------------------------------

test('merge applies and re-stamps normalizedName/normalizedHead in the affected artifacts', async () => {
  const { dir, entityRegistry, repairer, changes } = await twoHackerGroups({
    replies: [review([{ op: 'merge', from: 'Voodoo Bear', into: 'Sandworm', confidence: 'high', evidence: 'also tracked as' }])],
  });

  await writeArtifact(
    dir,
    '1.json',
    artifact(
      [{ name: 'Sandworm', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Sandworm', normalizedName: 'Sandworm' }],
      [],
      1
    )
  );
  await writeArtifact(
    dir,
    '2.json',
    artifact(
      [{ name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear', normalizedName: 'Voodoo Bear' }],
      [
        {
          head: 'Voodoo Bear',
          headCategory: 'HackerGroup',
          type: 'attacks',
          tail: 'Ukrenergo',
          tailCategory: 'Organization',
          normalizedHead: 'Voodoo Bear',
          normalizedTail: 'Ukrenergo',
        },
      ],
      2
    )
  );

  await repairer.processDoc('2.json', 2);

  assert.equal(entityRegistry.resolve('HackerGroup', 'Voodoo Bear'), 'Sandworm', 'merged into the first-seen survivor');
  const restamped = await readArtifact(dir, '2.json');
  assert.equal(restamped.entities[0].normalizedName, 'Sandworm');
  assert.equal(restamped.relations[0].normalizedHead, 'Sandworm');

  const merge = (await readLog(dir)).find((event) => event.op === 'repair-merge');
  assert.ok(merge, 'repair-merge logged');
  assert.equal(merge.into, 'Sandworm', 'logs the ACTUAL survivor, not the requested target');
  assert.equal(merge.by, 'StreamingRepairer');
  assert.ok(changes.some((event) => event.type === 'merge' && event.canonical === 'Sandworm'), 'blocker index invalidated');
});

test('cross-category merge moves the record first and emits category-correction', async () => {
  const context = await setup({
    replies: [review([{ op: 'merge', from: 'Sandworm Team', into: 'Sandworm', confidence: 'high', evidence: 'same group' }])],
    blocker: { HackerGroup: [{ canonical: 'Sandworm', sim: 0.95 }] },
  });
  const { dir, entityRegistry, repairer } = context;
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.mint('Organization', 'Sandworm Team', { doc: 2, date: '02.01.2024' });
  await entityRegistry.save();

  await repairer.processDoc('2.json', 2);

  assert.equal(entityRegistry.resolve('HackerGroup', 'Sandworm Team'), 'Sandworm');
  assert.deepEqual(entityRegistry.records('Organization'), {}, 'the record left its wrong category');

  const correction = (await readLog(dir)).find((event) => event.op === 'category-correction');
  assert.ok(correction, 'category-correction logged');
  assert.deepEqual(correction.from, { category: 'Organization', canonical: 'Sandworm Team' });
  assert.deepEqual(correction.into, { category: 'HackerGroup', canonical: 'Sandworm' });
  assert.equal(correction.by, 'StreamingRepairer');
});

test('low-confidence merge degrades to distinct with an empty signature, and the pair re-fires later', async () => {
  const { dir, entityRegistry, repairer, llm } = await twoHackerGroups({
    replies: [
      review([{ op: 'merge', from: 'Voodoo Bear', into: 'Sandworm', confidence: 'low', evidence: 'looks similar' }]),
      review([{ op: 'distinct', pair: ['Voodoo Bear', 'Sandworm'], confidence: 'high', evidence: 'different groups' }]),
    ],
  });

  await repairer.processDoc('2.json', 2);

  assert.ok(entityRegistry.records('HackerGroup')['Voodoo Bear'], 'a low-confidence merge is never applied');
  const adjudicated = entityRegistry.repairState().adjudicated;
  assert.equal(adjudicated.length, 1);
  assert.equal(adjudicated[0].verdict, 'distinct');
  assert.equal(adjudicated[0].signature, '', 'the retained-suspect sentinel: never equal to anything');
  const distinct = (await readLog(dir)).find((event) => event.op === 'repair-distinct');
  assert.ok(distinct, 'repair-distinct logged');

  // A later document touching either member re-probes the pair; the '' signature never suppresses.
  entityRegistry.link('HackerGroup', 'Voodoo Bear', 'VooDoo', { docId: 3 });
  await repairer.processDoc('3.json', 3);
  assert.equal(llm.calls(), 2, 'the retained suspect was re-adjudicated');
});

test('distinct with a real signature suppresses an identical re-probe', async () => {
  const { entityRegistry, repairer, llm } = await twoHackerGroups({
    replies: [review([{ op: 'distinct', pair: ['Voodoo Bear', 'Sandworm'], confidence: 'high', evidence: 'unrelated' }])],
  });

  await repairer.processDoc('2.json', 2);
  assert.equal(llm.calls(), 1);
  assert.equal(entityRegistry.repairState().adjudicated[0].signature.length, 64, 'sha256 hex');

  // Nothing about either member changed, so re-running phase 2 (the crash-recovery path) re-derives
  // the same suspect and finds it already adjudicated — no second call.
  await repairer.processDoc('2.json', 2);
  assert.equal(llm.calls(), 1, 'adjudicated dedup limits the re-work');
});

// --- rejection / completeness ------------------------------------------------------------------

test('an op naming an unlisted entity is rejected and its pair spills over', async () => {
  const { dir, entityRegistry, repairer, llm } = await twoHackerGroups({
    replies: [review([{ op: 'merge', from: 'Fancy Bear', into: 'Sandworm', confidence: 'high', evidence: 'invented' }])],
  });

  await repairer.processDoc('2.json', 2);

  assert.ok(entityRegistry.records('HackerGroup')['Voodoo Bear'], 'nothing was applied');
  assert.equal(llm.calls(), 2, 'one primary call plus exactly one re-ask');
  const spillover = entityRegistry.repairState().spillover;
  assert.equal(spillover.length, 1, 'the unadjudicated pair is queued, never dropped');

  const events = await readLog(dir);
  assert.ok(events.some((event) => event.op === 'repair-op-rejected' && event.reason === 'unlisted-entity'));
  assert.ok(events.some((event) => event.op === 'repair-spillover'));
});

test('an incomplete component gets exactly one retry, then spills; callsForDoc counts first attempts only', async () => {
  const { dir, entityRegistry, repairer, llm } = await twoHackerGroups({
    replies: ['{"reviews":[]}', '{"reviews":[]}'],
  });

  await repairer.processDoc('2.json', 2);

  assert.equal(llm.calls(), 2, 'primary + one retry, never two retries');
  assert.equal(repairer.callsForDoc(2), 1, 'the retry is logged separately, not as a first attempt');
  assert.equal(entityRegistry.repairState().spillover.length, 1);

  const kinds = (await readLog(dir)).filter((event) => event.op === 'llm-call').map((event) => event.kind);
  assert.deepEqual(kinds, ['repair-judge', 'repair-judge-retry']);
});

// --- rung / renamed ----------------------------------------------------------------------------

test('rung records a granularity edge and never merges identity', async () => {
  const { dir, entityRegistry, repairer } = await twoHackerGroups({
    second: 'UAC-0002',
    replies: [
      review([
        { op: 'rung', finer: 'UAC-0002', coarser: 'Sandworm', edgeKind: 'part-of', confidence: 'high', evidence: 'a unit of' },
      ]),
    ],
  });

  await repairer.processDoc('2.json', 2);

  assert.ok(entityRegistry.records('HackerGroup')['UAC-0002'], 'both records survive a rung verdict');
  assert.ok(entityRegistry.records('HackerGroup')['Sandworm']);
  const edges = entityRegistry.granularityEdges('HackerGroup');
  assert.equal(edges.length, 1);
  assert.deepEqual(
    { from: edges[0].from, to: edges[0].to, kind: edges[0].kind, decision: edges[0].decision },
    { from: 'UAC-0002', to: 'Sandworm', kind: 'part-of', decision: 'repairer' }
  );
  assert.equal(entityRegistry.repairState().adjudicated[0].verdict, 'rung', 'recorded so it cannot re-fire forever');

  const edgeEvent = (await readLog(dir)).find((event) => event.op === 'granularity-edge');
  assert.equal(edgeEvent.by, 'StreamingRepairer');
});

test('renamed leaves one record under the NEW name and keeps the historical rename edge', async () => {
  const { dir, entityRegistry, repairer } = await twoHackerGroups({
    second: 'APT44',
    replies: [review([{ op: 'renamed', from: 'Sandworm', to: 'APT44', confidence: 'high', evidence: 'formerly known as' }])],
  });

  await repairer.processDoc('2.json', 2);

  assert.deepEqual(Object.keys(entityRegistry.records('HackerGroup')), ['APT44'], 'survivor is the new name, not first-seen');
  assert.equal(entityRegistry.resolve('HackerGroup', 'Sandworm'), 'APT44');
  const renames = entityRegistry.renameEdges('HackerGroup');
  assert.equal(renames.length, 1);
  assert.deepEqual({ from: renames[0].from, to: renames[0].to }, { from: 'Sandworm', to: 'APT44' });

  const ops = (await readLog(dir)).map((event) => event.op);
  assert.ok(ops.includes('rename-edge'), 'rename edge logged for replay');
  assert.ok(ops.includes('repair-merge'), 'the identity fold is logged too');
});

// --- coherence: split / move -------------------------------------------------------------------

test('split reassigns exactly the detached alias\'s mentions (matchedVia locality)', async () => {
  const context = await setup({
    replies: [review([{ op: 'split', alias: 'Voodoo Bear', outOf: 'Sandworm', confidence: 'high', evidence: 'a different group' }])],
    blocker: {},
    glossIndex: fakeGlossIndex({ aliasCoherence: () => 0.1 }),
  });
  const { dir, entityRegistry, repairer } = context;
  context.schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 2 });
  await entityRegistry.save();
  await context.schemaRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    artifact([{ name: 'Sandworm', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Sandworm', normalizedName: 'Sandworm' }], [], 1)
  );
  await writeArtifact(
    dir,
    '2.json',
    artifact(
      [{ name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear', normalizedName: 'Sandworm' }],
      [],
      2
    )
  );

  await repairer.processDoc('2.json', 2);

  assert.ok(entityRegistry.records('HackerGroup')['Voodoo Bear'], 'detached alias became its own canonical');
  assert.equal((await readArtifact(dir, '2.json')).entities[0].normalizedName, 'Voodoo Bear', 'its mention followed it');
  assert.equal((await readArtifact(dir, '1.json')).entities[0].normalizedName, 'Sandworm', 'other mentions stayed put');

  const split = (await readLog(dir)).find((event) => event.op === 'repair-split');
  assert.deepEqual(split.detached, ['Voodoo Bear']);
  assert.equal(split.newCanonical, 'Voodoo Bear');
});

test('move reattaches one alias to another listed entity and re-stamps its mentions', async () => {
  const context = await setup({
    replies: [
      review([
        { op: 'distinct', pair: ['Sandworm', 'APT28'], confidence: 'high', evidence: 'different groups' },
        { op: 'move', alias: 'Fancy Bear', from: 'Sandworm', to: 'APT28', confidence: 'high', evidence: 'Fancy Bear is APT28' },
      ]),
    ],
    blocker: {
      HackerGroup: [
        { canonical: 'Sandworm', sim: 0.95 },
        { canonical: 'APT28', sim: 0.95 },
      ],
    },
    glossIndex: fakeGlossIndex({ aliasCoherence: () => 0.1 }),
  });
  const { dir, entityRegistry, repairer } = context;
  context.schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.mint('HackerGroup', 'APT28', { doc: 1, date: '01.01.2024' });
  entityRegistry.link('HackerGroup', 'Sandworm', 'Fancy Bear', { docId: 2 });
  await entityRegistry.save();
  await context.schemaRegistry.save();

  await writeArtifact(
    dir,
    '2.json',
    artifact(
      [{ name: 'Fancy Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Fancy Bear', normalizedName: 'Sandworm' }],
      [],
      2
    )
  );

  await repairer.processDoc('2.json', 2);

  assert.equal(entityRegistry.resolve('HackerGroup', 'Fancy Bear'), 'APT28');
  assert.equal((await readArtifact(dir, '2.json')).entities[0].normalizedName, 'APT28');
  const move = (await readLog(dir)).find((event) => event.op === 'repair-move');
  assert.deepEqual({ alias: move.alias, from: move.from, to: move.to }, { alias: 'Fancy Bear', from: 'Sandworm', to: 'APT28' });
});

test('keep records a coherence verdict so the entity is not re-flagged by future drift noise', async () => {
  const context = await setup({
    replies: [review([{ op: 'keep', entity: 'Sandworm', confidence: 'high', evidence: 'every alias is attested' }])],
    blocker: {},
    glossIndex: fakeGlossIndex({ aliasCoherence: () => 0.1 }),
  });
  const { dir, entityRegistry, repairer, llm } = context;
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 2 });
  await entityRegistry.save();

  await repairer.processDoc('2.json', 2);

  const adjudicated = entityRegistry.repairState().adjudicated;
  assert.equal(adjudicated.length, 1);
  assert.equal(adjudicated[0].verdict, 'keep');
  assert.deepEqual(adjudicated[0].a, adjudicated[0].b, 'a coherence memo is single-entity');
  assert.deepEqual(entityRegistry.aliasSurfaces('HackerGroup', 'Sandworm'), ['Sandworm', 'Voodoo Bear'], 'nothing detached');
  assert.ok((await readLog(dir)).some((event) => event.op === 'repair-keep'));

  // Same registry content, same drift reading: the memo suppresses the re-probe.
  await repairer.processDoc('2.json', 2);
  assert.equal(llm.calls(), 1);
});

// --- defer queue + spillover -------------------------------------------------------------------

test('a deferred pair becomes a suspect and the queue entry is consumed', async () => {
  const context = await setup({
    replies: [review([{ op: 'distinct', pair: ['Sandworm Team', 'Sandworm'], confidence: 'high', evidence: 'no evidence of identity' }])],
    blocker: {},
  });
  const { entityRegistry, repairer, llm } = context;
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.mint('HackerGroup', 'Sandworm Team', { doc: 2, date: '02.01.2024' });
  entityRegistry.pushDeferred({
    category: 'HackerGroup',
    mention: 'Sandworm Team',
    mintedAs: 'Sandworm Team',
    candidates: ['Sandworm'],
    docId: 2,
  });
  await entityRegistry.save();

  await repairer.processDoc('2.json', 2);

  assert.equal(llm.calls(), 1, 'the defer queue alone is enough to fire a repair call');
  assert.deepEqual(entityRegistry.deferred(), [], 'reviewed = consumed');
  assert.equal(entityRegistry.repairState().adjudicated.length, 1);
});

test('a component over the token cap sheds its lowest-scoring pair into spillover', async () => {
  const context = await setup({
    replies: ['{"reviews":[]}', '{"reviews":[]}'],
    blocker: {
      HackerGroup: [
        { canonical: 'Sandworm', sim: 0.99 },
        { canonical: 'Voodoo Bear', sim: 0.95 },
        { canonical: 'Telebots', sim: 0.91 },
      ],
    },
    tokenCap: 1, // every rendered block overflows: only the highest-scoring edge survives
  });
  const { dir, entityRegistry, repairer } = context;
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.mint('HackerGroup', 'Telebots', { doc: 1, date: '01.01.2024' });
  entityRegistry.mint('HackerGroup', 'Voodoo Bear', { doc: 2, date: '02.01.2024' });
  await entityRegistry.save();

  await repairer.processDoc('2.json', 2);

  const spilled = (await readLog(dir)).find((event) => event.op === 'repair-spillover');
  assert.ok(spilled, 'overflow is logged, per I1');
  assert.ok(entityRegistry.repairState().spillover.length > 0, 'and queued for a later document');
});

// --- failure posture ---------------------------------------------------------------------------

test('a repair-judge failure never aborts the document: every due pair spills', async () => {
  const context = await twoHackerGroups({});
  const { dir, entityRegistry } = context;
  // A client that throws — the same posture #linkJudge takes for the normalizer.
  const throwing = {
    async send() {
      throw new Error('backend down');
    },
  } as unknown as LlmClient;
  const failing = new StreamingRepairer({
    artifactsDir: path.join(dir, 'artifacts'),
    llmClient: throwing,
    schemaRegistry: context.schemaRegistry,
    entityRegistry,
    decisionLog: context.decisionLog,
    glossIndex: fakeGlossIndex(),
    blocker: fakeBlocker({
      HackerGroup: [
        { canonical: 'Sandworm', sim: 0.95 },
        { canonical: 'Voodoo Bear', sim: 0.95 },
      ],
    }),
    thresholds: thresholds(),
  });

  await failing.processDoc('2.json', 2);

  assert.equal(entityRegistry.repairState().spillover.length, 1, 'queued, not lost');
  assert.equal(entityRegistry.repairState().repairedThrough, 2, 'the document still completes');
});

// --- run(): standalone catch-up ------------------------------------------------------------------

test('run() processes only artifacts past repairedThrough', async () => {
  const { dir, entityRegistry, repairer } = await setup({ blocker: {} });
  entityRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  entityRegistry.setRepairedThrough(1);
  await entityRegistry.save();
  await writeArtifact(dir, '1.json', artifact([], [], 1));
  await writeArtifact(dir, '2.json', artifact([], [], 2));
  await writeArtifact(dir, '3.json', artifact([], [], 3));

  await repairer.run();

  assert.equal(entityRegistry.repairState().repairedThrough, 3);
});

// --- invariants ----------------------------------------------------------------------------------

test('I1 throws when a gathered suspect is left unaccounted', () => {
  const pair: SuspectPair = {
    a: { category: 'HackerGroup', canonical: 'Sandworm' },
    b: { category: 'HackerGroup', canonical: 'Voodoo Bear' },
    signal: 'union-blocker',
    score: 0.9,
    docId: 2,
  };
  assert.doesNotThrow(() => assertSuspectsAccounted(2, [pair], new Set([suspectPairKey(pair.a, pair.b)])));
  assert.throws(() => assertSuspectsAccounted(2, [pair], new Set()), /I1/);
});

test('I2 throws on a second first-attempt repair call for one document', async () => {
  assert.doesNotThrow(() => assertCallBudget(2, 1));
  assert.throws(() => assertCallBudget(2, 2), /I2/);

  // End to end: a low-confidence merge leaves the pair retained (empty signature), so re-processing
  // the same document re-fires it — a second first-attempt call on doc 2, which is the budget bug.
  const { repairer } = await twoHackerGroups({
    replies: [review([{ op: 'merge', from: 'Voodoo Bear', into: 'Sandworm', confidence: 'low', evidence: 'thin' }])],
  });
  await repairer.processDoc('2.json', 2);
  await assert.rejects(() => repairer.processDoc('2.json', 2), /I2/);
});
