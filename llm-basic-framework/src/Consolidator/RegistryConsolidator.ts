import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry, SchemaEntry } from '../SchemaRegistry/SchemaRegistry';
import { sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import { stringSimilarity } from '../utils/similarityUtils';
import { StreamingArtifact, extractAndParseJson } from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

interface Params {
  artifactsDir: string;
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  entityRegistry: EntityRegistry;
  decisionLog: DecisionLog;
  suspectSim?: number;
}

interface Merge {
  from: string;
  into: string;
}

// Optional repair step (spec §4.3) — manual trigger only, never scheduled.
// Objective: evidence-bounded merging only; never adds relations, never
// optimizes for graph connectivity.
export class RegistryConsolidator {
  #artifactsDir: string;
  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #entityRegistry: EntityRegistry;
  #decisionLog: DecisionLog;
  #suspectSim: number;

  constructor(params: Params) {
    this.#artifactsDir = params.artifactsDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#entityRegistry = params.entityRegistry;
    this.#decisionLog = params.decisionLog;
    this.#suspectSim = params.suspectSim ?? 0.7;
  }

  async run() {
    await this.#schemaRegistry.load();
    await this.#entityRegistry.load();

    console.time('CONSOLIDATE registry pass');
    await this.#registryPass();
    console.timeEnd('CONSOLIDATE registry pass');

    console.time('CONSOLIDATE schema pass');
    await this.#schemaPass();
    console.timeEnd('CONSOLIDATE schema pass');

    await this.#entityRegistry.save();
    await this.#schemaRegistry.save();

    console.time('CONSOLIDATE re-stamp');
    await this.#restampArtifacts();
    console.timeEnd('CONSOLIDATE re-stamp');

    console.log('Consolidation done. Re-run the streamingGraphBuilder step to rebuild the graph.');
  }

  // Pass 1: per-category duplicate canonical detection + LLM-reviewed merges
  async #registryPass() {
    for (const category of this.#entityRegistry.categories()) {
      const records = this.#entityRegistry.records(category);
      const canonicals = Object.keys(records);
      const suspects = new Set<string>();

      for (let i = 0; i < canonicals.length; i++) {
        for (let j = i + 1; j < canonicals.length; j++) {
          const aliasesA = records[canonicals[i]].aliases;
          const aliasesB = records[canonicals[j]].aliases;
          let maxSim = 0;
          for (const a of aliasesA) {
            for (const b of aliasesB) {
              maxSim = Math.max(maxSim, stringSimilarity(a, b));
            }
            if (maxSim >= this.#suspectSim) break;
          }
          if (maxSim >= this.#suspectSim) {
            suspects.add(canonicals[i]);
            suspects.add(canonicals[j]);
          }
        }
      }

      if (suspects.size === 0) continue;

      const merges = await this.#judgeMerges(
        `canonical entities of category "${category}" in a cyber-incident knowledge base`,
        [...suspects].map((name) => ({ name, aliases: records[name].aliases }))
      );

      const valid = merges.filter((merge) => records[merge.from] && records[merge.into]);
      this.#entityRegistry.applyMerges(category, valid);
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
    const merges = await this.#judgeMerges(
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
        this.#entityRegistry.moveCategory(merge.from, merge.into);
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

  async #judgeMerges(
    subject: string,
    items: Array<{ name: string; aliases: string[]; definition?: string }>
  ): Promise<Merge[]> {
    const lines = items.map((item) => {
      const definition = item.definition ? ` — ${item.definition}` : '';
      return `* "${item.name}"${definition} [aliases: ${item.aliases.join(', ') || 'none'}]`;
    });

    const instructions = `You review ${subject} for duplicates.
The entries below were flagged as suspiciously similar. Decide which are truly the SAME real-world concept under different names. Merge ONLY on naming evidence (shared names, stated aliases, unambiguous abbreviations) — similar type or theme alone is NOT identity. Never merge to make a graph more connected. When uncertain, do not merge. Prefer the more complete or more standard name as "into".

Output a single raw JSON object, no markdown fences, no commentary:
{ "merges": [ { "from": "<name to remove>", "into": "<name to keep>" } ] }
Return { "merges": [] } when nothing should merge.`;

    const started = Date.now();
    try {
      const result = await this.#llmClient.send(instructions, lines.join('\n'));
      const parsed = extractAndParseJson(result);
      const merges = Array.isArray(parsed?.merges) ? parsed!.merges : [];
      return merges.filter(
        (merge: Merge) =>
          typeof merge?.from === 'string' &&
          typeof merge?.into === 'string' &&
          merge.from.trim() &&
          merge.into.trim() &&
          merge.from !== merge.into
      );
    } catch (error) {
      console.error('CONSOLIDATE: merge-judge call failed, skipping this group:', error);
      return [];
    } finally {
      await this.#decisionLog.logLlmCall({
        doc: -1,
        kind: 'consolidate',
        seconds: (Date.now() - started) / 1000,
      });
    }
  }

  // Pass 3: deterministic re-stamp of artifacts through the updated alias→canonical maps.
  // No LLM, no re-extraction — the only permitted artifact mutation (spec §3.4).
  async #restampArtifacts() {
    if (!existsSync(this.#artifactsDir)) return;

    const files = sortByNumericId(await fs.readdir(this.#artifactsDir));
    let changed = 0;

    for (const file of files) {
      const filePath = `${this.#artifactsDir}/${file}`;
      const original = (await fs.readFile(filePath)).toString();
      const artifact = JSON.parse(original) as StreamingArtifact;

      for (const entity of artifact.entities) {
        entity.category = this.#schemaRegistry.resolveCategory(entity.category) || entity.category;
        const canonical = this.#entityRegistry.resolve(entity.category, entity.name);
        if (canonical) entity.normalizedName = canonical;
      }

      for (const relation of artifact.relations || []) {
        relation.headCategory =
          this.#schemaRegistry.resolveCategory(relation.headCategory) || relation.headCategory;
        relation.tailCategory =
          this.#schemaRegistry.resolveCategory(relation.tailCategory) || relation.tailCategory;
        const head = this.#entityRegistry.resolve(relation.headCategory, relation.head);
        if (head) relation.normalizedHead = head;
        const tail = this.#entityRegistry.resolve(relation.tailCategory, relation.tail);
        if (tail) relation.normalizedTail = tail;
      }

      const updated = JSON.stringify(artifact, undefined, 2);
      if (updated !== original) {
        await writeJsonAtomic(filePath, artifact);
        changed++;
      }
    }

    console.log(`Re-stamped ${changed}/${files.length} artifacts`);
  }
}
