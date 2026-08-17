import { mergeMetricsByStratum } from './clusterMetrics';
import {
  GoldValidationError,
  assertReportableSplit,
  goldPartition,
  goldSummary,
  labeledPairs,
  nilObservations,
  selectCategory,
  selectSplit,
  validateGoldTable,
  type GoldTable,
} from './gold';
import { nilMetrics } from './nilMetrics';
import { Partition } from './partition';
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

const table = (over: Partial<GoldTable> = {}): GoldTable =>
  validateGoldTable({
    version: 'gold-aliases-v1',
    inputContentHash: 'deadbeef',
    order: 'chronological',
    clusters: [
      {
        id: 'g1',
        category: 'HackerGroup',
        members: ['APT28', 'Fancy Bear'],
        stratum: 'c',
        split: 'test',
        evidence: [
          { pair: ['APT28', 'Fancy Bear'], snippet: '…also known as…', annotator: 'kb', source: 'mitre:G0007' },
        ],
      },
      { id: 'g2', category: 'HackerGroup', members: ['Sandworm'], stratum: 'c', split: 'test' },
      { id: 'g3', category: 'HackerGroup', members: ['UAC-0028'], stratum: 'd', split: 'dev' },
    ],
    nilLabels: [
      { docId: 10, category: 'HackerGroup', mention: 'APT28', label: 'NIL', clusterId: 'g1' },
      { docId: 90, category: 'HackerGroup', mention: 'Fancy Bear', label: 'known', clusterId: 'g1' },
    ],
    ...over,
  });

// --- the schema amendment this loader enforces ---------------------------------------------------

test('REJECTS a flat mention→label nilLabels object', () => {
  // The defect found in the original plan: a flat map cannot express prefix-relative labels.
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        order: 'chronological',
        clusters: [{ id: 'g1', category: 'C', members: ['a'], stratum: 'a', split: 'test' }],
        nilLabels: { APT28: 'NIL', 'Fancy Bear': 'known' },
      }),
    /must be an ARRAY/
  );
});

test('accepts the position-indexed nilLabels array', () => {
  const loaded = table();
  assert.equal(loaded.nilLabels.length, 2);
  assert.equal(loaded.nilLabels[0].docId, 10);
});

test('the same mention carries both NIL and known at different positions', () => {
  const loaded = validateGoldTable({
    version: 'gold-aliases-v1',
    inputContentHash: 'x',
    order: 'chronological',
    clusters: [{ id: 'g1', category: 'HackerGroup', members: ['UAC-0028'], stratum: 'd', split: 'test' }],
    nilLabels: [
      { docId: 10, category: 'HackerGroup', mention: 'UAC-0028', label: 'NIL' },
      { docId: 90, category: 'HackerGroup', mention: 'UAC-0028', label: 'known' },
    ],
  });
  assert.equal(loaded.nilLabels.length, 2, 'both coexist — impossible under a flat map');
});

test('requires `order`, because NIL labels are order-dependent', () => {
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        clusters: [],
        nilLabels: [],
      }),
    /order is required/
  );
});

test('requires inputContentHash, so a table names the corpus it annotates', () => {
  assert.throws(
    () => validateGoldTable({ version: 'gold-aliases-v1', order: 'chronological', clusters: [], nilLabels: [] }),
    /inputContentHash is required/
  );
});

// --- structural validation ----------------------------------------------------------------------

test('rejects an unsupported version', () => {
  assert.throws(() => validateGoldTable({ version: 'gold-v2', inputContentHash: 'x', order: 'o', clusters: [] }), /unsupported gold version/);
});

test('rejects a cluster missing a stratum', () => {
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        order: 'o',
        clusters: [{ id: 'g1', category: 'C', members: ['a'], split: 'test' }],
        nilLabels: [],
      }),
    /stratum is required/
  );
});

test('rejects an invalid split', () => {
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        order: 'o',
        clusters: [{ id: 'g1', category: 'C', members: ['a'], stratum: 'a', split: 'train' }],
        nilLabels: [],
      }),
    /split must be/
  );
});

test('rejects a surface form claimed by two gold clusters', () => {
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        order: 'o',
        clusters: [
          { id: 'g1', category: 'C', members: ['a', 'b'], stratum: 's', split: 'test' },
          { id: 'g2', category: 'C', members: ['b'], stratum: 's', split: 'test' },
        ],
        nilLabels: [],
      }),
    /appears in gold clusters/
  );
});

