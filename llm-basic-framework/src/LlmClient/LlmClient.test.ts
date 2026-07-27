import { CostMeter, type PriceTable } from '../Experiment/CostMeter';
import { LlmClient } from './LlmClient';
import type {
  LlmBackendBase,
  LlmCallOptions,
  LlmResponse,
  LlmSamplingSupport,
} from './LlmClientBackendBase';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PRICES: PriceTable = {
  models: { 'fake-model': { inputPerMTok: 1, outputPerMTok: 2 } },
  providerDefaults: {},
};

/** Records what the client actually forwarded, which is the thing under test. */
class SpyBackend implements LlmBackendBase {
  model = 'fake-model';
  readonly provider: string;
  readonly sampling: LlmSamplingSupport;
  calls: LlmCallOptions[] = [];

  constructor(provider: string, sampling: LlmSamplingSupport) {
    this.provider = provider;
    this.sampling = sampling;
  }

  async send(_instructions: string, _text: string, options: LlmCallOptions = {}): Promise<LlmResponse> {
    this.calls.push(options);
    return {
      text: 'ok',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      model: this.model,
      latencyMs: 42,
      finishReason: 'end_turn',
    };
  }
}

const permissive: LlmSamplingSupport = { temperature: true, seed: true, topP: true };
const anthropicLike: LlmSamplingSupport = {
  temperature: false,
  seed: false,
  topP: false,
  note: 'Opus 4.7+ removes sampling parameters; non-default values return HTTP 400.',
};

test('forwards supported sampling parameters', async () => {
  const backend = new SpyBackend('openai', permissive);
  const client = new LlmClient({ backend });
  await client.send('sys', 'user', { temperature: 0, seed: 7, topP: 0.9, maxTokens: 100 });

  assert.deepEqual(backend.calls[0], { maxTokens: 100, temperature: 0, topP: 0.9, seed: 7 });
});

test('DROPS temperature for a backend that rejects it — the Anthropic 400 guard', async () => {
  const backend = new SpyBackend('anthropic', anthropicLike);
  const client = new LlmClient({ backend });
  await client.send('sys', 'user', { temperature: 0, seed: 7, topP: 0.9, maxTokens: 100 });

  // maxTokens survives (Anthropic accepts max_tokens); the three sampling params must not be sent.
  assert.deepEqual(backend.calls[0], { maxTokens: 100 });
  assert.equal('temperature' in backend.calls[0], false);
  assert.equal('seed' in backend.calls[0], false);
  assert.equal('topP' in backend.calls[0], false);
});

test('a shared temperature: 0 default does not leak into an Anthropic-like backend', async () => {
  const backend = new SpyBackend('anthropic', anthropicLike);
  const client = new LlmClient({ backend, defaultCallOptions: { temperature: 0 } });
  await client.send('sys', 'user');
  assert.deepEqual(backend.calls[0], {});
});

test('per-call options override defaults', async () => {
  const backend = new SpyBackend('openai', permissive);
  const client = new LlmClient({ backend, defaultCallOptions: { temperature: 1, seed: 1 } });
  await client.send('sys', 'user', { temperature: 0 });
  assert.deepEqual(backend.calls[0], { temperature: 0, seed: 1 });
});

test('effectiveDefaults reports what will really be sent, not what was requested', () => {
  const permissiveClient = new LlmClient({
    backend: new SpyBackend('openai', permissive),
    defaultCallOptions: { temperature: 0, seed: 3 },
  });
  assert.deepEqual(permissiveClient.effectiveDefaults, { temperature: 0, seed: 3 });

  const anthropicClient = new LlmClient({
    backend: new SpyBackend('anthropic', anthropicLike),
    defaultCallOptions: { temperature: 0, seed: 3 },
  });
  // The run card records this — so it cannot claim a temperature that never left the process.
  assert.deepEqual(anthropicClient.effectiveDefaults, {});
});

test('meters every call with operator and doc attribution', async () => {
  const backend = new SpyBackend('openai', permissive);
  const costMeter = new CostMeter({ runId: 'r1', priceTable: PRICES });
  const client = new LlmClient({ backend, costMeter });

  await client.send('sys', 'user', { operator: 'link-judge', docId: 40102 });

  const record = costMeter.records[0];
  assert.equal(record.operator, 'link-judge');
  assert.equal(record.docId, 40102);
  assert.equal(record.provider, 'openai');
  assert.equal(record.model, 'fake-model');
  assert.equal(record.latencyMs, 42);
  assert.equal(record.costUsd, 3); // 1M in @ $1 + 1M out @ $2
});

test('operator/docId are not forwarded to the backend as sampling parameters', async () => {
  const backend = new SpyBackend('openai', permissive);
  const client = new LlmClient({ backend });
  await client.send('sys', 'user', { operator: 'extract', docId: 5, temperature: 0.5 });
  assert.deepEqual(backend.calls[0], { temperature: 0.5 });
});

test('an unattributed call still meters, in the unknown/none buckets', async () => {
  const backend = new SpyBackend('openai', permissive);
  const costMeter = new CostMeter({ runId: 'r1', priceTable: PRICES });
  const client = new LlmClient({ backend, costMeter });
  await client.send('sys', 'user');
  assert.equal(costMeter.records[0].operator, 'unknown');
  assert.equal(costMeter.records[0].docId, null);
});

test('returns the full response, and text is reachable via .text', async () => {
  const client = new LlmClient({ backend: new SpyBackend('openai', permissive) });
  const response = await client.send('sys', 'user');
  assert.equal(response.text, 'ok');
  assert.equal(response.usage.inputTokens, 1_000_000);
  assert.equal(response.finishReason, 'end_turn');
});

test('a failed call propagates and is not metered as a success', async () => {
  class FailingBackend extends SpyBackend {
    async send(): Promise<LlmResponse> {
      throw new Error('boom');
    }
  }
  const costMeter = new CostMeter({ runId: 'r1', priceTable: PRICES });
  const client = new LlmClient({ backend: new FailingBackend('openai', permissive), costMeter });

  await assert.rejects(() => client.send('sys', 'user', { operator: 'extract' }), /boom/);
  assert.equal(costMeter.records.length, 0);
});
