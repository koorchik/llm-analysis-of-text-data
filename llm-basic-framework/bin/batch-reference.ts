#!/usr/bin/env ts-node
/**
 * RQ3 batch-reference harness runner (T12). Builds a `RegistryConsolidator` and runs it once
 * against a COPIED run directory — regime (ii) of E6 (see `RegistryConsolidator`'s header for what
 * that means and why it is never wired into the pipeline).
 *
 *   RUN_DIR=<path/to/copied/run> npm run batch-reference -- --copied
 *
 * `RUN_DIR` must be a COPY of a run directory (`registry.json`/`schema.json`/`artifacts/`), never a
 * live arm's own output: the consolidator mutates the registry in place and re-stamps every
 * artifact on disk, so pointing this at a pipeline's real run directory would corrupt that arm out
 * from under it. There is no reliable way to tell a copy from an original by path alone, so
 * `--copied` is a required acknowledgment, not a detection heuristic — the script simply refuses to
 * run without it.
 *
 * `LLM_PROVIDER`/`LLM_MODEL` select the backend (defaults match `bin/app.ts`'s: openai/gpt-5).
 * `DECISIONS_LOG=1` appends this pass's ops (`doc: -1`) to the copied run's own `decisions.jsonl` —
 * the same file the playback viewer (T11) reads, where this run reads as the "batch-reference
 * chapter".
 *
 * Prints the resulting `registry.json` path on success — that path is ARI's input.
 */
import { RegistryConsolidator } from '../src/Consolidator/RegistryConsolidator';
import { DecisionLog } from '../src/DecisionLog/DecisionLog';
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { CostMeter } from '../src/Experiment/CostMeter';
import { stripRunDate } from '../src/Experiment/runDirName';
import { LlmClient } from '../src/LlmClient/LlmClient';
import { createLlmBackend } from '../src/LlmClient/createBackend';
import { SchemaRegistry } from '../src/SchemaRegistry/SchemaRegistry';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

dotenv.config();

async function main() {
  const runDir = process.env.RUN_DIR;
  if (!runDir) {
    console.error(
      'usage: RUN_DIR=<path/to/copied/run> npm run batch-reference -- --copied\n' +
        '       RUN_DIR must contain registry.json, schema.json and artifacts/ from a run.'
    );
    process.exit(2);
  }

  // Guard against clobbering a live arm: the consolidator mutates registry.json in place and
  // re-stamps every artifact on disk. --copied is a required acknowledgment, not a check — there is
  // no way to tell a copy from an original by path alone.
  if (!process.argv.includes('--copied')) {
    console.error(
      `RUN_DIR (${runDir}) was not acknowledged as a copy. This harness mutates the registry in ` +
        'place and re-stamps every artifact on disk — pointed at a live pipeline run directory it ' +
        'would corrupt that arm.\n' +
        `Copy the run directory first (e.g. cp -r "${runDir}" "${runDir}-batch-ref"), point RUN_DIR ` +
        'at the copy, then re-run with --copied to confirm you did.'
    );
    process.exit(2);
  }

  if (!existsSync(path.join(runDir, 'registry.json')) || !existsSync(path.join(runDir, 'schema.json'))) {
    console.error(`RUN_DIR (${runDir}) is missing registry.json or schema.json — not a run directory.`);
    process.exit(2);
  }

  const provider = process.env.LLM_PROVIDER || 'openai';
  const model = process.env.LLM_MODEL || 'gpt-5';
  // Run directories carry a `<YYYY-MM-DD>-` presentation prefix; the identity is the runId under it.
  const runId = stripRunDate(path.basename(runDir));
  const costMeter = new CostMeter({ runId: `batch-reference-${runId}` });
  const llmClient = new LlmClient({ backend: createLlmBackend({ provider, model }), costMeter });

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(runDir, 'schema.json') });
  const conceptRegistry = new ConceptRegistry({ filePath: path.join(runDir, 'registry.json') });
  // Same file the run already wrote under DECISIONS_LOG=1 — this pass appends its docId -1 ops to
  // it rather than starting a new log, which is what lets the viewer read it as one more chapter.
  const decisionLog = new DecisionLog({
    filePath: path.join(runDir, 'decisions.jsonl'),
    enabled: process.env.DECISIONS_LOG === '1',
    runId,
  });

  const consolidator = new RegistryConsolidator({
    artifactsDir: path.join(runDir, 'artifacts'),
    llmClient,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
  });

  await consolidator.run();

  const registryPath = path.join(runDir, 'registry.json');
  console.log(`batch-reference: consolidated registry written to ${registryPath}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
