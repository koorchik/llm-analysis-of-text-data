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

# StreamingRepairer (phase 2 of every document; on by default)
REPAIR=1                          # default; 0 = RQ3 NAIVE arm, no repairer/GlossIndex constructed
REPAIR_GLOSS_THRESHOLDS=default=0.92    # "Category=0.97,default=0.85" format; unset = built-in
REPAIR_BLOCKER_THRESHOLDS=default=0.88  # same format; unset = built-in
REPAIR_COHERENCE_THRESHOLD=0.5    # drift floor for the alias-coherence probe
REPAIR_TOKEN_CAP=8000             # per-document repair-judge prompt budget
REPAIR_TOP_K=5                    # suspect candidates kept per signal, per event
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

- `streamingPipeline` - Per-document extract → normalize → repair (interleaved; the default;
  repair is phase 2 of `streamingNormalizer`'s own `processFile`, not a separate pass)
- `streamingExtractor` - Extraction stage only (`extractions/`)
- `streamingNormalizer` - Normalization stage only (`extractions/` → `artifacts/`); runs phase-2
  repair per document too, unless `REPAIR=0`
- `streamingGraphBuilder` - Build `graph/nodes.csv` + `graph/edges.csv` (mode via `EDGES_FROM`)
- `streamingRepairer` - Standalone catch-up repair pass for documents past `repairedThrough` (an
  existing corpus, or a run that died mid-stream); requires `REPAIR=1` (the default)
- `dataAnalyzer` - Statistical analysis over `artifacts/`

`registryConsolidator` is no longer a pipeline step. The deferred, manually-triggered consolidator
of the previous revision is deleted as a system component; what remains
(`src/Consolidator/RegistryConsolidator.ts`) is the RQ3 order-robustness batch-reference harness,
run separately via `npm run batch-reference` (`bin/batch-reference.ts`) against a COPY of a run
directory, never against a live pipeline's own output. See `docs/streaming-pipeline-spec.md` §4.3.

Note: never run two processes against the same `incremental/<model>/` directory
concurrently — the shared state files (`schema.json`, `registry.json`) assume a
single writer.

