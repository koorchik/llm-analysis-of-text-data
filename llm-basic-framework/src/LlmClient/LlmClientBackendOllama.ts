import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import { Ollama } from 'ollama';

const DEFAULT_NUM_CTX = 32768;

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

  constructor(args: { model: string; apiKey?: string; numCtx?: number }) {
    this.model = args.model;
    this.#numCtx = args.numCtx ?? DEFAULT_NUM_CTX;

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
