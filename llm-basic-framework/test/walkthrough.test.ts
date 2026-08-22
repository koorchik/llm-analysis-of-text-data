import { DecisionLog } from '../src/DecisionLog/DecisionLog';
import type { EmbeddingsClient } from '../src/EmbeddingsClient/EmbeddingsClient';
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { GlossIndex } from '../src/Repair/GlossIndex';
import type { LlmClient } from '../src/LlmClient/LlmClient';
import { SchemaRegistry } from '../src/SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from '../src/DataProcessors/StreamingNormalizer';
import { StreamingRepairer } from '../src/DataProcessors/StreamingRepairer';
import { StringSimilarityGenerator } from '../src/Normalization/candidates/StringSimilarityGenerator';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { before, describe, it } from 'node:test';

/**
 * **The walkthrough micro-corpus (T14)** — the end-to-end verification that the migration to the
 * synchronous `StreamingRepairer` actually produces the story the presentation tells.
 *
 * The four documents, their verdicts and every expected state transition are transcribed from Part
 * II of `dissert/wiki/presentations/skein-data-structures-walkthrough.md` (READ-ONLY wiki):
 *
 * | Doc | Date       | Text                                                                          |
 * |-----|------------|-------------------------------------------------------------------------------|
 * | d1  | 2026-06-02 | "CERT-UA reports that Sandworm targeted an oblast energy operator using OpenSSH backdoors." |
 * | d2  | 2026-06-05 | "The Sandworm group (also tracked as UAC-0002) attacked energy-sector SCADA systems."       |
 * | d3  | 2026-06-09 | "APT28 conducted phishing against the same regional energy company."                        |
 * | d4  | 2026-06-12 | "Voodoo Bear deployed a new wiper against the oblast energy operator."                      |
 *
 * cold-start discovery (d1) · entity aliasing (d2) · a correct *don't-merge* (d3) · a justified-but-
 * wrong mint and its repair **inside the same document cycle** (d4). The load-bearing claim is that
 * last one: the duplicate `Voodoo Bear` lives for ZERO subsequent documents, so there is no fifth
 * document in this test and there must not be one.
 *
 * **What is real here**: `SchemaRegistry`, `ConceptRegistry`, `StreamingNormalizer` (phase 1),
 * `StreamingRepairer` (phase 2) with its real `SuspectGenerator` and a real `GlossIndex`, and a real
 * `StringSimilarityGenerator` blocker — the same instance shared between normalizer and repairer with
 * `onRegistryChange` forwarded, exactly as `bin/app.ts#createProcessors` wires it. Only the two
 * network boundaries are faked: the LLM (scripted per `docId` + operator) and the embeddings backend
 * (a deterministic vector table).
 *
 * **Deliberate simplifications**, none of which the walkthrough's assertions depend on:
 * - The extraction step is not run; `extractions/N.json` are written directly, which is also the only
 *   way to pin the exact mention set the narrative walks through.
 * - Schema categories are pre-admitted rather than admitted from each extraction's `schemaProposals`
 *   (the normalizer never reads proposals — the extractor does). This reproduces d1's real behaviour:
 *   "no near-matches in an empty schema → all 5 proposals admitted without a judge call."
 * - Pair rules are pre-admitted for graph-fold coverage; normalization does not discover them.
 * - `LadderDiscovery` is deliberately NOT injected (`StreamingNormalizer` skips the bootstrap when it
 *   is absent), so no ladder calls enter the budget either.
 */

// --- fixtures ------------------------------------------------------------------------------------

