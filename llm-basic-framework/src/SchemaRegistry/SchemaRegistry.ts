import { writeJsonAtomic } from '../utils/fsUtils';
import { sanitizeSchemaName } from '../utils/fsUtils';
import { matchStrings } from '../Normalization/matchStrings';
import { existsSync } from 'fs';
import fs from 'fs/promises';

export interface SchemaEntry {
  name: string;
  definition: string;
  examples: string[];
  aliases: string[];
  firstSeen: number;
}


export interface PairRuleEndpoint {
  category: string;
  role: string;
}

export interface PairRule {
  source: PairRuleEndpoint;
  target: PairRuleEndpoint;
  relation: string | null;
}

interface HistoryEntry {
  doc: number;
  op: string;
  name?: string;
  alias?: string;
  signature?: string;
}

interface SchemaData {
  categories: SchemaEntry[];
  relationTypes: SchemaEntry[];
  pairRules: PairRule[];
  history: HistoryEntry[];
}

interface Params {
  filePath: string;
}

type SchemaKind = 'category' | 'relationType';

export class SchemaRegistry {
  public readonly filePath: string;

  #data: SchemaData = { categories: [], relationTypes: [], pairRules: [], history: [] };
  #categoryAliasMap = new Map<string, string>();
  #relationTypeAliasMap = new Map<string, string>();
  #pairRuleIndex = new Map<string, PairRule>();
  #loaded = false;
  #dirty = false;

  constructor(params: Params) {
    this.filePath = params.filePath;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;

    if (existsSync(this.filePath)) {
      const content = await fs.readFile(this.filePath);
      const parsed = JSON.parse(content.toString());
      this.#data = {
        categories: parsed.categories || [],
        relationTypes: parsed.relationTypes || [],
        pairRules: parsed.pairRules || [],
        history: parsed.history || [],
      };
    }

