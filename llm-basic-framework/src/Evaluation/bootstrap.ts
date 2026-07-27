/**
 * Resampling inference, implementing exactly what `docs/statistical-protocol.md` pre-registered:
 * BCa bootstrap CIs (10,000 resamples, 95%), a paired permutation test over documents (10,000
 * sign-flips, two-sided, add-one corrected), and Holm–Bonferroni adjustment over the headline
 * family.
 *
 * Nothing here chooses a method at analysis time — the choices are fixed in that document, which is
 * committed before any result exists. The defaults below are those choices.
 */

export const DEFAULT_RESAMPLES = 10_000;
export const DEFAULT_PERMUTATIONS = 10_000;
export const DEFAULT_CONFIDENCE = 0.95;

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Named explicitly because JavaScript has no seedable `Math.random`, so "seeded resampling" is
 * otherwise unreproducible. The same generator seeds `seededShuffle` in M7 for the same reason.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- normal distribution helpers ---------------------------------------------------------------

/**
 * Standard normal CDF via Hart's rational approximation (as given by West, "Better approximations
 * to cumulative normal functions"), accurate to roughly 1e-15.
 *
 * Double precision is not decoration here: BCa feeds its quantiles back through this CDF, so the
 * CDF's error sets a floor on the interval's accuracy. An Abramowitz & Stegun 7.1.26 erf (|ε| ≈
 * 1.5e-7) was tried first and was *worse than useless* — it made the Halley refinement in
 * `normalQuantile` degrade Acklam's raw ~1e-9 approximation instead of improving it, and put
 * `normalQuantile(0.5)` off zero by 1.3e-9.
 */
export function normalCdf(z: number): number {
  const absZ = Math.abs(z);
  let tail: number;

  if (absZ > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-absZ * absZ) / 2);
    if (absZ < 7.07106781186547) {
      let numerator = 3.52624965998911e-2 * absZ + 0.700383064443688;
      numerator = numerator * absZ + 6.37396220353165;
      numerator = numerator * absZ + 33.912866078383;
      numerator = numerator * absZ + 112.079291497871;
      numerator = numerator * absZ + 221.213596169931;
      numerator = numerator * absZ + 220.206867912376;

      let denominator = 8.83883476483184e-2 * absZ + 1.75566716318264;
      denominator = denominator * absZ + 16.064177579207;
      denominator = denominator * absZ + 86.7807322029461;
      denominator = denominator * absZ + 296.564248779674;
      denominator = denominator * absZ + 637.333633378831;
      denominator = denominator * absZ + 793.826512519948;
      denominator = denominator * absZ + 440.413735824752;

      tail = (e * numerator) / denominator;
    } else {
      // Continued fraction for the far tail.
      let b = absZ + 0.65;
      b = absZ + 4 / b;
      b = absZ + 3 / b;
      b = absZ + 2 / b;
      b = absZ + 1 / b;
      tail = e / (b * 2.506628274631);
    }
  }

  return z > 0 ? 1 - tail : tail;
}

/**
 * Inverse normal CDF (probit), Acklam's rational approximation plus one Halley refinement step.
 * Accurate to ~1e-15 after refinement, which matters because BCa feeds these quantiles back
 * through the CDF and small errors compound at the tails.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // Halley refinement against the CDF.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// --- BCa bootstrap ------------------------------------------------------------------------------

export interface BootstrapOptions {
  resamples?: number;
  confidence?: number;
  seed?: number;
}

export interface BootstrapCI {
  estimate: number;
  lower: number;
  upper: number;
  confidence: number;
  resamples: number;
  /**
   * Resamples where the statistic was undefined — e.g. a resample containing no gold positive, so
   * precision is 0/0. Excluded and **counted**: dropping them silently would narrow the interval,
   * and imputing 0 would bias it downward.
   */
  degenerate: number;
  method: 'bca' | 'percentile';
  seed: number;
}

/**
 * A statistic over a sample of units. Returns `null` when undefined for that resample — the caller
 * must not substitute a number, because both alternatives bias the interval.
 */
export type Statistic<T> = (units: readonly T[]) => number | null;

/**
 * BCa (bias-corrected and accelerated) bootstrap interval.
 *
 * BCa rather than percentile because merge precision is bounded in [0,1] and often sits near a
 * boundary on the easy strata, where the percentile interval is visibly biased. BCa corrects for
 * bias (z0, from the fraction of resamples below the point estimate) and for skew (a, from the
 * jackknife) at negligible extra cost at this scale.
 *
 * Falls back to the percentile interval only when the acceleration is undefined (a constant
 * jackknife), and says so in `method` rather than pretending it ran BCa.
 */
