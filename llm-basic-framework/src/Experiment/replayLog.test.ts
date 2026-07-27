import type { DecisionEvent } from '../DecisionLog/DecisionLog';
import {
  IdentityReplayStrategy,
  decisionKey,
  parseDecisionEvents,
  replayEvents,
  serializeDecisionEvents,
} from './replayLog';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const event = (over: Partial<DecisionEvent> = {}): DecisionEvent => ({
  mention: 'APT28',
  category: 'HackerGroup',
  docId: 40102,
  candidates: [
    { name: 'Fancy Bear', sim: 0.42, channel: 'string-sim' },
    { name: 'Sandworm', sim: 0.31, channel: 'string-sim' },
  ],
  decision: 'link',
  target: 'Fancy Bear',
  confidence: 0.9,
  ...over,
});

test('parseDecisionEvents keeps decision rows and skips llm-call rows', () => {
  const jsonl = [
    JSON.stringify({ op: 'llm-call', doc: 1, kind: 'extract', seconds: 1 }),
    JSON.stringify({ op: 'decision', ...event() }),
    '',
    JSON.stringify({ op: 'llm-call', doc: 2, kind: 'link-judge', seconds: 2 }),
  ].join('\n');

  const events = parseDecisionEvents(jsonl);
  assert.equal(events.length, 1);
  assert.equal(events[0].mention, 'APT28');
});

test('parseDecisionEvents reports the offending line on malformed JSON', () => {
  const jsonl = `${JSON.stringify({ op: 'decision', ...event() })}\nnot json\n`;
  assert.throws(() => parseDecisionEvents(jsonl), /line 2/);
});

test('replay fidelity: same strategy reproduces the log exactly (verification item 7)', async () => {
  const original = [
    event(),
    event({ mention: 'UAC-0028', decision: 'mint', target: null, docId: 40103 }),
    event({ mention: 'atera', category: 'Software', decision: 'defer', target: null, docId: 6280099 }),
  ];

  const replayed = await replayEvents(original, new IdentityReplayStrategy(original));

  assert.equal(replayed.length, original.length);
  replayed.forEach((got, index) => {
    const want = original[index];
    assert.equal(got.decision, want.decision);
    assert.equal(got.target, want.target);
    assert.equal(got.mention, want.mention);
    assert.equal(got.docId, want.docId);
    assert.equal(got.category, want.category);
    // The candidate set and its ORDER must survive: position bias is real, so a reordered
    // list would silently change what the replayed judge sees.
    assert.deepEqual(got.candidates, want.candidates);
  });
});

test('replay preserves candidate order rather than re-deriving it', async () => {
  const original = [event()];
  const replayed = await replayEvents(original, new IdentityReplayStrategy(original));
  assert.deepEqual(
    replayed[0].candidates.map((candidate) => candidate.name),
    ['Fancy Bear', 'Sandworm']
  );
});

test('replay stamps the strategy id so a swapped log is distinguishable', async () => {
  const original = [event()];
  const replayed = await replayEvents(original, new IdentityReplayStrategy(original));
  assert.equal(replayed[0].strategy, 'identity');
});

test('decisionKey includes category — one doc can carry one name under two categories', () => {
  // Confirmed in the corpus: `atera` appears as both Organization and Software in doc 6280099.
  const asOrg = { docId: 6280099, category: 'Organization', mention: 'atera' };
  const asSoftware = { docId: 6280099, category: 'Software', mention: 'atera' };
  assert.notEqual(decisionKey(asOrg), decisionKey(asSoftware));
});

test('decisionKey is case- and whitespace-insensitive on mention and category', () => {
  assert.equal(
    decisionKey({ docId: 1, category: 'HackerGroup', mention: '  APT28 ' }),
    decisionKey({ docId: 1, category: 'hackergroup', mention: 'apt28' })
  );
});

test('IdentityReplayStrategy fails loudly on an unlogged decision point', () => {
  const strategy = new IdentityReplayStrategy([event()]);
  assert.throws(
    () => strategy.decide({ mention: 'unseen', category: 'Country', docId: 9, candidates: [] }),
    /no logged verdict/
  );
});

test('two categories of the same mention both replay, neither is lost', async () => {
  const original = [
    event({ mention: 'atera', category: 'Organization', docId: 6280099, target: 'Atera Networks' }),
    event({ mention: 'atera', category: 'Software', docId: 6280099, target: 'Atera' }),
  ];
  const replayed = await replayEvents(original, new IdentityReplayStrategy(original));
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].target, 'Atera Networks');
  assert.equal(replayed[1].target, 'Atera');
});

test('serialize → parse round-trips', () => {
  const original = [event(), event({ mention: 'X', decision: 'mint', target: null })];
  const parsed = parseDecisionEvents(serializeDecisionEvents(original));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].candidates, original[0].candidates);
});
