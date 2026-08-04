import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';

/**
 * Gemini API backend (Google AI Studio, `generativelanguage.googleapis.com`), keyed by
 * `GEMINI_API_KEY` — distinct from `LlmClientBackendVertexAi`, which reaches Gemini through a
 * GCP project + service account. This one exists so the gold cross-annotator can come from a
 * model family outside the systems under test (GOLD-TABLE.md §7.1) with nothing but an API key.
 *
 * Plain `fetch` against the REST endpoint, no SDK: the call shape is three JSON fields, and an
 * injectable `fetchFn` keeps the tests offline.
 */

interface GeminiPart {
  text?: string;
  /** True on reasoning parts of thinking models — never part of the answer. */
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

export class LlmClientBackendGemini implements LlmBackendBase {
  model: string;
  readonly provider = 'gemini';

  readonly sampling: LlmSamplingSupport = {
    temperature: true,
    seed: false,
    topP: true,
    note: 'generationConfig temperature/topP supported; no seed parameter on the Gemini API.',
  };

  #apiKey: string;
  #fetchFn: typeof fetch;
  #baseUrl: string;

  constructor(args: { apiKey: string; model: string; fetchFn?: typeof fetch; baseUrl?: string }) {
    this.model = args.model;
    this.#apiKey = args.apiKey;
    this.#fetchFn = args.fetchFn ?? fetch;
    this.#baseUrl = args.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    const generationConfig: Record<string, number> = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.topP !== undefined) generationConfig.topP = options.topP;
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;

    const response = await this.#fetchFn(
      `${this.#baseUrl}/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.#apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: instructions }] },
          contents: [{ role: 'user', parts: [{ text }] }],
          ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (!candidate) {
      // A safety block or empty answer must throw, not return '': the annotator's posture for a
      // failed batch is unsure-and-route-to-human, which only triggers on an error.
      throw new Error(
        `Gemini returned no candidates${data.promptFeedback?.blockReason ? ` (blockReason: ${data.promptFeedback.blockReason})` : ''}`
      );
    }

    const answer = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    return {
      text: answer,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: data.modelVersion || this.model,
      latencyMs: Date.now() - started,
      finishReason: candidate.finishReason ?? null,
    };
  }
}
