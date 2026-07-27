import { CostMeter, priceLookupKeys, type PriceTable } from './CostMeter';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PRICES: PriceTable = {
  models: {
    'priced-model': { inputPerMTok: 5, outputPerMTok: 25 },
    'null-priced-model': { inputPerMTok: null, outputPerMTok: null },
  },
  providerDefaults: {
    ollama: { inputPerMTok: 0, outputPerMTok: 0 },
  },
};

// --- dated-snapshot resolution ---------------------------------------------------------------
// Providers resolve an alias to a dated snapshot in the response. Found on a live OpenAI run:
// requesting `gpt-5.4-nano` returned `gpt-5.4-nano-2026-03-17`, so an alias-keyed price table
// matched nothing and every call was silently unpriced.

test('priceLookupKeys strips a -YYYY-MM-DD snapshot suffix', () => {
  assert.deepEqual(priceLookupKeys('gpt-5.4-nano-2026-03-17'), [
    'gpt-5.4-nano-2026-03-17',
    'gpt-5.4-nano',
  ]);
});

test('priceLookupKeys strips a -YYYYMMDD snapshot suffix', () => {
  assert.deepEqual(priceLookupKeys('claude-haiku-4-5-20251001'), [
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
  ]);
});

test('priceLookupKeys leaves an undated id alone', () => {
  assert.deepEqual(priceLookupKeys('claude-opus-4-8'), ['claude-opus-4-8']);
});

test('priceLookupKeys does not mistake a version tail for a date', () => {
  // `-4-8` and `-2026` alone must not be stripped, or the wrong model would be priced.
  assert.deepEqual(priceLookupKeys('claude-opus-4-8'), ['claude-opus-4-8']);
  assert.deepEqual(priceLookupKeys('some-model-2026'), ['some-model-2026']);
});

test('a dated snapshot is priced from its alias entry', () => {
  const m = new CostMeter({
    runId: 'r',
    priceTable: { models: { 'aliased-model': { inputPerMTok: 4, outputPerMTok: 8 } }, providerDefaults: {} },
  });
  const record = m.record({
    operator: 'extract',
    provider: 'openai',
    model: 'aliased-model-2026-03-17',
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    latencyMs: 1,
  });
  assert.equal(record.costUsd, 12);
  assert.deepEqual(m.unpricedModels, [], 'snapshot must not be reported unpriced');
});

test('an exact snapshot entry wins over the alias entry', () => {
  const m = new CostMeter({
    runId: 'r',
    priceTable: {
      models: {
        'aliased-model': { inputPerMTok: 4, outputPerMTok: 8 },
        'aliased-model-2026-03-17': { inputPerMTok: 1, outputPerMTok: 1 },
      },
      providerDefaults: {},
    },
  });
  const record = m.record({
    operator: 'extract',
    provider: 'openai',
    model: 'aliased-model-2026-03-17',
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    latencyMs: 1,
  });
  assert.equal(record.costUsd, 2);
});

const meter = () => new CostMeter({ runId: 'test-run', priceTable: PRICES });

test('costs a priced call from the table', () => {
  const m = meter();
  const record = m.record({
    operator: 'link-judge',
    docId: 40102,
    provider: 'anthropic',
    model: 'priced-model',
    usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    latencyMs: 1200,
  });

  // 1M in at $5/MTok + 100k out at $25/MTok = 5 + 2.5
  assert.equal(record.costUsd, 7.5);
  assert.equal(m.totals().costUsd, 7.5);
  assert.equal(m.totals().unpricedCalls, 0);
});

test('an unknown model is unpriced, NOT free', () => {
  const m = meter();
  const record = m.record({
    operator: 'extract',
    provider: 'openai',
    model: 'model-nobody-priced',
    usage: { inputTokens: 500, outputTokens: 500 },
    latencyMs: 10,
  });

  // The whole point: a silent 0 would make an expensive run look free.
  assert.equal(record.costUsd, null);
  const totals = m.totals();
  assert.equal(totals.unpricedCalls, 1);
  assert.equal(totals.costUsd, 0, 'priced sum stays 0 because nothing priced was recorded');
  assert.deepEqual(m.unpricedModels, ['openai/model-nobody-priced']);
  // Tokens are still counted — the run is measurable even when it is not costable.
  assert.equal(totals.inputTokens, 500);
  assert.equal(totals.outputTokens, 500);
});

test('an explicit null price is treated as unpriced, not as zero', () => {
  const m = meter();
  const record = m.record({
    operator: 'extract',
    provider: 'openai',
    model: 'null-priced-model',
    usage: { inputTokens: 1000, outputTokens: 1000 },
    latencyMs: 10,
  });
  assert.equal(record.costUsd, null);
  assert.equal(m.totals().unpricedCalls, 1);
});

test('provider default prices a model absent from the table', () => {
  const m = meter();
  const record = m.record({
    operator: 'extract',
    provider: 'ollama',
    model: 'some-local-model',
    usage: { inputTokens: 9_999, outputTokens: 9_999 },
    latencyMs: 10,
  });
  // Local inference is free at the margin — a defensible 0, unlike a missing cloud price.
  assert.equal(record.costUsd, 0);
  assert.equal(m.totals().unpricedCalls, 0);
  assert.deepEqual(m.unpricedModels, []);
});

test('groups totals by operator and by doc', () => {
  const m = meter();
  const usage = { inputTokens: 200_000, outputTokens: 0 };
  m.record({ operator: 'extract', docId: 1, provider: 'x', model: 'priced-model', usage, latencyMs: 5 });
  m.record({ operator: 'extract', docId: 2, provider: 'x', model: 'priced-model', usage, latencyMs: 7 });
  m.record({ operator: 'link-judge', docId: 1, provider: 'x', model: 'priced-model', usage, latencyMs: 9 });

  const byOperator = m.byOperator();
  assert.equal(byOperator.extract.calls, 2);
  assert.equal(byOperator['link-judge'].calls, 1);
  assert.equal(byOperator.extract.wallClockMs, 12);

  const byDoc = m.byDoc();
  assert.equal(byDoc['1'].calls, 2);
  assert.equal(byDoc['2'].calls, 1);

  // Verification item 5: the card's totals equal the sum of the log's rows.
  const totals = m.totals();
  assert.equal(totals.calls, 3);
  assert.equal(totals.wallClockMs, 21);
  assert.equal(
    totals.costUsd,
    Object.values(byOperator).reduce((sum, bucket) => sum + bucket.costUsd, 0)
  );
});

test('docId is optional and buckets as "none"', () => {
  const m = meter();
  m.record({
    operator: 'consolidate',
    provider: 'x',
    model: 'priced-model',
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 1,
  });
  assert.equal(m.byDoc().none.calls, 1);
  assert.equal(m.records[0].docId, null);
});
