# Code plan: normalization experiment harness

> **Deliverable.** This document is the migration plan. The research design it implements is
> `dissert/wiki/notes/normalization-experiments-cert-ua.md` — that note owns *what* to measure;
> this one owns *what to build*.
>
> **Execution step 0 — establish a baseline commit. ✅ DONE.** The streaming pipeline
> (`src/Consolidator/`, `src/DecisionLog/`, `src/EntityRegistry/`, `src/SchemaRegistry/`,
> `StreamingExtractor.ts`, `StreamingNormalizer.ts`, `StreamingGraphBuilder.ts`, `fsUtils.ts`,
> `similarityUtils.ts`, plus modifications to `bin/app.ts`, `validationUtils.ts`,
> `LlmClientBackendAnthropic.ts`) **and this document** are committed and tagged
> **`skein-v2-baseline`**; `npx tsc --noEmit` is green at the tag over 32 TS files. That is the revert
> point, the reference for M2.5's byte-identity capture, and what the `git sha` in every run card
> means. **The line numbers below are valid as of that tag and drift afterwards** — resolve them with
> `git show skein-v2-baseline:<path>` rather than against the working tree.

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

**Critical path: M1 → M2 → M2.5 → M3 → M4 → M6 → M7 → M9, with M5 after.** M2.5 is small but
**order-critical**: it captures the behaviour-preservation fixture that M4's gate is scored against,
and it must run *before* M3 rewrites the registry format. M1–M4 alone do *not* reach the
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

| Backend | Capture from | Seed support | Determinism lever |
|---|---|---|---|
| Anthropic | `message.usage.{input_tokens,output_tokens}` | none | **none — see below.** `temperature` must be *omitted*, not zeroed |
| OpenAI | `chatCompletion.usage.{prompt_tokens,completion_tokens}` | `seed` param | `seed` (+ `temperature` only if the model accepts it) |
| Ollama | `response.{prompt_eval_count,eval_count}` | `options.seed` | `options.seed` |
| VertexAI | `result.response.usageMetadata` | none — use `temperature: 0` (today `:20-21` hardcodes `temperature: 0.2, topP: 0.95`) | `temperature: 0` |

**Anthropic has no `temperature: 0` option — do not add one.** On Claude Opus 4.7 and later
(4.7 / 4.8 / Opus 5 / Sonnet 5 / Fable 5) the sampling parameters `temperature`, `top_p` and `top_k`
are **removed from the API**: sending a *non-default* value returns HTTP 400. The default
`temperature` is 1.0, which is exactly why the current `LlmClientBackendAnthropic.ts:17`
(`temperature: 1`) works — verified by the 204 committed `claude-opus-4-8` outputs under
`storage/cert.gov.ua/processed/normalized/claude-opus-4-8/`. Setting `temperature: 0` there would
400 on every call and break the whole Anthropic arm.

Consequences, all of which must be honoured rather than worked around:

- `LlmCallOptions` must let a backend **omit** a sampling field, not merely default it to a number.
  Modelling `temperature` as `number` with a `0` default silently breaks Anthropic; it has to be
  `temperature?: number` with the Anthropic backend dropping it (or passing the default `1`).
- The run card records `temperature: null` / `"provider-default (1.0)"` for Anthropic rather than
  pretending a value was chosen.
- **The determinism substitute for Anthropic is replication at default sampling**, not
  low-temperature sampling: ≥3 independent calls with identical inputs and no sampling parameters.
  This is a weaker claim than a seed *and* weaker than `temperature: 0`, and
  `docs/statistical-protocol.md` must say so in those terms.
- Anthropic's newer models also think by default and never return raw chain-of-thought.
  `LlmClientBackendAnthropic.ts:27-29` already skips leading `thinking` blocks — keep that, and note
  that thinking tokens are billed and counted in `usage`, so `CostMeter` figures for Anthropic
  include reasoning the log cannot show.

