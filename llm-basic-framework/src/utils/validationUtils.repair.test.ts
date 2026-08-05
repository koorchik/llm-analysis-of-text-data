import {
  glossRestatesMention,
  normalizeLinkVerdicts,
  normalizeRepairReviews,
  REPAIR_OPS,
} from './validationUtils';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// ============================================================================
// T2: gloss on the link judge (prompts/link-judge.md, rules 3-4)
// ============================================================================

test('normalizeLinkVerdicts: null gloss pre-coerces to "" (LIVR absent idiom)', () => {
  const verdicts = normalizeLinkVerdicts({
    verdicts: [
      {
        mention: 'Voodoo Bear',
        category: 'HackerGroup',
        verdict: 'mint',
        gloss: null,
        reasoning: 'new actor',
      },
    ],
  });
  assert.equal(verdicts?.length, 1);
  assert.equal(verdicts?.[0].gloss, '');
});

test('normalizeLinkVerdicts: a "link" verdict has its gloss blanked in the post-pass', () => {
  // The prompt itself says gloss is null for "link" (rule 4), but a model that decorates a link
  // anyway must not have that gloss survive — it would poison duplicate-finding on a mention that
  // was resolved, not minted.
  const verdicts = normalizeLinkVerdicts({
    verdicts: [
      {
        mention: 'MS Office',
        category: 'Software',
        verdict: 'link',
        target: 'Microsoft Office',
        gloss: 'Russian state-sponsored group',
        reasoning: 'alias',
      },
    ],
  });
  assert.equal(verdicts?.length, 1);
  assert.equal(verdicts?.[0].verdict, 'link');
  assert.equal(verdicts?.[0].gloss, '');
});

test('normalizeLinkVerdicts: gloss carries through unchanged for mint/defer', () => {
  const verdicts = normalizeLinkVerdicts({
    verdicts: [
      {
        mention: 'Sandworm',
        category: 'HackerGroup',
        verdict: 'mint',
        gloss: 'Russian state-sponsored group targeting energy sector',
        reasoning: 'no match',
      },
    ],
  });
  assert.equal(verdicts?.[0].gloss, 'Russian state-sponsored group targeting energy sector');
});

// --- glossRestatesMention ------------------------------------------------------------------------

test('glossRestatesMention: identical strings restate', () => {
  assert.equal(glossRestatesMention('Voodoo Bear', 'Voodoo Bear'), true);
});

test('glossRestatesMention: case and punctuation are folded', () => {
  assert.equal(glossRestatesMention('voodoo-bear!', 'Voodoo Bear'), true);
  assert.equal(glossRestatesMention('VOODOO, BEAR.', 'voodoo bear'), true);
});

test('glossRestatesMention: gloss tokens that are a subset of the mention tokens still restate', () => {
  assert.equal(glossRestatesMention('Bear', 'Voodoo Bear'), true);
});

test('glossRestatesMention: a real, name-independent gloss does not restate', () => {
  assert.equal(
    glossRestatesMention('Russian state-sponsored group targeting energy sector', 'Voodoo Bear'),
    false
  );
});

// ============================================================================
// T2: normalizeRepairReviews (prompts/repair-judge.md)
// ============================================================================

test('normalizeRepairReviews: unknown op is dropped with console.error, without sinking the review', () => {
  const errorMock = mock.method(console, 'error', () => {});
  try {
    const reviews = normalizeRepairReviews({
      reviews: [
        {
          component: 1,
          ops: [
            { op: 'teleport', entity: 'X', confidence: 'high', evidence: 'nonsense op' },
            { op: 'keep', entity: 'APT28', confidence: 'high', evidence: 'coherent' },
          ],
        },
      ],
    });
    assert.equal(reviews?.length, 1, 'the review survives despite one bad op');
    assert.equal(reviews?.[0].ops.length, 1, 'only the valid op remains');
    assert.equal(reviews?.[0].ops[0].op, 'keep');
    assert.ok(errorMock.mock.calls.length >= 1, 'the drop is logged');
  } finally {
    errorMock.mock.restore();
  }
});

test('REPAIR_OPS lists the 7 ops in the order the prompt documents them', () => {
  assert.deepEqual([...REPAIR_OPS], ['merge', 'distinct', 'rung', 'renamed', 'split', 'move', 'keep']);
});

test('normalizeRepairReviews: "rung" round-trips finer/coarser/edgeKind', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'rung',
            finer: 'Unit 74455',
            coarser: 'GRU',
            edgeKind: 'part-of',
            confidence: 'high',
            evidence: 'sub-unit of the parent agency',
          },
        ],
      },
    ],
  });
  const op = reviews?.[0].ops[0];
  assert.equal(op?.op, 'rung');
  assert.equal(op?.finer, 'Unit 74455');
  assert.equal(op?.coarser, 'GRU');
  assert.equal(op?.edgeKind, 'part-of');
  assert.equal(op?.confidence, 'high');
});

test('normalizeRepairReviews: "rung" also round-trips the "coarsens-to" edgeKind', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'rung',
            finer: 'Office 2010 SP2',
            coarser: 'Microsoft Office',
            edgeKind: 'coarsens-to',
            confidence: 'medium',
            evidence: 'version of the product',
          },
        ],
      },
    ],
  });
  assert.equal(reviews?.[0].ops[0].edgeKind, 'coarsens-to');
});

