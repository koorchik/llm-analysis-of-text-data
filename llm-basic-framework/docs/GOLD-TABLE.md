# Building the gold table — what's expected from you

The gold table is the reference every number in the paper is measured against. Nothing downstream
can run without it: `bin/evaluate.ts` and the whole metric suite are written and tested, but until
this table exists there is nothing to score. It is the long pole.

This document is the annotation guideline the protocol requires you to write down *before*
annotating. Read §2 first — it tells you exactly which parts are yours and which the tooling does.

---

## 1. What you are producing

A file, `gold-aliases-v1`, that says:

1. **Which surface forms denote the same real-world entity** — grouped into clusters, per category.
2. **Which mention occurrences are new entities at the point they appear** — the NIL labels.
3. **How hard each merge was** — the stratum, so capability is attributed rather than averaged.
4. **Which clusters may be tuned on and which may only be reported** — the dev/test split.

Point 3 is what makes this a contribution rather than infrastructure. Reporting one averaged number
hides that a system solves easy string variants and fails on semantics — the exact flaw in the
published paper this work is correcting.

---

## 2. Your part vs the machine's part

| Stage | Who | Why |
|---|---|---|
| Export the mention inventory | **tooling** | Mechanical. Hand-curation silently drops the rare surfaces stratum (d) is made of |
| Propose candidate pairs, strata (a)/(b) | **tooling** | Deterministic pre-labelling; you verify the residue |
| Propose (c)/(d) *candidates* from the registry | **tooling** | `--registry`. It finds zero-overlap pairs, and it over-merges — every row arrives as `review`. §4 |
| Find the rest of strata (c)/(d) | **you** | The registry is not independent of the systems under test. §4, §7 |
| **Decide `same` / `different` on every pair** | **you** | This is the annotation. Everything else is bookkeeping |
| Attach evidence to positive merges | **you** | §6 — this is what makes single-annotator gold defensible |
| Close pairs under transitivity | **tooling** | Closure by eye misses chains |
| Add singletons as gold mints | **tooling** | 2,411 of 2,673 canonicals are singletons; omitting them breaks scoring |
| Derive NIL labels | **tooling** | ~4,000 rows on this corpus. Hand-labelling would introduce the prefix errors the schema exists to prevent |
| Assign dev/test split | **tooling** | Must be per-cluster, not per-mention, or aliases leak across the split |
| Validate | **tooling** | §9 |

**Your actual work is the middle rows: adjudicating pairs, sourcing (c)/(d), and writing evidence.**
On this corpus that is 1,919 proposed pairs — 539 of which no rule decides — plus the (c)/(d)
sourcing the registry cannot supply. Budget 2–4 weeks.

---

## 3. The workflow

```bash
cd llm-basic-framework

# 1. Export the annotation universe (3,360 surfaces, ~1s)
npm run gold -- inventory \
  --source ../storage/cert.gov.ua/processed/raw-unified/gpt-5 \
  --out gold/inventory.json

# 2. Propose candidate pairs (~1s)
npm run gold -- pairs --inventory gold/inventory.json \
  --skip-categories Domain \
  --registry ../storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json \
  --out gold/worksheet.tsv

# 3. ——— YOU ADJUDICATE gold/worksheet.tsv HERE ——— (see §5)
#    Also add your stratum (c) and (d) rows (see §4)

# 4. Close into clusters, add singletons, derive NIL labels, assign the split
npm run gold -- build --inventory gold/inventory.json \
  --pairs gold/worksheet.tsv --out gold/gold.json

# 5. Check it before trusting it
npm run gold -- validate gold/gold.json --inventory gold/inventory.json

# 6. Then, and only then
npm run evaluate -- --gold gold/gold.json --split test --run <runDir>
```

Steps 1, 2, 4 and 5 are free, offline and re-runnable. Re-run step 4 as often as you like while
annotating — the cluster ids and the split are derived deterministically, so adding pairs does not
reshuffle what was already assigned.

### What step 2 gives you on this corpus

**1,919 pairs**, `Domain` excluded — 1,624 from the string mechanisms and 295 more that only the
registry proposes. Silver pre-labels:

| rule | suggests | pairs |
|---|---|---|
| `differing-digits` | different | 1,356 |
| `registry-semantic` | review | 252 |
| `none` | review | 177 |
| `registry-conflict` | review | 80 |
| `one-sided-digits` | review | 30 |
| `punctuation-only` | same | 13 |
| `decorated-identifier` | same | 9 |
| `cross-script` | same | 2 |

1,380 arrive pre-labelled; **539 need your judgment**. Run `npm run gold -- rules` to read the
rationale for each before bulk-accepting any of them.

Where the pairs come from: 1,514 string-only, 110 both proposers, 295 registry-only. The `source`
column records this per row, and it is not bookkeeping — see §7.4.

**Two cross-script pairs is not a bug — but it is a finding you should check.** The pairs found are
`India`/`Індія` and `NATO`/`НАТО`, both at string similarity **0**. The count is low because the
extraction stage already rendered most names in English; the raw reports contain far more
Ukrainian/English variation than the extracted inventory does. Before accepting it, sweep the 297
Cyrillic surfaces in the inventory by hand for English counterparts the analyzers missed — and note
in the paper that stratum (b) is thin *because of upstream normalization*, which is itself a result.

---

## 4. The four strata

Report them separately. Never average them — that is the flaw being corrected.

### (a) surface — high string similarity
Typos, spacing, punctuation, decoration. `UAC-0010` vs `UAC-0010 (Armageddon)`.
**Source: tooling proposes these.** Your job is verification.

Watch out: high similarity is mostly *not* identity here. The highest-similarity proposals in this
corpus are `MikroTik CCR 1016` vs `CCR 1036` (0.94) and `Netgear R7000` vs `R8000` (0.92) — different
products. Expect to mark most stratum-(a) proposals `different`. That is the correct outcome and it
is precisely what makes the threshold baselines fail.

### (b) cross-script — transliteration and homoglyphs
**Two distinct mechanisms. Do not conflate them:**

- **Transliteration** — a name written in Cyrillic and in Latin: `СБУ`/`SBU`, `Індія`/`India`.
- **Homoglyphs (Unicode confusables)** — Latin-looking text made of Cyrillic characters: `АРТ28` vs
  `APT28`, where `А`, `Р`, `Т` are Cyrillic.

The research note's own example mis-attributes this: it presents `АРТ28`/`APT28` as transliteration.
It is not. Cyrillic `Р` is ER, so a transliterator maps `АРТ28` to `art28`, never `apt28`. Only the
confusable-skeleton mechanism finds that pair. Putting it in the wrong bucket mis-attributes the
channel in E4, so classify by *which mechanism explains the pair*, not by "it looks foreign".

**Source: tooling proposes these, plus your manual sweep of the 297 Cyrillic surfaces.**

### (c) semantic-known — the memorized head
Zero string overlap, and in every public knowledge base: `APT28` = `Fancy Bear` = `Sofacy` =
`STRONTIUM`.

**Source: take these from an authority, do not annotate them.** MITRE ATT&CK group and software
alias tables, and Wikidata. Authoritative gold is *stronger* than single-expert gold, not merely
cheaper, and it is citable.

One trap to know: in MITRE ATT&CK's STIX data, `aliases` and `x_mitre_aliases` are different fields
with different semantics. Check which one you are reading.

**Also proposed by `--registry`, which is a candidate source and not an authority.** The 295
registry-only rows arrive as `rule: registry-semantic`, `suggested: review`, `stratum: c`
*provisionally*. They contain the pairs no string mechanism can reach —

```
HackerGroup:  APT44 <> Sandworm          HackerGroup:  UAC-0114 <> Winter Vivern
HackerGroup:  GhostWriter <> unc1151     Software:     CVE-2021-44228 <> Log4Shell
Organization: ЄС <> Європейський Союз    HackerGroup:  @frwl_team <> FRwL
```

— and, mixed in among them, granularity errors: `MS Exchange` vs `Microsoft Exchange Server 2016`,
`Windows Script Host` vs `cscript.exe`, `Remote Utilities` vs `rutserv.exe`. **Read every one. Never
bulk-accept this rule.** For each row you keep: decide `c` or `d` by whether it is in a public
knowledge base, and attach the §6 evidence — a registry row is not evidence of anything.

