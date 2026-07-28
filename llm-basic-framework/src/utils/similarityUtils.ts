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

interface Candidate {
  key: string;
  strings: string[];
}

interface BestMatchOptions {
  k?: number;
  minSim?: number;
}

export function bestMatches(
  needle: string,
  haystack: Candidate[],
  options: BestMatchOptions = {}
): Array<{ key: string; sim: number }> {
  const { k = 5, minSim = 0.5 } = options;

  const scored: Array<{ key: string; sim: number }> = [];
  for (const candidate of haystack) {
    let sim = 0;
    for (const str of candidate.strings) {
      sim = Math.max(sim, stringSimilarity(needle, str));
      if (sim === 1) break;
    }
    if (sim >= minSim) {
      scored.push({ key: candidate.key, sim });
    }
  }

  // Deterministic tie-break: (-sim, key).
  //
  // Sorting on `b.sim - a.sim` alone left equal-similarity candidates in haystack order, which for
  // EntityRegistry is `Object.entries(records)` order — i.e. mint order, i.e. document order. That
  // is deterministic for one replay but changes with the stream order, on a resume, or after a
  // merge, so "same config → same candidate list" was false in a way no seed could fix.
  //
  // It matters because the design mandates similarity-ordered top-k *precisely because* position
  // bias is real (`wang2024comem`): a tied candidate silently moving from slot 1 to slot 4 changes
  // what the judge sees. It also affects `.slice(0, k)` — which tied candidates survive the cut.
  //
  // Two call sites are affected, both intentionally (M2.5):
  //   * EntityRegistry.candidates()      → the judge's candidate list
  //   * SchemaRegistry.findSimilar*()    → near-matches rendered into the type-judge PROMPT text
  //
  // `<` compares UTF-16 code units. localeCompare is deliberately avoided: it is ICU- and
  // locale-dependent, so it would reintroduce cross-environment nondeterminism on Cyrillic keys.
  // The comparison is written without `||` so a `-0` difference cannot fall through to the
  // tie-break branch.
  return scored
    .sort((a, b) => {
      if (a.sim !== b.sim) return b.sim - a.sim;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, k);
}
