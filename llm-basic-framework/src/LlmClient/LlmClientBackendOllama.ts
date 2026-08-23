import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import { Ollama, type Fetch } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';

const DEFAULT_NUM_CTX = 32768;

/**
 * How long a single local call may take before the HTTP layer gives up.
 *
 * ollama-js leaves `fetch` on undici's defaults, and undici times out after **300 s waiting for
 * response headers**. A non-streaming `/api/chat` sends no headers until generation finishes, so
 * that default is a hard per-call ceiling — and a 64k local judge sits uncomfortably close to it:
 * measured on `gemma4:12b-64k`, ordinary calls run 145-230 s and one landed at exactly 300.7 s,
 * which undici killed. The failure is silent in the worst way: `StreamingNormalizer` catches it and
 * mints every mention in the document, so the arm keeps running and simply scores worse, looking
 * like bad judgement rather than a dropped call (the trap recorded in commit 22f01d7).
 *
 * 30 minutes is far above any observed call and still bounded, so a genuinely hung server fails
 * rather than blocking the run forever.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export function ollamaTimeoutMs(): number {
  const override = Number(process.env.OLLAMA_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TIMEOUT_MS;
}

/**
 * `fetch` for ollama-js with that ceiling raised. Node does not expose a configurable dispatcher for
 * its built-in `fetch`, and `setGlobalDispatcher` from the standalone `undici` package does NOT
 * reach it (separate module instances) — so the request has to go through undici's own `fetch` with
 * an explicit dispatcher. Passing only `fetch` to `Ollama` leaves host resolution untouched
 * (`config?.host ?? defaultHost`), so this changes transport timeouts and nothing else.
 */
export function createOllamaFetch(timeoutMs = ollamaTimeoutMs()): Fetch {
  const agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher: agent } as never)) as unknown as Fetch;
}

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

    const fetch = createOllamaFetch();
    this.ollama =
      // OLLAMA_CLOUD=1 routes ANY model to ollama.com when an API key is present (the hosted
      // catalog decides what actually exists there — gemma4:31b is, gemma4:12b is not).
      args.apiKey && (args.model.match(/gpt-oss/) || process.env.OLLAMA_CLOUD === '1')
        ? new Ollama({
            host: 'https://ollama.com',
            headers: {
              Authorization: `Bearer ${args.apiKey}`,
            },
            fetch,
          })
        : new Ollama({ fetch });
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    const think = options.think ?? this.#think;
    const response = await this.ollama.chat({
      model: this.model,
      ...(think === undefined ? {} : { think }),
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