**Sampling parameters become per-call, never per-backend.** The hardcoded values above are invisible
to the run card today. After M1 they arrive through `LlmCallOptions` and are recorded — including
being recorded as *absent* where the provider forbids them.

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
and the documented substitute for providers without a seed. That substitute is **not uniform across
providers** and the document must spell out all three tiers, because they support different claims:

| Tier | Providers | What "≥3 seeds" means | Strength |
|---|---|---|---|
| Seeded | OpenAI, Ollama | 3 distinct `seed` values | strongest available |
| Zero-temperature replicates | VertexAI | 3 calls at `temperature: 0` | weaker — no seed, but sampling pinned |
| **Default-sampling replicates** | **Anthropic** | 3 calls with sampling params **omitted** (provider default `temperature` 1.0) | **weakest — sampling is not pinned at all** |

The Anthropic tier is the one that constrains the paper's claims: because `temperature` cannot be
lowered on Opus 4.7+ without a 400 (see M1), its replicates vary under full default sampling, so
its variance estimates measure a genuinely noisier process than the other two arms. State this in
threats to validity, and never present the three tiers as interchangeable "3 seeds".

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
  "order": "chronological",        // the stream order the NIL labels below are relative to
  "clusters": [ { "id": "g0007", "category": "HackerGroup",
                  "members": ["APT28", "Fancy Bear", "УАЦ-0028"],
                  "stratum": "c",                       // a | b | c | d
                  "split": "test",                      // dev | test
                  "evidence": [ { "pair": ["APT28","Fancy Bear"],
                                  "snippet": "…also known as…",
                                  "source": "mitre:G0007",
                                  "annotator": "expert" | "llm" | "kb",
                                  "rationale": "…" } ] } ],
  // NIL is a property of (mention, stream position) — never of a mention alone.
  "nilLabels": [ { "docId": 40102, "category": "HackerGroup", "mention": "УАЦ-0028",
                   "clusterId": "g0007", "label": "NIL" } ] }
