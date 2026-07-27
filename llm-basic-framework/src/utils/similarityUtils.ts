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

  return scored.sort((a, b) => b.sim - a.sim).slice(0, k);
}
