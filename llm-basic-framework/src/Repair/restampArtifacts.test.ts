import { restampArtifacts } from './restampArtifacts';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

/**
 * `restampArtifacts` (T8) is `RegistryConsolidator#restampArtifacts` (RegistryConsolidator.ts:477-518,
 * pre-extraction) lifted verbatim into a shared module — deterministic re-stamp of artifacts through
 * the updated alias->canonical maps, no LLM. `RegistryConsolidator.test.ts` still exercises it
 * end-to-end through the consolidator; these tests call it directly plus pin the `files` restriction
 * that only the T9 repairer will exercise.
 */

let counter = 0;
async function scratchDir(): Promise<string> {
  const key = crypto.createHash('sha256').update(`restamp${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `restamp-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

async function registries(dir: string) {
  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await conceptRegistry.load();
  return { schemaRegistry, conceptRegistry };
}

function baseArtifact(entities: any[], relations: any[] = []) {
  return {
    entities,
    relations,
    schemaProposals: { categories: [], relationTypes: [] },
    metadata: { id: 1 },
  };
}

async function writeArtifact(dir: string, file: string, artifact: unknown) {
  await fs.writeFile(path.join(dir, 'artifacts', file), JSON.stringify(artifact, undefined, 2));
}

async function readArtifact(dir: string, file: string) {
  return JSON.parse(await fs.readFile(path.join(dir, 'artifacts', file), 'utf8'));
}

test('missing artifactsDir is a no-op', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);
  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'nope'),
    conceptRegistry,
    schemaRegistry,
  });
  assert.deepEqual(result, { changed: 0, total: 0 });
});

test('re-stamps entities via matchedVia first, falling back to entity.name', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 1 });
  await conceptRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    baseArtifact([
      // matchedVia present and different from name -> resolved via matchedVia.
      { name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear' },
      // no matchedVia -> resolved via name.
      { name: 'Sandworm', category: 'HackerGroup', role: 'Attacker' },
    ])
  );

  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'artifacts'),
    conceptRegistry,
    schemaRegistry,
  });

  assert.equal(result.total, 1);
  assert.equal(result.changed, 1);
  const artifact = await readArtifact(dir, '1.json');
  assert.equal(artifact.entities[0].normalizedName, 'Sandworm');
  assert.equal(artifact.entities[1].normalizedName, 'Sandworm');
});

test('re-stamps relation endpoints and corrects drifted categories via schemaRegistry', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  schemaRegistry.admitCategory({ name: 'HackerGroups', definition: '', doc: 1 });
  schemaRegistry.mergeEntries('category', 'HackerGroups', 'HackerGroup', -1);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.mint('HackerGroup', 'Ukraine Ministry', { doc: 1, date: '01.01.2024' });
  await conceptRegistry.save();
  await schemaRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    baseArtifact(
      [],
      [
        {
          head: 'Sandworm',
          headCategory: 'HackerGroups', // stale alias category, must resolve to HackerGroup
          type: 'targets',
          tail: 'Ukraine Ministry',
          tailCategory: 'HackerGroup',
        },
      ]
    )
  );

  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'artifacts'),
    conceptRegistry,
    schemaRegistry,
  });

  assert.equal(result.changed, 1);
  const artifact = await readArtifact(dir, '1.json');
  assert.equal(artifact.relations[0].headCategory, 'HackerGroup', 'category corrected');
  assert.equal(artifact.relations[0].normalizedHead, 'Sandworm');
  assert.equal(artifact.relations[0].normalizedTail, 'Ukraine Ministry');
});

test('changed-only writes: an artifact already at its correct stamp is left untouched', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  await conceptRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    baseArtifact([
      { name: 'Sandworm', category: 'HackerGroup', role: 'Attacker', normalizedName: 'Sandworm' },
    ])
  );
  const before = await fs.stat(path.join(dir, 'artifacts', '1.json'));

  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'artifacts'),
    conceptRegistry,
    schemaRegistry,
  });

  assert.equal(result.changed, 0);
  assert.equal(result.total, 1);
  const after = await fs.stat(path.join(dir, 'artifacts', '1.json'));
  assert.equal(after.mtimeMs, before.mtimeMs, 'untouched file was not rewritten');
});

