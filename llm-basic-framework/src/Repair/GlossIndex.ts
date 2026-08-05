import type { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';
import type { CanonicalRecord, EntityRegistry, EntityRef } from '../EntityRegistry/EntityRegistry';
import { cosineNormalized, l2Normalize, meanPool } from '../utils/vectorUtils';

interface Params {
  embeddingsClient: EmbeddingsClient;
}

interface Entry {
  gloss: string | null;
  /** L2-normalized mean of the entity's surface vectors — see the class comment for the formula. */
  centroid: number[];
  /** Content fingerprint (gloss + sorted surface set) as of the sync() that produced this entry. */
  signature: string;
}

/**
 * Dense retrieval over the *repair* layer's entities — the StreamingRepairer's own index, separate
 * from `EmbeddingGenerator`'s (M4/E4 candidate generator for the normalizer's blocker).
 *
 * **Brute-force cosine, explicitly no ANN index** — same rejection as `EmbeddingGenerator`
 * (`EmbeddingGenerator.ts:41-43`): "At ~2,674 canonicals an index is scale theatre — the same
 * argument `StringSimilarityGenerator` already makes for its own linear scan. This is a documented
 * rejection for the paper, not an oversight." Nothing about the repair layer changes that scale, so
 * the same call applies here rather than earning its own analysis.
 *
 * **Text format is `` `${surface}: ${gloss}` `` (bare `surface` when `gloss` is null)** — byte-
 * identical to `EmbeddingGenerator#textFor`'s `name+gloss` branch, deliberately, so both indexes
 * embed the same string for the same surface and `EmbeddingsClient`'s on-disk `(model, text)` cache
 * is shared between them rather than each paying for its own copy of every embedding call.
 *
 * **Centroid = `l2Normalize(meanPool(...))` of every unique surface vector (canonical name + every
 * alias), each individually `l2Normalize`d first** — the same "normalize once, cosine is a dot
 * product" discipline `EmbeddingGenerator`'s `centroid` cluster representation uses. This is an
 * implementation choice flagged per design R6, not the only reachable one: an alternative would
 * weight the canonical's own name+gloss vector separately from the alias-surface vectors (e.g. a
 * fixed blend ratio) instead of pooling all surfaces uniformly. Uniform pooling was picked because
 * `CanonicalRecord.aliases` already stores the canonical as its own first alias (`EntityRegistry
 * .mint`), so "alias-surface vectors" and "the name+gloss vector" are already the same set in
 * practice — a separate weighted term would double-count the canonical's own surface for no signal.
 *
 * **`sync(registry)` is content-aware, not just presence-aware.** Each indexed entry carries a
 * signature (`gloss` + the sorted deduplicated surface set) computed from the registry record; a
 * canonical is re-embedded whenever its live signature differs from the one it was last indexed
 * under, not only when it is missing outright. A canonical absent from the registry (merged away,
 * split out from under its old name, ...) is dropped on the next `sync()`. This makes the index a
 * true pure function of persisted registry state (task brief) end to end: a crash between docs loses
 * nothing, because the next `sync()` rebuilds exactly the live set with exactly its live content —
 * including a survivor that `applyMerges`/`renameInto` enriched with absorbed aliases and/or a
 * backfilled `gloss` (`if (!target.gloss && source.gloss) target.gloss = source.gloss`) in a
 * *previous* document's repair step. Re-embedding is cheap: `EmbeddingsClient`'s disk cache is keyed
 * on `(model, text)`, so only genuinely new surface texts cost an API call — everything the merge
 * carried over from the absorbed canonical was very likely embedded already.
 *
 * **Two different kinds of "stale" — only one of which this class defends against.** (1) *Merge/
 * rename staleness across documents*: fixed by the content-signature refresh above. (2) *Within one
 * `processDoc` call, `aliasCoherence` sees an alias that was linked earlier in the SAME document*:
 * `StreamingRepairer.processDoc` calls `glossIndex.sync(registry)` as its first step, but by then the
 * normalizer has already `link()`ed this document's new aliases into the very same registry instance
 * (the repairer hook runs as the last statement of `StreamingNormalizer#processFile`, after that
 * document's mints/links are committed) — so a content-aware `sync()` has already folded a
 * just-linked alias into its entity's centroid by the time `SuspectGenerator` calls
 * `aliasCoherence(ref, thatAlias)` for it. This is **not** a bug this class tries to prevent: there is
 * no signal available to `sync()` that would let it tell "linked this document, not yet vetted" apart
 * from "linked several documents ago and long since trusted" — both are just current registry
 * content. The check therefore answers "does this alias fit the entity's *currently recorded*
 * identity" (which, once linked, includes itself) rather than "did this alias look right before
 * anyone recorded it" — a real characteristic of the call order, not a contamination defect, and its
 * effect shrinks as an entity accumulates more pre-existing aliases.
 */
export class GlossIndex {
  #client: EmbeddingsClient;
  /** category -> canonical -> entry. */
  #index = new Map<string, Map<string, Entry>>();

  constructor(params: Params) {
    this.#client = params.embeddingsClient;
  }

  /**
   * Content-aware diff against the registry's live categories/canonicals: (re-)embeds any canonical
   * whose current signature (gloss + surface set) differs from what it was last indexed under —
   * covers both "not indexed yet" and "indexed but enriched since" (merge/rename absorption) — in ONE
   * batched call across every such canonical, and drops entries for canonicals no longer live. A
   * no-op call — nothing minted, linked, merged, split or renamed since the last `sync()` — embeds
   * nothing.
   */
  async sync(registry: EntityRegistry): Promise<void> {
    const liveCategories = new Set(registry.categories());
    for (const category of this.#index.keys()) {
      if (!liveCategories.has(category)) this.#index.delete(category);
    }

    const pending: Array<{
      category: string;
      canonical: string;
      gloss: string | null;
      signature: string;
      texts: string[];
    }> = [];

    for (const category of registry.categories()) {
      const records = registry.records(category);
      const liveCanonicals = new Set(Object.keys(records));

      const bucket = this.#index.get(category);
      if (bucket) {
        for (const canonical of bucket.keys()) {
          if (!liveCanonicals.has(canonical)) bucket.delete(canonical);
        }
      }

      for (const [canonical, record] of Object.entries(records)) {
        const gloss = record.gloss ?? null;
        const signature = this.#signatureFor(canonical, record);
        if (bucket?.get(canonical)?.signature === signature) continue; // unchanged since last sync

        pending.push({ category, canonical, gloss, signature, texts: this.#surfaceTexts(canonical, record, gloss) });
      }
    }

    if (pending.length === 0) return;

    const allTexts = [...new Set(pending.flatMap((entity) => entity.texts))];
    const embedded = await this.#client.embed(allTexts, { operator: 'gloss-index' });
    const byText = new Map(allTexts.map((text, position) => [text, embedded[position]]));

    for (const { category, canonical, gloss, signature, texts } of pending) {
      const vectors = texts.map((text) => l2Normalize(byText.get(text)!));
      const centroid = l2Normalize(meanPool(vectors));

      if (!this.#index.has(category)) this.#index.set(category, new Map());
      this.#index.get(category)!.set(canonical, { gloss, centroid, signature });
    }
  }

  /** ALL categories, self excluded — cross-category by design (repair suspects are not category-scoped). */
  async nearest(ref: EntityRef, k: number): Promise<Array<{ ref: EntityRef; sim: number }>> {
    const target = this.#entry(ref);

    const scored: Array<{ ref: EntityRef; sim: number }> = [];
    for (const [category, bucket] of this.#index) {
      for (const [canonical, entry] of bucket) {
        if (category === ref.category && canonical === ref.canonical) continue;
        scored.push({ ref: { category, canonical }, sim: cosineNormalized(target.centroid, entry.centroid) });
      }
    }

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, k);
  }

  /** cosine(embed(alias), entity centroid) — the alias text uses the entity's own gloss, so a coherent alias embeds identically to how it would if `link()`ed and later picked up by `EmbeddingGenerator`. */
  async aliasCoherence(ref: EntityRef, alias: string): Promise<number> {
    const target = this.#entry(ref);
    const text = this.#textFor(alias, target.gloss);
    const vector = l2Normalize(await this.#client.embed(text, { operator: 'gloss-index' }));
    return cosineNormalized(vector, target.centroid);
  }

  #entry(ref: EntityRef): Entry {
    const entry = this.#index.get(ref.category)?.get(ref.canonical);
    if (!entry) {
      throw new Error(
        `GlossIndex: unknown entity ${ref.category}/"${ref.canonical}" — sync(registry) must run first ` +
          'and the entity must still be live (not merged/split/renamed away)'
      );
    }
    return entry;
  }

  /** `[canonical, ...aliasSurfaces]`, de-duplicated, each rendered through the shared name+gloss format. */
  #surfaceTexts(canonical: string, record: CanonicalRecord, gloss: string | null): string[] {
    const surfaces = new Set([canonical, ...record.aliases.map((alias) => alias.surface)]);
    return [...new Set([...surfaces].map((surface) => this.#textFor(surface, gloss)))];
  }

  /**
   * Content fingerprint for staleness detection — gloss plus the sorted deduplicated surface set, so
   * an alias-order shuffle with no actual content change (never observed today, but not ruled out by
   * `CanonicalRecord`'s shape either) can never look like a spurious re-embed.
   */
  #signatureFor(canonical: string, record: CanonicalRecord): string {
    const surfaces = [...new Set([canonical, ...record.aliases.map((alias) => alias.surface)])].sort();
    return JSON.stringify({ gloss: record.gloss ?? null, surfaces });
  }

  /** Byte-identical to `EmbeddingGenerator#textFor`'s `name+gloss` branch — see the class comment. */
  #textFor(surface: string, gloss: string | null): string {
    return gloss ? `${surface}: ${gloss}` : surface;
  }
}