```

**`nilLabels` is position-indexed, and this is load-bearing.** A flat `mention -> NIL|known` map
cannot express what M9's `close` must emit: the same mention is NIL the first time its cluster is
seen and `known` at every later occurrence, so one mention carries *both* labels over the stream.
Keying by `(docId, category, mention)` — one row per occurrence, in `order` — is the minimum shape
that makes streaming replay scoreable at all (Phase 2.4). `order` is recorded in the file because
the labels are only valid for the stream order they were derived from; the same gold table replayed
under `seededShuffle` needs its NIL labels regenerated, not reused.

An equivalent normalisation is to store `firstSeen: { docId }` per cluster and derive each
occurrence's label as `docId === cluster.firstSeen.docId ? "NIL" : "known"`. Either is acceptable —
**a flat mention→label map is not.** M2's `gold.ts` loader must reject `nilLabels` given as a plain
object, so a regression to the flat shape fails at load rather than silently mis-scoring.

Gold stores **cluster membership, not canonical names** (see M9).

`bin/evaluate.ts` scores any set of runs against gold and emits the composed results table —
rows = conditions, columns = per-stratum merge P/R, NIL F1, cluster F1, calls/tokens/$, downstream
τ (from M11), order-ARI where applicable.

### M2.5 — Behaviour-preservation fixture (small, and it must land before M3)

**Why this is its own migration.** M4's byte-identity gate is the test that makes the whole refactor
safe, but it can only be captured against the **v1** registry format and the **current**
`EntityRegistry.candidates()`. M3 replaces that format and M4 deletes that method. Left inside M4 —
where the original plan put it — the gate is unbuildable by the time you reach it: the fixture would
have to be reconstructed through the v1→v2 migrator, and a gate whose reference was produced by the
very migrator it is meant to police proves nothing. So it is hoisted here, after M2 (which supplies
`unionFind` and the test harness) and before M3 touches the format.

Deliverables:

1. **`test/fixtures/registry-v1.json`** — built by replaying the 3,392 frozen `(surface, category)`
   pairs through exact-`resolve()`-then-`mint()` with **no LLM in the loop**, in `sortByNumericId`
   order (deliberately the *current* order, not chronological — this fixture reproduces today's
   behaviour, it does not improve on it). Deterministic and committed.
2. **`bin/capture-golden.ts`** — the generator, committed alongside its output so the fixture can be
   rebuilt and diffed rather than trusted.
3. **`test/fixtures/golden-candidates.json`** — `candidates()` output for every one of the 3,392
   pairs against that fixture, at the defaults the streaming pipeline actually uses
   (**verified: `k = 5`, `minSim = 0.5`**, from `StreamingNormalizer`'s `candidateK` /
   `candidateMinSim`), recorded in the document metadata so the gate cannot drift.
   Metadata is deliberately **path-free** — the corpus is identified by its content hash and the
   fixture by its canonical hash, so the file verifies from any directory. (Found by testing the
   verifier: embedding paths made a faithful copy fail on the metadata alone, a false positive that
   would mask real drift.)

   **Format: a JSON document, not JSONL.** This was got wrong twice before landing, so the reasoning
   is recorded rather than the conclusion alone.

   The first attempt was JSONL with the metadata as line 0. That breaks the only contract JSONL has —
   **every line is the same shape** — and consumers depend on it: `pandas.read_json(lines=True)`
   yields a phantom all-null row, DuckDB/BigQuery schema inference produces a bogus union schema,
   `jq -s 'map(.category)'` returns a leading null. It also forced the loader to identify the header
   *by position*, which stops working the moment the file is sorted, filtered or concatenated. Adding
   a `type` discriminator per line was considered and rejected: it hardens the parse while keeping
   the heterogeneity, and "metadata plus a uniform table" is exactly what a JSON document is for.

   The size and diff arguments originally offered for JSONL do not survive measurement either:

   | format | bytes | lines | diff: 1 sim changes | diff: 1,275 sims change | diff: 1 query inserted |
   |---|---|---|---|---|---|
   | pretty JSON (`indent 2`) | 2,466,743 | 114,566 | 2 | 2,550 | 13 |
   | compact JSON (one line) | 1,278,012 | 1 | 2 = *whole file* | 2 = *whole file* | 2 = *whole file* |
   | JSONL | 1,278,000 | 3,393 | 2 | 2,550 | 1 |

   JSONL beats *compact* JSON decisively but is no better than *pretty* JSON on diffs, and is within
   12 bytes of compact on size. So the format was chosen on structure, not on those numbers.

   The shipped file is a JSON document whose **metadata is pretty-printed and whose `results` rows
   occupy exactly one line each** (hand-rolled serializer, ~10 deterministic lines in
   `bin/capture-golden.ts`). That keeps every property worth having at once: one `JSON.parse`, a
   homogeneous `results` array, metadata at the root, 1.25 MB, and a one-line diff per changed query.
   Rule of thumb for this repo: **JSONL only for homogeneous record streams; JSON for anything
   carrying metadata alongside rows.**

4. **Fix the tie-break first.** `similarityUtils.ts:61` sorts on `b.sim - a.sim` only, so
   equal-similarity candidates fall back to registry insertion order. Change it to sort on
   `(-sim, canonicalName)` **before** capturing, and capture against the fixed version — otherwise
   the golden file bakes in a run-dependent ordering and the gate enforces a bug. This is the one
   intentional behaviour change in M2.5; everything else is capture-only. Use UTF-16 code-unit
   comparison, **never `localeCompare`**, which is ICU- and locale-dependent and would reintroduce
   cross-environment nondeterminism on Cyrillic keys.
5. A test that rebuilds the fixture from the frozen input and asserts it matches the committed copy,
   so a change in `mint`/`resolve` semantics is caught here rather than in M4. Compared by
   **canonical hash and deep equality, not raw bytes** — object key order is not semantically
   meaningful to `candidates()` once the tie-break is name-based, and a formatter run over the
   committed JSON must not be able to fail the gate. Order changes that *do* matter still surface,
   because `firstSeen` is part of the hashed content.

**Measured: the tie-break was not a cosmetic fix.** Over the 3,392 frozen queries against the
3,360-canonical fixture at `k = 5`, `minSim = 0.5`:

| | queries | top-5 changed by the fix | top-5 cut decided by tie order |
|---|---|---|---|
| **all** | 3,392 | **1,275 (37.6%)** | **1,352 (39.9%)** |
| Domain | 1,929 | 836 (43.3%) | 1,058 (54.8%) |
| Software | 882 | 334 (37.9%) | 228 (25.9%) |
| **HackerGroup** | 93 | **51 (54.8%)** | 43 (46.2%) |
| Sector | 121 | 27 | 10 |
| Organization | 174 | 13 | 8 |
| Government Body | 96 | 13 | 3 |
| Device | 31 | 1 | 2 |
| Country · Individual · Infrastructure | 66 | 0 | 0 |

So **more than a third of all candidate lists were order-dependent**, and the worst-affected
category is `HackerGroup` — the one carrying strata (c) and (d), on which the two-claims framing
rests. Mean candidates above `minSim` is **42.0** (max 221), so `k = 5` already discards most of
them; before the fix, *which* five reached the judge was decided by mint order. This is Risk #7
made concrete, and it is why the fix precedes the capture.

**Two mechanism findings that belong to M4 and E4, not here.** Both come from the same capture and
are recorded so they are not rediscovered later:

- **Token-set Dice makes structurally-similar identifiers look alike.** `tokenSetDice` splits on
  `[^\p{L}\p{N}]+`, so any two 2-token domains sharing only a TLD score **exactly 0.5** — at the
  `minSim` boundary, which is why Domain has 1,058 tie-decided cuts. Worse for designations:
  60 of 92 `HackerGroup` canonicals are `UAC-####`, and they score 0.75–0.875 against each other on
  the shared prefix alone. Concretely, query `UAC-0010` retrieves `UAC-0018`, `UAC-0050` and
  `UAC-0210` at 0.875 **ahead of** `UAC-0010 (Armageddon)` at 0.8 — its own designation, ranked
  fifth and only just inside `k = 5`. This is the strongest available argument for M4's
  `identifierRegex` analyzer, and it is exactly the failure E4 measures as candidate recall@k.
