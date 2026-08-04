# Runbook: streaming (Ψ_link) run, scored against the new gold table

Written 2026-08-04 for an agent executing in a fresh session; amended the same day after the
SKEIN v2 sync landed (ladders, rung-aware judge, granularity edges — see below). This distils and
*supplements* `docs/RUNNING-EXPERIMENTS.md` (the authoritative operational guide — read §3, §6,
§10, "What does not work yet" if anything here surprises you). Where the two disagree, this file
is newer on two topics: **the gold table now exists** (`gold/gold.json`, format
`gold-aliases-v2`) — RUNNING-EXPERIMENTS' "M9: no gold table exists" is stale — and **the SKEIN
v2 ladder/linking subsystem is implemented** (this file describes it).

## 0. What you are running, honestly

`FLOW=incremental` runs the SKEIN v2 streaming arm: per-document mention lists → **granularity
ladder bootstrap** (per category, once ≥8 distinct surfaces accumulate; N≥3 ensemble of the
`ladder` prompt, code validators, `disputed` forced on disagreement, cached versioned in
`schema.json`, retroactive rung binding over existing canonicals) → exact alias fast path →
candidate generator (`string-sim` by default; `CANDIDATE_GENERATOR=union` selects the deck's
five-channel RRF union blocker) → one batched `link-judge` call per document (the three-verdict
rung-aware judge: `link | mint | defer`, `mentionRung`, and `parentCandidate`+`edgeKind` that
becomes a granularity edge in-stream) → `EntityRegistry` **v3 identity graph** (per-alias
provenance, rungs, `coarsens-to`/`part-of` + `renamed-to` edge layers, defer queue), with
`decisions.jsonl` as the scorable log and artifacts stamping `matchedVia` beside
`normalizedName`. A judge `defer` mints provisionally and queues the pair for the consolidator
(scoring per `docs/statistical-protocol.md` §5 is unchanged: a withheld decision).

The consolidator (`registryConsolidator` step, manual) now carries the full repair inventory —
merge / **split** / **move**, granularity/rename edge creation, the defer-queue review, and a
cross-category sweep that records category corrections; re-stamp reassigns mentions by
`matchedVia`. The graph builder accepts **λ** (`LAMBDA="Software=g2,default=g0"`): one g0 store,
coarser views computed at fold time (`coarsens-to` folds freely; `part-of` only under
`LAMBDA_INTERPRETIVE=1`, and such views mark folded edges `inferred`); the projection contract
recomputes weights as distinct incidents, never sums.

**Still not implemented:** hierarchical (hP/hR) scoring in `evaluate` — the run now *produces*
granularity edges, but `evaluate`'s identity metrics still ignore both the system's and the
gold's `edges` by design. Also note a vocabulary seam kept deliberately: the pipeline's
`coarsens-to` corresponds to the gold table's `isa` edge kind (gold changes only by dated
amendment; the mapping is one-to-one for future hP/hR work).

- Evaluation today is identity metrics (merge P/R by stratum, B³, ARI, pairwise F1) plus
  mint/NIL accounting and the deferral-rate column.
- Granularity-type gold pairs (`rung`) should now show up as hard non-merges PLUS a system edge —
  visible in `run-view.html` and `registry.json`, not yet in `evaluate`'s numbers.

**The gold table is provisional.** As of 2026-08-04 the worksheet still has ~640 machine-labelled
rows awaiting human confirmation (queue 3) and 29 recorded transitivity contradictions. Numbers
from this run are for *pipeline debugging and plumbing verification* — nothing is reportable until
the human review finishes and the table is frozen. Say this in any summary you produce.

## 1. Preconditions

```bash
cd llm-basic-framework
npm install
npm run typecheck       # tsc --noEmit; must be clean
npm test                # ~720 tests incl. the behaviour gate; all must pass
```

- `.env` must contain the key for the provider you run (`ANTHROPIC_API_KEY` and/or
  `OPENAI_API_KEY`). `GEMINI_API_KEY` is present but irrelevant here.
- **Commit or stash any dirty tree first.** The runId folds in a dirty-diff hash; a real run
  should be reproducible from a sha.
