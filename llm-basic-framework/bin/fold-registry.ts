#!/usr/bin/env ts-node
/**
 * Fold a registry along its granularity edges — the operation the graph exists for.
 *
 *   npm run fold -- --run <runDir> --category Software
 *   npm run fold -- --run <runDir> --relations coarsens-to      # versions only, keep components
 *   npm run fold -- --run <runDir> --level g1                   # stop at the ladder's product rung
 *
 * A flat registry answers "how many mentions of `Microsoft Office 2010`". A folded one answers "how
 * many mentions of Office **at product granularity**", which is the question an analysis usually
 * wants, and it is a different answer for every choice of fold — hence a runtime operation over the
 * stored graph rather than a decision baked into the registry.
 *
 * Two knobs, because the two edge kinds mean different things:
 *
 * - `coarsens-to` preserves the referent (`Office 2010` → `Office`). Following it is a rollup.
 * - `part-of` does not (`MS Word` → `MS Office`, `rfusclient.exe` → `Remote Utilities`). Following
 *   it answers "which system was involved", which is often what a report-level count wants and is
 *   sometimes wrong — so it is opt-in per run, not a default.
 *
 * `--level` stops the walk at the first ancestor sitting at or above the given ladder rung, which is
 * what makes "show everything at product level" a single flag rather than a hand-written traversal.
 */
import { promises as fs } from 'fs';
import path from 'path';

interface Registry {
  categories?: Record<
    string,
    Record<string, { aliases?: Array<{ surface: string } | string>; rung?: string; gloss?: string | null }>
  >;
  granularityEdges?: Record<string, Array<{ from: string; to: string; kind: string }>>;
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const RUN = flag('run');
const CATEGORY = flag('category');
const RELATIONS = new Set(flag('relations', 'coarsens-to,part-of').split(',').map((s) => s.trim()));
const LEVEL = flag('level');
const TOP = Number(flag('top', '25'));

async function main() {
  if (!RUN) throw new Error('usage: fold-registry --run <runDir> [--category X] [--relations coarsens-to,part-of] [--level g1]');
  const registry = JSON.parse(await fs.readFile(path.join(RUN, 'registry.json'), 'utf8')) as Registry;

  const categories = Object.keys(registry.categories ?? {}).filter(
    (name) => !CATEGORY || name.toLowerCase() === CATEGORY.toLowerCase()
  );

  for (const category of categories) {
    const records = registry.categories![category];
    const edges = (registry.granularityEdges?.[category] ?? []).filter((edge) => RELATIONS.has(edge.kind));
    if (Object.keys(records).length === 0) continue;

    const parent = new Map<string, { to: string; kind: string }>();
    for (const edge of edges) {
      // One parent per node keeps the fold a function. A second edge out of the same node is a
      // multi-parent DAG — real, but it makes "the" folded value ambiguous, so the first wins and
      // the rest are reported.
      if (!parent.has(edge.from)) parent.set(edge.from, { to: edge.to, kind: edge.kind });
    }
    const multiParent = edges.length - parent.size;

    const rungOf = (name: string) => records[name]?.rung ?? 'g0';
    const rungNumber = (rung: string) => Number(/^g(\d+)$/.exec(rung)?.[1] ?? 0);
    const stopAt = LEVEL ? rungNumber(LEVEL) : Infinity;

    const foldOf = (name: string): string => {
      const seen = new Set<string>([name]);
      let current = name;
      for (;;) {
        if (rungNumber(rungOf(current)) >= stopAt) return current;
        const next = parent.get(current);
        if (!next || seen.has(next.to)) return current;
        seen.add(next.to);
        current = next.to;
      }
    };

    const mentions = (name: string) => (records[name]?.aliases ?? []).length;
    const folded = new Map<string, { members: string[]; mentions: number }>();
    for (const name of Object.keys(records)) {
      const target = foldOf(name);
      const bucket = folded.get(target) ?? { members: [], mentions: 0 };
      bucket.members.push(name);
      bucket.mentions += mentions(name);
      folded.set(target, bucket);
    }

    const moved = [...folded.values()].reduce((sum, b) => sum + b.members.length, 0) - folded.size;
    console.log(
      `\n=== ${category}: ${Object.keys(records).length} canonicals, ${edges.length} usable edges ` +
        `(${[...RELATIONS].join('+')}${LEVEL ? `, stop at ${LEVEL}` : ''})`
    );
    console.log(`    folded to ${folded.size} nodes — ${moved} canonicals absorbed` +
      (multiParent ? `; ${multiParent} extra parent edges ignored (multi-parent)` : ''));

    const rolled = [...folded.entries()]
      .filter(([, bucket]) => bucket.members.length > 1)
      .sort((a, b) => b[1].mentions - a[1].mentions)
      .slice(0, TOP);
    for (const [target, bucket] of rolled) {
      const absorbed = bucket.members.filter((member) => member !== target);
      console.log(`    ${target}  (${bucket.mentions} surfaces)  <- ${absorbed.join(', ')}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