export function bootstrapCI<T>(
  units: readonly T[],
  statistic: Statistic<T>,
  options: BootstrapOptions = {}
): BootstrapCI {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);

  const pointEstimate = statistic(units);
  const n = units.length;

  if (pointEstimate === null || n === 0) {
    return {
      estimate: NaN,
      lower: NaN,
      upper: NaN,
      confidence,
      resamples: 0,
      degenerate: resamples,
      method: 'percentile',
      seed,
    };
  }

  const replicates: number[] = [];
  let degenerate = 0;
  const buffer: T[] = new Array(n);

  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) buffer[i] = units[Math.floor(random() * n)];
    const value = statistic(buffer);
    if (value === null || !Number.isFinite(value)) degenerate++;
    else replicates.push(value);
  }

  if (replicates.length === 0) {
    return {
      estimate: pointEstimate,
      lower: NaN,
      upper: NaN,
      confidence,
      resamples: 0,
      degenerate,
      method: 'percentile',
      seed,
    };
  }

  replicates.sort((a, b) => a - b);

  const alpha = (1 - confidence) / 2;

  // Bias correction: how many replicates fall below the point estimate.
  const below = replicates.filter((value) => value < pointEstimate).length;
  const proportion = below / replicates.length;
  const z0 =
    proportion <= 0
      ? normalQuantile(1 / (2 * replicates.length))
      : proportion >= 1
        ? normalQuantile(1 - 1 / (2 * replicates.length))
        : normalQuantile(proportion);

  // Acceleration from the jackknife.
  const jackknife: number[] = [];
  for (let i = 0; i < n; i++) {
    const reduced = units.slice(0, i).concat(units.slice(i + 1));
    const value = statistic(reduced);
    if (value !== null && Number.isFinite(value)) jackknife.push(value);
  }

  let method: 'bca' | 'percentile' = 'bca';
  let acceleration = 0;
  if (jackknife.length > 1) {
    const mean = jackknife.reduce((sum, value) => sum + value, 0) / jackknife.length;
    let sumSquares = 0;
    let sumCubes = 0;
    for (const value of jackknife) {
      const diff = mean - value;
      sumSquares += diff * diff;
      sumCubes += diff * diff * diff;
    }
    acceleration = sumSquares === 0 ? 0 : sumCubes / (6 * Math.pow(sumSquares, 1.5));
    if (sumSquares === 0) method = 'percentile';
  } else {
    method = 'percentile';
  }

  const adjust = (a: number): number => {
    if (method === 'percentile') return a;
    const z = normalQuantile(a);
    const numerator = z0 + z;
    const denominator = 1 - acceleration * numerator;
    if (denominator === 0) return a;
    return normalCdf(z0 + numerator / denominator);
  };

  const quantile = (p: number): number => {
    const clamped = Math.min(Math.max(p, 0), 1);
    const index = Math.min(
      replicates.length - 1,
      Math.max(0, Math.ceil(clamped * replicates.length) - 1)
    );
    return replicates[index];
  };

  return {
    estimate: pointEstimate,
    lower: quantile(adjust(alpha)),
    upper: quantile(adjust(1 - alpha)),
    confidence,
    resamples: replicates.length,
    degenerate,
    method,
    seed,
  };
}

// --- paired permutation test --------------------------------------------------------------------

export interface PermutationResult {
  /** mean(a) − mean(b) over the paired units. */
  observedDifference: number;
  pValue: number;
  permutations: number;
  /** Pairs whose difference is exactly 0 — they carry no sign information. */
  ties: number;
  seed: number;
}

/**
 * Paired permutation test by sign-flipping, two-sided.
 *
 * **Paired** because every condition runs on the same frozen input, so discarding the pairing
 * would throw away power for nothing. **Permutation** because per-document metric differences are
 * neither normal nor variance-homogeneous, so a t-test's assumptions are not met while
 * exchangeability under the null holds by construction.
 *
 * p = (1 + #{|mean_perm| ≥ |mean_observed|}) / (1 + permutations) — the standard add-one
 * correction, which keeps p from ever being reported as exactly 0.
 */
export function pairedPermutationTest(
  differences: readonly number[],
  options: { permutations?: number; seed?: number } = {}
): PermutationResult {
  const permutations = options.permutations ?? DEFAULT_PERMUTATIONS;
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);

  const n = differences.length;
  if (n === 0) {
    return { observedDifference: NaN, pValue: NaN, permutations: 0, ties: 0, seed };
  }

  const observedMean = differences.reduce((sum, value) => sum + value, 0) / n;
  const observedAbs = Math.abs(observedMean);
  const ties = differences.filter((value) => value === 0).length;

  let atLeastAsExtreme = 0;
  for (let p = 0; p < permutations; p++) {
    let sum = 0;
    for (const difference of differences) sum += random() < 0.5 ? -difference : difference;
    if (Math.abs(sum / n) >= observedAbs) atLeastAsExtreme++;
  }

  return {
    observedDifference: observedMean,
    pValue: (1 + atLeastAsExtreme) / (1 + permutations),
    permutations,
    ties,
    seed,
  };
}

