# Configuration

Simple environment-based configuration. No complex abstractions.

## Environment Variables

```bash
# LLM
LLM_PROVIDER=ollama     # 'openai', 'ollama', 'vertexai', 'anthropic'
LLM_MODEL=gpt-oss:20b

# Embeddings  
EMBEDDINGS_PROVIDER=ollama  # 'openai', 'ollama', 'vertexai'
EMBEDDINGS_MODEL=nomic-embed-text

# Directories
INPUT_DIR=../cert.gov.ua-fetcher/data
OUTPUT_DIR=./storage/cert.gov.ua/output

# Flow to run
FLOW=batch              # 'batch' (legacy pipeline) or 'incremental' (streaming SKEIN v2)

# Steps to run (comma-separated, subset of the selected flow's steps)
STEPS=dataExtractor     # batch default; incremental default is 'streamingPipeline'

# Incremental flow options
DECISIONS_LOG=1         # enable decisions.jsonl (link/mint/llm-call events; off by default)
EDGES_FROM=layered      # graph edge mode: 'layered' | 'extracted' | 'cooccurrence'
```

## API Keys (in .env file)

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
VERTEXAI_PROJECT=...
VERTEXAI_LOCATION=...
OLLAMA_API_KEY=...      # optional
```

## Usage Examples

```bash
# Run extraction only
npm start

# Run full pipeline
STEPS=dataExtractor,dataEntitiesCollector,dataNormalizer,dataAnalyzer,dataGraphBuilder npm start

# Use different model
LLM_PROVIDER=openai LLM_MODEL=gpt-4o-mini npm start

# Custom directories
INPUT_DIR=./my-data OUTPUT_DIR=./my-output npm start

# Run the incremental (streaming) pipeline with decision logging
FLOW=incremental DECISIONS_LOG=1 npm start

# Rebuild the streaming graph from extracted relations only
FLOW=incremental STEPS=streamingGraphBuilder EDGES_FROM=extracted npm start
```

## Available Steps

### Batch flow (`FLOW=batch`, default)

- `dataExtractor` - Extract entities from reports
- `dataEntitiesCollector` - Collect and deduplicate entities  
- `dataNormalizer` - Normalize entities and embeddings
- `dataAnalyzer` - Statistical analysis
- `dataGraphBuilder` - Build relationship graphs

### Incremental flow (`FLOW=incremental`)

Streaming pipeline with emergent schema (see `docs/streaming-pipeline-spec.md`).
Outputs to `OUTPUT_DIR/incremental/<model>/`.

- `streamingPipeline` - Per-document extract → normalize (interleaved; the default)
- `streamingExtractor` - Extraction stage only (`extractions/`)
- `streamingNormalizer` - Normalization stage only (`extractions/` → `artifacts/`)
- `streamingGraphBuilder` - Build `graph/nodes.csv` + `graph/edges.csv` (mode via `EDGES_FROM`)
- `registryConsolidator` - Optional manual repair: merge duplicate canonicals, re-stamp artifacts
- `dataAnalyzer` - Statistical analysis over `artifacts/`

Note: never run two processes against the same `incremental/<model>/` directory
concurrently — the shared state files (`schema.json`, `registry.json`) assume a
single writer.

