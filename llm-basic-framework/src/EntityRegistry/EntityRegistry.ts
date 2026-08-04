import type { RegistrySnapshot } from '../Normalization/types';
import { closure } from '../Evaluation/unionFind';
import { writeJsonAtomic } from '../utils/fsUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

/**
 * Registry v2 — an alias graph with provenance.
 *
 * v1 stored `aliases: string[]`, which could not answer "who added this alias, from which document,
 * on what evidence?" — so a wrong merge could be neither audited nor undone. v2 stores one record
 * per alias, which is what makes the split/move operators (M8/E6) and KB grounding (E5) possible.
 *
 * **The v1 reader is retained deliberately.** `test/fixtures/registry-v1.json` is the M2.5
 * behaviour-preservation reference and must stay in the pre-M3 format; it would be worthless if
 * regenerated through this migration, so `load()` accepts both shapes.
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

// --- v2 -------------------------------------------------------------------------------------------

/** How an alias came to be attached to its canonical. */
export type AliasDecision = 'mint' | 'link' | 'merge' | 'split' | 'move' | 'migrated';

export interface AliasRecord {
  surface: string;
  /** Document that introduced it; -1 for registry-level operations with no document context. */
  docId: number;
  decision: AliasDecision;
  confidence?: number | null;
  /** Provenance snippet — the report's own "also known as" phrasing, or an authoritative page. */
  evidence?: string | null;
  /** runId of the run that added it, so a merge can be attributed after the fact. */
  addedBy?: string | null;
}

export interface CanonicalRecord {
  aliases: AliasRecord[];
  /** One-line description, written by the judge at mint time. Feeds gloss embeddings (E4). */
  gloss?: string | null;
  externalIds?: Record<string, string | null>;
  /** Observations per category — the input for soft category blocking later. */
  categoryCounts?: Record<string, number>;
  /**
   * Position on the category's granularity ladder, as judged at mint time (`mentionRung`).
   * Absent on pre-v3 records and on entities minted before their category had a ladder.
   */
  rung?: Rung;
  firstSeen: { doc: number; date: string };
}

// --- v3: identity-graph layers ---------------------------------------------------------------

export type Rung = 'g0' | 'g1' | 'g2' | 'g3';

/**
 * Granularity edge kinds are DERIVED from the LLM's `preserving` verdict — `coarsens-to` when
 * folding keeps a fact's subject (preserving: true), `part-of` when it widens attribution
 * (preserving: false). The name `isa` is retired (wiki note `isa-vs-partof-flags`, 2026-08-04).
 * Not to be confused with the graph builder's `extracted|inferred` edge *provenance* kinds.
 */
export type GranularityEdgeKind = 'coarsens-to' | 'part-of';

export type EdgeDecision = 'judge' | 'consolidator' | 'ladder-binding' | 'migrated';

/** Finer → coarser, same category. Per-edge provenance mirrors `AliasRecord` — the precondition
 * for a *local* split (one bad edge deletes without unpicking a transitive merge). */
export interface GranularityEdge {
  /** Finer canonical. */
  from: string;
  /** Coarser canonical. */
  to: string;
  kind: GranularityEdgeKind;
  docId: number;
  decision: EdgeDecision;
  evidence?: string | null;
  addedBy?: string | null;
}

/** Old designation → new, same referent over time. Never an alias, never auto-folded. */
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
 * A judge `defer` = provisional mint + this queue entry. The consolidator reviews the queue;
 * decisions.jsonl is never read at runtime (deck rule 10), so the queue lives in registry state.
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
 * How the surviving canonical surface form is chosen when several are folded together.
 *
 * The research note calls this out directly — the plan never said *how* the canonical is picked, so
 * it was an accident of insertion order. Now it is a recorded configuration value.
 *
 * - `first-seen` — earliest `firstSeen.doc`. The streaming default and v1's implicit behaviour.
 * - `frequency-weighted` — most aliases accumulated (`vashishth2018cesi` picks the element nearest
 *   the frequency-weighted mean; alias count is the registry-local proxy).
 * - `highest-degree` — `shu2026latticekg`. Needs graph degrees, which the registry does not hold,
 *   so it requires an injected `degreeOf` provider and falls back loudly without one.
 */
