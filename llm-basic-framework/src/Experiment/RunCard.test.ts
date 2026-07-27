import { CostMeter, type PriceTable } from './CostMeter';
import { RunCard } from './RunCard';
import { resolveRunConfig, type RunConfigInput } from './RunConfig';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const PRICES: PriceTable = {
  models: { 'fake-model': { inputPerMTok: 1, outputPerMTok: 2 } },
  providerDefaults: {},
};

const config = (): RunConfigInput => ({
  condition: 'card-test',
  orchestration: 'streaming',
  input: { path: '/frozen', contentHash: 'deadbeef', fileCount: 204 },
  llm: { provider: 'anthropic', model: 'fake-model' },
  sampling: {
    effective: {},
    supported: { temperature: false, seed: false, topP: false, note: 'no lever on this provider' },
  },
  seed: null,
  order: 'chronological',
});

async function tmpRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runcard-'));
}

test('writes a card carrying config, git state and input hash', async () => {
  const runDir = await tmpRunDir();
  const resolved = resolveRunConfig(config());
  const card = new RunCard({ runDir, config: resolved });
  await card.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run-card.json'), 'utf8'));
  assert.equal(onDisk.version, 'run-card-v1');
  assert.equal(onDisk.runId, resolved.runId);
  assert.equal(onDisk.config.input.contentHash, 'deadbeef');
  assert.equal(onDisk.config.llm.model, 'fake-model');
  assert.ok('git' in onDisk.config, 'git state is recorded');
  assert.equal(onDisk.completedAt, null, 'an unfinished run is not marked complete');
});

test('records sampling as absent-and-unsupported rather than as a chosen value', async () => {
  const runDir = await tmpRunDir();
  const card = new RunCard({ runDir, config: resolveRunConfig(config()) });
  await card.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run-card.json'), 'utf8'));
  assert.deepEqual(onDisk.config.sampling.effective, {});
  assert.equal(onDisk.config.sampling.supported.temperature, false);
  assert.match(onDisk.config.sampling.supported.note, /no lever/);
});

test("card cost totals equal the sum of the metered calls (verification item 5)", async () => {
  const runDir = await tmpRunDir();
  const meter = new CostMeter({ runId: 'r1', priceTable: PRICES });

  const calls = [
    { operator: 'extract', docId: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    { operator: 'link-judge', docId: 1, usage: { inputTokens: 0, outputTokens: 1_000_000 } },
    { operator: 'link-judge', docId: 2, usage: { inputTokens: 500_000, outputTokens: 500_000 } },
  ];
  for (const call of calls) {
    meter.record({ ...call, provider: 'anthropic', model: 'fake-model', latencyMs: 10 });
  }

  const card = new RunCard({ runDir, config: resolveRunConfig(config()) });
  card.attachCost(meter);
  card.markComplete();
  await card.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run-card.json'), 'utf8'));
  const expected = meter.records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);

  assert.equal(onDisk.cost.totals.calls, 3);
  assert.equal(onDisk.cost.totals.costUsd, expected);
  assert.equal(onDisk.cost.totals.inputTokens, 1_500_000);
  assert.equal(onDisk.cost.totals.outputTokens, 1_500_000);
  assert.equal(onDisk.cost.byOperator['link-judge'].calls, 2);
  assert.ok(onDisk.completedAt, 'a finished run is marked complete');
});

test('surfaces unpriced models so a run cannot look cheaper than it was', async () => {
  const runDir = await tmpRunDir();
  const meter = new CostMeter({ runId: 'r1', priceTable: PRICES });
  meter.record({
    operator: 'extract',
    provider: 'openai',
    model: 'unpriced-model',
    usage: { inputTokens: 10, outputTokens: 10 },
    latencyMs: 1,
  });

  const card = new RunCard({ runDir, config: resolveRunConfig(config()) });
  card.attachCost(meter);
  await card.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run-card.json'), 'utf8'));
  assert.deepEqual(onDisk.cost.unpricedModels, ['openai/unpriced-model']);
  assert.equal(onDisk.cost.totals.unpricedCalls, 1);
});

test('resuming preserves createdAt and accumulates resume events', async () => {
  const runDir = await tmpRunDir();
  const resolved = resolveRunConfig(config());

  const first = new RunCard({ runDir, config: resolved });
  first.noteResume('extractions/1.json');
  await first.save();
  const createdAt = first.data.createdAt;

  // A second process entering the same run directory — the resume case the runId move preserves.
  const second = new RunCard({ runDir, config: resolved });
  second.noteResume('extractions/2.json');
  await second.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'run-card.json'), 'utf8'));
  assert.equal(onDisk.createdAt, createdAt, 'original run start is preserved across resumes');
  assert.equal(onDisk.resumeEvents.length, 2);
  assert.deepEqual(
    onDisk.resumeEvents.map((event: { skipped: string }) => event.skipped),
    ['extractions/1.json', 'extractions/2.json']
  );
});

test('verifyInputHash catches an edited "frozen" corpus', async () => {
  const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frozen-'));
  await fs.writeFile(path.join(inputDir, 'a.json'), '{"v":1}');

  const runDir = await tmpRunDir();
  const { hashInputDir } = await import('./inputHash');
  const { contentHash } = await hashInputDir(inputDir);

  const resolved = resolveRunConfig({
    ...config(),
    input: { path: inputDir, contentHash, fileCount: 1 },
  });
  const card = new RunCard({ runDir, config: resolved });

  assert.equal((await card.verifyInputHash()).ok, true);

  await fs.writeFile(path.join(inputDir, 'a.json'), '{"v":2}');
  const after = await card.verifyInputHash();
  assert.equal(after.ok, false);
  assert.notEqual(after.recorded, after.actual);
});
