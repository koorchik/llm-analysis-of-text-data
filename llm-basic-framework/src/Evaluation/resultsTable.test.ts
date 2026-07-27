import type { CostTotals } from '../Experiment/CostMeter';
import { clusterMetrics, mergeMetricsByStratum, type LabeledPair } from './clusterMetrics';
import { nilMetrics } from './nilMetrics';
import { Partition } from './partition';
import {
  determinismTier,
  renderResultsTable,
  tableNotes,
  type ConditionResult,
} from './resultsTable';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const zeroCost = (): CostTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  wallClockMs: 0,
});

const gold = Partition.fromGroups([['a', 'b'], ['c']]);
const predicted = Partition.fromGroups([['a', 'b'], ['c']]);
const pairs: LabeledPair[] = [
  { a: 'a', b: 'b', stratum: 'a' },
  { a: 'a', b: 'c', stratum: 'a' },
];

const condition = (over: Partial<ConditionResult> = {}): ConditionResult => ({
  condition: 'psi-link',
  runIds: ['r1'],
  tier: 'seeded',
  merge: mergeMetricsByStratum(predicted, gold, pairs),
  nil: nilMetrics([]),
  cluster: clusterMetrics(predicted, gold),
  cost: zeroCost(),
  unpricedModels: [],
  ...over,
});

// --- determinism tier ---------------------------------------------------------------------------

test('a seed-supporting backend is the seeded tier', () => {
  assert.equal(
    determinismTier({
      supported: { temperature: true, seed: true, topP: true },
      effective: { seed: 1 },
    }),
    'seeded'
  );
});

test('temperature 0 without seed support is the zero-temperature tier', () => {
  assert.equal(
    determinismTier({
      supported: { temperature: true, seed: false, topP: true },
      effective: { temperature: 0 },
    }),
    'zero-temperature'
  );
});

test('a backend that rejects sampling entirely is the default-sampling tier', () => {
  // The live Anthropic case: Opus 4.7+ removes temperature/top_p/top_k, so there is no lever.
  assert.equal(
    determinismTier({
      supported: { temperature: false, seed: false, topP: false },
      effective: {},
    }),
    'default-sampling'
  );
});

test('temperature supported but not pinned is unclassified, not silently "zero-temperature"', () => {
  assert.equal(
    determinismTier({
      supported: { temperature: true, seed: false, topP: true },
      effective: { temperature: 0.7 },
    }),
    'unknown'
  );
});

test('the tier comes from recorded support, not the provider name', () => {
  // Pinning an older Anthropic model that still accepts temperature genuinely moves that arm to a
  // different tier — only the run card records that difference.
  const olderModel = determinismTier({
    supported: { temperature: true, seed: false, topP: true },
    effective: { temperature: 0 },
  });
  assert.equal(olderModel, 'zero-temperature');
});

// --- rendering ----------------------------------------------------------------------------------

test('undefined metrics render as an em dash, not as 0.000', () => {
  // The bug found while scoring the real Psi_norm artifact: a stratum with only negative pairs, on
  // which the system correctly made no merges, has undefined precision. Printing 0.000 made a
  // perfect result read as total failure.
  const negativesOnly: LabeledPair[] = [{ a: 'a', b: 'c', stratum: 'd' }];
  const merge = mergeMetricsByStratum(predicted, gold, negativesOnly);

  // The metric itself must be null, not 0.
  assert.equal(merge.d.precision, null, 'no merges claimed → undefined precision');
  assert.equal(merge.d.recall, null, 'no gold positives → undefined recall');
  assert.equal(merge.d.trueNegatives, 1, 'the correct abstention is still counted');

  const table = renderResultsTable([condition({ merge })]);
  const lines = table.split('\n');
  const cell = (line: string, name: string): string => {
    const headers = lines[0].split('|').map((part) => part.trim());
    const index = headers.indexOf(name);
    assert.notEqual(index, -1, `column ${name} missing`);
    return line.split('|').map((part) => part.trim())[index];
  };

  // Check the merge cells specifically — the row legitimately contains 0.000 elsewhere (the defer
  // rate is a *defined* zero), so a blanket "no 0.000 anywhere" assertion would be wrong.
  for (const column of ['merge P (d)', 'merge R (d)']) {
    assert.equal(cell(lines[2], column), '—', `${column} must be dashed, not 0.000`);
  }
});

