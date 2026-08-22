#!/usr/bin/env ts-node
/**
 * Convert a v1 registry to the current version (6) in place, or inspect one.
 *
 *   npm run migrate-registry -- <registry.json> [--policy first-seen] [--out <file>] [--dry-run]
 *
 * `ConceptRegistry` reads every historical version transparently, so this is not required to *run*
 * the pipeline — it exists so an existing registry can be upgraded once, deliberately, rather than
 * being silently rewritten the next time some process happens to call `save()`.
 *
 * The migration cannot invent what v1 never recorded. Every label becomes
 * `decision: "migrated"` with `docId` taken from the record's `firstSeen.doc`, which is the only
 * document context available; `definition` is absent and `externalIds` empty. Fabricating finer
 * provenance would make an unauditable registry look auditable, which is worse than admitting the
 * gap.
 */
import {
  ConceptRegistry,
  type CanonicalPolicy,
  type RegistryDataV6,
} from '../src/ConceptRegistry/ConceptRegistry';
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
  const { conceptSchemes, broaderEdges, renameEdges, deferQueue, repair, policy: filePolicy, wasV1 } =
    ConceptRegistry.parse(raw);

  const canonicals = Object.values(conceptSchemes).reduce(
    (sum, records) => sum + Object.keys(records).length,
    0
  );
  const aliases = Object.values(conceptSchemes).reduce(
    (sum, records) => sum + Object.values(records).reduce((n, record) => n + record.labels.length, 0),
    0
  );

  console.log(`file:        ${inPath}`);
  // parse() now accepts v1-v4 (T3 added v4's repair layer); this script only cares which side of
  // the v1 boundary a file falls on, since v2+ all read and write without needing a migration step.
  console.log(`detected:    ${wasV1 ? 'v1' : 'v2+'}${filePolicy ? ` (canonicalPolicy: ${filePolicy})` : ''}`);
  console.log(`schemes:     ${Object.keys(conceptSchemes).length}`);
  console.log(`canonicals:  ${canonicals}`);
  console.log(`aliases:     ${aliases}`);

  if (!wasV1) {
    console.log('\nAlready v2 or newer — nothing to migrate (only v1 needs this script).');
    return;
  }

  const migrated: RegistryDataV6 = {
    version: 6,
    // A v1 file recorded no policy. `first-seen` is v1's implicit behaviour, so it is the only
    // choice that does not change how future merges resolve; anything else must be asked for.
    canonicalPolicy: filePolicy ?? policy,
    conceptSchemes,
    broaderEdges,
    renameEdges,
    deferQueue,
    repair,
  };

  if (dryRun) {
    console.log(`\n[dry run] would write v6 with canonicalPolicy "${migrated.canonicalPolicy}" to ${outPath}`);
    const sampleScheme = Object.keys(conceptSchemes)[0];
    const sampleCanonical = sampleScheme ? Object.keys(conceptSchemes[sampleScheme])[0] : undefined;
    if (sampleScheme && sampleCanonical) {
      console.log('\nsample migrated record:');
      console.log(
        JSON.stringify({ [sampleScheme]: { [sampleCanonical]: conceptSchemes[sampleScheme][sampleCanonical] } }, null, 2)
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
  console.log(`wrote v6 to ${outPath} (canonicalPolicy: ${migrated.canonicalPolicy})`);
  console.log(
    'NOTE: every label is decision="migrated" with docId from firstSeen.doc — v1 recorded no ' +
      'per-label provenance, and none was invented.'
  );
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
