import type { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';
import type { Concept, ConceptRegistry, ConceptRef } from '../ConceptRegistry/ConceptRegistry';
import { cosineNormalized, l2Normalize, meanPool } from '../utils/vectorUtils';

interface Params {
  embeddingsClient: EmbeddingsClient;
}

interface Entry {
  gloss: string | null;
  /** L2-normalized mean of the entity's surface vectors — see the class comment for the formula. */
  centroid: number[];
  /**
   * The canonical's own name+gloss vector, kept separately from `vectors` so `aliasCoherence`'s
   * leave-one-out pool always has an anchor even when the probed alias IS the canonical's own
   * surface (see the class comment's "leave-one-out" paragraph).
   */
  nameGlossVector: number[];
  /** Every unique surface text -> its L2-normalized vector (includes the canonical's own text). */
  vectors: Map<string, number[]>;
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
 * `Concept.labels` already stores the canonical as its own first alias (`ConceptRegistry
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
 * **Two different kinds of "stale", both handled, by two different mechanisms.** (1) *Merge/rename
 * staleness across documents* — a survivor enriched by `applyMerges`/`renameInto` in an earlier
 * document's repair step: fixed by the content-signature refresh above. (2) *Within one `processDoc`
 * call, `aliasCoherence` sees an alias that was linked earlier in the SAME document*:
 * `StreamingRepairer.processDoc` calls `glossIndex.sync(registry)` as its first step, but by then the
 * normalizer has already `link()`ed this document's new aliases into the very same registry instance
 * (the repairer hook runs as the last statement of `StreamingNormalizer#processFile`, after that
 * document's mints/links are committed) — so a content-aware `sync()` may already have folded a
 * just-linked alias into its entity's centroid by the time `SuspectGenerator` calls
 * `aliasCoherence(ref, thatAlias)` for it. Left alone, that would be a real bug: cosine
 * self-inclusion systematically inflates a probe's score against a centroid it is already part of,
 * so a wrongly-linked alias would tend to look "coherent" precisely in the common case the check
 * exists to catch. `aliasCoherence` therefore compares against a **leave-one-out** centroid — see
 * below — computed fresh on every call by excluding the probed alias's own vector, which makes the
 * result independent of whatever `sync()` happened to fold in beforehand. No call-order contract
 * with `StreamingRepairer`/`SuspectGenerator` is needed for correctness, only for freshness (an
 * un-synced brand-new canonical still has to be indexed at least once before either method works at
 * all). Note this corrects an earlier version of this comment, which reasoned that the *original*
 * (pre-signature-refresh) frozen-forever design "never actually delivered isolation" for this case —
 * that was an overstatement: freezing forever *did* protect the common case (a pre-existing,
 * already-indexed canonical gaining a same-document alias, which the frozen design would never
 * re-embed at all), and only failed the rarer merge/rename-enrichment case. Fixing that rarer case
 * with content-aware refresh reopened the common one, which is why leave-one-out exists — a fix that
 * covers both, unconditionally, rather than trading one staleness case for the other.
 *
 * **Leave-one-out mechanics.** Each entry keeps its component vectors, not only the pooled
 * `centroid`: `nameGlossVector` (the canonical's own name+gloss text, embedded and kept
 * unconditionally) plus `vectors` (every unique surface text -> vector, which — since
 * `Concept.labels` always lists the canonical as its own first alias — includes a second,
 * separately-keyed copy of the canonical's own text). `aliasCoherence(ref, alias)` embeds `alias`,
 * then pools `nameGlossVector` with every entry of `vectors` **except** the one whose text matches
 * the probed alias's own embed text, and compares the probe against that pool's centroid. If the
 * probed alias resolves to a surface with no other component (an entity with no aliases beyond its
 * own name, probed with that same name) the exclusion removes the sole `vectors` entry but
 * `nameGlossVector` remains, so the pool is never empty — comparing a lone canonical's own name
 * against its own name+gloss vector is the documented, deliberate edge case, not a crash.
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
  async sync(registry: ConceptRegistry): Promise<void> {
    const liveCategories = new Set(registry.conceptSchemes());
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

    for (const category of registry.conceptSchemes()) {
      const records = registry.concepts(category);
      const liveCanonicals = new Set(Object.keys(records));

      const bucket = this.#index.get(category);
      if (bucket) {
        for (const canonical of bucket.keys()) {
          if (!liveCanonicals.has(canonical)) bucket.delete(canonical);
        }
      }

      for (const [canonical, record] of Object.entries(records)) {
        const gloss = record.definition ?? null;
        const signature = this.#signatureFor(canonical, record);
        if (bucket?.get(canonical)?.signature === signature) continue; // unchanged since last sync

        pending.push({ category, canonical, gloss, signature, texts: this.#surfaceTexts(canonical, record, gloss) });
      }
    }

    if (pending.length === 0) return;

    const allTexts = [...new Set(pending.flatMap((entity) => entity.texts))];
    const embedded = await this.#client.embed(allTexts, { operator: 'gloss-index' });
    // Normalized once here rather than per-consumer — every reader of `byText` (the pooled centroid
    // AND each entry's `vectors` map, which `aliasCoherence`'s leave-one-out pools straight from)
    // wants the same L2-normalized vector, so there is no reason to redo it per read site.
    const byText = new Map(allTexts.map((text, position) => [text, l2Normalize(embedded[position])]));

    for (const { category, canonical, gloss, signature, texts } of pending) {
      const vectors = new Map(texts.map((text) => [text, byText.get(text)!]));
      const centroid = l2Normalize(meanPool([...vectors.values()]));
      const nameGlossVector = byText.get(this.#textFor(canonical, gloss))!;

      if (!this.#index.has(category)) this.#index.set(category, new Map());
      this.#index.get(category)!.set(canonical, { gloss, centroid, nameGlossVector, vectors, signature });
    }
  }

  /** ALL categories, self excluded — cross-category by design (repair suspects are not category-scoped). */
  async nearest(ref: ConceptRef, k: number): Promise<Array<{ ref: ConceptRef; sim: number }>> {
    const target = this.#entry(ref);

    const scored: Array<{ ref: ConceptRef; sim: number }> = [];
    for (const [category, bucket] of this.#index) {
      for (const [canonical, entry] of bucket) {
        if (category === ref.category && canonical === ref.canonical) continue;
        scored.push({ ref: { category, canonical }, sim: cosineNormalized(target.centroid, entry.centroid) });
      }
    }

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, k);
  }

  /**
   * cosine(embed(alias), leave-one-out entity centroid) — the alias text uses the entity's own
   * gloss, so a coherent alias embeds identically to how it would if `link()`ed and later picked up
   * by `EmbeddingGenerator`. "Leave-one-out": the comparison centroid excludes the probed alias's
   * own vector (matched by embed-text identity against `target.vectors`), so the result never
   * depends on whether `sync()` already folded this exact alias in — see the class comment's
   * "leave-one-out mechanics" paragraph for why that independence matters.
   */
  async aliasCoherence(ref: ConceptRef, alias: string): Promise<number> {
    const target = this.#entry(ref);
    const text = this.#textFor(alias, target.gloss);
    const probe = l2Normalize(await this.#client.embed(text, { operator: 'gloss-index' }));

    const pool: number[][] = [target.nameGlossVector];
    for (const [surfaceText, vector] of target.vectors) {
      if (surfaceText !== text) pool.push(vector);
    }

    const leaveOneOutCentroid = l2Normalize(meanPool(pool));
    return cosineNormalized(probe, leaveOneOutCentroid);
  }

  #entry(ref: ConceptRef): Entry {
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
  #surfaceTexts(canonical: string, record: Concept, gloss: string | null): string[] {
    const surfaces = new Set([canonical, ...record.labels.map((label) => label.surface)]);
    return [...new Set([...surfaces].map((surface) => this.#textFor(surface, gloss)))];
  }

  /**
   * Content fingerprint for staleness detection — gloss plus the sorted deduplicated surface set, so
   * an alias-order shuffle with no actual content change (never observed today, but not ruled out by
   * `Concept`'s shape either) can never look like a spurious re-embed.
   */
  #signatureFor(canonical: string, record: Concept): string {
    const surfaces = [...new Set([canonical, ...record.labels.map((label) => label.surface)])].sort();
    // The `gloss` JSON key is frozen in step with SuspectGenerator.signature's persisted dialect,
    // so the two "did the evidence change" fingerprints never look deceptively different.
    return JSON.stringify({ gloss: record.definition ?? null, surfaces });
  }

  /** Byte-identical to `EmbeddingGenerator#textFor`'s `name+gloss` branch — see the class comment. */
  #textFor(surface: string, gloss: string | null): string {
    return gloss ? `${surface}: ${gloss}` : surface;
  }
}
