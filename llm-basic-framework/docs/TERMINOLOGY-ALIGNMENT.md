# Terminology alignment: project vocabulary → scientific community vocabulary

Purpose: make the dissertation/paper legible to reviewers from the entity-resolution, knowledge-graph
and IR communities by mapping every project-internal term onto its established equivalent. The code
keeps its internal names (renaming working code buys nothing); the paper introduces each internal
name ONCE, in parentheses after the standard term, then uses whichever is shorter. Pattern:

> "…the judge returns a NIL verdict (internally: *mint*), creating a new entity…"

## 1. What to call the system as a whole

Recommended framing for abstract/introduction, composed entirely of established task names:

> **Incremental (streaming) entity resolution and canonicalization** over LLM-extracted mentions,
> with **NIL-aware entity linking** against an incrementally maintained entity store, coupled with
> **on-line taxonomy induction**: the same LLM adjudication step that decides identity also emits
> typed hierarchical (broader-concept) relations, organized per the **W3C SKOS** data model and
> consumed by **OLAP-style roll-up** with a similarity-threshold guard against **semantic drift**.

Each bolded phrase is a literature anchor (§6). "SKEIN" stays as the system name; Ψ_link / Ψ_norm
notation stays.

## 2. Core pipeline vocabulary

| Project term | Community term | Anchor | Paper usage |
|---|---|---|---|
| mention | entity mention | standard (EL/TAC-KBP) | already aligned |
| surface / alias | **surface form** | standard (entity linking) | say "surface form"; "alias" is fine after first use |
| canonical | **canonical form / representative** | canonicalization: `galarraga2014canonicalizing`, `vashishth2018cesi` (already cited) | already aligned |
| registry | **incrementally maintained entity store** (canonicalized KB) | `gruenheid2014incremental`, `vashishth2018cesi` | "entity store (the *registry*)" once, then registry |
| mint | **NIL verdict / new-entity decision** | TAC-KBP NIL: `ji2011knowledge`, `mcnamee2009overview` | "NIL (mint)" once; your NIL metrics section already speaks this language — connect the two explicitly |
| link | **entity linking** (to an in-store entity) | standard | already aligned |
| defer | **abstention** (classification with a reject option) | `chow1970optimum`, `elyaniv2010foundations`, `geifman2017selective` | "abstention (*defer*)"; defer rate → **abstention rate**; note the precision-exclusion/recall-miss scoring is exactly selective prediction's risk–coverage trade-off — cite it, §5 of the protocol becomes much easier to defend |
| judge | **LLM adjudicator (LLM-as-judge)** | `zheng2023judging` | "LLM-as-judge" is now the recognizable phrase |
| listwise ballot (E-numbers, mint = option n+1) | **listwise decision** with an explicit **NIL option** | listwise: `cao2007learning`; NIL option: TAC-KBP | "listwise prompt with an explicit NIL option" |
| blocker / candidate generator | **blocking / candidate generation (indexing)** | survey: `papadakis2020blocking`; textbook: `christen2012data` | "blocking"; the recall-only/never-decides-identity doctrine is standard blocking doctrine — cite it as such |
| union-rr | **round-robin interleaving fusion** of heterogeneous retrievers | RRF baseline: `cormack2009reciprocal` | present as "rank-level fusion; reciprocal-rank fusion (RRF) vs round-robin interleaving" — your 74.4→88.1 recall@4 result is then a measured comparison between two named fusion methods |
| exact fast path | exact-match lookup | — | fine as-is |
| gloss | **gloss** | WordNet: `miller1995wordnet` | already the community's word — cite WordNet so reviewers know you know |
| spreadSample | **systematic sampling** (strided) | standard statistics | one parenthetical: "a systematic (strided) sample" |
| brute-force cosine index | **exact nearest-neighbour search** (vs ANN) | — | "exact (non-approximate) NN search — the corpus scale does not warrant ANN" |
| max-over-aliases | maximum-similarity aggregation over surface forms | (single-link flavour) | describe, no citation needed |

