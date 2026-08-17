#!/usr/bin/env ts-node
/**
 * Materialize a committed doc-list into a scratch INPUT_DIR for the fast-iteration loop
 * (spec 2026-08-16). Copies, never links: a run must not be able to mutate the corpus.
 *
 *   npm run make-subset -- --list gold/subsets/dev-software-22.txt \
 *                          --from ../storage/cert.gov.ua/fetched --to /tmp/subset-dev-software
 */
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

interface Args {
  list?: string;
  from?: string;
  to?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--list':
        args.list = argv[++i];
        break;
      case '--from':
        args.from = argv[++i];
        break;
      case '--to':
        args.to = argv[++i];
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.list || !args.from || !args.to) {
    console.error('usage: make-subset --list <file> --from <srcDir> --to <destDir>');
    process.exit(2);
  }

  const lines = (await fs.readFile(args.list, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const missing = lines.filter((file) => !existsSync(path.join(args.from!, file)));
  if (missing.length > 0) {
    // Fail before copying anything: a partial subset would score as a mysteriously-shrunken run.
    throw new Error(`missing from ${args.from}: ${missing.join(', ')}`);
  }

  await fs.mkdir(args.to, { recursive: true });
  for (const file of lines) {
    await fs.copyFile(path.join(args.from, file), path.join(args.to, file));
  }
  console.log(`${lines.length} docs → ${args.to}`);
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
