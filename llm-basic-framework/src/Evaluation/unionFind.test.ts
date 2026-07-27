import { UnionFind, closure } from './unionFind';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const sortedGroups = (groups: string[][]): string[][] =>
  groups.map((group) => [...group].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('a fresh element is its own set', () => {
  const uf = new UnionFind<string>(['a', 'b']);
  assert.equal(uf.find('a'), 'a');
  assert.equal(uf.groupCount(), 2);
  assert.equal(uf.connected('a', 'b'), false);
});

test('union links two sets and reports whether it changed anything', () => {
  const uf = new UnionFind<string>();
  assert.equal(uf.union('a', 'b'), true);
  assert.equal(uf.union('a', 'b'), false, 'already connected');
  assert.equal(uf.connected('a', 'b'), true);
  assert.equal(uf.groupCount(), 1);
});

test('closure is transitive: A=B, B=C implies A=C', () => {
  const uf = new UnionFind<string>();
  uf.union('A', 'B');
  uf.union('B', 'C');
  assert.equal(uf.connected('A', 'C'), true);
  assert.deepEqual(sortedGroups(uf.groups()), [['A', 'B', 'C']]);
});

test('closure is ORDER-INDEPENDENT — the applyMerges bug it exists to fix', () => {
  // v1 applied merges sequentially behind a `records[from] && records[into]` guard, so
  // [{A→B},{B→C}] worked and [{B→C},{A→B}] silently dropped A→B. Both orders must agree here.
  const forward = closure<string>([
    ['A', 'B'],
    ['B', 'C'],
  ]);
  const reverse = closure<string>([
    ['B', 'C'],
    ['A', 'B'],
  ]);
  assert.deepEqual(sortedGroups(forward), [['A', 'B', 'C']]);
  assert.deepEqual(sortedGroups(reverse), [['A', 'B', 'C']]);
  assert.deepEqual(sortedGroups(forward), sortedGroups(reverse));
});

test('closure keeps disjoint groups separate', () => {
  const groups = closure<string>([
    ['a', 'b'],
    ['c', 'd'],
    ['d', 'e'],
  ]);
  assert.deepEqual(sortedGroups(groups), [
    ['a', 'b'],
    ['c', 'd', 'e'],
  ]);
});

test('closure includes listed singletons but does not invent them', () => {
  const withSingleton = closure<string>([['a', 'b']], ['a', 'b', 'lonely']);
  assert.deepEqual(sortedGroups(withSingleton), [['a', 'b'], ['lonely']]);

  const withoutSingleton = closure<string>([['a', 'b']]);
  assert.deepEqual(sortedGroups(withoutSingleton), [['a', 'b']]);
});

test('self-pairs do not create spurious merges', () => {
  const groups = closure<string>([
    ['a', 'a'],
    ['b', 'b'],
  ]);
  assert.deepEqual(sortedGroups(groups), [['a'], ['b']]);
});

test('a long chain compresses without stack overflow', () => {
  const uf = new UnionFind<number>();
  const N = 50_000;
  for (let i = 0; i < N - 1; i++) uf.union(i, i + 1);
  assert.equal(uf.groupCount(), 1);
  assert.equal(uf.connected(0, N - 1), true);
  assert.equal(uf.find(0), uf.find(N - 1));
});

test('groups partition every element exactly once', () => {
  const uf = new UnionFind<string>(['a', 'b', 'c', 'd', 'e']);
  uf.union('a', 'b');
  uf.union('d', 'e');
  const groups = uf.groups();
  const flat = groups.flat();
  assert.equal(flat.length, 5, 'no element duplicated or dropped');
  assert.equal(new Set(flat).size, 5);
  assert.equal(groups.length, 3);
});

test('union is idempotent under repeated application in any order', () => {
  const pairs: Array<[string, string]> = [
    ['x', 'y'],
    ['y', 'z'],
    ['x', 'z'],
    ['z', 'y'],
  ];
  assert.deepEqual(sortedGroups(closure(pairs)), [['x', 'y', 'z']]);
});
