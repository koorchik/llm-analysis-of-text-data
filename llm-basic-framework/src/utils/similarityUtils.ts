import { distance } from 'fastest-levenshtein';

export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - distance(a, b) / maxLen;
}

function tokenize(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

export function tokenSetDice(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

export function stringSimilarity(a: string, b: string): number {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  return Math.max(levenshteinRatio(normA, normB), tokenSetDice(normA, normB));
}

/**
 * `bestMatches` was **removed in M4**.
 *
 * Its two importers are migrated: `ConceptRegistry` now exposes `snapshot()` for
 * `StringSimilarityGenerator`, and `SchemaRegistry` uses `Normalization/matchStrings`. Both share the
 * `(-sim, key)` tie-break M2.5 established, so neither can reintroduce the insertion-order leak that
 * made 37.6% of candidate lists run-dependent.
 *
 * `stringSimilarity` above is retained: `StreamingExtractor` and `RegistryConsolidator` (now
 * harness-only — the RQ3 batch-reference tool, `bin/batch-reference.ts` — not the live repair
 * path, which is `StreamingRepairer`/`SuspectGenerator`) still use it for their pairwise suspect
 * checks, and the metrics tests assert that
 * `identity + max(levenshtein, tokenDice)` reproduces it exactly — the algebraic identity the
 * behaviour-preservation gate rests on.
 */
