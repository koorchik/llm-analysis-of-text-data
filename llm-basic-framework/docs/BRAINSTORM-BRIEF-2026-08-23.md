# Brainstorming brief: reliable SKOS hierarchy extraction with a small local LLM judge in a streaming entity-resolution pipeline

This is a standalone description of an engineering/research challenge. You have no other context;
everything needed is in this document. We want ideas — prompt designs, output formats, decoding
strategies, architectural mechanisms — for the open questions in §8.

## 1. The system

We process a never-ending stream of cybersecurity incident reports (Ukrainian CERT-UA corpus).
Each document yields entity mentions (mostly category "Software": products, malware, file names).
A streaming pipeline maintains a persistent concept registry:

- **Identity**: each mention either links to an existing concept (alias) or mints a new one.
- **Hierarchy**: concepts carry typed SKOS/ISO-25964 `broader` edges — broaderGeneric (kind-of),
  broaderPartitive (part-of), broaderInstantial (version/instance-of). The graph is a DAG
  (multi-parent allowed, acyclicity enforced on write).

Per document, ONE LLM "judge" call decides both questions for all unresolved mentions at once
(a "ballot"). Candidates ("options") per mention come from a retrieval blocker (embeddings +
string similarity, top-K, K≈4-10 shown). Constraints that must hold:

- Streaming-native: no batch passes, no growth counters, no end-of-stream steps. The stream never
  ends. Per-document cost must stay bounded (a few LLM calls).
- Identity quality is sacred: pairwise identity F1 is 1.000 in all good configurations and must
  not degrade.
- Two judges: **gemini-3.7-flash** (cloud, fast, obedient — near-ceiling) and
  **gemma4:12b-64k** (local via ollama, the focus of this brief).

## 2. The ballot format (what the judge sees)

System instructions = the prompt in §6. User text (real example, abridged):

```
Source: "Agent Tesla (malware)" — evidence: <first 600 chars of the document>
Entities:
E1. MS Excel
E2. Internet Explorer
...
E47. Chromium Browser
...
E85. Agent Tesla
Mentions:
M5. "Google Chrome" (Software) — options: E7, E15, E22, E1
M14. "Torch Browser" (Software) — options: E44, E48, E9, E4
... (up to ~74 mention rows)
```

The E-list is the union of every mention's retrieved candidates plus the document's own unresolved
mentions. Options per row are identity-retrieval only. Expected output: one raw JSON object,
`{"v":[{"m":"M1","id":"E3"|"NEW","g":<gloss>,"p":<E-number|null>,"r":"v|n|p|b"|null}, ...]}` —
`id` = identity verdict, `g` = 12-word gloss, `p`+`r` = this mention's ONE broader relation
(`b` reverses direction: the mention is broader than the listed entity).

## 3. What we established experimentally (gemini flash reference)

- **Row-composition law**: the judge asserts hierarchy parents that appear in the mention's own
  options row and, on large ballots, practically nowhere else — regardless of prompt instructions
  that explicitly allow choosing any E-number. Retrieval composition, not prompt wording, decides
  recall.
- Mechanisms that exploit this now exist and are validated on flash (reachable edge recall ≈ .78-.86,
  precision .87-.93, identity 1.000, any document order): re-ask a parentless concept whenever a
  later document re-mentions it; carry the previous document's parentless mints onto the next
  ballot once; and best of all "reask-now" — after a document's mints land, run one extra
  review-shaped call for its parentless mints (rows with the concept's own name excluded from its
  options, options re-retrieved against the now-updated registry, no source text, header
  `Source: "registry review at N canonicals"`).

## 4. The local judge's measured pathologies (gemma4:12b-64k)

