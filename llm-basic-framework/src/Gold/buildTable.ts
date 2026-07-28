import { GOLD_VERSION, type GoldCluster, type GoldNilLabel, type GoldTable, type Split } from '../Evaluation/gold';
import { UnionFind } from '../Evaluation/unionFind';
import type { Inventory } from './inventory';

/**
 * Steps 4 and 5 of E0: close adjudicated pairs under transitivity into clusters, derive the NIL
 * labels, and assign the dev/test split.
 *
 * All three are mechanical, and doing them by hand is where a gold table quietly goes wrong:
 * transitive closure by eye misses chains, NIL labels number in the thousands, and a split assigned
 * per-mention rather than per-cluster leaks aliases across it.
 */

/** One adjudicated pair: the annotator's verdict on a proposal. */
export interface AdjudicatedPair {
  category: string;
  left: string;
  right: string;
  label: 'same' | 'different';
  stratum: string;
  evidence?: string;
}

const fold = (value: string) => value.trim().toLowerCase();
const key = (category: string, surface: string) => `${fold(category)}|${fold(surface)}`;

/**
 * Close `same` pairs under transitivity, within a category.
 *
 * **`different` verdicts are not subtracted.** If a–b and b–c are both `same`, a–c is in the cluster
 * even if an annotator marked it `different`: identity is an equivalence relation, so that
 * combination is a contradiction in the annotation, not a smaller cluster. `conflicts` reports every
 * such case so it can be resolved rather than silently resolved *for* you — an unreported conflict
 * is a gold table that disagrees with itself.
 */
export function closeIntoClusters(
  pairs: AdjudicatedPair[],
  inventory: Inventory
): { clusters: GoldCluster[]; conflicts: AdjudicatedPair[] } {
  const union = new UnionFind<string>();
  const stratumOf = new Map<string, string>();

  for (const pair of pairs) {
    if (pair.label !== 'same') continue;
    const a = key(pair.category, pair.left);
    const b = key(pair.category, pair.right);
    union.union(a, b);
    // The hardest stratum in a cluster wins: a cluster containing a (d) pair is a (d) cluster,
    // because that is the capability being attributed.
    for (const member of [a, b]) {
      const current = stratumOf.get(member);
      if (current === undefined || pair.stratum > current) stratumOf.set(member, pair.stratum);
    }
  }

  const conflicts = pairs.filter((pair) => {
    if (pair.label !== 'different') return false;
    const a = key(pair.category, pair.left);
    const b = key(pair.category, pair.right);
    // `has` first: `connected` calls `find`, which *adds* an unknown element. Querying a pair that
    // was never unioned would therefore insert both as singleton groups, and every `different`
    // verdict would silently manufacture a cluster.
    return union.has(a) && union.has(b) && union.connected(a, b);
  });

  // Rebuild readable clusters from the inventory so members carry the spelling an annotator saw,
  // rather than the folded key used for grouping.
  const surfaceOf = new Map<string, { category: string; surface: string }>();
  for (const entry of inventory.entries) {
    surfaceOf.set(key(entry.category, entry.surface), entry);
  }

  const clusters: GoldCluster[] = [];
  let index = 0;
  // Sorted by first member so cluster ids are stable across runs on the same input.
  const groups = union.groups().sort((a, b) => ([...a].sort()[0] < [...b].sort()[0] ? -1 : 1));

  for (const group of groups) {
    const resolved = group
      .map((member) => surfaceOf.get(member))
      .filter((entry): entry is { category: string; surface: string } => entry !== undefined);
    if (resolved.length === 0) continue;

    clusters.push({
      id: `g${++index}`,
      category: resolved[0].category,
      members: resolved.map((entry) => entry.surface).sort(),
      stratum: group.map((member) => stratumOf.get(member) ?? 'a').sort().pop() ?? 'a',
      // Assigned later by assignSplit — a placeholder here would be a silently wrong default.
      split: 'test',
    });
  }

  return { clusters, conflicts };
}

/**
 * Add every unclustered surface as a singleton.
 *
 * Step 4: "singletons are gold mints". Leaving them out is the most consequential omission possible
 * — 2,411 of 2,673 canonicals in this corpus are singletons, so a table of merged clusters only
 * would score a system that links nothing as having no opinion instead of as mostly right.
 */
export function addSingletons(clusters: GoldCluster[], inventory: Inventory): GoldCluster[] {
  const claimed = new Set<string>();
  for (const cluster of clusters) {
    for (const member of cluster.members) claimed.add(key(cluster.category, member));
  }

  const out = [...clusters];
  let index = clusters.length;
  for (const entry of inventory.entries) {
    if (claimed.has(key(entry.category, entry.surface))) continue;
    out.push({
      id: `s${++index}`,
      category: entry.category,
      members: [entry.surface],
      // A singleton exhibits no alias difficulty — it is a mint, and stratum 'a' is the floor.
      stratum: 'a',
      split: 'test',
    });
  }
  return out;
}

