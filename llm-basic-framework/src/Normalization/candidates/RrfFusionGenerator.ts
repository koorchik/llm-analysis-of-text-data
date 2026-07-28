import type {
  Candidate,
  CandidateGenerator,
  CandidateQuery,
  RegistryChange,
  RegistrySnapshot,
} from '../types';

interface Params {
  children: CandidateGenerator[];
  /** RRF damping. 60 is the value from the original Cormack et al. formulation. */
  rrfK?: number;
  /**
   * How many candidates to draw from each child before fusing. Larger than the final `k`, because a
   * candidate ranked 6th by every child should still be able to win on consensus.
   */
  perChildK?: number;
  channel?: string;
}

/**
 * Reciprocal rank fusion over several generators — **the E4 union arm**.
 *
 * The note specifies this arm precisely: edit distance ∪ transliteration/confusable skeleton ∪
 * char-3gram TF-IDF ∪ multilingual dense ∪ BM25, fused by RRF. Items 1–6 of its
 * promising-but-uncovered shortlist *are* this generator.
 *
 * RRF fuses **ranks, not scores**: `Σ 1/(rrfK + rank)` over the children that surfaced a candidate.
 * That is the whole point — the children's scores are incommensurable (an edit-distance ratio, a
 * cosine, and a per-query-normalized BM25 value are not on one scale), so any score-level
 * combination would be comparing units. Ranks are all that survive the comparison.
 *
 * **Two contract details that matter downstream.**
 *
 * 1. `sim` reports the **best child similarity**, not the RRF score. RRF scores live on a ~1/60
 *    scale, so putting one in `sim` would make `minSim` meaningless and mislead every reader of the
 *    decision log. The fusion decides the *order*; `sim` stays an interpretable similarity.
 * 2. Because of that, the returned list is **already ordered and must not be re-sorted by `sim`**.
 *    This is the one generator whose output order is not `(-sim, canonical)`, which is precisely
 *    what fusing is for.
 */
export class RrfFusionGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #children: CandidateGenerator[];
  #rrfK: number;
  #perChildK: number;
  #channel: string;

  constructor(params: Params) {
    if (params.children.length === 0) {
      throw new Error('RrfFusionGenerator: at least one child generator is required');
    }
    this.#children = params.children;
    this.#rrfK = params.rrfK ?? 60;
    this.#perChildK = params.perChildK ?? 20;
    this.#channel = params.channel ?? 'rrf';
    this.id = `rrf(${this.#children.map((child) => child.id).join(',')})`;
    this.config = {
      rrfK: this.#rrfK,
      perChildK: this.#perChildK,
      children: this.#children.map((child) => ({ id: child.id, config: child.config })),
    };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    await Promise.all(this.#children.map((child) => child.prepare(snapshot)));
  }

  onRegistryChange(event: RegistryChange): void {
    for (const child of this.#children) child.onRegistryChange(event);
  }

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    // Children are asked for more than the final k and with **minSim 0**: a candidate that one child
    // rates weakly can still win on consensus, and applying the caller's threshold per child would
    // discard exactly the evidence fusion exists to combine.
    const childQuery: CandidateQuery = { ...query, k: this.#perChildK, minSim: 0 };
    const perChild = await Promise.all(
      this.#children.map((child) => child.candidates(childQuery))
    );

    interface Fused {
      candidate: Candidate;
      rrf: number;
      bestSim: number;
      channels: string[];
    }
    const fused = new Map<string, Fused>();

    perChild.forEach((candidates, childIndex) => {
      candidates.forEach((candidate, rank) => {
        const existing = fused.get(candidate.canonical);
        const contribution = 1 / (this.#rrfK + rank + 1); // rank is 0-based; RRF is 1-based
        if (existing) {
          existing.rrf += contribution;
          existing.bestSim = Math.max(existing.bestSim, candidate.sim);
          existing.channels.push(candidate.channel);
        } else {
          fused.set(candidate.canonical, {
            candidate,
            rrf: contribution,
            bestSim: candidate.sim,
            channels: [candidate.channel],
          });
        }
      });
      void childIndex;
    });

    const ordered = [...fused.values()]
      // Descending RRF, then the shared canonical tie-break so equal-consensus candidates are still
      // deterministically ordered.
      .sort((a, b) =>
        a.rrf !== b.rrf
          ? b.rrf - a.rrf
          : a.candidate.canonical < b.candidate.canonical
            ? -1
            : a.candidate.canonical > b.candidate.canonical
              ? 1
              : 0
      )
      // The caller's threshold applies to the reported similarity, once, at the end.
      .filter((entry) => entry.bestSim >= query.minSim)
      .slice(0, query.k);

    return ordered.map((entry) => ({
      canonical: entry.candidate.canonical,
      sim: entry.bestSim,
      surfaces: entry.candidate.surfaces,
      // Every contributing channel is recorded, so E4 can attribute recall per channel rather than
      // only to the fusion. Sorted and de-duplicated for a stable label.
      channel: `${this.#channel}:${[...new Set(entry.channels)].sort().join('+')}`,
    }));
  }
}
