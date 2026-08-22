# SKOS campaign log — 2026-08-22 (session state / recovery document)

Branch `feature/skos-graph-registry`. This file is the recovery anchor for the session that built
the SKOS graph registry, migrated to SKOS/ISO 25964 vocabulary (registry v6), and ran the
gemini-flash experiment matrix. Read it top-to-bottom to resume.

## 1. What the branch contains (all committed with this doc)

1. **Ladder removed, SKOS graph in** (replaces ladder discovery entirely; catch-up ported as
   count-triggered pass — see §5 for its fate). Prompt `listwise-skos-v1` (letter codes v/n/p/b;
   `b` = mention is broader, endpoints swap). `listwise-skos-v2` = word-code ablation (LOST:
   letters stay).
2. **Registry v6 = SKOS/ISO 25964 vocabulary everywhere**: `conceptSchemes[scheme][prefLabel]` →
   `Concept{labels: LabelRecord[], definition, ...}`; `broaderEdges[scheme][]` →
   `BroaderEdge{narrower, broader, type: broaderGeneric|broaderPartitive|broaderInstantial|null,
   similarityScore, ...}` (BTG/BTP/BTI per iso-thes; v=BTI, n=BTG, p=BTP). Class renames:
   `ConceptRegistry` (dir `src/ConceptRegistry/`), `ConceptRef`. All v1–v5 files load via
   `ConceptRegistry.parse` (never rewritten). Journal op `broader-edge` (dual-read of old
   `granularity-edge` everywhere). Frozen dialects: prompts+hashes, LLM verdict fields
   (`edgeKind`/`gloss`), gold kinds, repair-signature JSON keys, `'name+gloss'` id,
   `SKOS_CATCHUP_*`. Verified: byte-identical evaluate/fold pre/post migration; 942 tests green.
3. **Exporter** `npm run export-skos`: isothes:broader{Generic,Partitive,Instantial} +
   materialized skos:broader + RDF-star `{| skein:similarityScore |}`.
4. **Rollup**: `rollupTarget(scheme, concept, {threshold|null, contract, score})`;
   `npm run fold -- --rescore max-labels` = state-aware max-over-label-pairs rescoring (fixes
   canonical-name lottery; demonstrated: recovers Office-version folds at threshold 0.7).
5. **New knobs** (all in runId): `ORDER=numeric-id|reverse|seededShuffle:<seed>`;
   `SNIPPET_MODE=head|none|anchored|per-mention`; `JUDGE_UNRESOLVED=1`;
   `SKOS_CATCHUP_EVERY` (0=off) / `SKOS_CATCHUP_WIDTH`; `LISTWISE_K`;
   `EMBEDDINGS_PROVIDER=gemini` + `EmbeddingsBackendGemini` (AI Studio, GEMINI_API_KEY,
   `gemini-embedding-2`, 3072 dims). `npm run order-ari` = cross-order identity ARI + edge
   Jaccard + type agreement.
6. **Gold expanded** 249 → 280 edges (`rule: manual-review-2026-08-22`, 31 edges: 19 Chromium-family
   isa, 8 Windows-component part-of, ChakraCore→Edge part-of, TRYxaEbX(.ps1/_2.ps1)→TRYxaEbX isa,
   host_news_mod_mod.msi→Електронний запит.exe part-of; rejected xlsx→Excel and UkrScanner pair).
   Pre-review backup: `gold/gold.json.pre-review-backup`. Validates clean.
7. **Docs**: `docs/TERMINOLOGY-ALIGNMENT.md` (paper vocabulary map + ISO row + v6 migration note).

## 2. Experiment protocol (dev-software-22, non-reportable, iteration only)

Subset via `npm run make-subset -- --list gold/subsets/dev-software-22.txt --from
../storage/cert.gov.ua/fetched --to <dir>`; bootstrap→pre-seed frozen gpt-5 extractions→rerun
(CLAUDE.md §"Testing one scoped case"). Base env: `STEPS=streamingNormalizer FLOW=incremental
CATEGORIES=Software DECISION_STRATEGY=listwise-graph LISTWISE_PROMPT_ID=listwise-skos-v1
CANDIDATE_GENERATOR=union-rr CANDIDATE_K=10 CANDIDATE_MIN_SIM=0 REPAIR=0 EMBEDDINGS=1
EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=embeddinggemma SKOS_CATCHUP_EVERY=25
SKOS_CATCHUP_WIDTH=40 DECISIONS_LOG=1`. Judges: `gemini/gemini-3.7-flash` and local
`ollama/gemma4:12b-64k`. Score: `npm run evaluate -- --gold gold/gold.json --split dev
--allow-dev --category Software --hierarchy-all-splits --run <dir>...`.

## 3. Results (all vs the EXPANDED gold; identity = 1.000 everywhere, NIL F1 0.966, in EVERY arm)