- **Distinct surfaces can score 1.0.** 73 queries retrieve more than one candidate at similarity 1,
  because the tokenizer collapses punctuation: `accounts-ukr.net`, `accounts--ukr.net` and
  `accounts---ukr.net` have identical token sets. They are plausibly typosquats of one another, so
  any threshold-based merge arm will merge them unconditionally — and for a CTI corpus that may be
  precisely the wrong answer. Note the tension for M4's `domainCanonical` analyzer: eTLD+1 folding
  would make this *worse*, not better. Do not let the embedding-threshold arm inherit it silently.

Nothing in M2.5 changes pipeline behaviour beyond the tie-break, and nothing consumes the fixture
yet — M4 is where it becomes a gate. Regenerate with `npm run capture-golden`; check drift with
`npm run capture-golden -- --verify` (~13 s, 3.7M similarity comparisons).

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

Reader accepts v1 and v2; writer emits v2; `bin/migrate-registry.ts` converts (idempotent, backs
up the original, `--dry-run` to inspect).

**The v1 reader is not just courtesy — it is what keeps the M2.5 gate valid.**
`test/fixtures/registry-v1.json` must stay in the pre-M3 format, or the gate's reference would have
passed through the very migration it exists to police. So `buildFixtureRegistry` projects through
`toV1()`, and `candidates()` still returns alias **surfaces as strings** rather than alias records —
the golden lists record them as strings, and changing that shape would break the byte comparison M4
is scored against. Verified after the migration: fixture hash `098b21de…` unchanged and all 3,392
candidate lists byte-identical.

