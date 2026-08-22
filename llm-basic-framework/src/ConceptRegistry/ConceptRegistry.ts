import type { RegistrySnapshot } from '../Normalization/types';
import { closure } from '../Evaluation/unionFind';
import { writeJsonAtomic } from '../utils/fsUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

/**
 * The registry — a SKOS-shaped concept store with provenance (file format v6).
 *
 * Vocabulary follows W3C SKOS and ISO 25964 (iso-thes): each category bucket is a concept scheme,
 * each record a concept whose key is its preferred label; `labels` carry every surface form with
 * per-label provenance (SKOS-XL reading: labels as first-class resources); `definition` is
 * skos:definition; `broaderEdges` are skos:broader relations typed by the ISO 25964 broader-term
 * typology (`broaderGeneric` = BTG/is-a, `broaderPartitive` = BTP/part–whole,
 * `broaderInstantial` = BTI/named instance). Renames and the repair layer are documented
 * extensions with no SKOS equivalent.
 *
 * **The v1 reader is retained deliberately.** `test/fixtures/registry-v1.json` is the M2.5
 * behaviour-preservation reference and must stay in the pre-M3 format; it would be worthless if
 * regenerated through this migration, so `load()` accepts every historical shape (v1–v5) and
 * normalizes it in memory. Committed registries are never rewritten.
 *
 * **Candidate generation lives outside this class** as of M4. The registry keeps storage plus the
 * exact `resolve()` fast path and exposes `snapshot()`; `StringSimilarityGenerator` and friends
 * consume the snapshot. `candidates()` was removed only after the M2.5 gate proved the generator
 * reproduces it byte for byte on all 3,392 frozen pairs.
 */

// --- v1 (read-only, historical) -------------------------------------------------------------------

export interface CanonicalRecordV1 {
  aliases: string[];
  firstSeen: { doc: number; date: string };
}

export type RegistryDataV1 = Record<string, Record<string, CanonicalRecordV1>>;

// --- labels (SKOS-XL: a label is a first-class resource with provenance) --------------------------

/** How a label came to be attached to its concept. Values are frozen — they appear in committed data. */
export type LabelDecision = 'mint' | 'link' | 'merge' | 'split' | 'move' | 'migrated';

export interface LabelRecord {
  surface: string;
  /** Document that introduced it; -1 for registry-level operations with no document context. */
  docId: number;
  decision: LabelDecision;
  confidence?: number | null;
  /** Provenance snippet — the report's own "also known as" phrasing, or an authoritative page. */
  evidence?: string | null;
  /** runId of the run that added it, so a merge can be attributed after the fact. */
  addedBy?: string | null;
}

/**
 * One concept. The record key in its scheme is the concept's preferred label (skos:prefLabel);
 * `labels` holds every surface form including that one — `mint` stores the concept's own name as
 * its first label, which is load-bearing for `snapshot()` and the M2.5 gate.
 */
export interface Concept {
  labels: LabelRecord[];
  /** One-line description (skos:definition), written by the judge at mint time. Feeds embeddings (E4). */
  definition?: string | null;
  externalIds?: Record<string, string | null>;
  /** Observations per category — the input for soft category blocking later. */
  categoryCounts?: Record<string, number>;
  firstSeen: { doc: number; date: string };
}

// --- broader edges (skos:broader, typed per ISO 25964 / iso-thes) ---------------------------------

/**
 * The ISO 25964 broader-term typology, realized in RDF by iso-thes as subproperties of
 * skos:broader: `broaderGeneric` (BTG, is-a), `broaderPartitive` (BTP, part–whole),
 * `broaderInstantial` (BTI, named instance under its class — versions/releases store as BTI).
 */
export type BroaderType = 'broaderGeneric' | 'broaderPartitive' | 'broaderInstantial';

// 'ladder-binding' is legacy vocabulary: nothing writes it any more, but pre-v5 files carry it.
export type EdgeDecision = 'judge' | 'consolidator' | 'ladder-binding' | 'migrated' | 'repairer';

/**
 * One skos:broader relation (`narrower` skos:broader `broader`), same scheme. Per-edge provenance
 * mirrors `LabelRecord` — the precondition for a *local* split (one bad edge deletes without
 * unpicking a transitive merge).
 */
export interface BroaderEdge {
  /** The narrower concept. */
  narrower: string;
  /** The broader concept. */
  broader: string;
  /** ISO 25964 typing; null = untyped skos:broader (legacy edges with no finer reading recorded). */
  type?: BroaderType | null;
  /**
   * Cosine similarity between the embeddings of the two concept names, frozen at edge-creation
   * time — deliberately NOT recomputed when a later merge or rename absorbs an endpoint (that would
   * need an async hook inside synchronous registry mutations). Null on paths with no embeddings
   * client (repairer, legacy load, consolidator).
   */
  similarityScore?: number | null;
  docId: number;
  decision: EdgeDecision;
  evidence?: string | null;
  addedBy?: string | null;
}

/** Old designation → new, same referent over time. Never a label, never auto-folded. No SKOS equivalent. */
export interface RenameEdge {
  from: string;
  to: string;
  kind: 'renamed-to';
  /** ISO date the new designation takes effect, when known. */
  validFrom?: string | null;
  docId: number;
  decision: EdgeDecision;
  evidence?: string | null;
  addedBy?: string | null;
}

/**
 * A judge `defer` = provisional mint + this queue entry. The StreamingRepairer consumes the queue
 * each document, replacing the old deferred-to-the-end RegistryConsolidator sweep; decisions.jsonl
 * is never read at runtime (wiki rule 10), so the queue lives in registry state.
 */
export interface DeferredPair {
  category: string;
  mention: string;
  /** The provisional canonical the mention was minted as. */
  mintedAs: string;
  /** Candidate canonical names the judge could not decide between. */
  candidates: string[];
  docId: number;
}

/**
 * How the surviving preferred label is chosen when several concepts are folded together.
 *
 * The research note calls this out directly — the plan never said *how* the canonical is picked, so
 * it was an accident of insertion order. Now it is a recorded configuration value.
 *
 * - `first-seen` — earliest `firstSeen.doc`. The streaming default and v1's implicit behaviour.
 * - `frequency-weighted` — most labels accumulated (`vashishth2018cesi` picks the element nearest
 *   the frequency-weighted mean; label count is the registry-local proxy).
 * - `highest-degree` — `shu2026latticekg`. Needs graph degrees, which the registry does not hold,
 *   so it requires an injected `degreeOf` provider and falls back loudly without one.
 */
export type CanonicalPolicy = 'first-seen' | 'frequency-weighted' | 'highest-degree';

// --- legacy on-disk shapes (v2–v5, read-only) -----------------------------------------------------

/** The pre-v6 record dialect: `aliases`/`gloss` instead of `labels`/`definition`. Read-only. */
interface LegacyRecord {
  aliases: LabelRecord[];
  gloss?: string | null;
  externalIds?: Record<string, string | null>;
  categoryCounts?: Record<string, number>;
  firstSeen: { doc: number; date: string };
}

/** The pre-v6 edge dialect: from/to plus kind (v3/v4) or kind+relation (v5). Read-only. */
interface LegacyEdge {
  from: string;
  to: string;
  kind: string;
  relation?: 'version-of' | 'narrower-of' | 'part-of' | null;
  similarityScore?: number | null;
  docId: number;
  decision: EdgeDecision;
  evidence?: string | null;
  addedBy?: string | null;
}

