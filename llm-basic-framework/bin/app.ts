import { CountryNameNormalizer } from '../src/CountryNameNormalizer/CountryNameNormalizer';
import { RegistryConsolidator } from '../src/Consolidator/RegistryConsolidator';
import { DataAnalyzer } from '../src/DataProcessors/DataAnalyzer';
import { DataEntitiesCollector } from '../src/DataProcessors/DataEntitiesCollector';
import { DataExtractor } from '../src/DataProcessors/DataExtractor';
import { DataGraphBuilder } from '../src/DataProcessors/DataGraphBuilder';
import { DataNormalizer } from '../src/DataProcessors/DataNormalizer';
import { StreamingExtractor } from '../src/DataProcessors/StreamingExtractor';
import { StreamingGraphBuilder, EdgesFrom, parseLambda } from '../src/DataProcessors/StreamingGraphBuilder';
import { StreamingNormalizer } from '../src/DataProcessors/StreamingNormalizer';
import { DecisionLog } from '../src/DecisionLog/DecisionLog';
import { EmbeddingsClient } from '../src/EmbeddingsClient/EmbeddingsClient';
import { createEmbeddingsClient as buildEmbeddingsClient } from '../src/EmbeddingsClient/createEmbeddingsClient';
import { EntityRegistry } from '../src/EntityRegistry/EntityRegistry';
import { CostMeter } from '../src/Experiment/CostMeter';
import { RunCard } from '../src/Experiment/RunCard';
import { resolveRunConfig, type ResolvedRunConfig } from '../src/Experiment/RunConfig';
import { hashInputDir } from '../src/Experiment/inputHash';
import { FlowManager } from '../src/FlowManager/FlowManager';
import { LadderDiscovery } from '../src/Ladder/LadderDiscovery';
import { LlmClient } from '../src/LlmClient/LlmClient';
import type { LlmBackendBase, LlmCallOptions } from '../src/LlmClient/LlmClientBackendBase';
import { createLlmBackend as buildLlmBackend } from '../src/LlmClient/createBackend';
import {
  DECISION_STRATEGIES,
  ComemSelectDecision,
  ListwiseMintCandidateDecision,
  createOfflineStrategy,
  isOfflineStrategyId,
} from '../src/Normalization/decision';
import { resolveGenerator } from '../src/Normalization/candidates';
import type { CandidateGenerator, DecisionStrategy } from '../src/Normalization/types';
import { prompts } from '../src/Normalization/PromptProvider';
import { SchemaRegistry } from '../src/SchemaRegistry/SchemaRegistry';
import { sortByNumericId } from '../src/utils/fsUtils';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Flow: 'batch' (legacy pipeline) | 'incremental' (streaming SKEIN v2 pipeline)
const FLOW = process.env.FLOW || 'batch';
if (!['batch', 'incremental'].includes(FLOW)) {
  throw new Error(`Unknown FLOW: ${FLOW}. Available: batch, incremental`);
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

  // M6 decision stage. Unset means the built-in link-judge path — the published Ψ_link behaviour
  // the golden fixture pins — so an unset variable never silently changes what the default arm
  // measures. CONDITION only *names* an arm; this is what selects one.
  // Normalized to undefined when empty: `DECISION_STRATEGY=` must behave exactly like unset, or the
  // run card would record an empty-string arm name that reads as "none" but is not `?? `-defaulted.
  decisionStrategy: process.env.DECISION_STRATEGY || undefined,

  // M5 candidate generation. Unset means `string-sim` — the generator the M2.5 golden fixture pins
  // and the M4 gate is scored against — so the default arm is provably unchanged. Empty behaves as
  // unset, for the same reason DECISION_STRATEGY does.
  candidateGenerator: process.env.CANDIDATE_GENERATOR || undefined,
  candidateK: process.env.CANDIDATE_K === undefined ? undefined : Number(process.env.CANDIDATE_K),
  candidateMinSim:
    process.env.CANDIDATE_MIN_SIM === undefined ? undefined : Number(process.env.CANDIDATE_MIN_SIM),

  // SKEIN v2 ladder bootstrap. N same-model ensemble runs by default (spec floor 3); a
  // comma-separated `provider:model` list switches to a multi-model ensemble. All three knobs
  // fold into the runId — two arms differing only in ladder policy must not share a directory.
  ladderEnsembleN:
    process.env.LADDER_ENSEMBLE_N === undefined ? 3 : Number(process.env.LADDER_ENSEMBLE_N),
  ladderEnsembleModels: process.env.LADDER_ENSEMBLE_MODELS || undefined,
  ladderMinExamples:
    process.env.LADDER_MIN_EXAMPLES === undefined ? 8 : Number(process.env.LADDER_MIN_EXAMPLES),

  // M5 batch flow. Off by default: turning embeddings on changes what DataNormalizer writes, and
  // the committed `normalized/` artifacts must stay byte-identical for anyone who did not ask.
  embeddings: process.env.EMBEDDINGS === '1',

  edgesFrom: (process.env.EDGES_FROM as EdgesFrom) || 'layered',

  // SKEIN v2 λ: merge granularity at fold time (streamingGraphBuilder only, zero LLM calls).
  // e.g. LAMBDA="Software=g2,default=g0"; LAMBDA_INTERPRETIVE=1 opts into folding part-of edges.
  lambda: process.env.LAMBDA || undefined,
  lambdaInterpretive: process.env.LAMBDA_INTERPRETIVE === '1',

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
    order: 'numeric-id', // M7 replaces this with chronological | seededShuffle
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
      ladder: {
        ensembleN: CONFIG.ladderEnsembleN,
        ensembleModels: CONFIG.ladderEnsembleModels ?? null,
        minExamples: CONFIG.ladderMinExamples,
      },
    },
  });

  const runDir = `${CONFIG.outputDir}/experiments/${runConfig.runId}`;
  const costMeter = new CostMeter({ runId: runConfig.runId });
  const llmClient = createLlmClient(backend, costMeter);

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
  const processors = createProcessors(llmClient, embeddingsClient, runDir, candidateGenerator, costMeter);

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
    registryConsolidator: () => processors.registryConsolidator.run(),
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

