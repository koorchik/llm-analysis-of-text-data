import {
  EntityRegistry,
  type RegistryDataV1,
  type RegistryDataV2,
  type RegistryDataV3,
  type RegistryDataV4,
  type AdjudicatedEntry,
  type SuspectPair,
} from './EntityRegistry';
import { StringSimilarityGenerator } from '../Normalization/candidates/StringSimilarityGenerator';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function tmpPath(name = 'registry.json'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entityreg-'));
  return path.join(dir, name);
}

/** A loaded registry seeded via mint/link, which is how the pipeline builds one. */
async function seeded(
  entries: Array<{ category: string; canonical: string; aliases?: string[]; doc: number }>,
  options: Partial<ConstructorParameters<typeof EntityRegistry>[0]> = {}
): Promise<EntityRegistry> {
  const registry = new EntityRegistry({ filePath: await tmpPath(), ...options });
  await registry.load();
  for (const entry of entries) {
    registry.mint(entry.category, entry.canonical, { doc: entry.doc, date: '01.01.2020' });
    for (const alias of entry.aliases ?? []) {
      registry.link(entry.category, entry.canonical, alias, { docId: entry.doc });
    }
  }
  return registry;
}

const surfaces = (registry: EntityRegistry, category: string, canonical: string) =>
  [...registry.aliasSurfaces(category, canonical)].sort();

// --- v1 / v2 reading ------------------------------------------------------------------------------

test('reads a v1 file and reports that it was v1', async () => {
  const filePath = await tmpPath();
  const v1: RegistryDataV1 = {
    HackerGroup: {
      APT28: { aliases: ['APT28', 'Fancy Bear'], firstSeen: { doc: 40102, date: '01.01.2020' } },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(v1));

  const registry = new EntityRegistry({ filePath });
  await registry.load();

  assert.equal(registry.loadedFromV1, true);
  assert.equal(registry.resolve('HackerGroup', 'fancy bear'), 'APT28', 'index built from v1 aliases');
  assert.deepEqual(surfaces(registry, 'HackerGroup', 'APT28'), ['APT28', 'Fancy Bear']);

  // v1 carried no per-alias provenance, so migrated aliases must say so rather than invent one.
  const record = registry.records('HackerGroup').APT28;
  assert.ok(record.aliases.every((alias) => alias.decision === 'migrated'));
  assert.ok(record.aliases.every((alias) => alias.docId === 40102), 'firstSeen.doc is the only context v1 had');
});

test('reads a v2 file and adopts its recorded canonicalPolicy', async () => {
  const filePath = await tmpPath();
  const v2: RegistryDataV2 = {
    version: 2,
    canonicalPolicy: 'frequency-weighted',
    categories: {
      HackerGroup: {
        APT28: {
          aliases: [{ surface: 'APT28', docId: 1, decision: 'mint' }],
          firstSeen: { doc: 1, date: '01.01.2020' },
        },
      },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(v2));

  const registry = new EntityRegistry({ filePath });
  await registry.load();
  assert.equal(registry.loadedFromV1, false);
  assert.equal(registry.canonicalPolicy, 'frequency-weighted');
});

test('an explicit constructor policy wins over the file’s', async () => {
  const filePath = await tmpPath();
  await fs.writeFile(
    filePath,
    JSON.stringify({ version: 2, canonicalPolicy: 'frequency-weighted', categories: {} })
  );
  const registry = new EntityRegistry({ filePath, canonicalPolicy: 'highest-degree' });
  await registry.load();
  assert.equal(registry.canonicalPolicy, 'highest-degree');
});

test('writes v4 and round-trips through the reader', async () => {
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'APT28', aliases: ['Fancy Bear'], doc: 5 },
  ]);
  await registry.save();

  const written = JSON.parse(await fs.readFile(registry.filePath, 'utf8'));
  assert.equal(written.version, 4);
  assert.equal(written.canonicalPolicy, 'first-seen');
  assert.equal(written.categories.HackerGroup.APT28.aliases[0].surface, 'APT28');
  assert.equal(written.categories.HackerGroup.APT28.aliases[0].decision, 'mint');

  const reloaded = new EntityRegistry({ filePath: registry.filePath });
  await reloaded.load();
  assert.equal(reloaded.resolve('HackerGroup', 'FANCY BEAR'), 'APT28');
});

test('toV1 projects back to the historical shape', async () => {
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'APT28', aliases: ['Fancy Bear'], doc: 7 },
  ]);
  const v1 = registry.toV1();
  assert.deepEqual(v1.HackerGroup.APT28.aliases, ['APT28', 'Fancy Bear'], 'strings, not records');
  assert.deepEqual(v1.HackerGroup.APT28.firstSeen, { doc: 7, date: '01.01.2020' });
  assert.equal('gloss' in v1.HackerGroup.APT28, false, 'v1 has no place for v2-only fields');
});

// --- provenance -----------------------------------------------------------------------------------

test('link records document, confidence and evidence', async () => {
  const registry = await seeded([{ category: 'HackerGroup', canonical: 'APT28', doc: 1 }]);
  registry.link('HackerGroup', 'APT28', 'Fancy Bear', {
    docId: 40102,
    confidence: 0.9,
    evidence: '…also known as…',
  });

  const alias = registry.records('HackerGroup').APT28.aliases.find((a) => a.surface === 'Fancy Bear')!;
  assert.equal(alias.docId, 40102);
  assert.equal(alias.decision, 'link');
  assert.equal(alias.confidence, 0.9);
  assert.equal(alias.evidence, '…also known as…');
});

