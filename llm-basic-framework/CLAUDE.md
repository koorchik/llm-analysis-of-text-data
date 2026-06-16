# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript-based LLM framework for analyzing Ukrainian cybersecurity incident reports from CERT-UA. The application processes unstructured text reports to extract structured entities (attack targets, hacker groups, countries), normalize data, generate embeddings, and create visualizations.

## Key Commands

### Development
```bash
# Run the main application
npm start

# The application runs through three processing stages:
# 1. Data extraction from raw reports
# 2. Data normalization and embedding generation  
# 3. Data analysis and visualization

# Note: No test framework is configured yet
# npm test returns "Not implemented yet"
```

### Typecheck
```bash
npx tsc --noEmit   # no build step; strict:true but noUnusedLocals is OFF, so unused imports compile
```

### Environment Setup
Create a `.env` file with these required variables:
```
OPENAI_API_KEY=your_key
VERTEXAI_PROJECT=your_project
VERTEXAI_LOCATION=your_location
ANTHROPIC_API_KEY=your_key
```

## Architecture

### Processing Pipeline
The application follows a 5-stage pipeline orchestrated by `FlowManager`:

1. **DataExtractor** (`src/DataProcessors/DataExtractor.ts`)
   - Reads incident reports and uses LLM to extract entities into a unified format (name, category, role)
   - Outputs to `storage/output/raw/{model-name}/`

2. **DataEntitiesCollector** (`src/DataProcessors/DataEntitiesCollector.ts`)
   - Collects entities across all reports and normalizes names via LLM (deduplication)
   - Supports resumable processing
   - Outputs to `storage/output/entities/{model-name}/`

3. **DataNormalizer** (`src/DataProcessors/DataNormalizer.ts`)
   - Normalizes country names using `CountryNameNormalizer`
   - Applies normalized entity names from the entities collector
   - Generates embeddings for target infrastructure/sector/device entities
   - Outputs to `storage/output/normalized/{model-name}/`

4. **DataAnalyzer** (`src/DataProcessors/DataAnalyzer.ts`)
   - Performs statistical analysis
   - Creates t-SNE visualizations of embeddings
   - Outputs to `storage/output/analyzed/{model-name}/`

5. **DataGraphBuilder** (`src/DataProcessors/DataGraphBuilder.ts`)
   - Builds relationship graphs from normalized data
   - Outputs to `storage/output/analyzed/{model-name}/`

### Multi-LLM Architecture
The system supports multiple LLM backends through a plugin architecture:
- **LlmClient** (`src/LlmClient/LlmClient.ts`) - Main client interface
- Backends: OpenAI, Anthropic, Ollama, Google Vertex AI
- **EmbeddingsClient** (`src/EmbeddingsClient/EmbeddingsClient.ts`) - For text embeddings
- Backends: OpenAI, Ollama, Google Vertex AI

### Key Components
- **Normalizer** (`src/Normalizer/`) - General text normalization utilities
- **validationUtils** (`src/utils/validationUtils.ts`) - LIVR-based validation
- Custom TypeScript definitions in `src/types/` for external libraries

## Development Notes

### Modifying the Pipeline
Configure which steps run via the `STEPS` environment variable:
```bash
# Run single step:
STEPS=dataExtractor npm start

# Run full pipeline:
STEPS=dataExtractor,dataEntitiesCollector,dataNormalizer,dataAnalyzer,dataGraphBuilder npm start
```
All steps make live LLM/embedding calls **except** `dataAnalyzer` (pure-local t-SNE, free to run). `DataNormalizer` embedding generation is currently stubbed (`entity.embedding = []`; the `embed()` call is commented out).

### Switching LLM Models
Models are configured via environment variables `LLM_PROVIDER`, `LLM_MODEL`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_MODEL`. See `README-CONFIGURATION.md` for details.

### Code Conventions
- No build process - uses ts-node for direct TypeScript execution
- Data lives at the repo root under `storage/cert.gov.ua/` (committed to git), one level up from this subproject — hence the `../storage/...` paths in `bin/app.ts` (override via `INPUT_DIR`/`OUTPUT_DIR`)
- Entry point: `bin/app.ts`
- All processors follow constructor injection pattern with config objects
- Data flows through directories under `storage/`
- Model names in paths replace colons with hyphens (e.g., `llama3.1:70b` → `llama3.1-70b`)