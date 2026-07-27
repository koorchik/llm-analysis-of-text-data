import {
  LlmBackendBase,
  type LlmCallOptions,
  type LlmResponse,
  type LlmSamplingSupport,
} from './LlmClientBackendBase';
import { VertexAI, GenerateContentCandidate } from '@google-cloud/vertexai';

// Was hardcoded at 1024, which silently truncated extractions (plan, M1: "Fix while in there").
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

export class LlmClientBackendVertexAi implements LlmBackendBase {
  model: string;
  readonly provider = 'vertexai';

  // No seed available; the determinism lever is temperature: 0. The previous hardcoded
  // 0.2 / topP 0.95 was invisible to the run card and is now caller-supplied.
  readonly sampling: LlmSamplingSupport = {
    temperature: true,
    seed: false,
    topP: true,
    note: 'No seed parameter; determinism substitute is repeated calls at temperature: 0.',
  };

  #vertexAiClient: VertexAI;
  #maxOutputTokens: number;

  constructor(args: {
    project: string;
    location: string;
    model: string;
    maxOutputTokens?: number;
  }) {
    this.model = args.model;
    this.#maxOutputTokens = args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#vertexAiClient = new VertexAI({
      project: args.project,
      location: args.location,
    });
  }

  async send(
    instructions: string,
    text: string,
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const started = Date.now();

    const generativeModel = this.#vertexAiClient.preview.getGenerativeModel({
      model: this.model,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? this.#maxOutputTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { topP: options.topP } : {}),
      },
      systemInstruction: instructions,
    });

    const result: any = await generativeModel.generateContent({
      contents: [{ role: 'user', parts: [{ text }] }],
    });

    const candidate: GenerateContentCandidate | undefined = result.response?.candidates?.[0];
    const usage = result.response?.usageMetadata;

    return {
      text: candidate?.content?.parts?.[0]?.text || '',
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
      model: this.model,
      latencyMs: Date.now() - started,
      finishReason: candidate?.finishReason ?? null,
    };
  }
}
