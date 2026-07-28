import { charNgramCosine, levenshteinRatio } from '../metrics/stringMetrics';
import type { Decision, DecisionRequest, DecisionStrategy } from '../types';

/**
 * One binary comparison between a mention and a candidate. Fellegi–Sunter is defined over a vector
 * of these, not over a single score — that is exactly what distinguishes it from a threshold.
 */
export interface Comparator {
  readonly id: string;
  agrees(mention: string, surface: string): boolean;
  /** P(this comparator agrees | the pair is a true match). */
  m: number;
  /** P(this comparator agrees | the pair is not a match). */
  u: number;
}

interface Params {
  comparators?: Comparator[];
  /** Link when the total weight is at or above this (FS's upper cutoff, in log2 odds). */
  upper?: number;
  /** Mint when the total weight is at or below this (FS's lower cutoff). Between the two: defer. */
  lower?: number;
  /**
   * Collapse the middle region into `mint` instead of `defer`. Needed to run FS as a two-way arm
   * comparable with the others; the three-way form is the faithful one.
   */
  noDefer?: boolean;
}

const clampProbability = (value: number, name: string): number => {
  if (!(value > 0 && value < 1)) {
    // 0 or 1 makes the log weight infinite, which would let one comparator override every other.
    throw new Error(`FellegiSunterDecision: ${name} must be strictly within (0, 1), got ${value}`);
  }
  return value;
};

const fold = (value: string) => value.trim().toLowerCase();
const tokens = (value: string) => fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The default comparator vector.
 *
 * **The m/u values are literature-standard priors, not fitted to this corpus** — that is a deliberate
 * choice and a limitation to report, not an oversight. Fitting them here would need labelled pairs,
 * and the only labels available are the gold table the strategies are scored against; using it to
 * tune a strategy and then scoring that strategy on it would be circular. So this arm answers "how
 * far does classical record linkage get with reasonable priors", which is the honest question for a
 * baseline. An EM-fitted variant is a legitimate later arm, and would need its own held-out split.
 */
export function defaultComparators(): Comparator[] {
  return [
    {
      id: 'exact',
      agrees: (mention, surface) => fold(mention) === fold(surface),
      m: 0.7,
      u: 0.001,
    },
    {
      id: 'edit-similar',
      agrees: (mention, surface) => levenshteinRatio(fold(mention), fold(surface)) >= 0.85,
      m: 0.85,
      u: 0.02,
    },
    {
      id: 'trigram-similar',
      agrees: (mention, surface) => charNgramCosine(fold(mention), fold(surface), 3) >= 0.7,
      m: 0.8,
      u: 0.05,
    },
    {
      id: 'shares-rare-token',
      // A shared token of 4+ characters. Short tokens ("the", "ltd", "uac") agree by chance often
      // enough that treating them as evidence is what produces confidently-wrong links.
      agrees: (mention, surface) => {
        const surfaceTokens = new Set(tokens(surface).filter((token) => token.length >= 4));
        return tokens(mention).some((token) => token.length >= 4 && surfaceTokens.has(token));
      },
      m: 0.9,
      u: 0.08,
    },
    {
      id: 'same-digits',
      // Numeric payloads carry most of the identity in this corpus's group names (UAC-0010).
      // Disagreement here is strong evidence *against*, which is the asymmetry a single similarity
      // score cannot express: UAC-0010 and UAC-0018 are 0.875 similar and definitely distinct.
      agrees: (mention, surface) => {
        const digitsOf = (value: string) => (value.match(/\p{Nd}+/gu) || []).join('-');
        const a = digitsOf(mention);
        const b = digitsOf(surface);
        return a !== '' && a === b;
      },
      m: 0.75,
      u: 0.01,
    },
  ];
}

