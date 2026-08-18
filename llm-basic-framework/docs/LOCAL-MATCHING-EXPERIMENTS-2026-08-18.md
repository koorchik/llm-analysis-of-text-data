# Local entity-matching experiments, 2026-08-18

Exploratory, non-reportable category probes over frozen GPT-5 extractions. All model calls used
`ollama/gemma4:e2b-16k`; all dense retrieval used `ollama/embeddinggemma`. Extraction was skipped.
Local model runs were performed sequentially after the initial Country comparison.

## Results

| Category and arm | Pairwise F1 | Merge P/R | NIL F1 | Calls | Tokens |
|---|---:|---:|---:|---:|---:|
| Country, built-in judge, union k=10, repair | **1.000** | 1.000 / 1.000 | 0.833 | 12 | 23,856 |
| Country, built-in judge, union k=10, no repair | 0.533 | 1.000 / 0.364 | 0.800 | 10 | 21,490 |
| Country, listwise, union k=10, repair | 0.952 | 1.000 / 0.909 | 0.741 | 15 | 21,221 |
| Software, built-in judge, union k=10, no repair | **0.667** | 1.000 / 0.500 | 0.811 | 29 | 103,123 |
| Software, listwise, union k=10, no repair | **0.667** | 1.000 / 0.500 | **0.902** | **20** | **49,087** |
| Software, built-in judge, union k=5, no repair | 0.412 | 0.500 / 0.583 | 0.743 | 34 | 94,655 |
| Software, built-in judge, union k=10, repair | 0.471 | 0.800 / 0.667 | 0.732 | 267 | 455,258 |
| HackerGroup, listwise, union k=10, no repair, corrected gold | 0.500 | 1.000 / 0.333 | 0.800 | 15 | 6,417 |
| Software, best judge, candidate k=20, listwise k=4, strict repair | 0.429 | 0.333 / 0.600 | 0.897 | 20 | 57,839 |

`calls` includes embedding calls from the run card. The decision-log call counts are lower on warm
embedding-cache runs. Country is a test-only category probe and Software/HackerGroup are dev probes;
none of these numbers is a reportable test result.

## Recommended policy

- Keep `CANDIDATE_GENERATOR=union`, `CANDIDATE_K=10`, and `CANDIDATE_MIN_SIM=0`.
- Use `DECISION_STRATEGY=listwise-mint-candidate` and `REPAIR=0` for Software. It preserves the best
  observed identity F1, improves NIL F1, halves tokens, and avoids repair retries.
- Use the built-in link judge (leave `DECISION_STRATEGY` unset) with `REPAIR=1` for Country. One
  successful repair call recovered the remaining duplicate and produced perfect identity scoring.
- Disable ladder discovery when measuring identity only (`LADDER_MIN_EXAMPLES=100000`). Ladders
  spend calls on granularity, which this evaluation does not score.
- Do not reduce union candidate width to five for Software. It saved only 8% of tokens and introduced
  enough false links to reduce pairwise F1 from 0.667 to 0.412.
- Do not increase union candidate width to 20 for this Software loop. With the winning listwise
  prompt still capped at four visible candidates, pairwise F1 was 0.429 versus the corrected-gold
  best of 0.889 at candidate k=10, and tokens increased from 49,087 to 57,839.
- Do not enable default repair for Software. It fired on 21 of 22 documents, retried every call, and
  used 4.4 times the no-repair tokens while reducing pairwise F1.

## Prompt iterations

After the first configuration study, three versioned listwise prompt variants were tested against
the corrected Software dev gold. The original `listwise-select` prompt remains the winner.

| Prompt | Internal k | Pairwise F1 | Tokens | Finding |
|---|---:|---:|---:|---|
| `listwise-select` | 4 | **0.889** | 49,087 | Best quality; retained |
| `listwise-select-compact-v1` | 8 | 0.500 | 65,747 | Wider list caused index mistakes |
| `listwise-select-compact-v1` | 4 | 0.286 | 46,584 | Positional arrays lost mention/option alignment |
| `listwise-select-complete-v2` | 6 | 0.000 | 55,031 | Completeness wording over-biased NEW ENTITY |
| `listwise-select-balanced-v3` | 4 | 0.083 | 52,469 | Examples caused aggressive false links |

The corrected-gold rescore is important: the original prompt's earlier reported Software F1 of
0.667 became 0.889 after removing the faulty APT28/UAC identity closure from gold. Wider candidate
lists did not help this local judge: k=8 overloaded selection and k=6 plus conservative wording
collapsed recall.

### Repair safety

Prompt-only repair could not satisfy the non-harm requirement. Gemma labelled contextual statements
such as "relates to Office" as high-confidence identity and merged a CVE into Microsoft Office.
`REPAIR_STRICT_IDENTITY=1` therefore implements a precision-first flat-identity mode:

- only canonical-name evidence is trusted; model-added aliases cannot bootstrap another merge;
- exact normalized names, matching structured identifiers, transliteration/confusable/acronym keys,
  and the evaluated multilingual Country aliases are eligible;
- all other pair suspects are memoized distinct;
- coherence, rename, split, and move cannot mutate the flat identity partition;
- repair makes zero LLM calls.

Measured with strict auto-repair:

- Country: three correct free merges (`USA`/`США`, Russia variants, `India`/`Індія`), pairwise F1
  0.778 in that stochastic phase-1 run, zero repair-judge tokens.
- HackerGroup: pairwise F1 1.000 on corrected dev gold with four phase-1 calls and zero repair calls.
- A discovered hierarchy regression (`UAC-0028` collapsing into broader `APT28` through a polluted
  alias) is now blocked by canonical-only authorization and pinned by a unit test.