1. **Bimodal "mode coin"**: on a family-heavy ballot (30 browser mentions incl. their base
   "Chromium Browser"), a response either asserts the family nearly completely (~26/27 parents)
   or asserts zero — nothing in between. Heads rate ≈ 1/3. No prompt wording changed the rate
   (explicit "every other mention is a candidate parent; checking the full list is mandatory"
   was tested: same rate). The winning samples visibly use the gloss: they first write
   "a Chromium-based web browser" as `g`, then copy the answer into `p`. The losing samples write
   the same gloss and still answer `p:null`.
2. **Temperature**: greedy decoding (T=0) loops its hidden thinking to the 64k context cap and
   returns EMPTY content (finish=length). Must run at default temperature → sampling variance.
3. **Context window**: forcing num_ctx to 96k (model tag tuned for 64k) makes it lazy — blanket
   `g:null,p:null` answers. Bigger context hurts.
4. **Frame sensitivity**: identical knowledge questions are answered in a source-free
   "registry review" call and refused inside a document-framed ballot (e.g., MS Word → MS Office
   asserted in every review-framed row, never in doc-framed rows).
5. **Identity fragility**: injecting embedding-near co-mentions into the identity options row
   destroyed written-form alias linking (pairwise F1 1.000 → .500). Identity rows must stay pure.
6. **Knowledge limits**: it knows only the famous Chromium forks (Chrome, Brave, Vivaldi, Opera)
   — ~4 of 25. Flash knows ~25/25. A mechanism cannot conjure missing knowledge, but eliciting
   MORE of what it does know is in scope.
7. Current mitigation: JUDGE_SAMPLES=N — call the same ballot N times, union the hierarchy halves
   (identity from first sample). Works because heads-samples are near-perfect precision.

## 5. The late-parent multi-child problem

Documents arrive in any order. When the BROADER concept arrives after its children already exist
in the registry (e.g. "Chromium Browser" arrives; 25 parentless browser forks are waiting), the
current dialect caps the yield: one ballot row can assert only ONE relation (`p` + `r:"b"`), so
one arriving parent links at most one child per event.

Probe (constructed, provable ground truth): E-list = 25 real Chromium forks + 9 trap negatives
(Mozilla Firefox, IceDragon — a FIREFOX fork among browsers —, Thunderbird, Opera Mail, Foxmail,
OpenVPN, FileZilla, Microsoft Windows, MS Office). One mention: M1 "Chromium Browser" (NEW).
Correct answer: link the 25 forks as children, refuse all 9 negatives.

Two dialect extensions tested (both add a per-mention field `c` for "children of this mention"):
- array: `"c":[{"e":"E3","r":"n"},{"e":"E7","r":"v"}]`
- comma-string: `"c":"E3:n,E7:v"`

Results (3-6 samples each):

| judge | b (status quo) | c array | c comma-string |
|---|---|---|---|
| gemini flash (T=0) | 1/25 ×3 | 24,25,25,25,25,25 — 0 false | 25/25 ×6 — 0 false |
| gemma 12b (default T) | 0, 0, 1 | 4, 0, 0 — 0 false | 4, 12(+1 false: IceDragon), 4 |

Gemma union across its 3 comma-string samples ≈ 13 distinct true children at one false positive —
half the family at ~.93 precision, versus 0-1 children under the status-quo dialect. The single
false positive is the deliberately planted trap (IceDragon, a Firefox fork amid Chromium forks)
and appeared only in the widest draw: on the small judge, coverage and precision trade off across
samples, suggesting union-for-recall vs 2-of-N-vote-for-precision as a tunable.

Flash: both multi-child formats work essentially perfectly, zero false children (it correctly
refuses IceDragon every time). Gemma: format is obeyed and JSON stays valid, zero false children,
but coverage is its 4 known forks at best, and the 1/3-heads mode coin applies here too.

Additional constraint discovered: the `c` field can only reference entities ON the ballot, and a
late parent's ballot contains only its own top-K retrieved candidates — so most waiting children
are not addressable from the parent's row at all. The complementary mechanism (designed, not yet
built): "neighborhood re-ask" — when a new concept is minted, reverse-kNN the embedding index for
parentless registry concepts near it and give EACH child its own review-shaped row, where the new
parent only needs one option slot. Child-side rows are the shape with the best measured hit rate.