- Confirm the inputs exist:
  - corpus: `../storage/cert.gov.ua/fetched/` (204 JSON reports)
  - frozen extractions: `../storage/cert.gov.ua/processed/raw-unified/gpt-5/` (204 files)
  - gold: `gold/gold.json` (validate: `npm run gold -- validate gold/gold.json --inventory gold/inventory.json`)

## 2. Choose the arm

One environment set = one arm = one runId. Recommended first arm (matches the deck's cloud
ladder; leave `TEMPERATURE`/`TOP_P` unset — on Anthropic the client silently drops them anyway,
and the run card records the sampling that actually left the process):

```bash
export FLOW=incremental
export CONDITION=psi-link-default
export LLM_PROVIDER=anthropic
export LLM_MODEL=claude-opus-5
export DECISIONS_LOG=1          # MANDATORY for NIL/mint scoring, replay AND run playback
                                #   (merge metrics would still work from registry.json alone)
# leave DECISION_STRATEGY unset  → built-in SKEIN v2 link-judge path
# leave CANDIDATE_GENERATOR unset → string-sim (the gate-pinned blocker);
#   CANDIDATE_GENERATOR=union    → the SKEIN v2 method arm (string-sim ∪ translit/confusable ∪
#                                  3-gram ∪ BM25 ∪ dense name+gloss, RRF-fused) — REQUIRES a
#                                  working embeddings config (EMBEDDINGS_PROVIDER/MODEL)
# ladder knobs (all fold into the runId):
#   LADDER_ENSEMBLE_N=3          # default; N same-model prompt runs per category
#   LADDER_ENSEMBLE_MODELS=anthropic:claude-opus-5,openai:gpt-5   # optional multi-model ensemble
#   LADDER_MIN_EXAMPLES=8        # surfaces a category must accumulate before its ladder fires
# fold-time (streamingGraphBuilder only, NOT in the runId — refolds are free):
#   LAMBDA="Software=g2,default=g0"   LAMBDA_INTERPRETIVE=1
```

`CONDITION` is a label, not behaviour. If you later run other models, change `CONDITION` too
(e.g. `psi-link-opus`, `psi-link-gpt5`) so run directories stay readable.

## 3. Smoke test first (~2 min, cents)

```bash
mkdir -p /tmp/smoke-docs && ls ../storage/cert.gov.ua/fetched/*.json | head -3 \
  | xargs -I{} cp {} /tmp/smoke-docs/
INPUT_DIR=/tmp/smoke-docs OUTPUT_DIR=/tmp/smoke-out FLOW=incremental CONDITION=smoke \
  LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 DECISIONS_LOG=1 npm start
```

Success = it prints `RUN <runId> → <runDir>`, extracts 3 documents, normalizes them, and
`/tmp/smoke-out/experiments/<runId>/` contains `run-card.json`, `decisions.jsonl`,
`registry.json`, `extractions/`, `artifacts/`. The input hash differing from the frozen corpus is
expected — this is a smoke test, not a result. Delete `/tmp/smoke-out` afterwards.

## 4. Full run — pre-seed the frozen extractions (important)

Extraction is the expensive step AND the comparability step: the gold table annotates the surface
forms of the **frozen gpt-5 extractions**, while a live `streamingExtractor` would produce its own
(different) mention lists. The deck's contract is "extraction is input, replayed from disk". The
implementation hook is per-file resumability: `StreamingExtractor.processFile` skips any file
already present in `<runDir>/extractions/` (`SKIP (exists)` in the log).

Two facts the pre-seed depends on, both verified against the code:

- **Format**: the streaming extractor writes FOUR keys (`entities, relations, schemaProposals,
  metadata`); the frozen files carry only `entities + metadata`, and the normalizer iterates
  `extraction.relations` unguarded — a bare `cp` therefore CRASHES on document 1, after paying
  for its link-judge call. The copy must inject `relations: []` (step 2 below does).
