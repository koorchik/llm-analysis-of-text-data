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
   * Every surface this canonical can be matched on: the canonical itself followed by its label
   * surfaces, in registry order. The canonical usually appears twice, because `mint` stores it in
   * its own label list — harmless, since scoring takes a max.
   */
  surfaces: string[];
  /** skos:definition — the one-line description written at mint time. */
  definition?: string | null;
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

// --- DecisionStrategy -----------------------------------------------------------------------------

/**
 * One mention awaiting a decision, with the candidates a generator surfaced for it.
 *
 * `candidates` arrives already ordered by {@link compareCandidates} and truncated to k. A strategy
 * may re-rank internally but must not assume it can widen the list — recall it did not get is gone.
 */
export interface DecisionRequest {
  mention: string;
  category: string;
  candidates: Candidate[];
  docId: number;
  /** Generic source evidence; strategies must not treat contextual role or behavior as identity. */
  docTitle?: string;
  docSnippet?: string;
  /**
   * Which evidence window(s) of `docSnippet` cover this mention (per-mention snippet mode):
   * `docSnippet` then holds numbered windows ("S1. …") and this names the ones containing the
   * mention (e.g. "S2"), so the ballot can bind evidence to mentions without re-printing text.
   */
  contextRef?: string;
  /**
   * Entities this document already knows about, offered as possible **parents**: every candidate
   * surfaced for any mention in the batch, plus the other mentions being decided alongside it.
   *
   * Identity retrieval and hierarchy retrieval want different neighbours, which is why this is a
   * separate list rather than a wider `candidates`. Measured on the dev-Software slice: of 24
   * reachable gold edges, 14 had a parent the identity blocker never surfaced at any depth
   * (`rfusclient.exe` → `Remote Utilities`, `MS Excel` → `MS Office`) — they are not near in name or
   * in embedding space, they are simply discussed in the same report.
   */
  pool?: Array<{ canonical: string; surfaces: string[] }>;
}

export type DecisionKind = 'link' | 'mint' | 'defer';

/**
 * `defer` is the third state M6 adds, and it is deliberately not a synonym for `mint`.
 *
 * A `mint` asserts "this is a new entity"; a `defer` asserts "I decline to decide". They differ in
 * how they score — see §5 of `docs/statistical-protocol.md`, fixed before any `defer` was emitted: a
 * deferral is a **withheld decision**, excluded from merge *precision* (no claim was made, so none
 * can be wrong) but **counted as a miss in recall**, and reported as its own deferral-rate column.
 * The asymmetry is deliberate — excluding deferrals from both would make "defer everything" score
 * perfectly. A strategy that cannot abstain never returns it, so the baseline arms are unaffected.
 */
export interface Decision {
  kind: DecisionKind;
  /** The chosen canonical for `link`; null for `mint` and `defer`. */
  target: string | null;
  /**
   * Strategy-reported confidence in [0, 1], or null when the strategy has no calibrated notion of
   * one. Never invent a number here: a fabricated confidence would flow into the decision log and
   * look like evidence in E5's calibration curves.
   */
  confidence: number | null;
  /** Short, loggable reason — appears in the decision log, so keep it stable across runs. */
  reason: string;
  /**
   * The graph half of a verdict, filled only by strategies that model hierarchy. All optional so
   * the flat-identity strategies stay unchanged, and all **proposals**: the caller validates
   * `parentCandidate` against the list it actually showed before storing anything.
   */
  gloss?: string | null;
  parentCandidate?: string | null;
  /**
   * The ISO 25964 typing the strategy read between mention and `parentCandidate`:
   * `broaderInstantial` (BTI — a version/edition/platform qualifier removed, `Office 2010` under
   * `Office`), `broaderGeneric` (BTG — is-a, stated less precisely for any other reason), or
   * `broaderPartitive` (BTP — a distinct component of a whole).
   *
   * All three store one skos:broader edge; the typing rides in the edge's `type` field.
   * `broaderInstantial` is recorded separately because it is the one relation an analysis usually
   * wants to contract on its own — "products without version names" folds `Office 2010` into
   * `Office` while leaving `MS Word` under `MS Office` alone.
   */
  broaderType?: 'broaderGeneric' | 'broaderPartitive' | 'broaderInstantial' | null;
  /**
   * True when the strategy read the mention as the BROADER side of the relation (`r: "b"` on the
   * SKOS ballot): the stored edge runs `parentCandidate` → mention, endpoints swapped by the caller.
   */
  mentionIsBroader?: boolean;
}

/**
 * Decides identity. This is the port E1/E3/E8 vary along.
 *
 * `decide` takes the whole document's batch at once, because the LLM strategies make **one batched
 * call per document** and splitting that into per-mention calls would change both cost and the
 * judge's context. Returning an array positionally aligned with `requests` is part of the contract —
 * strategies must return exactly one decision per request, in order.
 *
 * Note the asymmetry with `CandidateGenerator`: generators see one query at a time and strategies see
 * the batch. That is not an inconsistency, it reflects where batching is observable in cost.
 */
export interface DecisionStrategy {
  readonly id: string;
  readonly config: Record<string, unknown>;
  decide(requests: DecisionRequest[]): Promise<Decision[]>;
}
