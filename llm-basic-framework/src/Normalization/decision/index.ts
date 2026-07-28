import { ComemSelectDecision } from './ComemSelectDecision';
import { ExactOnlyDecision } from './ExactOnlyDecision';
import { FellegiSunterDecision } from './FellegiSunterDecision';
import { ListwiseMintCandidateDecision } from './ListwiseMintCandidateDecision';
import { ThresholdDecision } from './ThresholdDecision';

export { ComemSelectDecision } from './ComemSelectDecision';
export { ExactOnlyDecision } from './ExactOnlyDecision';
export { FellegiSunterDecision, defaultComparators, type Comparator } from './FellegiSunterDecision';
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
  'comem-select': ComemSelectDecision,
} as const;

export type DecisionStrategyId = keyof typeof DECISION_STRATEGIES;

/** Strategy ids that make no LLM calls, so they can run without a configured backend. */
export const OFFLINE_STRATEGY_IDS: DecisionStrategyId[] = [
  'exact-only',
  'threshold',
  'fellegi-sunter',
];
