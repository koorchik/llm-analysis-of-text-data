import type { CostMeter } from '../Experiment/CostMeter';
import type { EmbeddingCache, EmbeddingCacheStats } from './EmbeddingCache';
import type {
  EmbeddingCallOptions,
  EmbeddingsBackendBase,
  EmbeddingsResponse,
} from './EmbeddingsBackendBase';

/** Attribution for the cost meter, mirroring `LlmSendOptions`. */
export interface EmbedOptions extends EmbeddingCallOptions {
  operator?: string;
  docId?: number | null;
}

interface Args {
  backend: EmbeddingsBackendBase;
  costMeter?: CostMeter;
  cache?: EmbeddingCache;
  /** Inputs per provider request. Large batches are cheaper; too large and the provider rejects. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 96;

export class EmbeddingsClient {
  #backend: EmbeddingsBackendBase;
  #costMeter?: CostMeter;
  #cache?: EmbeddingCache;
  #batchSize: number;
  #dimensions: number | null = null;

  constructor(args: Args) {
    this.#backend = args.backend;
    this.#costMeter = args.costMeter;
    this.#cache = args.cache;
    this.#batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * One text in, one vector out; many in, many out **in input order**.
   *
   * The overloads exist so the pre-M5 single-string call sites keep working unchanged while the
   * batch path — the one that matters, since both OpenAI and Ollama batch natively and the
   * one-at-a-time loop was pure waste — is the same method.
   */
  async embed(input: string, options?: EmbedOptions): Promise<number[]>;
  async embed(input: string[], options?: EmbedOptions): Promise<number[][]>;
  async embed(input: string | string[], options: EmbedOptions = {}): Promise<number[] | number[][]> {
    const single = typeof input === 'string';
    const inputs = single ? [input] : input;
    const vectors = await this.#embedMany(inputs, options);
    return single ? vectors[0] : vectors;
  }

  async #embedMany(inputs: string[], options: EmbedOptions): Promise<number[][]> {
    const { operator, docId, ...callOptions } = options;

    // De-duplicate by text before consulting the cache, so a repeated surface costs one lookup and
    // one embedding rather than N. The registry hands the same surface to several canonicals often
    // enough that this is a real saving, not a hypothetical one — and it keeps `cacheStats` honest,
    // since counting one text twice would understate the hit rate.
    const resolved = new Map<string, number[] | null>();
    for (const text of inputs) {
      if (resolved.has(text)) continue;
      resolved.set(text, this.#cache?.get(text) ?? null);
    }

    const missing = [...resolved].filter(([, vector]) => vector === null).map(([text]) => text);
    for (let start = 0; start < missing.length; start += this.#batchSize) {
      const chunk = missing.slice(start, start + this.#batchSize);
      const response = await this.#send(chunk, callOptions, operator, docId);
      chunk.forEach((text, index) => {
        const vector = response.vectors[index];
        resolved.set(text, vector);
        this.#cache?.set(text, vector);
      });
    }

    return inputs.map((text) => resolved.get(text)!);
  }

  async #send(
    chunk: string[],
    callOptions: EmbeddingCallOptions,
    operator?: string,
    docId?: number | null
  ): Promise<EmbeddingsResponse> {
    try {
      const response = await this.#backend.embed(chunk, callOptions);

      // Metered after the await and inside the try, so a throw is never recorded as a success —
      // the property `LlmClient` is tested for, and the same one matters here.
      this.#costMeter?.record({
        operator: operator ?? 'embed',
        docId: docId ?? null,
        provider: this.#backend.provider,
        model: response.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      if (this.#dimensions === null) this.#dimensions = response.dimensions;
      else if (this.#dimensions !== response.dimensions) {
        // A mid-run dimension change means the encoder changed under us. Every vector already in
        // the index is now incomparable, and cosine would throw far from the cause.
        throw new Error(
          `EmbeddingsClient: ${this.#backend.model} returned ${response.dimensions} dimensions ` +
            `after ${this.#dimensions} — the encoder changed mid-run`
        );
      }

      return response;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  get modelName(): string {
    return this.#backend.model;
  }

  get provider(): string {
    return this.#backend.provider;
  }

  /** Backend configuration, verbatim, for the run card. */
  get config(): Record<string, unknown> {
    return this.#backend.config;
  }

  /** Null until the first call — the encoder is the authority on its own width, not the config. */
  get dimensions(): number | null {
    return this.#dimensions;
  }

  /**
   * Cache hits are **not** CostMeter records, so a fully-cached run reports zero embedding calls.
   * That is only legible next to these counters — otherwise "no embedding calls" reads as
   * "embeddings never happened".
   */
  get cacheStats(): EmbeddingCacheStats | null {
    return this.#cache?.stats ?? null;
  }
}
