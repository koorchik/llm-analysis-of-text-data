import type { LabeledPair, Stratum } from './clusterMetrics';
import type { NilObservation } from './nilMetrics';
import { Partition, elementKey, fromGoldClusters, type KeyOptions } from './partition';
import fs from 'fs/promises';

/**
 * Loader and validator for `gold-aliases-v1`.
 *
 * The schema is defined here, in M2, even though M9 produces the table — the loader must not be
 * written against an undefined format. Two properties are enforced rather than assumed, because
 * both are silent-corruption risks:
 *
 * 1. **`nilLabels` is position-indexed.** A flat mention→label map is rejected outright. NIL is a
 *    property of (mention, stream position), not of a mention: the same mention is NIL at its
 *    cluster's first occurrence and known at every later one, so a flat map cannot represent both
 *    and would silently mis-score the entire mint side.
 * 2. **`order` is recorded.** NIL labels are only valid for the stream order they were derived
 *    under, so a table replayed under a different order needs them regenerated, not reused.
 */

export const GOLD_VERSION = 'gold-aliases-v1';
export const GOLD_VERSION_2 = 'gold-aliases-v2';

export type Split = 'dev' | 'test';
export type AnnotatorKind = 'expert' | 'llm' | 'kb';
export type GoldEdgeKind = 'isa' | 'part-of' | 'renamed-to';

export interface GoldEvidence {
  pair: [string, string];
  snippet: string;
  source?: string;
  annotator: AnnotatorKind;
  rationale?: string;
  minutesSpent?: number;
}

export interface GoldCluster {
  id: string;
  category: string;
  /** Surface forms, not canonical names — see partition.ts for why. */
  members: string[];
  stratum: Stratum;
  split: Split;
  evidence?: GoldEvidence[];
  /**
   * Which proposers surfaced the pairs that formed this cluster.
   *
   * Provenance, not annotation: the verdicts are the annotator's either way. It is recorded because
   * one of the proposers — the unified-entities registry — is the batch Ψ_norm arm's own output,
   * which `evaluate --batch` scores. A cluster set whose judgment strata are entirely
   * registry-sourced cannot constrain that arm's merge recall, and the bias has to be reportable
   * rather than invisible.
   */
  sources?: string[];
}

/** One label per (docId, category, mention) occurrence, in the recorded stream order. */
export interface GoldNilLabel {
  docId: number;
  category: string;
  mention: string;
  label: 'NIL' | 'known';
  clusterId?: string;
}

/**
 * A gold ladder edge — gold-by-projection (SKEIN v2 deck amendment, 2026-08-03).
 *
 * `from` → `to` is finer → coarser for `isa`/`part-of`, and old → new designation for
 * `renamed-to`. Endpoints are member surfaces; `fromClusterId`/`toClusterId` are the derived
 * cluster-level view consumers actually join on — the edge connects clusters, whichever member
 * surface the annotator happened to adjudicate.
 */
export interface GoldEdge {
  category: string;
  from: string;
  to: string;
  kind: GoldEdgeKind;
  fromClusterId?: string;
  toClusterId?: string;
  evidence?: GoldEvidence[];
  /** Proposer provenance, same vocabulary as GoldCluster.sources. */
  sources?: string[];
  /** Per-model ensemble votes in compact form — the per-edge provenance the deck requires. */
  models?: Record<string, string>;
  /** The pre-label rule that had claimed the row. */
  rule?: string;
}

export interface GoldTable {
  version: typeof GOLD_VERSION | typeof GOLD_VERSION_2;
  inputContentHash: string;
  /** The stream order the NIL labels were derived under. */
  order: string;
  clusters: GoldCluster[];
  /** Ladder + rename edges. Always present after validation; empty for a v1 table. */
  edges: GoldEdge[];
  nilLabels: GoldNilLabel[];
}

export class GoldValidationError extends Error {}

function fail(message: string): never {
  throw new GoldValidationError(message);
}

/**
 * Validate a parsed object as a gold table. Deliberately strict: a gold table is the reference
 * every number in the paper is measured against, so a malformed one must fail loudly at load
 * rather than produce a plausible wrong score.
 */
