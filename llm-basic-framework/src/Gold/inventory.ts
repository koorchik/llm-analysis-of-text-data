import type { StreamingEntity } from '../utils/validationUtils';
import { sortByNumericId } from '../utils/fsUtils';
import fs from 'fs/promises';

/**
 * Step 1 of E0: export every unique `(category, surface)` pair from the frozen corpus.
 *
 * This is the annotation universe. It is mechanical and must stay mechanical — a hand-curated
 * inventory would silently drop the rare surfaces that stratum (d) is made of, and those are the
 * ones that carry the paper's second claim.
 *
 * The occurrence list is not decoration: NIL is a property of (mention, stream position), so the
 * document ids each surface appears in are what make the NIL labels derivable later instead of
 * hand-written.
 */

export interface InventoryEntry {
  category: string;
  surface: string;
  /** Document ids this surface appears in, ascending, deduplicated. */
  docIds: number[];
  /** Total mentions across the corpus — `docIds.length` counts documents, this counts occurrences. */
  occurrences: number;
}

export interface Inventory {
  /** The extraction directory this was built from. */
  sourceDir: string;
  /** Content hash of that directory — a gold table must name the corpus it annotates. */
  inputContentHash: string;
  /** The stream order the document sequence was read in. */
  order: string;
  entries: InventoryEntry[];
}

interface ExtractionFile {
  entities?: StreamingEntity[];
  metadata?: Record<string, unknown>;
}

/**
 * Read an extraction directory into an inventory.
 *
 * Files are read in `sortByNumericId` order — the same order the pipeline processes them in, which
 * is what makes the resulting `docIds` a genuine stream position rather than a filesystem accident.
 */
export async function buildInventory(params: {
  sourceDir: string;
  inputContentHash: string;
  order?: string;
}): Promise<Inventory> {
  const files = sortByNumericId((await fs.readdir(params.sourceDir)).filter((f) => f.endsWith('.json')));

  // Keyed by category|folded-surface so case variants of one name collapse to a single row, while
  // the first-seen spelling is preserved as the surface an annotator reads.
  const byKey = new Map<string, InventoryEntry>();

  for (const file of files) {
    const raw = await fs.readFile(`${params.sourceDir}/${file}`, 'utf8');
    const parsed = JSON.parse(raw) as ExtractionFile;
    const docId = Number(parsed.metadata?.id) || parseInt(file, 10) || 0;

    for (const entity of parsed.entities ?? []) {
      const surface = (entity.name ?? '').trim();
      const category = (entity.category ?? '').trim();
      if (!surface || !category) continue;

      const key = `${category.toLowerCase()}|${surface.toLowerCase()}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { category, surface, docIds: [], occurrences: 0 };
        byKey.set(key, entry);
      }
      entry.occurrences++;
      if (entry.docIds[entry.docIds.length - 1] !== docId) entry.docIds.push(docId);
    }
  }

  const entries = [...byKey.values()].sort(
    (a, b) => compareStrings(a.category, b.category) || compareStrings(a.surface, b.surface)
  );

  return {
    sourceDir: params.sourceDir,
    inputContentHash: params.inputContentHash,
    order: params.order ?? 'numeric-id',
    entries,
  };
}

/** UTF-16 code-unit order. Never `localeCompare` — it is ICU- and locale-dependent. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function inventorySummary(inventory: Inventory): Array<{ category: string; surfaces: number }> {
  const counts = new Map<string, number>();
  for (const entry of inventory.entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, surfaces]) => ({ category, surfaces }))
    .sort((a, b) => b.surfaces - a.surfaces || compareStrings(a.category, b.category));
}