test('runId is stamped so a merge is attributable after the fact', async () => {
  const registry = await seeded([{ category: 'HackerGroup', canonical: 'APT28', doc: 1 }], {
    runId: 'run-abc',
  });
  registry.link('HackerGroup', 'APT28', 'Fancy Bear');
  assert.equal(registry.records('HackerGroup').APT28.aliases[1].addedBy, 'run-abc');
});

test('gloss and externalIds are settable and persisted', async () => {
  const registry = await seeded([{ category: 'HackerGroup', canonical: 'APT28', doc: 1 }]);
  registry.setGloss('HackerGroup', 'APT28', 'Russian state-sponsored threat actor');
  registry.setExternalId('HackerGroup', 'APT28', 'mitreAttack', 'G0007');
  registry.setExternalId('HackerGroup', 'APT28', 'wikidata', null);
  await registry.save();

  const written = JSON.parse(await fs.readFile(registry.filePath, 'utf8'));
  const record = written.categories.HackerGroup.APT28;
  assert.equal(record.gloss, 'Russian state-sponsored threat actor');
  assert.deepEqual(record.externalIds, { mitreAttack: 'G0007', wikidata: null });
});

test('link is idempotent and does not duplicate an alias', async () => {
  const registry = await seeded([{ category: 'HackerGroup', canonical: 'APT28', doc: 1 }]);
  registry.link('HackerGroup', 'APT28', 'Fancy Bear');
  registry.link('HackerGroup', 'APT28', 'fancy BEAR');
  assert.equal(registry.records('HackerGroup').APT28.aliases.length, 2, 'canonical + one alias');
});

// --- applyMerges: the order-dependence bug --------------------------------------------------------

test('chained merges succeed in EITHER order — the v1 bug', async () => {
  // v1 applied from→into sequentially behind a `records[from] && records[into]` guard, so
  // [{A→B},{B→C}] worked and [{B→C},{A→B}] silently dropped A→B. Same input, different registry.
  const run = async (merges: Array<{ from: string; into: string }>) => {
    const registry = await seeded([
      { category: 'C', canonical: 'A', doc: 1 },
      { category: 'C', canonical: 'B', doc: 2 },
      { category: 'C', canonical: 'C3', doc: 3 },
    ]);
    registry.applyMerges('C', merges);
    return registry;
  };

  const forward = await run([{ from: 'A', into: 'B' }, { from: 'B', into: 'C3' }]);
  const reverse = await run([{ from: 'B', into: 'C3' }, { from: 'A', into: 'B' }]);

  // One surviving canonical holding all three surfaces, whichever order the merges arrived in.
  assert.deepEqual(Object.keys(forward.records('C')), ['A'], 'first-seen survivor is A (doc 1)');
  assert.deepEqual(Object.keys(reverse.records('C')), ['A']);
  assert.deepEqual(surfaces(forward, 'C', 'A'), ['A', 'B', 'C3']);
  assert.deepEqual(surfaces(reverse, 'C', 'A'), ['A', 'B', 'C3'], 'no alias silently lost');
});

test('a merge group keeps the earliest firstSeen', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'Late', doc: 90 },
    { category: 'C', canonical: 'Early', doc: 5 },
  ]);
  registry.applyMerges('C', [{ from: 'Late', into: 'Early' }]);
  assert.equal(registry.records('C').Early.firstSeen.doc, 5);
});

test('merged aliases carry decision "merge" and the requested evidence', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
  ]);
  registry.applyMerges('C', [{ from: 'B', into: 'A', evidence: 'aka in doc 7', confidence: 0.8 }]);

  const merged = registry.records('C').A.aliases.find((alias) => alias.surface === 'B')!;
  assert.equal(merged.decision, 'merge');
  assert.equal(merged.evidence, 'aka in doc 7');
});

test('applyMerges reports what it did, so the caller can log it', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
    { category: 'C', canonical: 'Z', doc: 3 },
  ]);
  const summary = registry.applyMerges('C', [{ from: 'B', into: 'A' }]);
  assert.deepEqual(summary.survivors, ['A']);
  assert.deepEqual(summary.removed, ['B']);
  assert.equal(summary.groups.length, 1);
  assert.ok(registry.records('C').Z, 'untouched canonicals survive');
});

test('self-merges and unknown canonicals are ignored, not thrown', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  const summary = registry.applyMerges('C', [
    { from: 'A', into: 'A' },
    { from: 'A', into: 'ghost' },
  ]);
  assert.equal(summary.groups.length, 0);
  assert.deepEqual(Object.keys(registry.records('C')), ['A']);
});

test('the alias index is rebuilt after a merge, so resolve follows it', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
  ]);
  registry.applyMerges('C', [{ from: 'B', into: 'A' }]);
  assert.equal(registry.resolve('C', 'B'), 'A', 'the removed canonical now resolves to the survivor');
});

// --- canonicalPolicy ------------------------------------------------------------------------------

test('first-seen keeps the earliest document, regardless of merge direction', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'Newer', doc: 50 },
    { category: 'C', canonical: 'Older', doc: 2 },
  ]);
  // The caller asks to fold Older INTO Newer; the policy overrules, because under closure `into` is
  // ambiguous anyway. The request survives in provenance.
  registry.applyMerges('C', [{ from: 'Older', into: 'Newer' }]);
  assert.deepEqual(Object.keys(registry.records('C')), ['Older']);
});