- **runId stability**: the run directory must not dirty the git tree, or the second invocation
  computes a *different* runId and re-extracts everything at full cost. The repo's `.gitignore`
  now covers `storage/cert.gov.ua/processed/experiments/` — verify with
  `git check-ignore ../storage/cert.gov.ua/processed/experiments/x && echo ok` before starting,
  and keep the tree otherwise committed.

```bash
# 1. Start the run; note the "RUN <runId> → <runDir>" line; once the first
#    "LLM EXTRACTION" begins, stop it (Ctrl-C). The point was only to learn <runDir>.
FLOW=incremental CONDITION=psi-link-default LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 \
  DECISIONS_LOG=1 npm start

# 2. Pre-seed the frozen extractions, adding the empty `relations` the normalizer requires
#    (overwrites any partial file from step 1):
RUNDIR=../storage/cert.gov.ua/processed/experiments/<runId-from-step-1>
mkdir -p "$RUNDIR/extractions"
node -e '
const fs = require("fs"), path = require("path");
const src = "../storage/cert.gov.ua/processed/raw-unified/gpt-5";
const dst = process.argv[1];
for (const f of fs.readdirSync(src).filter(f => f.endsWith(".json"))) {
  const j = JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
  j.relations ??= [];
  j.schemaProposals ??= [];
  fs.writeFileSync(path.join(dst, f), JSON.stringify(j, null, 2));
}
console.log("seeded", fs.readdirSync(dst).length, "files");
' "$RUNDIR/extractions"

# 3. Sanity-check ONE seeded file: must show all four keys and an entity shape:
node -e "const j=require('$RUNDIR/extractions/10011.json'); console.log(Object.keys(j).sort(), j.entities[0])"
#   expect: [ 'entities', 'metadata', 'relations', 'schemaProposals' ] { name, category, role }

# 4. Restart with the IDENTICAL environment (same env + same clean-tree state ⇒ same runId):
FLOW=incremental CONDITION=psi-link-default LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 \
  DECISIONS_LOG=1 npm start
```

Expected log shape: the pipeline interleaves per document — `SKIP (exists)` from the extractor,
then `NORMALIZE`/`LINK-JUDGE` for that same document, 204 times. Exact-hit mentions resolve free;
the rest go through candidates + one `LINK-JUDGE` call per document. With extraction skipped
there are NO extract or type-judge calls; the recurring calls are `link-judge` (≤1/doc),
`pair-rule`, one country-normalize call per Country mention, and — new — `ladder` calls: N
ensemble runs per category, fired once per category when it crosses `LADDER_MIN_EXAMPLES`
distinct surfaces and re-fired on ≥2× growth (expect roughly categories × N ≈ 30–60 calls over a
full 204-doc run, front-loaded; `LADDER <category> vN: …` lines mark them). Wall-clock roughly
1–2 h sequential; read the run card's `cost` block for the real figure — order of $5–15 on
`claude-opus-5` plus the ladder ensemble.

Known cosmetic side effect of pre-seeding: the frozen files carry no `schemaProposals`, so every
category is admitted via the normalizer's fallback with an empty definition (one warning per
document; `schema.json` is then not comparable to a live-extraction run's). Harmless for identity
metrics.

If the step-3 check shows anything else, abort the pre-seed: delete the copied files and run
extraction live, and record in your summary that the run's mentions are then NOT the gold
inventory's surfaces, so merge-metric coverage will be partial.

The run is kill-safe and resumable per file: rerunning the same environment (with the tree in the
same git state) skips whatever exists. For a truly fresh run of the same arm, delete its run
directory first.

## 5. Score against gold

```bash
RUNDIR=../storage/cert.gov.ua/processed/experiments/<runId>
npm run evaluate -- --gold gold/gold.json --split test --run "$RUNDIR" --json results.json
```

- `gold-aliases-v2` loads in the current tree (clusters + edges; evaluate's identity metrics
  ignore the edges by design).
- Expect merge P/R per stratum, mint/NIL accounting, and the CESI cluster suite. Undefined
  metrics print as `—`. `downstreamTau`/`orderAri` are `null` — not wired yet (M7/M11), not a bug.
