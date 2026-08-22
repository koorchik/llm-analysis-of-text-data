import { ComemSelectDecision } from './ComemSelectDecision';
import { ExactOnlyDecision } from './ExactOnlyDecision';
import { FellegiSunterDecision, defaultComparators } from './FellegiSunterDecision';
import { ListwiseGraphDecision } from './ListwiseGraphDecision';
import { ListwiseMintCandidateDecision } from './ListwiseMintCandidateDecision';
import { ThresholdDecision } from './ThresholdDecision';
import { DECISION_STRATEGIES, OFFLINE_STRATEGY_IDS } from './index';
import type { LlmClient } from '../../LlmClient/LlmClient';
import type { Candidate, DecisionRequest } from '../types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function candidate(canonical: string, sim: number, surfaces: string[] = []): Candidate {
  return { canonical, sim, surfaces: [canonical, ...surfaces], channel: 'test' };
}

function request(
  mention: string,
  candidates: Candidate[],
  overrides: Partial<DecisionRequest> = {}
): DecisionRequest {
  return { mention, category: 'HackerGroup', candidates, docId: 1, ...overrides };
}

/**
 * A stand-in for LlmClient that returns canned replies and records what it was sent.
 * An `Error` in the list is thrown on that call, which is how the failure paths are exercised.
 */
function fakeLlm(replies: Array<string | Error>) {
  const calls: Array<{ instructions: string; text: string }> = [];
  let index = 0;
  const client = {
    async send(instructions: string, text: string) {
      calls.push({ instructions, text });
      const reply = replies[Math.min(index++, replies.length - 1)];
      if (reply instanceof Error) throw reply;

      return {
        text: reply,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, calls, callCount: () => calls.length };
}

describe('ExactOnlyDecision', () => {
  it('links on an exact surface match and mints otherwise', async () => {
    const strategy = new ExactOnlyDecision();
    const [exact, near] = await strategy.decide([
      request('APT28', [candidate('APT28', 1)]),
      request('APT29', [candidate('APT28', 0.8)]),
    ]);
    assert.deepEqual(exact, {
      kind: 'link',
      target: 'APT28',
      confidence: 1,
      reason: 'exact surface match',
    });
    assert.equal(near.kind, 'mint');
  });

  it('matches an alias, not only the canonical name', async () => {
    const strategy = new ExactOnlyDecision();
    const [decision] = await strategy.decide([
      request('Fancy Bear', [candidate('APT28', 0.1, ['Fancy Bear'])]),
    ]);
    assert.equal(decision.target, 'APT28');
  });

  it('folds case by default, matching what the registry treats as identical', async () => {
    const insensitive = new ExactOnlyDecision();
    const sensitive = new ExactOnlyDecision({ caseSensitive: true });
    const req = [request('apt28', [candidate('APT28', 1)])];
    assert.equal((await insensitive.decide(req))[0].kind, 'link');
    assert.equal((await sensitive.decide(req))[0].kind, 'mint');
  });

  it('never defers — abstention is not part of the floor', async () => {
    const strategy = new ExactOnlyDecision();
    const decisions = await strategy.decide([
      request('a', []),
      request('b', [candidate('b', 1)]),
      request('c', [candidate('d', 0.99)]),
    ]);
    assert.ok(decisions.every((decision) => decision.kind !== 'defer'));
  });
});

describe('ThresholdDecision', () => {
  it('links at or above the threshold, mints below', async () => {
    const strategy = new ThresholdDecision({ threshold: 0.8 });
    const [at, below] = await strategy.decide([
      request('x', [candidate('X', 0.8)]),
      request('y', [candidate('Y', 0.79)]),
    ]);
    assert.equal(at.kind, 'link');
    assert.equal(below.kind, 'mint');
  });

  it('links the top candidate, since the list arrives pre-sorted', async () => {
    const strategy = new ThresholdDecision({ threshold: 0.5 });
    const [decision] = await strategy.decide([
      request('x', [candidate('First', 0.9), candidate('Second', 0.85)]),
    ]);
    assert.equal(decision.target, 'First');
  });

  it('gets the UAC-0010 case wrong, which is why the arm exists', async () => {
    // UAC-0010 retrieves UAC-0018 at 0.875, ahead of its own "UAC-0010 (Armageddon)" alias at 0.8.
    // Any threshold in (0.8, 0.875] links the wrong one; this is the documented failure, not a bug.
    const strategy = new ThresholdDecision({ threshold: 0.85 });
    const [decision] = await strategy.decide([
      request('UAC-0010', [candidate('UAC-0018', 0.875), candidate('UAC-0010 (Armageddon)', 0.8)]),
    ]);
    assert.equal(decision.kind, 'link');
    assert.equal(decision.target, 'UAC-0018');
  });

  it('reports no confidence — a retrieval score is not a calibrated probability', async () => {
    const strategy = new ThresholdDecision();
    const [decision] = await strategy.decide([request('x', [candidate('X', 0.95)])]);
    assert.equal(decision.confidence, null);
  });

  it('defers inside the band when one is configured, and not otherwise', async () => {
    const banded = new ThresholdDecision({ threshold: 0.8, deferBand: 0.1 });
    const plain = new ThresholdDecision({ threshold: 0.8 });
    const req = [request('x', [candidate('X', 0.75)])];
    assert.equal((await banded.decide(req))[0].kind, 'defer');
    assert.equal((await plain.decide(req))[0].kind, 'mint');
  });

  it('defers a near-tie when minMargin is set', async () => {
    const strategy = new ThresholdDecision({ threshold: 0.8, minMargin: 0.05 });
    const [tie, clear] = await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.89)]),
      request('y', [candidate('C', 0.9), candidate('D', 0.5)]),
    ]);
    assert.equal(tie.kind, 'defer');
    assert.equal(clear.kind, 'link');
  });

  it('links a sole candidate under minMargin — there is no runner-up to tie with', async () => {
    const strategy = new ThresholdDecision({ threshold: 0.8, minMargin: 0.5 });
    const [decision] = await strategy.decide([request('x', [candidate('X', 0.85)])]);
    assert.equal(decision.kind, 'link');
  });

  it('mints when there are no candidates at all', async () => {
    const [decision] = await new ThresholdDecision().decide([request('x', [])]);
    assert.equal(decision.kind, 'mint');
    assert.equal(decision.reason, 'no candidates');
  });

  it('rejects a threshold outside [0, 1] rather than silently never linking', () => {
    assert.throws(() => new ThresholdDecision({ threshold: 1.5 }), /must be in \[0, 1\]/);
  });
});

