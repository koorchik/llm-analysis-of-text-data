import { identityAnalyzer } from '../analyzers/identity';
import { maxLevDice } from '../metrics/stringMetrics';
import {
  topK,
  type Analyzer,
  type Candidate,
  type CandidateGenerator,
  type CandidateQuery,
  type RegistryChange,
  type RegistrySnapshot,
  type SimilarityMetric,
} from '../types';

interface Params {
  analyzers?: Analyzer[];
  metric?: SimilarityMetric;
  /** Overrides the default `string-sim` channel label recorded in the decision log. */
  channel?: string;
}

/**
 * Brute-force similarity over every canonical in the category.
 *
 * This is the generator the M2.5 gate is scored against: with the `identity` analyzer and
 * `max(levenshtein, tokenDice)` it must reproduce the pre-M4 `ConceptRegistry.candidates()` output
 * byte for byte on all 3,392 frozen pairs. Every detail below that looks incidental is load-bearing
 * for that equality.
 *
 * **Scale honesty:** brute force over ~2,674 canonicals is microseconds, and the note is explicit
 * that introducing an ANN index here would be scale theatre. Documented as a rejection, not an
 * oversight.
 */
export class StringSimilarityGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #analyzers: Analyzer[];
  #metric: SimilarityMetric;
  #channel: string;
  #snapshot?: RegistrySnapshot;

  constructor(params: Params = {}) {
    this.#analyzers = params.analyzers ?? [identityAnalyzer];
    this.#metric = params.metric ?? maxLevDice;
    this.#channel = params.channel ?? 'string-sim';
    this.id = `string-sim(${this.#analyzers.map((a) => a.id).join('+')},${this.#metric.id})`;
    this.config = {
      analyzers: this.#analyzers.map((analyzer) => analyzer.id),
      metric: this.#metric.id,
    };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    this.#snapshot = snapshot;
  }

  /**
   * No-op: the snapshot is a live view and this generator holds no index, so there is nothing to
   * invalidate. Declared explicitly rather than omitted, so the contract is visibly satisfied.
   */
  onRegistryChange(_event: RegistryChange): void {}

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    if (!this.#snapshot) throw new Error(`${this.id}: prepare() must be called before candidates()`);

    const ctx = { category: query.category };
    const queryKeys = this.#keysFor(query.mention, ctx);
    if (queryKeys.length === 0) return [];

    const scored: Candidate[] = [];

    for (const entry of this.#snapshot.entries(query.category)) {
      let sim = 0;
      for (const surface of entry.surfaces) {
        for (const surfaceKey of this.#keysFor(surface, ctx)) {
          for (const queryKey of queryKeys) {
            const score = this.#metric.score(queryKey, surfaceKey);
            if (score > sim) sim = score;
          }
        }
        // Early exit on a perfect match. Present in the pre-M4 implementation; kept because it is
        // free, and it cannot change the result since the aggregate is a maximum.
        if (sim === 1) break;
      }

      if (sim >= query.minSim) {
        scored.push({
          canonical: entry.canonical,
          sim,
          surfaces: entry.surfaces.slice(1),
          channel: this.#channel,
        });
      }
    }

    // Sort-then-slice, never slice-then-sort: with 42 candidates above minSim on average and k=5,
    // slicing first would discard better matches. `topK` applies the shared (-sim, canonical)
    // ordering so no generator can reintroduce the pre-M2.5 insertion-order leak.
    return topK(scored, query.k);
  }

  #keysFor(value: string, ctx: { category: string }): string[] {
    if (this.#analyzers.length === 1) return this.#analyzers[0].keys(value, ctx);
    // De-duplicated across analyzers: two analyzers agreeing on a key must not double the work, and
    // must not change the score either (the aggregate is a max).
    const keys = new Set<string>();
    for (const analyzer of this.#analyzers) {
      for (const key of analyzer.keys(value, ctx)) keys.add(key);
    }
    return [...keys];
  }
}
