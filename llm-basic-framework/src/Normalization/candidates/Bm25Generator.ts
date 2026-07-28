import { identityAnalyzer } from '../analyzers/identity';
import { tokenize } from '../metrics/stringMetrics';
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
  /** Term-frequency saturation. 1.2 is the standard default. */
  k1?: number;
  /** Length normalization. 0.75 is the standard default. */
  b?: number;
  channel?: string;
}

interface Bm25Index {
  documents: Map<string, { terms: Map<string, number>; length: number; surfaces: string[] }>;
  documentFrequency: Map<string, number>;
  averageLength: number;
}

/**
 * Okapi BM25 over word tokens — the sparse half of the hybrid fusion arm.
 *
 * `rasmussen2025zep-preprint` runs cosine + Okapi BM25 + full-text together, and `mo2025kggen`
 * fuses BM25 with embeddings for top-k; the note rates hybrid sparse+dense fusion ★★★ as "the
 * standard fix when names share no semantics", which is the novel-tail case exactly.
 *
 * **Word tokens, not character n-grams**, deliberately: BM25's term saturation (`k1`) and length
 * normalization (`b`) are formulated for terms that carry meaning independently, and the char-n-gram
 * niche is already covered by `TfidfNgramGenerator`. Keeping the two channels on different term
 * spaces is what gives the fusion something to fuse — two n-gram channels would mostly agree, and
 * RRF over near-identical rankings buys nothing.
 *
 * BM25 is unbounded above, so scores are squashed into [0, 1] before being reported as `sim` — see
 * `#normalize`. Without that, `minSim` would be meaningless on this channel and the fusion would be
 * comparing incommensurable scales.
 */
export class Bm25Generator implements CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;

  #analyzers: Analyzer[];
  #k1: number;
  #b: number;
  #channel: string;
  #snapshot?: RegistrySnapshot;
  #indexes = new Map<string, Bm25Index>();

  constructor(params: Params = {}) {
    this.#analyzers = params.analyzers ?? [identityAnalyzer];
    this.#k1 = params.k1 ?? 1.2;
    this.#b = params.b ?? 0.75;
    this.#channel = params.channel ?? 'bm25';
    this.id = `bm25(${this.#analyzers.map((analyzer) => analyzer.id).join('+')})`;
    this.config = { k1: this.#k1, b: this.#b, analyzers: this.#analyzers.map((a) => a.id) };
  }

  async prepare(snapshot: RegistrySnapshot): Promise<void> {
    this.#snapshot = snapshot;
    this.#indexes.clear();
  }

  onRegistryChange(event: RegistryChange): void {
    this.#indexes.delete(event.category);
  }

  async candidates(query: CandidateQuery): Promise<Candidate[]> {
    if (!this.#snapshot) throw new Error(`${this.id}: prepare() must be called before candidates()`);

    const index = this.#indexFor(query.category);
    if (index.documents.size === 0) return [];

    const queryTerms = this.#termsFor(query.mention, query.category);
    if (queryTerms.length === 0) return [];

    const total = index.documents.size;
    const raw: Array<{ canonical: string; score: number; surfaces: string[] }> = [];

    for (const [canonical, document] of index.documents) {
      let score = 0;
      for (const term of new Set(queryTerms)) {
        const tf = document.terms.get(term);
        if (!tf) continue;
        const df = index.documentFrequency.get(term) ?? 0;
        // Standard BM25 idf with the +0.5 smoothing; max(0, …) guards the negative value a term
        // present in more than half the corpus would otherwise produce.
        const idf = Math.max(0, Math.log((total - df + 0.5) / (df + 0.5) + 1));
        const denominator =
          tf + this.#k1 * (1 - this.#b + (this.#b * document.length) / index.averageLength);
        score += idf * ((tf * (this.#k1 + 1)) / denominator);
      }
      if (score > 0) raw.push({ canonical, score, surfaces: document.surfaces });
    }

    const scored = this.#normalize(raw)
      .filter((candidate) => candidate.sim >= query.minSim)
      .map((candidate) => ({ ...candidate, channel: this.#channel }));

    return topK(scored, query.k);
  }

  /**
   * Squash unbounded BM25 into [0, 1] by dividing by the best score in this result set.
   *
   * A per-query normalization, so `sim` means "how strong relative to the best match for this
   * mention" rather than an absolute similarity. Stated plainly because it is **not** comparable
   * across queries the way an edit-distance ratio is — a lone weak match normalizes to 1.0. Fusion
   * uses ranks rather than these values for exactly that reason.
   */
  #normalize(
    raw: Array<{ canonical: string; score: number; surfaces: string[] }>
  ): Array<{ canonical: string; sim: number; surfaces: string[] }> {
    const best = raw.reduce((max, entry) => Math.max(max, entry.score), 0);
    if (best === 0) return [];
    return raw.map((entry) => ({
      canonical: entry.canonical,
      sim: entry.score / best,
      surfaces: entry.surfaces,
    }));
  }

  #termsFor(value: string, category: string): string[] {
    const ctx = { category };
    const terms: string[] = [];
    for (const analyzer of this.#analyzers) {
      for (const key of analyzer.keys(value, ctx)) terms.push(...tokenize(key));
    }
    return terms;
  }

  #indexFor(category: string): Bm25Index {
    const cached = this.#indexes.get(category);
    if (cached) return cached;

    const documents = new Map<string, { terms: Map<string, number>; length: number; surfaces: string[] }>();
    const documentFrequency = new Map<string, number>();
    let totalLength = 0;

    for (const entry of this.#snapshot!.entries(category)) {
      const terms = new Map<string, number>();
      let length = 0;
      for (const surface of entry.surfaces) {
        for (const term of this.#termsFor(surface, category)) {
          terms.set(term, (terms.get(term) ?? 0) + 1);
          length++;
        }
      }
      documents.set(entry.canonical, { terms, length, surfaces: entry.surfaces.slice(1) });
      totalLength += length;
      for (const term of terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const index: Bm25Index = {
      documents,
      documentFrequency,
      averageLength: documents.size === 0 ? 1 : totalLength / documents.size,
    };
    this.#indexes.set(category, index);
    return index;
  }
}