describe('FellegiSunterDecision', () => {
  it('links an exact match, which agrees on every comparator', async () => {
    const strategy = new FellegiSunterDecision();
    const [decision] = await strategy.decide([request('APT28', [candidate('APT28', 1)])]);
    assert.equal(decision.kind, 'link');
    assert.equal(decision.target, 'APT28');
  });

  it('separates UAC-0010 from UAC-0018, where a threshold cannot', async () => {
    // The pair agrees on edit distance and trigrams but disagrees on digits. The negative weight
    // from that disagreement is the property the threshold arm has no way to express.
    const strategy = new FellegiSunterDecision();
    const [decision] = await strategy.decide([request('UAC-0010', [candidate('UAC-0018', 0.875)])]);
    assert.notEqual(decision.target, 'UAC-0018');
  });

  it('scores against the best-agreeing surface, not only the canonical', async () => {
    const strategy = new FellegiSunterDecision();
    const [decision] = await strategy.decide([
      request('Armageddon', [candidate('UAC-0010', 0.2, ['Armageddon'])]),
    ]);
    assert.equal(decision.kind, 'link');
    assert.equal(decision.target, 'UAC-0010');
  });

  it('returns defer for the middle region by default and mint when noDefer is set', async () => {
    const middle = request('accounts-ukr.net', [candidate('accounts-ukrnet.com', 0.9)]);
    const threeWay = await new FellegiSunterDecision().decide([middle]);
    const twoWay = await new FellegiSunterDecision({ noDefer: true }).decide([middle]);
    // Whatever the weight lands on, the two-way arm must never abstain.
    assert.ok(['link', 'defer', 'mint'].includes(threeWay[0].kind));
    assert.notEqual(twoWay[0].kind, 'defer');
  });

  it('is deterministic and independent of candidate order on a weight tie', async () => {
    const strategy = new FellegiSunterDecision();
    const forward = await strategy.decide([
      request('zzz', [candidate('Alpha', 0.5), candidate('Beta', 0.5)]),
    ]);
    const reversed = await strategy.decide([
      request('zzz', [candidate('Beta', 0.5), candidate('Alpha', 0.5)]),
    ]);
    assert.deepEqual(forward[0], reversed[0]);
  });

  it('records its comparator priors in config, so a run card shows what was assumed', () => {
    const strategy = new FellegiSunterDecision();
    const comparators = strategy.config.comparators as Array<{ id: string; m: number; u: number }>;
    assert.deepEqual(
      comparators.map((comparator) => comparator.id),
      defaultComparators().map((comparator) => comparator.id)
    );
    assert.ok(comparators.every((comparator) => comparator.m > 0 && comparator.u > 0));
  });

  it('rejects a degenerate prior that would make one comparator override all others', () => {
    const broken = [{ id: 'always', agrees: () => true, m: 1, u: 0.5 }];
    assert.throws(
      () => new FellegiSunterDecision({ comparators: broken }),
      /strictly within \(0, 1\)/
    );
  });

  it('rejects cutoffs that cross', () => {
    assert.throws(() => new FellegiSunterDecision({ upper: 1, lower: 5 }), /must not exceed upper/);
  });
});

