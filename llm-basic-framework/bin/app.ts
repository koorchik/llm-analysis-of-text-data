import { CountryNameNormalizer } from '../src/CountryNameNormalizer/CountryNameNormalizer';
import { DataAnalyzer } from '../src/DataProcessors/DataAnalyzer';
import { DataEntitiesCollector } from '../src/DataProcessors/DataEntitiesCollector';
import { DataExtractor } from '../src/DataProcessors/DataExtractor';
import { DataGraphBuilder } from '../src/DataProcessors/DataGraphBuilder';
import { DataNormalizer } from '../src/DataProcessors/DataNormalizer';
import { StreamingExtractor } from '../src/DataProcessors/StreamingExtractor';
import { StreamingGraphBuilder, EdgesFrom } from '../src/DataProcessors/StreamingGraphBuilder';
import { StreamingNormalizer } from '../src/DataProcessors/StreamingNormalizer';
import { StreamingRepairer } from '../src/DataProcessors/StreamingRepairer';
import { DecisionLog } from '../src/DecisionLog/DecisionLog';
import { EmbeddingsClient } from '../src/EmbeddingsClient/EmbeddingsClient';
import { createEmbeddingsClient as buildEmbeddingsClient } from '../src/EmbeddingsClient/createEmbeddingsClient';
import { ConceptRegistry } from '../src/ConceptRegistry/ConceptRegistry';
import { CostMeter } from '../src/Experiment/CostMeter';
import { RunCard } from '../src/Experiment/RunCard';
import { resolveRunConfig, type ResolvedRunConfig } from '../src/Experiment/RunConfig';
import { resolveRunDir, stripRunDate } from '../src/Experiment/runDirName';
import { hashInputDir } from '../src/Experiment/inputHash';
import { FlowManager } from '../src/FlowManager/FlowManager';
import { LlmCallLog } from '../src/LlmClient/LlmCallLog';
import { loadRunData, renderRunViewHtml } from '../src/RunView/runView';
import { LlmClient } from '../src/LlmClient/LlmClient';
import type { LlmBackendBase, LlmCallOptions } from '../src/LlmClient/LlmClientBackendBase';
import { createLlmBackend as buildLlmBackend } from '../src/LlmClient/createBackend';
import {
  DECISION_STRATEGIES,
  ComemSelectDecision,
  ListwiseGraphDecision,
  ListwiseMintCandidateDecision,
  createOfflineStrategy,
  isOfflineStrategyId,
} from '../src/Normalization/decision';
import { resolveGenerator } from '../src/Normalization/candidates';
import type { CandidateGenerator, DecisionStrategy } from '../src/Normalization/types';
import { prompts } from '../src/Normalization/PromptProvider';
import { GlossIndex } from '../src/Repair/GlossIndex';
import { parseThresholds } from '../src/Repair/SuspectGenerator';
import { SchemaRegistry } from '../src/SchemaRegistry/SchemaRegistry';
import { sortByNumericId } from '../src/utils/fsUtils';
import { orderFiles, validateOrderSpec } from '../src/utils/orderUtils';
import { parseCategories } from '../src/utils/validationUtils';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Flow: 'batch' (legacy pipeline) | 'incremental' (streaming SKEIN v2 pipeline)
const FLOW = process.env.FLOW || 'batch';
if (!['batch', 'incremental'].includes(FLOW)) {
  throw new Error(`Unknown FLOW: ${FLOW}. Available: batch, incremental`);
}
// Fail fast on a malformed ORDER before any run directory is created.
if (process.env.ORDER) {
  validateOrderSpec(process.env.ORDER);
}
if (process.env.SNIPPET_MODE && !['head', 'none', 'anchored', 'per-mention'].includes(process.env.SNIPPET_MODE)) {
  throw new Error(`SNIPPET_MODE "${process.env.SNIPPET_MODE}" is not one of: head | none | anchored | per-mention`);
}

