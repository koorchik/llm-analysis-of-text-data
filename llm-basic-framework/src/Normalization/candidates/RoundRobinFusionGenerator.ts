import type {
  Candidate,
  CandidateGenerator,
  CandidateQuery,
  RegistryChange,
  RegistrySnapshot,
} from '../types';

interface Params {
  children: CandidateGenerator[];
  /** How many candidates to draw from each child before interleaving. */
  perChildK?: number;
  channel?: string;
}

/**
 * Interleaving fusion — the **consensus-free** alternative to {@link RrfFusionGenerator}.
 *
 * RRF asks "which candidate do the most channels like?". Measured on the full gold pool
 * (`npm run blocker-bench`), that question is the wrong one for this corpus: RRF scored recall@4
 * 74.4% against 85.9% for the dense channel **on its own**, and lost 9 of 14 Country queries the
 * dense channel got right. Identity evidence here is usually *single-channel* — `Poland`/`Польща`
 * is invisible to edit distance, 3-grams and BM25, all of which still cast a rank vote, and three
 * uninformed votes outweigh one informed one. Consensus is the wrong prior when the channels have
 * disjoint competence.
 *
 * Interleaving asks each channel for its best pick instead: take every child's rank-1, then every
 * child's rank-2, and so on, de-duplicating. A candidate that exactly one channel ranks first is
 * therefore **guaranteed** a slot in the first `children.length` positions — which is what the
 * judge's `LISTWISE_K=4` window needs, since only the top few are ever rendered.
 *
 * Contract, matching RRF so the two are drop-in swappable:
 *
 * 1. `sim` is the **best child similarity**, not a fusion score, so `minSim` stays interpretable.
 * 2. The returned list is **already ordered and must not be re-sorted by `sim`** — interleaved
 *    order is the point.
 * 3. Child order is the tie-break within a rank tier, so the output is deterministic across runs.
 */
export class RoundRobinFusionGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #children: CandidateGenerator[];
  #perChildK: number;
  #channel: string;

  constructor(params: Params) {
    if (params.children.length === 0) {
      throw new Error('RoundRobinFusionGenerator: at least one child generator is required');
    }
    this.#children = params.children;
    this.#perChildK = params.perChildK ?? 20;
    this.#channel = params.channel ?? 'rr';
    this.id = `rr(${this.#children.map((child) => child.id).join(',')})`;
    this.config = {
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
    // Same as RRF: children are asked wide and unthresholded, because the caller's threshold is a
    // statement about the reported similarity, not about any single channel's view of a candidate.
    const childQuery: CandidateQuery = { ...query, k: this.#perChildK, minSim: 0 };
    const perChild = await Promise.all(this.#children.map((child) => child.candidates(childQuery)));

    // Best similarity and contributing channels, pooled across children — reported, never ordered on.
    const bestSim = new Map<string, number>();
    const channels = new Map<string, Set<string>>();
    const surfaces = new Map<string, string[]>();
    for (const candidates of perChild) {
      for (const candidate of candidates) {
        const seen = bestSim.get(candidate.canonical);
        if (seen === undefined || candidate.sim > seen) bestSim.set(candidate.canonical, candidate.sim);
        (channels.get(candidate.canonical) ?? channels.set(candidate.canonical, new Set()).get(candidate.canonical)!).add(
          candidate.channel
        );
        if (!surfaces.has(candidate.canonical)) surfaces.set(candidate.canonical, candidate.surfaces);
      }
    }

    const ordered: string[] = [];
    const taken = new Set<string>();
    const depth = Math.max(0, ...perChild.map((candidates) => candidates.length));
    for (let tier = 0; tier < depth && ordered.length < query.k + taken.size; tier++) {
      for (const candidates of perChild) {
        const candidate = candidates[tier];
        if (!candidate || taken.has(candidate.canonical)) continue;
        taken.add(candidate.canonical);
        ordered.push(candidate.canonical);
      }
    }

    return ordered
      .filter((canonical) => bestSim.get(canonical)! >= query.minSim)
      .slice(0, query.k)
      .map((canonical) => ({
        canonical,
        sim: bestSim.get(canonical)!,
        surfaces: surfaces.get(canonical)!,
        channel: `${this.#channel}:${[...channels.get(canonical)!].sort().join('+')}`,
      }));
  }
}
