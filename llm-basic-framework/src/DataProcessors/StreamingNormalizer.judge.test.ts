import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

/**
 * The built-in SKEIN v2 link-judge (2026-08-04 redesign): three verdicts, rung assignment,
 * parent-edge structure on mint, defer as provisional mint + queue — all through the real
 * StreamingNormalizer with a canned LLM reply.
 */

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`judge${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `streaming-judge-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function cannedLlm(reply: string) {
  const prompts: string[] = [];
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      return {
        text: reply,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts };
}

/** Replays canned responses in call order; repeats the last one when calls exceed replies — the
 * gloss-retry tests need a first reply (the batch) and a second (the one-mention retry). */
function cannedLlmSequence(replies: string[]) {
  const prompts: string[] = [];
  let call = 0;
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      const text = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts, calls: () => call };
}

type RepairerStub = { processDoc: (file: string, docId: number) => Promise<void> };

async function setup(
  tag: string,
  reply: string,
  mention = 'UAC-0002',
  options: { repairer?: RepairerStub } = {}
) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [{ name: mention, category: 'HackerGroup', role: 'Attacker' }],
      relations: [],
      schemaProposals: [],
      metadata: { id: 1, title: 'test report', date: '2024-01-01' },
    })
  );

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  // A near-miss candidate so the judge is consulted (string-sim retrieves it).
  entityRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
  entityRegistry.setRung('HackerGroup', 'UAC-0002x', 'g1');
  await schemaRegistry.save();
  await entityRegistry.save();

  const llm = cannedLlm(reply);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    decisionLog,
    repairer: options.repairer,
  });
  return { dir, normalizer, llm, entityRegistry, decisionLog, schemaRegistry };
}

/**
 * Two mentions in one document, each with a near-miss candidate so the judge is consulted for
 * both — the fixture the gloss-retry tests need to prove a retry batch excludes the mention that
 * already had a valid gloss.
 */
async function setupGlossRetry(tag: string, replies: string[]) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [
        { name: 'UAC-0002', category: 'HackerGroup', role: 'Attacker' },
        { name: 'UAC-0099', category: 'HackerGroup', role: 'Attacker' },
      ],
      relations: [],
      schemaProposals: [],
      metadata: { id: 1, title: 'test report', date: '2024-01-01' },
    })
  );

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  entityRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
  entityRegistry.setRung('HackerGroup', 'UAC-0002x', 'g1');
  entityRegistry.mint('HackerGroup', 'UAC-0099x', { doc: 0, date: '2023-01-01' });
  entityRegistry.setRung('HackerGroup', 'UAC-0099x', 'g1');
  // Both mentions share a (category, role) signature — pre-register it as a known pair rule so
  // #pairRuleJudge doesn't fire a THIRD llm.send() and throw off the retry-count assertions below;
  // that judge is unrelated to gloss validation.
  schemaRegistry.admitPairRule(
    {
      source: { category: 'HackerGroup', role: 'Attacker' },
      target: { category: 'HackerGroup', role: 'Attacker' },
      relation: null,
    },
    0
  );
  await schemaRegistry.save();
  await entityRegistry.save();

  const llm = cannedLlmSequence(replies);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    decisionLog,
  });
  return { dir, normalizer, llm, entityRegistry, decisionLog };
}