/**
 * Classical probabilistic record linkage (Fellegi & Sunter 1969).
 *
 * **The non-LLM statistical pole.** Where `ThresholdDecision` reduces a pair to one number, FS scores
 * an *agreement pattern*: each comparator contributes `log2(m/u)` when it agrees and
 * `log2((1-m)/(1-u))` when it does not, and the sum is compared against two cutoffs. Two properties
 * fall out that a threshold cannot express, and both matter on this corpus:
 *
 * 1. **Disagreement is evidence.** `UAC-0010` vs `UAC-0018` agree on edit distance and trigrams but
 *    disagree on digits; the negative weight from `same-digits` pulls the pair apart. A similarity
 *    score has no way to say "these are similar *and* that similarity is the wrong kind".
 * 2. **The middle region is a first-class outcome.** FS's three-way rule (link / possible link /
 *    non-link) is where `defer` comes from historically, and it is the honest answer for the 73
 *    queries that retrieve several candidates at similarity exactly 1.0.
 *
 * Cost: zero LLM calls. If this beats the judge, the paper's claim changes shape — which is precisely
 * why it runs alongside E1 rather than after it.
 */
export class FellegiSunterDecision implements DecisionStrategy {
  public readonly id = 'fellegi-sunter';
  public readonly config: Record<string, unknown>;

  #comparators: Comparator[];
  #upper: number;
  #lower: number;
  #noDefer: boolean;

  constructor(params: Params = {}) {
    this.#comparators = params.comparators ?? defaultComparators();
    for (const comparator of this.#comparators) {
      clampProbability(comparator.m, `comparator "${comparator.id}" m`);
      clampProbability(comparator.u, `comparator "${comparator.id}" u`);
    }

    this.#upper = params.upper ?? 6;
    this.#lower = params.lower ?? 0;
    if (this.#lower > this.#upper) {
      throw new Error(
        `FellegiSunterDecision: lower (${this.#lower}) must not exceed upper (${this.#upper})`
      );
    }
    this.#noDefer = params.noDefer ?? false;

    this.config = {
      comparators: this.#comparators.map((comparator) => ({
        id: comparator.id,
        m: comparator.m,
        u: comparator.u,
      })),
      upper: this.#upper,
      lower: this.#lower,
      noDefer: this.#noDefer,
    };
  }

  async decide(requests: DecisionRequest[]): Promise<Decision[]> {
    return requests.map((request) => {
      if (request.candidates.length === 0) {
        return { kind: 'mint', target: null, confidence: null, reason: 'no candidates' };
      }

      let best: { canonical: string; weight: number; pattern: string } | null = null;
      for (const candidate of request.candidates) {
        // Score against the candidate's best-agreeing surface, not only its canonical name: an
        // alias is exactly the evidence the registry stores, and ignoring it would penalise
        // candidates whose canonical happens to be the least similar of their surfaces.
        const scored = this.#scoreCandidate(request.mention, [
          candidate.canonical,
          ...candidate.surfaces,
        ]);
        // Ties break on canonical name, matching compareCandidates, so the arm is order-independent.
        if (
          !best ||
          scored.weight > best.weight ||
          (scored.weight === best.weight && candidate.canonical < best.canonical)
        ) {
          best = { canonical: candidate.canonical, weight: scored.weight, pattern: scored.pattern };
        }
      }

      const { canonical, weight, pattern } = best!;
      const detail = `weight ${weight.toFixed(2)} [${pattern}]`;

      if (weight >= this.#upper) {
        return { kind: 'link', target: canonical, confidence: null, reason: detail };
      }
      if (weight > this.#lower && !this.#noDefer) {
        return { kind: 'defer', target: null, confidence: null, reason: `${detail} in FS middle region` };
      }
      return { kind: 'mint', target: null, confidence: null, reason: detail };
    });
  }

  #scoreCandidate(mention: string, surfaces: string[]): { weight: number; pattern: string } {
    let bestWeight = -Infinity;
    let bestPattern = '';

    for (const surface of surfaces) {
      let weight = 0;
      const agreed: string[] = [];
      for (const comparator of this.#comparators) {
        if (comparator.agrees(mention, surface)) {
          weight += Math.log2(comparator.m / comparator.u);
          agreed.push(comparator.id);
        } else {
          weight += Math.log2((1 - comparator.m) / (1 - comparator.u));
        }
      }
      if (weight > bestWeight) {
        bestWeight = weight;
        bestPattern = agreed.join('+') || 'none';
      }
    }

    return { weight: bestWeight, pattern: bestPattern };
  }
}
