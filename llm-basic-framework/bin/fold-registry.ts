#!/usr/bin/env ts-node
/**
 * Fold a registry along its skos:broader edges — the roll-up the graph exists for.
 *
 *   npm run fold -- --run <runDir> --category Software
 *   npm run fold -- --run <runDir> --contract broaderInstantial   # versions only (alias: version-of)
 *   npm run fold -- --run <runDir> --threshold 0.85               # stop at semantic drift
 *   npm run fold -- --run <runDir> --threshold 0.85 --rescore max-labels
 *
 * A flat registry answers "how many mentions of `Microsoft Office 2010`". A folded one answers "how
 * many mentions of Office **at product granularity**", which is the question an analysis usually
 * wants, and it is a different answer for every choice of fold — hence a runtime operation over the
 * stored graph rather than a decision baked into the registry.
 *
 * Two knobs:
 *
 * - `--contract` folds only the named ISO 25964 broader types (`broaderInstantial`,
 *   `broaderGeneric`, `broaderPartitive`; the pre-v6 names `version-of`, `narrower-of`, `part-of`
 *   are accepted as aliases). `--contract broaderInstantial` folds `Office 2010` into `Office`
 *   and `Photoshop 7` into `Photoshop` in one pass while leaving `MS Word` under `MS Office` alone.
 * - `--threshold` is the semantic brake: an edge is only followed while its similarity is at or
 *   above the threshold. That is what keeps "Microsoft Office" from rolling up into an overly
 *   abstract "Microsoft Products". 0 (the default) folds every edge; edges with no score count as
 *   below any positive threshold.
 * - `--rescore max-labels` replaces the stored score (frozen at edge-creation time, name-to-name
 *   against whichever surface won the canonical slot) with a state-aware one: the MAX cosine over
 *   all current label pairs of the two endpoints — the blocker's max-over-aliases aggregation,
 *   immune to the canonical-name lottery. Needs a live encoder (`EMBEDDINGS_PROVIDER`/`_MODEL`,
 *   default ollama/embeddinggemma; cache at `EMBEDDINGS_CACHE` or `<runDir>/../../embeddings-cache`).
 *
 * The walk itself is `ConceptRegistry.rollupTarget` — the same traversal downstream analyses use —
 * so the CLI cannot drift from the library semantics. Loading through the registry normalizes
 * every historical file version (v1–v6) in memory.
 */
