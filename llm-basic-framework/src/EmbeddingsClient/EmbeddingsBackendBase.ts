// M5 instrumentation: the embeddings path gets the contract M1 gave the LLM path.
//
// Before M5 this was `embed(text: string): Promise<number[]>` — a bare value returned one line
// after the provider's `usage` was discarded, which is verbatim the shape M1's header comment
// describes as the thing it removed. No embedding call could be costed, none could be attributed
// to an operator, and the encoder that produced a vector was not recorded anywhere.

import type { LlmUsage } from '../LlmClient/LlmClientBackendBase';

/**
 * Per-call options. As in `LlmCallOptions`, **the optionality is load-bearing**: `undefined` means
 * "do not send this parameter", which is not the same as sending a default. Only OpenAI honours
 * `dimensions` (Matryoshka truncation) and only Ollama honours `truncate`; a backend drops what it
 * cannot accept rather than forwarding it into a 400.
 */
export interface EmbeddingCallOptions {
  dimensions?: number;
  truncate?: boolean;
}

export interface EmbeddingsResponse {
  /** One vector per input, **in input order**. Providers may return them out of order. */
  vectors: number[][];
  /**
   * Embeddings have no completion, so `outputTokens` is always 0. This is `LlmUsage` rather than a
   * parallel type because `CostMeter.record` takes exactly that interface — see the pricing note in
   * `config/model-prices.json`.
   */
  usage: LlmUsage;
  /** `response.model || this.model` — the dated-snapshot id, which is what CostMeter prices on. */
  model: string;
  latencyMs: number;
  dimensions: number;
}

export abstract class EmbeddingsBackendBase {
  /**
   * Always a batch. `EmbeddingsClient` normalizes a single string to a one-element array, so no
   * backend reimplements that and no call site can reintroduce the per-item loop — which is pure
   * waste, since both OpenAI and Ollama batch natively.
   */
  abstract embed(inputs: string[], options?: EmbeddingCallOptions): Promise<EmbeddingsResponse>;
  abstract model: string;
  abstract readonly provider: string;
  /** Recorded in the run card, so an encoder arm can be told apart by more than its model id. */
  abstract readonly config: Record<string, unknown>;
}

/** Providers must return exactly one vector per input, or the positional alignment is a lie. */
export function assertVectorCount(backend: string, inputs: string[], vectors: number[][]): void {
  if (vectors.length !== inputs.length) {
    throw new Error(
      `${backend}: expected ${inputs.length} vectors, got ${vectors.length}. ` +
        'Vectors are positionally aligned with inputs; a mismatch would silently mis-assign them.'
    );
  }
}
