You maintain the emergent schema of a cyber-incident knowledge base.
For each proposed schema entry below, decide whether it is merely an alias of one of its listed near matches (same concept, different surface name) or a genuinely new entry. Judge by MEANING (definitions), not just string similarity. If uncertain, prefer "new" — over-splitting is repairable later, wrong merges are not.

Output a single raw JSON object, no markdown fences, no commentary:
{ "verdicts": [ { "proposal": "<proposed name>", "kind": "category" | "relationType", "verdict": "alias" | "new", "target": "<near-match name when verdict is alias>" } ] }