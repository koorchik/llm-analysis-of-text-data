import type { RegistrySnapshot } from '../Normalization/types';
import { closure } from '../Evaluation/unionFind';
import { writeJsonAtomic } from '../utils/fsUtils';
import { bestMatches } from '../utils/similarityUtils';
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
 * regenerated through this migration. `load()` therefore accepts both shapes, and `candidates()`
 * still returns alias **surfaces as strings** so the golden candidate lists remain byte-comparable.
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
  firstSeen: { doc: number; date: string };
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
      const { categories, policy, wasV1 } = EntityRegistry.parse(parsed);
      this.#categories = categories;
      this.#loadedFromV1 = wasV1;
      // An explicit constructor policy wins; otherwise adopt whatever the file recorded.
      if (policy && this.canonicalPolicy === DEFAULT_POLICY) this.canonicalPolicy = policy;
    }

    this.#rebuildIndex();
    this.#loaded = true;
  }

  /** Normalises either on-disk shape into v2 records. Exported for the migrator and for tests. */
  static parse(parsed: unknown): {
    categories: Record<string, Record<string, CanonicalRecord>>;
    policy?: CanonicalPolicy;
    wasV1: boolean;
  } {
    if (parsed !== null && typeof parsed === 'object' && (parsed as RegistryDataV2).version === 2) {
      const v2 = parsed as RegistryDataV2;
      return { categories: v2.categories ?? {}, policy: v2.canonicalPolicy, wasV1: false };
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
    return { categories, wasV1: true };
  }

  /** The v2 document as written to disk. */
  toJSON(): RegistryDataV2 {
    return { version: 2, canonicalPolicy: this.canonicalPolicy, categories: this.#categories };
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

  /**
   * Candidate generation (spec §4.2 step 2) — the future embeddings/ANN swap point.
   *
   * `aliases` is returned as **surface strings, not alias records**. Two reasons: the judge prompt
   * renders them as text, and the M2.5 golden candidate lists record them as strings, so changing
   * the shape here would break the behaviour-preservation gate M4 is scored against.
   */
  candidates(
    category: string,
    name: string,
    options: { k?: number; minSim?: number } = {}
  ): Array<{ name: string; sim: number; aliases: string[] }> {
    const records = this.#categories[category];
    if (!records) return [];

    const matches = bestMatches(
      name,
      Object.entries(records).map(([canonical, record]) => ({
        key: canonical,
        strings: [canonical, ...record.aliases.map((alias) => alias.surface)],
      })),
      options
    );
    return matches.map((match) => ({
      name: match.key,
      sim: match.sim,
      aliases: records[match.key].aliases.map((alias) => alias.surface),
    }));
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

    this.#dirty = true;
    this.#rebuildIndex();
    return true;
  }

  /** For schema-level category merges: registry buckets are keyed by canonical category. */
  moveCategory(from: string, into: string): void {
    const fromRecords = this.#categories[from];
    if (!fromRecords || from === into) return;
    for (const canonical of Object.keys(fromRecords)) this.move(from, canonical, into);
    delete this.#categories[from];
    this.#rebuildIndex();
    this.#dirty = true;
  }

  // --- internals --------------------------------------------------------------------------------

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
