#!/usr/bin/env ts-node
/**
 * The gold-table workflow (E0). Four stages, in order:
 *
 *   npm run gold -- inventory --source <extractions> --out inventory.json
 *   npm run gold -- pairs     --inventory inventory.json --out worksheet.json
 *   npm run gold -- build     --inventory inventory.json --pairs worksheet.json --out gold.json
 *   npm run gold -- validate  gold.json
 *
 * What is mechanical and what is not: `inventory`, transitive closure, singleton expansion, the
 * dev/test split and the NIL labels are all derived, because doing them by hand is where a gold
 * table quietly goes wrong. `pairs` *proposes* candidates for strata (a)/(b) only — you adjudicate
 * them, and strata (c)/(d) come from authorities and expert judgment (see docs/GOLD-TABLE.md).
 *
 * Nothing here calls an LLM. Run it as often as you like.
 */
import { hashInputDir } from '../src/Experiment/inputHash';
import { loadGoldTable, selectSplit, goldSummary } from '../src/Evaluation/gold';
import {
  addSingletons,
  assignSplit,
  buildGoldTable,
  closeIntoClusters,
  type AdjudicatedPair,
} from '../src/Gold/buildTable';
import { buildInventory, inventorySummary, type Inventory } from '../src/Gold/inventory';
import { preLabel, preLabelSummary, PRE_LABEL_RULES } from '../src/Gold/preLabel';
import { proposePairs, proposalSummary } from '../src/Gold/proposePairs';
import { fromTsv, toTsv } from '../src/Gold/worksheet';
import fs from 'fs/promises';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function num(name: string, fallback: number): number {
  const value = arg(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${value}"`);
  return parsed;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(data, undefined, 2)}\n`);
  console.log(`wrote ${path}`);
}

const USAGE = `usage:
  gold inventory --source <extractionsDir> [--out inventory.json] [--order numeric-id]
  gold pairs     --inventory <file> [--out worksheet.json] [--min-sim 0.7]
                 [--skip-categories Domain] [--max-per-category 0]
  gold build     --inventory <file> --pairs <adjudicated.tsv|.json> [--out gold.json] [--dev-fraction 0.2]
  gold validate  <gold.json> [--inventory <file>]
  gold rules     — explain every pre-labelling rule before you bulk-accept it`;

async function main() {
  const command = process.argv[2];

  if (command === 'inventory') {
    const source = arg('source');
    if (!source) throw new Error(USAGE);
    // The hash is what ties the table to a corpus; a gold table without it cannot be trusted to
    // describe the input a run actually saw.
    const { contentHash } = await hashInputDir(source);
    const inventory = await buildInventory({
      sourceDir: source,
      inputContentHash: contentHash,
      order: arg('order') ?? 'numeric-id',
    });

    console.log(`source:      ${source}`);
    console.log(`contentHash: ${contentHash}`);
    console.log(`surfaces:    ${inventory.entries.length}`);
    for (const row of inventorySummary(inventory)) {
      console.log(`  ${row.category.padEnd(18)} ${row.surfaces}`);
    }
    await writeJson(arg('out') ?? 'inventory.json', inventory);
    return;
  }

  if (command === 'pairs') {
    const inventoryPath = arg('inventory');
    if (!inventoryPath) throw new Error(USAGE);
    const inventory = await readJson<Inventory>(inventoryPath);

    const skip = (arg('skip-categories') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const proposals = proposePairs(inventory, {
      minSim: num('min-sim', 0.7),
      skipCategories: skip,
      maxPerCategory: num('max-per-category', 0),
    });

    const labelled = preLabel(proposals);

    console.log(`proposals:   ${labelled.length} pairs`);
    if (skip.length > 0) console.log(`skipped:     ${skip.join(', ')}`);
    console.log('\nby category:');
    for (const row of proposalSummary(proposals).slice(0, 15)) {
      console.log(`  ${row.category.padEnd(18)} ${row.stratum}  ${row.mechanism.padEnd(16)} ${row.pairs}`);
    }

    console.log('\nsilver pre-labels (suggestions, not verdicts — `gold rules` explains each):');
    for (const row of preLabelSummary(labelled)) {
      console.log(`  ${row.rule.padEnd(20)} -> ${row.suggested.padEnd(10)} ${row.pairs}`);
    }
    const needsReview = labelled.filter((pair) => pair.suggested === 'review').length;
    console.log(`\n${labelled.length - needsReview} pre-labelled, ${needsReview} need your judgment.`);

    const out = arg('out') ?? 'worksheet.tsv';
    if (out.endsWith('.tsv')) {
      await fs.writeFile(out, toTsv(labelled));
      console.log(`wrote ${out}`);
      console.log('Open it in a spreadsheet, correct the `label` column, then run `gold build`.');
    } else {
      await writeJson(out, labelled);
    }

    console.log(
      '\nStrata (c) semantic-known and (d) semantic-novel are NOT proposed here — no string\n' +
        'mechanism can find a zero-overlap alias. Add those rows yourself; see docs/GOLD-TABLE.md.'
    );
    return;
  }

  if (command === 'build') {
    const inventoryPath = arg('inventory');
    const pairsPath = arg('pairs');
    if (!inventoryPath || !pairsPath) throw new Error(USAGE);

    const inventory = await readJson<Inventory>(inventoryPath);

    let allPairs: AdjudicatedPair[];
    let unlabelledCount: number;
    let total: number;
    if (pairsPath.endsWith('.tsv')) {
      const parsed = fromTsv(await fs.readFile(pairsPath, 'utf8'));
      allPairs = parsed.pairs;
      unlabelledCount = parsed.unlabelled;
      total = parsed.pairs.length + parsed.unlabelled;
      console.log(`adjudicated: ${parsed.pairs.length}/${total} pairs`);
      console.log(`corrections: ${parsed.corrected} rows where you overrode the silver suggestion`);
    } else {
      const raw = await readJson<AdjudicatedPair[]>(pairsPath);
      allPairs = raw.filter((pair) => pair.label === 'same' || pair.label === 'different');
      unlabelledCount = raw.length - allPairs.length;
      total = raw.length;
    }

    if (unlabelledCount > 0) {
      // Loud, not fatal: a partially adjudicated worksheet is a normal mid-annotation state, but an
      // unlabelled pair silently counted as `different` would understate recall.
      console.warn(
        `WARNING: ${unlabelledCount}/${total} pairs are unlabelled and were treated as ` +
          '"not merged". Finish adjudication before reporting anything from this table.'
      );
    }

    const { clusters: merged, conflicts } = closeIntoClusters(allPairs, inventory);
    if (conflicts.length > 0) {
      // A contradiction in the annotation itself: a-b and b-c are `same`, so a-c is too, whatever
      // the annotator said about a-c. Reported rather than silently resolved.
      console.error(`\nTRANSITIVITY CONFLICTS: ${conflicts.length} pair(s) marked "different" but`);
      console.error('linked through a chain of "same" verdicts. Resolve these before reporting:');
      for (const conflict of conflicts.slice(0, 10)) {
        console.error(`  ${conflict.category}: "${conflict.left}" vs "${conflict.right}"`);
      }
      if (conflicts.length > 10) console.error(`  … and ${conflicts.length - 10} more`);
    }

    const withSingletons = addSingletons(merged, inventory);
    const split = assignSplit(withSingletons, num('dev-fraction', 0.2));
    const table = buildGoldTable({ clusters: split, inventory });

    const multi = table.clusters.filter((cluster) => cluster.members.length > 1);
    console.log(`\nclusters:    ${table.clusters.length} (${multi.length} with >1 member)`);
    console.log(`singletons:  ${table.clusters.length - multi.length} — these are the gold mints`);
    console.log(`nilLabels:   ${table.nilLabels.length} (derived, not hand-written)`);
    console.log(`dev/test:    ${table.clusters.filter((c) => c.split === 'dev').length} / ${table.clusters.filter((c) => c.split === 'test').length}`);
    await writeJson(arg('out') ?? 'gold.json', table);
    return;
  }

  if (command === 'validate') {
    const path = process.argv[3];
    if (!path || path.startsWith('--')) throw new Error(USAGE);

    const table = await loadGoldTable(path); // throws with a specific reason on any schema problem
    console.log(`VALID: ${path}`);
    console.log(`  version:     ${table.version}`);
    console.log(`  corpus:      ${table.inputContentHash}`);
    console.log(`  order:       ${table.order}`);
    console.log(`  ${JSON.stringify(goldSummary(table))}`);

    for (const split of ['dev', 'test'] as const) {
      const slice = selectSplit(table, split);
      const multi = slice.clusters.filter((cluster) => cluster.members.length > 1).length;
      console.log(`  ${split}: ${slice.clusters.length} clusters, ${multi} mergeable`);
      if (multi === 0) {
        console.warn(`  WARNING: the ${split} split has no multi-member cluster — merge P/R will be empty`);
      }
    }

    // The strata exist to be reported separately; an empty (d) means the paper's second claim is
    // unmeasurable, which is worth saying at validation time rather than discovering in analysis.
    const strata = new Map<string, number>();
    for (const cluster of table.clusters) {
      if (cluster.members.length > 1) strata.set(cluster.stratum, (strata.get(cluster.stratum) ?? 0) + 1);
    }
    console.log(`  mergeable clusters by stratum: ${JSON.stringify(Object.fromEntries([...strata].sort()))}`);
    if (!strata.has('d')) {
      console.warn(
        '  WARNING: no stratum-(d) cluster. Without the novel tail, "the model is not reciting\n' +
          '  its training data" is unmeasurable and the result is refutable in one sentence.'
      );
    }

    const inventoryPath = arg('inventory');
    if (inventoryPath) {
      const inventory = await readJson<Inventory>(inventoryPath);
      if (inventory.inputContentHash !== table.inputContentHash) {
        console.error(
          `  MISMATCH: gold annotates ${table.inputContentHash} but the inventory is ` +
            `${inventory.inputContentHash} — these describe different corpora`
        );
        process.exit(1);
      }
      const covered = new Set<string>();
      for (const cluster of table.clusters) {
        for (const member of cluster.members) {
          covered.add(`${cluster.category.toLowerCase()}|${member.trim().toLowerCase()}`);
        }
      }
      const missing = inventory.entries.filter(
        (entry) => !covered.has(`${entry.category.toLowerCase()}|${entry.surface.trim().toLowerCase()}`)
      );
      console.log(`  coverage: ${inventory.entries.length - missing.length}/${inventory.entries.length} surfaces`);
      if (missing.length > 0) {
        // An uncovered surface is not scored at all, so it silently shrinks the evaluation.
        console.warn(`  WARNING: ${missing.length} surfaces are in no gold cluster, e.g.:`);
        for (const entry of missing.slice(0, 5)) console.warn(`    ${entry.category}: "${entry.surface}"`);
      }
    }
    return;
  }

  if (command === 'rules') {
    console.log('Silver pre-labelling rules, applied in this order (first match wins).\n');
    for (const rule of PRE_LABEL_RULES) {
      console.log(`${rule.id}  ->  ${rule.suggest}`);
      console.log(`  ${rule.rationale}\n`);
    }
    console.log('Anything no rule claims gets "review" — most stratum-(a) pairs genuinely need you.');
    return;
  }

  console.error(USAGE);
  process.exit(2);
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
