import type { Candidate, DecisionStrategy } from '../Normalization/types';
import type { DecisionPoint, ReplayStrategy, ReplayVerdict } from './replayLog';

/**
 * Runs a real {@link DecisionStrategy} over logged decision points.
 *
 * **This is what makes the strategy comparison affordable.** A logged run records the exact
 * candidate list each mention was judged against, so every non-LLM arm — `exact-only`, `threshold`,
 * `fellegi-sunter` — can be scored against the same decision points for zero marginal cost, without
 * re-running extraction or re-deriving candidates. Re-deriving them would measure the generator; the
 * point here is to hold retrieval fixed and vary only the decision.
 *
 * One point per `decide()` call, deliberately. The batched LLM strategies exist to make one call per
 * document, and replaying them one mention at a time would multiply their cost while changing the
 * context the judge sees — so those are not meaningfully replayable through this adapter, and the
 * CLI restricts itself to the offline strategies.
 */
export class StrategyReplayAdapter implements ReplayStrategy {
  public readonly id: string;

  #strategy: DecisionStrategy;
  #missingSurfaces = 0;

  constructor(strategy: DecisionStrategy) {
    this.#strategy = strategy;
    this.id = strategy.id;
  }

  /**
   * How many replayed points had no logged alias surfaces.
   *
   * Non-zero means the log predates M6, so alias-sensitive strategies were judged on names alone and
   * their scores are a **lower bound**, not a measurement. The CLI reports this rather than letting
   * it pass silently — a quietly degraded arm looks like a genuinely weaker one.
   */
  get missingSurfaces(): number {
    return this.#missingSurfaces;
  }

  async decide(point: DecisionPoint): Promise<ReplayVerdict> {
    const candidates: Candidate[] = point.candidates.map((candidate) => {
      if (candidate.surfaces === undefined) this.#missingSurfaces++;
      return {
        canonical: candidate.name,
        sim: candidate.sim,
        // Missing means unknown, not empty: fall back to the canonical alone, which is what a
        // name-only comparison would have used anyway.
        surfaces: candidate.surfaces ?? [candidate.name],
        channel: candidate.channel,
      };
    });

    const [decision] = await this.#strategy.decide([
      {
        mention: point.mention,
        category: point.category,
        candidates,
        docId: point.docId,
      },
    ]);

    return {
      decision: decision.kind,
      target: decision.target,
      confidence: decision.confidence,
    };
  }
}
