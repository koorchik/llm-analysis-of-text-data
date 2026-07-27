# Code plan: normalization experiment harness

> **Deliverable.** This document is the migration plan. The research design it implements is
> `dissert/wiki/notes/normalization-experiments-cert-ua.md` — that note owns *what* to measure;
> this one owns *what to build*.
>
> **Execution step 0 — establish a baseline commit.** Every file this plan cites by line number is
> currently **untracked working-tree code** (`src/Consolidator/`, `src/DecisionLog/`,
> `src/EntityRegistry/`, `src/SchemaRegistry/`, `StreamingExtractor.ts`, `StreamingNormalizer.ts`,
> `StreamingGraphBuilder.ts`, `fsUtils.ts`, `similarityUtils.ts`, plus modifications to
> `bin/app.ts`, `validationUtils.ts`, `LlmClientBackendAnthropic.ts`). Commit the streaming
> pipeline **and this document**, tag the result, and verify `npx tsc --noEmit` is green at the
> tag. Until that exists there is no revert point, no baseline for M4's byte-identity gate, and the
> `git sha` field in every run card is meaningless. The line numbers below are valid as of that tag
> and will drift afterwards.

## Context

The normalization article (RQ2/RQ5) needs to compare normalization approaches — batch vs
incremental, and a menu of ~40 similarity/decision/repair mechanisms — on the frozen 204-report
CERT-UA corpus. The code cannot express a single one of those comparisons today.

Verified state of `llm-basic-framework` (32 TS files, `tsc --noEmit` currently **green**):

| Blocker | Evidence |
|---|---|
| No seam for similarity | `similarityUtils` hard-imported by 4 files — `stringSimilarity` by `StreamingExtractor.ts:5` and `RegistryConsolidator.ts:6`; `bestMatches` by `EntityRegistry.ts:2` and `SchemaRegistry.ts:3` |
| No seam for prompts | **10** inline literals: `StreamingExtractor.ts:301,328` · `StreamingNormalizer.ts:301,359` · `RegistryConsolidator.ts:180` · `CountryNameNormalizer.ts:20` · **`DataEntitiesCollector.ts:157` (the published Ψ_norm prompt — the artifact E1 scores)** · `DataExtractor.ts:74` · `Normalizer.ts:17,34` |
| No cost data | `LlmClient.send()` returns bare `string`; all 4 backends discard provider `usage` one line before returning |
| No run identity | Output dir is `incremental/{modelDir}` (`bin/app.ts:185,233`). Two variants on one model **collide and silently resume each other** via the `existsSync` skips |
| No metrics, no clustering | Zero hits for precision/recall/F1/ARI/union-find/transitive-closure anywhere in `src/` |
| No tests | `"test": "echo ... && exit 1"`; no framework, no CI |
| No split operator | `RegistryConsolidator` does merge (+move as a side effect) only |
| No order seam | `sortByNumericId` (`fsUtils.ts:18`) is the sole document order, at 5 call sites — and it is **not chronological**: id order has 32 adjacent date inversions over the 204 files |

**Decisions taken with the user:** build everything through E2/E4 (infrastructure, deterministic
algorithms, embeddings, decision strategies) · registry v2 alias-graph now, before any run exists ·
batch Ψ_norm gets instrumentation but its algorithm stays untouched.

**Frozen Stage-1 input:** `storage/cert.gov.ua/processed/raw-unified/gpt-5/` — 204 files,
3,392 unique `(surface, category)` pairs (Domain 1929, Software 882, Organization 174, Sector 121,
Government Body 96, HackerGroup 93, Country 32, Device 31, Individual 19, Infrastructure 15).
All counts re-verified against the directory.

**Content hash — recipe, not a literal.** The previously recorded value
(`70563419bd76…`) is **not reproducible**: sixteen candidate constructions of "content hash of
sorted per-file digests" were tried across two audits and none matches, and the plan never stated
the algorithm. It is therefore withdrawn. Ship **`bin/hash-input.ts`** in M1 as the single
definition — sha256 per file over raw bytes, sorted lexically by filename, joined
`"{filename}  {hexdigest}\n"`, sha256 of that manifest — and have `RunCard` *compute* the hash at
run time rather than copy a constant. Regenerate the value once `bin/hash-input.ts` exists and
record the command, not the number, in this document.

---

## Architecture: five ports

Follow the existing conventions — one PascalCase directory per class, single `params` config object
per constructor, no barrels. The registry-of-implementations pattern already exists in
`graph-data-analyzer/src/AnalysisRegistry.ts` + `analyzers/BaseAnalyzer.ts`; mirror it.

