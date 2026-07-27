#!/usr/bin/env ts-node
/**
 * Content-hash a frozen input directory. The recipe lives in src/Experiment/inputHash.ts and is
 * shared with RunCard, so the number a run records and the number you get here cannot diverge.
 *
 *   npm run hash-input -- ../storage/cert.gov.ua/processed/raw-unified/gpt-5
 *   npm run hash-input -- <dir> --manifest   # print the intermediate manifest too
 *
 * Record the *command* in documentation, not the resulting digest.
 */
import { hashInputDir } from '../src/Experiment/inputHash';

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  const showManifest = args.includes('--manifest');

  if (!dir) {
    console.error('usage: hash-input <dir> [--manifest] [--ext .json]');
    process.exit(2);
  }

  const extIndex = args.indexOf('--ext');
  const extension = extIndex >= 0 ? args[extIndex + 1] : undefined;

  const result = await hashInputDir(dir, extension ? { extension } : {});

  if (showManifest) process.stdout.write(result.manifest);

  console.log(`dir:         ${dir}`);
  console.log(`files:       ${result.fileCount}`);
  console.log(`contentHash: ${result.contentHash}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
