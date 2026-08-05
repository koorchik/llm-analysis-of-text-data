import type { EntityRef, SuspectPair } from '../EntityRegistry/EntityRegistry';
import { buildComponents, capComponents, type SuspectComponent } from './components';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * TDD for T7 `buildComponents`/`capComponents` — pure code (no LLM, no registry). Entity refs and
 * suspect pairs are hand-built literals; `buildComponents`'s only collaborator is
 * `src/Evaluation/unionFind.ts:closure`, already covered by its own tests.
 */

const ref = (category: string, canonical: string): EntityRef => ({ category, canonical });

let nextDoc = 0;
function pair(a: EntityRef, b: EntityRef, opts: { signal?: SuspectPair['signal']; score?: number } = {}): SuspectPair {
  return { a, b, signal: opts.signal ?? 'union-blocker', score: opts.score ?? 0.9, docId: nextDoc++ };
}

// --- buildComponents -----------------------------------------------------------------------------

test('transitive chaining: A-B, B-C fold into one 3-entity component', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  const pairs = [pair(A, B), pair(B, C)];

  const components = buildComponents(pairs);

  assert.equal(components.length, 1);
  assert.deepEqual(
    components[0].entities.map((e) => e.canonical).sort(),
    ['A', 'B', 'C']
  );
  assert.equal(components[0].pairs.length, 2);
  assert.deepEqual(components[0].coherence, []);
});

test('disjoint pairs stay in separate components', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  const D = ref('HackerGroup', 'D');
  const pairs = [pair(A, B), pair(C, D)];

  const components = buildComponents(pairs);

  assert.equal(components.length, 2);
  const sizes = components.map((c) => c.entities.length).sort();
  assert.deepEqual(sizes, [2, 2]);
});

test('a coherence pair (b === a) becomes a coherence entry, not a pair edge', () => {
  const A = ref('HackerGroup', 'A');
  const coherencePair = pair(A, A, { signal: 'coherence', score: 0.1 });

  const components = buildComponents([coherencePair]);

  assert.equal(components.length, 1);
  assert.equal(components[0].pairs.length, 0, 'coherence must not become a pair edge');
  assert.deepEqual(components[0].entities, [A]);
  assert.deepEqual(components[0].coherence, [A]);
});

test('a coherence entry for an entity that is also in a normal edge lands in that edge\'s component', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const pairs = [pair(A, B), pair(A, A, { signal: 'coherence', score: 0.1 })];

  const components = buildComponents(pairs);

  assert.equal(components.length, 1);
  assert.equal(components[0].pairs.length, 1);
  assert.deepEqual(components[0].coherence, [A]);
  assert.deepEqual(
    components[0].entities.map((e) => e.canonical).sort(),
    ['A', 'B']
  );
});

test('buildComponents output is deterministically ordered regardless of input order', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  const D = ref('HackerGroup', 'D');

  const forward = buildComponents([pair(A, B), pair(C, D)]);
  const reverse = buildComponents([pair(C, D), pair(A, B)]);

  const canonicalize = (components: SuspectComponent[]) =>
    components.map((c) => c.entities.map((e) => e.canonical).sort());

  assert.deepEqual(canonicalize(forward), canonicalize(reverse));
  // Components themselves must come out in a fixed order too (sorted by their entities), not
  // whatever order a Map happened to iterate them in.
  assert.deepEqual(
    forward.map((c) => c.entities[0].canonical),
    reverse.map((c) => c.entities[0].canonical)
  );
});

// --- capComponents ---------------------------------------------------------------------------------

/** Concatenates each pair's two canonicals, `;`-joined — deterministic, and short enough that tests
 * can compute an exact tokenCap from a candidate pair list via `renderBlock(...).length / 4`. */
function renderBlock(c: SuspectComponent): string {
  return c.pairs.map((p) => `${p.a.canonical}${p.b.canonical}`).join(';');
}

test('a component that already fits under the cap is returned unchanged, with no spillover', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const components = buildComponents([pair(A, B, { score: 0.9 })]);

  const { due, spillover } = capComponents(components, renderBlock, 1000);

  assert.equal(due.length, 1);
  assert.equal(due[0].pairs.length, 1);
  assert.deepEqual(spillover, []);
});

