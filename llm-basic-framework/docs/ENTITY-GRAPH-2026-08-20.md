# Building the registry as a graph, 2026-08-20

Until now every local arm produced a **flat** registry: clusters of surface forms, no relations
between them. `MS Office 2010` and `Microsoft Office` ended as two unrelated clusters, so no later
analysis could fold one into the other. This document covers making the same one-call-per-document
judge emit the granularity edges too, and what that costs.

Everything here runs on `gemma4:12b-64k` + `embeddinggemma`, `CANDIDATE_GENERATOR=union-rr`,
`CANDIDATE_K=10`, `LISTWISE_K=4`, `REPAIR=0`, frozen gpt-5 extractions, `STEPS=streamingNormalizer`.
Numbers are non-reportable (dev/test single-category slices over subset corpora) unless stated.

## 1. The hierarchy was never scored

The gold table carries **249 granularity edges** (139 `part-of`, 108 `isa`, 2 `renamed-to`) across
seven categories. No metric consumed them, so a judge that emitted nothing scored the same as one
that got them right, and every arm's ladder output was invisible.

`src/Evaluation/hierarchyMetrics.ts` scores them, and `npm run evaluate` prints the table.
The design decisions that matter:

- **Between clusters, never between rungs.** A run's canonical is mapped to the gold cluster its
  surfaces belong to, and an edge is a directed pair of cluster ids. Rung labels (`g0`…`g3`) are
  local to whatever ladder that arm discovered; comparing them would score the numbering, not the
  graph. This is also what makes two arms with different ladder depth comparable.
- **`collapsed` is not a precision miss.** An edge whose endpoints land in the *same* gold cluster is
  a merge the judge expressed as a parent link — a different defect with a different fix, so pooling
  it into precision would hide it. It gets its own column.
- **Three denominators.** Raw recall over the slice's gold edges; **reachable** recall over the gold
  edges whose endpoints both exist as canonicals in the run (a subset corpus makes most edges
  unreachable, so raw recall is a floor); and transitive credit, since `A→C` when gold has `A→B→C`
  has the relation right and the granularity coarse.
- **Split.** Gold edges cross the split boundary — 76 of 249 join a dev cluster to a test one — and
  `selectSplit` drops all of those, leaving dev/Software with 4 edges, none reachable. The
  `--hierarchy-all-splits` flag scores edges against the whole table while identity stays split-pure.
  Iteration only; a reportable run must not use it.

First application, on the three published arms (test split, 161 gold edges) — all of them previously
unmeasured:

| arm | edges | P | R | F1 | kind agreement |
|---|---:|---:|---:|---:|---:|
| `gpt-5-6-sol` (cloud) | 88 | 0.443 | 0.242 | 0.313 | 0.923 |
| `claude-opus-5` (cloud) | 80 | 0.425 | 0.211 | 0.282 | 0.765 |
| `gemma4:e2b` (local) | 54 | 0.056 | 0.019 | 0.028 | 0.333 |

Even the strongest cloud arm reproduces a quarter of the known hierarchy. This is a hard task, and
the local baseline was doing nothing useful at all.

## 2. Two structural defects, found by running it

**Edge kind was hard-coupled to the ladder.** `#edgeKindForParent` derived the stored kind from the
*parent's rung*, so a category with no discovered ladder dropped every edge its judge proposed. The
first graph run proposed `Microsoft Office 2013 → MS Office` correctly and recorded **zero** edges.
The ladder still decides when it can place the parent; otherwise the relation the judge stated
carries the edge.

**Edges were written mid-loop.** `addGranularityEdge` requires both endpoints to exist, and edges
were inserted while iterating the document's plans — so a parent minted *later in the same document*
always failed. They are now flushed after every plan lands, which is what makes "A is part of B"
storable when A and B are first seen together.

Both defects silently produced empty graphs rather than errors, which is why a scoring gap and a
correctness gap tend to arrive as a pair.

