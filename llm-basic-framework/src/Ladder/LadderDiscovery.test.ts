import { LadderDiscovery, spreadSample, buildConsensus, validateRun } from './LadderDiscovery';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LadderProposal } from '../utils/validationUtils';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ladder-'));
}

/** A fake LlmClient that replays canned response texts in order (cycling). */
function fakeClient(responses: string[]): { client: LlmClient; calls: () => number } {
  let count = 0;
  const client = {
    send: async () => {
      const text = responses[Math.min(count, responses.length - 1)];
      count += 1;
      return {
        text,
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  } as unknown as LlmClient;
  return { client, calls: () => count };
}

const SOFTWARE_LADDER = JSON.stringify({
  category: 'Software',
  ladder: [
    { g: 0, alias: 'build', example: 'Microsoft Office 2010 SP2' },
    {
      g: 1,
      alias: 'product',
      move: 'drop-qualifier',
      example: 'Microsoft Office',
      preserving: true,
      foldTest:
        "'Office 2010 SP2 was exploited' -> 'Microsoft Office was exploited': same claim, less precise",
      disputed: false,
    },
    {
      g: 2,
      alias: 'vendor',
      move: 'grouped-by',
      example: 'microsoft:* (any Microsoft product)',
      preserving: true,
      foldTest:
        "'Microsoft Office was targeted' -> 'a Microsoft product was targeted': same claim, less precise",
      disputed: false,
    },
  ],
  rejected: [
    { candidate: 'Microsoft, the company', gate: '1', reason: 'Organization, not Software' },
  ],
  notes: 'clean',
});

const SOFTWARE_LADDER_WIDENING_G1 = JSON.stringify({
  category: 'Software',
  ladder: [
    { g: 0, alias: 'build', example: 'Microsoft Office 2010 SP2' },
    {
      g: 1,
      alias: 'product',
      move: 'part-of',
      example: 'Microsoft Office',
      preserving: false,
      foldTest:
        "'Office 2010 SP2 was exploited' -> 'Microsoft Office was exploited': a claim about a different thing",
      disputed: false,
    },
  ],
  rejected: [],
  notes: '',
});

async function harness(responses: string[], options: { minExamples?: number; n?: number } = {}) {
  const dir = await tmpDir();
  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  await schemaRegistry.load();
  schemaRegistry.admitCategory({ name: 'Software', definition: 'A named software product', doc: 1 });

  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await entityRegistry.load();

  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const { client, calls } = fakeClient(responses);
  const discovery = new LadderDiscovery({
    llmClient: client,
    schemaRegistry,
    entityRegistry,
    decisionLog,
    ensembleN: options.n ?? 3,
    minExamples: options.minExamples ?? 3,
  });
  return { discovery, schemaRegistry, entityRegistry, decisionLog, calls, dir };
}

function seedSurfaces(registry: EntityRegistry, names: string[]) {
  for (const [index, name] of names.entries()) {
    registry.mint('Software', name, { doc: index + 1, date: '01.01.2024' });
  }
}

test('does not fire below the example floor', async () => {
  const { discovery, entityRegistry, calls } = await harness([SOFTWARE_LADDER], { minExamples: 5 });
  seedSurfaces(entityRegistry, ['Office', 'Excel']);
  assert.equal(await discovery.maybeDiscover('Software', 10), undefined);
  assert.equal(calls(), 0);
});

test('caches a consensus ladder with code-derived edge kinds', async () => {
  const { discovery, schemaRegistry, entityRegistry, calls } = await harness([
    SOFTWARE_LADDER,
    SOFTWARE_LADDER,
    SOFTWARE_LADDER,
  ]);
  seedSurfaces(entityRegistry, ['Office 2010 SP2', 'Microsoft Office', 'Exchange']);

  const ladder = await discovery.maybeDiscover('Software', 10);
  assert.ok(ladder);
  assert.equal(calls(), 3, 'ensemble ran N times');
  assert.equal(ladder.version, 1);
  assert.equal(ladder.rungs.length, 3);
  assert.equal(ladder.rungs[1].edgeKind, 'coarsens-to', 'derived from preserving, not asked');
  assert.equal(ladder.rungs[1].disputed, false, 'unanimous ensemble leaves disputed off');
  assert.equal(schemaRegistry.getLadder('Software')?.version, 1, 'cached in Σ');
  assert.ok(
    schemaRegistry.getHistory().some((entry) => entry.op === 'discover-ladder'),
    'history records the discovery'
  );
});

test('non-unanimous preserving forces disputed with a disagreement note', async () => {
  const { discovery, entityRegistry } = await harness([
    SOFTWARE_LADDER,
    SOFTWARE_LADDER_WIDENING_G1,
    SOFTWARE_LADDER,
  ]);
  seedSurfaces(entityRegistry, ['Office 2010 SP2', 'Microsoft Office', 'Exchange']);

  const ladder = await discovery.maybeDiscover('Software', 10);
  assert.ok(ladder);
  const g1 = ladder.rungs.find((rung) => rung.g === 1)!;
  assert.equal(g1.disputed, true, 'ensemble disagreement forces disputed');
  assert.ok(ladder.disagreements.some((note) => note.includes('preserving')));
  const g2 = ladder.rungs.find((rung) => rung.g === 2)!;
  assert.equal(g2.disputed, true, 'rung omitted by one run is disputed too');
});

test('a ladder that fails hard validation in every run is not cached, and is not retried', async () => {
  const invalid = JSON.stringify({
    category: 'Software',
    ladder: [
      { g: 0, alias: 'build', example: 'Office 2010' },
      {
        g: 1,
        alias: 'agency',
        example: 'GRU',
        preserving: false,
        foldTest: "'x' -> 'y': a claim about a different thing",
        disputed: false,
      },
      {
        g: 2,
        alias: 'blur',
        example: 'Office',
        preserving: true,
        foldTest: "'x' -> 'y': same claim, less precise",
        disputed: false,
      },
    ],
    rejected: [],
    notes: 'blur above widening — must be rejected',
  });
  const { discovery, schemaRegistry, entityRegistry, calls } = await harness([invalid]);
  seedSurfaces(entityRegistry, ['Office 2010 SP2', 'Microsoft Office', 'Exchange']);

  assert.equal(await discovery.maybeDiscover('Software', 10), undefined);
  assert.equal(schemaRegistry.getLadder('Software'), undefined);
  const callsAfterFirst = calls();
  await discovery.maybeDiscover('Software', 11);
  assert.equal(calls(), callsAfterFirst, 'failed discovery is not re-fired every document');
});

test('depth-1 ladders are success, and re-fire happens at 2× example growth', async () => {
  const depth1 = JSON.stringify({
    category: 'Software',
    ladder: [{ g: 0, alias: 'identifier', example: 'CVE-2024-1234' }],
    rejected: [],
    notes: 'designator category',
  });
  const { discovery, schemaRegistry, entityRegistry } = await harness([depth1], { n: 1 });
  seedSurfaces(entityRegistry, ['CVE-2024-1234', 'CVE-2023-44487', 'CVE-2021-44228']);

  const first = await discovery.maybeDiscover('Software', 10);
  assert.equal(first?.rungs.length, 1, 'depth-1 accepted, never padded');
  assert.equal(first?.version, 1);

  // Growth below 2× returns the cache; at ≥2× a new version fires.
  seedSurfaces(entityRegistry, ['CVE-2020-0001', 'CVE-2020-0002']);
  assert.equal((await discovery.maybeDiscover('Software', 11))?.version, 1);
  seedSurfaces(entityRegistry, ['CVE-2020-0003']);
  const refired = await discovery.maybeDiscover('Software', 12);
  assert.equal(refired?.version, 2, 're-fired at 2× surface growth');
  assert.equal(schemaRegistry.getLadder('Software')?.version, 2);
});

// --- validator unit tests -------------------------------------------------------------------------

function proposal(partial: Partial<LadderProposal>): LadderProposal {
  return { category: 'Software', ladder: [], rejected: [], notes: '', ...partial };
}

test('validateRun: foldTest contradicting preserving is a hard violation', () => {
  const violations = validateRun(
    'Software',
    proposal({
      ladder: [
        { g: 0, alias: 'a', move: '', example: 'X 1.0', foldTest: '', disputed: false },
        {
          g: 1,
          alias: 'b',
          move: '',
          example: 'X',
          preserving: true,
          foldTest: "'s' -> 't': a claim about a different thing",
          disputed: false,
        },
      ],
    })
  );
  assert.ok(violations.some((v) => v.rule === 'foldtest-contradicts-preserving' && v.hard));
});

test('validateRun: missing preserving falls back to widening + disputed (soft)', () => {
  const input = proposal({
    ladder: [
      { g: 0, alias: 'a', move: '', example: 'X 1.0', foldTest: '', disputed: false },
      { g: 1, alias: 'b', move: '', example: 'X', foldTest: '', disputed: false },
    ],
  });
  const violations = validateRun('Software', input);
  assert.ok(violations.every((v) => !v.hard));
  assert.equal(input.ladder[1].preserving, false, 'safe default is widening');
  assert.equal(input.ladder[1].disputed, true);
});

test('validateRun: star group and part-of rung to the same anchor violates gate 3', () => {
  const violations = validateRun(
    'Software',
    proposal({
      ladder: [
        { g: 0, alias: 'a', move: '', example: 'GRU Unit 74455', foldTest: '', disputed: false },
        {
          g: 1,
          alias: 'star',
          move: 'grouped-by',
          example: 'gru:*',
          preserving: true,
          foldTest: "'s' -> 't': same claim, less precise",
          disputed: false,
        },
        {
          g: 2,
          alias: 'agency',
          move: 'part-of',
          example: 'GRU',
          preserving: false,
          foldTest: "'s' -> 't': a claim about a different thing",
          disputed: false,
        },
      ],
    })
  );
  assert.ok(violations.some((v) => v.rule === 'star-and-partof-same-anchor' && v.hard));
});

test('validateRun: the category itself is dropped as a rung, softly', () => {
  const input = proposal({
    ladder: [
      { g: 0, alias: 'a', move: '', example: 'certifiedauth.in', foldTest: '', disputed: false },
      {
        g: 1,
        alias: 'category',
        move: '',
        example: 'Software',
        preserving: true,
        foldTest: "'s' -> 't': same claim, less precise",
        disputed: false,
      },
    ],
  });
  const violations = validateRun('Software', input);
  assert.ok(violations.some((v) => v.rule === 'category-as-rung' && !v.hard));
  assert.equal(input.ladder.length, 1);
});

test('buildConsensus keeps g0 bare and stamps edgeKind per non-g0 rung', () => {
  const parsed = JSON.parse(SOFTWARE_LADDER) as LadderProposal;
  const widened = JSON.parse(SOFTWARE_LADDER_WIDENING_G1) as LadderProposal;
  const { ladder, disagreements } = buildConsensus([widened, parsed]);
  assert.equal(ladder[0].edgeKind, undefined, 'g0 carries no edge');
  assert.equal(ladder[1].edgeKind, 'part-of', 'base run widening → part-of');
  assert.equal(ladder[1].disputed, true);
  assert.ok(disagreements.length > 0);
});

test('spreadSample returns everything when the pool fits the window', () => {
  assert.deepEqual(spreadSample([1, 2, 3], 5), [1, 2, 3]);
});

test('spreadSample spreads across the pool instead of taking the front', () => {
  const pool = Array.from({ length: 100 }, (_, index) => index);
  const sample = spreadSample(pool, 10);
  assert.equal(sample.length, 10);
  assert.equal(sample[0], 0);
  // The tail of the pool is represented — head-N sampling stops at 9 and can never place an entity
  // minted later in the stream.
  assert.ok(sample[sample.length - 1] >= 90);
  assert.deepEqual(sample, [...new Set(sample)], 'no duplicates');
});

test('spreadSample is deterministic, because the sample is part of what the runId describes', () => {
  const pool = Array.from({ length: 37 }, (_, index) => `s${index}`);
  assert.deepEqual(spreadSample(pool, 12), spreadSample(pool, 12));
});
