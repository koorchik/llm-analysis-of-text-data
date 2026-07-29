# Registry as a second pair proposer for the gold table

**Status:** approved, not implemented
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
| keys that are inventory surfaces under the same category | 3,360 |
| keys dropped by cross-validation | 32 |
| multi-surface clusters | 280 |
| implied pairs, both surfaces in inventory | 4,956 |
| …of which `Domain` | 4,551 |
| non-`Domain` pairs | 405 |
| non-`Domain` pairs also proposed by the string mechanisms | 110 |
| non-`Domain` pairs the string mechanisms never propose | **295** |

The 32 dropped keys are version drift between the registry and the current `raw-unified` snapshot
(`CloudFlare`, `Ukr.Net`, `UNC1151`, `OutSteel`, `CaddyWiper`, `rclone`, and `TOR` filed under
`Software` where the inventory has it elsewhere). Cross-validation finds them; without it they would
silently produce pairs naming surfaces the corpus does not contain, which `gold build` drops in
silence.

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

### What it gets wrong

The registry over-merges, in two systematic ways that would corrupt the gold if trusted:

- **Granularity collapse.** `Domain` folds every hostname into its registrable domain —
  `certifiedauth.in` absorbs 60 surfaces including `accounts.google2.certifiedauth.in` and
  `admin.certifiedauth.in`. In `Software`, `Microsoft Office` absorbs 2007/2010/2013/2016/2019 plus
  `MS Office` (11 surfaces), and `MS Exchange` merges with `Microsoft Exchange Server 2010` through
  `2019`. This directly contradicts the `differing-digits` pre-label rule, which §4 identifies as
  the largest source of false merges.
- **Distinct components under one product.** `Windows Script Host` merges with both `cscript.exe`
  and `wscript.exe`, which are different binaries.

So: the registry proposes, the annotator disposes. Same contract the string proposer already has.

## 3. The contamination problem

`npm run evaluate -- --batch <entities.json>` scores the batch Ψ_norm arm against this exact file.
The registry is the output of a system under test.

Manual verification fixes **precision** — the annotator deletes bad merges. It cannot fix
**recall**: a merge the batch arm missed can only reach the gold via the string mechanisms or an
external authority. Left unaddressed this inflates the batch arm's recall relative to the streaming
arm, asymmetrically.

This is a reason to record and measure the bias, not to reject the source. The mitigation is §5.4.

## 4. Non-goals

- **`Domain` stays excluded.** The registry proposes 4,551 `Domain` pairs; including them would make
  `Domain` 74% of the worksheet, and almost all of them are the subdomain collapse described above.
  `--skip-categories` applies to both proposers. §8 of `GOLD-TABLE.md` is unchanged.
- **No auto-`same` from the registry alone.** No registry-only pair is ever pre-labelled positive.
- **No second-model registry.** `processed/incremental/gpt-5.4-nano` exists and is same-family, so it
  buys weak independence. Out of scope.

## 5. Design

### 5.1 `src/Gold/registryPairs.ts`

```ts
export interface RegistryPair extends ProposedPair {
  /** The canonical both surfaces were mapped to. Context for the annotator, never evidence. */
  canonical: string;
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
| `registry-conflict` | `source: both` and the winning rule suggests `different` | `review` | 39 |

That is the whole intervention on the overlap. The other 71 `source: both` rows keep the rule and
verdict they have today — 19 already suggest `same` (`punctuation-only` 12, `decorated-identifier`
5, `cross-script` 2) and 52 already resolve to `review` (`none` 36, `one-sided-digits` 16). A rule
that re-suggests `same` where an existing rule already does would change no verdict while destroying
the rule attribution `preLabel.ts` exists to preserve for bulk auditing. Corroboration is carried by
the `source` column instead.

`registry-conflict` is the highest-value queue in the worksheet: 39 rows where two independent
proposers disagree, containing the `Microsoft Office` version family. Expect most to confirm
`different` — the string rule is usually the correct one here. The 39 glances buy protection against
the case where it is not.

All 295 registry-only rows are `suggested: review`, `rule: registry-semantic`.

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

`test/gate.test.ts` is untouched — nothing here is on the pipeline path.

## 7. Risks

| risk | mitigation |
|---|---|
| Annotator anchors on the registry's verdict | Registry-only rows are `review` with no suggestion; the conflict queue is surfaced first |
| Recall bias toward the batch arm | §5.4 warning + composition-by-source reported in the paper |
| Registry drifts from `raw-unified` | Cross-validation reports `droppedKeys`; 32 today |
| Provisional `c` rows left as `c` when they are `d` | `gold validate` already warns on empty (d); the guide instructs demotion with evidence |
