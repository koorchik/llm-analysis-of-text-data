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
import { createEmbeddingsClient } from '../src/EmbeddingsClient/createEmbeddingsClient';
import { hashInputDir } from '../src/Experiment/inputHash';
import { loadGoldTable, selectSplit, goldSummary } from '../src/Evaluation/gold';
import {
  addSingletons,
  assignSplit,
  buildGoldTable,
  closeIntoClusters,
  registryOnlyJudgmentStrata,
  type AdjudicatedPair,
} from '../src/Gold/buildTable';
import { cosineHistogram, embeddingPairs, type EmbeddingProposal } from '../src/Gold/embeddingPairs';
import { loadCorpus, snippetsFor } from '../src/Gold/evidence';
import {
  buildInventory,
  crossCategorySurfaces,
  inventorySummary,
  type Inventory,
} from '../src/Gold/inventory';
import {
  preLabel,
  preLabelSummary,
  PRE_LABEL_RULES,
  PROVENANCE_RULES,
  type WorksheetPair,
} from '../src/Gold/preLabel';
import { proposePairs, proposalSummary } from '../src/Gold/proposePairs';
import {
  loadRegistry,
  registryPairs,
  registryPairsSummary,
  unionProposals,
} from '../src/Gold/registryPairs';
import { fromTsv, toTsv } from '../src/Gold/worksheet';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** A boolean flag: present or not, takes no value. */
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
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
                 [--registry <entities-unified/<model>/entities.json>]
                 [--embeddings] [--emb-k 10] [--emb-min-cos 0.6] [--emb-xscript-min-cos 0.4]
                 [--emb-cache gold/embeddings-cache]
                 [--docs <fetchedDir>]  — fill the snippet column with document evidence
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

    // A second proposer, off by default. It reaches strata (c)/(d), which no string mechanism can —
    // and it over-merges, so every one of its rows arrives as `review`. See src/Gold/registryPairs.ts.
    const registryPath = arg('registry');
    let registryProposals: ReturnType<typeof registryPairs>['pairs'] = [];

    // A third proposer, also off by default: dense-embedding neighbours — the one channel
    // independent of both string mechanics and the systems under test. See src/Gold/embeddingPairs.ts.
    let embeddingProposals: EmbeddingProposal[] = [];
    const embProvider = process.env.EMBEDDINGS_PROVIDER || 'openai';
    const embModel = process.env.EMBEDDINGS_MODEL || 'text-embedding-3-large';
    const embK = num('emb-k', 10);
    const embMinCos = num('emb-min-cos', 0.6);
    const embXscriptMinCos = num('emb-xscript-min-cos', 0.4);

    if (has('embeddings')) {
      const client = createEmbeddingsClient({
        provider: embProvider,
        model: embModel,
        cacheDir: arg('emb-cache') ?? 'gold/embeddings-cache',
      });
      const result = await embeddingPairs(inventory, client, {
        k: embK,
        minCos: embMinCos,
        crossScriptMinCos: embXscriptMinCos,
        skipCategories: skip,
        minSim: num('min-sim', 0.7),
      });
      embeddingProposals = result.pairs;

      console.log(
        `embeddings:  ${embProvider}/${embModel}, k=${embK}, minCos=${embMinCos}, ` +
          `xscriptMinCos=${embXscriptMinCos}`
      );
      console.log(
        `             ${result.stats.surfaces} surfaces, ${result.stats.comparisons} comparisons, ` +
          `${result.stats.proposed} proposals`
      );
      console.log('             candidate-cosine histogram (tune --emb-min-cos from this):');
      for (const row of cosineHistogram(result.cosines)) {
        if (row.count > 0) console.log(`               ${row.bucket}  ${row.count}`);
      }
    }

    if (registryPath) {
      const registry = await loadRegistry(registryPath);
      const fromRegistry = registryPairs(registry, inventory, {
        minSim: num('min-sim', 0.7),
        skipCategories: skip,
      });
      registryProposals = fromRegistry.pairs;

      console.log(`registry:    ${registryPath}`);
      console.log(`             ${fromRegistry.pairs.length} pairs proposed`);
      if (fromRegistry.droppedKeys.length > 0) {
        // Registry/raw-unified drift. Silent here would mean pairs naming surfaces the corpus
        // never contained, which `gold build` discards without a word.
        console.warn(
          `             ${fromRegistry.droppedKeys.length} registry keys are not inventory surfaces ` +
            'under the same category and were dropped, e.g.:'
        );
        for (const key of fromRegistry.droppedKeys.slice(0, 5)) {
          console.warn(`               ${key.category}: "${key.surface}"`);
        }
      }
      console.log('\nwhat the registry merged (reporting only — never a label):');
      for (const row of registryPairsSummary(fromRegistry.pairs).slice(0, 10)) {
        console.log(`  ${row.category.padEnd(18)} ${row.relation.padEnd(14)} ${row.pairs}`);
      }
      console.log(
        '  part-of and sibling are hierarchy, not coreference — a host is not the domain it sits\n' +
          '  under, and a version is not its product. Those are `different`; see docs/GOLD-TABLE.md §5.'
      );
    }

    const worksheetPairs: WorksheetPair[] = unionProposals(proposals, registryProposals, embeddingProposals);
    const labelled = preLabel(worksheetPairs);

    // Document-evidence snippets, when the fetched corpus is at hand. These feed both the LLM
    // annotators and the human reviewer — same passage for everyone.
    const docsDir = arg('docs');
    let snippetMisses = 0;
    if (docsDir) {
      const corpus = await loadCorpus(docsDir);
      const docIdsOf = new Map(
        inventory.entries.map((entry) => [
          `${entry.category.toLowerCase()}|${entry.surface.trim().toLowerCase()}`,
          entry.docIds,
        ])
      );
      const snippetOf = new Map<string, string>();
      const lookup = (category: string, surface: string): string => {
        const key = `${category.toLowerCase()}|${surface.trim().toLowerCase()}`;
        if (!snippetOf.has(key)) {
          const found = snippetsFor(surface, docIdsOf.get(key) ?? [], corpus, { maxDocs: 1 });
          snippetOf.set(key, found[0] ?? '');
        }
        return snippetOf.get(key)!;
      };
      for (const row of labelled as Array<(typeof labelled)[number] & { snippet?: string }>) {
        const left = lookup(row.category, row.left);
        const right = lookup(row.category, row.right);
        if (left === '') snippetMisses++;
        if (right === '') snippetMisses++;
        row.snippet = left === '' && right === '' ? '' : `left: ${left || '—'} ‖ right: ${right || '—'}`;
      }
      console.log(
        `\nsnippets:    from ${docsDir} — ${snippetMisses} pair sides have no literal occurrence ` +
          '(extraction normalized the spelling); those lean on the annotators\' unsure discipline'
      );
    }

    // The deck's "upstream category noise" threat, made visible: a surface filed under two
    // categories is invisible to every within-category pair below. Reported, not repaired —
    // repair belongs to the consolidator's cross-category sweep.
    const crossCategory = crossCategorySurfaces(inventory);
    if (crossCategory.length > 0) {
      console.log(`\ncross-category surfaces: ${crossCategory.length} appear under >1 category, e.g.:`);
      for (const row of crossCategory.slice(0, 5)) {
        console.log(`  "${row.surface}"  ${row.categories.join(' / ')}`);
      }
      console.log('  (within-category pairs cannot connect these — see the GOLD-TABLE amendment)');
    }

    console.log(`\nproposals:   ${labelled.length} pairs`);
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

    // Composition by source — the threat-to-validity table reads straight off this.
    const bySource = new Map<string, number>();
    for (const row of labelled) bySource.set(row.source ?? 'string', (bySource.get(row.source ?? 'string') ?? 0) + 1);
    console.log('\nby source:');
    for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source.padEnd(26)} ${count}`);
    }

    const out = arg('out') ?? 'worksheet.tsv';
    if (out.endsWith('.tsv')) {
      await fs.writeFile(out, toTsv(labelled));
      console.log(`wrote ${out}`);
      console.log('Open it in a spreadsheet, correct the `label` column, then run `gold build`.');
    } else {
      await writeJson(out, labelled);
    }

    // A sidecar recording how this worksheet was proposed — the paper's composition table and the
    // reproduction command read from here, not from anyone's memory.
    await writeJson(path.join(path.dirname(out), 'pairs-meta.json'), {
      generatedAt: new Date().toISOString(),
      inventory: { path: inventoryPath, inputContentHash: inventory.inputContentHash },
      options: {
        minSim: num('min-sim', 0.7),
        skipCategories: skip,
        maxPerCategory: num('max-per-category', 0),
      },
      proposers: {
        string: { pairs: proposals.length },
        registry: registryPath ? { path: registryPath, pairs: registryProposals.length } : null,
        embeddings: has('embeddings')
          ? {
              provider: embProvider,
              model: embModel,
              k: embK,
              minCos: embMinCos,
              crossScriptMinCos: embXscriptMinCos,
              pairs: embeddingProposals.length,
            }
          : null,
      },
      snippets: docsDir ? { docsDir, missingSides: snippetMisses } : null,
      union: { pairs: labelled.length, bySource: Object.fromEntries(bySource) },
      crossCategorySurfaces: crossCategory.length,
    });

    if (registryPath) {
      console.log(
        '\nThe registry rows carry a PROVISIONAL stratum (c). It cannot tell semantic-known from\n' +
          'semantic-novel — set `c` or `d` yourself, and attach evidence to every positive merge.\n' +
          'It is also the batch arm\'s own output, so it is not an independent source: the MITRE/\n' +
          'Wikidata pass and the Cyrillic sweep are still required. See docs/GOLD-TABLE.md §4, §7.'
      );
    } else {
      console.log(
        '\nStrata (c) semantic-known and (d) semantic-novel are NOT proposed here — no string\n' +
          'mechanism can find a zero-overlap alias. Add those rows yourself, or pass --registry\n' +
          'to have the unified-entities registry propose candidates; see docs/GOLD-TABLE.md.'
      );
    }
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
      allPairs = raw.filter((pair) =>
        ['same', 'different', 'rung', 'rename'].includes(pair.label)
      );
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

    // Provenance, and the bias it makes visible.
    const sources = new Map<string, number>();
    for (const cluster of table.clusters) {
      if (cluster.members.length <= 1) continue;
      const label = (cluster.sources ?? ['string']).join('+');
      sources.set(label, (sources.get(label) ?? 0) + 1);
    }
    if (sources.size > 0) {
      console.log(`  mergeable clusters by proposer: ${JSON.stringify(Object.fromEntries([...sources].sort()))}`);
    }
    if (registryOnlyJudgmentStrata(table.clusters)) {
      console.warn(
        '  WARNING: every stratum (c)/(d) cluster came from the registry, which is the batch\n' +
          '  Ψ_norm arm\'s own output — the same file `evaluate --batch` scores. Verification\n' +
          '  removed its false merges, but nothing here can add the merges it never proposed, so\n' +
          '  that arm\'s merge recall is inflated by construction. Do the MITRE/Wikidata pass or\n' +
          '  the manual sweep before reporting a comparison.'
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
    console.log('Anything no rule claims gets "review" — most stratum-(a) pairs genuinely need you.\n');
    console.log('Then adjustments that depend on where the row came from, not on the two surfaces:\n');
    for (const rule of PROVENANCE_RULES) {
      console.log(`${rule.id}  ->  ${rule.suggest}`);
      console.log(`  ${rule.rationale}\n`);
    }
    console.log(
      'Note what is missing: nothing promotes a row to `same` because a registry agreed. The\n' +
        'string rules run first and unchanged, so a registry merge can only ever be softened to\n' +
        '`review` — never turned into a merge you did not adjudicate.'
    );
    return;
  }

  console.error(USAGE);
  process.exit(2);
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
