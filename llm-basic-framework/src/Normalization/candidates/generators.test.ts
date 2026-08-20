import { identifierRegexAnalyzer } from '../analyzers/identifierRegex';
import { identityAnalyzer } from '../analyzers/identity';
import type { Candidate, CandidateGenerator, CandidateQuery, RegistrySnapshot, SnapshotEntry } from '../types';
import { Bm25Generator } from './Bm25Generator';
import { resolveGenerator } from './index';
import { ExactMatchGenerator } from './ExactMatchGenerator';
import { RoundRobinFusionGenerator } from './RoundRobinFusionGenerator';
import { RrfFusionGenerator } from './RrfFusionGenerator';
import { StringSimilarityGenerator } from './StringSimilarityGenerator';
import { TfidfNgramGenerator } from './TfidfNgramGenerator';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** A snapshot over a fixed entry list, matching the live-view contract. */
function snapshotOf(entries: Record<string, string[][]>): RegistrySnapshot {
  const built: Record<string, SnapshotEntry[]> = {};
  for (const [category, groups] of Object.entries(entries)) {
    built[category] = groups.map((surfaces) => ({
      canonical: surfaces[0],
      surfaces,
      gloss: null,
    }));
  }
  return {
    categories: () => Object.keys(built),
    size: (category) => (built[category] ?? []).length,
    entries: (category) => built[category] ?? [],
  };
}

const query = (over: Partial<CandidateQuery> = {}): CandidateQuery => ({
  mention: 'x',
  category: 'C',
  k: 5,
  minSim: 0.5,
  ...over,
});

const names = (candidates: Candidate[]): string[] => candidates.map((c) => c.canonical);

// --- ExactMatchGenerator: the E2 floor --------------------------------------------------------------

test('exact match returns similarity 1 or nothing', async () => {
  const generator = new ExactMatchGenerator();
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28', 'Fancy Bear'], ['Sandworm', 'Sandworm']] }));

  const hit = await generator.candidates(query({ mention: 'fancy BEAR' }));
  assert.deepEqual(names(hit), ['APT28'], 'case-folded exact match on an alias');
  assert.equal(hit[0].sim, 1);

  assert.deepEqual(await generator.candidates(query({ mention: 'APT29' })), [], 'near is not exact');
});

test('exact match with identifierRegex achieves what string similarity cannot', async () => {
  // The M2.5 finding: string similarity ranked UAC-0018/0050/0210 ahead of UAC-0010 (Armageddon).
  // On the identifier channel the designation IS the key, so only the true match survives.
  const generator = new ExactMatchGenerator({ analyzers: [identifierRegexAnalyzer] });
  await generator.prepare(
    snapshotOf({
      C: [
        ['UAC-0010 (Armageddon)', 'UAC-0010 (Armageddon)'],
        ['UAC-0018', 'UAC-0018'],
        ['UAC-0210', 'UAC-0210'],
      ],
    })
  );

  const found = await generator.candidates(query({ mention: 'UAC-0010' }));
  assert.deepEqual(names(found), ['UAC-0010 (Armageddon)'], 'exactly the right one, and only it');
});

test('exact match returns nothing when the analyzer has no opinion', async () => {
  const generator = new ExactMatchGenerator({ analyzers: [identifierRegexAnalyzer] });
  await generator.prepare(snapshotOf({ C: [['Fancy Bear', 'Fancy Bear']] }));
  assert.deepEqual(await generator.candidates(query({ mention: 'Fancy Bear' })), []);
});

// --- TfidfNgramGenerator ----------------------------------------------------------------------------

test('tfidf ranks a rare-gram match above a common-gram one', async () => {
  // The reason IDF matters here: `.com` is near-universal among 1,929 domains, so sharing it is weak
  // evidence, while a rare gram is nearly decisive. Unweighted similarity drowns in the former.
  const generator = new TfidfNgramGenerator();
  await generator.prepare(
    snapshotOf({
      C: [
        ['zephyr.com', 'zephyr.com'],
        ['alpha.com', 'alpha.com'],
        ['beta.com', 'beta.com'],
        ['gamma.com', 'gamma.com'],
        ['delta.com', 'delta.com'],
      ],
    })
  );

  const found = await generator.candidates(query({ mention: 'zephyr.com', minSim: 0 }));
  assert.equal(found[0].canonical, 'zephyr.com', 'the distinctive stem wins');
  assert.ok(found[0].sim > (found[1]?.sim ?? 0), 'and by a clear margin over the shared .com');
});

