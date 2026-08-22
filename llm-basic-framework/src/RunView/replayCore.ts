/**
 * The replay reducer for the run playback viewer.
 *
 * Written ONCE, in browser-compatible JavaScript (no TS-only syntax inside the function bodies),
 * and shared verbatim with the generated page via `REPLAY_SOURCE` — the Node tests and the
 * browser scrubber run the exact same fold, so they cannot drift apart.
 *
 * State is rebuilt by folding `decisions.jsonl` events in order. Backward scrubbing replays from
 * zero — a few thousand events, simplicity over incremental undo.
 */

export interface ReplayEntity {
  aliases: string[];
  deferred?: boolean;
  firstDoc: number;
}

export interface ReplayEdge {
  narrower: string;
  broader: string;
  /** ISO 25964 typing (broaderGeneric | broaderPartitive | broaderInstantial) or null (untyped). */
  type?: string | null;
  similarityScore?: number | null;
  by?: string;
  doc: number;
}

export interface ReplayRename {
  from: string;
  to: string;
  by?: string;
  doc: number;
}

export interface ReplayCategoryState {
  entities: Record<string, ReplayEntity>;
  edges: ReplayEdge[];
  renames: ReplayRename[];
}

export interface ReplayState {
  categories: Record<string, ReplayCategoryState>;
  counts: { links: number; mints: number; defers: number };
  /**
   * T11: telemetry for the `StreamingRepairer` events that carry no structural fold of their own —
   * `suspect`/`repair-distinct`/`gloss-flagged` tally one per occurrence (each log row is one pair
   * or one mention); `spillover` sums the event's `size` field, so it reads as "suspects spilled"
   * rather than "spill events logged" (one spill event can carry several queued suspects). Kept
   * separate from `counts` so the pre-existing link/mint/defer shape never has to change.
   */
  repairCounts: { suspects: number; distinct: number; spillover: number; glossFlagged: number };
  /**
   * T14 review fix: bridges a StreamingRepairer `category-correction` event to the `repair-merge`
   * event that immediately follows it. `ConceptRegistry#move` relocates the record under ITS OWN
   * name (see `#merge`, StreamingRepairer.ts:1027-1036), so the category-correction fold alone
   * cannot finish the operation — the merge is folded by the following `repair-merge` event. That
   * event's survivor is chosen by `canonicalPolicy` and may turn out to be the JUST-MOVED entity's
   * own name, in which case `repair-merge`'s `from` and `into` fields are identical
   * (StreamingRepairer.ts:851/854 — `from` is always the pre-merge non-survivor's name) and carry no
   * information about the actual merge partner. This pointer recovers it. Cleared as soon as the
   * next `repair-merge` event consumes it (matched or not) so it never survives past its one use.
   */
  pendingCrossCategoryMerge: { category: string; movedName: string; requestedInto: string } | null;
}

export const createEmptyState = function (): ReplayState {
  return {
    categories: {},
    counts: { links: 0, mints: 0, defers: 0 },
    repairCounts: { suspects: 0, distinct: 0, spillover: 0, glossFlagged: 0 },
    pendingCrossCategoryMerge: null,
  };
};

/**
 * The document an event belongs to; consolidator events (doc -1) form the batch-reference chapter.
 * T11: per-document repair ops (`repair-merge`/`repair-split`/`repair-move`/…) carry the REAL doc id
 * that triggered them — the -1 chapter is now specific to the older whole-corpus consolidator pass.
 */
export const docOf = function (event: Record<string, unknown>): number {
  const doc = event.docId !== undefined ? event.docId : event.doc;
  return typeof doc === 'number' ? doc : -1;
};