## 3. Repair & consolidation vocabulary

| Project term | Community term | Anchor | Paper usage |
|---|---|---|---|
| repairer / phase 2 | **incremental ER repair / correction** | `gruenheid2014incremental` (uses merge/split on cluster graphs), `whang2014incremental` | your merge/split/move inventory maps 1-to-1 onto the incremental record-linkage literature's operators — say so |
| merge / split / move | merge, split, (re-)assignment | same | already aligned once anchored |
| defer queue + adjudicated memo | pay-as-you-go resolution state | `whang2013payasyougo` | optional anchor |
| catch-up pass | **periodic consolidation pass** | incremental ER above | "a periodic, registry-wide consolidation pass (*catch-up*)" |
| suspect pair | candidate duplicate pair | standard | fine |
| order ARI / order robustness | **insertion-order sensitivity** of incremental clustering | — | phrase it as a stability/robustness analysis |

## 4. Hierarchy & roll-up vocabulary (the SKOS half)

| Project term | Community term | Anchor | Paper usage |
|---|---|---|---|
| granularity edge / broadMatch | **hierarchical (broader-concept) relation**, `skos:broader` | W3C SKOS: `miles2009skos`; thesaurus standard: ISO 25964 | rename in the paper: "granularity edge" → "hierarchical edge"; "granularity forest" → **concept hierarchy** |
| relation = narrower-of | **hyponymy (is-a / subsumption)** | `hearst1992automatic`, `miller1995wordnet` | |
| relation = part-of | **meronymy (part–whole)** | `girju2006automatic`, WordNet | |
| relation = version-of | version relation (a named refinement of hyponymy) | `dcterms:isVersionOf` (DCMI Metadata Terms: "a version, edition, or adaptation of the described resource") | align to Dublin Core rather than claiming a new relation: "version-of (≈ `dcterms:isVersionOf`)"; the contribution is *typing hierarchy edges during joint ER + taxonomy induction*, not the relation itself |
| the whole edge-emitting judge | **taxonomy induction** performed jointly with entity resolution | TExEval: `bordea2015semeval`, `bordea2016semeval` | "joint ER + taxonomy induction in one adjudication call" is the headline framing |
| edge `type` broaderGeneric / broaderPartitive / broaderInstantial (v6) | **ISO 25964 broader-term typology** BTG / BTP / BTI, realized in RDF by iso-thes (`iso-thes:broaderGeneric/…Partitive/…Instantial`, each `rdfs:subPropertyOf skos:broader`) | ISO 25964-1:2011; iso-thes (`purl.org/iso25964/skos-thes`) | since registry v6 the *stored* vocabulary IS the standard's — cite both, and note BTI-for-versions is a documented interpretation |
| ladder (retired) | taxonomy levels / granularity strata | — | past tense only, in the ablation narrative |
| rollupTarget / fold | **roll-up along a concept hierarchy** | data cube: `gray1997data`; OLAP dimension hierarchies | "roll-up" is already the OLAP community's word — cite the data cube paper and the term does all the work |
| similarity-threshold brake | **semantic-drift guard** | drift: `curran2007minimising`; SKOS non-transitivity of `skos:broader` (spec §8) | two-part defense: (1) SKOS deliberately does not declare `broader` transitive because mixed generic/partitive chains break it; (2) the threshold bounds drift along otherwise-licensed chains |
| similarityScore on edges | edge weight (annotated statement) | RDF 1.2 / RDF-star (W3C Working Draft) | "RDF 1.2 (currently a W3C Working Draft)" — do not call it a Recommendation |
| registry vs document relations split | **identity graph vs assertion graph** (T-Box-ish vs A-Box-ish flavour) | description-logic vocabulary | one sentence; do not overclaim DL semantics |

