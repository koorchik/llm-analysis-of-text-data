import { EntityRegistry } from '../src/EntityRegistry/EntityRegistry';
import { StringSimilarityGenerator } from '../src/Normalization/candidates/StringSimilarityGenerator';
import {
  buildFixtureRegistry,
  registryCanonicalSha256,
  serializeFixture,
  type RegistryDataV1,
} from '../src/Experiment/fixtureRegistry';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * M2.5 — guards on the behaviour-preservation fixture that M4's gate is scored against.
 *
 * These tests protect a reference that cannot be re-derived later: M3 replaces the registry format
 * and M4 deletes `EntityRegistry.candidates()`, so if the fixture or golden file drifts before then,
 * there is nothing to fall back on. Regenerate with `npm run capture-golden`; check with
 * `npm run capture-golden -- --verify`.
 */

const INPUT_DIR = path.resolve(__dirname, '../../storage/cert.gov.ua/processed/raw-unified/gpt-5');
const FIXTURE = path.resolve(__dirname, 'fixtures/registry-v1.json');
const GOLDEN = path.resolve(__dirname, 'fixtures/golden-candidates.json');

const corpusAvailable = existsSync(INPUT_DIR);
const fixtureAvailable = existsSync(FIXTURE);
const goldenAvailable = existsSync(GOLDEN);

const loadFixture = (): RegistryDataV1 => JSON.parse(readFileSync(FIXTURE, 'utf8'));

interface GoldenRow {
  category: string;
  name: string;
  candidates: Array<{ name: string; sim: number; aliases: string[] }>;
}

interface GoldenDocument extends Record<string, any> {
  results: GoldenRow[];
}

/**
 * One `JSON.parse`, no line splitting.
 *
 * The file was briefly JSONL with the metadata on line 0, which violated JSONL's only real
 * contract — every line the same shape — and forced this loader to hard-code `lines[0]`.
 */
const loadGolden = (): GoldenDocument => JSON.parse(readFileSync(GOLDEN, 'utf8'));

// --- the fixture ---------------------------------------------------------------------------------

test(
  'the fixture rebuilds from the frozen corpus and matches the committed copy',
  { skip: !corpusAvailable || !fixtureAvailable },
  async () => {
    // The plan's required M2.5 check. Compared by canonical hash and deep equality rather than raw
    // bytes: key order is not semantically meaningful to `candidates()` once the tie-break is
    // (-sim, canonicalName), and a formatter run over the committed JSON must not be able to fail
    // the gate. Order changes that DO matter still surface, because `firstSeen` is hashed content.
    const built = await buildFixtureRegistry(INPUT_DIR);
    const committed = loadFixture();

    assert.equal(
      registryCanonicalSha256(built.data),
      registryCanonicalSha256(committed),
      'fixture drift — rerun `npm run capture-golden` and review the diff before committing'
    );
    assert.deepEqual(built.data, committed);
  }
);

test(
  'the replay produces the documented inventory',
  { skip: !corpusAvailable },
  async () => {
    const { stats } = await buildFixtureRegistry(INPUT_DIR);
    assert.equal(stats.files, 204);
    assert.equal(stats.distinctPairs, 3392, 'the plan’s frozen-input figure');
    // 32 fewer canonicals than pairs: surfaces differing only by case or surrounding space collapse
    // under `resolve()`, which lowercases and trims.
    assert.equal(stats.canonicals, 3360);
    assert.equal(stats.categories, 10);
    // Every entity either mints or resolves, so the two must account for all of them exactly.
    assert.equal(stats.resolvedByFastPath, stats.entitiesSeen - stats.canonicals);
  }
);

test(
  'every fixture canonical is its own sole alias — proof no linking happened',
  { skip: !fixtureAvailable },
  () => {
    // The fixture is exact-resolve-then-mint with NO judge, so `link()` is never called. If this
    // fails, something introduced merges and the fixture is no longer the intended reference.
    const data = loadFixture();
    for (const [category, records] of Object.entries(data)) {
      for (const [canonical, record] of Object.entries(records)) {
        assert.deepEqual(
          record.aliases,
          [canonical],
          `${category}/${canonical} has aliases beyond itself`
        );
        assert.equal(typeof record.firstSeen.doc, 'number');
        assert.equal(typeof record.firstSeen.date, 'string');
      }
    }
  }
);

test('the committed fixture loads through EntityRegistry', { skip: !fixtureAvailable }, async () => {
  const registry = new EntityRegistry({ filePath: FIXTURE });
  await registry.load();
  assert.equal(registry.categories().length, 10);
  // A spot check that the alias index was built, so `resolve()` works case-insensitively.
  assert.ok(registry.resolve('HackerGroup', 'uac-0010'), 'case-folded resolve must hit');
});

test('serializeFixture is stable and newline-terminated', { skip: !fixtureAvailable }, () => {
  const data = loadFixture();
  const serialized = serializeFixture(data);
  assert.ok(serialized.endsWith('\n'));
  assert.deepEqual(JSON.parse(serialized), data, 'round-trips losslessly');
});

// --- the golden candidate lists ------------------------------------------------------------------

test('the golden file is a single valid JSON document with a homogeneous results array', { skip: !goldenAvailable }, () => {
  // It is deliberately NOT JSONL. JSONL's one contract is that every line has the same shape, and
  // metadata-plus-rows does not — a differently-shaped first line breaks
  // pandas.read_json(lines=True), DuckDB/BigQuery schema inference and `jq -s`. Metadata belongs at
  // a document root.
  const raw = readFileSync(GOLDEN, 'utf8');
  const doc = JSON.parse(raw); // one call — no line splitting, no discriminator
  assert.ok(Array.isArray(doc.results));

  // Every row has exactly the same key set: uniform, so it really is a table.
  const shape = (row: GoldenRow) => Object.keys(row).sort().join(',');
  const shapes = new Set(doc.results.map(shape));
  assert.equal(shapes.size, 1, `rows are not uniform: ${[...shapes].join(' | ')}`);
  assert.equal([...shapes][0], 'candidates,category,name');

  // Metadata keys must not leak into rows, nor vice versa.
  assert.equal('results' in doc.results[0], false);
  assert.equal('version' in doc.results[0], false);
});

