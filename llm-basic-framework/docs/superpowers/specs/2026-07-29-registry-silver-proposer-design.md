# Registry as a second pair proposer for the gold table

**Status:** implemented
**Date:** 2026-07-29
**Touches:** `src/Gold/`, `bin/gold.ts`, `docs/GOLD-TABLE.md`

---

## 1. The problem

`gold pairs` proposes candidates from string mechanisms only — edit similarity, transliteration,
confusable skeletons, identifier regexes. That is correct for strata (a) and (b) and useless for (c)
and (d), which are defined by having no string overlap. `GOLD-TABLE.md` §4 says stratum (d) "cannot
be skipped" and that an empty (d) is "the single most important thing the validator says". Today
both judgment strata are empty and the only stated sources for them are an authority pass and manual
work that has not happened.

Meanwhile the repository already contains a semantic alias map over the exact same corpus:
`storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json`, a
`category → surface → canonical` map produced by `DataEntitiesCollector`. Grouping surfaces by
shared canonical yields alias clusters directly.

## 2. What the registry actually contains

Measured against `gold/inventory.json` (3,360 surfaces from `raw-unified/gpt-5`):

| quantity | value |
|---|---|
| registry keys | 3,392 |
| keys that resolve to an inventory surface in the same category | all 3,392 |
| keys dropped by cross-validation | 0 |
| multi-surface clusters | 280 |
| implied pairs, both surfaces in inventory | 4,960 |
| …of which `Domain` | 4,551 |
| non-`Domain` pairs | 405 |
| non-`Domain` pairs also proposed by the string mechanisms | 110 |
| non-`Domain` pairs the string mechanisms never propose | **295** |

Cross-validation drops **nothing**: the two artifacts are in exact correspondence. Matching is
case-insensitive, because `buildInventory` folds case variants into one row keeping the first-seen
spelling — the registry's `CloudFlare` and the inventory's `Cloudflare` are the same surface, which
is also why there are 3,392 keys for 3,360 surfaces. The check stays regardless: without it, drift
would silently produce pairs naming surfaces the corpus does not contain, and `gold build` discards
those without a word.

**The split by string signal is exact.** Of the 405 non-`Domain` registry pairs, 110 reproduce a
string proposal (101 edit-similarity, 7 identifier, 2 transliteration) and the remaining 295 have no
string mechanism firing and similarity below the 0.7 threshold. There is no ambiguous middle.

### What it finds that strings cannot

```
HackerGroup:  APT44         <> Sandworm
HackerGroup:  UAC-0114      <> Winter Vivern
HackerGroup:  GhostWriter   <> unc1151
HackerGroup:  @frwl_team    <> FRwL
Organization: ЄС            <> Європейський Союз
Software:     CVE-2021-44228 <> Log4Shell
Software:     Remote Utilities <> rutserv.exe
```

These are stratum (c)/(d) rows, at similarity 0, for 295 additional adjudications on top of 1,624 —
about 18% more work aimed entirely at the stratum that currently has nothing in it.

### What it gets wrong: hierarchy mistaken for coreference

The registry over-merges, and the failure has one shape. Entity resolution asks whether two names
denote the **same referent**. The registry answers whether two things are **related**:

| pair | relation | correct merge? |
|---|---|---|
| `CloudFlare` / `Cloudflare Inc.` | coreference — two names, one referent | yes |
| `MS Office` / `Microsoft Office` | coreference (abbreviation) | yes |
| `Microsoft Office 2016` / `Microsoft Office` | instance-of — a version *of* a product | **no** |
| `admin.certifiedauth.in` / `certifiedauth.in` | part-of — a host *under* a domain | **no** |
| `admin.certifiedauth.in` / `analytics.certifiedauth.in` | siblings — co-located, distinct | **no** |

Coreference is symmetric and identity-preserving; hierarchy is neither. Only the first is what this
gold table scores.

Classifying every `Domain` merge mechanically: of **4,551 pairs, 716 are part-of and 3,835 are
siblings under a common parent. Zero are coreference.** The entire category contains no correct
merge. `Software` shows the same shape more mildly — `Microsoft Office` absorbs 2007/2010/2013/2016/
2019 alongside `MS Office`; `MS Exchange` merges with `Microsoft Exchange Server 2010`–`2019`;
`Windows Script Host` merges with both `cscript.exe` and `wscript.exe`, which are different binaries.
All of this contradicts the `differing-digits` rule that §4 of `GOLD-TABLE.md` identifies as the
largest source of false merges.

### Root cause

`prompts/psi-norm-batch.md`, the published Ψ_norm artifact, reads:

> Group **similar** entities together and provide a single normalized name for each group.

