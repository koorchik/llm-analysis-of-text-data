/**
 * Union-find with path compression and union by rank.
 *
 * Needed by gold closure (Phase 2.4), by repair (M8), and by `ConceptRegistry.applyMerges`, whose
 * v1 implementation applied `from→into` sequentially behind a `records[from] && records[into]`
 * guard and therefore dropped chained merges depending on their order: `[{A→B},{B→C}]` succeeded
 * while `[{B→C},{A→B}]` silently lost `A→B`. Order-dependence is worse than plain breakage,
 * because the same merge set yields different registries run to run. Closure is order-independent
 * by construction, which is the point of routing merges through here (M3).
 */
export class UnionFind<T> {
  #parent = new Map<T, T>();
  #rank = new Map<T, number>();

  constructor(elements: Iterable<T> = []) {
    for (const element of elements) this.add(element);
  }

  add(element: T): void {
    if (!this.#parent.has(element)) {
      this.#parent.set(element, element);
      this.#rank.set(element, 0);
    }
  }

  has(element: T): boolean {
    return this.#parent.has(element);
  }

  /** Iterative to stay safe on long chains — a recursive find can blow the stack. */
  find(element: T): T {
    this.add(element);

    let root = element;
    while (this.#parent.get(root) !== root) {
      root = this.#parent.get(root)!;
    }

    // Path compression: point everything on the walk straight at the root.
    let cursor = element;
    while (this.#parent.get(cursor) !== root) {
      const next = this.#parent.get(cursor)!;
      this.#parent.set(cursor, root);
      cursor = next;
    }

    return root;
  }

  /** Returns true when the two were in different sets (i.e. this call merged something). */
  union(a: T, b: T): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;

    const rankA = this.#rank.get(rootA)!;
    const rankB = this.#rank.get(rootB)!;

    if (rankA < rankB) {
      this.#parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.#parent.set(rootB, rootA);
    } else {
      this.#parent.set(rootB, rootA);
      this.#rank.set(rootA, rankA + 1);
    }
    return true;
  }

  connected(a: T, b: T): boolean {
    return this.find(a) === this.find(b);
  }

  get size(): number {
    return this.#parent.size;
  }

  /**
   * All sets as arrays. Elements keep insertion order within a set, and sets are ordered by their
   * first-inserted element, so output is deterministic for a given insertion sequence.
   */
  groups(): T[][] {
    const bucket = new Map<T, T[]>();
    for (const element of this.#parent.keys()) {
      const root = this.find(element);
      const existing = bucket.get(root);
      if (existing) existing.push(element);
      else bucket.set(root, [element]);
    }
    return [...bucket.values()];
  }

  groupCount(): number {
    const roots = new Set<T>();
    for (const element of this.#parent.keys()) roots.add(this.find(element));
    return roots.size;
  }
}

/**
 * Transitive closure of a pair list into groups. Singletons appear only if listed in `elements`.
 *
 * This is the operation Phase 2.4 calls for when turning annotated alias pairs into gold clusters:
 * if A=B and B=C are both annotated, A and C are in one gold cluster whether or not that pair was
 * ever shown to an annotator.
 */
export function closure<T>(
  pairs: Iterable<readonly [T, T]>,
  elements: Iterable<T> = []
): T[][] {
  const uf = new UnionFind<T>(elements);
  for (const [a, b] of pairs) uf.union(a, b);
  return uf.groups();
}