    this.#rebuildIndexes();
    this.#loaded = true;
  }

  async save(): Promise<void> {
    if (!this.#dirty) return;
    await writeJsonAtomic(this.filePath, this.#data);
    this.#dirty = false;
  }

  resolveCategory(name: string): string | undefined {
    return this.#categoryAliasMap.get(name.trim().toLowerCase());
  }

  resolveRelationType(name: string): string | undefined {
    return this.#relationTypeAliasMap.get(name.trim().toLowerCase());
  }

  admitCategory(params: {
    name: string;
    definition: string;
    examples?: string[];
    doc: number;
  }): string {
    return this.#admit('category', params);
  }

  admitRelationType(params: {
    name: string;
    definition: string;
    examples?: string[];
    doc: number;
  }): string {
    return this.#admit('relationType', params);
  }

  addCategoryAlias(canonical: string, alias: string, doc: number): void {
    this.#addAlias('category', canonical, alias, doc);
  }

  addRelationTypeAlias(canonical: string, alias: string, doc: number): void {
    this.#addAlias('relationType', canonical, alias, doc);
  }

  signatureKey(a: PairRuleEndpoint, b: PairRuleEndpoint): string {
    const parts = [`${a.category}/${a.role}`, `${b.category}/${b.role}`].sort();
    return parts.join(' × ');
  }

  hasPairRule(key: string): boolean {
    return this.#pairRuleIndex.has(key);
  }

  getPairRule(key: string): PairRule | undefined {
    return this.#pairRuleIndex.get(key);
  }

  admitPairRule(rule: PairRule, doc: number): void {
    const key = this.signatureKey(rule.source, rule.target);
    if (this.#pairRuleIndex.has(key)) return;

    if (rule.relation !== null) {
      const canonical = this.resolveRelationType(rule.relation);
      if (!canonical) {
        console.warn(
          `SchemaRegistry: pair rule for "${key}" references unknown relation type "${rule.relation}" — storing as null`
        );
        rule = { ...rule, relation: null };
      } else {
        rule = { ...rule, relation: canonical };
      }
    }

    this.#data.pairRules.push(rule);
    this.#pairRuleIndex.set(key, rule);
    this.#data.history.push({ doc, op: 'admit-pair-rule', signature: key });
    this.#dirty = true;
  }

  findSimilarCategories(name: string, minSim = 0.5): Array<{ entry: SchemaEntry; sim: number }> {
    return this.#findSimilar(this.#data.categories, name, minSim);
  }

  findSimilarRelationTypes(name: string, minSim = 0.5): Array<{ entry: SchemaEntry; sim: number }> {
    return this.#findSimilar(this.#data.relationTypes, name, minSim);
  }

  renderKnownCategories(): string {
    return this.#renderEntries(this.#data.categories);
  }

  renderKnownRelationTypes(): string {
    return this.#renderEntries(this.#data.relationTypes);
  }

  getCategories(): SchemaEntry[] {
    return this.#data.categories;
  }

  getRelationTypes(): SchemaEntry[] {
    return this.#data.relationTypes;
  }

  getPairRules(): PairRule[] {
    return this.#data.pairRules;
  }

  getHistory(): HistoryEntry[] {
    return this.#data.history;
  }

  // RQ3 batch-reference harness support (RegistryConsolidator's schema pass — the only caller;
  // StreamingRepairer never mutates the schema registry): fold `from` (name + aliases) into
  // `into` as aliases
  mergeEntries(kind: SchemaKind, from: string, into: string, doc: number): void {
    const entries = kind === 'category' ? this.#data.categories : this.#data.relationTypes;
    const fromIndex = entries.findIndex((entry) => entry.name === from);
    const intoEntry = entries.find((entry) => entry.name === into);
    if (fromIndex === -1 || !intoEntry || from === into) return;

    const fromEntry = entries[fromIndex];
    for (const alias of [fromEntry.name, ...fromEntry.aliases]) {
      if (!intoEntry.aliases.includes(alias) && alias !== intoEntry.name) {
        intoEntry.aliases.push(alias);
      }
    }
    entries.splice(fromIndex, 1);
    this.#data.history.push({ doc, op: `merge-${kind}`, name: into, alias: from });

    // Re-point pair rules that referenced the merged category
    if (kind === 'category') {
      for (const rule of this.#data.pairRules) {
        if (rule.source.category === from) rule.source.category = into;
        if (rule.target.category === from) rule.target.category = into;
      }
    } else {
      for (const rule of this.#data.pairRules) {
        if (rule.relation === from) rule.relation = into;
      }
    }

    this.#rebuildIndexes();
    this.#dirty = true;
  }

  #admit(
    kind: SchemaKind,
    params: { name: string; definition: string; examples?: string[]; doc: number }
  ): string {
    const name = sanitizeSchemaName(params.name);
    if (!name) return params.name;

    // Resolve-first guard: re-admitting a known name is a no-op (crash-retry safe)
    const resolved = kind === 'category' ? this.resolveCategory(name) : this.resolveRelationType(name);
    if (resolved) return resolved;

    const entry: SchemaEntry = {
      name,
      definition: params.definition,
      examples: params.examples || [],
      aliases: [],
      firstSeen: params.doc,
    };

    const entries = kind === 'category' ? this.#data.categories : this.#data.relationTypes;
    entries.push(entry);
    this.#aliasMap(kind).set(name.toLowerCase(), name);
    this.#data.history.push({ doc: params.doc, op: `admit-${this.#opName(kind)}`, name });
    this.#dirty = true;
    return name;
  }

  #addAlias(kind: SchemaKind, canonical: string, alias: string, doc: number): void {
    const cleanAlias = sanitizeSchemaName(alias);
    if (!cleanAlias) return;

    const aliasMap = this.#aliasMap(kind);
    const resolved = aliasMap.get(cleanAlias.toLowerCase());
    if (resolved) return; // already resolvable (to this or another entry) — no-op

    const entries = kind === 'category' ? this.#data.categories : this.#data.relationTypes;
    const entry = entries.find((candidate) => candidate.name === canonical);
    if (!entry) {
      console.warn(`SchemaRegistry: cannot alias "${alias}" to unknown ${kind} "${canonical}"`);
      return;
    }

    entry.aliases.push(cleanAlias);
    aliasMap.set(cleanAlias.toLowerCase(), canonical);
    this.#data.history.push({
      doc,
      op: `alias-${this.#opName(kind)}`,
      name: canonical,
      alias: cleanAlias,
    });
    this.#dirty = true;
  }

  #findSimilar(
    entries: SchemaEntry[],
    name: string,
    minSim: number
  ): Array<{ entry: SchemaEntry; sim: number }> {
    // Near-matches are rendered into the type-judge PROMPT, so their order is model-visible — the
    // reason M2.5's (-sim, key) tie-break had to reach this path too, not just entity candidates.
    const matches = matchStrings(
      name,
      entries.map((entry) => ({ key: entry.name, strings: [entry.name, ...entry.aliases] })),
      { k: entries.length, minSim }
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return matches.map((match) => ({ entry: byName.get(match.key)!, sim: match.sim }));
  }

  #renderEntries(entries: SchemaEntry[]): string {
    if (entries.length === 0) return '  (none discovered yet)';
    return entries
      .map((entry) => {
        const examples = entry.examples.length ? ` (e.g., ${entry.examples.join(', ')})` : '';
        return `  * \`${entry.name}\`: ${entry.definition}${examples}`;
      })
      .join('\n');
  }

  #aliasMap(kind: SchemaKind): Map<string, string> {
    return kind === 'category' ? this.#categoryAliasMap : this.#relationTypeAliasMap;
  }

  #opName(kind: SchemaKind): string {
    return kind === 'category' ? 'category' : 'relation-type';
  }

  #rebuildIndexes(): void {
    this.#categoryAliasMap.clear();
    this.#relationTypeAliasMap.clear();
    this.#pairRuleIndex.clear();

    for (const entry of this.#data.categories) {
      this.#categoryAliasMap.set(entry.name.toLowerCase(), entry.name);
      for (const alias of entry.aliases) {
        this.#categoryAliasMap.set(alias.toLowerCase(), entry.name);
      }
    }
    for (const entry of this.#data.relationTypes) {
      this.#relationTypeAliasMap.set(entry.name.toLowerCase(), entry.name);
      for (const alias of entry.aliases) {
        this.#relationTypeAliasMap.set(alias.toLowerCase(), entry.name);
      }
    }
    for (const rule of this.#data.pairRules) {
      this.#pairRuleIndex.set(this.signatureKey(rule.source, rule.target), rule);
    }
  }
}
