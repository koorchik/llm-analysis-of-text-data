import { identityAnalyzer } from './analyzers/identity';
import { maxLevDice } from './metrics/stringMetrics';
import type { Analyzer, SimilarityMetric } from './types';

export interface StringMatch {
  key: string;
  sim: number;
}

export interface MatchOptions {
  k?: number;
  minSim?: number;
  analyzers?: Analyzer[];
  metric?: SimilarityMetric;
}

/**
 * Top-k string matching for callers that are **not** matching registry canonicals.
 *
 * This is the replacement for the retired `similarityUtils.bestMatches`. `SchemaRegistry` needs the
 * same operation — score a needle against labelled bundles of strings, keep the best k — but it
 * matches *schema entries*, not entities, so wrapping it in a `CandidateGenerator` (which is defined
 * over a `RegistrySnapshot`) would be a type-level lie.
 *
 * Same ordering rule as the generators: `(-sim, key)` in UTF-16 code-unit order, never
 * `localeCompare`. `SchemaRegistry`'s near-matches are rendered into the type-judge **prompt text**,
 * so their order is model-visible — which is why M2.5's tie-break fix had to reach this path too.
 */
export function matchStrings(
  needle: string,
  haystack: Array<{ key: string; strings: string[] }>,
  options: MatchOptions = {}
): StringMatch[] {
  const { k = 5, minSim = 0.5 } = options;
  const analyzers = options.analyzers ?? [identityAnalyzer];
  const metric = options.metric ?? maxLevDice;
  const ctx = { category: '' };

  const keysOf = (value: string): string[] => {
    if (analyzers.length === 1) return analyzers[0].keys(value, ctx);
    const keys = new Set<string>();
    for (const analyzer of analyzers) for (const key of analyzer.keys(value, ctx)) keys.add(key);
    return [...keys];
  };

  const needleKeys = keysOf(needle);
  if (needleKeys.length === 0) return [];

  const scored: StringMatch[] = [];
  for (const candidate of haystack) {
    let sim = 0;
    for (const value of candidate.strings) {
      for (const valueKey of keysOf(value)) {
        for (const needleKey of needleKeys) {
          const score = metric.score(needleKey, valueKey);
          if (score > sim) sim = score;
        }
      }
      if (sim === 1) break;
    }
    if (sim >= minSim) scored.push({ key: candidate.key, sim });
  }

  return scored
    .sort((a, b) => {
      if (a.sim !== b.sim) return b.sim - a.sim;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, k);
}
