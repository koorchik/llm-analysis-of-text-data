import type { EmbeddingProposal } from './embeddingPairs';
import { classifyMechanism, type ProposedPair, type ProposedStratum } from './proposePairs';
import { joinSources, type WorksheetPair } from './preLabel';
import type { Inventory } from './inventory';
import fs from 'fs/promises';

/**
 * A second pair proposer, reading the unified-entities registry produced by
 * `DataEntitiesCollector` (`storage/.../entities-unified/<model>/entities.json`).
 *
 * **Why bother, when a string sweep already proposes pairs.** No string mechanism can find a
 * zero-overlap alias, so strata (c) and (d) — the ones `docs/GOLD-TABLE.md` §4 says cannot be
 * skipped — have no mechanical source at all. The registry does have one: it groups surfaces by a
 * canonical name, and on this corpus that yields `APT44`/`Sandworm`, `UAC-0114`/`Winter Vivern`,
 * `GhostWriter`/`unc1151` and `CVE-2021-44228`/`Log4Shell` — 295 non-`Domain` pairs the string
 * sweep never surfaces.
 *
 * **Three things it is not.**
 *
 * 1. **Not a label.** The registry over-merges systematically: it answers "are these related",
 *    where entity resolution asks "are these the same referent". Classified mechanically, all 4,551
 *    of its `Domain` merges are part-of (716) or sibling (3,835) relations and *none* is
 *    coreference. `Microsoft Office` absorbs 2007 through 2019; `Windows Script Host` absorbs both
 *    `cscript.exe` and `wscript.exe`. So it proposes and the annotator disposes — the same contract
 *    `proposePairs` has.
 * 2. **Not an authority on strata.** It cannot tell semantic-known from semantic-novel, so a pair
 *    no string mechanism explains gets a *provisional* `c` for the annotator to promote or demote.
 * 3. **Not independent of the systems under test.** It is the batch Ψ_norm arm's own output, which
 *    `evaluate --batch` scores. Every pair carries its source so the resulting bias is reported
 *    rather than hidden; see §5.4 of the design spec.
 */

export interface Registry {
  /** category → surface → canonical name. */
  entities: Record<string, Record<string, string>>;
}

/**
 * What the registry merged, for reporting only.
 *
 * **This must never reach a label or a suggestion.** It exists to turn "the batch method
 * over-merges" into a number in a table. It is also a heuristic — the registrable tail is taken as
 * the last two labels, which is wrong for multi-label public suffixes like `co.uk`. No such suffix
 * appears in this corpus, and a misclassification moves a count, never a verdict.
 */
export type MergeRelation = 'part-of' | 'sibling' | 'instance-of' | 'unclassified';

export interface RegistryPair extends Omit<ProposedPair, 'stratum'> {
  /**
   * `a`/`b` when a string mechanism explains the pair, otherwise a **provisional** `c`.
   *
   * Wider than `ProposedStratum` on purpose: the string proposer can only ever produce (a)/(b),
   * which is precisely the gap this proposer exists to fill.
   */
  stratum: ProposedStratum | 'c';
  /** The canonical both surfaces were mapped to. Context for the annotator, never evidence. */
  canonical: string;
  relation: MergeRelation;
}

export interface RegistryPairsResult {
  pairs: RegistryPair[];
  /**
   * Registry keys that are not inventory surfaces under the same category.
   *
   * Reported rather than dropped in silence: a pair naming a surface the corpus never contained is
   * discarded by `gold build` without a word, so this is the only place registry/`raw-unified`
   * drift would become visible.
   *
   * **Empty on this corpus.** Matching is case-insensitive because the inventory folds case
   * variants into one row, keeping the first-seen spelling — the registry's `CloudFlare` and the
   * inventory's `Cloudflare` are the same surface. All 3,392 registry keys resolve to one of the
   * 3,360 inventory surfaces, so the two artifacts are in exact correspondence.
   */
  droppedKeys: Array<{ category: string; surface: string }>;
}