```ts
// src/Normalization/types.ts — all ports in one file

interface Analyzer {                        // string -> matching keys
  readonly id: string;
  keys(value: string, ctx: { category: string }): string[];
}

interface SimilarityMetric {                // pure, synchronous
  readonly id: string;
  score(a: string, b: string): number;
}

interface CandidateGenerator {              // RECALL only — never decides identity
  readonly id: string;
  readonly config: Record<string, unknown>;
  prepare(snapshot: RegistrySnapshot): Promise<void>;
  onRegistryChange(event: RegistryChange): void;
  candidates(query: CandidateQuery): Promise<Candidate[]>;
}

interface DecisionStrategy {                // link | mint | defer
  readonly id: string;
  readonly promptSha256?: string;
  decide(req: DecisionRequest): Promise<{ decisions: Decision[]; usage: LlmUsage[] }>;
}

interface RepairStrategy {
  readonly id: string;
  maybeRepair(ctx: RepairContext): Promise<RepairOp[]>;   // merge | split | move
}
```

Two design rules carried from the research notes:

- **Mint is an explicit candidate in the judge's list, never a similarity threshold**
  (`dong2023reveal`). The current prompt asks for `verdict: link|mint`; the new one lists
  `0. NEW ENTITY` alongside the k candidates.
- **`CandidateGenerator` owns matching-time normalization** (transliteration, confusables, acronym
  expansion) but never changes what is *stored*. Analyzers produce keys; the registry keeps surface
  forms.

---

## Migrations

Each leaves the system runnable.

**Critical path: M1 → M2 → M3 → M4 → M6 → M7 → M9, with M5 after.** M1–M4 alone do *not* reach the
headline experiment: E2's Phase 4.1 design invariants require mint-as-an-explicit-candidate
(**M6**) and chronological replay with 20-document snapshots (**M7**). M5 (embeddings) serves only
the IMPORTANT embedding-threshold conditions and the E4 ablation, so it follows. M9 is the 2–4 week
annotation long pole and starts as soon as M4 lands — verified to need only M1 (`llm-annotate`),
M2 (`close`) and M4 (`pairs`).

**Sequenced deliberately late:** M11 (E9 downstream impact) needs E2 runs to exist, but it is
CRITICAL and belongs to the minimum viable article — schedule it, do not drop it.

### M1 — Instrumentation spine (no behaviour change)

**Widen the LLM contract.** `LlmClientBackendBase.send()` returns
`{ text, usage: { inputTokens, outputTokens }, model, latencyMs, finishReason }` and accepts
`LlmCallOptions { temperature?, seed?, maxTokens?, topP? }`. The usage data already exists in every
provider response and is discarded:

| Backend | Capture from | Seed support |
|---|---|---|
| Anthropic | `message.usage.{input_tokens,output_tokens}` | none — use `temperature: 0` (today `LlmClientBackendAnthropic.ts:17` hardcodes `temperature: 1`) |
| OpenAI | `chatCompletion.usage.{prompt_tokens,completion_tokens}` | `seed` param |
| Ollama | `response.{prompt_eval_count,eval_count}` | `options.seed` |
| VertexAI | `result.response.usageMetadata` | none — use `temperature: 0` (today `:20-21` hardcodes `temperature: 0.2, topP: 0.95`) |

**Sampling parameters become per-call, never per-backend.** All three hardcoded values above are
invisible to the run card today. After M1 they arrive through `LlmCallOptions` and are recorded.

Ripple: 4 backends + `LlmClient.ts` + **10 call sites in 7 files** (`CountryNameNormalizer.ts:27`,
`Normalizer.ts:27,41`, `DataExtractor.ts:199`, `DataEntitiesCollector.ts:181`,
`StreamingExtractor.ts:86,310`, `StreamingNormalizer.ts:314,370`, `RegistryConsolidator.ts:189`).

**Fix while in there:** `LlmClientBackendVertexAi.ts:19` caps `maxOutputTokens: 1024`, which
silently truncates extractions. Make it configurable with a sane default.

**`src/Experiment/CostMeter.ts`** — injected into `LlmClient`, accumulates calls/tokens/$/wall-clock
keyed by `(runId, operator, docId)`. Prices from `config/model-prices.json`.

**`DecisionLog` v2** — open the closed `LlmCallKind` union (`DecisionLog.ts:10`); add
`runId, seed, model, promptTokens, completionTokens, costUsd`. Add a typed `DecisionEvent`
carrying `{mention, category, docId, candidates[{name,sim,channel}], decision: link|mint|defer,
target, confidence}` — exactly the shape the note's Phase 1.1 specifies.

**`src/Experiment/RunConfig.ts` + `RunCard.ts`** — a `runId` derived from a hash of the resolved
config **plus the git sha plus the prompt hashes**. Config alone is not enough: a code or prompt
change would otherwise reuse an existing run directory and the `existsSync` skips would silently
resume across versions. **Output moves to `{OUTPUT_DIR}/experiments/{runId}/`**, which retires the
collision hazard. The run card records config, git sha, prompt hashes, input content hash, seed,
sampling parameters, model ids, resume events, and final cost totals.

**`bin/hash-input.ts`** — the content-hash recipe defined above, used by `RunCard` and runnable
standalone.

