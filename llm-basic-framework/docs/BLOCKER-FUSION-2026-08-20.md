# The union blocker loses recall to its own fusion, 2026-08-20

The Country probe in `LOCAL-MATCHING-EXPERIMENTS-2026-08-19.md` ended at pairwise F1 0.952 on every
judge, with one unresolved gold pair: `g3 Poland | Польща`. It is not a gold error and not a judging
error. `Польща` was retrieved, scored **0.95 — the highest similarity on the ballot** — and then
placed **5th** by the fusion, outside the `LISTWISE_K=4` window the judge is shown. The judge never
saw it.

## 1. Why the best candidate ranked fifth

`RrfFusionGenerator` orders by reciprocal rank fusion: each channel votes `1/(60 + rank)` and the sums
decide. `sim` is reported as the best child similarity and is deliberately *not* the ordering key
(`RrfFusionGenerator.ts:28-39`) — the children's scores are incommensurable, so ranks are the only
comparable quantity. That rationale is sound in general and wrong for this corpus.

Reconstructing the exact `Poland` ballot channel by channel:

| channel | rank of `Польща` | its score |
|---|---:|---:|
| `string-sim(identity)` | 8 | 0.000 |
| `string-sim(translit)` | **1** | 0.500 |
| `tfidf-3gram` | 8 | 0.000 |
| `bm25` | absent | — |
| `embedding` | **1** | 0.946 |
| **fused (RRF)** | **4–5** | reported sim 0.946 |

Two channels rank it first. Three cannot see a Latin/Cyrillic pair at all — `string-sim` and `tfidf`
score it **0.000** and still cast a rank vote from position 8 — and `China`/`Ukraine`/`Israel`, which
place mid-list in every channel, win on breadth of consensus by a 2% margin.

**Consensus is the wrong prior when the channels have disjoint competence.** Identity evidence on this
corpus is usually single-channel: a transliteration pair is invisible to edit distance, an exact
identifier is invisible to a dense encoder. RRF rewards the candidate the most channels *tolerate*,
which is systematically not the candidate one channel *knows*.

Suppressing zero-score votes does not fix it (tested: `Польща` drops to 7th) — it shrinks the two
informed votes more than the six uninformed ones. The defect is structural, not a threshold.

## 2. Measuring the blocker, not the encoder

`bin/embed-bench.js` ranks encoders. The new `npm run blocker-bench` ranks whole candidate generators
on the only thing a blocker owes the judge — **is the right entity on the ballot** — at the judge's
width (`LISTWISE_K=4`) and the pipeline's retrieval width (`CANDIDATE_K=10`).

Setup mirrors the streaming reality: every gold surface becomes its own registry entry (nothing
pre-merged, as when a sibling was minted a few documents earlier), each member of every multi-member
cluster is queried in turn, and a hit means a same-cluster sibling made the top-k. Full gold pool:
**1,400 surfaces, 270 queries, 8 categories** — the scale the 22-doc iteration slices cannot probe.
No LLM calls; embeddings come from the shared cache.

```bash
npm run blocker-bench -- --generators embedding,union,union-rr --k 4,10
```

| generator | recall@4 | recall@10 |
|---|---:|---:|
| `union` (RRF over 5 channels) | 74.4% | 82.6% |
| `embedding` (dense channel alone) | 85.9% | 90.0% |
| **`union-rr` (5 channels, interleaved)** | **85.6%** | **90.7%** |

Per category at k=4, `union` vs `union-rr`: Country **5/14 → 14/14**, Sector 31/48 → 43/48,
Organization 16/22 → 19/22, Government Body 39/53 → 43/53, Software 90/106 → 94/106. `union` keeps a
one-query edge on HackerGroup (15/21 vs 14/21) and Individual (3/4 vs 2/4), both inside noise at these
counts, and `union-rr` takes both back at k=10.

The fusion was costing **11.2 points of recall@4** against its own dense child.

## 3. The fix: interleave instead of fuse

`RoundRobinFusionGenerator` (`CANDIDATE_GENERATOR=union-rr`) takes every child's rank-1, then every
child's rank-2, and so on, de-duplicating. A candidate that exactly one channel ranks first is
**guaranteed** a slot in the first `children.length` positions — which is what a 4-wide judge window
needs. Contract is otherwise identical to RRF so the two are drop-in swappable: `sim` is still the best
child similarity, the list is still pre-ordered and must not be re-sorted by `sim`, child order breaks
ties. The dense channel is listed first, so it owns rank 1 when two channels disagree.

End-to-end on the three category probes (12b judge, `nameform-v6`, otherwise the 2026-08-19 config):

| blocker | Software | Country | HackerGroup |
|---|---:|---:|---:|
| `union` | 1.000 | 0.952 | 1.000 |
| `embedding` | 1.000 | 1.000 | 1.000 |
| **`union-rr`** | **1.000** | **1.000** | **1.000** |

Software decisions are byte-identical across all three blockers; Country gains the Poland merge. Token
cost is a wash.

## 4. Why keep the other channels at all

`embedding` alone matches `union-rr` at the judge's width on this evidence, and it is simpler. Two
reasons not to drop the lexical channels:

1. **Retrieval width matters beyond the judge.** At k=10 — what `CANDIDATE_K` actually retrieves, and
   what repair and other decision strategies see — `union-rr` is ahead (90.7% vs 90.0%), recovering
   HackerGroup and Individual pairs the dense channel misses.
2. **The failure modes are disjoint by construction.** The dense channel misses exact identifiers
   (`UAC-0028` vs `UAC-0001` differ by two characters and embed nearly identically); the lexical
   channels own those. Deleting them would trade a measured 11-point fusion bug for an unmeasured
   coverage hole.

## 5. Recommended policy change

```diff
- CANDIDATE_GENERATOR=union
+ CANDIDATE_GENERATOR=union-rr
```

`union` stays registered and unchanged: the 2026-08-08 four-arm study and both committed baselines ran
it, and their runIds must keep resolving to the same blocker.

## 6. Limits

Recall@k is a blocker metric, not an end-to-end one — a wider ballot can also hand the judge more
plausible wrong answers, which this bench cannot see. The end-to-end check in §3 is three
single-category subset probes (five scorable Software clusters, six Country, two HackerGroup), so it
confirms no regression rather than proving the gain. The blocker bench itself is full-pool and
LLM-free, which is why it carries most of the weight here.