async function readDecisions(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

const verdict = (extra: Record<string, unknown>) =>
  JSON.stringify({
    verdicts: [
      {
        index: 1,
        mention: 'UAC-0002',
        category: 'HackerGroup',
        mentionRung: 'g0',
        verdict: 'mint',
        target: null,
        parentCandidate: null,
        edgeKind: null,
        reasoning: 'test',
        ...extra,
      },
    ],
  });

describe('StreamingNormalizer built-in judge (SKEIN v2)', () => {
  it('renders the prompt with title, snippet and rung-labelled candidates', async () => {
    const { normalizer, llm } = await setup('prompt', verdict({}));
    await normalizer.processFile('1.json');
    const judgePrompt = llm.prompts.find((prompt) => prompt.includes('UNRESOLVED MENTIONS'));
    assert.ok(judgePrompt, 'link-judge prompt rendered');
    assert.ok(judgePrompt!.includes('"test report"'), 'docTitle placeholder filled');
    assert.ok(judgePrompt!.includes('UAC-0002x [g1]'), 'candidate labelled with its rung');
    assert.ok(!/\{\{\w+\}\}/.test(judgePrompt!), 'no unrendered placeholder');
  });

  it('mints at the judged rung', async () => {
    const { normalizer, entityRegistry } = await setup('rung', verdict({ mentionRung: 'g0' }));
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.rungOf('HackerGroup', 'UAC-0002'), 'g0');
  });

  it('a mint carrying a valid parentCandidate records a granularity edge with judge provenance', async () => {
    const { normalizer, entityRegistry } = await setup(
      'parent',
      verdict({ parentCandidate: 'UAC-0002x', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');

    const edges = entityRegistry.granularityEdges('HackerGroup');
    assert.equal(edges.length, 1, 'the hard-non-merge-plus-edge outcome');
    assert.equal(edges[0].from, 'UAC-0002');
    assert.equal(edges[0].to, 'UAC-0002x');
    assert.equal(edges[0].kind, 'part-of');
    assert.equal(edges[0].decision, 'judge');
    assert.equal(edges[0].evidence, 'test');
    // Still two distinct canonicals — the edge is a connection, never a merge.
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a parentCandidate not in the candidate list is dropped; the mint stands', async () => {
    const { normalizer, entityRegistry } = await setup(
      'badparent',
      verdict({ parentCandidate: 'Sandworm', edgeKind: 'part-of' })
    );
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.granularityEdges('HackerGroup').length, 0);
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002');
  });

  it('a link to an unlisted target is demoted to mint (strict candidate matching)', async () => {
    const { normalizer, entityRegistry } = await setup(
      'strict',
      verdict({ verdict: 'link', target: 'Sandworm' })
    );
    await normalizer.processFile('1.json');
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'minted, not linked');
  });

  it('defer mints provisionally, queues the pair, and logs a defer decision with a null target', async () => {
    const { normalizer, entityRegistry, dir } = await setup('defer', verdict({ verdict: 'defer' }));
    await normalizer.processFile('1.json');

    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'provisional mint');
    const queued = entityRegistry.deferred();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].mintedAs, 'UAC-0002');

    const log = (await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const deferEvent = log.find((event) => event.decision === 'defer');
    assert.ok(deferEvent, 'defer decision logged');
    assert.equal(deferEvent.target, null, 'protocol §5: a deferral is a withheld decision');
    assert.equal(deferEvent.mintedAs, 'UAC-0002', 'replayable provisional canonical');
  });

  it('stamps matchedVia beside normalizedName in the artifact', async () => {
    const { normalizer, dir } = await setup(
      'matchedvia',
      verdict({ verdict: 'link', target: 'UAC-0002x' })
    );
    await normalizer.processFile('1.json');
    const artifact = JSON.parse(
      await fs.readFile(path.join(dir, 'artifacts', '1.json'), 'utf8')
    );
    assert.equal(artifact.entities[0].normalizedName, 'UAC-0002x');
    assert.equal(artifact.entities[0].matchedVia, 'UAC-0002', 'the alias surface actually hit');
  });
});

