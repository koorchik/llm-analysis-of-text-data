import type { DecisionEvent } from '../DecisionLog/DecisionLog';
import {
  costCurve,
  fastPathCurve,
  fitHeaps,
  growthDiagnostics,
  streamCurves,
} from './streamCurves';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, tolerance = 1e-9, message?: string) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message ?? ''} expected ${expected}, got ${actual}`);

const decision = (
  docId: number,
  mention: string,
  kind: 'mint' | 'link' | 'defer',
  target: string | null = mention
): DecisionEvent => ({
  mention,
  category: 'HackerGroup',
  docId,
  candidates: [],
  decision: kind,
  target: kind === 'defer' ? null : target,
});

test('cluster growth is cumulative and counts each canonical once', () => {
  const curves = streamCurves([
    decision(1, 'A', 'mint'),
    decision(1, 'B', 'mint'),
    decision(2, 'C', 'mint'),
    decision(2, 'A2', 'link', 'A'), // links to an existing canonical: no new cluster
  ]);

  assert.equal(curves.documents, 2);
  assert.equal(curves.points[0].clustersCumulative, 2);
  assert.equal(curves.points[1].clustersCumulative, 3, 'only C is new in doc 2');
  assert.equal(curves.points[1].newCanonicals, 1);
  assert.equal(curves.totalMints, 3);
  assert.equal(curves.totalLinks, 1);
});

test('document order follows first appearance in the log, not sorted docId', () => {
  // Stream order is a run property: id order is NOT chronological (32 adjacent date inversions
  // over the 204 files), so sorting numerically would silently re-impose the wrong order.
  const curves = streamCurves([
    decision(500, 'A', 'mint'),
    decision(100, 'B', 'mint'),
    decision(300, 'C', 'mint'),
  ]);
  assert.deepEqual(curves.points.map((point) => point.docId), [500, 100, 300]);
  assert.deepEqual(curves.points.map((point) => point.position), [1, 2, 3]);
});

test('a re-minted canonical does not inflate the arrivals curve', () => {
  // A crash-retry can re-mint the same name; arrivals must count distinct canonicals.
  const curves = streamCurves([
    decision(1, 'A', 'mint'),
    decision(2, 'A', 'mint'),
  ]);
  assert.equal(curves.points[1].newCanonicals, 0);
  assert.equal(curves.points[1].clustersCumulative, 1);
  assert.equal(curves.totalMints, 2, 'the mint decision is still counted as a decision');
});

test('defers are counted separately and create no cluster', () => {
  const curves = streamCurves([decision(1, 'A', 'mint'), decision(1, 'B', 'defer')]);
  assert.equal(curves.points[0].defers, 1);
  assert.equal(curves.points[0].clustersCumulative, 1);
  assert.equal(curves.totalDefers, 1);
});

test('linkShare is null for a document with no decided mentions', () => {
  const curves = streamCurves([decision(1, 'A', 'defer')]);
  assert.equal(curves.points[0].linkShare, null, 'not 0, which would imply an all-mint document');
});

test('linkShare rises as the registry warms up', () => {
  const curves = streamCurves([
    decision(1, 'A', 'mint'),
    decision(1, 'B', 'mint'),
    decision(2, 'A2', 'link', 'A'),
    decision(2, 'B2', 'link', 'B'),
  ]);
  near(curves.points[0].linkShare!, 0, 1e-12, 'cold registry: all mints');
  near(curves.points[1].linkShare!, 1, 1e-12, 'warm registry: all links');
});

// --- Heaps' law ---------------------------------------------------------------------------------

test('fitHeaps recovers a known exponent', () => {
  // Construct V = n^0.5 exactly: at n mentions, n^0.5 canonicals.
  const points = Array.from({ length: 50 }, (_, index) => {
    const n = (index + 1) * 100;
    return {
      position: index + 1,
      docId: index + 1,
      decisions: 0,
      mints: 0,
      links: 0,
      defers: 0,
      clustersCumulative: Math.sqrt(n),
      mentionsCumulative: n,
      newCanonicals: 0,
      linkShare: null,
    };
  });

  const fit = fitHeaps(points);
  near(fit.beta, 0.5, 1e-9, 'log-log slope recovers the exponent');
  near(fit.rSquared, 1, 1e-9, 'a perfect power law fits perfectly');
});

test('fitHeaps reports a linear (beta = 1) growth curve as such', () => {
  // Every mention mints: V = n, so beta = 1 — nothing is being merged.
  const points = Array.from({ length: 30 }, (_, index) => ({
    position: index + 1,
    docId: index + 1,
    decisions: 1,
    mints: 1,
    links: 0,
    defers: 0,
    clustersCumulative: index + 1,
    mentionsCumulative: index + 1,
    newCanonicals: 1,
    linkShare: 0,
  }));

  const fit = fitHeaps(points);
  near(fit.beta, 1, 1e-9);
  assert.equal(growthDiagnostics(points).subLinear, false, 'linear growth is not sub-linear');
});

test('fitHeaps needs at least two usable points', () => {
  assert.ok(Number.isNaN(fitHeaps([]).beta));
  assert.equal(fitHeaps([]).usedPoints, 0);
});

test('growthDiagnostics detects deceleration', () => {
  // Early: every mention is a new canonical. Late: none are.
  const points = Array.from({ length: 30 }, (_, index) => {
    const early = index < 15;
    return {
      position: index + 1,
      docId: index + 1,
      decisions: 2,
      mints: early ? 2 : 0,
      links: early ? 0 : 2,
      defers: 0,
      clustersCumulative: early ? (index + 1) * 2 : 30,
      mentionsCumulative: (index + 1) * 2,
      newCanonicals: early ? 2 : 0,
      linkShare: early ? 0 : 1,
    };
  });

  const diagnostics = growthDiagnostics(points);
  near(diagnostics.earlyArrivalRate, 1, 1e-12);
  near(diagnostics.lateArrivalRate, 0, 1e-12);
  assert.equal(diagnostics.decelerating, true);
  assert.equal(diagnostics.subLinear, true, 'saturating registry is sub-linear');
});

// --- fast path ----------------------------------------------------------------------------------

test('fast-path hits come from mention totals, not from the decision log', () => {
  // A fast-path hit emits NO decision event — that is the point of the fast path — so deriving
  // the hit rate from the log alone would report zero regardless of the truth.
  const curve = fastPathCurve([
    { docId: 1, mentionsTotal: 10, decisionsMade: 10 }, // cold: nothing resolved by exact match
    { docId: 2, mentionsTotal: 10, decisionsMade: 2 }, // warm: 8 hits
  ]);
  near(curve[0].hitRate!, 0);
  near(curve[1].hitRate!, 0.8);
  assert.equal(curve[1].fastPathHits, 8);
  near(curve[1].cumulativeHitRate, 8 / 20, 1e-12);
});

test('fast-path hit rate is null for an empty document', () => {
  const curve = fastPathCurve([{ docId: 1, mentionsTotal: 0, decisionsMade: 0 }]);
  assert.equal(curve[0].hitRate, null);
  assert.equal(curve[0].cumulativeHitRate, 0);
});

test('fast-path hits never go negative if decisions exceed the mention total', () => {
  const curve = fastPathCurve([{ docId: 1, mentionsTotal: 2, decisionsMade: 5 }]);
  assert.equal(curve[0].fastPathHits, 0);
});

// --- cost curve ---------------------------------------------------------------------------------

test('cost curve accumulates calls and tokens per document', () => {
  const curve = costCurve([
    { doc: 1, kind: 'extract', seconds: 1, promptTokens: 100, completionTokens: 10 },
    { doc: 1, kind: 'link-judge', seconds: 1, promptTokens: 50, completionTokens: 5 },
    { doc: 2, kind: 'extract', seconds: 1, promptTokens: 200, completionTokens: 20 },
  ]);

  assert.equal(curve.length, 2);
  assert.equal(curve[0].calls, 2);
  assert.equal(curve[0].inputTokens, 150);
  assert.equal(curve[1].cumulativeCalls, 3);
  assert.equal(curve[1].cumulativeTokens, 150 + 15 + 220);
});

test('cost curve tolerates missing token counts', () => {
  const curve = costCurve([{ doc: 1, kind: 'extract', seconds: 1 }]);
  assert.equal(curve[0].inputTokens, 0);
  assert.equal(curve[0].calls, 1);
});
