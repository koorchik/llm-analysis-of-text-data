import type { CostTotals } from '../Experiment/CostMeter';
import type { LlmSamplingSupport } from '../LlmClient/LlmClientBackendBase';
import { aggregateSeeds, type SeedAggregate } from './bootstrap';
import type { ClusterMetricSuite, MergeMetrics, Stratum } from './clusterMetrics';
import type { NilMetrics } from './nilMetrics';

/**
 * The one composed results table (Phase 8.4): rows = conditions, columns = per-stratum merge P/R,
 * NIL F1, cluster F1, calls/tokens/$, downstream τ, and order-ARI where applicable.
 *
 * Two reporting rules are enforced by the shape rather than left to discipline:
 *
 * - **Strata are separate columns, never averaged.** There is no field for "mean merge F1 across
 *   strata", because averaging a near-ceiling memorized head with a novel tail hides the exact
 *   effect the two-claims framing exists to show.
 * - **The determinism tier is a column.** It is derived from the run card's recorded sampling
 *   support, not from the provider name, so a table can never present three non-equivalent kinds
 *   of "3 seeds" as if they were the same claim.
 */

export type DeterminismTier = 'seeded' | 'zero-temperature' | 'default-sampling' | 'unknown';

/**
 * Classify a condition's determinism tier from what the backend actually accepts.
 *
 * Reads `sampling.supported` off the run card rather than inferring from the provider string —
 * pinning an older Anthropic model that still accepts `temperature` genuinely moves that arm to a
 * different tier, and the run card is the only place that difference is recorded.
 */
export function determinismTier(
  sampling: { supported: LlmSamplingSupport; effective: { temperature?: number; seed?: number } }
): DeterminismTier {
  if (sampling.supported.seed) return 'seeded';
  if (sampling.supported.temperature) {
    return sampling.effective.temperature === 0 ? 'zero-temperature' : 'unknown';
  }
  return 'default-sampling';
}

export const TIER_STRENGTH: Record<DeterminismTier, string> = {
  seeded: 'strongest available (distinct seed values)',
  'zero-temperature': 'weaker — no seed, but sampling pinned at temperature 0',
  'default-sampling': 'weakest — sampling not pinned at all; replicates vary under provider defaults',
  unknown: 'unclassified — sampling supported but not pinned; state explicitly before reporting',
};

export interface ConditionResult {
  condition: string;
  runIds: string[];
  tier: DeterminismTier;
  /** Per-stratum merge metrics, keyed by stratum. Includes the pooled `all` row. */
  merge: Record<Stratum, MergeMetrics>;
  nil: NilMetrics;
  cluster: ClusterMetricSuite;
  cost: CostTotals;
  /** Aggregates across seeds for the headline figure. Empty when only one seed exists. */
  seedAggregates?: Record<string, SeedAggregate>;
  /** Kendall τ-b against the gold-normalized reference graph (M11). */
  downstreamTau?: number | null;
  /** ARI between registries from shuffled document orders (E6). */
  orderAri?: number | null;
  /** Models with no price entry — their spend is missing from `cost.costUsd`. */
  unpricedModels?: string[];
}

const fixed = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : value.toFixed(digits);

const integer = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : String(Math.round(value));

/**
 * Render the composed table as Markdown.
 *
 * Strata order is taken from the data, with `all` forced last so the pooled row cannot be mistaken
 * for the headline. Any condition with unpriced models gets an explicit cost caveat instead of a
 * dollar figure that silently omits spend.
 */
