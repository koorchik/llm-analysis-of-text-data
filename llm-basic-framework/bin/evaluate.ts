#!/usr/bin/env ts-node
/**
 * Score one or more runs against the gold table and emit the composed results table (Phase 8.4).
 *
 *   npm run evaluate -- --gold gold-aliases-v1.json --split test \
 *                       --run <OUTPUT_DIR>/experiments/<runId> [--run …] [--json out.json]
 *
 * Each `--run` is a run directory containing `run-card.json` and, for streaming conditions,
 * `registry.json` and/or `decisions.jsonl`. A `--batch <entities.json>` condition scores the
 * published Ψ_norm artifact, which is the only artifact E1 can be scored from.
 *
 * Reporting discipline is enforced, not documented: `--split test` is required for reportable
 * numbers, strata are never averaged, and a condition whose model has no price entry gets an
 * explicit "unpriced" cell rather than a dollar figure that silently omits spend.
 */
import { parseDecisionEvents } from '../src/Experiment/replayLog';
import type { RunCardData } from '../src/Experiment/RunCard';
import { clusterMetrics, mergeMetricsByStratum } from '../src/Evaluation/clusterMetrics';
import {
  assertReportableSplit,
  goldPartition,
  goldSummary,
  labeledPairs,
  loadGoldTable,
  nilObservations,
  selectSplit,
  type Split,
} from '../src/Evaluation/gold';
import { nilMetrics } from '../src/Evaluation/nilMetrics';
import {
  fromBatchEntitiesMap,
  fromDecisionEvents,
  fromRegistry,
  type Partition,
} from '../src/Evaluation/partition';
import {
  determinismTier,
  renderResultsTable,
  tableNotes,
  type ConditionResult,
} from '../src/Evaluation/resultsTable';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

interface Args {
  gold?: string;
  split: Split;
  runs: string[];
  batches: string[];
  json?: string;
  allowDev: boolean;
  ignoreCategories: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    split: 'test',
    runs: [],
    batches: [],
    allowDev: false,
    ignoreCategories: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--gold':
        args.gold = argv[++i];
        break;
      case '--split':
        args.split = argv[++i] as Split;
        break;
      case '--run':
        args.runs.push(argv[++i]);
        break;
      case '--batch':
        args.batches.push(argv[++i]);
        break;
      case '--json':
        args.json = argv[++i];
        break;
      case '--allow-dev':
        args.allowDev = true;
        break;
      case '--ignore-categories':
        // For arms whose category vocabulary is emergent and so cannot match a fixed-vocabulary gold.
        args.ignoreCategories = true;
        break;
      default:
        if (argv[i].startsWith('--')) throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return args;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

/** Build the predicted partition for a run, preferring the registry and falling back to the log. */
async function predictedPartitionFor(
  runDir: string,
  keyOptions: { includeCategory: boolean }
): Promise<{ partition: Partition; source: string } | null> {
  const registryPath = path.join(runDir, 'registry.json');
  if (existsSync(registryPath)) {
    return { partition: fromRegistry(await readJson(registryPath), keyOptions), source: 'registry' };
  }

  const logPath = path.join(runDir, 'decisions.jsonl');
  if (existsSync(logPath)) {
    const events = parseDecisionEvents(await fs.readFile(logPath, 'utf8'));
    if (events.length > 0) {
      return { partition: fromDecisionEvents(events, keyOptions), source: 'decision-log' };
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.gold) {
    console.error(
      'usage: evaluate --gold <gold.json> [--split test|dev] --run <runDir> [--run …] [--batch <entities.json>] [--json out.json]'
    );
    process.exit(2);
  }

  assertReportableSplit(args.split, { allowDev: args.allowDev });

  const fullTable = await loadGoldTable(args.gold);
  const table = selectSplit(fullTable, args.split);
  const keyOptions = { includeCategory: !args.ignoreCategories };
  const gold = goldPartition(table, keyOptions);
  const pairs = labeledPairs(table, keyOptions);

  console.log('gold:', JSON.stringify(goldSummary(table)));
  console.log(`split=${args.split} clusters=${gold.size} elements=${gold.elementCount} labelledPairs=${pairs.length}`);
  if (pairs.length === 0) {
    console.warn('WARNING: no labelled pairs in this split — merge P/R will be empty for every condition');
  }
  console.log();

  const results: ConditionResult[] = [];

  for (const runDir of args.runs) {
    const cardPath = path.join(runDir, 'run-card.json');
    if (!existsSync(cardPath)) {
      console.warn(`skipping ${runDir}: no run-card.json`);
      continue;
    }
    const card = await readJson<RunCardData>(cardPath);

    const predicted = await predictedPartitionFor(runDir, keyOptions);
    if (!predicted) {
      console.warn(`skipping ${runDir}: neither registry.json nor a non-empty decisions.jsonl`);
      continue;
    }

    // NIL observations come from the decision log; a run without one cannot be NIL-scored.
    const logPath = path.join(runDir, 'decisions.jsonl');
    const events = existsSync(logPath)
      ? parseDecisionEvents(await fs.readFile(logPath, 'utf8'))
      : [];
    const { observations, unlabeled } = nilObservations(
      table,
      events.map((event) => ({
        docId: event.docId,
        category: event.category,
        mention: event.mention,
        decision: event.decision,
      }))
    );
    if (unlabeled > 0) {
      console.warn(
        `${card.condition}: ${unlabeled} decisions had no gold NIL label and were excluded from NIL metrics`
      );
    }

    const cost = (card.cost as { totals?: ConditionResult['cost']; unpricedModels?: string[] } | null) ?? {};

    results.push({
      condition: card.condition,
      runIds: [card.runId],
      tier: determinismTier(card.config.sampling),
      merge: mergeMetricsByStratum(predicted.partition, gold, pairs),
      nil: nilMetrics(observations),
      cluster: clusterMetrics(predicted.partition, gold),
      cost:
        cost.totals ??
        { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, wallClockMs: 0 },
      unpricedModels: cost.unpricedModels ?? [],
      downstreamTau: null, // filled by bin/downstream.ts (M11)
      orderAri: null, // filled by the E6 order-robustness arm (M8)
    });

    console.log(`${card.condition}: partition from ${predicted.source}, ${predicted.partition.size} clusters`);
  }

  for (const batchPath of args.batches) {
    const file = await readJson<Parameters<typeof fromBatchEntitiesMap>[0]>(batchPath);
    const partition = fromBatchEntitiesMap(file, keyOptions);

    results.push({
      condition: `psi-norm (${path.basename(path.dirname(batchPath))})`,
      runIds: [],
      // The published artifact predates the instrumentation, so its sampling is unrecorded.
      tier: 'unknown',
      merge: mergeMetricsByStratum(partition, gold, pairs),
      // The batch arm emits no per-mention decision log, so mint/NIL cannot be scored from it.
      nil: nilMetrics([]),
      cluster: clusterMetrics(partition, gold),
      cost: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, wallClockMs: 0 },
      unpricedModels: [],
    });

    console.log(`psi-norm from ${batchPath}: ${partition.size} clusters`);
  }

  if (results.length === 0) {
    console.error('no scoreable conditions');
    process.exit(1);
  }

  console.log();
  console.log(renderResultsTable(results));
  console.log();
  for (const note of tableNotes(results)) console.log(`- ${note}`);

  if (args.json) {
    await fs.writeFile(args.json, `${JSON.stringify({ gold: goldSummary(table), results }, null, 2)}\n`);
    console.log(`\nwrote ${args.json}`);
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