**`bin/replay.ts`** — replays logged decision points from a `DecisionEvent` JSONL against a
different `DecisionStrategy`, emitting a new log with the same mention/candidate set. The research
note requires this twice ("E8 and E9 replay it", Phase 1.1; "replay the *identical logged decision
points*", Phase 7.1). It is nearly free once `DecisionEvent` exists and it makes E8 cheap.

**`docs/statistical-protocol.md`** — an M1 deliverable, written **before any result exists**
(Phase 1.4 is CRITICAL and explicitly about the garden of forking paths). It must fix: the
significance test for headline deltas (paired permutation test over documents is the default
choice — see M2), the bootstrap CI method and resampling unit, how the ≥3 seeds are aggregated,
and the documented substitute for providers without a seed — for Anthropic and VertexAI a "seed"
is three independent `temperature: 0` replicates, which is a weaker claim and must be stated as
such in the paper's threats to validity.

**Instrument the two blind spots:** `CountryNameNormalizer` (LLM calls invisible today) and
`DataEntitiesCollector` (batch — console.time only). Algorithm untouched.

**Tooling:** `node:test` + `ts-node/register` (zero new runtime deps, works with the CJS setup);
add `@types/node`; add `test` and `typecheck` npm scripts; add `include`/`exclude` to
`tsconfig.json` (currently absent, so every new file is auto-typechecked); drop the junk `install`
and `npm` dependencies.

### M2 — Evaluation suite (pure, offline, unit-tested first)

The note warns these are "easy to implement subtly wrong; test before trusting" — so tests come
before any experiment consumes them.

- `src/Evaluation/unionFind.ts` — nothing like it exists; needed by gold closure, repair and metrics
- `src/Evaluation/partition.ts` — extract partitions from four sources: a registry, gold, a decision
  log, **and the batch `entities.json` name→name map**
  (`storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json`). That fourth source is the
  only artifact E1 can be scored from — omitting it makes the CRITICAL Ψ_norm baseline unscoreable
- `src/Evaluation/clusterMetrics.ts` — macro / micro / pairwise F1 (CESI suite), B³, ARI
- `src/Evaluation/nilMetrics.ts` — mint/NIL P/R/F1 (`dong2023reveal` accounting)
- `src/Evaluation/blockingMetrics.ts` — candidate recall@k, pair completeness, reduction ratio
- `src/Evaluation/bootstrap.ts` — bootstrap CIs over documents and clusters, **plus the paired
  permutation test** named in `docs/statistical-protocol.md`. CIs alone do not satisfy Phase 1.4
- `src/Evaluation/streamCurves.ts` — the three per-stream curves the note marks CRITICAL and the
  original plan omitted: **registry cluster growth** (sub-linear microclustering, the over-merge
  sanity check), **new-canonical arrivals** (the predicted Heaps-law decay — RQ5's headline
  figure), and **fast-path hit rate** over the stream
- `src/Evaluation/rankCorrelation.ts` — Kendall τ-b with tie handling, plus top-k overlap. Consumed
  by M11
- `src/Evaluation/gold.ts` — load/validate the gold table, dev/test guard
- `*.test.ts` beside each, with toy partitions of known score

**Every metric takes a stratum dimension.** Per-stratum merge P/R is the paper's framing device
(strata a–d reported separately, never averaged — the two-claims framing), so `clusterMetrics` and
`nilMetrics` accept a stratum tag per gold pair and emit per-stratum breakdowns, not just totals.

**The gold table's on-disk schema is defined here**, in M2, even though M9 produces it — the loader
must not be written against an undefined format:

```jsonc
{ "version": "gold-aliases-v1",
  "inputContentHash": "…",
  "clusters": [ { "id": "g0007", "category": "HackerGroup",
                  "members": ["APT28", "Fancy Bear", "УАЦ-0028"],
                  "stratum": "c",                       // a | b | c | d
                  "split": "test",                      // dev | test
                  "evidence": [ { "pair": ["APT28","Fancy Bear"],
                                  "snippet": "…also known as…",
                                  "source": "mitre:G0007",
                                  "annotator": "expert" | "llm" | "kb",
                                  "rationale": "…" } ] } ],
  "nilLabels": { "…": "…" } }   // mention -> NIL|known, relative to a registry prefix
```

Gold stores **cluster membership, not canonical names** (see M9).

`bin/evaluate.ts` scores any set of runs against gold and emits the composed results table —
rows = conditions, columns = per-stratum merge P/R, NIL F1, cluster F1, calls/tokens/$, downstream
τ (from M11), order-ARI where applicable.

### M3 — Registry v2: alias graph with provenance

Enables split/move repair, gloss embeddings and external KB ids. Done now, before any registry
exists on disk.

```jsonc
{ "version": 2,
  "categories": { "HackerGroup": { "APT28": {
    "aliases": [ { "surface": "APT28 (UAC-0028)", "docId": 40102, "decision": "link",
                   "confidence": 0.9, "evidence": "…also known as…", "addedBy": "run-abc" } ],
    "gloss": "Russian state-sponsored threat actor",     // written by the judge at mint time
    "externalIds": { "mitreAttack": "G0007", "wikidata": null },
    "categoryCounts": { "HackerGroup": 12 },              // for soft category blocking later
    "firstSeen": { "doc": 37788, "date": "16.03.2022" } } } } }
```

Reader accepts v1 and v2; writer emits v2; `bin/migrate-registry.ts` converts.

**Two real bugs to fix here:**
- `EntityRegistry.applyMerges` (`:119-140`) applies `from→into` sequentially with a
  `records[from] && records[into]` guard (`:124`) that causes **order-dependent silent loss of
  chained merges**. `[{A→B},{B→C}]` succeeds; `[{B→C},{A→B}]` drops `A→B` because B no longer
  exists. Order-dependence is worse than unconditional breakage — the same merge set produces
  different registries run to run. Replace with union-find closure from M2.
- Add a genuine **`split`** operator (edge removal + deterministic re-stamp) and a standalone
  **`move`**; today only merge exists, and move only as a side effect of a category merge.

**Canonical-label choice becomes explicit.** The research note calls this out directly ("the plan
never says *how* the canonical surface form is chosen — fix that"). v2 records a
`canonicalPolicy` per registry: `first-seen` (the current implicit behaviour, and the streaming
default) vs `frequency-weighted` (`vashishth2018cesi`) vs `highest-degree` (`shu2026latticekg`).
It is a recorded configuration choice, not an accident of insertion order.

### M4 — Analyzers, metrics, candidate generators

`src/Normalization/analyzers/` — `identity` · `transliterate` (ISO 9 / KMU 55-2010 / BGN-PCGN) ·
`confusableSkeleton` (UTS #39) · `acronym` · `domainCanonical` (NFKC, case-fold, strip-www,
punycode/IDN, eTLD+1 via Public Suffix List) · `identifierRegex` (`UAC-####`, `CVE-*`, hashes,
IP/CIDR, ASN).

`src/Normalization/metrics/` — `levenshtein` (wrap existing) · `damerau` · `jaroWinkler` ·
`tokenDice` (wrap existing) · `charNgramTfidf` · `composite` (max / weighted).
**`mongeElkan` is dropped** — the note rates it ★ "document as considered-and-rejected", so it
belongs in the paper's rejection list, not in the codebase.

`src/Normalization/candidates/` — `ExactMatchGenerator` (the E2 floor) ·
`StringSimilarityGenerator(analyzers, metric)` · `TfidfNgramGenerator` · `Bm25Generator` ·
`RrfFusionGenerator(children[])` (the E4 union arm).

**Structural change:** `EntityRegistry.candidates()` (`:57`) is removed. The registry keeps storage
+ exact `resolve()` and gains a read-only `snapshot()`. Generators consume snapshots. Retire
`bestMatches` from `similarityUtils` once its **two** importers (`EntityRegistry.ts:2`,
`SchemaRegistry.ts:3`) are migrated; `stringSimilarity`'s two importers
(`StreamingExtractor.ts:5`, `RegistryConsolidator.ts:6`) migrate separately.

**Regression gate:** `StringSimilarityGenerator` with `identity` analyzer + `max(lev, dice)` must
reproduce the current `candidates()` output **exactly** on the frozen input. Assert byte-identity in
a test before anything else changes.

**How to capture the golden output** — the gate is not runnable as stated, because `candidates()`
needs a populated registry and none exists on disk. Sequence it explicitly:

1. **Before** touching `EntityRegistry`, build a deterministic fixture registry by replaying the
   3,392 frozen `(surface, category)` pairs through exact-`resolve()`-then-mint (no LLM), in
   `sortByNumericId` order, and commit it as a test fixture.
2. Record `candidates()` output for every pair against that fixture → `golden-candidates.json`.
3. Capture this **before the M3 v2 format change**, or the fixture and the golden file must be
   regenerated through the v1→v2 migrator and the gate proves nothing.
4. Only then remove `candidates()` and assert the generator reproduces the golden file byte for
   byte.

**Deterministic tie-break.** `similarityUtils.ts:61` sorts `b.sim - a.sim`, so equal-similarity
candidates come back in registry insertion order — run-dependent. Since the note mandates
similarity-ordered top-k *precisely because* position bias is real, ties must break on a stable
key: sort by `(-sim, canonicalName)`. Fix this in the golden capture, not after.

### M5 — Embeddings

`EmbeddingsClient.embed()` accepts `string | string[]` (both OpenAI and Ollama support batching
natively; the current one-at-a-time loop is pure waste), captures usage, and reports `modelName`.
The VertexAI backend is a stub returning `[]` — either implement or delete it.

New: `src/utils/vectorUtils.ts` (cosine, normalize — none exists today).

`EmbeddingGenerator` with pluggable representation: `name` · `name+gloss` · `name+category` ·
cluster representation `centroid | mean | max-over-aliases`. Encoders: **BGE-M3 via Ollama**
(self-hosted, satisfies the confidentiality constraint), `text-embedding-3-large`, SecureBERT —
the last two settle the published encoder contradiction the note flags as a free finding.

**SecureBERT needs a serving path that does not exist.** `EmbeddingsClient` has three backends —
OpenAI, Ollama, VertexAI — and none serves a HuggingFace RoBERTa-family model, so the
encoder-contradiction arm currently depends on unbuilt infrastructure. Resolve it one of two ways
before committing to the arm: (a) convert SecureBERT to GGUF and serve it through the existing
Ollama backend — cheapest, reuses the confidentiality story; or (b) a small local
`EmbeddingsBackendHttp` pointing at a `sentence-transformers` sidecar. If neither is affordable,
**demote the arm explicitly** and record the consequence — the published contradiction
(`cheng2025ctinexus` vs `yang2026ctithinker`) stays unsettled and the "free finding" is forfeited.

**Scale honesty:** brute-force cosine over ~2,674 canonicals, explicitly **no ANN index**. Write
that into the paper as a documented rejection.

### M6 — Decision strategies

`src/Normalization/PromptProvider.ts` — extract **all 10** inline prompts to versioned template
files under `prompts/`, hash each into the run card. The four the original inventory missed matter:
**`DataEntitiesCollector.ts:157` is the published Ψ_norm normalization prompt** — the exact
artifact E1 exists to score, and Phase 1.5 requires every run to record its prompt text — plus
`DataExtractor.ts:74` and `Normalizer.ts:17,34`. This is what makes E8 (judge swap) and prompt
sensitivity measurable at all.

`src/Normalization/decision/` — **MVA set, build first:** `ExactOnlyDecision` (floor) ·
`ThresholdDecision` (embedding cosine ≥0.8 pole) · `ListwiseMintCandidateDecision` (current judge,
upgraded so mint is an explicit list item, k≈4, similarity-ordered — position bias is real) ·
`ComemSelectDecision` · `FellegiSunterDecision` (non-LLM statistical pole, runs alongside E1).

**Deferred to M12 (E8, budget-dependent):** `PairwiseJudgeDecision` ·
`CascadeDecision(ranker, selector)` · `VotingDecision(child, rounds)`. These serve Phase 7, which
the note marks budget-dependent; with `bin/replay.ts` from M1 they can be added at any time
without touching the orchestration.

Add the third state: `link | mint | **defer**`.

**`defer` needs gold semantics before it is emitted.** The gold table is link/mint only, so a
deferred decision has no defined score. Fix the convention here: a `defer` counts as a **withheld
decision** — excluded from merge P/R, counted in a reported *deferral rate*, and scored as a miss
in recall-oriented totals. State it in `docs/statistical-protocol.md` so the choice predates the
numbers.

**Bug to fix here:** `StreamingNormalizer.ts:318` keys `batchByMention` by name only while the batch
is deduped by `category|name`. One document with the same string under two categories silently
loses a verdict (confirmed: `atera` as Organization and Software in doc 6280099). Key by
`${category}|${name}` and use `verdict.category` on lookup.

### M7 — Orchestration and the experiment CLI

`src/Normalization/runs/` — `StreamingRun` (Ψ_link; `StreamingNormalizer.processFile` L126-159
becomes a composition of the ports) · `BatchRun` (wraps `DataEntitiesCollector`, algorithm
untouched) · `ExactMatchRun` · `EmbeddingThresholdRun`.

`src/Experiment/DocumentOrder.ts` — `chronological` and `seededShuffle(seed)`.

**This is a behaviour change, not a rename.** `sortByNumericId` sorts by filename/`metadata.id`,
which is **not** date order: measured over the 204 frozen files, id order contains **32 adjacent
date inversions**. Phase 4.2 requires replay in date order, so:

- `DocumentOrder` operates on loaded documents with **parsed** dates, not on filenames. Dates are
  `dd.mm.yyyy` strings (e.g. `"17.01.2020"`) — naive string sort is wrong.
- Tie-break is `(date, numeric id)`, stated explicitly so identical dates replay deterministically.
- Replace `sortByNumericId` at the **3 stream-order call sites** only —
  `StreamingExtractor.ts:62`, `StreamingNormalizer.ts:77`, `RegistryConsolidator.ts:217`. The other
  two (`StreamingGraphBuilder.ts:53`, `bin/app.ts:303`) are output ordering, not stream order, and
  stay as they are.
- `seededShuffle` names its PRNG — **mulberry32**, seeded from the run's `seed` — because JS has
  no seedable `Math.random` and "seeded shuffle" is otherwise unreproducible. Required for the
  order-robustness arm.

Registry snapshots every 20 documents (the note's Phase 4.2).

`bin/experiment.ts` — run one condition or a matrix, ≥3 seeds per LLM condition:

```bash
npm run experiment -- --config experiments/E2-psi-link.json --seeds 1,2,3
npm run experiment -- --matrix experiments/E4-retrieval.json
```

```jsonc
// experiments/E2-psi-link.json
{ "condition": "psi-link-baseline",
  "orchestration": "streaming",
  "input": { "path": "…/raw-unified/gpt-5" },   // contentHash computed by bin/hash-input.ts
  "candidates": { "id": "string-sim", "params": { "analyzers": ["identity"],
                  "metric": "max-lev-dice", "k": 4, "minSim": 0.5 } },
  "decision": { "id": "listwise-mint-candidate",
                "model": { "provider": "openai", "model": "gpt-5", "temperature": 0 } },
  "repair": { "id": "none" },
  "order": "chronological" }
```

**Validate the model/sampling combination against the live API before committing this example.**
Reasoning-class OpenAI models reject or ignore `temperature` on some endpoints; if `gpt-5` does,
the config is wrong on paper and the determinism story for the *one* provider that supports `seed`
collapses. A single throwaway call settles it.

**Per-category policy dispatch (E3) must be expressible in the schema.** As written, a run has one
candidate generator and one decision strategy, so E3 — dispatch Domain to deterministic
canonicalization, Country to a gazetteer, open categories to the LLM — cannot be configured at
all, and novelty statement 1(iv) has no implementation. Add an optional `policies` block plus a
`PolicyDispatchRun` that routes by category and logs a **policy-vs-LLM disagreement diff** (the
audit set the note asks for):

```jsonc
"policies": {
  "Domain":         { "candidates": { "id": "exact", "params": { "analyzers": ["domainCanonical"] } },
                      "decision":   { "id": "exact-only" } },
  "Country":        { "decision": { "id": "gazetteer", "params": { "source": "iso3166+geonames-ua" } } },
  "*":              { "decision": { "id": "listwise-mint-candidate" } }
}
```

### M9 — Gold table tooling (E0) — start as soon as M4 lands

`bin/gold.ts` with subcommands `pairs` → `sample-domain` → `annotate` → `llm-annotate` →
`agreement` → `retest` → `close` → `split` → `freeze` → `package`.

- `pairs` generates the four strata: **(a)** string similarity · **(b)** transliteration/confusable
  matches invisible to raw similarity · **(c)** seeded from MITRE ATT&CK + MISP galaxy alias tables
  · **(d)** post-cutoff `UAC-####` designations + held-out canonicals. Plus the **acronym
  micro-stratum** the note asks for as its own class (СБУ ↔ Security Service of Ukraine), driven by
  M4's `acronym` analyzer — an alias class neither edit distance nor name embeddings catch
- **`sample-domain`** implements the note's Phase 2.6: Domain is 1,929 names, 53% of the inventory
  and dominated by trivially distinct strings. Sample rather than exhaustively pair, with a
  recorded, reproducible sampling rule the paper can describe
- `annotate` is an evidence-first CLI: every positive merge requires a provenance snippet. Each
  record carries `annotator`, `rationale` (mandatory on every adjudicated disagreement) and
  `minutesSpent` — **annotation hours are a reported HITL cost and a result in themselves**
  (Phase 2.7)
- `llm-annotate` uses a model family **different from every system under test**
- **`agreement`** computes and reports expert-vs-LLM agreement **per stratum**. **`retest`**
  re-serves a random 10% sample for re-annotation after ≥2 weeks and reports intra-annotator
  agreement. These two are not optional polish: the Phase 2 gate is literally "agreement metrics
  reported per stratum (LLM-cross + test-retest)", and under the single-annotator protocol this
  tooling **is** the validity argument that replaces inter-annotator κ
- `close` runs union-find (M2) and additionally emits **NIL/known labels relative to a registry
  prefix** — for each document position in the stream order, which mentions are NIL against the
  registry as it stood. Without this, streaming replay cannot be scored (Phase 2.4)
- `split` partitions **by cluster** ~20/80 dev/test; `freeze` content-hashes as `gold-aliases-v1`
- **`package`** emits the public release bundle — gold table, evidence snippets, annotation
  guideline, agreement reports, licence notes. The note frames the gold table as a *contribution*,
  not infrastructure (Phase 2.8, novelty statement 5), and the same command serves Phase 9.7

`src/Resources/` fetchers **for E0 gold**: ATT&CK STIX (`aliases` vs `x_mitre_aliases` field trap —
element [0] is the object's own name), MISP galaxy `clusters/threat-actor.json`, Wikidata SPARQL
(`uk`+`en` labels/altLabels).

The **GeoNames `UA`** and **NVD CPE** fetchers move out of M9 into the E3 work — they serve the
type-conditioned policy ablation (Country gazetteer, Software canonical names), not gold
construction, and M9 is the 2–4 week long pole that should carry nothing it does not need.

**Gold stores cluster membership, not canonical names** — batch normalizes to English canonicals
while streaming links to first-seen surface forms, so any name-based gold would be invalid across
arms.

### M11 — Downstream analytical impact (E9) — after the first E2 runs

**This was missing from the plan entirely, and it is CRITICAL and inside the note's minimum viable
article.** Phase 5 is the paper's "so what": merge quality must be shown to change *conclusions*,
not just metrics. Effort is "days" — it is pure recomputation over artifacts that already exist —
but nothing in M1–M9 builds it, and `graph-data-analyzer/` was never referenced by this plan at
all.

`bin/downstream.ts` — for each E2 condition:

1. Read `experiments/{runId}/registry.json`, re-stamp the normalized entity artifacts.
2. Rebuild the graph via `StreamingGraphBuilder`.
3. Run the existing `graph-data-analyzer` analyzers — `ActiveHackerGroupsAnalyzer` already produces
   the ranked actor profiles with `totalAttackWeight` that are the Tables 2–5 analyses of
   `turskyi2025formal`; `TopIncomingAttacksAnalyzer` and `SoftwareTargetsAnalyzer` give the target
   weights.
4. Build the **gold-normalized reference graph** the same way, from the frozen gold partition
   rather than from a run's registry. This is the comparison target and has no other home.
5. Score with `src/Evaluation/rankCorrelation.ts` (M2): Kendall τ-b against the reference ranking,
   plus top-k overlap at k ∈ {5, 10, 20}.
6. Emit the diff that finds **one narrated case** — an actor whose rank crosses the top-10
   boundary because of a single normalization error. The note asks for exactly one, narrated.

Output feeds the τ column of `bin/evaluate.ts`'s composed table.

---

## Directory layout

```
src/Normalization/{types.ts, PromptProvider.ts, analyzers/, metrics/, candidates/, decision/,
                   repair/, runs/}
src/Experiment/{RunConfig.ts, RunCard.ts, CostMeter.ts, DocumentOrder.ts, ExperimentRunner.ts}
src/Evaluation/{unionFind.ts, partition.ts, clusterMetrics.ts, nilMetrics.ts, blockingMetrics.ts,
                bootstrap.ts, streamCurves.ts, rankCorrelation.ts, gold.ts, *.test.ts}
src/Resources/{AttackStix.ts, MispGalaxy.ts, Wikidata.ts}        // GeoNames, NvdCpe → E3
bin/{app.ts, experiment.ts, evaluate.ts, gold.ts, replay.ts, downstream.ts, hash-input.ts,
     migrate-registry.ts}
docs/statistical-protocol.md
prompts/*.md          experiments/*.json          config/model-prices.json
```

Out of scope for this plan, deliberately, **all four declared**: **M8 repair strategies** (E6),
**M10 external baselines** (CESI runner, ReVerb45K adapter), **M12 extra decision strategies**
(`PairwiseJudgeDecision`, `CascadeDecision`, `VotingDecision` — the budget-dependent half of E8,
cheap to add later because `bin/replay.ts` lands in M1), and **E7 micro-batch window plus NIL
clustering**. M3 lays the foundation for M8 and M10 so neither needs a second format change.

E7 deserves a note rather than silence: the research design flags NIL clustering — deciding
whether several would-be mints inside one window denote the *same* new entity — as a ★★★ genuinely
uncovered contribution that `dong2023reveal` names as future work and no published system does. It
is cheap once M6 and M7 exist. It is excluded here only because it is OPTIONAL in the note and the
critical path is already long; revisit it if E2 lands early.

---

## Traceability — research phase → migration

The note owns *what* to measure and this plan owns *what to build*, so the join has to be written
down or requirements go missing silently. They did: E9 was absent from the first draft of this
plan, and it is inside the minimum viable article. Anything CRITICAL in the note with no migration
in this column is a defect in **this** document.

| Research note | Migration | Note |
|---|---|---|
| P1.1 decision log · P1.2 cost meter · P1.5 config versioning | M1 | |
| P1.3 metric suite (+ per-stratum, growth curve) | M2 | `streamCurves.ts` covers 4.5/4.6 |
| P1.4 statistical protocol | M1 (`docs/statistical-protocol.md`) + M2 (permutation test) | must predate results |
| P2 / E0 gold, all four strata + acronym | M9 | |
| P2.3 agreement, test-retest, rationale · P2.6 Domain sampling · P2.7 hours · P2.8 release | M9 | the E0 gate |
| P2.4 closure + prefix-relative NIL labels | M9 `close` + M2 `unionFind` | |
| P3.1 / E1 Ψ_norm scored | M7 `BatchRun` + M2 `partition.ts` batch-map source + M6 prompt hash | |
| P3.2 CESI · P3.3 ReVerb45K anchor | **M10 — out of scope** | declared |
| P3.3 Fellegi–Sunter pole | M6 | |
| P4 / E2 all conditions + invariants | M4 + M5 + M6 + M7 | |
| **P5 / E9 downstream impact** | **M11** | CRITICAL, in the MVA |
| P6 / E4 retrieval ablation | M4 + M5 + M2 `blockingMetrics` | the mandatory ablation |
| P6 / E6 repair | **M8 — out of scope**; M3 lays split/move, M7 lays order | declared |
| P6 / E3 type-conditioned policies | M4 analyzers + M7 `policies` block + GeoNames/NVD fetchers | |
| P7 / E8 judge swap | M1 `bin/replay.ts` + M12 (pairwise/cascade/voting) | budget-dependent |
| P7 / E5 KB grounding | M3 `externalIds` + M9 `src/Resources/` | OPTIONAL |
| P7 / E7 micro-batch + NIL clustering | **out of scope** | declared, with regret |
| P8.1 CIs + significance · P8.4 composed table | M2 + `bin/evaluate.ts` | |
| P8.3 error taxonomy | `bin/evaluate.ts` decision-log × gold diff | thin — expand if the taxonomy grows |
| P9.7 release package | M9 `package` | |

## Verification

0. **Baseline tagged.** The streaming pipeline is committed and `npx tsc --noEmit` is green at the
   tag (execution step 0). Nothing below is meaningful without it.
1. **Typecheck stays green.** `npx tsc --noEmit` passes today over 32 files with zero errors —
   treat any new diagnostic as introduced. Wire it into a `typecheck` script. **Note there is no CI
   today** — `.github/` contains only `dependabot.yml` — so "wire it into CI" is new
   infrastructure; budget it or run the script in a pre-commit hook and say so.
2. **Metric unit tests first** (M2). Toy partitions with hand-computed macro/micro/pairwise F1, B³
   and ARI, including the degenerate cases: all-singletons, one-big-cluster, perfect match. Add
   per-stratum breakdown tests — a metric that is right in aggregate and wrong per stratum would
   invalidate the paper's central framing.
3. **Statistical protocol exists before any result** (M1). `docs/statistical-protocol.md` is
   committed, names the significance test, and predates the first `experiments/` directory. This is
   checkable by commit date, and it is the specific thing reviewers probe for.
4. **Behaviour-preservation gate** (M4). `StringSimilarityGenerator(identity, max-lev-dice)` must
   reproduce `EntityRegistry.candidates()` byte-identically on all 3,392 frozen pairs, against the
   committed fixture registry and golden file captured before the M3 format change. This is the
   test that makes the refactor safe.
5. **Instrumentation smoke test** (M1). One 5-document run emits a decision log with non-zero token
   counts from every backend, and a run card whose cost totals equal the log's sum.
6. **Content hash is reproducible.** `bin/hash-input.ts` run twice gives the same value, and the
   value `RunCard` records equals it.
7. **Replay fidelity** (M1). `bin/replay.ts` fed a log and the *same* decision strategy reproduces
   the original decisions exactly. Without this, E8's numbers measure the replayer, not the judge.
8. **Order correctness** (M7). `chronological` produces a strictly non-decreasing date sequence
   over the 204 files, and differs from `sortByNumericId` at the 32 known inversions.
9. **End-to-end** (M7). Two conditions differing only in seed produce two distinct
   `experiments/<runId>/` directories with no collision, and `bin/evaluate.ts` scores both against
   a stub gold table.
10. **Downstream gate** (M11). Two E2 conditions produce two rebuilt graphs, a τ against the
    gold-normalized reference for each, and at least one identified top-10 rank crossing.
11. **Cost sanity.** Full Ψ_link replay over 204 documents ≈ 200 judge calls per condition. But the
    protocol is ≥3 seeds × 5 E2 conditions + 3 seeds for E1 + the E4 arms, so budget the
    **aggregate** (order 4–5k judge calls), not the per-condition figure. Compare the meter's total
    against the provider dashboard once, to validate the price table.

## Risks

1. **Scope.** Ten migrations is a multi-week program. M1–M4 alone unblock the gold table, which is
   the 2–4 week annotation long pole — start M9 the moment M4 lands rather than finishing M5–M7
   first. But note M1–M4 do **not** reach E2 (see the critical path above): the headline experiment
   additionally needs M6 and M7.
2. **The LLM contract change touches 10 call sites** across both flows. Do it as one mechanical
   commit with no behaviour change, verified by typecheck, before anything else.
3. **`validationUtils` LIVR validators are module-level singletons** with a global
   `defaultAutoTrim(true)` side effect at import time. Category vocabulary cannot be varied per
   experiment until they are made constructible. Not blocking for E2/E4; note it.
4. **Prompt extraction changes behaviour if done carelessly.** Extract verbatim first, hash, verify
   an identical run, and only then introduce variants.
5. **Anthropic and VertexAI have no seed.** Determinism there is `temperature: 0` only — and today
   both backends hardcode the *wrong* values (`temperature: 1` for Anthropic, `0.2/0.95` for
   Vertex), so this risk is currently worse than stated. State the limitation in the paper's
   threats-to-validity rather than implying three independent seeds everywhere.
6. **Registry v2 must land before the first real run**, or every artifact needs regeneration.
7. **Determinism leaks beyond the seed.** Equal-similarity candidate ordering (fixed in M4),
   `seededShuffle`'s PRNG (named in M7), and `runId` excluding the git sha (fixed in M1) each make
   "same config → same run" false in a different way. All three are cheap to close and expensive to
   discover after results exist.
8. **The baseline is uncommitted** (execution step 0). Every line number in this document is a
   reference into untracked working-tree code. Until the tag exists, run cards cannot record a
   meaningful `git sha` and the M4 gate has no fixed reference point.
9. **E9 is easy to defer and cannot be dropped.** It is days of work over existing artifacts, which
   makes it tempting to postpone indefinitely — but it is CRITICAL and inside the minimum viable
   article. A measurement paper that never shows the measurement changing a conclusion reads as an
   audit.
