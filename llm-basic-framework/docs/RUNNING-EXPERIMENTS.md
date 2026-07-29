# Running the experiments

Everything you need to reproduce, run and score the normalization experiments yourself.

This is the operational guide. Two companions cover the *why*:
`docs/normalization-experiments-refactor.md` is the migration plan and milestone status,
`docs/statistical-protocol.md` is the pre-registered analysis — read §5 before you emit a `defer`
and §6.1 before you generalize any result off this single corpus.

**Building the gold table is a separate guide: `docs/GOLD-TABLE.md`.** Nothing in §6 below can run
until it exists, so start there.

**Milestone status: M1–M4 and M6 are done. M5, M7–M12 are not.** What that means in practice is
called out in [What does not work yet](#what-does-not-work-yet) — read it before you plan a run, so
you do not spend money discovering it.

---

## 1. Setup

```bash
cd llm-basic-framework
npm install
```

Create `.env` in `llm-basic-framework/`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
VERTEXAI_PROJECT=your-project
VERTEXAI_LOCATION=us-central1
OLLAMA_API_KEY=...          # only if your Ollama endpoint requires one
```

Only the provider you actually run needs a key. Nothing here needs Python — the whole pipeline,
metrics, bootstrap and significance tests are TypeScript on Node 24.

Check the tree is sound before anything else:

```bash
npm run typecheck    # tsc --noEmit
npm test             # 437 tests, ~12s — includes the behaviour gate
```

The slow test in there (~6.5s) is **the gate**: it rebuilds all 3,392 candidate lists through the
M4 `StringSimilarityGenerator` and asserts byte-identity against a golden fixture captured before
the refactor. If it passes, the port extraction changed no behaviour. If it fails, stop — a
measured difference downstream would be the refactor, not the arm.

---

## 2. The 30-second tour

Nothing here costs money:

```bash
# 1. What is the frozen corpus?
npm run hash-input -- ../storage/cert.gov.ua/fetched                 # raw reports
npm run hash-input -- ../storage/cert.gov.ua/processed/raw-unified/gpt-5   # extracted entities

# 2. Is the behaviour gate intact?
npm test

# 3. Which decision strategies can be replayed offline?
npm run replay -- --list-strategies
```

Both are 204 files, and they are different stages — do not mix them up:

| directory | contentHash | what it is |
|---|---|---|
| `cert.gov.ua/fetched` | `908f3f60…de92` | the raw CERT-UA reports, the pipeline's input |
| `cert.gov.ua/processed/raw-unified/gpt-5` | `37d57e47…8dff` | extracted entities — what the **normalization** stage consumes, and what the golden fixture pins |

**If a hash does not match, your corpus is not the frozen one** and no number you produce is
comparable to any other. `hash-input` only hashes `.json` files by default (`--ext` to change it),
and the recipe is shared with `RunCard`, so the number a run records and the number you get here
cannot diverge.

---

## 3. Running a pipeline

Both flows are driven by `npm start` and configured entirely through environment variables.

```bash
# Streaming Ψ_link — the system under test
FLOW=incremental CONDITION=psi-link-default LLM_PROVIDER=openai LLM_MODEL=gpt-5 \
  DECISIONS_LOG=1 npm start

# Batch Ψ_norm — the published baseline E1 scores
FLOW=batch CONDITION=psi-norm-default STEPS=dataExtractor,dataEntitiesCollector \
  DECISIONS_LOG=1 npm start
```

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `FLOW` | `batch` | `batch` (Ψ_norm) or `incremental` (Ψ_link) |
| `STEPS` | flow-dependent | Comma-separated subset; see below |
| `CONDITION` | `psi-norm-default` / `psi-link-default` | **Names** the arm — a label in the runId. It does *not* select behaviour; `DECISION_STRATEGY` does |
| `LLM_PROVIDER` | `openai` | `openai`, `anthropic`, `ollama`, `vertexai` |
| `LLM_MODEL` | `gpt-5` | |
| `EMBEDDINGS_PROVIDER` | `ollama` | `ollama`, `openai`, `vertexai`, `http` (§4a) |
| `EMBEDDINGS_MODEL` | `nomic-embed-text` | Keys the vector cache, the price lookup and the runId |
| `EMBEDDINGS_URL` | `http://localhost:8080` | `http` provider only — the sidecar's base URL |
| `EMBEDDINGS_POOLING`, `EMBEDDINGS_NORMALIZE`, `EMBEDDINGS_API_KEY` | unset | `http` provider only. Pooling is **recorded, not applied** — the sidecar does it |
| `OLLAMA_HOST` | unset | Point the embeddings backend at a non-local Ollama |
| `INPUT_DIR` | `../storage/cert.gov.ua/fetched` | |
| `OUTPUT_DIR` | `../storage/cert.gov.ua/processed` | |
| `DECISIONS_LOG` | off | **Set to `1`.** Without it there is nothing to score or replay |
| `DECISION_STRATEGY` | unset | Selects the decision stage (§4). Unset = the built-in `link-judge` path |
| `CANDIDATE_GENERATOR` | unset | Selects the blocker (§4a). Unset = `string-sim`, the arm the M4 gate pins |
| `CANDIDATE_K`, `CANDIDATE_MIN_SIM` | `5`, `0.5` | The golden fixture's values; changing either forks the runId |
| `EMBEDDINGS` | off | `FLOW=batch` only. `1` makes `DataNormalizer` write real vectors — and moves its output into the run directory (§4a) |
| `SEED` | none | Recorded in the run card |
| `TEMPERATURE`, `TOP_P`, `MAX_TOKENS` | unset | Unset means *send nothing* — see below |
| `EDGES_FROM` | `layered` | Graph build only |

Steps for `FLOW=incremental`: `streamingPipeline` (all of them), `streamingExtractor`,
`streamingNormalizer`, `streamingGraphBuilder`, `registryConsolidator`, `dataAnalyzer`.
For `FLOW=batch`: `dataExtractor`, `dataEntitiesCollector`, `dataNormalizer`, `dataAnalyzer`,
`dataGraphBuilder`.

Steps that make **no** LLM calls, and so are free to re-run: `dataAnalyzer` (local t-SNE),
`dataGraphBuilder` and `streamingGraphBuilder` (both build graphs from existing artifacts). Every
other step calls the model.

### Do not set `TEMPERATURE=0` on Anthropic

Opus 4.7+ **rejects** a non-default `temperature`, `top_p` or `top_k` with HTTP 400. Leaving these
unset is the only valid configuration there, and `LlmClient` drops any sampling parameter the
backend declares unsupported rather than sending it. The run card records
`sampling.effective` — what really left the process — separately from what you asked for, so a run
can never claim a `temperature: 0` it never sent. `docs/statistical-protocol.md` §4 defines the
three determinism tiers this creates.

### What a run produces

Each run gets its own directory, `$OUTPUT_DIR/experiments/<runId>/`:

- `run-card.json` — config, git sha, input hash, prompt hashes, effective sampling, cost
- `decisions.jsonl` — one row per decision point and per LLM call (needs `DECISIONS_LOG=1`)

For `FLOW=incremental`, the run's whole state lives there too: `registry.json`, `schema.json`,
`extractions/`, `artifacts/`, `graph/`, `analyzed/`. That is what `evaluate --run <runDir>` reads.

For `FLOW=batch` only the run card and decision log are in the run directory — the artifacts still
go to the shared `$OUTPUT_DIR/{raw,entities,normalized,analyzed}/<model>/` layout. Score a batch arm
with `evaluate --batch <entities.json>`, not `--run`.

`runId = sha256(config + git sha + dirty-diff hash + prompt hashes)`, prefixed with the condition
name. Two arms therefore cannot share a directory and silently resume each other, and **a prompt
edit alone changes the runId** — that is what `prompts/` and `PromptProvider` are for.

If the working tree is dirty the run warns and folds a diff hash into the runId. It will still run;
commit before a real one.

---

## 4. Decision strategies

The decision stage is a port (`src/Normalization/types.ts`), and five strategies implement it.
Select one with `DECISION_STRATEGY`:

```bash
DECISION_STRATEGY=listwise-mint-candidate CONDITION=e2-listwise \
  FLOW=incremental DECISIONS_LOG=1 npm start
```

**Leaving `DECISION_STRATEGY` unset is a sixth path, not a synonym for any of these.** It runs the
built-in `link-judge` call — the published Ψ_link behaviour the golden fixture pins — and that is
deliberately the default, so an unset variable can never quietly change what `psi-link-default`
measures. `listwise-mint-candidate` is its closest relative but uses a different prompt
(`listwise-select`), so the two are separate arms.

Three of the five cost nothing to run:

| id | LLM calls | What it is for |
|---|---|---|
| `exact-only` | none | **The floor.** 2,411 of 2,673 canonicals are singletons, so linking nothing already scores well. Every paid arm must beat this by more than the bootstrap CI |
| `threshold` | none | The similarity pole. Expected to fail informatively — see below |
| `fellegi-sunter` | none | Classical record linkage over an agreement *pattern*, so disagreement counts as evidence |
| `listwise-mint-candidate` | 1 per document | The judge, with mint as an explicit numbered option, k=4 |
| `comem-select` | **1 per mention** | COMEM's published protocol, for comparability. Costs a large multiple of the batched arms |

Two corpus cases are worth knowing because they drive the whole comparison:

- `UAC-0010` retrieves `UAC-0018` at similarity **0.875**, *ahead of* its own alias
  `UAC-0010 (Armageddon)` at **0.8**. Any threshold in (0.8, 0.875] links the wrong one. Fellegi–
  Sunter's `same-digits` comparator contributes negative weight and pulls them apart.
- 73 queries retrieve more than one candidate at similarity exactly **1.0** (the
  `accounts-ukr.net` family — plausible typosquats). No threshold setting fixes that at all.

The three-state outcome is `link | mint | defer`. `defer` is **not** a synonym for mint: it is a
withheld decision, excluded from merge *precision* but counted as a miss in *recall*, and reported
as its own rate. That asymmetry is deliberate — excluding deferrals from both would make "defer
everything" score perfectly. Only `fellegi-sunter` and a `threshold` configured with `deferBand` or
`minMargin` ever defer; the LLM arms never do (an LLM asked to abstain will abstain, so the rate
would reflect prompt wording rather than genuine ambiguity).

---

## 4a. Candidate generators — the retrieval arm (M5)

`CANDIDATE_GENERATOR` selects the blocker. Unset means `string-sim`, which is what
`EntityRegistry.candidates()` was proved byte-identical to on all 3,392 frozen pairs — so leaving it
alone keeps the arm the gate pins. An unknown id is **fatal**, never a silent fallback.

| id | Channel | Notes |
|---|---|---|
| `string-sim` | `string-sim` | Default. `identity` analyzer, `max(levenshtein, token-dice)` |
| `exact` | `exact` | The E2 floor. Similarity 1 or nothing |
| `tfidf-ngram` | `tfidf-ngram` | Char-3gram TF-IDF cosine, IDF over the live registry |
| `bm25` | `bm25` | Word tokens, so it fuses with the char-level channels rather than duplicating them |
| `embedding` | `embedding` | Dense cosine over `EMBEDDINGS_MODEL`. Brute force, **no ANN index** |

`rrf` is deliberately absent: it takes child generators rather than plain options, so it cannot be
built from an id alone. That arrives with M7's config loader.

**This is what makes `threshold` an embedding pole.** `ThresholdDecision` reads
`candidates[0].sim` and nothing else — it has no idea what produced it. The plan's "embedding cosine
≥ 0.8" arm is `CANDIDATE_GENERATOR=embedding` plus `DECISION_STRATEGY=threshold`; without the first
half, "threshold 0.8" is an edit-distance ratio wearing the name.

```bash
# Self-hosted encoder (confidentiality constraint) — needs `ollama pull bge-m3`
FLOW=incremental CONDITION=e2-embed-threshold \
  EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=bge-m3 \
  CANDIDATE_GENERATOR=embedding DECISION_STRATEGY=threshold DECISIONS_LOG=1 npm start
```

Three things to know before reading the numbers:

- **A cosine is clamped to `[0, 1]`, not rescaled.** A negative cosine scores 0 — "no evidence" —
  rather than `(1+cos)/2`, which would put *orthogonal* vectors at 0.5 and let them pass
  `minSim: 0.5`. Every threshold cited from `dong2023reveal` is a similarity threshold, so rescaling
  would silently change what those numbers mean.
- **`sim === 1` never happens.** Floating-point cosine of a vector with itself is `0.9999999999999998`.
  `minSim: 1` retrieves nothing, and the `sim === 1` early exit that is valid for string metrics is
  not valid here.
- **`name+gloss` is currently identical to `name`.** Nothing writes glosses — `EntityRegistry.mint`
  accepts one and `setGloss()` has no callers — so every record's gloss is null. The representation
  ships and warns loudly when selected. Do not report it as evidence that glosses do not help.

### The vector cache

Vectors are cached at `{OUTPUT_DIR}/embeddings-cache/{provider}-{model}.jsonl`, content-addressed by
`(model, text)` and **deliberately outside `experiments/{runId}/`** — a vector is run-independent, so
per-run scoping would re-embed the whole registry on every seed, and ≥3 seeds per condition is the
protocol.

Measured on a 3-document smoke run: cold 16 embedding calls / 59.5 s, warm **0 calls / 3.6 ms**.

**Read `embeddingCache` in the run card, not the call count.** Cache hits are not `CostMeter` calls,
so a fully-cached arm reports zero embedding calls — which reads as "embeddings never ran" unless the
hit count sits beside it. The `COST` line prints `embed cache N hit / M miss` for the same reason.

### Encoders

| Provider | Use | Status |
|---|---|---|
| `ollama` | BGE-M3, self-hosted — satisfies the confidentiality constraint | ✅ verified live |
| `openai` | `text-embedding-3-large` — the cloud arm | ✅ batching + usage implemented; input price still `null` |
| `http` | SecureBERT via a sidecar — settles the published encoder contradiction | ✅ unit-tested against the wire contract; see `tools/securebert-sidecar/` |
| `vertexai` | Spare capacity for a future encoder | ⚠️ **implemented but never called** — see below |

**VertexAI is unverified.** It was a stub returning `[]` before M5 — reachable, silent, and giving
every entity a zero-length vector. It is now a real `:predict` implementation over
`google-auth-library`, and every failure path throws. But `GOOGLE_APPLICATION_CREDENTIALS` was the
placeholder `CHANGE_ME` in this environment, so **no call has ever been made**. Treat the first real
run as the verification step.

### `EMBEDDINGS=1` and the batch flow

`FLOW=batch`'s `DataNormalizer` writes `"embedding": []` by default — exactly as it did before M5, so
the committed `normalized/{model}/` corpus stays byte-identical and nobody pays for a re-run they did
not ask for. With `EMBEDDINGS=1` it embeds one batched request per document (the whitelist is
`Infrastructure`/`Sector`/`Device` × `role: Target`, unchanged) **and the batch flow's output moves to
`{runDir}/batch/`**. That is the only way `DataAnalyzer`'s t-SNE has ever seen a real vector.

---

## 5. Replaying a run through another strategy — free

This is the cheapest thing in the repo and the reason to always set `DECISIONS_LOG=1`.

A decision log records each mention with **the exact candidate list, in the exact order, with the
alias surfaces the judge saw**. So any offline strategy can be scored over the same decision points
without re-running extraction and without re-deriving candidates. Retrieval is held fixed by
construction, so a delta measures the decision rule and nothing else.

```bash
RUN=../storage/cert.gov.ua/processed/experiments/psi-link-default-abc123

# Fidelity check first: replaying a log through the SAME verdicts must reproduce it exactly.
npm run replay -- --in $RUN/decisions.jsonl --verify

# Then score alternative decision rules for free
npm run replay -- --in $RUN/decisions.jsonl --strategy exact-only     --out /tmp/exact.jsonl
npm run replay -- --in $RUN/decisions.jsonl --strategy threshold --threshold 0.8 --out /tmp/t80.jsonl
npm run replay -- --in $RUN/decisions.jsonl --strategy fellegi-sunter --out /tmp/fs.jsonl
```

Flags: `--threshold`, `--defer-band`, `--min-margin` (threshold); `--upper`, `--lower`,
`--no-defer` (Fellegi–Sunter); `--case-sensitive` (exact-only). A typo'd numeric flag is fatal
rather than falling back to the default, so a mislabelled number cannot reach a results table.

Asking to replay `listwise-mint-candidate` or `comem-select` is **refused**, not silently run: those
strategies exist to batch per document, and replaying them a mention at a time is a different arm
with a different cost. Run those live with `CONDITION` set.

**Logs written before M6 have no alias surfaces.** Replay warns loudly when it sees this — the
alias-sensitive arms then scored on canonical names alone, so their numbers are a lower bound, not
a measurement. Re-run to get a current log.

---

## 6. Scoring against gold

```bash
npm run evaluate -- --gold path/to/gold.json --split test \
  --run $RUN_A --run $RUN_B --json results.json
```

Flags: `--run` (repeatable, one per condition), `--batch <entities.json>` for a batch Ψ_norm
artifact, `--split dev|test`, `--json` to write the table, `--allow-dev` to permit dev-split
reporting, `--ignore-categories` for arms whose category vocabulary is emergent.

`--split test` is the default and `dev` requires `--allow-dev` on purpose: the split you report is
a decision that should predate the numbers.

What it computes **today**: merge precision/recall by stratum, mint/NIL accounting, and the CESI
cluster suite (macro/micro/pairwise F1, B³, ARI). Undefined metrics render as `—`, never as `0`.

**Not yet wired into this CLI**, though the modules exist and are unit-tested to the protocol's
parameters: BCa bootstrap CIs (10k, 95%, `src/Evaluation/bootstrap.ts`), paired permutation tests,
Holm–Bonferroni, blocking/candidate recall per channel (`blockingMetrics.ts`) and Kendall τ-b
(`rankCorrelation.ts`). `evaluate` currently emits `downstreamTau: null` and `orderAri: null`
outright. Wiring them up is M7/M11 work — until then, CIs and significance tests must be computed
by calling those modules directly.

### The gold table

**How to build one: `docs/GOLD-TABLE.md`.** `npm run gold` does the mechanical parts (inventory,
pair proposals, transitive closure, singletons, NIL labels, dev/test split); you adjudicate pairs
and source the semantic strata.

The format is `gold-aliases-v1`, and the loader is deliberately strict — it is the reference every number is
measured against, so a malformed table fails at load rather than producing a plausible wrong score.

```json
{
  "version": "gold-aliases-v1",
  "inputContentHash": "37d57e47...",
  "order": "numeric-id",
  "clusters": [
    { "id": "g1", "category": "HackerGroup",
      "members": ["APT28", "Fancy Bear", "АРТ28"],
      "stratum": "b", "split": "test",
      "evidence": [{ "pair": ["APT28", "Fancy Bear"], "snippet": "...", "annotator": "expert" }] }
  ],
  "nilLabels": [
    { "docId": 10, "category": "HackerGroup", "mention": "APT28", "label": "NIL", "clusterId": "g1" },
    { "docId": 42, "category": "HackerGroup", "mention": "APT28", "label": "known", "clusterId": "g1" }
  ]
}
```

Two things the loader enforces rather than assumes, because both are silent-corruption risks:

1. **`nilLabels` is position-indexed, and a flat `{mention: label}` map is rejected outright.** NIL
   is a property of (mention, stream position), not of a mention — `APT28` is NIL at its cluster's
   first occurrence and known at every later one. A flat map cannot represent both and would
   mis-score the entire mint side. Note both rows above, same mention, different answers.
2. **`order` is recorded.** NIL labels are only valid for the stream order they were derived under.
   Replay under a different order and they must be regenerated, not reused. The loader accepts any
   non-empty string, but today runs only ever use `numeric-id` — `chronological` and `seededShuffle`
   are M7 and do not exist yet, so a table claiming one of those cannot be matched by any run you
   can currently produce.

`members` are **surface forms**, not canonical names. `stratum` is the E0 stratum (a–d).

When you annotate, one thing to get right that the source note gets wrong: **`АРТ28` vs `APT28` is
a Unicode confusable case, not a transliteration one** — Cyrillic `Р` is ER, so a transliterator
maps `АРТ28` to `art28`, not `apt28`. They are different mechanisms with different analyzers
(`confusableSkeleton` vs `transliterate`), and putting the pair in the wrong stratum will
mis-attribute the channel in E4.

---

## 7. The behaviour gate

The gate is what lets a measured difference be attributed to an arm rather than to the refactor.

```bash
npm test                                    # the gate runs as part of the suite
npm run capture-golden -- --verify          # explicit check, writes nothing
```

`capture-golden` also takes `--input`, `--out-dir`, `--k` and `--min-sim` for regenerating the
fixture against a different registry or retrieval setting. `hash-input` takes `--manifest` to print
the per-file digests behind a content hash, which is what to reach for when two directories hash
differently and you need to know which file moved.

`test/fixtures/golden-candidates.json` holds 3,392 candidate lists captured from the pre-refactor
code path, plus `test/fixtures/registry-v1.json` (3,360 canonicals). The verify path is path-free
by design — it compares hashes only, so a fixture is not tied to the machine that made it.

Only re-capture (without `--verify`) when you *intend* a behaviour change, and commit the diff
deliberately.

---

## 8. Prompts

All twelve prompts live in `prompts/` as files, are hashed into every run card, and are folded into
the runId. Ten were mechanically **extracted** from inline literals in M6; `listwise-select` and
`comem-select` were authored for their strategies and carry `extractedFrom: null` in the manifest
rather than claiming a provenance they do not have. `prompts/README.md` covers the format and provenance; `prompts/manifest.json` is the
extraction record.

Editing a prompt **fails the test suite on purpose** — the manifest hash no longer matches. Prompt
text is an experimental variable, so changing it should be a deliberate act that also updates the
manifest and therefore every affected runId. For a variant arm, prefer adding a *new* prompt id and
injecting a `PromptProvider` rather than editing the baseline.

`prompts/psi-norm-batch.md` is the published Ψ_norm prompt — the exact artifact E1 scores. Leave it
alone unless you mean to change what E1 measures.

---

## 9. Registry migration

The registry moved from v1 (aliases as plain strings) to v2 (alias records with provenance) in M3.
`parse()` accepts both and `toV1()` projects back, so nothing is stranded.

```bash
npm run migrate-registry -- registry.json --policy first-seen --dry-run
npm run migrate-registry -- registry.json --policy first-seen --out registry-v2.json
```

`--policy` accepts `first-seen`, `frequency-weighted` or `highest-degree`.

Always `--dry-run` first. It reports the detected version, category/canonical/alias counts and **one
sample migrated record**, and writes nothing. Without `--out` the migration rewrites the input file
in place — it does copy the original to `<file>.v1.bak` first, but dry-running is still the cheaper
way to find out you passed the wrong policy.

---

## 10. Cost expectations

Read the run card's cost block rather than guessing — but the shape to expect:

- `exact-only`, `threshold`, `fellegi-sunter` — **zero**. Replay them over an existing log.
- `listwise-mint-candidate` — one judge call per document, so ~204 judge calls plus extraction.
- `comem-select` — one call **per unresolved mention**, a large multiple of the above on this
  corpus. That cost is the finding, not a defect; do a 5-document slice before committing to it.
- `CANDIDATE_GENERATOR=embedding` — one `embed-query` call per unresolved mention plus one
  `embed-index` call per category rebuild, both under their own operator buckets, and both **free on
  the second run** because of the vector cache. Cheap relative to the judge, but the *first* run over
  the frozen corpus pays for every surface.

Guard rail: a call on an unpriced model yields `costUsd: null` and is counted in `unpricedCalls` /
`unpricedModels`. Dated snapshot suffixes (`-2025-01-01`) are stripped for the lookup, so one row
per model alias is enough.

**An embeddings price row needs `outputPerMTok: 0`, not `null`.** `CostMeter.priceFor` only accepts
an entry when *both* legs are non-null, so the natural-looking `{ inputPerMTok: 0.13,
outputPerMTok: null }` reports every embedding call as unpriced rather than as priced on input
alone. There is a regression test for this.

**Read `unpricedCalls`, not the total.** `totals().costUsd` sums the priced calls only, so a run
where nothing was priced reports `$0.0000 (+N unpriced calls)` — a plain zero, not a null. The
zero is not the cost; the `+N` is the warning.

**`config/model-prices.json` is partly unpriced.** The Anthropic models have real rates; `gpt-5`,
`gpt-5.4-nano` and `text-embedding-3-large`'s *input* leg are still `null` pending the
provider-dashboard check (verification item 11). Locally-served encoders (`bge-m3`,
`nomic-embed-text`, `securebert`) and the `ollama`/`http` provider defaults are a real 0 — free at
the margin, with wall-clock still metered. Token counts are already correct everywhere; only the
dollar conversion is missing. Fill those in before quoting any cost figure.

Practical advice for a first live run: point `INPUT_DIR` at a directory of 3–5 reports. The
resulting hash will differ from the frozen corpus, which is correct — such a run is a smoke test,
not a result.

---

## What does not work yet

Honest status, so you do not plan around something that is not there.

**Works now:** both pipelines end to end; run cards and cost metering; the decision log; all five
decision strategies, live via `DECISION_STRATEGY` and offline via `replay`; the gate; registry v2;
analyzers and candidate generators — now **selectable at runtime** via `CANDIDATE_GENERATOR`
(string-sim, exact, TF-IDF, BM25, embedding; RRF fusion awaits M7's config loader); embeddings with
batching, cost metering and a cross-run vector cache; merge P/R, NIL and the CESI suite through
`bin/evaluate.ts`.

**Not built yet:**

- **Gloss writing.** `EntityRegistry` stores a `gloss` and `EmbeddingGenerator` can encode
  `name+gloss`, but nothing ever writes one, so that arm is currently identical to `name` (it warns).
  The judge would have to emit a one-line description at mint time.
- **VertexAI embeddings are unverified** — implemented, never called. See §4a.
- **The SecureBERT sidecar has not been started here** — no Docker daemon. The backend is unit
  tested against the wire contract; the compose file is not.
- **M7 — the experiment CLI and ordering.** No single command runs a full arm matrix; run each arm
  by hand with `CANDIDATE_GENERATOR`, `DECISION_STRATEGY` and `CONDITION`. Stream order is fixed at `numeric-id`;
  `chronological` and `seededShuffle` are not implemented, which matters because the gold table's
  `order` field must match the order a run actually used.
- **M7/M11 — significance testing in the CLI.** The bootstrap, permutation-test, Holm, blocking and
  rank-correlation modules are written and unit-tested, but `bin/evaluate.ts` does not call them
  yet (§6).
- **M9 — the gold table.** No CERT-UA gold table exists yet. `bin/evaluate.ts` and the whole metric
  suite are tested and ready, but until you annotate one there is nothing to score against. This is
  the work you said you would do yourself, and it is the single blocker on every headline number.
- **M12 / E8** — `PairwiseJudgeDecision`, `CascadeDecision`, `VotingDecision`. Note the source
  material records pairwise "comparing" as a *measured negative* — most expensive, and unable to
  recover from one wrong comparison — so it enters as a documented rejection, not a hopeful arm.

**One finding to carry into the write-up:** the published **2,674** canonical figure is not
reproducible from the released artifact. Rebuilding it gives **2,673**, case-sensitively and
insensitively alike. Whatever you report, report that discrepancy with it.

---

## Troubleshooting

**`npx ts-node` behaves oddly** — use `./node_modules/.bin/ts-node`; npx can pull a different
version.

**HTTP 400 from Anthropic** — you set `TEMPERATURE`/`TOP_P`. Unset them (see §3).

**A run resumed something unexpected** — steps skip on `existsSync`. Different arms get different
runIds and so different directories; if you meant a fresh run of the same arm, delete its directory.

**`evaluate` skips a run** — it needs `run-card.json` plus either `registry.json` or a non-empty
`decisions.jsonl`. A run without `DECISIONS_LOG=1` cannot be NIL-scored at all.

**The gate fails** — do not proceed. Either a behaviour change was introduced (find it) or one was
intended (re-capture deliberately).

**A prompt test fails after you edited a prompt** — working as designed. Update
`prompts/manifest.json` and accept that affected runIds change.