test('frequency-weighted keeps the canonical with the most aliases', async () => {
  const registry = await seeded(
    [
      { category: 'C', canonical: 'Sparse', doc: 1 },
      { category: 'C', canonical: 'Rich', aliases: ['r2', 'r3', 'r4'], doc: 90 },
    ],
    { canonicalPolicy: 'frequency-weighted' }
  );
  registry.applyMerges('C', [{ from: 'Rich', into: 'Sparse' }]);
  assert.deepEqual(Object.keys(registry.records('C')), ['Rich'], 'despite being seen later');
});

test('highest-degree uses the injected provider', async () => {
  const registry = await seeded(
    [
      { category: 'C', canonical: 'Low', doc: 1 },
      { category: 'C', canonical: 'High', doc: 90 },
    ],
    {
      canonicalPolicy: 'highest-degree',
      degreeOf: (_category, canonical) => (canonical === 'High' ? 42 : 1),
    }
  );
  registry.applyMerges('C', [{ from: 'High', into: 'Low' }]);
  assert.deepEqual(Object.keys(registry.records('C')), ['High']);
});

test('highest-degree without a provider falls back to first-seen and warns', async () => {
  // The registry holds no graph, so the policy cannot be honoured alone. Falling back silently
  // would make the recorded policy a lie.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => warnings.push(String(message));
  try {
    const registry = await seeded(
      [
        { category: 'C', canonical: 'Early', doc: 1 },
        { category: 'C', canonical: 'Late', doc: 90 },
      ],
      { canonicalPolicy: 'highest-degree' }
    );
    registry.applyMerges('C', [{ from: 'Early', into: 'Late' }]);
    assert.deepEqual(Object.keys(registry.records('C')), ['Early']);
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((message) => /highest-degree/.test(message)));
});

test('the survivor never depends on insertion order when the policy ties', async () => {
  // Same firstSeen for both: the code-unit tie-break must decide, not whichever was minted first.
  const build = async (order: string[]) => {
    const registry = await seeded(
      order.map((canonical) => ({ category: 'C', canonical, doc: 1 })),
    );
    registry.applyMerges('C', [{ from: order[0], into: order[1] }]);
    return Object.keys(registry.records('C'));
  };
  assert.deepEqual(await build(['beta', 'alpha']), ['alpha']);
  assert.deepEqual(await build(['alpha', 'beta']), ['alpha']);
});

// --- split (the operator v1 lacked entirely) ------------------------------------------------------

test('split detaches the named aliases into a new canonical', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'Blob', aliases: ['keep-1', 'move-1', 'move-2'], doc: 3 },
  ]);

  const result = registry.split('C', 'Blob', ['move-1', 'move-2'], { evidence: 'distinct actors' });

  assert.ok(result);
  assert.equal(result!.newCanonical, 'move-1', 'deterministic: lowest surface in code-unit order');
  assert.deepEqual(surfaces(registry, 'C', 'Blob'), ['Blob', 'keep-1']);
  assert.deepEqual(surfaces(registry, 'C', 'move-1'), ['move-1', 'move-2']);
  // Both halves resolve to their own canonical afterwards.
  assert.equal(registry.resolve('C', 'move-2'), 'move-1');
  assert.equal(registry.resolve('C', 'keep-1'), 'Blob');
});

test('split records provenance on the detached aliases', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'Blob', aliases: ['x'], doc: 3 }], {
    runId: 'run-split',
  });
  registry.split('C', 'Blob', ['x'], { evidence: 'not the same host' });

  const alias = registry.records('C').x.aliases[0];
  assert.equal(alias.decision, 'split');
  assert.equal(alias.evidence, 'not the same host');
  assert.equal(alias.addedBy, 'run-split');
});

test('split is case-insensitive on the surfaces to detach', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'Blob', aliases: ['Move-Me'], doc: 1 }]);
  const result = registry.split('C', 'Blob', ['move-me']);
  assert.equal(result!.newCanonical, 'Move-Me');
});

test('split refuses to detach every alias — that is a rename, not a split', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'Solo', doc: 1 }]);
  assert.equal(registry.split('C', 'Solo', ['Solo']), null, 'would leave an empty canonical');
  assert.deepEqual(Object.keys(registry.records('C')), ['Solo'], 'unchanged');
});

test('split returns null for an unknown canonical or a no-op detach set', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', aliases: ['a2'], doc: 1 }]);
  assert.equal(registry.split('C', 'ghost', ['a2']), null);
  assert.equal(registry.split('C', 'A', ['not-an-alias']), null);
});

test('mint cannot create a canonical that is already an alias — collisions are unconstructible', async () => {
  // Worth pinning: `mint` resolves first, so linking "taken" to A and then minting "taken" returns
  // A rather than creating a second canonical. The alias index makes the inconsistency impossible
  // through the public API, which is why split's collision guard is purely defensive.
  const registry = await seeded([{ category: 'C', canonical: 'A', aliases: ['taken'], doc: 1 }]);
  assert.equal(registry.mint('C', 'taken', { doc: 2, date: '01.01.2020' }), 'A');
  assert.deepEqual(Object.keys(registry.records('C')), ['A']);
});

