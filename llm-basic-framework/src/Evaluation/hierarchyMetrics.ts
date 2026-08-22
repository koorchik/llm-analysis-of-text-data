import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { normalizeSurface } from './partition';

/**
 * Granularity-edge scoring — the half of SKEIN v2 the identity metrics never looked at.
 *
 * The gold table carries **249 hierarchy edges** (`part-of`, `isa`, `renamed-to`) that no metric
 * consumed before 2026-08-20, so every arm's ladder output was unscored and a judge that emitted no
 * edges at all read the same as one that got them right.
 *
 * **Scored between clusters, never between rungs.** A run's canonical is mapped to the gold cluster
 * its surfaces belong to, and an edge is a directed pair of gold cluster ids. Rung labels (`g0`…`g3`)
 * are a run-local artifact of whatever ladder that arm discovered — two arms can express the same
 * hierarchy with different rung numbering, and comparing the labels would score the numbering rather
 * than the graph.
 *
 * Three denominators, reported separately because they answer different questions:
 *
 * - **raw recall** over every gold edge in the scored slice — what fraction of the known hierarchy
 *   this run reproduced.
 * - **reachable recall** over the gold edges whose endpoints both exist as canonicals in this run —
 *   what fraction it got right *of what it could have seen*. A subset corpus makes most edges
 *   unreachable, so raw recall on a 22-document slice is a floor, not a verdict.
 * - **transitive** credit — `A→C` counts when gold has `A→B→C`. Coarsening is transitive, so an arm
 *   that skips an intermediate rung has the relation right and the granularity coarse.
 *
 * `collapsed` is tracked apart from precision: an edge whose endpoints land in the *same* gold
 * cluster is not a false hierarchy claim, it is a merge the judge expressed as a parent link. That
 * is a different defect with a different fix, so pooling it into edge precision would hide it.
 */
export interface HierarchyEdge {
  category: string;
  from: string;
  to: string;
  kind: string;
}

export interface GoldHierarchyEdge {
  category: string;
  from: string;
  to: string;
  kind: string;
  fromClusterId?: string;
  toClusterId?: string;
}

export interface GoldClusterForHierarchy {
  id: string;
  category: string;
  members: string[];
  split?: string;
}

export interface HierarchyMetrics {
  /** Edges the run emitted, after mapping both endpoints onto gold clusters. */
  predicted: number;
  /** Emitted edges dropped because an endpoint is not in the gold table at all. */
  unmappable: number;
  /** Emitted edges whose endpoints are the same gold cluster — a merge stated as a parent link. */
  collapsed: number;
  /** Gold edges in the scored slice. */
  goldTotal: number;
  /** Gold edges whose endpoints both exist as canonicals in this run. */
  goldReachable: number;
  matched: number;
  matchedTransitive: number;
  precision: number;
  recall: number;
  f1: number;
  recallReachable: number;
  /** Of the matched edges, the share whose kind agrees with gold under {@link KIND_ALIASES}. */
  kindAgreement: number | null;
}

/**
 * The registry writes the ISO 25964 broader-term typology, gold was annotated in the ontology
 * vocabulary. `broaderGeneric` (is-a) and `broaderInstantial` (a named instance/version — a
 * refinement of is-a) both fold onto gold's `isa`; `broaderPartitive` is gold's `part-of`.
 * Legacy keys (`coarsens-to` from ladder-era registries) are kept so old baselines re-score in the
 * same table. Keys are lowercase — `foldKind` lower-cases before lookup.
 */
const KIND_ALIASES: Record<string, string> = {
  broadergeneric: 'isa',
  broaderinstantial: 'isa',
  broaderpartitive: 'part-of',
  'coarsens-to': 'isa',
  isa: 'isa',
  'part-of': 'part-of',
  'renamed-to': 'renamed-to',
};

const foldKind = (kind: string) => KIND_ALIASES[kind.trim().toLowerCase()] ?? kind.trim().toLowerCase();
const surfaceKey = (category: string, surface: string) =>
  `${category.trim().toLowerCase()}|${normalizeSurface(surface)}`;

/** canonical (category-qualified) → gold cluster id, by majority over the canonical's surfaces. */
export function mapCanonicalsToGold(
  registryCanonicals: Array<{ category: string; canonical: string; surfaces: string[] }>,
  goldClusters: GoldClusterForHierarchy[]
): Map<string, string> {
  const clusterOfSurface = new Map<string, string>();
  for (const cluster of goldClusters) {
    for (const member of cluster.members) {
      clusterOfSurface.set(surfaceKey(cluster.category, member), cluster.id);
    }
  }

  const mapped = new Map<string, string>();
  for (const entry of registryCanonicals) {
    const votes = new Map<string, number>();
    for (const surface of [entry.canonical, ...entry.surfaces]) {
      const clusterId = clusterOfSurface.get(surfaceKey(entry.category, surface));
      if (clusterId) votes.set(clusterId, (votes.get(clusterId) ?? 0) + 1);
    }
    if (votes.size === 0) continue;
    // Ties break on the cluster id so an over-merged canonical maps deterministically rather than
    // by object insertion order.
    const winner = [...votes.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0][0];
    mapped.set(`${entry.category.trim().toLowerCase()}|${entry.canonical}`, winner);
  }
  return mapped;
}

