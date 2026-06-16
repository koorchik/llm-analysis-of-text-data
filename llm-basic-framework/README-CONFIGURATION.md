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

# Steps to run (comma-separated)
STEPS=dataExtractor     # or 'dataExtractor,dataNormalizer' etc.
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
```

## Available Steps

- `dataExtractor` - Extract entities from reports
- `dataEntitiesCollector` - Collect and deduplicate entities  
- `dataNormalizer` - Normalize entities and embeddings
- `dataAnalyzer` - Statistical analysis
- `dataGraphBuilder` - Build relationship graphs

