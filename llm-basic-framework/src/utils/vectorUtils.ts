/**
 * Dense-vector helpers for the M5 embedding arms.
 *
 * Scope note: the two *sparse* cosines already in the tree stay where they are —
 * `Normalization/metrics/stringMetrics.ts` (`charNgramCosine`) and `TfidfNgramGenerator`'s
 * `#vectorize`. Both operate on `Map<string, number>` term vectors and the string metrics are
 * deliberately corpus-free; folding them together would couple two things that vary independently.
 *
 * The discipline copied from `TfidfNgramGenerator`: **normalize once at store time, then a cosine
 * is a plain dot product.** Over ~2,674 canonicals × 1024 dimensions that is the difference between
 * one multiply-add loop and three.
 */

/** Throws rather than returning 0 — a length mismatch is an encoder swap, not a dissimilar pair. */
function assertSameLength(a: number[], b: number[]): void {
  if (a.length !== b.length) {
    throw new Error(
      `vectorUtils: dimension mismatch ${a.length} vs ${b.length} — vectors from different encoders`
    );
  }
}

export function dot(a: number[], b: number[]): number {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function norm(a: number[]): number {
  let sum = 0;
  for (const value of a) sum += value * value;
  return Math.sqrt(sum);
}

/** Returns a **new** array. A zero vector normalizes to itself rather than to NaN. */
export function l2Normalize(a: number[]): number[] {
  const length = norm(a);
  if (length === 0) return [...a];
  return a.map((value) => value / length);
}

/**
 * Cosine similarity **clamped to [0, 1]**.
 *
 * The clamp is a deliberate convention, not defensive coding. `Candidate.sim`, `compareCandidates`
 * and `minSim` all assume `[0, 1]`, while a cosine ranges over `[-1, 1]`. Two mappings were
 * available and they are not equivalent:
 *
 * - `Math.max(0, cos)` — a negative cosine means "no evidence of identity", which is exactly what 0
 *   already means everywhere else in this codebase.
 * - `(1 + cos) / 2` — rescaling, which would make orthogonal vectors score **0.5** and therefore
 *   pass a `minSim: 0.5` filter. Every threshold the plan cites from `dong2023reveal`
 *   (0.45/0.55/0.80/0.95) is a *similarity* threshold, so rescaling would silently change what
 *   those numbers mean and make the embedding arm incomparable to the string arm.
 *
 * The first is used. Anything that wants the raw signed value calls `dot` on normalized vectors.
 */
export function cosine(a: number[], b: number[]): number {
  assertSameLength(a, b);
  const normA = norm(a);
  const normB = norm(b);
  if (normA === 0 || normB === 0) return 0;
  return clampSimilarity(dot(a, b) / (normA * normB));
}

/** Cosine for vectors already `l2Normalize`d — the hot path, where the dot product *is* the cosine. */
export function cosineNormalized(a: number[], b: number[]): number {
  return clampSimilarity(dot(a, b));
}

/** Floating-point error can push a self-comparison to 1 + 1e-16, which would break `minSim` logic. */
export function clampSimilarity(value: number): number {
  if (value <= 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Element-wise mean. The `centroid` / `mean` cluster representations in `EmbeddingGenerator`, and
 * the pooling a sidecar may leave to the client.
 */
export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error('vectorUtils: meanPool of an empty set');
  const width = vectors[0].length;
  const out = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    assertSameLength(out, vector);
    for (let i = 0; i < width; i += 1) out[i] += vector[i];
  }
  return out.map((value) => value / vectors.length);
}