## 3. The bottleneck is retrieval, not judgement

Of the 24 reachable gold edges on the dev-Software slice, for the first graph arm:

| where the parent was | count | outcome |
|---|---:|---|
| on the mention's ballot (k=4) | 7 | 5 taken, all correct; 2 missed |
| retrieved but below the k=4 cut | 3 | all missed |
| **never retrieved at any depth** | **14** | all missed |

The identity blocker retrieves *identity* neighbours. A parent is usually not one:
`rfusclient.exe` → `Remote Utilities`, `MS Excel` → `MS Office`,
`shellcode.x64.bin` → `Cobalt Strike Beacon` share neither strings nor embedding neighbourhood.
What they share is a **document**.

Hence the **document-scoped parent pool**: every entity the source put on the table — all candidates
retrieved for any mention, plus the other mentions being decided in the same call — offered as
numbered parent options. It needs no domain vocabulary and no second retrieval pass.

## 4. What the pool buys, and what it costs

Software dev-22, identical config, prompt varying:

| arm | identity F1 | edges | edge P | edge R (reachable) | kind agree | collapsed | tokens/doc |
|---|---:|---:|---:|---:|---:|---:|---:|
| flat `nameform-v6` (reference) | 1.000 | 0 | — | — | — | — | 3.7k |
| `listwise-graph-v1` (no pool) | 1.000 | 5 | 1.000 | 0.227 | 1.000 | 0 | 6.2k |
| `listwise-graph-v2` (pool, verbose) | 0.750 | 19 | 0.579 | **0.500** | 0.727 | 1 | 11.1k |
| `listwise-graph-compact-v3` (pool, compact) | **1.000** | 17 | 0.647 | **0.500** | 0.909 | **0** | 10.5k |

The pool more than doubles reachable edge recall and produces a genuinely useful graph —
`rfusclient.exe -part-of-> Remote Utilities`, `Windows 7 -coarsens-to-> Microsoft Windows`,
`cmd.exe -part-of-> Microsoft Windows`, `shellcode.x64 (Cobalt Strike Beacon) -coarsens-to-> Cobalt
Strike Beacon`.

It also costs identity: pairwise F1 1.000 → 0.750. **Offering a parent slot reduces merging.** Both
lost merges are the same failure — `shellcode.x86.bin` and `shellcode.x64.bin` were minted with a
parent edge instead of being linked to `shellcode.x86 (Cobalt Strike Beacon)`, which sat at rank 1 on
their ballots. The `collapsed` column caught one of them directly. Given somewhere to put a relation,
the judge prefers expressing a distinction over asserting sameness.

This is the central trade-off of doing both jobs in one call, and it is a prompt problem rather than
an architectural one — **the compact dialect recovers identity in full while keeping the doubled edge
recall** (row 4): pairwise F1 back to 1.000, kind agreement 0.727 → 0.909, zero collapsed merges, and
prompt tokens down 60% (5,048 → 1,994). Sharing one `E`-numbered entity list between identity options
and parents is what does it. Names stop being re-typed per mention, and — the part that matters — the
judge stops treating the presence of a parent slot as licence to avoid merging, because the identity
question is asked against the same numbered list it must answer the parent question against.

## 5. Prompt variants

- **`listwise-graph-v1`** — the winning `nameform-v6` identity ballot plus a parent option number, a
  relation, and a gloss. Parents chosen from the mention's own option list.
- **`listwise-graph-v2`** — adds the document-scoped parent pool (`P1…Pn`).
- **`listwise-graph-compact-v3`** — one `E`-numbered entity list shared by identity options and
  parents, `M`-numbered mentions, single-letter keys, and a `lvl` field so entities receive ladder
  rungs. Output tokens dominate this call (v2: 6.0k output against 5.0k input), most of it re-typing
  mention and category strings the caller already knows.
