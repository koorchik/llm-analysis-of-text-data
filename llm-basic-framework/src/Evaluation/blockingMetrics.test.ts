import {
  blockingEfficiency,
  candidateRecallAtK,
  meanReciprocalRank,
  recallAtKByStratum,
  recallCurve,
  type CandidateQuery,
} from './blockingMetrics';
import { pairKey } from './partition';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);

const query = (over: Partial<CandidateQuery>): CandidateQuery => ({
  mention: 'm',
  candidates: [],
  goldTargets: [],
  ...over,
});

test('recall@k counts a hit only when a gold target is inside the top k', () => {
  const queries = [
    query({ mention: 'a', candidates: ['t1', 'x', 'y', 'z'], goldTargets: ['t1'] }), // rank 1
    query({ mention: 'b', candidates: ['x', 'y', 'z', 't2'], goldTargets: ['t2'] }), // rank 4
  ];
  near(candidateRecallAtK(queries, 1).recall, 0.5, 'only the first is found at k=1');
  near(candidateRecallAtK(queries, 4).recall, 1, 'both found at k=4');
});

test('recall@k is monotonically non-decreasing in k', () => {
  const queries = [
    query({ mention: 'a', candidates: ['x', 't', 'y'], goldTargets: ['t'] }),
    query({ mention: 'b', candidates: ['x', 'y', 'z'], goldTargets: ['nope'] }),
  ];
  const curve = recallCurve(queries, [1, 2, 3, 4]);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].recall >= curve[i - 1].recall, `k=${curve[i].k} dipped below k=${curve[i - 1].k}`);
  }
  near(curve[0].recall, 0, 'nothing at k=1');
  near(curve[1].recall, 0.5, 't found at k=2');
});

test('a correctly-NIL query is excluded from recall, not counted as a miss', () => {
  // Nothing to retrieve, so counting it would make a good blocker look bad on a hard corpus.
  const queries = [
    query({ mention: 'a', candidates: ['t'], goldTargets: ['t'] }),
    query({ mention: 'b', candidates: ['x', 'y'], goldTargets: [] }),
  ];
  const result = candidateRecallAtK(queries, 5);
  assert.equal(result.scoreable, 1);
  assert.equal(result.nilQueries, 1);
  near(result.recall, 1, 'the one scoreable query was a hit');
});

test('any gold target counts — a cluster may have several members in the registry', () => {
  const queries = [
    query({ mention: 'a', candidates: ['t2'], goldTargets: ['t1', 't2', 't3'] }),
  ];
  near(candidateRecallAtK(queries, 1).recall, 1);
});

test('recall@k per stratum, with a pooled row', () => {
  const byStratum = recallAtKByStratum(
    [
      // surface stratum: string similarity finds it
      query({ mention: 'a', candidates: ['t'], goldTargets: ['t'], stratum: 'a' }),
      // novel tail: the true canonical never reaches the judge
      query({ mention: 'b', candidates: ['junk'], goldTargets: ['t'], stratum: 'd' }),
      query({ mention: 'c', candidates: ['junk'], goldTargets: ['t'], stratum: 'd' }),
    ],
    4
  );
  near(byStratum.a.recall, 1);
  near(byStratum.d.recall, 0, 'a candidate the blocker never retrieves can never be merged');
  near(byStratum.all.recall, 1 / 3);
});

test('pair completeness and reduction ratio trade off against each other', () => {
  // Universe of 5 elements → C(5,2) = 10 possible pairs.
  const goldPairs = new Set([pairKey('a', 'b'), pairKey('c', 'd')]);

  // A tight blocker: proposes only (a,b). PC = 1/2, and it proposed 1 of 10 pairs → RR = 0.9.
  const tight = blockingEfficiency({
    queries: [query({ mention: 'a', candidates: ['b'], goldTargets: ['b'] })],
    universeSize: 5,
    goldPairs,
  });
  assert.equal(tight.candidatePairs, 1);
  near(tight.pairCompleteness, 0.5);
  near(tight.reductionRatio, 0.9);

  // An exhaustive blocker over the same universe: PC = 1 but RR = 0.
  const exhaustive = blockingEfficiency({
    queries: [
      query({ mention: 'a', candidates: ['b', 'c', 'd', 'e'] }),
      query({ mention: 'b', candidates: ['c', 'd', 'e'] }),
      query({ mention: 'c', candidates: ['d', 'e'] }),
      query({ mention: 'd', candidates: ['e'] }),
    ],
    universeSize: 5,
    goldPairs,
  });
  assert.equal(exhaustive.candidatePairs, 10);
  near(exhaustive.pairCompleteness, 1, 'proposing everything finds everything');
  near(exhaustive.reductionRatio, 0, 'and saves nothing — why both are reported');
});

test('a self-pair is not counted as a candidate pair', () => {
  const result = blockingEfficiency({
    queries: [query({ mention: 'a', candidates: ['a', 'b'] })],
    universeSize: 3,
    goldPairs: new Set([pairKey('a', 'b')]),
  });
  assert.equal(result.candidatePairs, 1);
});

test('duplicate proposals across queries are counted once', () => {
  // (a,b) proposed from both directions is one comparison, not two.
  const result = blockingEfficiency({
    queries: [
      query({ mention: 'a', candidates: ['b'] }),
      query({ mention: 'b', candidates: ['a'] }),
    ],
    universeSize: 4,
    goldPairs: new Set([pairKey('a', 'b')]),
  });
  assert.equal(result.candidatePairs, 1);
  near(result.pairCompleteness, 1);
});

test('MRR distinguishes two blockers with identical recall@k', () => {
  // Position bias is real (wang2024comem), so rank matters even at equal recall.
  const first = [query({ mention: 'a', candidates: ['t', 'x', 'y', 'z'], goldTargets: ['t'] })];
  const fourth = [query({ mention: 'a', candidates: ['x', 'y', 'z', 't'], goldTargets: ['t'] })];

  near(candidateRecallAtK(first, 4).recall, candidateRecallAtK(fourth, 4).recall, 'same recall@4');
  near(meanReciprocalRank(first).mrr, 1);
  near(meanReciprocalRank(fourth).mrr, 0.25, 'but a much worse rank');
});

test('MRR skips NIL queries and averages over the scoreable ones', () => {
  const result = meanReciprocalRank([
    query({ mention: 'a', candidates: ['t'], goldTargets: ['t'] }), // 1/1
    query({ mention: 'b', candidates: ['x', 't'], goldTargets: ['t'] }), // 1/2
    query({ mention: 'c', candidates: ['x'], goldTargets: [] }), // skipped
  ]);
  assert.equal(result.scoreable, 2);
  near(result.mrr, (1 + 0.5) / 2);
});

test('a miss contributes 0 to MRR rather than being dropped', () => {
  const result = meanReciprocalRank([
    query({ mention: 'a', candidates: ['t'], goldTargets: ['t'] }),
    query({ mention: 'b', candidates: ['x'], goldTargets: ['t'] }),
  ]);
  assert.equal(result.scoreable, 2);
  near(result.mrr, 0.5, '(1 + 0) / 2');
});

test('degenerate: no queries yields zeros, not NaN', () => {
  const recall = candidateRecallAtK([], 4);
  assert.equal(recall.recall, 0);
  assert.equal(Number.isNaN(recall.recall), false);
  assert.equal(meanReciprocalRank([]).mrr, 0);

  const efficiency = blockingEfficiency({ queries: [], universeSize: 0, goldPairs: new Set() });
  assert.equal(Number.isNaN(efficiency.reductionRatio), false);
  assert.equal(Number.isNaN(efficiency.pairCompleteness), false);
});