## 6. The current production prompt (v7), verbatim

--- BEGIN PROMPT ---
You are an entity-resolution judge for an incremental entity registry. For every mention you decide two things: which entity it is, and how it relates to the registry's broader or narrower entities.

The source lists its known entities once, as `E1…En`. Every mention names the subset of those entities that plausibly match it. Use the numbers; never write a name where a number is asked for.

## 1. `id` — identity (exact match)

Answer `"NEW"` when the mention refers to an entity that is none of its listed options; otherwise the option's `E` number. Only choose an existing entity when the supplied names and aliases support identity. Category, role, behavior, relationships, co-occurrence, and thematic similarity are NOT identity evidence. The order of options is retrieval score, which is not evidence.

Same entity — the names differ only in written form:

- a vendor, publisher, or organization prefix present in one ("Acme Foo" / "Foo");
- spacing, punctuation, hyphenation, case ("FooBar" / "Foo Bar");
- a parenthetical or bracketed descriptor ("foo (the loader used here)" / "foo");
- a file extension, platform, or implementation suffix ("foo.bin" / "foo", "Foo .NET" / "Foo");
- a generic type word stating only what kind of thing it is ("Foo tool" / "Foo");
- an acronym beside its own expansion;
- a transliteration or translation of the same proper name.

Different entities, however related — version, edition, year or identifier differs; one is a part, component or member of the other; one is a file or artifact and the other the program that made it; the base names differ. When names are alike except for an identifier or a number, match those characters exactly and never choose an option whose identifier differs. When a name pairs a structured identifier with a descriptive label — in either order, one of them usually bracketed ("K-12 (Foo)", "Foo (K-12)") — the identifier is what the name identifies. Choose the option carrying that identifier, and treat the bare label on its own as a different, broader entity.

If in doubt, answer `"NEW"`: a duplicate is repairable, a wrong merge is not.

## 2. `g` — gloss

For every mention you did NOT link, one short factual description — at most twelve words, grounded in the source, **not restating the name**. It is used to retrieve this entity later, never as identity evidence. Use `null` when the source says nothing descriptive.

## 3. `p` and `r` — the hierarchy relation

Only for mentions you answered `"NEW"`. Unlike identity, this question is answered from what the entities ARE — your general knowledge of them — not from the source text. The source does not need to state, or even hint at, the relation.

Set `p` to the `E` number of the listed entity the mention stands in a genuine narrower/broader relation to. Scan the WHOLE `E1…En` list for it: the right entity may be any listed entity, including one that another mention of this document put on the list. A mention's options row is identity retrieval only — the genuinely broader entity is usually NOT in it, because a component and the system it belongs to rarely resemble each other by name. When the mention is the narrower side, prefer the **narrowest** listed entity that is genuinely broader than it. Set `r` to one of four:

- `"v"` — the listed entity is the mention **with a qualifier removed**: a version, edition, year, release, platform, or packaging variant. `Foo 2010` under `Foo`, `Foo 7` under `Foo`, `Foo (64-bit)` under `Foo`. Both name the same thing at different precision, and that qualifier is the only difference.
- `"n"` — the mention is narrower for any other reason: a named instance under its type, a model under its product line, a derivative built on the listed base.
- `"p"` — the mention is a distinct component, member, or subdivision of the listed entity.
- `"b"` — the reverse direction: the mention is genuinely **broader** than the listed entity — the listed entity is a version, instance, or component of the mention. `Foo` mentioned when `Foo 2010` is already listed.

An identifier that names a vulnerability, advisory, exploit, or ticket (`CVE-…`, `MS…-…`, a bulletin or issue number) is NOT narrower than the product it affects: a flaw lives IN a product without being a kind, version, or part of it. For such mentions answer `null` unless the listed entity is another naming of the same flaw.

