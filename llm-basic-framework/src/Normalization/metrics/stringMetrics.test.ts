import { identityAnalyzer } from '../analyzers/identity';
import { stringSimilarity } from '../../utils/similarityUtils';
import {
  METRICS,
  charNgramCosine,
  charNgrams,
  damerauLevenshteinDistance,
  damerauRatio,
  jaroSimilarity,
  jaroWinklerSimilarity,
  levenshteinRatio,
  maxLevDice,
  maxOf,
  tokenSetDice,
  tokenize,
  weightedOf,
} from './stringMetrics';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const near = (actual: number, expected: number, tolerance = 1e-12, message?: string) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${message ?? ''} expected ${expected}, got ${actual}`);

// --- the composition that the gate depends on -------------------------------------------------------

test('identity + max(lev, dice) IS the pre-M4 stringSimilarity', () => {
  // The algebraic identity the M2.5 gate rests on. If this breaks, the gate breaks, and the reason
  // will be much harder to see there than here.
  const pairs: Array<[string, string]> = [
    ['APT28', 'apt28'],
    ['  Fancy Bear ', 'BEAR FANCY'],
    ['UAC-0010', 'UAC-0018'],
    ['accounts-ukr.net', 'accounts--ukr.net'],
    ['example.com', 'other.com'],
    ['Служба безпеки України', 'СБУ'],
    ['', ''],
    ['a', ''],
  ];

  for (const [a, b] of pairs) {
    const keyA = identityAnalyzer.keys(a, { category: 'X' })[0] ?? '';
    const keyB = identityAnalyzer.keys(b, { category: 'X' })[0] ?? '';
    near(
      maxLevDice.score(keyA, keyB),
      stringSimilarity(a, b),
      1e-15,
      `decomposition differs for ${JSON.stringify([a, b])}`
    );
  }
});

test('metrics do NOT normalize — that is the analyzer’s job', () => {
  // The pre-M4 stringSimilarity trimmed and lower-cased internally, which is exactly why it could
  // not be recombined with a different notion of identity.
  assert.notEqual(levenshteinRatio('APT28', 'apt28'), 1, 'raw metric sees different strings');
  near(levenshteinRatio('apt28', 'apt28'), 1);
});

// --- Levenshtein ------------------------------------------------------------------------------------

test('levenshteinRatio: known values', () => {
  near(levenshteinRatio('abc', 'abc'), 1);
  near(levenshteinRatio('abc', 'xyz'), 0, 1e-12, '3 edits over maxLen 3');
  near(levenshteinRatio('abcd', 'abce'), 0.75);
  near(levenshteinRatio('', ''), 1, 1e-12, 'not 0/0');
  near(levenshteinRatio('abc', ''), 0);
});

// --- Damerau ----------------------------------------------------------------------------------------

test('damerau counts a transposition as ONE edit, unlike Levenshtein', () => {
  // The common typo class in hand-entered names: Sandowrm vs Sandworm.
  assert.equal(damerauLevenshteinDistance('sandowrm', 'sandworm'), 1);
  near(damerauRatio('sandowrm', 'sandworm'), 1 - 1 / 8);
  // Plain Levenshtein charges two substitutions for the same pair.
  near(levenshteinRatio('sandowrm', 'sandworm'), 1 - 2 / 8);
  assert.ok(damerauRatio('sandowrm', 'sandworm') > levenshteinRatio('sandowrm', 'sandworm'));
});

test('damerau: identity, empties, and plain substitutions match Levenshtein', () => {
  assert.equal(damerauLevenshteinDistance('abc', 'abc'), 0);
  assert.equal(damerauLevenshteinDistance('', 'abc'), 3);
  assert.equal(damerauLevenshteinDistance('abc', ''), 3);
  assert.equal(damerauLevenshteinDistance('abc', 'axc'), 1);
  near(damerauRatio('', ''), 1);
});

test('damerau is symmetric', () => {
  for (const [a, b] of [['kitten', 'sitting'], ['ab', 'ba'], ['apt28', 'apt82']]) {
    assert.equal(damerauLevenshteinDistance(a, b), damerauLevenshteinDistance(b, a), `${a}/${b}`);
  }
});

// --- Jaro / Jaro–Winkler ----------------------------------------------------------------------------

test('jaro: the textbook reference values', () => {
  // MARTHA/MARHTA = 0.944444…, DWAYNE/DUANE = 0.822222…, DIXON/DICKSONX = 0.766666…
  near(jaroSimilarity('martha', 'marhta'), 0.9444444444444445, 1e-15);
  near(jaroSimilarity('dwayne', 'duane'), 0.8222222222222223, 1e-15);
  near(jaroSimilarity('dixon', 'dicksonx'), 0.7666666666666667, 1e-15);
  near(jaroSimilarity('abc', 'abc'), 1);
  near(jaroSimilarity('abc', 'xyz'), 0);
});

test('jaroWinkler adds the documented prefix bonus', () => {
  // MARTHA/MARHTA: jaro 0.944444… + 3 shared prefix chars × 0.1 × (1 − jaro) = 0.961111…
  near(jaroWinklerSimilarity('martha', 'marhta'), 0.9611111111111111, 1e-15);
  near(jaroWinklerSimilarity('dixon', 'dicksonx'), 0.8133333333333332, 1e-15);
});

test('jaroWinkler withholds the bonus below the 0.7 threshold', () => {
  const jaro = jaroSimilarity('ab', 'axxxxxxxx');
  assert.ok(jaro <= 0.7);
  near(jaroWinklerSimilarity('ab', 'axxxxxxxx'), jaro, 1e-15, 'no bonus applied');
});

test('jaroWinkler caps the prefix bonus at four characters', () => {
  // Two long strings sharing six leading characters must not get a six-character bonus.
  const withFive = jaroWinklerSimilarity('abcdefzzz', 'abcdefyyy');
  const jaro = jaroSimilarity('abcdefzzz', 'abcdefyyy');
  near(withFive, jaro + 4 * 0.1 * (1 - jaro), 1e-15);
});

test('jaroWinkler will FLATTER UAC-#### designations — a caution for E4', () => {
  // They share a four-character prefix by construction, so the bonus is always maximal. Recorded
  // because it means this metric must be reported per stratum, not in aggregate.
  const unrelated = jaroWinklerSimilarity('uac-0010', 'uac-0210');
  assert.ok(unrelated > 0.8, `expected an inflated score, got ${unrelated}`);
});

// --- token-set Dice ---------------------------------------------------------------------------------

test('tokenSetDice is order-free and set-based', () => {
  near(tokenSetDice('fancy bear', 'bear fancy'), 1);
  near(tokenSetDice('a b', 'a c'), 0.5, 1e-12, '2·1/(2+2)');
  near(tokenSetDice('', ''), 1);
  near(tokenSetDice('a', ''), 0);
});

test('tokenize splits on any run of non-letter, non-digit characters', () => {
  assert.deepEqual([...tokenize('accounts---ukr.net')], ['accounts', 'ukr', 'net']);
  assert.deepEqual([...tokenize('Служба безпеки')], ['Служба', 'безпеки']);
});

test('the measured Dice failure modes are pinned here', () => {
  // Two 2-token domains sharing only a TLD score EXACTLY 0.5 — the pipeline's minSim boundary, which
  // is why Domain had 1,058 tie-decided cuts in M2.5.
  near(tokenSetDice('example.com', 'other.com'), 0.5);
  near(tokenSetDice('gov.ua', 'mil.ua'), 0.5);

  // Punctuation-variant hosts have IDENTICAL token sets and score 1.0 while plausibly being
  // distinct typosquats. Any threshold-based merge arm will merge them unconditionally.
  near(tokenSetDice('accounts-ukr.net', 'accounts---ukr.net'), 1);
});

// --- char n-grams -----------------------------------------------------------------------------------

test('charNgrams pads so short strings still produce grams', () => {
  assert.deepEqual(charNgrams('ab', 3), [' ab', 'ab ']);
  assert.equal(charNgrams('abcdef', 3).length, 6, '" abcdef " length 8 → 6 trigrams');
  assert.deepEqual(charNgrams('a', 5), [' a ']);
});

test('charNgramCosine: identity, disjoint, and partial overlap', () => {
  near(charNgramCosine('apt28', 'apt28'), 1);
  near(charNgramCosine('abc', 'xyz'), 0);
  const partial = charNgramCosine('sandworm', 'sandwork');
  assert.ok(partial > 0.5 && partial < 1, `expected partial overlap, got ${partial}`);
});

test('charNgramCosine is symmetric and bounded', () => {
  for (const [a, b] of [['apt28', 'apt82'], ['ukr.net', 'ukr.com'], ['', 'x']]) {
    near(charNgramCosine(a, b), charNgramCosine(b, a), 1e-15);
    const score = charNgramCosine(a, b);
    assert.ok(score >= 0 && score <= 1 + 1e-12, `${a}/${b} out of range: ${score}`);
  }
});

// --- composites -------------------------------------------------------------------------------------

test('maxOf takes the best child score and names itself', () => {
  const metric = maxOf([METRICS.levenshtein, METRICS['token-dice']]);
  near(metric.score('fancy bear', 'bear fancy'), 1, 1e-12, 'dice wins where edit distance fails');
  assert.equal(maxLevDice.id, 'max-lev-dice');
  assert.match(metric.id, /^max\(levenshtein,token-dice\)$/);
});

test('weightedOf normalizes its weights', () => {
  const equal = weightedOf([
    { metric: METRICS.levenshtein, weight: 1 },
    { metric: METRICS['token-dice'], weight: 1 },
  ]);
  const scaled = weightedOf([
    { metric: METRICS.levenshtein, weight: 5 },
    { metric: METRICS['token-dice'], weight: 5 },
  ]);
  near(equal.score('a b', 'a c'), scaled.score('a b', 'a c'), 1e-15, 'weights need not sum to 1');
});

test('weightedOf with zero total weight returns 0 rather than NaN', () => {
  const degenerate = weightedOf([{ metric: METRICS.levenshtein, weight: 0 }]);
  assert.equal(Number.isNaN(degenerate.score('a', 'a')), false);
  near(degenerate.score('a', 'a'), 0);
});

// --- registry ---------------------------------------------------------------------------------------

test('every registered metric is bounded, symmetric, and 1 on identical input', () => {
  const samples = ['apt28', 'uac-0010', 'ukr.net', 'служба безпеки', '', 'a'];
  for (const [id, metric] of Object.entries(METRICS)) {
    for (const a of samples) {
      near(metric.score(a, a), 1, 1e-12, `${id} is not 1 on identical input (${JSON.stringify(a)})`);
      for (const b of samples) {
        const forward = metric.score(a, b);
        assert.ok(forward >= 0 && forward <= 1 + 1e-12, `${id} out of [0,1] for ${a}/${b}: ${forward}`);
        near(forward, metric.score(b, a), 1e-12, `${id} is asymmetric for ${a}/${b}`);
      }
    }
  }
});

test('mongeElkan is deliberately absent from the registry', () => {
  // The note rates it "document as considered-and-rejected", so it belongs in the paper's rejection
  // list. Implementing it would imply it had been evaluated. Same for phonetic metrics.
  assert.equal('monge-elkan' in METRICS, false);
  assert.equal('soundex' in METRICS, false);
  assert.equal('metaphone' in METRICS, false);
});
