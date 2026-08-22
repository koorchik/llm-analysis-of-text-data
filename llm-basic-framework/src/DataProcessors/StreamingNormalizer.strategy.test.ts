import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
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
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await conceptRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  // A near-miss candidate: close enough to be retrieved, not equal, so the judge is consulted.
  conceptRegistry.mint('HackerGroup', 'Fancy Bears', { doc: 0, date: '2023-01-01' });
  await schemaRegistry.save();
  await conceptRegistry.save();

  const llm = recordingLlm('{"verdicts":[],"choices":[],"selected":0,"rules":[]}');
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });

  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    decisionStrategy: strategy,
  });

  return { dir, normalizer, llm, conceptRegistry };
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

  it('passes identity inputs and generic source evidence, but no role', async () => {
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
    assert.ok(!Object.prototype.hasOwnProperty.call(request, 'role'));
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
    const { normalizer, conceptRegistry } = await setup('link', strategy);
    await normalizer.processFile('1.json');
    assert.equal(conceptRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bears');
  });

  it('treats a defer as a provisional mint AND queues the pair for the consolidator', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({ kind: 'defer' as const, target: null, confidence: null, reason: 'stub' }))
    );
    const { normalizer, conceptRegistry } = await setup('defer', strategy);
    await normalizer.processFile('1.json');
    // Not linked to the candidate — it became its own canonical (mint-over-merge doctrine)…
    assert.equal(conceptRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
    // …and the undecided pair is queued in registry state (SKEIN v2: decisions.jsonl is never
    // read at runtime, so the consolidator's input lives here).
    const queued = conceptRegistry.deferred();
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
    const { normalizer, conceptRegistry } = await setup('offlist', strategy);
    await normalizer.processFile('1.json');
    assert.equal(conceptRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
  });

  it('mints the document rather than aborting it when the strategy throws', async () => {
    const strategy = new StubStrategy(() => {
      throw new Error('strategy exploded');
    });
    const { normalizer, conceptRegistry } = await setup('throws', strategy);
    // Must not reject: mint-all is conservative and repairable by the consolidator.
    assert.equal(await normalizer.processFile('1.json'), true);
    assert.equal(conceptRegistry.resolve('HackerGroup', 'Fancy Bear'), 'Fancy Bear');
  });

  it('refuses a strategy that returns the wrong number of decisions', async () => {
    // Positional alignment is the port's contract. Silently misaligning verdicts with mentions
    // would be unrecoverable after the fact, so this is fatal rather than best-effort.
    const strategy = new StubStrategy(() => []);
    const { normalizer } = await setup('misaligned', strategy);
    await assert.rejects(() => normalizer.processFile('1.json'), /returned 0 decisions for 1 requests/);
  });
});

// --- SKOS graph: similarity-scored edges, the `b` direction, and the catch-up pass ---------------