// Configuration from environment or defaults
const CONFIG = {
  // LLM provider: 'openai', 'ollama', 'vertexai', 'anthropic'
  llmProvider: process.env.LLM_PROVIDER || 'openai',
  llmModel: process.env.LLM_MODEL || 'gpt-5',

  // Embeddings provider: 'openai', 'ollama', 'vertexai'
  embeddingsProvider: process.env.EMBEDDINGS_PROVIDER || 'ollama',
  embeddingsModel: process.env.EMBEDDINGS_MODEL || 'nomic-embed-text',

  // Directories
  inputDir: process.env.INPUT_DIR || '../storage/cert.gov.ua/fetched',
  outputDir: process.env.OUTPUT_DIR || '../storage/cert.gov.ua/processed',

  // What to run (subset of the selected flow's steps)
  flow: FLOW,
  steps:
    process.env.STEPS?.split(',') ||
    (FLOW === 'incremental' ? ['streamingPipeline'] : ['dataExtractor']),

  // Incremental flow options
  decisionsLog: process.env.DECISIONS_LOG === '1',

  // Document arrival order (E6/M7 order robustness): numeric-id | reverse | seededShuffle:<seed>.
  // Folded into the runId via config.order — two orders must never share a run directory.
  order: process.env.ORDER || 'numeric-id',

  // Judge every unresolved mention, even with zero identity candidates (in-document hierarchy
  // for first-seen concepts). Folded into the runId.
  judgeUnresolved: process.env.JUDGE_UNRESOLVED === '1',

  // Judge evidence block (snippet ablation): head | none | anchored | per-mention. Folded into
  // the runId.
  snippetMode: (process.env.SNIPPET_MODE as 'head' | 'none' | 'anchored' | 'per-mention') || 'head',

  // M6 decision stage. Unset means the built-in link-judge path — the published Ψ_link behaviour
  // the golden fixture pins — so an unset variable never silently changes what the default arm
  // measures. CONDITION only *names* an arm; this is what selects one.
  // Normalized to undefined when empty: `DECISION_STRATEGY=` must behave exactly like unset, or the
  // run card would record an empty-string arm name that reads as "none" but is not `?? `-defaulted.
  decisionStrategy: process.env.DECISION_STRATEGY || undefined,
  listwisePromptId: process.env.LISTWISE_PROMPT_ID || undefined,
  listwiseK: process.env.LISTWISE_K === undefined ? undefined : Number(process.env.LISTWISE_K),

  // M5 candidate generation. Unset means `string-sim` — the generator the M2.5 golden fixture pins
  // and the M4 gate is scored against — so the default arm is provably unchanged. Empty behaves as
  // unset, for the same reason DECISION_STRATEGY does.
  candidateGenerator: process.env.CANDIDATE_GENERATOR || undefined,
  candidateK: process.env.CANDIDATE_K === undefined ? undefined : Number(process.env.CANDIDATE_K),
  candidateMinSim:
    process.env.CANDIDATE_MIN_SIM === undefined ? undefined : Number(process.env.CANDIDATE_MIN_SIM),

  // SKOS graph catch-up: a registry-wide review of a category fires after it has grown this many
  // new canonicals (0 disables), each pass reviewing at most `skosCatchupWidth` canonicals. Both
  // knobs fold into the runId — two arms differing only in catch-up policy must not share a
  // directory.
  skosCatchupEvery:
    process.env.SKOS_CATCHUP_EVERY === undefined ? 25 : Number(process.env.SKOS_CATCHUP_EVERY),
  skosCatchupWidth:
    process.env.SKOS_CATCHUP_WIDTH === undefined ? 40 : Number(process.env.SKOS_CATCHUP_WIDTH),

  // M5 batch flow. Off by default: turning embeddings on changes what DataNormalizer writes, and
  // the committed `normalized/` artifacts must stay byte-identical for anyone who did not ask.
  embeddings: process.env.EMBEDDINGS === '1',

  edgesFrom: (process.env.EDGES_FROM as EdgesFrom) || 'extracted',

  // T9 repair pass: synchronous per-document registry repair, riding inside streamingNormalizer's
  // processFile. Default ON — the incremental flow's normal behaviour. REPAIR=0 is the RQ3 NAIVE
  // arm: no StreamingRepairer (and no GlossIndex) is constructed at all, so this has to be its own
  // knob rather than a threshold that happens to silence everything.
  repair: process.env.REPAIR === undefined ? true : process.env.REPAIR === '1',
  repairPromptId: process.env.REPAIR_PROMPT_ID || undefined,
  repairStrictIdentity: process.env.REPAIR_STRICT_IDENTITY === '1',
  // "Category=0.97,default=0.9" format (parseThresholds); unset keeps T6's conservative built-ins.
  repairGlossThresholds: process.env.REPAIR_GLOSS_THRESHOLDS || undefined,
  repairBlockerThresholds: process.env.REPAIR_BLOCKER_THRESHOLDS || undefined,
  repairCoherenceThreshold:
    process.env.REPAIR_COHERENCE_THRESHOLD === undefined
      ? undefined
      : Number(process.env.REPAIR_COHERENCE_THRESHOLD),
  // 8000 by default (StreamingRepairer's own default) — fits the 8k local window the deferred
  // consolidator's 22.6k prompt overflowed.
  repairTokenCap:
    process.env.REPAIR_TOKEN_CAP === undefined ? undefined : Number(process.env.REPAIR_TOKEN_CAP),
  repairTopK: process.env.REPAIR_TOP_K === undefined ? undefined : Number(process.env.REPAIR_TOP_K),

  // Full-fidelity LLM transcripts under `<runDir>/llm-calls/` (spec 2026-08-17). On by default.
  // Deliberately NOT part of the runId: writing files does not change what the pipeline computes,
  // and folding it in would rotate every arm's runId and make a logged run incomparable with the
  // committed ones. That is also why it does NOT appear in the `extra` block below.
  llmLog: process.env.LLM_LOG !== '0',

  // Fast-iteration category filter (spec 2026-08-16): only listed canonical categories are
  // normalized; unset means all. parseCategories throws on unknown names at startup — module
  // evaluation time, before any LLM call. Folds into the runId below: a filtered run measures a
  // different population and must never share a directory with (or resume) a full arm.
  categories: parseCategories(process.env.CATEGORIES),

  // M1 run identity. CONDITION names the experimental arm; two arms on the same model no longer
  // share an output directory, so they cannot silently resume each other.
  condition: process.env.CONDITION || (FLOW === 'incremental' ? 'psi-link-default' : 'psi-norm-default'),
  seed: process.env.SEED === undefined ? null : Number(process.env.SEED),

  // Sampling is per-call and recorded. Unset means "send nothing" — which is the only valid
  // choice for Anthropic on Opus 4.7+, where a non-default temperature returns HTTP 400.
  temperature: process.env.TEMPERATURE === undefined ? undefined : Number(process.env.TEMPERATURE),
  topP: process.env.TOP_P === undefined ? undefined : Number(process.env.TOP_P),
  maxTokens: process.env.MAX_TOKENS === undefined ? undefined : Number(process.env.MAX_TOKENS),
};