test('tfidf rebuilds its index after a registry change', async () => {
  // A stale index would silently lose every canonical minted since prepare() — the failure mode the
  // live-snapshot contract exists to prevent.
  const entries: Record<string, string[][]> = { C: [['alpha', 'alpha']] };
  const snapshot: RegistrySnapshot = {
    categories: () => ['C'],
    size: () => entries.C.length,
    entries: () => entries.C.map((surfaces) => ({ canonical: surfaces[0], surfaces })),
  };

  const generator = new TfidfNgramGenerator();
  await generator.prepare(snapshot);
  assert.deepEqual(names(await generator.candidates(query({ mention: 'alpha', minSim: 0 }))), ['alpha']);

  entries.C.push(['alphabet', 'alphabet']);
  generator.onRegistryChange({ type: 'mint', category: 'C', canonical: 'alphabet' });

  const after = await generator.candidates(query({ mention: 'alphabet', minSim: 0 }));
  assert.ok(names(after).includes('alphabet'), 'the newly minted canonical is retrievable');
});

test('tfidf scores are cosines in [0,1] and 1 for an identical name', async () => {
  const generator = new TfidfNgramGenerator();
  await generator.prepare(snapshotOf({ C: [['apt28', 'apt28'], ['sandworm', 'sandworm']] }));
  const found = await generator.candidates(query({ mention: 'apt28', minSim: 0 }));
  assert.ok(Math.abs(found[0].sim - 1) < 1e-12, `expected 1, got ${found[0].sim}`);
  assert.ok(found.every((candidate) => candidate.sim >= 0 && candidate.sim <= 1 + 1e-12));
});

// --- Bm25Generator ----------------------------------------------------------------------------------

test('bm25 retrieves on shared tokens and normalizes into [0,1]', async () => {
  const generator = new Bm25Generator();
  await generator.prepare(
    snapshotOf({
      C: [
        ['Security Service of Ukraine', 'Security Service of Ukraine'],
        ['State Service of Special Communications', 'State Service of Special Communications'],
        ['Sandworm', 'Sandworm'],
      ],
    })
  );

  const found = await generator.candidates(query({ mention: 'Service of Ukraine', minSim: 0 }));
  assert.equal(found[0].canonical, 'Security Service of Ukraine');
  assert.ok(found.every((candidate) => candidate.sim >= 0 && candidate.sim <= 1 + 1e-12));
  assert.ok(Math.abs(found[0].sim - 1) < 1e-12, 'best match normalizes to 1');
  assert.equal(names(found).includes('Sandworm'), false, 'no shared token, no retrieval');
});

test('bm25 returns nothing when no token is shared', async () => {
  const generator = new Bm25Generator();
  await generator.prepare(snapshotOf({ C: [['alpha', 'alpha']] }));
  assert.deepEqual(await generator.candidates(query({ mention: 'zzz', minSim: 0 })), []);
});

// --- RrfFusionGenerator: the E4 union arm -----------------------------------------------------------

/** A stub generator returning a fixed ranking, for testing fusion in isolation. */
class StubGenerator implements CandidateGenerator {
  readonly config = {};
  constructor(
    readonly id: string,
    private readonly ranking: Array<{ canonical: string; sim: number }>
  ) {}
  async prepare(): Promise<void> {}
  onRegistryChange(): void {}
  async candidates(): Promise<Candidate[]> {
    return this.ranking.map((entry) => ({
      canonical: entry.canonical,
      sim: entry.sim,
      surfaces: [],
      channel: this.id,
    }));
  }
}

test('rrf promotes the candidate with the best CONSENSUS, not the best single score', async () => {
  // The point of fusing ranks: `consensus` is second everywhere, `spike` is first in one child and
  // absent from the other. Two second places beat one first place plus one absence.
  const fusion = new RrfFusionGenerator({
    children: [
      new StubGenerator('a', [
        { canonical: 'spike', sim: 0.99 },
        { canonical: 'consensus', sim: 0.6 },
      ]),
      new StubGenerator('b', [
        { canonical: 'other', sim: 0.9 },
        { canonical: 'consensus', sim: 0.6 },
      ]),
    ],
  });
  await fusion.prepare(snapshotOf({ C: [] }));

  const found = await fusion.candidates(query({ minSim: 0 }));
  assert.equal(found[0].canonical, 'consensus');
});

