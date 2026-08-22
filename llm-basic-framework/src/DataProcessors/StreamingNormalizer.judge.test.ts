import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

/**
 * The built-in SKEIN v2 link-judge (2026-08-04 redesign): three verdicts, rung assignment,
 * parent-edge structure on mint, defer as provisional mint + queue — all through the real
 * StreamingNormalizer with a canned LLM reply.
 */

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`judge${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `streaming-judge-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function cannedLlm(reply: string) {
  const prompts: string[] = [];
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      return {
        text: reply,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts };
}

function cannedLlmSequence(replies: string[]) {
  const prompts: string[] = [];
  let call = 0;
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts };
}

type RepairerStub = { processDoc: (file: string, docId: number) => Promise<void> };

async function setup(
  tag: string,
  reply: string,
  mention = 'UAC-0002',
  options: { repairer?: RepairerStub } = {}
) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [{ name: mention, category: 'HackerGroup', role: 'Attacker' }],
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
  // A near-miss candidate so the judge is consulted (string-sim retrieves it).
  conceptRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
  await schemaRegistry.save();
  await conceptRegistry.save();

  const llm = cannedLlm(reply);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    repairer: options.repairer,
  });
  return { dir, normalizer, llm, conceptRegistry, decisionLog, schemaRegistry };
}

async function setupGlossRetry(tag: string, replies: string[]) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [
        { name: 'UAC-0002', category: 'HackerGroup', role: 'Attacker' },
        { name: 'UAC-0099', category: 'HackerGroup', role: 'Attacker' },
      ],
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
  conceptRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
  conceptRegistry.mint('HackerGroup', 'UAC-0099x', { doc: 0, date: '2023-01-01' });
  await schemaRegistry.save();
  await conceptRegistry.save();

  const llm = cannedLlmSequence(replies);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
  });
  return { dir, normalizer, llm, conceptRegistry };
}

