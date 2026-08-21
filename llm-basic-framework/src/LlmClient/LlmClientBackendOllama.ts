import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import { Ollama } from 'ollama';

const DEFAULT_NUM_CTX = 32768;

/**
 * The context window a local model tag advertises, e.g. `gemma4:e2b-8k` → 8192.
 *
 * Local arms are tagged by the window they were built for, but `options.num_ctx` OVERRIDES the
 * Modelfile — so sending the 32k default to an `-8k` tag silently allocates a 32k KV cache. On an
 * 8 GB card that spills the cache to CPU and makes the tag a lie about what actually ran. Reading
 * the window back off the tag keeps the model's name, the request, and the run card in agreement.
 *
 * Returns `undefined` for tags that advertise nothing (`gemma4:e2b`, `gpt-oss:20b`), which then
 * fall through to `DEFAULT_NUM_CTX` as before. `b`/`B` parameter-count suffixes are NOT windows.
 */
export function numCtxFromModelTag(model: string): number | undefined {
  const match = model.match(/-(\d+)k$/i);
  if (!match) return undefined;
  const window = Number(match[1]) * 1024;
  return Number.isFinite(window) && window > 0 ? window : undefined;
}

export class LlmClientBackendOllama implements LlmBackendBase {
  model: string;
  readonly provider = 'ollama';

  readonly sampling: LlmSamplingSupport = {
    temperature: true,
    seed: true,
    topP: true,
  };

  ollama: Ollama;
  #numCtx: number;
  /**
   * Whether the model may spend output tokens on hidden reasoning.
   *
   * Measured on `gemma4:12b-64k` deciding one document: 672 characters of answer against **9,910
   * reported output tokens** — ollama returns the reasoning in `message.thinking`, which never
   * reaches the parser but is billed, generated, and waited for. `undefined` leaves the model's
   * default alone so existing arms are unaffected.
   */
  #think?: boolean;

  /** The window actually requested per call — read by the run log so the arm is self-describing. */
  get numCtx(): number {
    return this.#numCtx;
  }

  get think(): boolean | undefined {
    return this.#think;
  }

  constructor(args: { model: string; apiKey?: string; numCtx?: number; think?: boolean }) {
    this.model = args.model;
    this.#numCtx = args.numCtx ?? numCtxFromModelTag(args.model) ?? DEFAULT_NUM_CTX;
    this.#think = args.think;

    this.ollama =
      args.apiKey && args.model.match(/gpt-oss/)
        ? new Ollama({
            host: 'https://ollama.com',
            headers: {
              Authorization: `Bearer ${args.apiKey}`,
            },
          })
        : new Ollama();
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    const response = await this.ollama.chat({
      model: this.model,
      ...(this.#think === undefined ? {} : { think: this.#think }),
      options: {
        num_ctx: this.#numCtx,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
      },
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: text },
      ],
    });

    return {
      text: response.message.content,
      usage: {
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
      },
      model: response.model || this.model,
      latencyMs: Date.now() - started,
      finishReason: response.done_reason ?? null,
    };
  }
}