/** Directed reachability over the gold edge set, for transitive credit. */
function transitiveClosure(edges: Array<[string, string]>): Set<string> {
  const out = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    (out.get(from) ?? out.set(from, new Set()).get(from)!).add(to);
  }
  const closure = new Set<string>();
  for (const start of out.keys()) {
    const stack = [...(out.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      closure.add(`${start}→${node}`);
      for (const next of out.get(node) ?? []) stack.push(next);
    }
  }
  return closure;
}

export function hierarchyMetrics(params: {
  predictedEdges: HierarchyEdge[];
  registryCanonicals: Array<{ category: string; canonical: string; surfaces: string[] }>;
  goldClusters: GoldClusterForHierarchy[];
  goldEdges: GoldHierarchyEdge[];
}): HierarchyMetrics {
  const { predictedEdges, registryCanonicals, goldClusters, goldEdges } = params;
  const canonicalToCluster = mapCanonicalsToGold(registryCanonicals, goldClusters);
  const clusterById = new Map(goldClusters.map((cluster) => [cluster.id, cluster]));
  const key = (category: string, canonical: string) =>
    canonicalToCluster.get(`${category.trim().toLowerCase()}|${canonical}`);

  // Gold edges as cluster pairs, restricted to clusters present in the scored slice.
  const goldPairs = new Map<string, string>(); // "from→to" -> kind
  const goldPairList: Array<[string, string]> = [];
  for (const edge of goldEdges) {
    const from = edge.fromClusterId;
    const to = edge.toClusterId;
    if (!from || !to || !clusterById.has(from) || !clusterById.has(to)) continue;
    goldPairs.set(`${from}→${to}`, foldKind(edge.kind));
    goldPairList.push([from, to]);
  }
  const goldClosure = transitiveClosure(goldPairList);

  const presentClusters = new Set(canonicalToCluster.values());
  const goldReachable = [...goldPairs.keys()].filter((pair) => {
    const [from, to] = pair.split('→');
    return presentClusters.has(from) && presentClusters.has(to);
  }).length;

  let unmappable = 0;
  let collapsed = 0;
  const predictedPairs = new Map<string, string>();
  for (const edge of predictedEdges) {
    const from = key(edge.category, edge.from);
    const to = key(edge.category, edge.to);
    if (!from || !to) {
      unmappable += 1;
      continue;
    }
    if (from === to) {
      collapsed += 1;
      continue;
    }
    predictedPairs.set(`${from}→${to}`, foldKind(edge.kind));
  }

  let matched = 0;
  let matchedTransitive = 0;
  let kindAgree = 0;
  for (const [pair, kind] of predictedPairs) {
    if (goldPairs.has(pair)) {
      matched += 1;
      matchedTransitive += 1;
      if (goldPairs.get(pair) === kind) kindAgree += 1;
    } else if (goldClosure.has(pair)) {
      matchedTransitive += 1;
    }
  }

  const precision = predictedPairs.size ? matched / predictedPairs.size : 0;
  const recall = goldPairs.size ? matched / goldPairs.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    predicted: predictedPairs.size,
    unmappable,
    collapsed,
    goldTotal: goldPairs.size,
    goldReachable,
    matched,
    matchedTransitive,
    precision,
    recall,
    f1,
    recallReachable: goldReachable ? matched / goldReachable : 0,
    kindAgreement: matched ? kindAgree / matched : null,
  };
}

/**
 * Pull the run's canonicals and broader edges out of a registry file (any version, v1–v6),
 * routed through `ConceptRegistry.parse` — the single shape normalizer, so the legacy-kind folding
 * is never duplicated here. The scoring kind is the edge's ISO 25964 `type`, folded onto the gold
 * vocabulary by {@link KIND_ALIASES}; untyped edges score as `untyped` and never agree with gold.
 */
export function readRegistryHierarchy(registry: unknown): {
  canonicals: Array<{ category: string; canonical: string; surfaces: string[] }>;
  edges: HierarchyEdge[];
} {
  const { conceptSchemes, broaderEdges } = ConceptRegistry.parse(registry);

  const canonicals: Array<{ category: string; canonical: string; surfaces: string[] }> = [];
  for (const [category, records] of Object.entries(conceptSchemes)) {
    for (const [canonical, record] of Object.entries(records ?? {})) {
      canonicals.push({
        category,
        canonical,
        surfaces: record.labels.map((label) => label.surface),
      });
    }
  }

  const edges: HierarchyEdge[] = [];
  for (const [category, list] of Object.entries(broaderEdges)) {
    for (const edge of list ?? []) {
      if (!edge?.narrower || !edge?.broader) continue;
      edges.push({
        category,
        from: edge.narrower,
        to: edge.broader,
        kind: edge.type ?? 'untyped',
      });
    }
  }
  return { canonicals, edges };
}
