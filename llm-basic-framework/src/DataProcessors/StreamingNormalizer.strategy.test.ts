import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { Decision, DecisionRequest, DecisionStrategy } from '../Normalization/types';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

/**
 * The M6 decision port, exercised through the real StreamingNormalizer.
 *
 * The property that matters most here is the *default*: with no strategy injected the built-in
 * `link-judge` path must still run, because that is the published Ψ_link behaviour the golden
 * fixture pins. A port that silently changed the default arm would invalidate every comparison
 * against it.
 */

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  // Content-derived, so the helper stays deterministic without Date.now()/Math.random().
  const key = crypto.createHash('sha256').update(`${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `streaming-normalizer-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

/** Records every prompt sent, so a test can tell which decision path ran. */
function recordingLlm(reply: string) {
  const operators: string[] = [];
  const client = {
    async send(_instructions: string, _text: string, options?: { operator?: string }) {
      operators.push(options?.operator ?? 'unknown');
      return {
        text: reply,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, operators };
}

class StubStrategy implements DecisionStrategy {
  readonly id = 'stub';
  readonly config = {};
  seen: DecisionRequest[][] = [];

  constructor(private readonly decide_: (requests: DecisionRequest[]) => Decision[]) {}

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    this.seen.push(requests);
    return this.decide_(requests);
  }
}

async function setup(tag: string, strategy?: DecisionStrategy) {
  const dir = await scratchDir(tag);

  // One document with a mention that will miss the exact fast path but retrieve a candidate.
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [{ name: 'Fancy Bear', category: 'HackerGroup', role: 'attacker' }],
      relations: [],
      schemaProposals: [],
      metadata: { id: 1, title: 'test report', date: '2024-01-01' },
    })
  );

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  // A near-miss candidate: close enough to be retrieved, not equal, so the judge is consulted.
  entityRegistry.mint('HackerGroup', 'Fancy Bears', { doc: 0, date: '2023-01-01' });
  await schemaRegistry.save();
  await entityRegistry.save();

  const llm = recordingLlm('{"verdicts":[],"choices":[],"selected":0,"rules":[]}');
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });

  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient: llm.client, decisionLog }),
    decisionLog,
    decisionStrategy: strategy,
  });

  return { dir, normalizer, llm, entityRegistry };
}

describe('StreamingNormalizer decision port', () => {
  it('uses the built-in link-judge path when no strategy is injected', async () => {
    const { normalizer, llm } = await setup('default');
    await normalizer.processFile('1.json');
    // The published behaviour: a batched call with operator 'link-judge'.
    assert.ok(llm.operators.includes('link-judge'), `operators were ${llm.operators.join(', ')}`);
  });

  it('uses the injected strategy instead, and does not make the built-in call', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({ kind: 'mint' as const, target: null, confidence: null, reason: 'stub' }))
    );
    const { normalizer, llm } = await setup('injected', strategy);
    await normalizer.processFile('1.json');

    assert.equal(strategy.seen.length, 1, 'strategy was consulted exactly once for the document');
    assert.ok(!llm.operators.includes('link-judge'), 'built-in judge must not also run');
  });

  it('passes the candidates, category and document context the strategy needs', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({ kind: 'mint' as const, target: null, confidence: null, reason: 'stub' }))
    );
    const { normalizer } = await setup('context', strategy);
    await normalizer.processFile('1.json');

    const [request] = strategy.seen[0];
    assert.equal(request.mention, 'Fancy Bear');
    assert.equal(request.category, 'HackerGroup');
    assert.equal(request.docId, 1);
    assert.equal(request.docTitle, 'test report');
    assert.ok(request.candidates.length > 0, 'the near-miss candidate must reach the strategy');
    assert.equal(request.candidates[0].canonical, 'Fancy Bears');
    // Alias surfaces must survive: they are worth +2-14 F1 to a judge, and the non-LLM arms
    // match against them too.
    assert.ok(request.candidates[0].surfaces.includes('Fancy Bears'));
  });

  it('applies a link verdict to the registry', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map((request) => ({
        kind: 'link' as const,
        target: request.candidates[0].canonical,
        confidence: null,
        reason: 'stub',
      }))
    );
    const { normalizer, entityRegistry } = await setup('link', strategy);
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bears');
  });

  it('treats a defer as a provisional mint AND queues the pair for the consolidator', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({ kind: 'defer' as const, target: null, confidence: null, reason: 'stub' }))
    );
    const { normalizer, entityRegistry } = await setup('defer', strategy);
    await normalizer.processFile('1.json');
    // Not linked to the candidate — it became its own canonical (mint-over-merge doctrine)…
    assert.equal(entityRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
    // …and the undecided pair is queued in registry state (SKEIN v2: decisions.jsonl is never
    // read at runtime, so the consolidator's input lives here).
    const queued = entityRegistry.deferred();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].mention, 'Fancy Bear');
    assert.deepEqual(queued[0].candidates, ['Fancy Bears']);
  });

  it('rejects a link to something that was never a candidate', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({
        kind: 'link' as const,
        target: 'Never Offered',
        confidence: null,
        reason: 'stub',
      }))
    );
    const { normalizer, entityRegistry } = await setup('offlist', strategy);
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
  });

  it('mints the document rather than aborting it when the strategy throws', async () => {
    const strategy = new StubStrategy(() => {
      throw new Error('strategy exploded');
    });
    const { normalizer, entityRegistry } = await setup('throws', strategy);
    // Must not reject: mint-all is conservative and repairable by the consolidator.
    assert.equal(await normalizer.processFile('1.json'), true);
    assert.equal(entityRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
  });

  it('refuses a strategy that returns the wrong number of decisions', async () => {
    // Positional alignment is the port's contract. Silently misaligning verdicts with mentions
    // would be unrecoverable after the fact, so this is fatal rather than best-effort.
    const strategy = new StubStrategy(() => []);
    const { normalizer } = await setup('misaligned', strategy);
    await assert.rejects(() => normalizer.processFile('1.json'), /returned 0 decisions for 1 requests/);
  });
});