### (d) semantic-novel — the novel tail
Zero string overlap and **not** in the training data: recent `UAC-####` designations, post-cutoff
aliases, plus deliberately held-out registry canonicals whose mentions become gold mints.

**Source: you, from CERT-UA's own reporting and post-cutoff sources.**

**This stratum is the one that cannot be skipped.** Without it, every positive result is refutable
in one review sentence — "the model knows this from Wikipedia". `gold validate` warns when it is
empty, and that warning is the single most important thing the validator says.

---

## 5. How to adjudicate

Open `gold/worksheet.tsv` in a spreadsheet. One row per pair, `label` first because it is the only
column you must edit:

| label | suggested | rule | source | category | left | right | stratum | mechanism | sim | canonical | evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | review | registry-semantic | registry | HackerGroup | APT44 | Sandworm | c | registry | 0 | Sandworm | |
| different | different | differing-digits | string | Device | Netgear R7000 | Netgear R8000 | a | edit-similarity | 0.9231 | | |

Set `label` to `same` or `different`. That is the whole task. Rows whose suggestion is `review`
arrive with `label` empty on purpose — `review` is not a valid label, so an untouched row cannot
slip through as a verdict.

Three columns are context, not instructions. `rule` names the mechanism that produced the
suggestion — audit it once with `npm run gold -- rules`, then accept or reject all of its rows
together. `source` names the proposer (§7.4). `canonical` is what a registry mapped both surfaces
to; it tells you *why* the row exists and is never evidence that the merge is right.

On registry rows you may also need to correct `stratum` — it arrives as a provisional `c`.

### The decision rule

**Same** means: these two surfaces denote **the same real-world entity**.

Link only on evidence of identity:
- shared naming that is not coincidental,
- an alias stated in the report itself ("УАЦ-0010 (Armageddon)"),
- an unambiguous abbreviation,
- an authoritative alias table.

**Similar type, theme, vendor or product line is NOT identity.** `MikroTik CCR 1016` and
`MikroTik CCR 1036` are the same vendor and the same product line and are different devices.

#### Part-of and instance-of are `different`

Entity resolution asks whether two names denote the **same referent**. It does not ask whether two
things are related. Only **coreference** — two *names* for one *referent* — is `same`.

| pair | relation | verdict |
|---|---|---|
| `CloudFlare` / `Cloudflare Inc.` | coreference | `same` |
| `MS Office` / `Microsoft Office` | coreference (abbreviation) | `same` |
| `Microsoft Office 2016` / `Microsoft Office` | instance-of — a version *of* a product | `different` |
| `admin.certifiedauth.in` / `certifiedauth.in` | part-of — a host *under* a domain | `different` |
| `admin.certifiedauth.in` / `analytics.certifiedauth.in` | siblings — co-located, distinct | `different` |

An abbreviation is coreference; a **narrowing** is not.

**Component vs product** needs a stated call, because this corpus contains both readings: `MSHTA`
and `mshta.exe` are one tool under two names, while `Windows Script Host` covers `cscript.exe` *and*
`wscript.exe`, which are two. **Rule: merge only when the product has exactly one binary in this
corpus; otherwise the binary is a component and the pair is `different`.** That makes `curl`/
`curl.exe` `same`, and `Remote Utilities`/`rutserv.exe` `different` — it has `rfusclient.exe` too.

Why this asymmetry rather than a coarser granularity: coarse is derivable from fine — roll hostnames
up with a public-suffix list, strip version tokens — but fine is not recoverable from coarse. A
gold table at coreference granularity can be rolled up later; one that already collapsed hierarchy
cannot be taken apart. Roll-up is a separate, reported operation, never baked into the reference.

**When genuinely uncertain, mark `different`.** This asymmetry is deliberate and matches the
system's own mint-if-uncertain design: a missed merge is a recall error you can see, a wrong merge
corrupts a cluster and propagates. Do not split the difference — there is no "maybe" label, and a
guessed `same` is worse than a considered `different`.

