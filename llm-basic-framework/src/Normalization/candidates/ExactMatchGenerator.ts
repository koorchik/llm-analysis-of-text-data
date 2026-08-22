import { identityAnalyzer } from '../analyzers/identity';
import {
  topK,
  type Analyzer,
  type Candidate,
  type CandidateGenerator,
  type CandidateQuery,
  type RegistryChange,
  type RegistrySnapshot,
} from '../types';

interface Params {
  analyzers?: Analyzer[];
  channel?: string;
}

/**
 * Candidates whose analyzer keys match the query's **exactly**. Similarity is 1 or nothing.
 *
 * **The E2 floor.** `edge2024graphrag-preprint` §3.1.3 does only this, so it is the published
 * lower bound every other condition must beat; if the LLM judge cannot improve on exact matching,
 * the paper has no result. It is also the arm with no false merges by construction, which makes it
 * the precision ceiling as well as the recall floor.
 *
 * With `identity` it is equivalent to `ConceptRegistry.resolve()`, expressed as a candidate list.
 * It becomes genuinely useful with other analyzers: `identifier-regex` turns it into "same UAC
 * designation", which M2.5 showed string similarity cannot achieve at any threshold.
 */
export class ExactMatchGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #analyzers: Analyzer[];
  #channel: string;
  #snapshot?: RegistrySnapshot;

  constructor(params: Params = {}) {
    this.#analyzers = params.analyzers ?? [identityAnalyzer];
    this.#channel = params.channel ?? 'exact';
    this.id = `exact(${this.#analyzers.map((analyzer) => analyzer.id).join('+')})`;
    this.config = { analyzers: this.#analyzers.map((analyzer) => analyzer.id) };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    this.#snapshot = snapshot;
  }

  onRegistryChange(_event: RegistryChange): void {}

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    if (!this.#snapshot) throw new Error(`${this.id}: prepare() must be called before candidates()`);

    const ctx = { category: query.category };
    const wanted = new Set<string>();
    for (const analyzer of this.#analyzers) {
      for (const key of analyzer.keys(query.mention, ctx)) wanted.add(key);
    }
    if (wanted.size === 0) return [];

    const matches: Candidate[] = [];
    for (const entry of this.#snapshot.entries(query.category)) {
      const hit = entry.surfaces.some((surface) =>
        this.#analyzers.some((analyzer) =>
          analyzer.keys(surface, ctx).some((key) => wanted.has(key))
        )
      );
      // minSim is irrelevant to an exact channel — a match is 1, which passes any threshold ≤ 1 —
      // but it is respected rather than ignored so a caller setting minSim > 1 gets nothing.
      if (hit && 1 >= query.minSim) {
        matches.push({
          canonical: entry.canonical,
          sim: 1,
          surfaces: entry.surfaces.slice(1),
          channel: this.#channel,
        });
      }
    }

    // All ties at 1, so ordering is entirely the (-sim, canonical) tie-break — which is exactly why
    // that rule has to be shared rather than reimplemented per generator.
    return topK(matches, query.k);
  }
}