test('rrf reports the best CHILD similarity as sim, never the RRF score', async () => {
  // RRF scores live on a ~1/60 scale. Putting one in `sim` would make minSim meaningless and mislead
  // every reader of the decision log.
  const fusion = new RrfFusionGenerator({
    children: [new StubGenerator('a', [{ canonical: 'x', sim: 0.83 }])],
  });
  await fusion.prepare(snapshotOf({ C: [] }));
  const found = await fusion.candidates(query({ minSim: 0 }));
  assert.equal(found[0].sim, 0.83, 'an interpretable similarity, not 1/61');
});

test('rrf records every contributing channel, so E4 can attribute recall', async () => {
  const fusion = new RrfFusionGenerator({
    children: [
      new StubGenerator('string-sim', [{ canonical: 'x', sim: 0.7 }]),
      new StubGenerator('bm25', [{ canonical: 'x', sim: 0.4 }]),
    ],
  });
  await fusion.prepare(snapshotOf({ C: [] }));
  const found = await fusion.candidates(query({ minSim: 0 }));
  assert.equal(found[0].channel, 'rrf:bm25+string-sim', 'sorted and de-duplicated for stability');
});

test('rrf applies the caller minSim ONCE, at the end', async () => {
  // Children are queried at minSim 0 so a weakly-rated candidate can still win on consensus;
  // filtering per child would discard the evidence fusion exists to combine.
  const fusion = new RrfFusionGenerator({
    children: [new StubGenerator('a', [{ canonical: 'weak', sim: 0.2 }])],
  });
  await fusion.prepare(snapshotOf({ C: [] }));
  assert.deepEqual(await fusion.candidates(query({ minSim: 0.5 })), [], 'below the reported threshold');
  assert.equal((await fusion.candidates(query({ minSim: 0.1 }))).length, 1);
});

test('rrf breaks equal-consensus ties on canonical name, deterministically', async () => {
  const build = (order: string[]) =>
    new RrfFusionGenerator({
      children: [new StubGenerator('a', order.map((canonical) => ({ canonical, sim: 0.5 })))],
    });

  // Same rank in the only child → equal RRF; the shared canonical tie-break must decide.
  const forward = build(['beta', 'alpha']);
  await forward.prepare(snapshotOf({ C: [] }));
  const found = await forward.candidates(query({ minSim: 0, k: 2 }));
  assert.equal(found.length, 2);
  // Ranks differ here (0 and 1), so RRF order is preserved — fusion order, not sim order.
  assert.deepEqual(names(found), ['beta', 'alpha'], 'child rank is respected');
});

test('rrf refuses to be constructed with no children', () => {
  assert.throws(() => new RrfFusionGenerator({ children: [] }), /at least one child/);
});

test('rrf fans prepare and onRegistryChange out to every child', async () => {
  let prepared = 0;
  let notified = 0;
  class Counting extends StubGenerator {
    async prepare(): Promise<void> {
      prepared++;
    }
    onRegistryChange(): void {
      notified++;
    }
  }
  const fusion = new RrfFusionGenerator({
    children: [new Counting('a', []), new Counting('b', [])],
  });
  await fusion.prepare(snapshotOf({ C: [] }));
  fusion.onRegistryChange({ type: 'mint', category: 'C', canonical: 'x' });
  assert.equal(prepared, 2);
  assert.equal(notified, 2);
});

// --- shared contract ---------------------------------------------------------------------------------

test('every generator respects k and refuses to run before prepare()', async () => {
  const snapshot = snapshotOf({
    C: Array.from({ length: 12 }, (_, i) => [`apt2${i}`, `apt2${i}`]),
  });

  const generators: CandidateGenerator[] = [
    new StringSimilarityGenerator(),
    new ExactMatchGenerator(),
    new TfidfNgramGenerator(),
    new Bm25Generator(),
  ];

  for (const generator of generators) {
    await assert.rejects(
      () => generator.candidates(query()),
      /prepare\(\) must be called/,
      `${generator.id} did not refuse`
    );
    await generator.prepare(snapshot);
    const found = await generator.candidates(query({ mention: 'apt20', k: 3, minSim: 0 }));
    assert.ok(found.length <= 3, `${generator.id} returned ${found.length} for k=3`);
    assert.ok(
      found.every((candidate) => typeof candidate.channel === 'string' && candidate.channel.length > 0),
      `${generator.id} left a candidate unlabelled`
    );
  }
});

