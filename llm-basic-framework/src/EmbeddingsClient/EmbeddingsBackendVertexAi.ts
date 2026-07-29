import {
  assertVectorCount,
  EmbeddingsBackendBase,
  type EmbeddingCallOptions,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';
import { GoogleAuth } from 'google-auth-library';

interface Args {
  project: string;
  location: string;
  model: string;
  /** `RETRIEVAL_QUERY` | `RETRIEVAL_DOCUMENT` | `SEMANTIC_SIMILARITY` | … */
  taskType?: string;
  timeoutMs?: number;
}

interface PredictResponse {
  predictions?: Array<{
    embeddings?: { values?: number[]; statistics?: { token_count?: number } };
  }>;
  metadata?: { billableCharacterCount?: number };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INSTANCES_PER_REQUEST = 250;

/**
 * Vertex AI text embeddings, over the REST `:predict` endpoint.
 *
 * **Why REST and not the SDK.** The installed `@google-cloud/vertexai` exports only `VertexAI` —
 * generative models. It has no embeddings surface at all, and `@google-cloud/aiplatform` is a large
 * dependency for one endpoint. `google-auth-library` was already in the tree and supplies exactly
 * the piece that is hard (ADC token minting), so the endpoint is called directly.
 *
 * **What this replaces.** The pre-M5 version accepted `project` and `location`, discarded both,
 * and returned `[]` — reachable from `bin/app.ts` with no error, giving every entity a zero-length
 * vector. That is the failure mode a stub should never have: it does not look like a failure. Every
 * path here throws instead.
 *
 * ⚠️ **Unverified against the live API.** `GOOGLE_APPLICATION_CREDENTIALS` was the placeholder
 * string `CHANGE_ME` when this was written, so no call has been made. Treat the first real run as
 * the verification step, and see `docs/RUNNING-EXPERIMENTS.md`.
 */
export class EmbeddingsBackendVertexAi implements EmbeddingsBackendBase {
  model: string;
  readonly provider = 'vertexai';
  readonly config: Record<string, unknown>;

  #project: string;
  #location: string;
  #taskType?: string;
  #timeoutMs: number;
  #auth: GoogleAuth;

  constructor(args: Args) {
    if (!args.project) throw new Error('EmbeddingsBackendVertexAi: `project` is required');
    if (!args.location) throw new Error('EmbeddingsBackendVertexAi: `location` is required');

    this.model = args.model;
    this.#project = args.project;
    this.#location = args.location;
    this.#taskType = args.taskType;
    this.#timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    this.config = {
      provider: this.provider,
      model: this.model,
      location: this.#location,
      taskType: this.#taskType ?? null,
    };
  }

  async embed(inputs: string[], options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    if (inputs.length > MAX_INSTANCES_PER_REQUEST) {
      throw new Error(
        `EmbeddingsBackendVertexAi: ${inputs.length} instances exceeds the ${MAX_INSTANCES_PER_REQUEST} ` +
          'per-request limit — lower EmbeddingsClient `batchSize`'
      );
    }

    const started = Date.now();
    const endpoint =
      `https://${this.#location}-aiplatform.googleapis.com/v1/projects/${this.#project}` +
      `/locations/${this.#location}/publishers/google/models/${this.model}:predict`;

    const token = await this.#auth.getAccessToken();
    if (!token) {
      throw new Error(
        'EmbeddingsBackendVertexAi: no access token from Application Default Credentials — check ' +
          'GOOGLE_APPLICATION_CREDENTIALS'
      );
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instances: inputs.map((content) => ({
          content,
          ...(this.#taskType ? { task_type: this.#taskType } : {}),
        })),
        ...(options.dimensions !== undefined
          ? { parameters: { outputDimensionality: options.dimensions } }
          : {}),
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `EmbeddingsBackendVertexAi: ${this.model} returned ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail.slice(0, 500)}` : '')
      );
    }

    const body = (await response.json()) as PredictResponse;
    const predictions = body.predictions ?? [];
    const vectors = predictions.map((prediction, index) => {
      const values = prediction.embeddings?.values;
      if (!Array.isArray(values)) {
        throw new Error(
          `EmbeddingsBackendVertexAi: prediction ${index} carried no \`embeddings.values\``
        );
      }
      return values;
    });
    assertVectorCount('EmbeddingsBackendVertexAi', inputs, vectors);

    return {
      vectors,
      usage: {
        // Per-instance token counts, summed. Absent on some model versions, in which case the call
        // is metered with 0 input tokens and reported as such rather than estimated.
        inputTokens: predictions.reduce(
          (sum, prediction) => sum + (prediction.embeddings?.statistics?.token_count ?? 0),
          0
        ),
        outputTokens: 0,
      },
      model: this.model,
      latencyMs: Date.now() - started,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}
