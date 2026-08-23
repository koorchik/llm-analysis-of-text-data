# Design justifications: the v8 streaming SKOS architecture and the findings that forced it
(2026-08-23 — article source material; every decision below cites the measurement that motivated
it. Dev-subset numbers are non-reportable in absolute terms; they justify *relative* choices.)

## 0. The final architecture (what is being justified)

Per document, exactly 1–2 LLM calls; the registry is FINAL for the stream prefix after each
document — no queues, no counters, no end-of-stream steps, no cross-document debt:

- **Pass 1 — document ballot** (always): identity + gloss only. Per-mention evidence windows,
  JSONL output, one row per unresolved mention, options = top-K identity retrieval, untouched by
  any hierarchy machinery.
- **Pass 2 — registry review** (optional; fires only when there is work): source-free frame
  ("registry review at N canonicals"). One row per question, each row needing exactly ONE option
  slot: (a) this document's parentless new mints (parent question against the post-mint registry);
  (b) its re-mentioned still-parentless concepts; (c) gap-swept parentless registry concepts
  embedding-near the new mints (late-parent healing). Judged by the same listwise judge with the
  hierarchy prompt (listwise-skos-v7); on the small local judge, sampled N times with a
  hierarchy-union merge (JUDGE_SAMPLES).
- Hierarchy store: typed SKOS/ISO-25964 broader edges (BTG/BTP/BTI), DAG with write-time
  acyclicity, poly-hierarchy by accrual; single-parent-per-assertion; reverse (`b`) direction
  supported; rollup linearizes at read time by best-scoring edge.

Flash validation of exactly this build: reachable edge recall .812 / .882 / .884
(numeric / replicate / REVERSE order), precision .76–.80 nominal (≈.93 after separating gold
under-coverage), identity pairwise F1 1.000 in all three. Reverse being the BEST arm is the
architecture's signature: when every document leaves the registry final, arrival order stops
being a treatment. Local judge (gemma4:12b-64k, JUDGE_SAMPLES=2, numeric): reachable recall .677 / precision .647 /
kind agreement .932 / identity 1.000 — 2.2× its with-catch-up baseline (.304/.553) and above the
prior local best (.623, which depended on a lucky first-shot draw). Every edge came from the
pass-2 review call: pass 1 contributes no hierarchy by construction, so the number is the
mechanism's, not a sampling accident.

## 1. Why hierarchy left the document call (the frame finding)