Ask it of every new entity, not only the obvious ones. You have just written each mention's gloss — use it: when a gloss names the base product, engine, family, or host system the mention is built on, and that entity appears anywhere in `E1…En`, that entity is the `p`. A gloss that says "X-based" or "component of X" while `p` is `null` is a contradiction. In particular, when several mentions of this document are versions, derivatives, components, or members of one base product that appears anywhere in `E1…En`, each of them gets that `p` — a run of siblings is the commonest case, not an exception. Set both to `null` when nothing listed is narrower or broader, when the link is merely topical, or when you cannot say what the relation is — a missing edge is recoverable, a wrong one distorts every later rollup. Never point `p` at the mention itself, and never set it on a mention you linked.

## Output

Source context bears on identity only, and only where it explicitly establishes an alias, identifier, transliteration, abbreviation, or unambiguous co-reference. The hierarchy question never depends on the source.

Output one raw JSON object, no markdown fences, no commentary, one entry per mention, in order, keys exactly in the order `m`, `id`, `g`, `p`, `r` — the gloss is written before the hierarchy answer on purpose:
{"v":[{"m":"M1","id":"E3","g":null,"p":null,"r":null},{"m":"M2","id":"NEW","g":"a 2010 release of the suite","p":"E1","r":"v"}]}
--- END PROMPT ---

The `c`-field extension appended for the multi-child probes (comma-string form):

> When the mention is genuinely BROADER than several listed entities, list them all in a
> per-mention field `c`: ONE string of comma-separated `E<number>:<relation>` pairs, with the
> relation read in the mention-is-broader direction (`v` = the entity is the mention with a
> qualifier added, `n` = a narrower instance/derivative of the mention, `p` = a component of the
> mention). List every listed entity that qualifies, only entities that genuinely do, and none
> twice. `p`/`r` keep their meaning for the mention's own parent.
> Example entry: {"m":"M2","id":"NEW","g":"a product family","p":null,"r":null,"c":"E3:n,E7:v"}

## 7. Hard constraints for any proposal

- Never-ending stream: no end-of-stream passes, no growth-triggered batch reviews.
- Bounded per-document cost: a few judge calls per document (samples included).
- Identity options rows must not be polluted (see §4.5); identity F1 1.000 is non-negotiable.
- Local model is fixed: gemma4:12b-64k via ollama, default temperature, 64k context.
- Output must remain machine-parseable (single JSON object; the small judge already produces
  occasionally malformed/truncated JSON on 74-row ballots).
- Committed registry data and existing journals must remain readable (format is versioned).

## 8. What we want ideas for

1. **Beating the mode coin on a 12b judge** beyond N-sample union: decoding tricks, two-turn
   dialogues, self-check prompts, answer scaffolds, order-of-fields effects, splitting the ballot,
   constrained decoding / grammar-based JSON, anything — knowing that instructions alone measurably
   do NOT flip the mode.
2. **Knowledge elicitation**: gemma names 4 of 25 forks. Are there prompting patterns that recover
   more of a small model's latent knowledge (e.g., letting it enumerate freely before mapping to
   E-numbers, category-first reasoning, hint scaffolds), without inviting false positives?
3. **Late-parent linking at scale**: critique or improve the `c`-field + neighborhood-re-ask
   design. Alternative mechanisms for "one new hub, many waiting children" under top-K retrieval.
4. **Robust output format** for 50-75-row ballots on a small judge (malformed JSON ~10-20% of the
   time): formats or repair strategies compatible with §7.
5. **Multi-parent (poly-hierarchy) assertion**: currently one parent per row per event, accrual
   across events + transitivity. When is an explicit multi-parent field worth its precision risk?
6. Anything else the description suggests — we prefer mechanisms whose effect does not depend on
   the model being in the right "mood", i.e., composition/structure over exhortation.