async function main() {
  console.log(CONFIG);

  // --- M1: establish run identity before anything writes ---
  const backend = createLlmBackend();
  const sampling = {
    effective: {} as LlmCallOptions, // filled in below from the client's own view
    supported: backend.sampling,
  };

  // Built before the run config so its id and config can enter the runId. The LLM-backed strategies
  // need a client, which needs the cost meter, which needs the runId — so this one is constructed
  // with a placeholder client and rebuilt below once the real one exists. Only `.config` is read
  // here, and that does not depend on the client.
  const strategyForCard = createDecisionStrategy(null as unknown as LlmClient, undefined);

  // Same two-phase trick for the candidate generator (M5): its config has to enter the runId, but
  // the embedding generator needs a client that needs the cost meter that needs the runId. An
  // unmetered client is enough to read `.config` — the real one is built below. Without this, a
  // string-sim run and an embedding run would share a runId, share `experiments/{runId}/`, and
  // silently resume each other through the `existsSync` skips.
  const generatorForCard = createCandidateGenerator(createEmbeddingsClient());

  const runConfig = resolveRunConfig({
    condition: CONFIG.condition,
    orchestration: CONFIG.flow,
    input: await describeInput(CONFIG.inputDir),
    llm: { provider: CONFIG.llmProvider, model: CONFIG.llmModel },
    embeddings: { provider: CONFIG.embeddingsProvider, model: CONFIG.embeddingsModel },
    sampling,
    seed: CONFIG.seed,
    order: CONFIG.order, // document arrival order (E6/M7) — numeric-id | reverse | seededShuffle:<seed>
    // Every prompt on disk, not just the ones this step happens to use: a run card that recorded
    // only the used subset would make an unused-prompt edit invisible, and the next run of a
    // different step would then reuse this runId despite a genuinely different prompt set.
    promptHashes: prompts.hashes(),
    extra: {
      steps: CONFIG.steps,
      edgesFrom: CONFIG.edgesFrom,
      // Part of the runId, not just a label: two arms differing only by decision rule would
      // otherwise share a directory and resume each other through the `existsSync` skips.
      decisionStrategy: CONFIG.decisionStrategy ?? 'builtin-link-judge',
      decisionStrategyConfig: strategyForCard?.config ?? null,
      // Same argument as above, for retrieval: E4 varies the blocker while holding the judge fixed,
      // so two arms can differ *only* here.
      candidateGenerator: generatorForCard.id,
      candidateGeneratorConfig: generatorForCard.config,
      candidateK: CONFIG.candidateK ?? null,
      candidateMinSim: CONFIG.candidateMinSim ?? null,
      embeddings: CONFIG.embeddings,
      skos: {
        catchupEvery: CONFIG.skosCatchupEvery,
        catchupWidth: CONFIG.skosCatchupWidth,
      },
      snippetMode: CONFIG.snippetMode,
      judgeUnresolved: CONFIG.judgeUnresolved,
      // T9 repair pass: on/off and every threshold/knob that changes what it does. REPAIR=0 (the
      // RQ3 NAIVE arm) must not share a runId with a repaired arm, and two repaired arms differing
      // only by threshold must not share one either — same argument as `decisionStrategy` above.
      repair: CONFIG.repair,
      repairPromptId: CONFIG.repairPromptId ?? 'repair-judge',
      repairStrictIdentity: CONFIG.repairStrictIdentity,
      repairGlossThresholds: CONFIG.repairGlossThresholds ?? null,
      repairBlockerThresholds: CONFIG.repairBlockerThresholds ?? null,
      repairCoherenceThreshold: CONFIG.repairCoherenceThreshold ?? null,
      repairTokenCap: CONFIG.repairTokenCap ?? null,
      repairTopK: CONFIG.repairTopK ?? null,
      categories: CONFIG.categories ?? null,
    },
  });

  // `<YYYY-MM-DD>-<runId>` so `ls experiments/` reads chronologically. The date is presentation
  // only — never part of the runId — and an existing directory for this runId always wins, so a
  // run resumed on a later day keeps its original directory instead of silently starting over.
  const runDir = resolveRunDir(`${CONFIG.outputDir}/experiments`, runConfig.runId, new Date());
  const costMeter = new CostMeter({ runId: runConfig.runId });
  const callLog = new LlmCallLog({
    dir: `${runDir}/llm-calls`,
    runId: runConfig.runId,
    enabled: CONFIG.llmLog,
  });
  const llmClient = createLlmClient(backend, costMeter, callLog);

  // Record what the client will really send, after unsupported parameters are dropped.
  sampling.effective = llmClient.effectiveDefaults;
  runConfig.sampling = sampling;

  const runCard = new RunCard({ runDir, config: runConfig });
  await runCard.save();
  console.log(`RUN ${runConfig.runId} → ${runDir}`);
  if (runConfig.git.dirty) {
    console.warn('RUN: working tree is dirty — runId includes a diff hash, but commit before a real run');
  }

  // The real client: metered, and backed by a cache that lives OUTSIDE the run directory, because
  // a vector for a given (model, text) is run-independent and re-embedding per seed would dominate
  // the cost of every encoder arm.
  const embeddingsClient = createEmbeddingsClient(costMeter, `${CONFIG.outputDir}/embeddings-cache`);
  const candidateGenerator = createCandidateGenerator(embeddingsClient);

  // Create processors
  const processors = createProcessors(llmClient, embeddingsClient, runDir, candidateGenerator, costMeter, callLog);

  // Build flow
  const batchSteps: Record<string, () => Promise<void>> = {
    dataExtractor: () => processors.dataExtractor.run(),
    dataEntitiesCollector: () => processors.dataEntitiesCollector.run(),
    dataNormalizer: () => processors.dataNormalizer.run(),
    dataAnalyzer: () => processors.dataAnalyzer.run(),
    dataGraphBuilder: () => processors.dataGraphBuilder.run(),
  };

  const incrementalSteps: Record<string, () => Promise<void>> = {
    streamingPipeline: () => runStreamingPipeline(processors),
    streamingExtractor: () => processors.streamingExtractor.run(),
    streamingNormalizer: () => processors.streamingNormalizer.run(),
    streamingGraphBuilder: () => processors.streamingGraphBuilder.run(),
    // T9: standalone catch-up for a registry whose repair pass never ran (an existing corpus, or a
    // run that died mid-stream) — repair otherwise rides inside streamingNormalizer's processFile.
    // registryConsolidator was here; T12 gives it a separate harness entry point instead of a step.
    streamingRepairer: async () => {
      if (!processors.streamingRepairer) {
        throw new Error(
          'STEPS=streamingRepairer requires REPAIR=1 (the default) — REPAIR=0 constructs no ' +
            'repairer, so there is nothing to catch up'
        );
      }
      await processors.streamingRepairer.run();
    },
    dataAnalyzer: () => processors.streamingDataAnalyzer.run(),
  };

  const availableSteps = CONFIG.flow === 'incremental' ? incrementalSteps : batchSteps;

  const steps = CONFIG.steps.map((stepName) => {
    if (!availableSteps[stepName]) {
      throw new Error(
        `Unknown step: ${stepName}. Available for FLOW=${CONFIG.flow}: ${Object.keys(availableSteps).join(', ')}`
      );
    }
    return {
      name: stepName,
      run: availableSteps[stepName],
    };
  });

  const flowManager = new FlowManager({ steps });

  // Run. The cost totals are attached in `finally` so an aborted run still leaves a card
  // recording what it spent before it died.
  try {
    if (CONFIG.steps.length === 1) {
      await flowManager.runStep(CONFIG.steps[0]);
    } else {
      await flowManager.runAllSteps();
    }
    runCard.markComplete();
  } finally {
    runCard.attachCost(costMeter);
    // M5: a fully-cached encoder arm makes zero embedding calls, which reads as "embeddings never
    // ran" unless the hit count is recorded beside the spend.
    runCard.attachEmbeddingCache(embeddingsClient.cacheStats);
    await runCard.save();
    const totals = costMeter.totals();
    const cache = embeddingsClient.cacheStats;
    console.log(
      `COST ${runConfig.runId}: ${totals.calls} calls, ` +
        `${totals.inputTokens}+${totals.outputTokens} tokens, ` +
        `$${totals.costUsd.toFixed(4)}` +
        (totals.unpricedCalls ? ` (+${totals.unpricedCalls} unpriced calls)` : '') +
        (cache && cache.hits + cache.misses > 0
          ? `, embed cache ${cache.hits} hit / ${cache.misses} miss`
          : '')
    );
    if (costMeter.unpricedModels.length) {
      console.warn(`COST: no price entry for ${costMeter.unpricedModels.join(', ')} — add to config/model-prices.json`);
    }
    await writeRunView(runDir);
  }
}

