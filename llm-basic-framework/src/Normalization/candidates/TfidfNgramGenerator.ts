import { identityAnalyzer } from '../analyzers/identity';
import { charNgrams } from '../metrics/stringMetrics';
import {
  topK,
  type Analyzer,
  type Candidate,
  type CandidateGenerator,
  type CandidateQuery,
  type RegistryChange,
  type RegistrySnapshot,
} from '../types';

interface Params {
  analyzers?: Analyzer[];
  n?: number;
  channel?: string;
}

interface CategoryIndex {
  /** canonical → n-gram → term frequency, L2-normalized with idf applied. */
  vectors: Map<string, Map<string, number>>;
  surfaces: Map<string, string[]>;
  idf: Map<string, number>;
}

/**
 * Character n-gram TF-IDF cosine — the cheapest strong blocker.
 *
 * `wang2024comem` uses exactly this (Sparkly TF/IDF kNN) and reports **recall@10 of 86.57–99.96%**,
 * which is the published precedent for E4's primary metric. IDF is what makes it stronger than the
 * plain cosine in `stringMetrics`: a gram shared by half the registry carries almost no evidence,
 * while a rare gram is nearly decisive. On this corpus that should matter a great deal — `.com` and
 * `ukr` are near-universal among 1,929 domains, and M2.5 showed unweighted similarity drowning in
 * exactly that kind of shared-but-uninformative overlap.
 *
 * The index is rebuilt lazily on registry change. At ~2,674 canonicals a rebuild is milliseconds, so
 * incremental maintenance would be complexity without benefit — and a stale index would silently
 * lose every canonical minted since `prepare()`.
 */
export class TfidfNgramGenerator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #analyzers: Analyzer[];
  #n: number;
  #channel: string;
  #snapshot?: RegistrySnapshot;
  #indexes = new Map<string, CategoryIndex>();

  constructor(params: Params = {}) {
    this.#analyzers = params.analyzers ?? [identityAnalyzer];
    this.#n = params.n ?? 3;
    this.#channel = params.channel ?? 'tfidf-ngram';
    this.id = `tfidf-${this.#n}gram(${this.#analyzers.map((a) => a.id).join('+')})`;
    this.config = { n: this.#n, analyzers: this.#analyzers.map((analyzer) => analyzer.id) };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    this.#snapshot = snapshot;
    this.#indexes.clear();
  }

  /** Drops the affected category's index; it is rebuilt on the next query for that category. */
  onRegistryChange(event: RegistryChange): void {
    this.#indexes.delete(event.category);
  }

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    if (!this.#snapshot) throw new Error(`${this.id}: prepare() must be called before candidates()`);

    const index = this.#indexFor(query.category);
    if (index.vectors.size === 0) return [];

    const queryVector = this.#vectorize(this.#gramsFor(query.mention, query.category), index.idf);
    if (queryVector.size === 0) return [];

    const scored: Candidate[] = [];
    for (const [canonical, vector] of index.vectors) {
      let dot = 0;
      // Iterate the shorter vector; both are already L2-normalized, so the dot product IS the cosine.
      const [small, large] = queryVector.size <= vector.size ? [queryVector, vector] : [vector, queryVector];
      for (const [gram, weight] of small) {
        const other = large.get(gram);
        if (other !== undefined) dot += weight * other;
      }

      if (dot >= query.minSim) {
        scored.push({
          canonical,
          sim: dot,
          surfaces: index.surfaces.get(canonical) ?? [],
          channel: this.#channel,
        });
      }
    }

    return topK(scored, query.k);
  }

  #gramsFor(value: string, category: string): string[] {
    const ctx = { category };
    const grams: string[] = [];
    for (const analyzer of this.#analyzers) {
      for (const key of analyzer.keys(value, ctx)) grams.push(...charNgrams(key, this.#n));
    }
    return grams;
  }

  #indexFor(category: string): CategoryIndex {
    const cached = this.#indexes.get(category);
    if (cached) return cached;

    const entries = this.#snapshot!.entries(category);
    const documentFrequency = new Map<string, number>();
    const rawVectors = new Map<string, Map<string, number>>();
    const surfaces = new Map<string, string[]>();

    for (const entry of entries) {
      const counts = new Map<string, number>();
      // Every surface contributes to one document, so an alias-rich canonical is genuinely easier to
      // retrieve — which is the intended behaviour, not a bias to correct.
      for (const surface of entry.surfaces) {
        for (const gram of this.#gramsFor(surface, category)) {
          counts.set(gram, (counts.get(gram) ?? 0) + 1);
        }
      }
      rawVectors.set(entry.canonical, counts);
      surfaces.set(entry.canonical, entry.surfaces.slice(1));
      for (const gram of counts.keys()) {
        documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
      }
    }

    // Smoothed idf, so a gram present in every document gets a small positive weight rather than 0
    // — zeroing it would make two names sharing only universal grams score exactly 0 and vanish
    // below minSim, which loses the (weak but real) evidence that they share anything at all.
    const total = entries.length;
    const idf = new Map<string, number>();
    for (const [gram, df] of documentFrequency) {
      idf.set(gram, Math.log((total + 1) / (df + 1)) + 1);
    }

    const vectors = new Map<string, Map<string, number>>();
    for (const [canonical, counts] of rawVectors) {
      vectors.set(canonical, this.#vectorize([...counts.entries()].flatMap(([gram, count]) => Array(count).fill(gram)), idf));
    }

    const index: CategoryIndex = { vectors, surfaces, idf };
    this.#indexes.set(category, index);
    return index;
  }

  /** tf-idf weights, L2-normalized so a dot product is a cosine. */
  #vectorize(grams: string[], idf: Map<string, number>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const gram of grams) counts.set(gram, (counts.get(gram) ?? 0) + 1);

    const weighted = new Map<string, number>();
    for (const [gram, tf] of counts) {
      // An unseen gram gets the maximum idf the index can express: it is maximally informative, and
      // dropping it would silently ignore the most distinctive part of an unseen name.
      const weight = tf * (idf.get(gram) ?? Math.log(idf.size + 1) + 1);
      if (weight !== 0) weighted.set(gram, weight);
    }

    let norm = 0;
    for (const weight of weighted.values()) norm += weight * weight;
    norm = Math.sqrt(norm);
    if (norm === 0) return new Map();

    for (const [gram, weight] of weighted) weighted.set(gram, weight / norm);
    return weighted;
  }
}