describe('StreamingNormalizer gloss end-to-end (T5)', () => {
  it('a mint verdict with a valid gloss stores it on the registry record', async () => {
    const { normalizer, entityRegistry } = await setup(
      'gloss-mint',
      verdict({ gloss: 'Group linked to a wave of energy-sector intrusions' })
    );
    await normalizer.processFile('1.json');
    const entries = entityRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    assert.equal(uac2?.gloss, 'Group linked to a wave of energy-sector intrusions');
  });

  it("a link verdict's gloss is ignored — no gloss validation, no retry", async () => {
    const { normalizer, llm, entityRegistry, dir } = await setup(
      'gloss-link-ignored',
      verdict({ verdict: 'link', target: 'UAC-0002x', gloss: 'irrelevant text' })
    );
    await normalizer.processFile('1.json');
    assert.equal(llm.prompts.length, 1, 'no retry for a link verdict');
    const entries = entityRegistry.snapshot().entries('HackerGroup');
    const uac2x = entries.find((e) => e.canonical === 'UAC-0002x');
    assert.equal(uac2x?.gloss, null, 'link never writes a gloss');

    const log = await readDecisions(dir);
    assert.ok(!log.some((e) => e.op === 'gloss-flagged'));
  });

  it('a defer outcome carries its gloss into the provisional mint, like a mint verdict', async () => {
    const { normalizer, entityRegistry } = await setup(
      'gloss-defer',
      verdict({ verdict: 'defer', gloss: 'Suspected alias of a known group; evidence insufficient' })
    );
    await normalizer.processFile('1.json');
    const entries = entityRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    assert.equal(uac2?.gloss, 'Suspected alias of a known group; evidence insufficient');
  });

  const glossBatchReply = (uac2Gloss: unknown) =>
    JSON.stringify({
      verdicts: [
        {
          index: 1,
          mention: 'UAC-0002',
          category: 'HackerGroup',
          mentionRung: 'g0',
          verdict: 'mint',
          target: null,
          parentCandidate: null,
          edgeKind: null,
          gloss: uac2Gloss,
          reasoning: 'test',
        },
        {
          index: 2,
          mention: 'UAC-0099',
          category: 'HackerGroup',
          mentionRung: 'g0',
          verdict: 'mint',
          target: null,
          parentCandidate: null,
          edgeKind: null,
          gloss: 'Ransomware group targeting regional hospitals',
          reasoning: 'test',
        },
      ],
    });

  const retryReply = (uac2Gloss: unknown) =>
    JSON.stringify({
      verdicts: [
        {
          index: 1,
          mention: 'UAC-0002',
          category: 'HackerGroup',
          mentionRung: 'g0',
          verdict: 'mint',
          target: null,
          parentCandidate: null,
          edgeKind: null,
          gloss: uac2Gloss,
          reasoning: 'test',
        },
      ],
    });

  it('retries gloss validation once, asking only about the failing mention, and applies the corrected gloss', async () => {
    const { normalizer, llm, entityRegistry, dir } = await setupGlossRetry('retry-ok', [
      glossBatchReply('UAC-0002'), // restates the mention's own name — fails validation
      retryReply('Russian state-sponsored group targeting the energy sector'),
    ]);
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 2, 'exactly one retry call');
    // Quoted form only — UAC-0002's own near-miss candidate list legitimately mentions
    // "UAC-0099x" (unquoted), so a bare substring check would false-positive on that.
    assert.ok(
      !llm.prompts[1].includes('"UAC-0099"'),
      'retry batch excludes the mention that already passed'
    );
    assert.ok(llm.prompts[1].includes('"UAC-0002"'), 'retry batch includes the failing mention');

    const entries = entityRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    const uac99 = entries.find((e) => e.canonical === 'UAC-0099');
    assert.equal(uac2?.gloss, 'Russian state-sponsored group targeting the energy sector');
    assert.equal(uac99?.gloss, 'Ransomware group targeting regional hospitals');

    const log = await readDecisions(dir);
    assert.ok(!log.some((e) => e.op === 'gloss-flagged'), 'no flag once the retry succeeds');
    assert.ok(log.some((e) => e.op === 'llm-call' && e.kind === 'link-judge'));
    assert.ok(log.some((e) => e.op === 'llm-call' && e.kind === 'link-judge-retry'));
  });

  it('still-bad gloss after retry logs gloss-flagged and mints with no gloss (never loops)', async () => {
    const { normalizer, llm, entityRegistry, dir } = await setupGlossRetry('retry-bad', [
      glossBatchReply(null), // missing gloss — fails validation
      retryReply('UAC-0002'), // retry also restates the name — still bad
    ]);
    await normalizer.processFile('1.json');

    assert.equal(llm.prompts.length, 2, 'exactly one retry — never loops');

    const entries = entityRegistry.snapshot().entries('HackerGroup');
    const uac2 = entries.find((e) => e.canonical === 'UAC-0002');
    assert.equal(uac2?.gloss, null, 'mint proceeds without a gloss');
    assert.equal(entityRegistry.resolve('HackerGroup', 'UAC-0002'), 'UAC-0002', 'still minted');

    const log = await readDecisions(dir);
    const flagged = log.find((e) => e.op === 'gloss-flagged');
    assert.ok(flagged, 'gloss-flagged logged');
    assert.equal(flagged!.mention, 'UAC-0002');
    const retryCalls = log.filter((e) => e.op === 'llm-call' && e.kind === 'link-judge-retry');
    assert.equal(retryCalls.length, 1, 'the retry is logged, but only once');
  });
});

