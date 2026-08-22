import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { LlmCallLog } from '../LlmClient/LlmCallLog';
import { LlmClient } from '../LlmClient/LlmClient';
import type { LlmBackendBase } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`nlog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `normalizer-calllog-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function backendReturning(text: string) {
  return {
    provider: 'fakeprovider',
    model: 'fakemodel',
    sampling: { temperature: true, topP: true, seed: true },
    async send() {
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fakemodel',
        latencyMs: 1,
        finishReason: 'stop' as const,
      };
    },
  } as unknown as LlmBackendBase;
}

describe('link-judge transcript outcome', () => {
  it('marks the transcript FAILED when the judge response is unusable', async () => {
    const dir = await scratchDir('badjson');
    await fs.writeFile(
      path.join(dir, 'extractions', '1.json'),
      JSON.stringify({
        entities: [{ name: 'UAC-0002', category: 'HackerGroup', role: 'Attacker' }],
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
    // A near-miss candidate so the judge is actually consulted.
    conceptRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
    await schemaRegistry.save();
    await conceptRegistry.save();

    const callLog = new LlmCallLog({ dir: path.join(dir, 'llm-calls') });
    // Valid HTTP, useless body — the exact failure mode the feature exists for.
    const llmClient = new LlmClient({ backend: backendReturning('I am not JSON at all'), callLog });
    const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });

    const normalizer = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient,
      schemaRegistry,
      conceptRegistry,
      decisionLog,
    });

    await normalizer.processFile('1.json');

    // Doc folders are numbered by processing order: the first document processed is `001-<docId>`.
    const files = await fs.readdir(path.join(dir, 'llm-calls', '001-1'));
    const judged = files.filter((name) => name.includes('link-judge') && name.endsWith('.json'));
    assert.ok(judged.length > 0, 'a link-judge transcript was written');
    assert.ok(
      judged.every((name) => name.includes('.FAILED.')),
      `expected FAILED marking, got ${judged.join(', ')}`
    );
    // and the document still completed — never-abort posture unchanged
    assert.ok(existsSync(path.join(dir, 'artifacts', '1.json')));
  });
});
