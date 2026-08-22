import { EmbeddingCache } from './EmbeddingCache';
import { EmbeddingsBackendGemini } from './EmbeddingsBackendGemini';
import { EmbeddingsBackendHttp } from './EmbeddingsBackendHttp';
import { EmbeddingsBackendOllama } from './EmbeddingsBackendOllama';
import { EmbeddingsBackendOpenAi } from './EmbeddingsBackendOpenAi';
import { EmbeddingsBackendVertexAi } from './EmbeddingsBackendVertexAi';
import { EmbeddingsClient } from './EmbeddingsClient';
import type { CostMeter } from '../Experiment/CostMeter';

/**
 * The one place a provider name becomes an embeddings backend.
 *
 * Extracted from `bin/app.ts` so `bin/gold.ts` (the embedding pair proposer) builds its client
 * through the same switch instead of a drifting copy. Credentials come from the environment, as
 * everywhere else in the repo; the caller chooses provider, model and cache directory.
 */
export function createEmbeddingsClient(params: {
  provider: string;
  model: string;
  cacheDir?: string;
  costMeter?: CostMeter;
}): EmbeddingsClient {
  let backend;

  switch (params.provider) {
    case 'openai':
      backend = new EmbeddingsBackendOpenAi({
        model: params.model,
        apiKey: process.env.OPENAI_API_KEY!,
      });
      break;

    // Google AI Studio (GEMINI_API_KEY) — the encoder-side sibling of the 'gemini' LLM provider;
    // distinct from 'vertexai', which needs a GCP project.
    case 'gemini':
      backend = new EmbeddingsBackendGemini({
        model: params.model,
        apiKey: process.env.GEMINI_API_KEY!,
      });
      break;

    case 'ollama':
      backend = new EmbeddingsBackendOllama({
        model: params.model,
        apiKey: process.env.OLLAMA_API_KEY,
        host: process.env.OLLAMA_HOST,
      });
      break;

    case 'vertexai':
      backend = new EmbeddingsBackendVertexAi({
        model: params.model,
        project: process.env.VERTEXAI_PROJECT!,
        location: process.env.VERTEXAI_LOCATION!,
      });
      break;

    // M5: any OpenAI-compatible /v1/embeddings endpoint. This is the SecureBERT arm — see
    // tools/securebert-sidecar/.
    case 'http':
      backend = new EmbeddingsBackendHttp({
        model: params.model,
        url: process.env.EMBEDDINGS_URL || 'http://localhost:8080',
        apiKey: process.env.EMBEDDINGS_API_KEY,
        pooling: process.env.EMBEDDINGS_POOLING,
        normalize:
          process.env.EMBEDDINGS_NORMALIZE === undefined
            ? undefined
            : process.env.EMBEDDINGS_NORMALIZE === '1',
      });
      break;

    default:
      throw new Error(`Unknown embeddings provider: ${params.provider}`);
  }

  return new EmbeddingsClient({
    backend,
    costMeter: params.costMeter,
    cache: params.cacheDir
      ? new EmbeddingCache({
          dir: params.cacheDir,
          provider: backend.provider,
          model: params.model,
        })
      : undefined,
  });
}
