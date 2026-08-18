# Prompts

Every LLM instruction the pipeline sends. Loaded by `src/Normalization/PromptProvider.ts`, hashed
into the run card, and folded into the `runId`.

Before M6 these were inline template literals. A prompt change was therefore invisible to the run
card: two runs could differ in the single most behaviour-determining input and be indistinguishable
afterwards. Extracting them here is what makes `promptHashes` in the `runId` load-bearing — a prompt
can now change with no code change at all, so the git sha no longer covers it.

## Format

Plain text with `{{placeholder}}` variables. `PromptProvider.render()` is strict in both directions:
every placeholder must be supplied and every supplied variable must be used. A missing variable would
otherwise leave a literal `{{knownRelationTypes}}` in the prompt, which the model would silently do
its best with.

`manifest.json` records, per prompt: the source file it was extracted from, the original `${…}`
expression behind each placeholder, its byte length, and its sha256. `PromptProvider.test.ts` checks
the live files against it.

## Editing a prompt

Prompt text is an experimental variable, not an implementation detail.

1. Edit the `.md` file.
2. `npm test` fails — the manifest hash no longer matches. That failure is the feature.
3. Update `sha256` and `bytes` in `manifest.json` deliberately.
4. Every affected `runId` changes, so the new prompt cannot resume an old run's output directory.

For an experiment arm that needs different text (E8 judge swap, prompt-sensitivity measurement),
prefer a *new* prompt id and a `PromptProvider` injected via the processor's `prompts` param — that
keeps the baseline text pinned and the comparison honest.

Listwise variants are selected with `LISTWISE_PROMPT_ID`; `LISTWISE_K` controls how many candidates
that judge sees. Both values are recorded in the decision strategy config and folded into `runId`.

## Provenance

The ten prompts here were lifted mechanically: a script read the exact characters of each template
literal out of the source and replaced `${expr}` with `{{name}}`, so byte-identity with the pre-M6
inline text is guaranteed by construction rather than by careful copying. Each was then diffed against
`git HEAD` with interpolations masked to the same sentinel on both sides; all ten matched exactly.
That check cannot be repeated now that the literals are gone from the source, which is why the
manifest hashes exist.

## The prompts

The streaming matching prompts originated in the wiki prompt library
(`dissert/wiki/notes/prompts.md`). The repository copies are now the executable, hashed source of
truth and have been generalized for domain-neutral entity matching.

| id | used by | variables |
|---|---|---|
| `extract-streaming` | `StreamingExtractor` — per-document extraction (Ψ_link) | `knownCategories`, `knownRelationTypes` |
| `type-judge` | `StreamingExtractor` — emergent-schema category/relation decisions | — |
| `ladder` | `LadderDiscovery` — per-category granularity-ladder bootstrap (g0–g3, ensemble) | `CATEGORY`, `DEFINITION`, `EXAMPLES` |
| `link-judge` | `StreamingNormalizer` — domain-neutral link / mint / defer verdict with rung + parent edge | `docTitle`, `docSnippet`, `mentionsBatch` |
| `listwise-select` | `ListwiseMintCandidateDecision` — baseline numbered choice with explicit NEW ENTITY | — |
| `listwise-select-compact-v1` | `ListwiseMintCandidateDecision` — compact positional-array prompt variant | — |
| `listwise-select-complete-v2` | `ListwiseMintCandidateDecision` — complete named-choice prompt variant | — |
| `listwise-select-balanced-v3` | `ListwiseMintCandidateDecision` — balanced abbreviation/version examples | — |
| `repair-judge` | `StreamingRepairer` — suspect-component adjudication (merge/distinct/rung/renamed/split/move/keep) | `components` |
| `repair-judge-compact-v1` | `StreamingRepairer` — conservative compact repair variant | `components` |
| `pair-rule` | Reserved legacy prompt — role-based graph inference, not used by entity normalization | `knownRelationTypes` |
| `consolidate-merge` | `RegistryConsolidator` — **harness-only**: RQ3 order-robustness batch-reference arm, no longer in the main pipeline | `subject` |
| `country-normalize` | `CountryNameNormalizer` | `countryCodes` |
| `psi-norm-batch` | `DataEntitiesCollector` — **the published Ψ_norm prompt E1 scores** | `entityType` |
| `extract-batch` | `DataExtractor` — batch extraction | — |
| `normalize-target` | `Normalizer` (unreferenced; kept for provenance) | — |
| `normalize-country` | `Normalizer` (unreferenced; kept for provenance) | `countryCodes` |