export interface RegistryDataV2 {
  version: 2;
  canonicalPolicy: CanonicalPolicy;
  categories: Record<string, Record<string, LegacyRecord>>;
}

export interface RegistryDataV3 {
  version: 3;
  canonicalPolicy: CanonicalPolicy;
  categories: Record<string, Record<string, LegacyRecord>>;
  granularityEdges: Record<string, LegacyEdge[]>;
  renameEdges: Record<string, RenameEdge[]>;
  deferQueue: DeferredPair[];
}

// --- v4: repair layer (SKEIN v2 StreamingRepairer) ---------------------------------------------

/** Points at one concept, the unit the repairer's suspects and verdicts are expressed over. */
export interface ConceptRef {
  category: string;
  canonical: string;
}

/**
 * A candidate duplicate pair surfaced during streaming — the input to adjudication, not yet a
 * verdict. Spillover (pairs a document's judge budget did not reach) is this same shape, queued for
 * the next document rather than lost, which is what makes the repairer incremental instead of a
 * deferred batch sweep in disguise.
 */
export interface SuspectPair {
  a: ConceptRef;
  b: ConceptRef;
  signal: 'gloss-ann' | 'union-blocker' | 'defer' | 'coherence';
  score: number;
  docId: number;
}

/**
 * A recorded verdict on one suspect pair (or one entity, for `keep`, where `b === a`) — the
 * repairer's memo so the same pair is never re-adjudicated after a `distinct` call, and a `keep`
 * entity is not re-flagged by future noise.
 *
 * `signature` is opaque here by design: the registry stores and compares strings, never computes
 * the hash itself. It is computed by the caller (SuspectGenerator) at adjudication time over both
 * members' sorted folded surface sets plus definitions; a later call recomputes the same signature
 * over the *current* member state and compares. Its serialization dialect is FROZEN at the v5
 * vocabulary (see SuspectGenerator.signature) because these strings persist in committed
 * registries. `''` is the sentinel for "no computable signature" and must never compare equal to
 * anything, including another `''` — that comparison is the caller's job.
 */
export interface AdjudicatedEntry {
  a: ConceptRef;
  b: ConceptRef; // b === a for single-entity (coherence 'keep') entries
  signature: string;
  verdict: 'distinct' | 'rung' | 'keep';
  docId: number;
}

export interface RegistryDataV4 extends Omit<RegistryDataV3, 'version'> {
  version: 4;
  repair: {
    adjudicated: AdjudicatedEntry[];
    spillover: SuspectPair[];
    /** Highest docId the repairer has fully processed; -1 means none yet. */
    repairedThrough: number;
  };
}

/** v5 — the ladder/rank era ended: no rungs, single edge kind `broadMatch` + `relation`. */
export interface RegistryDataV5 extends Omit<RegistryDataV4, 'version'> {
  version: 5;
}

// --- v6: SKOS / iso-thes vocabulary ---------------------------------------------------------------

/**
 * v6 — the file speaks SKOS: `conceptSchemes` of concepts with `labels`/`definition`, and
 * `broaderEdges` typed by the ISO 25964 broader-term typology. Same information as v5 under
 * standard names; `renameEdges`, `deferQueue` and `repair` are unchanged extensions.
 */
export interface RegistryDataV6 {
  version: 6;
  canonicalPolicy: CanonicalPolicy;
  conceptSchemes: Record<string, Record<string, Concept>>;
  /** scheme → skos:broader edges (narrower → broader, same scheme). */
  broaderEdges: Record<string, BroaderEdge[]>;
  renameEdges: Record<string, RenameEdge[]>;
  deferQueue: DeferredPair[];
  repair: RegistryDataV4['repair'];
}

/** A fresh, unaliased default — every pre-v4 load and every constructed registry gets its own. */
function emptyRepair(): RegistryDataV4['repair'] {
  return { adjudicated: [], spillover: [], repairedThrough: -1 };
}

/**
 * Pre-v5 normalization (operates on the legacy dialect): drop the ladder-era `rung` from records;
 * fold legacy edge kinds into one (`part-of` backfills `relation: 'part-of'` so its reading
 * survives the fold); default `similarityScore` to null — legacy edges predate
 * embeddings-at-edge-time.
 */
function normalizePreV5(
  categories: Record<string, Record<string, LegacyRecord>>,
  granularityEdges: Record<string, LegacyEdge[]>
): void {
  for (const records of Object.values(categories)) {
    for (const record of Object.values(records)) {
      delete (record as { rung?: unknown }).rung;
    }
  }
  for (const [category, edges] of Object.entries(granularityEdges)) {
    if (!Array.isArray(edges)) {
      // Malformed layer (seen in defensive tests): drop rather than crash a whole-file load.
      delete granularityEdges[category];
      continue;
    }
    const seen = new Set<string>();
    granularityEdges[category] = edges.flatMap((edge) => {
      const key = `${edge.from}|${edge.to}`;
      if (seen.has(key)) return []; // kinds collapsed — (from, to, kind) dupes become (from, to) dupes
      seen.add(key);
      return [
        {
          ...edge,
          relation: edge.relation ?? (edge.kind === 'part-of' ? ('part-of' as const) : null),
          similarityScore: edge.similarityScore ?? null,
        },
      ];
    });
  }
}

/** The v5 `relation` → ISO 25964 `type` value map. Shared with journal replay (replayCore). */
export function broaderTypeOfLegacyRelation(
  relation: string | null | undefined
): BroaderType | null {
  if (relation === 'version-of') return 'broaderInstantial';
  if (relation === 'narrower-of') return 'broaderGeneric';
  if (relation === 'part-of') return 'broaderPartitive';
  return null;
}

/** Lift the legacy (v2–v5) dialect into the v6 vocabulary. */
function liftToV6(
  categories: Record<string, Record<string, LegacyRecord>>,
  granularityEdges: Record<string, LegacyEdge[]>
): {
  conceptSchemes: Record<string, Record<string, Concept>>;
  broaderEdges: Record<string, BroaderEdge[]>;
} {
  const conceptSchemes: Record<string, Record<string, Concept>> = {};
  for (const [category, records] of Object.entries(categories)) {
    conceptSchemes[category] = {};
    for (const [canonical, record] of Object.entries(records ?? {})) {
      const { aliases, gloss, ...rest } = record;
      conceptSchemes[category][canonical] = {
        ...rest,
        labels: aliases ?? [],
        definition: gloss ?? null,
      };
    }
  }

  const broaderEdges: Record<string, BroaderEdge[]> = {};
  for (const [category, edges] of Object.entries(granularityEdges)) {
    if (!Array.isArray(edges)) continue;
    broaderEdges[category] = edges.map((edge) => ({
      narrower: edge.from,
      broader: edge.to,
      type: broaderTypeOfLegacyRelation(edge.relation),
      similarityScore: edge.similarityScore ?? null,
      docId: edge.docId,
      decision: edge.decision,
      evidence: edge.evidence ?? null,
      addedBy: edge.addedBy ?? null,
    }));
  }

  return { conceptSchemes, broaderEdges };
}

export interface MergeOp {
  from: string;
  into: string;
  evidence?: string | null;
  confidence?: number | null;
}