test('split refuses to collide with an existing canonical (defensive, from a crafted file)', async () => {
  // Only reachable from a file that already holds the inconsistency, since mint/link cannot produce
  // it (above). Exercised anyway: a hand-edited or externally-generated registry could.
  const filePath = await tmpPath();
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 2,
      canonicalPolicy: 'first-seen',
      categories: {
        C: {
          A: {
            aliases: [
              { surface: 'A', docId: 1, decision: 'mint' },
              { surface: 'taken', docId: 1, decision: 'link' },
            ],
            firstSeen: { doc: 1, date: '01.01.2020' },
          },
          taken: {
            aliases: [{ surface: 'taken', docId: 2, decision: 'mint' }],
            firstSeen: { doc: 2, date: '01.01.2020' },
          },
        },
      },
    })
  );
  const registry = new EntityRegistry({ filePath });
  await registry.load();

  assert.equal(registry.split('C', 'A', ['taken']), null, 'would clash with the existing canonical');
  assert.deepEqual(Object.keys(registry.records('C')).sort(), ['A', 'taken'], 'unchanged');
});

test('split then merge round-trips the membership', async () => {
  // Splitting and re-merging must restore one cluster, which is what makes repair reversible and is
  // the argument for the symbolic alias graph over baked-in embeddings (liu2023mulcanon).
  const registry = await seeded([
    { category: 'C', canonical: 'A', aliases: ['b', 'c'], doc: 1 },
  ]);
  const split = registry.split('C', 'A', ['b', 'c'])!;
  assert.equal(Object.keys(registry.records('C')).length, 2);

  registry.applyMerges('C', [{ from: split.newCanonical, into: 'A' }]);
  assert.deepEqual(Object.keys(registry.records('C')), ['A']);
  assert.deepEqual(surfaces(registry, 'C', 'A'), ['A', 'b', 'c']);
});

// --- move ------------------------------------------------------------------------------------------

test('move relocates one canonical between categories', async () => {
  // NB the alias must not be a mere case-variant of the canonical: `link` skips those, because the
  // alias index is case-folded. 'Atera' would be dropped; 'Atera Networks' is a real alias.
  const registry = await seeded([
    { category: 'Organization', canonical: 'atera', aliases: ['Atera Networks'], doc: 6280099 },
  ]);

  assert.equal(registry.move('Organization', 'atera', 'Software'), true);
  assert.deepEqual(registry.categories(), ['Software'], 'the emptied category is dropped');
  assert.deepEqual(surfaces(registry, 'Software', 'atera'), ['Atera Networks', 'atera']);
  assert.equal(registry.resolve('Software', 'atera'), 'atera');
  assert.equal(registry.resolve('Organization', 'atera'), undefined);
});

test('move into an existing canonical folds the aliases in', async () => {
  const registry = await seeded([
    { category: 'Organization', canonical: 'atera', aliases: ['Atera Networks'], doc: 90 },
    { category: 'Software', canonical: 'atera', aliases: ['Atera RMM'], doc: 5 },
  ]);

  assert.equal(registry.move('Organization', 'atera', 'Software'), true);
  assert.deepEqual(surfaces(registry, 'Software', 'atera'), [
    'Atera Networks',
    'Atera RMM',
    'atera',
  ]);
  assert.equal(registry.records('Software').atera.firstSeen.doc, 5, 'earliest firstSeen kept');
});

test('move records the operation on the relocated aliases', async () => {
  const registry = await seeded([{ category: 'A', canonical: 'x', doc: 1 }], { runId: 'run-move' });
  registry.move('A', 'x', 'B');
  const alias = registry.records('B').x.aliases[0];
  assert.equal(alias.decision, 'move');
  assert.equal(alias.addedBy, 'run-move');
});

test('move tracks the observation in categoryCounts, for soft category blocking later', async () => {
  const registry = await seeded([{ category: 'A', canonical: 'x', doc: 1 }]);
  registry.move('A', 'x', 'B');
  const counts = registry.records('B').x.categoryCounts!;
  assert.equal(counts.A, 1, 'the original category is still evidenced');
  assert.equal(counts.B, 1);
});

test('move rejects a no-op and an unknown canonical', async () => {
  const registry = await seeded([{ category: 'A', canonical: 'x', doc: 1 }]);
  assert.equal(registry.move('A', 'x', 'A'), false);
  assert.equal(registry.move('A', 'ghost', 'B'), false);
});

test('moveCategory relocates every canonical and drops the old bucket', async () => {
  const registry = await seeded([
    { category: 'Old', canonical: 'a', doc: 1 },
    { category: 'Old', canonical: 'b', doc: 2 },
    { category: 'New', canonical: 'c', doc: 3 },
  ]);
  registry.moveCategory('Old', 'New');
  assert.deepEqual(registry.categories(), ['New']);
  assert.deepEqual(Object.keys(registry.records('New')).sort(), ['a', 'b', 'c']);
});

test('the operator inventory is complete: merge, split, move', async () => {
  // gruenheid2014incremental's full inventory. v1 had merge only, plus move as a side effect of a
  // whole-category merge — which is why E6's repair ablation could not be expressed at all.
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  assert.equal(typeof registry.applyMerges, 'function');
  assert.equal(typeof registry.split, 'function');
  assert.equal(typeof registry.move, 'function');
});

// --- v1 → v2 → v1 round trip -----------------------------------------------------------------------

