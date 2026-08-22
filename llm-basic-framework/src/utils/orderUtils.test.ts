import { orderFiles, validateOrderSpec } from './orderUtils';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const FILES = ['10.json', '2.json', '1.json', '30.json', '4.json'];

test('numeric-id is the canonical ascending order regardless of input order', () => {
  assert.deepEqual(orderFiles(FILES, 'numeric-id'), ['1.json', '2.json', '4.json', '10.json', '30.json']);
});

test('reverse is the exact mirror of numeric-id', () => {
  assert.deepEqual(orderFiles(FILES, 'reverse'), ['30.json', '10.json', '4.json', '2.json', '1.json']);
});

test('seededShuffle is a deterministic permutation: same seed same order, different seed different order', () => {
  const s1 = orderFiles(FILES, 'seededShuffle:1');
  const s1again = orderFiles([...FILES].reverse(), 'seededShuffle:1');
  const s2 = orderFiles(FILES, 'seededShuffle:2');
  assert.deepEqual(s1, s1again, 'depends only on seed and file set, not enumeration order');
  assert.deepEqual([...s1].sort(), [...FILES].sort(), 'a permutation, nothing lost');
  assert.notDeepEqual(s1, s2, 'seeds 1 and 2 disagree on 5 elements');
  assert.notDeepEqual(s1, orderFiles(FILES, 'numeric-id'), 'shuffle actually shuffles');
});

test('malformed specs fail fast', () => {
  assert.throws(() => validateOrderSpec('chronological'));
  assert.throws(() => validateOrderSpec('seededShuffle:abc'));
  assert.doesNotThrow(() => validateOrderSpec('seededShuffle:42'));
});