export interface RepairSummary {
  /** Groups that were folded, as the member lists after closure. */
  groups: string[][];
  /** Canonical that survived each group, in the same order. */
  survivors: string[];
  /** Canonicals removed. */
  removed: string[];
}

interface Params {
  filePath: string;
  canonicalPolicy?: CanonicalPolicy;
  /** Stamped into label provenance so a merge is attributable to a run. */
  runId?: string;
  /** Required only by the `highest-degree` policy. */
  degreeOf?: (category: string, canonical: string) => number;
}

const DEFAULT_POLICY: CanonicalPolicy = 'first-seen';

export class ConceptRegistry {
  public readonly filePath: string;
  public canonicalPolicy: CanonicalPolicy;

  #conceptSchemes: Record<string, Record<string, Concept>> = {};
  #broaderEdges: Record<string, BroaderEdge[]> = {};
  #renameEdges: Record<string, RenameEdge[]> = {};
  #deferQueue: DeferredPair[] = [];
  #repair: RegistryDataV4['repair'] = emptyRepair();
  #labelIndex = new Map<string, Map<string, string>>(); // scheme → lowercased surface → canonical
  /** scheme → concept → outgoing broader edges. Lazily built; dropped on any edge mutation. */
  #parentIndex = new Map<string, Map<string, BroaderEdge[]>>();
  #loaded = false;
  #dirty = false;
  #runId?: string;
  #degreeOf?: (category: string, canonical: string) => number;
  /** True when the file on disk was v1, so `save()` can report a format upgrade. */
  #loadedFromV1 = false;

  constructor(params: Params) {
    this.filePath = params.filePath;
    this.canonicalPolicy = params.canonicalPolicy ?? DEFAULT_POLICY;
    this.#runId = params.runId;
    this.#degreeOf = params.degreeOf;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get loadedFromV1(): boolean {
    return this.#loadedFromV1;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;

    if (existsSync(this.filePath)) {
      const content = await fs.readFile(this.filePath);
      const parsed = JSON.parse(content.toString());
      const { conceptSchemes, policy, wasV1, broaderEdges, renameEdges, deferQueue, repair } =
        ConceptRegistry.parse(parsed);
      this.#conceptSchemes = conceptSchemes;
      this.#broaderEdges = broaderEdges;
      this.#renameEdges = renameEdges;
      this.#deferQueue = deferQueue;
      this.#repair = repair;
      this.#loadedFromV1 = wasV1;
      this.#parentIndex.clear();
      // An explicit constructor policy wins; otherwise adopt whatever the file recorded.
      if (policy && this.canonicalPolicy === DEFAULT_POLICY) this.canonicalPolicy = policy;
    }

    this.#rebuildIndex();
    // Adjudicated entries name canonicals literally; a repair absorbed since the entry was written
    // (merge/renameInto/split from a previous run) leaves it stale. Prune on load as well as lazily
    // on findAdjudicated, so a reload never carries dead-canonical verdicts forward silently.
    this.#pruneAdjudicated();
    this.#loaded = true;
  }

