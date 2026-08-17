# Streaming Pipeline Spec (SKEIN v2, artifact-first)

Implementation specification for the streaming successor of the batch pipeline
(`DataExtractor` → `DataEntitiesCollector` → `DataNormalizer` → `DataGraphBuilder`).
Design source of truth: `dissert/wiki/notes/streaming-autodiscovery-normalization.md` (v2),
governed by the deck `dissert/wiki/presentations/skein-v2-method.md`.

**Status: implemented** (`FLOW=incremental`; operational guide: `docs/RUNNING-EXPERIMENTS.md`,
runbook: `docs/RUN-STREAMING.md`). The original "no code implemented yet" header is history.

> **Amendment 2026-08-04 (SKEIN v2 granularity sync — follows the deck, per its authority
> rule).** The link-judge became the three-verdict rung-aware judge (`link | mint | defer`,
> `mentionRung`, `parentCandidate`+`edgeKind`; the repository's hashed prompt is authoritative).
> The registry became a **v3 identity graph** (per-alias
> provenance, per-entity `rung`, strictly layered `coarsens-to`/`part-of` granularity edges and
> `renamed-to` rename edges, a consolidator defer queue). A **granularity-ladder bootstrap**
> (`src/Ladder/LadderDiscovery.ts`, `prompts/ladder.md`, N≥3 ensemble, code validators, cached
> versioned in `schema.json.categories[].ladder`, retroactive rung binding) fires per category
> once ≥`LADDER_MIN_EXAMPLES` surfaces exist. Edge labels are DERIVED from the model's
> `preserving` verdict — `coarsens-to` ⇔ true, `part-of` ⇔ false; `edgeKind`/`foldByDefault` are
> never requested from a model; **zero external dictionaries** (CPE/PSL/ISO-3166/BGP) are bound
> in code. The consolidator carries merge/**split**/**move**, the defer-queue review and a
> cross-category sweep; artifacts stamp `matchedVia` for local re-stamps. The graph builder takes
> λ (`LAMBDA`, `LAMBDA_INTERPRETIVE`) with the five-row projection contract (distinct-incident
> weights recomputed, never summed). Sections below record the original contract; where they
> disagree with this amendment, the amendment wins.

## 1. Goals and principle

Three changes relative to the batch pipeline, nothing else:

1. **Category autodiscovery** — the fixed 10-category list leaves the prompt; categories become an
   emergent schema. Roles stay the fixed enum `Attacker | Target | Neutral`.
2. **Streaming normalization** — no gather-all-names step. Each document is normalized against a
   growing registry the moment it is extracted; `DataEntitiesCollector` and `DataNormalizer` are
   replaced by one per-document processor.
3. **Relation extraction with optional legacy inference**:
   - **Extracted** (primary): relations stated in the text, extracted by the LLM in the same call
     as entities, with an emergent relation-type vocabulary. Evidence-grounded.
   - **Inferred** (fallback — discovery removed 2026-08-17): the graph fold still reads
     `schema.json.pairRules` and emits `kind: inferred` edges for co-occurring pairs without an
     extracted relation, but **nothing in the pipeline populates that table any more** — the
     rule-discovery step and its `pair-rule` LLM call were deleted from `StreamingNormalizer`
     because it keyed on contextual roles, which are outside entity-normalization evidence. A
     fresh run therefore produces an extracted-only graph; the inferred channel only fires for a
     schema whose rule table predates the removal or was pre-seeded (as the walkthrough test does).
   - Every graph edge carries `kind: extracted | inferred`. `extracted` is the default mode;
     `layered` and `cooccurrence` are explicit legacy/reference modes.

**Principle: the per-document artifact is the primary output; the graph is a pure fold over
artifacts; shared streaming state is exactly two small JSON files.** After any document, the
pipeline can stop and the artifacts + graph are complete for everything seen so far.

Per-document LLM budget: **1 extraction call + ≤1 type-judge call + ≤1 link-judge call**.
Everything else is string matching and bookkeeping, apart from occasional ladder discovery and
optional synchronous repair calls.

## 2. Directory layout

Per source and model, everything lives under
`storage/<source>/processed/incremental/<model>/` (the dir already staged for this experiment):

```text
incremental/<model>/
├── extractions/NN.json    # stage-1 output per document (pre-normalization; replayable)
├── artifacts/NN.json      # THE MAIN OUTPUT: normalized per-document artifact
├── schema.json            # emergent schema (categories + relation types) — state file 1
├── registry.json          # canonical entities with aliases — state file 2
├── decisions.jsonl        # OPTIONAL (--log): link/type decisions, for evaluation only
└── graph/
    ├── nodes.csv          # derived, rebuildable at any time
    └── edges.csv
```

`extractions/` exists so the expensive LLM extraction is never re-paid: normalization, repair
(§4.3) and graph builds can all be re-run from disk.

## 3. Data shapes

### 3.1 `schema.json` (state file 1 — saturates)

```json
{
  "categories": [
    { "name": "HackerGroup",
      "definition": "A named threat actor, APT group, or cyber-criminal collective",
      "examples": ["Sandworm", "APT28"],
      "aliases": ["ThreatActor"],
      "firstSeen": 16 }
  ],
  "relationTypes": [
    { "name": "attacks",
      "definition": "An actor directs malicious activity at a target",
      "examples": ["Sandworm attacks the energy sector"],
      "aliases": ["targeted", "conducted phishing against"],
      "firstSeen": 16 }
  ],
  "pairRules": [
    { "source": { "category": "HackerGroup", "role": "Attacker" },
      "target": { "category": "Organization", "role": "Target" },
      "relation": "attacks" },
    { "source": { "category": "Organization", "role": "Neutral" },
      "target": { "category": "Organization", "role": "Neutral" },
      "relation": null }
  ],
  "history": [
    { "doc": 16, "op": "admit-category", "name": "HackerGroup" },
    { "doc": 23, "op": "alias-relation-type", "name": "attacks", "alias": "targeted" },
    { "doc": 23, "op": "admit-pair-rule", "signature": "HackerGroup/Attacker × Organization/Target" }
  ]
}
```

- `aliases` — surface names judged equivalent; resolution maps them to `name`.
- `pairRules` — the **discovered signature-rule table** (successor of the hardcoded
  `#inferRelationship`): one entry per co-occurrence signature ever seen, keyed by the unordered
  pair of `(category, role)`; the verdict fixes direction (`source`/`target`) and a relation type
  (`relation` must reference a `relationTypes` entry — the verdict may propose a new one, which is
  admitted through the normal schema flow) or `null` ("this signature implies no relation").
  Because both categories and roles are finite-ish (roles fixed at 3, categories saturate), this
  table **saturates fast** — a few dozen entries in practice. **Read-only since 2026-08-17**: the
  discovery step (§4.2 step 5) is removed, so entries exist only in schemas written before the
  removal or pre-seeded by hand/tests.
- `history` — append-only; the new-types-per-document curve ν(t) for RQ1 reads directly off it.
  New op since the 2026-08-04 amendment: `discover-ladder`.
- Seeding: `schema.json` may start empty (pure autodiscovery) **or** pre-seeded with the legacy 10
  categories (the seeded arm of the RQ4 ablation). Both are just initial file contents.
- **Amendment 2026-08-04:** each category entry may carry a **`ladder`** field — the cached,
  versioned granularity ladder discovered by `LadderDiscovery`
  (`{version, exampleCount, runs, models, rungs[], rejected[], notes, disagreements[],
  discoveredAtDoc}`; each non-g0 rung: `{g, alias, move?, example, preserving, foldTest,
  disputed, edgeKind}` where `edgeKind` is code-derived from `preserving`). Fires once
  ≥`LADDER_MIN_EXAMPLES` distinct surfaces exist; re-fires at ≥2× surface growth.

### 3.2 `registry.json` (state file 2 — grows ~linearly)

```json
{
  "HackerGroup": {
    "Sandworm": {
      "aliases": ["Sandworm", "Sandworm group", "UAC-0002"],
      "firstSeen": { "doc": 16, "date": "2020-01-17" }
    }
  },
  "Organization": {
    "Microsoft": { "aliases": ["Microsoft", "Microsoft Corp"], "firstSeen": { "doc": 3, "date": "2020-01-05" } }
  }
}
```

Keyed `category → canonicalName → record`. At load time build an in-memory
`Map<category, Map<lowercased alias, canonicalName>>` for the exact-hit fast path.

**Amendment 2026-08-04 — the registry is a v3 identity graph.** The v1 shape above (and the v2
alias-provenance shape that followed) still load; saves write v3:

```json
{ "version": 3, "canonicalPolicy": "first-seen",
  "categories": { "HackerGroup": { "Sandworm": {
      "aliases": [ { "surface": "UAC-0002", "docId": 23, "decision": "link",
                     "evidence": "also tracked as UAC-0002", "addedBy": "<runId>" } ],
      "rung": "g1", "gloss": null, "categoryCounts": { "HackerGroup": 3 },
      "firstSeen": { "doc": 16, "date": "2020-01-17" } } } },
  "granularityEdges": { "HackerGroup": [
      { "from": "UAC-0002", "to": "Sandworm", "kind": "part-of", "docId": 23,
        "decision": "judge", "evidence": "…", "addedBy": "<runId>" } ] },
  "renameEdges": { "HackerGroup": [
      { "from": "Sandworm", "to": "APT44", "kind": "renamed-to", "validFrom": null,
        "docId": -1, "decision": "consolidator" } ] },
  "deferQueue": [ { "category": "HackerGroup", "mention": "UAC-0002",
      "mintedAs": "UAC-0002", "candidates": ["Sandworm"], "docId": 23 } ] }
```

Layer rules: granularity edges (`coarsens-to` = preserving blur, `part-of` = widening) are
finer→coarser, same-category, acyclicity-checked on write, per-edge provenance; rename edges are
never aliases and never fold; the defer queue is the **StreamingRepairer**'s input (§4.3) — the RQ3
batch-reference harness also drains it, but only when run against a copied NAIVE-arm (`REPAIR=0`)
directory, where no repairer ever ran (nothing reads `decisions.jsonl` at runtime); assertional
relations never enter this file.

**Amendment 2026-08-05 — registry v4 adds the repair layer.** `save()` writes v4; v1–v3 still load.
On top of v3's identity graph, v4 adds:

```json
{ "version": 4, "...": "…v3 fields unchanged…",
  "repair": {
    "adjudicated": [ { "a": { "category": "HackerGroup", "canonical": "Sandworm" },
        "b": { "category": "HackerGroup", "canonical": "APT44" },
        "signature": "…sha256, or '' to always re-fire…", "verdict": "distinct", "docId": 40 } ],
    "spillover": [ { "a": { "category": "HackerGroup", "canonical": "Sandworm" },
        "b": { "category": "HackerGroup", "canonical": "Voodoo Bear" },
        "signal": "gloss-ann", "score": 0.93, "docId": 41 } ],
    "repairedThrough": 41 } }
```

`repair` is the `StreamingRepairer`'s own working memory (§4.3), not derived from the identity
graph: `adjudicated` is the sha256-keyed do-not-re-fire memo per suspect pair (a `''` signature is
the sentinel that retains a suspect for permanent re-fire — a low-confidence merge demoted to
`distinct`); `spillover` is suspects that missed this document's token cap, judge call or apply
step and are carried into the next document's gather step; `repairedThrough` is the high-water mark
of fully-repaired document ids (`-1` = none yet), the boundary the standalone `streamingRepairer`
catch-up step resumes from.

### 3.3 `extractions/NN.json` (stage-1 output)

```json
{
  "entities": [
    { "name": "Sandworm group", "category": "HackerGroup", "role": "Attacker" },
    { "name": "SCADA systems", "category": "IndustrialSystem", "role": "Target" }
  ],
  "relations": [
    { "head": "Sandworm group", "headCategory": "HackerGroup",
      "type": "attacks",
      "tail": "SCADA systems", "tailCategory": "IndustrialSystem" }
  ],
  "schemaProposals": {
    "categories": [
      { "name": "IndustrialSystem", "definition": "Industrial control or operational-technology system" }
    ],
    "relationTypes": []
  },
  "metadata": { "date": "17.01.2020", "id": 16, "title": "…", "llmProcessingTimeSeconds": 4.6 }
}
```

`relations[].head/tail` reference entity `name` values from the same file; `headCategory`/
`tailCategory` disambiguate same-name entities of different categories.

### 3.4 `artifacts/NN.json` — **the main output**

The extraction shape plus normalization stamps. A strict superset of today's
`normalized/NN.json`:

```json
{
  "entities": [
    { "name": "Sandworm group", "category": "HackerGroup", "role": "Attacker",
      "normalizedName": "Sandworm" },
    { "name": "Ukraine", "category": "Country", "role": "Target",
      "normalizedName": "Ukraine", "code": "UA" }
  ],
  "relations": [
    { "head": "Sandworm group", "headCategory": "HackerGroup",
      "type": "attacks",
      "tail": "SCADA systems", "tailCategory": "IndustrialSystem",
      "normalizedHead": "Sandworm", "normalizedTail": "SCADA systems" }
  ],
  "schemaProposals": { "categories": [], "relationTypes": [] },
  "metadata": { "date": "17.01.2020", "id": 16, "title": "…", "llmProcessingTimeSeconds": 4.6 }
}
```

Artifacts are immutable **except** for deterministic re-stamping of `normalizedName` /
`normalizedHead` / `normalizedTail` — collectively `normalized*` — by the **StreamingRepairer**
(§4.3), still the only writer. Nothing else ever rewrites them.

**Backward compatibility.** `entities[]` keeps the exact field names of `UnifiedData.Entity`
(`name`, `category`, `role`, `normalizedName`, `code`), so `DataAnalyzer` and other
`ProcessedIncident` consumers keep working, with one type-level change: `category` widens from the
closed `Category` union to `string`. Required change in `src/utils/validationUtils.ts`: a new
LIVR validator for streaming mode where `category: ['required', 'string']` (no `oneOf`), `role`
keeps its `oneOf`, plus validation for the new `relations` and `schemaProposals` blocks. The
legacy validator stays untouched for the batch pipeline.

### 3.5 `decisions.jsonl` (optional, `--log`)

One JSON object per line; written only when logging is enabled. Purely an evaluation/debugging
instrument — nothing reads it at runtime.

```json
{ "doc": 23, "op": "link", "mention": "UAC-0002", "category": "HackerGroup",
  "candidates": [ { "name": "Sandworm", "sim": 0.34 } ],
  "verdict": "link", "target": "Sandworm",
  "evidence": "the Sandworm group (also tracked as UAC-0002)" }
{ "doc": 23, "op": "mint", "mention": "SCADA systems", "category": "IndustrialSystem",
  "candidates": [], "verdict": "mint", "target": "SCADA systems" }
{ "doc": 40, "op": "alias-relation-type", "proposal": "targeted", "target": "attacks" }
{ "doc": 999, "op": "merge-canonical", "category": "HackerGroup",
  "from": "Voodoo Bear", "into": "Sandworm", "by": "RegistryConsolidator" }
```

RQ2 (linking precision/recall vs. a gold alias table) is computed by replaying `link`/`mint`
events against the gold table. RQ5 call counts come from one `llm-call` event per request
(`{ "op": "llm-call", "doc": N, "kind": "extract|type-judge|link-judge|consolidate", "tokens": … }`).

**Amendment 2026-08-04 — new events.** `llm-call.kind` gains `ladder` (plus the already-present
legacy `pair-rule` and `country-normalize` values). Normalization no longer emits `pair-rule` calls.
Decision events may carry `decision: "defer"` with
`target: null` and a non-scoring `mintedAs` field (protocol §5 semantics preserved: a deferral is
a withheld decision, provisionally minted). New ops: `granularity-edge`
(`{category, from, to, kind, by?}` — from the judge, ladder binding, or the consolidator),
`rename-edge`, `discover-ladder` (full cached ladder payload — the run playback viewer replays
state from these), `split-canonical`, `category-correction`. `decisions.jsonl` remains
evaluation/debug-only at runtime; the offline `npm run view` playback page and `npm run replay`
read it after the fact.

**Amendment 2026-08-05 — repair events (`StreamingRepairer`, §4.3).** New ops: `suspect`
(`{doc, op, pair, categories, signal, score}` — one per suspect gathered, whatever its eventual
disposition); `repair-merge` (`{category, from, into, by}` — `into` is the ACTUAL survivor, never
the requested one); `repair-distinct` (`{pair, categories, confidence, demotedFrom}`);
`repair-spillover` (`{size, reason}`, reason ∈ `token-cap | judge-failed | incomplete |
op-rejected`); `repair-split` (`{category, canonical, detached, newCanonical}`); `repair-move`
(`{alias, from, to, categories}`); `repair-keep`; `repair-op-rejected` / `repair-op-skipped`
(validator/apply-time rejections, log-only); `gloss-flagged` (`{mention, category, kind}` — a
mint/defer gloss still bad after phase 1's one retry, mint proceeds with no gloss).
`granularity-edge`, `rename-edge` and `category-correction` (2026-08-04 amendment above) gain
`by: 'StreamingRepairer'` when phase 2 emits them, distinguishing repair-time provenance from the
judge/ladder-binding/harness sources already documented. New `llm-call.kind`: `repair-judge` (the
≤1 first-attempt Ψ_repair call), `repair-judge-retry` (its ≤1 completeness re-ask),
`link-judge-retry` (phase 1's own ≤1 gloss re-ask, `StreamingNormalizer`). As always: log-only,
nothing reads `decisions.jsonl` at runtime.

### 3.6 `graph/nodes.csv`, `graph/edges.csv`

Node format as today (`Id;Label;EntityType;RiskScore;Date`); edges gain one column:
`Source;Target;Weight;EdgeType;Kind;Date` where `Kind ∈ extracted | inferred`. Node key stays
`category:normalizedName`; weight stays "number of distinct incidents"; `Date` stays
earliest-seen. `EdgeType` is the canonical relation-type name from `schema.json`. Edges aggregate
per `(source, target, edgeType, kind)` — collapsing the `kind` split (for the dense
2025-comparable view) is a trivial post-filter.

## 4. Processors

All follow the existing `DataProcessors` conventions: `Params` constructor object with dirs +
`llmClient`, a `run()` loop over a directory, `console.time` instrumentation, skip-if-output-
exists resumability. New support classes go in the already-staged empty dirs:
`src/SchemaRegistry/SchemaRegistry.ts`, `src/EntityRegistry/EntityRegistry.ts`,
`src/DecisionLog/DecisionLog.ts` (optional appender). The remaining v1 scaffold dirs
(`OpenExtractor/`, `EntityLinker/`, `TypeResolver/`, `Consolidator/`, `TemporalGraph/`) are
superseded by this spec and can be deleted (or `Consolidator/` reused for the consolidator class).

### 4.1 `StreamingExtractor` (evolution of `DataExtractor`)

Per document: render prompt from `SchemaRegistry` → 1 LLM call → parse/validate → resolve schema
proposals → write `extractions/NN.json`.

**Schema-proposal resolution** (inside the same processor, after parsing):

1. For each proposed category/relation type, compare against existing schema entries
   (`name` + `aliases`) by normalized string similarity (see §4.2).
2. No near match → **admit** as new schema entry (`firstSeen` = doc id).
3. Near match(es) → **one batched type-judge LLM call** for all ambiguous proposals of the
   document: verdict `alias-of:<name>` (append to that entry's `aliases`) or `new`.
4. Every admit/alias appends to `schema.json.history`.

Cold start: with an empty schema the prompt simply shows empty lists — everything is proposed,
everything is admitted (after intra-document near-match collapsing). The schema saturates within
a few dozen documents; from then on the type-judge call fires rarely.

**Prompt** (replaces the fixed-schema prompt of `DataExtractor`; role definitions, the
role-assignment rules engine, implied-country rule, deduplication and exclusions are kept
verbatim from the current prompt — marked below):

````text
### ROLE ###
You are a specialized AI model functioning as a high-precision data extraction engine. Your
purpose is to parse unstructured text about cyber incidents and convert it into a structured
JSON object according to the rules provided.

### KNOWN SCHEMA ###
The schema below was discovered from previously processed documents. REUSE its categories and
relation types whenever they fit. Only propose a new category or relation type when nothing in
the known schema fits; a proposal must include a one-line definition.

Known entity categories:
{{#each categories}}
  * `{{name}}`: {{definition}} (e.g., {{examples}})
{{/each}}

Known relation types:
{{#each relationTypes}}
  * `{{name}}`: {{definition}}
{{/each}}

Roles are FIXED (never propose new roles):
  * `Target`: The ultimate entity being victimized or attacked.
  * `Attacker`: The aggressor, or any software, domain, or infrastructure directly controlled by
    and used by the aggressor to facilitate an attack.
  * `Neutral`: A third-party observer, security researcher, reporting agency, or any entity not
    directly involved in the conflict.

### WHAT TO EXTRACT ###
1. `entities`: every relevant entity as { "name", "category", "role" }.
   - `category`: a known category name, or your proposed new one (also listed in
     `schemaProposals.categories` with its definition).
   - `role`: exactly one of Target | Attacker | Neutral, per the RULES ENGINE below.
2. `relations`: every relationship STATED OR CLEARLY IMPLIED IN THE TEXT between two extracted
   entities, as { "head", "headCategory", "type", "tail", "tailCategory" }.
   - `type`: a known relation type name, or your proposed new one (also listed in
     `schemaProposals.relationTypes` with its definition).
   - Direction: head acts on tail (e.g., attacker attacks target).
   - Do NOT invent relations that the text does not support. It is correct to return few or no
     relations. Do NOT add a relation for every co-occurring pair.
3. `schemaProposals`: { "categories": [{ "name", "definition" }],
   "relationTypes": [{ "name", "definition" }] } — empty arrays when everything fit the known
   schema. Absence of new types is the normal case, not a failure.

### RULES ENGINE ###
[Rule 1: Role Assignment Logic — Conditions A/B/C, verbatim from the current DataExtractor prompt]
[Rule 2: Implied Country Extraction — verbatim]
[Rule 3: Strict role adherence — roles only from the fixed list]
[Rule 4: Deduplication — verbatim, applied to entities]
[Rule 5: Negative Constraints — verbatim: ignore CERT-UA; ignore generic technologies]

### FINAL OUTPUT FORMAT ###
First think through the incident in free form (who did what to whom, with which tools). Then
output a single raw JSON object: { "entities": […], "relations": […], "schemaProposals": {…} }.
No markdown fences, no commentary after the JSON. If nothing is found:
{ "entities": [], "relations": [], "schemaProposals": { "categories": [], "relationTypes": [] } }.
````

(The `{{#each}}` blocks are template pseudo-code — implement with a simple string join, no
templating dependency needed.)

### 4.2 `StreamingNormalizer` (replaces `DataEntitiesCollector` + `DataNormalizer`)

Per document (`extractions/NN.json` → `artifacts/NN.json`):

1. **Exact fast path** — for each entity, look up `lowercase(name)` in the registry's alias map
   for its category (after schema-alias resolution of the category name). Hit → `normalizedName`
   assigned, zero cost. After the first few hundred documents this resolves the large majority
   of mentions.
2. **Candidates** — for each miss, top-k (k=5) canonical candidates within the category by string
   similarity over all aliases. Similarity: max of normalized Levenshtein ratio and token-set
   Dice over lowercased strings; keep candidates ≥ 0.5. Implement inline or with a tiny dep
   (e.g. `fastest-levenshtein`); **embeddings are explicitly out of scope for v1** (upgrade path:
   swap the candidate generator for ANN over `EmbeddingsClient` vectors — the interface stays
   `candidates(category, name) → [{name, sim}]`).
3. **Link-judge** — ONE batched LLM call for all unresolved mentions of the document. Input per
   mention: the mention, its category, the document title + a text snippet, and its candidates
   with alias lists. Verdict per mention: `link:<canonicalName>` or `mint`. Mentions with zero
   candidates skip the call and mint directly.
   **Amendment 2026-08-04 — the three-verdict rung-aware judge.** The authoritative prompt is
   `prompts/link-judge.md`, with placeholders
   `{{docTitle}}/{{docSnippet}}/{{mentionsBatch}}`; candidates are shown with their current
   rung. Verdicts: `link | mint | defer`, plus `mentionRung ∈ g0..g3` and — on mint — an
   optional `parentCandidate` + `edgeKind` (`coarsens-to | part-of`). Post-checks in code: a
   `link` target must case-insensitively match a listed candidate else it demotes to `mint`; a
   `parentCandidate` must match a listed candidate else the edge is dropped and the mint stands;
   a valid parent yields a granularity edge with judge provenance; `defer` = provisional mint +
   defer-queue entry. Sketch below is the pre-amendment two-verdict prompt, kept for history.
4. **Registry update** — links append the mention to the canonical's `aliases`; mints create a
   new canonical record (`firstSeen` = doc, `rung` = the judged `mentionRung`). Registry saved
   once per document.
5. **Pair-rule discovery — removed 2026-08-17.** The step computed `(category, role) ×
   (category, role)` co-occurrence signatures and cached one batched LLM verdict per novel
   signature in `schema.json.pairRules`. It keyed on contextual roles — not entity-normalization
   evidence — so `#pairRuleJudge` and the per-document `pair-rule` call are gone; the table is now
   read-only (§3.1) and the graph fold (§4.4) consumes it unchanged when pre-seeded.
6. **Stamp & write** — `normalizedName` on every entity, `normalizedHead`/`normalizedTail` on
   every relation (resolved through the same map); `code` via the existing
   `CountryNameNormalizer` for `Country` entities; since 2026-08-04 also **`matchedVia`** (the
   registry surface the mention actually hit, in stored casing) — the precondition for a repair
   re-stamp (StreamingRepairer, §4.3, and the RQ3 batch-reference harness) that resolves by the
   alias each mention actually hit rather than by a now-ambiguous canonical. Write
   `artifacts/NN.json`.
0. *(Amendment 2026-08-04, runs before step 1)* **Ladder bootstrap** — for every category this
   document touches, `LadderDiscovery.maybeDiscover` fires the `ladder` prompt ensemble when the
   category first crosses `LADDER_MIN_EXAMPLES` distinct surfaces (re-fires at ≥2× growth),
   validates, caches into `schema.json`, and retroactively binds rungs/edges over existing
   canonicals whose names match rung examples.

**Link-judge prompt sketch:**

````text
You are an entity-resolution judge for a cyber-incident knowledge base.
For each mention below, decide whether it refers to one of the known canonical entities of the
same category (answer "link" with its name) or to an entity not seen before (answer "mint").
Only link when the evidence supports identity: shared naming, a stated alias in the document
context, or an unambiguous abbreviation. Similar type or theme alone is NOT identity. If
uncertain, prefer "mint" — duplicates are repairable later, wrong merges are not.

Document: "{{title}}" — context: {{snippet}}
Mentions:
1. "UAC-0002" (HackerGroup); candidates: Sandworm [aliases: Sandworm, Sandworm group]
2. …

Output raw JSON: { "verdicts": [ { "mention": "UAC-0002", "verdict": "link", "target": "Sandworm" } ] }
````

**Pair-rule judge prompt sketch** (fires only for never-seen signatures):

````text
You maintain co-occurrence inference rules for a cyber-incident knowledge graph. When two
entities with the type/role signatures below appear in the same incident report, what
relationship — if any — does that co-occurrence imply BY DEFAULT? Answer conservatively:
use "none" unless the signature itself implies a directed relationship. Reuse a known relation
type when one fits; otherwise propose a new one with a one-line definition.

Known relation types: attacks: …; uses_infrastructure: …; …
Signatures to rule on:
1. HackerGroup/Attacker × Organization/Target
2. Organization/Neutral × Country/Neutral

Output raw JSON: { "rules": [ { "signature": 1, "relation": "attacks",
  "source": "HackerGroup/Attacker", "target": "Organization/Target" },
  { "signature": 2, "relation": null } ] }
````

### 4.3 StreamingRepairer (synchronous per-document repair — phase 2 of every document)

> **Superseded 2026-08-05.** The deferred RegistryConsolidator of the previous revision is deleted
> as a system component (kept only as the RQ3 batch-reference harness, bin/batch-reference.ts).
> Design: dissert/wiki/notes/streaming-repair-design.md.

Runs at the end of every document's `StreamingNormalizer.processFile`, via a `repairer` hook
(`REPAIR=0` omits it entirely — the RQ3 NAIVE arm). Where §4.2 is phase 1 (extract mentions,
resolve identity), this is phase 2: repair whatever phase 1 got wrong, scoped to the document just
processed plus whatever earlier documents deferred or could not fit. The deleted consolidator's
per-category batching bet failed on the measured corpus — one category's suspect set arrived as a
single ~22.6k-token prompt, over an 8k local window. Running every document keeps each call small
*by construction* instead of by tuning.

1. **Suspect generation** (`SuspectGenerator`, `eventsForDoc`) — for every mint and alias-add this
   document produced, across ALL categories:
   - **union-blocker probe** — `blocker.candidates()` (the phase-1 blocker instance, shared so its
     index does not go stale) against the event's surface; a hit ≥ `REPAIR_BLOCKER_THRESHOLDS`
     becomes a `union-blocker` suspect. Top `REPAIR_TOP_K` (default 5) candidates kept per event.
   - **gloss-ANN probe** — nearest neighbours in `GlossIndex` (brute-force cosine over
     `embed(name+gloss)`, byte-identical text format to the phase-1 embedding channel so the disk
     embedding cache is shared) ≥ `REPAIR_GLOSS_THRESHOLDS` become `gloss-ann` suspects.
     **Documented deviation:** the design note calls for a gloss-embedding ANN index; this brute-force
     cosine scan substitutes for it, same rejection as `EmbeddingGenerator`'s (`GlossIndex.ts:29-33`,
     `EmbeddingGenerator.ts:41-43`) — at ~2,674 canonicals an ANN index is scale theatre, not an
     oversight, and the retrieval call is swappable behind the same interface if the corpus ever grows
     into ANN's actual regime.
   - **coherence probe** (alias-adds only) — leave-one-out centroid drift on the linked-into
     canonical's alias set; below `REPAIR_COHERENCE_THRESHOLD` becomes a single-entity `coherence`
     suspect (`b === a`). **Documented deviation:** the design note leaves "centroid" undefined; the
     implemented centroid (`GlossIndex.ts:40-45,88-98`) is the L2-normalized mean of the entity's
     alias-surface vectors plus its own name+gloss vector, pooled uniformly (not weighted toward the
     name+gloss vector) — and the comparison pool is leave-one-out per probe, excluding the probed
     alias's own vector so a same-document link already folded into the index cannot inflate its own
     coherence score.
   - Both threshold env vars parse as `"Category=0.97,default=0.85"` (a `default` entry is
     required) and default HIGH when unset (glossAnn 0.92, blocker 0.88) — unlike the phase-1
     blocker's recall-oriented floor, nothing sits between a suspect and an adjudication call here,
     so the threshold does the precision work.
   - **Defer-derived pairs** — every live candidate the link-judge listed for a deferred mention
     (§4.2 step 3) becomes a suspect against the provisional mint; the defer-queue entry is
     consumed (removed) regardless of verdict, so a pair left unruled here does not re-queue
     forever.
   - **Adjudicated-set dedup** — a suspect whose current `(a, b)` signature already matches an
     `adjudicated` memo is suppressed; a `distinct` verdict reached at low confidence writes the
     memo with signature `''`, a sentinel that never equals a real sha256 digest — that suspect is
     *retained* and re-fires on every future occasion (the mint-over-merge asymmetry running at
     repair time, same as the batch-consolidator's rule but now per-document).
2. **Components + token cap + spillover** (`Repair/components.ts`) — suspects union-find into
   connected components (a shared entity merges two components into one); each component becomes
   one prompt block. Components are packed under `REPAIR_TOKEN_CAP` (default 8000, the 8k local
   window the old consolidator prompt overflowed); when full, the lowest-scoring edge is evicted
   and the component is re-scoped from scratch (an eviction can split one component into two),
   repeating until everything fits or is queued. A component left with no pair edges and no
   coherence check after eviction (a bare singleton) is dropped, not queued. Whatever does not fit
   joins the **spillover queue** (registry v4 `repair.spillover`, §3.2) — carried into the next
   document's gather step, first-in.
3. **Ψ_repair call** — ONE first-attempt `repair-judge` call over every due component (authoritative
   prompt `prompts/repair-judge.md`; placeholder
   `{{components}}`). **User ruling 2**: at most one first-attempt call per document, plus at most
   one validator-driven completeness re-ask (`repair-judge-retry`) containing only the components a
   completeness check ("every listed pair needs an op, every coherence entity needs an op") found
   incomplete after the first response. The re-ask **fills gaps, it does not replace** — the first
   accepted verdict for any given pair wins, so a sibling op's rejection in the re-ask cannot undo a
   settled one. Whatever is still incomplete after the retry spills. A judge call that throws sends
   every due suspect straight to spillover — the document is never aborted.
4. **Validation** (code, wiki rule 7): (a) schema — unrecognized ops dropped, missing/bad
   `confidence` demoted to `'low'`; (b) every entity name an op references must
   case-insensitively match a listed component member, else the op is rejected
   (`repair-op-rejected`, log-only) and adjudicates nothing — a self-pairing or duplicate-pair op is
   rejected the same way, keeping "exactly one op per pair" a function of the suspects; (c)
   completeness, recomputed over the first attempt and the retry combined.
5. **Apply** (code only, the full SKEIN v2 inventory):

   | op | effect | notes |
   |---|---|---|
   | `merge` | `applyMerges` (survivor chosen by `canonicalPolicy` under transitive closure — the ACTUAL survivor is logged, never the requested `into`) | cross-category `merge` = `move` then merge, plus a `category-correction` log entry; low confidence (`confidence: 'low'`) demotes to `distinct` with the `''` retained-suspect signature instead of merging (mint-over-merge asymmetry) |
   | `distinct` | writes an `adjudicated` memo keyed on the pair's current signature | suppresses re-firing until either member's content changes |
   | `rung` | `addGranularityEdge` (`coarsens-to`/`part-of`), same-category only | **documented deviation** (design R4): also pushes an `adjudicated` memo (`verdict: 'rung'`) so the pair does not re-fire forever asking a judge who can only say `rung` again — a granularity edge is not identity, but it is treated as settled |
   | `renamed` | **user ruling 1**: absorbs via `renameInto`, whose survivor is ALWAYS the new name (`to`) — `canonicalPolicy` has no vote — AND preserves the historical `renamed-to` edge; both a `rename-edge` and a `repair-merge` are logged, so the identity fold and the historical record are both replayable | cross-category rejected (spills) |
   | `split` | `EntityRegistry.split` detaches the named alias into a new canonical | |
   | `move` | `moveAlias` — the single-alias move primitive (T3), across categories | no whole-canonical move primitive existed before this |
   | `keep` | writes an `adjudicated` memo (`verdict: 'keep'`) for a coherence check that found nothing wrong | **documented deviation**: enters `adjudicated` same as `distinct`/`rung` — the design note has no `keep` verdict feeding the adjudicated set; without it a clean coherence check would re-fire on every future document instead of being settled |

   Every applied mutation fires `onRegistryChange` so the phase-1 blocker index does not go stale.
   An op whose endpoint was absorbed by an earlier op in the same batch is skipped
   (`repair-op-skipped`), not spilled — the suspect it named no longer exists. An op the registry
   itself refuses (a primitive returns nothing) spills the ORIGINAL suspect, not a synthesized one,
   so its signal/score survive into the next document's capping.
6. **Re-stamp** (`restampArtifacts`, `Repair/restampArtifacts.ts`) — deterministic, resolves **by
   `matchedVia`** (never by the now-ambiguous canonical), **WHOLE CORPUS** whenever any op touched
   a live canonical this document, not scoped to the touched document's own mentions:
   `EntityRegistry.link` is idempotent, so a repeat mention of an already-known surface writes no
   alias record, and deriving "affected documents" from alias `docId`s would silently miss every
   repeat mention — measured 711/4,071 stamped mentions (17.5%) on the baseline corpus. This is the
   **idempotent-link trap**, documented at `StreamingRepairer.ts` step 7's class comment; per-alias
   mention-doc tracking would fix it properly and is named there as the future, registry-level fix.
   **No LLM, no re-extraction.**
7. **Invariants.** **I1 — debt-free boundary**: after document *d*, every suspect gathered is
   settled by one of three things (`assertSuspectsAccounted`, `StreamingRepairer.ts:1074-1092`): an
   op applied **this document**, a spillover-queue slot, or either member no longer being a live
   canonical (absorbed by an earlier op in the same batch). The persisted `adjudicated` set is
   deliberately **not** consulted — checked in memory before the save, never from `decisions.jsonl`
   (wiki rule 10) — because a memo from an earlier document proves nothing about what *this* document
   did: a low-confidence merge's `''`-signature retained suspect is meant to re-fire on every future
   occasion, and counting its stale memo as settlement would blind I1 to exactly the pairs it exists
   to watch. (Ops that *do* write a memo this document — `distinct`/`rung`/`keep` — already record
   their key at the moment they write it, so this-document memos are covered without the stale ones
   coming along.) **I2 — call cap** (user ruling 2): at most one
   first-attempt `repair-judge` call per document; the retry is budgeted and counted separately.
   Both assertions run BEFORE the single `entityRegistry.save()` that commits everything phase 2
   did, so a violated invariant is never what gets persisted.

**Crash story.** Phase 1 has already committed this document's artifact and registry writes before
phase 2 starts, so phase 2 only ever repairs durable state. All of its mutations land in one
`save()`, and `setRepairedThrough(docId)` is part of that same write, so `repairedThrough` can never
claim a document whose repairs were not persisted. A crash between re-stamp and save re-runs phase 2
for that one document on resume (`repairedThrough < docId`): suspects re-derive identically, the
`adjudicated` memo suppresses everything already ruled on, and the re-stamp is idempotent (it
rewrites an artifact only when the rendered JSON actually differs).

**`GlossIndex.sync` failure is deliberately FATAL to the document** (not caught, unlike the judge
call) — a repair pass that silently skipped its own embedding sync would corrupt an arm with no
error signal, which is worse than failing loudly.

**Standalone catch-up.** The `streamingRepairer` step (§5) re-runs phase 2, ascending document
order, for any document with `docId > repairedThrough` — for a registry whose repair pass never
ran (an existing corpus, or a run that died mid-stream). It requires `REPAIR=1` (the default);
`REPAIR=0` constructs no repairer at all, so there is nothing to catch up.

**The RQ3 batch-reference harness** (`src/Consolidator/RegistryConsolidator.ts`, run via
`RUN_DIR=<copy> npm run batch-reference -- --copied`, `bin/batch-reference.ts`) is what remains of
the deleted consolidator: the old registry pass + cross-category sweep + schema pass + full-corpus
re-stamp, over a COPY of a run directory only — never wired into the live pipeline, and refuses to
run without `--copied` since there is no reliable way to tell a copy from an original by path
alone. It exists for E6 regime (ii) / RQ3 order-robustness comparisons, not for repair. Its
objective, same as before: evidence-bounded repair only, never assertional relations, never
optimizing for graph connectivity.

### 4.4 `DataGraphBuilder` v2

Extend the existing class with an input mode:

- `edgesFrom: 'layered'` (explicit legacy/pre-seeded mode): per document, per entity pair —
  1. if the artifact contains extracted relation(s) between the two entities → emit them as
     `kind: extracted` edges;
  2. otherwise look the pair's signature up in `schema.json.pairRules` → emit the rule edge as
     `kind: inferred` (skip when `relation: null` or the signature is unruled).
  Aggregation exactly as today (weight = distinct incident count, earliest date), keyed with
  `kind`. The builder stays **LLM-free**: it only reads the cached rule table.

**Amendment 2026-08-04 — λ (merge granularity at fold time).** `StreamingGraphBuilder` accepts a
per-category rung choice (`LAMBDA="Software=g2,default=g0"`): node labels project upward along
the registry's granularity edges toward the λ rung, rounding down to the nearest populated rung;
`coarsens-to` folds freely, `part-of` only when `LAMBDA_INTERPRETIVE=1` — and every edge touched
by a widening fold is downgraded to `kind: inferred` (the view is an interpretation). Projection
contract: weight = distinct-incident count RECOMPUTED via incident-id set union (never summed up
the ladder — distinct-count is non-additive), earliest date = min, diamonds resolve
deterministically (oldest edge wins). The fold's parameters land in `graph/lambda.json` beside
the CSVs; λ is never part of the runId — refolds are free and views are never stored.
- `edgesFrom: 'extracted'`: extracted relations only — the sparse, fully evidence-grounded graph.
- `edgesFrom: 'cooccurrence'` (legacy): the current hardcoded `#inferRelationship` path, kept as
  the 2025-baseline comparison mode.

Node creation, CSV formats, and `calculateRiskScore` are unchanged; emergent categories fall
through to the existing `default` branches of the risk-score switch.

## 5. Orchestration, ordering, resumability

- New `bin/app.ts` step **`streamingPipeline`**: list input docs, sort ascending by numeric file
  id (chronological for CERT-UA; if a preprocessor supplies `metadata.date`, sort by date), then
  per document: `StreamingExtractor.processFile()` → `StreamingNormalizer.processFile()`, which
  itself runs phase 1 (extraction-stamp resolution, §4.2) then, inside the same call via a
  `repairer` hook, phase 2 (`StreamingRepairer.processDoc()`, §4.3) — **extract → normalize
  (phase 1) → repair (phase 2), synchronously, per document.** `REPAIR=0` omits the hook entirely
  (the RQ3 NAIVE arm). All three classes also keep a directory-level `run()` so each stage can be
  re-run standalone (e.g. re-normalize everything from `extractions/` after wiping
  `registry.json`; `streamingRepairer` as its own step is the standalone catch-up for a registry
  whose repair pass never ran).
- **Amendment 2026-08-05.** `registryConsolidator` is no longer a pipeline step — the deferred,
  manually-triggered consolidator of the previous revision is deleted as a system component. What
  remains under `src/Consolidator/RegistryConsolidator.ts` is the RQ3 order-robustness
  batch-reference harness only, run via `npm run batch-reference` (`bin/batch-reference.ts`)
  against a COPY of a run directory, never the live pipeline's own output (§4.3). `DataGraphBuilder`
  / `streamingGraphBuilder` remain separate steps, run on demand.
- **Resumability** = skip documents whose output file already exists (the existing idiom). Crash
  recovery: state files are written atomically (write temp + rename) once per document; on
  restart the worst case is re-doing the one in-flight document — for repair specifically, at most
  one repeated repair call for that single in-flight document (§4.3's crash story).
- Config via env as today: `STEPS=streamingPipeline`, plus `DECISIONS_LOG=1` to enable §3.5,
  `REPAIR=0` to disable phase 2 entirely.

## 6. Evaluation hooks (for the article)

| RQ | Where it reads from |
|----|---------------------|
| RQ1 schema convergence ν(t) | `schema.json.history` — admits per document, cumulative curve; bonus figure: extracted-vs-inferred edge agreement (how often the text refines or contradicts the signature rule) from `edges.csv` `Kind` split |
| RQ2 linking P/R | `decisions.jsonl` link/mint events vs. a gold alias table |
| RQ3 order robustness | run the pipeline over shuffled doc orders (fresh state dirs); compare `schema.json` + `registry.json` partitions (ARI), with/without repair (`REPAIR=1` vs the NAIVE `REPAIR=0` arm), plus the batch-reference harness as regime (ii) of E6 |
| RQ4 domain transfer | new `storage/<source2>/`; seeded vs. empty initial `schema.json` |
| RQ5 cost | `llm-call` events in `decisions.jsonl` (or the existing timing metadata) per document |

## 7. Out of scope for v1

- Embeddings/ANN candidate retrieval (string similarity only; interface designed for the swap).
- Any mutation of `raw-unified`/legacy outputs — the batch pipeline remains intact and runnable
  for baseline comparisons.

**Amendment 2026-08-05.** "Scheduled/automatic consolidation (manual trigger only)" is deleted
from this list — superseded by the synchronous per-document `StreamingRepairer` (§4.3), which runs
as phase 2 of every document with no manual trigger. What this section originally scoped out is
now the streaming pipeline's default behavior.
