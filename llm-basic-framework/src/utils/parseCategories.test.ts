import { CATEGORY_VALUES, parseCategories } from './validationUtils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('parseCategories', () => {
  it('returns undefined for unset or empty input', () => {
    assert.equal(parseCategories(undefined), undefined);
    assert.equal(parseCategories(''), undefined);
    assert.equal(parseCategories('   '), undefined);
    assert.equal(parseCategories(','), undefined);
    assert.equal(parseCategories(' , '), undefined);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    assert.deepEqual(parseCategories('Software'), ['Software']);
    assert.deepEqual(parseCategories(' Software , HackerGroup '), ['Software', 'HackerGroup']);
  });

  it('accepts every canonical category, including the two-word one', () => {
    assert.deepEqual(parseCategories(CATEGORY_VALUES.join(',')), [...CATEGORY_VALUES]);
    assert.deepEqual(parseCategories('Government Body'), ['Government Body']);
  });

  it('throws on unknown names, listing them and the valid vocabulary', () => {
    assert.throws(() => parseCategories('Sofware'), /Sofware/);
    assert.throws(() => parseCategories('Software,Nope'), /Nope/);
    assert.throws(() => parseCategories('software'), /software/); // exact-case only
  });
});