const EXTRACTIONS: Record<string, unknown> = {
  '1.json': {
    entities: [
      { name: 'Sandworm', category: 'HackerGroup', role: 'Attacker' },
      { name: 'oblast energy operator', category: 'Organization', role: 'Target' },
      { name: 'OpenSSH', category: 'Software', role: 'Attacker' },
    ],
    relations: [
      {
        head: 'Sandworm',
        headCategory: 'HackerGroup',
        type: 'targeted',
        tail: 'oblast energy operator',
        tailCategory: 'Organization',
      },
      {
        head: 'Sandworm',
        headCategory: 'HackerGroup',
        type: 'used-tool',
        tail: 'OpenSSH',
        tailCategory: 'Software',
      },
    ],
    schemaProposals: {
      categories: [
        { name: 'HackerGroup', definition: 'A named threat actor' },
        { name: 'Organization', definition: 'An organization' },
        { name: 'Software', definition: 'A software product' },
      ],
      relationTypes: [
        { name: 'targeted', definition: 'An actor targets someone' },
        { name: 'used-tool', definition: 'An actor uses a tool' },
      ],
    },
    metadata: { id: 1, date: '2026-06-02', title: 'CERT-UA report d1' },
  },
  '2.json': {
    entities: [
      { name: 'Sandworm group', category: 'HackerGroup', role: 'Attacker' },
      { name: 'UAC-0002', category: 'HackerGroup', role: 'Attacker' },
      { name: 'SCADA systems', category: 'IndustrialSystem', role: 'Target' },
    ],
    relations: [
      {
        head: 'Sandworm group',
        headCategory: 'HackerGroup',
        type: 'attacked',
        tail: 'SCADA systems',
        tailCategory: 'IndustrialSystem',
      },
    ],
    schemaProposals: {
      categories: [
        {
          name: 'IndustrialSystem',
          definition: 'Industrial control or operational-technology system',
        },
      ],
      relationTypes: [
        { name: 'attacked', definition: 'An actor conducts an attack against a target' },
      ],
    },
    metadata: { id: 2, date: '2026-06-05', title: 'CERT-UA report d2' },
  },
  '3.json': {
    entities: [
      { name: 'APT28', category: 'HackerGroup', role: 'Attacker' },
      { name: 'regional energy company', category: 'Organization', role: 'Target' },
    ],
    relations: [
      {
        head: 'APT28',
        headCategory: 'HackerGroup',
        type: 'conducted phishing against',
        tail: 'regional energy company',
        tailCategory: 'Organization',
      },
    ],
    schemaProposals: { categories: [], relationTypes: [] },
    metadata: { id: 3, date: '2026-06-09', title: 'CERT-UA report d3' },
  },
  '4.json': {
    entities: [
      { name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker' },
      { name: 'oblast energy operator', category: 'Organization', role: 'Target' },
    ],
    relations: [
      {
        head: 'Voodoo Bear',
        headCategory: 'HackerGroup',
        type: 'deployed wiper against',
        tail: 'oblast energy operator',
        tailCategory: 'Organization',
      },
    ],
    schemaProposals: { categories: [], relationTypes: [] },
    metadata: { id: 4, date: '2026-06-12', title: 'CERT-UA report d4' },
  },
};

const VOODOO_BEAR_GLOSS = 'Russian state-sponsored group targeting energy sector';
// Plausible stand-in, not transcribed from the wiki walkthrough (unlike the module comment's other
// fixtures above) — the wiki source does not give APT28 a gloss.
const APT28_GLOSS = 'Russian military intelligence group conducting phishing campaigns';

const linkVerdict = (over: Record<string, unknown>) => ({
  index: 1,
  mention: '',
  category: 'HackerGroup',
  mentionRung: 'g0',
  verdict: 'mint',
  target: null,
  parentCandidate: null,
  edgeKind: null,
  gloss: null,
  reasoning: 'test',
  ...over,
});

/**
 * Scripted LLM replies, keyed `${docId}:${operator}` — the walkthrough's own verdict tables.
 *
 * d1 is absent on purpose: an empty registry yields no candidates, mints bypass the judge entirely,
 * and the document therefore pays for NO call at all ("registry empty → no candidates anywhere → all
 * three entities minted"). d1's mints consequently carry no gloss, which is why `Sandworm` is indexed
 * by name alone below.
 */
const SCRIPT: Record<string, string> = {
  '2:link-judge': JSON.stringify({
    verdicts: [
      linkVerdict({ index: 1, mention: 'Sandworm group', verdict: 'link', target: 'Sandworm' }),
      linkVerdict({
        index: 2,
        mention: 'UAC-0002',
        verdict: 'link',
        target: 'Sandworm',
        reasoning: 'the Sandworm group (also tracked as UAC-0002)',
      }),
    ],
  }),
  '3:link-judge': JSON.stringify({
    verdicts: [
      linkVerdict({
        index: 1,
        mention: 'APT28',
        verdict: 'mint',
        gloss: APT28_GLOSS,
        reasoning: 'both being threat actors is not identity',
      }),
      linkVerdict({
        index: 2,
        mention: 'regional energy company',
        category: 'Organization',
        verdict: 'link',
        target: 'oblast energy operator',
        reasoning: '"the same regional energy company" refers back',
      }),
    ],
  }),
  '4:link-judge': JSON.stringify({
    verdicts: [
      linkVerdict({
        index: 1,
        mention: 'Voodoo Bear',
        verdict: 'mint',
        gloss: VOODOO_BEAR_GLOSS,
        reasoning: 'no evidence in this document links it to a known actor',
      }),
    ],
  }),
  '4:repair-judge': JSON.stringify({
    reviews: [
      {
        component: 1,
        ops: [
          {
            op: 'merge',
            from: 'Voodoo Bear',
            into: 'Sandworm',
            confidence: 'high',
            evidence: 'Both glosses describe a Russian state actor targeting the energy sector.',
          },
        ],
      },
    ],
  }),
};

// --- fakes ---------------------------------------------------------------------------------------

interface LlmCall {
  docId: number;
  operator: string;
}

/**
 * Routes on `(docId, operator)` rather than popping a replies array: the exact call ORDER across
 * four documents and two processors is an implementation detail this test should not pin, while
 * "which call was this" is exactly what the per-document budget assertion needs. An unscripted call
 * is recorded and throws — both failure postures (`#linkJudge` mints all, `#adjudicate` spills) would
 * otherwise swallow it into a silently different outcome.
 */
function scriptedLlm(script: Record<string, string>) {
  const calls: LlmCall[] = [];
  const unscripted: string[] = [];
  const client = {
    async send(
      _instructions: string,
      _message: string,
      options: { operator: string; docId: number }
    ) {
      const key = `${options.docId}:${options.operator}`;
      calls.push({ docId: options.docId, operator: options.operator });
      const text = script[key];
      if (text === undefined) {
        unscripted.push(key);
        throw new Error(`walkthrough: unscripted LLM call ${key}`);
      }
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, calls, unscripted };
}

const DIM = 16;
const unit = (index: number): number[] => {
  const vector = new Array<number>(DIM).fill(0);
  vector[index] = 1;
  return vector;
};

/**
 * Deterministic embeddings keyed on `GlossIndex#textFor`'s exact output — `` `${surface}: ${gloss}` ``,
 * or the bare surface when the gloss is null (the shared `EmbeddingGenerator` format).
 *
 * `Sandworm` is indexed by name ALONE because d1 minted it with no judge call and therefore no gloss;
 * `Voodoo Bear` carries d4's gloss. Placing those two ~0.95 apart and everything else orthogonal is
 * what makes d4's `gloss-ann` suspect fire deterministically at a 0.8 floor and nothing else fire at
 * all. Unlisted texts get their own basis vector on first sight (cosine 0 against everything,
 * including each other), so an unforeseen surface can never manufacture a suspect.
 */
function fakeEmbeddings() {
  const table = new Map<string, number[]>([
    ['Sandworm', unit(0)],
    ['Sandworm group', unit(0)],
    ['UAC-0002', unit(0)],
    // cos([1, 0.33, 0…], [1, 0, 0…]) ≈ 0.95 — above the 0.8 glossAnn floor, below 1 so it is
    // visibly a near-neighbour rather than a duplicate string.
    [`Voodoo Bear: ${VOODOO_BEAR_GLOSS}`, [1, 0.33, ...new Array<number>(DIM - 2).fill(0)]],
  ]);
  let nextFree = 2;
  const vectorFor = (text: string): number[] => {
    const known = table.get(text);
    if (known) return known;
    if (nextFree >= DIM) throw new Error(`walkthrough: fake embedding table exhausted at "${text}"`);
    const fresh = unit(nextFree++);
    table.set(text, fresh);
    return fresh;
  };
  const client = {
    async embed(input: string | string[]) {
      return Array.isArray(input) ? input.map(vectorFor) : vectorFor(input);
    },
  };
  return client as unknown as EmbeddingsClient;
}

// --- the run -------------------------------------------------------------------------------------

async function scratchDir(): Promise<string> {
  const key = crypto.createHash('sha256').update('walkthrough').digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `skein-walkthrough-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

interface Walkthrough {
  dir: string;
  conceptRegistry: ConceptRegistry;
  repairer: StreamingRepairer;
  llm: ReturnType<typeof scriptedLlm>;
  decisions: Array<Record<string, unknown>>;
  /** `Object.keys(records('HackerGroup'))` captured after each document's FULL cycle (both phases). */
  hackerGroupsAfter: string[][];
}

async function runWalkthrough(): Promise<Walkthrough> {
  const dir = await scratchDir();
  for (const [file, extraction] of Object.entries(EXTRACTIONS)) {
    await fs.writeFile(path.join(dir, 'extractions', file), JSON.stringify(extraction));
  }

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await conceptRegistry.load();

  // Stands in for the extractor's cold-start proposal admission (d1: "all 5 proposals admitted
  // without a judge call") — the normalizer resolves categories, it never reads `schemaProposals`.
  for (const name of ['HackerGroup', 'Organization', 'Software', 'IndustrialSystem']) {
    schemaRegistry.admitCategory({ name, definition: '', doc: 0 });
  }
  // Every (category, role) signature the four documents co-occur, pre-ruled — see the simplification
  // note in the file header. `relation: null` keeps the rule inert: it neither infers edges nor needs
  // a relation type admitted first.
  const signatures: Array<[string, string, string, string]> = [
    ['HackerGroup', 'Attacker', 'Organization', 'Target'],
    ['HackerGroup', 'Attacker', 'Software', 'Attacker'],
    ['Organization', 'Target', 'Software', 'Attacker'],
    ['HackerGroup', 'Attacker', 'HackerGroup', 'Attacker'],
    ['HackerGroup', 'Attacker', 'IndustrialSystem', 'Target'],
  ];
  for (const [sourceCategory, sourceRole, targetCategory, targetRole] of signatures) {
    schemaRegistry.admitPairRule(
      {
        source: { category: sourceCategory, role: sourceRole },
        target: { category: targetCategory, role: targetRole },
        relation: null,
      },
      0
    );
  }
  await schemaRegistry.save();
  await conceptRegistry.save();

  const llm = scriptedLlm(SCRIPT);
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const glossIndex = new GlossIndex({ embeddingsClient: fakeEmbeddings() });

  // ONE blocker instance, shared by both phases with `onRegistryChange` forwarded from the repairer —
  // `bin/app.ts#createProcessors`'s wiring, and the thing that keeps phase 1's index from going stale
  // after a repair merge.
  const blocker = new StringSimilarityGenerator();

  const repairer = new StreamingRepairer({
    artifactsDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    glossIndex,
    blocker,
    thresholds: {
      // The fake puts the Sandworm/Voodoo Bear pair at ~0.95 and every other pair at 0.
      glossAnn: new Map([['default', 0.8]]),
      // High enough that string-similarity noise ("Sandworm group" vs "Sandworm") cannot add a
      // second suspect to the component the walkthrough describes as a single gloss-ANN pair.
      blocker: new Map([['default', 0.99]]),
      // Disabled: cosine over this fake's non-negative vectors is never < -1. Alias-coherence drift
      // is not part of the walkthrough, and a fake vector table would decide it arbitrarily.
      coherence: -1,
    },
    onRegistryChange: (event) => blocker.onRegistryChange(event),
  });

  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    candidateGenerator: blocker,
    // The walkthrough judges candidates the default 0.5 floor would never retrieve — "UAC-0002 …
    // Sandworm 0.12 — kept via doc evidence" and "Voodoo Bear … Sandworm 0.15, APT28 0.13". Recall,
    // not precision, is the blocker's job here (`Normalization/types.ts`: minSim is deliberately
    // permissive because the judge sits downstream), so this micro-corpus shows the judge everything.
    candidateMinSim: 0,
    repairer,
  });

  const hackerGroupsAfter: string[][] = [];
  for (const file of Object.keys(EXTRACTIONS)) {
    await normalizer.processFile(file);
    hackerGroupsAfter.push(Object.keys(conceptRegistry.concepts('HackerGroup')));
  }

  const raw = await fs.readFile(path.join(dir, 'decisions.jsonl'), 'utf8');
  const decisions = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return { dir, conceptRegistry, repairer, llm, decisions, hackerGroupsAfter };
}

