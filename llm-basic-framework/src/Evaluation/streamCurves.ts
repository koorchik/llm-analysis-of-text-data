import type { DecisionEvent, LlmCallEvent } from '../DecisionLog/DecisionLog';
import { elementKey, type KeyOptions } from './partition';

/**
 * Per-stream curves. The note marks all three CRITICAL and the original migration plan omitted
 * them, so they are first-class here rather than something derived ad hoc at writing time.
 *
 * 1. **Registry cluster growth** — the over-merge sanity check. Sub-linear growth is the
 *    microclustering signature (`binette2022entityresolution`); linear growth means nothing is
 *    being merged, and a growth curve that flattens too hard means everything is.
 * 2. **New-canonical arrivals** — the predicted Heaps-law decay, and RQ5's headline figure.
 * 3. **Fast-path hit rate** — should rise over the stream as the registry warms up. A flat rate
 *    means the exact-alias fast path is not paying for itself.
 *
 * All three are computed from the decision log, so they need no extra instrumentation and can be
 * recomputed for any past run.
 */

export interface StreamPoint {
  /** 1-based position in the stream, in the run's document order. */
  position: number;
  docId: number;
  /** Decisions observed in this document. */
  decisions: number;
  mints: number;
  links: number;
  defers: number;
  /** Distinct clusters in the registry after this document. */
  clustersCumulative: number;
  /** Mentions seen so far (cumulative decisions). */
  mentionsCumulative: number;
  /** New canonicals minted in this document. */
  newCanonicals: number;
  /** links / (links + mints) within this document — undefined when the document had neither. */
  linkShare: number | null;
}

export interface StreamCurves {
  points: StreamPoint[];
  /** Documents in the order they were replayed. */
  documents: number;
  totalDecisions: number;
  totalMints: number;
  totalLinks: number;
  totalDefers: number;
}

/**
 * Build the curves from a decision log.
 *
 * Document order is taken from **first appearance in the log**, not from sorting `docId`, because
 * the stream order is a run property (chronological or seeded-shuffle in M7) and sorting numerically
 * would silently re-impose id order — which is not chronological, differing from date order at 32
 * adjacent positions over the 204 files.
 */
export function streamCurves(events: DecisionEvent[], options: KeyOptions = {}): StreamCurves {
  const order: number[] = [];
  const byDoc = new Map<number, DecisionEvent[]>();

  for (const event of events) {
    let bucket = byDoc.get(event.docId);
    if (!bucket) {
      bucket = [];
      byDoc.set(event.docId, bucket);
      order.push(event.docId);
    }
    bucket.push(event);
  }

  const canonicals = new Set<string>();
  const points: StreamPoint[] = [];

  let mentionsCumulative = 0;
  let totalMints = 0;
  let totalLinks = 0;
  let totalDefers = 0;

  order.forEach((docId, index) => {
    const docEvents = byDoc.get(docId)!;
    let mints = 0;
    let links = 0;
    let defers = 0;
    let newCanonicals = 0;

    for (const event of docEvents) {
      if (event.decision === 'defer') {
        defers++;
        continue;
      }
      if (event.decision === 'mint') {
        mints++;
        // A mint's target is the newly-minted canonical; count it as new only if unseen, so a
        // crash-retry that re-mints the same name does not inflate the arrivals curve.
        const key = elementKey(event.category, event.target ?? event.mention, options);
        if (!canonicals.has(key)) {
          canonicals.add(key);
          newCanonicals++;
        }
      } else {
        links++;
        if (event.target) canonicals.add(elementKey(event.category, event.target, options));
      }
    }

    mentionsCumulative += mints + links + defers;
    totalMints += mints;
    totalLinks += links;
    totalDefers += defers;

    const decided = links + mints;
    points.push({
      position: index + 1,
      docId,
      decisions: docEvents.length,
      mints,
      links,
      defers,
      clustersCumulative: canonicals.size,
      mentionsCumulative,
      newCanonicals,
      linkShare: decided === 0 ? null : links / decided,
    });
  });

  return {
    points,
    documents: order.length,
    totalDecisions: events.length,
    totalMints,
    totalLinks,
    totalDefers,
  };
}

/**
 * Heaps-law fit on the new-canonical arrivals curve: V(n) ≈ K · n^β for n mentions seen.
 *
 * β < 1 is the sub-linear signature RQ5 predicts — vocabulary growth decelerating as the registry
 * saturates. Fitted by ordinary least squares on log V against log n, which is the standard
 * estimator for Heaps' law; `rSquared` is reported so a poor fit is visible rather than implied.
 */
