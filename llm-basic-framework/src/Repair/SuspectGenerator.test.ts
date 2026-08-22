import { ConceptRegistry, type ConceptRef } from '../ConceptRegistry/ConceptRegistry';
import type { GlossIndex } from './GlossIndex';
import { eventsForDoc, parseThresholds, SuspectGenerator, type RegistryEvent } from './SuspectGenerator';
import type { Candidate, CandidateGenerator, CandidateQuery } from '../Normalization/types';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { test } from 'node:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * TDD for T6 `SuspectGenerator` — pure code, no LLM. Fakes stand in for T6's two collaborators
 * (`CandidateGenerator` blocker, `GlossIndex`); the registry is real, seeded via mint/link, matching
 * `GlossIndex.test.ts`'s `seeded()` pattern (`ConceptRegistry.test.ts`'s convention too).
 */

async function tmpRegistry(): Promise<ConceptRegistry> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suspect-generator-'));
  const registry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  return registry;
}

/** Table-driven fake blocker: mimics a real generator by filtering its own table on `query.minSim`,
 * so tests can assert SuspectGenerator computed and passed the right per-category threshold. */
function fakeBlocker(
  table: Record<string, Array<{ canonical: string; sim: number }>>
): CandidateGenerator & { calls: CandidateQuery[] } {
  const calls: CandidateQuery[] = [];
  return {
    id: 'fake-blocker',
    config: {},
    calls,
    async prepare() {},
    onRegistryChange() {},
    async candidates(query: CandidateQuery): Promise<Candidate[]> {
      calls.push(query);
      return (table[query.category] ?? [])
        .filter((c) => c.sim >= query.minSim)
        .map((c) => ({ canonical: c.canonical, sim: c.sim, surfaces: [c.canonical], channel: 'fake-blocker' }));
    },
  };
}

function fakeGlossIndex(opts: {
  nearest?: (ref: ConceptRef, k: number) => Array<{ ref: ConceptRef; sim: number }>;
  aliasCoherence?: (ref: ConceptRef, alias: string) => number;
}): GlossIndex & { coherenceCalls: Array<{ ref: ConceptRef; alias: string }> } {
  const coherenceCalls: Array<{ ref: ConceptRef; alias: string }> = [];
  return {
    coherenceCalls,
    async nearest(ref: ConceptRef, k: number) {
      return opts.nearest ? opts.nearest(ref, k) : [];
    },
    async aliasCoherence(ref: ConceptRef, alias: string) {
      coherenceCalls.push({ ref, alias });
      return opts.aliasCoherence ? opts.aliasCoherence(ref, alias) : 1;
    },
  } as unknown as GlossIndex & { coherenceCalls: Array<{ ref: ConceptRef; alias: string }> };
}

const noThresholds = () => ({
  glossAnn: new Map([['default', 0.9]]),
  blocker: new Map([['default', 0.9]]),
  coherence: 0.5,
});

// --- suspectsFor -------------------------------------------------------------------------------

test('a mint near a foreign-category entity surfaces a cross-category union-blocker suspect', async () => {
  const registry = await tmpRegistry();
  registry.mint('Software', 'EvilTool', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'APT28', { doc: 1, date: '2024-01-02' });

  const blocker = fakeBlocker({
    Software: [{ canonical: 'EvilTool', sim: 0.9 }],
    HackerGroup: [],
  });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({
    registry,
    glossIndex,
    blocker,
    thresholds: noThresholds(),
  });

  const events: RegistryEvent[] = [{ type: 'mint', ref: { category: 'HackerGroup', canonical: 'APT28' }, surface: 'APT28' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1);
  assert.deepEqual(suspects[0].a, { category: 'HackerGroup', canonical: 'APT28' });
  assert.deepEqual(suspects[0].b, { category: 'Software', canonical: 'EvilTool' });
  assert.equal(suspects[0].signal, 'union-blocker');
  assert.equal(suspects[0].score, 0.9);
  assert.equal(suspects[0].docId, 1);
});

test('self-hits are dropped: a blocker candidate resolving to the event\'s own ref never becomes a suspect', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });

  const blocker = fakeBlocker({ HackerGroup: [{ canonical: 'APT28', sim: 1.0 }] });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [{ type: 'mint', ref: { category: 'HackerGroup', canonical: 'APT28' }, surface: 'APT28' }];
  const suspects = await gen.suspectsFor(events, 0);

  assert.equal(suspects.length, 0);
});