Similarity, never identity. `admin.certifiedauth.in` genuinely *is* similar to `certifiedauth.in`.
The baseline has no identity criterion, so it cannot do entity resolution — it is doing what it was
asked. This is not model noise; it is systematic and predictable, which is why §8 treats it as a
result rather than an obstacle.

### Why this is a defect and not merely a coarser granularity

Two reasons, both of which force the gold to sit at coreference granularity:

1. **It is lossy in the irreversible direction.** Coarse is derivable from fine — roll hostnames up
   with a public-suffix list, strip version tokens. Fine is not recoverable from coarse. Roll-up
   must therefore be a separate, explicitly reported operation, never baked into the reference.
2. **For `Domain` it erases the phenomenon under study.** Under `ssl2.site` the registry collapses
   `docs.google.com.ssl2.site` and `docs.googie.com.ssl2.site` into one entity. That
   `googie`/`google` substitution is the homoglyph typosquat §8 of `GOLD-TABLE.md` calls the
   genuinely interesting part of the category.

In fairness: for blocklisting, registrable-domain granularity is what an operator wants. The
behaviour is not senseless — it is simply not entity resolution, and not what is being measured.

### Why pairs and not clusters

The `Microsoft Office` cluster holds 11 surfaces including **one correct merge** (`MS Office`) and
several wrong ones. It cannot be accepted or rejected wholesale, which is why the design adjudicates
pairs. Transitive closure is unforgiving here: accept `MS Office` = `Microsoft Office` (true) plus
`Microsoft Office 2016` = `Microsoft Office` (false) and closure yields
`MS Office` = `Microsoft Office 2016`. `gold build` detects *contradictions*, not
consistent-but-wrong closures — one bad pair takes its whole cluster with it.

So: the registry proposes, the annotator disposes. Same contract the string proposer already has.

## 3. The contamination problem

`npm run evaluate -- --batch <entities.json>` scores the batch Ψ_norm arm against this exact file.
The registry is the output of a system under test.

Manual verification fixes **precision** — the annotator deletes bad merges. It cannot fix
**recall**: a merge the batch arm missed can only reach the gold via the string mechanisms or an
external authority. Left unaddressed this inflates the batch arm's recall relative to the streaming
arm, asymmetrically.

Note the two failure directions are independent and both real: within the clusters it forms the
registry **over**-merges (§2), while across the corpus it **under**-proposes — 405 non-`Domain`
pairs against the string proposer's 1,624. Over-merging does not buy back the missed merges, so the
recall concern stands undiminished.

This is a reason to record and measure the bias, not to reject the source. The mitigation is §5.4.

## 4. Non-goals

- **`Domain` stays excluded.** The registry proposes 4,551 `Domain` pairs; including them would make
  `Domain` 74% of the worksheet, and by §2 not one of them is a coreference merge — they are
  part-of (716) and sibling (3,835) relations. `--skip-categories` applies to both proposers. §8 of
  `GOLD-TABLE.md` is unchanged, though §2's typosquat-erasure finding strengthens its case for an
  eventual deliberate `Domain` sample aimed at the homoglyph families.
- **No auto-`same` from the registry alone.** No registry-only pair is ever pre-labelled positive.
- **No second-model registry.** `processed/incremental/gpt-5.4-nano` exists and is same-family, so it
  buys weak independence. Out of scope.

## 5. Design

### 5.1 `src/Gold/registryPairs.ts`

```ts
export interface RegistryPair extends ProposedPair {
  /** The canonical both surfaces were mapped to. Context for the annotator, never evidence. */
  canonical: string;
  /** Reporting-only classification of what the registry merged. Never a label. See below. */
  relation: 'part-of' | 'sibling' | 'instance-of' | 'unclassified';
}

export interface RegistryPairsResult {
  pairs: RegistryPair[];
  /** Registry keys that are not inventory surfaces under the same category. Reported, not hidden. */
  droppedKeys: Array<{ category: string; surface: string }>;
}

export function loadRegistry(path: string): Registry;
export function registryPairs(
  registry: Registry,
  inventory: Inventory,
  options: { skipCategories?: string[] }
): RegistryPairsResult;
```

Behaviour:

1. Group surfaces by `(category, canonical)`; emit every within-group pair, ordered `left < right`
   to match `proposePairs` serialization.
2. Drop any surface absent from `inventory.entries` **under the same category**; collect it in
   `droppedKeys`.
3. Skip categories in `skipCategories`, folded, same as `proposePairs`.
4. **Assign stratum from string evidence, not from the registry.** Re-run the same analyzer cascade
   `proposePairs` uses (confusable → transliteration → identifier → edit similarity ≥ `minSim`). A
   pair that fires keeps that stratum and mechanism. A pair that fires nothing gets
   `stratum: 'c'`, `mechanism: 'registry'`, `sim: <computed>`.