export function fitHeaps(points: StreamPoint[]): {
  K: number;
  beta: number;
  rSquared: number;
  usedPoints: number;
} {
  // log(0) is undefined, so only positions with at least one mention and one canonical qualify.
  const usable = points.filter((point) => point.mentionsCumulative > 0 && point.clustersCumulative > 0);
  const n = usable.length;
  if (n < 2) return { K: NaN, beta: NaN, rSquared: NaN, usedPoints: n };

  const xs = usable.map((point) => Math.log(point.mentionsCumulative));
  const ys = usable.map((point) => Math.log(point.clustersCumulative));

  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceX = 0;
  for (let i = 0; i < n; i++) {
    covariance += (xs[i] - meanX) * (ys[i] - meanY);
    varianceX += (xs[i] - meanX) ** 2;
  }

  if (varianceX === 0) return { K: NaN, beta: NaN, rSquared: NaN, usedPoints: n };

  const beta = covariance / varianceX;
  const intercept = meanY - beta * meanX;

  let residualSumSquares = 0;
  let totalSumSquares = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + beta * xs[i];
    residualSumSquares += (ys[i] - predicted) ** 2;
    totalSumSquares += (ys[i] - meanY) ** 2;
  }

  return {
    K: Math.exp(intercept),
    beta,
    rSquared: totalSumSquares === 0 ? 1 : 1 - residualSumSquares / totalSumSquares,
    usedPoints: n,
  };
}

/**
 * Is cluster growth sub-linear? The over-merge sanity check, stated as a testable claim rather
 * than eyeballed off a chart.
 *
 * Reports the Heaps β together with the growth rate over the first and last thirds of the stream:
 * a decelerating registry has a lower arrival rate late than early.
 */
export function growthDiagnostics(points: StreamPoint[]): {
  beta: number;
  subLinear: boolean;
  earlyArrivalRate: number;
  lateArrivalRate: number;
  decelerating: boolean;
} {
  const { beta } = fitHeaps(points);
  const third = Math.max(1, Math.floor(points.length / 3));
  const early = points.slice(0, third);
  const late = points.slice(-third);

  const rate = (slice: StreamPoint[]): number => {
    const mentions = slice.reduce((sum, point) => sum + point.mints + point.links, 0);
    const arrivals = slice.reduce((sum, point) => sum + point.newCanonicals, 0);
    return mentions === 0 ? 0 : arrivals / mentions;
  };

  const earlyArrivalRate = rate(early);
  const lateArrivalRate = rate(late);

  return {
    beta,
    subLinear: Number.isFinite(beta) && beta < 1,
    earlyArrivalRate,
    lateArrivalRate,
    decelerating: lateArrivalRate < earlyArrivalRate,
  };
}

// --- fast-path hit rate -------------------------------------------------------------------------

export interface FastPathPoint {
  position: number;
  docId: number;
  /** Mentions resolved by exact alias lookup, i.e. never reaching a judge. */
  fastPathHits: number;
  /** Mentions that needed candidate generation and a decision. */
  decisionsMade: number;
  hitRate: number | null;
  cumulativeHitRate: number;
}

/**
 * Fast-path hit rate over the stream.
 *
 * A mention resolved by exact alias lookup produces **no** decision event — that is the whole point
 * of the fast path — so the hit count must come from the per-document mention total, which the
 * caller supplies. Deriving it from the decision log alone would report a hit rate of zero
 * regardless of the truth.
 */
export function fastPathCurve(
  perDocument: Array<{ docId: number; mentionsTotal: number; decisionsMade: number }>
): FastPathPoint[] {
  let cumulativeHits = 0;
  let cumulativeMentions = 0;

  return perDocument.map((document, index) => {
    const hits = Math.max(0, document.mentionsTotal - document.decisionsMade);
    cumulativeHits += hits;
    cumulativeMentions += document.mentionsTotal;

    return {
      position: index + 1,
      docId: document.docId,
      fastPathHits: hits,
      decisionsMade: document.decisionsMade,
      hitRate: document.mentionsTotal === 0 ? null : hits / document.mentionsTotal,
      cumulativeHitRate: cumulativeMentions === 0 ? 0 : cumulativeHits / cumulativeMentions,
    };
  });
}

// --- cost curve ---------------------------------------------------------------------------------

export interface CostCurvePoint {
  position: number;
  docId: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cumulativeCalls: number;
  cumulativeTokens: number;
}

/**
 * Per-document LLM cost over the stream, from the log's `llm-call` rows.
 *
 * Paired with the arrivals curve this is RQ5's argument: if new-canonical arrivals decay while
 * per-document cost stays flat, the streaming operator's cost is bounded by candidates-per-mention
 * rather than by corpus size — the claim M1's formal framing makes.
 */
export function costCurve(calls: Array<LlmCallEvent & { doc: number }>): CostCurvePoint[] {
  const order: number[] = [];
  const byDoc = new Map<number, Array<LlmCallEvent>>();

  for (const call of calls) {
    let bucket = byDoc.get(call.doc);
    if (!bucket) {
      bucket = [];
      byDoc.set(call.doc, bucket);
      order.push(call.doc);
    }
    bucket.push(call);
  }

  let cumulativeCalls = 0;
  let cumulativeTokens = 0;

  return order.map((docId, index) => {
    const docCalls = byDoc.get(docId)!;
    const inputTokens = docCalls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0);
    const outputTokens = docCalls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);

    cumulativeCalls += docCalls.length;
    cumulativeTokens += inputTokens + outputTokens;

    return {
      position: index + 1,
      docId,
      calls: docCalls.length,
      inputTokens,
      outputTokens,
      cumulativeCalls,
      cumulativeTokens,
    };
  });
}