test('parse(v1) then toV1() is the identity on everything v1 could express', async () => {
  // The migration must not silently alter state. Anything v1 held has to survive the round trip
  // exactly; only fields v1 never had (provenance detail, gloss, externalIds) are additions.
  const v1: RegistryDataV1 = {
    HackerGroup: {
      APT28: { aliases: ['APT28', 'Fancy Bear', 'Sofacy'], firstSeen: { doc: 40102, date: '16.03.2022' } },
      Sandworm: { aliases: ['Sandworm'], firstSeen: { doc: 37788, date: '01.02.2022' } },
    },
    Country: { Ukraine: { aliases: ['Ukraine', 'UA'], firstSeen: { doc: 1, date: '01.01.2020' } } },
  };

  const filePath = await tmpPath();
  await fs.writeFile(filePath, JSON.stringify(v1));
  const registry = new EntityRegistry({ filePath });
  await registry.load();

  assert.deepEqual(registry.toV1(), v1, 'v1 content survives the round trip unchanged');
});

test('a migrated registry answers candidates() identically to the v1 original', async () => {
  // The property that makes the migration safe for the M2.5 gate: v2 changes storage, not matching.
  const v1: RegistryDataV1 = {
    C: {
      'UAC-0010': { aliases: ['UAC-0010'], firstSeen: { doc: 1, date: 'd' } },
      'UAC-0018': { aliases: ['UAC-0018'], firstSeen: { doc: 2, date: 'd' } },
      'UAC-0010 (Armageddon)': { aliases: ['UAC-0010 (Armageddon)'], firstSeen: { doc: 3, date: 'd' } },
    },
  };

  const v1Path = await tmpPath('v1.json');
  await fs.writeFile(v1Path, JSON.stringify(v1));
  const fromV1 = new EntityRegistry({ filePath: v1Path });
  await fromV1.load();

  // Persist as v2, reload, and compare.
  const v2Path = await tmpPath('v2.json');
  await fs.writeFile(v2Path, JSON.stringify(fromV1.toJSON()));
  const fromV2 = new EntityRegistry({ filePath: v2Path });
  await fromV2.load();

  assert.equal(fromV2.loadedFromV1, false);

  // Candidate generation left the registry in M4, so the invariant is now expressed through the
  // generator: v2 changes STORAGE, not matching, and the snapshot of either must score identically.
  const fromV1Generator = new StringSimilarityGenerator();
  await fromV1Generator.prepare(fromV1.snapshot());
  const fromV2Generator = new StringSimilarityGenerator();
  await fromV2Generator.prepare(fromV2.snapshot());

  for (const query of ['UAC-0010', 'UAC-0018', 'UAC-0099']) {
    const q = { mention: query, category: 'C', k: 5, minSim: 0.5 };
    assert.deepEqual(
      await fromV2Generator.candidates(q),
      await fromV1Generator.candidates(q),
      `candidates differ for ${query}`
    );
  }
});

test('v2 is written with a recorded policy, so a reload cannot silently change merge behaviour', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }], {
    canonicalPolicy: 'frequency-weighted',
  });
  await registry.save();
  const reloaded = new EntityRegistry({ filePath: registry.filePath });
  await reloaded.load();
  assert.equal(reloaded.canonicalPolicy, 'frequency-weighted');
});

// --- v3: identity-graph layers --------------------------------------------------------------------

test('v3 round-trips rungs, granularity/rename edges and the defer queue', async () => {
  const registry = await seeded([
    { category: 'Software', canonical: 'Microsoft Office 2010 SP2', doc: 1 },
    { category: 'Software', canonical: 'Microsoft Office', doc: 2 },
    { category: 'HackerGroup', canonical: 'Sandworm', doc: 3 },
    { category: 'HackerGroup', canonical: 'APT44', doc: 4 },
  ]);

  registry.setRung('Software', 'Microsoft Office 2010 SP2', 'g0');
  registry.setRung('Software', 'Microsoft Office', 'g2');
  assert.ok(
    registry.addGranularityEdge('Software', {
      from: 'Microsoft Office 2010 SP2',
      to: 'Microsoft Office',
      kind: 'coarsens-to',
      docId: 5,
      decision: 'judge',
      evidence: 'service pack blurred',
    })
  );
  assert.ok(
    registry.addRenameEdge('HackerGroup', {
      from: 'Sandworm',
      to: 'APT44',
      docId: 6,
      decision: 'consolidator',
      validFrom: '2024-01-01',
    })
  );
  registry.pushDeferred({
    category: 'HackerGroup',
    mention: 'UAC-0002',
    mintedAs: 'UAC-0002',
    candidates: ['Sandworm'],
    docId: 7,
  });
  await registry.save();

  const raw = JSON.parse(await fs.readFile(registry.filePath, 'utf8'));
  assert.equal(raw.version, 4, 'save() always writes the current file version, v4 since T3');

  const reloaded = new EntityRegistry({ filePath: registry.filePath });
  await reloaded.load();
  assert.equal(reloaded.rungOf('Software', 'Microsoft Office 2010 SP2'), 'g0');
  assert.equal(reloaded.granularityEdges('Software').length, 1);
  assert.equal(reloaded.granularityEdges('Software')[0].kind, 'coarsens-to');
  assert.equal(reloaded.renameEdges('HackerGroup')[0].to, 'APT44');
  assert.equal(reloaded.deferred().length, 1);
});

