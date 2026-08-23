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

## 5b. Evening session — catch-up replaced by streaming-native mechanisms (2026-08-22, uncommitted)

**User constraint that reshaped §5.1: the stream is never-ending — an end-of-stream pass is
catch-up relocated, not eliminated. The solution must live inside the per-document loop.**

**Diagnosis** (transcripts, both directions): the judge asserts hierarchy parents it sees in a
mention's own OPTIONS row and, on large ballots, nowhere else — reverse-order doc 3028 wrote
"Chromium-based web browser" as 15 glosses while answering 15 null parents, with Chromium at E74.
Catch-up's whole advantage = dense per-concept retrieval put family into options. K is irrelevant.
Flash judge is nondeterministic even at TEMPERATURE=0 (v5 numeric .696 vs replicate .377): the
~25-edge browser-family ballot is a coin flip in every prompt-only variant.

**New knobs** (all runId-folded; code in StreamingNormalizer/ListwiseGraphDecision/bin/app.ts):
`TEMPERATURE` (now set 0 in all arms); prompts `listwise-skos-v3` (hierarchy from world knowledge,
scan whole E-list), `-v4` (set-level `e` edge list — no effect, .333), `-v5` (gloss BEFORE p in
section+key order, contradiction rule), `-v6` (v5 + kin rule); `DOC_SIBLINGS=N` +
`DOC_SIBLINGS_MODE=options|kin` (top-N embedding-nearest same-category co-mentions into the
options row / as `kin:` refs); `REASK_PARENTLESS=1` (re-mentioned concept with no broader edge
returns to the ballot as a hierarchy-only row: self-excluded options, dense retrieval, identity
verdict ignored — the catch-up row shape, triggered by the stream itself); `SKOS_CONSOLIDATE=end`
(deterministic full-registry end pass — built and measured as ANCHOR ONLY, rejected as solution
per the never-ending-stream constraint).

**Gold**: 280 → 296 (`manual-review-2026-08-22b`, backup gold/gold.json.pre-review2-backup):
Google Chrome/7Star/Amigo/Liebao/Citrio/Opera→Chromium isa, IceDragon→Firefox isa,
RegAsm.exe→.NET part-of, Equation Editor→MS Office part-of, WinServer 2008/2012→Windows isa
(2003 precedent), Browser/Files/Screen/Social/USB.dll→SPECTR part-of (ext\ path, doc 6280422).
Rejected: Office Services and Web Apps→Office; scan.exe (CredoMap_v2)→CredoMap_v2. Annotator
marked "pending koorchik approval".

**Results vs expanded gold** (dev-software-22, non-reportable; R-reach / P / identity-pairwise;
arms numeric, numeric-replicate, reverse; all T=0, CATCHUP=0, JUDGE_UNRESOLVED=1):

| config | numeric | replicate | reverse | verdict |
|---|---|---|---|---|
| with catch-up (K4/K10 anchors, T default) | .551 / .84 | — | — | old baseline |
| v1 no-catch-up (pctrl) | .333 / .96 / 1.0 | — | — | family never lands |
| v3 (T default) | .797→.449 | flip | .319–.449 | coin flip |
| v5 T0 | .696 | .377 | .406 | coin flip persists |
| v5+DOC_SIBLINGS options (sib) | .806 | .836 | .768 | 3/3 hierarchy; identity 1/3 miss (shellcode.x64 twin) |
| v6+kin | .826 | .435 | .768 | annotation ≠ options texture |
| v5+REASK (reask) | **.826 / .93 / 1.0** | .739 | .377 | reverse has no re-mention of the family |
| v5+SKOS_CONSOLIDATE=end (ANCHOR) | .779 | .768 | .783 | re-ask guarantee confirmed; rejected per constraint |
| **v5+REASK+DOC_SIBLINGS options (combo)** | **.754 / .91 / 1.0** | **.797 / .83 / 1.0** | **.731 / .91 / 1.0** | **WINNER: stable, order-robust, identity 1.0 in all three, 22 calls** |

Combo cross-run agreement: edge Jaccard .598 (vs .306 catch-up era), type agreement .942.
Reverse-order identity dip (.750 pairwise, one c-stratum merge) recurs in EVERY rev arm regardless
of mechanism — an order effect, notably ABSENT in combo-rev.

