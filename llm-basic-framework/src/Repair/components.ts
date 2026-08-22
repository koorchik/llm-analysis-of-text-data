import { closure } from '../Evaluation/unionFind';
import type { ConceptRef, SuspectPair } from '../ConceptRegistry/ConceptRegistry';

/**
 * Component scoping + token cap + spillover (T7) — pure code, no LLM, no registry access. `T9`
 * (`StreamingRepairer`) calls `buildComponents(pairs)` on one document's suspects, then
 * `capComponents(components, renderBlock, tokenCap)` before handing each fitted component to the
 * judge as one call. Everything here is a function of its arguments, so — like `unionFind.ts` and
 * the rest of T6 — it needs no persistence of its own.
 */

/** One connected cluster of suspect pairs, the unit the judge adjudicates in a single call.
 * `coherence` holds single-entity drift questions (`SuspectPair`s with `b === a`) that belong to
 * this component but are never pair edges — they ride along with whichever entity they're about. */
export interface SuspectComponent {
  pairs: SuspectPair[];
  entities: ConceptRef[];
  coherence: ConceptRef[];
}

/** Separator-free encoding — a plain `"${category} ${canonical}"` join is not collision-safe (the
 * real category domain already contains "Government Body", and `{category:'A', canonical:'B C'}` /
 * `{category:'A B', canonical:'C'}` would both join to `"A B C"`), and a collision here would
 * silently fold two distinct entities into one union-find node with zero error signal. */
function refKey(ref: ConceptRef): string {
  return JSON.stringify([ref.category, ref.canonical]);
}

function refEquals(a: ConceptRef, b: ConceptRef): boolean {
  return a.category === b.category && a.canonical === b.canonical;
}

/** Total order over refs, used everywhere below so output never depends on Map/Set iteration
 * order — only on the (category, canonical) values themselves. */
function compareRefs(a: ConceptRef, b: ConceptRef): number {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.canonical !== b.canonical) return a.canonical < b.canonical ? -1 : 1;
  return 0;
}

function comparePairs(x: SuspectPair, y: SuspectPair): number {
  return compareRefs(x.a, y.a) || compareRefs(x.b, y.b) || x.score - y.score;
}

function dedupeRefs(refs: ConceptRef[]): ConceptRef[] {
  const seen = new Set<string>();
  const out: ConceptRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.sort(compareRefs);
}

/**
 * Groups `entities` into connected components under `edges` (a plain union-find over ref keys —
 * `closure` from `unionFind.ts`), attaching each `coherence` ref and each edge to the component
 * that contains its entity/entities. `entities` is the full membership list, including any that
 * have no edge at all (singletons) — `closure`'s `elements` parameter is exactly for that.
 *
 * Shared by `buildComponents` (the initial split) and `capComponents`'s eviction loop (re-scoping
 * after a pair is evicted, since removing an edge can split what was one component into several —
 * an entity only reachable through the evicted edge must not be silently dropped, so connectivity
 * is recomputed from scratch here rather than patched incrementally).
 */
function scope(entities: ConceptRef[], edges: SuspectPair[], coherence: ConceptRef[]): SuspectComponent[] {
  const refByKey = new Map<string, ConceptRef>();
  for (const ref of entities) if (!refByKey.has(refKey(ref))) refByKey.set(refKey(ref), ref);

  const closurePairs: Array<[string, string]> = edges.map((e) => [refKey(e.a), refKey(e.b)]);
  const allKeys = entities.map(refKey);
  const groups = closure(closurePairs, allKeys);

  const groupIndex = new Map<string, number>();
  groups.forEach((group, idx) => {
    for (const key of group) groupIndex.set(key, idx);
  });

  const components: SuspectComponent[] = groups.map(() => ({ pairs: [], entities: [], coherence: [] }));

  for (const edge of edges) {
    components[groupIndex.get(refKey(edge.a))!].pairs.push(edge);
  }
  for (const ref of coherence) {
    components[groupIndex.get(refKey(ref))!].coherence.push(ref);
  }
  groups.forEach((group, idx) => {
    components[idx].entities = group.map((key) => refByKey.get(key)!).sort(compareRefs);
    components[idx].coherence = dedupeRefs(components[idx].coherence);
    components[idx].pairs.sort(comparePairs);
  });

  return components.sort((x, y) => compareRefs(x.entities[0], y.entities[0]));
}

/**
 * Splits `pairs` into connected components (transitive closure over shared entities, via
 * `src/Evaluation/unionFind.ts`'s `closure`). Coherence suspects (`b` deep-equal `a` — same
 * category+canonical, per `ConceptRegistry.SuspectPair`) never contribute an edge: a self-pair is a
 * no-op for connectivity (`unionFind.test.ts`: "self-pairs do not create spurious merges"), so they
 * are pulled out up front and reattached as `coherence` entries of whichever component contains
 * their entity — or their own singleton component, if that entity has no other suspect at all.
 *
 * Output is sorted deterministically (components by their first entity, entities and coherence
 * within a component by ref, pairs by `(a, b, score)`) — never dependent on Map iteration order.
 */
