import { ComemSelectDecision } from './ComemSelectDecision';
import { ExactOnlyDecision } from './ExactOnlyDecision';
import { FellegiSunterDecision } from './FellegiSunterDecision';
import { ListwiseGraphDecision } from './ListwiseGraphDecision';
import { ListwiseMintCandidateDecision } from './ListwiseMintCandidateDecision';
import { ThresholdDecision } from './ThresholdDecision';
import type { DecisionStrategy } from '../types';

export { ComemSelectDecision } from './ComemSelectDecision';
export { ExactOnlyDecision } from './ExactOnlyDecision';
export { FellegiSunterDecision, defaultComparators, type Comparator } from './FellegiSunterDecision';
export { ListwiseGraphDecision } from './ListwiseGraphDecision';
export { ListwiseMintCandidateDecision } from './ListwiseMintCandidateDecision';
export { ThresholdDecision } from './ThresholdDecision';

/**
 * The MVA set of decision strategies, by id.
 *
 * Two need an LLM client and two do not, which is the axis the results table is organised around:
 * `exact-only` and `threshold` and `fellegi-sunter` cost nothing per document, so any LLM arm has to
 * beat them by more than the bootstrap CI to justify its price.
 *
 * Deferred to M12 (E8, budget-dependent): `PairwiseJudgeDecision`, `CascadeDecision(ranker,
 * selector)`, `VotingDecision(child, rounds)`. With `bin/replay.ts` they can be added later without
 * touching the orchestration, which is why they are not blocking here. Note the note records
 * pairwise "comparing" as a **measured negative** — most expensive, and unable to recover from a
 * single wrong comparison — so it enters as a documented rejection, not a hopeful arm.
 */
export const DECISION_STRATEGIES = {
  'exact-only': ExactOnlyDecision,
  threshold: ThresholdDecision,
  'fellegi-sunter': FellegiSunterDecision,
  'listwise-mint-candidate': ListwiseMintCandidateDecision,
  'listwise-graph': ListwiseGraphDecision,
  'comem-select': ComemSelectDecision,
} as const;

export type DecisionStrategyId = keyof typeof DECISION_STRATEGIES;

/** Strategy ids that make no LLM calls, so they can run without a configured backend. */
export const OFFLINE_STRATEGY_IDS = ['exact-only', 'threshold', 'fellegi-sunter'] as const;

export type OfflineStrategyId = (typeof OFFLINE_STRATEGY_IDS)[number];

export interface OfflineStrategyOptions {
  /** ThresholdDecision */
  threshold?: number;
  deferBand?: number;
  minMargin?: number;
  /** FellegiSunterDecision */
  upper?: number;
  lower?: number;
  noDefer?: boolean;
  /** ExactOnlyDecision */
  caseSensitive?: boolean;
}

export function isOfflineStrategyId(id: string): id is OfflineStrategyId {
  return (OFFLINE_STRATEGY_IDS as readonly string[]).includes(id);
}

/**
 * Build an offline strategy by id.
 *
 * Exists so `bin/replay.ts` can construct one from a flag without switching on the id itself: the
 * classes take different option objects, and a union of their constructors is not callable. Unknown
 * options for the chosen strategy are ignored rather than rejected, because the CLI passes one flat
 * bag of flags for whichever strategy was asked for.
 */
export function createOfflineStrategy(
  id: OfflineStrategyId,
  options: OfflineStrategyOptions = {}
): DecisionStrategy {
  switch (id) {
    case 'exact-only':
      return new ExactOnlyDecision({ caseSensitive: options.caseSensitive });
    case 'threshold':
      return new ThresholdDecision({
        threshold: options.threshold,
        deferBand: options.deferBand,
        minMargin: options.minMargin,
      });
    case 'fellegi-sunter':
      return new FellegiSunterDecision({
        upper: options.upper,
        lower: options.lower,
        noDefer: options.noDefer,
      });
  }
}
