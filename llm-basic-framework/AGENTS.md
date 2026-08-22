# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Rules

- **NEVER run `git commit` (or `git push`) without the user's explicit approval.** Prepare the change, show what would be committed, and wait for the user to say commit.

## Project Overview

This is a TypeScript-based LLM framework for analyzing Ukrainian cybersecurity incident reports from CERT-UA. The application processes unstructured text reports to extract structured entities (attack targets, hacker groups, countries), normalize data, generate embeddings, and create visualizations.

It also hosts the experiment harness for a research paper comparing entity-normalization approaches
(streaming Ψ_link vs batch Ψ_norm) on a frozen 204-report corpus. These docs cover that work:

- **`docs/RUNNING-EXPERIMENTS.md`** — how to run, replay and score everything. Start here.
- **`docs/REPRODUCE.md`** — setting a fresh clone up to continue the work: what is already
  committed (two baseline arms), local-model recreation, and why runIds change on every commit.
- `docs/RUN-STREAMING.md` — runbook for one streaming run, arm by arm.
- **`docs/GOLD-TABLE.md`** — how to build the gold table (`npm run gold`). Gates every result.
- `docs/normalization-experiments-refactor.md` — the migration plan and milestone status.
- `docs/statistical-protocol.md` — the pre-registered analysis. Read §5 before emitting a `defer`.

**Session start — where the work currently stands.** Read `docs/ENTITY-GRAPH-2026-08-20.md` FIRST:
the §14 "Update, 2026-08-22" paragraph (the recommended configuration — the "v8 package":
`listwise-graph-compact-v8` + `ladder-placed-v2` + `LADDER_MAX_EXAMPLES=50` + the automatic catch-up
pass), then §15a (the package replicated on both `gemma4:12b-64k` and `gemini-3.7-flash`: identity
1.000 held, reachable edge recall +50% relative on both) and §15b (two harness bugs that silently
degraded local arms — never remove the undici dispatcher in `LlmClientBackendOllama`). Open threads
as of 2026-08-22, roughly in value order: (1) kind agreement regression `.750 → .500` — catch-up
edges mislabel `part-of` vs `narrower-of` without document context; (2) full-corpus 204-doc run is
the honest gate for every reportable number; (3) the catch-up-without-placements ablation
(v7 + old ladder + catch-up) was never run and would isolate the one change that carries the gain;
(4) 4 of 52 ladder placements fail to resolve (`Microsoft Windows` lands g0 beside `MS Office` g1);
(5) edge-recall variance on Gemini needs replicates (.545/.545/.364 spread). The all-category arm
runner is `run-allcat.sh` in the session scratchpad — /tmp is wiped on reboot; recreate it per its
own header comment and rebuild subsets from `gold/subsets/*.txt`.

Two things that are load-bearing and easy to break: `test/gate.test.ts` (byte-identity against a
golden fixture — a failure means a measured difference downstream would be the refactor, not the
experiment), and `prompts/` (prompt text is an experimental variable, hashed into every `runId`, so
editing a prompt is meant to fail the suite until `prompts/manifest.json` is updated deliberately).

## Key Commands