function createLlmClient(backend: LlmBackendBase, costMeter: CostMeter): LlmClient {
  return new LlmClient({
    backend,
    costMeter,
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
    return new ListwiseMintCandidateDecision({ llmClient, decisionLog });
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
  costMeter?: CostMeter
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
    runId: path.basename(runDir),
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
  const entityRegistry = new EntityRegistry({ filePath: `${incrementalDir}/registry.json` });

  const streamingExtractor = new StreamingExtractor({
    inputDir,
    outputDir: `${incrementalDir}/extractions`,
    preprocessor,
    llmClient,
    schemaRegistry,
    decisionLog,
  });

  // SKEIN v2 ladder bootstrap. Ensemble members: either LADDER_ENSEMBLE_MODELS
  // ("provider:model,provider:model" — the gold annotator's spec format) or N runs of the
  // session model. Member clients share the run's cost meter, so ladder calls are priced.
  const ladderMembers = CONFIG.ladderEnsembleModels
    ?.split(',')
    .map((spec) => spec.trim())
    .filter(Boolean)
    .map((spec) => {
      const [provider, ...modelParts] = spec.split(':');
      const model = modelParts.join(':');
      if (!provider || !model) {
        throw new Error(
          `LADDER_ENSEMBLE_MODELS entry "${spec}" is not provider:model (e.g. anthropic:claude-opus-5)`
        );
      }
      return {
        label: spec,
        client: costMeter
          ? createLlmClient(buildLlmBackend({ provider, model }), costMeter)
          : llmClient,
      };
    });

  const ladderDiscovery = new LadderDiscovery({
    llmClient,
    schemaRegistry,
    entityRegistry,
    decisionLog,
    ensembleN: CONFIG.ladderEnsembleN,
    ...(ladderMembers && ladderMembers.length > 0 ? { members: ladderMembers } : {}),
    minExamples: CONFIG.ladderMinExamples,
  });

  const streamingNormalizer = new StreamingNormalizer({
    inputDir: streamingExtractor.outputDir,
    outputDir: `${incrementalDir}/artifacts`,
    llmClient,
    schemaRegistry,
    entityRegistry,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient, decisionLog }),
    decisionLog,
    sourceDir: inputDir,
    preprocessor,
    ladderDiscovery,
    decisionStrategy: createDecisionStrategy(llmClient, decisionLog),
    // M5: previously hardcoded to StringSimilarityGenerator inside the normalizer, which left every
    // generator M4 shipped with no live caller.
    candidateGenerator,
    ...(CONFIG.candidateK !== undefined ? { candidateK: CONFIG.candidateK } : {}),
    ...(CONFIG.candidateMinSim !== undefined ? { candidateMinSim: CONFIG.candidateMinSim } : {}),
  });

  const streamingGraphBuilder = new StreamingGraphBuilder({
    inputDir: streamingNormalizer.outputDir,
    outputDir: `${incrementalDir}/graph`,
    schemaRegistry,
    entityRegistry,
    edgesFrom: CONFIG.edgesFrom,
    lambda: parseLambda(CONFIG.lambda),
    interpretive: CONFIG.lambdaInterpretive,
  });

  const registryConsolidator = new RegistryConsolidator({
    artifactsDir: streamingNormalizer.outputDir,
    llmClient,
    schemaRegistry,
    entityRegistry,
    decisionLog,
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
    registryConsolidator,
    streamingDataAnalyzer,
  };
}

// Spec §5: per document, extract → normalize (interleaved) so that after any
// document the artifacts + state files are complete for everything seen so far
async function runStreamingPipeline(processors: ReturnType<typeof createProcessors>) {
  const files = sortByNumericId(
    (await fs.readdir(CONFIG.inputDir)).filter((file) => file.endsWith('.json'))
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
