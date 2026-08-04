import type { ProposedPair } from './proposePairs';

/**
 * Silver pre-labelling: a suggested verdict per proposed pair, with the rule that produced it.
 *
 * **Silver is not gold.** Every suggestion here comes from a stated string rule, and string rules
 * cannot decide identity — that is the premise of the entire experiment. The value is triage: rules
 * that are near-certain let you bulk-accept, and everything else is surfaced as `review` so your
 * attention goes where judgment is actually needed.
 *
 * Two design constraints:
 *
 * 1. **Every suggestion names its rule**, so you can audit a rule once and accept or reject all of
 *    its rows together instead of re-deriving the reasoning 1,600 times.
 * 2. **Uncertain means `review`, never a guess.** A wrong `same` that gets bulk-accepted is a
 *    corrupted cluster that propagates through transitive closure; a `review` costs you a glance.
 *    The asymmetry matches the mint-if-uncertain convention the system itself uses.
 */

export type Suggestion = 'same' | 'different' | 'review';

/**
 * Which proposer(s) surfaced a row: `+`-joined sorted source names — `string`, `registry`,
 * `embedding`, `registry+string`, `embedding+string`, … The legacy spelling `both`
 * (= `registry+string`) still parses; `sourceSet` is the one place that knows it.
 */
export type PairSource = string;

/** Parse a source cell into the set of proposers. Absent means the string sweep. */
export function sourceSet(source: string | undefined): Set<string> {
  if (source === undefined || source.trim() === '') return new Set(['string']);
  if (source === 'both') return new Set(['registry', 'string']);
  return new Set(
    source
      .split('+')
      .map((name) => name.trim())
      .filter(Boolean)
  );
}

/** Serialize a set of proposers back to the canonical `+`-joined sorted spelling. */
export function joinSources(sources: Iterable<string>): PairSource {
  return [...new Set(sources)].sort().join('+');
}

/**
 * A worksheet row before adjudication: a proposal from either proposer.
 *
 * Wider than `ProposedPair` in one way that matters — `stratum` is a plain string, because the
 * registry proposer emits a provisional `c` and the annotator may write `d`, neither of which any
 * string mechanism can produce.
 */
export type WorksheetPair = Omit<ProposedPair, 'stratum'> & {
  stratum: string;
  source?: PairSource;
  /** The registry canonical, when a registry proposed this row. Context, never evidence. */
  canonical?: string;
};

export interface PreLabelRule {
  id: string;
  /** Why this rule is safe to apply mechanically — read this before bulk-accepting its rows. */
  rationale: string;
  suggest: Suggestion;
  applies(pair: WorksheetPair): boolean;
}

const fold = (value: string) => value.trim().toLowerCase();

/** Digits in order, as a comparable signature. `UAC-0010` → `0010`; `CCR 1016` → `1016`. */
function digits(value: string): string {
  return (value.match(/\p{Nd}+/gu) ?? []).join('-');
}

/** Strip everything but letters and digits — the difference punctuation and spacing make. */
function alnum(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Content inside trailing brackets: `UAC-0010 (Armageddon)` → `armageddon`. */
function parenthetical(value: string): string | null {
  const match = value.match(/^(.*?)\s*[（(]([^)）]+)[)）]\s*$/u);
  return match ? fold(match[2]) : null;
}

function withoutParenthetical(value: string): string {
  return fold(value.replace(/\s*[（(][^)）]+[)）]\s*$/u, ''));
}

