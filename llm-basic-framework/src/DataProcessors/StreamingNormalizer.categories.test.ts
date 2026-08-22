import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`cat${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `streaming-categories-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function cannedLlm() {
  const prompts: string[] = [];
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      return {
        text: '{"decisions": []}',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts };
}

async function setup(tag: string, categories?: string[]) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [
        { name: 'LummaStealer', category: 'Software', role: 'Neutral' },
        { name: 'PikaBot', category: 'Software', role: 'Neutral' },
        { name: 'UAC-0006', category: 'HackerGroup', role: 'Attacker' },
      ],
      relations: [
        // Software–Software: survives a Software-only filter
        {
          head: 'LummaStealer', headCategory: 'Software',
          tail: 'PikaBot', tailCategory: 'Software', type: 'used-with',
        },
        // HackerGroup–Software: one endpoint filtered → dropped
        {
          head: 'UAC-0006', headCategory: 'HackerGroup',
          tail: 'LummaStealer', tailCategory: 'Software', type: 'uses',
        },
      ],
      schemaProposals: [],
      metadata: { id: 1, title: 'test report', date: '2024-01-01' },
    })
  );

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await conceptRegistry.load();
  schemaRegistry.admitCategory({ name: 'Software', definition: '', doc: 0 });
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  await schemaRegistry.save();
  await conceptRegistry.save();

  const llm = cannedLlm();
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    ...(categories ? { categories } : {}),
  });
  return { dir, normalizer, llm, conceptRegistry };
}

describe('StreamingNormalizer CATEGORIES filter', () => {
  it('keeps only listed categories in registry and artifact, drops half-filtered relations', async () => {
    const { dir, normalizer, conceptRegistry } = await setup('filter', ['Software']);
    await normalizer.processFile('1.json');

    // NOTE: ConceptRegistry#snapshot() does not expose a `categories` map — `categories` is a
    // `() => string[]` accessor and per-category counts come from `size(category)`. Adapted per
    // the brief's fallback: assert through `resolve()` directly, which is null/undefined for a
    // category+name pair the registry never minted.
    const snapshot = conceptRegistry.snapshot();
    assert.ok(snapshot.categories().includes('Software'), 'Software entities minted');
    assert.equal(snapshot.size('Software'), 2, 'both Software mentions minted');
    assert.ok(!snapshot.categories().includes('HackerGroup'), 'HackerGroup never entered the registry');
    assert.equal(
      conceptRegistry.resolve('HackerGroup', 'UAC-0006'),
      undefined,
      'HackerGroup mention never resolves'
    );

    const artifact = JSON.parse(
      (await fs.readFile(path.join(dir, 'artifacts', '1.json'))).toString()
    );
    assert.deepEqual(
      artifact.entities.map((e: { name: string }) => e.name).sort(),
      ['LummaStealer', 'PikaBot']
    );
    assert.equal(artifact.relations.length, 1);
    assert.equal(artifact.relations[0].type, 'used-with');
  });

  it('is a no-op when categories is omitted', async () => {
    const { dir, normalizer, conceptRegistry } = await setup('noop');
    await normalizer.processFile('1.json');

    const snapshot = conceptRegistry.snapshot();
    assert.ok(snapshot.categories().includes('HackerGroup'), 'HackerGroup minted as before');
    assert.equal(
      conceptRegistry.resolve('HackerGroup', 'UAC-0006'),
      'UAC-0006',
      'HackerGroup mention resolves as before'
    );

    const artifact = JSON.parse(
      (await fs.readFile(path.join(dir, 'artifacts', '1.json'))).toString()
    );
    assert.equal(artifact.entities.length, 3);
    assert.equal(artifact.relations.length, 2);
  });

  it('treats omitted relations as empty in a filtered frozen extraction', async () => {
    const { dir, normalizer } = await setup('no-relations', ['Software']);
    const extractionPath = path.join(dir, 'extractions', '1.json');
    const extraction = JSON.parse(await fs.readFile(extractionPath, 'utf8'));
    delete extraction.relations;
    await fs.writeFile(extractionPath, JSON.stringify(extraction));

    await normalizer.processFile('1.json');

    const artifact = JSON.parse(await fs.readFile(path.join(dir, 'artifacts', '1.json'), 'utf8'));
    assert.deepEqual(artifact.relations, []);
  });

  it('does not discover role-based pair rules during entity normalization', async () => {
    const { normalizer, llm } = await setup('no-pair-rules');
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 0, 'no candidates means normalization needs no LLM call');
    const schema = JSON.parse(
      await fs.readFile(path.join(normalizer.outputDir, '..', 'schema.json'), 'utf8')
    );
    assert.deepEqual(schema.pairRules, []);
  });
});
