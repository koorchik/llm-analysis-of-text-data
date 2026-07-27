import { CountryNameNormalizer } from '../src/CountryNameNormalizer/CountryNameNormalizer';
import { RegistryConsolidator } from '../src/Consolidator/RegistryConsolidator';
import { DataAnalyzer } from '../src/DataProcessors/DataAnalyzer';
import { DataEntitiesCollector } from '../src/DataProcessors/DataEntitiesCollector';
import { DataExtractor } from '../src/DataProcessors/DataExtractor';
import { DataGraphBuilder } from '../src/DataProcessors/DataGraphBuilder';
import { DataNormalizer } from '../src/DataProcessors/DataNormalizer';
import { StreamingExtractor } from '../src/DataProcessors/StreamingExtractor';
import { StreamingGraphBuilder, EdgesFrom } from '../src/DataProcessors/StreamingGraphBuilder';
import { StreamingNormalizer } from '../src/DataProcessors/StreamingNormalizer';
import { DecisionLog } from '../src/DecisionLog/DecisionLog';
import { EmbeddingsBackendOllama } from '../src/EmbeddingsClient/EmbeddingsBackendOllama';
import { EmbeddingsBackendOpenAi } from '../src/EmbeddingsClient/EmbeddingsBackendOpenAi';
import { EmbeddingsBackendVertexAi } from '../src/EmbeddingsClient/EmbeddingsBackendVertexAi';
import { EmbeddingsClient } from '../src/EmbeddingsClient/EmbeddingsClient';
import { EntityRegistry } from '../src/EntityRegistry/EntityRegistry';
import { FlowManager } from '../src/FlowManager/FlowManager';
import { LlmClient } from '../src/LlmClient/LlmClient';
import { LlmClientBackendAnthropic } from '../src/LlmClient/LlmClientBackendAnthropic';
import { LlmClientBackendOllama } from '../src/LlmClient/LlmClientBackendOllama';
import { LlmClientBackendOpenAi } from '../src/LlmClient/LlmClientBackendOpenAi';
import { LlmClientBackendVertexAi } from '../src/LlmClient/LlmClientBackendVertexAi';
import { SchemaRegistry } from '../src/SchemaRegistry/SchemaRegistry';
import { sortByNumericId } from '../src/utils/fsUtils';
import dotenv from 'dotenv';
import fs from 'fs/promises';

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
  edgesFrom: (process.env.EDGES_FROM as EdgesFrom) || 'layered',
};

async function main() {
  console.log(CONFIG);
  // Create LLM client
  const llmClient = createLlmClient();
  const embeddingsClient = createEmbeddingsClient();

  // Create processors
  const processors = createProcessors(llmClient, embeddingsClient);

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

  // Run
  if (CONFIG.steps.length === 1) {
    await flowManager.runStep(CONFIG.steps[0]);
  } else {
    await flowManager.runAllSteps();
  }
}

function createLlmClient(): LlmClient {
  let backend;

  switch (CONFIG.llmProvider) {
    case 'openai':
      backend = new LlmClientBackendOpenAi({
        model: CONFIG.llmModel,
        apiKey: process.env.OPENAI_API_KEY!,
      });
      break;

    case 'ollama':
      backend = new LlmClientBackendOllama({
        model: CONFIG.llmModel,
        apiKey: process.env.OLLAMA_API_KEY,
      });
      break;

    case 'vertexai':
      backend = new LlmClientBackendVertexAi({
        model: CONFIG.llmModel,
        project: process.env.VERTEXAI_PROJECT!,
        location: process.env.VERTEXAI_LOCATION!,
      });
      break;

    case 'anthropic':
      backend = new LlmClientBackendAnthropic({
        model: CONFIG.llmModel,
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });
      break;

    default:
      throw new Error(`Unknown LLM provider: ${CONFIG.llmProvider}`);
  }

  return new LlmClient({ backend });
}

function createEmbeddingsClient(): EmbeddingsClient {
  let backend;

  switch (CONFIG.embeddingsProvider) {
    case 'openai':
      backend = new EmbeddingsBackendOpenAi({
        model: CONFIG.embeddingsModel,
        apiKey: process.env.OPENAI_API_KEY!,
      });
      break;

    case 'ollama':
      backend = new EmbeddingsBackendOllama({
        model: CONFIG.embeddingsModel,
      });
      break;

    case 'vertexai':
      backend = new EmbeddingsBackendVertexAi({
        model: CONFIG.embeddingsModel,
        project: process.env.VERTEXAI_PROJECT!,
        location: process.env.VERTEXAI_LOCATION!,
      });
      break;

    default:
      throw new Error(`Unknown embeddings provider: ${CONFIG.embeddingsProvider}`);
  }

  return new EmbeddingsClient({ backend });
}

function createProcessors(llmClient: LlmClient, embeddingsClient: EmbeddingsClient) {
  const modelDir = llmClient.modelName.replace(/:/g, '-');
  const baseDir = CONFIG.outputDir;
  const inputDir = CONFIG.inputDir;

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
  });

  const dataNormalizer = new DataNormalizer({
    inputDir: dataExtractor.outputDir,
    outputDir: `${baseDir}/normalized/${modelDir}`,
    entitiesFile: `${dataEntitiesCollector.outputDir}/entities.json`,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient }),
    embeddingsClient,
  });

  const dataAnalyzer = new DataAnalyzer({
    inputDir: dataNormalizer.outputDir,
    outputDir: `${baseDir}/analyzed/${modelDir}`,
  });

  const dataGraphBuilder = new DataGraphBuilder({
    inputDir: dataNormalizer.outputDir,
    outputDir: `${baseDir}/analyzed/${modelDir}`,
  });

  // --- Incremental (streaming) flow — spec: docs/streaming-pipeline-spec.md ---
  const incrementalDir = `${baseDir}/incremental/${modelDir}`;

  // Shared state instances: one schema/registry per run keeps the interleaved
  // extract→normalize step coherent (disk is write-only during a run)
  const schemaRegistry = new SchemaRegistry({ filePath: `${incrementalDir}/schema.json` });
  const entityRegistry = new EntityRegistry({ filePath: `${incrementalDir}/registry.json` });
  const decisionLog = new DecisionLog({
    filePath: `${incrementalDir}/decisions.jsonl`,
    enabled: CONFIG.decisionsLog,
  });

  const streamingExtractor = new StreamingExtractor({
    inputDir,
    outputDir: `${incrementalDir}/extractions`,
    preprocessor,
    llmClient,
    schemaRegistry,
    decisionLog,
  });

  const streamingNormalizer = new StreamingNormalizer({
    inputDir: streamingExtractor.outputDir,
    outputDir: `${incrementalDir}/artifacts`,
    llmClient,
    schemaRegistry,
    entityRegistry,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient }),
    decisionLog,
    sourceDir: inputDir,
    preprocessor,
  });

  const streamingGraphBuilder = new StreamingGraphBuilder({
    inputDir: streamingNormalizer.outputDir,
    outputDir: `${incrementalDir}/graph`,
    schemaRegistry,
    edgesFrom: CONFIG.edgesFrom,
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