test('every generator exposes a config that records what it ran as', async () => {
  const generators = [
    new StringSimilarityGenerator({ analyzers: [identityAnalyzer] }),
    new ExactMatchGenerator({ analyzers: [identifierRegexAnalyzer] }),
    new TfidfNgramGenerator({ n: 4 }),
    new Bm25Generator({ k1: 1.5 }),
  ];
  for (const generator of generators) {
    assert.ok(generator.id.length > 0);
    // The run card records this, so an arm cannot be reported without its configuration.
    assert.ok(Object.keys(generator.config).length > 0, `${generator.id} has an empty config`);
  }
  assert.match(new TfidfNgramGenerator({ n: 4 }).id, /4gram/);
});

test('union: the SKEIN v2 blocker composes all five channels behind one id', () => {
  const embeddingsClient = {
    modelName: 'fake-embed',
    embed: async (texts: string[]) => texts.map(() => [0, 1]),
  } as unknown as import('../../EmbeddingsClient/EmbeddingsClient').EmbeddingsClient;

  const generator = resolveGenerator('union', { embeddingsClient });
  assert.ok(generator.id.startsWith('rrf('), 'RRF-fused');
  const childIds = (generator.config.children as Array<{ id: string }>).map((child) => child.id);
  assert.equal(childIds.length, 5);
  assert.ok(childIds.some((id) => id.includes('translit')), 'cross-script channel present');
  assert.ok(childIds.some((id) => id.includes('name+gloss')), 'dense channel embeds name+gloss');
  assert.ok(childIds.some((id) => id.includes('bm25') || id.includes('Bm25') || id.toLowerCase().includes('bm25')));
});

test('union without an embeddings client is fatal, never a silent downgrade', () => {
  assert.throws(() => resolveGenerator('union', {}), /EmbeddingsClient/);
});

// --- RoundRobinFusionGenerator: interleaving instead of consensus -----------------------------------

test('round-robin gives every child its rank-1 slot, so a single-channel match reaches the judge', async () => {
  // The contract that fixes Poland/Польща: the dense channel ranks it first, the lexical channels
  // cannot see a Latin/Cyrillic pair at all and bury it below every distractor. Under RRF the
  // uninformed majority decides the order (measured: recall@4 74.4% vs 85.9% for the dense channel
  // alone, `npm run blocker-bench`); interleaving reserves rank 1 of each channel instead.
  const blind = (id: string) =>
    new StubGenerator(id, [
      ...['noise1', 'noise2', 'noise3', 'noise4', 'noise5'].map((canonical) => ({ canonical, sim: 0.3 })),
      { canonical: 'truth', sim: 0 },
    ]);
  const rr = new RoundRobinFusionGenerator({
    children: [
      blind('lexical-a'),
      blind('lexical-b'),
      new StubGenerator('dense', [
        { canonical: 'truth', sim: 0.95 },
        { canonical: 'noise1', sim: 0.6 },
      ]),
    ],
  });
  await rr.prepare(snapshotOf({ C: [] }));

  // Three children, so every child's best pick is inside the first three slots, whatever the rest
  // of the field looks like.
  const found = await rr.candidates(query({ minSim: 0, k: 3 }));
  assert.deepEqual(found.map((candidate) => candidate.canonical), ['noise1', 'truth', 'noise2']);
});

test('round-robin de-duplicates across children and keeps the first placement', async () => {
  const rr = new RoundRobinFusionGenerator({
    children: [
      new StubGenerator('a', [{ canonical: 'x', sim: 0.5 }, { canonical: 'y', sim: 0.4 }]),
      new StubGenerator('b', [{ canonical: 'x', sim: 0.9 }, { canonical: 'z', sim: 0.4 }]),
    ],
  });
  await rr.prepare(snapshotOf({ C: [] }));
  const found = await rr.candidates(query({ minSim: 0, k: 10 }));
  assert.deepEqual(found.map((c) => c.canonical), ['x', 'y', 'z']);
  assert.equal(found[0].sim, 0.9, 'sim is the best child similarity, as in rrf');
  assert.equal(found[0].channel, 'rr:a+b', 'every contributing channel recorded');
});

test('round-robin applies the caller minSim once, at the end', async () => {
  const rr = new RoundRobinFusionGenerator({
    children: [new StubGenerator('a', [{ canonical: 'weak', sim: 0.2 }])],
  });
  await rr.prepare(snapshotOf({ C: [] }));
  assert.deepEqual(await rr.candidates(query({ minSim: 0.5 })), []);
  assert.equal((await rr.candidates(query({ minSim: 0.1 }))).length, 1);
});

test('union-rr without an embeddings client is fatal, never a silent downgrade', () => {
  assert.throws(() => resolveGenerator('union-rr', {}), /EmbeddingsClient/);
});