export const PRE_LABEL_RULES: PreLabelRule[] = [
  {
    id: 'cross-script',
    rationale:
      'A transliteration or confusable-skeleton key matched. These are script renderings of one ' +
      'name (India/Індія, NATO/НАТО), which is what stratum (b) means. Verify the pair is not a ' +
      'coincidental key collision, then accept the rule wholesale.',
    suggest: 'same',
    applies: (pair) => pair.stratum === 'b',
  },
  {
    id: 'punctuation-only',
    rationale:
      'Identical once punctuation, spacing and case are removed — "Cobalt Strike" vs ' +
      '"Cobalt-Strike". Nothing but typography separates them.',
    suggest: 'same',
    applies: (pair) => alnum(pair.left) === alnum(pair.right),
  },
  {
    id: 'decorated-identifier',
    rationale:
      'One side is the other plus a parenthetical gloss, with the same digits — ' +
      '"UAC-0010" vs "UAC-0010 (Armageddon)". The bracket names the same entity, it does not ' +
      'select a different one.',
    suggest: 'same',
    applies: (pair) => {
      const leftHasParen = parenthetical(pair.left) !== null;
      const rightHasParen = parenthetical(pair.right) !== null;
      if (leftHasParen === rightHasParen) return false;
      const bare = leftHasParen ? fold(pair.right) : fold(pair.left);
      const decorated = leftHasParen ? withoutParenthetical(pair.left) : withoutParenthetical(pair.right);
      return bare === decorated && digits(pair.left) === digits(pair.right);
    },
  },
  {
    id: 'differing-digits',
    rationale:
      'Both sides carry digits and the digits differ — "MikroTik CCR 1016" vs "CCR 1036", ' +
      '"UAC-0010" vs "UAC-0018". In this corpus the numeric payload IS the identity: same vendor, ' +
      'same product line, different product; same designator prefix, different group. This rule ' +
      'covers the near-miss pairs that string similarity scores highest, and it is the single ' +
      'largest source of false merges if left to a threshold.',
    suggest: 'different',
    applies: (pair) => {
      const left = digits(pair.left);
      const right = digits(pair.right);
      return left !== '' && right !== '' && left !== right;
    },
  },
  {
    id: 'one-sided-digits',
    rationale:
      'Exactly one side carries digits — "Netgear" vs "Netgear R7000". A model number narrows a ' +
      'family to a product, so the bare name and the numbered one are usually different entities ' +
      'at different granularity. Worth a glance: the opposite reading (an abbreviation of the ' +
      'same thing) does occur.',
    suggest: 'review',
    applies: (pair) => (digits(pair.left) === '') !== (digits(pair.right) === ''),
  },
];

/**
 * Adjustments that depend on *provenance* rather than on the two surfaces.
 *
 * These cannot be ordinary rules, because they are defined in terms of what the string rules
 * concluded — a first-match-wins cascade cannot express "and a different-suggesting rule fired".
 * They are exported anyway so `gold rules` can explain every mechanism that touches a suggestion.
 *
 * Note what is deliberately **absent**: a rule that re-suggests `same` when the registry agrees
 * with a `same`-suggesting string rule. It would change no verdict while overwriting the rule id,
 * and the rule ids are what let you audit a rule once and accept all of its rows together. The
 * corroboration is carried by the `source` column instead.
 */
export const PROVENANCE_RULES = [
  {
    id: 'registry-conflict',
    rationale:
      'A registry merged these two surfaces and a string rule rejects them — "Microsoft Office ' +
      '2010" vs "2016", merged under "Microsoft Office" but separated by differing-digits. Two ' +
      'proposers disagreeing is the highest-information row in the worksheet, so it goes to you ' +
      'rather than being decided silently. Expect most to confirm `different`: the registry ' +
      'collapses hierarchy, merging a version into its product and a host into its domain.',
    suggest: 'review' as const,
  },
  {
    id: 'registry-semantic',
    rationale:
      'A registry proposed this pair and no string mechanism explains it — "APT44"/"Sandworm", ' +
      '"GhostWriter"/"unc1151". These are the stratum (c)/(d) candidates no string sweep can ' +
      'reach, and they are also where the registry\'s granularity errors live ("MS Exchange" vs ' +
      '"Microsoft Exchange Server 2016"). Never bulk-accept them: read each one, set the stratum ' +
      'to `c` or `d`, and attach evidence to every positive merge.',
    suggest: 'review' as const,
  },
  {
    id: 'embedding-neighbour',
    rationale:
      'A dense-embedding sweep proposed this pair and no string mechanism explains it — the ' +
      'channel that can surface zero-overlap aliases ("Fancy Bear"/"APT28") and cross-script ' +
      'pairs. Unlike a registry row, an embedding neighbour asserts nothing but proximity in ' +
      'vector space, and proximity is not identity: expect mostly `different` with the occasional ' +
      'real find. The stratum is provisional (c) for the same reason as registry rows.',
    suggest: 'review' as const,
  },
];

