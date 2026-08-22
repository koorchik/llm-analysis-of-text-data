import type { DecisionEvent } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { UnionFind } from './unionFind';

/**
 * A partition of surface forms into clusters, which is the only representation that can be
 * compared across arms.
 *
 * **Membership, never canonical names.** Batch Ψ_norm normalizes to English canonicals while
 * streaming Ψ_link links to first-seen surface forms, so two arms that agree perfectly still
 * disagree on every canonical string. Any name-based comparison would therefore be invalid across
 * arms — hence gold stores cluster membership too (M9).
 */

export type ElementKey = string;

export interface KeyOptions {
  /**
   * Include the category in the element key. Default true.
   *
   * Set false when comparing arms whose category vocabularies differ: the streaming pipeline's
   * schema is emergent (a live run produced `VictimOrganization` and `Malware file`), so a
   * category-qualified key would make every element a non-match against a fixed-vocabulary gold.
   */
  includeCategory?: boolean;
}

export function normalizeSurface(surface: string): string {
  return surface.trim().toLowerCase();
}

export function elementKey(category: string, surface: string, options: KeyOptions = {}): ElementKey {
  const includeCategory = options.includeCategory ?? true;
  const name = normalizeSurface(surface);
  return includeCategory ? `${category.trim().toLowerCase()}|${name}` : name;
}

/**
 * Order-independent key for an unordered element pair.
 *
 * The separator is NUL because element keys legitimately contain spaces and `|`
 * (`hackergroup|fancy bear`), and any printable separator would make pair keys ambiguous:
 * elements `"x y"`+`"z"` and `"x"`+`"y z"` would collide on a space-joined key, silently merging
 * two different pairs in every pairwise metric.
 */
export function pairKey(a: ElementKey, b: ElementKey): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export interface Cluster {
  id: string;
  members: ElementKey[];
}

export class Partition {
  #clusters: Cluster[] = [];
  #byElement = new Map<ElementKey, string>();

  constructor(groups: Iterable<{ id?: string; members: Iterable<ElementKey> }>) {
    let autoId = 0;
    for (const group of groups) {
      const members = [...new Set(group.members)];
      if (members.length === 0) continue;
      const id = group.id ?? `c${autoId++}`;
      this.#clusters.push({ id, members });
      for (const member of members) {
        // An element in two clusters is a caller bug, not something to silently absorb: every
        // metric below assumes each element has exactly one cluster.
        const existing = this.#byElement.get(member);
        if (existing !== undefined && existing !== id) {
          throw new Error(`Partition: element ${member} appears in clusters ${existing} and ${id}`);
        }
        this.#byElement.set(member, id);
      }
    }
  }

  get clusters(): readonly Cluster[] {
    return this.#clusters;
  }

  get size(): number {
    return this.#clusters.length;
  }

  get elementCount(): number {
    return this.#byElement.size;
  }

  elements(): ElementKey[] {
    return [...this.#byElement.keys()];
  }

  clusterIdOf(element: ElementKey): string | undefined {
    return this.#byElement.get(element);
  }

  membersOf(clusterId: string): ElementKey[] {
    return this.#clusters.find((cluster) => cluster.id === clusterId)?.members ?? [];
  }

  /** True when both elements are present AND in the same cluster. */
  sameCluster(a: ElementKey, b: ElementKey): boolean {
    const clusterA = this.#byElement.get(a);
    return clusterA !== undefined && clusterA === this.#byElement.get(b);
  }

  /**
   * Restrict to a set of elements, dropping everything else and any cluster left empty.
   *
   * Required before scoring: a predicted partition contains surface forms gold never annotated,
   * and building a partition from the batch map introduces canonical names that are not surface
   * forms at all (e.g. "Microsoft Corporation" when only "MSFT" and "Microsoft Corp" were seen).
   * Those phantoms must not count as elements — but they must still have done their job of
   * connecting the real surfaces before being dropped, which is why restriction happens last.
   */
  restrictTo(elements: Iterable<ElementKey>): Partition {
    const keep = new Set(elements);
    return new Partition(
      this.#clusters
        .map((cluster) => ({
          id: cluster.id,
          members: cluster.members.filter((member) => keep.has(member)),
        }))
        .filter((cluster) => cluster.members.length > 0)
    );
  }

  /** All unordered same-cluster pairs, keyed by {@link pairKey}. */
  pairKeys(): Set<string> {
    const pairs = new Set<string>();
    for (const cluster of this.#clusters) {
      const members = [...cluster.members].sort();
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          pairs.add(pairKey(members[i], members[j]));
        }
      }
    }
    return pairs;
  }

  /** Σ C(|c|, 2) — the number of same-cluster pairs, without materialising them. */
  pairCount(): number {
    return this.#clusters.reduce(
      (sum, cluster) => sum + (cluster.members.length * (cluster.members.length - 1)) / 2,
      0
    );
  }

  static fromGroups(groups: Iterable<Iterable<ElementKey>>): Partition {
    return new Partition([...groups].map((members) => ({ members })));
  }
}

