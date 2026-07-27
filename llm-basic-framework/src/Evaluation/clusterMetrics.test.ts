import { Partition } from './partition';
import {
  adjustedRandIndex,
  allPairsFromGold,
  bCubedPRF,
  clusterMetrics,
  macroPRF,
  mergeMetricsByStratum,
  mergeMetricsForPairs,
  microPRF,
  pairwisePRF,
  type LabeledPair,
} from './clusterMetrics';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Asserts the value is defined as well as close: a null here means the metric was undefined. */
const near = (actual: number | null | undefined, expected: number, message?: string) => {
  assert.notEqual(actual, null, `${message ?? ''} expected ${expected}, got an UNDEFINED metric`);
  assert.ok(
    Math.abs(actual! - expected) < 1e-9,
    `${message ?? ''} expected ${expected}, got ${actual}`
  );
};

/**
 * The reference toy, used for every metric below. All expected values are computed BY HAND in the
 * comments — never read back from this implementation, which would make the tests circular.
 *
 *   gold      = {a,b,c} {d,e} {f}          (3 clusters, 6 elements)
 *   predicted = {a,b} {c,d} {e} {f}        (4 clusters)
 *
 * It is deliberately messy: one split (a,b|c), one wrong merge (c,d), one correct singleton (f).
 */
const gold = () => Partition.fromGroups([['a', 'b', 'c'], ['d', 'e'], ['f']]);
const predicted = () => Partition.fromGroups([['a', 'b'], ['c', 'd'], ['e'], ['f']]);

// --- macro ------------------------------------------------------------------------------------

test('macro: pure predicted clusters / whole gold clusters', () => {
  // pure: {a,b}⊆G1 ✓, {c,d} spans G1,G2 ✗, {e}⊆G2 ✓, {f}⊆G3 ✓  → 3/4 = 0.75
  // whole: {a,b,c} spans P1,P2 ✗, {d,e} spans P2,P3 ✗, {f}⊆P4 ✓ → 1/3
  const result = macroPRF(predicted(), gold());
  near(result.precision, 0.75, 'macro precision');
  near(result.recall, 1 / 3, 'macro recall');
  near(result.f1, (2 * 0.75 * (1 / 3)) / (0.75 + 1 / 3), 'macro f1'); // = 0.4615384615…
  near(result.f1, 0.46153846153846156);
});

// --- micro ------------------------------------------------------------------------------------

test('micro: dominant-overlap purity and inverse purity', () => {
  // precision: {a,b}→2, {c,d}→1, {e}→1, {f}→1 = 5 of 6
  // recall:    {a,b,c}→2, {d,e}→1, {f}→1      = 4 of 6
  const result = microPRF(predicted(), gold());
  near(result.precision, 5 / 6, 'micro precision');
  near(result.recall, 4 / 6, 'micro recall');
  near(result.f1, 0.7407407407407407, 'micro f1');
});

// --- pairwise ---------------------------------------------------------------------------------

test('pairwise: same-cluster pair agreement', () => {
  // gold pairs: ab, ac, bc, de = 4.  predicted pairs: ab, cd = 2.  intersection: ab = 1.
  const result = pairwisePRF(predicted(), gold());
  near(result.precision, 1 / 2, 'pairwise precision');
  near(result.recall, 1 / 4, 'pairwise recall');
  near(result.f1, 1 / 3, 'pairwise f1');
});

// --- B³ ---------------------------------------------------------------------------------------

test('B-cubed: per-element precision and recall, element-weighted', () => {
  // a: |{a,b}∩{a,b,c}|=2 → P 2/2=1,   R 2/3
  // b: same                            P 1,     R 2/3
  // c: |{c,d}∩{a,b,c}|=1 → P 1/2,      R 1/3
  // d: |{c,d}∩{d,e}|=1   → P 1/2,      R 1/2
  // e: |{e}∩{d,e}|=1     → P 1,        R 1/2
  // f: |{f}∩{f}|=1       → P 1,        R 1
  // P = (1+1+0.5+0.5+1+1)/6 = 5/6 ; R = (2/3+2/3+1/3+1/2+1/2+1)/6 = (11/3)/6 = 11/18
  const result = bCubedPRF(predicted(), gold());
  near(result.precision, 5 / 6, 'B3 precision');
  near(result.recall, 11 / 18, 'B3 recall');
  near(result.recall, 0.6111111111111112);
  near(result.f1, 0.7051282051282052, 'B3 f1');
});

// --- ARI --------------------------------------------------------------------------------------

