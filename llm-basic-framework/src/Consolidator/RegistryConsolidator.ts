import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { DeferredPair, ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import {
  confusableSkeletonAnalyzer,
  transliterateAnalyzer,
} from '../Normalization/analyzers';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { restampArtifacts } from '../Repair/restampArtifacts';
import { SchemaRegistry, SchemaEntry } from '../SchemaRegistry/SchemaRegistry';
import { stringSimilarity } from '../utils/similarityUtils';
import { extractAndParseJson } from '../utils/validationUtils';

interface Params {
  artifactsDir: string;
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  conceptRegistry: ConceptRegistry;
  decisionLog: DecisionLog;
  suspectSim?: number;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
}

interface Merge {
  from: string;
  into: string;
}

/** The full SKEIN v2 repair review — merge is one verdict among four, not the whole vocabulary. */
interface RegistryReview {
  merges: Merge[];
  edges: Array<{ finer: string; coarser: string; kind: 'coarsens-to' | 'part-of' }>;
  renames: Array<{ old: string; new: string }>;
  splits: Array<{ canonical: string; detach: string[] }>;
}

/**
 * Union-blocker-shaped suspect signals over alias sets, max-over-aliases: plain string similarity,
 * shared transliteration/confusable skeleton key (the Cyrillic↔Latin channel), and char-3-gram
 * Jaccard. Recall channels only — every hit still goes through the LLM review.
 */
function pairSuspicious(aliasesA: string[], aliasesB: string[], suspectSim: number): boolean {
  const ctx = { category: '' };
  const skeletons = (surfaces: string[]) => {
    const keys = new Set<string>();
    for (const surface of surfaces) {
      for (const analyzer of [transliterateAnalyzer, confusableSkeletonAnalyzer]) {
        for (const key of analyzer.keys(surface, ctx)) {
          if (key.trim()) keys.add(key);
        }
      }
    }
    return keys;
  };

  for (const a of aliasesA) {
    for (const b of aliasesB) {
      if (stringSimilarity(a, b) >= suspectSim) return true;
      if (trigramJaccard(a, b) >= 0.5) return true;
    }
  }
  const skeletonsA = skeletons(aliasesA);
  for (const key of skeletons(aliasesB)) {
    if (skeletonsA.has(key)) return true;
  }
  return false;
}

function trigramJaccard(a: string, b: string): number {
  const grams = (value: string) => {
    const folded = value.toLowerCase().replace(/\s+/g, ' ').trim();
    const out = new Set<string>();
    for (let i = 0; i + 3 <= folded.length; i++) out.add(folded.slice(i, i + 3));
    return out;
  };
  const gramsA = grams(a);
  const gramsB = grams(b);
  if (gramsA.size === 0 || gramsB.size === 0) return 0;
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return shared / (gramsA.size + gramsB.size - shared);
}

/**
 * RQ3 batch-reference evaluation harness — regime (ii) of E6. Never wired into the pipeline (spec
 * §4.3 superseded 2026-08-05; see dissert wiki streaming-repair-design). Runs only via
 * `bin/batch-reference.ts` against a COPY of a run directory.
 *
 * Consumes the defer queue on entry — the NAIVE arm (REPAIR=0) mints straight through and only
 * pushes to `deferQueue`, so this class is the only consumer of it (T12). Its `restampArtifacts`
 * call passes no `files` filter, so it re-stamps every artifact in `artifactsDir`; that parameter
 * belongs to T9's per-document repairer, which restricts the re-stamp to one document's affected
 * set — nothing here needs that narrower path. Every op it logs carries `doc: -1`; the playback
 * viewer (T11) labels that run the "batch-reference chapter".
 *
 * Objective: evidence-bounded merging only; never adds relations, never
 * optimizes for graph connectivity.
 */
export class RegistryConsolidator {
  #artifactsDir: string;
  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #conceptRegistry: ConceptRegistry;
  #decisionLog: DecisionLog;
  #suspectSim: number;

  #prompts: PromptProvider;

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.#artifactsDir = params.artifactsDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#conceptRegistry = params.conceptRegistry;
    this.#decisionLog = params.decisionLog;
    this.#suspectSim = params.suspectSim ?? 0.7;
  }

  async run() {
    await this.#schemaRegistry.load();
    await this.#conceptRegistry.load();

    console.time('CONSOLIDATE registry pass');
    await this.#registryPass();
    console.timeEnd('CONSOLIDATE registry pass');

    console.time('CONSOLIDATE cross-category sweep');
    await this.#crossCategorySweep();
    console.timeEnd('CONSOLIDATE cross-category sweep');

    console.time('CONSOLIDATE schema pass');
    await this.#schemaPass();
    console.timeEnd('CONSOLIDATE schema pass');

    await this.#conceptRegistry.save();
    await this.#schemaRegistry.save();

    console.time('CONSOLIDATE re-stamp');
    // Prints "Re-stamped 0/0 artifacts" even when artifactsDir is missing (cosmetic change from the
    // pre-extraction private method, which printed nothing on that early-return path).
    const { changed, total } = await restampArtifacts({
      artifactsDir: this.#artifactsDir,
      conceptRegistry: this.#conceptRegistry,
      schemaRegistry: this.#schemaRegistry,
    });
    console.log(`Re-stamped ${changed}/${total} artifacts`);
    console.timeEnd('CONSOLIDATE re-stamp');

    console.log('Consolidation done. Re-run the streamingGraphBuilder step to rebuild the graph.');
  }

  // Pass 1: per-category repair — merge / edge / rename / split, over union-blocker-shaped
  // suspects plus every pair the streaming judge deferred (SKEIN v2 full repair inventory:
  // merge-only greedy is a known-weak configuration, gruenheid2014incremental).
  async #registryPass() {
    const deferredByCategory = new Map<string, DeferredPair[]>();
    for (const entry of this.#conceptRegistry.deferred()) {
      deferredByCategory.set(entry.category, [
        ...(deferredByCategory.get(entry.category) ?? []),
        entry,
      ]);
    }

    for (const category of this.#conceptRegistry.conceptSchemes()) {
      const records = this.#conceptRegistry.concepts(category);
      const canonicals = Object.keys(records);
      const suspects = new Set<string>();

      // v2 stores alias records; similarity and the judge prompt both want plain surfaces.
      // Cached per canonical so the O(n²) sweep below does not re-project on every comparison.
      const surfaces = new Map<string, string[]>(
        canonicals.map((canonical) => [canonical, this.#conceptRegistry.labelSurfaces(category, canonical)])
      );

      for (let i = 0; i < canonicals.length; i++) {
        for (let j = i + 1; j < canonicals.length; j++) {
          if (pairSuspicious(surfaces.get(canonicals[i])!, surfaces.get(canonicals[j])!, this.#suspectSim)) {
            suspects.add(canonicals[i]);
            suspects.add(canonicals[j]);
          }
        }
      }

      // Every deferred pair is review input regardless of similarity — the judge already said
      // "cannot decide", so the queue bypasses the blocker.
      const deferredHere = deferredByCategory.get(category) ?? [];
      for (const entry of deferredHere) {
        if (records[entry.mintedAs]) suspects.add(entry.mintedAs);
        for (const candidate of entry.candidates) {
          if (records[candidate]) suspects.add(candidate);
        }
      }

      if (suspects.size === 0) continue;

      const review = await this.#judgeReview(
        `canonical entities of category "${category}" in a cyber-incident knowledge base`,
        [...suspects].map((name) => ({ name, aliases: surfaces.get(name) ?? [] }))
      );

      const valid = review.merges.filter((merge) => records[merge.from] && records[merge.into]);
      this.#conceptRegistry.applyMerges(category, valid);
      for (const merge of valid) {
        console.log(`MERGE ${category}: "${merge.from}" -> "${merge.into}"`);
        await this.#decisionLog.log({
          doc: -1,
          op: 'merge-canonical',
          category,
          from: merge.from,
          into: merge.into,
          by: 'RegistryConsolidator',
        });
      }

      for (const edge of review.edges) {
        // Endpoints may have just merged — re-resolve before writing.
        const finer = this.#conceptRegistry.resolve(category, edge.finer);
        const coarser = this.#conceptRegistry.resolve(category, edge.coarser);
        if (!finer || !coarser || finer === coarser) continue;
        // The consolidator's review prompt still answers in the legacy kind vocabulary (frozen
        // LLM-output dialect); it maps onto the ISO 25964 typing here. No embeddings client in
        // this path → null similarityScore.
        const type = edge.kind === 'coarsens-to' ? ('broaderGeneric' as const) : ('broaderPartitive' as const);
        const added = this.#conceptRegistry.addBroaderEdge(category, {
          narrower: finer,
          broader: coarser,
          type,
          similarityScore: null,
          docId: -1,
          decision: 'consolidator',
        });
        if (added) {
          console.log(`EDGE ${category}: "${finer}" -[${type}]-> "${coarser}"`);
          await this.#decisionLog.log({
            doc: -1,
            op: 'broader-edge',
            category,
            narrower: finer,
            broader: coarser,
            type,
            by: 'RegistryConsolidator',
          });
        }
      }

      for (const rename of review.renames) {
        const from = this.#conceptRegistry.resolve(category, rename.old);
        const to = this.#conceptRegistry.resolve(category, rename.new);
        if (!from || !to || from === to) continue;
        if (this.#conceptRegistry.addRenameEdge(category, {
          from,
          to,
          docId: -1,
          decision: 'consolidator',
        })) {
          console.log(`RENAME ${category}: "${from}" -> "${to}"`);
          await this.#decisionLog.log({
            doc: -1,
            op: 'rename-edge',
            category,
            from,
            to,
            by: 'RegistryConsolidator',
          });
        }
      }

      for (const split of review.splits) {
        if (!records[split.canonical] || split.detach.length === 0) continue;
        const result = this.#conceptRegistry.split(category, split.canonical, split.detach);
        if (result) {
          console.log(
            `SPLIT ${category}: "${split.canonical}" detached [${result.moved.join(', ')}] -> "${result.newCanonical}"`
          );
          await this.#decisionLog.log({
            doc: -1,
            op: 'split-canonical',
            category,
            canonical: split.canonical,
            detached: result.moved,
            newCanonical: result.newCanonical,
            by: 'RegistryConsolidator',
          });
        }
      }

      // Reviewed = consumed, whatever the verdict; pairs the review left alone were judged
      // distinct-enough and must not re-queue forever.
      if (deferredHere.length > 0) this.#conceptRegistry.clearDeferred(deferredHere);
    }
  }

  /**
   * Cross-category sweep: upstream extractors misassign categories (`Sandworm` as HackerGroup in
   * one document, Organization in another), and per-category blocking makes such duplicates
   * invisible to the streaming loop. High-confidence signal only — an exact case-folded surface
   * shared by canonicals in two categories — then the same LLM review; a confirmed duplicate
   * merges and records the category correction.
   */
  async #crossCategorySweep() {
    const categories = this.#conceptRegistry.conceptSchemes();
    const bySurface = new Map<string, Array<{ category: string; canonical: string }>>();
    for (const category of categories) {
      for (const [canonical, record] of Object.entries(this.#conceptRegistry.concepts(category))) {
        for (const alias of record.labels) {
          const key = alias.surface.trim().toLowerCase();
          if (!key) continue;
          const owners = bySurface.get(key) ?? [];
          if (!owners.some((owner) => owner.category === category && owner.canonical === canonical)) {
            owners.push({ category, canonical });
          }
          bySurface.set(key, owners);
        }
      }
    }

    const suspects = new Map<string, { category: string; canonical: string }>();
    for (const owners of bySurface.values()) {
      const distinctCategories = new Set(owners.map((owner) => owner.category));
      if (distinctCategories.size < 2) continue;
      for (const owner of owners) {
        suspects.set(`${owner.category}/${owner.canonical}`, owner);
      }
    }
    if (suspects.size === 0) return;

    const review = await this.#judgeReview(
      'canonical entities that appear under MORE THAN ONE category of a cyber-incident knowledge base (each entry is "Category/Name"; a merge means the two entries are one real-world entity and "into" names its CORRECT category)',
      [...suspects.values()].map((owner) => ({
        name: `${owner.category}/${owner.canonical}`,
        aliases: this.#conceptRegistry.labelSurfaces(owner.category, owner.canonical),
      }))
    );

    for (const merge of review.merges) {
      const from = suspects.get(merge.from.trim());
      const into = suspects.get(merge.into.trim());
      if (!from || !into || (from.category === into.category && from.canonical === into.canonical)) {
        continue;
      }
      if (from.category !== into.category) {
        if (!this.#conceptRegistry.move(from.category, from.canonical, into.category)) continue;
      }
      if (from.canonical !== into.canonical) {
        this.#conceptRegistry.applyMerges(into.category, [
          { from: from.canonical, into: into.canonical },
        ]);
      }
      console.log(
        `CROSS-CATEGORY ${from.category}/"${from.canonical}" -> ${into.category}/"${into.canonical}"`
      );
      // The category correction is a result in its own right: reported, and fed back upstream.
      await this.#decisionLog.log({
        doc: -1,
        op: 'category-correction',
        from: { category: from.category, canonical: from.canonical },
        into: { category: into.category, canonical: into.canonical },
        by: 'RegistryConsolidator',
      });
    }
  }

  // Pass 2: schema categories and relation types whose alias sets have drifted together
  async #schemaPass() {
    await this.#schemaEntriesPass('category', this.#schemaRegistry.getCategories());
    await this.#schemaEntriesPass('relationType', this.#schemaRegistry.getRelationTypes());
  }

  async #schemaEntriesPass(kind: 'category' | 'relationType', entries: SchemaEntry[]) {
    const suspects = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const stringsA = [entries[i].name, ...entries[i].aliases];
        const stringsB = [entries[j].name, ...entries[j].aliases];
        let maxSim = 0;
        for (const a of stringsA) {
          for (const b of stringsB) {
            maxSim = Math.max(maxSim, stringSimilarity(a, b));
          }
        }
        if (maxSim >= this.#suspectSim) {
          suspects.add(entries[i].name);
          suspects.add(entries[j].name);
        }
      }
    }

    if (suspects.size === 0) return;

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    // Schema entries use only the merge verdict; edge/rename/split make no sense for categories
    // and are ignored if the model emits them here.
    const { merges } = await this.#judgeReview(
      kind === 'category'
        ? 'entity categories of an emergent cyber-incident schema'
        : 'relation types of an emergent cyber-incident schema',
      [...suspects].map((name) => {
        const entry = byName.get(name)!;
        return { name, aliases: entry.aliases, definition: entry.definition };
      })
    );

    for (const merge of merges) {
      if (!byName.has(merge.from) || !byName.has(merge.into)) continue;
      console.log(`MERGE ${kind}: "${merge.from}" -> "${merge.into}"`);
      this.#schemaRegistry.mergeEntries(kind, merge.from, merge.into, -1);
      if (kind === 'category') {
        // Registry buckets are keyed by canonical category — must follow the merge
        this.#conceptRegistry.moveCategory(merge.from, merge.into);
      }
      await this.#decisionLog.log({
        doc: -1,
        op: `merge-${kind === 'category' ? 'category' : 'relation-type'}`,
        from: merge.from,
        into: merge.into,
        by: 'RegistryConsolidator',
      });
    }
  }

  async #judgeReview(
    subject: string,
    items: Array<{ name: string; aliases: string[]; definition?: string }>
  ): Promise<RegistryReview> {
    const empty: RegistryReview = { merges: [], edges: [], renames: [], splits: [] };
    const lines = items.map((item) => {
      const definition = item.definition ? ` — ${item.definition}` : '';
      return `* "${item.name}"${definition} [aliases: ${item.aliases.join(', ') || 'none'}]`;
    });

    const instructions = this.#prompts.render('consolidate-merge', { subject });

    const started = Date.now();
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(instructions, lines.join('\n'), {
        operator: 'consolidate',
        docId: null,
      });
      const parsed = extractAndParseJson(response.text);
      const asArray = (value: unknown) => (Array.isArray(value) ? value : []);
      return {
        merges: asArray(parsed?.merges).filter(
          (merge: Merge) =>
            typeof merge?.from === 'string' &&
            typeof merge?.into === 'string' &&
            merge.from.trim() &&
            merge.into.trim() &&
            merge.from !== merge.into
        ),
        edges: asArray(parsed?.edges).filter(
          (edge: RegistryReview['edges'][number]) =>
            typeof edge?.finer === 'string' &&
            typeof edge?.coarser === 'string' &&
            edge.finer.trim() &&
            edge.coarser.trim() &&
            edge.finer !== edge.coarser &&
            (edge.kind === 'coarsens-to' || edge.kind === 'part-of')
        ),
        renames: asArray(parsed?.renames).filter(
          (rename: RegistryReview['renames'][number]) =>
            typeof rename?.old === 'string' &&
            typeof rename?.new === 'string' &&
            rename.old.trim() &&
            rename.new.trim() &&
            rename.old !== rename.new
        ),
        splits: asArray(parsed?.splits).filter(
          (split: RegistryReview['splits'][number]) =>
            typeof split?.canonical === 'string' &&
            split.canonical.trim() &&
            Array.isArray(split?.detach) &&
            split.detach.every((surface: unknown) => typeof surface === 'string')
        ),
      };
    } catch (error) {
      console.error('CONSOLIDATE: review call failed, skipping this group:', error);
      return empty;
    } finally {
      await this.#decisionLog.logLlmCall({
        doc: -1,
        kind: 'consolidate',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }
}