export interface PreLabelled extends Omit<WorksheetPair, 'label'> {
  /** Prefilled with the suggestion ('' for `review`) — the human overwrites it. */
  label: string;
  /** The rule's verdict: 'same' | 'different' | 'review'. You overwrite this in `label`. */
  suggested: Suggestion;
  /** Which rule fired, or 'none'. Audit the rule once, then accept its rows together. */
  rule: string;
}

/** The label a suggestion prefills: a confident verdict verbatim, `review` deliberately nothing. */
const prefillOf = (suggested: Suggestion): string => (suggested === 'review' ? '' : suggested);

/**
 * Apply the rules in order; the first that fires wins. Then apply the provenance adjustments.
 *
 * Order matters and is deliberate: `cross-script` precedes `differing-digits` so `АРТ28`/`APT28`
 * is not rejected for having "different digits" when in fact both read 28. A pair no rule claims
 * gets `review`, which is the honest default — most stratum-(a) proposals genuinely need a human.
 *
 * The string rules run **first and unchanged** on registry rows. That ordering is the whole
 * safeguard: `differing-digits` keeps priority over anything a registry asserts, so a registry
 * merge can only ever be softened to `review`, never promoted to `same`.
 */
export function preLabel(pairs: WorksheetPair[]): PreLabelled[] {
  return pairs.map((pair) => {
    let suggested: Suggestion = 'review';
    let rule = 'none';
    for (const candidate of PRE_LABEL_RULES) {
      if (candidate.applies(pair)) {
        suggested = candidate.suggest;
        rule = candidate.id;
        break;
      }
    }

    const sources = sourceSet(pair.source);
    // A registry merge that a string rule rejects goes to a human: two proposers disagreeing is
    // the highest-information row. An embedding neighbour gets no such softening — it asserts
    // nothing but proximity, so there is no conflicting claim to surface.
    if (sources.has('registry') && suggested === 'different') {
      return { ...pair, label: '', suggested: 'review' as const, rule: 'registry-conflict' };
    }
    // Rows the string sweep did NOT propose and no string rule decides are re-attributed, because
    // on these the string rule that claimed them is a coincidence: `one-sided-digits` fires on
    // `APT44`/`Sandworm` and offers "a model number narrows a family to a product", which explains
    // nothing about that pair. The provenance rule tells the annotator why the row is here and
    // what to do with it; registry guidance wins over embedding because it carries the stratum
    // instructions. Rows the string sweep also proposed keep their rule — there the attribution
    // is real.
    if (!sources.has('string') && suggested === 'review') {
      if (sources.has('registry')) return { ...pair, label: '', suggested, rule: 'registry-semantic' };
      if (sources.has('embedding')) return { ...pair, label: '', suggested, rule: 'embedding-neighbour' };
    }
    return { ...pair, label: prefillOf(suggested), suggested, rule };
  });
}

export function preLabelSummary(
  pairs: PreLabelled[]
): Array<{ rule: string; suggested: Suggestion; pairs: number }> {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const key = `${pair.rule} ${pair.suggested}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [rule, suggested] = key.split(' ');
      return { rule, suggested: suggested as Suggestion, pairs: count };
    })
    .sort((a, b) => b.pairs - a.pairs);
}
