import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import OpenAI from 'openai';

export class LlmClientBackendOpenAi implements LlmBackendBase {
  model: string;
  readonly provider = 'openai';

  // The only arm that can claim seeded reproducibility. `temperature` is forwarded only when the
  // caller asks for it: reasoning-class models reject or ignore it on some endpoints, and an
  // ignored parameter recorded as if it applied is worse than an absent one (plan, M7).
  readonly sampling: LlmSamplingSupport = {
    temperature: true,
    seed: true,
    topP: true,
    note: 'Reasoning-class models may reject or ignore temperature; verify per model before relying on it.',
  };

  #openAiClient: OpenAI;

  constructor(args: { apiKey: string; model: string }) {
    this.model = args.model;
    this.#openAiClient = new OpenAI({ apiKey: args.apiKey });
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    const chatCompletion = await this.#openAiClient.chat.completions.create({
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: text },
      ],
      model: this.model,
      // Spread-if-defined: only send what the caller actually set, so an unset parameter is
      // absent from the request rather than present-and-undefined.
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.maxTokens !== undefined ? { max_completion_tokens: options.maxTokens } : {}),
    });

    const choice = chatCompletion.choices[0];

    return {
      text: choice?.message?.content || '',
      usage: {
        inputTokens: chatCompletion.usage?.prompt_tokens ?? 0,
        outputTokens: chatCompletion.usage?.completion_tokens ?? 0,
      },
      model: chatCompletion.model || this.model,
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason ?? null,
    };
  }
}