export function renderResultsTable(
  results: ConditionResult[],
  options: { strata?: Stratum[] } = {}
): string {
  const strata =
    options.strata ??
    [
      ...new Set(results.flatMap((result) => Object.keys(result.merge))),
    ].sort((a, b) => (a === 'all' ? 1 : b === 'all' ? -1 : a < b ? -1 : 1));

  const header = [
    'condition',
    'tier',
    ...strata.flatMap((stratum) => [`merge P (${stratum})`, `merge R (${stratum})`]),
    'NIL F1',
    'defer rate',
    'cluster F1 (pairwise)',
    'B³ F1',
    'ARI',
    'calls',
    'tokens',
    '$',
    'τ down',
    'order ARI',
  ];

  const rows = results.map((result) => {
    const totalTokens = result.cost.inputTokens + result.cost.outputTokens;
    const cost =
      result.unpricedModels && result.unpricedModels.length > 0
        ? `unpriced (${result.cost.unpricedCalls} calls)`
        : fixed(result.cost.costUsd, 4);

    // With no shared elements there is nothing to compare, so every cluster-level figure is
    // meaningless — including ARI, which returns a vacuous 1 for n < 2. Printing those numbers
    // would contradict the accompanying "undefined, not zero" note.
    const scoreable = result.cluster.universeSize > 0;
    const clusterCell = (value: number) => (scoreable ? fixed(value) : '—');

    return [
      result.condition,
      result.tier,
      ...strata.flatMap((stratum) => {
        const merge = result.merge[stratum];
        return merge ? [fixed(merge.precision), fixed(merge.recall)] : ['—', '—'];
      }),
      fixed(result.nil.f1),
      result.nil.observations > 0 ? fixed(result.nil.deferralRate) : '—',
      clusterCell(result.cluster.pairwise.f1),
      clusterCell(result.cluster.bCubed.f1),
      clusterCell(result.cluster.ari),
      integer(result.cost.calls),
      integer(totalTokens),
      cost,
      fixed(result.downstreamTau),
      fixed(result.orderAri),
    ];
  });

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length))
  );

  const line = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;

  const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;

  return [line(header), separator, ...rows.map(line)].join('\n');
}

/**
 * Notes that must accompany the table. These are not decoration — each corresponds to a commitment
 * in `docs/statistical-protocol.md`, and omitting them would make the table overstate its claims.
 */
export function tableNotes(results: ConditionResult[]): string[] {
  const notes: string[] = [];

  notes.push(
    'Strata are reported separately and never averaged; the `all` column is pooled for completeness only.'
  );

  const tiers = new Set(results.map((result) => result.tier));
  if (tiers.size > 1) {
    notes.push(
      'Conditions differ in determinism tier, so their between-seed variability is NOT comparable: ' +
        [...tiers].map((tier) => `${tier} = ${TIER_STRENGTH[tier]}`).join('; ') +
        '.'
    );
  }
  if (tiers.has('default-sampling')) {
    notes.push(
      'At least one condition has no determinism lever at all (sampling parameters rejected by the ' +
        'provider), so its replicates vary under full default sampling. State this in threats to validity.'
    );
  }

  const unpriced = new Set(results.flatMap((result) => result.unpricedModels ?? []));
  if (unpriced.size > 0) {
    notes.push(
      `No $ figure is quotable for: ${[...unpriced].join(', ')} — no price entry, so their spend is ` +
        'absent from the cost column. Token counts are unaffected.'
    );
  }

  const deferring = results.filter((result) => result.nil.deferralRate > 0);
  if (deferring.length > 0) {
    notes.push(
      'Deferrals are excluded from NIL precision and charged against NIL recall (protocol §5); the ' +
        'deferral-rate column is required to interpret the precision figures.'
    );
  }

  if (results.some((result) => result.cluster.universeSize === 0)) {
    notes.push('A condition scored an empty shared universe — its metrics are undefined, not zero.');
  }

  return notes;
}

/** Aggregate a metric across seeds for one condition, per protocol §4 (mean + between-seed SD). */
export function aggregateConditionSeeds(
  perSeed: Array<Record<string, number>>
): Record<string, SeedAggregate> {
  const keys = new Set(perSeed.flatMap((entry) => Object.keys(entry)));
  const out: Record<string, SeedAggregate> = {};
  for (const key of keys) {
    out[key] = aggregateSeeds(
      perSeed.map((entry) => entry[key]).filter((value): value is number => typeof value === 'number')
    );
  }
  return out;
}
