import type { Stratum } from './clusterMetrics';
import { pairKey, type ElementKey } from './partition';

/**
 * Blocking / candidate-generation metrics, reported under the entity-resolution field's own names
 * (`simonini2022brewer`, `binette2022entityresolution`) rather than invented ones — free
 * credibility, and it lets E4's numbers be read against published blocking work.
 *
 * The primary question is E4's: **does the true canonical even reach the judge's list?** A
 * candidate the blocker never retrieves is one the judge can never merge, so recall@k bounds
 * everything downstream. This is the mechanism most tied to the novel tail.
 */

export interface CandidateQuery {
  /** The mention being resolved. */
  mention: ElementKey;
  /** Candidates in the order shown to the judge — position matters, so order is preserved. */
  candidates: ElementKey[];
  /**
   * The element(s) that would be a correct link. Usually one canonical, but a gold cluster may
   * have several members already in the registry, any of which is a correct target.
   */
  goldTargets: ElementKey[];
  stratum?: Stratum;
}

export interface RecallAtK {
  k: number;
  /** Queries where at least one gold target appeared in the top k. */
  hits: number;
  /** Queries that had at least one gold target to find (the only scoreable ones). */
  scoreable: number;
  recall: number;
  /**
   * Queries with no gold target at all — correctly-NIL mentions. Excluded from recall: there was
   * nothing to retrieve, so counting them would make a good blocker look bad on a hard corpus.
   */
  nilQueries: number;
}

export function candidateRecallAtK(queries: CandidateQuery[], k: number): RecallAtK {
  let hits = 0;
  let scoreable = 0;
  let nilQueries = 0;

  for (const query of queries) {
    if (query.goldTargets.length === 0) {
      nilQueries++;
      continue;
    }
    scoreable++;
    const topK = query.candidates.slice(0, k);
    if (topK.some((candidate) => query.goldTargets.includes(candidate))) hits++;
  }

  return {
    k,
    hits,
    scoreable,
    recall: scoreable === 0 ? 0 : hits / scoreable,
    nilQueries,
  };
}

export function recallCurve(queries: CandidateQuery[], ks: number[]): RecallAtK[] {
  return ks.map((k) => candidateRecallAtK(queries, k));
}

export function recallAtKByStratum(
  queries: CandidateQuery[],
  k: number
): Record<Stratum, RecallAtK> {
  const buckets = new Map<Stratum, CandidateQuery[]>();
  for (const query of queries) {
    const stratum = query.stratum ?? 'unstratified';
    const bucket = buckets.get(stratum);
    if (bucket) bucket.push(query);
    else buckets.set(stratum, [query]);
  }

  const out: Record<Stratum, RecallAtK> = {};
  for (const [stratum, bucket] of buckets) out[stratum] = candidateRecallAtK(bucket, k);
  out.all = candidateRecallAtK(queries, k);
  return out;
}

export interface BlockingEfficiency {
  /** Distinct candidate pairs the blocker proposed. */
  candidatePairs: number;
  /** Pairs an exhaustive comparison would have made: C(n, 2). */
  totalPairs: number;
  /** Gold-positive pairs the blocker surfaced / all gold-positive pairs. */
  pairCompleteness: number;
  /** 1 − candidatePairs / totalPairs. Higher means more comparisons avoided. */
  reductionRatio: number;
  truePositivePairsRetained: number;
  truePositivePairsTotal: number;
}

/**
 * Pair completeness and reduction ratio — the standard blocking trade-off.
 *
 * PC and RR pull against each other: proposing every pair gives PC 1 and RR 0. Both are reported
 * because either alone is trivially gameable, and E4's arms differ mainly in where they sit on
 * that curve.
 */
export function blockingEfficiency(args: {
  queries: CandidateQuery[];
  /** Every element the blocker could have compared against — the universe size drives C(n,2). */
  universeSize: number;
  /** Gold-positive pairs, as {@link pairKey} strings. */
  goldPairs: Set<string>;
}): BlockingEfficiency {
  const proposed = new Set<string>();
  for (const query of args.queries) {
    for (const candidate of query.candidates) {
      if (candidate !== query.mention) proposed.add(pairKey(query.mention, candidate));
    }
  }

  let retained = 0;
  for (const pair of proposed) if (args.goldPairs.has(pair)) retained++;

  const totalPairs = (args.universeSize * (args.universeSize - 1)) / 2;

  return {
    candidatePairs: proposed.size,
    totalPairs,
    pairCompleteness: args.goldPairs.size === 0 ? 0 : retained / args.goldPairs.size,
    reductionRatio: totalPairs === 0 ? 0 : 1 - proposed.size / totalPairs,
    truePositivePairsRetained: retained,
    truePositivePairsTotal: args.goldPairs.size,
  };
}

/**
 * Mean reciprocal rank of the first correct candidate — a position-sensitive companion to
 * recall@k.
 *
 * Worth reporting because the design mandates similarity-ordered top-k *precisely because*
 * position bias is real (`wang2024comem`): two blockers with identical recall@4 are not
 * equivalent if one puts the answer first and the other fourth.
 */
export function meanReciprocalRank(queries: CandidateQuery[]): {
  mrr: number;
  scoreable: number;
} {
  let sum = 0;
  let scoreable = 0;

  for (const query of queries) {
    if (query.goldTargets.length === 0) continue;
    scoreable++;
    const rank = query.candidates.findIndex((candidate) => query.goldTargets.includes(candidate));
    if (rank >= 0) sum += 1 / (rank + 1);
  }

  return { mrr: scoreable === 0 ? 0 : sum / scoreable, scoreable };
}
