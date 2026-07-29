import { CostMeter, type PriceTable } from '../Experiment/CostMeter';
import { EmbeddingCache } from './EmbeddingCache';
import {
  assertVectorCount,
  type EmbeddingCallOptions,
  type EmbeddingsBackendBase,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';
import { EmbeddingsClient } from './EmbeddingsClient';
import { mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PRICES: PriceTable = {
  models: { 'fake-embed': { inputPerMTok: 2, outputPerMTok: 0 } },
  providerDefaults: {},
};

/** Records the batches it was handed — the thing under test is that there is only one. */
class SpyBackend implements EmbeddingsBackendBase {
  model = 'fake-embed';
  readonly provider = 'fake';
  readonly config = { provider: 'fake', model: 'fake-embed' };

  batches: string[][] = [];
  #dimensions: number;

  constructor(dimensions = 4) {
    this.#dimensions = dimensions;
  }

  async embed(inputs: string[], _options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    this.batches.push([...inputs]);
    // A deterministic vector per text, so tests can assert alignment rather than just shape.
    const vectors = inputs.map((text) =>
      Array.from({ length: this.#dimensions }, (_, i) => (text.charCodeAt(i % text.length) % 17) + i)
    );
    assertVectorCount('SpyBackend', inputs, vectors);
    return {
      vectors,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      model: this.model,
      latencyMs: 7,
      dimensions: this.#dimensions,
    };
  }
}

const withTempDir = (body: (dir: string) => void | Promise<void>) => async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'embed-cache-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a batch of N texts is ONE provider request, not N — the pre-M5 loop is gone', async () => {
  const backend = new SpyBackend();
  const client = new EmbeddingsClient({ backend });

  const vectors = await client.embed(['alpha', 'beta', 'gamma']);

  assert.equal(backend.batches.length, 1);
  assert.deepEqual(backend.batches[0], ['alpha', 'beta', 'gamma']);
  assert.equal(vectors.length, 3);
});

test('a single string returns a single vector, not a nested array', async () => {
  const client = new EmbeddingsClient({ backend: new SpyBackend() });
  const vector = await client.embed('alpha');
  assert.ok(Array.isArray(vector));
  assert.equal(typeof vector[0], 'number');
});

test('duplicate texts are embedded ONCE but returned at every position', async () => {
  const backend = new SpyBackend();
  const client = new EmbeddingsClient({ backend });

  const vectors = await client.embed(['apt28', 'sandworm', 'apt28']);

  assert.deepEqual(backend.batches[0], ['apt28', 'sandworm']);
  assert.deepEqual(vectors[0], vectors[2]);
  assert.notDeepEqual(vectors[0], vectors[1]);
});

test('batchSize splits the request and keeps input order across chunks', async () => {
  const backend = new SpyBackend();
  const client = new EmbeddingsClient({ backend, batchSize: 2 });

  const vectors = await client.embed(['a', 'b', 'c', 'd', 'e']);

  assert.deepEqual(backend.batches, [['a', 'b'], ['c', 'd'], ['e']]);
  const direct = await new EmbeddingsClient({ backend: new SpyBackend() }).embed(['c']);
  assert.deepEqual(vectors[2], direct[0]);
});

test('the cost meter records under operator `embed` with ZERO output tokens', async () => {
  const costMeter = new CostMeter({ runId: 'test-run', priceTable: PRICES });
  const client = new EmbeddingsClient({ backend: new SpyBackend(), costMeter });

  await client.embed(['alpha']);

  const [record] = costMeter.records;
  assert.equal(record.operator, 'embed');
  assert.equal(record.outputTokens, 0);
  assert.equal(record.costUsd, 2); // 1M input @ $2, and no output leg at all
  assert.equal(costMeter.totals().unpricedCalls, 0);
});

test('an embeddings model priced only on input is UNPRICED — outputPerMTok must be 0, not null', () => {
  // The trap this guards: CostMeter.priceFor requires BOTH legs non-null, so the natural-looking
  // `{ inputPerMTok: 0.13, outputPerMTok: null }` row silently reports every embedding call as
  // unpriced rather than as priced on input alone.
  const meter = new CostMeter({
    runId: 'test-run',
    priceTable: { models: { half: { inputPerMTok: 1, outputPerMTok: null } }, providerDefaults: {} },
  });
  const record = meter.record({
    operator: 'embed',
    provider: 'fake',
    model: 'half',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    latencyMs: 1,
  });
  assert.equal(record.costUsd, null);
  assert.deepEqual(meter.unpricedModels, ['fake/half']);
});

test('a failed call propagates and is NOT metered as a success', async () => {
  class FailingBackend extends SpyBackend {
    async embed(): Promise<EmbeddingsResponse> {
      throw new Error('boom');
    }
  }
  const costMeter = new CostMeter({ runId: 'test-run', priceTable: PRICES });
  const client = new EmbeddingsClient({ backend: new FailingBackend(), costMeter });

  await assert.rejects(() => client.embed(['alpha']), /boom/);
  assert.equal(costMeter.records.length, 0);
});

test('a mid-run dimension change throws rather than poisoning the index', async () => {
  class DriftingBackend extends SpyBackend {
    #calls = 0;
    async embed(inputs: string[]): Promise<EmbeddingsResponse> {
      this.#calls += 1;
      const width = this.#calls === 1 ? 4 : 8;
      return {
        vectors: inputs.map(() => new Array(width).fill(0.5)),
        usage: { inputTokens: 1, outputTokens: 0 },
        model: this.model,
        latencyMs: 1,
        dimensions: width,
      };
    }
  }
  const client = new EmbeddingsClient({ backend: new DriftingBackend() });

  await client.embed(['first']);
  await assert.rejects(() => client.embed(['second']), /the encoder changed mid-run/);
});

test(
  'a cache hit issues NO provider call and survives a new client over the same directory',
  withTempDir(async (dir) => {
    const first = new SpyBackend();
    const cacheArgs = { dir, provider: 'fake', model: 'fake-embed' };
    const warm = new EmbeddingsClient({ backend: first, cache: new EmbeddingCache(cacheArgs) });
    const original = await warm.embed(['apt28', 'sandworm']);
    assert.equal(first.batches.length, 1);

    const second = new SpyBackend();
    const cold = new EmbeddingsClient({ backend: second, cache: new EmbeddingCache(cacheArgs) });
    const replayed = await cold.embed(['apt28', 'sandworm']);

    assert.equal(second.batches.length, 0, 'a fully cached batch must not reach the provider');
    assert.deepEqual(replayed, original);
    assert.deepEqual(cold.cacheStats, { hits: 2, misses: 0, entries: 2 });
  })
);

test(
  'a partially cached batch embeds only the misses',
  withTempDir(async (dir) => {
    const cacheArgs = { dir, provider: 'fake', model: 'fake-embed' };
    const warm = new EmbeddingsClient({ backend: new SpyBackend(), cache: new EmbeddingCache(cacheArgs) });
    await warm.embed(['apt28']);

    const backend = new SpyBackend();
    const client = new EmbeddingsClient({ backend, cache: new EmbeddingCache(cacheArgs) });
    await client.embed(['apt28', 'sandworm']);

    assert.deepEqual(backend.batches, [['sandworm']]);
    assert.deepEqual(client.cacheStats, { hits: 1, misses: 1, entries: 2 });
  })
);

test(
  'the cache is keyed by model, so two encoders do not share vectors',
  withTempDir(async (dir) => {
    const client = new EmbeddingsClient({
      backend: new SpyBackend(),
      cache: new EmbeddingCache({ dir, provider: 'fake', model: 'fake-embed' }),
    });
    await client.embed(['apt28']);

    const other = new SpyBackend();
    const otherClient = new EmbeddingsClient({
      backend: other,
      cache: new EmbeddingCache({ dir, provider: 'fake', model: 'other-embed' }),
    });
    await otherClient.embed(['apt28']);

    assert.deepEqual(other.batches, [['apt28']], 'a different model must miss');
  })
);
