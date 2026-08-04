import { LlmClientBackendGemini } from './LlmClientBackendGemini';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('LlmClientBackendGemini', () => {
  it('sends system_instruction + user text and parses text and usage', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const backend = new LlmClientBackendGemini({
      apiKey: 'k',
      model: 'gemini-3.1-pro-preview',
      fetchFn: async (url, init) => {
        captured = { url: String(url), init: init! };
        return okResponse({
          candidates: [
            { content: { parts: [{ text: '{"verdicts": []}' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
          modelVersion: 'gemini-3.1-pro-preview-001',
        });
      },
    });

    const response = await backend.send('instructions here', 'the pairs');
    assert.equal(response.text, '{"verdicts": []}');
    assert.equal(response.usage.inputTokens, 100);
    assert.equal(response.usage.outputTokens, 20);
    assert.equal(response.finishReason, 'STOP');

    assert.ok(captured!.url.includes('/models/gemini-3.1-pro-preview:generateContent'));
    assert.equal((captured!.init.headers as Record<string, string>)['x-goog-api-key'], 'k');
    const body = JSON.parse(String(captured!.init.body));
    assert.equal(body.system_instruction.parts[0].text, 'instructions here');
    assert.equal(body.contents[0].parts[0].text, 'the pairs');
  });

  it('joins text parts and skips thought parts', async () => {
    const backend = new LlmClientBackendGemini({
      apiKey: 'k',
      model: 'm',
      fetchFn: async () =>
        okResponse({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'internal reasoning', thought: true },
                  { text: '{"a":', thoughtSignature: 'sig' },
                  { text: ' 1}' },
                ],
              },
            },
          ],
        }),
    });
    const response = await backend.send('i', 't');
    assert.equal(response.text, '{"a": 1}');
  });

  it('throws on an API error so the annotator marks the batch unsure', async () => {
    const backend = new LlmClientBackendGemini({
      apiKey: 'k',
      model: 'm',
      fetchFn: async () =>
        ({ ok: false, status: 429, json: async () => ({}), text: async () => 'quota' }) as Response,
    });
    await assert.rejects(() => backend.send('i', 't'), /429/);
  });

  it('throws when the response carries no candidates (safety block)', async () => {
    const backend = new LlmClientBackendGemini({
      apiKey: 'k',
      model: 'm',
      fetchFn: async () => okResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    });
    await assert.rejects(() => backend.send('i', 't'), /SAFETY|no candidates/);
  });
});
