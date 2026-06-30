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

    if (message.content[0].type === 'text') {
      return message.content[0].text;
    } else {
      return '';
    }
  }
}
