# Per-run LLM call transcripts

**Date:** 2026-08-17
**Status:** Approved by user (conversation 2026-08-17)
**Goal:** For every experiment, write the full LLM request and response of every call to
per-document, per-operator files inside the run directory, so a single call can be read, diffed,
and manually retried against a different model.

## Motivation

Today a run records only LLM *metadata* — `llm-call` events in `decisions.jsonl` carry
`doc`, `kind`, `seconds`, `model`, token counts and cost, but never the prompt or the response
text. When a local judge fails (the measured case: `gemma4:e4b-32k`'s repair-judge failing the
`reviews` schema on ~50%+ of large prompts, which is the single biggest quality differentiator
found in the 2026-08-08 four-arm study), there is nothing on disk to inspect: the failure is
visible only as a retry counter. Debugging requires the exact bytes sent and received.

## Design

### 1. One writer at the single chokepoint

New class `LlmCallLog` (`src/LlmClient/LlmCallLog.ts`), injected into `LlmClient`
(`src/LlmClient/LlmClient.ts:26`). Every call in the codebase goes through `LlmClient.send()`,
which already receives `operator` and `docId` for cost attribution (`LlmSendOptions`,
`LlmClient.ts:14-17`). Therefore:

- **No call-site changes are needed** for capture. Every operator is covered automatically —
  `link-judge`, `link-judge-retry`, `pair-rule`, `repair-judge`, `repair-judge-retry`, `ladder`,
  `extract`, `type-judge`, `country-normalize`, and any operator added later.
- Embeddings are **out of scope**: `EmbeddingsClient` is a separate class, its payloads are large
  vectors, and they carry no prompt-debugging value.

### 2. Layout and file format

```
<runDir>/llm-calls/<docId>/<NNN>-<operator>.json
<runDir>/llm-calls/<docId>/<NNN>-<operator>.txt
```

- `<docId>` is the numeric document id; calls with `docId == null` go to `_no-doc/`.
- `<NNN>` is a zero-padded per-document counter in call order (`001`, `002`, …), so the sequence
  of calls for one document reads top to bottom.
- The `.json` file is the machine-readable record: `runId`, `operator`, `docId`, `seq`,
  `timestamp`, `provider`, `model`, `sampling` (the **effective** options, after
  `LlmClient#resolveOptions` drops what the backend cannot accept — what was really sent, not what
  was requested), `instructions`, `text`, `response`, `usage`, `latencyMs`, `finishReason`.
- The `.txt` file is the same content rendered for reading:

```
=== REQUEST (ollama gemma4:e2b-16k) ===
--- instructions ---
<instructions verbatim>
--- text ---
<text verbatim>

=== RESPONSE (14.4s, in 1203 / out 88 tok, stop) ===
<response verbatim>
```

- **No truncation.** Fidelity is the entire point; a repair prompt at the 8k-token cap is ~32 KB.
- No replay CLI is built (user decision): the `.json` is self-contained enough to retry by hand.

### 3. Failures are logged too

- **Backend throws** (timeout, HTTP error, connection reset) are caught at the `LlmClient.send`
  seam, written as `<NNN>-<operator>.FAILED.json` / `.FAILED.txt` with an `error` field holding the
  message and stack, and then re-thrown — the existing never-abort behavior of the callers is
  unchanged.
- **Schema/validation failures** are not visible at the client seam (the call returned 200 with
  unusable content). `LlmCallLog` exposes `logOutcome(docId, seq, outcome)` and the two judges that
  validate call it: `StreamingNormalizer#linkJudge`'s catch block
  (`StreamingNormalizer.ts:701-706`) and `StreamingRepairer`'s judge path around `#validate`
  (`StreamingRepairer.ts:465, 674`). The outcome is appended to the existing `.json` as an
  `outcome` field and to the `.txt` as a trailing `=== OUTCOME ===` block, and the files are
  renamed to `.FAILED.*` when the outcome is a failure. This is the case the whole feature exists
  for, so it must not be silently missing.

### 4. On by default, never in the runId

- Writing transcript files does not change pipeline behavior, so the knob must **not** enter
  `RunConfig`/`extra`: folding it in would rotate every `runId` and make a logged run incomparable
  with the committed arms. It stays out of `RunConfig` entirely.
- Default **on**; `LLM_LOG=0` disables it. The user wants transcripts for every experiment.
- `storage/**/experiments/` is committed to git and a full 204-doc run adds roughly 30–50 MB of
  transcripts, so `llm-calls/` is added to `.gitignore` — an accidental `git add` of a run
  directory cannot sweep them in.
- A logging failure (disk full, permission denied) must **never** kill a run: `LlmCallLog` catches
  its own write errors, warns once per run, and continues.

### 5. Testing

Unit tests with a fake backend (the `cannedLlm` pattern from
`src/DataProcessors/StreamingNormalizer.judge.test.ts`):

- files land at `<dir>/<docId>/<NNN>-<operator>.json|.txt`, numbered per document;
- `docId: null` lands in `_no-doc/`;
- a thrown backend error produces `.FAILED.json` containing the error message, and the error is
  still re-thrown to the caller;
- `logOutcome` with a failure renames/annotates the pair;
- disabled log writes nothing;
- the `.json` records **effective** sampling, not requested (e.g. a `temperature` dropped for a
  backend that rejects it must not appear).

The behaviour gate (`test/gate.test.ts`) and the full suite (883 tests) must stay green; with
logging enabled the gate's byte-compared artifacts are unaffected because transcripts are written
to a separate directory.

## Out of scope

- Replay/retry CLI (explicit user decision — files are self-contained).
- Embedding call logging.
- Any change to `prompts/`, gold, scoring, or the decision log's existing `llm-call` events.