test('a v2 file loads with empty v3 layers', async () => {
  const filePath = await tmpPath();
  const v2: RegistryDataV2 = {
    version: 2,
    canonicalPolicy: 'first-seen',
    categories: {
      C: {
        A: {
          aliases: [{ surface: 'A', docId: 1, decision: 'mint' }],
          firstSeen: { doc: 1, date: '' },
        },
      },
    },
  };
  await fs.writeFile(filePath, JSON.stringify(v2));
  const registry = new EntityRegistry({ filePath });
  await registry.load();
  assert.equal(registry.resolve('C', 'a'), 'A');
  assert.deepEqual(registry.granularityEdges('C'), []);
  assert.deepEqual(registry.deferred(), []);
});

test('granularity edges reject self-loops, unknown endpoints and cycles', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
    { category: 'C', canonical: 'D', doc: 3 },
  ]);
  const edge = (from: string, to: string) =>
    registry.addGranularityEdge('C', { from, to, kind: 'coarsens-to', docId: 1, decision: 'judge' });

  assert.equal(edge('A', 'A'), false, 'self-loop');
  assert.equal(edge('A', 'nope'), false, 'unknown endpoint');
  assert.equal(edge('A', 'B'), true);
  assert.equal(edge('B', 'D'), true);
  assert.equal(edge('D', 'A'), false, 'would close a cycle');
  assert.equal(edge('A', 'B'), true, 'idempotent re-add');
  assert.equal(registry.granularityEdges('C').length, 2);

  assert.equal(registry.removeGranularityEdge('C', 'B', 'D'), true);
  assert.equal(edge('D', 'A'), true, 'edge is legal once the path is gone');
});

test('setRung is first-write-wins', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  registry.setRung('C', 'A', 'g1');
  registry.setRung('C', 'A', 'g3');
  assert.equal(registry.rungOf('C', 'A'), 'g1');
});

test('applyMerges rewrites edges and defer entries to the survivor and drops self-loops', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
    { category: 'C', canonical: 'Parent', doc: 3 },
  ]);
  registry.addGranularityEdge('C', { from: 'A', to: 'Parent', kind: 'part-of', docId: 1, decision: 'judge' });
  registry.addGranularityEdge('C', { from: 'B', to: 'Parent', kind: 'part-of', docId: 2, decision: 'judge' });
  registry.addGranularityEdge('C', { from: 'B', to: 'A', kind: 'coarsens-to', docId: 2, decision: 'judge' });
  registry.pushDeferred({ category: 'C', mention: 'b', mintedAs: 'B', candidates: ['A'], docId: 9 });

  registry.applyMerges('C', [{ from: 'B', into: 'A' }]);

  const edges = registry.granularityEdges('C');
  assert.deepEqual(
    edges.map((e) => `${e.from}->${e.to}`),
    ['A->Parent'],
    'B\'s duplicate edge deduped, B->A self-loop dropped'
  );
  assert.equal(registry.deferred()[0].mintedAs, 'A', 'defer entry follows the survivor');
});

test('move drops edges touching the departing canonical; moveCategory migrates the whole layer', async () => {
  const registry = await seeded([
    { category: 'X', canonical: 'A', doc: 1 },
    { category: 'X', canonical: 'B', doc: 2 },
  ]);
  registry.addGranularityEdge('X', { from: 'A', to: 'B', kind: 'coarsens-to', docId: 1, decision: 'judge' });

  registry.move('X', 'A', 'Y');
  assert.deepEqual(registry.granularityEdges('X'), [], 'edge touching moved canonical dropped');

  // Rebuild the pair inside one category, then migrate the bucket wholesale.
  registry.move('Y', 'A', 'X');
  registry.addGranularityEdge('X', { from: 'A', to: 'B', kind: 'coarsens-to', docId: 1, decision: 'judge' });
  registry.pushDeferred({ category: 'X', mention: 'a', mintedAs: 'A', candidates: [], docId: 3 });
  registry.moveCategory('X', 'Z');
  assert.equal(registry.granularityEdges('Z').length, 1, 'granularity layer migrated with the bucket');
  assert.equal(registry.deferred()[0].category, 'Z', 'defer entries follow the category merge');
});

test('clearDeferred removes only consumed entries', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  registry.pushDeferred({ category: 'C', mention: 'x', mintedAs: 'A', candidates: [], docId: 1 });
  registry.pushDeferred({ category: 'C', mention: 'y', mintedAs: 'A', candidates: [], docId: 2 });
  registry.pushDeferred({ category: 'C', mention: 'x', mintedAs: 'A', candidates: [], docId: 1 }); // dup ignored
  assert.equal(registry.deferred().length, 2);

  registry.clearDeferred([{ category: 'C', mention: 'x', mintedAs: 'A', candidates: [], docId: 1 }]);
  assert.deepEqual(registry.deferred().map((d) => d.mention), ['y']);
});

// --- v4: repair state (T3) -------------------------------------------------------------------------

test('a v3 file loads with empty repair state', async () => {
  const filePath = await tmpPath();
  const v3: RegistryDataV3 = {
    version: 3,
    canonicalPolicy: 'first-seen',
    categories: {
      C: { A: { aliases: [{ surface: 'A', docId: 1, decision: 'mint' }], firstSeen: { doc: 1, date: '' } } },
    },
    granularityEdges: {},
    renameEdges: {},
    deferQueue: [],
  };
  await fs.writeFile(filePath, JSON.stringify(v3));

  const registry = new EntityRegistry({ filePath });
  await registry.load();
  assert.deepEqual(registry.repairState(), { adjudicated: [], spillover: [], repairedThrough: -1 });
});