/**
 * Write `<runDir>/run-view.html` at the end of every run, so the replay page is simply there
 * instead of needing a remembered `npm run view` invocation.
 *
 * Best-effort by design: it runs in the same `finally` that records cost, and a viewer that cannot
 * be built (no decision log, an aborted run with nothing to replay) must never turn a completed
 * experiment into a failed one. `npm run view` still exists for multi-run comparison pages.
 */
async function writeRunView(runDir: string): Promise<void> {
  try {
    const data = await loadRunData(runDir);
    await fs.writeFile(`${runDir}/run-view.html`, renderRunViewHtml(data));
    console.log(`VIEW ${runDir}/run-view.html`);
  } catch (error) {
    console.warn(
      `VIEW: could not write run-view.html (${error instanceof Error ? error.message : error})`
    );
  }
}

/** Content-hash the frozen input so a run card cannot claim a corpus it did not read. */
async function describeInput(dir: string) {
  try {
    const { contentHash, fileCount } = await hashInputDir(dir);
    return { path: dir, contentHash, fileCount };
  } catch (error) {
    console.warn(`RUN: could not hash input dir ${dir} —`, error);
    return { path: dir, contentHash: 'unavailable', fileCount: 0 };
  }
}

function createLlmBackend(): LlmBackendBase {
  // The provider switch lives in src/LlmClient/createBackend.ts, shared with `bin/gold.ts` so
  // the ensemble annotator and the pipeline build backends identically.
  return buildLlmBackend({ provider: CONFIG.llmProvider, model: CONFIG.llmModel });
}

