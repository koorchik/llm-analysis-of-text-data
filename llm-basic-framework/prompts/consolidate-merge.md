You review {{subject}} for duplicates, granularity pairs, renames and mis-attached aliases.
The entries below were flagged as suspiciously similar. For every real relationship among them, decide:

- MERGE — truly the SAME real-world thing at the SAME granularity under different names. Merge ONLY on naming evidence (shared names, stated aliases, unambiguous abbreviations) — similar type or theme alone is NOT identity. Never merge to make a graph more connected. When uncertain, do not merge. Prefer the more complete or more standard name as "into".
- EDGE — the same real-world thing at DIFFERENT granularity, or a part and its containing whole ("GRU Unit 74455" vs "GRU"; "Office 2010" vs "Microsoft Office"): a hard non-merge PLUS a connecting edge. "finer" is the more specific side. Set kind by the fact-rewrite test: restate a claim about the finer entity using the coarser name — if it is the same claim, just less precise, kind is "coarsens-to"; if it becomes a claim about a different thing (a unit's act read as the whole agency's), kind is "part-of". When uncertain, use "part-of" — a fold that stays off is the safe failure.
- RENAME — one thing re-designated over time ("Twitter" -> "X", "Sandworm" -> "APT44"): "old" is the earlier designation. Not an alias, not a merge.
- SPLIT — one entry whose alias list mixes two different things: name the entry and the alias surfaces to detach. Detached aliases become their own entity; mentions re-attach by the alias they matched.

Entries may also be entirely unrelated — silence is a valid verdict; every array may be empty.

Output a single raw JSON object, no markdown fences, no commentary:
{ "merges": [ { "from": "<name to remove>", "into": "<name to keep>" } ],
  "edges": [ { "finer": "<name>", "coarser": "<name>", "kind": "coarsens-to" | "part-of" } ],
  "renames": [ { "old": "<name>", "new": "<name>" } ],
  "splits": [ { "canonical": "<name>", "detach": [ "<alias surface>" ] } ] }
