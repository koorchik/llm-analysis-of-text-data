#!/usr/bin/env ts-node
/**
 * M2.5 — capture the behaviour-preservation fixture and golden candidate lists.
 *
 *   npm run capture-golden            # write test/fixtures/{registry-v1.json,golden-candidates.json}
 *   npm run capture-golden -- --verify   # recompute and compare; writes nothing, exits 1 on drift
 *
 * WHY THIS EXISTS, AND WHY NOW
 *
 * M4 deletes `ConceptRegistry.candidates()` and replaces it with `StringSimilarityGenerator`. The
 * only way to know that swap preserved behaviour is to compare against a reference captured
 * beforehand — and the reference can only be captured while the v1 registry format and the original
 * `candidates()` both still exist. M3 replaces the format, so this must land before M3. Captured
 * afterwards, the reference would have to be produced through the very v1→v2 migrator it is
 * supposed to police, and the gate would prove nothing.
 *
 * WHAT THE GOLDEN FILE ENCODES
 *
 * The **tie-break-fixed** behaviour, not today's raw output. `bestMatches` previously sorted on
 * similarity alone, leaving equal-similarity candidates in registry insertion order; that is fixed
 * to `(-sim, canonicalName)` in the same migration, deliberately *before* capture, so the reference
 * does not enshrine the bug. Diagnostics below quantify how much that changes.
 */
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { identityAnalyzer } from '../src/Normalization/analyzers/identity';
import { StringSimilarityGenerator } from '../src/Normalization/candidates/StringSimilarityGenerator';
import { maxLevDice } from '../src/Normalization/metrics/stringMetrics';
import {
  buildFixtureRegistry,
  registryCanonicalSha256,
  serializeFixture,
  type RegistryDataV1,
} from '../src/Experiment/fixtureRegistry';
import { hashInputDir } from '../src/Experiment/inputHash';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_INPUT = '../storage/cert.gov.ua/processed/raw-unified/gpt-5';
const DEFAULT_OUT_DIR = 'test/fixtures';

/** The values `StreamingNormalizer` actually passes (`candidateK` / `candidateMinSim` defaults). */
const PIPELINE_K = 5;
const PIPELINE_MIN_SIM = 0.5;

/**
 * v2 is a JSON **document**, not JSONL. v1 was JSONL with the metadata as line 0 — which broke the
 * one contract JSONL has: **every line is the same shape**. Consumers rely on that
 * (`pandas.read_json(lines=True)`, DuckDB/BigQuery schema inference, `jq -s 'map(.category)'`); a
 * differently-shaped first line yields a phantom all-null row or a bogus union schema. Adding a
 * `type` discriminator was considered and rejected: it hardens the parse but keeps the
 * heterogeneity, and metadata plus a uniform table is precisely what a JSON document is for.
 *
 * Metadata therefore lives at the document root and the rows live in `results`. Serialization is
 * hand-rolled so each row occupies exactly one line: that keeps per-record diffs (a changed row is
 * a one-line diff) and the compact size, without the format lie.
 */
const GOLDEN_VERSION = 'golden-candidates-v2';

interface CandidateRow {
  name: string;
  sim: number;
  aliases: string[];
}

interface GoldenResult {
  category: string;
  name: string;
  candidates: CandidateRow[];
}

/**
 * Document-level metadata, deliberately **path-free**: the corpus is identified by its content hash
 * and the fixture by its canonical hash, both of which are semantic. Recording file paths would make
 * the golden file non-portable — verifying a copy from another directory would fail on the metadata
 * alone, which is a false positive that hides real drift. (Found by testing the verifier.)
 */
interface GoldenMeta {
  version: typeof GOLDEN_VERSION;
  generatedBy: string;
  note: string;
  input: { contentHash: string; files: number };
  fixture: { canonicalSha256: string; canonicals: number; categories: number };
  options: { k: number; minSim: number };
  tieBreak: string;
  queries: number;
}

/**
 * Serialize as valid JSON with **one result per line**.
 *
 * `JSON.stringify(doc, null, 2)` would indent every candidate object across ~7 lines, giving a
 * 2.47 MB file whose diffs span whole blocks; fully compact would give one 1.28 MB line with no
 * usable diff at all. Emitting the metadata pretty and each row on its own line gets both: 1.28 MB,
 * a one-line diff per changed query, and `JSON.parse` in a single call.
 *
 * Deterministic by construction — key order comes from the object literals, and no sorting or
 * locale-dependent formatting is involved.
 */
