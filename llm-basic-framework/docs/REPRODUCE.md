# Continuing this work on another machine

Written 2026-08-05, after the two-arm baseline landed (commits `34a6231`, `c748119`).
Companion to `RUN-STREAMING.md` (how to execute a run) — this file is about **getting a clone into
a state where that runbook works**, and about what is already in the repo so you do not re-pay for
it.

## 1. What the clone already contains

Everything needed to reproduce or compare against the baseline, with no downloads:

| what | where | size |
|---|---|---|
| corpus, 204 CERT-UA reports | `storage/cert.gov.ua/fetched/` | tracked |
| frozen gpt-5 extractions (the pre-seed source) | `storage/cert.gov.ua/processed/raw-unified/gpt-5/` | 204 files |
| gold table + inventory | `llm-basic-framework/gold/` | 13 files |
| prompts (hashed into every runId) | `llm-basic-framework/prompts/` | 17 files |
| **baseline run: claude-opus-5** | `storage/cert.gov.ua/processed/experiments/psi-link-default-4ee484f372fc/` | 6.8M |
| **baseline run: gemma4:e2b** | `…/psi-link-gemma-e2b-f53eb864f8b0/` | 6.6M |
| two-arm comparison page | `…/experiments/compare-opus5-vs-gemma.html` | 3.0M |
| written summary + call histograms | `…/experiments/SUMMARY-2026-08-04.md`, `call-histograms.txt` | — |

Each baseline arm carries `run-card.json`, `results.json`, `decisions.jsonl`, `registry.json`,
`schema.json`, `run-view.html`, all 204 `artifacts/` and `extractions/`, and the full
`console-output.txt` of the run that produced them.

**Run directories are gitignored** so an untracked run dir cannot dirty the tree and change the
runId being computed. The two baselines were force-added as a deliberate one-off; the ignore rule
is untouched, so anything you run next stays ignored. Do not "fix" this.

## 2. Setup

```bash
git clone <repo> && cd llm-analysis-of-text-data/llm-basic-framework
npm install
cp .env.example .env      # then paste your real keys — .env is never committed
npm run typecheck         # must be clean
npm test                  # 733 tests incl. the behaviour gate; all must pass
```

If `test/gate.test.ts` fails, STOP — a refactor changed behaviour and any number you measure
afterwards describes the refactor, not the experiment.

## 3. Local models (the GPU box)

The two local arms use custom tags that are just the stock `gemma4:e2b` weights with a different
`num_ctx`. They exist only on the machine that created them, so recreate them:

```bash
ollama pull gemma4:e2b
printf 'FROM gemma4:e2b\nPARAMETER num_ctx 8192\n'  | ollama create gemma4:e2b-8k  -f -
printf 'FROM gemma4:e2b\nPARAMETER num_ctx 16384\n' | ollama create gemma4:e2b-16k -f -
ollama pull bge-m3          # multilingual embeddings — see §6
```

Since 2026-08-05 the Ollama backend derives `num_ctx` **from the tag suffix** (`-8k` → 8192), so
the tag name and the window actually requested cannot drift apart. Override with `OLLAMA_NUM_CTX`.
Watch `ollama ps` during a run: the `PROCESSOR` column tells you whether the model is on GPU or
has spilled to CPU, and `CONTEXT` confirms the window.

On the 8 GB card used for the baseline, `gemma4:e2b-8k` ran **100% GPU** while `gemma4:e2b-16k`
ran **71% CPU**. With more VRAM you can raise both windows, or run `e4b` instead of `e2b`.

## 4. Reproducing either baseline arm

Pre-seed the frozen extractions first (`RUN-STREAMING.md` §4) — extraction is *input*, and the gold
table annotates the surfaces of the frozen gpt-5 extractions, not whatever a live extractor would
produce.

**Cloud arm:**
```bash
FLOW=incremental CONDITION=psi-link-default \
  LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 \
  DECISIONS_LOG=1 npm start
```

**Local arm** (cheap 8k judge, 16k only for the ladder ensemble):
```bash
FLOW=incremental CONDITION=psi-link-gemma-e2b \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:e2b-8k \
  LADDER_ENSEMBLE_MODELS=ollama:gemma4:e2b-16k,ollama:gemma4:e2b-16k,ollama:gemma4:e2b-16k \
  DECISIONS_LOG=1 npm start
```

