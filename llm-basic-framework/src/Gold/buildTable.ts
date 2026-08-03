import {
  GOLD_VERSION_2,
  type GoldCluster,
  type GoldEdge,
  type GoldNilLabel,
  type GoldTable,
  type Split,
} from '../Evaluation/gold';
import { UnionFind } from '../Evaluation/unionFind';
import type { Inventory } from './inventory';
import type { PairSource } from './preLabel';

/**
 * Steps 4 and 5 of E0: close adjudicated pairs under transitivity into clusters, derive the NIL
 * labels, and assign the dev/test split.
 *
 * All three are mechanical, and doing them by hand is where a gold table quietly goes wrong:
 * transitive closure by eye misses chains, NIL labels number in the thousands, and a split assigned
 * per-mention rather than per-cluster leaks aliases across it.
 */

/**
 * The four final verdicts, per the gold-by-projection amendment (SKEIN v2 deck, 2026-08-03):
 * `same` is an alias at the same grain; `rung` is finer/coarser of one thing (a ladder edge, never
 * a merge); `rename` is one referent re-designated over time (`Sandworm` → `APT44`); `different`
 * is everything else. The pre-amendment table collapsed `rung` and `rename` into `different`,
 * which threw away exactly the edges the granularity-error metrics need.
 */
export type PairLabel = 'same' | 'different' | 'rung' | 'rename';
export type PairRelation = 'isa' | 'part-of' | 'renamed-to';
/** Which side is the finer node (`rung`) or the older designation (`rename`). */
export type PairDirection = 'left' | 'right';

