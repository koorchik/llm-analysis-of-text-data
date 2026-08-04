# Streaming Pipeline Spec (SKEIN v2, artifact-first)

Implementation specification for the streaming successor of the batch pipeline
(`DataExtractor` → `DataEntitiesCollector` → `DataNormalizer` → `DataGraphBuilder`).
Design source of truth: `dissert/wiki/notes/streaming-autodiscovery-normalization.md` (v2),
governed by the deck `dissert/wiki/presentations/skein-v2-method.md`.

**Status: implemented** (`FLOW=incremental`; operational guide: `docs/RUNNING-EXPERIMENTS.md`,
runbook: `docs/RUN-STREAMING.md`). The original "no code implemented yet" header is history.

> **Amendment 2026-08-04 (SKEIN v2 granularity sync — follows the deck, per its authority
> rule).** The link-judge became the three-verdict rung-aware judge (`link | mint | defer`,
> `mentionRung`, `parentCandidate`+`edgeKind`; prompt copied verbatim from
> `dissert/wiki/notes/prompts.md`). The registry became a **v3 identity graph** (per-alias
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
3. **Relation autodiscovery, layered** — two complementary sources, both emergent:
   - **Extracted** (primary): relations stated in the text, extracted by the LLM in the same call
     as entities, with an emergent relation-type vocabulary. Evidence-grounded.
   - **Inferred** (fallback): a **discovered signature-rule table** replaces
     `DataGraphBuilder#inferRelationship`'s hardcoded rules. The first time a
     `(category, role) × (category, role)` co-occurrence signature appears, one small cached LLM
     verdict decides what relation (if any) that signature implies; thereafter co-occurring pairs
     **without** an extracted relation get their rule edge deterministically.
   - Every graph edge carries `kind: extracted | inferred` so analyses can use the dense
     2025-comparable graph (both), the precise graph (extracted only), or the legacy-equivalent
     baseline (inferred only).

**Principle: the per-document artifact is the primary output; the graph is a pure fold over
artifacts; shared streaming state is exactly two small JSON files.** After any document, the
pipeline can stop and the artifacts + graph are complete for everything seen so far.

Per-document LLM budget: **1 extraction call + ≤1 type-judge call + ≤1 link-judge call**, plus
≤1 pair-rule call while co-occurrence signatures are still novel (the rule table saturates, so
this term goes to zero). Everything else is string matching and bookkeeping.

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

`extractions/` exists so the expensive LLM extraction is never re-paid: normalization,
consolidation and graph builds can all be re-run from disk.

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
  table **saturates fast** — a few dozen entries in practice.
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
never aliases and never fold; the defer queue is the consolidator's input (nothing reads
`decisions.jsonl` at runtime); assertional relations never enter this file.

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
`normalizedHead` / `normalizedTail` by the consolidator (§4.3). Nothing else ever rewrites them.

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
`pair-rule`, `country-normalize`). Decision events may carry `decision: "defer"` with
`target: null` and a non-scoring `mintedAs` field (protocol §5 semantics preserved: a deferral is
a withheld decision, provisionally minted). New ops: `granularity-edge`
(`{category, from, to, kind, by?}` — from the judge, ladder binding, or the consolidator),
`rename-edge`, `discover-ladder` (full cached ladder payload — the run playback viewer replays
state from these), `split-canonical`, `category-correction`. `decisions.jsonl` remains
evaluation/debug-only at runtime; the offline `npm run view` playback page and `npm run replay`
read it after the fact.

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
   **Amendment 2026-08-04 — the three-verdict rung-aware judge.** The prompt is
   `prompts/link-judge.md`, copied VERBATIM from `dissert/wiki/notes/prompts.md`
   (§ *Document entities streaming linking judge*) with placeholders
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
5. **Pair-rule discovery** — compute the document's co-occurrence signatures
   (`(category, role) × (category, role)` for every entity pair). For signatures **not yet in**
   `schema.json.pairRules`: one batched LLM call (see prompt sketch below) → verdicts cached in
   `pairRules` (+ `history` entry). Signatures already ruled cost nothing; the table saturates,
   so this call disappears after the early corpus.