test('files restriction: only the named files are read or written', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 1 });
  await conceptRegistry.save();

  const stale = baseArtifact([
    { name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear' },
  ]);
  await writeArtifact(dir, '1.json', stale);
  await writeArtifact(dir, '2.json', stale);
  const before2 = await fs.stat(path.join(dir, 'artifacts', '2.json'));

  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'artifacts'),
    conceptRegistry,
    schemaRegistry,
    files: ['1.json'],
  });

  assert.equal(result.total, 1, 'only the restricted file counted');
  assert.equal(result.changed, 1);

  const artifact1 = await readArtifact(dir, '1.json');
  assert.equal(artifact1.entities[0].normalizedName, 'Sandworm', 'restricted file was re-stamped');

  const after2 = await fs.stat(path.join(dir, 'artifacts', '2.json'));
  assert.equal(after2.mtimeMs, before2.mtimeMs, 'file outside the restriction was not touched');
  const artifact2 = await readArtifact(dir, '2.json');
  assert.equal(artifact2.entities[0].normalizedName, undefined, 'file outside the restriction was not re-stamped');
});

test('files restriction: a stale/missing entry is skipped with a warning, not thrown, and siblings still process', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 1 });
  await conceptRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    baseArtifact([
      { name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker', matchedVia: 'Voodoo Bear' },
    ])
  );
  // '999.json' is never written — simulates a stale entry in a T9-computed "affected" set.

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  let result: { changed: number; total: number };
  try {
    result = await restampArtifacts({
      artifactsDir: path.join(dir, 'artifacts'),
      conceptRegistry,
      schemaRegistry,
      files: ['1.json', '999.json'],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.total, 1, 'the missing file is not counted in total');
  assert.equal(result.changed, 1, 'the sibling file still processed and changed');
  assert.equal(warnings.length, 1, 'exactly one warning was emitted');
  assert.match(warnings[0], /999\.json/, 'the warning names the missing file');

  const artifact1 = await readArtifact(dir, '1.json');
  assert.equal(artifact1.entities[0].normalizedName, 'Sandworm', 'sibling was re-stamped despite the stale entry');
});

test('matchedVia-first: a split sends two mentions of the same canonical to different canonicals', async () => {
  const dir = await scratchDir();
  const { schemaRegistry, conceptRegistry } = await registries(dir);

  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 1 });
  conceptRegistry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  conceptRegistry.link('HackerGroup', 'Sandworm', 'Voodoo Bear', { docId: 2 });
  await conceptRegistry.save();

  await writeArtifact(
    dir,
    '1.json',
    baseArtifact([
      {
        name: 'Voodoo Bear', category: 'HackerGroup', role: 'Attacker',
        normalizedName: 'Sandworm', matchedVia: 'Voodoo Bear',
      },
      {
        name: 'Sandworm', category: 'HackerGroup', role: 'Attacker',
        normalizedName: 'Sandworm', matchedVia: 'Sandworm',
      },
    ])
  );

  // Split "Voodoo Bear" off Sandworm into its own canonical.
  const split = conceptRegistry.split('HackerGroup', 'Sandworm', ['Voodoo Bear']);
  assert.ok(split, 'split applied');
  await conceptRegistry.save();

  const result = await restampArtifacts({
    artifactsDir: path.join(dir, 'artifacts'),
    conceptRegistry,
    schemaRegistry,
  });

  assert.equal(result.changed, 1);
  const artifact = await readArtifact(dir, '1.json');
  assert.equal(artifact.entities[0].normalizedName, 'Voodoo Bear', 'moved by matchedVia');
  assert.equal(artifact.entities[1].normalizedName, 'Sandworm', 'stayed by matchedVia');
});