async function readDecisions(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

const verdict = (extra: Record<string, unknown>) =>
  JSON.stringify({
    verdicts: [
      {
        index: 1,
        mention: 'UAC-0002',
        category: 'HackerGroup',
        verdict: 'mint',
        target: null,
        parentCandidate: null,
        edgeKind: null,
        reasoning: 'test',
        ...extra,
      },
    ],
  });

describe('StreamingNormalizer built-in judge (SKEIN v2)', () => {
  it('renders a domain-neutral prompt that does not expose the structured role', async () => {
    const { normalizer, llm } = await setup('prompt', verdict({}));
    await normalizer.processFile('1.json');
    const judgePrompt = llm.prompts.find((prompt) => prompt.includes('UNRESOLVED MENTIONS'));
    assert.ok(judgePrompt, 'link-judge prompt rendered');
    assert.ok(judgePrompt!.includes('UAC-0002x'), 'candidate rendered');
    assert.ok(!judgePrompt!.includes('ladder'), 'no ladder vocabulary in the prompt');
    assert.ok(judgePrompt!.includes('(HackerGroup)'), 'category remains available');
    assert.ok(judgePrompt!.includes('test report'), 'generic source evidence remains available');
    assert.ok(!judgePrompt!.includes('Attacker'), 'incident role is not matching evidence');
    assert.ok(!judgePrompt!.includes('cyber'), 'prompt is not tied to the source dataset');
    assert.ok(!/\{\{\w+\}\}/.test(judgePrompt!), 'no unrendered placeholder');
  });

  it('a mint carrying a valid parentCandidate records a broadMatch edge with judge provenance', async () => {
    const { normalizer, conceptRegistry } = await setup(
      'parent',
      verdict({ parentCandidate: 'UAC-0002x', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');

    const edges = conceptRegistry.broaderEdges('HackerGroup');
    assert.equal(edges.length, 1, 'the hard-non-merge-plus-edge outcome');
    assert.equal(edges[0].narrower, 'UAC-0002');
    assert.equal(edges[0].broader, 'UAC-0002x');
    assert.equal(edges[0].type, 'broaderPartitive', 'the legacy edgeKind answer maps onto the ISO 25964 typing');
    assert.equal(edges[0].similarityScore, null, 'no embeddings client injected: null score');
    assert.equal(edges[0].decision, 'judge');
    assert.equal(edges[0].evidence, 'test');
    // Still two distinct canonicals — the edge is a connection, never a merge.
    assert.equal(conceptRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a parentCandidate not in the candidate list is dropped; the mint stands', async () => {
    const { normalizer, conceptRegistry } = await setup(
      'badparent',
      verdict({ parentCandidate: 'Sandworm', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');
    assert.equal(conceptRegistry.broaderEdges('HackerGroup').length, 0);
    assert.equal(conceptRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a link to an unlisted target is demoted to mint (strict candidate matching)', async () => {
    const { normalizer, conceptRegistry } = await setup(
      'strict',
      verdict({ verdict: 'link', target: 'Sandworm' })
    );
    await normalizer.processFile('1.json');
    assert.equal(conceptRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'minted, not linked');
  });

  it('defer mints provisionally, queues the pair, and logs a defer decision with a null target', async () => {
    const { normalizer, conceptRegistry, dir } = await setup('defer', verdict({ verdict: 'defer' }));
    await normalizer.processFile('1.json');

    assert.equal(conceptRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'provisional mint');
    const queued = conceptRegistry.deferred();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].mintedAs, 'UAC-0002');

    const log = (await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const deferEvent = log.find((event) => event.decision === 'defer');
    assert.ok(deferEvent, 'defer decision logged');
    assert.equal(deferEvent.target, null, 'protocol §5: a deferral is a withheld decision');
    assert.equal(deferEvent.mintedAs, 'UAC-0002', 'replayable provisional canonical');
  });

  it('stamps matchedVia beside normalizedName in the artifact', async () => {
    const { normalizer, dir } = await setup(
      'matchedvia',
      verdict({ verdict: 'link', target: 'UAC-0002x' })
    );
    await normalizer.processFile('1.json');
    const artifact = JSON.parse(
      await fs.readFile(path.join(dir, 'artifacts', '1.json'), 'utf8')
    );
    assert.equal(artifact.entities[0].normalizedName, 'UAC-0002x');
    assert.equal(artifact.entities[0].matchedVia, 'UAC-0002', 'the alias surface actually hit');
  });
});

describe('StreamingNormalizer matching metadata', () => {
  it('stores a source-grounded gloss for later candidate retrieval', async () => {
    const { normalizer, conceptRegistry } = await setup(
      'gloss-mint',
      verdict({ gloss: 'Group linked to a wave of energy-sector intrusions' })
    );
    await normalizer.processFile('1.json');
    const entries = conceptRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    assert.equal(uac2?.definition, 'Group linked to a wave of energy-sector intrusions');
  });

  it("a link verdict's gloss is ignored — no gloss validation, no retry", async () => {
    const { normalizer, llm, conceptRegistry, dir } = await setup(
      'gloss-link-ignored',
      verdict({ verdict: 'link', target: 'UAC-0002x', gloss: 'irrelevant text' })
    );
    await normalizer.processFile('1.json');
    assert.equal(llm.prompts.length, 1, 'no retry for a link verdict');
    const entries = conceptRegistry.snapshot().entries('HackerGroup');
    const uac2x = entries.find((e) => e.canonical === 'UAC-0002x');
    assert.equal(uac2x?.definition, null, 'link never writes a gloss');

    const log = await readDecisions(dir);
    assert.ok(!log.some((e) => e.op === 'gloss-flagged'));
  });

  it('stores a source-grounded gloss on a deferred provisional mint', async () => {
    const { normalizer, conceptRegistry } = await setup(
      'gloss-defer',
      verdict({ verdict: 'defer', gloss: 'Suspected alias of a known group; evidence insufficient' })
    );
    await normalizer.processFile('1.json');
    const entries = conceptRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    assert.equal(uac2?.definition, 'Suspected alias of a known group; evidence insufficient');
  });

  const batchReply = (gloss: unknown) =>
    JSON.stringify({
      verdicts: [
        {
          mention: 'UAC-0002', category: 'HackerGroup', mentionRung: 'g0', verdict: 'mint',
          target: null, parentCandidate: null, edgeKind: null, gloss, reasoning: 'test',
        },
        {
          mention: 'UAC-0099', category: 'HackerGroup', mentionRung: 'g0', verdict: 'mint',
          target: null, parentCandidate: null, edgeKind: null,
          gloss: 'Distinct organization operating in a separate region', reasoning: 'test',
        },
      ],
    });

  const retryReply = (gloss: unknown) =>
    JSON.stringify({
      verdicts: [{
        mention: 'UAC-0002', category: 'HackerGroup', mentionRung: 'g0', verdict: 'mint',
        target: null, parentCandidate: null, edgeKind: null, gloss, reasoning: 'test',
      }],
    });

  it('accepts an explicit null gloss as "no name-independent evidence" without a retry or flag', async () => {
    const { normalizer, llm, conceptRegistry, dir } = await setupGlossRetry('null-ok', [
      batchReply(null),
    ]);
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 1, 'a null gloss is a sanctioned answer, not a retry trigger');
    const record = conceptRegistry.snapshot().entries('HackerGroup')
      .find((entry) => entry.canonical === 'UAC-0002');
    assert.equal(record?.definition, null);
    const log = await readDecisions(dir);
    assert.ok(!log.some((event) => event.op === 'gloss-flagged'), 'null is not a failure');
  });

  it('retries a name-restating gloss once for only the failing mention', async () => {
    const { normalizer, llm, conceptRegistry } = await setupGlossRetry('retry-ok', [
      batchReply('UAC-0002'),
      retryReply('Organization identified by a stable external designation'),
    ]);
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 2);
    assert.ok(llm.prompts[1].includes('"UAC-0002"'));
    assert.ok(!llm.prompts[1].includes('"UAC-0099"'));
    const record = conceptRegistry.snapshot().entries('HackerGroup')
      .find((entry) => entry.canonical === 'UAC-0002');
    assert.equal(record?.definition, 'Organization identified by a stable external designation');
  });

  it('drops a still-restating gloss after one retry and records the failure', async () => {
    const { normalizer, llm, conceptRegistry, dir } = await setupGlossRetry('retry-bad', [
      batchReply('uac-0002'),
      retryReply('UAC-0002'),
    ]);
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 2, 'never loops');
    const record = conceptRegistry.snapshot().entries('HackerGroup')
      .find((entry) => entry.canonical === 'UAC-0002');
    assert.equal(record?.definition, null);
    const log = await readDecisions(dir);
    assert.ok(log.some((event) => event.op === 'gloss-flagged' && event.mention === 'UAC-0002'));
  });
});

describe('StreamingNormalizer repairer hook (T5 phase-2)', () => {
  it('calls repairer.processDoc after the artifact is written, as the last step of processFile', async () => {
    let dirRef = '';
    const calls: Array<{ file: string; docId: number; artifactExisted: boolean }> = [];
    const repairer: RepairerStub = {
      async processDoc(file, docId) {
        const artifactPath = path.join(dirRef, 'artifacts', file);
        calls.push({ file, docId, artifactExisted: existsSync(artifactPath) });
      },
    };
    const { dir, normalizer } = await setup('repairer-normal', verdict({}), 'UAC-0002', { repairer });
    dirRef = dir;
    await normalizer.processFile('1.json');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '1.json');
    assert.equal(calls[0].docId, 1);
    assert.equal(calls[0].artifactExisted, true, 'artifact already on disk when the repairer ran');
  });

  it('invokes the repairer on the SKIP-exists branch when repair has not caught up to this doc', async () => {
    const { dir, normalizer, conceptRegistry, decisionLog, llm, schemaRegistry } = await setup(
      'repairer-skip-behind',
      verdict({})
    );
    await normalizer.processFile('1.json'); // no repairer wired yet; just produces the artifact

    const calls: Array<{ file: string; docId: number }> = [];
    const repairer: RepairerStub = {
      async processDoc(file, docId) {
        calls.push({ file, docId });
      },
    };
    const normalizer2 = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: llm.client,
      schemaRegistry,
      conceptRegistry,
      decisionLog,
      repairer,
    });

    const result = await normalizer2.processFile('1.json');
    assert.equal(result, true);
    assert.equal(calls.length, 1, 'repairer invoked on the skip-exists path (crash recovery)');
    assert.equal(calls[0].file, '1.json');
    assert.equal(calls[0].docId, 1);
  });

  it('does not invoke the repairer on the SKIP-exists branch once repair has caught up', async () => {
    const { dir, normalizer, conceptRegistry, decisionLog, llm, schemaRegistry } = await setup(
      'repairer-skip-caughtup',
      verdict({})
    );
    await normalizer.processFile('1.json');
    conceptRegistry.setRepairedThrough(1);
    await conceptRegistry.save();

    const calls: number[] = [];
    const repairer: RepairerStub = {
      async processDoc() {
        calls.push(1);
      },
    };
    const normalizer2 = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: llm.client,
      schemaRegistry,
      conceptRegistry,
      decisionLog,
      repairer,
    });

    await normalizer2.processFile('1.json');
    assert.equal(calls.length, 0, 'repair already caught up to this doc');
  });
});