test('normalizeRepairReviews: "split" round-trips alias/outOf', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'split',
            alias: 'Sandworm',
            outOf: 'GRU',
            confidence: 'medium',
            evidence: 'alias contradicts the entity gloss',
          },
        ],
      },
    ],
  });
  const op = reviews?.[0].ops[0];
  assert.equal(op?.op, 'split');
  assert.equal(op?.alias, 'Sandworm');
  assert.equal(op?.outOf, 'GRU');
});

test('normalizeRepairReviews: "move" round-trips alias/from/to', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'move',
            alias: 'Sandworm',
            from: 'GRU',
            to: 'APT28',
            confidence: 'medium',
            evidence: 'alias belongs to the other listed entity',
          },
        ],
      },
    ],
  });
  const op = reviews?.[0].ops[0];
  assert.equal(op?.op, 'move');
  assert.equal(op?.alias, 'Sandworm');
  assert.equal(op?.from, 'GRU');
  assert.equal(op?.to, 'APT28');
});

test('normalizeRepairReviews: missing confidence demotes to "low"', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [{ op: 'merge', from: 'APT28', into: 'Fancy Bear', evidence: 'alias statement' }],
      },
    ],
  });
  assert.equal(reviews?.[0].ops[0].confidence, 'low');
});

test('normalizeRepairReviews: an unrecognized confidence also demotes to "low"', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'merge',
            from: 'APT28',
            into: 'Fancy Bear',
            confidence: 'certain',
            evidence: 'alias statement',
          },
        ],
      },
    ],
  });
  assert.equal(reviews?.[0].ops[0].confidence, 'low');
});

test('normalizeRepairReviews: non-array pair coerces to []', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'distinct',
            pair: 'APT28, APT29',
            confidence: 'medium',
            evidence: 'no shared identifier',
          },
        ],
      },
    ],
  });
  assert.deepEqual(reviews?.[0].ops[0].pair, []);
});

test('normalizeRepairReviews: non-string entries inside a pair array are filtered out', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'distinct',
            pair: ['APT28', 42, null, 'APT29', { name: 'nested' }],
            confidence: 'medium',
            evidence: 'no shared identifier',
          },
        ],
      },
    ],
  });
  assert.deepEqual(reviews?.[0].ops[0].pair, ['APT28', 'APT29']);
});

test('normalizeRepairReviews: a well-formed pair array survives', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'distinct',
            pair: ['APT28', 'APT29'],
            confidence: 'medium',
            evidence: 'no shared identifier',
          },
        ],
      },
    ],
  });
  assert.deepEqual(reviews?.[0].ops[0].pair, ['APT28', 'APT29']);
});

test('normalizeRepairReviews: a review with a missing/invalid component number is dropped', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      { ops: [{ op: 'keep', entity: 'APT28', confidence: 'high', evidence: 'coherent' }] },
      {
        component: 2,
        ops: [{ op: 'keep', entity: 'APT29', confidence: 'high', evidence: 'coherent' }],
      },
    ],
  });
  assert.equal(reviews?.length, 1, 'the componentless review is dropped');
  assert.equal(reviews?.[0].component, 2);
});

test('normalizeRepairReviews: null op fields pre-coerce to "" (LIVR absent idiom)', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'split',
            alias: 'Sandworm',
            outOf: 'GRU',
            confidence: null,
            evidence: null,
          },
        ],
      },
    ],
  });
  assert.equal(reviews?.[0].ops[0].confidence, 'low');
  assert.equal(reviews?.[0].ops[0].evidence, '');
});

test('normalizeRepairReviews: renamed{from,to} maps `to` onto the shared `into` field', () => {
  const reviews = normalizeRepairReviews({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'renamed',
            from: 'Blue Kitsune',
            to: 'Sandworm',
            confidence: 'high',
            evidence: '"formerly known as"',
          },
        ],
      },
    ],
  });
  const op = reviews?.[0].ops[0];
  assert.equal(op?.op, 'renamed');
  assert.equal(op?.from, 'Blue Kitsune');
  assert.equal(op?.into, 'Sandworm');
});

test('normalizeRepairReviews: an explicit empty reviews list round-trips to []', () => {
  // Matches normalizeLinkVerdicts's established quirk: LIVR's `default` modifier fills in an
  // empty/missing *item*, but a fully absent top-level key still fails FORMAT_ERROR — asserted
  // here so a future refactor of the pre-coercion pass can't silently change this contract.
  assert.deepEqual(normalizeRepairReviews({ reviews: [] }), []);
});

test('normalizeRepairReviews: non-object input returns undefined', () => {
  assert.equal(normalizeRepairReviews(null as never), undefined);
});

test('normalizeRepairReviews: a fully-absent reviews key returns undefined, not []', () => {
  // The established normalizeLinkVerdicts quirk: LIVR's `default` modifier fills in an
  // empty/missing *item*, but a fully absent top-level key fails FORMAT_ERROR before `default`
  // ever applies. Pinned explicitly so a future refactor of the pre-coercion pass can't silently
  // change this contract — the sibling test below shows the {reviews: []} case that DOES round-trip.
  assert.equal(normalizeRepairReviews({}), undefined);
});