**The migration cannot invent provenance.** Every v1 alias becomes `decision: "migrated"` with
`docId` from the record's `firstSeen.doc` — the only document context v1 recorded — and `gloss` null
with `externalIds` empty. Fabricating finer provenance would make an unauditable registry look
auditable, which is worse than admitting the gap.

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

Two consequences discovered while implementing it:

- **The caller's `into` is no longer authoritative for the surviving name.** Under closure it cannot
  be: a three-way group `{A,B,C}` has no single requested target. The policy decides, and the
  judge's requested direction is preserved in alias provenance instead of obeyed. With the default
  `first-seen` this is also the more defensible choice — it is what makes the operation
  order-independent, which was the point of the fix.
- **`highest-degree` cannot be honoured by the registry alone**, which holds no graph. It takes an
  injected `degreeOf` provider (the graph arrives in M11) and falls back to `first-seen` with a loud
  warning when absent — because silently falling back would make the recorded policy a lie.

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
+ exact `resolve()` and gains a read-only `snapshot()` — **live, not a frozen copy**, because the
streaming registry mutates after every document. Generators consume snapshots and are told about
mutations through `onRegistryChange`, which is what keeps the TF-IDF and BM25 indexes from silently
losing every canonical minted since `prepare()`.

`bestMatches` is retired; both importers are migrated. `EntityRegistry` uses the generator, and
`SchemaRegistry` uses `Normalization/matchStrings` — a separate helper rather than a generator,
because it matches *schema entries* and a `CandidateGenerator` is defined over a `RegistrySnapshot`.
`stringSimilarity` **stays**: `StreamingExtractor` and `RegistryConsolidator` still use it for their
pairwise suspect checks, and the metrics tests assert that `identity + max(levenshtein, tokenDice)`
reproduces it exactly — the algebraic identity the gate rests on, asserted where a break is legible
rather than as 3,392 mysterious mismatches.

**Normalization lives in analyzers; metrics are pure functions of the keys they are given.** The
pre-M4 `stringSimilarity` trimmed and case-folded internally, which is exactly why it could not be
recombined — no caller could compose it with a different notion of identity. So `identity` means the
identity *matching* transform, case folding included, because that is what identity has always meant
here: `resolve()` matches on `trim().toLowerCase()`.

**Regression gate: ✅ PASSED.** `StringSimilarityGenerator(identity, max-lev-dice)` reproduces
`EntityRegistry.candidates()` output exactly on **3,392 / 3,392** frozen pairs — similarity floats
included — against the `test/fixtures/registry-v1.json` + `test/fixtures/golden-candidates.json` pair
captured in **M2.5**. Only then was `candidates()` deleted. The gate lives in `test/gate.test.ts` and
runs the **full** query set (~11M comparisons, ~7 s): a sampled gate would leave the tail unchecked,
and the tail is where a normalization difference hides.

Three bugs found by testing the analyzers against real corpus values rather than trusting them, all
recorded in place so they are not reintroduced:

- **Digit folding in the confusables table corrupted the case it exists for.** Mapping `8→b` turned
  `АРТ28` into `apt2b`, so the homoglyph spoof failed to match `apt28`. Digits here are
  identity-bearing — it would equally corrupt `UAC-0010`, `CVE-2021-44228` and every version number.
  All digit→letter mappings removed.
- **JavaScript's `\b` is ASCII-only even under the `u` flag**, so `/\bуац/u` can never match
  `УАЦ-0028` — the Cyrillic designation form silently produced no keys. Replaced with Unicode
  property lookarounds.
- `\d{3,5}` rejected the shorthand `UAC-28`; now `{2,5}` zero-padded to four, with two digits
  minimum so stray prose like `uac 5` does not register.