function createLlmClient(
  backend: LlmBackendBase,
  costMeter: CostMeter,
  callLog?: LlmCallLog
): LlmClient {
  return new LlmClient({
    backend,
    costMeter,
    ...(callLog ? { callLog } : {}),
    // Sampling defaults are per-call and get filtered per backend: LlmClient drops any
    // parameter the provider does not accept rather than forwarding it into a 400.
    defaultCallOptions: {
      ...(CONFIG.temperature !== undefined ? { temperature: CONFIG.temperature } : {}),
      ...(CONFIG.topP !== undefined ? { topP: CONFIG.topP } : {}),
      ...(CONFIG.maxTokens !== undefined ? { maxTokens: CONFIG.maxTokens } : {}),
      ...(CONFIG.seed !== null && !Number.isNaN(CONFIG.seed) ? { seed: CONFIG.seed } : {}),
    },
  });
}

function createEmbeddingsClient(costMeter?: CostMeter, cacheDir?: string): EmbeddingsClient {
  // The provider switch lives in src/EmbeddingsClient/createEmbeddingsClient.ts, shared with
  // `bin/gold.ts` so the pair proposer and the pipeline build clients identically.
  return buildEmbeddingsClient({
    provider: CONFIG.embeddingsProvider,
    model: CONFIG.embeddingsModel,
    cacheDir,
    costMeter,
  });
}

