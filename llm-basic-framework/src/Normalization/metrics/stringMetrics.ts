import type { SimilarityMetric } from '../types';
import { distance } from 'fastest-levenshtein';

/**
 * Pairwise string similarity metrics.
 *
 * All operate on **analyzer keys already normalized** — no metric trims or case-folds. The pre-M4
 * `stringSimilarity` did both internally, which is why it could not be recombined with a different
 * notion of identity; keeping metrics pure is what makes the analyzer × metric matrix expressible.
 *
 * `mongeElkan` is deliberately **absent**. The research note rates it ★ "document as
 * considered-and-rejected", so it belongs in the paper's rejection list, not the codebase — adding
 * it would imply it was evaluated. Same for phonetic metrics (Soundex/Metaphone/NYSIIS): designed
 * for English surnames, useless on Cyrillic and on `UAC-####` designations.
 */

// --- Levenshtein ----------------------------------------------------------------------------------

export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance(a, b) / maxLen;
}

export const levenshtein: SimilarityMetric = {
  id: 'levenshtein',
  score: levenshteinRatio,
};

// --- Damerau–Levenshtein --------------------------------------------------------------------------

/**
 * Damerau–Levenshtein with adjacent transpositions, normalized like {@link levenshteinRatio}.
 *
 * Distinguishes a transposition from two substitutions, so `Sandowrm`/`Sandworm` costs 1 rather
 * than 2 — the common typo class in hand-entered CTI names. Restricted (optimal string alignment)
 * rather than unrestricted: it is the standard choice, and the unrestricted variant's extra
 * generality is not worth the cost here.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two rows would not suffice: a transposition looks back two rows.
  const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1, // deletion
        rows[i][j - 1] + 1, // insertion
        rows[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return rows[a.length][b.length];
}

export function damerauRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - damerauLevenshteinDistance(a, b) / maxLen;
}

export const damerau: SimilarityMetric = { id: 'damerau', score: damerauRatio };

// --- Jaro–Winkler ---------------------------------------------------------------------------------

export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const half = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3;
}

/**
 * Jaro–Winkler: Jaro with a bonus for a shared prefix.
 *
 * `gruenheid2014incremental` measures it on Febrl noise sweeps, and the note rates it ★★ "stronger
 * than Levenshtein on short names and shared prefixes" — which is the CERT-UA case exactly. It is
 * also the metric most likely to *worsen* `UAC-####` retrieval, since those share a four-character
 * prefix by construction; E4 should report it per stratum rather than in aggregate.
 */
export function jaroWinklerSimilarity(a: string, b: string, prefixScale = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  // The standard bonus applies only above 0.7, and to at most four leading characters.
  if (jaro <= 0.7) return jaro;

  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;

  return jaro + prefix * prefixScale * (1 - jaro);
}

export const jaroWinkler: SimilarityMetric = { id: 'jaro-winkler', score: jaroWinklerSimilarity };

// --- token-set Dice -------------------------------------------------------------------------------

/** Splits on any run of non-letter, non-digit characters. */
export function tokenize(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/**
 * Token-set Dice coefficient.
 *
 * **Known failure mode, measured in M2.5:** because tokenization discards punctuation, any two
 * 2-token domains sharing only a TLD score exactly 0.5 — at the pipeline's `minSim` boundary — and
 * `accounts-ukr.net` / `accounts--ukr.net` / `accounts---ukr.net` have *identical* token sets and
 * score 1.0 while plausibly being distinct typosquats. Use `domainCanonical` or an exact channel for
 * domains rather than relying on this alone.
 */
export function tokenSetDice(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

export const tokenDice: SimilarityMetric = { id: 'token-dice', score: tokenSetDice };

// --- character n-grams ----------------------------------------------------------------------------

export function charNgrams(text: string, n = 3): string[] {
  if (n <= 0) return [];
  // Pad so short strings and word boundaries still produce grams.
  const padded = ` ${text} `;
  if (padded.length < n) return [padded];
  const grams: string[] = [];
  for (let i = 0; i + n <= padded.length; i++) grams.push(padded.slice(i, i + n));
  return grams;
}

/**
 * Cosine over character n-gram **term frequencies** — no IDF.
 *
 * IDF needs a corpus, which a pairwise metric does not have. The IDF-weighted variant the note calls
 * for (`wang2024comem`'s Sparkly TF/IDF kNN, recall@10 86.57–99.96%) therefore lives in
 * `TfidfNgramGenerator`, where the registry provides the document frequencies. Splitting it this way
 * keeps the metric honest about what it can compute alone.
 */
export function charNgramCosine(a: string, b: string, n = 3): number {
  if (a === b) return 1;
  const countsA = new Map<string, number>();
  for (const gram of charNgrams(a, n)) countsA.set(gram, (countsA.get(gram) ?? 0) + 1);
  const countsB = new Map<string, number>();
  for (const gram of charNgrams(b, n)) countsB.set(gram, (countsB.get(gram) ?? 0) + 1);

  let dot = 0;
  for (const [gram, count] of countsA) dot += count * (countsB.get(gram) ?? 0);
  if (dot === 0) return 0;

  const normA = Math.sqrt([...countsA.values()].reduce((sum, c) => sum + c * c, 0));
  const normB = Math.sqrt([...countsB.values()].reduce((sum, c) => sum + c * c, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

export const charNgram = (n = 3): SimilarityMetric => ({
  id: `char-${n}gram-cosine`,
  score: (a, b) => charNgramCosine(a, b, n),
});

// --- composites -----------------------------------------------------------------------------------

/**
 * Maximum over child metrics.
 *
 * `max(levenshtein, tokenDice)` is the pre-M4 `stringSimilarity`, and reproducing it exactly is what
 * the M2.5 behaviour-preservation gate checks.
 */
export function maxOf(metrics: SimilarityMetric[], id?: string): SimilarityMetric {
  return {
    id: id ?? `max(${metrics.map((metric) => metric.id).join(',')})`,
    score: (a, b) => metrics.reduce((best, metric) => Math.max(best, metric.score(a, b)), 0),
  };
}

/** Convex combination. Weights are normalized, so they need not sum to 1. */
export function weightedOf(
  parts: Array<{ metric: SimilarityMetric; weight: number }>,
  id?: string
): SimilarityMetric {
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  return {
    id: id ?? `weighted(${parts.map((part) => `${part.metric.id}:${part.weight}`).join(',')})`,
    score: (a, b) =>
      total === 0
        ? 0
        : parts.reduce((sum, part) => sum + part.weight * part.metric.score(a, b), 0) / total,
  };
}

/**
 * The metric the streaming pipeline has always used, now expressible as a composition.
 *
 * Identical to the pre-M4 `stringSimilarity` **provided the inputs are already case-folded and
 * trimmed** — which the `identity` analyzer guarantees.
 */
export const maxLevDice: SimilarityMetric = maxOf([levenshtein, tokenDice], 'max-lev-dice');

export const METRICS: Record<string, SimilarityMetric> = {
  levenshtein,
  damerau,
  'jaro-winkler': jaroWinkler,
  'token-dice': tokenDice,
  'char-3gram-cosine': charNgram(3),
  'max-lev-dice': maxLevDice,
};
