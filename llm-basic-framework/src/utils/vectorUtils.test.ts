import { clampSimilarity, cosine, cosineNormalized, dot, l2Normalize, meanPool, norm } from './vectorUtils';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('dot is the sum of element-wise products', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
});

test('dot THROWS on a dimension mismatch — an encoder swap, not a dissimilar pair', () => {
  assert.throws(() => dot([1, 2], [1, 2, 3]), /dimension mismatch 2 vs 3/);
});

test('l2Normalize produces a unit vector and does not mutate its input', () => {
  const input = [3, 4];
  const unit = l2Normalize(input);
  assert.deepEqual(unit, [0.6, 0.8]);
  assert.ok(Math.abs(norm(unit) - 1) < 1e-12);
  assert.deepEqual(input, [3, 4]);
});

test('l2Normalize of a zero vector returns zeros, NOT NaN', () => {
  assert.deepEqual(l2Normalize([0, 0, 0]), [0, 0, 0]);
});

test('cosine of identical vectors is 1 to within float error — and NOT exactly 1', () => {
  // Measured: 0.9999999999999998. Recorded as an assertion because it is a trap for anyone who
  // reaches for `sim === 1` the way StringSimilarityGenerator's early exit does — that shortcut is
  // valid for string metrics and invalid for cosine, and `minSim: 1` retrieves nothing.
  const vector = [0.37, -0.91, 0.22, 0.05];
  const self = cosine(vector, vector);
  assert.ok(Math.abs(self - 1) < 1e-12, `expected ~1, got ${self}`);
  assert.ok(self <= 1, 'the clamp must never let it exceed 1');
});

test('cosine of orthogonal vectors is 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('a NEGATIVE cosine clamps to 0 rather than rescaling to 0.5', () => {
  // The convention that keeps minSim comparable with the string arms: opposed vectors are "no
  // evidence" (0), not "half similar". Rescaling would let orthogonal pairs pass minSim: 0.5.
  assert.equal(cosine([1, 0], [-1, 0]), 0);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine of a zero vector is 0, not NaN', () => {
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('cosineNormalized agrees with cosine on pre-normalized input', () => {
  const a = l2Normalize([2, 1, -3]);
  const b = l2Normalize([1, 1, 1]);
  assert.ok(Math.abs(cosineNormalized(a, b) - cosine(a, b)) < 1e-12);
});

test('clampSimilarity bounds both ends', () => {
  assert.equal(clampSimilarity(1 + 1e-16), 1);
  assert.equal(clampSimilarity(-0.4), 0);
  assert.equal(clampSimilarity(0.5), 0.5);
});

test('meanPool averages element-wise', () => {
  assert.deepEqual(meanPool([[0, 2], [2, 4]]), [1, 3]);
});

test('meanPool rejects an empty set rather than returning an empty vector', () => {
  assert.throws(() => meanPool([]), /empty set/);
});

test('meanPool rejects a ragged set', () => {
  assert.throws(() => meanPool([[1, 2], [1]]), /dimension mismatch/);
});
