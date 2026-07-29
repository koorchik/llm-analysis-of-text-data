import {
  assertVectorCount,
  EmbeddingsBackendBase,
  type EmbeddingCallOptions,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';
import OpenAI from 'openai';

export class EmbeddingsBackendOpenAi implements EmbeddingsBackendBase {
  #openAiClient: OpenAI;
  model: string;
  readonly provider = 'openai';
  readonly config: Record<string, unknown>;

  #dimensions?: number;

  constructor(args: { apiKey: string; model: string; dimensions?: number }) {
    this.model = args.model;
    this.#dimensions = args.dimensions;
    this.#openAiClient = new OpenAI({ apiKey: args.apiKey });
    this.config = {
      provider: this.provider,
      model: this.model,
      dimensions: this.#dimensions ?? null,
    };
  }

  async embed(inputs: string[], options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    const started = Date.now();
    const dimensions = options.dimensions ?? this.#dimensions;

    const response = await this.#openAiClient.embeddings.create({
      input: inputs,
      model: this.model,
      ...(dimensions !== undefined ? { dimensions } : {}),
    });

    // `data` carries an explicit `index` because order is not guaranteed over the wire. A silently
    // permuted batch would attach every vector to the wrong surface — a bug that surfaces as a
    // mysteriously poor recall number rather than as an error. Sort rather than trust.
    const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    assertVectorCount('EmbeddingsBackendOpenAi', inputs, vectors);

    return {
      vectors,
      // An embedding has no completion: the response carries `prompt_tokens`/`total_tokens` only.
      usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: 0 },
      model: response.model || this.model,
      latencyMs: Date.now() - started,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}
