# Single-category fast-iteration loop (Software, e4b, dev split)

**Date:** 2026-08-16
**Status:** Approved by user (conversation 2026-08-16)
**Goal:** Cut the algorithm-iteration loop on the streaming Ψ_link/repair pipeline from ~3.5 h
(full 204-doc corpus, local `gemma4:e4b-32k` arm) to ~5–10 min, without burning the test split or
contaminating the committed experiment arms.

## Motivation (measured on the committed e4b run `psi-link-gemma-e4b-union-934e13d70482`)

- Domain accounts for **1929 / 3360 (57%)** of judge decisions but its gold signal is almost
  entirely singletons — most wall-clock is spent on the least informative category.
- **Software carries the signal**: the most multi-member gold clusters (40 test + 10 dev of 110
  total), the most repair activity, 1123 / 4071 (28%) of mentions.
- A greedy covering set of **22 docs** covers every one of the 21 members of the 10 dev-split
  Software multi-member clusters at least twice.
- `evaluate` already supports `--allow-dev`; `runId = sha256(canonical config + git sha +
  dirty-diff hash + prompt hashes)`, so any knob threaded into `RunConfig` isolates runs
  automatically; `RUN-STREAMING.md` §3 already documents an `INPUT_DIR` subset smoke-test pattern.

## Design

### 1. `CATEGORIES` pipeline knob

New env var `CATEGORIES` — comma-separated canonical categories (e.g. `CATEGORIES=Software`).
Unset = all categories, byte-for-byte today's behavior.

- Read in `bin/app.ts`, threaded into `RunConfig` so it folds into the `runId`. A filtered run
  can never share a directory with a full arm.
- Filtering happens in `StreamingNormalizer.processFile` at plan-build time (the
  `extraction.entities.map(...)` that builds `plans`): entities of other categories are dropped
  from `plans` after category canonicalization, so link, repair, gloss and graph phases all see
  only the kept categories.
- Extractions on disk stay frozen and untouched.
- Relations where either endpoint was filtered out are dropped at stamp time.
- With the knob unset, behavior is identical — the gate test (`test/gate.test.ts`) must stay
  green with **no fixture change**.

### 2. Committed doc subset

- Committed list file `gold/subsets/dev-software-22.txt`: the 22-doc greedy covering set
  (2× coverage of all 21 members of the 10 dev-split Software multi-member clusters).
- A small helper (`bin/make-subset.ts`) materializes the listed raw input files from
  `../storage/cert.gov.ua/fetched/` into a scratch `INPUT_DIR`, following the smoke-test pattern
  in `RUN-STREAMING.md` §3.
- Frozen gpt-5 extractions for those 22 docs are pre-seeded per `RUN-STREAMING.md` §4, unchanged.
- The input-hash difference from the frozen corpus is expected and already documented as
  non-reportable.

### 3. `evaluate --category` flag

- `--category <name>` filters gold clusters, NIL labels, and the predicted partition (both
  registry- and log-derived — both already carry category) to the named category before metrics.
- Loop scoring command:
  `npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software --run <runDir>`
- All numbers from this loop are non-reportable (dev + subset + provisional gold) — same
  discipline the tooling already enforces for `--split`.

### 4. The loop and promotion ladder

- **Inner loop (~5–10 min):** edit algorithm → run the 22-doc `CATEGORIES=Software` arm on
  `gemma4:e4b-32k` → score on dev → compare.
- **Middle ring (~1 h):** full-corpus `CATEGORIES=Software` when a change looks real.
- **Outer ring:** the existing full 4-arm test-split protocol, unchanged, only for promoted
  changes.
- Documented as a short section in `RUNNING-EXPERIMENTS.md`.

### 5. Error handling and testing

- Unknown category names in `CATEGORIES` fail fast at startup, before any LLM call.
- Unit tests: the filter drops non-listed categories and their relations; unset knob is a no-op;
  `evaluate --category` restricts gold and predictions symmetrically.
- Existing test suite (~872 tests) plus the behaviour gate must pass untouched.

## Out of scope

- No changes to prompts (would rotate all arm runIds for no algorithmic reason).
- No hP/hR granularity scoring in `evaluate` (pre-existing gap, unchanged).
- No changes to the committed experiment arms or the gold table.
