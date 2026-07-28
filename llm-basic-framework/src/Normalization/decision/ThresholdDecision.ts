import type { Decision, DecisionRequest, DecisionStrategy } from '../types';

interface Params {
  /**
   * Link when the top candidate scores at or above this. The plan's pole is 0.8, which is where
   * `dong2023reveal` lands for two of its five datasets — not a tuned value, a *cited* one.
   */
  threshold?: number;
  /**
   * Optional abstention band. When set, a top score in `[threshold - band, threshold)` returns
   * `defer` instead of `mint`. Off by default, so the plain arm stays a clean two-way pole.
   */
  deferBand?: number;
  /**
   * Require the top candidate to beat the runner-up by this margin, else defer. Off by default.
   * A near-tie is the case a threshold genuinely cannot adjudicate.
   */
  minMargin?: number;
}

/**
 * Links the top candidate when its similarity clears a fixed threshold.
 *
 * **The statistical pole, and the strategy the experiment expects to fail informatively.** Its value
 * is not that it works but that it makes the threshold's weakness measurable. `dong2023reveal` tunes
 * this to 0.45/0.55/0.80/0.95/0.95 across five datasets — a spread that already says no single value
 * transfers — and still reports failures on confidently-wrong near-1.0 matches, which no threshold
 * can fix at any setting.
 *
 * This corpus has that failure in it: 73 queries retrieve more than one candidate at similarity
 * exactly 1.0 (the `accounts-ukr.net` family, plausible typosquats), and `UAC-0010` retrieves
 * `UAC-0018`/`0050`/`0210` at 0.875 *ahead of* its own `UAC-0010 (Armageddon)` alias at 0.8. Any
 * threshold linking the first case is wrong, and any threshold in (0.8, 0.875] gets the second
 * exactly backwards. That is what this arm is here to demonstrate.
 *
 * The `deferBand` and `minMargin` options exist so the abstention variant can be run as its own arm:
 * the interesting question is whether declining the near-ties recovers the precision the threshold
 * loses, or whether it just declines everything.
 */
export class ThresholdDecision implements DecisionStrategy {
  public readonly id = 'threshold';
  public readonly config: Record<string, unknown>;

  #threshold: number;
  #deferBand: number;
  #minMargin: number;

  constructor(params: Params = {}) {
    this.#threshold = params.threshold ?? 0.8;
    this.#deferBand = params.deferBand ?? 0;
    this.#minMargin = params.minMargin ?? 0;

    if (this.#threshold < 0 || this.#threshold > 1) {
      throw new Error(`ThresholdDecision: threshold must be in [0, 1], got ${this.#threshold}`);
    }
    this.config = {
      threshold: this.#threshold,
      deferBand: this.#deferBand,
      minMargin: this.#minMargin,
    };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    return requests.map((request) => {
      // Candidates arrive sorted by compareCandidates, so [0] is the top and [1] the runner-up.
      const top = request.candidates[0];
      if (!top) {
        return { kind: 'mint', target: null, confidence: null, reason: 'no candidates' };
      }

      if (top.sim >= this.#threshold) {
        const runnerUp = request.candidates[1];
        const margin = runnerUp ? top.sim - runnerUp.sim : Infinity;
        if (this.#minMargin > 0 && margin < this.#minMargin) {
          return {
            kind: 'defer',
            target: null,
            // The similarity is a retrieval score, not a calibrated probability of identity. Passing
            // it off as confidence would put an uncalibrated number into E5's calibration curves.
            confidence: null,
            reason: `top two within ${margin.toFixed(3)} < minMargin ${this.#minMargin}`,
          };
        }
        return {
          kind: 'link',
          target: top.canonical,
          confidence: null,
          reason: `sim ${top.sim.toFixed(3)} >= ${this.#threshold}`,
        };
      }

      if (this.#deferBand > 0 && top.sim >= this.#threshold - this.#deferBand) {
        return {
          kind: 'defer',
          target: null,
          confidence: null,
          reason: `sim ${top.sim.toFixed(3)} in defer band [${(this.#threshold - this.#deferBand).toFixed(3)}, ${this.#threshold})`,
        };
      }

      return {
        kind: 'mint',
        target: null,
        confidence: null,
        reason: `sim ${top.sim.toFixed(3)} < ${this.#threshold}`,
      };
    });
  }
}
