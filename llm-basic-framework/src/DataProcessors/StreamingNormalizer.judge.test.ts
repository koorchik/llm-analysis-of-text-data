import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
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

async function setup(tag: string, reply: string, mention = 'UAC-0002') {
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
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  // A near-miss candidate so the judge is consulted (string-sim retrieves it).
  entityRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
  entityRegistry.setRung('HackerGroup', 'UAC-0002x', 'g1');
  await schemaRegistry.save();
  await entityRegistry.save();

  const llm = cannedLlm(reply);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient: llm.client, decisionLog }),
    decisionLog,
  });
  return { dir, normalizer, llm, entityRegistry, decisionLog };
}

const verdict = (extra: Record<string, unknown>) =>
  JSON.stringify({
    verdicts: [
      {
        index: 1,
        mention: 'UAC-0002',
        category: 'HackerGroup',
        mentionRung: 'g0',
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
  it('renders the prompt with title, snippet and rung-labelled candidates', async () => {
    const { normalizer, llm } = await setup('prompt', verdict({}));
    await normalizer.processFile('1.json');
    const judgePrompt = llm.prompts.find((prompt) => prompt.includes('UNRESOLVED MENTIONS'));
    assert.ok(judgePrompt, 'link-judge prompt rendered');
    assert.ok(judgePrompt!.includes('"test report"'), 'docTitle placeholder filled');
    assert.ok(judgePrompt!.includes('UAC-0002x [g1]'), 'candidate labelled with its rung');
    assert.ok(!/\{\{\w+\}\}/.test(judgePrompt!), 'no unrendered placeholder');
  });

  it('mints at the judged rung', async () => {
    const { normalizer, entityRegistry } = await setup('rung', verdict({ mentionRung: 'g0' }));
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.rungOf('HackerGroup', 'UAC-0002'), 'g0');
  });

  it('a mint carrying a valid parentCandidate records a granularity edge with judge provenance', async () => {
    const { normalizer, entityRegistry } = await setup(
      'parent',
      verdict({ parentCandidate: 'UAC-0002x', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');

    const edges = entityRegistry.granularityEdges('HackerGroup');
    assert.equal(edges.length, 1, 'the hard-non-merge-plus-edge outcome');
    assert.equal(edges[0].from, 'UAC-0002');
    assert.equal(edges[0].to, 'UAC-0002x');
    assert.equal(edges[0].kind, 'part-of');
    assert.equal(edges[0].decision, 'judge');
    assert.equal(edges[0].evidence, 'test');
    // Still two distinct canonicals — the edge is a connection, never a merge.
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a parentCandidate not in the candidate list is dropped; the mint stands', async () => {
    const { normalizer, entityRegistry } = await setup(
      'badparent',
      verdict({ parentCandidate: 'Sandworm', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.granularityEdges('HackerGroup').length, 0);
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a link to an unlisted target is demoted to mint (strict candidate matching)', async () => {
    const { normalizer, entityRegistry } = await setup(
      'strict',
      verdict({ verdict: 'link', target: 'Sandworm' })
    );
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'minted, not linked');
  });

  it('defer mints provisionally, queues the pair, and logs a defer decision with a null target', async () => {
    const { normalizer, entityRegistry, dir } = await setup('defer', verdict({ verdict: 'defer' }));
    await normalizer.processFile('1.json');

    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'provisional mint');
    const queued = entityRegistry.deferred();
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