test('a defined 0 still renders as 0.000, so a real failure is visible', () => {
  const wrongMerge = Partition.fromGroups([['a', 'c'], ['b']]);
  const table = renderResultsTable([
    condition({
      merge: mergeMetricsByStratum(wrongMerge, gold, [{ a: 'a', b: 'c', stratum: 'a' }]),
    }),
  ]);
  // One merge claimed and it was wrong → precision is a defined 0.
  assert.ok(table.includes('0.000'), 'a genuine zero must not be hidden behind a dash');
});

test('strata become separate columns and `all` is forced last', () => {
  const multiStratum: LabeledPair[] = [
    { a: 'a', b: 'b', stratum: 'a' },
    { a: 'a', b: 'c', stratum: 'd' },
  ];
  const header = renderResultsTable([
    condition({ merge: mergeMetricsByStratum(predicted, gold, multiStratum) }),
  ]).split('\n')[0];

  assert.ok(header.includes('merge P (a)'));
  assert.ok(header.includes('merge P (d)'));
  assert.ok(
    header.indexOf('merge P (all)') > header.indexOf('merge P (d)'),
    'the pooled column must not be mistaken for the headline'
  );
  assert.equal(header.includes('mean merge'), false, 'there is no averaged-across-strata column');
});

test('an unpriced condition shows a caveat instead of a dollar figure', () => {
  const table = renderResultsTable([
    condition({
      unpricedModels: ['openai/gpt-5.4-nano-2026-03-17'],
      cost: { ...zeroCost(), calls: 11, unpricedCalls: 11 },
    }),
  ]);
  assert.ok(table.includes('unpriced (11 calls)'));
});

// --- notes --------------------------------------------------------------------------------------

test('the no-averaging note is always present', () => {
  const notes = tableNotes([condition()]);
  assert.ok(notes.some((note) => note.includes('never averaged')));
});

test('mixed tiers produce an incomparability warning', () => {
  const notes = tableNotes([
    condition({ condition: 'openai', tier: 'seeded' }),
    condition({ condition: 'anthropic', tier: 'default-sampling' }),
  ]);
  assert.ok(notes.some((note) => note.includes('NOT comparable')));
  assert.ok(notes.some((note) => note.includes('no determinism lever at all')));
});

test('a single tier produces no incomparability warning', () => {
  const notes = tableNotes([condition({ tier: 'seeded' })]);
  assert.equal(notes.some((note) => note.includes('NOT comparable')), false);
});

test('unpriced models are named in the notes', () => {
  const notes = tableNotes([condition({ unpricedModels: ['openai/mystery-model'] })]);
  assert.ok(notes.some((note) => note.includes('openai/mystery-model')));
  assert.ok(notes.some((note) => note.includes('No $ figure is quotable')));
});

test('a deferring condition triggers the deferral-rate note', () => {
  const withDefers = nilMetrics([
    { docId: 1, category: 'C', mention: 'm', goldNil: true, decision: 'defer' },
  ]);
  const notes = tableNotes([condition({ nil: withDefers })]);
  assert.ok(notes.some((note) => note.includes('deferral-rate column is required')));
});

test('an empty shared universe is called out rather than reported as zeros', () => {
  const notes = tableNotes([
    condition({ cluster: clusterMetrics(Partition.fromGroups([]), gold) }),
  ]);
  assert.ok(notes.some((note) => note.includes('undefined, not zero')));
});

test('an empty shared universe dashes the cluster columns, so the table matches its own note', () => {
  // ARI returns a vacuous 1 for n < 2 and pairwise F1 a 0/0-derived 0. Printing either would
  // contradict the "undefined, not zero" note sitting directly beneath the table.
  const empty = clusterMetrics(Partition.fromGroups([]), gold);
  assert.equal(empty.universeSize, 0);

  const lines = renderResultsTable([condition({ cluster: empty })]).split('\n');
  const headers = lines[0].split('|').map((part) => part.trim());
  const cells = lines[2].split('|').map((part) => part.trim());

  for (const column of ['cluster F1 (pairwise)', 'B³ F1', 'ARI']) {
    const index = headers.indexOf(column);
    assert.notEqual(index, -1, `column ${column} missing`);
    assert.equal(cells[index], '—', `${column} must be dashed on an empty universe`);
  }
});

test('a NIL row with no observations dashes the deferral rate', () => {
  const lines = renderResultsTable([condition({ nil: nilMetrics([]) })]).split('\n');
  const headers = lines[0].split('|').map((part) => part.trim());
  const cells = lines[2].split('|').map((part) => part.trim());
  assert.equal(cells[headers.indexOf('defer rate')], '—', 'no observations → no rate to report');
});