function createCandidateGenerator(embeddingsClient: EmbeddingsClient): CandidateGenerator {
  return resolveGenerator(CONFIG.candidateGenerator ?? 'string-sim', { embeddingsClient });
}

/**
 * Build the decision strategy named by `DECISION_STRATEGY`, or undefined for the built-in path.
 *
 * Undefined is the default on purpose: the built-in `link-judge` call is the published Ψ_link
 * behaviour, and having an unset environment variable quietly substitute a different decision rule
 * would change what `psi-link-default` measures without anything in the run card saying so.
 */
function createDecisionStrategy(
  llmClient: LlmClient,
  decisionLog?: DecisionLog
): DecisionStrategy | undefined {
  const id = CONFIG.decisionStrategy;
  if (!id) return undefined;

  if (isOfflineStrategyId(id)) return createOfflineStrategy(id);
  if (id === 'listwise-mint-candidate') {
    return new ListwiseMintCandidateDecision({
      llmClient,
      decisionLog,
      promptId: CONFIG.listwisePromptId,
      k: CONFIG.listwiseK,
    });
  }
  if (id === 'listwise-graph') {
    return new ListwiseGraphDecision({
      llmClient,
      decisionLog,
      promptId: CONFIG.listwisePromptId,
      k: CONFIG.listwiseK,
    });
  }
  if (id === 'comem-select') return new ComemSelectDecision({ llmClient, decisionLog });

  // Fatal rather than falling back: silently running the built-in judge under another arm's name
  // would put the wrong label on a real result.
  throw new Error(
    `Unknown DECISION_STRATEGY: ${id}. Available: ${Object.keys(DECISION_STRATEGIES).join(', ')} ` +
      '(unset = the built-in link-judge path)'
  );
}