## 5. Evaluation vocabulary

| Project term | Community term | Anchor | Paper usage |
|---|---|---|---|
| gold table | **gold standard** | standard | already aligned |
| clusters | entity clusters / equivalence classes | standard | fine |
| pairwise P/R/F1 | pairwise metrics | `menestrina2010evaluating` (optional) | fine |
| B³ | B-cubed | `bagga1998algorithms` | cite |
| ARI | Adjusted Rand Index | `hubert1985comparing` | cite |
| NIL metrics | NIL detection / **NIL clustering** | TAC-KBP 2011+: `ji2011knowledge` | your unlabeled-NIL exclusions mirror TAC practice — say so |
| edge P/R, reachable recall | **taxonomy-evaluation edge precision/recall** | TExEval: `bordea2016semeval` | "reachable recall" = recall against the ceiling of edges whose endpoints the run resolved — define once, it is a legitimate ceiling analysis |
| kind agreement | **relation-type accuracy** | — | rename in the paper |
| collapsed | hierarchy-collapse errors (merge expressed as an edge) | — | keep, defined once |
| strata a/b/c | difficulty strata | — | define once |
| run card / runId | experiment card / **configuration fingerprint** | model cards: `mitchell2019model` (inspiration) | one sentence on provenance discipline; optionally note W3C PROV-O as the export vocabulary for provenance, mirroring the SKOS export |

## 6. Suggested bibliography additions (keys in the repo's `authorYEARword` style)