**Recommended streaming config** (no catch-up, no end pass): `LISTWISE_PROMPT_ID=listwise-skos-v5
TEMPERATURE=0 JUDGE_UNRESOLVED=1 REASK_PARENTLESS=1 DOC_SIBLINGS=2 DOC_SIBLINGS_MODE=options
LISTWISE_K=6 SKOS_CATCHUP_EVERY=0`. Mechanism split: sibling options make the first-shot family
ballot reliable (in-row texture); re-ask gives every later co-occurrence another chance
(streaming-native re-review); v5's gloss-before-p supplies the knowledge at decision time.

**Next steps**: replicates ×3+ of combo for CI; gemma4:12b-64k transfer of combo (sequential!);
full-corpus test split; gold 16-edge batch needs koorchik sign-off; optional: repair-pass
interplay (REPAIR=1) since StreamingRepairer should catch the sib-mode identity misses.

## 5c. Night session — the one-carry orphan rule + review-frame split; catch-up fully replaced on BOTH judges (2026-08-23)

**User's design (`REASK_CARRY=1`): carry the PREVIOUS document's parentless mints onto the next
document's ballot as hierarchy-only reask rows — once, ever.** Bounded by construction; one
document later the co-minted family is in the registry, so dense retrieval prints the right
parent into the row. Complements `REASK_PARENTLESS=1` (re-mention trigger), which alone cannot
cover single-occurrence families — measured: the browser family exists ONLY in doc 3028's
extraction, so no re-mention ever fires for it.

**`REASK_SPLIT=1`**: reask/carried rows go to a SEPARATE source-free "registry review" call (the
catch-up frame at document cadence; +1 call per carrying document). Motivated by the frame
finding: gemma asserted MS Word→MS Office on catch-up-framed rows and on none of the same rows
inside a document ballot. **Prompt `listwise-skos-v7`** = v5 + vulnerability-identifier rule
(a CVE/advisory is not narrower than the product it affects) — carried CVE orphans otherwise
placed themselves under products (14 of 26 non-gold edges).

**Final configs** (both no catch-up, no end pass; `SKOS_CATCHUP_EVERY=0 JUDGE_UNRESOLVED=1
REASK_PARENTLESS=1 REASK_CARRY=1 LISTWISE_PROMPT_ID=listwise-skos-v7`):

| judge | extra | R-reach | P | identity | vs own catch-up baseline |
|---|---|---|---|---|---|
| gemini-3.7-flash | `TEMPERATURE=0`, split OFF | .855 / .855 / .797 (num/rep/rev) | .87–.93 | 1.000 all | .551 → +.30; split variant equal but 2× calls |
| gemma4:12b-64k | default temp (T=0 loops thinking to 64k cap!), `REASK_SPLIT=1` | **.623** | **.694** | 1.000 | **.304 → 2×**, P .553→.694, kind .857→.907 |

Attribution audit of gemma-split's .623 (per-call): review calls contributed ~8 edges directly
(18 fired / 8 answered / 1 looped to length cap); the 25 Chromium-family edges landed in doc
3028's own DOC-framed call via v7's gloss-before-parent ordering (gloss "a Chromium-based web
browser" → p:E47, 25 rows; v1-era glosses on the same ballot said "web browser", p:null). At
gemma's default temperature that first shot is a sampling event (a prior v7 run nulled the same
ballot) — REPLICATES REQUIRED before quoting .623. The knowledge was in the 12b model; the
document frame plus pre-v7 prompts suppressed it (with-catch-up baseline: 0 family edges).
Retired: DOC_SIBLINGS options injection (broke gemma identity to .500 — written-form links lost),
kin annotations (information without row membership does not move the judge), SKOS_CONSOLIDATE=end
(anchor only — rejected for never-ending streams; its .77–.78 band confirmed the re-ask
mechanism the streaming devices now deliver incrementally).

**Protocol notes**: TEMPERATURE is NOT folded into the runId (flag for determinism statement);
gemma must run at default temperature; sibling-free identity rows are load-bearing for small
judges. Follow-ups: gemma split reverse/replicate arms; combo of split+flash for cost-insensitive
runs; full-corpus test split; per-mention snippet × carry interplay.

## 6. Operational notes

- Runner scripts live in the session scratchpad (`run-one-arm.sh`, `run-snippet-arm.sh` + sed
  variants) — /tmp is volatile; recreate from §2 env if gone.
- gemma arms: never run two 12b arms concurrently (user rule); embeddinggemma alongside is fine.
- Order-arm comparisons: keep code frozen across arms of one comparison.
- Delete stray bootstrap dirs (partial gemma rev/s1/s2 attempts) before resuming those arms.
- 942 tests, tsc clean at commit time. `test/gate.test.ts` + `registry-v1.json` fixture untouched.
