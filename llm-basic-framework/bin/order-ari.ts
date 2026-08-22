#!/usr/bin/env ts-node
/**
 * Order-robustness scorer (E6/M7): how much does the final registry depend on document arrival
 * order?
 *
 *   npm run order-ari -- --run <dir> --run <dir> [--run <dir> ...] [--category X]
 *
 * Pass one run directory per ORDER arm (same corpus, same config, only `ORDER` differs — the runId
 * enforces that they cannot share a directory). For every pair of runs this reports:
 *
 * - **identity ARI** — adjusted Rand index between the two final label partitions, over their
 *   shared surface universe (`adjustedRandIndex` restricts internally). 1.0 = the same clustering
 *   regardless of order.
 * - **edge Jaccard** — overlap of the (scheme, narrower, broader) broader-edge sets, and
 *   **type agreement** on the shared edges (how often the ISO 25964 typing also matches).
 *
 * No LLM calls; reads registry.json through the loader (any historical version).
 */
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { adjustedRandIndex } from '../src/Evaluation/clusterMetrics';
import { fromRegistry, type Partition } from '../src/Evaluation/partition';
import { promises as fs } from 'fs';
import path from 'path';

interface Arm {
  name: string;
  partition: Partition;
  edges: Map<string, string>; // "scheme|narrower|broader" -> type ('' for null)
}

function collectArgs(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

function flag(name: string, fallback = ''): string {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
}

async function loadArm(runDir: string, category: string): Promise<Arm> {
  const raw = JSON.parse(await fs.readFile(path.join(runDir, 'registry.json'), 'utf8'));
  const { conceptSchemes, broaderEdges } = ConceptRegistry.parse(raw);

  const schemes = category
    ? Object.fromEntries(
        Object.entries(conceptSchemes).filter(([name]) => name.toLowerCase() === category.toLowerCase())
      )
    : conceptSchemes;

  const edges = new Map<string, string>();
  for (const [scheme, list] of Object.entries(broaderEdges)) {
    if (category && scheme.toLowerCase() !== category.toLowerCase()) continue;
    for (const edge of list) {
      edges.set(`${scheme}|${edge.narrower}|${edge.broader}`, edge.type ?? '');
    }
  }

  return {
    name: path.basename(runDir),
    partition: fromRegistry({ version: 6, canonicalPolicy: 'first-seen', conceptSchemes: schemes,
      broaderEdges: {}, renameEdges: {}, deferQueue: [],
      repair: { adjudicated: [], spillover: [], repairedThrough: -1 } }),
    edges,
  };
}

function edgeAgreement(a: Arm, b: Arm): { jaccard: number; typeAgreement: number | null } {
  const keys = new Set([...a.edges.keys(), ...b.edges.keys()]);
  if (keys.size === 0) return { jaccard: 1, typeAgreement: null };
  let shared = 0;
  let typeAgree = 0;
  for (const key of keys) {
    if (a.edges.has(key) && b.edges.has(key)) {
      shared += 1;
      if (a.edges.get(key) === b.edges.get(key)) typeAgree += 1;
    }
  }
  return {
    jaccard: shared / keys.size,
    typeAgreement: shared ? typeAgree / shared : null,
  };
}

async function main() {
  const runs = collectArgs('run');
  if (runs.length < 2) {
    throw new Error('usage: order-ari --run <dir> --run <dir> [--run <dir> ...] [--category X]');
  }
  const category = flag('category');

  const arms: Arm[] = [];
  for (const run of runs) arms.push(await loadArm(run, category));

  console.log(`order robustness over ${arms.length} arms${category ? ` (category ${category})` : ''}\n`);
  const aris: number[] = [];
  const jaccards: number[] = [];
  const typeAgreements: number[] = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const ari = adjustedRandIndex(arms[i].partition, arms[j].partition);
      const { jaccard, typeAgreement } = edgeAgreement(arms[i], arms[j]);
      aris.push(ari);
      jaccards.push(jaccard);
      if (typeAgreement !== null) typeAgreements.push(typeAgreement);
      console.log(
        `${arms[i].name}\n  vs ${arms[j].name}\n  identity ARI ${ari.toFixed(3)} · edge Jaccard ${jaccard.toFixed(3)}` +
          (typeAgreement !== null ? ` · type agreement ${typeAgreement.toFixed(3)}` : '') + '\n'
      );
    }
  }

  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  console.log(
    `mean: identity ARI ${mean(aris).toFixed(3)} · edge Jaccard ${mean(jaccards).toFixed(3)}` +
      (typeAgreements.length ? ` · type agreement ${mean(typeAgreements).toFixed(3)}` : '')
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