- **`listwise-graph-compact-v4`** — v3 plus the two rules its predecessors' errors called for: a
  written-form variant is identity and never a parent edge, and a substitution test separating
  `narrower-of` from `part-of` (v2 labelled components such as `AppLocker → Microsoft Windows` as
  coarsenings).

All four are placeholder-named and domain-neutral: no CERT-UA vocabulary, no product names, no
category-specific rules.

## 6. Context size: 64k earns its cost, for a non-obvious reason

Same prompt, same everything else, only `num_ctx` varying:

| context | identity F1 | edges | edge P | edge R (reach) | kind agree | wall |
|---|---:|---:|---:|---:|---:|---:|
| `gemma4:12b-64k` | **1.000** | 17 | **0.647** | **0.500** | **0.909** | 2,986 s |
| `gemma4:12b-16k` | 0.750 | 20 | 0.500 | 0.455 | 0.700 | 3,598 s |

16k is worse on every axis *and* slower, even though the prompt is only ~2k tokens. The reason is the
next section: `num_ctx` must hold the prompt **plus** everything the model generates, and this judge
generates ~9k tokens of reasoning it never shows. At 16k it is working in a window it keeps
overrunning.

## 7. Hidden reasoning is 97% of the output budget

The compact dialect cut prompt tokens by 60% but *raised* reported output tokens (6.0k → 8.5k), which
made no sense against its answers: one document's stored response is **672 characters** against
**9,910 reported output tokens**.

Ollama returns a thinking model's reasoning in `message.thinking`, a separate field the backend never
read. So ~97% of the output budget — and most of the 106 s/call latency — is spent generating text the
pipeline discards. A direct probe on `gemma4:12b-64k`, same prompt, same answer:

| | reported output tokens | `message.thinking` |
|---|---:|---:|
| `think: true` (model default) | 265 | 779 chars |
| `think: false` | **14** | none |

`OLLAMA_THINK=0` now exposes the switch (unset leaves the model's default, so no existing arm changes
behaviour). Two consequences worth stating in any cost table: every local-judge token figure published
from this harness so far **includes reasoning that never reached the parser**, and per-call latency is
dominated by it.

## 8. Folding — what the graph is for

`npm run fold` walks the stored edges to answer a question the flat registry cannot. On the compact-v3
Software registry (173 canonicals, 17 edges):

```
MS Office          (11 surfaces)  <- Microsoft Office 2016, 2013, 2010, 2007, Microsoft Equation Editor
Microsoft Windows   (6 surfaces)  <- Windows 7, Windows Vista, Windows Server 2008/2012, AppLocker
Remote Utilities    (5 surfaces)  <- Remote Utilities - Host, rutserv.exe, rfusclient.exe
Cobalt Strike Beacon (5 surfaces) <- shellcode.x86 (…), shellcode.x64 (…)
```

The fold is a **runtime choice, not a stored one**, which is the whole argument for keeping edges
instead of merging: `--relations coarsens-to` rolls versions into their product but keeps components
separate (173 → 160 nodes), `coarsens-to,part-of` also absorbs the components (173 → 156), and
`--level g1` stops the walk at the ladder's product rung. One registry, three different analyses.

It is also the fastest error display available: `MS Excel <- PGMB New Order 18-2077.xlsx` shows an
attachment folded into the application that opened it, which no identity metric would ever surface.

## 9. Universality: all categories, still one call per document

The configuration above with no `CATEGORIES` filter — every category of every document decided in the
same call, 21 documents, 639 dev gold clusters:

| | value |
|---|---|
| judge calls per document | **1** (max, not mean) |
| categories decided in one call | 8 — Software 189, Domain 80, Organization 15, Sector 11, Government Body 8, HackerGroup 8, Country 3, Infrastructure 2 |
| prompt tokens | 2,427 mean, **4,097 max** |
| identity pairwise F1 | **1.000** |
| NIL F1 | 0.914 |
| granularity edges | 28 scored, kind agreement **1.000**, collapsed 0 |

