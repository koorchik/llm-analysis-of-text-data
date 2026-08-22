import { normalizeLadderProposal } from './validationUtils';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const RUNG = { g: 0, name: 'product_name', preserving: true };

/**
 * `placements` and `rejected` are both optional `listOfObjects` fields, and LIVR's `default` does
 * not fire ahead of `listOfObjects` for an absent field — so an omitted one fails the whole
 * proposal with FORMAT_ERROR. That silently narrows a 3-member ladder ensemble to 2 whenever a
 * model declines to emit an empty array, which local models do routinely.
 */
test('an omitted optional list does not sink an otherwise valid ladder', () => {
  assert.ok(normalizeLadderProposal({ ladder: [RUNG], notes: '' }), 'omitting both');
  assert.ok(normalizeLadderProposal({ ladder: [RUNG], rejected: [], notes: '' }), 'omits placements');
  assert.ok(normalizeLadderProposal({ ladder: [RUNG], placements: [], notes: '' }), 'omits rejected');
});

test('an explicit null for an optional list is treated as absent', () => {
  assert.ok(normalizeLadderProposal({ ladder: [RUNG], rejected: null, placements: null, notes: '' }));
});

test('the omitted list arrives as an empty array, not undefined', () => {
  const proposal = normalizeLadderProposal({ ladder: [RUNG], notes: '' });
  assert.deepEqual(proposal?.rejected, []);
  assert.deepEqual(proposal?.placements, []);
});

test('a supplied rejected list still survives normalization', () => {
  const proposal = normalizeLadderProposal({
    ladder: [RUNG],
    rejected: [{ candidate: 'vendor', gate: 2, reason: 'not a granularity' }],
    notes: '',
  });
  assert.equal(proposal?.rejected.length, 1);
  assert.equal(proposal?.rejected[0].gate, '2', 'a numeric gate is coerced to string');
});

test('a genuinely malformed ladder is still rejected', () => {
  assert.equal(normalizeLadderProposal({ ladder: 'not-a-list', notes: '' }), undefined);
  assert.equal(normalizeLadderProposal({}), undefined);
});