6. **Stamp & write** — `normalizedName` on every entity, `normalizedHead`/`normalizedTail` on
   every relation (resolved through the same map); `code` via the existing
   `CountryNameNormalizer` for `Country` entities; since 2026-08-04 also **`matchedVia`** (the
   registry surface the mention actually hit, in stored casing) — the precondition for a local
   consolidator split re-stamp. Write `artifacts/NN.json`.
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

### 4.3 `RegistryConsolidator` (optional repair, manual trigger — never scheduled)

Fixes wrong-but-safe streaming decisions. **Amendment 2026-08-04: the full repair inventory —
merge / split / move** (merge-only greedy is the known-weak configuration;
gruenheid2014incremental):

1. **Registry pass** — per category, cluster suspicious canonical pairs using union-blocker-shaped
   signals over full alias sets (string similarity ∪ transliteration/confusable skeleton ∪
   char-3-gram Jaccard, max-over-aliases), **plus every pair the judge deferred** (the registry's
   `deferQueue` bypasses the blocker); one LLM call (`prompts/consolidate-merge.md`) reviewing
   only canonical names + aliases returns the four-verdict repair set: `merges` (same thing, same
   grain), `edges` (rung pair → granularity edge), `renames` (`renamed-to` chain), `splits`
   (mixed alias list → detach). Reviewed defer entries clear from the queue whatever the verdict.
2. **Cross-category sweep** — canonicals in different categories sharing an exact case-folded
   surface are reviewed together (entries labelled `Category/Name`); a confirmed duplicate moves
   + merges and logs a `category-correction` (reported, and fed back upstream).
3. **Schema pass** — same idea over `schema.json` relation types and categories whose alias sets
   or definitions have drifted together; merges append to `history` (merge verdict only).
4. **Re-stamp** — deterministically rewrite `normalizedName`/`normalizedHead`/`normalizedTail`
   in affected artifacts, resolving **by `matchedVia`** (the alias each mention actually hit),
   never by the now-ambiguous canonical — which is what keeps a split local. **No LLM, no
   re-extraction.** Then rebuild the graph.

The consolidator's objective is evidence-bounded repair only — it must never add assertional
relations or optimize for graph connectivity.

### 4.4 `DataGraphBuilder` v2

Extend the existing class with an input mode:

- `edgesFrom: 'layered'` (new default for the streaming pipeline): per document, per entity pair —
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
  per document: `StreamingExtractor.processFile()` → `StreamingNormalizer.processFile()`. Both
  classes also keep a directory-level `run()` so each stage can be re-run standalone (e.g.
  re-normalize everything from `extractions/` after wiping `registry.json`).
- `RegistryConsolidator` and `DataGraphBuilder` are separate steps, run on demand.
- **Resumability** = skip documents whose output file already exists (the existing idiom). Crash
  recovery: state files are written atomically (write temp + rename) once per document; on
  restart the worst case is re-doing the one in-flight document.
- Config via env as today: `STEPS=streamingPipeline`, plus `DECISIONS_LOG=1` to enable §3.5.

## 6. Evaluation hooks (for the article)

| RQ | Where it reads from |
|----|---------------------|
| RQ1 schema convergence ν(t) | `schema.json.history` — admits per document, cumulative curve; bonus figure: extracted-vs-inferred edge agreement (how often the text refines or contradicts the signature rule) from `edges.csv` `Kind` split |
| RQ2 linking P/R | `decisions.jsonl` link/mint events vs. a gold alias table |
| RQ3 order robustness | run the pipeline over shuffled doc orders (fresh state dirs); compare `schema.json` + `registry.json` partitions (ARI), with/without consolidation |
| RQ4 domain transfer | new `storage/<source2>/`; seeded vs. empty initial `schema.json` |
| RQ5 cost | `llm-call` events in `decisions.jsonl` (or the existing timing metadata) per document |

## 7. Out of scope for v1

- Embeddings/ANN candidate retrieval (string similarity only; interface designed for the swap).
- Scheduled/automatic consolidation (manual trigger only).
- Any mutation of `raw-unified`/legacy outputs — the batch pipeline remains intact and runnable
  for baseline comparisons.
