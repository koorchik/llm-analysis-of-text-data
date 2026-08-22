import type { EmbeddingsClient } from '../../EmbeddingsClient/EmbeddingsClient';
import { cosineNormalized, l2Normalize, meanPool } from '../../utils/vectorUtils';
import {
  topK,
  type Candidate,
  type CandidateGenerator,
  type CandidateQuery,
  type RegistryChange,
  type RegistrySnapshot,
  type SnapshotEntry,
} from '../types';

/** What text is encoded for a surface. `name+gloss` is the E4 ablation — see the class comment. */
export type EmbeddingRepresentation = 'name' | 'name+gloss' | 'name+category';

/** How a canonical's several surfaces collapse into a score against the query. */
export type ClusterRepresentation = 'max-over-aliases' | 'centroid' | 'mean';

interface Params {
  embeddingsClient: EmbeddingsClient;
  representation?: EmbeddingRepresentation;
  clusterRepresentation?: ClusterRepresentation;
  channel?: string;
}

interface CategoryIndex {
  /** canonical → the L2-normalized vectors it is matched on (one, or one per surface). */
  vectors: Map<string, number[][]>;
  surfaces: Map<string, string[]>;
}

/**
 * Dense retrieval over registry canonicals — **the multilingual channel of E4's union arm**, and
 * the generator that makes the embedding-cosine pole of E2 an embedding pole rather than a string
 * one wearing the name.
 *
 * `ThresholdDecision` needs no change to consume this: it thresholds `candidates[0].sim`, whatever
 * produced it. Swapping the generator is what turns "threshold 0.8" from an edit-distance ratio
 * into a cosine.
 *
 * **Scale: brute-force cosine, explicitly no ANN index.** At ~2,674 canonicals an index is scale
 * theatre — the same argument `StringSimilarityGenerator` already makes for its own linear scan.
 * This is a documented rejection for the paper, not an oversight.
 *
 * **`name+gloss` writes real glosses since 2026-08-05.** The link-judge emits a one-line `gloss`
 * on every mint/defer (code-validated, one re-ask on a bad gloss, `gloss-flagged` on retry
 * failure), and `StreamingNormalizer` passes it through `ConceptRegistry.mint`'s `extras.gloss` —
 * not via `setGloss()`, which still has no caller. **Any registry from before 2026-08-05**
 * (including both committed baseline arms) still has every canonical's gloss null, so this
 * representation still degrades to plain `name` on those specific run directories, and this class
 * still detects an all-null gloss set and warns rather than silently producing results identical
 * to `name` — a silently-identical arm would show up in the results table as evidence that
 * glosses do not help, which would be a false finding about the method rather than a true one
 * about the data on a pre-2026-08-05 corpus.
 */