- Bootstrap CIs / significance are NOT in the CLI; do not fabricate them.
- Optional free extras over the same log (fidelity check first):

```bash
npm run replay -- --in "$RUNDIR/decisions.jsonl" --verify
npm run replay -- --in "$RUNDIR/decisions.jsonl" --strategy exact-only --out /tmp/exact.jsonl
npm run replay -- --in "$RUNDIR/decisions.jsonl" --strategy threshold --threshold 0.8 --out /tmp/t80.jsonl
```

## 5b. Watch the run: playback viewer

```bash
npm run view -- --run "$RUNDIR"     # writes $RUNDIR/run-view.html
```

One self-contained HTML page (no server, no network): scrub document by document and watch each
report change the ladders and the registry — ladder pane (rungs with `preserving`/`disputed`
chips, version history), granularity forest (finer nested under coarser, renames as chains,
aliases wrapped under the name), per-document event list, and a final "repair" chapter for
consolidator operations. Requires `DECISIONS_LOG=1` (the journal is the replay source; document
order derives from `artifacts/`). The page diffs its final replayed frame against
`registry.json` and shows a warning banner on any mismatch.

## 6. Deliverables of this run

1. The run directory path + `run-card.json` (config, prompt hashes, effective sampling, cost).
2. `results.json` from `evaluate` + the console table.
3. The per-document LLM call histogram (from `decisions.jsonl` — the deck asks for the full
   histogram, not just link-judge counts; `ladder` is now one of the kinds).
4. `run-view.html` (§5b) — the reviewable form of the registry/ladder state.
5. A short summary that states: which blocker arm ran (`string-sim` vs `union`), the ladder
   ensemble config, gold provisional (unreviewed queue-3 rows), and the observed cost. Identity
   metrics only — granularity edges exist but are not yet scored (no hP/hR). No headline claims.

## 7. Known traps

- **All runIds changed on 2026-08-04**: the `ladder` prompt is new, `link-judge` and
  `consolidate-merge` were replaced (SKEIN v2), and prompt hashes fold into every runId — a
  pre-sync run directory can never be resumed by the new code. Registry files migrate forward
  (v1/v2 read fine, saved as v3), but a fresh arm is the honest comparison.
- The `union` blocker arm requires embeddings (`EMBEDDINGS_PROVIDER`/`EMBEDDINGS_MODEL` and its
  key); it fails fast if missing — never a silent downgrade to string-sim.
- Ladder ensemble cost scales with `LADDER_ENSEMBLE_N` × categories; the calls are front-loaded
  (each category fires once it crosses the surface floor). A category that never accumulates
  `LADDER_MIN_EXAMPLES` surfaces stays in flat g0 mode — that is correct behaviour, not a bug.
- `TEMPERATURE`/`TOP_P` on Anthropic are silently DROPPED by the client (not sent, no 400) —
  the run card's `sampling.effective` records what really left the process. Leave them unset so
  the record is unambiguous.
- No `DECISIONS_LOG=1` → the run cannot be NIL/mint-scored or replayed (merge metrics still work
  from `registry.json`).
- The runId folds in a dirty-diff hash; untracked files inside the repo count as dirty. Run dirs
  are gitignored for exactly this reason — do not write other artifacts into the repo mid-run.
- `npx ts-node` can resolve a wrong version — use `npm run …` scripts or `./node_modules/.bin/ts-node`.
- `gpt-5` and `text-embedding-3-large` input are unpriced in `config/model-prices.json` — a
  `$0.00 (+N unpriced calls)` total means *unpriced*, not free. Anthropic models are priced.
- `evaluate` needs `run-card.json` plus `registry.json` or a non-empty `decisions.jsonl`.
- The behaviour gate (`test/gate.test.ts`) failing means STOP — a refactor changed behaviour;
  numbers would measure the refactor, not the arm.
- Mention coverage: even with pre-seeded extractions, the normalizer's *canonicalization* of
  surfaces may differ from the inventory's case-folding. If `evaluate` reports suspiciously low
  coverage, diff the run's registry surfaces against `gold/inventory.json` before blaming the
  metrics.