### Development
```bash
# Run the main application
npm start

# The application runs through three processing stages:
# 1. Data extraction from raw reports
# 2. Data normalization and embedding generation  
# 3. Data analysis and visualization

# Tests: node:test via ts-node, no build step
npm test        # ~950 tests, ~15s — includes the behaviour gate (test/gate.test.ts)
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
All steps make live LLM/embedding calls **except** `dataAnalyzer` (pure-local t-SNE, free to run). `DataNormalizer` writes `entity.embedding = []` unless `EMBEDDINGS=1`, which is off by default so the committed `normalized/{model}/` corpus stays byte-identical; with it on, the batch flow's output moves under `{runDir}/batch/`.

`FLOW=incremental` selects the streaming SKEIN v2 pipeline instead, with its own steps
(`streamingPipeline`, `streamingExtractor`, `streamingNormalizer`, `streamingGraphBuilder`,
`streamingRepairer`, `dataAnalyzer`). Set `CONDITION` to name the experimental arm and
`DECISIONS_LOG=1` to get a scorable log. `LLM_LOG=0` disables the full request/response transcripts
otherwise written to `<runDir>/llm-calls/` (per document, per operator; `.FAILED` marks calls the
judge could not use). `CANDIDATE_GENERATOR` selects the blocker and
`DECISION_STRATEGY` the judge — the two ports the experiments vary along; both are folded into the
`runId`, so arms cannot share a directory. Since 2026-08-05, repair is synchronous: every document
runs phase 2 (`StreamingRepairer`) inside `streamingNormalizer`'s own `processFile`
(`REPAIR=1` default; `streamingRepairer` as its own step is only the standalone catch-up pass for
a registry whose repair pass never ran). The old deferred, manually-triggered
`registryConsolidator` step is gone — the deleted consolidator's code
(`src/Consolidator/RegistryConsolidator.ts`) survives only as the RQ3 batch-reference harness
(`npm run batch-reference`, run against a COPY of a run directory). Full reference:
`docs/RUNNING-EXPERIMENTS.md`; repair design: `docs/streaming-pipeline-spec.md` §4.3.

### Testing one scoped case (single category, dev subset)

The fast loop for "does this change help category X?" — minutes, not an hour, and no cloud spend.
Every number it produces is **non-reportable** (dev split × single category × subset corpus); it
exists to rank iterations. Full reference: `docs/RUNNING-EXPERIMENTS.md` §3b. Current best-known
knobs are the v8 package in `docs/ENTITY-GRAPH-2026-08-20.md` (§14 update: judge `gemma4:12b-64k` +
`DECISION_STRATEGY=listwise-graph` + `LISTWISE_PROMPT_ID=listwise-graph-compact-v8` +
`LADDER_PROMPT_ID=ladder-placed-v2` + `CANDIDATE_GENERATOR=union-rr`); the flat-partition era it
superseded is `docs/LOCAL-MATCHING-EXPERIMENTS-2026-08-19.md` / `-18.md`, and the blocker-fusion
measurement is `docs/BLOCKER-FUSION-2026-08-20.md`.

Three ingredients make it fast: `CATEGORIES` drops every other category's mentions at plan-build
time, a committed doc subset (`gold/subsets/*.txt`) shrinks the corpus, and pre-seeded frozen
extractions with `STEPS=streamingNormalizer` skip the expensive extraction step entirely.

```bash
# 1. Materialize the subset once (already on disk at /tmp/opencode/software-22 in most sessions)
npm run make-subset -- --list gold/subsets/dev-software-22.txt \
  --from ../storage/cert.gov.ua/fetched --to /tmp/subset-dev-software

# 2. Learn the run directory: start the arm, let it print `RUN <runId> → <runDir>`, Ctrl-C.
#    With STEPS=streamingNormalizer and no extractions yet it exits on its own (ENOENT extractions).
INPUT_DIR=/tmp/subset-dev-software \
  OUTPUT_DIR=../storage/cert.gov.ua/processed/experiments-dev \
  STEPS=streamingNormalizer FLOW=incremental CONDITION=software-<label> CATEGORIES=Software \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:e2b-16k \
  DECISION_STRATEGY=listwise-mint-candidate \
  CANDIDATE_GENERATOR=union-rr CANDIDATE_K=10 CANDIDATE_MIN_SIM=0 \
  REPAIR=0 LADDER_MIN_EXAMPLES=100000 \
  EMBEDDINGS=1 EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=embeddinggemma \
  DECISIONS_LOG=1 npm start

# 3. Pre-seed the frozen gpt-5 extractions into that run dir, injecting the empty `relations` the
#    normalizer iterates unguarded (a bare `cp` crashes on document 1). See RUN-STREAMING.md §4.
RUNDIR=../storage/cert.gov.ua/processed/experiments-dev/experiments/<dated-runId>
mkdir -p "$RUNDIR/extractions"
node -e '
const fs=require("fs"),path=require("path");
const src="../storage/cert.gov.ua/processed/raw-unified/gpt-5", inp=process.argv[2], dst=process.argv[1];
for (const f of fs.readdirSync(inp).filter(f=>f.endsWith(".json"))) {
  const j=JSON.parse(fs.readFileSync(path.join(src,f),"utf8"));
  j.relations ??= []; j.schemaProposals ??= [];
  fs.writeFileSync(path.join(dst,f), JSON.stringify(j,null,2));
}' "$RUNDIR/extractions" /tmp/subset-dev-software

# 4. Rerun the IDENTICAL command from step 2 — same runId, same directory, extraction skipped.
# 5. Score it (free, no LLM calls; --allow-dev is required or evaluate refuses the dev split)
npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software \
  --run "$RUNDIR"
```

`--run` is repeatable: pass the old and new run directories in one `evaluate` call to get both
rows in one table, scored against the same gold. Always re-score the baseline rather than quoting a
number from a doc — gold corrections silently move old figures (the Software baseline moved 0.667 →
0.889 that way).

**The runId moves when the tree goes from clean to dirty.** `readGitState` sets `dirty` from
`git status --porcelain` (untracked files count) but `diffHash` from `git diff HEAD` (they do not).
So the *first* run in a clean tree gets one id and the second gets another — creating the run
directory made the tree dirty. Once an untracked run directory exists the id is stable, which is
why step 2 above must be run before pre-seeding and its id reused. Delete stray bootstrap
directories from the failed first attempt.

**Read the diff, not just the F1.** These slices are ~5 scorable clusters wide, so one merge moves
pairwise F1 by ~0.15, and false merges on pairs gold does not label are invisible to every metric
in the table. Diff the two registries' `categories.<Category>` alias sets before concluding that
the higher number is the better arm — the `gemma4:26b-16k` probe scored 0.571 against e2b's 0.889
while making strictly fewer identity errors.

### Switching LLM Models
Models are configured via environment variables `LLM_PROVIDER`, `LLM_MODEL`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_MODEL`. See `README-CONFIGURATION.md` for details.

### Code Conventions
- No build process - uses ts-node for direct TypeScript execution
- Data lives at the repo root under `storage/cert.gov.ua/` (committed to git), one level up from this subproject — hence the `../storage/...` paths in `bin/app.ts` (override via `INPUT_DIR`/`OUTPUT_DIR`)
- Run directories are `experiments/<YYYY-MM-DD-HHmm>-<runId>/`, timestamped by run start so `ls` reads chronologically. The timestamp is presentation only — it is NEVER part of the `runId` (a config+code hash), never enters logs or run cards, and an existing directory for a runId always wins so a resumed run keeps its original directory. `src/Experiment/runDirName.ts` owns both halves (`resolveRunDir`, `stripRunDate`); anything deriving identity from a directory name must strip the prefix.
- Entry point: `bin/app.ts`
- All processors follow constructor injection pattern with config objects
- Data flows through directories under `storage/`
- Model names in paths replace colons with hyphens (e.g., `llama3.1:70b` → `llama3.1-70b`)