import type { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';

/** Deterministic per-text vectors, so a cosine is computable without a live encoder. */
function stubEmbeddings(vectors: Record<string, number[]>): EmbeddingsClient {
  const client = {
    async embed(input: string | string[]) {
      const texts = Array.isArray(input) ? input : [input];
      const out = texts.map((text) => {
        const vector = vectors[text];
        if (!vector) throw new Error(`stubEmbeddings: no vector for "${text}"`);
        return vector;
      });
      return Array.isArray(input) ? out : out[0];
    },
  };
  return client as unknown as EmbeddingsClient;
}

async function readOps(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
}

describe('StreamingNormalizer SKOS graph', () => {
  it('an edge carries the cosine similarity of its endpoint names', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({
        kind: 'mint' as const,
        target: null,
        confidence: null,
        reason: 'stub',
        parentCandidate: 'Fancy Bears',
        broaderType: 'broaderGeneric' as const,
      }))
    );
    const { dir, conceptRegistry } = await setup('simscore', strategy);
    // cos = 0.6 between the two stub unit vectors below.
    const withEmbeddings = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: recordingLlm('{}').client,
      schemaRegistry: new SchemaRegistry({ filePath: path.join(dir, 'schema.json') }),
      conceptRegistry,
      decisionLog: new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true }),
      decisionStrategy: strategy,
      embeddingsClient: stubEmbeddings({
        'Fancy Bear': [1, 0],
        'Fancy Bears': [0.6, 0.8],
      }),
    });
    await withEmbeddings.processFile('1.json');

    const edges = conceptRegistry.broaderEdges('HackerGroup');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].narrower, 'Fancy Bear');
    assert.equal(edges[0].broader, 'Fancy Bears');
    assert.ok(Math.abs((edges[0].similarityScore ?? 0) - 0.6) < 1e-9, 'cosine of the stub vectors');

    const edgeEvent = (await readOps(dir)).find((event) => event.op === 'broader-edge');
    assert.equal(edgeEvent?.type, 'broaderGeneric');
    assert.ok(Math.abs(Number(edgeEvent?.similarityScore) - 0.6) < 1e-9);

    assert.equal(
      conceptRegistry.rollupTarget('HackerGroup', 'Fancy Bear', { threshold: 0.5 }),
      'Fancy Bears',
      'above the threshold the edge rolls up'
    );
    assert.equal(
      conceptRegistry.rollupTarget('HackerGroup', 'Fancy Bear', { threshold: 0.85 }),
      'Fancy Bear',
      'below the threshold the semantic brake stops the rollup'
    );
  });

  it('mentionIsBroader (r:"b") stores the edge with swapped endpoints', async () => {
    const strategy = new StubStrategy((requests) =>
      requests.map(() => ({
        kind: 'mint' as const,
        target: null,
        confidence: null,
        reason: 'stub',
        parentCandidate: 'Fancy Bears',
        broaderType: 'broaderGeneric' as const,
        mentionIsBroader: true,
      }))
    );
    const { normalizer, conceptRegistry } = await setup('broader', strategy);
    await normalizer.processFile('1.json');

    const edges = conceptRegistry.broaderEdges('HackerGroup');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].narrower, 'Fancy Bears', 'the listed entity is the narrower side');
    assert.equal(edges[0].broader, 'Fancy Bear', 'the freshly minted mention is the broader side');
    assert.equal(edges[0].similarityScore, null, 'no embeddings client in this arm');
  });

  it('the catch-up pass fires on canonical growth, merges via applyMerges, and does not re-fire', async () => {
    const dir = await scratchDir('catchup');
    for (const doc of [1, 2]) {
      await fs.writeFile(
        path.join(dir, 'extractions', `${doc}.json`),
        JSON.stringify({
          entities: [{ name: `Mention ${doc}`, category: 'HackerGroup', role: 'attacker' }],
          relations: [],
          schemaProposals: [],
          metadata: { id: doc, title: `report ${doc}`, date: '2024-01-01' },
        })
      );
    }

    const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
    const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
    await schemaRegistry.load();
    await conceptRegistry.load();
    schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
    // Two near-identical canonicals: the catch-up's own retrieval surfaces each as the other's
    // candidate, and the stub merges them.
    conceptRegistry.mint('HackerGroup', 'Fancy Bears', { doc: 0, date: '2023-01-01' });
    conceptRegistry.mint('HackerGroup', 'Fancy Bearz', { doc: 0, date: '2023-01-01' });
    await schemaRegistry.save();
    await conceptRegistry.save();

    const strategy = new StubStrategy((requests) =>
      requests.map((request) => {
        // Catch-up requests carry the registry-review title; merge the pair once.
        if (request.docTitle?.startsWith('registry review') && request.mention === 'Fancy Bearz') {
          return {
            kind: 'link' as const,
            target: request.candidates[0].canonical,
            confidence: null,
            reason: 'stub merge',
          };
        }
        return { kind: 'mint' as const, target: null, confidence: null, reason: 'stub' };
      })
    );

    const normalizer = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: recordingLlm('{}').client,
      schemaRegistry,
      conceptRegistry,
      decisionLog: new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true }),
      decisionStrategy: strategy,
      skosCatchupEvery: 2,
      skosCatchupWidth: 40,
    });
    await normalizer.processFile('1.json');
    await normalizer.processFile('2.json');

    const ops = await readOps(dir);
    const catchUps = ops.filter((event) => event.op === 'skos-catch-up');
    assert.equal(catchUps.length, 1, 'fires once at the growth threshold, not per document');
    assert.equal(catchUps[0].merged, 1);
    const merge = ops.find((event) => event.op === 'merge');
    assert.equal(merge?.by, 'skos-catch-up');
    assert.equal(
      conceptRegistry.resolve('HackerGroup', 'Fancy Bearz'),
      conceptRegistry.resolve('HackerGroup', 'Fancy Bears'),
      'the duplicate pair folded into one canonical'
    );
  });
});