  /** Normalises any on-disk shape (v1–v6) into v6 state. Exported for the migrator, evaluation and tests. */
  static parse(parsed: unknown): {
    conceptSchemes: Record<string, Record<string, Concept>>;
    policy?: CanonicalPolicy;
    wasV1: boolean;
    broaderEdges: Record<string, BroaderEdge[]>;
    renameEdges: Record<string, RenameEdge[]>;
    deferQueue: DeferredPair[];
    repair: RegistryDataV4['repair'];
  } {
    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV6).version === 6) {
      const v6 = parsed as RegistryDataV6;
      return {
        conceptSchemes: v6.conceptSchemes ?? {},
        policy: v6.canonicalPolicy,
        wasV1: false,
        broaderEdges: v6.broaderEdges ?? {},
        renameEdges: v6.renameEdges ?? {},
        deferQueue: v6.deferQueue ?? [],
        repair: v6.repair ?? emptyRepair(),
      };
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV5).version === 5) {
      const v5 = parsed as RegistryDataV5;
      return {
        ...liftToV6(v5.categories ?? {}, v5.granularityEdges ?? {}),
        policy: v5.canonicalPolicy,
        wasV1: false,
        renameEdges: v5.renameEdges ?? {},
        deferQueue: v5.deferQueue ?? [],
        repair: v5.repair ?? emptyRepair(),
      };
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV4).version === 4) {
      const v4 = parsed as RegistryDataV4;
      const categories = v4.categories ?? {};
      const granularityEdges = v4.granularityEdges ?? {};
      normalizePreV5(categories, granularityEdges);
      return {
        ...liftToV6(categories, granularityEdges),
        policy: v4.canonicalPolicy,
        wasV1: false,
        renameEdges: v4.renameEdges ?? {},
        deferQueue: v4.deferQueue ?? [],
        repair: v4.repair ?? emptyRepair(),
      };
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV3).version === 3) {
      const v3 = parsed as RegistryDataV3;
      const categories = v3.categories ?? {};
      const granularityEdges = v3.granularityEdges ?? {};
      normalizePreV5(categories, granularityEdges);
      return {
        ...liftToV6(categories, granularityEdges),
        policy: v3.canonicalPolicy,
        wasV1: false,
        renameEdges: v3.renameEdges ?? {},
        deferQueue: v3.deferQueue ?? [],
        repair: emptyRepair(),
      };
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV2).version === 2) {
      const v2 = parsed as RegistryDataV2;
      return {
        ...liftToV6(v2.categories ?? {}, {}),
        policy: v2.canonicalPolicy,
        wasV1: false,
        renameEdges: {},
        deferQueue: [],
        repair: emptyRepair(),
      };
    }

    // v1: category → canonical → { aliases: string[], firstSeen }
    const v1 = (parsed ?? {}) as RegistryDataV1;
    const conceptSchemes: Record<string, Record<string, Concept>> = {};
    for (const [category, records] of Object.entries(v1)) {
      conceptSchemes[category] = {};
      for (const [canonical, record] of Object.entries(records ?? {})) {
        conceptSchemes[category][canonical] = {
          labels: (record?.aliases ?? []).map((surface) => ({
            surface,
            // v1 recorded no per-label provenance. `firstSeen.doc` is the only document context
            // available, and inventing anything finer would fabricate provenance.
            docId: record.firstSeen?.doc ?? -1,
            decision: 'migrated' as const,
          })),
          categoryCounts: { [category]: (record?.aliases ?? []).length },
          firstSeen: record?.firstSeen ?? { doc: -1, date: '' },
        };
      }
    }
    return {
      conceptSchemes,
      wasV1: true,
      broaderEdges: {},
      renameEdges: {},
      deferQueue: [],
      repair: emptyRepair(),
    };
  }

  /** The v6 document as written to disk. */
  toJSON(): RegistryDataV6 {
    return {
      version: 6,
      canonicalPolicy: this.canonicalPolicy,
      conceptSchemes: this.#conceptSchemes,
      broaderEdges: this.#broaderEdges,
      renameEdges: this.#renameEdges,
      deferQueue: this.#deferQueue,
      repair: this.#repair,
    };
  }

  /**
   * Project back to the v1 shape.
   *
   * Only for comparing against pre-M3 artifacts — chiefly the M2.5 fixture, which must remain in
   * its historical format. The OUTPUT dialect (`aliases` of plain strings) is frozen regardless of
   * internal vocabulary: the gate and `capture-golden` depend on byte identity of the regenerated
   * fixture. Lossy by definition: provenance, definition, externalIds and categoryCounts have no
   * v1 representation.
   */
  toV1(): RegistryDataV1 {
    const out: RegistryDataV1 = {};
    for (const [category, records] of Object.entries(this.#conceptSchemes)) {
      out[category] = {};
      for (const [canonical, record] of Object.entries(records)) {
        out[category][canonical] = {
          aliases: record.labels.map((label) => label.surface),
          firstSeen: record.firstSeen,
        };
      }
    }
    return out;
  }

  async save(): Promise<void> {
    if (!this.#dirty) return;
    await writeJsonAtomic(this.filePath, this.toJSON());
    this.#dirty = false;
  }

  // --- reads ------------------------------------------------------------------------------------

  /** Exact fast path (spec §4.2 step 1). */
  resolve(category: string, name: string): string | undefined {
    return this.#labelIndex.get(category)?.get(name.trim().toLowerCase());
  }

  /** The scheme ids — one concept scheme per category. */
  conceptSchemes(): string[] {
    return Object.keys(this.#conceptSchemes);
  }

  /** The concepts of one scheme, keyed by preferred label. */
  concepts(category: string): Record<string, Concept> {
    return this.#conceptSchemes[category] || {};
  }

  /** Label surfaces for one concept — for callers that want plain strings. */
  labelSurfaces(category: string, canonical: string): string[] {
    return (this.#conceptSchemes[category]?.[canonical]?.labels ?? []).map((label) => label.surface);
  }

  /**
   * The stored surface a lookup of `name` actually hits, in its stored casing — what artifacts
   * stamp as `matchedVia`. Falls back to the concept's own name (which the fast path also
   * matches, since mint stores it as its own label).
   */
  matchedSurface(category: string, name: string): string | undefined {
    const canonical = this.resolve(category, name);
    if (!canonical) return undefined;
    const folded = name.trim().toLowerCase();
    if (canonical.toLowerCase() === folded) return canonical;
    return (
      this.#conceptSchemes[category]?.[canonical]?.labels.find(
        (label) => label.surface.trim().toLowerCase() === folded
      )?.surface ?? canonical
    );
  }

  /**
   * Read-only view for candidate generators (M4).
   *
   * **Live, not a frozen copy.** The streaming registry mutates after every document, so a copy
   * taken once at `prepare()` would be stale by the second document. Generators that maintain an
   * index therefore rely on `onRegistryChange` for invalidation rather than on immutability here.
   *
   * `surfaces` is `[canonical, ...labelSurfaces]` — the canonical usually appears twice, because
   * `mint` stores it in its own label list. Harmless (scoring takes a max) and preserved verbatim,
   * because the M2.5 golden lists were captured against exactly this array.
   */
  snapshot(): RegistrySnapshot {
    const conceptSchemes = this.#conceptSchemes;
    return {
      categories: () => Object.keys(conceptSchemes),
      size: (category: string) => Object.keys(conceptSchemes[category] ?? {}).length,
      entries: (category: string) =>
        Object.entries(conceptSchemes[category] ?? {}).map(([canonical, record]) => ({
          canonical,
          surfaces: [canonical, ...record.labels.map((label) => label.surface)],
          definition: record.definition ?? null,
          categoryCounts: record.categoryCounts,
        })),
    };
  }

  labelToCanonicalMap(category: string): Map<string, string> {
    return new Map(this.#schemeIndex(category));
  }

  // --- writes -----------------------------------------------------------------------------------

  link(
    category: string,
    canonicalName: string,
    alias: string,
    provenance: { docId?: number; confidence?: number | null; evidence?: string | null } = {}
  ): void {
    const record = this.#conceptSchemes[category]?.[canonicalName];
    if (!record) {
      console.warn(`ConceptRegistry: cannot link "${alias}" to unknown ${category}/"${canonicalName}"`);
      return;
    }

    const labelKey = alias.trim().toLowerCase();
    if (this.#labelIndex.get(category)?.has(labelKey)) return; // idempotent

    record.labels.push({
      surface: alias.trim(),
      docId: provenance.docId ?? -1,
      decision: 'link',
      confidence: provenance.confidence ?? null,
      evidence: provenance.evidence ?? null,
      addedBy: this.#runId ?? null,
    });
    this.#bumpCategoryCount(record, category);
    this.#schemeIndex(category).set(labelKey, canonicalName);
    this.#dirty = true;
  }

  mint(
    category: string,
    name: string,
    firstSeen: { doc: number; date: string },
    extras: { definition?: string | null; externalIds?: Record<string, string | null> } = {}
  ): string {
    const existing = this.resolve(category, name);
    if (existing) return existing; // resolve-first guard (crash-retry safe)

    const canonical = name.trim();
    if (!this.#conceptSchemes[category]) this.#conceptSchemes[category] = {};
    this.#conceptSchemes[category][canonical] = {
      labels: [
        {
          surface: canonical,
          docId: firstSeen.doc,
          decision: 'mint',
          addedBy: this.#runId ?? null,
        },
      ],
      definition: extras.definition ?? null,
      externalIds: extras.externalIds ?? {},
      categoryCounts: { [category]: 1 },
      firstSeen,
    };
    this.#schemeIndex(category).set(canonical.toLowerCase(), canonical);
    this.#dirty = true;
    return canonical;
  }

  setDefinition(category: string, canonical: string, definition: string | null): void {
    const record = this.#conceptSchemes[category]?.[canonical];
    if (!record) return;
    record.definition = definition;
    this.#dirty = true;
  }

  setExternalId(category: string, canonical: string, source: string, id: string | null): void {
    const record = this.#conceptSchemes[category]?.[canonical];
    if (!record) return;
    record.externalIds = { ...(record.externalIds ?? {}), [source]: id };
    this.#dirty = true;
  }

  // --- broader edges (skos:broader) ---------------------------------------------------------------

  /**
   * Adds a `narrower` skos:broader `broader` edge. Rejects (returns false, warns) when an endpoint
   * is unknown, the edge is a self-loop, or it would close a cycle — acyclicity is checked on every
   * write. Idempotent on (narrower, broader).
   */
  addBroaderEdge(
    category: string,
    edge: {
      narrower: string;
      broader: string;
      type?: BroaderType | null;
      similarityScore?: number | null;
      docId: number;
      decision: EdgeDecision;
      evidence?: string | null;
    }
  ): boolean {
    const records = this.#conceptSchemes[category];
    if (!records?.[edge.narrower] || !records?.[edge.broader]) {
      console.warn(
        `ConceptRegistry: broader edge needs existing endpoints — ${category}/"${edge.narrower}" -> "${edge.broader}"`
      );
      return false;
    }
    if (edge.narrower === edge.broader) {
      console.warn(`ConceptRegistry: refusing broader self-loop on ${category}/"${edge.narrower}"`);
      return false;
    }

    const edges = (this.#broaderEdges[category] ??= []);
    if (edges.some((e) => e.narrower === edge.narrower && e.broader === edge.broader)) {
      return true; // idempotent
    }
    if (this.#reaches(category, edge.broader, edge.narrower)) {
      console.warn(
        `ConceptRegistry: broader edge ${category}/"${edge.narrower}" -> "${edge.broader}" would close a cycle — rejected`
      );
      return false;
    }

    edges.push({
      narrower: edge.narrower,
      broader: edge.broader,
      type: edge.type ?? null,
      similarityScore: edge.similarityScore ?? null,
      docId: edge.docId,
      decision: edge.decision,
      evidence: edge.evidence ?? null,
      addedBy: this.#runId ?? null,
    });
    this.#parentIndex.delete(category);
    this.#dirty = true;
    return true;
  }

  broaderEdges(category: string): BroaderEdge[] {
    return this.#broaderEdges[category] ?? [];
  }

  /** Edge deletion — the local repair per-edge provenance exists for. */
  removeBroaderEdge(category: string, narrower: string, broader: string): boolean {
    const edges = this.#broaderEdges[category];
    if (!edges) return false;
    const next = edges.filter((e) => !(e.narrower === narrower && e.broader === broader));
    if (next.length === edges.length) return false;
    this.#broaderEdges[category] = next;
    this.#parentIndex.delete(category);
    this.#dirty = true;
    return true;
  }

  /** Outgoing (narrower → broader) edges of one concept. */
  broaderOf(category: string, canonical: string): BroaderEdge[] {
    return this.#parentsFor(category).get(canonical) ?? [];
  }

  /**
   * The roll-up target for OLAP-style aggregation: walk narrower → broader along skos:broader
   * edges, following the highest-`similarityScore` parent at each hop (a roll-up must be a
   * function; the closest-by-cosine generalization is the least lossy one).
   *
   * `threshold` is the semantic brake that keeps "Microsoft Office" from rolling up into
   * "Microsoft Products": the walk stops BEFORE traversing an edge whose `similarityScore` is null
   * or below it. Default 0.85; pass `null` for no brake (null-score edges are then followed —
   * the fold CLI's "fold everything" mode). `contract` restricts the walk to edges of the given
   * ISO 25964 types (untyped edges never match a contract). O(1) per hop via the lazily built
   * per-scheme parent index.
   */
  rollupTarget(
    category: string,
    canonical: string,
    options: {
      threshold?: number | null;
      contract?: BroaderType[] | null;
      /**
       * Similarity override for state-aware rescoring (e.g. max over current label pairs instead
       * of the frozen edge-creation score). Defaults to the stored `similarityScore`. Both parent
       * choice and the threshold brake use it.
       */
      score?: (edge: BroaderEdge) => number | null;
    } = {}
  ): string {
    const threshold = options.threshold === undefined ? 0.85 : options.threshold;
    const contract = options.contract ?? null;
    const score = options.score ?? ((edge: BroaderEdge) => edge.similarityScore ?? null);
    const parents = this.#parentsFor(category);
    const seen = new Set<string>([canonical]);
    let current = canonical;
    for (;;) {
      let candidates = parents.get(current) ?? [];
      if (contract) {
        candidates = candidates.filter((e) => e.type != null && contract.includes(e.type));
      }
      const best = pickRollupEdge(candidates, score);
      if (!best) return current;
      const bestScore = score(best);
      if (threshold != null && (bestScore == null || bestScore < threshold)) {
        return current;
      }
      if (seen.has(best.broader)) return current; // defensive: writes reject cycles already
      seen.add(best.broader);
      current = best.broader;
    }
  }

  addRenameEdge(
    category: string,
    edge: {
      from: string;
      to: string;
      docId: number;
      decision: EdgeDecision;
      validFrom?: string | null;
      evidence?: string | null;
    }
  ): boolean {
    const records = this.#conceptSchemes[category];
    if (!records?.[edge.from] || !records?.[edge.to] || edge.from === edge.to) {
      console.warn(
        `ConceptRegistry: invalid rename edge ${category}/"${edge.from}" -> "${edge.to}"`
      );
      return false;
    }
    const edges = (this.#renameEdges[category] ??= []);
    if (edges.some((e) => e.from === edge.from && e.to === edge.to)) return true;
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: 'renamed-to',
      validFrom: edge.validFrom ?? null,
      docId: edge.docId,
      decision: edge.decision,
      evidence: edge.evidence ?? null,
      addedBy: this.#runId ?? null,
    });
    this.#dirty = true;
    return true;
  }

  renameEdges(category: string): RenameEdge[] {
    return this.#renameEdges[category] ?? [];
  }

  /** Queues a judge `defer` for the StreamingRepairer. Idempotent on (category, mention, docId). */
  pushDeferred(entry: DeferredPair): void {
    const key = (d: DeferredPair) => `${d.category}|${d.mention.trim().toLowerCase()}|${d.docId}`;
    if (this.#deferQueue.some((d) => key(d) === key(entry))) return;
    this.#deferQueue.push(entry);
    this.#dirty = true;
  }

  deferred(): DeferredPair[] {
    return [...this.#deferQueue];
  }

  /** The StreamingRepairer calls this after reviewing a document's queue; entries not passed stay queued. */
  clearDeferred(consumed: DeferredPair[]): void {
    const key = (d: DeferredPair) => `${d.category}|${d.mention.trim().toLowerCase()}|${d.docId}`;
    const gone = new Set(consumed.map(key));
    const next = this.#deferQueue.filter((d) => !gone.has(key(d)));
    if (next.length !== this.#deferQueue.length) {
      this.#deferQueue = next;
      this.#dirty = true;
    }
  }

  // --- repair state (v4+) ------------------------------------------------------------------------

  /**
   * A copy of the StreamingRepairer's working memory. Copied (not live) so a caller mutating the
   * returned arrays cannot corrupt registry state behind `#dirty`'s back — every other write here
   * goes through a method that sets it.
   */
  repairState(): { adjudicated: AdjudicatedEntry[]; spillover: SuspectPair[]; repairedThrough: number } {
    return {
      adjudicated: [...this.#repair.adjudicated],
      spillover: [...this.#repair.spillover],
      repairedThrough: this.#repair.repairedThrough,
    };
  }

  /** High-water mark: the StreamingRepairer has fully processed every document up to and including this one. */
  setRepairedThrough(doc: number): void {
    this.#repair.repairedThrough = doc;
    this.#dirty = true;
  }

  /** Suspects a document's judge budget did not reach — carried forward instead of dropped. */
  pushSpillover(pairs: SuspectPair[]): void {
    if (pairs.length === 0) return;
    this.#repair.spillover.push(...pairs);
    this.#dirty = true;
  }

  /** Empties and returns the spillover queue — a drain, not a peek, so the next document starts clean. */
  drainSpillover(): SuspectPair[] {
    const drained = this.#repair.spillover;
    this.#repair.spillover = [];
    if (drained.length > 0) this.#dirty = true;
    return drained;
  }

  /** Records a verdict so the pair (or entity, for `keep`) is not re-adjudicated. */
  pushAdjudicated(entry: AdjudicatedEntry): void {
    this.#repair.adjudicated.push(entry);
    this.#dirty = true;
  }

  /** Unordered lookup: `(a, b)` and `(b, a)` are the same suspect pair. */
  findAdjudicated(a: ConceptRef, b: ConceptRef): AdjudicatedEntry | undefined {
    this.#pruneAdjudicated();
    const sameRef = (x: ConceptRef, y: ConceptRef) => x.category === y.category && x.canonical === y.canonical;
    return this.#repair.adjudicated.find(
      (entry) => (sameRef(entry.a, a) && sameRef(entry.b, b)) || (sameRef(entry.a, b) && sameRef(entry.b, a))
    );
  }

  // --- repair operators -------------------------------------------------------------------------

  /**
   * Fold merge pairs into their transitive closure, then keep one canonical per group.
   *
   * v1 applied `from→into` sequentially behind a `records[from] && records[into]` guard, which meant
   * `[{A→B},{B→C}]` succeeded while `[{B→C},{A→B}]` silently dropped `A→B` — B no longer existed by
   * the time it was applied. Order-dependence is worse than plain breakage: the same merge set
   * produced different registries run to run, with no error. Closure is order-independent by
   * construction, which is the point.
   *
   * Which canonical survives is now decided by `canonicalPolicy`, not by the caller's `into`. Under
   * closure `into` is ambiguous anyway (three-way groups have no single target), so the requested
   * target is recorded in label provenance rather than obeyed.
   */
  applyMerges(category: string, merges: MergeOp[]): RepairSummary {
    const records = this.#conceptSchemes[category];
    const summary: RepairSummary = { groups: [], survivors: [], removed: [] };
    if (!records) return summary;

    const pairs: Array<[string, string]> = [];
    const evidenceByPair = new Map<string, MergeOp>();
    for (const merge of merges) {
      if (merge.from === merge.into) continue;
      if (!records[merge.from] || !records[merge.into]) continue;
      pairs.push([merge.from, merge.into]);
      evidenceByPair.set(`${merge.from} ${merge.into}`, merge);
    }
    if (pairs.length === 0) return summary;

    for (const group of closure(pairs)) {
      if (group.length < 2) continue;
      const survivor = this.#chooseCanonical(category, group);
      const target = records[survivor];

      for (const member of group) {
        if (member === survivor) continue;
        const source = records[member];
        if (!source) continue;

        // The concept's own name becomes a label of the survivor, with its provenance kept.
        const incoming: LabelRecord[] = source.labels.map((label) => ({
          ...label,
          decision: 'merge' as const,
          addedBy: this.#runId ?? label.addedBy ?? null,
        }));
        for (const label of incoming) {
          if (!target.labels.some((existing) => existing.surface === label.surface)) {
            const op =
              evidenceByPair.get(`${member} ${survivor}`) ??
              evidenceByPair.get(`${survivor} ${member}`);
            target.labels.push({
              ...label,
              evidence: label.evidence ?? op?.evidence ?? null,
              confidence: label.confidence ?? op?.confidence ?? null,
            });
          }
        }

        // Keep the earliest firstSeen and accumulate category counts and external ids.
        if (source.firstSeen.doc >= 0 && (target.firstSeen.doc < 0 || source.firstSeen.doc < target.firstSeen.doc)) {
          target.firstSeen = source.firstSeen;
        }
        target.categoryCounts = mergeCounts(target.categoryCounts, source.categoryCounts);
        target.externalIds = { ...(source.externalIds ?? {}), ...(target.externalIds ?? {}) };
        if (!target.definition && source.definition) target.definition = source.definition;

        delete records[member];
        summary.removed.push(member);
      }

      summary.groups.push(group);
      summary.survivors.push(survivor);
      this.#dirty = true;
    }

    const survivorOf = new Map<string, string>();
    summary.groups.forEach((group, index) => {
      for (const member of group) {
        if (member !== summary.survivors[index]) survivorOf.set(member, summary.survivors[index]);
      }
    });
    this.#rewriteAfterMerge(category, survivorOf);

    this.#rebuildIndex();
    return summary;
  }

  /**
   * Split labels off a concept into a new one — edge removal, the operator v1 lacked entirely.
   *
   * Deterministic: the detached surfaces are matched case-insensitively, the new canonical is chosen
   * from them by `canonicalPolicy`'s tie-break (lexicographically lowest for a fresh group, since a
   * detached set has no independent `firstSeen`), and the label order of both records is preserved.
   * Artifacts are re-stamped separately by the consolidator via `labelToCanonicalMap`.
   */
  split(
    category: string,
    canonical: string,
    detach: string[],
    provenance: { docId?: number; evidence?: string | null } = {}
  ): { newCanonical: string; moved: string[] } | null {
    const records = this.#conceptSchemes[category];
    const record = records?.[canonical];
    if (!record) {
      console.warn(`ConceptRegistry: cannot split unknown ${category}/"${canonical}"`);
      return null;
    }

    const wanted = new Set(detach.map((surface) => surface.trim().toLowerCase()));
    const moving = record.labels.filter((label) => wanted.has(label.surface.trim().toLowerCase()));
    const staying = record.labels.filter((label) => !wanted.has(label.surface.trim().toLowerCase()));

    if (moving.length === 0) return null;
    if (staying.length === 0) {
      // Detaching everything would leave an empty concept; that is a rename, not a split.
      console.warn(`ConceptRegistry: refusing to split all labels off ${category}/"${canonical}"`);
      return null;
    }

    // Deterministic name for the new canonical: lowest surface in code-unit order.
    const newCanonical = [...moving.map((label) => label.surface)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    )[0];
    if (records[newCanonical] && newCanonical !== canonical) {
      console.warn(`ConceptRegistry: split target ${category}/"${newCanonical}" already exists`);
      return null;
    }

    record.labels = staying;
    records[newCanonical] = {
      labels: moving.map((label) => ({
        ...label,
        decision: 'split' as const,
        evidence: provenance.evidence ?? label.evidence ?? null,
        addedBy: this.#runId ?? null,
      })),
      definition: null,
      externalIds: {},
      categoryCounts: { [category]: moving.length },
      firstSeen: {
        doc: provenance.docId ?? record.firstSeen.doc,
        date: record.firstSeen.date,
      },
    };

    this.#dirty = true;
    this.#rebuildIndex();
    return { newCanonical, moved: moving.map((label) => label.surface) };
  }

  /**
   * Move one concept between schemes — standalone, which v1 could only do as a side effect of
   * a whole-category merge.
   */
  move(fromCategory: string, canonical: string, toCategory: string): boolean {
    if (fromCategory === toCategory) return false;
    const source = this.#conceptSchemes[fromCategory]?.[canonical];
    if (!source) {
      console.warn(`ConceptRegistry: cannot move unknown ${fromCategory}/"${canonical}"`);
      return false;
    }

    if (!this.#conceptSchemes[toCategory]) this.#conceptSchemes[toCategory] = {};
    const target = this.#conceptSchemes[toCategory][canonical];

    const moved: Concept = {
      ...source,
      labels: source.labels.map((label) => ({
        ...label,
        decision: 'move' as const,
        addedBy: this.#runId ?? label.addedBy ?? null,
      })),
      categoryCounts: mergeCounts(source.categoryCounts, { [toCategory]: 1 }),
    };

    if (target) {
      for (const label of moved.labels) {
        if (!target.labels.some((existing) => existing.surface === label.surface)) {
          target.labels.push(label);
        }
      }
      if (source.firstSeen.doc >= 0 && (target.firstSeen.doc < 0 || source.firstSeen.doc < target.firstSeen.doc)) {
        target.firstSeen = source.firstSeen;
      }
      target.categoryCounts = mergeCounts(target.categoryCounts, moved.categoryCounts);
      target.externalIds = { ...(moved.externalIds ?? {}), ...(target.externalIds ?? {}) };
      if (!target.definition && moved.definition) target.definition = moved.definition;
    } else {
      this.#conceptSchemes[toCategory][canonical] = moved;
    }

    delete this.#conceptSchemes[fromCategory][canonical];
    if (Object.keys(this.#conceptSchemes[fromCategory]).length === 0) delete this.#conceptSchemes[fromCategory];

    // Broader/rename edges are same-scheme by construction; a concept moving out orphans its
    // edges. They are dropped loudly — a cross-scheme edge would be a type error as data.
    const dropped = (this.#broaderEdges[fromCategory] ?? []).filter(
      (edge) => edge.narrower === canonical || edge.broader === canonical
    );
    if (dropped.length > 0) {
      console.warn(
        `ConceptRegistry: dropping ${dropped.length} broader edge(s) touching moved ${fromCategory}/"${canonical}"`
      );
      this.#broaderEdges[fromCategory] = (this.#broaderEdges[fromCategory] ?? []).filter(
        (edge) => edge.narrower !== canonical && edge.broader !== canonical
      );
      this.#parentIndex.delete(fromCategory);
    }
    if (this.#renameEdges[fromCategory]?.some((edge) => edge.from === canonical || edge.to === canonical)) {
      this.#renameEdges[fromCategory] = this.#renameEdges[fromCategory].filter(
        (edge) => edge.from !== canonical && edge.to !== canonical
      );
    }

    this.#dirty = true;
    this.#rebuildIndex();
    return true;
  }

  /**
   * Reattach one label record to a different concept — `move()` above relocates a whole concept,
   * but the StreamingRepairer's most common correction is finer-grained: one surface form was
   * linked under the wrong concept, and the fix is to move *it*, not everything the wrong concept
   * has accumulated since. Works across schemes, since a mis-linked label can land in the wrong
   * bucket entirely (e.g. an org name linked under Software).
   *
   * Refuses to detach a concept's own name: `mint` always stores the concept's name as its first
   * label, so that surface *is* the record's identity, not an attachable label — letting it walk
   * away would leave a concept unable to match itself.
   */
  moveLabel(
    from: ConceptRef,
    to: ConceptRef,
    alias: string,
    provenance: { docId: number; evidence?: string | null }
  ): boolean {
    const fromRecord = this.#conceptSchemes[from.category]?.[from.canonical];
    const toRecord = this.#conceptSchemes[to.category]?.[to.canonical];
    if (!fromRecord || !toRecord) {
      console.warn(
        `ConceptRegistry: moveLabel needs existing endpoints — ${from.category}/"${from.canonical}" -> ${to.category}/"${to.canonical}"`
      );
      return false;
    }

    const key = alias.trim().toLowerCase();
    if (key === from.canonical.trim().toLowerCase()) {
      console.warn(
        `ConceptRegistry: refusing to detach ${from.category}/"${from.canonical}"'s own concept name via moveLabel`
      );
      return false;
    }

    const index = fromRecord.labels.findIndex((l) => l.surface.trim().toLowerCase() === key);
    if (index === -1) {
      console.warn(`ConceptRegistry: moveLabel found no "${alias}" on ${from.category}/"${from.canonical}"`);
      return false;
    }

    const [source] = fromRecord.labels.splice(index, 1);
    const moved: LabelRecord = {
      ...source,
      docId: provenance.docId,
      decision: 'move',
      evidence: provenance.evidence ?? source.evidence ?? null,
      addedBy: this.#runId ?? source.addedBy ?? null,
    };
    if (!toRecord.labels.some((existing) => existing.surface === moved.surface)) {
      toRecord.labels.push(moved);
    }

    this.#dirty = true;
    this.#rebuildIndex();
    return true;
  }

  /**
   * Absorb `from` into `to` as a rename, not a merge: the survivor is always `to` — the caller's
   * chosen direction, never `canonicalPolicy`'s — because a rename records which name is *current*,
   * a fact the policy (first-seen / frequency / degree) has no opinion on and must not overrule.
   *
   * The `renamed-to` edge is recorded FIRST, before absorption, because `addRenameEdge` requires
   * both endpoints to still be live records — the guard that exists specifically so a rename edge
   * can never name something that was never real. Absorption then reuses `applyMerges`' member-fold
   * steps (label union, earliest firstSeen, merged counts/ids/definition) with the survivor fixed
   * to `to`.
   *
   * A rename is history, not topology: `#rewriteAfterMerge` (below) deliberately never touches
   * rename edges, so this edge's endpoints stay `from → to` literally, forever — even once neither
   * name is a live concept any more. Rewriting them to whatever eventually survives would erase
   * the very fact the edge exists to record (dissertation wiki rule 5: edge layers stay separated;
   * user ruling 2026-08-05: renames are a historical layer, never rewritten nor self-loop-dropped).
   */
  renameInto(
    category: string,
    op: { from: string; to: string; docId: number; evidence?: string | null; validFrom?: string | null }
  ): boolean {
    const records = this.#conceptSchemes[category];
    if (!records?.[op.from] || !records?.[op.to] || op.from === op.to) {
      console.warn(`ConceptRegistry: renameInto needs existing distinct endpoints — ${category}/"${op.from}" -> "${op.to}"`);
      return false;
    }

    this.addRenameEdge(category, {
      from: op.from,
      to: op.to,
      docId: op.docId,
      decision: 'repairer',
      evidence: op.evidence ?? null,
      validFrom: op.validFrom ?? null,
    });

    const source = records[op.from];
    const target = records[op.to];

    // Same absorption steps as applyMerges' member loop — see its doc comment — but the survivor is
    // fixed to `to` rather than chosen by canonicalPolicy.
    const incoming: LabelRecord[] = source.labels.map((l) => ({
      ...l,
      decision: 'merge' as const,
      addedBy: this.#runId ?? l.addedBy ?? null,
    }));
    for (const labelRecord of incoming) {
      if (!target.labels.some((existing) => existing.surface === labelRecord.surface)) {
        target.labels.push({ ...labelRecord, evidence: labelRecord.evidence ?? op.evidence ?? null });
      }
    }

    if (source.firstSeen.doc >= 0 && (target.firstSeen.doc < 0 || source.firstSeen.doc < target.firstSeen.doc)) {
      target.firstSeen = source.firstSeen;
    }
    target.categoryCounts = mergeCounts(target.categoryCounts, source.categoryCounts);
    target.externalIds = { ...(source.externalIds ?? {}), ...(target.externalIds ?? {}) };
    if (!target.definition && source.definition) target.definition = source.definition;

    delete records[op.from];

    this.#rewriteAfterMerge(category, new Map([[op.from, op.to]]));
    this.#rebuildIndex();
    this.#dirty = true;
    return true;
  }

  /** For schema-level category merges: registry schemes are keyed by canonical category. */
  moveCategory(from: string, into: string): void {
    const fromRecords = this.#conceptSchemes[from];
    if (!fromRecords || from === into) return;

    // The whole scheme migrates, so its edges stay intra-scheme — capture them before move()
    // (which drops edges of individually departing concepts) and re-add after.
    const bEdges = this.#broaderEdges[from] ?? [];
    const rEdges = this.#renameEdges[from] ?? [];
    delete this.#broaderEdges[from];
    delete this.#renameEdges[from];
    this.#parentIndex.delete(from);

    for (const canonical of Object.keys(fromRecords)) this.move(from, canonical, into);
    delete this.#conceptSchemes[from];

    for (const edge of bEdges) {
      this.addBroaderEdge(into, edge); // re-validates endpoints and acyclicity in the target
    }
    for (const edge of rEdges) {
      this.addRenameEdge(into, edge);
    }
    this.#deferQueue = this.#deferQueue.map((entry) =>
      entry.category === from ? { ...entry, category: into } : entry
    );

    this.#rebuildIndex();
    this.#dirty = true;
  }

  // --- internals --------------------------------------------------------------------------------

  #parentsFor(category: string): Map<string, BroaderEdge[]> {
    let index = this.#parentIndex.get(category);
    if (!index) {
      index = new Map();
      for (const edge of this.#broaderEdges[category] ?? []) {
        const list = index.get(edge.narrower);
        if (list) list.push(edge);
        else index.set(edge.narrower, [edge]);
      }
      this.#parentIndex.set(category, index);
    }
    return index;
  }

  /** True when `target` is reachable from `start` along existing broader edges (narrower → broader). */
  #reaches(category: string, start: string, target: string): boolean {
    const edges = this.#broaderEdges[category] ?? [];
    const out = new Map<string, string[]>();
    for (const edge of edges) out.set(edge.narrower, [...(out.get(edge.narrower) ?? []), edge.broader]);
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(out.get(node) ?? []));
    }
    return false;
  }

  /**
   * After a merge (or a `renameInto` absorption — same closure mechanics, survivor fixed instead of
   * policy-chosen) fold, broader edges and defer entries naming a removed concept are rewritten to
   * its survivor. Self-loops produced by the rewrite are dropped (the two levels became one node);
   * duplicates dedupe on (narrower, broader), keeping the earliest.
   *
   * Rename edges are the one layer this deliberately never touches, in either direction — not
   * rewritten to a survivor, not dropped as a self-loop. A `renamed-to` edge records *history*
   * ("APT44 used to be called Sandworm"); once Sandworm is later absorbed by something else, the
   * edge naming it becomes a dangling reference by graph-topology standards but stays a true
   * historical fact. Rewriting it would make the graph consistent at the cost of making the record
   * false (dissertation wiki rule 5: edge layers stay separated; user ruling 2026-08-05). This is
   * also what lets `renameInto` (T3) call this method for its own broader/defer rewrite and trust
   * its own just-recorded `from → to` edge to survive untouched.
   */
  #rewriteAfterMerge(category: string, survivorOf: Map<string, string>): void {
    if (survivorOf.size === 0) return;
    const project = (name: string) => survivorOf.get(name) ?? name;

    const bEdges = this.#broaderEdges[category];
    if (bEdges) {
      const seen = new Set<string>();
      this.#broaderEdges[category] = bEdges.flatMap((edge) => {
        const narrower = project(edge.narrower);
        const broader = project(edge.broader);
        if (narrower === broader) return [];
        const key = `${narrower}|${broader}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...edge, narrower, broader }];
      });
      this.#parentIndex.delete(category);
    }

    this.#deferQueue = this.#deferQueue.map((entry) =>
      entry.category === category
        ? { ...entry, mintedAs: project(entry.mintedAs), candidates: entry.candidates.map(project) }
        : entry
    );
  }

  /**
   * Adjudicated entries name concepts literally (`ConceptRef`, not a resolved label). Once a
   * merge, `renameInto`, or split absorbs one into a survivor, the literal name is no longer a live
   * concept and the verdict it recorded is stale — its premise, that concept as a standalone
   * record, no longer exists. Pruned lazily on read (`findAdjudicated`) and on `load()`, rather than
   * eagerly at absorption time, because `#rewriteAfterMerge`'s survivor map does not know about this
   * layer at all and adjudicated entries are cheap to re-derive from suspects if ever needed again.
   */
  #pruneAdjudicated(): void {
    const alive = (ref: ConceptRef) => this.#conceptSchemes[ref.category]?.[ref.canonical] !== undefined;
    const next = this.#repair.adjudicated.filter((entry) => alive(entry.a) && alive(entry.b));
    if (next.length !== this.#repair.adjudicated.length) {
      this.#repair.adjudicated = next;
      this.#dirty = true;
    }
  }

  /** Applies `canonicalPolicy` to pick the survivor of a group. */
  #chooseCanonical(category: string, group: string[]): string {
    const records = this.#conceptSchemes[category];
    // Code-unit order as the final tie-break, so the choice never depends on insertion order.
    const ordered = [...group].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    switch (this.canonicalPolicy) {
      case 'frequency-weighted':
        return ordered.reduce((best, member) =>
          (records[member]?.labels.length ?? 0) > (records[best]?.labels.length ?? 0) ? member : best
        );

      case 'highest-degree': {
        if (!this.#degreeOf) {
          console.warn(
            'ConceptRegistry: canonicalPolicy "highest-degree" needs a degreeOf provider — falling back to first-seen'
          );
          return firstSeenWinner(ordered, records);
        }
        const degree = this.#degreeOf;
        return ordered.reduce((best, member) =>
          degree(category, member) > degree(category, best) ? member : best
        );
      }

      case 'first-seen':
      default:
        return firstSeenWinner(ordered, records);
    }
  }

  #bumpCategoryCount(record: Concept, category: string): void {
    record.categoryCounts = mergeCounts(record.categoryCounts, { [category]: 1 });
  }

  #schemeIndex(category: string): Map<string, string> {
    let index = this.#labelIndex.get(category);
    if (!index) {
      index = new Map();
      this.#labelIndex.set(category, index);
    }
    return index;
  }

  #rebuildIndex(): void {
    this.#labelIndex.clear();
    for (const [category, records] of Object.entries(this.#conceptSchemes)) {
      const index = this.#schemeIndex(category);
      for (const [canonical, record] of Object.entries(records)) {
        index.set(canonical.toLowerCase(), canonical);
        for (const label of record.labels) {
          index.set(label.surface.toLowerCase(), canonical);
        }
      }
    }
  }
}

