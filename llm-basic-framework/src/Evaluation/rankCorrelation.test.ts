import {
  kendallTauB,
  rankCrossings,
  rankOrder,
  spearmanRho,
  topKOverlap,
  type RankedItem,
} from './rankCorrelation';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, tolerance = 1e-12, message?: string) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message ?? ''} expected ${expected}, got ${actual}`);

const ranked = (pairs: Array<[string, number]>): RankedItem[] =>
  pairs.map(([id, score]) => ({ id, score }));

test('identical rankings give tau = 1', () => {
  const items = ranked([['a', 10], ['b', 8], ['c', 6], ['d', 4]]);
  near(kendallTauB(items, items).tau, 1);
});

test('exactly reversed rankings give tau = -1', () => {
  const a = ranked([['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
  const b = ranked([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  near(kendallTauB(a, b).tau, -1);
});

test('one swapped adjacent pair out of four items', () => {
  // A: a>b>c>d.  B: a>c>b>d (b and c swapped).
  // Pairs: ab ac ad bc bd cd = 6. Only (b,c) is discordant → nc=5, nd=1, no ties.
  // tau = (5−1)/6 = 2/3
  const a = ranked([['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
  const b = ranked([['a', 4], ['b', 2], ['c', 3], ['d', 1]]);
  const result = kendallTauB(a, b);
  assert.equal(result.concordant, 5);
  assert.equal(result.discordant, 1);
  near(result.tau, 2 / 3);
});

test('tau-b corrects for ties rather than penalising them', () => {
  // A ties b and c; B ranks them apart. Pairs: ab ac ad bc bd cd = 6.
  //   ab: A a>b, B a>b → concordant
  //   ac: A a>c, B a>c → concordant
  //   ad: concordant
  //   bc: A tied, B not → tie in A
  //   bd: A b>d, B b>d → concordant
  //   cd: A c>d, B c>d → concordant
  // nc=5, nd=0, n1=1, n2=0, n0=6 → tau = 5 / sqrt(5·6) = 5/sqrt(30)
  const a = ranked([['a', 10], ['b', 5], ['c', 5], ['d', 1]]);
  const b = ranked([['a', 10], ['b', 6], ['c', 4], ['d', 1]]);
  const result = kendallTauB(a, b);
  assert.equal(result.concordant, 5);
  assert.equal(result.discordant, 0);
  assert.equal(result.tiesInA, 1);
  near(result.tau, 5 / Math.sqrt(30));
  // tau-a would have divided by 6 and reported a lower value for a ranking that never disagreed.
  assert.ok(result.tau > 5 / 6);
});

test('all-tied rankings are perfect agreement by convention, not NaN', () => {
  // Weighted degree really does produce all-equal scores on small graphs; NaN would poison the
  // composed results table.
  const a = ranked([['a', 1], ['b', 1], ['c', 1]]);
  const b = ranked([['a', 2], ['b', 2], ['c', 2]]);
  const result = kendallTauB(a, b);
  assert.equal(Number.isNaN(result.tau), false);
  near(result.tau, 1);
});

test('tau is computed only over shared items', () => {
  const a = ranked([['a', 3], ['b', 2], ['ghost', 1]]);
  const b = ranked([['a', 3], ['b', 2]]);
  const result = kendallTauB(a, b);
  assert.equal(result.n, 2, 'ghost is not comparable');
  near(result.tau, 1);
});

test('fewer than two shared items yields NaN rather than a fake correlation', () => {
  assert.ok(Number.isNaN(kendallTauB(ranked([['a', 1]]), ranked([['a', 1]])).tau));
  assert.ok(Number.isNaN(kendallTauB(ranked([['a', 1]]), ranked([['b', 1]])).tau));
});

test('tau is symmetric', () => {
  const a = ranked([['a', 5], ['b', 3], ['c', 4], ['d', 1]]);
  const b = ranked([['a', 4], ['b', 4], ['c', 2], ['d', 3]]);
  near(kendallTauB(a, b).tau, kendallTauB(b, a).tau);
});

// --- ordering -----------------------------------------------------------------------------------

test('rankOrder is descending by score with a deterministic tie-break', () => {
  const items = ranked([['z', 5], ['a', 5], ['m', 9]]);
  assert.deepEqual(rankOrder(items), ['m', 'a', 'z'], 'ties break on id, so runs are comparable');
});

// --- top-k overlap ------------------------------------------------------------------------------

test('top-k overlap names which items moved', () => {
  const a = ranked([['x', 10], ['y', 9], ['z', 8], ['w', 7]]);
  const b = ranked([['x', 10], ['y', 9], ['w', 8], ['z', 7]]);
  const result = topKOverlap(a, b, 3);
  assert.equal(result.intersection, 2, 'x and y');
  near(result.overlap, 2 / 3);
  assert.deepEqual(result.onlyInA, ['z']);
  assert.deepEqual(result.onlyInB, ['w']);
});

test('top-k overlap is 1 for identical rankings and 0 for disjoint top-k', () => {
  const a = ranked([['a', 3], ['b', 2], ['c', 1]]);
  near(topKOverlap(a, a, 2).overlap, 1);

  const b = ranked([['c', 3], ['b', 2], ['a', 1]]);
  const result = topKOverlap(a, b, 1);
  assert.equal(result.intersection, 0);
  near(result.overlap, 0);
});

test('top-k handles k larger than the lists via an effective k', () => {
  const a = ranked([['a', 2], ['b', 1]]);
  const result = topKOverlap(a, a, 20);
  assert.equal(result.effectiveK, 2);
  near(result.overlap, 1, 1e-12, 'not 2/20');
});

// --- rank crossings (the E9 deliverable) --------------------------------------------------------

test('rankCrossings finds an actor crossing the top-10 boundary', () => {
  // 11 items; in B, k11 overtakes k10 and enters the top 10.
  const base: Array<[string, number]> = Array.from({ length: 11 }, (_, i) => [`k${i + 1}`, 100 - i]);
  const a = ranked(base);
  const b = ranked(base.map(([id, score]) => (id === 'k11' ? [id, 95.5] : [id, score])));

  const crossings = rankCrossings(a, b, 10);
  const ids = crossings.map((crossing) => crossing.id).sort();
  assert.deepEqual(ids, ['k10', 'k11'], 'one entered, one left');

  const k11 = crossings.find((crossing) => crossing.id === 'k11')!;
  assert.equal(k11.rankInA, 11);
  assert.ok(k11.rankInB! <= 10, 'k11 is inside the boundary in B');
});

test('no crossings when the boundary is not crossed', () => {
  // A swap deep inside the top-10 changes tau but crosses no boundary.
  const a = ranked([['a', 5], ['b', 4], ['c', 3]]);
  const b = ranked([['a', 5], ['b', 3], ['c', 4]]);
  assert.deepEqual(rankCrossings(a, b, 10), []);
});

test('an item present in only one ranking counts as a crossing', () => {
  const a = ranked([['a', 5], ['b', 4]]);
  const b = ranked([['a', 5]]);
  const crossings = rankCrossings(a, b, 10);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].id, 'b');
  assert.equal(crossings[0].rankInB, null);
  assert.equal(crossings[0].movement, null);
});

// --- Spearman -----------------------------------------------------------------------------------

test('Spearman rho is 1 for identical and -1 for reversed rankings', () => {
  const a = ranked([['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
  near(spearmanRho(a, a), 1, 1e-12);
  const reversed = ranked([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
  near(spearmanRho(a, reversed), -1, 1e-12);
});

test('Spearman rho handles ties via average ranks', () => {
  const a = ranked([['a', 5], ['b', 5], ['c', 1]]);
  const b = ranked([['a', 9], ['b', 9], ['c', 2]]);
  near(spearmanRho(a, b), 1, 1e-12);
});

test('Spearman rho is NaN with fewer than two shared items', () => {
  assert.ok(Number.isNaN(spearmanRho(ranked([['a', 1]]), ranked([['a', 1]]))));
});