test('each result occupies exactly one line, so a changed query is a one-line diff', { skip: !goldenAvailable }, () => {
  // The reason for the hand-rolled serializer: JSON.stringify(doc, null, 2) would spread every
  // candidate over ~7 lines (2.47 MB), and fully compact would put the file on one line.
  const lines = readFileSync(GOLDEN, 'utf8').split('\n');
  const rowLines = lines.filter((line) => line.startsWith('    {"category"'));
  assert.equal(rowLines.length, 3392, 'one line per result');
  assert.ok(lines.length < 3392 + 20, 'metadata adds only a handful of lines');
});

test('the golden metadata pins the options the pipeline actually uses', { skip: !goldenAvailable }, () => {
  const doc = loadGolden();
  const rows = doc.results;
  assert.equal(doc.version, 'golden-candidates-v2');
  // StreamingNormalizer's candidateK / candidateMinSim defaults. If these drift, the gate is
  // measuring a configuration the pipeline never runs.
  assert.equal(doc.options.k, 5);
  assert.equal(doc.options.minSim, 0.5);
  assert.equal(doc.queries, 3392);
  assert.equal(rows.length, 3392);
  assert.match(doc.tieBreak, /-sim/);
});

test(
  'the golden file is bound to the committed fixture by hash',
  { skip: !goldenAvailable || !fixtureAvailable },
  () => {
    // Without this, a regenerated fixture and a stale golden file could be compared against each
    // other and the M4 gate would silently score against a mismatched registry.
    const doc = loadGolden();
    assert.equal(doc.fixture.canonicalSha256, registryCanonicalSha256(loadFixture()));
    assert.equal(doc.fixture.canonicals, 3360);
  }
);

test('every golden row is ordered by (-sim, name)', { skip: !goldenAvailable }, () => {
  const rows = loadGolden().results;
  for (const row of rows) {
    for (let i = 1; i < row.candidates.length; i++) {
      const previous = row.candidates[i - 1];
      const current = row.candidates[i];
      assert.ok(
        current.sim < previous.sim || (current.sim === previous.sim && previous.name < current.name),
        `${row.category}/${row.name}: ${previous.name}(${previous.sim}) before ${current.name}(${current.sim})`
      );
    }
    assert.ok(row.candidates.length <= 5, 'k=5 must be respected');
  }
});

test('every query finds its own canonical at similarity 1', { skip: !goldenAvailable }, () => {
  // The query name case-folds to exactly one canonical, so similarity 1 is guaranteed. Note it is
  // NOT guaranteed to be FIRST — see the next test.
  const rows = loadGolden().results;
  for (const row of rows) {
    const self = row.candidates.find(
      (candidate) => candidate.name.trim().toLowerCase() === row.name.trim().toLowerCase()
    );
    assert.ok(self, `${row.category}/${row.name} did not retrieve itself`);
    assert.equal(self!.sim, 1);
  }
});

test('distinct surfaces can tie at similarity 1 — the tokenizer collapses punctuation', () => {
  const rows = goldenAvailable ? loadGolden().results : ([] as GoldenRow[]);
  if (rows.length === 0) return;

  const multipleAtOne = rows.filter(
    (row) => row.candidates.filter((candidate) => candidate.sim === 1).length > 1
  );

  // 73 queries retrieve more than one candidate at similarity 1. Cause: tokenSetDice splits on
  // [^\p{L}\p{N}]+, so `accounts-ukr.net`, `accounts--ukr.net` and `accounts---ukr.net` have
  // IDENTICAL token sets and score exactly 1.0 — while being three distinct hosts, plausibly
  // typosquats of one another. Recorded because any threshold-based merge arm will merge them
  // unconditionally, which for a CTI corpus may be exactly wrong.
  assert.equal(multipleAtOne.length, 73);
  assert.ok(
    rows.filter((row) => row.candidates[0]?.name.trim().toLowerCase() === row.name.trim().toLowerCase())
      .length === 3355,
    'own canonical is first for all but the 37 queries that tie with another surface at 1.0'
  );
});

test(
  'the golden lists are what an unrestricted top-k would have cut to',
  { skip: !goldenAvailable || !fixtureAvailable },
  async () => {
    // Sort-then-slice: slicing the full ordered list at k must equal asking for k directly. If these
    // ever disagree, a generator has grown an order-dependent early exit.
    //
    // The exact per-query comparison against the golden lists lives in test/gate.test.ts, which runs
    // all 3,392 pairs through StringSimilarityGenerator — the M4 replacement for the removed
    // EntityRegistry.candidates(). A sampled copy of it here would be redundant.
    const doc = loadGolden();
    const registry = new EntityRegistry({ filePath: FIXTURE });
    await registry.load();
    const generator = new StringSimilarityGenerator();
    await generator.prepare(registry.snapshot());

    for (const row of doc.results.filter((_: GoldenRow, index: number) => index % 400 === 0)) {
      const full = await generator.candidates({
        mention: row.name,
        category: row.category,
        k: Infinity,
        minSim: doc.options.minSim,
      });
      const capped = await generator.candidates({
        mention: row.name,
        category: row.category,
        k: doc.options.k,
        minSim: doc.options.minSim,
      });
      assert.deepEqual(full.slice(0, doc.options.k), capped, `${row.category}/${row.name}`);
    }
  }
);
