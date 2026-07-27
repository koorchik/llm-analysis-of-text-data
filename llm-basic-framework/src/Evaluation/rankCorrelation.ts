/**
 * Rank agreement between two orderings, consumed by M11 (E9 downstream impact).
 *
 * The E9 question is not "are the metrics different" but "does the analyst's *conclusion* change" —
 * so the comparison is between ranked actor lists (`ActiveHackerGroupsAnalyzer`'s
 * `totalAttackWeight`, the Tables 2–5 analyses of `turskyi2025formal`) produced from a run's
 * registry versus from the gold-normalized reference graph.
 */

export interface RankedItem {
  id: string;
  /** Higher is more important. Ties are expected — weighted degree produces many. */
  score: number;
}

export interface KendallResult {
  /** τ-b, the tie-corrected variant. */
  tau: number;
  concordant: number;
  discordant: number;
  tiesInA: number;
  tiesInB: number;
  /** Items present in both rankings — the only ones that can be compared. */
  n: number;
}

/**
 * Kendall τ-b with tie correction.
 *
 * τ-b = (n_c − n_d) / sqrt((n₀ − n₁)(n₀ − n₂))
 *   n₀ = C(n,2), n₁ = Σ C(tᵢ,2) over tie groups in A, n₂ = Σ C(uⱼ,2) over tie groups in B.
 *
 * τ-b rather than τ-a because **ties are the normal case here**: filtered weighted degree gives
 * many actors identical scores, and τ-a would penalise a ranking for ties that carry no
 * disagreement at all. Reported with the raw counts so a τ driven by a handful of comparable pairs
 * is visible rather than hidden behind a single number.
 */
export function kendallTauB(a: RankedItem[], b: RankedItem[]): KendallResult {
  const scoresB = new Map(b.map((item) => [item.id, item.score]));
  const shared = a.filter((item) => scoresB.has(item.id));
  const n = shared.length;

  if (n < 2) {
    return { tau: NaN, concordant: 0, discordant: 0, tiesInA: 0, tiesInB: 0, n };
  }

  let concordant = 0;
  let discordant = 0;
  let tiesInA = 0;
  let tiesInB = 0;
  let tiesInBoth = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const diffA = shared[i].score - shared[j].score;
      const diffB = scoresB.get(shared[i].id)! - scoresB.get(shared[j].id)!;

      const signA = Math.sign(diffA);
      const signB = Math.sign(diffB);

      if (signA === 0 && signB === 0) tiesInBoth++;
      else if (signA === 0) tiesInA++;
      else if (signB === 0) tiesInB++;
      else if (signA === signB) concordant++;
      else discordant++;
    }
  }

  // n₁ and n₂ count ALL tied pairs in each ranking, including those tied in both.
  const n0 = (n * (n - 1)) / 2;
  const n1 = tiesInA + tiesInBoth;
  const n2 = tiesInB + tiesInBoth;

  const denominator = Math.sqrt((n0 - n1) * (n0 - n2));

  return {
    // Every pair tied in at least one ranking → no comparable pairs. Perfect agreement by
    // convention (there is no disagreement to find), not NaN.
    tau: denominator === 0 ? 1 : (concordant - discordant) / denominator,
    concordant,
    discordant,
    tiesInA: n1,
    tiesInB: n2,
    n,
  };
}

export interface TopKOverlap {
  k: number;
  /** |top-k(A) ∩ top-k(B)| */
  intersection: number;
  /** intersection / k, using the effective k when a list is shorter. */
  overlap: number;
  /** Items in A's top-k but not B's — the ones a normalization error moved. */
  onlyInA: string[];
  onlyInB: string[];
  effectiveK: number;
}

/** Descending by score; ties broken by id so the ordering is deterministic across runs. */
export function rankOrder(items: RankedItem[]): string[] {
  return [...items]
    .sort((x, y) => (y.score !== x.score ? y.score - x.score : x.id < y.id ? -1 : 1))
    .map((item) => item.id);
}