export function validateGoldTable(data: unknown): GoldTable {
  if (typeof data !== 'object' || data === null) fail('gold table is not an object');
  const table = data as Record<string, unknown>;

  if (table.version !== GOLD_VERSION && table.version !== GOLD_VERSION_2) {
    fail(
      `unsupported gold version ${JSON.stringify(table.version)}; expected ${GOLD_VERSION} or ${GOLD_VERSION_2}`
    );
  }
  if (typeof table.inputContentHash !== 'string' || table.inputContentHash.length === 0) {
    fail('inputContentHash is required — a gold table must name the corpus it annotates');
  }
  if (typeof table.order !== 'string' || table.order.length === 0) {
    fail('order is required — NIL labels are only valid for the stream order they were derived under');
  }
  if (!Array.isArray(table.clusters)) fail('clusters must be an array');

  // The amendment this loader exists to enforce.
  if (table.nilLabels !== undefined && !Array.isArray(table.nilLabels)) {
    fail(
      'nilLabels must be an ARRAY of {docId, category, mention, label} rows, not an object. ' +
        'A flat mention→label map cannot express prefix-relative labels: the same mention is NIL at ' +
        'its first occurrence and known later, so both labels must coexist. See the M2 gold schema.'
    );
  }

  const clusters: GoldCluster[] = [];
  const seenClusterIds = new Set<string>();
  const memberOwner = new Map<string, string>();

  for (const [index, raw] of (table.clusters as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null) fail(`clusters[${index}] is not an object`);
    const cluster = raw as Record<string, unknown>;

    const id = cluster.id;
    if (typeof id !== 'string' || id.length === 0) fail(`clusters[${index}].id is required`);
    if (seenClusterIds.has(id)) fail(`duplicate cluster id ${id}`);
    seenClusterIds.add(id);

    if (typeof cluster.category !== 'string' || cluster.category.length === 0) {
      fail(`cluster ${id}: category is required`);
    }
    if (!Array.isArray(cluster.members) || cluster.members.length === 0) {
      fail(`cluster ${id}: members must be a non-empty array`);
    }
    for (const member of cluster.members) {
      if (typeof member !== 'string' || member.trim().length === 0) {
        fail(`cluster ${id}: members must be non-empty strings`);
      }
    }
    if (typeof cluster.stratum !== 'string' || cluster.stratum.length === 0) {
      fail(`cluster ${id}: stratum is required — strata are reported separately, never averaged`);
    }
    if (cluster.split !== 'dev' && cluster.split !== 'test') {
      fail(`cluster ${id}: split must be "dev" or "test", got ${JSON.stringify(cluster.split)}`);
    }

    // A surface form in two gold clusters is a contradiction in the gold itself.
    for (const member of cluster.members as string[]) {
      const key = elementKey(cluster.category as string, member);
      const owner = memberOwner.get(key);
      if (owner !== undefined && owner !== id) {
        fail(`member ${JSON.stringify(member)} appears in gold clusters ${owner} and ${id}`);
      }
      memberOwner.set(key, id);
    }

    clusters.push(cluster as unknown as GoldCluster);
  }

  // Edges — v2's addition. A v1 table carrying edges is a version lie, rejected as such.
  if (table.version === GOLD_VERSION && table.edges !== undefined) {
    fail(`a ${GOLD_VERSION} table must not carry edges — declare ${GOLD_VERSION_2}`);
  }
  if (table.edges !== undefined && !Array.isArray(table.edges)) fail('edges must be an array');

  const edges: GoldEdge[] = [];
  const seenEdges = new Set<string>();
  const foldEdge = (value: string) => value.trim().toLowerCase();
  for (const [index, raw] of ((table.edges as unknown[]) ?? []).entries()) {
    if (typeof raw !== 'object' || raw === null) fail(`edges[${index}] is not an object`);
    const edge = raw as Record<string, unknown>;

    if (typeof edge.category !== 'string' || edge.category.length === 0) {
      fail(`edges[${index}]: category is required`);
    }
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string' || !edge.from || !edge.to) {
      fail(`edges[${index}]: from and to are required`);
    }
    if (edge.kind !== 'isa' && edge.kind !== 'part-of' && edge.kind !== 'renamed-to') {
      fail(
        `edges[${index}]: kind must be "isa", "part-of" or "renamed-to", got ${JSON.stringify(edge.kind)} — ` +
          'assertional relations never enter the identity layer'
      );
    }

    // Endpoints must be member surfaces of clusters in the same category — and of two DIFFERENT
    // clusters: an edge inside one cluster asserts a node sits on a rung of itself.
    const owners: string[] = [];
    for (const endpoint of [edge.from, edge.to] as string[]) {
      const owner = memberOwner.get(elementKey(edge.category as string, endpoint));
      if (owner === undefined) {
        fail(`edges[${index}]: ${JSON.stringify(endpoint)} is in no ${edge.category} cluster`);
      }
      owners.push(owner!);
    }
    if (owners[0] === owners[1]) {
      fail(`edges[${index}]: both endpoints resolve to cluster ${owners[0]} — a cluster cannot rung to itself`);
    }

    const key = [foldEdge(edge.category as string), foldEdge(edge.from as string), foldEdge(edge.to as string), edge.kind].join('|');
    if (seenEdges.has(key)) fail(`edges[${index}]: duplicate edge ${key}`);
    seenEdges.add(key);

    edges.push(edge as unknown as GoldEdge);
  }

  const nilLabels: GoldNilLabel[] = [];
  for (const [index, raw] of ((table.nilLabels as unknown[]) ?? []).entries()) {
    if (typeof raw !== 'object' || raw === null) fail(`nilLabels[${index}] is not an object`);
    const label = raw as Record<string, unknown>;
    if (typeof label.docId !== 'number' || !Number.isFinite(label.docId)) {
      fail(`nilLabels[${index}].docId must be a number — NIL is position-relative`);
    }
    if (typeof label.category !== 'string' || typeof label.mention !== 'string') {
      fail(`nilLabels[${index}] requires category and mention`);
    }
    if (label.label !== 'NIL' && label.label !== 'known') {
      fail(`nilLabels[${index}].label must be "NIL" or "known"`);
    }
    nilLabels.push(label as unknown as GoldNilLabel);
  }

  return { ...(table as unknown as GoldTable), clusters, edges, nilLabels };
}

