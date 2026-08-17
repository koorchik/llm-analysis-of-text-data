import { LlmCallLog } from './LlmCallLog';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`calllog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `llm-call-log-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    operator: 'link-judge',
    docId: 2660,
    provider: 'ollama',
    model: 'gemma4:e2b-16k',
    sampling: { maxTokens: 64000 },
    instructions: 'You are a link judge.\nCandidates:\n1. Sandworm',
    text: 'Adjudicate.',
    response: '{"decisions": []}',
    usage: { inputTokens: 1203, outputTokens: 88 },
    latencyMs: 14400,
    finishReason: 'stop',
    ...overrides,
  } as Parameters<LlmCallLog['write']>[0];
}

describe('LlmCallLog', () => {
  it('writes a json/txt pair under <docId>/<NNN>-<operator>, numbered per document', async () => {
    const dir = await scratchDir('basic');
    const log = new LlmCallLog({ dir, runId: 'run-abc' });

    await log.write(record());
    await log.write(record({ operator: 'repair-judge' }));
    await log.write(record({ docId: 2707 }));

    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.json')));
    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.txt')));
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.json')));
    // numbering is per document, so doc 2707 starts at 001 again
    assert.ok(existsSync(path.join(dir, '2707', '001-link-judge.json')));

    const parsed = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.json'))).toString()
    );
    assert.equal(parsed.runId, 'run-abc');
    assert.equal(parsed.operator, 'link-judge');
    assert.equal(parsed.docId, 2660);
    assert.equal(parsed.seq, 1);
    assert.equal(parsed.model, 'gemma4:e2b-16k');
    assert.deepEqual(parsed.sampling, { maxTokens: 64000 });
    assert.equal(parsed.response, '{"decisions": []}');
    assert.ok(typeof parsed.timestamp === 'string');
  });

  it('writes prompts verbatim and unescaped into the txt rendering', async () => {
    const dir = await scratchDir('txt');
    const log = new LlmCallLog({ dir });
    await log.write(record());

    const txt = (await fs.readFile(path.join(dir, '2660', '001-link-judge.txt'))).toString();
    assert.match(txt, /=== REQUEST \(ollama gemma4:e2b-16k\) ===/);
    // multi-line instructions survive as real newlines, not \n escapes
    assert.ok(txt.includes('You are a link judge.\nCandidates:\n1. Sandworm'));
    assert.match(txt, /=== RESPONSE \(14\.4s, in 1203 \/ out 88 tok, stop\) ===/);
    assert.ok(txt.includes('{"decisions": []}'));
  });

  it('puts docId-less calls in _no-doc', async () => {
    const dir = await scratchDir('nodoc');
    const log = new LlmCallLog({ dir });
    await log.write(record({ docId: null, operator: 'ladder' }));
    assert.ok(existsSync(path.join(dir, '_no-doc', '001-ladder.json')));
  });

  it('marks a record carrying an error as FAILED', async () => {
    const dir = await scratchDir('err');
    const log = new LlmCallLog({ dir });
    await log.write(record({ response: undefined, error: 'ECONNRESET: socket hang up' }));

    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.FAILED.json')));
    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.FAILED.txt')));
    assert.ok(!existsSync(path.join(dir, '2660', '001-link-judge.json')));
    const parsed = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.FAILED.json'))).toString()
    );
    assert.match(parsed.error, /ECONNRESET/);
  });

  it('logOutcome annotates a success and renames the pair on failure', async () => {
    const dir = await scratchDir('outcome');
    const log = new LlmCallLog({ dir });

    const okHandle = await log.write(record());
    await log.logOutcome(okHandle, { ok: true, detail: '3 decisions accepted' });
    const okJson = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.json'))).toString()
    );
    assert.deepEqual(okJson.outcome, { ok: true, detail: '3 decisions accepted' });

    const badHandle = await log.write(record({ operator: 'repair-judge' }));
    await log.logOutcome(badHandle, { ok: false, detail: 'reviews schema failed' });
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.FAILED.json')));
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.FAILED.txt')));
    assert.ok(!existsSync(path.join(dir, '2660', '002-repair-judge.json')));
    const badTxt = (await fs.readFile(path.join(dir, '2660', '002-repair-judge.FAILED.txt'))).toString();
    assert.match(badTxt, /=== OUTCOME \(FAILED\) ===/);
    assert.ok(badTxt.includes('reviews schema failed'));
  });

  it('writes nothing when disabled, and returns a null handle', async () => {
    const dir = await scratchDir('off');
    const log = new LlmCallLog({ dir, enabled: false });
    const handle = await log.write(record());
    assert.equal(handle, null);
    assert.equal(existsSync(dir), false);
    // a null handle must be a safe no-op, not a crash
    await log.logOutcome(handle, { ok: false, detail: 'ignored' });
  });

  it('never throws when the directory cannot be written', async () => {
    const dir = await scratchDir('unwritable');
    // A FILE where the log wants a DIRECTORY: every mkdir/write beneath it fails with ENOTDIR.
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not a directory');

    const log = new LlmCallLog({ dir });
    const handle = await log.write(record());   // must not reject
    await log.logOutcome(handle, { ok: false, detail: 'also must not reject' });
  });
});