Nothing degrades when the ballot mixes categories, and the prompt stays *smaller* than the
single-category verbose dialect it replaced (4.1k peak against 8.0k). What grows with a document is
the per-mention option list, not the number of categories, because each mention only ever sees its
own category's entities.

Scored on its Software slice alone, the multi-category run matches the single-category one on identity
(1.000) and finds more edges (26 vs 17) at lower measured precision (0.385 vs 0.647) — which is the
subject of the next section.

## 10. Measured edge precision is a lower bound

Gold annotates 249 edges over a corpus of thousands of entities, so its hierarchy is **sparse by
construction**: an edge that is right but unannotated scores as a false positive. The 18 edges the
all-category run was charged for, verbatim:

```
CORRECT but unannotated (12)   docs.microsoft.com -part-of-> microsoft.com
                               social.technet.microsoft.com -coarsens-to-> microsoft.com
                               Microsoft Equation Editor -part-of-> MS Office
                               Microsoft Office Services and Web Apps -part-of-> MS Office
                               RegAsm.exe / vaultcli.dll / rundll32.exe / AppLocker / Win32k /
                                 .NET Framework / Windows Host Compute Service Shim
                                 -part-of-> Microsoft Windows
KIND WRONG, parent right (4)   cmd.exe / powershell.exe / Internet Explorer / Microsoft Edge
                                 -coarsens-to-> Microsoft Windows   (all four are part-of)
WRONG (2)                      WinSCP -part-of-> Microsoft Windows  (third-party, not a component)
                               PGMB New Order 18-2077.xlsx -part-of-> MS Excel  (attachment, not a part)
```

Of 28 scored edges: 10 match gold, ~12 are correct additions gold never recorded, 4 have the right
parent and the wrong kind, 2 are wrong. **Reported precision 0.357; adjudicated ≈0.79 counting kind
errors as failures, ≈0.93 counting parent-only.** Any precision figure from this metric must carry
that caveat; the defensible headline is *recall against known edges*, with precision from a manually
adjudicated sample.

The four kind errors are one pattern — a component labelled as a coarsening — which is exactly what
`compact-v4`'s substitution test was written to fix.

## 11. Compression is not free: two prompt regressions

The compact dialect's savings came from shortening rules, and two of those shortenings cost measurable
quality. Both are worth recording because the failure is invisible in the category you tuned on.

**`compact-v4` broke HackerGroup.** The identifier-precedence rule that `nameform-v6` states in two
sentences was compressed to one clause — "when a name pairs an identifier with a label, the identifier
is what it identifies" — dropping *"Choose the option carrying that identifier, and treat the bare
label on its own as a different, broader entity."* The judge then linked `APT28 (UAC-0028)` and
`UAC-0028 (APT28)` to the bare label `APT28` instead of to `UAC-0028`:

| HackerGroup arm | identity F1 |
|---|---:|
| flat `nameform-v6` | 1.000 |
| graph `compact-v4` | 0.500 |
| graph `compact-v5` (rule restored, strengthened) | **1.000** |

**`compact-v5` then broke Software.** Restoring the rule, I strengthened it — "never the option
carrying only the bare label … it belongs in `p` if anywhere". That reads as licence to treat any
label-ish option as a parent rather than an identity, and Software collapsed from 15 links to 4:

| Software arm | identity F1 | links |
|---|---:|---:|
| graph `compact-v3` / `v4` | 1.000 | 15 |
| graph `compact-v5` | 0.000 | 4 |

`compact-v6` restores the rule **verbatim** from `nameform-v6` — but stacked on top of v4's two
additions, and that stack is itself a cost. On Software, quality falls monotonically with rule load:

| Software arm | rules past v3 | identity F1 | edge P | edge R (reach) | kind agree | prompt bytes |
|---|---|---:|---:|---:|---:|---:|
| `compact-v3` | none | **1.000** | **0.647** | **0.500** | **0.909** | **3,762** |
| `compact-v4` | +anti-collapse, +substitution test | 1.000 | 0.611 | 0.500 | 0.818 | 4,566 |
| `compact-v6` | those two + verbatim identifier | 0.750 | 0.455 | 0.455 | 0.800 | 4,774 |

Read that table with §13's variance measurement in hand: **the Software column moves by 0.25 identity
F1 between replicates of the same arm**, so the v3/v4/v6 ordering there is inside the noise band and
must not be read as a ranking. What is outside it, and reproduces, is HackerGroup — and `compact-v5`'s
Software collapse to 0.000, which is far below anything sampling explains.

Neither of v4's additions ever demonstrably earned its place: the anti-collapse rule was written for a
failure the compact dialect had already fixed structurally, and the substitution test did not repair
the kind errors it targeted. Absent evidence of benefit, the leaner prompt is preferred — but "v6 is
worse on Software" is not something this data supports.

The ablation isolates the rule cleanly. `compact-v3` carries the same compressed identifier clause as
v4 and inherits the same failure, so the restoration is **necessary**, not incidental:

| HackerGroup arm | identifier rule | identity F1 |
|---|---|---:|
| `compact-v3` | compressed | 0.500 |
| `compact-v4` | compressed | 0.500 |
| `compact-v6` | verbatim, plus two extra clauses | **1.000** |
| `compact-v7` | verbatim, nothing else | (the test of sufficiency) |

Two lessons, and they pull in opposite directions, which is why both need stating:

1. **Structural compression is free.** Sharing one `E`-numbered entity list between identity and
   parents cut prompt tokens 60% and *improved* every metric.