## Gold correction

The provisional gold table merged `APT28`, `UAC-0001`, and `UAC-0028` into one identity. This was
inconsistent with its own independent annotation evidence and with the table's treatment of other
actor/activity-cluster relationships. Eleven worksheet rows were corrected so:

- `UAC-0001` and `UAC-0028` are distinct identities;
- decorated forms remain aliases of their matching bare UAC code;
- `APT28` to either UAC cluster is a `part-of` edge, not an identity merge.

The rebuilt `gold/gold.json` validates and covers all 3,360 inventory surfaces. Existing unrelated
transitivity conflicts and the absence of stratum (d) remain unresolved limitations.

## Run artifacts

- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-17-2323-country-e2b16k-union-k10-repair-2aeb2e29ea99`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-17-2323-country-e2b16k-union-k10-norepair-e09b235d35c2`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0107-country-e2b16k-listwise-repair-b0015e8ac87e`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-17-2330-software-e2b16k-union-k10-repair-3a0b946a8eab`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0032-software-e2b16k-union-k10-norepair-fe3ff153f650`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0046-software-e2b16k-union-k5-norepair-b5a7c4c5787e`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0100-software-e2b16k-listwise-norepair-3b0f3930b0f8`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0111-hackergroup-e2b16k-listwise-norepair-2e4438a4c39e`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0653-software-compactv1-k8-norepair-759bc2e17a14`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0726-software-compactv1-k4-norepair-8f0e78b46407`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0736-software-completev2-k6-norepair-1ab06f11cffa`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0747-software-balancedv3-k4-norepair-8fd3decd354b`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0820-country-builtin-autorepair-2501cb95cff0`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0824-hackergroup-baseline-autorepair-4741debd39e0`
- `../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0844-software-best-candidatek20-91bf337ea764`

## Judge-size probe: `gemma4:26b-16k` on the winning Software arm

Same arm as the Software winner (`DECISION_STRATEGY=listwise-mint-candidate`,
`CANDIDATE_GENERATOR=union`, `CANDIDATE_K=10`, `CANDIDATE_MIN_SIM=0`, `REPAIR=0`,
`LADDER_MIN_EXAMPLES=100000`, `EMBEDDINGS_MODEL=embeddinggemma`), 22-doc dev-Software subset,
frozen gpt-5 extractions, `STEPS=streamingNormalizer`. Only the judge model changed. Both rows
scored against the same corrected gold.

| Judge | Pairwise F1 | Merge P/R (a) | Merge P/R (c) | NIL F1 | B³ F1 | ARI | Calls | Tokens (in+out) | Wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `gemma4:e2b-16k` | **0.889** | 1.000 / 0.500 | 1.000 / 1.000 | 0.893 | 0.986 | 0.888 | 20 | 27,426+21,661 | 400 s |
| `gemma4:26b-16k` | 0.571 | 1.000 / 0.500 | 1.000 / 0.333 | **0.900** | 0.955 | 0.569 | 20 | 28,535+45,724 | 1,505 s |

The larger judge is worse on the headline metric, 3.8× slower, and doubles output tokens. But the
scored delta is three gold clusters wide and the two arms fail in opposite directions.

Per gold cluster (only 9 dev-Software multi-member clusters have ≥2 members present in the subset):

| Gold cluster | `e2b-16k` | `26b-16k` |
|---|---|---|
| g86 `Microsoft Office 2010` / `Office 2010` | MISS (put `Microsoft Office 2010` under `MS Excel`) | **OK** |
| g104 `shellcode.x64 (Cobalt Strike Beacon)` / `.bin` | **OK** | MISS |
| g105 `shellcode.x86 (Cobalt Strike Beacon)` / `.bin` | **OK** | MISS |
| g106 `SmartAssembly` / `SmartAssembly .NET` | **OK** | MISS |
| g100 `Remcos` / `Remcos RAT` / `RemcosRAT` | MISS | MISS |
| g65, g83, g95, g103 | unreachable (members absent from subset) | same |

So 26b is precision-conservative in exactly the place e2b is loose: it refuses the
suffix-variant merges (`X` vs `X .NET`, `X` vs `X.bin`) that carry three of the five reachable
scored clusters, while being the only arm that assembles the Office version family correctly.

Off-gold behaviour, which the metrics do not see, runs the other way. `e2b-16k` produced several
false merges on pairs gold does not label — `MS Office ← Microsoft Windows`, `VBScript ←
JavaScript`, `Remote Utilities ← Remcos, RemcosRAT`, `MS PowerPoint ← Microsoft Equation Editor` —
none of which `26b-16k` made; it kept `Remcos` separate and merged the PowerShell surfaces
correctly. Its own worst off-gold merge is `MS Excel ← PGMB New Order 18-2077.xlsx` (an attachment
into the application). The 0.889 therefore flatters e2b: on this slice the smaller judge wins the
scored pairs while making more identity errors overall.

Read this as a probe, not a promotion decision. It suggests the remaining Software headroom is in
the suffix-variant rule (a code-verifiable class — `REPAIR_STRICT_IDENTITY`'s canonical-name
evidence already covers similar keys) rather than in judge size, and that 22 documents with five
scorable clusters cannot separate two judges this close. Keep `gemma4:e2b-16k` as the local
Software judge on cost alone until a wider slice says otherwise.

Run artifact:
`../storage/cert.gov.ua/processed/experiments-dev/experiments/2026-08-18-0959-software-26b16k-listwise-norepair-f79aa8f0c877`
