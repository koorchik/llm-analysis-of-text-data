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
  rung?: string;
  deferred?: boolean;
  firstDoc: number;
}

export interface ReplayEdge {
  from: string;
  to: string;
  kind: string;
  by?: string;
  doc: number;
}

export interface ReplayCategoryState {
  entities: Record<string, ReplayEntity>;
  edges: ReplayEdge[];
  renames: ReplayEdge[];
}

export interface ReplayState {
  categories: Record<string, ReplayCategoryState>;
  /** category → ladder versions in discovery order (each the full cached payload). */
  ladders: Record<string, unknown[]>;
  counts: { links: number; mints: number; defers: number };
}

export const createEmptyState = function (): ReplayState {
  return { categories: {}, ladders: {}, counts: { links: 0, mints: 0, defers: 0 } };
};

/** The document an event belongs to; consolidator events (doc -1) form the repair chapter. */
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
    if (event.mentionRung && !entity.rung) entity.rung = event.mentionRung;
    return;
  }

  if (event.op === 'granularity-edge' && event.category) {
    const bucket = category(event.category);
    const exists = bucket.edges.some(function (edge) {
      return edge.from === event.from && edge.to === event.to && edge.kind === event.kind;
    });
    if (!exists) {
      ensureEntity(event.category, event.from, doc);
      ensureEntity(event.category, event.to, doc);
      bucket.edges.push({ from: event.from, to: event.to, kind: event.kind, by: event.by, doc });
    }
    if (event.mentionRung && bucket.entities[event.from] && !bucket.entities[event.from].rung) {
      bucket.entities[event.from].rung = event.mentionRung;
    }
    return;
  }

  if (event.op === 'rename-edge' && event.category) {
    const bucket = category(event.category);
    ensureEntity(event.category, event.from, doc);
    ensureEntity(event.category, event.to, doc);
    bucket.renames.push({ from: event.from, to: event.to, kind: 'renamed-to', by: event.by, doc });
    return;
  }

  if (event.op === 'discover-ladder' && event.category && event.outcome === 'cached') {
    if (!state.ladders[event.category]) state.ladders[event.category] = [];
    state.ladders[event.category].push(event.ladder);
    return;
  }

  if (event.op === 'merge-canonical' && event.category) {
    const bucket = category(event.category);
    const source = bucket.entities[event.from];
    const target = ensureEntity(event.category, event.into, doc);
    if (source) {
      for (const alias of source.aliases) {
        if (target.aliases.indexOf(alias) === -1) target.aliases.push(alias);
      }
      if (!target.rung && source.rung) target.rung = source.rung;
      delete bucket.entities[event.from];
    }
    const project = function (name: string): string {
      return name === event.from ? event.into : name;
    };
    bucket.edges = bucket.edges
      .map(function (edge) {
        return { from: project(edge.from), to: project(edge.to), kind: edge.kind, by: edge.by, doc: edge.doc };
      })
      .filter(function (edge) {
        return edge.from !== edge.to;
      });
    bucket.renames = bucket.renames
      .map(function (edge) {
        return { from: project(edge.from), to: project(edge.to), kind: edge.kind, by: edge.by, doc: edge.doc };
      })
      .filter(function (edge) {
        return edge.from !== edge.to;
      });
    return;
  }

  if (event.op === 'split-canonical' && event.category) {
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
    const target = ensureEntity(event.into.category, event.into.canonical, doc);
    for (const alias of entity.aliases) {
      if (target.aliases.indexOf(alias) === -1) target.aliases.push(alias);
    }
    fromBucket.edges = fromBucket.edges.filter(function (edge) {
      return edge.from !== event.from.canonical && edge.to !== event.from.canonical;
    });
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
