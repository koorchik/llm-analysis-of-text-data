import { f1Of, type PRF, type Stratum } from './clusterMetrics';

/**
 * Mint / NIL accounting, following `dong2023reveal`'s out-of-KB metric set.
 *
 * A **NIL** mention is one whose entity is not yet in the registry, so the correct action is to
 * mint. Because "not yet" depends on stream position, gold NIL labels are relative to a registry
 * prefix: the same mention is NIL at its cluster's first occurrence and known at every later one.
 * That is why gold stores one label per (docId, category, mention) occurrence rather than a flat
 * mention→label map (M2 gold schema).
 */

export interface NilObservation {
  docId: number;
  category: string;
  mention: string;
  /** What gold says the correct action was at this stream position. */
  goldNil: boolean;
  /** What the system actually did. */
  decision: 'link' | 'mint' | 'defer';
  stratum?: Stratum;
}

/**
 * Like {@link MergeMetrics}, precision/recall/F1 are `number | null` where null means *undefined*
 * rather than zero — a condition that emitted no mint claims, or a slice with no gold NILs, has no
 * defined figure, and printing 0 would make an abstention indistinguishable from a failure.
 */
export interface NilMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Predicted mint AND gold NIL. */
  truePositives: number;
  /** Predicted mint but the entity was already known — a wrong mint (duplicate). */
  falsePositives: number;
  /** Gold NIL but the system linked it to something — a wrong merge of a novel entity. */
  falseNegatives: number;
  trueNegatives: number;
  /** Withheld decisions: excluded from precision, charged against recall. */
  deferred: number;
  /** Deferrals on gold-NIL mentions, i.e. the part charged against recall. */
  deferredOnNil: number;
  observations: number;
  deferralRate: number;
}

/**
 * `defer` scoring, fixed in docs/statistical-protocol.md §5 **before** any defer was emitted:
 *
 * - excluded from **precision** — the system made no mint claim, so it can be neither right nor
 *   wrong about one;
 * - counted as a **miss in recall** — a gold NIL the system failed to mint is a failure whatever
 *   the reason. Without this, "defer everything" would score perfect precision at no recall cost;
 * - **deferral rate is always reported**, because a precision computed over a shrunken decision
 *   set is meaningless without knowing how much was withheld.
 */
export function nilMetrics(observations: NilObservation[]): NilMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let deferred = 0;
  let deferredOnNil = 0;

  for (const observation of observations) {
    if (observation.decision === 'defer') {
      deferred++;
      if (observation.goldNil) deferredOnNil++;
      continue;
    }

    const predictedMint = observation.decision === 'mint';
    if (predictedMint && observation.goldNil) truePositives++;
    else if (predictedMint && !observation.goldNil) falsePositives++;
    else if (!predictedMint && observation.goldNil) falseNegatives++;
    else trueNegatives++;
  }

  const precisionDenominator = truePositives + falsePositives;
  const precision = precisionDenominator === 0 ? null : truePositives / precisionDenominator;

  // Deferrals on gold-NIL mentions join the recall denominator: they are missed mints.
  const recallDenominator = truePositives + falseNegatives + deferredOnNil;
  const recall = recallDenominator === 0 ? null : truePositives / recallDenominator;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    deferred,
    deferredOnNil,
    observations: observations.length,
    deferralRate: observations.length === 0 ? 0 : deferred / observations.length,
    precision,
    recall,
    f1: precision === null || recall === null ? null : f1Of(precision, recall),
  };
}

/**
 * The appendix variant from the protocol: recall computed **without** the deferral penalty, so a
 * reader can see the convention's effect rather than take it on trust. Reported once, alongside
 * the primary figure — never instead of it.
 */
export function nilMetricsIgnoringDeferrals(observations: NilObservation[]): NilMetrics {
  return nilMetrics(observations.filter((observation) => observation.decision !== 'defer'));
}

export function nilMetricsByStratum(
  observations: NilObservation[]
): Record<Stratum, NilMetrics> {
  const buckets = new Map<Stratum, NilObservation[]>();
  for (const observation of observations) {
    const stratum = observation.stratum ?? 'unstratified';
    const bucket = buckets.get(stratum);
    if (bucket) bucket.push(observation);
    else buckets.set(stratum, [observation]);
  }

  const out: Record<Stratum, NilMetrics> = {};
  for (const [stratum, bucket] of buckets) out[stratum] = nilMetrics(bucket);
  out.all = nilMetrics(observations);
  return out;
}

/**
 * The mint-vs-merge error asymmetry the RQ2 prediction names: wrong mints (duplicates, repairable
 * later) versus wrong merges of novel entities (not repairable without a split operator).
 *
 * Reported as a ratio because the prediction is directional — the hypothesis is that wrong mints
 * outnumber wrong merges, validating the mint-if-uncertain asymmetry.
 */
export function mintVsMergeAsymmetry(metrics: NilMetrics): {
  wrongMints: number;
  wrongMerges: number;
  ratio: number | null;
} {
  return {
    wrongMints: metrics.falsePositives,
    wrongMerges: metrics.falseNegatives,
    ratio: metrics.falseNegatives === 0 ? null : metrics.falsePositives / metrics.falseNegatives,
  };
}