### Adding (c)/(d) rows

Append rows to the same file in the same shape, with `stratum` set to `"c"` or `"d"`:

```json
{ "category": "HackerGroup", "left": "APT28", "right": "Fancy Bear",
  "stratum": "c", "label": "same",
  "evidence": "MITRE ATT&CK G0007 aliases: https://attack.mitre.org/groups/G0007/" }
```

Both surfaces must already exist in the inventory — a pair naming a surface the corpus never
contained is silently dropped, because there is nothing to score it against.

---

## 6. Evidence

**Every positive merge in strata (c) and (d) carries a provenance snippet.** Either the report's own
"also known as" phrasing, or a URL to an authoritative page.

This is not bureaucracy. The protocol accepts a single annotator with no second-annotator κ, so
validity has to come from somewhere else: evidence, authority and auditability. Evidence-grounded
gold that a reader can check beats unauditable double-annotated gold. `goldSummary` reports
`clustersWithEvidence`, and a reviewer will look at it.

Strata (a)/(b) are near-mechanical and do not need per-pair evidence.

---

## 7. Validity safeguards

Single-annotator design, so these are what stand in for inter-annotator agreement. State the design
in threats-to-validity.

1. **LLM cross-annotator.** Have a model from a **different family than every system under test**
   independently label the judgment strata. Report agreement per stratum. You adjudicate every
   disagreement with a written rationale. Treat it as a check, never as truth — LLM judges disagree
   with humans at material rates and with systematic bias.
2. **Test–retest.** Re-annotate a random 10% sample after **at least two weeks**. Report
   intra-annotator agreement.
3. **If agreement is poor anywhere, fix the guideline and re-annotate — never adjust individual
   labels to improve the number.**
4. **Proposer independence.** `--registry` reads `entities-unified/gpt-5/entities.json` — the batch
   Ψ_norm arm's own output, and the same file `evaluate --batch` scores. Your verification deletes
   its false merges, so **precision is safe**; nothing you do at the worksheet can add a merge it
   never proposed, so **recall is not**. Left alone, that inflates the batch arm's merge recall
   relative to the streaming arm.

   This is why every row carries `source`. `gold validate` prints mergeable clusters by proposer and
   warns when *every* stratum (c)/(d) cluster is registry-sourced. Clearing that warning means doing
   the MITRE/Wikidata pass or the Cyrillic sweep — the proposer-independent sources §4 already
   requires. **Report the composition-by-source table in threats-to-validity**, and state that the
   registry was a candidate generator, never a label.

   A related confound to pre-empt: `prompts/psi-norm-batch.md` asks the model to "group **similar**
   entities together" — similarity, not identity — which is why it collapses hierarchy so
   systematically. That is a finding, but it also invites "you compared against a lazy prompt".
   Do not edit the published prompt; E1 must score the published artifact. Answer it with a third
   arm instead: batch Ψ_norm under an identity-criterion prompt, everything else held fixed.
5. **Log your hours.** The HITL cost is a reported result, not overhead.

---

## 8. Two decisions to record in the paper

**Domain sampling.** `Domain` is 1,929 of 3,360 surfaces (57%) and is dominated by trivially
distinct hostnames. Exhaustively pairing it would swamp the annotation for almost no signal, so
`--skip-categories Domain` excludes it. If you sample it instead, describe the sampling method in
the paper — an unexplained exclusion looks like cherry-picking.

Worth knowing before you decide: 73 queries in this corpus retrieve more than one candidate at
similarity exactly 1.0, mostly the `accounts-ukr.net` family — plausible typosquats. Those are
genuinely interesting and genuinely hard. A small deliberate `Domain` sample aimed at them is worth
more than a large random one.

The registry strengthens that case rather than weakening it. It proposes 4,551 `Domain` merges, and
classified mechanically **every one is hierarchy: 716 part-of and 3,835 sibling, zero coreference**.
Under `ssl2.site` it collapses `docs.google.com.ssl2.site` and `docs.googie.com.ssl2.site` into one
entity — deleting the exact homoglyph substitution that makes the category worth sampling. So
`--skip-categories Domain` applies to both proposers, and a hand-picked sample remains the only
sensible way in.