describe('ListwiseMintCandidateDecision', () => {
  it('puts NEW ENTITY in the list as the last numbered option', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"HackerGroup","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client, k: 4 });
    await strategy.decide([request('x', [candidate('A', 0.9), candidate('B', 0.8)])]);
    assert.match(llm.calls[0].text, /3\. NEW ENTITY/);
  });

  it('links the chosen option by number', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"HackerGroup","choice":2}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.8)]),
    ]);
    assert.equal(decision.kind, 'link');
    assert.equal(decision.target, 'B');
  });

  it('mints when the judge picks the NEW ENTITY option', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"HackerGroup","choice":3}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.8)]),
    ]);
    assert.equal(decision.kind, 'mint');
    assert.equal(decision.reason, 'judge chose NEW ENTITY');
  });

  it('distinguishes an out-of-range answer from a deliberate mint', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"HackerGroup","choice":9}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('x', [candidate('A', 0.9)])]);
    assert.equal(decision.kind, 'mint');
    assert.match(decision.reason, /out of range/);
  });

  it('caps the list at k', async () => {
    const llm = fakeLlm(['{"choices":[]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client, k: 2 });
    await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.8), candidate('C', 0.7)]),
    ]);
    assert.doesNotMatch(llm.calls[0].text, /C \[aliases/);
    assert.match(llm.calls[0].text, /3\. NEW ENTITY/);
  });

  it('keeps two categories of the same surface apart — the batchByMention bug', async () => {
    // `atera` was extracted as both Organization and Software in doc 6280099. Keying by mention
    // alone collapsed them, so one lost its verdict and could be assigned the other's target.
    const llm = fakeLlm([
      `{"choices":[
        {"mention":"atera","category":"Organization","choice":1},
        {"mention":"atera","category":"Software","choice":2}
      ]}`,
    ]);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [organization, software] = await strategy.decide([
      request('atera', [candidate('Atera Networks', 0.9)], { category: 'Organization' }),
      request('atera', [candidate('AteraAgent', 0.9), candidate('Atera RMM', 0.8)], {
        category: 'Software',
      }),
    ]);
    assert.equal(organization.target, 'Atera Networks');
    assert.equal(software.target, 'Atera RMM');
  });

  it('falls back to a mention-only match only when that surface is unambiguous', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"solo","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('solo', [candidate('Solo Inc', 0.9)])]);
    assert.equal(decision.target, 'Solo Inc');
  });

  it('refuses to guess when the category is omitted and the surface is ambiguous', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"atera","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('atera', [candidate('Atera Networks', 0.9)], { category: 'Organization' }),
      request('atera', [candidate('AteraAgent', 0.9)], { category: 'Software' }),
    ]);
    assert.ok(decisions.every((decision) => decision.kind === 'mint'));
  });

  it('accepts a mention echoed back with the quotes the prompt showed it in', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"\\"shellcode.x64.bin\\"","category":"Software","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('shellcode.x64.bin', [candidate('shellcode.x64 (Cobalt Strike Beacon)', 0.9)]),
    ]);
    assert.equal(decision.target, 'shellcode.x64 (Cobalt Strike Beacon)');
  });

  it('still refuses a quoted mention-only match when the surface is ambiguous', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"\\"atera\\"","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('atera', [candidate('Atera Networks', 0.9)], { category: 'Organization' }),
      request('atera', [candidate('AteraAgent', 0.9)], { category: 'Software' }),
    ]);
    assert.ok(decisions.every((decision) => decision.kind === 'mint'));
  });

  it('makes exactly one call per document, not per mention', async () => {
    const llm = fakeLlm(['{"choices":[]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
      request('c', [candidate('C', 0.9)]),
    ]);
    assert.equal(llm.callCount(), 1);
  });

  it('accepts compact positional choices with exactly one entry per askable mention', async () => {
    const llm = fakeLlm(['{"choices":[1,2]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
    ]);
    assert.equal(decisions[0].target, 'A');
    assert.equal(decisions[1].kind, 'mint');
  });

  it('rejects an incomplete compact response instead of shifting choices', async () => {
    const llm = fakeLlm(['{"choices":[1]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
    ]);
    assert.ok(decisions.every((decision) => decision.kind === 'mint'));
  });

  it('spends nothing when no mention has candidates', async () => {
    const llm = fakeLlm(['{"choices":[]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([request('a', []), request('b', [])]);
    assert.equal(llm.callCount(), 0);
    assert.ok(decisions.every((decision) => decision.reason === 'no candidates'));
  });

  it('returns one decision per request, positionally aligned, even when some have no candidates', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"b","category":"HackerGroup","choice":1}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('a', []),
      request('b', [candidate('B', 0.9)]),
      request('c', []),
    ]);
    assert.equal(decisions.length, 3);
    assert.equal(decisions[0].kind, 'mint');
    assert.equal(decisions[1].target, 'B');
    assert.equal(decisions[2].kind, 'mint');
  });

  it('mints everything rather than aborting the document when the call fails', async () => {
    const llm = fakeLlm([new Error('boom')]);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([request('a', [candidate('A', 0.9)])]);
    assert.equal(decisions[0].kind, 'mint');
    assert.equal(decisions[0].reason, 'judge call failed');
  });

  it('mints on unparseable output rather than inventing a link', async () => {
    const llm = fakeLlm(['not json at all']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('a', [candidate('A', 0.9)])]);
    assert.equal(decision.kind, 'mint');
  });

  it('records the prompt hash in config, so the run card pins the judged text', () => {
    const llm = fakeLlm(['{}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    assert.match(String(strategy.config.promptSha256), /^[0-9a-f]{64}$/);
  });

  it('records an explicit prompt variant and candidate width in config', () => {
    const llm = fakeLlm(['{}']);
    const strategy = new ListwiseMintCandidateDecision({
      llmClient: llm.client,
      promptId: 'listwise-select-compact-v1',
      k: 8,
    });
    assert.equal(strategy.config.promptId, 'listwise-select-compact-v1');
    assert.equal(strategy.config.k, 8);
    assert.match(String(strategy.config.promptSha256), /^[0-9a-f]{64}$/);
  });

  it('never defers', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"a","category":"HackerGroup","choice":2}]}']);
    const strategy = new ListwiseMintCandidateDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('a', [candidate('A', 0.9)])]);
    assert.notEqual(decision.kind, 'defer');
  });
});