test('an adjudicated "distinct" pair with an unchanged signature is suppressed', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'APT29', { doc: 0, date: '2024-01-01' });
  const a: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };
  const b: ConceptRef = { category: 'HackerGroup', canonical: 'APT29' };
  const signature = SuspectGenerator.signature(registry, a, b);
  registry.pushAdjudicated({ a, b, signature, verdict: 'distinct', docId: 0 });

  const blocker = fakeBlocker({ HackerGroup: [{ canonical: 'APT29', sim: 0.95 }] });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [{ type: 'alias-add', ref: a, surface: 'APT-28' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 0, 'unchanged signature must suppress the re-fire');
});

test('a new alias on one member changes the signature, so the adjudicated pair re-fires', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'APT29', { doc: 0, date: '2024-01-01' });
  const a: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };
  const b: ConceptRef = { category: 'HackerGroup', canonical: 'APT29' };
  const signature = SuspectGenerator.signature(registry, a, b);
  registry.pushAdjudicated({ a, b, signature, verdict: 'distinct', docId: 0 });

  // Mutates a's alias-surface set, so the current signature no longer matches the stored one.
  registry.link('HackerGroup', 'APT28', 'APT-28', { docId: 1 });

  const blocker = fakeBlocker({ HackerGroup: [{ canonical: 'APT29', sim: 0.95 }] });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [{ type: 'alias-add', ref: a, surface: 'APT-28' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1, 'a changed signature must re-fire even though the pair was adjudicated before');
  assert.equal(suspects[0].signal, 'union-blocker');
});

test('a retained suspect with the "" sentinel signature always re-fires, even with no changes', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'APT29', { doc: 0, date: '2024-01-01' });
  const a: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };
  const b: ConceptRef = { category: 'HackerGroup', canonical: 'APT29' };
  registry.pushAdjudicated({ a, b, signature: '', verdict: 'distinct', docId: 0 });

  const blocker = fakeBlocker({ HackerGroup: [{ canonical: 'APT29', sim: 0.95 }] });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [{ type: 'alias-add', ref: a, surface: 'anything' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1, 'the "" sentinel must never compare equal to a real signature');
});

test('a per-category blocker threshold silences one category while "default" still fires another', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28x', { doc: 0, date: '2024-01-01' });
  registry.mint('Software', 'EvilTool', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'NewGroup', { doc: 1, date: '2024-01-02' });

  const blocker = fakeBlocker({
    HackerGroup: [{ canonical: 'APT28x', sim: 0.9 }],
    Software: [{ canonical: 'EvilTool', sim: 0.9 }],
  });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({
    registry,
    glossIndex,
    blocker,
    thresholds: {
      glossAnn: new Map([['default', 0.9]]),
      blocker: new Map([
        ['default', 0.5],
        ['Software', 0.95], // stricter than the observed 0.9 -> silenced
      ]),
      coherence: 0.5,
    },
  });

  const events: RegistryEvent[] = [{ type: 'mint', ref: { category: 'HackerGroup', canonical: 'NewGroup' }, surface: 'NewGroup' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1, 'only the default-threshold category should surface a suspect');
  assert.deepEqual(suspects[0].b, { category: 'HackerGroup', canonical: 'APT28x' });

  const softwareCall = blocker.calls.find((c) => c.category === 'Software');
  assert.equal(softwareCall?.minSim, 0.95, 'the per-category threshold must be passed through as minSim');
});

test('gloss-ann threshold is keyed by the NEIGHBOUR\'s own category, not the probing event\'s category', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'NewGroup', { doc: 1, date: '2024-01-02' });
  registry.mint('Software', 'SomeTool', { doc: 0, date: '2024-01-01' });
  registry.mint('Country', 'Elbonia', { doc: 0, date: '2024-01-01' });

  const eventRef: ConceptRef = { category: 'HackerGroup', canonical: 'NewGroup' };
  const softwareRef: ConceptRef = { category: 'Software', canonical: 'SomeTool' };
  const countryRef: ConceptRef = { category: 'Country', canonical: 'Elbonia' };

  const blocker = fakeBlocker({});
  const glossIndex = fakeGlossIndex({
    nearest: () => [
      { ref: softwareRef, sim: 0.7 },
      { ref: countryRef, sim: 0.7 },
    ],
  });
  const gen = new SuspectGenerator({
    registry,
    glossIndex,
    blocker,
    thresholds: {
      glossAnn: new Map([
        ['default', 0.5],
        ['Software', 0.9], // stricter than the observed 0.7 -> must silence the Software neighbour
        // 'HackerGroup' (the EVENT's own category) is deliberately absent from the map: if the
        // implementation mistakenly keyed the threshold off the probing event's category instead of
        // each neighbour's OWN category, both neighbours would fall back to 'default' (0.5) and both
        // would pass — this test only distinguishes the two readings because it doesn't.
      ]),
      blocker: new Map([['default', 0.9]]),
      coherence: 0.5,
    },
  });

  const events: RegistryEvent[] = [{ type: 'mint', ref: eventRef, surface: 'NewGroup' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1, 'only the neighbour whose OWN category clears its own threshold should surface');
  assert.deepEqual(suspects[0].b, countryRef);
  assert.equal(suspects[0].signal, 'gloss-ann');
});

