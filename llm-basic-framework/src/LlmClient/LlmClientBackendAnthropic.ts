import { LlmBackendBase } from './LlmClientBackendBase';
import Anthropic from '@anthropic-ai/sdk';

export class LlmClientBackendAnthropic implements LlmBackendBase {
  model: string;
  #client: Anthropic;

  constructor(args: { apiKey: string; model: string }) {
    this.model = args.model;
    this.#client = new Anthropic({ apiKey: args.apiKey });
  }

  async send(instructions: string, text: string): Promise<string> {
    const message = await this.#client.messages.create({
      model: this.model,
      max_tokens: 100000,
      temperature: 1,
      system: instructions,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text }],
        },
      ],
    });

    // Newer Claude models may prepend a `thinking` block before the text block
    const textBlock = message.content.find((block) => block.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text : '';
  }
}
