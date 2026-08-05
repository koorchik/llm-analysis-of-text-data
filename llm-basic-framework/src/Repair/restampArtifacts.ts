import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import { StreamingArtifact } from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

export interface RestampArtifactsParams {
  artifactsDir: string;
  entityRegistry: EntityRegistry;
  schemaRegistry: SchemaRegistry;
  /**
   * Restrict re-stamping to exactly these basenames within `artifactsDir` — the repairer's (T9)
   * common case, where only the handful of documents touched by one document's repair ops need
   * re-checking. Omitted = every artifact in the directory, `RegistryConsolidator`'s full-corpus
   * pass.
   *
   * A listed name that does not exist on disk is SKIPPED with a `console.warn` naming it, and is
   * not counted in the returned `total` — never thrown. `files` here is expected to come from a
   * caller-computed "affected" set (T9), and a stale or wrong entry in that set must not crash a
   * document mid-repair (never abort a document, wiki rule / repo error posture).
   */
  files?: string[];
}

/**
 * Deterministic re-stamp of artifacts through the updated alias->canonical maps. No LLM, no
 * re-extraction — the only permitted artifact mutation (spec §3.4).
 *
 * Extracted verbatim from `RegistryConsolidator#restampArtifacts` (T8, pre-extraction at
 * `RegistryConsolidator.ts:477-518`) so `StreamingRepairer` (T9) can call the same logic per
 * document after applying repair ops, instead of only through the consolidator's full-corpus pass.
 */
export async function restampArtifacts(
  params: RestampArtifactsParams
): Promise<{ changed: number; total: number }> {
  const { artifactsDir, entityRegistry, schemaRegistry } = params;
  if (!existsSync(artifactsDir)) return { changed: 0, total: 0 };

  const files = sortByNumericId(params.files ?? (await fs.readdir(artifactsDir)));
  let changed = 0;
  let total = 0;

  for (const file of files) {
    const filePath = `${artifactsDir}/${file}`;
    let original: string;
    try {
      original = (await fs.readFile(filePath)).toString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A `files`-restricted caller (T9) computes its own "affected" set; a stale/wrong entry
        // must not crash the document mid-repair — skip it, don't count it, warn so it is visible.
        console.warn(`restampArtifacts: skipping missing file "${file}" in ${artifactsDir}`);
        continue;
      }
      throw error;
    }
    total++;
    const artifact = JSON.parse(original) as StreamingArtifact;

    for (const entity of artifact.entities) {
      entity.category = schemaRegistry.resolveCategory(entity.category) || entity.category;
      // Re-stamp by `matchedVia` — the alias surface the mention actually hit — never by the
      // now-ambiguous canonical. This is what keeps a split LOCAL: detached aliases now resolve
      // to the split-off canonical, and exactly their mentions follow.
      const canonical =
        (entity.matchedVia && entityRegistry.resolve(entity.category, entity.matchedVia)) ||
        entityRegistry.resolve(entity.category, entity.name);
      if (canonical) entity.normalizedName = canonical;
    }

    for (const relation of artifact.relations || []) {
      relation.headCategory =
        schemaRegistry.resolveCategory(relation.headCategory) || relation.headCategory;
      relation.tailCategory =
        schemaRegistry.resolveCategory(relation.tailCategory) || relation.tailCategory;
      const head = entityRegistry.resolve(relation.headCategory, relation.head);
      if (head) relation.normalizedHead = head;
      const tail = entityRegistry.resolve(relation.tailCategory, relation.tail);
      if (tail) relation.normalizedTail = tail;
    }

    const updated = JSON.stringify(artifact, undefined, 2);
    if (updated !== original) {
      await writeJsonAtomic(filePath, artifact);
      changed++;
    }
  }

  return { changed, total };
}