export type CanonicalPolicy = 'first-seen' | 'frequency-weighted' | 'highest-degree';

export interface RegistryDataV2 {
  version: 2;
  canonicalPolicy: CanonicalPolicy;
  categories: Record<string, Record<string, CanonicalRecord>>;
}

/**
 * v3 — the registry as an **identity graph** (SKEIN v2 deck): the v2 alias layer plus strictly
 * separated granularity and rename edge layers and the consolidator's defer queue. Assertional
 * relations never enter this file.
 */
export interface RegistryDataV3 {
  version: 3;
  canonicalPolicy: CanonicalPolicy;
  categories: Record<string, Record<string, CanonicalRecord>>;
  /** category → granularity edges (finer → coarser, same category). */
  granularityEdges: Record<string, GranularityEdge[]>;
  /** category → rename chains. */
  renameEdges: Record<string, RenameEdge[]>;
  deferQueue: DeferredPair[];
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
  /** Stamped into alias provenance so a merge is attributable to a run. */
  runId?: string;
  /** Required only by the `highest-degree` policy. */
  degreeOf?: (category: string, canonical: string) => number;
}

const DEFAULT_POLICY: CanonicalPolicy = 'first-seen';

export class EntityRegistry {
  public readonly filePath: string;
  public canonicalPolicy: CanonicalPolicy;

