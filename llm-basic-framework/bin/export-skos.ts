#!/usr/bin/env ts-node
/**
 * Export a run's registry as SKOS/Turtle — the interoperability deliverable.
 *
 *   npm run export-skos -- --run <runDir> [--category Software] [--base urn:skein:] [--out file.ttl]
 *
 * See src/Export/skosExport.ts for the vocabulary mapping and the RDF 1.2 (RDF-star) annotations
 * that carry what SKOS core cannot (typed relations, edge similarity scores). Without --out the
 * Turtle goes to stdout.
 */
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { registryToTurtle } from '../src/Export/skosExport';
import { promises as fs } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

async function main() {
  const run = flag('run');
  if (!run) throw new Error('usage: export-skos --run <runDir> [--category X] [--base IRI] [--out file.ttl]');
  // Loading through the registry normalizes every historical file version (v1–v6) in memory.
  const registry = new ConceptRegistry({ filePath: path.join(run, 'registry.json') });
  await registry.load();
  const turtle = registryToTurtle(registry.toJSON(), {
    ...(flag('category') ? { category: flag('category') } : {}),
    ...(flag('base') ? { base: flag('base') } : {}),
  });
  const out = flag('out');
  if (out) {
    await fs.writeFile(out, turtle);
    console.error(`wrote ${out}`);
  } else {
    console.log(turtle);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
