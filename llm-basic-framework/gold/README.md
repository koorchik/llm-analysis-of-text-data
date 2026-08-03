# Gold table working directory

Machine-generated silver, awaiting your adjudication. **Nothing here is gold until you have
reviewed it** — see "What's missing" below and `../docs/GOLD-TABLE.md` (including the
2026-08-03 amendment: gold-by-projection, the embedding proposer, ensemble silver labelling).

## Files

| file | what it is | edit it? |
|---|---|---|
| `inventory.json` | All 3,360 unique `(category, surface)` pairs from the frozen corpus, with the documents each appears in | **no** — regenerate instead |
| `worksheet.tsv` | 3,446 candidate pairs from three proposers, LLM-ensemble-annotated, sorted by review queue. **This is your worksheet** | **yes** |
| `pairs-meta.json` | How the worksheet was proposed: proposer settings, thresholds, composition by source | no — regenerated with `pairs` |
| `llm-annotations/*.jsonl` | Per-model verdict caches = the annotation audit trail. Committed on purpose (no sampling lever on the Anthropic backend — reproducibility is by artifact) | **no** |
| `embeddings-cache/` | Vector cache (gitignored, ~83 MB, reproducible from the API) | no |
| `archive/` | The pre-registry era (`silver-pairs.tsv`, `silver.json`). Do not build against it | no |

## The pipeline

```bash
# 1. Annotation universe (mechanical, ~1s)
npm run gold -- inventory --source ../storage/cert.gov.ua/processed/raw-unified/gpt-5 --out gold/inventory.json

# 2. Propose pairs: string + registry + embeddings, with document snippets
npm run gold -- pairs --inventory gold/inventory.json \
  --skip-categories Domain \
  --registry ../storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json \
  --embeddings --emb-min-cos 0.6 --emb-xscript-min-cos 0.4 \
  --docs ../storage/cert.gov.ua/fetched \
  --out gold/worksheet.tsv

# 3. Two-model ensemble silver labels + review queue (LLM calls; resumable via the JSONL caches)
npm run gold -- llm-annotate --worksheet gold/worksheet.tsv --inventory gold/inventory.json \
  --docs ../storage/cert.gov.ua/fetched

# 4. ——— YOU REVIEW gold/worksheet.tsv HERE ——— (top-down by the queue column)

# 5. Close into clusters + edges, singletons, NIL labels, split
npm run gold -- build --inventory gold/inventory.json --pairs gold/worksheet.tsv --out gold/gold.json

# 6. Check it before trusting it
npm run gold -- validate gold/gold.json --inventory gold/inventory.json
```

**Regenerating `pairs` after adjudication starts would DESTROY your labels.** Once you have
touched a single row, proposer changes must go through a merge, never a regeneration. The
`llm-annotate` step is safe to re-run: it never overwrites a human label (a label that deviates
from the suggestion/ensemble is final), and cached verdicts make re-runs free.

## Your review, in queue order

The worksheet is pre-sorted by the `queue` column. Edit `label` (and `relation` + `direction`
for `rung`/`rename`); everything else is context.

| queue | what it is | what to do |
|---|---|---|
| 1 | the two models disagree, or an ensemble verdict contradicts a pre-label rule | **Start here.** Highest-information rows; decide each one |
| 2 | at least one model answered `unsure` | Decide each one; the snippet column holds the same context the models saw |
| 3 | both models agree on a positive (`same`/`rung`/`rename`), label prefilled | Confirm each one — a wrong `same` corrupts a cluster through transitive closure |
| 4 | both models agree `different`, label prefilled | Skim |
| 5 | rule-labelled bulk (`differing-digits`, incl. its spot-check sample) | Spot-check result is in the run summary; move on |

Labels: `same` · `different` · `rung` (+ `relation` `isa`/`part-of`, `direction` = finer side) ·
`rename` (+ `direction` = older side). `UAC-0002`/`Sandworm` is the canonical `rung part-of`
case — a hard non-merge plus a connecting edge, per the SKEIN v2 deck.

On registry/embedding rows also correct `stratum` — it arrives as a provisional `c`.

`npm run gold -- rules` explains every pre-labelling rule.

## What's missing — why this is silver, not gold

1. **No authority stratum (c).** Zero-overlap aliases still need MITRE ATT&CK / Wikidata tables
   (authoritative and citable; mind `aliases` vs `x_mitre_aliases`). The embedding proposer does
   NOT close this gap — on bare names it scores known aliases low (measured: `APT44`/`Sandworm`
   ≈ 0.15) and its semantic rows still need your judgment.
2. **No stratum (d).** Post-cutoff designations and held-out canonicals. `validate` warns; without
   (d), any positive result is refutable as "the model knows this from Wikipedia".
3. **Human review not done.** Ensemble agreement is triage, not truth — both model families are
   systems under test. Nothing is reportable until queues 1–3 are reviewed.
4. **Cross-annotator check open.** §7.1's independent-family LLM cross-annotation (Gemini via the
   existing VertexAi backend) has not been run.

Do not report anything from this directory until 1–3 are done.
