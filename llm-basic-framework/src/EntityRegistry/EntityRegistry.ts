import { writeJsonAtomic } from '../utils/fsUtils';
import { bestMatches } from '../utils/similarityUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

export interface CanonicalRecord {
  aliases: string[];
  firstSeen: { doc: number; date: string };
}

type RegistryData = Record<string, Record<string, CanonicalRecord>>;

interface Params {
  filePath: string;
}

export class EntityRegistry {
  public readonly filePath: string;

  #data: RegistryData = {};
  #aliasIndex = new Map<string, Map<string, string>>(); // category → lowercased alias → canonical
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
      this.#data = JSON.parse(content.toString());
    }

    this.#rebuildIndex();
    this.#loaded = true;
  }

  async save(): Promise<void> {
    if (!this.#dirty) return;
    await writeJsonAtomic(this.filePath, this.#data);
    this.#dirty = false;
  }

  // Exact fast path (spec §4.2 step 1)
  resolve(category: string, name: string): string | undefined {
    return this.#aliasIndex.get(category)?.get(name.trim().toLowerCase());
  }

  // Candidate generation (spec §4.2 step 2) — the future embeddings/ANN swap point
  candidates(
    category: string,
    name: string,
    options: { k?: number; minSim?: number } = {}
  ): Array<{ name: string; sim: number; aliases: string[] }> {
    const records = this.#data[category];
    if (!records) return [];

    const matches = bestMatches(
      name,
      Object.entries(records).map(([canonical, record]) => ({
        key: canonical,
        strings: [canonical, ...record.aliases],
      })),
      options
    );
    return matches.map((match) => ({
      name: match.key,
      sim: match.sim,
      aliases: records[match.key].aliases,
    }));
  }

  link(category: string, canonicalName: string, alias: string): void {
    const record = this.#data[category]?.[canonicalName];
    if (!record) {
      console.warn(`EntityRegistry: cannot link "${alias}" to unknown ${category}/"${canonicalName}"`);
      return;
    }

    const aliasKey = alias.trim().toLowerCase();
    if (this.#aliasIndex.get(category)?.has(aliasKey)) return; // idempotent

    record.aliases.push(alias.trim());
    this.#categoryIndex(category).set(aliasKey, canonicalName);
    this.#dirty = true;
  }

  mint(category: string, name: string, firstSeen: { doc: number; date: string }): string {
    const existing = this.resolve(category, name);
    if (existing) return existing; // resolve-first guard (crash-retry safe)

    const canonical = name.trim();
    if (!this.#data[category]) this.#data[category] = {};
    this.#data[category][canonical] = { aliases: [canonical], firstSeen };
    this.#categoryIndex(category).set(canonical.toLowerCase(), canonical);
    this.#dirty = true;
    return canonical;
  }

  categories(): string[] {
    return Object.keys(this.#data);
  }

  records(category: string): Record<string, CanonicalRecord> {
    return this.#data[category] || {};
  }

  aliasToCanonicalMap(category: string): Map<string, string> {
    return new Map(this.#categoryIndex(category));
  }

  applyMerges(category: string, merges: Array<{ from: string; into: string }>): void {
    const records = this.#data[category];
    if (!records) return;

    for (const { from, into } of merges) {
      if (from === into || !records[from] || !records[into]) continue;

      const fromRecord = records[from];
      const intoRecord = records[into];
      for (const alias of fromRecord.aliases) {
        if (!intoRecord.aliases.includes(alias)) intoRecord.aliases.push(alias);
      }
      // Keep the earliest firstSeen
      if (fromRecord.firstSeen.doc < intoRecord.firstSeen.doc) {
        intoRecord.firstSeen = fromRecord.firstSeen;
      }
      delete records[from];
      this.#dirty = true;
    }

    this.#rebuildIndex();
  }

  // For schema-level category merges: registry buckets are keyed by canonical category
  moveCategory(from: string, into: string): void {
    const fromRecords = this.#data[from];
    if (!fromRecords || from === into) return;

    if (!this.#data[into]) this.#data[into] = {};
    const intoRecords = this.#data[into];

    for (const [canonical, record] of Object.entries(fromRecords)) {
      const existing = intoRecords[canonical];
      if (existing) {
        for (const alias of record.aliases) {
          if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
        }
        if (record.firstSeen.doc < existing.firstSeen.doc) {
          existing.firstSeen = record.firstSeen;
        }
      } else {
        intoRecords[canonical] = record;
      }
    }

    delete this.#data[from];
    this.#rebuildIndex();
    this.#dirty = true;
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
    for (const [category, records] of Object.entries(this.#data)) {
      const index = this.#categoryIndex(category);
      for (const [canonical, record] of Object.entries(records)) {
        index.set(canonical.toLowerCase(), canonical);
        for (const alias of record.aliases) {
          index.set(alias.toLowerCase(), canonical);
        }
      }
    }
  }
}
