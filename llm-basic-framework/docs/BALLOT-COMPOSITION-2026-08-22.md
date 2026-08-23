# Ballot composition, not prompt wording, decides LLM hierarchy recall (research note, 2026-08-22)

Status: paper-ready finding for the streaming entity-resolution chapter. Dev-subset numbers are
non-reportable (iteration split); the finding itself is mechanism-level and reproduces across
prompts, temperatures, document orders, and two judge models. All run directories referenced live
under `storage/cert.gov.ua/processed/experiments-dev/experiments/` (prefix 2026-08-22-…).

## 1. The finding

A listwise LLM judge deciding entity identity and SKOS hierarchy in one ballot **asserts
`broader` relations almost exclusively toward entities printed in the mention's own options row**.
A shared document-wide entity list — which the prompt explicitly designates as a valid source of
parents ("any of E1…En, not only that mention's options") — is consulted only sporadically, and on
large ballots effectively never. Consequently, whichever pass controls *retrieval into the options
row* controls hierarchy recall, regardless of how the hierarchy question is phrased.

This explains a result that initially looked paradoxical: a periodic registry-wide "catch-up"
pass, using the *same prompt, same judge, same K* as the per-document pass, contributed roughly
half of all hierarchy recall (reachable edge recall .642 with it, .321 without it — §4 of
SKOS-CAMPAIGN-2026-08-22.md). Its advantage was not the registry-wide view as such: it was that
catch-up retrieves candidates *per concept, densely, against a registry that by then contains the
concept's family* — so the correct broader entity lands in the options row.

## 2. The key evidence pair (doc 3028, the Agent Tesla stealer report)

Doc 3028 lists ~30 browsers (Torch, Brave, Yandex, Vivaldi, …) alongside `Chromium Browser`
itself — all first-seen. Gold expects ~15 `X → Chromium Browser` (broaderGeneric) edges.

**Per-document ballot** (run `…-pv5t0-rev-1a6e129ff6a0`, doc 016-3028): the registry holds no
browsers yet, so identity retrieval fills every options row with noise
(`M14. "Torch Browser" — options: cmd.exe, Windows Server 2012, …`). `Chromium Browser` is
present on the ballot as E74 (it is mention M12). The judge's verdict, verbatim:

```
{"m":"M14","id":"NEW","g":"Chromium-based web browser","p":null,"r":null}
```

— fifteen rows where the model *writes the parent's name into the gloss* and still answers
`p:null`. Every parent it did assert in that call (Outlook→MS Office, RegAsm.exe→.NET,
vaultcli.dll→Windows) sat inside the asserting mention's own options row.

**Catch-up ballot** (run `…-skos-v6-gem37-637f3a48ae68`, call 010-703548): same prompt, but rows
are built by dense per-concept retrieval against the now-populated registry:
`M22. "ChromePlus Browser" — options: E76 (Chromium Browser), …`. Verdict:

```
{"m":"M22","id":"NEW","p":"E76","r":"n"}   … 7 family edges in one call
```

including `p:"E76"` for M20 (Yandex), whose own options row did *not* contain E76 — once several
neighbouring rows print the parent, the pattern generalizes. The seed rows must exist.

## 3. What prompt engineering could and could not fix

Interventions tested on gemini-3.7-flash (dev-software-22; reachable recall / precision), each
with catch-up disabled:

| intervention | numeric | replicate | reverse |
|---|---|---|---|
| baseline prompt (listwise-skos-v1) | .333 / .958 | — | — |
| + "hierarchy is world knowledge; scan the whole E-list" (v3) | .797 | .449 | .319–.449 |
| + temperature 0 | .449 | — | — |
| + gloss written *before* the parent field (v5, key order m,id,g,p,r) | .696 | .377 | .406 |
| + `kin:` row annotation naming sibling E-numbers (v6) | .826 | .435 | .768 |
| **+ siblings placed into the options row** (DOC_SIBLINGS=options) | **.806** | **.836** | **.768** |

Three lessons. (a) Epistemic reframing ("the source need not state the relation") is necessary —
the baseline never lands the family — but leaves the outcome a coin flip; the model's sampling
nondeterminism persists even at temperature 0. (b) *Annotations* pointing at the parent
(`kin: E47`) do not substitute for *membership in the options row*: same information, different
placement, unreliable effect. (c) Only physical placement into the options row made the family
edges reproducible across replicates and document orders. Output-shape restructuring (a
document-level edge list, v4) had no effect at all (.333).

## 4. The streaming-native consequence