function createProcessors(
  llmClient: LlmClient,
  embeddingsClient: EmbeddingsClient,
  runDir: string,
  candidateGenerator: CandidateGenerator,
  costMeter?: CostMeter,
  callLog?: LlmCallLog
) {
  const modelDir = llmClient.modelName.replace(/:/g, '-');
  const baseDir = CONFIG.outputDir;
  const inputDir = CONFIG.inputDir;

  // M5: with `EMBEDDINGS=1` the batch flow writes vectors, so its output moves into the run
  // directory. That keeps the committed `normalized/{model}/` artifacts — 204 files, every
  // `embedding` an empty array — byte-identical, and it means the t-SNE built from real vectors
  // belongs to the run that paid for them. With embeddings off the paths are exactly as before.
  const batchDir = CONFIG.embeddings ? `${runDir}/batch` : `${baseDir}`;
  const normalizedDir = `${batchDir}/normalized/${modelDir}`;
  const analyzedDir = `${batchDir}/analyzed/${modelDir}`;

  // The decision log and run card live in the run directory for BOTH flows — cost and decisions
  // are properties of a run, not of an artifact layout.
  const decisionLog = new DecisionLog({
    filePath: `${runDir}/decisions.jsonl`,
    enabled: CONFIG.decisionsLog,
    // The pure runId, NOT the directory name: the directory carries a presentation date prefix,
    // and stamping that into every logged event would break replay/scoring comparisons against
    // runs recorded before dating existed.
    runId: stripRunDate(path.basename(runDir)),
  });

  const preprocessor = (content: string) => {
    const data = JSON.parse(content);
    return Promise.resolve({
      text: data.text.replace(/<img[^>]*>/gi, ''),
      metadata: {
        date: data.date,
        id: data.id,
        title: data.title,
      },
    });
  };

  const dataExtractor = new DataExtractor({
    inputDir,
    outputDir: `${baseDir}/raw/${modelDir}`,
    preprocessor,
    llmClient,
  });

  const dataEntitiesCollector = new DataEntitiesCollector({
    inputDir: dataExtractor.outputDir,
    outputDir: `${baseDir}/entities/${modelDir}`,
    llmClient,
    decisionLog,
  });

  const dataNormalizer = new DataNormalizer({
    inputDir: dataExtractor.outputDir,
    outputDir: normalizedDir,
    entitiesFile: `${dataEntitiesCollector.outputDir}/entities.json`,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient, decisionLog }),
    embeddingsClient,
    embeddingsEnabled: CONFIG.embeddings,
  });

  const dataAnalyzer = new DataAnalyzer({
    inputDir: dataNormalizer.outputDir,
    outputDir: analyzedDir,
  });

  const dataGraphBuilder = new DataGraphBuilder({
    inputDir: dataNormalizer.outputDir,
    outputDir: analyzedDir,
  });

  // --- Incremental (streaming) flow — spec: docs/streaming-pipeline-spec.md ---
  // M1: was `${baseDir}/incremental/${modelDir}`, where two conditions on the same model shared a
  // directory and silently resumed each other through the `existsSync` skips. Keyed by runId now.
  const incrementalDir = runDir;

  // Shared state instances: one schema/registry per run keeps the interleaved
  // extract→normalize step coherent (disk is write-only during a run)
  const schemaRegistry = new SchemaRegistry({ filePath: `${incrementalDir}/schema.json` });
  const conceptRegistry = new ConceptRegistry({ filePath: `${incrementalDir}/registry.json` });

  const streamingExtractor = new StreamingExtractor({
    inputDir,
    outputDir: `${incrementalDir}/extractions`,
    preprocessor,
    llmClient,
    schemaRegistry,
    decisionLog,
    fileOrder: (files) => orderFiles(files, CONFIG.order),
  });

  // T9: synchronous per-document repair pass. GlossIndex is built from the run's own
  // `embeddingsClient` — the same instance and cache dir (`${OUTPUT_DIR}/embeddings-cache`)
  // `EmbeddingGenerator` uses — so the disk (model, text) cache is shared rather than paid for
  // twice. REPAIR=0 (the RQ3 NAIVE arm) constructs neither GlossIndex nor StreamingRepairer: with
  // no repair step to feed it, GlossIndex has no caller and would only add a spurious embeddings
  // dependency to an arm that is supposed to have none.
  //
  // Posture (controller adjudication): `glossIndex.sync` failing inside `processDoc` is deliberately
  // FATAL to the document, uncaught here — silently skipping repair on a sync failure would corrupt
  // an experimental arm by letting it run partially repaired without saying so; a loud crash is the
  // correct failure mode for a research harness.
  const glossIndex = CONFIG.repair ? new GlossIndex({ embeddingsClient }) : undefined;

  const streamingRepairer = glossIndex
    ? new StreamingRepairer({
        artifactsDir: `${incrementalDir}/artifacts`,
        llmClient,
        schemaRegistry,
        conceptRegistry,
        decisionLog,
        glossIndex,
        promptId: CONFIG.repairPromptId,
        strictIdentity: CONFIG.repairStrictIdentity,
        // The SAME instance the normalizer prepares below — sharing keeps its phase-1 indexes warm
        // instead of paying for a second cold build (StreamingRepairer's Params doc).
        blocker: candidateGenerator,
        thresholds: {
          glossAnn: parseThresholds(CONFIG.repairGlossThresholds, 'glossAnn'),
          blocker: parseThresholds(CONFIG.repairBlockerThresholds, 'blocker'),
          coherence: CONFIG.repairCoherenceThreshold ?? 0.5,
        },
        ...(CONFIG.repairTokenCap !== undefined ? { tokenCap: CONFIG.repairTokenCap } : {}),
        ...(CONFIG.repairTopK !== undefined ? { suspectTopK: CONFIG.repairTopK } : {}),
        // Invalidates the phase-1 blocker index after every applied repair op — without this the
        // blocker `candidateGenerator` shares with the normalizer keeps answering from a stale index.
        onRegistryChange: (event) => candidateGenerator.onRegistryChange(event),
      })
    : undefined;

  const streamingNormalizer = new StreamingNormalizer({
    inputDir: streamingExtractor.outputDir,
    outputDir: `${incrementalDir}/artifacts`,
    llmClient,
    schemaRegistry,
    conceptRegistry,
    decisionLog,
    sourceDir: inputDir,
    preprocessor,
    fileOrder: (files) => orderFiles(files, CONFIG.order),
    snippetMode: CONFIG.snippetMode,
    judgeUnresolved: CONFIG.judgeUnresolved,
    // SKOS graph: every hierarchy edge carries the cosine similarity of its endpoint names,
    // computed through the run's shared embeddings client and cache.
    embeddingsClient,
    skosCatchupEvery: CONFIG.skosCatchupEvery,
    skosCatchupWidth: CONFIG.skosCatchupWidth,
    decisionStrategy: createDecisionStrategy(llmClient, decisionLog),
    // M5: previously hardcoded to StringSimilarityGenerator inside the normalizer, which left every
    // generator M4 shipped with no live caller.
    candidateGenerator,
    ...(CONFIG.candidateK !== undefined ? { candidateK: CONFIG.candidateK } : {}),
    ...(CONFIG.candidateMinSim !== undefined ? { candidateMinSim: CONFIG.candidateMinSim } : {}),
    // T5 hook: phase 2 rides inside processFile once this document's registry writes have landed.
    // Omitted entirely under REPAIR=0, so a repairer-free arm behaves exactly as before T9.
    ...(streamingRepairer ? { repairer: streamingRepairer } : {}),
    ...(CONFIG.categories ? { categories: CONFIG.categories } : {}),
  });

  const streamingGraphBuilder = new StreamingGraphBuilder({
    inputDir: streamingNormalizer.outputDir,
    outputDir: `${incrementalDir}/graph`,
    schemaRegistry,
    conceptRegistry,
    edgesFrom: CONFIG.edgesFrom,
  });

  // Artifacts are a strict superset of normalized/NN.json — DataAnalyzer reused unchanged
  const streamingDataAnalyzer = new DataAnalyzer({
    inputDir: streamingNormalizer.outputDir,
    outputDir: `${incrementalDir}/analyzed`,
  });

  return {
    dataExtractor,
    dataEntitiesCollector,
    dataNormalizer,
    dataAnalyzer,
    dataGraphBuilder,
    streamingExtractor,
    streamingNormalizer,
    streamingGraphBuilder,
    streamingRepairer,
    streamingDataAnalyzer,
  };
}

// Spec §5: per document, extract → normalize (interleaved) so that after any
// document the artifacts + state files are complete for everything seen so far
async function runStreamingPipeline(processors: ReturnType<typeof createProcessors>) {
  const files = orderFiles(
    (await fs.readdir(CONFIG.inputDir)).filter((file) => file.endsWith('.json')),
    CONFIG.order
  );

  let consecutiveFailures = 0;
  for (const file of files) {
    const extracted = await processors.streamingExtractor.processFile(file);
    if (extracted) {
      consecutiveFailures = 0;
      await processors.streamingNormalizer.processFile(file);
    } else if (++consecutiveFailures >= 5) {
      throw new Error(
        '5 consecutive extraction failures — aborting (check API key / model config)'
      );
    }
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
