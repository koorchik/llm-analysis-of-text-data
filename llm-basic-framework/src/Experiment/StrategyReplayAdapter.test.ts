import { createOfflineStrategy } from '../Normalization/decision';
import { StrategyReplayAdapter } from './StrategyReplayAdapter';
import { IdentityReplayStrategy, parseDecisionEvents, replayEvents } from './replayLog';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const LOG = [
  '{"op":"llm-call","doc":1,"kind":"link-judge","seconds":1.2,"model":"gpt-5"}',
  '{"op":"decision","docId":1,"mention":"APT28","category":"HackerGroup","candidates":[{"name":"APT28","sim":1,"channel":"string-sim","surfaces":["APT28","Fancy Bear"]}],"decision":"link","target":"APT28","confidence":null}',
  '{"op":"decision","docId":1,"mention":"UAC-0010","category":"HackerGroup","candidates":[{"name":"UAC-0018","sim":0.875,"channel":"string-sim","surfaces":["UAC-0018"]},{"name":"UAC-0010 (Armageddon)","sim":0.8,"channel":"string-sim","surfaces":["UAC-0010 (Armageddon)","Armageddon"]}],"decision":"link","target":"UAC-0010 (Armageddon)","confidence":null}',
  '{"op":"decision","docId":2,"mention":"atera","category":"Organization","candidates":[{"name":"Atera Networks","sim":0.7,"channel":"string-sim","surfaces":["Atera Networks"]}],"decision":"mint","target":"atera","confidence":null}',
].join('\n');

const events = () => parseDecisionEvents(LOG);

describe('StrategyReplayAdapter', () => {
  it('ignores llm-call rows and replays only decision points', () => {
    assert.equal(events().length, 3);
  });

  it('preserves the mention, category, docId and candidate list of every point', async () => {
    const original = events();
    const replayed = await replayEvents(
      original,
      new StrategyReplayAdapter(createOfflineStrategy('exact-only'))
    );
    assert.equal(replayed.length, original.length);
    replayed.forEach((event, index) => {
      assert.equal(event.mention, original[index].mention);
      assert.equal(event.category, original[index].category);
      assert.equal(event.docId, original[index].docId);
      assert.deepEqual(event.candidates, original[index].candidates);
    });
  });

  it('stamps the strategy id, so a replayed log is distinguishable from the original', async () => {
    const replayed = await replayEvents(
      events(),
      new StrategyReplayAdapter(createOfflineStrategy('threshold'))
    );
    assert.ok(replayed.every((event) => event.strategy === 'threshold'));
  });

  it('identity replay reproduces the log exactly — verification item 7', async () => {
    const original = events();
    const replayed = await replayEvents(original, new IdentityReplayStrategy(original));
    replayed.forEach((event, index) => {
      assert.equal(event.decision, original[index].decision);
      assert.equal(event.target, original[index].target);
    });
  });

  it('passes the logged alias surfaces through, so alias evidence survives the replay', async () => {
    // "Armageddon" is only an alias of UAC-0010 (Armageddon). An exact-match arm can only find it
    // if the surfaces reached the strategy.
    const point = {
      docId: 1,
      mention: 'Armageddon',
      category: 'HackerGroup',
      candidates: [
        {
          name: 'UAC-0010 (Armageddon)',
          sim: 0.4,
          channel: 'string-sim',
          surfaces: ['UAC-0010 (Armageddon)', 'Armageddon'],
        },
      ],
    };
    const adapter = new StrategyReplayAdapter(createOfflineStrategy('exact-only'));
    const verdict = await adapter.decide(point);
    assert.equal(verdict.decision, 'link');
    assert.equal(verdict.target, 'UAC-0010 (Armageddon)');
    assert.equal(adapter.missingSurfaces, 0);
  });

  it('counts candidates with no logged surfaces instead of treating them as alias-free', async () => {
    const adapter = new StrategyReplayAdapter(createOfflineStrategy('exact-only'));
    await adapter.decide({
      docId: 1,
      mention: 'Armageddon',
      category: 'HackerGroup',
      candidates: [{ name: 'UAC-0010 (Armageddon)', sim: 0.4, channel: 'string-sim' }],
    });
    // A pre-M6 log: the alias is not there to be found, and the count is what makes that visible.
    assert.equal(adapter.missingSurfaces, 1);
  });

  it('the threshold arm links UAC-0018 while Fellegi–Sunter does not', async () => {
    // The headline contrast between the two non-LLM poles, on the corpus case that motivates it.
    const threshold = await replayEvents(
      events(),
      new StrategyReplayAdapter(createOfflineStrategy('threshold', { threshold: 0.85 }))
    );
    const fellegiSunter = await replayEvents(
      events(),
      new StrategyReplayAdapter(createOfflineStrategy('fellegi-sunter'))
    );

    const uacThreshold = threshold.find((event) => event.mention === 'UAC-0010')!;
    const uacFs = fellegiSunter.find((event) => event.mention === 'UAC-0010')!;

    assert.equal(uacThreshold.target, 'UAC-0018');
    assert.notEqual(uacFs.target, 'UAC-0018');
  });

  it('createOfflineStrategy honours its options rather than silently using defaults', () => {
    const strict = createOfflineStrategy('threshold', { threshold: 0.95 });
    assert.equal(strict.config.threshold, 0.95);
    const fs = createOfflineStrategy('fellegi-sunter', { noDefer: true });
    assert.equal(fs.config.noDefer, true);
  });
});
