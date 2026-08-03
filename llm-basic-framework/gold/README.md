# Gold table working directory

> **2026-08-03:** `silver-pairs.tsv` and `silver.json` moved to `archive/` — they predate the
> registry proposer and the v2 worksheet. The current worksheet is `worksheet.tsv` (string +
> registry proposers); the rest of this README still describes the archived era and will be
> rewritten when the LLM silver-labelling pipeline lands. Do not build against `archive/`.

Machine-generated draft. **`silver.json` is not gold yet** — see "What's missing" below.

Full guide: `../docs/GOLD-TABLE.md`. This file is just what's in this directory and what to do next.

## Files

| file | what it is | edit it? |
|---|---|---|
| `inventory.json` | All 3,360 unique `(category, surface)` pairs from the frozen corpus, with the documents each appears in | **no** — regenerate instead |
| `silver-pairs.tsv` | 1,624 candidate pairs, pre-labelled by rule. **This is your worksheet** | **yes** |
| `silver.json` | The draft table built from `silver-pairs.tsv` | no — rebuild from the TSV |

Regenerate everything:

```bash
npm run gold -- inventory --source ../storage/cert.gov.ua/processed/raw-unified/gpt-5 --out gold/inventory.json
npm run gold -- pairs --inventory gold/inventory.json --skip-categories Domain --out gold/silver-pairs.tsv
npm run gold -- build --inventory gold/inventory.json --pairs gold/silver-pairs.tsv --out gold/silver.json
npm run gold -- validate gold/silver.json --inventory gold/inventory.json
```

Regenerating `pairs` overwrites your labels. Once you start editing, only re-run `build` and
`validate`.

## Your worksheet

Open `silver-pairs.tsv` in a spreadsheet (tab-separated; it contains commas, quotes and apostrophes
inside names, so do not treat it as CSV). Edit **only the `label` column**: `same` or `different`.

The columns are ordered so `label` is first and you never scroll to reach it. `suggested` and `rule`
tell you what the machine thought and why — leave them alone, they let `build` report how many rows
you corrected.

### Where the 1,624 rows went

| rule | suggests | rows | what to do |
|---|---|---|---|
| `differing-digits` | `different` | 1,395 | Spot-check and move on. These are `UAC-0125`/`UAC-0165`, `CVE-2018-8134`/`CVE-2018-8136` — distinct identifiers where digits *are* the identity |
| *(no rule)* | `review` | 177 | **Your real work.** Sorted by similarity in the file |
| `one-sided-digits` | `review` | 30 | e.g. `Netgear` vs `Netgear R7000` — family vs product |
| `punctuation-only` | `same` | 13 | Verify, then accept |
| `decorated-identifier` | `same` | 7 | Verify, then accept |
| `cross-script` | `same` | 2 | Verify, then accept |

**1,417 pre-labelled, 207 need your judgment.** Rows suggested `review` have an empty `label` on
purpose — `review` is not a valid verdict, so an untouched row cannot slip into the table as one.

`npm run gold -- rules` prints the rationale for each rule. Read a rule once, decide whether you
trust it, then accept or reject all of its rows together.

### All 22 `same` suggestions, for a quick eyeball

Cross-script: `India`/`Індія`, `NATO`/`НАТО`.
Decorated: `UAC-0010`/`UAC-0010 (Armageddon)`, `UAC-0057`/`UAC-0057 (GhostWriter)`,
`Служба безпеки України`/`… (СБУ)`, `Національний банк України`/`… (НБУ)` and `… (CSIRT-NBU)`,
`csrss.exe`/`csrss.exe (DoubleZero)`, `Windows Script Host`/`… (wscript.exe)`.
Punctuation: `Agent Tesla`/`AgentTesla`, `Remcos RAT`/`RemcosRAT`, `QUASAR RAT`/`QuasarRAT`,
`RDP Wrapper`/`RDPWrapper`, `October CMS`/`OctoberCMS`, `Remote Utilities`/`RemoteUtilities`,
`Trend Micro`/`Trendmicro`, `UKR.NET`/`Ukrnet`, `NO-IP`/`NoIP`, `Base-Update.exe`/`base_update.exe`,
`DARKCRYSTALRAT (DCRAT)`/`Dark Crystal RAT (DCRAT)`, `@CyberArmyofRussia_Reborn`/`CyberArmyofRussia_Reborn`,
`Держспецзв'язку`/`Держспецзв’язку` (straight vs curly apostrophe).

### Patterns you'll hit in the review queue

- **Ukrainian morphological inflection** — `Департамент кіберполіції…` vs `Департаменту кіберполіції…`,
  `державна організація` vs `державні організації`. Grammatical case and number, same referent. A
  large and systematic share of the queue; decide your policy once and apply it consistently.
- **Genuinely different look-alikes** — `cscript.exe` vs `wscript.exe`, `Cisco IOS XE` vs `IOS XR`.
  Different programs, high similarity.
- **Randomized malware filenames** — `Windows_Security_Update_HxW` / `_gMj` / `_xBQ`. Same campaign,
  different artifacts. Decide whether your unit of identity is the file or the campaign, and say so
  in the paper.
- **Decoration at similarity 1.0** — `PowerShell (powershell.exe)` vs `powershell.exe`.

## What's missing — why this is silver, not gold

1. **No stratum (c).** Zero-string-overlap aliases (`APT28` = `Fancy Bear` = `Sofacy`). No string
   mechanism can propose these. Take them from MITRE ATT&CK and Wikidata alias tables — authoritative
   and citable, which beats annotating. Watch the `aliases` vs `x_mitre_aliases` field distinction.
2. **No stratum (d).** The novel tail: post-cutoff `UAC-####` designations and deliberately held-out
   canonicals. `validate` warns about this, and it is the warning that matters most — without (d),
   any positive result is refutable with "the model knows this from Wikipedia".
3. **No evidence.** `clustersWithEvidence: 0`. Every positive merge in (c)/(d) needs a provenance
   snippet or URL. Under a single-annotator protocol this is what carries validity instead of κ.
4. **207 pairs unadjudicated.** `build` counts these as not-merged, which understates recall.
5. **Only 2 cross-script pairs, and that needs checking.** 297 surfaces in the inventory contain
   Cyrillic. The count is low because extraction already rendered most names in English — sweep those
   297 by hand for English counterparts, and if the number stays low, report that as a finding about
   upstream normalization rather than a gap.
6. **`Domain` excluded** — 1,929 of 3,360 surfaces. Deliberate, per the guide, but the paper must
   describe the sampling. The 73 queries retrieving several candidates at similarity exactly 1.0
   (the `accounts-ukr.net` typosquat family) are the interesting part if you sample any of it.

## Current draft numbers

3,338 clusters — 21 mergeable, 3,317 singletons (the gold mints), 4,069 derived NIL labels, split
667 dev / 2,671 test with mergeable clusters on both sides. 100% inventory coverage.

Do not report anything from this file until items 1–4 are done.
