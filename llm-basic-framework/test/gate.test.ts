import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { identityAnalyzer } from '../src/Normalization/analyzers/identity';
import { StringSimilarityGenerator } from '../src/Normalization/candidates/StringSimilarityGenerator';
import { maxLevDice } from '../src/Normalization/metrics/stringMetrics';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * **The behaviour-preservation gate (plan verification item 4).**
 *
 * `StringSimilarityGenerator(identity, max-lev-dice)` must reproduce the pre-M4
 * `ConceptRegistry.candidates()` output **exactly** on all 3,392 frozen pairs — similarity floats
 * included — against the fixture and golden lists captured in M2.5, before M3 changed the registry
 * format and before `candidates()` was removed.
 *
 * This is the test that makes the refactor safe. If it passes, the analyzer × metric decomposition
 * is behaviour-preserving and everything M4 builds on top is measuring the same thing the pipeline
 * measured before. If it fails, the delta is a bug in the decomposition, not an improvement.
 *
 * It runs the full query set rather than a sample: ~11M similarity comparisons, a few seconds. A
 * sampled gate would leave the tail unchecked, and the tail is where a normalization difference
 * would hide.
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/registry-v1.json');
const GOLDEN = path.resolve(__dirname, 'fixtures/golden-candidates.json');
const available = existsSync(FIXTURE) && existsSync(GOLDEN);

interface GoldenRow {
  category: string;
  name: string;
  candidates: Array<{ name: string; sim: number; aliases: string[] }>;
}

test(
  'GATE: StringSimilarityGenerator(identity, max-lev-dice) reproduces all 3,392 golden lists exactly',
  { skip: !available },
  async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      options: { k: number; minSim: number };
      results: GoldenRow[];
    };

    const registry = new ConceptRegistry({ filePath: FIXTURE });
    await registry.load();
    assert.equal(registry.loadedFromV1, true, 'the gate must score against the v1 reference');

    const generator = new StringSimilarityGenerator({
      analyzers: [identityAnalyzer],
      metric: maxLevDice,
    });
    await generator.prepare(registry.snapshot());

    const { k, minSim } = golden.options;
    let checked = 0;
    const mismatches: string[] = [];

    for (const row of golden.results) {
      const produced = await generator.candidates({
        mention: row.name,
        category: row.category,
        k,
        minSim,
      });

      // Lossless 1:1 shape mapping. The generator's Candidate carries `canonical`/`surfaces` plus a
      // `channel`; the golden recorded `candidates()`'s `name`/`aliases`. Same information.
      const asGolden = produced.map((candidate) => ({
        name: candidate.canonical,
        sim: candidate.sim,
        aliases: candidate.surfaces,
      }));

      try {
        assert.deepEqual(asGolden, row.candidates);
      } catch {
        if (mismatches.length < 5) {
          mismatches.push(
            `${row.category}/${row.name}\n    golden:   ${JSON.stringify(row.candidates)}\n    produced: ${JSON.stringify(asGolden)}`
          );
        }
      }
      checked++;
    }

    assert.equal(checked, 3392, 'every frozen pair must be checked, not a sample');
    assert.deepEqual(
      mismatches,
      [],
      `${mismatches.length}+ candidate lists differ:\n  ${mismatches.join('\n  ')}`
    );
  }
);

test(
  'GATE: every candidate channel is labelled, so E4 can score recall per channel',
  { skip: !available },
  async () => {
    const registry = new ConceptRegistry({ filePath: FIXTURE });
    await registry.load();
    const generator = new StringSimilarityGenerator();
    await generator.prepare(registry.snapshot());

    const produced = await generator.candidates({
      mention: 'UAC-0010',
      category: 'HackerGroup',
      k: 5,
      minSim: 0.5,
    });
    assert.ok(produced.length > 0);
    assert.ok(produced.every((candidate) => candidate.channel === 'string-sim'));
  }
);

test(
  'GATE: the generator refuses to run before prepare(), rather than returning nothing',
  { skip: !available },
  async () => {
    // Returning [] would look like "no candidates" and silently degrade every decision to a mint.
    const generator = new StringSimilarityGenerator();
    await assert.rejects(
      () => generator.candidates({ mention: 'x', category: 'C', k: 5, minSim: 0.5 }),
      /prepare\(\) must be called/
    );
  }
);