// --- Source 1: an ConceptRegistry on disk ------------------------------------------------------

/**
 * Accepts every registry version (v1–v6) by routing through `ConceptRegistry.parse`, the single
 * shape normalizer — the earlier hand-rolled version sniffing here once read a whole v3 file as
 * the category map, so `granularityEdges`/`deferQueue` became phantom clusters and every real
 * cluster went unscored (a silent wrong answer, not a crash). The canonical name is included as a
 * member because `mint` stores it in its own label list; including it twice is harmless (members
 * are de-duplicated).
 */
export function fromRegistry(data: unknown, options: KeyOptions = {}): Partition {
  const { conceptSchemes } = ConceptRegistry.parse(data);

  const groups: Array<{ id: string; members: ElementKey[] }> = [];
  for (const [category, records] of Object.entries(conceptSchemes)) {
    for (const [canonical, record] of Object.entries(records ?? {})) {
      const surfaces = [canonical, ...record.labels.map((label) => label.surface)];
      groups.push({
        id: `${category}|${canonical}`,
        members: surfaces
          .filter((surface): surface is string => typeof surface === 'string' && surface.length > 0)
          .map((surface) => elementKey(category, surface, options)),
      });
    }
  }
  return new Partition(groups);
}

// --- Source 2: the gold table -----------------------------------------------------------------

export interface GoldClusterLike {
  id: string;
  category: string;
  members: string[];
}

export function fromGoldClusters(
  clusters: GoldClusterLike[],
  options: KeyOptions = {}
): Partition {
  return new Partition(
    clusters.map((cluster) => ({
      id: cluster.id,
      members: cluster.members.map((member) => elementKey(cluster.category, member, options)),
    }))
  );
}

// --- Source 3: a decision log -----------------------------------------------------------------

/**
 * Transitive closure of `mention ~ target` over the log.
 *
 * Closure rather than grouping by target, because the stream is not static: a mention can mint a
 * canonical and a later mention can link to it, and a mention's target can change across
 * documents. Union-find gives the same answer regardless of the order rows appear in.
 *
 * `defer` rows are skipped — a withheld decision asserts no membership (see
 * docs/statistical-protocol.md §5). They are counted in the deferral rate, not here.
 */
export function fromDecisionEvents(
  events: DecisionEvent[],
  options: KeyOptions = {}
): Partition {
  const uf = new UnionFind<ElementKey>();

  for (const event of events) {
    if (event.decision === 'defer') continue;
    const mention = elementKey(event.category, event.mention, options);
    uf.add(mention);
    if (event.target) {
      uf.union(mention, elementKey(event.category, event.target, options));
    }
  }

  return Partition.fromGroups(uf.groups());
}

// --- Source 4: the batch entities.json name→name map ------------------------------------------

export interface BatchEntitiesFile {
  entities: { [category: string]: { [surface: string]: string } };
}

/**
 * The published Ψ_norm artifact: category → surface → normalized name.
 *
 * **This is the only artifact E1 can be scored from**, which is why it is a first-class partition
 * source rather than something reconstructed later. Omitting it would leave the CRITICAL Ψ_norm
 * baseline unscoreable.
 *
 * A normalized name that is not itself a surface form (e.g. an invented English canonical) joins
 * its group and is then dropped by `restrictTo(goldElements)` — after having connected the real
 * surfaces that map to it.
 */
export function fromBatchEntitiesMap(
  file: BatchEntitiesFile,
  options: KeyOptions = {}
): Partition {
  const uf = new UnionFind<ElementKey>();

  for (const [category, mapping] of Object.entries(file.entities ?? {})) {
    for (const [surface, normalized] of Object.entries(mapping ?? {})) {
      const from = elementKey(category, surface, options);
      uf.add(from);
      if (typeof normalized === 'string' && normalized.length > 0) {
        uf.union(from, elementKey(category, normalized, options));
      }
    }
  }

  return Partition.fromGroups(uf.groups());
}

/**
 * The element universe two partitions can be compared over: elements present in both.
 *
 * Scoring outside the intersection is meaningless — a predicted cluster over surfaces gold never
 * annotated is neither right nor wrong, and gold elements the system never saw are a coverage
 * question, not a precision one. Callers should report the intersection size alongside any metric.
 */
export function sharedElements(a: Partition, b: Partition): ElementKey[] {
  const inB = new Set(b.elements());
  return a.elements().filter((element) => inB.has(element));
}