Run dirs under `storage/cert.gov.ua/processed/experiments-dev/experiments/`:

| condition (dir date-prefix 2026-08-2x) | edges | P | R-reach | kind | note |
|---|---|---|---|---|---|
| software-gem37-v8 (ladder baseline, old gold: P .600 R .682) | 25 | — | — | — | pre-SKOS |
| skos-graph-v1-8ce2… / skos-v2-words-c183… | 49/38 | — | — | — | words LOST ablation |
| skos-v6-gem37-637f3a48ae68 (K4 head, baseline) | 45 | .756 | .642 | .912 | |
| skos-v6-gem37-k10-e385… (LISTWISE_K=10) | 46 | .804 | .698 | .919 | best single change |
| skos-v6-gem37-snip-none / -anch / -perm | 40/42/53 | .775/.619/.660 | .585/.491/.660 | .935/.923/.914 | per-mention best recall |
| skos-v6-gem37-gembed2-54b1… (gemini-embedding-2) | 34 | .853 | .547 | .931 | best precision; blocker r@4 88.1 vs 85.6, r@10 93.7 vs 90.7; sim band .60–.93 vs .45–.80 |
| skos-v6-gem37-pkg (gembed2+perm+K10) | 37 | .595 | .415 | .864 | catch-up collapse (8 cu-edges), not refuted |
| skos-v6-gem37-nocu / k10-nocu (CATCHUP=0) | 24/22 | .708/.773 | **.321/.321** | .824 | catch-up = half the recall; K10 gain flows THROUGH catch-up |
| skos-v6-gem37-k10-nocu-ju (JUDGE_UNRESOLVED=1) | 25 | .800 | .377 | .850 | bypass fix helps some |
| gemma12b: skos-v6-gemma12b-386cf… (numeric) done; -rev/-s1/-s2 DEFERRED (partial dirs may exist — delete strays) | 38 | — | .545(old gold) | — | resume later |

**Order robustness** (4 gemini order arms: 637f=numeric, rev-6d3f, s1-a507, s2-b2cb):
identity ARI mean **.956**; edge Jaccard **.306**; type agreement .874. Cause isolated: doc-edges
stable (20–33/arm), catch-up edges 1–21/arm (trigger+sample luck). Catch-up = dominant
order-dependence vector.

**Key mechanism findings**: (a) zero-candidate mentions bypassed the judge (fixed by
JUDGE_UNRESOLVED); (b) even on-ballot, the judge declines knowledge-only family edges
(browsers→Chromium) on wide doc ballots but asserts them on catch-up ballots — because catch-up's
*dense retrieval per concept* puts family members in the options; (c) catch-up IS the same
machinery (same prompt/blocker/ballot; deltas: no source text, link→merge, self-excluded).

## 4. Cost/quality snapshot

SKOS arm ≈ 34% cheaper than ladder arm at equal hierarchy/identity. gemma thinking tokens inflate
its token counts (~397k hidden reasoning). No price entry yet for gemini models
(config/model-prices.json TODO).

## 5. Agreed direction & next steps (user decisions)

1. **User wants NO catch-up.** Agreed replacement: **deterministic end-of-stream consolidation** —
   same machinery, trigger changed to fixed point (stream end; checkpoints for endless streams),
   sample = ALL concepts chunked into WIDTH-sized passes. Order-independent by construction.
   NOT YET IMPLEMENTED — next task. Then re-run K10 arm to confirm recall returns (~.70) without
   variance. Optional bonus: `listwise-skos-v3` prompt nudging in-document family edges.
2. Then: replicates of K10 vs package under the deterministic pass; resume gemma arms (STRICTLY
   sequential on GPU — user instruction); full-corpus test-split runs + bootstrap CIs (paper gate);
   price entries; event-driven hierarchy suspects idea remains on file as alternative.
3. Paper assets ready: TERMINOLOGY-ALIGNMENT.md, ISO 25964/BTG-BTP-BTI story, ablation ladder
   (none→head→anchored→per-mention), letters-vs-words negative result, order-robustness split
   (identity stable / consolidation not), encoder comparison, chrome_updater.dll qualitative case,
   drift-threshold-is-encoder-relative figure (embeddinggemma .52–.83 vs gembed2 .60–.93;
   cos("Microsoft Office 2007","MS Office") .68 vs .84).

## 6. Operational notes

- Runner scripts live in the session scratchpad (`run-one-arm.sh`, `run-snippet-arm.sh` + sed
  variants) — /tmp is volatile; recreate from §2 env if gone.
- gemma arms: never run two 12b arms concurrently (user rule); embeddinggemma alongside is fine.
- Order-arm comparisons: keep code frozen across arms of one comparison.
- Delete stray bootstrap dirs (partial gemma rev/s1/s2 attempts) before resuming those arms.
- 942 tests, tsc clean at commit time. `test/gate.test.ts` + `registry-v1.json` fixture untouched.