test('rejects duplicate cluster ids and empty member lists', () => {
  const base = { version: 'gold-aliases-v1', inputContentHash: 'x', order: 'o', nilLabels: [] };
  assert.throws(
    () =>
      validateGoldTable({
        ...base,
        clusters: [
          { id: 'g1', category: 'C', members: ['a'], stratum: 's', split: 'test' },
          { id: 'g1', category: 'C', members: ['c'], stratum: 's', split: 'test' },
        ],
      }),
    /duplicate cluster id/
  );
  assert.throws(
    () => validateGoldTable({ ...base, clusters: [{ id: 'g1', category: 'C', members: [], stratum: 's', split: 'test' }] }),
    /non-empty array/
  );
});

test('rejects a NIL label without a numeric docId', () => {
  assert.throws(
    () =>
      validateGoldTable({
        version: 'gold-aliases-v1',
        inputContentHash: 'x',
        order: 'o',
        clusters: [{ id: 'g1', category: 'C', members: ['a'], stratum: 's', split: 'test' }],
        nilLabels: [{ category: 'C', mention: 'a', label: 'NIL' }],
      }),
    /docId must be a number/
  );
});

test('GoldValidationError is the thrown type, so callers can catch it specifically', () => {
  assert.throws(() => validateGoldTable(null), GoldValidationError);
});

// --- split discipline ---------------------------------------------------------------------------

test('selectSplit filters clusters and their NIL labels by cluster', () => {
  const test_ = selectSplit(table(), 'test');
  assert.deepEqual(test_.clusters.map((cluster) => cluster.id), ['g1', 'g2']);
  assert.equal(test_.nilLabels.length, 2, 'both labels belong to g1');

  const dev = selectSplit(table(), 'dev');
  assert.deepEqual(dev.clusters.map((cluster) => cluster.id), ['g3']);
  assert.equal(dev.nilLabels.length, 0);
});

test('reporting from dev is refused unless explicitly allowed', () => {
  assert.throws(() => assertReportableSplit('dev'), /refusing to report results from the dev split/);
  assert.doesNotThrow(() => assertReportableSplit('dev', { allowDev: true }));
  assert.doesNotThrow(() => assertReportableSplit('test'));
});

// --- derived views ------------------------------------------------------------------------------

test('goldPartition builds membership clusters keyed by category and surface', () => {
  const partition = goldPartition(table());
  assert.equal(partition.size, 3);
  assert.equal(partition.sameCluster('hackergroup|apt28', 'hackergroup|fancy bear'), true);
  assert.equal(partition.sameCluster('hackergroup|apt28', 'hackergroup|sandworm'), false);
});

test('labeledPairs produces within-cluster positives and same-stratum negatives', () => {
  const pairs = labeledPairs(selectSplit(table(), 'test'));
  // g1 gives one positive (APT28, Fancy Bear). g1×g2 gives two negatives, both stratum c.
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every((pair) => pair.stratum === 'c'));
});

test('labeledPairs never pairs across strata or categories', () => {
  const mixed = validateGoldTable({
    version: 'gold-aliases-v1',
    inputContentHash: 'x',
    order: 'o',
    clusters: [
      { id: 'g1', category: 'HackerGroup', members: ['A'], stratum: 'a', split: 'test' },
      { id: 'g2', category: 'HackerGroup', members: ['B'], stratum: 'd', split: 'test' },
      { id: 'g3', category: 'Software', members: ['C'], stratum: 'a', split: 'test' },
    ],
    nilLabels: [],
  });
  // No two clusters share (category, stratum), so there are no negatives at all — and crucially
  // no cross-stratum pair that would attribute an error to the wrong stratum.
  assert.equal(labeledPairs(mixed).length, 0);
});

test('merge metrics run end to end off the gold table', () => {
  const goldTable = selectSplit(table(), 'test');
  const gold = goldPartition(goldTable);
  // A prediction that correctly merges g1 but wrongly pulls Sandworm in with them.
  const predicted = Partition.fromGroups([
    ['hackergroup|apt28', 'hackergroup|fancy bear', 'hackergroup|sandworm'],
  ]);

  const byStratum = mergeMetricsByStratum(predicted, gold, labeledPairs(goldTable));
  assert.equal(byStratum.c.truePositives, 1, 'APT28 ~ Fancy Bear');
  assert.equal(byStratum.c.falsePositives, 2, 'Sandworm wrongly merged with both');
  assert.ok(byStratum.c.precision !== null && byStratum.c.precision < 0.5);
});