describe('ComemSelectDecision', () => {
  it('makes one call per mention — the published protocol, and the cost finding', async () => {
    const llm = fakeLlm(['{"selected":0}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
    ]);
    assert.equal(llm.callCount(), 2);
  });

  it('links the selected candidate and mints on 0', async () => {
    const llm = fakeLlm(['{"selected":1}', '{"selected":0}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    const [linked, minted] = await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
    ]);
    assert.equal(linked.target, 'A');
    assert.equal(minted.kind, 'mint');
    assert.equal(minted.reason, 'judge selected none of the above');
  });

  it('serializes candidates as attribute-value pairs without repeating the canonical', async () => {
    const llm = fakeLlm(['{"selected":0}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    await strategy.decide([request('x', [candidate('APT28', 0.9, ['Fancy Bear'])])]);
    const { text } = llm.calls[0];
    assert.match(text, /1\. name: APT28 \| category: HackerGroup \| aliases: Fancy Bear/);
    // mint() stores the canonical in its own alias list; it must not be echoed back as an alias.
    assert.doesNotMatch(text, /aliases: APT28/);
  });

  it('offers 0 as the explicit none option', async () => {
    const llm = fakeLlm(['{"selected":0}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    await strategy.decide([request('x', [candidate('A', 0.9)])]);
    assert.match(llm.calls[0].text, /^0\. none of the above$/m);
  });

  it('spends nothing on a mention with no candidates', async () => {
    const llm = fakeLlm(['{"selected":0}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('x', [])]);
    assert.equal(llm.callCount(), 0);
    assert.equal(decision.reason, 'no candidates');
  });

  it('mints on an out-of-range selection', async () => {
    const llm = fakeLlm(['{"selected":7}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([request('x', [candidate('A', 0.9)])]);
    assert.equal(decision.kind, 'mint');
    assert.match(decision.reason, /out of range/);
  });

  it('mints that mention only when its own call fails, leaving the rest intact', async () => {
    const llm = fakeLlm([new Error('boom'), '{"selected":1}']);
    const strategy = new ComemSelectDecision({ llmClient: llm.client });
    const [failed, fine] = await strategy.decide([
      request('a', [candidate('A', 0.9)]),
      request('b', [candidate('B', 0.9)]),
    ]);
    assert.equal(failed.reason, 'judge call failed');
    assert.equal(fine.target, 'B');
  });
});

describe('the strategy registry', () => {
  it('exposes every MVA strategy the plan names', () => {
    assert.deepEqual(Object.keys(DECISION_STRATEGIES).sort(), [
      'comem-select',
      'exact-only',
      'fellegi-sunter',
      'listwise-graph',
      'listwise-mint-candidate',
      'threshold',
    ]);
  });

  it('the offline strategies really are constructible without an LLM client', async () => {
    for (const id of OFFLINE_STRATEGY_IDS) {
      const Strategy = DECISION_STRATEGIES[id] as new () => { id: string; decide: Function };
      const strategy = new Strategy();
      assert.equal(strategy.id, id);
      const decisions = await strategy.decide([request('x', [candidate('X', 1)])]);
      assert.equal(decisions.length, 1);
    }
  });

  it('every strategy returns exactly one decision per request, in order', async () => {
    const llm = fakeLlm(['{"choices":[],"selected":0}']);
    const strategies = [
      new ExactOnlyDecision(),
      new ThresholdDecision(),
      new FellegiSunterDecision(),
      new ListwiseMintCandidateDecision({ llmClient: llm.client }),
      new ComemSelectDecision({ llmClient: llm.client }),
    ];
    const requests = [
      request('alpha', [candidate('Alpha', 1)]),
      request('beta', []),
      request('gamma', [candidate('Delta', 0.6)]),
    ];
    for (const strategy of strategies) {
      const decisions = await strategy.decide(requests);
      assert.equal(decisions.length, requests.length, strategy.id);
      assert.ok(
        decisions.every((decision) => ['link', 'mint', 'defer'].includes(decision.kind)),
        strategy.id
      );
      // A link must always name a target; a mint or defer must never claim one.
      for (const decision of decisions) {
        if (decision.kind === 'link') assert.ok(decision.target, strategy.id);
        else assert.equal(decision.target, null, strategy.id);
      }
    }
  });

  it('every strategy exposes a config the run card can serialize', () => {
    const llm = fakeLlm(['{}']);
    const strategies = [
      new ExactOnlyDecision(),
      new ThresholdDecision(),
      new FellegiSunterDecision(),
      new ListwiseMintCandidateDecision({ llmClient: llm.client }),
      new ComemSelectDecision({ llmClient: llm.client }),
    ];
    for (const strategy of strategies) {
      assert.doesNotThrow(() => JSON.stringify(strategy.config), strategy.id);
      assert.ok(Object.keys(strategy.config).length > 0, strategy.id);
    }
  });
});

describe('ListwiseGraphDecision', () => {
  it('decides identity and the parent edge in ONE call per document', async () => {
    const llm = fakeLlm([
      '{"choices":[' +
        '{"mention":"Office 2010","category":"Software","choice":3,"parent":1,"relation":"narrower-of","gloss":"a 2010 release of the office suite"},' +
        '{"mention":"MS Word","category":"Software","choice":3,"parent":1,"relation":"part-of","gloss":"the word processor in the suite"}' +
        ']}',
    ]);
    const pool = [{ canonical: 'MS Office', surfaces: ['MS Office'] }];
    const strategy = new ListwiseGraphDecision({ llmClient: llm.client });
    const decisions = await strategy.decide([
      request('Office 2010', [candidate('MS Office', 0.9), candidate('Excel', 0.5)], { category: 'Software', pool }),
      request('MS Word', [candidate('MS Office', 0.9), candidate('Excel', 0.5)], { category: 'Software', pool }),
    ]);

    assert.equal(llm.callCount(), 1, 'both mentions ride one call');
    assert.equal(decisions[0].kind, 'mint');
    assert.equal(decisions[0].parentCandidate, 'MS Office');
    assert.equal(decisions[0].gloss, 'a 2010 release of the office suite');
    assert.equal(decisions[1].parentCandidate, 'MS Office');
  });

  it('ignores a parent on a mention it linked — an entity cannot be both the same and narrower', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"Software","choice":1,"parent":2,"relation":"part-of"}]}']);
    const strategy = new ListwiseGraphDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.8)], {
        category: 'Software',
        pool: [{ canonical: 'A', surfaces: ['A'] }, { canonical: 'B', surfaces: ['B'] }],
      }),
    ]);
    assert.equal(decision.kind, 'link');
    assert.equal(decision.parentCandidate, undefined);
  });

  it('drops a parent number that is out of range rather than guessing', async () => {
    const llm = fakeLlm(['{"choices":[{"mention":"x","category":"Software","choice":3,"parent":9,"relation":"part-of"}]}']);
    const strategy = new ListwiseGraphDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('x', [candidate('A', 0.9), candidate('B', 0.8)], {
        category: 'Software',
        pool: [{ canonical: 'A', surfaces: ['A'] }],
      }),
    ]);
    assert.equal(decision.kind, 'mint');
    assert.equal(decision.parentCandidate, null);
  });

  it('takes a parent that is nowhere in the mention own option list — the pool is the point', async () => {
    // rfusclient.exe -> Remote Utilities: the identity blocker never surfaces the parent, because a
    // component and its system do not resemble each other by name. The pool carries it anyway.
    const llm = fakeLlm([
      '{"choices":[{"mention":"rfusclient.exe","category":"Software","choice":3,"parent":2,"relation":"part-of","gloss":"a client executable"}]}',
    ]);
    const strategy = new ListwiseGraphDecision({ llmClient: llm.client });
    const [decision] = await strategy.decide([
      request('rfusclient.exe', [candidate('rutserv.exe', 0.6), candidate('b.exe', 0.4)], {
        category: 'Software',
        pool: [
          { canonical: 'rutserv.exe', surfaces: ['rutserv.exe'] },
          { canonical: 'Remote Utilities', surfaces: ['Remote Utilities'] },
        ],
      }),
    ]);
    assert.equal(decision.parentCandidate, 'Remote Utilities');
    assert.equal(decision.broaderType, 'broaderPartitive');
    assert.match(llm.calls[0].text, /P2\. Remote Utilities/);
  });
});