/**
 * The one edge a roll-up follows out of a multi-parent node: highest `similarityScore` wins (null
 * scores as −1 so any scored edge beats an unscored one), ties break lexicographically on
 * `broader` so the choice never depends on insertion order.
 */
function pickRollupEdge(
  edges: BroaderEdge[],
  score: (edge: BroaderEdge) => number | null = (edge) => edge.similarityScore ?? null
): BroaderEdge | undefined {
  let best: BroaderEdge | undefined;
  for (const edge of edges) {
    if (!best) {
      best = edge;
      continue;
    }
    const bestScore = score(best) ?? -1;
    const edgeScore = score(edge) ?? -1;
    if (edgeScore > bestScore || (edgeScore === bestScore && edge.broader < best.broader)) best = edge;
  }
  return best;
}

function firstSeenWinner(
  ordered: string[],
  records: Record<string, Concept>
): string {
  return ordered.reduce((best, member) => {
    const bestDoc = records[best]?.firstSeen.doc ?? Number.MAX_SAFE_INTEGER;
    const memberDoc = records[member]?.firstSeen.doc ?? Number.MAX_SAFE_INTEGER;
    // Unknown (-1) must never beat a real document id.
    const normalise = (doc: number) => (doc < 0 ? Number.MAX_SAFE_INTEGER : doc);
    return normalise(memberDoc) < normalise(bestDoc) ? member : best;
  });
}

function mergeCounts(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [key, value] of Object.entries(b ?? {})) out[key] = (out[key] ?? 0) + value;
  return out;
}