test('ARI: chance-corrected pair agreement', () => {
  // contingency cells: 2 (P1×G1), 1 (P2×G1), 1 (P2×G2), 1 (P3×G2), 1 (P4×G3)
  // Σ C(cell,2) = 1 ; rows 2,2,1,1 → Σ = 2 ; cols 3,2,1 → Σ = 4 ; n=6, C(6,2)=15
  // expected = 2·4/15 = 8/15 ; max = (2+4)/2 = 3
  // ARI = (1 − 8/15)/(3 − 8/15) = (7/15)/(37/15) = 7/37
  near(adjustedRandIndex(predicted(), gold()), 7 / 37, 'ARI');
  near(adjustedRandIndex(predicted(), gold()), 0.1891891891891892);
});

test('ARI is symmetric', () => {
  near(adjustedRandIndex(predicted(), gold()), adjustedRandIndex(gold(), predicted()));
});

// --- degenerate cases (verification item 2) ---------------------------------------------------

test('degenerate: perfect match scores 1 everywhere', () => {
  const suite = clusterMetrics(gold(), gold());
  for (const key of ['macro', 'micro', 'pairwise', 'bCubed'] as const) {
    near(suite[key].precision, 1, `${key} precision`);
    near(suite[key].recall, 1, `${key} recall`);
    near(suite[key].f1, 1, `${key} f1`);
  }
  near(suite.ari, 1, 'ARI');
});

