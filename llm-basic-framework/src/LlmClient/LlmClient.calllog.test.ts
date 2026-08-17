import { LlmCallLog } from './LlmCallLog';
import { LlmClient } from './LlmClient';
import type { LlmBackendBase } from './LlmClientBackendBase';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`clientlog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `llm-client-log-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

/** A backend that answers, or throws, and records what sampling it was handed. */
function fakeBackend(options: { throws?: Error } = {}) {
  const seen: unknown[] = [];
  const backend = {
    provider: 'fakeprovider',
    model: 'fakemodel',
    // Deliberately rejects temperature — the log must record what was SENT, not what was asked for.
    sampling: { temperature: false, topP: true, seed: false },
    async send(_instructions: string, _text: string, effective: unknown) {
      seen.push(effective);
      if (options.throws) throw options.throws;
      return {
        text: '{"ok": true}',
        usage: { inputTokens: 11, outputTokens: 22 },
        model: 'fakemodel',
        latencyMs: 1500,
        finishReason: 'stop' as const,
      };
    },
  };
  return { backend: backend as unknown as LlmBackendBase, seen };
}

describe('LlmClient → LlmCallLog', () => {
  it('writes a transcript for a successful call, recording effective sampling', async () => {
    const dir = await scratchDir('ok');
    const { backend } = fakeBackend();
    const client = new LlmClient({
      backend,
      callLog: new LlmCallLog({ dir }),
      defaultCallOptions: { temperature: 0, topP: 0.9 },
    });

    await client.send('INSTRUCTIONS', 'TEXT', { operator: 'link-judge', docId: 42 });

    const file = path.join(dir, '001-42', '001-link-judge.json');
    assert.ok(existsSync(file));
    const parsed = JSON.parse((await fs.readFile(file)).toString());
    assert.equal(parsed.provider, 'fakeprovider');
    assert.equal(parsed.instructions, 'INSTRUCTIONS');
    assert.equal(parsed.text, 'TEXT');
    assert.equal(parsed.response, '{"ok": true}');
    assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 22 });
    // temperature was dropped by the backend's sampling support, so it must NOT appear
    assert.equal(parsed.sampling.temperature, undefined);
    assert.equal(parsed.sampling.topP, 0.9);
  });

  it('writes a FAILED transcript when the backend throws, and still re-throws', async () => {
    const dir = await scratchDir('throw');
    const { backend } = fakeBackend({ throws: new Error('ECONNRESET') });
    const client = new LlmClient({ backend, callLog: new LlmCallLog({ dir }) });

    await assert.rejects(
      () => client.send('I', 'T', { operator: 'repair-judge', docId: 7 }),
      /ECONNRESET/
    );

    const file = path.join(dir, '001-7', '001-repair-judge.FAILED.json');
    assert.ok(existsSync(file));
    const parsed = JSON.parse((await fs.readFile(file)).toString());
    assert.match(parsed.error, /ECONNRESET/);
    assert.equal(parsed.response, undefined);
  });

  it('works with no callLog injected (existing behaviour unchanged)', async () => {
    const { backend } = fakeBackend();
    const client = new LlmClient({ backend });
    const response = await client.send('I', 'T', { operator: 'ladder', docId: null });
    assert.equal(response.text, '{"ok": true}');
    assert.equal(client.lastCallHandle(), null);
  });

  it('exposes the handle of the last call for outcome annotation', async () => {
    const dir = await scratchDir('handle');
    const { backend } = fakeBackend();
    const client = new LlmClient({ backend, callLog: new LlmCallLog({ dir }) });

    await client.send('I', 'T', { operator: 'link-judge', docId: 5 });
    assert.deepEqual(client.lastCallHandle(), {
      docId: 5,
      seq: 1,
      operator: 'link-judge',
      folder: '001-5',
    });

    await client.callLog!.logOutcome(client.lastCallHandle(), { ok: false, detail: 'bad json' });
    assert.ok(existsSync(path.join(dir, '001-5', '001-link-judge.FAILED.json')));
  });
});
