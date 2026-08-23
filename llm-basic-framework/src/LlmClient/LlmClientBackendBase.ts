// M1 instrumentation spine: every backend reports what a call cost and how it was sampled.
// Before M1 `send()` returned a bare string and threw away the provider's `usage` one line
// before returning it, so no run could be costed and no run card could record its sampling.

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Per-call sampling parameters. Every field is optional **and the optionality is
 * load-bearing** — `undefined` means "do not send this parameter to the provider",
 * which is not the same as sending a default value.
 *
 * Anthropic is the reason: on Claude Opus 4.7 and later, `temperature`/`top_p`/`top_k`
 * are removed from the API and any non-default value returns HTTP 400. Modelling
 * `temperature` as `number` with a `0` default would 400 every Anthropic call. See
 * docs/normalization-experiments-refactor.md (M1) for the full three-tier determinism story.
 */
export interface LlmCallOptions {
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  topP?: number;
  /** Per-call hidden-reasoning switch (ollama thinking models); overrides the backend default. */
  think?: boolean;
}

/** Why the provider stopped. Not normalised across providers — recorded verbatim. */
export type LlmFinishReason = string | null;

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  finishReason: LlmFinishReason;
}

/**
 * Which sampling parameters a backend actually accepts. The run card records this
 * alongside the values so a reader can tell "not requested" from "requested but
 * unsupported by this provider".
 */
export interface LlmSamplingSupport {
  temperature: boolean;
  seed: boolean;
  topP: boolean;
  /** Human-readable note for the run card, e.g. why temperature is unavailable. */
  note?: string;
}

export abstract class LlmBackendBase {
  abstract send(
    instructions: string,
    text: string,
    options?: LlmCallOptions
  ): Promise<LlmResponse>;
  abstract model: string;
  abstract readonly provider: string;
  abstract readonly sampling: LlmSamplingSupport;
}