Since composition is the lever, catch-up can be replaced without any scheduled pass — relevant
because the target setting is a **never-ending stream**, where an end-of-stream consolidation is
catch-up relocated, not removed. Two per-document mechanisms suffice:

1. **Doc-sibling options** (`DOC_SIBLINGS=2 DOC_SIBLINGS_MODE=options LISTWISE_K=6`): each
   unresolved mention's top-2 embedding-nearest same-category co-mentions are prepended to its
   options row. A document that co-mentions a family now prints the family into its own rows —
   first sight, any arrival order.
2. **Parentless re-ask** (`REASK_PARENTLESS=1`): when a document re-mentions a concept that
   resolved exactly but has no broader edge yet, the concept returns to that document's ballot as
   a hierarchy-only row: its own canonical excluded from options (the catch-up row shape), dense
   registry retrieval as candidates, identity verdict ignored. The trigger is the stream itself —
   no growth counter, no checkpoint, no stream end; every recurrence is another chance where the
   one-shot NEW ballot had exactly one.

Combined (`listwise-skos-v5`, T=0, no catch-up): reachable recall **.754 / .797 / .731**
(numeric, replicate, reverse) at precision .83–.91, identity pairwise F1 1.000 in all three runs,
cross-run edge Jaccard .598 vs .306 in the catch-up era — at the same 22 LLM calls as the
baseline. A deterministic full-registry end pass, built as a measurement anchor, reaches the same
band (.768–.783) — confirming that *re-asking with dense per-concept retrieval* is the underlying
sufficient mechanism, which the two streaming-native devices deliver incrementally.

## 4b. Second finding: the FRAME gates knowledge on a small judge (gemma4:12b, 2026-08-23)

The composition finding has a frame-level twin, isolated on the local 12b judge, with an honest
attribution audit. The frame evidence proper: gemma asserted MS Word→MS Office (and its class)
on every catch-up-framed registry-review row and on none of the same rows inside a document
ballot — the with-catch-up baseline owes its knowledge edges to the review frame. On that basis
reask/carried rows were split into their own source-free review call (`REASK_SPLIT=1`, +1 call
per carrying document). In the winning run (.623 reachable recall vs the .304 with-catch-up
baseline, precision .553→.694, identity intact) the per-call audit attributes the gain as
follows: the review calls directly contributed ~8 edges (18 fired, 8 answered, 1 looped to the
length cap — mostly reversed placements such as Windows 7→Microsoft Windows,
shellcode.x86→Cobalt Strike Beacon), while the **25 Chromium-family edges landed in doc 3028's
own document-framed call**, where the v7 gloss-before-parent ordering is visibly operative: the
model writes "a Chromium-based web browser" as the gloss and then copies the answer into
`p:E47`, twenty-five rows in a row — its glosses in the same ballot under v1-era prompts said
just "web browser" with null parents. At gemma's mandatory default temperature this first-shot
win is a sampling event (an earlier v7 run nulled the same ballot), so the local headline number
requires replicates before it is quotable; the frame effect and the gloss-first mechanism are
the reproducible findings. The frontier judge (flash) needs neither the split (equal scores, 2×
calls) nor the luck (T=0 + carry replicates at .855/.855): frame sensitivity, like
row-composition sensitivity, scales inversely with judge capability.

Two auxiliary small-judge results worth a footnote: greedy decoding (T=0) loops gemma's hidden
thinking to the 64k context cap with an empty answer (finish=length) — default temperature is
mandatory locally while T=0 is what stabilizes flash; and injecting embedding-near co-mentions
into a small judge's identity options destroys its written-form linking (pairwise 1.000 → .500),
so hierarchy aids must stay out of the identity row for small judges.

## 5. Paper framing suggestions

- Present as an instance of **retrieval-composition bias** in listwise LLM judgment: the
  effective hypothesis space of a per-item decision is the item's printed candidate set, not the
  prompt-declared one. Related to positional/selection biases in listwise ranking, but the
  failure is *absence from the row*, not order within it.
- The gloss-vs-parent contradiction (writes "Chromium-based web browser", answers `p:null`) is a
  clean, quotable demonstration that the failure is not missing knowledge.
- The kin-vs-options contrast (same E-numbers, annotation vs membership, unreliable vs reliable)
  isolates placement as the causal variable.
- Report the anchor triangle: no-catch-up (.33) < prompt-only (coin flip .38–.80) <
  composition-fixed streaming (.73–.80) ≈ deterministic full re-ask (.77–.78).