  #categories: Record<string, Record<string, CanonicalRecord>> = {};
  #granularityEdges: Record<string, GranularityEdge[]> = {};
  #renameEdges: Record<string, RenameEdge[]> = {};
  #deferQueue: DeferredPair[] = [];
  #aliasIndex = new Map<string, Map<string, string>>(); // category → lowercased alias → canonical
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
      const { categories, policy, wasV1, granularityEdges, renameEdges, deferQueue } =
        EntityRegistry.parse(parsed);
      this.#categories = categories;
      this.#granularityEdges = granularityEdges;
      this.#renameEdges = renameEdges;
      this.#deferQueue = deferQueue;
      this.#loadedFromV1 = wasV1;
      // An explicit constructor policy wins; otherwise adopt whatever the file recorded.
      if (policy && this.canonicalPolicy === DEFAULT_POLICY) this.canonicalPolicy = policy;
    }

    this.#rebuildIndex();
    this.#loaded = true;
  }

  /** Normalises any on-disk shape (v1/v2/v3) into v3 state. Exported for the migrator and for tests. */
  static parse(parsed: unknown): {
    categories: Record<string, Record<string, CanonicalRecord>>;
    policy?: CanonicalPolicy;
    wasV1: boolean;
    granularityEdges: Record<string, GranularityEdge[]>;
    renameEdges: Record<string, RenameEdge[]>;
    deferQueue: DeferredPair[];
  } {
    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV3).version === 3) {
      const v3 = parsed as RegistryDataV3;
      return {
        categories: v3.categories ?? {},
        policy: v3.canonicalPolicy,
        wasV1: false,
        granularityEdges: v3.granularityEdges ?? {},
        renameEdges: v3.renameEdges ?? {},
        deferQueue: v3.deferQueue ?? [],
      };
    }

    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV2).version === 2) {
      const v2 = parsed as RegistryDataV2;
      return {
        categories: v2.categories ?? {},
        policy: v2.canonicalPolicy,
        wasV1: false,
        granularityEdges: {},
        renameEdges: {},
        deferQueue: [],
      };
    }

    // v1: category → canonical → { aliases: string[], firstSeen }
    const v1 = (parsed ?? {}) as RegistryDataV1;
    const categories: Record<string, Record<string, CanonicalRecord>> = {};
    for (const [category, records] of Object.entries(v1)) {
      categories[category] = {};
      for (const [canonical, record] of Object.entries(records ?? {})) {
        categories[category][canonical] = {
          aliases: (record?.aliases ?? []).map((surface) => ({
            surface,
            // v1 recorded no per-alias provenance. `firstSeen.doc` is the only document context
            // available, and inventing anything finer would fabricate provenance.
            docId: record.firstSeen?.doc ?? -1,
            decision: 'migrated' as const,
          })),
          categoryCounts: { [category]: (record?.aliases ?? []).length },
          firstSeen: record?.firstSeen ?? { doc: -1, date: '' },
        };
      }
    }
    return { categories, wasV1: true, granularityEdges: {}, renameEdges: {}, deferQueue: [] };
  }

  /** The v3 document as written to disk. */
  toJSON(): RegistryDataV3 {
    return {
      version: 3,
      canonicalPolicy: this.canonicalPolicy,
      categories: this.#categories,
      granularityEdges: this.#granularityEdges,
      renameEdges: this.#renameEdges,
      deferQueue: this.#deferQueue,
    };
  }

  /**
   * Project back to the v1 shape.
   *
   * Only for comparing against pre-M3 artifacts — chiefly the M2.5 fixture, which must remain in
   * its historical format. Lossy by definition: provenance, gloss, externalIds and categoryCounts
   * have no v1 representation.
   */
  toV1(): RegistryDataV1 {
    const out: RegistryDataV1 = {};
    for (const [category, records] of Object.entries(this.#categories)) {
      out[category] = {};
      for (const [canonical, record] of Object.entries(records)) {
        out[category][canonical] = {
          aliases: record.aliases.map((alias) => alias.surface),
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
    return this.#aliasIndex.get(category)?.get(name.trim().toLowerCase());
  }

  categories(): string[] {
    return Object.keys(this.#categories);
  }

  records(category: string): Record<string, CanonicalRecord> {
    return this.#categories[category] || {};
  }

  /** Alias surfaces for one canonical — for callers that want plain strings. */
  aliasSurfaces(category: string, canonical: string): string[] {
    return (this.#categories[category]?.[canonical]?.aliases ?? []).map((alias) => alias.surface);
  }

  /**
   * The stored surface a lookup of `name` actually hits, in its stored casing — what artifacts
   * stamp as `matchedVia`. Falls back to the canonical name itself (which the fast path also
   * matches, since mint stores it as its own alias).
   */
  matchedSurface(category: string, name: string): string | undefined {
    const canonical = this.resolve(category, name);
    if (!canonical) return undefined;
    const folded = name.trim().toLowerCase();
    if (canonical.toLowerCase() === folded) return canonical;
    return (
      this.#categories[category]?.[canonical]?.aliases.find(
        (alias) => alias.surface.trim().toLowerCase() === folded
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
   * `surfaces` is `[canonical, ...aliasSurfaces]` — the canonical usually appears twice, because
   * `mint` stores it in its own alias list. Harmless (scoring takes a max) and preserved verbatim,
   * because the M2.5 golden lists were captured against exactly this array.
   */
  snapshot(): RegistrySnapshot {
    const categories = this.#categories;
    return {
      categories: () => Object.keys(categories),
      size: (category: string) => Object.keys(categories[category] ?? {}).length,
      entries: (category: string) =>
        Object.entries(categories[category] ?? {}).map(([canonical, record]) => ({
          canonical,
          surfaces: [canonical, ...record.aliases.map((alias) => alias.surface)],
          gloss: record.gloss ?? null,
          categoryCounts: record.categoryCounts,
        })),
    };
  }

  aliasToCanonicalMap(category: string): Map<string, string> {
    return new Map(this.#categoryIndex(category));
  }

  // --- writes -----------------------------------------------------------------------------------

  link(
    category: string,
    canonicalName: string,
    alias: string,
    provenance: { docId?: number; confidence?: number | null; evidence?: string | null } = {}
  ): void {
    const record = this.#categories[category]?.[canonicalName];
    if (!record) {
      console.warn(`EntityRegistry: cannot link "${alias}" to unknown ${category}/"${canonicalName}"`);
      return;
    }

    const aliasKey = alias.trim().toLowerCase();
    if (this.#aliasIndex.get(category)?.has(aliasKey)) return; // idempotent

    record.aliases.push({
      surface: alias.trim(),
      docId: provenance.docId ?? -1,
      decision: 'link',
      confidence: provenance.confidence ?? null,
      evidence: provenance.evidence ?? null,
      addedBy: this.#runId ?? null,
    });
    this.#bumpCategoryCount(record, category);
    this.#categoryIndex(category).set(aliasKey, canonicalName);
    this.#dirty = true;
  }

  mint(
    category: string,
    name: string,
    firstSeen: { doc: number; date: string },
    extras: { gloss?: string | null; externalIds?: Record<string, string | null> } = {}
  ): string {
    const existing = this.resolve(category, name);
    if (existing) return existing; // resolve-first guard (crash-retry safe)

    const canonical = name.trim();
    if (!this.#categories[category]) this.#categories[category] = {};
    this.#categories[category][canonical] = {
      aliases: [
        {
          surface: canonical,
          docId: firstSeen.doc,
          decision: 'mint',
          addedBy: this.#runId ?? null,
        },
      ],
      gloss: extras.gloss ?? null,
      externalIds: extras.externalIds ?? {},
      categoryCounts: { [category]: 1 },
      firstSeen,
    };
    this.#categoryIndex(category).set(canonical.toLowerCase(), canonical);
    this.#dirty = true;
    return canonical;
  }

  setGloss(category: string, canonical: string, gloss: string | null): void {
    const record = this.#categories[category]?.[canonical];
    if (!record) return;
    record.gloss = gloss;
    this.#dirty = true;
  }

  setExternalId(category: string, canonical: string, source: string, id: string | null): void {
    const record = this.#categories[category]?.[canonical];
    if (!record) return;
    record.externalIds = { ...(record.externalIds ?? {}), [source]: id };
    this.#dirty = true;
  }

  // --- identity-graph layers (v3) -----------------------------------------------------------------

  /** Records the judge's `mentionRung`. First write wins — a rung is identity metadata, not a vote. */
  setRung(category: string, canonical: string, rung: Rung): void {
    const record = this.#categories[category]?.[canonical];
    if (!record || record.rung) return;
    record.rung = rung;
    this.#dirty = true;
  }

  rungOf(category: string, canonical: string): Rung | undefined {
    return this.#categories[category]?.[canonical]?.rung;
  }

  /**
   * Adds a finer→coarser granularity edge. Rejects (returns false, warns) when an endpoint is
   * unknown, the edge is a self-loop, or it would close a cycle — acyclicity is checked on every
   * write, per the deck's ladder-structure rules. Idempotent on (from, to, kind).
   */
  addGranularityEdge(
    category: string,
    edge: {
      from: string;
      to: string;
      kind: GranularityEdgeKind;
      docId: number;
      decision: EdgeDecision;
      evidence?: string | null;
    }
  ): boolean {
    const records = this.#categories[category];
    if (!records?.[edge.from] || !records?.[edge.to]) {
      console.warn(
        `EntityRegistry: granularity edge needs existing endpoints — ${category}/"${edge.from}" -> "${edge.to}"`
      );
      return false;
    }
    if (edge.from === edge.to) {
      console.warn(`EntityRegistry: refusing granularity self-loop on ${category}/"${edge.from}"`);
      return false;
    }

    const edges = (this.#granularityEdges[category] ??= []);
    if (edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
      return true; // idempotent
    }
    if (this.#reaches(category, edge.to, edge.from)) {
      console.warn(
        `EntityRegistry: granularity edge ${category}/"${edge.from}" -> "${edge.to}" would close a cycle — rejected`
      );
      return false;
    }

    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      docId: edge.docId,
      decision: edge.decision,
      evidence: edge.evidence ?? null,
      addedBy: this.#runId ?? null,
    });
    this.#dirty = true;
    return true;
  }

  granularityEdges(category: string): GranularityEdge[] {
    return this.#granularityEdges[category] ?? [];
  }

  /** Edge deletion — the local repair per-edge provenance exists for. */
  removeGranularityEdge(category: string, from: string, to: string): boolean {
    const edges = this.#granularityEdges[category];
    if (!edges) return false;
    const next = edges.filter((e) => !(e.from === from && e.to === to));
    if (next.length === edges.length) return false;
    this.#granularityEdges[category] = next;
    this.#dirty = true;
    return true;
  }

  /** Outgoing (finer→coarser) edges of one canonical, optionally restricted to one kind. */
  parentsOf(category: string, canonical: string, kind?: GranularityEdgeKind): GranularityEdge[] {
    return this.granularityEdges(category).filter(
      (e) => e.from === canonical && (kind === undefined || e.kind === kind)
    );
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
    const records = this.#categories[category];
    if (!records?.[edge.from] || !records?.[edge.to] || edge.from === edge.to) {
      console.warn(
        `EntityRegistry: invalid rename edge ${category}/"${edge.from}" -> "${edge.to}"`
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

  /** Queues a judge `defer` for the consolidator. Idempotent on (category, mention, docId). */
  pushDeferred(entry: DeferredPair): void {
    const key = (d: DeferredPair) => `${d.category}|${d.mention.trim().toLowerCase()}|${d.docId}`;
    if (this.#deferQueue.some((d) => key(d) === key(entry))) return;
    this.#deferQueue.push(entry);
    this.#dirty = true;
  }

  deferred(): DeferredPair[] {
    return [...this.#deferQueue];
  }

  /** Consolidator calls this after reviewing; entries not passed stay queued. */
  clearDeferred(consumed: DeferredPair[]): void {
    const key = (d: DeferredPair) => `${d.category}|${d.mention.trim().toLowerCase()}|${d.docId}`;
    const gone = new Set(consumed.map(key));
    const next = this.#deferQueue.filter((d) => !gone.has(key(d)));
    if (next.length !== this.#deferQueue.length) {
      this.#deferQueue = next;
      this.#dirty = true;
    }
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
   * target is recorded in alias provenance rather than obeyed.
   */
  applyMerges(category: string, merges: MergeOp[]): RepairSummary {
    const records = this.#categories[category];
    const summary: RepairSummary = { groups: [], survivors: [], removed: [] };
    if (!records) return summary;

    const pairs: Array<[string, string]> = [];
    const evidenceByPair = new Map<string, MergeOp>();
    for (const merge of merges) {
      if (merge.from === merge.into) continue;
      if (!records[merge.from] || !records[merge.into]) continue;
      pairs.push([merge.from, merge.into]);
      evidenceByPair.set(`${merge.from} ${merge.into}`, merge);
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

        // The canonical name itself becomes an alias of the survivor, with its provenance kept.
        const incoming: AliasRecord[] = source.aliases.map((alias) => ({
          ...alias,
          decision: 'merge' as const,
          addedBy: this.#runId ?? alias.addedBy ?? null,
        }));
        for (const alias of incoming) {
          if (!target.aliases.some((existing) => existing.surface === alias.surface)) {
            const op =
              evidenceByPair.get(`${member} ${survivor}`) ??
              evidenceByPair.get(`${survivor} ${member}`);
            target.aliases.push({
              ...alias,
              evidence: alias.evidence ?? op?.evidence ?? null,
              confidence: alias.confidence ?? op?.confidence ?? null,
            });
          }
        }

        // Keep the earliest firstSeen and accumulate category counts and external ids.
        if (source.firstSeen.doc >= 0 && (target.firstSeen.doc < 0 || source.firstSeen.doc < target.firstSeen.doc)) {
          target.firstSeen = source.firstSeen;
        }
        target.categoryCounts = mergeCounts(target.categoryCounts, source.categoryCounts);
        target.externalIds = { ...(source.externalIds ?? {}), ...(target.externalIds ?? {}) };
        if (!target.gloss && source.gloss) target.gloss = source.gloss;

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
   * Split aliases off a canonical into a new one — edge removal, the operator v1 lacked entirely.
   *
   * Deterministic: the detached surfaces are matched case-insensitively, the new canonical is chosen
   * from them by `canonicalPolicy`'s tie-break (lexicographically lowest for a fresh group, since a
   * detached set has no independent `firstSeen`), and the alias order of both records is preserved.
   * Artifacts are re-stamped separately by the consolidator via `aliasToCanonicalMap`.
   */
  split(
    category: string,
    canonical: string,
    detach: string[],
    provenance: { docId?: number; evidence?: string | null } = {}
  ): { newCanonical: string; moved: string[] } | null {
    const records = this.#categories[category];
    const record = records?.[canonical];
    if (!record) {
      console.warn(`EntityRegistry: cannot split unknown ${category}/"${canonical}"`);
      return null;
    }

    const wanted = new Set(detach.map((surface) => surface.trim().toLowerCase()));
    const moving = record.aliases.filter((alias) => wanted.has(alias.surface.trim().toLowerCase()));
    const staying = record.aliases.filter((alias) => !wanted.has(alias.surface.trim().toLowerCase()));

    if (moving.length === 0) return null;
    if (staying.length === 0) {
      // Detaching everything would leave an empty canonical; that is a rename, not a split.
      console.warn(`EntityRegistry: refusing to split all aliases off ${category}/"${canonical}"`);
      return null;
    }

    // Deterministic name for the new canonical: lowest surface in code-unit order.
    const newCanonical = [...moving.map((alias) => alias.surface)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    )[0];
    if (records[newCanonical] && newCanonical !== canonical) {
      console.warn(`EntityRegistry: split target ${category}/"${newCanonical}" already exists`);
      return null;
    }

    record.aliases = staying;
    records[newCanonical] = {
      aliases: moving.map((alias) => ({
        ...alias,
        decision: 'split' as const,
        evidence: provenance.evidence ?? alias.evidence ?? null,
        addedBy: this.#runId ?? null,
      })),
      gloss: null,
      externalIds: {},
      categoryCounts: { [category]: moving.length },
      firstSeen: {
        doc: provenance.docId ?? record.firstSeen.doc,
        date: record.firstSeen.date,
      },
    };

    this.#dirty = true;
    this.#rebuildIndex();
    return { newCanonical, moved: moving.map((alias) => alias.surface) };
  }

  /**
   * Move one canonical between categories — standalone, which v1 could only do as a side effect of
   * a whole-category merge.
   */
  move(fromCategory: string, canonical: string, toCategory: string): boolean {
    if (fromCategory === toCategory) return false;
    const source = this.#categories[fromCategory]?.[canonical];
    if (!source) {
      console.warn(`EntityRegistry: cannot move unknown ${fromCategory}/"${canonical}"`);
      return false;
    }

    if (!this.#categories[toCategory]) this.#categories[toCategory] = {};
    const target = this.#categories[toCategory][canonical];

    const moved: CanonicalRecord = {
      ...source,
      aliases: source.aliases.map((alias) => ({
        ...alias,
        decision: 'move' as const,
        addedBy: this.#runId ?? alias.addedBy ?? null,
      })),
      categoryCounts: mergeCounts(source.categoryCounts, { [toCategory]: 1 }),
    };

    if (target) {
      for (const alias of moved.aliases) {
        if (!target.aliases.some((existing) => existing.surface === alias.surface)) {
          target.aliases.push(alias);
        }
      }
      if (source.firstSeen.doc >= 0 && (target.firstSeen.doc < 0 || source.firstSeen.doc < target.firstSeen.doc)) {
        target.firstSeen = source.firstSeen;
      }
      target.categoryCounts = mergeCounts(target.categoryCounts, moved.categoryCounts);
      target.externalIds = { ...(moved.externalIds ?? {}), ...(target.externalIds ?? {}) };
      if (!target.gloss && moved.gloss) target.gloss = moved.gloss;
    } else {
      this.#categories[toCategory][canonical] = moved;
    }

    delete this.#categories[fromCategory][canonical];
    if (Object.keys(this.#categories[fromCategory]).length === 0) delete this.#categories[fromCategory];

    // Granularity/rename edges are same-category by construction; a canonical moving out orphans
    // its edges. They are dropped loudly — a cross-category edge would be a type error as data.
    const dropped = (this.#granularityEdges[fromCategory] ?? []).filter(
      (edge) => edge.from === canonical || edge.to === canonical
    );
    if (dropped.length > 0) {
      console.warn(
        `EntityRegistry: dropping ${dropped.length} granularity edge(s) touching moved ${fromCategory}/"${canonical}"`
      );
      this.#granularityEdges[fromCategory] = (this.#granularityEdges[fromCategory] ?? []).filter(
        (edge) => edge.from !== canonical && edge.to !== canonical
      );
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

  /** For schema-level category merges: registry buckets are keyed by canonical category. */
  moveCategory(from: string, into: string): void {
    const fromRecords = this.#categories[from];
    if (!fromRecords || from === into) return;

    // The whole bucket migrates, so its edges stay intra-category — capture them before move()
    // (which drops edges of individually departing canonicals) and re-add after.
    const gEdges = this.#granularityEdges[from] ?? [];
    const rEdges = this.#renameEdges[from] ?? [];
    delete this.#granularityEdges[from];
    delete this.#renameEdges[from];

    for (const canonical of Object.keys(fromRecords)) this.move(from, canonical, into);
    delete this.#categories[from];

    for (const edge of gEdges) {
      this.addGranularityEdge(into, edge); // re-validates endpoints and acyclicity in the target
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

  /** True when `target` is reachable from `start` along existing granularity edges (finer→coarser). */
  #reaches(category: string, start: string, target: string): boolean {
    const edges = this.#granularityEdges[category] ?? [];
    const out = new Map<string, string[]>();
    for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
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
   * After a merge fold, edges and defer entries naming a removed canonical are rewritten to its
   * survivor. Self-loops produced by the rewrite are dropped (the two rungs became one node);
   * duplicates dedupe on (from, to, kind), keeping the earliest.
   */
  #rewriteAfterMerge(category: string, survivorOf: Map<string, string>): void {
    if (survivorOf.size === 0) return;
    const project = (name: string) => survivorOf.get(name) ?? name;

    const gEdges = this.#granularityEdges[category];
    if (gEdges) {
      const seen = new Set<string>();
      this.#granularityEdges[category] = gEdges.flatMap((edge) => {
        const from = project(edge.from);
        const to = project(edge.to);
        if (from === to) return [];
        const key = `${from}|${to}|${edge.kind}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...edge, from, to }];
      });
    }

    const rEdges = this.#renameEdges[category];
    if (rEdges) {
      const seen = new Set<string>();
      this.#renameEdges[category] = rEdges.flatMap((edge) => {
        const from = project(edge.from);
        const to = project(edge.to);
        if (from === to) return [];
        const key = `${from}|${to}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...edge, from, to }];
      });
    }

    this.#deferQueue = this.#deferQueue.map((entry) =>
      entry.category === category
        ? { ...entry, mintedAs: project(entry.mintedAs), candidates: entry.candidates.map(project) }
        : entry
    );
  }

  /** Applies `canonicalPolicy` to pick the survivor of a group. */
  #chooseCanonical(category: string, group: string[]): string {
    const records = this.#categories[category];
    // Code-unit order as the final tie-break, so the choice never depends on insertion order.
    const ordered = [...group].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    switch (this.canonicalPolicy) {
      case 'frequency-weighted':
        return ordered.reduce((best, member) =>
          (records[member]?.aliases.length ?? 0) > (records[best]?.aliases.length ?? 0) ? member : best
        );

      case 'highest-degree': {
        if (!this.#degreeOf) {
          console.warn(
            'EntityRegistry: canonicalPolicy "highest-degree" needs a degreeOf provider — falling back to first-seen'
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

  #bumpCategoryCount(record: CanonicalRecord, category: string): void {
    record.categoryCounts = mergeCounts(record.categoryCounts, { [category]: 1 });
  }

  #categoryIndex(category: string): Map<string, string> {
    let index = this.#aliasIndex.get(category);
    if (!index) {
      index = new Map();
      this.#aliasIndex.set(category, index);
    }
    return index;
  }

  #rebuildIndex(): void {
    this.#aliasIndex.clear();
    for (const [category, records] of Object.entries(this.#categories)) {
      const index = this.#categoryIndex(category);
      for (const [canonical, record] of Object.entries(records)) {
        index.set(canonical.toLowerCase(), canonical);
        for (const alias of record.aliases) {
          index.set(alias.surface.toLowerCase(), canonical);
        }
      }
    }
  }
}

function firstSeenWinner(
  ordered: string[],
  records: Record<string, CanonicalRecord>
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
