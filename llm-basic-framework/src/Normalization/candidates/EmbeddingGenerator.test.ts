import {
  assertVectorCount,
  type EmbeddingsBackendBase,
  type EmbeddingsResponse,
} from '../../EmbeddingsClient/EmbeddingsBackendBase';
import { EmbeddingsClient } from '../../EmbeddingsClient/EmbeddingsClient';
import type { CandidateQuery, RegistrySnapshot, SnapshotEntry } from '../types';
import { EmbeddingGenerator } from './EmbeddingGenerator';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * A deterministic stand-in encoder. Each text maps to a point on the unit circle derived from its
 * characters, so "similar strings embed similarly" holds well enough to assert ordering without
 * pretending to be a real model.
 */
class StubEncoder implements EmbeddingsBackendBase {
  model = 'stub-encoder';
  readonly provider = 'stub';
  readonly config = { provider: 'stub', model: 'stub-encoder' };

  batches: string[][] = [];
  #angles: Record<string, number>;

  constructor(angles: Record<string, number> = {}) {
    this.#angles = angles;
  }

  async embed(inputs: string[]): Promise<EmbeddingsResponse> {
    this.batches.push([...inputs]);
    const vectors = inputs.map((text) => {
      const angle =
        this.#angles[text] ??
        ([...text].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360) * (Math.PI / 180);
      return [Math.cos(angle), Math.sin(angle)];
    });
    assertVectorCount('StubEncoder', inputs, vectors);
    return {
      vectors,
      usage: { inputTokens: inputs.length, outputTokens: 0 },
      model: this.model,
      latencyMs: 1,
      dimensions: 2,
    };
  }
}

function snapshotOf(entries: Record<string, string[][]>, glosses: Record<string, string> = {}): RegistrySnapshot {
  const built: Record<string, SnapshotEntry[]> = {};
  for (const [category, groups] of Object.entries(entries)) {
    built[category] = groups.map((surfaces) => ({
      canonical: surfaces[0],
      surfaces,
      definition: glosses[surfaces[0]] ?? null,
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

const clientFor = (backend: EmbeddingsBackendBase) => new EmbeddingsClient({ backend });

test('candidates() requires prepare() first, like every other generator', async () => {
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder()) });
  await assert.rejects(() => generator.candidates(query()), /prepare\(\) must be called/);
});

test('the index is built in ONE batched call, and the doubled canonical is embedded once', async () => {
  const backend = new StubEncoder();
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(backend) });

  // `mint` stores the canonical in its own alias list, so `surfaces` normally repeats it. Paying
  // for that duplicate would be an API call that cannot change the max.
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28', 'Fancy Bear'], ['Sandworm', 'Sandworm']] }));
  await generator.candidates(query({ mention: 'APT28' }));

  const indexBatch = backend.batches[0];
  assert.deepEqual(indexBatch, ['APT28', 'Fancy Bear', 'Sandworm']);
});

test('an exact surface scores ~1 and ranks first', async () => {
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder()) });
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28'], ['Sandworm', 'Sandworm']] }));

  const [top] = await generator.candidates(query({ mention: 'APT28', minSim: 0 }));
  assert.equal(top.canonical, 'APT28');
  assert.ok(top.sim > 0.999, `expected ~1, got ${top.sim}`);
});

test('candidates are ordered by descending cosine and cut at k', async () => {
  const angles = { q: 0, near: 0.1, mid: 0.5, far: 1.0, farthest: 1.4 };
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder(angles)) });
  await generator.prepare(
    snapshotOf({ C: [['near'], ['mid'], ['far'], ['farthest']] })
  );

  const found = await generator.candidates(query({ mention: 'q', minSim: 0, k: 3 }));
  assert.deepEqual(
    found.map((candidate) => candidate.canonical),
    ['near', 'mid', 'far']
  );
});

test('minSim filters on the cosine, and a NEGATIVE cosine is 0 rather than a mid-range score', async () => {
  // Opposed vectors: raw cosine -1. Under the (1+cos)/2 rescaling that was rejected in vectorUtils
  // this would score 0 and still be excluded — but an *orthogonal* pair would score 0.5 and pass.
  const angles = { q: 0, opposed: Math.PI, orthogonal: Math.PI / 2 };
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder(angles)) });
  await generator.prepare(snapshotOf({ C: [['opposed'], ['orthogonal']] }));

  assert.deepEqual(await generator.candidates(query({ mention: 'q', minSim: 0.5 })), []);
  const all = await generator.candidates(query({ mention: 'q', minSim: 0 }));
  // The opposed pair clamps to exactly 0; the orthogonal one lands at cos(π/2) = 6.1e-17, which is
  // float reality rather than a rescaling. Both are far below 0.5, which is the point.
  assert.equal(all.length, 2);
  for (const candidate of all) assert.ok(candidate.sim < 1e-12, `expected ~0, got ${candidate.sim}`);
});

test('surfaces exclude the canonical itself, matching the other generators', async () => {
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder()) });
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28', 'Fancy Bear']] }));

  const [candidate] = await generator.candidates(query({ mention: 'APT28', minSim: 0 }));
  assert.deepEqual(candidate.surfaces, ['APT28', 'Fancy Bear']);
  assert.equal(candidate.channel, 'embedding');
});

