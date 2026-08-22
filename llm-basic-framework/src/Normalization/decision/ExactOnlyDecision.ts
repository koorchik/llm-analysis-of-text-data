import type { Decision, DecisionRequest, DecisionStrategy } from '../types';

interface Params {
  /** Case-insensitive by default, matching what `ConceptRegistry.resolve()` treats as identical. */
  caseSensitive?: boolean;
}

/**
 * Links only on an exact surface match, mints otherwise. Never defers, never calls an LLM.
 *
 * **This is the floor, and the floor is the point.** Every other strategy costs money or latency, so
 * each has to justify itself against a baseline that costs neither. If `ThresholdDecision` or the
 * LLM judge cannot beat exact-match by more than the bootstrap CI, that is the headline finding, not
 * a failed experiment — and without this arm in the results table there is nothing to say it against.
 *
 * It also bounds the corpus: 2,411 of 2,673 canonicals are singletons, so a strategy that links
 * nothing already gets most cluster decisions right. Reporting F1 without this reference would make
 * that structural fact look like an achievement.
 *
 * In practice the streaming pipeline resolves exact matches before a strategy is consulted at all, so
 * this arm mints nearly everything it sees. That is expected: it measures what the fast path alone
 * achieves.
 */
export class ExactOnlyDecision implements DecisionStrategy {
  public readonly id = 'exact-only';
  public readonly config: Record<string, unknown>;

  #caseSensitive: boolean;

  constructor(params: Params = {}) {
    this.#caseSensitive = params.caseSensitive ?? false;
    this.config = { caseSensitive: this.#caseSensitive };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    return requests.map((request) => {
      const mention = this.#fold(request.mention);
      const hit = request.candidates.find((candidate) =>
        [candidate.canonical, ...candidate.surfaces].some(
          (surface) => this.#fold(surface) === mention
        )
      );

      if (!hit) {
        return { kind: 'mint', target: null, confidence: null, reason: 'no exact surface match' };
      }
      // Confidence 1 is honest here in a way it would not be for a similarity score: the strings are
      // equal under the stated folding, so there is nothing left to be uncertain about.
      return { kind: 'link', target: hit.canonical, confidence: 1, reason: 'exact surface match' };
    });
  }

  #fold(value: string): string {
    const trimmed = value.trim();
    return this.#caseSensitive ? trimmed : trimmed.toLowerCase();
  }
}