test('a threshold map missing "default" fails safe: the category is silenced (unreachable minSim) and a warning is logged', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'ExistingGroup', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'NewGroup', { doc: 1, date: '2024-01-02' });

  const blocker = fakeBlocker({ HackerGroup: [{ canonical: 'ExistingGroup', sim: 1.0 }] });
  const glossIndex = fakeGlossIndex({});
  const gen = new SuspectGenerator({
    registry,
    glossIndex,
    blocker,
    thresholds: {
      glossAnn: new Map([['default', 0.9]]),
      blocker: new Map(), // hand-built, skipping 'default' — not what parseThresholds would produce
      coherence: 0.5,
    },
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  let suspects;
  try {
    const events: RegistryEvent[] = [{ type: 'mint', ref: { category: 'HackerGroup', canonical: 'NewGroup' }, surface: 'NewGroup' }];
    suspects = await gen.suspectsFor(events, 1);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(suspects.length, 0, 'a category with no reachable threshold must fail safe to silence, not to an open floor');
  assert.ok(
    warnings.some((w) => /default/i.test(w) && w.includes('HackerGroup')),
    `expected a warning naming the category and "default", got ${JSON.stringify(warnings)}`
  );
  assert.equal(
    blocker.calls.find((c) => c.category === 'HackerGroup')?.minSim,
    Number.POSITIVE_INFINITY,
    'the missing-default fallback must pass an unreachable minSim through, not a low/undefined one'
  );
});

test('a drifted alias-add produces a single-entity coherence suspect; a mint never triggers coherence at all', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  const ref: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };

  const blocker = fakeBlocker({});
  const glossIndex = fakeGlossIndex({
    aliasCoherence: (_ref, alias) => (alias === 'Drifted' ? 0.1 : 1.0),
  });
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [
    { type: 'mint', ref, surface: 'APT28' },
    { type: 'alias-add', ref, surface: 'Drifted' },
  ];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].signal, 'coherence');
  assert.deepEqual(suspects[0].a, ref);
  assert.deepEqual(suspects[0].b, ref);
  assert.equal(suspects[0].score, 0.1);
  // Coherence is only ever probed for alias-add events, never for mints.
  assert.deepEqual(
    glossIndex.coherenceCalls.map((c) => c.alias),
    ['Drifted']
  );
});

test('a coherent alias-add (above the coherence threshold) produces no suspect', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  const ref: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };

  const blocker = fakeBlocker({});
  const glossIndex = fakeGlossIndex({ aliasCoherence: () => 0.95 });
  const gen = new SuspectGenerator({ registry, glossIndex, blocker, thresholds: noThresholds() });

  const events: RegistryEvent[] = [{ type: 'alias-add', ref, surface: 'Fancy Bear' }];
  const suspects = await gen.suspectsFor(events, 1);

  assert.equal(suspects.length, 0);
});

// --- static signature ---------------------------------------------------------------------------

test('signature(a, b) === signature(b, a) — member order never matters', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' }, { definition: 'a group' });
  registry.mint('Software', 'EvilTool', { doc: 0, date: '2024-01-01' });
  const a: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };
  const b: ConceptRef = { category: 'Software', canonical: 'EvilTool' };

  assert.equal(SuspectGenerator.signature(registry, a, b), SuspectGenerator.signature(registry, b, a));
});

test('signature changes when an alias surface is added to either member', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'APT29', { doc: 0, date: '2024-01-01' });
  const a: ConceptRef = { category: 'HackerGroup', canonical: 'APT28' };
  const b: ConceptRef = { category: 'HackerGroup', canonical: 'APT29' };

  const before = SuspectGenerator.signature(registry, a, b);
  registry.link('HackerGroup', 'APT28', 'Fancy Bear', { docId: 1 });
  const after = SuspectGenerator.signature(registry, a, b);

  assert.notEqual(before, after);
});

// --- eventsForDoc --------------------------------------------------------------------------------