**A finding that changes how E0 and E4 are built.** The research note offers `АРТ28` vs `APT28` as its
stratum-(b) example, but that pair is **not** a transliteration case: Cyrillic `Р` is ER, so
transliteration yields `art28` and cannot match `apt28`. It is a *homoglyph spoof*, handled by
`confusableSkeleton`. Two distinct mechanisms hide behind "cross-script" — E0 should build stratum (b)
from both, and E4 must attribute recall to the right channel, or a transliteration arm scored on
homoglyph pairs will look falsely useless.

The capture itself — fixture construction, the golden file, and the `(-sim, canonicalName)`
tie-break fix it must be captured against — is **M2.5**, deliberately sequenced before M3's format
change. Do not attempt to (re)capture it here: by this point the registry is v2 and the original
`candidates()` is the thing under test, so a reference produced now would be circular. If M2.5 was
skipped, stop and do it against the `skein-v2-baseline` tag rather than improvising a reference.

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

**✅ M6 DONE** (`a0433a2`, `b97cbf6`). 437 tests pass; gate still 3,392/3,392.

- **All 10 prompts extracted** to `prompts/`, hashed into the run card, folded into the `runId` —
  which makes `promptHashes` load-bearing for the first time (a prompt can now change with no code
  change, so the git sha no longer covers it). Extraction was **mechanical**: a script lifted the
  exact characters of each template literal and replaced `${expr}` with `{{name}}`, then diffed each
  result against `git HEAD` with interpolations masked to the same sentinel. All ten matched exactly,
  satisfying Risk #4. `prompts/manifest.json` locks them; a prompt edit now fails the test suite.
- **Five strategies shipped**, behind the new `DecisionStrategy` port with `link | mint | defer`.
  Two extra prompts (`listwise-select`, `comem-select`) were authored for M6 and are marked as such
  in the manifest rather than claiming an extraction provenance they do not have.
- **The `defer` convention was already fixed in M1** (`docs/statistical-protocol.md` §5), before any
  strategy could emit one — as intended.
- **Bug fixed**, and all three key-construction sites now route through one `mentionKey()`. Keys
  built two different ways is precisely how the loss survived unnoticed.
- **`DECISION_STRATEGY` selects the arm at runtime.** `StreamingNormalizer` now takes the port;
  unset keeps the built-in `link-judge` call, which is the published Ψ_link behaviour the golden
  fixture pins, so the default arm is provably unchanged (test asserts the built-in path still runs
  when nothing is injected). The strategy id **and its full config** go into `extra`, so they are
  part of the runId — two arms differing only by decision rule would otherwise share a directory and
  resume each other through the `existsSync` skips. Verified: three strategies, three distinct runIds.
- **Three additions beyond the plan's letter**, all required to make the milestone's own goal real:
  1. `DecisionCandidate.surfaces` is now logged. The replay contract promises "the exact candidate
     list the judge saw", and aliases are part of what it saw (`dong2023reveal`: +2–14 F1) — without
     them a replayed prompt is not the original prompt, so E8 would report an input difference as a
     judge effect. Optional, since pre-M6 logs lack it; replay warns loudly rather than treating
     absent as empty.
  2. `StrategyReplayAdapter` + `bin/replay.ts` wiring, so the three **offline** strategies can be
     scored over a logged run for zero marginal cost. Replaying the batched LLM strategies is
     *refused*, not silently allowed: one call per mention is a different arm from one call per
     document, and substituting them would put a wrong cost next to a real quality figure.
  3. The runtime wiring above. Without it the five strategies had **no live caller at all** — the
     port existed and was tested, but nothing could run it, and `bin/replay.ts` told users to
     "run it live with CONDITION=", which does nothing (`CONDITION` only names an arm for the
     runId). Caught by a fact-check pass over the usage guide, along with several doc overclaims.