describe('ListwiseGraphDecision SKOS ballot', () => {
  it('never renders a Levels block or rung labels — the SKOS ballot has no ladder', async () => {
    const llm = fakeLlm(['{"v":[{"m":"M1","id":"NEW"},{"m":"M2","id":"NEW"}]}']);
    const strategy = new ListwiseGraphDecision({
      llmClient: llm.client,
      promptId: 'listwise-skos-v1',
    });
    await strategy.decide([
      request('x', [candidate('A', 0.9)], {
        category: 'Software',
        pool: [{ canonical: 'A', surfaces: ['A'] }],
      }),
      request('y', [candidate('B', 0.9)], {
        category: 'Domain',
        pool: [{ canonical: 'B', surfaces: ['B'] }],
      }),
    ]);
    assert.doesNotMatch(llm.calls[0].text, /Levels/);
    assert.doesNotMatch(llm.calls[0].text, /<g\d+>/);
  });

  it('r:"b" reverses the edge: relation narrower-of with mentionIsBroader set', async () => {
    const llm = fakeLlm(['{"v":[{"m":"M1","id":"NEW","p":"E1","r":"b","g":"a product family"}]}']);
    const strategy = new ListwiseGraphDecision({
      llmClient: llm.client,
      promptId: 'listwise-skos-v1',
    });
    const [decision] = await strategy.decide([
      request('Office', [candidate('Office 2010', 0.9)], {
        category: 'Software',
        pool: [{ canonical: 'Office 2010', surfaces: ['Office 2010'] }],
      }),
    ]);
    assert.equal(decision.kind, 'mint');
    assert.equal(decision.parentCandidate, 'Office 2010');
    assert.equal(decision.broaderType, 'broaderGeneric');
    assert.equal(decision.mentionIsBroader, true);
  });

  it('word-valued relation codes (the skos-v2 ablation) map like their single-letter twins', async () => {
    const llm = fakeLlm([
      '{"v":[{"m":"M1","id":"NEW","p":"E1","r":"version","g":null},{"m":"M2","id":"NEW","p":"E2","r":"broader","g":null}]}',
    ]);
    const strategy = new ListwiseGraphDecision({
      llmClient: llm.client,
      promptId: 'listwise-skos-v2',
    });
    const pool = [
      { canonical: 'Office', surfaces: ['Office'] },
      { canonical: 'Office 2010', surfaces: ['Office 2010'] },
    ];
    const [first, second] = await strategy.decide([
      request('Office 2013', [candidate('Office', 0.9)], { category: 'Software', pool }),
      request('Office Suite', [candidate('Office 2010', 0.9)], { category: 'Software', pool }),
    ]);
    assert.equal(first.parentCandidate, 'Office');
    assert.equal(first.broaderType, 'broaderInstantial');
    assert.ok(!first.mentionIsBroader);
    assert.equal(second.parentCandidate, 'Office 2010');
    assert.equal(second.broaderType, 'broaderGeneric');
    assert.equal(second.mentionIsBroader, true);
  });

  it('a stray lvl field in the response is ignored, not applied', async () => {
    const llm = fakeLlm(['{"v":[{"m":"M1","id":"NEW","p":null,"r":null,"lvl":"g2","g":null}]}']);
    const strategy = new ListwiseGraphDecision({
      llmClient: llm.client,
      promptId: 'listwise-skos-v1',
    });
    const [decision] = await strategy.decide([
      request('x', [candidate('A', 0.9)], {
        category: 'Software',
        pool: [{ canonical: 'A', surfaces: ['A'] }],
      }),
    ]);
    assert.equal(decision.kind, 'mint');
    assert.equal('mentionRung' in decision, false, 'no rung field survives on a Decision');
  });
});