export const applyEvent = function (state: ReplayState, event: Record<string, any>): void {
  const category = function (name: string): ReplayCategoryState {
    if (!state.categories[name]) {
      state.categories[name] = { entities: {}, edges: [], renames: [] };
    }
    return state.categories[name];
  };
  const ensureEntity = function (categoryName: string, canonical: string, doc: number): ReplayEntity {
    const bucket = category(categoryName);
    if (!bucket.entities[canonical]) {
      bucket.entities[canonical] = { aliases: [canonical], firstDoc: doc };
    }
    return bucket.entities[canonical];
  };
  const doc = docOf(event);

  if (event.op === 'decision') {
    const target = event.target || event.mintedAs;
    if (!event.category || !target) {
      if (event.decision === 'defer') state.counts.defers += 1;
      return;
    }
    const entity = ensureEntity(event.category, target, doc);
    if (event.decision === 'link') {
      state.counts.links += 1;
      if (event.mention && entity.aliases.indexOf(event.mention) === -1) {
        entity.aliases.push(event.mention);
      }
    } else if (event.decision === 'mint') {
      state.counts.mints += 1;
    } else if (event.decision === 'defer') {
      state.counts.defers += 1;
      entity.deferred = true;
    }
    return;
  }

  // Dual-read: new journals write `broader-edge` with narrower/broader/type; 158 committed run
  // dirs carry `granularity-edge` with from/to/relation (and the oldest only from/to/kind), which
  // normalize through the same value map the registry loaders use.
  if ((event.op === 'broader-edge' || event.op === 'granularity-edge') && event.category) {
    const narrower = event.narrower !== undefined ? event.narrower : event.from;
    const broader = event.broader !== undefined ? event.broader : event.to;
    const type =
      event.type !== undefined
        ? event.type
        : event.relation === 'version-of'
          ? 'broaderInstantial'
          : event.relation === 'narrower-of'
            ? 'broaderGeneric'
            : event.relation === 'part-of' || event.kind === 'part-of'
              ? 'broaderPartitive'
              : null;
    const bucket = category(event.category);
    const exists = bucket.edges.some(function (edge) {
      return edge.narrower === narrower && edge.broader === broader;
    });
    if (!exists) {
      ensureEntity(event.category, narrower, doc);
      ensureEntity(event.category, broader, doc);
      bucket.edges.push({
        narrower: narrower,
        broader: broader,
        type: type,
        similarityScore: event.similarityScore,
        by: event.by,
        doc: doc,
      });
    }
    return;
  }

  if (event.op === 'rename-edge' && event.category) {
    const bucket = category(event.category);
    ensureEntity(event.category, event.from, doc);
    ensureEntity(event.category, event.to, doc);
    bucket.renames.push({ from: event.from, to: event.to, by: event.by, doc: doc });
    return;
  }

  // --- T11: StreamingRepairer telemetry — no structural fold, just a running count. -------------

  if (event.op === 'suspect') {
    state.repairCounts.suspects += 1;
    return;
  }

  if (event.op === 'repair-distinct') {
    state.repairCounts.distinct += 1;
    return;
  }

  if (event.op === 'repair-spillover') {
    state.repairCounts.spillover += typeof event.size === 'number' ? event.size : 1;
    return;
  }

  if (event.op === 'gloss-flagged') {
    state.repairCounts.glossFlagged += 1;
    return;
  }

  // --- T11: repair-move — a single alias relocates between canonicals, possibly cross-category. --

  if (event.op === 'repair-move' && Array.isArray(event.categories) && event.categories.length === 2) {
    const fromBucket = category(event.categories[0]);
    const source = fromBucket.entities[event.from];
    if (source) {
      source.aliases = source.aliases.filter(function (alias) {
        return alias !== event.alias;
      });
    }
    const target = ensureEntity(event.categories[1], event.to, doc);
    if (target.aliases.indexOf(event.alias) === -1) target.aliases.push(event.alias);
    return;
  }

  // `repair-merge` (real doc id) folds exactly like `merge-canonical` (doc -1) — same field names
  // (category/from/into), just a different origin.
  // `merge` is the catch-up pass's own op — same structural fields (category/from/into).
  if ((event.op === 'merge-canonical' || event.op === 'repair-merge' || event.op === 'merge') && event.category) {
    const bucket = category(event.category);
    const pending = state.pendingCrossCategoryMerge;
    const degenerate =
      event.op === 'repair-merge' &&
      event.from === event.into &&
      pending !== null &&
      pending.category === event.category &&
      pending.movedName === event.from;
    state.pendingCrossCategoryMerge = null;

    // Ordinarily `from` is the absorbed name and `into` is the survivor. In the degenerate case
    // (canonicalPolicy kept the JUST-MOVED entity's own name as survivor) `from` and `into` are
    // identical and this event alone can't say who the other merge partner was — recovered from the
    // category-correction event that preceded it (see `pendingCrossCategoryMerge` doc comment).
    const absorbedName = degenerate ? pending!.requestedInto : event.from;
    const source = bucket.entities[absorbedName];
    const target = ensureEntity(event.category, event.into, doc);
    if (source && source !== target) {
      for (const alias of source.aliases) {
        if (target.aliases.indexOf(alias) === -1) target.aliases.push(alias);
      }
      delete bucket.entities[absorbedName];
    }
    const project = function (name: string): string {
      return name === absorbedName ? event.into : name;
    };
    bucket.edges = bucket.edges
      .map(function (edge) {
        return {
          narrower: project(edge.narrower),
          broader: project(edge.broader),
          type: edge.type,
          similarityScore: edge.similarityScore,
          by: edge.by,
          doc: edge.doc,
        };
      })
      .filter(function (edge) {
        return edge.narrower !== edge.broader;
      });
    // Renames are LEFT ALONE, deliberately — mirrors `ConceptRegistry#rewriteAfterMerge`, which never
    // touches rename edges in either direction (user ruling 2026-08-05). The `renamed` verdict path
    // logs `rename-edge(A→B)` immediately followed by `repair-merge(A→B)` as dual-replayable history;
    // projecting A→B through this merge would turn it into a B→B self-loop and the same filter above
    // would then delete it, silently erasing the rename from the Renames panel on the ROUTINE path.
    return;
  }

  // `repair-split` folds exactly like `split-canonical` — same structural fields
  // (category/canonical/detached/newCanonical).
  if ((event.op === 'split-canonical' || event.op === 'repair-split') && event.category) {
    const bucket = category(event.category);
    const source = bucket.entities[event.canonical];
    if (!source || !event.newCanonical) return;
    const detached: string[] = event.detached || [];
    source.aliases = source.aliases.filter(function (alias) {
      return detached.indexOf(alias) === -1;
    });
    const target = ensureEntity(event.category, event.newCanonical, doc);
    for (const alias of detached) {
      if (target.aliases.indexOf(alias) === -1) target.aliases.push(alias);
    }
    return;
  }

  if (event.op === 'category-correction' && event.from && event.into) {
    const fromBucket = category(event.from.category);
    const entity = fromBucket.entities[event.from.canonical];
    if (!entity) return;
    delete fromBucket.entities[event.from.canonical];
    fromBucket.edges = fromBucket.edges.filter(function (edge) {
      return edge.narrower !== event.from.canonical && edge.broader !== event.from.canonical;
    });

    if (event.by === 'StreamingRepairer') {
      // Mirrors `ConceptRegistry#move` (StreamingRepairer.ts:1027-1036): relocate the record into the
      // target category UNDER ITS OWN NAME, carrying its aliases. The merge under the REQUESTED name
      // (if any) is a separate step (`applyMerges`) that the `repair-merge` event immediately
      // following this one folds — pre-empting that merge here, under the requested name, is exactly
      // the bug this fix corrects (review finding): it left `bucket.entities[a]` undefined for the
      // repair-merge fold to mint a fresh, empty duplicate when canonicalPolicy kept `a`'s own name.
      const targetBucket = category(event.into.category);
      const existing = targetBucket.entities[event.from.canonical];
      if (existing && existing !== entity) {
        for (const alias of entity.aliases) {
          if (existing.aliases.indexOf(alias) === -1) existing.aliases.push(alias);
        }
      } else {
        targetBucket.entities[event.from.canonical] = entity;
      }
      state.pendingCrossCategoryMerge =
        event.from.canonical === event.into.canonical
          ? null
          : { category: event.into.category, movedName: event.from.canonical, requestedInto: event.into.canonical };
      return;
    }

    // Older / non-StreamingRepairer events (e.g. RegistryConsolidator's cross-category sweep,
    // RegistryConsolidator.ts:336-357): no follow-up merge event is ever logged for this pass — the
    // one event stands for both the move AND the merge — so fold both here, best-effort, under the
    // requested name (the only name this single event gives us).
    state.pendingCrossCategoryMerge = null;
    const target = ensureEntity(event.into.category, event.into.canonical, doc);
    for (const alias of entity.aliases) {
      if (target.aliases.indexOf(alias) === -1) target.aliases.push(alias);
    }
    return;
  }
};

/**
 * The exact source the page embeds — same functions the tests above the fold just ran.
 *
 * The `exports` shim is load-bearing: ts-node compiles this module to CommonJS, so a
 * cross-function call inside a compiled body becomes `(0, exports.docOf)(...)` — without the
 * shim the browser throws `exports is not defined` (caught by the real-browser check).
 */
export const REPLAY_SOURCE = [
  'var exports = {};',
  `exports.createEmptyState = ${createEmptyState.toString()};`,
  `exports.docOf = ${docOf.toString()};`,
  `exports.applyEvent = ${applyEvent.toString()};`,
  'var createEmptyState = exports.createEmptyState;',
  'var docOf = exports.docOf;',
  'var applyEvent = exports.applyEvent;',
].join('\n');
