import type { LlmBackendBase } from './LlmClientBackendBase';
import { LlmClientBackendAnthropic } from './LlmClientBackendAnthropic';
import { LlmClientBackendGemini } from './LlmClientBackendGemini';
import { LlmClientBackendOllama } from './LlmClientBackendOllama';
import { LlmClientBackendOpenAi } from './LlmClientBackendOpenAi';
import { LlmClientBackendVertexAi } from './LlmClientBackendVertexAi';

/**
 * The one place a provider name becomes an LLM backend.
 *
 * Extracted from `bin/app.ts` so `bin/gold.ts` (the ensemble annotator) builds its clients
 * through the same switch instead of a drifting copy. Credentials come from the environment, as
 * everywhere else in the repo; the caller chooses provider and model.
 */
export function createLlmBackend(params: { provider: string; model: string }): LlmBackendBase {
  switch (params.provider) {
    case 'openai':
      return new LlmClientBackendOpenAi({
        model: params.model,
        apiKey: process.env.OPENAI_API_KEY!,
      });

    // num_ctx is left to the model tag (`…-8k` → 8192) unless OLLAMA_NUM_CTX overrides it, so a
    // mixed-window arm (cheap 8k judge + 16k ladder ensemble) requests the right window per model
    // instead of one hardcoded default for every local call.
    case 'ollama': {
      const override = process.env.OLLAMA_NUM_CTX;
      const backend = new LlmClientBackendOllama({
        model: params.model,
        apiKey: process.env.OLLAMA_API_KEY,
        ...(override ? { numCtx: Number(override) } : {}),
      });
      console.log(`OLLAMA ${params.model}: num_ctx=${backend.numCtx}`);
      return backend;
    }

    case 'vertexai':
      return new LlmClientBackendVertexAi({
        model: params.model,
        project: process.env.VERTEXAI_PROJECT!,
        location: process.env.VERTEXAI_LOCATION!,
      });

    case 'anthropic':
      return new LlmClientBackendAnthropic({
        model: params.model,
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });

    // Google AI Studio (GEMINI_API_KEY) — distinct from 'vertexai', which needs a GCP project.
    case 'gemini':
      return new LlmClientBackendGemini({
        model: params.model,
        apiKey: process.env.GEMINI_API_KEY!,
      });

    default:
      throw new Error(`Unknown LLM provider: ${params.provider}`);
  }
}