test('v4 round-trips repair state through parse/toJSON', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
  ]);
  registry.pushAdjudicated({
    a: { category: 'C', canonical: 'A' },
    b: { category: 'C', canonical: 'B' },
    signature: 'sig-1',
    verdict: 'distinct',
    docId: 5,
  });
  registry.pushSpillover([
    {
      a: { category: 'C', canonical: 'A' },
      b: { category: 'C', canonical: 'B' },
      signal: 'defer',
      score: 0.5,
      docId: 6,
    },
  ]);
  registry.setRepairedThrough(6);
  await registry.save();

  const written = JSON.parse(await fs.readFile(registry.filePath, 'utf8')) as RegistryDataV4;
  assert.equal(written.version, 4);
  assert.equal(written.repair.adjudicated.length, 1);
  assert.equal(written.repair.spillover.length, 1);
  assert.equal(written.repair.repairedThrough, 6);

  const reloaded = new EntityRegistry({ filePath: registry.filePath });
  await reloaded.load();
  assert.deepEqual(reloaded.repairState(), registry.repairState());
});

test('setRepairedThrough / pushSpillover / drainSpillover round-trip in memory', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  assert.equal(registry.repairState().repairedThrough, -1, 'nothing repaired yet');

  registry.setRepairedThrough(3);
  assert.equal(registry.repairState().repairedThrough, 3);

  const pair: SuspectPair = {
    a: { category: 'C', canonical: 'A' },
    b: { category: 'C', canonical: 'A' },
    signal: 'coherence',
    score: 0.9,
    docId: 4,
  };
  registry.pushSpillover([pair]);
  assert.deepEqual(registry.repairState().spillover, [pair]);

  const drained = registry.drainSpillover();
  assert.deepEqual(drained, [pair]);
  assert.deepEqual(registry.repairState().spillover, [], 'drained, not just read');
});

test('findAdjudicated matches an unordered pair', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
  ]);
  const entry: AdjudicatedEntry = {
    a: { category: 'C', canonical: 'A' },
    b: { category: 'C', canonical: 'B' },
    signature: 'sig',
    verdict: 'distinct',
    docId: 3,
  };
  registry.pushAdjudicated(entry);

  assert.deepEqual(
    registry.findAdjudicated({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'B' }),
    entry
  );
  assert.deepEqual(
    registry.findAdjudicated({ category: 'C', canonical: 'B' }, { category: 'C', canonical: 'A' }),
    entry,
    'unordered'
  );
  assert.equal(
    registry.findAdjudicated({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'ghost' }),
    undefined
  );
});

test('adjudicated entries naming absorbed canonicals are pruned lazily on findAdjudicated', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
    { category: 'C', canonical: 'Untouched1', doc: 3 },
    { category: 'C', canonical: 'Untouched2', doc: 4 },
  ]);
  const stale: AdjudicatedEntry = {
    a: { category: 'C', canonical: 'A' },
    b: { category: 'C', canonical: 'B' },
    signature: 'sig-stale',
    verdict: 'distinct',
    docId: 1,
  };
  const alive: AdjudicatedEntry = {
    a: { category: 'C', canonical: 'Untouched1' },
    b: { category: 'C', canonical: 'Untouched2' },
    signature: 'sig-alive',
    verdict: 'distinct',
    docId: 1,
  };
  registry.pushAdjudicated(stale);
  registry.pushAdjudicated(alive);

  registry.applyMerges('C', [{ from: 'B', into: 'A' }]); // B absorbed — stale entry's premise is gone

  assert.equal(
    registry.findAdjudicated({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'B' }),
    undefined,
    'B no longer exists as a live canonical — its verdict is stale'
  );
  assert.deepEqual(registry.repairState().adjudicated, [alive], 'untouched entry survives');
});

test('adjudicated entries naming unknown canonicals are pruned on load', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  registry.pushAdjudicated({
    a: { category: 'C', canonical: 'A' },
    b: { category: 'C', canonical: 'Ghost' }, // never a live canonical — e.g. a hand-edited file
    signature: 'sig',
    verdict: 'distinct',
    docId: 1,
  });
  await registry.save();

  const reloaded = new EntityRegistry({ filePath: registry.filePath });
  await reloaded.load();
  assert.deepEqual(reloaded.repairState().adjudicated, []);
});

// --- moveAlias (T3) ---------------------------------------------------------------------------------

test('moveAlias reattaches one alias record to a different canonical', async () => {
  const registry = await seeded(
    [
      { category: 'C', canonical: 'A', aliases: ['stray'], doc: 1 },
      { category: 'C', canonical: 'B', doc: 2 },
    ],
    { runId: 'run-repair' }
  );

  const ok = registry.moveAlias(
    { category: 'C', canonical: 'A' },
    { category: 'C', canonical: 'B' },
    'stray',
    { docId: 9, evidence: 'misattributed' }
  );

  assert.equal(ok, true);
  assert.deepEqual(surfaces(registry, 'C', 'A'), ['A']);
  assert.deepEqual(surfaces(registry, 'C', 'B'), ['B', 'stray']);
  assert.equal(registry.resolve('C', 'stray'), 'B', 'index follows the move');
  assert.equal(registry.matchedSurface('C', 'stray'), 'stray');

  const moved = registry.records('C').B.aliases.find((a) => a.surface === 'stray')!;
  assert.equal(moved.decision, 'move');
  assert.equal(moved.docId, 9);
  assert.equal(moved.evidence, 'misattributed');
  assert.equal(moved.addedBy, 'run-repair');
});