export class EmbeddingGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #client: EmbeddingsClient;
  #representation: EmbeddingRepresentation;
  #clusterRepresentation: ClusterRepresentation;
  #channel: string;
  #snapshot?: RegistrySnapshot;
  #indexes = new Map<string, CategoryIndex>();
  #warnedAboutGloss = false;

  constructor(params: Params) {
    this.#client = params.embeddingsClient;
    this.#representation = params.representation ?? 'name';
    this.#clusterRepresentation = params.clusterRepresentation ?? 'max-over-aliases';
    this.#channel = params.channel ?? 'embedding';

    this.id = `embedding(${this.#client.modelName},${this.#representation},${this.#clusterRepresentation})`;
    this.config = {
      provider: this.#client.provider,
      model: this.#client.modelName,
      representation: this.#representation,
      clusterRepresentation: this.#clusterRepresentation,
      backend: this.#client.config,
    };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    this.#snapshot = snapshot;
    this.#indexes.clear();
  }

  /**
   * Drops the affected category's membership; rebuilt on the next query for that category.
   *
   * This method is **synchronous and returns void**, so no embedding call can happen here. That is
   * why the rebuild lives in `candidates()`, which is async — the shape `TfidfNgramGenerator`
   * established, and the reason `CandidateGenerator.candidates` was declared async back in M4.
   * Re-embedding is cheap in practice because `EmbeddingsClient`'s cache is keyed by
   * `(model, text)`: invalidation costs a rebuild of the *membership map*, not of the vectors.
   */
  onRegistryChange(event: RegistryChange): void {
    this.#indexes.delete(event.category);
  }

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    if (!this.#snapshot) throw new Error(`${this.id}: prepare() must be called before candidates()`);

    const index = await this.#indexFor(query.category);
    if (index.vectors.size === 0) return [];

    const queryText = this.#textFor(query.mention, query.category, null);
    const queryVector = l2Normalize(await this.#client.embed(queryText, { operator: 'embed-query' }));
    if (queryVector.length === 0) return [];

    const scored: Candidate[] = [];
    for (const [canonical, vectors] of index.vectors) {
      // Max over the canonical's surfaces — the same aggregation StringSimilarityGenerator uses, so
      // the dense arm differs from the string arm in *encoder*, not in how a cluster is scored.
      // `centroid`/`mean` collapse to a single vector at build time, so this loop is a no-op there.
      let best = 0;
      for (const vector of vectors) {
        const sim = cosineNormalized(queryVector, vector);
        if (sim > best) best = sim;
      }

      if (best >= query.minSim) {
        scored.push({
          canonical,
          sim: best,
          surfaces: index.surfaces.get(canonical) ?? [],
          channel: this.#channel,
        });
      }
    }

    return topK(scored, query.k);
  }

  /**
   * Builds the category's membership map, embedding every surface in **one batched call**.
   *
   * Async — unlike the string generators' synchronous `#indexFor` — which is the whole reason the
   * port's `candidates()` is a promise.
   */
  async #indexFor(category: string): Promise<CategoryIndex> {
    const cached = this.#indexes.get(category);
    if (cached) return cached;

    const entries = this.#snapshot!.entries(category);
    this.#warnAboutGlossOnce(entries);

    // `surfaces` is `[canonical, ...aliasSurfaces]` and `mint` puts the canonical in its own alias
    // list, so the canonical is normally present twice. De-duplicate before embedding: a duplicate
    // is a paid-for API call that cannot change the max.
    const texts: string[] = [];
    const perCanonical = new Map<string, string[]>();
    for (const entry of entries) {
      const unique = [...new Set(entry.surfaces)].map((surface) =>
        this.#textFor(surface, category, entry.definition ?? null)
      );
      perCanonical.set(entry.canonical, [...new Set(unique)]);
      texts.push(...perCanonical.get(entry.canonical)!);
    }

    const embedded = texts.length > 0 ? await this.#client.embed(texts, { operator: 'embed-index' }) : [];
    const byText = new Map<string, number[]>();
    texts.forEach((text, position) => byText.set(text, embedded[position]));

    const vectors = new Map<string, number[][]>();
    const surfaces = new Map<string, string[]>();
    for (const entry of entries) {
      const normalized = perCanonical
        .get(entry.canonical)!
        .map((text) => l2Normalize(byText.get(text)!));
      if (normalized.length === 0) continue;

      vectors.set(
        entry.canonical,
        this.#clusterRepresentation === 'max-over-aliases'
          ? normalized
          : // A centroid of unit vectors is the mean direction; re-normalizing keeps the dot product
            // a cosine. `centroid` and `mean` differ only in intent, so they share this path and are
            // kept as distinct ids because the experiment config names them separately.
            [l2Normalize(meanPool(normalized))]
      );
      surfaces.set(entry.canonical, entry.surfaces.slice(1));
    }

    const index: CategoryIndex = { vectors, surfaces };
    this.#indexes.set(category, index);
    return index;
  }

  #textFor(surface: string, category: string, gloss: string | null): string {
    switch (this.#representation) {
      case 'name+category':
        return `${surface} (${category})`;
      case 'name+gloss':
        return gloss ? `${surface}: ${gloss}` : surface;
      case 'name':
      default:
        return surface;
    }
  }

  #warnAboutGlossOnce(entries: SnapshotEntry[]): void {
    if (this.#representation !== 'name+gloss' || this.#warnedAboutGloss) return;
    if (entries.length === 0 || entries.some((entry) => entry.definition)) return;

    this.#warnedAboutGloss = true;
    console.warn(
      `${this.id}: every canonical has a null gloss, so this arm is currently IDENTICAL to ` +
        '`name`. The link-judge has written real glosses at mint/defer time since 2026-08-05, ' +
        'so an all-null set here means this registry predates that (e.g. a pre-2026-08-05 run ' +
        'directory) rather than that gloss writing is unimplemented. Do not report this as ' +
        'evidence that glosses do not help.'
    );
  }
}