interface Options {
  /** Minimum string similarity before a pair counts as stratum (a). Match `proposePairs`. */
  minSim?: number;
  /** Categories to skip entirely — `Domain`, for the sampling decision in §8. */
  skipCategories?: string[];
}

const fold = (value: string) => value.trim().toLowerCase();

/** Registrable tail, approximated as the last two labels. See `MergeRelation` for the caveat. */
const tail = (host: string) => host.split('.').slice(-2).join('.');

/** Strip a trailing version or year token: `microsoft office 2016` → `microsoft office`. */
const withoutVersion = (value: string) =>
  value.replace(/[\s-]*(v?\d{1,4}(\.\d+)*|20\d\d)$/u, '').trim();

function classifyRelation(category: string, left: string, right: string): MergeRelation {
  const [a, b] = [fold(left), fold(right)];
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  if (fold(category) === 'domain') {
    if (long.endsWith(`.${short}`)) return 'part-of';
    if (tail(a) === tail(b)) return 'sibling';
  }
  if (long !== short && withoutVersion(long) === short) return 'instance-of';
  return 'unclassified';
}

/**
 * Validate a parsed registry.
 *
 * Strict for the same reason the gold loader is: a malformed registry that quietly yielded zero
 * clusters would be indistinguishable from a working run that found nothing to merge.
 */
export function parseRegistry(data: unknown): Registry {
  if (typeof data !== 'object' || data === null) throw new Error('registry is not an object');

  const entities = (data as Record<string, unknown>).entities;
  if (typeof entities !== 'object' || entities === null) {
    throw new Error(
      'registry has no "entities" object — expected {entities: {category: {surface: canonical}}}'
    );
  }

  for (const [category, map] of Object.entries(entities as Record<string, unknown>)) {
    if (typeof map !== 'object' || map === null) {
      throw new Error(`registry entities.${category} is not an object`);
    }
    for (const [surface, canonical] of Object.entries(map as Record<string, unknown>)) {
      if (typeof canonical !== 'string') {
        throw new Error(`registry entities.${category}["${surface}"] must map to a string`);
      }
    }
  }

  return { entities: entities as Registry['entities'] };
}

export async function loadRegistry(filePath: string): Promise<Registry> {
  return parseRegistry(JSON.parse(await fs.readFile(filePath, 'utf8')));
}

export function registryPairs(
  registry: Registry,
  inventory: Inventory,
  options: Options = {}
): RegistryPairsResult {
  const minSim = options.minSim ?? 0.7;
  const skip = new Set((options.skipCategories ?? []).map(fold));

  // Cross-validation index. Keyed by category as well as surface: categories are separate
  // annotation universes, so a surface matching under a *different* category is not a match.
  const known = new Map<string, Set<string>>();
  for (const entry of inventory.entries) {
    const set = known.get(fold(entry.category)) ?? new Set<string>();
    set.add(fold(entry.surface));
    known.set(fold(entry.category), set);
  }

  const pairs: RegistryPair[] = [];
  const droppedKeys: RegistryPairsResult['droppedKeys'] = [];
  // The registry can key case variants of one surface separately (`CloudFlare` and `Cloudflare`)
  // where the inventory folded them into a single row. Left unchecked, such a group emits the same
  // pair twice and the annotator adjudicates one question twice, with no guarantee of one answer.
  const emitted = new Set<string>();

  for (const [category, map] of Object.entries(registry.entities)) {
    if (skip.has(fold(category))) continue;

    const groups = new Map<string, string[]>();
    for (const [surface, canonical] of Object.entries(map)) {
      if (!known.get(fold(category))?.has(fold(surface))) {
        droppedKeys.push({ category, surface });
        continue;
      }
      const group = groups.get(canonical) ?? [];
      group.push(surface);
      groups.set(canonical, group);
    }

    for (const [canonical, surfaces] of groups) {
      if (surfaces.length < 2) continue;
      const sorted = [...surfaces].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const [left, right] = [sorted[i], sorted[j]];
          if (fold(left) === fold(right)) continue; // the inventory already folded these together

          const folded = `${fold(category)}|${[fold(left), fold(right)].sort().join('|')}`;
          if (emitted.has(folded)) continue;
          emitted.add(folded);

          // Stratum comes from the mechanism that explains the pair, never from the registry —
          // a registry pair that is also an identifier variant is stratum (a), same as if the
          // string sweep had found it first. Nothing explains it: provisional (c).
          const classified = classifyMechanism(left, right, category, minSim);
          pairs.push({
            category,
            left,
            right,
            stratum: classified?.stratum ?? 'c',
            mechanism: classified?.mechanism ?? 'registry',
            sim: Number((classified?.sim ?? 0).toFixed(4)),
            label: '',
            evidence: '',
            canonical,
            relation: classifyRelation(category, left, right),
          });
        }
      }
    }
  }

  return { pairs, droppedKeys };
}