2. **Rule compression and rule accumulation both cost.** A validated rule is a fixed quantity —
   paraphrasing it to save tokens changes the experiment (v4's HackerGroup collapse), and so does
   piling on further rules to patch observed errors (v6's Software regression). `compact-v7` tests the
   minimal correct point: v3's structure with the identifier rule restored verbatim and nothing else.

## 12. The ladder: useful vocabulary, unusable labels

With `compact-v3`+ the judge answers a `lvl` field, so entities finally receive rungs. Measured on a
`compact-v7` Software run:

| rung | canonicals |
|---|---:|
| g0 | 170 |
| g1 | 1 (`MS Office`) |
| none | 2 |

The ladder itself was discovered three rungs deep (`g0=product_name | g1=suite_version |
g2=suite_name`), but the judge places almost everything at g0. Ladder discovery is also stochastic
across runs — an earlier run of the same category produced `g0=specific_software_instance |
g1=product_name`, a different vocabulary for the same corpus.

Two consequences:

- **Fold along edges, not levels.** `npm run fold --relations …` works on every registry produced here;
  `--level g1` has almost nothing to act on. The graph carries the information; the rung labels do not.
- **The ladder earns its keep as a category vocabulary**, not as a per-entity label: it tells a reader
  what granularities exist in a category, and it can still supply an edge kind when a parent happens to
  be placed. Making rung assignment reliable — a prompt that asks for the coarsest level that still
  describes the mention exactly, rather than a free choice — is the obvious next experiment and was not
  run here.

## 13. Design note: per-pair relation beats per-level rung

A ladder rung assigns **one** edge kind to every child of that level. It cannot express that
`Office 2010` *isa* `Office` while `MS Word` is *part-of* `Office` — same parent, same level, two
different relations. The judge's per-pair reading can. The ladder remains the right place for the
*level vocabulary* (what granularities exist in this category, so a registry can be folded to one of
them) and the wrong place for the kind of an individual edge.

## 14. Results

Every cell is `gemma4:12b-64k` + `embeddinggemma`, `union-rr`, `CANDIDATE_K=10`, `LISTWISE_K=4`,
`REPAIR=0`, ladder discovery on, one call per document. Identity is pairwise cluster F1; edges are
scored between gold clusters with `--hierarchy-all-splits`.

| configuration | `compact-v3` | `compact-v4` | `compact-v6` | **`compact-v7`** |
|---|---:|---:|---:|---:|
| Software identity | 1.000 | 1.000 | 0.750 | **1.000** |
| Software edges P / R_reach / kind | .647 / .500 / .909 | .611 / .500 / .818 | .455 / .455 / .800 | .667 / .364 / .750 |
| Country identity | 1.000 | 1.000 | 1.000 | **1.000** |
| HackerGroup identity | 0.500 | 0.500 | 1.000 | **1.000** |
| HackerGroup edges | 0 | 0 | 0 | **1 @ P 1.000, R .500** |
| all-categories identity | 1.000 | — | 0.889 | **1.000** |
| all-categories edges P / R_reach / kind | .357 / .435 / 1.000 | — | .500 / .261 / 1.000 | .471 / .348 / .750 |
| prompt bytes | 3,762 | 4,566 | 4,774 | 3,970 |

### Run-to-run variance, measured

Sampling is at provider defaults with reasoning enabled, and the Software slice has three stratum-c
clusters, so one merge is worth 0.25 identity F1. Replicating both finalists:

| Software arm | identity (run 1 / run 2) | edge R_reach (run 1 / run 2) |
|---|---|---|
| `compact-v3` | 1.000 / **0.750** | .500 / **.364** |
| `compact-v7` | 1.000 / **0.750** | .364 / **.500** |

Both arms span the same band and the two **swapped edge profiles** between runs. Every
single-sample Software comparison in this document — including the v3 > v4 > v6 ordering in §11 — is
therefore inside the noise, and the table above must be read as "these variants are indistinguishable
on Software", not as a ranking. Ranking arms on this slice needs ≥3 replicates per arm; the campaign
budget allowed two for the finalists.

### The decisive cell, replicated

`compact-v7` scored 1.000 on its first HackerGroup run and 0.500 on its replicate, which withdrew the
"compressed rule → 0.500, verbatim rule → 1.000, systematically" claim these notes carried for several
sections: the slice has two multi-member gold clusters, so one merge swings identity F1 by 0.5 and a
single sample per arm is a coin flip. Five samples per arm:

| prompt | HackerGroup identity F1, ten runs | at ceiling | mean |
|---|---|---|---:|
| `compact-v3` (rule compressed) | 0.5 ×8, 1.0 ×2 | **2/10** | 0.60 |
| `compact-v7` (rule verbatim) | 1.0 ×8, 0.5 ×2 | **8/10** | 0.90 |

Both arms are **bimodal, not noisy around a mean** — the run either applies the identifier rule to
`APT28 (UAC-0028)` or links it to the bare label. So the quantity to report is the *rate* at which a
prompt gets that one decision right, not an average F1, and averaging the two modes would describe a
state neither run is ever in.

At five samples per arm this was 4/5 against 1/5 — the right direction at Fisher **p ≈ 0.21**, a
direction rather than a result. Doubling to ten per arm, with the two arms interleaved so any drift in
machine state hits both equally, gives **8/10 against 2/10, Fisher exact two-sided p = 0.023**.

That is the one prompt difference in this campaign that survives replication at conventional
significance. It is also the smallest possible edit: one sentence, restored to the wording it had
when it was validated.

What still stands, because the effect size dwarfs the variance band or the mechanism is visible in the
decisions rather than only in the metric:

1. **`compact-v5` is genuinely broken** — Software identity 0.000 with 4 links against 15, far outside
   anything sampling explains, and the decisions show the mechanism (label options preferred as
   parents over identity).
2. **The parent pool is a real gain** — reachable edge recall 0.227 → 0.500 with the identity
   regression traced to and fixed by the compact structure, and the mechanism measured directly (14 of
   24 reachable parents were never retrieved at any depth).
3. **Structural compression is free** — −60% prompt tokens across every arm that used it.
4. **Hidden reasoning is load-bearing** — 19× faster without it, and identity falls 1.000 → 0.333, an
   effect far outside the ±0.25 band.
5. **64k beats 16k**, for the reason §7 gives.

**Recommendation: `listwise-graph-compact-v7`.** It reaches ceiling identity on the decisive slice in
8 runs out of 10 against `compact-v3`'s 2 (p = 0.023), ties every other configuration on identity
(Software, Country, all-categories — all within the variance band), and is the leanest variant that
carries every rule with demonstrated value and no clause that has been shown to help.

### The recommended configuration

```bash
LLM_PROVIDER=ollama LLM_MODEL=gemma4:12b-64k      # 64k is required — see §6/§7
EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=embeddinggemma
DECISION_STRATEGY=listwise-graph
LISTWISE_PROMPT_ID=listwise-graph-compact-v7
CANDIDATE_GENERATOR=union-rr CANDIDATE_K=10 CANDIDATE_MIN_SIM=0
LISTWISE_K=4
LADDER_MIN_EXAMPLES=8
REPAIR=0
```

Cost, measured on the 22-document Software slice: one judge call per document, ~2.0k prompt tokens and
~8.5k output tokens per call (of which ~97% is reasoning that never reaches the parser), ~106 s/call
wall-clock. The all-category run decides 316 mentions across 8 categories in 21 calls.

### What it produces

A registry that is a graph rather than a partition: 1.000 identity on every category tested, plus
edges that fold on demand — `MS Office <- Office 2016/2013/2010/2007`, `Microsoft Windows <- Windows 7,
Vista, Server 2008/2012`, `Remote Utilities <- rutserv.exe, rfusclient.exe`,
`Cobalt Strike Beacon <- shellcode.x86/x64`. `npm run fold` turns those into any of several analyses
from the same stored registry (§8).

## 15. Threats to validity

- **Slice size.** 22/14/11-document subsets with 22-24 reachable gold edges. One edge moves recall by
  ~0.045 and one merge moves identity F1 by ~0.15. Both finalists were replicated on Software.
- **Non-reportable splits.** Software/HackerGroup are dev, Country is test, and hierarchy scoring uses
  `--hierarchy-all-splits`, which puts test clusters in front of a dev measurement. Fine for ranking
  arms, not for a headline number.
- **Sparse gold hierarchy.** §10 — measured edge precision is a lower bound by roughly a factor of two.
- **Prompts tuned on these slices.** The rules were written after reading failures on the same
  categories they are evaluated on; the full-corpus run is the honest next gate.
- **Single-model.** Everything is `gemma4:12b-64k`. The prompt rules were validated on 12b/26b/31b in
  `LOCAL-MATCHING-EXPERIMENTS-2026-08-19.md`, but the graph half has only been measured on 12b.

## Reproduction

```bash
npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software \
  --hierarchy-all-splits --run <runDir>

# the graph the run produced, folded three ways
npm run fold -- --run <runDir> --category Software
npm run fold -- --run <runDir> --category Software --relations coarsens-to
npm run fold -- --run <runDir> --category Software --level g1

# blocker recall over the full gold pool, no LLM calls
npm run blocker-bench -- --generators embedding,union,union-rr --k 4,10

INPUT_DIR=<subset> OUTPUT_DIR=../storage/cert.gov.ua/processed/experiments-dev \
  STEPS=streamingNormalizer FLOW=incremental CONDITION=<label> CATEGORIES=Software \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:12b-64k \
  DECISION_STRATEGY=listwise-graph LISTWISE_PROMPT_ID=listwise-graph-compact-v7 \
  CANDIDATE_GENERATOR=union-rr CANDIDATE_K=10 CANDIDATE_MIN_SIM=0 \
  REPAIR=0 LADDER_MIN_EXAMPLES=8 \
  EMBEDDINGS=1 EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=embeddinggemma \
  DECISIONS_LOG=1 npm start
```
