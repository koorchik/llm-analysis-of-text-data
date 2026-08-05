import {
  assertVectorCount,
  type EmbeddingsBackendBase,
  type EmbeddingsResponse,
} from '../EmbeddingsClient/EmbeddingsBackendBase';
import { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { GlossIndex } from './GlossIndex';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Deterministic stand-in encoder, copied from `EmbeddingGenerator.test.ts`'s `StubEncoder`: each
 * text maps to a point on the unit circle, either from an explicit `angles` entry or derived from
 * its characters, so "similar strings embed similarly" holds without a real model.
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

const clientFor = (backend: EmbeddingsBackendBase) => new EmbeddingsClient({ backend });

async function tmpPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gloss-index-'));
  return path.join(dir, 'registry.json');
}

/** A loaded registry seeded via mint/link, matching `EntityRegistry.test.ts`'s `seeded()` pattern. */
async function seeded(
  entries: Array<{
    category: string;
    canonical: string;
    aliases?: string[];
    gloss?: string | null;
    doc?: number;
  }>
): Promise<EntityRegistry> {
  const registry = new EntityRegistry({ filePath: await tmpPath() });
  await registry.load();
  for (const entry of entries) {
    registry.mint(
      entry.category,
      entry.canonical,
      { doc: entry.doc ?? 1, date: '01.01.2020' },
      { gloss: entry.gloss ?? null }
    );
    for (const alias of entry.aliases ?? []) {
      registry.link(entry.category, entry.canonical, alias, { docId: entry.doc ?? 1 });
    }
  }
  return registry;
}

test('sync() embeds each entity once; a second sync with no registry changes embeds nothing new', async () => {
  const backend = new StubEncoder();
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'APT28' },
    { category: 'Country', canonical: 'Russia' },
  ]);

  await index.sync(registry);
  const callsAfterFirst = backend.batches.length;
  assert.ok(callsAfterFirst > 0, 'first sync must embed the seeded entities');

  await index.sync(registry);
  assert.equal(backend.batches.length, callsAfterFirst, 'idempotent sync must not re-embed');
});

test('sync() drops entities that were removed from the registry (e.g. merged away)', async () => {
  const backend = new StubEncoder();
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'APT28' },
    { category: 'HackerGroup', canonical: 'Sandworm' },
  ]);
  await index.sync(registry);

  // Simulate removal the way `applyMerges` would: fold Sandworm into APT28, so only APT28 survives.
  registry.applyMerges('HackerGroup', [{ from: 'Sandworm', into: 'APT28' }]);
  await index.sync(registry);

  await assert.rejects(
    () => index.nearest({ category: 'HackerGroup', canonical: 'Sandworm' }, 5),
    /unknown entity|sync/i
  );
});

test('text format is byte-identical to EmbeddingGenerator name+gloss: bare name when gloss is null, "name: gloss" otherwise', async () => {
  const backend = new StubEncoder();
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([
    { category: 'HackerGroup', canonical: 'APT28', gloss: 'Russian state-sponsored threat actor' },
    { category: 'Country', canonical: 'Russia', gloss: null },
  ]);

  await index.sync(registry);

  const embedded = backend.batches.flat();
  assert.ok(
    embedded.includes('APT28: Russian state-sponsored threat actor'),
    `expected the name+gloss text among ${JSON.stringify(embedded)}`
  );
  assert.ok(embedded.includes('Russia'), `expected the bare name among ${JSON.stringify(embedded)}`);
  assert.ok(!embedded.includes('Russia: null'), 'a null gloss must never be stringified into the text');
});

test('nearest() crosses categories and excludes self', async () => {
  const angles = { Foo: 0, Bar: 0.1, Baz: 3.0 };
  const backend = new StubEncoder(angles);
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([
    { category: 'A', canonical: 'Foo' },
    { category: 'B', canonical: 'Bar' },
    { category: 'C', canonical: 'Baz' },
  ]);
  await index.sync(registry);

  const found = await index.nearest({ category: 'A', canonical: 'Foo' }, 2);

  assert.equal(found.length, 2);
  assert.ok(
    !found.some((entry) => entry.ref.category === 'A' && entry.ref.canonical === 'Foo'),
    'self must be excluded'
  );
  // Bar (angle 0.1, near) must rank ahead of Baz (angle 3.0, far), and both are foreign categories —
  // proof the ranking is cross-category, not scoped to Foo's own category.
  assert.deepEqual(
    found.map((entry) => `${entry.ref.category}/${entry.ref.canonical}`),
    ['B/Bar', 'C/Baz']
  );
  assert.ok(found[0].sim > found[1].sim);
});

test('nearest() throws for an entity not yet synced', async () => {
  const index = new GlossIndex({ embeddingsClient: clientFor(new StubEncoder()) });
  await assert.rejects(
    () => index.nearest({ category: 'A', canonical: 'Ghost' }, 5),
    /unknown entity|sync/i
  );
});

test('aliasCoherence() scores a near alias high and a drifted alias low against the entity centroid', async () => {
  // Foo's only surface is its own name, so its centroid sits exactly at angle 0.
  const angles = { Foo: 0, 'Near Alias': 0.05, 'Drifted Alias': Math.PI };
  const backend = new StubEncoder(angles);
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([{ category: 'A', canonical: 'Foo' }]);
  await index.sync(registry);

  const near = await index.aliasCoherence({ category: 'A', canonical: 'Foo' }, 'Near Alias');
  const drifted = await index.aliasCoherence({ category: 'A', canonical: 'Foo' }, 'Drifted Alias');

  assert.ok(near > 0.99, `expected a near alias to score ~1, got ${near}`);
  assert.ok(drifted < 0.01, `expected an opposed alias to score ~0, got ${drifted}`);
  assert.ok(near > drifted);
});

test('aliasCoherence() applies the entity gloss to the alias text, same as the centroid vectors', async () => {
  const backend = new StubEncoder();
  const index = new GlossIndex({ embeddingsClient: clientFor(backend) });
  const registry = await seeded([
    { category: 'A', canonical: 'Foo', gloss: 'a thing' },
  ]);
  await index.sync(registry);
  backend.batches = []; // isolate the aliasCoherence call

  await index.aliasCoherence({ category: 'A', canonical: 'Foo' }, 'Bar');

  assert.deepEqual(backend.batches.flat(), ['Bar: a thing']);
});