Point 4 is the load-bearing one. `'c'` is **provisional** — the registry cannot distinguish
semantic-known from semantic-novel. The annotator promotes or demotes it in the `stratum` column,
which `fromTsv` already reads.

5. Classify each pair's `relation`, per §2:
   - `part-of` — `Domain`, and one surface is a dot-suffix of the other.
   - `sibling` — `Domain`, same registrable tail, neither a suffix of the other.
   - `instance-of` — one surface is the other plus a trailing version or year token.
   - `unclassified` — everything else, including every genuine coreference merge.

   **This classification is for reporting only and must never influence a label or a suggestion.**
   It is a heuristic: the registrable tail is taken as the last two labels, which is wrong for
   multi-label public suffixes like `co.uk`. No such suffix appears in this corpus, and a
   misclassification changes a number in a table, never a verdict. `registryPairsSummary()` reports
   the breakdown by category and relation — that is what turns "it over-merges" into §2's
   4,551 / 716 / 3,835 / 0.

### 5.2 Provenance

New TSV columns, both round-tripped:

- `source` — `string` | `registry` | `both`
- `canonical` — the registry canonical, empty for `source: string`

`fromTsv` reads `source` when present and defaults to `'string'`, so existing worksheets parse
unchanged. `AdjudicatedPair` gains an optional `source` field.

### 5.3 Worksheet assembly

`bin/gold.ts pairs` gains `--registry <path>`. Without it, behaviour is byte-identical to today.
With it: union of both proposers, deduped on `(category, left, right)`, `source: 'both'` where they
agree, string proposer's stratum/mechanism/sim winning on collision.

Expected on this corpus: **1,624 + 295 = 1,919 rows.**

Exactly one new rule in `PRE_LABEL_RULES`, evaluated **after** the existing rules so that
`differing-digits` keeps priority over anything the registry says:

| rule | condition | suggests | rows here |
|---|---|---|---|
| `registry-conflict` | a registry proposed the merge **and** the winning rule suggests `different` | `review` | 80 |

The condition is "a registry proposed it", not "both proposers did". A registry-only row can still
trip a `different`-suggesting rule — `Windows 10` vs `Windows 10 version 1809` is registry-only and
`differing-digits` rejects it — and that is the same disagreement, so it gets the same treatment.
It splits 39 from `source: both` and 41 from `source: registry`.

The other 71 `source: both` rows keep the rule and verdict they have today — 19 already suggest
`same` (`punctuation-only` 12, `decorated-identifier` 5, `cross-script` 2) and 52 already resolve to
`review` (`none` 36, `one-sided-digits` 16). A rule that re-suggests `same` where an existing rule
already does would change no verdict while destroying the rule attribution `preLabel.ts` exists to
preserve for bulk auditing. Corroboration is carried by the `source` column instead.

`registry-conflict` is the highest-value queue in the worksheet: 80 rows where the two proposers
disagree, containing the `Microsoft Office` and `MS Exchange` version families. Expect most to
confirm `different` — the string rule is usually the correct one here. The 80 glances buy protection
against the case where it is not.

Registry-only rows that no string rule decides become `rule: registry-semantic`, `suggested: review`
— 252 of them. The re-attribution matters: `one-sided-digits` claims `APT44`/`Sandworm` by accident
and offers "a model number narrows a family to a product", which explains nothing about that pair.
Rows the string sweep also proposed keep their own rule, where the attribution is real.

### 5.4 Contamination bookkeeping

- `gold build` propagates `source` to the cluster level: each cluster records the set of sources of
  the pairs that formed it.
- `goldSummary` reports merge clusters broken down by source, and per stratum.
- `gold validate` gains one warning, sibling to the existing empty-(d) warning:

  > every stratum (c)/(d) cluster came from `registry` — no proposer-independent merge in the
  > judgment strata

  It fires exactly when the gold's semantic merges are entirely what the batch arm produced. Clearing
  it requires the MITRE/Wikidata pass or the manual Cyrillic sweep — both of which §4 already
  mandates. The warning makes skipping them visible rather than silent.

### 5.5 Documentation

In `docs/GOLD-TABLE.md`:

- **§5, the decision rule — a new granularity clause.** The rule currently says "Similar type, theme,
  vendor or product line is NOT identity", which covers the `CCR 1016`/`CCR 1036` case but not
  hierarchy. Add, with §2's table as the examples:

  > **Part-of and instance-of are `different`.** A host is not the domain it sits under
  > (`admin.certifiedauth.in` ≠ `certifiedauth.in`), two hosts under one domain are not each other,
  > and a version is not its product (`Microsoft Office 2016` ≠ `Microsoft Office`). Only
  > coreference — two *names* for one *referent* — is `same`. An abbreviation is coreference
  > (`MS Office` = `Microsoft Office`); a narrowing is not.

  Component-vs-product needs a stated call because the corpus contains both readings: `MSHTA` and
  `mshta.exe` are one tool under two names, while `Windows Script Host` covers `cscript.exe` *and*
  `wscript.exe`, which are two. **Rule: merge only when the product has exactly one binary in this
  corpus; otherwise the binary is a component and the pair is `different`.**
- §2, machine/human table: registry proposal is tooling; stratum (c)/(d) *adjudication* stays human.
- §3, step 2: `--registry ../storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json`,
  and the updated pair counts.
- §4 (c)/(d): the registry is added as a proposer alongside MITRE/Wikidata, with the explicit warning
  that its rows include granularity errors (`MS Exchange` vs `Microsoft Exchange Server 2016`,
  `Windows Script Host` vs `cscript.exe`) and that a registry row is not evidence — positive merges
  in (c)/(d) still need the §6 provenance snippet.
- §7, validity safeguards: a new item stating the proposer bias, why manual verification does not
  remove it, and that the composition-by-source table is what quantifies it. This belongs in
  threats-to-validity in the paper.
- §9 checklist: the new warning.

## 6. Testing

Added to `src/Gold/gold.test.ts`:

1. Surfaces absent from the inventory are dropped and reported in `droppedKeys`; a surface present
   under a *different* category is still dropped.
2. `skipCategories` suppresses `Domain` in the registry proposer.
3. Stratum inference: a registry pair with an identifier hit gets `a`/`identifier`; one with nothing
   gets `c`/`registry`.
4. Dedup marks `source: 'both'` and keeps the string proposer's stratum.
5. Rule ordering: a `source: both` pair with differing digits yields `registry-conflict` →
   `review`, never `same`; a `source: both` pair that `punctuation-only` claims keeps
   `rule: punctuation-only` and `suggested: same`.
6. TSV round-trip preserves `source` and `canonical`; a worksheet without those columns parses with
   `source` defaulting to `'string'`.
7. `validate` emits the proposer-independence warning when all (c)/(d) clusters are registry-sourced,
   and not otherwise.
8. `relation` classification: `a.b.com`/`b.com` → `part-of`; `a.b.com`/`c.b.com` → `sibling`;
   `Office 2016`/`Office` → `instance-of`; `Cloudflare`/`CloudFlare Inc.` → `unclassified`. And a
   test asserting `relation` reaches no pre-label rule and no suggestion — the classification is
   reporting-only, and a regression that wired it into labelling would be silent otherwise.

`test/gate.test.ts` is untouched — nothing here is on the pipeline path.

## 7. Risks

| risk | mitigation |
|---|---|
| Annotator anchors on the registry's verdict | Registry-only rows are `review` with no suggestion; the conflict queue is surfaced first |
| Recall bias toward the batch arm | §5.4 warning + composition-by-source reported in the paper |
| Registry drifts from `raw-unified` | Cross-validation reports `droppedKeys`; 0 today, so any non-zero count is new drift |
| Provisional `c` rows left as `c` when they are `d` | `gold validate` already warns on empty (d); the guide instructs demotion with evidence |
| `relation` heuristic misclassifies a public suffix | Reporting-only by construction, asserted by test 8; a wrong row moves a count, never a label |

## 8. Out of scope, but must be recorded: the prompt confound

§2 shows the over-merging traces to one line of `prompts/psi-norm-batch.md` — "group **similar**
entities". That makes it a finding worth reporting: the published baseline's objective is
similarity, so it cannot perform entity resolution, and its errors are systematic rather than noisy.

It also creates the obvious reviewer objection: *you compared a careful method against a lazy
prompt.* The answer is **not** to edit the prompt. `RUNNING-EXPERIMENTS.md` is right that E1 must
score the published artifact, and faithful reproduction is a legitimate claim on its own.

The answer is a third arm: **batch Ψ_norm with an identity-criterion prompt**, holding everything
else fixed. That separates *batch-ness* from *prompt wording*. If batch-with-a-good-prompt still
collapses hierarchy, the failure is structural — no per-decision context, no mint-if-uncertain
option — which is the claim worth making. Without it the result reads as "this prompt is bad", which
is weaker and easier to attack.

This is a separate piece of work: a new prompt, a manifest entry, a run, and a `CONDITION`. It is
recorded here because the §2 finding is what motivates it, and because the composition-by-source
table from §5.4 is where both land in the paper.