test('nilObservations joins by (docId, category, mention) and counts unlabeled decisions', () => {
  const { observations, unlabeled } = nilObservations(table(), [
    { docId: 10, category: 'HackerGroup', mention: 'APT28', decision: 'mint' }, // gold NIL → TP
    { docId: 90, category: 'HackerGroup', mention: 'Fancy Bear', decision: 'link' }, // known → TN
    { docId: 99, category: 'HackerGroup', mention: 'Unlabeled', decision: 'mint' }, // no gold label
  ]);

  assert.equal(observations.length, 2);
  assert.equal(unlabeled, 1, 'dropped and counted, never given an invented label');

  const metrics = nilMetrics(observations);
  assert.equal(metrics.truePositives, 1);
  assert.equal(metrics.trueNegatives, 1);
});

test('nilObservations distinguishes the same mention at two stream positions', () => {
  const goldTable = validateGoldTable({
    version: 'gold-aliases-v1',
    inputContentHash: 'x',
    order: 'chronological',
    clusters: [{ id: 'g1', category: 'HackerGroup', members: ['UAC-0028'], stratum: 'd', split: 'test' }],
    nilLabels: [
      { docId: 10, category: 'HackerGroup', mention: 'UAC-0028', label: 'NIL' },
      { docId: 90, category: 'HackerGroup', mention: 'UAC-0028', label: 'known' },
    ],
  });

  const { observations } = nilObservations(goldTable, [
    { docId: 10, category: 'HackerGroup', mention: 'UAC-0028', decision: 'mint' }, // correct
    { docId: 90, category: 'HackerGroup', mention: 'UAC-0028', decision: 'mint' }, // duplicate
  ]);

  const metrics = nilMetrics(observations);
  assert.equal(metrics.truePositives, 1, 'the first-sight mint is right');
  assert.equal(metrics.falsePositives, 1, 'the second is a wrong mint');
});

test('goldSummary reports the shape the Phase 2 gate asks about', () => {
  const summary = goldSummary(table());
  assert.equal(summary.clusters, 3);
  assert.equal(summary.members, 4);
  assert.deepEqual(summary.byStratum, { c: 2, d: 1 });
  assert.deepEqual(summary.bySplit, { test: 2, dev: 1 });
  assert.equal(summary.clustersWithEvidence, 1);
  assert.equal(summary.nilLabels, 2);
});

describe('selectCategory', () => {
  const table = {
    version: 'gold-aliases-v2',
    inputContentHash: 'x',
    order: 'numeric-id',
    clusters: [
      { id: 'g1', category: 'Software', members: ['LummaStealer', 'Lumma'], stratum: 'a', split: 'dev' },
      { id: 'g2', category: 'HackerGroup', members: ['UAC-0006', 'UAC-6'], stratum: 'a', split: 'dev' },
    ],
    edges: [
      { category: 'Software', from: 'Lumma', to: 'LummaStealer', kind: 'isa' },
      { category: 'HackerGroup', from: 'UAC-6', to: 'UAC-0006', kind: 'isa' },
    ],
    nilLabels: [
      { docId: 1, category: 'Software', mention: 'LummaStealer', label: 'known', clusterId: 'g1' },
      { docId: 1, category: 'HackerGroup', mention: 'UAC-0006', label: 'known', clusterId: 'g2' },
    ],
  } as unknown as GoldTable;

  it('keeps only the named category across clusters, edges and nilLabels', () => {
    const sliced = selectCategory(table, 'Software');
    assert.deepEqual(sliced.clusters.map((c) => c.id), ['g1']);
    assert.equal(sliced.edges.length, 1);
    assert.equal(sliced.edges[0].category, 'Software');
    assert.deepEqual(sliced.nilLabels.map((l) => l.mention), ['LummaStealer']);
  });

  it('matches case-insensitively, like elementKey does', () => {
    assert.equal(selectCategory(table, 'software').clusters.length, 1);
  });

  it('returns empty slices for a category with no gold rows', () => {
    assert.equal(selectCategory(table, 'Device').clusters.length, 0);
  });
});
