import { levenshteinRatio, stringSimilarity, tokenSetDice } from './similarityUtils';
import { matchStrings } from '../Normalization/matchStrings';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ''} expected ${expected}, got ${actual}`);

// --- the metrics themselves ---------------------------------------------------------------------

test('levenshteinRatio is 1 for identical and 0 for fully distinct equal-length strings', () => {
  near(levenshteinRatio('abc', 'abc'), 1);
  near(levenshteinRatio('abc', 'xyz'), 0, '3 edits over maxLen 3');
  near(levenshteinRatio('', ''), 1, 'both empty is a match, not 0/0');
  near(levenshteinRatio('abcd', 'abce'), 0.75, '1 edit over maxLen 4');
});

test('tokenSetDice ignores order and duplicates', () => {
  near(tokenSetDice('fancy bear', 'bear fancy'), 1, 'set semantics: order-free');
  near(tokenSetDice('a b', 'a c'), 0.5, '2·1/(2+2)');
  near(tokenSetDice('', ''), 1);
  near(tokenSetDice('a', ''), 0);
});

test('stringSimilarity is the max of the two, on trimmed lowercase input', () => {
  near(stringSimilarity('  APT28 ', 'apt28'), 1, 'case and whitespace folded');
  // "fancy bear" vs "bear fancy": dice = 1, levenshtein much lower → max is 1.
  near(stringSimilarity('Fancy Bear', 'Bear Fancy'), 1, 'dice wins where edit distance fails');
});

// --- the tie-break (the M2.5 fix) ---------------------------------------------------------------
//
// The contract moved from the retired `bestMatches` to `Normalization/matchStrings` in M4, and is
// shared with the candidate generators via `compareCandidates`. These tests follow it there: the
// ordering rule is what stops 37.6% of candidate lists being insertion-order dependent, so it is
// asserted wherever it is implemented.

/** Two candidates equidistant from the needle, so their similarity ties exactly. */
const tiedHaystack = (order: string[]) => order.map((key) => ({ key, strings: [key] }));

test('equal-similarity candidates are ordered by key, not by haystack order', () => {
  // "ab" vs "ac" and "ab" vs "ad": one substitution each over maxLen 2 → sim 0.5 for both.
  const forward = matchStrings('ab', tiedHaystack(['ac', 'ad']), { minSim: 0.4 });
  const reverse = matchStrings('ab', tiedHaystack(['ad', 'ac']), { minSim: 0.4 });

  near(forward[0].sim, 0.5, 'the two are genuinely tied');
  near(forward[1].sim, 0.5);
  assert.deepEqual(
    forward.map((match) => match.key),
    ['ac', 'ad'],
    'ties break on key ascending'
  );
  assert.deepEqual(
    reverse.map((match) => match.key),
    ['ac', 'ad'],
    'and the SAME order regardless of how the registry happened to be built'
  );
});

test('candidate order is invariant under any permutation of the haystack', () => {
  // The property that matters: registry insertion order (mint order, i.e. document order) must not
  // leak into what the judge sees.
  const keys = ['ac', 'ad', 'ae', 'af', 'ag'];
  const reference = matchStrings('ab', tiedHaystack(keys), { k: 5, minSim: 0.4 }).map((m) => m.key);

  const permutations = [
    [...keys].reverse(),
    ['ae', 'ac', 'ag', 'ad', 'af'],
    ['af', 'ag', 'ae', 'ad', 'ac'],
  ];
  for (const permutation of permutations) {
    assert.deepEqual(
      matchStrings('ab', tiedHaystack(permutation), { k: 5, minSim: 0.4 }).map((m) => m.key),
      reference,
      `permutation ${permutation.join(',')} changed the result`
    );
  }
});

test('the top-k CUT is deterministic when the boundary is tied', () => {
  // Four tied candidates, k = 2: which two survive must not depend on haystack order.
  const keys = ['ac', 'ad', 'ae', 'af'];
  const forward = matchStrings('ab', tiedHaystack(keys), { k: 2, minSim: 0.4 });
  const reverse = matchStrings('ab', tiedHaystack([...keys].reverse()), { k: 2, minSim: 0.4 });

  assert.deepEqual(forward.map((m) => m.key), ['ac', 'ad'], 'lowest keys win the cut');
  assert.deepEqual(reverse.map((m) => m.key), forward.map((m) => m.key));
});

test('higher similarity still beats key order', () => {
  // The tie-break must be secondary — never reorder genuinely different similarities.
  const matches = matchStrings('apt28', [
    { key: 'zzz-apt28', strings: ['apt28'] }, // sim 1
    { key: 'aaa-other', strings: ['apt2'] }, // sim 0.8
  ]);
  assert.deepEqual(matches.map((m) => m.key), ['zzz-apt28', 'aaa-other']);
  near(matches[0].sim, 1);
});

test('tie-break uses code-unit order, so Cyrillic keys sort identically everywhere', () => {
  // localeCompare would be ICU- and locale-dependent; `<` is not. These two are equidistant from
  // the needle, so only the tie-break decides.
  const matches = matchStrings('аб', tiedHaystack(['ав', 'аг']), { minSim: 0.4 });
  assert.deepEqual(matches.map((m) => m.key), ['ав', 'аг']);
  // 'в' (U+0432) < 'г' (U+0433) in code-unit order.
  assert.ok('ав' < 'аг');
});

// --- filtering and shape ------------------------------------------------------------------------

test('minSim excludes weak matches and k caps the list', () => {
  const haystack = [
    { key: 'exact', strings: ['apt28'] },
    { key: 'close', strings: ['apt29'] },
    { key: 'far', strings: ['completely different'] },
  ];
  const matches = matchStrings('apt28', haystack, { k: 5, minSim: 0.5 });
  assert.deepEqual(matches.map((m) => m.key), ['exact', 'close'], 'far is below minSim');
  assert.equal(matchStrings('apt28', haystack, { k: 1, minSim: 0.5 }).length, 1);
});

test('a candidate scores by its BEST string, over canonical plus aliases', () => {
  const matches = matchStrings('fancy bear', [
    { key: 'APT28', strings: ['APT28', 'Sofacy', 'Fancy Bear'] },
  ]);
  near(matches[0].sim, 1, 'the matching alias decides, not the canonical');
});

test('a duplicated string in the candidate does not change its score', () => {
  // ConceptRegistry.mint() stores the canonical inside its own alias list, so `candidates()` passes
  // [canonical, canonical, …]. max over a multiset equals max over the set.
  const deduped = matchStrings('apt28', [{ key: 'k', strings: ['apt28'] }]);
  const duplicated = matchStrings('apt28', [{ key: 'k', strings: ['apt28', 'apt28'] }]);
  assert.deepEqual(deduped, duplicated);
});

test('an empty haystack yields an empty list, not a throw', () => {
  assert.deepEqual(matchStrings('anything', []), []);
});

test('defaults are k=5, minSim=0.5 — the values the streaming pipeline passes', () => {
  const haystack = Array.from({ length: 10 }, (_, i) => ({ key: `apt2${i}`, strings: [`apt2${i}`] }));
  assert.equal(matchStrings('apt28', haystack).length, 5, 'default k');
  // 'apt28' vs 'apt2X' is one substitution over 5 chars → 0.8, above the 0.5 default.
  assert.ok(matchStrings('apt28', haystack).every((match) => match.sim >= 0.5));
});
