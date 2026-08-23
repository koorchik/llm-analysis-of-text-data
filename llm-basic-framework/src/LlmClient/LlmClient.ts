import type { CostMeter } from '../Experiment/CostMeter';
import type {
  LlmBackendBase,
  LlmCallOptions,
  LlmResponse,
  LlmSamplingSupport,
} from './LlmClientBackendBase';
import type { LlmCallHandle, LlmCallLog } from './LlmCallLog';

/**
 * Sampling parameters plus the cost-attribution context for one call.
 * `operator` and `docId` are what CostMeter keys on — an unattributed call still meters,
 * but lands in the `unknown` / `none` buckets, so pass them.
 */
export interface LlmSendOptions extends LlmCallOptions {
  operator?: string;
  docId?: number | null;
}

interface Args {
  backend: LlmBackendBase;
  costMeter?: CostMeter;
  /** Sampling defaults applied to every call unless the call overrides them. */
  defaultCallOptions?: LlmCallOptions;
  /**
   * Full-fidelity transcripts (spec 2026-08-17). Injected here rather than at call sites: every
   * operator in the codebase already funnels through `send`, so this covers all of them, including
   * ones added later.
   */
  callLog?: LlmCallLog;
}

export class LlmClient {
  #backend: LlmBackendBase;
  #costMeter?: CostMeter;
  #defaults: LlmCallOptions;
  #callLog?: LlmCallLog;
  #lastHandle: LlmCallHandle | null = null;

  constructor(args: Args) {
    this.#backend = args.backend;
    this.#costMeter = args.costMeter;
    this.#defaults = args.defaultCallOptions ?? {};
    this.#callLog = args.callLog;
  }

  /**
   * Returns the full response, not a bare string. Call sites that only need the text read
   * `.text`; the rest of the shape is what makes a run costable and reproducible.
   */
  async send(
    instructions: string,
    text: string,
    options: LlmSendOptions = {}
  ): Promise<LlmResponse> {
    const { operator, docId, ...callOptions } = options;
    const effective = this.#resolveOptions(callOptions);
    this.#lastHandle = null;

    try {
      const response = await this.#backend.send(instructions, text, effective);

      this.#costMeter?.record({
        operator: operator ?? 'unknown',
        docId: docId ?? null,
        provider: this.#backend.provider,
        model: response.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      this.#lastHandle =
        (await this.#callLog?.write({
          operator: operator ?? 'unknown',
          docId: docId ?? null,
          provider: this.#backend.provider,
          model: response.model,
          sampling: effective as Record<string, unknown>,
          instructions,
          text,
          response: response.text,
          usage: response.usage,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason ?? undefined,
        })) ?? null;

      return response;
    } catch (error) {
      // A failed call is the most interesting one to inspect, so it is transcribed too — then the
      // original error is re-thrown, leaving every caller's never-abort posture untouched.
      await this.#callLog?.write({
        operator: operator ?? 'unknown',
        docId: docId ?? null,
        provider: this.#backend.provider,
        model: this.#backend.model,
        sampling: effective as Record<string, unknown>,
        instructions,
        text,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.trim() : String(error),
      });
      console.error(error);
      throw error;
    }
  }

  /**
   * Drops sampling parameters the backend cannot accept, rather than forwarding them into a
   * 400. Anthropic is the live case: on Opus 4.7+ a non-default `temperature` is rejected
   * outright, so a shared `temperature: 0` default must not reach it.
   */
  #resolveOptions(options: LlmCallOptions): LlmCallOptions {
    const merged: LlmCallOptions = { ...this.#defaults, ...options };
    const support = this.#backend.sampling;
    const out: LlmCallOptions = {};

    if (merged.maxTokens !== undefined) out.maxTokens = merged.maxTokens;
    if (merged.temperature !== undefined && support.temperature) out.temperature = merged.temperature;
    if (merged.topP !== undefined && support.topP) out.topP = merged.topP;
    if (merged.seed !== undefined && support.seed) out.seed = merged.seed;
    // Passed through untouched: only the ollama backend reads it, others ignore unknown options.
    if (merged.think !== undefined) out.think = merged.think;

    return out;
  }

  /** What the backend will actually honour — recorded verbatim in the run card. */
  get sampling(): LlmSamplingSupport {
    return this.#backend.sampling;
  }

  /**
   * The sampling parameters this client will really send, after dropping unsupported ones.
   * The run card records this rather than the requested config, so it cannot claim a
   * `temperature: 0` that never left the process.
   */
  get effectiveDefaults(): LlmCallOptions {
    return this.#resolveOptions({});
  }

  get provider(): string {
    return this.#backend.provider;
  }

  get modelName() {
    return this.#backend.model;
  }

  get costMeter(): CostMeter | undefined {
    return this.#costMeter;
  }

  get callLog(): LlmCallLog | undefined {
    return this.#callLog;
  }

  /**
   * The transcript handle of the most recent `send`, or null when logging is off or the call
   * threw. A judge that validates the response annotates it through this.
   */
  lastCallHandle(): LlmCallHandle | null {
    return this.#lastHandle;
  }
}