import { ConceptRegistry, type BroaderEdge, type BroaderType } from '../src/ConceptRegistry/ConceptRegistry';
import { createEmbeddingsClient } from '../src/EmbeddingsClient/createEmbeddingsClient';
import { cosineNormalized, l2Normalize } from '../src/utils/vectorUtils';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const RUN = flag('run');
const CATEGORY = flag('category');
const CONTRACT_INPUT = flag('contract', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const THRESHOLD = Number(flag('threshold', '0'));
const TOP = Number(flag('top', '25'));
const RESCORE = flag('rescore', '');

/** Pre-v6 relation names are accepted as aliases of the ISO 25964 types. */
const CONTRACT_ALIASES: Record<string, BroaderType> = {
  broaderInstantial: 'broaderInstantial',
  broaderGeneric: 'broaderGeneric',
  broaderPartitive: 'broaderPartitive',
  'version-of': 'broaderInstantial',
  'narrower-of': 'broaderGeneric',
  'part-of': 'broaderPartitive',
};

async function main() {
  if (!RUN) throw new Error('usage: fold-registry --run <runDir> [--category X] [--contract broaderInstantial,broaderGeneric,broaderPartitive] [--threshold 0.85]');

  const contract = CONTRACT_INPUT.map((name) => {
    const mapped = CONTRACT_ALIASES[name];
    if (!mapped) {
      throw new Error(
        `unknown --contract "${name}"; expected one of ${Object.keys(CONTRACT_ALIASES).join(', ')}`
      );
    }
    return mapped;
  });

  if (RESCORE && RESCORE !== 'max-labels') {
    throw new Error(`unknown --rescore "${RESCORE}"; expected max-labels`);
  }

  const registry = new ConceptRegistry({ filePath: path.join(RUN, 'registry.json') });
  await registry.load();

  const score = RESCORE === 'max-labels' ? await maxLabelScores(registry) : undefined;
  const rollupOptions = {
    // 0 = the fold-everything default: no brake, null-score edges are followed.
    threshold: THRESHOLD > 0 ? THRESHOLD : null,
    contract: contract.length > 0 ? contract : null,
    ...(score ? { score } : {}),
  };

  const schemes = registry
    .conceptSchemes()
    .filter((name) => !CATEGORY || name.toLowerCase() === CATEGORY.toLowerCase());

  for (const category of schemes) {
    const records = registry.concepts(category);
    if (Object.keys(records).length === 0) continue;
    const edges = registry
      .broaderEdges(category)
      .filter((edge) =>
        contract.length > 0 ? Boolean(edge.type) && contract.includes(edge.type!) : true
      );

    // Multi-parent DAGs are real, but a fold must be a function — rollupTarget follows the
    // highest-similarity parent; the rest are reported, not followed.
    const parentCount = new Set(edges.map((edge) => edge.narrower)).size;
    const multiParent = edges.length - parentCount;

    const mentions = (name: string) => (records[name]?.labels ?? []).length;
    const folded = new Map<string, { members: string[]; mentions: number }>();
    for (const name of Object.keys(records)) {
      const target = registry.rollupTarget(category, name, rollupOptions);
      const bucket = folded.get(target) ?? { members: [], mentions: 0 };
      bucket.members.push(name);
      bucket.mentions += mentions(name);
      folded.set(target, bucket);
    }

    const moved = [...folded.values()].reduce((sum, b) => sum + b.members.length, 0) - folded.size;
    console.log(
      `\n=== ${category}: ${Object.keys(records).length} canonicals, ${edges.length} usable edges ` +
        `(${CONTRACT_INPUT.length > 0 ? `relation ${CONTRACT_INPUT.join('+')}` : 'all relations'}` +
        `${THRESHOLD > 0 ? `, threshold ${THRESHOLD}` : ''}` +
        `${RESCORE ? `, rescored ${RESCORE}` : ''})`
    );
    console.log(`    folded to ${folded.size} nodes — ${moved} canonicals absorbed` +
      (multiParent ? `; ${multiParent} extra parent edges ignored (multi-parent)` : ''));

    const rolled = [...folded.entries()]
      .filter(([, bucket]) => bucket.members.length > 1)
      .sort((a, b) => b[1].mentions - a[1].mentions)
      .slice(0, TOP);
    for (const [target, bucket] of rolled) {
      const absorbed = bucket.members.filter((member) => member !== target);
      console.log(`    ${target}  (${bucket.mentions} surfaces)  <- ${absorbed.join(', ')}`);
    }
  }
}

/**
 * State-aware rescoring: for every broader edge, the MAX cosine over all current label pairs of
 * its endpoints, computed with the configured encoder through the shared on-disk cache. Returns a
 * scorer for `rollupTarget`'s `score` option.
 */
async function maxLabelScores(
  registry: ConceptRegistry
): Promise<(edge: BroaderEdge) => number | null> {
  const provider = process.env.EMBEDDINGS_PROVIDER ?? 'ollama';
  const model = process.env.EMBEDDINGS_MODEL ?? 'embeddinggemma';
  const cacheDir = process.env.EMBEDDINGS_CACHE ?? path.resolve(RUN, '../../embeddings-cache');
  const client = createEmbeddingsClient({ provider, model, cacheDir });

  // Every label surface that participates in any edge, embedded once.
  const surfaces = new Set<string>();
  for (const category of registry.conceptSchemes()) {
    for (const edge of registry.broaderEdges(category)) {
      for (const endpoint of [edge.narrower, edge.broader]) {
        for (const surface of registry.labelSurfaces(category, endpoint)) surfaces.add(surface);
        surfaces.add(endpoint);
      }
    }
  }
  const texts = [...surfaces].sort();
  if (texts.length === 0) return () => null;
  const vectors = await client.embed(texts, { operator: 'fold-rescore' });
  const vectorOf = new Map(texts.map((text, index) => [text, l2Normalize(vectors[index])]));

  const scores = new Map<string, number>();
  for (const category of registry.conceptSchemes()) {
    for (const edge of registry.broaderEdges(category)) {
      const narrowerSurfaces = [edge.narrower, ...registry.labelSurfaces(category, edge.narrower)];
      const broaderSurfaces = [edge.broader, ...registry.labelSurfaces(category, edge.broader)];
      let best = -1;
      for (const a of new Set(narrowerSurfaces)) {
        for (const b of new Set(broaderSurfaces)) {
          const va = vectorOf.get(a);
          const vb = vectorOf.get(b);
          if (!va || !vb) continue;
          best = Math.max(best, cosineNormalized(va, vb));
        }
      }
      if (best >= 0) scores.set(`${category}|${edge.narrower}|${edge.broader}`, best);
    }
  }
  console.error(`rescored ${scores.size} edges with ${provider}/${model} (max over label pairs)`);

  // The scorer is keyed by endpoints; the category is recovered by probing (schemes are disjoint
  // on concept names in practice, and a miss falls back to the stored score).
  return (edge) => {
    for (const category of registry.conceptSchemes()) {
      const hit = scores.get(`${category}|${edge.narrower}|${edge.broader}`);
      if (hit !== undefined) return hit;
    }
    return edge.similarityScore ?? null;
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