/**
 * The gold ladder + rename edges — [] on a v1 table.
 *
 * The one accessor downstream hierarchical metrics (hP/hR/hF over granularity errors) will read;
 * `labeledPairs`, `goldPartition` and the NIL logic stay deliberately blind to edges, so every
 * flat-coreference consumer scores v2 exactly as it scored v1.
 */
export function goldEdges(table: GoldTable): GoldEdge[] {
  return table.edges ?? [];
}

export async function loadGoldTable(filePath: string): Promise<GoldTable> {
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GoldValidationError(`gold table at ${filePath} is not valid JSON: ${error}`);
  }
  return validateGoldTable(parsed);
}

// --- split discipline ---------------------------------------------------------------------------

/**
 * Restrict a gold table to one split.
 *
 * The dev/test discipline is not advisory: **prompt and configuration tuning happens on dev only,
 * and reported results come from test only** (protocol §6). Splitting is by cluster, never by pair,
 * because pairs drawn from one cluster would leak membership across the boundary.
 */
export function selectSplit(table: GoldTable, split: Split): GoldTable {
  const clusters = table.clusters.filter((cluster) => cluster.split === split);
  const clusterIds = new Set(clusters.map((cluster) => cluster.id));
  const memberKeys = new Set(
    clusters.flatMap((cluster) => cluster.members.map((member) => elementKey(cluster.category, member)))
  );

  return {
    ...table,
    clusters,
    // An edge lives in a split only when BOTH endpoint clusters do — a dangling edge would send a
    // consumer looking for a cluster the slice does not contain.
    edges: (table.edges ?? []).filter(
      (edge) =>
        memberKeys.has(elementKey(edge.category, edge.from)) &&
        memberKeys.has(elementKey(edge.category, edge.to))
    ),
    nilLabels: table.nilLabels.filter(
      (label) =>
        (label.clusterId !== undefined && clusterIds.has(label.clusterId)) ||
        (label.clusterId === undefined && memberKeys.has(elementKey(label.category, label.mention)))
    ),
  };
}

/**
 * Restrict a gold table to one category — the fast-iteration loop's scoring slice
 * (spec 2026-08-16). Unlike selectSplit there is no membership subtlety: clusters, edges and NIL
 * labels all carry the category directly. Case-insensitive to match elementKey's lowercasing.
 */
export function selectCategory(table: GoldTable, category: string): GoldTable {
  const want = category.trim().toLowerCase();
  const match = (name: string) => name.trim().toLowerCase() === want;
  return {
    ...table,
    clusters: table.clusters.filter((cluster) => match(cluster.category)),
    edges: (table.edges ?? []).filter((edge) => match(edge.category)),
    nilLabels: table.nilLabels.filter((label) => match(label.category)),
  };
}

/**
 * Guard against scoring on the wrong split.
 *
 * Called by `bin/evaluate.ts` before any reported number is produced. It cannot enforce that no
 * human peeked, but it can make an accidental `--split dev` in a results run fail loudly.
 */
