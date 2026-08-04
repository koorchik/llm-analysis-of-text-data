import { propagateVerdicts } from './propagate';
import type { WorksheetRow } from './worksheet';
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

describe('propagateVerdicts', () => {
  it('fills a pair whose endpoints one same-chain already connects', () => {
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'same' }),
      row('A', 'C'),
    ];
    const { rows: out, derived } = propagateVerdicts(rows);
    assert.equal(derived, 1);
    const filled = out.find((r) => r.left === 'A' && r.right === 'C')!;
    assert.equal(filled.label, 'same');
    assert.equal(filled.agreement, 'derived');
    assert.equal(filled.queue, 5);
  });

  it('lifts a different verdict across clusters — A=B and B≠C implies A≠C', () => {
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'different' }),
      row('A', 'C'),
    ];
    const { rows: out } = propagateVerdicts(rows);
    assert.equal(out.find((r) => r.left === 'A' && r.right === 'C')!.label, 'different');
  });

  it('lifts a rung edge with the direction mapped to the target row sides', () => {
    // B is finer than C (part-of, direction left on the B|C row). A=B, so A is finer than C too.
    // On the unlabelled row the pair reads (C, A) — the finer side is the RIGHT one there.
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'rung', relation: 'part-of', direction: 'left' }),
      row('C', 'A'),
    ];
    const { rows: out } = propagateVerdicts(rows);
    const filled = out.find((r) => r.left === 'C' && r.right === 'A')!;
    assert.equal(filled.label, 'rung');
    assert.equal(filled.relation, 'part-of');
    assert.equal(filled.direction, 'right');
  });

  it('iterates to a fixpoint — a same derived in pass one enables a lift in pass two', () => {
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'same' }),
      row('A', 'C'), // derived same in pass 1 (already connected)
      row('C', 'D', { label: 'different' }),
      row('A', 'D'), // needs A~C's cluster to lift C≠D
    ];
    const { rows: out, derived } = propagateVerdicts(rows);
    assert.equal(derived, 2);
    assert.equal(out.find((r) => r.left === 'A' && r.right === 'D')!.label, 'different');
  });

  it('reports a contradiction instead of filling it', () => {
    // A=B, and between the two clusters BOTH a different (B≠C) and the pair A|C would be same via
    // another chain: construct same-cluster membership AND a lifted different — contradictory.
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'same' }),
      row('A', 'C', { label: 'different' }), // human contradiction, already labelled
      row('B', 'D', { label: 'same' }),
      row('A', 'D'), // implied same (cluster) — but the cluster also carries an internal different
    ];
    const { rows: out, conflicts } = propagateVerdicts(rows);
    // The A|C contradiction is between labelled rows — reported, never rewritten.
    assert.ok(conflicts.length >= 1);
    assert.equal(out.find((r) => r.left === 'A' && r.right === 'C')!.label, 'different', 'labelled rows are never rewritten');
  });

  it('never pairs derivations across categories and leaves undecidable rows empty', () => {
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('A', 'B', { label: '', category: 'Software', left: 'A', right: 'B' }),
      row('X', 'Y'),
    ];
    const { rows: out, derived } = propagateVerdicts(rows);
    assert.equal(derived, 0);
    assert.equal(out.find((r) => r.category === 'Software')!.label, '');
    assert.equal(out.find((r) => r.left === 'X')!.label, '');
  });

  it('records the derivation basis in llmRationale', () => {
    const rows = [
      row('A', 'B', { label: 'same' }),
      row('B', 'C', { label: 'same' }),
      row('A', 'C'),
    ];
    const { rows: out } = propagateVerdicts(rows);
    assert.match(out.find((r) => r.left === 'A' && r.right === 'C')!.llmRationale ?? '', /derived/i);
  });
});