function serializeGolden(meta: GoldenMeta, results: GoldenResult[]): string {
  const metaLines = Object.entries(meta).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`
  );
  const rows = results.map((row) => `    ${JSON.stringify(row)}`);
  const resultsBlock = rows.length === 0 ? '  "results": []' : `  "results": [\n${rows.join(',\n')}\n  ]`;
  return `{\n${metaLines.join(',\n')},\n${resultsBlock}\n}\n`;
}

/** Code-unit comparison — never `localeCompare`, which is ICU- and locale-dependent. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Compute the full scored candidate list per query, then derive both orderings from it.
 *
 * One scoring pass, two orderings: `candidates()` sorts then slices, so slicing the full
 * new-ordered list at k is exactly `candidates(k)`. The old ordering is reconstructed by re-sorting
 * the same scored set on `(-sim, haystackIndex)`, where the haystack index is the canonical's
 * position in `Object.keys(records)` — which is what a stable sort on similarity alone fell back to.
 */
async function analyseQuery(
  generator: StringSimilarityGenerator,
  haystackIndex: Map<string, Map<string, number>>,
  query: { category: string; name: string },
  k: number,
  minSim: number
) {
  // Since M4 the reference is produced by the generator rather than the removed
  // ConceptRegistry.candidates(). The gate proves the two are byte-identical on every frozen pair, so
  // the artifact this script writes is unchanged.
  const full = (
    await generator.candidates({ mention: query.name, category: query.category, k: Infinity, minSim })
  ).map((candidate) => ({
    name: candidate.canonical,
    sim: candidate.sim,
    aliases: candidate.surfaces,
  }));

  const newTop = full.slice(0, k);

  const indexes = haystackIndex.get(query.category)!;
  const oldOrder = [...full].sort((a, b) => {
    if (a.sim !== b.sim) return b.sim - a.sim;
    return (indexes.get(a.name) ?? 0) - (indexes.get(b.name) ?? 0);
  });
  const oldTop = oldOrder.slice(0, k);

  const sameTop =
    newTop.length === oldTop.length &&
    newTop.every((candidate, index) => candidate.name === oldTop[index].name);

  // The cut is decided by the tie-break alone when the candidate at the boundary ties with the
  // first one excluded — i.e. which candidates the judge sees is arbitrary up to the tie order.
  const cutIsTieDecided = full.length > k && full[k - 1].sim === full[k].sim;

  const tiedAtTop = full.filter((candidate) => candidate.sim === full[0]?.sim).length;

  return { full, newTop, sameTop, cutIsTieDecided, tiedAtTop };
}

async function main() {
  const verify = process.argv.includes('--verify');
  const inputDir = arg('input') ?? DEFAULT_INPUT;
  const outDir = arg('out-dir') ?? DEFAULT_OUT_DIR;
  const k = Number(arg('k') ?? PIPELINE_K);
  const minSim = Number(arg('min-sim') ?? PIPELINE_MIN_SIM);

  const fixturePath = path.join(outDir, 'registry-v1.json');
  const goldenPath = path.join(outDir, 'golden-candidates.json');

  console.log(`input:    ${inputDir}`);
  console.log(`fixture:  ${fixturePath}`);
  console.log(`golden:   ${goldenPath}`);
  console.log(`options:  k=${k} minSim=${minSim}${verify ? '  [VERIFY — writes nothing]' : ''}`);
  console.log();

  // --- 1. rebuild the fixture from the frozen corpus ---
  const built = await buildFixtureRegistry(inputDir);
  const rebuiltSerialized = serializeFixture(built.data);
  const rebuiltHash = registryCanonicalSha256(built.data);
  console.log('replay:', JSON.stringify(built.stats));
  console.log('fixture canonical sha256:', rebuiltHash);

  let failures = 0;

  if (verify) {
    if (!existsSync(fixturePath)) {
      console.error(`VERIFY FAILED: ${fixturePath} is missing — run without --verify to create it`);
      process.exit(1);
    }
    const committed = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as RegistryDataV1;
    const committedHash = registryCanonicalSha256(committed);
    if (committedHash !== rebuiltHash) {
      console.error(`VERIFY FAILED: fixture drift — committed ${committedHash}, rebuilt ${rebuiltHash}`);
      failures++;
    } else {
      console.log('OK: fixture matches the committed copy (canonical hash)');
    }
  } else {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(fixturePath, rebuiltSerialized);
    console.log(`wrote ${fixturePath} (${rebuiltSerialized.length} bytes)`);
  }

  // --- 2. score every query against the COMMITTED fixture ---
  // Loading from disk rather than reusing the in-memory build proves the committed artifact is
  // loadable and is what the golden file is actually defined against.
  const registry = new ConceptRegistry({ filePath: fixturePath });
  await registry.load();

  const generator = new StringSimilarityGenerator({
    analyzers: [identityAnalyzer],
    metric: maxLevDice,
  });
  await generator.prepare(registry.snapshot());

  // Haystack order is `Object.keys(records)` — i.e. mint order — which is what a stable sort on
  // similarity alone fell back to before the M2.5 tie-break fix. Needed to reconstruct that old
  // ordering for the impact diagnostics.
  const haystackIndex = new Map<string, Map<string, number>>();
  for (const category of registry.conceptSchemes()) {
    haystackIndex.set(
      category,
      new Map(Object.keys(registry.concepts(category)).map((name, index) => [name, index]))
    );
  }

  // Deterministic query order, independent of directory iteration.
  const queries = [...built.pairs].sort(
    (a, b) => byCodeUnit(a.category, b.category) || byCodeUnit(a.name, b.name)
  );

  const results: GoldenResult[] = [];
  let tieBreakChangedTop = 0;
  let tieDecidedCuts = 0;
  let queriesWithCandidates = 0;
  let totalCandidatesAboveMinSim = 0;
  let maxCandidates = 0;
  const changedByCategory = new Map<string, number>();
  const tieDecidedByCategory = new Map<string, number>();
  const queriesByCategory = new Map<string, number>();

  const started = Date.now();
  for (const [index, query] of queries.entries()) {
    const analysis = await analyseQuery(generator, haystackIndex, query, k, minSim);

    results.push({ category: query.category, name: query.name, candidates: analysis.newTop });

    queriesByCategory.set(query.category, (queriesByCategory.get(query.category) ?? 0) + 1);
    if (analysis.full.length > 0) queriesWithCandidates++;
    totalCandidatesAboveMinSim += analysis.full.length;
    maxCandidates = Math.max(maxCandidates, analysis.full.length);

    if (!analysis.sameTop) {
      tieBreakChangedTop++;
      changedByCategory.set(query.category, (changedByCategory.get(query.category) ?? 0) + 1);
    }
    if (analysis.cutIsTieDecided) {
      tieDecidedCuts++;
      tieDecidedByCategory.set(query.category, (tieDecidedByCategory.get(query.category) ?? 0) + 1);
    }

    if ((index + 1) % 500 === 0) {
      console.log(`  scored ${index + 1}/${queries.length} (${Date.now() - started}ms)`);
    }
  }
  console.log(`scored ${queries.length} queries in ${Date.now() - started}ms`);

  const meta: GoldenMeta = {
    version: GOLDEN_VERSION,
    generatedBy: 'bin/capture-golden.ts',
    note:
      'Reference output of ConceptRegistry.candidates() with the (-sim, canonicalName) tie-break, ' +
      'captured before the M3 registry-v2 format change. M4 must reproduce this exactly.',
    input: {
      contentHash: (await hashInputDir(inputDir)).contentHash,
      files: built.stats.files,
    },
    fixture: {
      canonicalSha256: rebuiltHash,
      canonicals: built.stats.canonicals,
      categories: built.stats.categories,
    },
    options: { k, minSim },
    tieBreak: '(-sim, canonicalName), UTF-16 code-unit order',
    queries: queries.length,
  };

  const serialized = serializeGolden(meta, results);

  if (verify) {
    if (!existsSync(goldenPath)) {
      console.error(`VERIFY FAILED: ${goldenPath} is missing`);
      process.exit(1);
    }
    const committed = await fs.readFile(goldenPath, 'utf8');
    if (committed === serialized) {
      console.log(`OK: golden matches the committed copy (${results.length} queries)`);
    } else {
      // Line-level diff so a mismatch is diagnosable rather than just "files differ".
      const committedLines = committed.split('\n');
      const rebuiltLines = serialized.split('\n');
      const differing: number[] = [];
      for (let i = 0; i < Math.max(committedLines.length, rebuiltLines.length); i++) {
        if (committedLines[i] !== rebuiltLines[i]) differing.push(i);
      }
      console.error(`VERIFY FAILED: golden drift on ${differing.length} line(s)`);
      for (const line of differing.slice(0, 5)) {
        console.error(`  line ${line}:`);
        console.error(`    committed: ${(committedLines[line] ?? '<missing>').slice(0, 200)}`);
        console.error(`    rebuilt:   ${(rebuiltLines[line] ?? '<missing>').slice(0, 200)}`);
      }
      failures++;
    }
  } else {
    await fs.writeFile(goldenPath, serialized);
    console.log(`wrote ${goldenPath} (${serialized.length} bytes)`);
  }

  // --- 3. diagnostics: how much determinism was actually at stake? ---
  console.log();
  console.log('--- tie-break impact -------------------------------------------------');
  console.log(`queries with >=1 candidate:        ${queriesWithCandidates}/${queries.length}`);
  console.log(`mean candidates above minSim:      ${(totalCandidatesAboveMinSim / queries.length).toFixed(1)}`);
  console.log(`max candidates for one query:      ${maxCandidates}`);
  console.log(
    `top-${k} CHANGED by the fix:           ${tieBreakChangedTop} (${((100 * tieBreakChangedTop) / queries.length).toFixed(1)}% of queries)`
  );
  console.log(
    `top-${k} cut decided by tie order:     ${tieDecidedCuts} (${((100 * tieDecidedCuts) / queries.length).toFixed(1)}% of queries)`
  );
  console.log();
  console.log('per category (queries | top-k changed | cut tie-decided):');
  for (const category of [...queriesByCategory.keys()].sort(byCodeUnit)) {
    console.log(
      `  ${category.padEnd(18)} ${String(queriesByCategory.get(category)).padStart(5)} | ` +
        `${String(changedByCategory.get(category) ?? 0).padStart(5)} | ` +
        `${String(tieDecidedByCategory.get(category) ?? 0).padStart(5)}`
    );
  }

  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