export function assertReportableSplit(split: Split, options: { allowDev?: boolean } = {}): void {
  if (split === 'dev' && !options.allowDev) {
    throw new GoldValidationError(
      'refusing to report results from the dev split: dev is for tuning only (protocol §6). ' +
        'Pass allowDev explicitly if this is a tuning run, and do not put the output in the paper.'
    );
  }
}

// --- derived views ------------------------------------------------------------------------------

export function goldPartition(table: GoldTable, options: KeyOptions = {}): Partition {
  return fromGoldClusters(table.clusters, options);
}

/**
 * The labelled pair set for per-stratum merge P/R.
 *
 * Positives come from within-cluster pairs, carrying that cluster's stratum. Negatives come from
 * cross-cluster pairs **within the same category and stratum** — a cross-category pair is not a
 * meaningful merge candidate, and pairing across strata would attribute an error to whichever
 * stratum happened to supply an endpoint.
 */
export function labeledPairs(table: GoldTable, options: KeyOptions = {}): LabeledPair[] {
  const pairs: LabeledPair[] = [];

  // Positives.
  for (const cluster of table.clusters) {
    const keys = cluster.members.map((member) => elementKey(cluster.category, member, options));
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        pairs.push({ a: keys[i], b: keys[j], stratum: cluster.stratum });
      }
    }
  }

  // Negatives, grouped by (category, stratum).
  const groups = new Map<string, GoldCluster[]>();
  for (const cluster of table.clusters) {
    const key = `${cluster.category} ${cluster.stratum}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(cluster);
    else groups.set(key, [cluster]);
  }

  for (const bucket of groups.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        for (const memberA of bucket[i].members) {
          for (const memberB of bucket[j].members) {
            pairs.push({
              a: elementKey(bucket[i].category, memberA, options),
              b: elementKey(bucket[j].category, memberB, options),
              stratum: bucket[i].stratum,
            });
          }
        }
      }
    }
  }

  return pairs;
}

/**
 * Join gold NIL labels to a run's decisions, producing the observations `nilMetrics` scores.
 *
 * Keyed by (docId, category, mention) so the same mention at two stream positions is two
 * observations, and so one document carrying one surface form under two categories keeps both.
 * A decision with no gold label is dropped and counted — scoring it would invent a label.
 */
export function nilObservations(
  table: GoldTable,
  decisions: Array<{ docId: number; category: string; mention: string; decision: 'link' | 'mint' | 'defer' }>,
  options: { stratumOf?: (label: GoldNilLabel) => Stratum | undefined } = {}
): { observations: NilObservation[]; unlabeled: number } {
  const key = (docId: number, category: string, mention: string) =>
    `${docId} ${category.trim().toLowerCase()} ${mention.trim().toLowerCase()}`;

  const labels = new Map<string, GoldNilLabel>();
  for (const label of table.nilLabels) {
    labels.set(key(label.docId, label.category, label.mention), label);
  }

  const observations: NilObservation[] = [];
  let unlabeled = 0;

  for (const decision of decisions) {
    const label = labels.get(key(decision.docId, decision.category, decision.mention));
    if (!label) {
      unlabeled++;
      continue;
    }
    observations.push({
      docId: decision.docId,
      category: decision.category,
      mention: decision.mention,
      goldNil: label.label === 'NIL',
      decision: decision.decision,
      stratum: options.stratumOf?.(label),
    });
  }

  return { observations, unlabeled };
}

export function goldSummary(table: GoldTable) {
  const byStratum = new Map<Stratum, number>();
  const bySplit = new Map<Split, number>();
  let members = 0;
  let withEvidence = 0;

  for (const cluster of table.clusters) {
    byStratum.set(cluster.stratum, (byStratum.get(cluster.stratum) ?? 0) + 1);
    bySplit.set(cluster.split, (bySplit.get(cluster.split) ?? 0) + 1);
    members += cluster.members.length;
    if (cluster.evidence && cluster.evidence.length > 0) withEvidence++;
  }

  return {
    version: table.version,
    inputContentHash: table.inputContentHash,
    order: table.order,
    clusters: table.clusters.length,
    members,
    byStratum: Object.fromEntries(byStratum),
    bySplit: Object.fromEntries(bySplit),
    clustersWithEvidence: withEvidence,
    edges: (table.edges ?? []).length,
    nilLabels: table.nilLabels.length,
  };
}