test('eventsForDoc reads exactly one document\'s mints and link-decision aliases, and nothing else', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 1, date: '2024-01-01' }); // mint at doc 1
  registry.link('HackerGroup', 'APT28', 'Fancy Bear', { docId: 1 }); // alias-add, same doc as the mint
  registry.link('HackerGroup', 'APT28', 'Sofacy', { docId: 3 }); // alias-add, a DIFFERENT doc
  registry.mint('HackerGroup', 'APT29', { doc: 2, date: '2024-01-02' }); // mint at a DIFFERENT doc

  const events = eventsForDoc(registry, 1);

  const sorted = [...events].sort((x, y) => (x.surface < y.surface ? -1 : x.surface > y.surface ? 1 : 0));
  assert.deepEqual(sorted, [
    { type: 'mint', ref: { category: 'HackerGroup', canonical: 'APT28' }, surface: 'APT28' },
    { type: 'alias-add', ref: { category: 'HackerGroup', canonical: 'APT28' }, surface: 'Fancy Bear' },
  ]);
});

test('eventsForDoc does not double-count a mint\'s own self-alias (decision "mint") as an alias-add', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 5, date: '2024-01-01' });

  const events = eventsForDoc(registry, 5);

  assert.equal(events.length, 1, 'the self-alias must not also surface as an alias-add event');
  assert.equal(events[0].type, 'mint');
});

test('eventsForDoc excludes aliases with a non-"link" decision (e.g. "merge") even if their docId matches', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });
  registry.mint('HackerGroup', 'Sandworm', { doc: 0, date: '2024-01-01' });
  // applyMerges folds Sandworm's own name in as a 'merge'-decision alias of APT28, stamped with
  // Sandworm's original firstSeen.doc (0) — must never be read back as doc 0's alias-add.
  registry.applyMerges('HackerGroup', [{ from: 'Sandworm', into: 'APT28' }]);

  const events = eventsForDoc(registry, 0);

  assert.ok(
    !events.some((e) => e.type === 'alias-add' && e.surface === 'Sandworm'),
    'a merge-decision alias must never be read back as an alias-add event'
  );
});

test('eventsForDoc returns nothing for a document with no mints or links', async () => {
  const registry = await tmpRegistry();
  registry.mint('HackerGroup', 'APT28', { doc: 0, date: '2024-01-01' });

  assert.deepEqual(eventsForDoc(registry, 99), []);
});

// --- parseThresholds -------------------------------------------------------------------------------

test('parseThresholds(undefined, kind) returns a conservative (high) "default"-only map', () => {
  const glossAnn = parseThresholds(undefined, 'glossAnn');
  const blocker = parseThresholds(undefined, 'blocker');

  assert.equal(glossAnn.size, 1);
  assert.ok(glossAnn.has('default'));
  assert.ok(glossAnn.get('default')! >= 0.8, 'defaults must be conservative (high)');

  assert.equal(blocker.size, 1);
  assert.ok(blocker.has('default'));
  assert.ok(blocker.get('default')! >= 0.8, 'defaults must be conservative (high)');
});

test('parseThresholds parses "Category=value,default=value" pairs, trimming whitespace', () => {
  const parsed = parseThresholds(' Domain = 0.97 , default = 0.85 ', 'blocker');
  assert.deepEqual([...parsed.entries()].sort(), [
    ['Domain', 0.97],
    ['default', 0.85],
  ]);
});

test('parseThresholds requires a "default" entry when a spec string is given', () => {
  assert.throws(() => parseThresholds('Domain=0.97', 'blocker'), /default/i);
});

test('parseThresholds rejects a malformed entry', () => {
  assert.throws(() => parseThresholds('Domain=notanumber,default=0.85', 'glossAnn'));
});

test('signature keeps the frozen v5 serialization keys — persisted adjudications must not go stale', async () => {
  // The literal `gloss`/`surfaces` JSON keys ship inside `repair.adjudicated[].signature` strings
  // in 158 committed registries; renaming them would mark every stored adjudication stale and
  // re-fire re-adjudication across the corpus. This pins the dialect: the sha256 over the frozen
  // serialization of known content must never move.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-freeze-'));
  const registry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('C', 'A', { doc: 1, date: '' });
  registry.mint('C', 'B', { doc: 2, date: '' });
  registry.setDefinition('C', 'A', 'a definition');

  const expectedHalfA = JSON.stringify({ surfaces: ['a'], gloss: 'a definition' });
  const expectedHalfB = JSON.stringify({ surfaces: ['b'], gloss: null });
  const expected = crypto
    .createHash('sha256')
    .update([expectedHalfA, expectedHalfB].sort().join(' '))
    .digest('hex');
  assert.equal(
    SuspectGenerator.signature(registry, { category: 'C', canonical: 'A' }, { category: 'C', canonical: 'B' }),
    expected,
    'the persisted-signature dialect is frozen at the v5 vocabulary'
  );
});
