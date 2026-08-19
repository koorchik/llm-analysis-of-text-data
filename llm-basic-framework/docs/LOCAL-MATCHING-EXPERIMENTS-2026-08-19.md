# Judge size vs prompt, 2026-08-19/20

Follow-up to the `gemma4:26b-16k` probe in `LOCAL-MATCHING-EXPERIMENTS-2026-08-18.md`, which found the
larger judge scoring **worse** (pairwise F1 0.571 vs 0.889) while making fewer identity errors.

That inversion was not a capability limit. It was two separate defects stacked:

1. **The prompt never stated the written-form rules.** `listwise-select` says "if uncertain, choose
   NEW ENTITY" and lists no rule for `X` vs `X .NET` vs `X.bin`, so a judge that follows instructions
   faithfully refuses exactly the merges gold scores. The small judge took them on string similarity
   and got credit while making four false merges the metrics never see.
2. **The harness discarded verdicts from literal judges.** The prompt renders each mention in quotes
   (`1. "shellcode.x64.bin" (Software)`), and `gemma4:26b-16k` echoed it back the same way —
   `"mention": "\"shellcode.x64.bin\""`. `keyOf` in `ListwiseMintCandidateDecision.ts` keyed on the raw
   string, missed, and minted. Both `shellcode.x*.bin` merges had been **answered correctly** and were
   thrown away. Fixed here by folding wrapping quotes before keying (2 regression tests).

With both fixed, every judge beats its smaller sibling on every category and 26b matches 12b exactly.

All runs: frozen gpt-5 extractions, `STEPS=streamingNormalizer`, `DECISION_STRATEGY=listwise-mint-candidate`,
`CANDIDATE_GENERATOR=union`, `CANDIDATE_K=10`, `CANDIDATE_MIN_SIM=0`, `REPAIR=0`,
`LADDER_MIN_EXAMPLES=100000`, `EMBEDDINGS_MODEL=embeddinggemma`, `LISTWISE_K=4`, single category,
committed subsets. Non-reportable (dev/test single-category slices over subset corpora).

## 1. The matrix (post-fix, one code version)

Pairwise cluster F1. Software and HackerGroup on `--split dev --allow-dev`, Country on `--split test`
(all Country multi-member clusters are test-split). `-fx-` run dirs.

| judge | VRAM fit | Software (22 docs) | Country (14 docs) | HackerGroup (11 docs) |
|---|---|---:|---:|---:|
| `e2b-16k` base | fits | 0.444 | 0.429 | 0.000 |
| `e2b-16k` + v6 | fits | 0.750 | 0.842 | 0.400 |
| `12b-16k` base | fits | 0.571 | 0.952 | 0.500 |
| **`12b-16k` + v6** | **fits** | **1.000** | **0.952** | **1.000** |
| `26b-16k` base | spills | 0.571 | 0.952 | 0.500 |
| **`26b-16k` + v6** | spills | **1.000** | **0.952** | **1.000** |
| `31b-16k` base | spills | 0.571 † | 0.952 | 0.500 † |
| `31b-16k` + v6 | spills | 0.889 † | 0.952 | 1.000 |

† degraded by dropped calls — see §4.

Two readings of the same table:

- **The prompt is worth more than the model.** v6 moves every judge; `12b` goes 0.571 → 1.000 on
  Software and 0.500 → 1.000 on HackerGroup without changing anything else.
- **Bigger never hurts any more.** Under v6, 26b ≡ 12b on all three categories, and both dominate e2b.
  Before the two fixes, 12b and 26b both sat at 0.571 while e2b showed 0.889.

## 2. The prompt variants

`prompts/listwise-select-nameform-v{4,5,6}.md`, selected with `LISTWISE_PROMPT_ID`; each a strict
superset of the previous. Deliberately written with placeholder names, no CERT-UA vocabulary.

- **v4** — written-form identity rules (vendor prefix, spacing/punctuation, bracketed descriptor,
  extension/platform suffix, generic type word, acronym-vs-expansion, transliteration/translation) plus
  the matching non-identity rules (version/edition differs, part-of, artifact-vs-program, different base
  name).
- **v5** — v4 plus identifier precedence: in `K-12 (Foo)` / `Foo (K-12)` the identifier carries the
  identity and the bare label is a broader entity.
- **v6** — v5 plus exact-identifier matching: when options differ only by a code, number, or a few
  characters, match those characters exactly.

The v4→v5→v6 sequence was driven by observed failures, each step fixing one and holding the rest:

| 12b judge | Software | Country | HackerGroup |
|---|---:|---:|---:|
| base | 0.571 | 0.952 | 0.500 |
| v4 | 1.000 | 0.952 | 0.500 |
| v5 | 0.727 | 0.952 | 1.000 |
| v6 | 1.000 | 0.952 | 1.000 |

v5's identifier rule fixed HackerGroup (`APT28 (UAC-0028)` moves off the bare `APT28` label onto
`UAC-0028`, as corrected gold requires) but cost Software one merge — it linked `shellcode.x64.bin` to
the **x86** entity. v6's exact-identifier sentence recovers it. Both v5 runs and both v6 runs were
replicated: identical scores, identical decisions.

## 3. Registry diffs, not just F1

The slices are ~5 scorable clusters wide, so one merge moves pairwise F1 by ~0.15 and false merges on
unlabelled pairs are invisible to every metric in the table.

- `12b + v6` on Software takes all five reachable gold clusters **and** makes zero wrong merges — every
  off-gold link is correct (`Microsoft Word`→`MS Word`, `Office 2007`→`Microsoft Office 2007`,
  `AgentTesla`→`Agent Tesla`, `RemoteUtilities`→`Remote Utilities`, `SRP` expansion).
- On Country, `12b` links all seven cross-lingual pairs correctly with either prompt, including
  stratum (b) at P=R=1.000 — the script-bridging that only cloud `gpt-5-6-sol` managed in the
  2026-08-08 four-arm study. `e2b` merges `India`→`China` and misses Russia variants.
- Country's one remaining miss under k=4 is **retrieval, not judging**: `Польща` sits at rank 5,
  outside the visible list. `LISTWISE_K=6` recovers it (1.000, fewer tokens) but costs Software one
  false merge (1.000 → 0.909), consistent with 2026-08-18's finding that wider lists hurt that loop.

## 4. Two caveats about the extremes

**`e2b-16k` is noisy.** Its Software baseline scored 0.889 on 2026-08-18 and 0.444 here — same config,
same gold, different sample. Sampling is left at the provider default (`sampling.effective` is empty in
every run card), so single e2b numbers should not be trusted; the 0.889 that made e2b look like the
Software winner was a favourable draw. The 12b arms, by contrast, reproduced identically across every
replicate taken (v4 ×2, v5 ×2, v6 ×3).

**`31b-16k` does not fit and its runs are degraded.** 19 GB model, 16 GB card: heavy CPU offload, and
requests die with `fetch failed` — 8 of 24 Software judge calls on the base arm, 8 of 24 on the v6 arm,
4 of 6 HackerGroup calls. A dropped call mints every mention in that document, so 31b's numbers are a
floor, not a measurement.

The v6 Software arm shows this exactly: 0.889 rather than the 1.000 that 12b and 26b reach, and the
four documents whose calls died include `2660` — the Office document carrying gold cluster g86, the one
cluster it misses. Its `merge R (c)` is 1.000, so every pair it was actually asked about, it got right.
26b (17 GB) spills too but completed every call. Nothing here suggests 31b judges worse given headroom;
it simply cannot be measured on this box.

## 5. Recommended local policy

```
LLM_MODEL=gemma4:12b-16k                              # 26b scores the same and is ~2.5x slower
LISTWISE_PROMPT_ID=listwise-select-nameform-v6
DECISION_STRATEGY=listwise-mint-candidate
CANDIDATE_GENERATOR=union CANDIDATE_K=10 CANDIDATE_MIN_SIM=0
REPAIR=0 LADDER_MIN_EXAMPLES=100000
LISTWISE_K=4        # 6 for Country
```

Wall clock per Software arm (22 docs): e2b ~140 s, 12b ~480 s, 26b ~1100 s, 31b ~3000 s.

## 6. Limits

The v4→v6 rules were written **after reading the failures on these slices**, so this measures "can the
prompt express what these judges were missing", not out-of-sample quality. Five scorable Software
clusters, six Country, two HackerGroup. The honest next gate is the promotion ladder in
`RUNNING-EXPERIMENTS.md` §3b: full-corpus `CATEGORIES=Software` (204 docs, 40 test-split multi-member
clusters, ~75 min on the 12b judge), base vs v6, before any of this is quoted as a result.

## Run artifacts

Under `../storage/cert.gov.ua/processed/experiments-dev/experiments/`. The post-fix matrix is the
`*-fx-*` set (24 arms: `{country,hackergroup,software}-{e2b,12b,26b,31b}-fx-{base,v6}`). The pre-fix
prompt-iteration runs (`*-nameformv{4,5,6}*`, plus their `-rep2` replicates and the `-k6` variants) are
kept because §2 and §3 cite them; their absolute numbers for 26b are superseded by the `-fx-` rows.
