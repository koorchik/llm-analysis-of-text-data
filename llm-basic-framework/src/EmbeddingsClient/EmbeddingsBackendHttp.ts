import {
  assertVectorCount,
  EmbeddingsBackendBase,
  type EmbeddingCallOptions,
  type EmbeddingsResponse,
} from './EmbeddingsBackendBase';

interface Args {
  /** Base URL of the sidecar, e.g. `http://localhost:8080`. `/v1/embeddings` is appended. */
  url: string;
  model: string;
  apiKey?: string;
  /**
   * How the sidecar pools token vectors into a sentence vector. **Recorded, not applied** — the
   * sidecar does the pooling; this is here so the run card says which convention produced the
   * numbers. It matters for SecureBERT specifically: see the class comment.
   */
  pooling?: string;
  /** Whether the sidecar L2-normalizes before returning. Also recorded, not applied. */
  normalize?: boolean;
  timeoutMs?: number;
}

interface OpenAiShapedResponse {
  data?: Array<{ index?: number; embedding: number[] }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Any OpenAI-compatible `/v1/embeddings` endpoint — the seam for encoders none of the three SDK
 * backends can serve.
 *
 * **This is what makes the SecureBERT arm possible.** `EmbeddingsClient` had OpenAI, Ollama and
 * VertexAI backends, none of which serves a HuggingFace RoBERTa-family model, so the arm that
 * settles the published encoder contradiction (`cheng2025ctinexus` vs `yang2026ctithinker`)
 * depended on infrastructure that did not exist. Targeting the OpenAI request/response shape rather
 * than inventing one means HuggingFace `text-embeddings-inference` and a `sentence-transformers`
 * server both work unmodified — see `tools/securebert-sidecar/`.
 *
 * **Two properties of SecureBERT to carry into the write-up rather than discover later.** It is a
 * RoBERTa **masked-language model**, not a sentence-transformers model. So (a) pooling is a choice
 * the experiment makes, not a property of the model — mean over last hidden states is the
 * convention — and (b) its vectors were never contrastively trained for cosine similarity, unlike
 * BGE-M3 and `text-embedding-3-large`. If it underperforms, that distinction is part of the
 * finding. Both fields are recorded in `config` and therefore in the run card and the runId.
 */
export class EmbeddingsBackendHttp implements EmbeddingsBackendBase {
  model: string;
  readonly provider = 'http';
  readonly config: Record<string, unknown>;

  #url: string;
  #apiKey?: string;
  #timeoutMs: number;

  constructor(args: Args) {
    this.model = args.model;
    this.#url = args.url.replace(/\/+$/, '');
    this.#apiKey = args.apiKey;
    this.#timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.config = {
      provider: this.provider,
      model: this.model,
      url: this.#url,
      // Not applied here — see the class comment. Recorded because they change the numbers.
      pooling: args.pooling ?? 'sidecar-default',
      normalize: args.normalize ?? null,
    };
  }

  async embed(inputs: string[], _options: EmbeddingCallOptions = {}): Promise<EmbeddingsResponse> {
    const started = Date.now();
    const endpoint = `${this.#url}/v1/embeddings`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
      },
      body: JSON.stringify({ input: inputs, model: this.model }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `EmbeddingsBackendHttp: ${endpoint} returned ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail.slice(0, 500)}` : '')
      );
    }

    const body = (await response.json()) as OpenAiShapedResponse;
    if (!Array.isArray(body.data)) {
      throw new Error(
        `EmbeddingsBackendHttp: ${endpoint} returned no \`data\` array — not an OpenAI-shaped ` +
          'embeddings response'
      );
    }

    // Sort by `index` where the sidecar supplies one; fall back to wire order where it does not.
    const vectors = body.data
      .map((item, position) => ({ index: item.index ?? position, embedding: item.embedding }))
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    assertVectorCount('EmbeddingsBackendHttp', inputs, vectors);

    return {
      vectors,
      // Local inference reports no usage in most servers. 0 here is honest — the run is priced at
      // 0 anyway (see `providerDefaults` in config/model-prices.json), and inventing a token count
      // would put a fabricated number in the cost table.
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0 },
      model: body.model || this.model,
      latencyMs: Date.now() - started,
      dimensions: vectors[0]?.length ?? 0,
    };
  }
}