/**
 * Union the proposers into one worksheet, deduplicated on `(category, left, right)`.
 *
 * **Field priority is string > registry > embedding.** A pair's stratum must describe the
 * mechanism that explains it: `UAC-0010`/`UAC-0010 (Armageddon)` is an identifier variant —
 * stratum (a) — whichever proposers also surfaced it. The registry beats the embedding side
 * because it carries the `canonical` the annotator wants and its provisional-stratum semantics
 * are the documented ones; an embedding neighbour contributes only its cosine.
 *
 * The `source` cell records *every* contributing proposer as the canonical `+`-joined sorted
 * spelling (`registry+string`, `embedding+registry`, …) — the composition-by-source table in the
 * paper reads straight off it.
 *
 * Ordering is string proposals first, in their similarity order, then registry-only rows, then
 * embedding-only rows. That keeps a worksheet diff readable when a proposer is added to an
 * existing run.
 */
export function unionProposals(
  stringPairs: ProposedPair[],
  registryProposals: RegistryPair[],
  embeddingProposals: EmbeddingProposal[] = []
): WorksheetPair[] {
  // Order-independent on purpose. Each proposer orders a pair by raw spelling and they do not
  // always hold the same spelling — the inventory keeps the first-seen casing, the registry keeps
  // its own — so `Zebra`/`apple` and `Apple`/`zebra` are one pair asked two ways.
  const keyOf = (pair: { category: string; left: string; right: string }) =>
    `${fold(pair.category)}|${[fold(pair.left), fold(pair.right)].sort().join('|')}`;

  const fromRegistry = new Map(registryProposals.map((pair) => [keyOf(pair), pair]));
  const fromEmbedding = new Map(embeddingProposals.map((pair) => [keyOf(pair), pair]));

  const sourcesOf = new Map<string, string[]>();
  const note = (key: string, source: string) => {
    const list = sourcesOf.get(key) ?? [];
    list.push(source);
    sourcesOf.set(key, list);
  };
  for (const pair of stringPairs) note(keyOf(pair), 'string');
  for (const pair of registryProposals) note(keyOf(pair), 'registry');
  for (const pair of embeddingProposals) note(keyOf(pair), 'embedding');

  const seen = new Set<string>();
  const merged: WorksheetPair[] = [];

  for (const pair of stringPairs) {
    const key = keyOf(pair);
    seen.add(key);
    merged.push({
      ...pair,
      source: joinSources(sourcesOf.get(key)!),
      canonical: fromRegistry.get(key)?.canonical,
    });
  }

  for (const pair of registryProposals) {
    const key = keyOf(pair);
    if (seen.has(key)) continue;
    seen.add(key); // belt and braces: never append the same folded pair twice
    merged.push({ ...pair, source: joinSources(sourcesOf.get(key)!) });
  }

  for (const pair of embeddingProposals) {
    const key = keyOf(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...pair, source: joinSources(sourcesOf.get(key)!) });
  }

  return merged;
}

export function registryPairsSummary(
  pairs: RegistryPair[]
): Array<{ category: string; relation: MergeRelation; pairs: number }> {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const key = `${pair.category} ${pair.relation}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [category, relation] = key.split(' ');
      return { category, relation: relation as MergeRelation, pairs: count };
    })
    .sort((a, b) => b.pairs - a.pairs || (a.category < b.category ? -1 : 1));
}