**Usage guide:** `docs/RUNNING-EXPERIMENTS.md` — every CLI, env var, the gold-table schema, cost
expectations, and an explicit "what does not work yet" section.

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
collapses. A single throwaway call settles it — and it is worth spending, because M1 establishes
that Anthropic has **no** sampling lever and VertexAI has no seed, so OpenAI is the only arm that
can claim seeded reproducibility at all. If `gpt-5` also rejects `temperature`, drop the field from
this example and rely on `seed` alone (recording `temperature: null` in the run card), rather than
silently sending a value the endpoint ignores — an ignored parameter recorded as if it applied is
worse than an absent one.

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
  registry as it stood. Without this, streaming replay cannot be scored (Phase 2.4). It emits the
  **position-indexed `nilLabels` array defined in M2** (one row per `(docId, category, mention)`
  occurrence, plus the `order` the labels were derived under) — the same mention is `NIL` at its
  cluster's first occurrence and `known` at every later one, so a flat mention→label map is not a
  valid output here. Re-run `close` for any run whose document order differs (`seededShuffle`);
  reusing chronological NIL labels under a shuffled order silently mis-scores the mint side
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
     migrate-registry.ts, capture-golden.ts}
test/fixtures/{registry-v1.json, golden-candidates.json}         // M2.5, before M3
docs/statistical-protocol.md
prompts/*.md          experiments/*.json          config/model-prices.json
```

Out of scope for this plan, deliberately, **all four declared**: **M8 repair strategies** (E6),
**M10 external baselines and corpora — dropped, not merely deferred** (see below),
**M12 extra decision strategies** (`PairwiseJudgeDecision`, `CascadeDecision`, `VotingDecision` —
the budget-dependent half of E8, cheap to add later because `bin/replay.ts` lands in M1), and
**E7 micro-batch window plus NIL clustering**. M3 still lays the foundation for M8 so it needs no
second format change.

**M10 is dropped by decision (2026-07-27), and the consequence is on the record.** The corpus is
**CERT-UA only**: no ReVerb45K adapter, no CESI runner, no second corpus. The reason is that every
external candidate is annotated for someone else's task — this project's gold is being built by hand
for this corpus, and an external set's labels do not transfer to it.

What that costs, stated plainly because Phase 3.2/3.3 are **IMPORTANT** and the note's own rule is
"skip only under real constraint and acknowledge the consequence in the paper where visible":

- **No number in the paper is calibratable against published results.** A reviewer cannot tell
  whether the gold table is hard or easy, because nothing anchors it to a benchmark others have run.
- **Every condition is self-implemented.** There is no non-self-implemented comparator, so
  implementation quality and method quality are not separable by an outside reader.
- Both belong in **threats to validity**, not in a footnote.

Two mitigations already inside scope, which is what makes the drop defensible rather than merely
convenient: **Fellegi–Sunter** (M6) is a classical non-LLM statistical pole that needs no external
corpus and no side information, and the **exact-match floor** (M4) bounds the problem from below.
Neither is a published external baseline, and neither claims to be.

Separately on CESI: only its **metric suite** (macro/micro/pairwise, implemented in M2) is used. The
CESI *system* would not have been informative on this corpus even had it been in scope — its
measured advantage comes from side information that does not exist here (Freebase/Wikipedia entity
linking, which fails precisely on the novel tail; English-only PPDB paraphrases, useless for the
cross-script stratum; English GloVe, for which Cyrillic surface forms are out-of-vocabulary; AMIE
constraints over functional relations this co-occurrence graph does not have). Run in that crippled
configuration it degenerates to string similarity plus IDF token overlap — which the note already
records as MEASURED-**negative** — and being batch-only it says nothing about the streaming question
that is RQ2. Record it in the paper's considered-and-rejected list with that reason.

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
| *(no research phase — refactor safety)* | **M2.5** fixture + golden capture | not in the note; gates M4. Must precede M3 |
| P2 / E0 gold, all four strata + acronym | M9 | |
| P2.3 agreement, test-retest, rationale · P2.6 Domain sampling · P2.7 hours · P2.8 release | M9 | the E0 gate |
| P2.4 closure + prefix-relative NIL labels | M9 `close` + M2 `unionFind` | |
| P3.1 / E1 Ψ_norm scored | M7 `BatchRun` + M2 `partition.ts` batch-map source + M6 prompt hash | |
| P3.2 CESI · P3.3 ReVerb45K anchor | **dropped — CERT-UA only** | consequence recorded in threats to validity; CESI *metric suite* still used via M2 |
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

0. **Baseline tagged. ✅ satisfied** — tag `skein-v2-baseline`, `npx tsc --noEmit` green over 32
   files (execution step 0). Nothing below is meaningful without it.
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
4. **Behaviour-preservation gate** (captured in M2.5, enforced in M4).
   `StringSimilarityGenerator(identity, max-lev-dice)` must reproduce `EntityRegistry.candidates()`
   byte-identically on all 3,392 frozen pairs, against the committed fixture registry and golden
   file. This is the test that makes the refactor safe. **Checkable by commit order:** the fixture
   and golden file must be committed *before* the M3 registry-v2 commit — if they arrive after, the
   gate is circular and does not count. Verify with
   `git log --oneline -- test/fixtures/golden-candidates.json src/EntityRegistry/`.
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
5. **Anthropic and VertexAI have no seed — and Anthropic has no `temperature: 0` either.** For
   VertexAI the lever is `temperature: 0` and today's hardcoded `0.2/0.95` is simply wrong; fix it.
   For Anthropic there is **no lever at all** on Opus 4.7+: sampling parameters are removed from the
   API and any non-default value 400s, so the current `temperature: 1` is not a bug to fix but the
   only accepted value (see M1). Its determinism substitute is replication under default sampling,
   which is weaker than both other tiers. The real risk is an implementation that "fixes" Anthropic
   to `temperature: 0` and breaks every call, or a protocol that reports all three tiers as "3
   seeds" — guard against both, and state the limitation in threats-to-validity rather than implying
   three independent seeds everywhere. Re-check this if the Anthropic model is ever pinned to an
   older Claude (4.6 and earlier still accept `temperature`), since the tier would change.
6. **Registry v2 is order-boxed on both sides.** It must land **before the first real run** (or every
   artifact needs regeneration) and **after M2.5** (or the behaviour-preservation gate loses its
   reference). That window is narrow and easy to miss under schedule pressure — M2.5 is small, so the
   temptation is to fold it into M4 and do M3 first, which is exactly the failure. Treat "M2.5
   committed before M3" as a hard precondition, checkable by commit order.
7. **Determinism leaks beyond the seed — the largest one is now measured.** Equal-similarity
   candidate ordering (fixed in **M2.5**, as part of the golden capture — not M4, or the golden file
   bakes the bug in), `seededShuffle`'s PRNG (named in M7), and `runId` excluding the git sha (fixed
   in M1) each make "same config → same run" false in a different way. All three are cheap to close
   and expensive to discover after results exist. The candidate-ordering leak turned out to affect
   **37.6% of all candidate lists and 54.8% of `HackerGroup` ones** (M2.5's table) — i.e. it was not
   a corner case, and had it been discovered after E2 ran, every affected judge decision would have
   been unreproducible.
8. **~~The baseline is uncommitted~~ — closed.** Execution step 0 is done: the streaming pipeline and
   this document are committed and tagged **`skein-v2-baseline`**, with `npx tsc --noEmit` green at
   the tag over 32 files. Line numbers in this document are valid as of that tag and drift
   afterwards; re-resolve them against `git show skein-v2-baseline:<path>` rather than trusting them
   later in the program.
9. **E9 is easy to defer and cannot be dropped.** It is days of work over existing artifacts, which
   makes it tempting to postpone indefinitely — but it is CRITICAL and inside the minimum viable
   article. A measurement paper that never shows the measurement changing a conclusion reads as an
   audit.
