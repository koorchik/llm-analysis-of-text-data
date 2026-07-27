import {
  aggregateSeeds,
  bootstrapCI,
  holmBonferroni,
  mulberry32,
  normalCdf,
  normalQuantile,
  pairedDifferences,
  pairedPermutationTest,
  pooledSeedCI,
} from './bootstrap';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, tolerance = 1e-9, message?: string) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${message ?? ''} expected ${expected} ± ${tolerance}, got ${actual}`
  );

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

// --- RNG ---------------------------------------------------------------------------------------

test('mulberry32 is deterministic for a given seed and differs across seeds', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = Array.from({ length: 5 }, a);
  const seqB = Array.from({ length: 5 }, b);
  const seqC = Array.from({ length: 5 }, c);
  assert.deepEqual(seqA, seqB, 'same seed → same stream');
  assert.notDeepEqual(seqA, seqC);
});

test('mulberry32 stays in [0,1)', () => {
  const random = mulberry32(7);
  for (let i = 0; i < 10_000; i++) {
    const value = random();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test('mulberry32 is roughly uniform', () => {
  const random = mulberry32(99);
  const buckets = new Array(10).fill(0);
  const draws = 100_000;
  for (let i = 0; i < draws; i++) buckets[Math.floor(random() * 10)]++;
  for (const count of buckets) {
    near(count / draws, 0.1, 0.01, 'bucket share');
  }
});

// --- normal helpers ----------------------------------------------------------------------------

// Reference values to full double precision. BCa feeds quantiles back through the CDF, so the
// CDF's own error sets a floor on interval accuracy — 1e-7-class approximations are not enough.
const Z_975 = 1.9599639845400545;
const Z_95 = 1.6448536269514722;
const Z_99 = 2.3263478740408408;
const Z_90 = 1.2815515655446004;

test('normalCdf matches known values to near machine precision', () => {
  near(normalCdf(0), 0.5, 1e-15);
  near(normalCdf(Z_975), 0.975, 1e-14);
  near(normalCdf(-Z_975), 0.025, 1e-14);
  near(normalCdf(Z_90), 0.9, 1e-14);
});

test('normalCdf stays usable in the far tail, where a naive erf collapses', () => {
  // Accuracy is ~1e-15 near the centre but degrades to ~1e-8 RELATIVE in the far tail, so the
  // tail is checked relatively — an absolute tolerance is meaningless at p ≈ 6e-16. This is far
  // beyond anything BCa evaluates for a 95% interval (α/2 = 0.025 → |z| ≈ 1.96).
  const reference = 6.220960574271786e-16;
  const relativeError = Math.abs(normalCdf(-8) - reference) / reference;
  assert.ok(relativeError < 1e-7, `far-tail relative error ${relativeError.toExponential(2)}`);

  assert.ok(normalCdf(-40) >= 0, 'no negative probability past the cutoff');
  assert.equal(normalCdf(40), 1);
});

test('normalQuantile matches known critical values to near machine precision', () => {
  near(normalQuantile(0.5), 0, 1e-15, 'the median must be exactly 0');
  near(normalQuantile(0.975), Z_975, 1e-13, 'the 95% two-sided critical value');
  near(normalQuantile(0.025), -Z_975, 1e-13);
  near(normalQuantile(0.95), Z_95, 1e-13);
  near(normalQuantile(0.01), -Z_99, 1e-13);
});

test('normalQuantile inverts normalCdf across the range', () => {
  for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
    near(normalCdf(normalQuantile(p)), p, 1e-12, `round trip at p=${p}`);
  }
});

test('normalQuantile is antisymmetric about 0.5', () => {
  for (const p of [0.01, 0.1, 0.3]) {
    near(normalQuantile(p), -normalQuantile(1 - p), 1e-12, `antisymmetry at p=${p}`);
  }
});

test('normalQuantile handles the boundaries without NaN', () => {
  assert.equal(normalQuantile(0), -Infinity);
  assert.equal(normalQuantile(1), Infinity);
});

// --- bootstrap ---------------------------------------------------------------------------------

test('bootstrap CI brackets the point estimate and is reproducible', () => {
  const units = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const first = bootstrapCI(units, mean, { resamples: 2000, seed: 1 });
  const second = bootstrapCI(units, mean, { resamples: 2000, seed: 1 });

  near(first.estimate, 5.5);
  assert.ok(first.lower < first.estimate && first.estimate < first.upper, 'CI brackets estimate');
  assert.equal(first.lower, second.lower, 'same seed → same interval');
  assert.equal(first.upper, second.upper);
  assert.equal(first.method, 'bca');
});

test('the seed is recorded on the result, and varying it does move the interval', () => {
  const units = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const intervals = [1, 2, 3, 4, 5].map((seed) => {
    const ci = bootstrapCI(units, mean, { resamples: 2000, seed });
    assert.equal(ci.seed, seed, 'the seed must be reported so an interval is reproducible');
    return `${ci.lower},${ci.upper}`;
  });

  // Endpoints are order statistics of the replicate distribution, so two particular seeds can
  // legitimately coincide — asserting that any two *must* differ would be a flaky test. What must
  // hold is that the seed is not ignored.
  assert.ok(new Set(intervals).size > 1, 'seed has no effect on the interval at all');
});

test('the CI narrows as n grows', () => {
  const small = bootstrapCI([1, 2, 3, 4, 5], mean, { resamples: 3000, seed: 5 });
  const large = bootstrapCI(
    Array.from({ length: 200 }, (_, i) => (i % 5) + 1),
    mean,
    { resamples: 3000, seed: 5 }
  );
  assert.ok(large.upper - large.lower < small.upper - small.lower, 'more data → tighter interval');
});

test('a 95% CI covers the true mean at roughly the nominal rate', () => {
  // Coverage check over 200 synthetic samples from a known distribution.
  const trueMean = 0.5;
  let covered = 0;
  const trials = 200;
  for (let trial = 0; trial < trials; trial++) {
    const random = mulberry32(1000 + trial);
    const sample = Array.from({ length: 60 }, () => (random() < trueMean ? 1 : 0));
    const ci = bootstrapCI(sample, mean, { resamples: 600, seed: trial + 1 });
    if (ci.lower <= trueMean && trueMean <= ci.upper) covered++;
  }
  const rate = covered / trials;
  assert.ok(rate > 0.87 && rate <= 1, `coverage ${rate} outside a sane band for nominal 0.95`);
});

test('degenerate resamples are excluded AND counted, not imputed', () => {
  // A statistic that is undefined unless the resample contains at least one positive: the
  // "precision over a resample with no gold positive" case the protocol calls out.
  const units = [0, 0, 0, 0, 1];
  const precisionLike = (sample: readonly number[]): number | null => {
    const positives = sample.filter((value) => value === 1).length;
    return positives === 0 ? null : positives / sample.length;
  };

  const result = bootstrapCI(units, precisionLike, { resamples: 2000, seed: 3 });
  assert.ok(result.degenerate > 0, 'some resamples contained no positive');
  assert.equal(result.resamples + result.degenerate, 2000, 'every resample accounted for');
  assert.ok(result.lower > 0, 'excluded rather than imputed as 0, which would bias downward');
});

test('bootstrap on an undefined point estimate returns NaN rather than a fake interval', () => {
  const result = bootstrapCI([], mean, { resamples: 100, seed: 1 });
  assert.ok(Number.isNaN(result.estimate));
  assert.ok(Number.isNaN(result.lower));
});

test('a constant sample falls back to percentile and says so', () => {
  // Zero jackknife variance means the acceleration is undefined; the method field must not lie.
  const result = bootstrapCI([3, 3, 3, 3], mean, { resamples: 500, seed: 1 });
  assert.equal(result.method, 'percentile');
  near(result.lower, 3);
  near(result.upper, 3);
});

// --- paired permutation test -------------------------------------------------------------------

test('a large consistent difference is significant', () => {
  const differences = Array.from({ length: 40 }, () => 0.2);
  const result = pairedPermutationTest(differences, { permutations: 2000, seed: 1 });
  near(result.observedDifference, 0.2);
  // Every sign-flip assignment yields |mean| ≤ 0.2, and only the all-positive/all-negative
  // assignments tie it, so p is essentially the add-one floor.
  assert.ok(result.pValue < 0.01, `expected a small p, got ${result.pValue}`);
});

test('no difference is not significant', () => {
  const differences = [0.1, -0.1, 0.1, -0.1, 0.1, -0.1, 0.1, -0.1];
  const result = pairedPermutationTest(differences, { permutations: 2000, seed: 1 });
  near(result.observedDifference, 0);
  assert.ok(result.pValue > 0.5, `expected a large p, got ${result.pValue}`);
});

test('p is never exactly 0 — the add-one correction', () => {
  const differences = Array.from({ length: 100 }, () => 5);
  const result = pairedPermutationTest(differences, { permutations: 1000, seed: 1 });
  assert.ok(result.pValue > 0, 'add-one keeps p strictly positive');
  near(result.pValue, 1 / 1001, 1e-12, 'the floor is exactly 1/(1+permutations)');
});

test('p is bounded by 1 and reproducible for a given seed', () => {
  const differences = [0, 0, 0, 0];
  const result = pairedPermutationTest(differences, { permutations: 500, seed: 1 });
  assert.equal(result.pValue, 1, 'all-zero differences: every permutation ties');
  assert.equal(result.ties, 4);
  const repeat = pairedPermutationTest(differences, { permutations: 500, seed: 1 });
  assert.equal(result.pValue, repeat.pValue);
});

test('the test is two-sided — sign of the effect does not change p', () => {
  const positive = pairedPermutationTest(Array.from({ length: 30 }, () => 0.3), {
    permutations: 2000,
    seed: 4,
  });
  const negative = pairedPermutationTest(Array.from({ length: 30 }, () => -0.3), {
    permutations: 2000,
    seed: 4,
  });
  near(positive.pValue, negative.pValue);
  near(positive.observedDifference, -negative.observedDifference);
});

test('pairedDifferences refuses unaligned inputs', () => {
  assert.deepEqual(pairedDifferences([1, 2, 3], [0.5, 1, 2]), [0.5, 1, 1]);
  assert.throws(() => pairedDifferences([1, 2], [1]), /not paired/);
});

// --- Holm–Bonferroni ---------------------------------------------------------------------------

test('Holm adjusts by rank, is monotone, and preserves caller order', () => {
  const tests = [
    { key: 'c', pValue: 0.04 },
    { key: 'a', pValue: 0.001 },
    { key: 'b', pValue: 0.01 },
  ];
  const adjusted = holmBonferroni(tests, 0.05);

  assert.deepEqual(adjusted.map((entry) => entry.key), ['c', 'a', 'b'], 'original order kept');

  const byKey = new Map(adjusted.map((entry) => [entry.key, entry]));
  // sorted: a=0.001 (×3), b=0.01 (×2), c=0.04 (×1)
  near(byKey.get('a')!.adjusted, 0.003);
  near(byKey.get('b')!.adjusted, 0.02);
  near(byKey.get('c')!.adjusted, 0.04);
  assert.equal(byKey.get('a')!.significant, true);
  assert.equal(byKey.get('b')!.significant, true);
  assert.equal(byKey.get('c')!.significant, true);
});

test('Holm is more powerful than Bonferroni at the same family-wise rate', () => {
  const tests = [
    { key: 'x', pValue: 0.02 },
    { key: 'y', pValue: 0.03 },
  ];
  const adjusted = holmBonferroni(tests, 0.05);
  const bonferroni = tests.map((entry) => entry.pValue * tests.length);
  const byKey = new Map(adjusted.map((entry) => [entry.key, entry]));
  // Holm: 0.02×2 = 0.04, then 0.03×1 = 0.03 → raised to 0.04 by monotonicity. Both significant.
  near(byKey.get('y')!.adjusted, 0.04);
  assert.equal(byKey.get('y')!.significant, true);
  assert.ok(bonferroni[1] > 0.05, 'plain Bonferroni would reject this one');
});

test('Holm enforces monotonicity so a larger raw p never gets a smaller adjusted p', () => {
  const adjusted = holmBonferroni(
    [
      { key: 'p1', pValue: 0.049 },
      { key: 'p2', pValue: 0.05 },
      { key: 'p3', pValue: 0.9 },
    ],
    0.05
  );
  const values = adjusted.map((entry) => entry.adjusted);
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1]);
});

test('Holm caps adjusted p at 1', () => {
  const adjusted = holmBonferroni([
    { key: 'a', pValue: 0.6 },
    { key: 'b', pValue: 0.9 },
  ]);
  for (const entry of adjusted) assert.ok(entry.adjusted <= 1);
});

// --- seed aggregation --------------------------------------------------------------------------

test('aggregateSeeds reports mean and sample SD, no best-seed selection', () => {
  const result = aggregateSeeds([0.8, 0.9, 0.7]);
  near(result.mean, 0.8, 1e-12);
  // sample SD with n−1: deviations 0, 0.1, −0.1 → variance = 0.02/2 = 0.01 → SD = 0.1
  near(result.sd, 0.1, 1e-12);
  assert.equal(result.seeds, 3);
  assert.deepEqual(result.values, [0.8, 0.9, 0.7], 'every seed retained, including any outlier');
});

test('aggregateSeeds keeps a divergent seed rather than dropping it', () => {
  const result = aggregateSeeds([0.9, 0.9, 0.1]);
  assert.equal(result.seeds, 3);
  assert.ok(result.sd > 0.4, 'the instability shows up in the SD, which is the point');
});

test('aggregateSeeds handles a single seed without NaN SD', () => {
  const result = aggregateSeeds([0.5]);
  near(result.mean, 0.5);
  assert.equal(result.sd, 0);
});

test('pooled seed CI carries both within- and between-seed variation', () => {
  // Three seeds that disagree markedly: the pooled interval must be wider than any single seed's.
  const perSeed = [
    [0.9, 0.9, 0.9, 0.9],
    [0.5, 0.5, 0.5, 0.5],
    [0.1, 0.1, 0.1, 0.1],
  ];
  const pooled = pooledSeedCI(perSeed, mean, { resamples: 3000, seed: 1 });
  const single = bootstrapCI(perSeed[0], mean, { resamples: 3000, seed: 1 });

  near(pooled.estimate, 0.5, 1e-9, 'mean over seed point estimates');
  assert.ok(
    pooled.upper - pooled.lower > single.upper - single.lower,
    'pooling must not understate uncertainty'
  );
});

test('pooled seed CI on no seeds returns NaN rather than throwing', () => {
  const result = pooledSeedCI([], mean, { resamples: 100, seed: 1 });
  assert.ok(Number.isNaN(result.estimate));
});
