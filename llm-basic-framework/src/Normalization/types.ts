/**
 * The five ports the normalization experiments vary along. All in one file, per the plan.
 *
 * The separation that matters: **candidate generation is recall-only and never decides identity.**
 * A generator's job is to ensure the true canonical reaches the judge's list; deciding whether two
 * surfaces denote the same entity belongs to `DecisionStrategy` (M6). Conflating the two is what
 * makes a similarity threshold masquerade as a merge decision — the failure mode
 * `dong2023reveal` documents when it shows tuned thresholds landing at 0.45/0.55/0.80/0.95/0.95
 * across five datasets and still failing on confidently-wrong near-1.0 matches.
 */

// --- Analyzer -------------------------------------------------------------------------------------

export interface AnalyzerContext {
  category: string;
}

/**
 * Maps a surface form to the keys it should be *matched* on.
 *
 * Analyzers own all matching-time normalization — transliteration, confusable folding, acronym
 * expansion, domain canonicalization — and never change what the registry stores. The registry keeps
 * surface forms; analyzers exist so two spellings of one name can meet without either being rewritten.
 *
 * Returning several keys is normal (a Cyrillic name has one key per transliteration scheme). An
 * analyzer that has nothing to say for a value returns an empty array, and the generator skips it.
 */
export interface Analyzer {
  readonly id: string;
  keys(value: string, ctx: AnalyzerContext): string[];
}

// --- SimilarityMetric -----------------------------------------------------------------------------

/**
 * A pure, synchronous score in [0, 1], 1 meaning identical.
 *
 * Metrics receive **analyzer keys, already normalized**, and must not normalize again. That split is
 * deliberate: hidden normalization inside a metric was exactly what made the pre-M4
 * `stringSimilarity` impossible to recombine — it trimmed and lower-cased internally, so no caller
 * could compose it with a different notion of identity.
 */
export interface SimilarityMetric {
  readonly id: string;
  score(a: string, b: string): number;
}

// --- registry view --------------------------------------------------------------------------------

export interface SnapshotEntry {
  canonical: string;
  /**
   * Every surface this canonical can be matched on: the canonical itself followed by its alias
   * surfaces, in registry order. The canonical usually appears twice, because `mint` stores it in
   * its own alias list — harmless, since scoring takes a max.
   */
  surfaces: string[];
  gloss?: string | null;
  categoryCounts?: Record<string, number>;
}

/**
 * Read-only view of the registry for generators.
 *
 * **Live, not a frozen copy.** The streaming registry changes after every document, so a copy taken
 * at `prepare()` time would go stale immediately. Generators that maintain an index must therefore
 * treat `onRegistryChange` as authoritative for invalidation rather than assuming immutability.
 */
export interface RegistrySnapshot {
  categories(): string[];
  entries(category: string): SnapshotEntry[];
  size(category: string): number;
}

export type RegistryChangeType = 'mint' | 'link' | 'merge' | 'split' | 'move';

export interface RegistryChange {
  type: RegistryChangeType;
  category: string;
  canonical: string;
}

// --- CandidateGenerator ---------------------------------------------------------------------------

export interface CandidateQuery {
  mention: string;
  category: string;
  k: number;
  minSim: number;
  /** Document context, for generators that use it (contextual embeddings in M5). */
  docId?: number;
  /** The document's text, where available. */
  context?: string;
}

export interface Candidate {
  canonical: string;
  sim: number;
  /** The canonical's surfaces, as shown to the judge. */
  surfaces: string[];
  /**
   * Which generator surfaced it. Carried into the decision log so E4 can score candidate recall
   * per channel rather than only in aggregate.
   */
  channel: string;
}

/**
 * Recall only — never decides identity.
 *
 * `prepare` is called once with the registry view; `onRegistryChange` reports mutations so an
 * index-bearing generator can invalidate; `candidates` answers one query. Async because M5's
 * embedding generators do I/O, even though the string generators are synchronous underneath.
 */
export interface CandidateGenerator {
  readonly id: string;
  readonly config: Record<string, unknown>;
  prepare(snapshot: RegistrySnapshot): Promise<void>;
  onRegistryChange(event: RegistryChange): void;
  candidates(query: CandidateQuery): Promise<Candidate[]>;
}

// --- ordering -------------------------------------------------------------------------------------

/**
 * The single ordering rule for candidate lists: descending similarity, then canonical name in
 * UTF-16 code-unit order.
 *
 * Shared by every generator so none can reintroduce the pre-M2.5 leak, where equal-similarity
 * candidates fell back to registry insertion order and 37.6% of lists were order-dependent. Never
 * `localeCompare` — it is ICU- and locale-dependent, which would make Cyrillic keys sort differently
 * across machines.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.sim !== b.sim) return b.sim - a.sim;
  return a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0;
}

/** Sort by {@link compareCandidates} then take the top k. Sort-then-slice, never slice-then-sort. */
export function topK(candidates: Candidate[], k: number): Candidate[] {
  return [...candidates].sort(compareCandidates).slice(0, k);
}