`LADDER_ENSEMBLE_MODELS` is parsed as `provider:model` on the FIRST colon, so a model name
containing colons works. Listing one model three times gives the N=3 ensemble.

Then score and view:
```bash
RUNDIR=../storage/cert.gov.ua/processed/experiments/<runId>
npm run evaluate -- --gold gold/gold.json --split test --run "$RUNDIR" --json "$RUNDIR/results.json"
npm run replay   -- --in "$RUNDIR/decisions.jsonl" --verify
npm run view     -- --run "$RUNDIR" --run <otherRunDir> --out compare.html   # switchable arms
node bin/run-stats.js "$RUNDIR"                                              # call histogram
```

Write `results.json` **into the run directory**, not the repo root — the run dir is gitignored, so
the tree stays clean.

## 5. You will NOT get the same runId — and that is fine

`runId = sha256(canonical config + git sha + dirty-diff hash + prompt hashes)` (`RunConfig.ts:93`).
The git sha is folded in, so **any commit changes every future runId**. Consequences:

- Re-running on the new machine produces a *new* directory. It cannot overwrite the committed
  baselines. They are safe.
- The committed baselines can no longer be *resumed* (their sha is in the past). They are complete
  at 204/204, so this only matters if you wanted to extend them — you would re-run instead.
- Keep the tree committed while running. An untracked file anywhere in the repo counts as dirty
  and changes the runId mid-experiment; a crash-resume would then restart from zero.

## 6. Where to take it next

The baseline used `string-sim(identity, max-lev-dice)` — the gate-pinned blocker, **not** the
method arm. It compares raw strings, so it cannot bridge scripts: `Росія` vs `Russia` scores
`0.000` and the judge was handed `candidates: []`. All six multi-member gold Country clusters were
missed on both arms, and both stratum-(b) gold clusters are exactly such cross-lingual pairs —
which is the whole of `merge R(b) = 0.000`.

```bash
EMBEDDINGS=1 EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=bge-m3 \
CANDIDATE_GENERATOR=union FLOW=incremental CONDITION=psi-link-union \
  LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 DECISIONS_LOG=1 npm start
```

`union` = string-sim ∪ translit/confusable ∪ 3-gram ∪ BM25 ∪ **dense name+gloss**, RRF-fused. The
dense channel is the only member that can bridge languages — transliteration cannot, because
`Росія` transliterates to `rosiia`, never `russia`. It is a translation problem, not a spelling
one. `bge-m3` is multilingual, runs locally, and costs nothing, which makes the GPU box the right
place to run this arm.

The blocker fails fast if embeddings are misconfigured — it never silently downgrades.

Other open threads, all evidenced in `SUMMARY-2026-08-04.md`:

- **Granularity edges are forward-only.** A coarser entity arriving after its finer variants leaves
  them orphaned (`GAMMASTEEL` g1 with `GammaSteel.NET`/`.PS1` at g0, never connected, even though
  both were in the candidate list when `GAMMASTEEL` was judged).
- **`registryConsolidator` was never run** — both baselines are pure streaming. It is ~11–12 LLM
  calls, but one of them puts all 1,259 Domain suspects in a single ~22.6k-token prompt, which
  overflows an 8k local window silently. Chunking by connected component of the suspect graph
  bounds it (155 components, median size 2, largest ~7.9k tokens) without losing anything the
  blocker had not already excluded.
- **Country identity is solvable deterministically.** `CountryNameNormalizer` already resolves all
  four Russia variants to `RU`; the code is computed, stamped on artifacts, and then ignored by the
  registry. Keying Country identity on it reproduces 5 of 6 gold clusters exactly — the sixth
  over-merges `ЛНР` into Ukraine, so it needs an exclusion rather than blind application.
- **hP/hR scoring does not exist.** Edges are produced but `evaluate` ignores them by design.

## 7. Standing caveat

The gold table is provisional: ~640 machine-labelled rows await human confirmation and 29
transitivity contradictions are recorded. Numbers from these runs are for pipeline debugging and
plumbing verification. Nothing is reportable until the review finishes and the table is frozen.
