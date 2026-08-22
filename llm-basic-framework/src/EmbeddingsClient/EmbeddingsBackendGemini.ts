import {
  assertVectorCount,
  EmbeddingsBackendBase,
  type EmbeddingCallOptions,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';

/**
 * Gemini API embeddings (Google AI Studio, `generativelanguage.googleapis.com`), keyed by
 * `GEMINI_API_KEY` — the encoder-side sibling of `LlmClientBackendGemini`, and distinct from
 * `EmbeddingsBackendVertexAi`, which reaches Google encoders through a GCP project. Exists so the
 * embeddinggemma vs gemini-embedding encoder comparison can run with nothing but the API key the
 * judge already uses.
 *
 * Plain `fetch` against the REST `:batchEmbedContents` endpoint, no SDK — same doctrine as the LLM
 * backend: the call shape is small, and an injectable `fetchFn` keeps the tests offline.
 *
 * The API reports no token usage for embeddings, so `inputTokens` is 0 and cost accounting relies
 * on the call counters (`EmbeddingsClient.cacheStats`) rather than token totals.
 */

interface GeminiEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

export class EmbeddingsBackendGemini implements EmbeddingsBackendBase {
  model: string;
  readonly provider = 'gemini';
  readonly config: Record<string, unknown>;

  #apiKey: string;
  #baseUrl: string;
  #fetchFn: typeof fetch;

  constructor(args: { model: string; apiKey: string; fetchFn?: typeof fetch; baseUrl?: string }) {
    this.model = args.model;
    this.#apiKey = args.apiKey;
    this.#fetchFn = args.fetchFn ?? fetch;
    this.#baseUrl = args.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.config = { provider: this.provider, model: this.model };
  }

  async embed(inputs: string[], _options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    const started = Date.now();
    const modelPath = this.model.startsWith('models/') ? this.model : `models/${this.model}`;

    const response = await this.#fetchFn(
      `${this.#baseUrl}/${modelPath}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.#apiKey,
        },
        body: JSON.stringify({
          requests: inputs.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
          })),
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini embeddings HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const parsed = (await response.json()) as GeminiEmbedResponse;
    if (parsed.error?.message) {
      throw new Error(`Gemini embeddings error: ${parsed.error.message}`);
    }
    const vectors = (parsed.embeddings ?? []).map((embedding) => embedding.values ?? []);
    assertVectorCount('EmbeddingsBackendGemini', inputs, vectors);

    return {
      vectors,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
      latencyMs: Date.now() - started,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}