**Issue.** The small judge answers knowledge questions by FRAME, not by content: gemma asserted
MS Word→MS Office on every source-free registry-review row and on none of the identical rows
inside a document-framed ballot; its with-catch-up baseline owed all its knowledge edges to the
review frame. On the frontier judge the same effect appears as conservatism ("the source doesn't
state it").
**Decision.** All hierarchy questions moved to a source-free pass 2; pass 1 asks only what the
document can actually evidence (identity, gloss).
**Rejected alternative (measured).** Keeping hierarchy in the doc call and exhorting the judge:
three prompt rewrites (world-knowledge framing v3; mandatory-full-list-check "allcand";
mandatory-checklist "twostep") all left the assertion rate unchanged (§6).

## 2. Why catch-up was removed (and what replaced it)

**Issue.** The growth-triggered registry-wide catch-up pass supplied HALF of hierarchy recall
(.642 with vs .321 without) — but was the dominant order-dependence vector (cross-order edge
Jaccard .306; doc-edges stable 20–33/arm while catch-up edges swung 1–21/arm on trigger and
sample luck), and it is architecturally incompatible with a never-ending stream (an end-of-stream
consolidation is catch-up relocated — measured as an anchor at .768–.783, then rejected on the
same streaming grounds).
**Decision.** Catch-up's two secret ingredients were identified and re-delivered inside the
per-document loop: (a) dense per-concept retrieval that puts the right relative INTO the row
(§3), and (b) the source-free frame (§1). Triggers are document events only: same-document
re-ask for new mints; re-mention re-ask for stragglers; gap sweep for late parents.

## 3. The row-composition law (the central mechanism finding)

**Issue.** The judge asserts hierarchy relations almost exclusively toward entities printed in
the mention's own options row. Direct evidence: on doc 3028 (30 browsers + Chromium co-mentioned)
every parent the judge asserted sat inside the asserting row's options; Chromium — present in the
shared entity list as E47, explicitly allowed by the prompt — was never chosen from the list
alone: 15 rows carried the gloss "Chromium-based web browser" AND `p:null` in the same response.
In catch-up ballots, where dense retrieval put Chromium into the options, the same judge asserted
the family (7 edges in one call, including for a row whose own options lacked it once several
neighbouring rows showed the pattern).
**Decision.** Every hierarchy mechanism is shaped as "give the concept a row whose options
contain its likely relative": review rows are built by per-concept dense retrieval; the child
sweep gives each waiting child its own row where the new parent occupies one option slot.
**Rejected alternatives (measured).** (a) Prompt exhortation to scan the full list — no effect
(§1, §6). (b) `kin:` row annotations naming sibling E-numbers — information without row
membership; unreliable (.826/.435/.768 across runs). (c) Injecting siblings into the identity
options row — works on flash (3/3 family) but destroys small-judge identity (§4).

## 4. Why identity rows are untouchable

**Issue.** Injecting embedding-near co-mentions into the identity options row (DOC_SIBLINGS
options mode) broke gemma's written-form alias linking wholesale: pairwise identity F1 1.000 →
.500 — every vendor-prefix variant link lost (Microsoft Office ↛ MS Office), plus one false
merge. The same injection was harmless on flash.
**Decision.** Identity options are never polluted by hierarchy aids, on any judge. Hierarchy
candidates live in pass-2 rows; identity retrieval stays exactly the measured-1.000
configuration. (Also why pass 1 sampling is fixed at 1: identity never flipped in any run.)

## 5. Late parents: recognition over recall (multi-child design)

**Issue.** Documents arrive in any order; a broader concept can arrive after its children. The
per-row dialect caps one relation per row, so an arriving hub linked at most ONE waiting child
(measured: 1/25, deterministic, three samples). Two multi-child output dialects were then
validated on a constructed provable case (25 real Chromium forks + 9 trap negatives incl. a
Firefox fork): flash answered the `c` array at 24–25/25 and the comma-string at 25/25 (six
samples), zero false children. BUT: (a) the `c` field can only reference entities ON the ballot,
and a late parent's ballot carries only its own top-K candidates — most waiting children are not
addressable; (b) the small judge managed only its 4 famous forks per heads-draw, with the mode
coin on top, and its widest draw admitted the trap negative.
**Decision.** Child-side "neighborhood re-ask": on each new mint, reverse-query the embedding
index for parentless concepts near it and give EACH child its own pass-2 row — N-to-1 recognition
(one option slot needed, the measured-reliable shape) instead of 1-to-N exhaustive recall. The
`c` comma-string dialect remains validated-and-shelved for frontier judges.
**Refinement (adopted from external review, then implemented).** Gap detection instead of naive
top-K for the sweep: walk the similarity ranking, stop at the first gap > 0.08 or below floor
0.5, hard cap 50, no minimum — a real hub pulls its whole densely-clustered family, a non-hub
mint pulls nobody, so review ballots are all-signal.

## 6. The mode coin (small-judge reliability) and why sampling, not wording

**Issue.** On family-heavy ballots gemma is bimodal: a response asserts ~26/27 of the family or
exactly 0 — never in between — at roughly ⅓ heads. Measured wording immunity: v7 baseline,
"allcand", and "twostep" all ⅓-ish; the winning draws visibly use their own gloss, the losing
draws write the SAME gloss and still answer null. Two auxiliary pathologies: T=0 loops hidden
thinking to the 64k cap with EMPTY content (finish=length) — greedy decoding is unusable locally
while it is what stabilizes flash; and forcing num_ctx to 96k made answers lazy
(blanket g:null,p:null) — bigger context degraded the 64k-tuned build.
**Decision.** Default temperature locally; 64k context; reliability via JUDGE_SAMPLES=N — the
same ballot judged N times, hierarchy answers unioned (identity from first sample). Justified by
the bimodality itself: heads-samples are near-perfect precision, so union adds recall at
negligible precision cost. One spare attempt absorbs an empty/looped response.
**Rejected alternatives (measured).** (a) `cat` rationale-bridge field (external suggestion):
heads ⅓→~½ (n=4) but introduced a TOXIC tails mode — one draw asserted 65 junk parents where
plain-v7 tails are harmless nulls — and only cat runs exhibited escaped-quote JSON degeneration;
usable, if ever, only behind 2-of-N voting. (b) Schema-constrained decoding: >40 min/call through
the thinking model — disqualified on latency. (c) Prompt wording — immune, as above.

### 6b. Per-pass decoding (the "hybrid") — promising probe, unresolved corpus run

Probe-level, the review pass is strictly better WITHOUT thinking at T=0: 27/28 family parents,
byte-identical across draws, ~22 s vs ~200 s (the T=0 pathology lives in the thinking channel;
remove the channel and greedy is stable). Corpus-wide, thinking OFF everywhere collapses identity
(pairwise 1.000 → .571) — deliberation is load-bearing for written-form linking. The per-pass
hybrid (thinking pass 1, no-thinking T=0 pass 2; plumbed as per-strategy decoding overrides
REVIEW_THINK / REVIEW_TEMPERATURE) should combine both, but its first validation arm failed
identity on the hard-merge stratum with a confounder present (an ollama server reconfiguration
restart mid-run) and one clean replication pending. STATUS: the RECOMMENDED local configuration
remains v8 + thinking + JUDGE_SAMPLES=2 (.677, identity 1.000); per-pass decoding is recorded as
the next optimization candidate, not a validated result. The asymmetry finding itself (thinking
helps name-form recognition, hurts relation assertion) stands on the probe + all-nothink data.

## 7. Transport: JSONL for big ballots

**Issue.** On 74-row ballots the small judge intermittently truncates or malforms the single
nested JSON object — total parse loss (mint-all fallback for the whole document).
**Decision.** Pass-1 output is JSONL (one verdict object per line, no wrapping array): a
truncated response loses a suffix, not everything. Measured: 73/73, 73/73, 71/73 rows recovered
line-wise on draws whose nested-JSON siblings had failed outright.

## 8. Evidence windows: per-mention snippets as default

**Issue.** The historical evidence block (document head, first 600 chars) frequently does not
contain the mentions being judged (the corpus buries entity tables mid-document). The ablation
showed structure matters more than content: head .642 R / none .585 / anchored .491 (UNLABELED
mention windows — worse than no evidence at all: a fragment soup misleads) / per-mention .660
(same windows, numbered S1…, each row binding `ctx: S2`).
**Decision (user).** Default = per-mention; anchored is dominated on identical content and
retired to the ablation record. In v8, evidence exists only in pass 1, so the mode's job narrows
to grounding identity + gloss — and gloss quality compounds through retrieval (§9).

## 9. Glosses as retrieval infrastructure (why `g` exists and where it acts)

**Finding.** The gloss is written in the same response that decides the mention, so it cannot
help its own ballot; its value is downstream: (a) stored as the concept's definition; (b)
embedded in the `name+gloss` representation that drives the dense retrieval channel — the bridge
that makes name-dissimilar pairs (chrome_updater.dll ↔ its family) findable by later review rows
and the child sweep; (c) gloss-ANN duplicate suspects in repair. Prompt-side ordering matters:
writing the gloss BEFORE the parent field (v5+) is the visible mechanism in winning draws
("a Chromium-based web browser" → p:E47 twenty-five rows in a row).

## 10. Relation typing decisions

- Vulnerability identifiers are not narrower than the product they affect (v7 rule): added after
  carried CVE orphans placed themselves under products (14 of 26 non-gold edges in one arm);
  restored precision .73→.87–.93 at equal recall.
- Reverse direction (`b`) is supported end-to-end (endpoints swapped at write) but types coarsely
  (always BTG); the multi-child dialect types each child individually — recorded as the fix if
  reverse typing ever matters.
- Residual known error class (flash v8 autopsy): "written-on/runs-on platform" mistaken for
  narrower-of (Agent Tesla → .NET Framework) — 3 edges; candidate for a future prompt guard.
- Mono-assertion, poly-accrual: one parent per row per event; multiple parents accrue across
  events into the DAG; transitive closure recovers ancestor chains (gold's multi-parent rows are
  almost all chain-type). Registry enforces acyclicity on every write; rollup linearizes by
  best-scoring edge at read time.

## 11. Judge-capability scaling (cross-cutting observation)

Every structural sensitivity measured scales INVERSELY with judge capability: row-composition
anchoring (flash obeys list-instructions when in the right frame; gemma never), frame sensitivity
(flash mildly conservative; gemma binary), injection fragility (flash tolerant; gemma identity
collapse), format fragility (flash never malformed; gemma ~10–20% on mega-ballots), knowledge
coverage (25/25 vs 4/25 known forks). The architecture is therefore designed to the WEAKEST
judge's constraints — composition and structure over exhortation — and the frontier judge simply
gets cheaper (samples=1, no vote) on the same skeleton. This is the article's portability claim.

We verified this by testing `gemma4:31b` via the cloud API. The 2.5× parameter jump perfectly bridges the structural extraction gap between the 12b local model and frontier flash (achieving `~0.74` reachability compared to `0.67` and `0.81`). However, it retains the 12b-era "identity asymmetry": without the `thinking` parameter enabled, `gemma4:31b` drops to `.33`–`.57` pairwise F1 for identity, confirming that reasoning tokens remain strictly necessary for open-weight models to reliably perform identity clustering, regardless of raw parameter count.

## 12. Negative results worth reporting

- Letter codes beat word codes for relations (v1 vs v2 ablation, earlier campaign).
- Set-level edge-list output (v4 `e` array in the doc call): no effect (.333 = baseline).
- `kin:` annotations: information without row membership does not move the judge.
- Sibling injection into identity options: catastrophic on small judges (§4).
- Prompt exhortation against a sampling-driven mode: immune (§6).
- `cat` bridge without voting: variance amplifier (§6).
- Bigger context window (96k on a 64k-tuned build): lazy degradation, 0/5 usable.
- Schema-constrained decoding on a thinking model: latency-disqualified.
- End-of-stream consolidation: works (.77–.78 everywhere) but is not streaming — kept as anchor.
- T=0 on gemma: infinite thinking loop, empty content.
- Anchored (unlabeled) snippets: worse than no evidence.

## 13. Metrics summary (dev-software-22, expanded gold 296 edges; R-reach / P / identity)

| configuration | numeric | replicate | reverse |
|---|---|---|---|
| catch-up era baseline (flash) | .551 / .84 / 1.0 | — | — |
| no catch-up, no mechanisms (flash) | .333 / .96 / 1.0 | — | — |
| v7 + carry (flash, pre-v8 best) | .855 / .92 / 1.0 | .855 / .87 / 1.0 | .797 / .93 / 1.0 |
| **v8 decoupled (flash)** | .812 / .80 / 1.0 | .882 / .76 / 1.0 | **.884 / .78 / 1.0** |
| **v8 decoupled (gemma31b, cloud)** | .739 / .70 / .33 | .742 / .71 / .57 | .609 / .72 / .57 |
| gemma with catch-up (local baseline) | .304 / .55 / 1.0 | — | — |
| gemma carry+split (pre-v8 best local) | .623 / .69 / 1.0 | (first-shot variance; audited) | — |
| **v8 decoupled (gemma12b, samples=2)** | **.677 / .65 / 1.0** | — | — |

Cross-order edge agreement: catch-up era Jaccard .306 → v8 .505 (type agreement .961).
