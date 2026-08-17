# experiments-dev — fast-iteration runs

Run directories from the fast-iteration loop live here, not in `../experiments/`.

Everything in this folder is **non-reportable by construction**: dev split, single category,
subset corpus. Keeping it separate means the published-arm tree (`../experiments/`) stays exactly
what the paper cites, while iteration runs still survive across sessions and reboots so you can
compare one iteration against the next.

The contents are gitignored (this README is the exception) — they are scratch, and a full
iteration session can accumulate hundreds of megabytes of LLM transcripts.

## Layout

Same dating scheme as the published tree, so `ls` reads chronologically:

```
experiments-dev/
  2026-08-17-fastloop-software-<runId>/
  2026-08-17-fastloop-software-<otherRunId>/   # after an algorithm edit — new runId, new directory
```

Every algorithm edit changes the `runId` (the dirty-diff hash feeds it), so each iteration lands in
its own directory rather than resuming the previous one.

## Using it

Point a fast-loop run here with `OUTPUT_DIR` — full runbook in
`llm-basic-framework/docs/RUNNING-EXPERIMENTS.md` §3b:

```bash
OUTPUT_DIR=../storage/cert.gov.ua/processed/experiments-dev \
  INPUT_DIR=/tmp/subset-dev-software CATEGORIES=Software \
  STEPS=streamingPipeline FLOW=incremental CONDITION=fastloop-software \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:e2b-16k DECISIONS_LOG=1 npm start
```

Compare two iterations:

```bash
npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software \
  --run <dirA> --run <dirB>
npm run view -- --run <dirA> --run <dirB> --out compare-iterations.html
```

Delete freely — nothing here is an input to any published result.
