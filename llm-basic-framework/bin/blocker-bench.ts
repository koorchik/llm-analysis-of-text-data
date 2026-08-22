#!/usr/bin/env ts-node
/**
 * Candidate-recall bench for the **blocker**, not the encoder.
 *
 *   npm run blocker-bench -- --generators embedding,union --k 4,10
 *
 * `bin/embed-bench.js` ranks encoders on cross-script pairs. This ranks whole candidate
 * generators — `union` (RRF over five channels) against any single channel — on the only thing a
 * blocker owes the judge: **is the right entity on the ballot at all**, at the width the judge
 * actually sees (`LISTWISE_K`, default 4) and at the width the pipeline retrieves (`CANDIDATE_K`,
 * default 10).
 *
 * Setup mirrors the streaming reality. Every gold surface in a category becomes its own registry
 * entry — nothing pre-merged, exactly the state the linker faces when the sibling was minted a few
 * documents earlier. Each member of every multi-member cluster is asked in turn; a hit means a
 * same-cluster sibling made the top-k. The pool is the full gold table, so this is the scale the
 * 22-doc iteration slices cannot probe.
 *
 * No LLM calls. Embedding calls are served by the shared on-disk cache after the first run.
 */
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';

import { createEmbeddingsClient } from '../src/EmbeddingsClient/createEmbeddingsClient';

dotenv.config();
import { resolveGenerator } from '../src/Normalization/candidates';
import type {
  CandidateGenerator,
  RegistrySnapshot,
  SnapshotEntry,
} from '../src/Normalization/types';

interface GoldCluster {
  id: string;
  category: string;
  members: string[];
  stratum?: string;
  split?: string;
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const GENERATORS = flag('generators', 'embedding,union').split(',');
const KS = flag('k', '4,10')
  .split(',')
  .map(Number)
  .sort((a, b) => a - b);
const ONLY = flag('categories', '');
const SPLIT = flag('split', '');
const GOLD = flag('gold', path.join(__dirname, '..', 'gold', 'gold.json'));

async function main() {
  const gold = JSON.parse(await fs.readFile(GOLD, 'utf8')) as { clusters: GoldCluster[] };

  let clusters = gold.clusters.filter((cluster) => cluster.members.length > 1);
  if (ONLY) {
    const keep = new Set(ONLY.split(',').map((s) => s.trim()));
    clusters = clusters.filter((cluster) => keep.has(cluster.category));
  }
  if (SPLIT) clusters = clusters.filter((cluster) => cluster.split === SPLIT);
  if (clusters.length === 0) throw new Error('no multi-member gold clusters matched');

  // Pool: every gold surface of every category under test, one registry entry per surface.
  const categories = [...new Set(clusters.map((cluster) => cluster.category))].sort();
  const poolByCategory = new Map<string, string[]>();
  for (const cluster of gold.clusters) {
    if (!categories.includes(cluster.category)) continue;
    const pool = poolByCategory.get(cluster.category) ?? [];
    pool.push(...cluster.members);
    poolByCategory.set(cluster.category, pool);
  }
  for (const [category, pool] of poolByCategory) {
    poolByCategory.set(category, [...new Set(pool)].sort());
  }

  const embeddingsClient = createEmbeddingsClient({
    provider: process.env.EMBEDDINGS_PROVIDER ?? 'ollama',
    model: process.env.EMBEDDINGS_MODEL ?? 'embeddinggemma',
    cacheDir: process.env.EMBEDDINGS_CACHE ?? '../storage/cert.gov.ua/processed/embeddings-cache',
  });

  const maxK = Math.max(...KS);
  const pairs = clusters.reduce((sum, cluster) => sum + cluster.members.length, 0);
  console.log(
    `blocker-bench: ${clusters.length} multi-member clusters, ${pairs} queries, ` +
      `pool ${[...poolByCategory.values()].reduce((sum, pool) => sum + pool.length, 0)} surfaces ` +
      `across ${categories.length} categories${SPLIT ? ` (split ${SPLIT})` : ''}`
  );

  for (const generatorId of GENERATORS) {
    const generator: CandidateGenerator = resolveGenerator(generatorId, { embeddingsClient });
    const hits = new Map<number, number>(KS.map((k) => [k, 0]));
    const perCategory = new Map<string, Map<number, number>>();
    const perCategoryTotal = new Map<string, number>();
    const missesAtSmallestK: string[] = [];
    let total = 0;

    for (const category of categories) {
      // One entry per surface: the blocker's job is to find the sibling *before* anything merged.
      const entries: SnapshotEntry[] = poolByCategory
        .get(category)!
        .map((surface) => ({ canonical: surface, surfaces: [surface] }));
      const snapshot: RegistrySnapshot = {
        categories: () => [category],
        entries: () => entries,
        size: () => entries.length,
      };
      await generator.prepare(snapshot);

      for (const cluster of clusters.filter((cluster) => cluster.category === category)) {
        for (const member of cluster.members) {
          const siblings = new Set(cluster.members.filter((other) => other !== member));
          const candidates = await generator.candidates({
            mention: member,
            category,
            k: maxK,
            minSim: 0,
          });
          const rank = candidates.findIndex((candidate) => siblings.has(candidate.canonical));
          total += 1;
          perCategoryTotal.set(category, (perCategoryTotal.get(category) ?? 0) + 1);
          for (const k of KS) {
            if (rank >= 0 && rank < k) {
              hits.set(k, hits.get(k)! + 1);
              const bucket = perCategory.get(category) ?? new Map<number, number>();
              bucket.set(k, (bucket.get(k) ?? 0) + 1);
              perCategory.set(category, bucket);
            }
          }
          if (!(rank >= 0 && rank < KS[0])) {
            missesAtSmallestK.push(
              `${cluster.id} ${category}: "${member}" — sibling at rank ${rank >= 0 ? rank + 1 : '>' + maxK}`
            );
          }
        }
      }
    }

    const pct = (n: number) => `${((100 * n) / total).toFixed(1)}%`;
    console.log(`\n=== ${generator.id}`);
    console.log(`    ${KS.map((k) => `recall@${k} ${pct(hits.get(k)!)}`).join('   ')}`);
    for (const category of categories) {
      const bucket = perCategory.get(category) ?? new Map<number, number>();
      const n = perCategoryTotal.get(category) ?? 0;
      console.log(
        `      ${category.padEnd(16)} ${KS.map((k) => `@${k} ${bucket.get(k) ?? 0}/${n}`).join('   ')}`
      );
    }
    if (missesAtSmallestK.length) {
      console.log(`    missed at k=${KS[0]} (${missesAtSmallestK.length}):`);
      for (const miss of missesAtSmallestK.slice(0, 25)) console.log(`      ${miss}`);
      if (missesAtSmallestK.length > 25) {
        console.log(`      … ${missesAtSmallestK.length - 25} more`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
