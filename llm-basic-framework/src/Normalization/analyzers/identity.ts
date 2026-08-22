import type { Analyzer } from '../types';

/**
 * The baseline matching key: the surface form, trimmed and case-folded.
 *
 * "Identity" here means the identity *matching* transform, not the untouched string. Case folding is
 * part of it because that is what identity has always meant in this pipeline — `ConceptRegistry`'s
 * exact fast path resolves on `name.trim().toLowerCase()`, so an analyzer that preserved case would
 * disagree with the registry's own notion of the same name.
 *
 * Putting the fold here rather than inside the metrics is what makes the matrix composable: metrics
 * receive keys and never normalize, so a different analyzer can supply a different notion of
 * identity without any metric changing. It is also exactly what the M2.5 gate requires —
 * `identity` + `max(levenshtein, tokenDice)` must reproduce the pre-M4 `stringSimilarity`, which
 * trimmed and lower-cased internally.
 *
 * Uses `toLowerCase()` rather than `toLocaleLowerCase()`: the latter is locale-dependent (Turkish
 * dotless ı being the classic trap) and would make matching differ by machine.
 */
export const identityAnalyzer: Analyzer = {
  id: 'identity',
  keys(value: string): string[] {
    const key = value.trim().toLowerCase();
    return key.length === 0 ? [] : [key];
  },
};