/** Convenience wrapper: builds the paired differences from two aligned per-unit metric arrays. */
export function pairedDifferences(a: readonly number[], b: readonly number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`pairedDifferences: lengths differ (${a.length} vs ${b.length}) — not paired`);
  }
  return a.map((value, index) => value - b[index]);
}

// --- multiplicity -------------------------------------------------------------------------------

export interface AdjustedPValue<K> {
  key: K;
  pValue: number;
  adjusted: number;
  /** Whether it survives at the family-wise level. */
  significant: boolean;
}

/**
 * Holm–Bonferroni step-down adjustment over the pre-registered headline family.
 *
 * Holm rather than plain Bonferroni because it is uniformly more powerful at the same family-wise
 * error rate. Exploratory comparisons are not passed through here — they carry unadjusted p only
 * and make no significance claim (protocol §2).
 */
export function holmBonferroni<K>(
  tests: Array<{ key: K; pValue: number }>,
  familyWiseAlpha = 0.05
): Array<AdjustedPValue<K>> {
  const ordered = [...tests].sort((a, b) => a.pValue - b.pValue);
  const m = ordered.length;

  let runningMax = 0;
  const adjusted = ordered.map((test, index) => {
    const value = Math.min(1, (m - index) * test.pValue);
    runningMax = Math.max(runningMax, value); // enforce monotonicity down the step-down sequence
    return { key: test.key, pValue: test.pValue, adjusted: runningMax, significant: runningMax <= familyWiseAlpha };
  });

  // Return in the caller's original order so a results table stays stable.
  const byKey = new Map(adjusted.map((entry) => [entry.key, entry]));
  return tests.map((test) => byKey.get(test.key)!);
}

// --- seed aggregation ---------------------------------------------------------------------------

export interface SeedAggregate {
  mean: number;
  /** Sample standard deviation across seeds (n−1). Reported next to the mean in every table. */
  sd: number;
  seeds: number;
  values: number[];
}

/**
 * Mean over seeds plus between-seed SD.
 *
 * The primary reported figure is the mean; the SD sits beside it. **No best-seed selection and no
 * outlier dropping** — a wildly divergent seed is a finding about the condition's stability and is
 * reported as one (protocol §4).
 */
export function aggregateSeeds(values: readonly number[]): SeedAggregate {
  const n = values.length;
  if (n === 0) return { mean: NaN, sd: NaN, seeds: 0, values: [] };

  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance =
    n < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);

  return { mean, sd: Math.sqrt(variance), seeds: n, values: [...values] };
}

/**
 * CI that carries both document-level and seed-level variation: resample units within each seed,
 * then pool the resampled statistics across seeds.
 *
 * Reporting a CI from one seed and the seed SD separately would understate total uncertainty, which
 * is why the protocol fixes this pooling rule rather than leaving it to the analyst.
 */
export function pooledSeedCI<T>(
  perSeedUnits: ReadonlyArray<readonly T[]>,
  statistic: Statistic<T>,
  options: BootstrapOptions = {}
): BootstrapCI {
  const resamplesTotal = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  const seed = options.seed ?? 1;
  const random = mulberry32(seed);

  const perSeed = perSeedUnits.filter((units) => units.length > 0);
  if (perSeed.length === 0) {
    return {
      estimate: NaN, lower: NaN, upper: NaN, confidence,
      resamples: 0, degenerate: resamplesTotal, method: 'percentile', seed,
    };
  }

  const pointEstimates = perSeed
    .map((units) => statistic(units))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const estimate =
    pointEstimates.length === 0
      ? NaN
      : pointEstimates.reduce((sum, value) => sum + value, 0) / pointEstimates.length;

  const perSeedCount = Math.max(1, Math.floor(resamplesTotal / perSeed.length));
  const replicates: number[] = [];
  let degenerate = 0;

  for (const units of perSeed) {
    const n = units.length;
    const buffer: T[] = new Array(n);
    for (let r = 0; r < perSeedCount; r++) {
      for (let i = 0; i < n; i++) buffer[i] = units[Math.floor(random() * n)];
      const value = statistic(buffer);
      if (value === null || !Number.isFinite(value)) degenerate++;
      else replicates.push(value);
    }
  }

  if (replicates.length === 0) {
    return { estimate, lower: NaN, upper: NaN, confidence, resamples: 0, degenerate, method: 'percentile', seed };
  }

  replicates.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const at = (p: number) =>
    replicates[Math.min(replicates.length - 1, Math.max(0, Math.ceil(p * replicates.length) - 1))];

  return {
    estimate,
    lower: at(alpha),
    upper: at(1 - alpha),
    confidence,
    resamples: replicates.length,
    degenerate,
    method: 'percentile', // pooling across seeds; BCa's jackknife is not defined across strata here
    seed,
  };
}