export function buildComponents(pairs: SuspectPair[]): SuspectComponent[] {
  const edges: SuspectPair[] = [];
  const coherenceRefs: ConceptRef[] = [];
  const entities: ConceptRef[] = [];

  for (const p of pairs) {
    if (refEquals(p.a, p.b)) {
      coherenceRefs.push(p.a);
      entities.push(p.a);
    } else {
      edges.push(p);
      entities.push(p.a, p.b);
    }
  }

  return scope(entities, edges, coherenceRefs);
}

/**
 * Picks the pair with the lowest `score` to evict, breaking ties on `(a, b)` so the choice is
 * deterministic regardless of input order (mirrors `comparePairs`'s tie-break, but score-first).
 */
function lowestScoringPair(pairs: SuspectPair[]): SuspectPair {
  return [...pairs].sort((x, y) => x.score - y.score || compareRefs(x.a, y.a) || compareRefs(x.b, y.b))[0];
}

function estimatedTokens(renderBlock: (c: SuspectComponent) => string, c: SuspectComponent): number {
  return renderBlock(c).length / 4;
}

/**
 * Shrinks one component to fit `tokenCap`, evicting the LOWEST-scoring pair edge first and
 * re-rendering until it fits — the eviction order the brief calls for, so the highest-signal
 * suspects are the ones a judge call is spent on when a component has to be trimmed.
 *
 * Evicting an edge can split a component (e.g. A–B, B–C loses A–B → {A} and {B,C} are no longer
 * one connected piece): connectivity is re-scoped from scratch after every eviction (`scope`, over
 * the component's original entity/coherence membership) rather than patched, so an entity that is
 * still reachable via a surviving edge is never dropped just because a *different* edge that used
 * to reach it was cut. Each resulting piece is then independently re-checked against the cap.
 *
 * A component down to a single pair edge is never evicted further, even if still over cap — that
 * single (by construction, highest-scoring) pair is kept, and a component with zero pair edges
 * (coherence-only, or a lone entity) has nothing evictable at all. Either way `renderBlock` is
 * called only on non-empty components, and a component is never handed to the judge empty.
 *
 * A fragment produced by a split can end up with BOTH zero pairs and zero coherence entries (every
 * edge that used to touch its one remaining entity was the one just evicted). That fragment has
 * nothing for the judge to adjudicate — no pair op, no coherence question — and the pair(s) that
 * used to connect it are already recorded in `spilled`, so dropping it loses no information. It is
 * filtered out before ever reaching `renderBlock` or `fitted`/`due`.
 */
function shrinkComponent(
  component: SuspectComponent,
  renderBlock: (c: SuspectComponent) => string,
  tokenCap: number
): { fitted: SuspectComponent[]; spilled: SuspectPair[] } {
  const spilled: SuspectPair[] = [];
  const fitted: SuspectComponent[] = [];
  const queue: SuspectComponent[] = [component];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.pairs.length === 0 && current.coherence.length === 0) continue; // bare singleton: drop

    if (estimatedTokens(renderBlock, current) <= tokenCap || current.pairs.length <= 1) {
      fitted.push(current);
      continue;
    }

    const evicted = lowestScoringPair(current.pairs);
    spilled.push(evicted);
    const remainingPairs = current.pairs.filter((p) => p !== evicted);
    queue.push(...scope(current.entities, remainingPairs, current.coherence));
  }

  return { fitted: fitted.sort((x, y) => compareRefs(x.entities[0], y.entities[0])), spilled };
}

/**
 * Caps every component to `tokenCap` (chars/4 heuristic on `renderBlock`'s rendered text — the
 * brief's estimate, cheap enough to recompute per eviction attempt). Evicted pair edges are
 * returned as `spillover`, destined for the registry's spillover queue so a future document's
 * repair pass picks them back up rather than losing them (T9).
 *
 * `due` and `spillover` are both sorted deterministically (see `scope`/`comparePairs`), independent
 * of input component order or any Map iteration.
 */
export function capComponents(
  components: SuspectComponent[],
  renderBlock: (c: SuspectComponent) => string,
  tokenCap: number
): { due: SuspectComponent[]; spillover: SuspectPair[] } {
  const due: SuspectComponent[] = [];
  const spillover: SuspectPair[] = [];

  for (const component of components) {
    const { fitted, spilled } = shrinkComponent(component, renderBlock, tokenCap);
    due.push(...fitted);
    spillover.push(...spilled);
  }

  due.sort((x, y) => compareRefs(x.entities[0], y.entities[0]));
  spillover.sort(comparePairs);

  return { due, spillover };
}