// --- assertions ----------------------------------------------------------------------------------

describe('SKEIN walkthrough micro-corpus d1–d4 (StreamingNormalizer + StreamingRepairer)', () => {
  let world: Walkthrough;

  before(async () => {
    world = await runWalkthrough();
  });

  it('never makes an unscripted LLM call', () => {
    assert.deepEqual(world.llm.unscripted, []);
  });

  it('d2: "Sandworm group" and "UAC-0002" link onto Sandworm instead of duplicating it', () => {
    const aliases = world.conceptRegistry.labelSurfaces('HackerGroup', 'Sandworm');
    assert.ok(aliases.includes('Sandworm group'), `aliases: ${aliases.join(', ')}`);
    assert.ok(aliases.includes('UAC-0002'), `aliases: ${aliases.join(', ')}`);

    const links = world.decisions.filter(
      (event) => event.docId === 2 && event.decision === 'link' && event.target === 'Sandworm'
    );
    assert.deepEqual(
      links.map((event) => event.mention).sort(),
      ['Sandworm group', 'UAC-0002'],
      'both actor mentions decided at d2, not merged later'
    );
    // "SCADA systems" is minted with no call: its category is empty, so there are no candidates.
    assert.equal(world.conceptRegistry.resolve('IndustrialSystem', 'SCADA systems'), 'SCADA systems');
  });

  it('d3: APT28 is minted as its own record and is never merged away (the don\'t-merge case)', () => {
    assert.deepEqual(world.hackerGroupsAfter[2].sort(), ['APT28', 'Sandworm']);
    assert.equal(world.conceptRegistry.resolve('HackerGroup', 'APT28'), 'APT28');
    // Still standing after d4's repair pass ran across all category registries.
    assert.equal(world.conceptRegistry.concepts('HackerGroup')['APT28'] !== undefined, true);
    assert.deepEqual(
      world.decisions.filter((event) => event.op === 'repair-merge' && event.from === 'APT28'),
      [],
      'APT28 was never a merge source'
    );
    // "the same regional energy company" refers back — a link, not a second organization.
    assert.equal(
      world.conceptRegistry.resolve('Organization', 'regional energy company'),
      'oblast energy operator'
    );
  });

  it("d4: the mint's gloss fires a gloss-ann suspect against Sandworm", () => {
    const suspects = world.decisions.filter((event) => event.op === 'suspect');
    assert.equal(suspects.length, 1, 'exactly one suspect pair over the whole corpus');
    assert.equal(suspects[0].doc, 4);
    assert.equal(suspects[0].signal, 'gloss-ann');
    assert.deepEqual((suspects[0].pair as string[]).slice().sort(), ['Sandworm', 'Voodoo Bear']);
  });

  it('d4: Voodoo Bear is merged into Sandworm inside the SAME document cycle', () => {
    assert.equal(world.hackerGroupsAfter.length, 4, 'four documents — the duplicate never outlives d4');

    const mint = world.decisions.find(
      (event) => event.docId === 4 && event.decision === 'mint' && event.mention === 'Voodoo Bear'
    );
    assert.ok(mint, 'd4 minted Voodoo Bear (the justified local error)');
    assert.equal(mint!.gloss, VOODOO_BEAR_GLOSS);

    const merge = world.decisions.find((event) => event.op === 'repair-merge');
    assert.ok(merge, 'repair-merge logged');
    assert.equal(merge!.doc, 4, 'same document as the mint — not a later catch-up pass');
    assert.equal(merge!.from, 'Voodoo Bear');
    assert.equal(merge!.into, 'Sandworm', 'first-seen canonical policy keeps d1\'s name as survivor');
    assert.equal(merge!.by, 'StreamingRepairer');

    assert.deepEqual(world.hackerGroupsAfter[3].sort(), ['APT28', 'Sandworm']);
  });

  it('d4: the registry keeps no Voodoo Bear record, only the alias on Sandworm', () => {
    assert.equal(
      world.conceptRegistry.concepts('HackerGroup')['Voodoo Bear'],
      undefined,
      'record absorbed'
    );
    assert.ok(
      world.conceptRegistry.labelSurfaces('HackerGroup', 'Sandworm').includes('Voodoo Bear'),
      'the alias survives the record'
    );
    assert.equal(world.conceptRegistry.resolve('HackerGroup', 'Voodoo Bear'), 'Sandworm');
  });

  it('d4: artifacts/4.json is deterministically re-stamped onto Sandworm', async () => {
    const artifact = JSON.parse(
      await fs.readFile(path.join(world.dir, 'artifacts', '4.json'), 'utf8')
    ) as {
      entities: Array<{ name: string; normalizedName?: string }>;
      relations: Array<{ head: string; normalizedHead?: string; normalizedTail?: string }>;
    };

    const voodoo = artifact.entities.find((entity) => entity.name === 'Voodoo Bear');
    assert.ok(voodoo, 'the extracted surface is preserved — only the stamp changes');
    assert.equal(voodoo!.normalizedName, 'Sandworm');

    const relation = artifact.relations.find((edge) => edge.head === 'Voodoo Bear');
    assert.ok(relation);
    assert.equal(relation!.normalizedHead, 'Sandworm');
    assert.equal(relation!.normalizedTail, 'oblast energy operator');
  });

  it('spends at most two first-attempt LLM calls per document (link ≤1 + repair ≤1)', () => {
    const firstAttempts = (docId: number) =>
      world.llm.calls.filter(
        (call) => call.docId === docId && !call.operator.endsWith('-retry')
      );

    for (const docId of [1, 2, 3, 4]) {
      assert.ok(
        firstAttempts(docId).length <= 2,
        `doc ${docId}: ${firstAttempts(docId).map((call) => call.operator).join(', ')}`
      );
    }
    // The exact budget the walkthrough claims: d1 pays nothing (empty registry, no candidates,
    // no suspects), d2/d3 pay one link-judge, d4 pays one link-judge plus one repair-judge.
    assert.deepEqual(
      [1, 2, 3, 4].map((docId) => firstAttempts(docId).map((call) => call.operator)),
      [[], ['link-judge'], ['link-judge'], ['link-judge', 'repair-judge']]
    );
    assert.equal(world.repairer.callsForDoc(4), 1, 'I2: one first-attempt repair call for d4');
  });

  it('leaves the repair boundary debt-free: nothing spilled, repairedThrough === 4', () => {
    const state = world.conceptRegistry.repairState();
    assert.deepEqual(state.spillover, [], 'no suspect was carried past its own document');
    assert.equal(state.repairedThrough, 4);
  });
});
