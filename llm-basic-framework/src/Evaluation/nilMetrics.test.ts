import {
  mintVsMergeAsymmetry,
  nilMetrics,
  nilMetricsByStratum,
  nilMetricsIgnoringDeferrals,
  type NilObservation,
} from './nilMetrics';
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Asserts the value is defined as well as close: a null here means the metric was undefined. */
const near = (actual: number | null | undefined, expected: number, message?: string) => {
  assert.notEqual(actual, null, `${message ?? ''} expected ${expected}, got an UNDEFINED metric`);
  assert.ok(
    Math.abs(actual! - expected) < 1e-9,
    `${message ?? ''} expected ${expected}, got ${actual}`
  );
};

const obs = (over: Partial<NilObservation>): NilObservation => ({
  docId: 1,
  category: 'HackerGroup',
  mention: 'x',
  goldNil: true,
  decision: 'mint',
  ...over,
});

test('counts the four outcomes', () => {
  const result = nilMetrics([
    obs({ goldNil: true, decision: 'mint' }), // TP — correctly minted a novel entity
    obs({ goldNil: false, decision: 'mint' }), // FP — wrong mint (duplicate)
    obs({ goldNil: true, decision: 'link' }), // FN — wrong merge of a novel entity
    obs({ goldNil: false, decision: 'link' }), // TN — correctly linked a known entity
  ]);

  assert.equal(result.truePositives, 1);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falseNegatives, 1);
  assert.equal(result.trueNegatives, 1);
  near(result.precision, 0.5);
  near(result.recall, 0.5);
  near(result.f1, 0.5);
});

test('the same mention is NIL at first sight and known later', () => {
  // The prefix-relative property that forces a position-indexed gold schema: a flat
  // mention→label map could not express both rows.
  const result = nilMetrics([
    obs({ docId: 10, mention: 'UAC-0028', goldNil: true, decision: 'mint' }),
    obs({ docId: 90, mention: 'UAC-0028', goldNil: false, decision: 'link' }),
  ]);
  assert.equal(result.truePositives, 1);
  assert.equal(result.trueNegatives, 1);
  near(result.precision, 1);
  near(result.recall, 1);
});

// --- the defer convention (docs/statistical-protocol.md §5) ------------------------------------

test('defer is excluded from precision', () => {
  // One correct mint, one defer. Precision must be 1/1, not 1/2 — the defer made no mint claim.
  const result = nilMetrics([
    obs({ goldNil: true, decision: 'mint' }),
    obs({ goldNil: false, decision: 'defer' }),
  ]);
  assert.equal(result.deferred, 1);
  near(result.precision, 1, 'defer does not dilute precision');
});

test('defer on a gold-NIL mention IS charged against recall', () => {
  // Two gold NILs; one minted, one deferred. Recall must be 1/2, not 1/1.
  const result = nilMetrics([
    obs({ goldNil: true, decision: 'mint' }),
    obs({ goldNil: true, decision: 'defer' }),
  ]);
  assert.equal(result.deferredOnNil, 1);
  near(result.precision, 1);
  near(result.recall, 0.5, 'a missed mint is a miss whatever the reason');
});

test('"defer everything" cannot game the score', () => {
  // The failure mode the convention exists to prevent: withholding every decision must not yield
  // a good F1.
  const result = nilMetrics([
    obs({ goldNil: true, decision: 'defer' }),
    obs({ goldNil: true, decision: 'defer' }),
    obs({ goldNil: false, decision: 'defer' }),
  ]);
  // Precision is UNDEFINED, not 0: no mint was claimed, so there is nothing to be right or wrong
  // about. That is exactly why it cannot be quoted as a good score.
  assert.equal(result.precision, null, 'no mint claims at all → undefined precision');
  near(result.recall!, 0, 'both gold NILs missed, so recall is a defined 0');
  assert.equal(result.f1, null, 'F1 is unreportable when precision is undefined');
  near(result.deferralRate, 1, 'and the deferral rate makes it obvious');
});