/**
 * Top-k overlap, reported at k ∈ {5, 10, 20} by M11.
 *
 * `onlyInA` / `onlyInB` are what makes the E9 narrative possible: the note asks for exactly one
 * narrated case of an actor crossing the top-10 boundary because of a single normalization error,
 * and these lists name the candidates.
 */
export function topKOverlap(a: RankedItem[], b: RankedItem[], k: number): TopKOverlap {
  const topA = rankOrder(a).slice(0, k);
  const topB = rankOrder(b).slice(0, k);
  const setB = new Set(topB);
  const setA = new Set(topA);

  const intersection = topA.filter((id) => setB.has(id)).length;
  const effectiveK = Math.min(k, Math.max(topA.length, topB.length));

  return {
    k,
    intersection,
    overlap: effectiveK === 0 ? 0 : intersection / effectiveK,
    onlyInA: topA.filter((id) => !setB.has(id)),
    onlyInB: topB.filter((id) => !setA.has(id)),
    effectiveK,
  };
}

export interface RankCrossing {
  id: string;
  rankInA: number | null;
  rankInB: number | null;
  /** Positive when the item ranks better (lower number) in A than in B. */
  movement: number | null;
  crossedBoundary: boolean;
}

/**
 * Items whose rank crosses a boundary between the two rankings.
 *
 * This is E9's deliverable, not a diagnostic: "wrong normalization gives a wrong threat-actor list"
 * is the claim, and a single actor entering or leaving the top-10 is what makes it concrete.
 */
export function rankCrossings(a: RankedItem[], b: RankedItem[], boundary = 10): RankCrossing[] {
  const orderA = rankOrder(a);
  const orderB = rankOrder(b);
  const rankA = new Map(orderA.map((id, index) => [id, index + 1]));
  const rankB = new Map(orderB.map((id, index) => [id, index + 1]));

  const ids = new Set([...orderA, ...orderB]);
  const crossings: RankCrossing[] = [];

  for (const id of ids) {
    const inA = rankA.get(id) ?? null;
    const inB = rankB.get(id) ?? null;
    const insideA = inA !== null && inA <= boundary;
    const insideB = inB !== null && inB <= boundary;

    if (insideA !== insideB) {
      crossings.push({
        id,
        rankInA: inA,
        rankInB: inB,
        movement: inA !== null && inB !== null ? inB - inA : null,
        crossedBoundary: true,
      });
    }
  }

  // Most dramatic crossings first: an item present in one ranking only sorts to the top.
  return crossings.sort((x, y) => Math.abs(y.movement ?? Infinity) - Math.abs(x.movement ?? Infinity));
}

/** Spearman's ρ via Pearson on average ranks — a companion to τ-b, not a replacement. */
export function spearmanRho(a: RankedItem[], b: RankedItem[]): number {
  const scoresB = new Map(b.map((item) => [item.id, item.score]));
  const shared = a.filter((item) => scoresB.has(item.id));
  const n = shared.length;
  if (n < 2) return NaN;

  const averageRanks = (values: number[]): number[] => {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((x, y) => y.value - x.value);

    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j++;
      // Tied group [i..j] shares the average of their positions (1-based).
      const averageRank = (i + 1 + (j + 1)) / 2;
      for (let t = i; t <= j; t++) ranks[indexed[t].index] = averageRank;
      i = j + 1;
    }
    return ranks;
  };

  const ranksA = averageRanks(shared.map((item) => item.score));
  const ranksB = averageRanks(shared.map((item) => scoresB.get(item.id)!));

  const meanA = ranksA.reduce((sum, value) => sum + value, 0) / n;
  const meanB = ranksB.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    covariance += (ranksA[i] - meanA) * (ranksB[i] - meanB);
    varianceA += (ranksA[i] - meanA) ** 2;
    varianceB += (ranksB[i] - meanB) ** 2;
  }

  return varianceA === 0 || varianceB === 0 ? 1 : covariance / Math.sqrt(varianceA * varianceB);
}