test('moveAlias works across categories', async () => {
  const registry = await seeded([
    { category: 'Organization', canonical: 'atera', aliases: ['Atera Networks'], doc: 1 },
    { category: 'Software', canonical: 'atera-rmm', doc: 2 },
  ]);

  assert.equal(
    registry.moveAlias(
      { category: 'Organization', canonical: 'atera' },
      { category: 'Software', canonical: 'atera-rmm' },
      'Atera Networks',
      { docId: 3 }
    ),
    true
  );
  assert.equal(registry.resolve('Organization', 'Atera Networks'), undefined);
  assert.equal(registry.resolve('Software', 'Atera Networks'), 'atera-rmm');
});

test('moveAlias refuses to detach a canonical from its own name', async () => {
  const registry = await seeded([
    { category: 'C', canonical: 'A', doc: 1 },
    { category: 'C', canonical: 'B', doc: 2 },
  ]);
  assert.equal(
    registry.moveAlias({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'B' }, 'A', { docId: 1 }),
    false
  );
  assert.deepEqual(surfaces(registry, 'C', 'A'), ['A'], 'unchanged');
});

test('moveAlias refuses unknown endpoints and unknown aliases', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', aliases: ['x'], doc: 1 }]);
  assert.equal(
    registry.moveAlias({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'ghost' }, 'x', {
      docId: 1,
    }),
    false
  );
  assert.equal(
    registry.moveAlias({ category: 'C', canonical: 'ghost' }, { category: 'C', canonical: 'A' }, 'x', {
      docId: 1,
    }),
    false
  );
  assert.equal(
    registry.moveAlias({ category: 'C', canonical: 'A' }, { category: 'C', canonical: 'A' }, 'not-there', {
      docId: 1,
    }),
    false,
    'unknown alias surface'
  );
});

// --- renameInto (T3) --------------------------------------------------------------------------------

test('renameInto absorbs from into to and records a literal renamed-to edge', async () => {
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'Sandworm', aliases: ['Voodoo Bear'], doc: 1 },
    { category: 'HackerGroup', canonical: 'APT44', doc: 2 },
  ]);

  const ok = registry.renameInto('HackerGroup', {
    from: 'Sandworm',
    to: 'APT44',
    docId: 10,
    evidence: 'CERT rename bulletin',
    validFrom: '2024-01-01',
  });

  assert.equal(ok, true);
  assert.deepEqual(Object.keys(registry.records('HackerGroup')).sort(), ['APT44']);
  assert.deepEqual(surfaces(registry, 'HackerGroup', 'APT44'), ['APT44', 'Sandworm', 'Voodoo Bear']);
  assert.equal(registry.resolve('HackerGroup', 'Sandworm'), 'APT44');

  const edges = registry.renameEdges('HackerGroup');
  assert.equal(edges.length, 1);
  assert.deepEqual(
    { from: edges[0].from, to: edges[0].to, decision: edges[0].decision },
    { from: 'Sandworm', to: 'APT44', decision: 'repairer' },
    'literal historical endpoints, repairer provenance'
  );
});

test('renameInto keeps the rename edge intact through a later unrelated merge', async () => {
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'Sandworm', doc: 1 },
    { category: 'HackerGroup', canonical: 'APT44', doc: 2 },
    { category: 'HackerGroup', canonical: 'X', doc: 3 },
    { category: 'HackerGroup', canonical: 'Y', doc: 4 },
  ]);
  registry.renameInto('HackerGroup', { from: 'Sandworm', to: 'APT44', docId: 5 });

  // Unrelated merge elsewhere in the same category — must not touch the rename edge at all, not
  // even to rewrite it or drop a self-loop it never had. #rewriteAfterMerge is shared by both
  // callers, so this pins the change at the shared method, not just renameInto's own call.
  registry.applyMerges('HackerGroup', [{ from: 'Y', into: 'X' }]);

  const edges = registry.renameEdges('HackerGroup');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, 'Sandworm');
  assert.equal(edges[0].to, 'APT44');
});

test('renameInto edge stays literal even when a later applyMerges folds away its own "to" endpoint', async () => {
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'Sandworm', doc: 1 },
    { category: 'HackerGroup', canonical: 'APT44', doc: 2 },
    { category: 'HackerGroup', canonical: 'APT44-Alt', doc: 3 },
  ]);
  registry.renameInto('HackerGroup', { from: 'Sandworm', to: 'APT44', docId: 5 });
  registry.applyMerges('HackerGroup', [{ from: 'APT44-Alt', into: 'APT44' }]);

  const edges = registry.renameEdges('HackerGroup');
  assert.equal(edges.length, 1);
  assert.deepEqual(
    { from: edges[0].from, to: edges[0].to },
    { from: 'Sandworm', to: 'APT44' },
    'endpoints stay literal even though APT44 just absorbed another canonical'
  );
});

test('renameInto refuses unknown or identical endpoints', async () => {
  const registry = await seeded([{ category: 'C', canonical: 'A', doc: 1 }]);
  assert.equal(registry.renameInto('C', { from: 'A', to: 'A', docId: 1 }), false);
  assert.equal(registry.renameInto('C', { from: 'A', to: 'ghost', docId: 1 }), false);
  assert.equal(registry.renameInto('C', { from: 'ghost', to: 'A', docId: 1 }), false);
});