/**
 * Deterministic ~20/80 dev/test split, **by cluster**.
 *
 * By cluster, never by mention: two surfaces of one entity landing on opposite sides would let a
 * condition tuned on dev see a test alias, which is exactly the leak the split exists to prevent.
 *
 * The assignment is a hash of the cluster id, so it is reproducible without a seed and stable when
 * clusters are added — re-running after annotating more pairs does not reshuffle what was already
 * assigned, which a random split would.
 */
export function assignSplit(clusters: GoldCluster[], devFraction = 0.2): GoldCluster[] {
  // Stratified, not a plain hash over everything. Mergeable clusters are rare — a real table might
  // have a few hundred against three thousand singletons — so an unstratified assignment can put
  // almost all of them on one side by chance, and a split with no mergeable cluster produces empty
  // merge P/R. Bucketing by (stratum, mergeable) makes the ratio hold *within* each group, which is
  // the property the 20/80 split is actually for.
  const buckets = new Map<string, GoldCluster[]>();
  for (const cluster of clusters) {
    const bucket = `${cluster.stratum}|${cluster.members.length > 1 ? 'multi' : 'single'}`;
    const list = buckets.get(bucket) ?? [];
    list.push(cluster);
    buckets.set(bucket, list);
  }

  const devIds = new Set<string>();
  for (const group of buckets.values()) {
    // Rank by hash within the bucket and take the lowest `devFraction`. Ranking rather than
    // thresholding is what makes the proportion exact per bucket instead of only in expectation.
    const ranked = [...group].sort((a, b) => hashFraction(a.id) - hashFraction(b.id));
    const devCount = Math.round(ranked.length * devFraction);
    for (const cluster of ranked.slice(0, devCount)) devIds.add(cluster.id);
  }

  return clusters.map((cluster) => ({
    ...cluster,
    split: (devIds.has(cluster.id) ? 'dev' : 'test') as Split,
  }));
}

/**
 * Stable [0,1) from a string: FNV-1a followed by a murmur3 finalizer.
 *
 * The finalizer is not optional. Plain FNV-1a avalanches poorly on short, sequential inputs — over
 * ids `g1`…`g100` it put 66% on one side of a 20% cutoff, because the digits of the id still
 * correlate with the output. Mixing the result decorrelates them.
 */
function hashFraction(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // murmur3 fmix32
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

/**
 * Derive the NIL labels from clusters plus the stream order.
 *
 * **This is why the inventory records `docIds`.** A mention is `NIL` at the first document where any
 * member of its cluster appears, and `known` at every later occurrence — the label is a property of
 * (mention, stream position), which is precisely what a flat mention→label map cannot express and
 * why the loader rejects one.
 *
 * Fully mechanical, and it must be: this corpus produces thousands of rows, and hand-labelling them
 * would introduce exactly the prefix errors the position-indexed schema was designed to prevent.
 */
export function deriveNilLabels(clusters: GoldCluster[], inventory: Inventory): GoldNilLabel[] {
  const clusterOf = new Map<string, GoldCluster>();
  for (const cluster of clusters) {
    for (const member of cluster.members) clusterOf.set(key(cluster.category, member), cluster);
  }

  // Every (cluster, docId) occurrence, so "first document of this cluster" is answerable.
  const occurrences: Array<{ docId: number; category: string; surface: string; cluster: GoldCluster }> = [];
  for (const entry of inventory.entries) {
    const cluster = clusterOf.get(key(entry.category, entry.surface));
    if (!cluster) continue;
    for (const docId of entry.docIds) {
      occurrences.push({ docId, category: entry.category, surface: entry.surface, cluster });
    }
  }

  const firstDocOf = new Map<string, number>();
  for (const occurrence of occurrences) {
    const current = firstDocOf.get(occurrence.cluster.id);
    if (current === undefined || occurrence.docId < current) {
      firstDocOf.set(occurrence.cluster.id, occurrence.docId);
    }
  }

  return occurrences
    .sort(
      (a, b) =>
        a.docId - b.docId ||
        (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
        (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0)
    )
    .map((occurrence) => ({
      docId: occurrence.docId,
      category: occurrence.category,
      mention: occurrence.surface,
      label: occurrence.docId === firstDocOf.get(occurrence.cluster.id) ? 'NIL' : 'known',
      clusterId: occurrence.cluster.id,
    }));
}

/** Assemble a complete, loadable gold table. */
export function buildGoldTable(params: {
  clusters: GoldCluster[];
  inventory: Inventory;
}): GoldTable {
  return {
    version: GOLD_VERSION,
    inputContentHash: params.inventory.inputContentHash,
    order: params.inventory.order,
    clusters: params.clusters,
    nilLabels: deriveNilLabels(params.clusters, params.inventory),
  };
}
