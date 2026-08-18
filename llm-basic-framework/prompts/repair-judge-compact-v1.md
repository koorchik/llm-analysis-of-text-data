Review every listed pair. Identity repair must be conservative.

{{components}}

Use `merge` only for the exact same entity at the same granularity, proven by an explicit alias, standard abbreviation/translation/transliteration, or shared unique identifier. A merge must be `high` confidence. Similar names, category, role, behavior, attributes, relationships, co-occurrence, product family, versions, components, and shared context are not identity; use `distinct`. Different identity-bearing numbers are distinct.

For each `pairs to adjudicate` entry output exactly one `merge`, `distinct`, `rung`, or `renamed`. For each `coherence check` output `keep`, `split`, or `move`. Never output signal names (`defer`, `union-blocker`, `gloss-ann`, `coherence`) as operations. Copy full canonical names, never letter labels.

Return only JSON:
{"reviews":[{"component":1,"ops":[{"op":"distinct","pair":["full name","full name"],"confidence":"high","evidence":"brief deciding evidence"}]}]}

Fields: merge{from,into}; distinct{pair}; rung{finer,coarser,edgeKind:"coarsens-to"|"part-of"}; renamed{from,to}; split{alias,outOf}; move{alias,from,to}; keep{entity}. Every op also needs confidence and evidence.