**Freeze before tuning.** Split ~20/80 dev/test, then freeze and version the table. Dev is for
prompt and configuration tuning; test is for reported results only. **No experiment may tune on
test.** `bin/evaluate.ts` defaults to `--split test` and requires `--allow-dev` to report dev
numbers, so the discipline is enforced rather than remembered.

---

## 9. Before you report anything

```bash
npm run gold -- validate gold/gold.json --inventory gold/inventory.json
```

Checklist:

- [ ] `VALID` — the schema loader is strict on purpose; a malformed table would produce a plausible
      wrong score rather than an error.
- [ ] **No stratum-(d) warning.** If it fires, the paper's second claim is unmeasurable.
- [ ] **No transitivity conflicts** from `gold build`. A conflict means the annotation contradicts
      itself: a–b and b–c are `same`, so a–c is too, whatever you marked it.
- [ ] **No unlabelled pairs** warning. Unlabelled counts as not-merged and would understate recall.
- [ ] **No proposer-independence warning.** If every (c)/(d) cluster came from the registry, the
      batch arm is being scored against its own output and the comparison is not fair. §7.4.
- [ ] **Coverage is 100%.** An uncovered surface is scored by nothing and silently shrinks the
      evaluation.
- [ ] **Both splits have mergeable clusters.** A split with none gives empty merge P/R.
- [ ] `inputContentHash` matches the corpus you will actually run against — pass `--inventory` and
      the validator checks this for you, and exits non-zero on a mismatch.
- [ ] `order` matches the order runs use. Today that is `numeric-id`; `chronological` and
      `seededShuffle` are M7 and do not exist yet, so a table claiming one cannot be matched by any
      run you can currently produce.

---

## 10. The schema

You should not need to write this by hand — `gold build` emits it — but this is what it is.

```json
{
  "version": "gold-aliases-v1",
  "inputContentHash": "37d57e47...",
  "order": "numeric-id",
  "clusters": [
    { "id": "g1", "category": "HackerGroup",
      "members": ["APT28", "Fancy Bear", "АРТ28"],
      "stratum": "b", "split": "test",
      "sources": ["registry", "string"],
      "evidence": [{ "pair": ["APT28", "Fancy Bear"], "snippet": "...",
                     "annotator": "expert", "source": "https://attack.mitre.org/groups/G0007/" }] }
  ],
  "nilLabels": [
    { "docId": 16, "category": "Organization", "mention": "Adobe", "label": "NIL",   "clusterId": "g5" },
    { "docId": 23, "category": "Organization", "mention": "Adobe", "label": "known", "clusterId": "g5" }
  ]
}
```

Two properties the loader enforces rather than assumes:

1. **`nilLabels` is a position-indexed array, and a flat `{mention: label}` map is rejected
   outright.** Look at the two `Adobe` rows: same mention, same category, different answers,
   because NIL is a property of (mention, stream position). `Adobe` is new at document 16 and known
   at document 23. A flat map cannot hold both and would mis-score the entire mint side.
2. **`order` is required.** NIL labels are only valid for the stream order they were derived under.
   Replay under a different order and they must be regenerated, not reused.

Also enforced: cluster ids unique, `members` non-empty, `stratum` present (strata are reported
separately, never averaged), `split` exactly `dev` or `test`, and **no surface in two clusters** —
that would be a contradiction in the gold itself.

`sources` is provenance, not annotation: which proposers surfaced the pairs that formed the cluster.
The verdicts are yours either way. It is recorded because one proposer is a system under test — §7.4.

`members` are **surface forms**, not canonical names — the thing the corpus actually contains.

---

## 11. If you want to do it entirely by hand

Nothing forces you through the tooling. Write a `gold-aliases-v1` JSON yourself and
`npm run gold -- validate` it. But derive the NIL labels programmatically even so — ~4,000
position-dependent rows is not a hand-editing task, and
`deriveNilLabels(clusters, inventory)` in `src/Gold/buildTable.ts` will do it from your clusters.