/** One adjudicated pair: the annotator's verdict on a proposal. */
export interface AdjudicatedPair {
  category: string;
  left: string;
  right: string;
  label: PairLabel;
  /** Required when label is `rung` (isa | part-of) or `rename` (renamed-to). */
  relation?: PairRelation;
  /** Required when label is `rung` or `rename` — see PairDirection. */
  direction?: PairDirection;
  stratum: string;
  evidence?: string;
  /** Which proposer surfaced this pair. Carried through to the cluster so the bias is reportable. */
  source?: PairSource;
  /** The pre-label rule that claimed the row — edge provenance. */
  rule?: string;
  /** Compact ensemble votes from the worksheet's model columns — edge provenance. */
  claudeVerdict?: string;
  gptVerdict?: string;
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
 *
 * **Only `same` merges.** `rung` and `rename` verdicts never enter the union-find — they become
 * edges *between* clusters (the deck's "hard non-merge plus a connecting edge"). A rung or rename
 * pair whose endpoints a `same` chain merged anyway is the same kind of contradiction as a merged
 * `different` pair, and is reported in `conflicts` alongside it.
 */
export function closeIntoClusters(
  pairs: AdjudicatedPair[],
  inventory: Inventory
): { clusters: GoldCluster[]; conflicts: AdjudicatedPair[] } {
  const union = new UnionFind<string>();
  const stratumOf = new Map<string, string>();
  const sourcesOf = new Map<string, Set<string>>();

  for (const pair of pairs) {
    if (pair.label !== 'same') continue;
    const a = key(pair.category, pair.left);
    const b = key(pair.category, pair.right);
    union.union(a, b);
    // Provenance accumulates per member, then unions with the cluster: a cluster formed by a
    // registry pair and a string pair carries both, and is therefore not registry-only. Compound
    // spellings (`embedding+registry`) split into components — the set holds proposers, not rows.
    for (const member of [a, b]) {
      const seen = sourcesOf.get(member) ?? new Set<string>();
      for (const component of (pair.source ?? 'string').split('+')) {
        if (component.trim()) seen.add(component.trim());
      }
      sourcesOf.set(member, seen);
    }
    // The hardest stratum in a cluster wins: a cluster containing a (d) pair is a (d) cluster,
    // because that is the capability being attributed.
    for (const member of [a, b]) {
      const current = stratumOf.get(member);
      if (current === undefined || pair.stratum > current) stratumOf.set(member, pair.stratum);
    }
  }

  const conflicts = pairs.filter((pair) => {
    // Every non-merging verdict conflicts with a `same` chain that connected its endpoints:
    // `different` is a straight contradiction, and `rung`/`rename` would put a node on a rung of
    // itself (or rename it to itself).
    if (pair.label === 'same') return false;
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
      sources: [...new Set(group.flatMap((member) => [...(sourcesOf.get(member) ?? [])]))].sort(),
      // Assigned later by assignSplit — a placeholder here would be a silently wrong default.
      split: 'test',
    });
  }

  return { clusters, conflicts };
}

/**
 * True when every mergeable cluster in a judgment stratum was proposed only by the registry.
 *
 * The registry is the batch Ψ_norm arm's own output, and `evaluate --batch` scores that arm against
 * the same file. Manual verification removes the registry's false merges, so precision is safe; it
 * cannot add the merges the registry never proposed, so **recall is not**. When nothing
 * proposer-independent contributed a (c)/(d) cluster, the batch arm's merge recall is inflated by
 * construction and the comparison against the streaming arm is not fair.
 *
 * Clearing this means doing the MITRE/Wikidata pass or the manual sweep — both of which §4 of
 * `docs/GOLD-TABLE.md` already requires. The check exists so that skipping them is visible rather
 * than silent.
 *
 * Returns false when there are no judgment-stratum clusters at all: that case is already covered,
 * and more precisely, by the empty-(d) warning.
 */
export function registryOnlyJudgmentStrata(clusters: GoldCluster[]): boolean {
  const judgment = clusters.filter(
    (cluster) => cluster.members.length > 1 && (cluster.stratum === 'c' || cluster.stratum === 'd')
  );
  if (judgment.length === 0) return false;
  return judgment.every(
    (cluster) => (cluster.sources ?? []).length > 0 && cluster.sources!.every((s) => s === 'registry')
  );
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

/**
 * Derive gold ladder + rename edges from the rung/rename verdicts — gold-by-projection.
 *
 * Direction is explicit in the pair (`direction` = the finer side for rungs, the older
 * designation for renames) and becomes `from` → `to` = finer → coarser / old → new. Endpoints
 * resolve to their *cluster* — the edge connects clusters, whichever member surface the
 * annotator happened to adjudicate. The same edge asserted through several pairs (two aliases of
 * one endpoint, two proposers) is emitted once with merged provenance.
 *
 * Skipped, deliberately: pairs whose endpoints share a cluster (a contradiction —
 * `closeIntoClusters` already reports it in `conflicts`) and pairs naming a surface no cluster
 * contains (not in the inventory; `gold build` discards those labels the same way).
 */
export function deriveEdges(pairs: AdjudicatedPair[], clusters: GoldCluster[]): GoldEdge[] {
  const clusterOf = new Map<string, GoldCluster>();
  for (const cluster of clusters) {
    for (const member of cluster.members) clusterOf.set(key(cluster.category, member), cluster);
  }

  const edges = new Map<string, GoldEdge>();
  for (const pair of pairs) {
    if (pair.label !== 'rung' && pair.label !== 'rename') continue;
    if (!pair.relation || !pair.direction) continue; // the worksheet parser enforces these; belt and braces

    const from = pair.direction === 'left' ? pair.left : pair.right;
    const to = pair.direction === 'left' ? pair.right : pair.left;
    const fromCluster = clusterOf.get(key(pair.category, from));
    const toCluster = clusterOf.get(key(pair.category, to));
    if (!fromCluster || !toCluster || fromCluster.id === toCluster.id) continue;

    const edgeKey = `${fold(pair.category)}|${fromCluster.id}|${toCluster.id}|${pair.relation}`;
    const existing = edges.get(edgeKey);
    const evidence = pair.evidence
      ? [{ pair: [pair.left, pair.right] as [string, string], snippet: pair.evidence, annotator: 'expert' as const }]
      : [];
    const sources = pair.source ? pair.source.split('+') : [];
    const models: Record<string, string> = {
      ...(pair.claudeVerdict ? { claude: pair.claudeVerdict } : {}),
      ...(pair.gptVerdict ? { gpt: pair.gptVerdict } : {}),
    };

    if (existing) {
      existing.evidence = [...(existing.evidence ?? []), ...evidence];
      existing.sources = [...new Set([...(existing.sources ?? []), ...sources])].sort();
      existing.models = { ...models, ...existing.models };
    } else {
      edges.set(edgeKey, {
        category: pair.category,
        from,
        to,
        kind: pair.relation,
        fromClusterId: fromCluster.id,
        toClusterId: toCluster.id,
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(sources.length > 0 ? { sources: [...sources].sort() } : {}),
        ...(Object.keys(models).length > 0 ? { models } : {}),
        ...(pair.rule ? { rule: pair.rule } : {}),
      });
    }
  }

  return [...edges.values()];
}

/** Assemble a complete, loadable gold table (v2 — clusters + edges). */
export function buildGoldTable(params: {
  clusters: GoldCluster[];
  inventory: Inventory;
  /** The adjudicated pairs, for edge derivation. Omitting them builds an edgeless table. */
  pairs?: AdjudicatedPair[];
}): GoldTable {
  return {
    version: GOLD_VERSION_2,
    inputContentHash: params.inventory.inputContentHash,
    order: params.inventory.order,
    clusters: params.clusters,
    edges: deriveEdges(params.pairs ?? [], params.clusters),
    nilLabels: deriveNilLabels(params.clusters, params.inventory),
  };
}
