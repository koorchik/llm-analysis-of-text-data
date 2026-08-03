import { classifyMechanism } from './proposePairs';
import type { Inventory, InventoryEntry } from './inventory';

/**
 * A third pair proposer: multilingual dense embeddings over the inventory surfaces.
 *
 * **Why it exists.** The string sweep cannot propose a zero-overlap alias (`Fancy Bear`/`APT28`)
 * and the registry proposer — the only current source of such pairs — is the batch Ψ_norm arm's
 * own output, i.e. a system under test (GOLD-TABLE.md §7.4). A dense encoder is the one channel
 * that is independent of both string mechanics and every system being evaluated, so its pairs are
 * what makes the judgment strata's recall defensible rather than registry-circular.
 *
 * **What a neighbour means.** Nothing but proximity in vector space. Unlike a registry row there
 * is no merge assertion here — most neighbours are thematic look-alikes, and the pre-labeller
 * sends every embedding-only row to `review` under its own rule. The value is recall of the pairs
 * worth asking about, not opinions about them.
 *
 * **Why not the `Normalization/candidates` generator.** That interface serves the streaming
 * pipeline's per-mention retrieval against a *mutating* registry (`onRegistryChange` invalidation).
 * Here the inventory is frozen and the job is one all-pairs top-k sweep — `embed()` everything
 * once (batched, cached) and brute-force cosine over ≤2K surfaces per category, which is
 * milliseconds. Wrapping the inventory in a fake registry to fit the generator interface would be
 * contortion with nothing bought.
 */

export interface EmbeddingProposal {
  category: string;
  left: string;
  right: string;
  /** From `classifyMechanism` when a string mechanism explains the pair; provisional 'c' otherwise. */
  stratum: string;
  mechanism: string;
  /** String similarity when re-attributed; the cosine for true embedding pairs. */
  sim: number;
  label: '';
  evidence: '';
  /** The raw cosine, kept regardless of re-attribution — this is what the threshold acted on. */
  cos: number;
}

export interface EmbeddingPairsResult {
  pairs: EmbeddingProposal[];
  /** Every considered candidate cosine (top-k, pre-threshold, deduplicated) — tune `minCos` from this. */
  cosines: number[];
  stats: { surfaces: number; embedded: number; comparisons: number; proposed: number };
}

interface Options {
  /** Neighbours considered per surface. */
  k?: number;
  /** Minimum cosine for a proposal. Corpus-dependent — pick from the reported histogram. */
  minCos?: number;
  skipCategories?: string[];
  /** Passed to `classifyMechanism` so re-attribution follows the shared rule. */
  minSim?: number;
}

/** The narrow slice of EmbeddingsClient this module needs — tests inject a canned one. */
export interface EmbedFn {
  embed(input: string[], options?: { operator?: string; docId?: number | null }): Promise<number[][]>;
}

const fold = (value: string) => value.trim().toLowerCase();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function embeddingPairs(
  inventory: Inventory,
  client: EmbedFn,
  options: Options = {}
): Promise<EmbeddingPairsResult> {
  const k = options.k ?? 10;
  const minCos = options.minCos ?? 0.6;
  const minSim = options.minSim ?? 0.7;
  const skip = new Set((options.skipCategories ?? []).map(fold));

  const byCategory = new Map<string, InventoryEntry[]>();
  for (const entry of inventory.entries) {
    if (skip.has(fold(entry.category))) continue;
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const surfaces = [...byCategory.values()].flat().map((entry) => entry.surface);
  // One call for everything: the client batches and caches internally, and a per-category loop
  // would only re-issue surfaces that repeat across categories.
  const vectors = surfaces.length > 0 ? await client.embed(surfaces, { operator: 'gold-embedding-pairs', docId: null }) : [];
  const vectorOf = new Map<string, number[]>();
  surfaces.forEach((surface, index) => vectorOf.set(surface, vectors[index]));

  const pairs: EmbeddingProposal[] = [];
  const cosines: number[] = [];
  const considered = new Set<string>();
  let comparisons = 0;

  for (const [category, entries] of byCategory) {
    for (let i = 0; i < entries.length; i++) {
      // Top-k neighbours of entry i within its category.
      const neighbours: Array<{ j: number; cos: number }> = [];
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        if (fold(entries[i].surface) === fold(entries[j].surface)) continue;
        comparisons++;
        neighbours.push({
          j,
          cos: cosine(vectorOf.get(entries[i].surface)!, vectorOf.get(entries[j].surface)!),
        });
      }
      neighbours.sort((a, b) => b.cos - a.cos);

      for (const { j, cos } of neighbours.slice(0, k)) {
        const left = entries[i].surface < entries[j].surface ? entries[i].surface : entries[j].surface;
        const right = entries[i].surface < entries[j].surface ? entries[j].surface : entries[i].surface;
        const key = `${fold(category)}|${fold(left)}|${fold(right)}`;
        if (considered.has(key)) continue;
        considered.add(key);
        cosines.push(Number(cos.toFixed(4)));
        if (cos < minCos) continue;

        // Stratum comes from the mechanism that explains the pair, never from the proposer —
        // the same rule the registry proposer follows.
        const classified = classifyMechanism(left, right, category, minSim);
        pairs.push({
          category,
          left,
          right,
          stratum: classified?.stratum ?? 'c',
          mechanism: classified?.mechanism ?? 'embedding',
          sim: Number((classified?.sim ?? cos).toFixed(4)),
          label: '',
          evidence: '',
          cos: Number(cos.toFixed(4)),
        });
      }
    }
  }

  // Highest cosine first, mirroring the string proposer's similarity order.
  pairs.sort(
    (a, b) =>
      b.cos - a.cos ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0)
  );

  return {
    pairs,
    cosines,
    stats: {
      surfaces: surfaces.length,
      embedded: vectorOf.size,
      comparisons,
      proposed: pairs.length,
    },
  };
}

/** Decile summary of the candidate-cosine distribution, for picking `minCos` from a dry run. */
export function cosineHistogram(cosines: number[], buckets = 10): Array<{ bucket: string; count: number }> {
  const out: Array<{ bucket: string; count: number }> = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const count = cosines.filter((c) => c >= lo && (b === buckets - 1 ? c <= hi : c < hi)).length;
    out.push({ bucket: `${lo.toFixed(1)}–${hi.toFixed(1)}`, count });
  }
  return out;
}