test('over cap: the lowest-scoring pair is evicted first and reported as spillover', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  // A triangle (A-B, B-C, A-C): evicting any ONE edge still leaves all three entities connected via
  // the remaining two, so this isolates "which pair gets evicted" from any connectivity split.
  const low = pair(A, B, { score: 0.1 });
  const mid = pair(B, C, { score: 0.5 });
  const high = pair(A, C, { score: 0.9 });
  const components = buildComponents([low, mid, high]);
  assert.equal(components.length, 1, 'sanity: all three pairs must be one component via A');

  // tokenCap exactly enough for the two higher-scoring pairs' rendered text, but not all three.
  const capAfterOneEviction = renderBlock({ pairs: [mid, high], entities: [], coherence: [] }).length / 4;
  const { due, spillover } = capComponents(components, renderBlock, capAfterOneEviction);

  assert.equal(due.length, 1, 'A, B, C stay connected via the two surviving edges — no split');
  assert.deepEqual(
    due[0].pairs.map((p) => p.score).sort(),
    [0.5, 0.9],
    'the two higher-scoring pairs must survive'
  );
  assert.deepEqual(spillover, [low], 'only the lowest-scoring pair is evicted');
});

test('a component still over cap after evicting down to one pair keeps that pair — never an empty call', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const only = pair(A, B, { score: 0.9 });
  const components = buildComponents([only]);

  const renderCalls: SuspectComponent[] = [];
  const trackingRender = (c: SuspectComponent): string => {
    renderCalls.push(c);
    return renderBlock(c);
  };

  // tokenCap of 0 — impossible to satisfy even with one pair.
  const { due, spillover } = capComponents(components, trackingRender, 0);

  assert.equal(due.length, 1);
  assert.equal(due[0].pairs.length, 1, 'the single remaining pair must be kept, never evicted to empty');
  assert.deepEqual(due[0].pairs[0], only);
  assert.deepEqual(spillover, [], 'nothing left that could be evicted');
  assert.ok(
    renderCalls.every((c) => c.pairs.length > 0 || c.entities.length > 0),
    'renderBlock must never be called on an empty component'
  );
});

test('evicting an edge that would split a component re-scopes connectivity: an entity still reachable via another edge is not lost', () => {
  // A-B (low score) and B-C (high score) chain three entities. Evicting A-B (lowest) should split
  // the component into {A} alone and {B,C} still joined by the surviving edge — not silently drop A
  // from every component, and not keep A falsely bundled with B/C.
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  const lowAB = pair(A, B, { score: 0.1 });
  const highBC = pair(B, C, { score: 0.9 });
  const components = buildComponents([lowAB, highBC]);
  assert.equal(components.length, 1);

  // Cap fits exactly one pair's rendered text.
  const tinyCap = renderBlock({ pairs: [highBC], entities: [], coherence: [] }).length / 4;
  const { due, spillover } = capComponents(components, renderBlock, tinyCap);

  assert.deepEqual(spillover, [lowAB]);
  // A must still show up SOMEWHERE in `due` (as its own singleton piece), never dropped entirely.
  const allEntities = due.flatMap((c) => c.entities.map((e) => e.canonical));
  assert.deepEqual(allEntities.sort(), ['A', 'B', 'C']);
  const bcComponent = due.find((c) => c.pairs.some((p) => p === highBC));
  assert.ok(bcComponent, 'B-C must survive as a fitted component');
  assert.deepEqual(
    bcComponent!.entities.map((e) => e.canonical).sort(),
    ['B', 'C']
  );
});

test('capComponents output is deterministically ordered (due and spillover both sorted)', () => {
  const A = ref('HackerGroup', 'A');
  const B = ref('HackerGroup', 'B');
  const C = ref('HackerGroup', 'C');
  const D = ref('HackerGroup', 'D');
  const components = buildComponents([pair(C, D, { score: 0.4 }), pair(A, B, { score: 0.9 })]);

  const { due } = capComponents(components, renderBlock, 1000);

  assert.deepEqual(
    due.map((c) => c.entities[0].canonical),
    ['A', 'C'],
    'due components must be sorted, not in Map-insertion or input order'
  );
});