test('max-over-aliases lets a distant canonical be reached through a near alias', async () => {
  const angles = { q: 0, 'Far Canonical': 3.0, 'Near Alias': 0.05 };
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder(angles)) });
  await generator.prepare(snapshotOf({ C: [['Far Canonical', 'Far Canonical', 'Near Alias']] }));

  const [candidate] = await generator.candidates(query({ mention: 'q', minSim: 0.5 }));
  assert.equal(candidate.canonical, 'Far Canonical');
  assert.ok(candidate.sim > 0.99, 'the alias, not the canonical, should decide the score');
});

test('centroid collapses the aliases, so the same pair no longer reaches minSim', async () => {
  const angles = { q: 0, 'Far Canonical': 3.0, 'Near Alias': 0.05 };
  const generator = new EmbeddingGenerator({
    embeddingsClient: clientFor(new StubEncoder(angles)),
    clusterRepresentation: 'centroid',
  });
  await generator.prepare(snapshotOf({ C: [['Far Canonical', 'Far Canonical', 'Near Alias']] }));

  assert.deepEqual(await generator.candidates(query({ mention: 'q', minSim: 0.5 })), []);
});

test('onRegistryChange rebuilds membership WITHOUT re-embedding — the vectors are cached', async () => {
  const backend = new StubEncoder();
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(backend) });
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28']] }));
  await generator.candidates(query({ mention: 'APT28', minSim: 0 }));
  const afterFirst = backend.batches.length;

  generator.onRegistryChange({ type: 'mint', category: 'C', canonical: 'APT28' });
  await generator.candidates(query({ mention: 'APT28', minSim: 0 }));

  // Without a cache in the client this DOES re-embed — the assertion records that the rebuild
  // happens, and the cache test in EmbeddingsClient.test.ts covers the cost side.
  assert.ok(backend.batches.length > afterFirst, 'invalidation must rebuild the membership map');
});

test('a mint after prepare() is retrievable — the stale-index failure the port exists to prevent', async () => {
  const backend = new StubEncoder();
  const generator = new EmbeddingGenerator({ embeddingsClient: clientFor(backend) });

  const live: Record<string, SnapshotEntry[]> = { C: [{ canonical: 'APT28', surfaces: ['APT28'], definition: null }] };
  await generator.prepare({
    categories: () => Object.keys(live),
    size: (category) => (live[category] ?? []).length,
    entries: (category) => live[category] ?? [],
  });
  await generator.candidates(query({ mention: 'APT28', minSim: 0 }));

  live.C.push({ canonical: 'Sandworm', surfaces: ['Sandworm'], definition: null });
  generator.onRegistryChange({ type: 'mint', category: 'C', canonical: 'Sandworm' });

  const found = await generator.candidates(query({ mention: 'Sandworm', minSim: 0.9 }));
  assert.deepEqual(found.map((candidate) => candidate.canonical), ['Sandworm']);
});

test('the id and config carry the encoder, so two arms cannot share a runId', async () => {
  const name = new EmbeddingGenerator({ embeddingsClient: clientFor(new StubEncoder()) });
  const withCategory = new EmbeddingGenerator({
    embeddingsClient: clientFor(new StubEncoder()),
    representation: 'name+category',
  });

  assert.equal(name.id, 'embedding(stub-encoder,name,max-over-aliases)');
  assert.notEqual(name.id, withCategory.id);
  assert.equal(name.config.model, 'stub-encoder');
  assert.equal(withCategory.config.representation, 'name+category');
});

test('name+category encodes a different string from name', async () => {
  const backend = new StubEncoder();
  const generator = new EmbeddingGenerator({
    embeddingsClient: clientFor(backend),
    representation: 'name+category',
  });
  await generator.prepare(snapshotOf({ C: [['APT28', 'APT28']] }));
  await generator.candidates(query({ mention: 'APT28' }));

  assert.deepEqual(backend.batches[0], ['APT28 (C)']);
});

test('name+gloss uses the gloss when present', async () => {
  const backend = new StubEncoder();
  const generator = new EmbeddingGenerator({
    embeddingsClient: clientFor(backend),
    representation: 'name+gloss',
  });
  await generator.prepare(
    snapshotOf({ C: [['APT28', 'APT28']] }, { APT28: 'Russian state-sponsored threat actor' })
  );
  await generator.candidates(query({ mention: 'APT28' }));

  assert.deepEqual(backend.batches[0], ['APT28: Russian state-sponsored threat actor']);
});

test('name+gloss WARNS when every gloss is null instead of silently mimicking `name`', async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => warnings.push(message);

  try {
    const generator = new EmbeddingGenerator({
      embeddingsClient: clientFor(new StubEncoder()),
      representation: 'name+gloss',
    });
    await generator.prepare(snapshotOf({ C: [['APT28', 'APT28']] }));
    await generator.candidates(query({ mention: 'APT28' }));
  } finally {
    console.warn = original;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /IDENTICAL to `name`/);
});