- `fellegi1969theory` — Fellegi & Sunter, *A Theory for Record Linkage*, JASA 1969. (The field's origin; one citation legitimizes "record linkage".)
- `christen2012data` — Christen, *Data Matching*, Springer 2012.
- `papadakis2020blocking` — Papadakis et al., *Blocking and Filtering Techniques for Entity Resolution: A Survey*, ACM CSUR 2020.
- `gruenheid2014incremental` — Gruenheid, Dong & Srivastava, *Incremental Record Linkage*, PVLDB 2014.
- `whang2014incremental` — Whang & Garcia-Molina, *Incremental Entity Resolution on Rules and Data*, VLDB J. 2014.
- `whang2013payasyougo` — Whang, Marmaros & Garcia-Molina, *Pay-As-You-Go Entity Resolution*, TKDE 2013.
- `galarraga2014canonicalizing` — Galárraga et al., *Canonicalizing Open Knowledge Bases*, CIKM 2014.
- `ji2011knowledge` — Ji & Grishman, *Knowledge Base Population: Successful Approaches and Challenges*, ACL 2011.
- `bagga1998algorithms` — Bagga & Baldwin, *Algorithms for Scoring Coreference Chains*, LREC-W 1998.
- `hubert1985comparing` — Hubert & Arabie, *Comparing Partitions*, J. Classification 1985.
- `chow1970optimum` — Chow, *On Optimum Recognition Error and Reject Tradeoff*, IEEE T-IT 1970.
- `geifman2017selective` — Geifman & El-Yaniv, *Selective Prediction of Deep Neural Networks*, NeurIPS 2017. (or `elyaniv2010foundations`)
- `zheng2023judging` — Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*, NeurIPS 2023.
- `cao2007learning` — Cao et al., *Learning to Rank: From Pairwise Approach to Listwise Approach*, ICML 2007.
- `cormack2009reciprocal` — Cormack, Clarke & Buettcher, *Reciprocal Rank Fusion…*, SIGIR 2009.
- `bordea2016semeval` — Bordea, Lefever & Buitelaar, *SemEval-2016 Task 13: Taxonomy Extraction Evaluation (TExEval-2)*.
- `hearst1992automatic` — Hearst, *Automatic Acquisition of Hyponyms from Large Text Corpora*, COLING 1992.
- `girju2006automatic` — Girju, Badulescu & Moldovan, *Automatic Discovery of Part–Whole Relations*, CL 2006.
- `curran2007minimising` — Curran, Murphy & Scholz, *Minimising Semantic Drift with Mutual Exclusion Bootstrapping*, PACLING 2007.
- `gray1997data` — Gray et al., *Data Cube: A Relational Aggregation Operator…*, DMKD 1997.
- `miller1995wordnet` — Miller, *WordNet: A Lexical Database for English*, CACM 1995.
- `miles2009skos` — Miles & Bechhofer (eds.), *SKOS Reference*, W3C Recommendation 2009.
- `mitchell2019model` — Mitchell et al., *Model Cards for Model Reporting*, FAT\* 2019.
- ISO 25964-1:2011 (thesauri) — already referenced in code comments; carry into the bibliography.
- RDF 1.2 (RDF-star) — cite as W3C **Working Draft**, with access date.

## 7. Concrete sentence-level replacements

| Instead of | Write |
|---|---|
| "the judge mints a new entity" | "the adjudicator returns a NIL verdict (*mint*), creating a new entity in the store" |
| "the blocker retrieves candidates" | "the blocking stage generates candidates (recall-only; it never decides identity)" |
| "defer rate" | "abstention rate (coverage)" |
| "granularity edge / granularity forest" | "hierarchical edge (`skos:broader`) / concept hierarchy" |
| "kind agreement" | "relation-type accuracy" |
| "the ladder places entities on rungs" (historical) | "the retired level-based bootstrap assigned discrete granularity strata" |
| "fold the registry" | "roll up the concept hierarchy" |
| "the threshold stops the rollup" | "the similarity threshold bounds semantic drift along the roll-up path" |
| "catch-up pass" | "periodic registry-wide consolidation pass" |
| "run card" | "experiment card (configuration fingerprint + cost provenance)" |

## 8. Deliberately NOT renamed

- **gloss, roll-up, B³, ARI, NIL, blocking, listwise, RRF** — already the community's words.
- **SKEIN, Ψ_link, Ψ_norm, run directories, decisions.jsonl** — system/artifact names; papers name systems.
- **mint/link/defer as verbs** *after* first introduction — short internal verbs make prose readable;
  the alignment table (this document, condensed into the methodology chapter) is what makes them safe.
- The SKOS mapping table itself should include a **residue row** (similarityScore, typed relations,
  structured provenance) — an alignment that documents its deviations is more credible than a
  claimed isomorphism.


## 9. Registry v6 migration note (2026-08-22)

The code and file format now speak SKOS / ISO 25964 natively. Old → new:

| pre-v6 | v6 |
|---|---|
| `categories` (file key) | `conceptSchemes` |
| record `aliases: AliasRecord[]` | `labels: LabelRecord[]` (SKOS-XL reading) |
| record `gloss` | `definition` |
| `granularityEdges` `{from, to, kind: 'broadMatch', relation}` | `broaderEdges` `{narrower, broader, type}` |
| relation `version-of` / `narrower-of` / `part-of` | type `broaderInstantial` / `broaderGeneric` / `broaderPartitive` (untyped legacy → `null`) |
| journal op `granularity-edge` | `broader-edge` (consumers dual-read both) |

Frozen dialects, deliberately NOT renamed: prompt files + letter codes `v/n/p/b` (measured ablation
winner — only the code-side mapping changed); LLM-output verdict fields (`edgeKind`, `gloss`);
`gold/gold.json` kinds (`isa`/`part-of`/`renamed-to`); ops in committed journals; the persisted
repair-signature JSON keys (`surfaces`/`gloss`); experiment-identifier strings (`'name+gloss'`
representation id, `SKOS_CATCHUP_*`). All 158 committed registries load through
`EntityRegistry.parse`, which lifts every historical version (v1–v5) to v6 in memory — committed
data is never rewritten. Verified by byte-identical evaluate/fold outputs across pre- and
post-migration code on the same run directories.
