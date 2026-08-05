import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LlmClientBackendOllama, numCtxFromModelTag } from './LlmClientBackendOllama';

describe('numCtxFromModelTag', () => {
  it('reads the window a local arm tag advertises', () => {
    assert.strictEqual(numCtxFromModelTag('gemma4:e2b-8k'), 8192);
    assert.strictEqual(numCtxFromModelTag('gemma4:e2b-16k'), 16384);
    assert.strictEqual(numCtxFromModelTag('gemma4:e4b-32k'), 32768);
  });

  it('is case-insensitive about the suffix', () => {
    assert.strictEqual(numCtxFromModelTag('gemma4:e2b-8K'), 8192);
  });

  it('returns undefined when the tag advertises no window', () => {
    assert.strictEqual(numCtxFromModelTag('gemma4:e2b'), undefined);
    assert.strictEqual(numCtxFromModelTag('gemma4:e4b-cracked'), undefined);
  });

  it('does not mistake a parameter count for a window', () => {
    // `gpt-oss:20b` is 20 billion parameters, not a 20k context.
    assert.strictEqual(numCtxFromModelTag('gpt-oss:20b'), undefined);
    assert.strictEqual(numCtxFromModelTag('llama3.1:70b'), undefined);
  });
});

describe('LlmClientBackendOllama num_ctx resolution', () => {
  it('prefers an explicit numCtx over the tag', () => {
    const backend = new LlmClientBackendOllama({ model: 'gemma4:e2b-8k', numCtx: 4096 });
    assert.strictEqual(backend.numCtx, 4096);
  });

  it('falls back to the tag when nothing is passed', () => {
    assert.strictEqual(new LlmClientBackendOllama({ model: 'gemma4:e2b-8k' }).numCtx, 8192);
  });

  it('keeps the 32k default for tags that advertise nothing', () => {
    assert.strictEqual(new LlmClientBackendOllama({ model: 'gemma4:e2b' }).numCtx, 32768);
  });
});