describe('StreamingNormalizer repairer hook (T5 phase-2)', () => {
  it('calls repairer.processDoc after the artifact is written, as the last step of processFile', async () => {
    let dirRef = '';
    const calls: Array<{ file: string; docId: number; artifactExisted: boolean }> = [];
    const repairer: RepairerStub = {
      async processDoc(file, docId) {
        const artifactPath = path.join(dirRef, 'artifacts', file);
        calls.push({ file, docId, artifactExisted: existsSync(artifactPath) });
      },
    };
    const { dir, normalizer } = await setup('repairer-normal', verdict({}), 'UAC-0002', { repairer });
    dirRef = dir;
    await normalizer.processFile('1.json');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '1.json');
    assert.equal(calls[0].docId, 1);
    assert.equal(calls[0].artifactExisted, true, 'artifact already on disk when the repairer ran');
  });

  it('invokes the repairer on the SKIP-exists branch when repair has not caught up to this doc', async () => {
    const { dir, normalizer, entityRegistry, decisionLog, llm, schemaRegistry } = await setup(
      'repairer-skip-behind',
      verdict({})
    );
    await normalizer.processFile('1.json'); // no repairer wired yet; just produces the artifact

    const calls: Array<{ file: string; docId: number }> = [];
    const repairer: RepairerStub = {
      async processDoc(file, docId) {
        calls.push({ file, docId });
      },
    };
    const normalizer2 = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: llm.client,
      schemaRegistry,
      entityRegistry,
      decisionLog,
      repairer,
    });

    const result = await normalizer2.processFile('1.json');
    assert.equal(result, true);
    assert.equal(calls.length, 1, 'repairer invoked on the skip-exists path (crash recovery)');
    assert.equal(calls[0].file, '1.json');
    assert.equal(calls[0].docId, 1);
  });

  it('does not invoke the repairer on the SKIP-exists branch once repair has caught up', async () => {
    const { dir, normalizer, entityRegistry, decisionLog, llm, schemaRegistry } = await setup(
      'repairer-skip-caughtup',
      verdict({})
    );
    await normalizer.processFile('1.json');
    entityRegistry.setRepairedThrough(1);
    await entityRegistry.save();

    const calls: number[] = [];
    const repairer: RepairerStub = {
      async processDoc() {
        calls.push(1);
      },
    };
    const normalizer2 = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient: llm.client,
      schemaRegistry,
      entityRegistry,
      decisionLog,
      repairer,
    });

    await normalizer2.processFile('1.json');
    assert.equal(calls.length, 0, 'repair already caught up to this doc');
  });
});