test('degenerate: all-singletons prediction', () => {
  const singletons = Partition.fromGroups([['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  const suite = clusterMetrics(singletons, gold());

  near(suite.macro.precision, 1, 'every singleton is trivially pure');
  near(suite.macro.recall, 1 / 3, 'only {f} survives whole');
  near(suite.micro.precision, 1);
  near(suite.micro.recall, 3 / 6, 'each gold cluster contributes max overlap 1');
  // No predicted pairs at all: precision is 0/0, reported as 0 rather than NaN or 1.
  near(suite.pairwise.precision, 0, 'no pairs proposed');
  near(suite.pairwise.recall, 0);
  near(suite.pairwise.f1, 0);
  near(suite.bCubed.precision, 1);
  near(suite.bCubed.recall, 0.5, '(1/3+1/3+1/3+1/2+1/2+1)/6');
  near(suite.ari, 0, 'all-singletons vs clustered gold is exactly chance');
});

test('degenerate: one-big-cluster prediction', () => {
  const oneBig = Partition.fromGroups([['a', 'b', 'c', 'd', 'e', 'f']]);
  const suite = clusterMetrics(oneBig, gold());

  near(suite.macro.precision, 0, 'the single cluster is impure');
  near(suite.macro.recall, 1, 'every gold cluster is contained in it');
  near(suite.micro.precision, 3 / 6, 'dominant gold cluster has 3 of the 6');
  near(suite.micro.recall, 1);
  near(suite.pairwise.precision, 4 / 15, 'C(6,2)=15 proposed, 4 correct');
  near(suite.pairwise.recall, 1);
  // P = (3/6+3/6+3/6 + 2/6+2/6 + 1/6)/6 = (1.5+0.666…+0.166…)/6 = 7/18
  near(suite.bCubed.precision, 7 / 18);
  near(suite.bCubed.recall, 1);
  near(suite.ari, 0, 'one-big-cluster is also exactly chance');
});

test('degenerate: both all-singletons is perfect agreement, not 0/0', () => {
  const a = Partition.fromGroups([['x'], ['y'], ['z']]);
  const b = Partition.fromGroups([['x'], ['y'], ['z']]);
  // Σ C(cell,2), Σ rows and Σ cols are all 0, so max === expected === 0. Must be 1, not NaN.
  near(adjustedRandIndex(a, b), 1);
  assert.equal(Number.isNaN(adjustedRandIndex(a, b)), false);
});

test('degenerate: both one-big-cluster is perfect agreement', () => {
  const a = Partition.fromGroups([['x', 'y', 'z']]);
  const b = Partition.fromGroups([['x', 'y', 'z']]);
  near(adjustedRandIndex(a, b), 1);
});

test('degenerate: empty universe does not throw or return NaN', () => {
  const empty = Partition.fromGroups([]);
  const suite = clusterMetrics(empty, gold());
  assert.equal(suite.universeSize, 0);
  for (const value of [suite.macro.f1, suite.micro.f1, suite.pairwise.f1, suite.bCubed.f1]) {
    assert.equal(Number.isNaN(value), false);
  }
  assert.equal(Number.isNaN(suite.ari), false);
});

test('degenerate: a single shared element cannot disagree', () => {
  near(adjustedRandIndex(Partition.fromGroups([['x']]), Partition.fromGroups([['x']])), 1);
});

// --- universe handling ------------------------------------------------------------------------

test('metrics are computed over the shared universe, not the union', () => {
  // The prediction knows an extra element gold never annotated; it must not be scored.
  const withExtra = Partition.fromGroups([['a', 'b', 'zzz'], ['c'], ['d', 'e'], ['f']]);
  const suite = clusterMetrics(withExtra, gold());
  assert.equal(suite.universeSize, 6, 'zzz excluded');
  // Restricted prediction is {a,b} {c} {d,e} {f}: gold pairs ab,ac,bc,de; predicted ab,de.
  near(suite.pairwise.precision, 1, 'both proposed pairs are correct');
  near(suite.pairwise.recall, 2 / 4);
});

// --- per-stratum merge P/R --------------------------------------------------------------------

test('merge metrics count TP/FP/FN/TN over an explicit labelled pair set', () => {
  const pairs: LabeledPair[] = [
    { a: 'a', b: 'b', stratum: 's1' }, // gold same, predicted same  → TP
    { a: 'a', b: 'c', stratum: 's1' }, // gold same, predicted apart → FN
    { a: 'c', b: 'd', stratum: 's2' }, // gold apart, predicted same → FP
    { a: 'a', b: 'f', stratum: 's2' }, // gold apart, predicted apart→ TN
  ];

  const byStratum = mergeMetricsByStratum(predicted(), gold(), pairs);

  // s1: TP=1 FN=1 → P = 1/1 = 1, R = 1/2 = 0.5, F1 = 2·1·0.5/1.5 = 2/3
  assert.equal(byStratum.s1.truePositives, 1);
  assert.equal(byStratum.s1.falseNegatives, 1);
  near(byStratum.s1.precision, 1);
  near(byStratum.s1.recall, 0.5);
  near(byStratum.s1.f1, 2 / 3);

  // s2: FP=1 TN=1, no TP. Precision IS defined (a merge was claimed, and it was wrong) → 0/1 = 0.
  // Recall is UNDEFINED: this stratum contains no gold-positive pair to find.
  assert.equal(byStratum.s2.falsePositives, 1);
  assert.equal(byStratum.s2.trueNegatives, 1);
  near(byStratum.s2.precision, 0, 'one merge claimed, and it was wrong');
  assert.equal(byStratum.s2.recall, null, 'no gold positives → recall undefined, not 0');
  assert.equal(byStratum.s2.f1, null);

  // pooled: TP=1 FP=1 FN=1 TN=1 → P = R = F1 = 0.5
  near(byStratum.all.precision, 0.5);
  near(byStratum.all.recall, 0.5);
  near(byStratum.all.f1, 0.5);
});

test('per-stratum figures do not equal the pooled figure — why averaging is banned', () => {
  const pairs: LabeledPair[] = [
    // an easy stratum the system gets right
    { a: 'a', b: 'b', stratum: 'easy' },
    // a hard stratum it gets wrong
    { a: 'a', b: 'c', stratum: 'hard' },
    { a: 'c', b: 'd', stratum: 'hard' },
  ];
  const byStratum = mergeMetricsByStratum(predicted(), gold(), pairs);

  near(byStratum.easy.recall, 1, 'near-ceiling on the easy stratum');
  near(byStratum.hard.recall, 0, 'total failure on the hard stratum');
  // Pooling hides the collapse the two-claims framing exists to expose.
  near(byStratum.all.recall, 0.5);
});

test('a pair with an endpoint the system never saw is skipped, not scored', () => {
  const pairs: LabeledPair[] = [{ a: 'a', b: 'unseen', stratum: 's' }];
  const result = mergeMetricsForPairs(predicted(), gold(), pairs);
  assert.equal(result.skipped, 1);
  assert.equal(result.truePositives + result.falsePositives + result.falseNegatives, 0);
});

test('allPairsFromGold enumerates every within-universe pair once', () => {
  const pairs = allPairsFromGold(gold());
  assert.equal(pairs.length, (6 * 5) / 2);
  const result = mergeMetricsForPairs(predicted(), gold(), pairs);
  // Over all 15 pairs: gold positives ab,ac,bc,de = 4; predicted positives ab,cd = 2.
  // TP=1 (ab), FP=1 (cd), FN=3 (ac,bc,de), TN=10.
  assert.equal(result.truePositives, 1);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falseNegatives, 3);
  assert.equal(result.trueNegatives, 10);
  // Consistency with the pairwise metric computed independently.
  const pw = pairwisePRF(predicted(), gold());
  near(result.precision, pw.precision);
  near(result.recall, pw.recall);
});

test('suite reports cluster counts alongside the metrics', () => {
  const suite = clusterMetrics(predicted(), gold());
  assert.equal(suite.predictedClusters, 4);
  assert.equal(suite.goldClusters, 3);
  assert.equal(suite.universeSize, 6);
});
