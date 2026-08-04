import { applyPolicyVerdicts, humanExemplars, renderExemplars, selectPolicyTargets } from './policy';
import type { PairAnnotation } from './llmAnnotate';
import { rowKey } from './llmAnnotate';
import type { WorksheetRow } from './worksheet';
import type { PropagationConflict } from './propagate';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const row = (left: string, right: string, overrides: Partial<WorksheetRow> = {}): WorksheetRow => ({
  label: '',
  suggested: 'review',
  rule: 'none',
  source: 'string',
  category: 'Sector',
  left,
  right,
  stratum: 'a',
  mechanism: 'edit-similarity',
  sim: 0.8,
  evidence: '',
  ...overrides,
});

const annotation = (overrides: Partial<PairAnnotation> = {}): PairAnnotation => ({
  verdict: 'different',
  relation: '',
  direction: '',
  rationale: 'rule: scoping qualifier makes a rung',
  quote: '',
  ...overrides,
});

describe('humanExemplars', () => {
  it('collects labels that deviate from every machine prefill', () => {
    const rows = [
      row('A', 'B', { label: 'rung', relation: 'part-of', direction: 'left', ensemble: 'same', agreement: 'disagree' }),
      row('C', 'D', { label: 'same', ensemble: 'same', agreement: 'agree' }), // ensemble prefill
      row('E', 'F', { label: 'different', suggested: 'different' }), // rule prefill
      row('G', 'H', { label: 'same', agreement: 'derived' }), // propagation, not human
      row('I', 'J'), // unlabelled
    ];
    const exemplars = humanExemplars(rows);
    assert.equal(exemplars.length, 1);
    assert.equal(exemplars[0].left, 'A');
  });
});

describe('renderExemplars', () => {
  it('renders category, pair and compact verdict one per line', () => {
    const text = renderExemplars([
      row('A', 'B', { label: 'rung', relation: 'part-of', direction: 'left' }),
      row('C', 'D', { label: 'same', category: 'Software' }),
    ]);
    assert.equal(text, 'Sector | A | B => rung:part-of:left\nSoftware | C | D => same');
  });
});

describe('selectPolicyTargets', () => {
  it('targets unlabelled rows and machine-labelled rows involved in contradictions', () => {
    const conflicted = row('C', 'D', { label: 'same', ensemble: 'same', agreement: 'agree' });
    const rows = [
      row('A', 'B'), // unlabelled
      conflicted,
      row('E', 'F', { label: 'same', ensemble: 'same', agreement: 'agree' }), // machine, no conflict
      row('G', 'H', { label: 'rung', relation: 'isa', direction: 'left', agreement: 'human' }), // human in conflict — never a target
    ];
    const conflicts: PropagationConflict[] = [
      { reason: 'x', rows: [conflicted, rows[3]] },
    ];
    const targets = selectPolicyTargets(rows, conflicts);
    assert.deepEqual(targets.map((r) => r.left).sort(), ['A', 'C']);
  });
});

describe('applyPolicyVerdicts', () => {
  it('fills an unlabelled target and queues it for confirmation', () => {
    const rows = [row('A', 'B')];
    const votes = new Map([[rowKey(rows[0]), annotation({ verdict: 'rung', relation: 'isa', direction: 'right' })]]);
    const { rows: out, summary } = applyPolicyVerdicts(rows, votes);
    assert.equal(out[0].label, 'rung');
    assert.equal(out[0].relation, 'isa');
    assert.equal(out[0].direction, 'right');
    assert.equal(out[0].agreement, 'policy');
    assert.equal(out[0].queue, 3);
    assert.match(out[0].llmRationale ?? '', /scoping qualifier/);
    assert.equal(summary.filled, 1);
  });

  it('replaces a conflicted machine label and clears stale relation fields', () => {
    const rows = [row('C', 'D', { label: 'rung', relation: 'part-of', direction: 'left', ensemble: 'rung:part-of:left', agreement: 'majority' })];
    const votes = new Map([[rowKey(rows[0]), annotation({ verdict: 'same' })]]);
    const { rows: out } = applyPolicyVerdicts(rows, votes);
    assert.equal(out[0].label, 'same');
    assert.equal(out[0].relation, undefined);
    assert.equal(out[0].direction, undefined);
    assert.equal(out[0].agreement, 'policy');
  });

  it('leaves a row untouched when the policy judge is unsure', () => {
    const rows = [row('A', 'B', { queue: 1, agreement: 'disagree' })];
    const votes = new Map([[rowKey(rows[0]), annotation({ verdict: 'unsure', rationale: '' })]]);
    const { rows: out, summary } = applyPolicyVerdicts(rows, votes);
    assert.equal(out[0].label, '');
    assert.equal(out[0].agreement, 'disagree');
    assert.equal(summary.unsure, 1);
  });

  it('never touches a human or derived row even when a vote exists', () => {
    const rows = [row('A', 'B', { label: 'different', agreement: 'human', queue: 5 })];
    const votes = new Map([[rowKey(rows[0]), annotation({ verdict: 'same' })]]);
    const { rows: out } = applyPolicyVerdicts(rows, votes);
    assert.equal(out[0].label, 'different');
    assert.equal(out[0].agreement, 'human');
  });
});
