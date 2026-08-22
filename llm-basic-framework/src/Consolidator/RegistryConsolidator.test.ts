import { RegistryConsolidator } from './RegistryConsolidator';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

/**
 * The SKEIN v2 repair inventory through the real consolidator: merge / edge / rename / split,
 * defer-queue consumption, the cross-category sweep, and the matchedVia re-stamp.
 */

let counter = 0;
async function scratchDir(): Promise<string> {
  const key = crypto.createHash('sha256').update(`consolidator${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `consolidator-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

/** Replays canned responses in call order; repeats the last one when calls exceed replies. */
function cannedLlm(replies: string[]) {
  let call = 0;
  const client = {
    async send() {
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
  return { client: client as unknown as LlmClient, calls: () => call };
}

const EMPTY_REVIEW = JSON.stringify({ merges: [], edges: [], renames: [], splits: [] });

async function setup(replies: string[]) {
  const dir = await scratchDir();
  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await conceptRegistry.load();

  const llm = cannedLlm(replies);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const consolidator = new RegistryConsolidator({
    artifactsDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
  });
  return { dir, consolidator, schemaRegistry, conceptRegistry, llm };
}

async function readLog(dir: string) {
  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8').catch(() => '');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('review verdicts apply: merge, granularity edge, rename — each with consolidator provenance', async () => {
  const review = JSON.stringify({
    merges: [{ from: 'Sandworm Team', into: 'Sandworm' }],
    edges: [{ finer: 'UAC-0002', coarser: 'Sandworm', kind: 'part-of' }],
    renames: [{ old: 'Sandworm', new: 'APT44' }],
    splits: [],
  });
  const { dir, consolidator, conceptRegistry } = await setup([review, EMPTY_REVIEW]);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.mint('HackerGroup', 'Sandworm Team', { doc: 2, date: '01.01.2024' });
  conceptRegistry.mint('HackerGroup', 'UAC-0002', { doc: 3, date: '01.01.2024' });
  conceptRegistry.mint('HackerGroup', 'APT44', { doc: 4, date: '01.01.2024' });
  await conceptRegistry.save();

  await consolidator.run();

  assert.equal(conceptRegistry.resolve('HackerGroup', 'Sandworm Team'), 'Sandworm', 'merged');
  const edges = conceptRegistry.broaderEdges('HackerGroup');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, 'broaderPartitive', 'the review reply\'s legacy kind maps onto the ISO 25964 typing');
  assert.equal(edges[0].decision, 'consolidator');
  const renames = conceptRegistry.renameEdges('HackerGroup');
  assert.equal(renames.length, 1);
  assert.equal(renames[0].to, 'APT44');

  const ops = (await readLog(dir)).map((event) => event.op);
  for (const op of ['merge-canonical', 'broader-edge', 'rename-edge']) {
    assert.ok(ops.includes(op), `${op} logged`);
  }
});

test('split detaches aliases and the matchedVia re-stamp moves exactly their mentions', async () => {
  const review = JSON.stringify({
    merges: [],
    edges: [],
    renames: [],
    splits: [{ canonical: 'Sandworm', detach: ['Voodoo Bear'] }],
  });
  const { dir, consolidator, conceptRegistry, schemaRegistry } = await setup([review, EMPTY_REVIEW]);

  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 2 });
  // A second, similar canonical so the pairwise scan makes the category suspicious at all.
  conceptRegistry.mint('HackerGroup', 'Sandworms', { doc: 3, date: '01.01.2024' });
  await conceptRegistry.save();
  await schemaRegistry.save();

  // Two mentions of the same canonical, matched via different aliases: only the detached one moves.
  await fs.writeFile(
    path.join(dir, 'artifacts', '1.json'),
    JSON.stringify({
      entities: [
        {
          name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker',
          normalizedName: 'Sandworm', matchedVia: 'Voodoo Bear',
        },
        {
          name: 'Sandworm', category: 'HackerGroup', role: 'Attacker',
          normalizedName: 'Sandworm', matchedVia: 'Sandworm',
        },
      ],
      relations: [],
      schemaProposals: { categories: [], relationTypes: [] },
      metadata: { id: 1 },
    })
  );

  await consolidator.run();

  assert.equal(
    conceptRegistry.resolve('HackerGroup', 'Voodoo Bear'),
    'Voodoo Bear',
    'detached alias became its own canonical'
  );
  const artifact = JSON.parse(await fs.readFile(path.join(dir, 'artifacts', '1.json'), 'utf8'));
  assert.equal(artifact.entities[0].normalizedName, 'Voodoo Bear', 'moved by matchedVia');
  assert.equal(artifact.entities[1].normalizedName, 'Sandworm', 'stayed by matchedVia');
});

test('deferred pairs reach the review even when similarity would not flag them, then clear', async () => {
  const { consolidator, conceptRegistry, llm } = await setup([EMPTY_REVIEW]);

  conceptRegistry.mint('HackerGroup', 'UAC-0002', { doc: 1, date: '01.01.2024' });
  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 2, date: '01.01.2024' });
  conceptRegistry.pushDeferred({
    category: 'HackerGroup',
    mention: 'UAC-0002',
    mintedAs: 'UAC-0002',
    candidates: ['Sandworm'],
    docId: 3,
  });
  await conceptRegistry.save();

  await consolidator.run();

  assert.ok(llm.calls() >= 1, 'the dissimilar deferred pair still triggered a review call');
  assert.equal(conceptRegistry.deferred().length, 0, 'reviewed defers are consumed');
});

test('cross-category sweep merges a shared-surface duplicate and records the category correction', async () => {
  const crossReview = JSON.stringify({
    merges: [{ from: 'Organization/Sandworm', into: 'HackerGroup/Sandworm' }],
    edges: [],
    renames: [],
    splits: [],
  });
  // Call order: no per-category suspects (single dissimilar entries) → cross-category call first.
  const { dir, consolidator, conceptRegistry } = await setup([crossReview, EMPTY_REVIEW]);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.mint('Organization', 'Sandworm', { doc: 2, date: '01.01.2024' });
  await conceptRegistry.save();

  await consolidator.run();

  assert.equal(conceptRegistry.concepts('Organization').Sandworm, undefined, 'moved out');
  assert.ok(conceptRegistry.concepts('HackerGroup').Sandworm, 'kept under the corrected category');
  const corrections = (await readLog(dir)).filter((event) => event.op === 'category-correction');
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].from.category, 'Organization');
  assert.equal(corrections[0].into.category, 'HackerGroup');
});
