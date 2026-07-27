import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MAX_TOKENS = 100000;

export class LlmClientBackendAnthropic implements LlmBackendBase {
  model: string;
  readonly provider = 'anthropic';

  // On Claude Opus 4.7+ (4.7 / 4.8 / Opus 5 / Sonnet 5 / Fable 5) the sampling parameters are
  // REMOVED from the API: any non-default value returns HTTP 400. There is therefore no
  // determinism lever here at all — the substitute is replication under default sampling.
  // See docs/statistical-protocol.md. Do not "fix" this to temperature: 0; it would 400 every call.
  readonly sampling: LlmSamplingSupport = {
    temperature: false,
    seed: false,
    topP: false,
    note:
      'Claude Opus 4.7+ removes temperature/top_p/top_k; non-default values return HTTP 400. ' +
      'Determinism substitute is replication at provider-default sampling (temperature 1.0).',
  };

  #client: Anthropic;
  #maxTokens: number;

  constructor(args: { apiKey: string; model: string; maxTokens?: number }) {
    this.model = args.model;
    this.#maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#client = new Anthropic({ apiKey: args.apiKey });
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    // Deliberately no temperature/top_p/top_k: see `sampling` above. A caller-supplied
    // temperature is dropped rather than forwarded, because forwarding it would 400.
    const message = await this.#client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? this.#maxTokens,
      system: instructions,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text }],
        },
      ],
    });

    // Newer Claude models may prepend a `thinking` block before the text block.
    // Thinking tokens are billed and counted in `usage`, so CostMeter figures for this
    // provider include reasoning that never appears in the decision log.
    const textBlock = message.content.find((block) => block.type === 'text');

    return {
      text: textBlock?.type === 'text' ? textBlock.text : '',
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
      },
      model: message.model || this.model,
      latencyMs: Date.now() - started,
      finishReason: message.stop_reason ?? null,
    };
  }
}
