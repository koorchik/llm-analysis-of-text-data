#!/usr/bin/env ts-node
/**
 * Convert a v1 registry to v2 in place, or inspect one.
 *
 *   npm run migrate-registry -- <registry.json> [--policy first-seen] [--out <file>] [--dry-run]
 *
 * `EntityRegistry` reads v1 transparently, so this is not required to *run* the pipeline — it exists
 * so an existing registry can be upgraded once, deliberately, rather than being silently rewritten
 * the next time some process happens to call `save()`.
 *
 * The migration cannot invent what v1 never recorded. Every alias becomes
 * `decision: "migrated"` with `docId` taken from the record's `firstSeen.doc`, which is the only
 * document context available; `gloss` is null and `externalIds` empty. Fabricating finer provenance
 * would make an unauditable registry look auditable, which is worse than admitting the gap.
 */
import {
  EntityRegistry,
  type CanonicalPolicy,
  type RegistryDataV2,
} from '../src/EntityRegistry/EntityRegistry';
import { existsSync } from 'fs';
import fs from 'fs/promises';

const POLICIES: CanonicalPolicy[] = ['first-seen', 'frequency-weighted', 'highest-degree'];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  const inPath = positional[0];
  const outPath = arg('out') ?? inPath;
  const dryRun = process.argv.includes('--dry-run');
  const policy = (arg('policy') ?? 'first-seen') as CanonicalPolicy;

  if (!inPath) {
    console.error('usage: migrate-registry <registry.json> [--policy first-seen] [--out <file>] [--dry-run]');
    process.exit(2);
  }
  if (!POLICIES.includes(policy)) {
    console.error(`unknown --policy ${policy}; expected one of ${POLICIES.join(', ')}`);
    process.exit(2);
  }
  if (!existsSync(inPath)) {
    console.error(`no such file: ${inPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(await fs.readFile(inPath, 'utf8'));
  const { categories, policy: filePolicy, wasV1 } = EntityRegistry.parse(raw);

  const canonicals = Object.values(categories).reduce(
    (sum, records) => sum + Object.keys(records).length,
    0
  );
  const aliases = Object.values(categories).reduce(
    (sum, records) => sum + Object.values(records).reduce((n, record) => n + record.aliases.length, 0),
    0
  );

  console.log(`file:        ${inPath}`);
  console.log(`detected:    ${wasV1 ? 'v1' : 'v2'}${filePolicy ? ` (canonicalPolicy: ${filePolicy})` : ''}`);
  console.log(`categories:  ${Object.keys(categories).length}`);
  console.log(`canonicals:  ${canonicals}`);
  console.log(`aliases:     ${aliases}`);

  if (!wasV1) {
    console.log('\nAlready v2 — nothing to migrate.');
    return;
  }

  const migrated: RegistryDataV2 = {
    version: 2,
    // A v1 file recorded no policy. `first-seen` is v1's implicit behaviour, so it is the only
    // choice that does not change how future merges resolve; anything else must be asked for.
    canonicalPolicy: filePolicy ?? policy,
    categories,
  };

  if (dryRun) {
    console.log(`\n[dry run] would write v2 with canonicalPolicy "${migrated.canonicalPolicy}" to ${outPath}`);
    const sampleCategory = Object.keys(categories)[0];
    const sampleCanonical = sampleCategory ? Object.keys(categories[sampleCategory])[0] : undefined;
    if (sampleCategory && sampleCanonical) {
      console.log('\nsample migrated record:');
      console.log(
        JSON.stringify({ [sampleCategory]: { [sampleCanonical]: categories[sampleCategory][sampleCanonical] } }, null, 2)
      );
    }
    return;
  }

  // Back up before overwriting in place — a registry is the run's accumulated state, and a bad
  // migration with no copy would mean re-running the whole pipeline.
  if (outPath === inPath) {
    const backup = `${inPath}.v1.bak`;
    await fs.copyFile(inPath, backup);
    console.log(`\nbacked up original to ${backup}`);
  }

  await fs.writeFile(outPath, `${JSON.stringify(migrated, null, 2)}\n`);
  console.log(`wrote v2 to ${outPath} (canonicalPolicy: ${migrated.canonicalPolicy})`);
  console.log(
    'NOTE: every alias is decision="migrated" with docId from firstSeen.doc — v1 recorded no ' +
      'per-alias provenance, and none was invented.'
  );
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
