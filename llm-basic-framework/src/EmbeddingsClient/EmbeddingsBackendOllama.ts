import {
  assertVectorCount,
  EmbeddingsBackendBase,
  type EmbeddingCallOptions,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';
import { Ollama } from 'ollama';

/**
 * Self-hosted encoders — the arm that satisfies the confidentiality constraint (BGE-M3).
 *
 * Pre-M5 this imported the default `ollama` singleton, so unlike `LlmClientBackendOllama` it could
 * only ever reach `localhost`: an `OLLAMA_API_KEY` in the environment had no effect and a hosted
 * endpoint was silently unreachable. The constructor now mirrors the LLM backend's.
 */
export class EmbeddingsBackendOllama implements EmbeddingsBackendBase {
  model: string;
  readonly provider = 'ollama';
  readonly config: Record<string, unknown>;

  ollama: Ollama;
  #host?: string;

  constructor(args: { model: string; apiKey?: string; host?: string }) {
    this.model = args.model;
    this.#host = args.host;

    this.ollama = args.host
      ? new Ollama({
          host: args.host,
          ...(args.apiKey ? { headers: { Authorization: `Bearer ${args.apiKey}` } } : {}),
        })
      : new Ollama();

    this.config = { provider: this.provider, model: this.model, host: this.#host ?? 'default' };
  }

  async embed(inputs: string[], options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    const started = Date.now();

    const response = await this.ollama.embed({
      model: this.model,
      input: inputs,
      ...(options.truncate !== undefined ? { truncate: options.truncate } : {}),
    });

    const vectors = response.embeddings;
    assertVectorCount('EmbeddingsBackendOllama', inputs, vectors);

    return {
      vectors,
      // `prompt_eval_count` covers the whole batch's input; there is no completion.
      usage: { inputTokens: response.prompt_eval_count ?? 0, outputTokens: 0 },
      model: response.model || this.model,
      latencyMs: Date.now() - started,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}