test('deferral rate is always reported', () => {
  const result = nilMetrics([
    obs({ decision: 'mint' }),
    obs({ decision: 'link', goldNil: false }),
    obs({ decision: 'defer' }),
    obs({ decision: 'defer' }),
  ]);
  near(result.deferralRate, 0.5);
  assert.equal(result.observations, 4);
});

test('the appendix variant drops deferrals entirely, so the convention’s effect is visible', () => {
  const observations = [
    obs({ goldNil: true, decision: 'mint' }),
    obs({ goldNil: true, decision: 'defer' }),
  ];
  // Primary: recall 1/2 (deferral charged). Appendix: recall 1/1 (deferral dropped).
  near(nilMetrics(observations).recall!, 0.5);
  near(nilMetricsIgnoringDeferrals(observations).recall!, 1);
});

// --- strata -----------------------------------------------------------------------------------

test('per-stratum NIL metrics, never averaged', () => {
  const byStratum = nilMetricsByStratum([
    // memorized head: handled correctly
    obs({ stratum: 'c', goldNil: false, decision: 'link' }),
    obs({ stratum: 'c', goldNil: false, decision: 'link' }),
    // novel tail: both novel entities wrongly linked away
    obs({ stratum: 'd', goldNil: true, decision: 'link' }),
    obs({ stratum: 'd', goldNil: true, decision: 'link' }),
  ]);

  assert.equal(byStratum.c.trueNegatives, 2);
  near(byStratum.d.recall!, 0, 'total failure on the novel tail');
  assert.equal(byStratum.d.falseNegatives, 2);
  assert.ok('all' in byStratum, 'pooled row present for completeness');
});

// --- the RQ2 asymmetry prediction --------------------------------------------------------------

test('mint-vs-merge asymmetry reports both error kinds and their ratio', () => {
  const metrics = nilMetrics([
    obs({ goldNil: false, decision: 'mint' }), // wrong mint
    obs({ goldNil: false, decision: 'mint' }), // wrong mint
    obs({ goldNil: false, decision: 'mint' }), // wrong mint
    obs({ goldNil: true, decision: 'link' }), // wrong merge
  ]);
  const asymmetry = mintVsMergeAsymmetry(metrics);
  assert.equal(asymmetry.wrongMints, 3);
  assert.equal(asymmetry.wrongMerges, 1);
  near(asymmetry.ratio!, 3, 'wrong mints outnumber wrong merges 3:1');
});

test('asymmetry ratio is null rather than Infinity when there are no wrong merges', () => {
  const metrics = nilMetrics([obs({ goldNil: false, decision: 'mint' })]);
  assert.equal(mintVsMergeAsymmetry(metrics).ratio, null);
});

// --- degenerate ------------------------------------------------------------------------------

test('empty input yields undefined metrics and a defined 0 deferral rate, never NaN', () => {
  const result = nilMetrics([]);
  assert.equal(result.precision, null);
  assert.equal(result.recall, null);
  assert.equal(result.f1, null);
  assert.equal(result.deferralRate, 0, 'no observations means nothing was deferred');
  assert.equal(result.observations, 0);
});

test('with no gold NILs, recall is UNDEFINED rather than 0', () => {
  // Two correct links and nothing to mint. Reporting recall 0 would read as a failure to find
  // NILs that never existed; the honest answer is that recall is not defined on this slice.
  const result = nilMetrics([
    obs({ goldNil: false, decision: 'link' }),
    obs({ goldNil: false, decision: 'link' }),
  ]);
  assert.equal(result.recall, null, 'empty recall denominator → undefined');
  assert.equal(result.precision, null, 'no mint claims → undefined');
  assert.equal(result.f1, null);
  assert.equal(result.trueNegatives, 2, 'the two correct links are still counted');
});
