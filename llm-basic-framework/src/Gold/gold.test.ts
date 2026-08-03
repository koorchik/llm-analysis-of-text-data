import { validateGoldTable } from '../Evaluation/gold';
import {
  addSingletons,
  assignSplit,
  buildGoldTable,
  closeIntoClusters,
  deriveNilLabels,
  registryOnlyJudgmentStrata,
  type AdjudicatedPair,
} from './buildTable';
import { crossCategorySurfaces, type Inventory } from './inventory';
import { preLabel, type PairSource, type WorksheetPair } from './preLabel';
import { proposePairs } from './proposePairs';
import { parseRegistry, registryPairs, registryPairsSummary, unionProposals } from './registryPairs';
import { fromTsv, readRows, toTsv, type WorksheetRow } from './worksheet';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function inventory(entries: Array<[string, string, number[]]>): Inventory {
  return {
    sourceDir: '/fake',
    inputContentHash: 'hash',
    order: 'numeric-id',
    entries: entries.map(([category, surface, docIds]) => ({
      category,
      surface,
      docIds,
      occurrences: docIds.length,
    })),
  };
}

const pair = (
  left: string,
  right: string,
  label: 'same' | 'different',
  stratum = 'a',
  category = 'HackerGroup'
): AdjudicatedPair => ({ category, left, right, label, stratum });

describe('closeIntoClusters', () => {
  it('closes a chain transitively — a=b and b=c makes one cluster of three', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [2]],
      ['HackerGroup', 'Sofacy', [3]],
    ]);
    const { clusters } = closeIntoClusters(
      [pair('APT28', 'Fancy Bear', 'same'), pair('Fancy Bear', 'Sofacy', 'same')],
      inv
    );
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].members, ['APT28', 'Fancy Bear', 'Sofacy']);
  });

  it('keeps `different` pairs apart', () => {
    const inv = inventory([
      ['Device', 'MikroTik CCR 1016', [1]],
      ['Device', 'MikroTik CCR 1036', [1]],
    ]);
    const { clusters } = closeIntoClusters(
      [pair('MikroTik CCR 1016', 'MikroTik CCR 1036', 'different', 'a', 'Device')],
      inv
    );
    assert.equal(clusters.length, 0, 'a `different` verdict creates no cluster');
  });

  it('reports a transitivity conflict instead of silently resolving it', () => {
    // a=b, b=c, but the annotator marked a-c different. Identity is an equivalence relation, so
    // that is a contradiction in the annotation — not a smaller cluster.
    const inv = inventory([
      ['HackerGroup', 'A', [1]],
      ['HackerGroup', 'B', [1]],
      ['HackerGroup', 'C', [1]],
    ]);
    const { clusters, conflicts } = closeIntoClusters(
      [pair('A', 'B', 'same'), pair('B', 'C', 'same'), pair('A', 'C', 'different')],
      inv
    );
    assert.equal(conflicts.length, 1);
    assert.equal(clusters[0].members.length, 3, 'the closure still includes all three');
  });

  it('takes the hardest stratum in a cluster, since that is the capability attributed', () => {
    const inv = inventory([
      ['HackerGroup', 'A', [1]],
      ['HackerGroup', 'B', [1]],
      ['HackerGroup', 'C', [1]],
    ]);
    const { clusters } = closeIntoClusters(
      [pair('A', 'B', 'same', 'a'), pair('B', 'C', 'same', 'd')],
      inv
    );
    assert.equal(clusters[0].stratum, 'd');
  });

  it('matches members case-insensitively but keeps the inventory spelling', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [1]],
    ]);
    const { clusters } = closeIntoClusters([pair('apt28', 'FANCY BEAR', 'same')], inv);
    assert.deepEqual(clusters[0].members, ['APT28', 'Fancy Bear']);
  });
});

describe('cluster provenance', () => {
  const inv = inventory([
    ['HackerGroup', 'APT44', [1]],
    ['HackerGroup', 'Sandworm', [2]],
    ['HackerGroup', 'GhostWriter', [3]],
    ['HackerGroup', 'unc1151', [4]],
  ]);

  const sourced = (
    left: string,
    right: string,
    source: PairSource,
    stratum = 'c'
  ): AdjudicatedPair => ({
    category: 'HackerGroup',
    left,
    right,
    label: 'same',
    stratum,
    source,
  });

  it('records which proposers formed a cluster', () => {
    const { clusters } = closeIntoClusters([sourced('APT44', 'Sandworm', 'registry')], inv);
    assert.deepEqual(clusters[0].sources, ['registry']);
  });

  it('reports every distinct source once, sorted', () => {
    const { clusters } = closeIntoClusters(
      [sourced('APT44', 'Sandworm', 'registry'), sourced('Sandworm', 'GhostWriter', 'string')],
      inv
    );
    assert.deepEqual(clusters[0].sources, ['registry', 'string']);
  });

  it('flags a gold table whose judgment strata came only from the registry', () => {
    // The registry is the batch arm's own output, scored by `evaluate --batch`. If every (c)/(d)
    // cluster came from it, nothing proposer-independent constrains merge recall and the batch
    // arm's number is inflated by construction.
    const { clusters } = closeIntoClusters(
      [sourced('APT44', 'Sandworm', 'registry'), sourced('GhostWriter', 'unc1151', 'registry')],
      inv
    );
    assert.equal(registryOnlyJudgmentStrata(clusters), true);
  });

  it('does not flag when an independent proposer contributed a judgment cluster', () => {
    const { clusters } = closeIntoClusters(
      [sourced('APT44', 'Sandworm', 'registry'), sourced('GhostWriter', 'unc1151', 'string')],
      inv
    );
    assert.equal(registryOnlyJudgmentStrata(clusters), false);
  });

  it('does not flag a table with no judgment-stratum cluster at all', () => {
    // That case is already covered, and more precisely, by the empty-(d) warning.
    const { clusters } = closeIntoClusters([sourced('APT44', 'Sandworm', 'registry', 'a')], inv);
    assert.equal(registryOnlyJudgmentStrata(clusters), false);
  });
});

describe('addSingletons', () => {
  it('adds every unclustered surface — singletons are the gold mints', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [1]],
      ['HackerGroup', 'Sandworm', [2]],
      ['Software', 'Cobalt Strike', [3]],
    ]);
    const { clusters } = closeIntoClusters([pair('APT28', 'Fancy Bear', 'same')], inv);
    const withSingletons = addSingletons(clusters, inv);

    assert.equal(withSingletons.length, 3);
    const singles = withSingletons.filter((cluster) => cluster.members.length === 1);
    assert.deepEqual(singles.map((cluster) => cluster.members[0]).sort(), ['Cobalt Strike', 'Sandworm']);
  });

  it('does not duplicate a surface that is already in a cluster', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [1]],
    ]);
    const { clusters } = closeIntoClusters([pair('APT28', 'Fancy Bear', 'same')], inv);
    assert.equal(addSingletons(clusters, inv).length, 1);
  });
});

describe('assignSplit', () => {
  it('is deterministic — the same ids always land the same way', () => {
    const clusters = Array.from({ length: 200 }, (_, i) => ({
      id: `g${i}`,
      category: 'C',
      members: [`m${i}`],
      stratum: 'a',
      split: 'test' as const,
    }));
    const first = assignSplit(clusters).map((cluster) => cluster.split);
    const second = assignSplit(clusters).map((cluster) => cluster.split);
    assert.deepEqual(first, second);
  });

  it('hits the requested fraction exactly, at every scale', () => {
    // A loose "somewhere near 20%" assertion let a badly biased hash through: over ids g1..g100 the
    // original FNV-1a put 66% in dev, and only evened out over thousands. Ranking within a bucket
    // makes the proportion exact, so the test can be exact too.
    for (const size of [21, 100, 1000]) {
      const clusters = Array.from({ length: size }, (_, i) => ({
        id: `g${i + 1}`,
        category: 'C',
        members: [`m${i}`],
        stratum: 'a',
        split: 'test' as const,
      }));
      const dev = assignSplit(clusters, 0.2).filter((cluster) => cluster.split === 'dev').length;
      assert.equal(dev, Math.round(size * 0.2), `size ${size}`);
    }
  });

  it('stratifies, so a rare mergeable cluster cannot land entirely on one side', () => {
    // The real shape: a handful of mergeable clusters against thousands of singletons. An
    // unstratified hash can put nearly all the mergeable ones in one split by chance, and a split
    // with none produces empty merge P/R — the metric the whole study reports.
    const mergeable = Array.from({ length: 21 }, (_, i) => ({
      id: `g${i + 1}`,
      category: 'C',
      members: [`a${i}`, `b${i}`],
      stratum: 'a',
      split: 'test' as const,
    }));
    const singletons = Array.from({ length: 3000 }, (_, i) => ({
      id: `s${i + 100}`,
      category: 'C',
      members: [`s${i}`],
      stratum: 'a',
      split: 'test' as const,
    }));
    const assigned = assignSplit([...mergeable, ...singletons], 0.2);
    const multi = (split: string) =>
      assigned.filter((cluster) => cluster.members.length > 1 && cluster.split === split).length;

    assert.equal(multi('dev'), 4);
    assert.equal(multi('test'), 17);
  });

  it('keeps each stratum represented in both splits', () => {
    const clusters = ['a', 'b', 'c', 'd'].flatMap((stratum) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `${stratum}${i}`,
        category: 'C',
        members: [`${stratum}${i}x`, `${stratum}${i}y`],
        stratum,
        split: 'test' as const,
      }))
    );
    const assigned = assignSplit(clusters, 0.2);
    for (const stratum of ['a', 'b', 'c', 'd']) {
      const dev = assigned.filter((c) => c.stratum === stratum && c.split === 'dev').length;
      assert.equal(dev, 2, `stratum ${stratum}`);
    }
  });

  it('keeps existing assignments stable when clusters are added', () => {
    // Re-running after annotating more pairs must not reshuffle what was already assigned; a
    // random split would, and would move clusters across the tune/report boundary mid-study.
    const base = Array.from({ length: 50 }, (_, i) => ({
      id: `g${i}`,
      category: 'C',
      members: [`m${i}`],
      stratum: 'a',
      split: 'test' as const,
    }));
    const before = new Map(assignSplit(base).map((cluster) => [cluster.id, cluster.split]));
    const grown = [...base, { id: 'g999', category: 'C', members: ['x'], stratum: 'a', split: 'test' as const }];
    for (const cluster of assignSplit(grown)) {
      if (before.has(cluster.id)) assert.equal(cluster.split, before.get(cluster.id), cluster.id);
    }
  });

  it('splits whole clusters, so no alias can leak across the boundary', () => {
    const clusters = assignSplit([
      { id: 'g1', category: 'C', members: ['APT28', 'Fancy Bear', 'Sofacy'], stratum: 'c', split: 'test' },
    ]);
    assert.equal(clusters.length, 1, 'a cluster is never divided between splits');
  });
});

describe('deriveNilLabels', () => {
  it('labels the first occurrence NIL and every later one known', () => {
    const inv = inventory([['Organization', 'Adobe', [16, 23, 2624]]]);
    const clusters = addSingletons([], inv);
    const labels = deriveNilLabels(clusters, inv);

    assert.deepEqual(
      labels.map((label) => [label.docId, label.label]),
      [
        [16, 'NIL'],
        [23, 'known'],
        [2624, 'known'],
      ]
    );
  });

  it('is relative to the CLUSTER, not the surface — an alias arriving later is already known', () => {
    // This is the property a flat mention→label map cannot express, and the reason the loader
    // rejects one. "Fancy Bear" is new as a string at doc 5, but its entity was seen at doc 1.
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [5]],
    ]);
    const { clusters } = closeIntoClusters([pair('APT28', 'Fancy Bear', 'same')], inv);
    const labels = deriveNilLabels(clusters, inv);

    const fancy = labels.find((label) => label.mention === 'Fancy Bear')!;
    const apt = labels.find((label) => label.mention === 'APT28')!;
    assert.equal(apt.label, 'NIL', 'the cluster is new at doc 1');
    assert.equal(fancy.label, 'known', 'by doc 5 the entity has been seen under another surface');
  });

  it('emits both labels for one mention, which a flat map could not hold', () => {
    const inv = inventory([['Organization', 'Adobe', [16, 23]]]);
    const labels = deriveNilLabels(addSingletons([], inv), inv);
    const forAdobe = labels.filter((label) => label.mention === 'Adobe');
    assert.equal(forAdobe.length, 2);
    assert.deepEqual(new Set(forAdobe.map((label) => label.label)), new Set(['NIL', 'known']));
  });

  it('orders labels by document, matching the stream', () => {
    const inv = inventory([
      ['Organization', 'B', [5]],
      ['Organization', 'A', [1, 9]],
    ]);
    const labels = deriveNilLabels(addSingletons([], inv), inv);
    assert.deepEqual(
      labels.map((label) => label.docId),
      [1, 5, 9]
    );
  });

  it('carries the cluster id, so a label can be traced to its cluster', () => {
    const inv = inventory([['Organization', 'Adobe', [16]]]);
    const clusters = addSingletons([], inv);
    assert.equal(deriveNilLabels(clusters, inv)[0].clusterId, clusters[0].id);
  });
});

describe('buildGoldTable', () => {
  it('produces a table the strict loader accepts', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1, 4]],
      ['HackerGroup', 'Fancy Bear', [4]],
      ['Software', 'Cobalt Strike', [2]],
    ]);
    const { clusters } = closeIntoClusters([pair('APT28', 'Fancy Bear', 'same', 'c')], inv);
    const table = buildGoldTable({
      clusters: assignSplit(addSingletons(clusters, inv)),
      inventory: inv,
    });

    const validated = validateGoldTable(table);
    assert.equal(validated.version, 'gold-aliases-v1');
    assert.equal(validated.inputContentHash, 'hash');
    assert.equal(validated.order, 'numeric-id');
    assert.ok(validated.nilLabels.length > 0);
  });

  it('covers every inventory surface exactly once', () => {
    const inv = inventory([
      ['HackerGroup', 'APT28', [1]],
      ['HackerGroup', 'Fancy Bear', [1]],
      ['Software', 'Cobalt Strike', [2]],
      ['Software', 'CobaltStrike', [3]],
    ]);
    const { clusters } = closeIntoClusters([pair('APT28', 'Fancy Bear', 'same')], inv);
    const table = buildGoldTable({
      clusters: assignSplit(addSingletons(clusters, inv)),
      inventory: inv,
    });

    const members = table.clusters.flatMap((cluster) => cluster.members);
    assert.equal(members.length, inv.entries.length);
    assert.equal(new Set(members).size, inv.entries.length, 'no surface appears twice');
  });
});

describe('proposePairs', () => {
  const ctx = (entries: Array<[string, string]>) =>
    inventory(entries.map(([category, surface]) => [category, surface, [1]] as [string, string, number[]]));

  it('proposes a cross-script pair that string similarity scores at 0', () => {
    // The whole point of stratum (b): no similarity threshold could ever retrieve this.
    const proposals = proposePairs(ctx([['Country', 'India'], ['Country', 'Індія']]));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].stratum, 'b');
    assert.equal(proposals[0].mechanism, 'transliteration');
    assert.equal(proposals[0].sim, 0);
  });

  it('classifies a homoglyph pair as confusable, not transliteration', () => {
    // АРТ28 vs APT28. Cyrillic Р is ER, so a transliterator gives `art28`, never `apt28` —
    // only the confusable skeleton finds it. The research note mis-attributes this pair.
    const proposals = proposePairs(ctx([['HackerGroup', 'APT28'], ['HackerGroup', 'АРТ28']]));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].stratum, 'b');
    assert.equal(proposals[0].mechanism, 'confusable');
  });

  it('proposes near-miss product names, which are mostly NOT merges', () => {
    const proposals = proposePairs(ctx([['Device', 'MikroTik CCR 1016'], ['Device', 'MikroTik CCR 1036']]));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].stratum, 'a');
    assert.ok(proposals[0].sim > 0.9);
  });

  it('leaves label and evidence empty — it proposes, it never labels', () => {
    const proposals = proposePairs(ctx([['Country', 'India'], ['Country', 'Індія']]));
    assert.equal(proposals[0].label, '');
    assert.equal(proposals[0].evidence, '');
  });

  it('never proposes across categories', () => {
    const proposals = proposePairs(ctx([['Country', 'India'], ['Organization', 'Індія']]));
    assert.equal(proposals.length, 0);
  });

  it('orders each pair consistently, so the same two surfaces serialize identically', () => {
    const forward = proposePairs(ctx([['Device', 'Netgear R7000'], ['Device', 'Netgear R8000']]));
    const reverse = proposePairs(ctx([['Device', 'Netgear R8000'], ['Device', 'Netgear R7000']]));
    assert.equal(forward[0].left, reverse[0].left);
    assert.equal(forward[0].right, reverse[0].right);
  });

  it('honours skipCategories, for the Domain sampling decision', () => {
    const entries = ctx([['Domain', 'accounts-ukr.net'], ['Domain', 'accounts-ukrnet.com']]);
    assert.ok(proposePairs(entries).length > 0);
    assert.equal(proposePairs(entries, { skipCategories: ['Domain'] }).length, 0);
  });

  it('does not propose case variants — the inventory already folded them together', () => {
    const proposals = proposePairs(ctx([['Software', 'Cobalt Strike'], ['Software', 'cobalt strike']]));
    assert.equal(proposals.length, 0);
  });
});

describe('preLabel with registry provenance', () => {
  const worksheetPair = (
    left: string,
    right: string,
    overrides: Partial<WorksheetPair> = {}
  ): WorksheetPair => ({
    category: 'Software',
    left,
    right,
    stratum: 'a',
    mechanism: 'edit-similarity',
    sim: 0.9,
    label: '',
    evidence: '',
    ...overrides,
  });

  it('sends a registry merge that differing-digits rejects back to review', () => {
    // The registry merges Microsoft Office 2010 with 2016; differing-digits says they are distinct
    // products. Two proposers disagreeing is the highest-information row in the worksheet, so it
    // goes to a human rather than being silently decided either way.
    const [labelled] = preLabel([
      worksheetPair('Microsoft Office 2010', 'Microsoft Office 2016', {
        source: 'both',
        canonical: 'Microsoft Office',
      }),
    ]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'registry-conflict');
  });

  it('flags the conflict even when only the registry proposed the pair', () => {
    // `Windows 10` vs `Windows 10 version 1809` is registry-only, and differing-digits still
    // rejects it. The disagreement is what matters, not which proposer surfaced the row.
    const [labelled] = preLabel([
      worksheetPair('Windows 10', 'Windows 10 version 1809', {
        source: 'registry',
        canonical: 'Windows 10',
      }),
    ]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'registry-conflict');
  });

  it('keeps the string rule that claimed a registry-corroborated pair', () => {
    // A rule that merely re-suggests `same` would destroy the attribution the rule ids exist for:
    // you audit a rule once and accept all of its rows together.
    const [labelled] = preLabel([
      worksheetPair('Cobalt Strike', 'Cobalt-Strike', { source: 'both', canonical: 'Cobalt Strike' }),
    ]);
    assert.equal(labelled.rule, 'punctuation-only');
    assert.equal(labelled.suggested, 'same');
  });

  it('marks a registry-only semantic pair for review under its own rule', () => {
    const [labelled] = preLabel([
      worksheetPair('APT44', 'Sandworm', {
        category: 'HackerGroup',
        stratum: 'c',
        mechanism: 'registry',
        sim: 0,
        source: 'registry',
        canonical: 'Sandworm',
      }),
    ]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'registry-semantic');
  });

  it('leaves string-only pairs exactly as they were', () => {
    const [labelled] = preLabel([worksheetPair('Netgear R7000', 'Netgear R8000')]);
    assert.equal(labelled.suggested, 'different');
    assert.equal(labelled.rule, 'differing-digits');
  });
});

describe('worksheet provenance columns', () => {
  it('round-trips source and canonical', () => {
    const labelled = preLabel([
      {
        category: 'Software',
        left: 'Cobalt Strike',
        right: 'Cobalt-Strike',
        stratum: 'a',
        mechanism: 'edit-similarity',
        sim: 0.96,
        label: '',
        evidence: '',
        source: 'both',
        canonical: 'Cobalt Strike',
      },
    ]);
    const parsed = fromTsv(toTsv(labelled));
    assert.equal(parsed.pairs.length, 1);
    // The legacy `both` spelling normalizes to the canonical N-source form on read.
    assert.equal(parsed.pairs[0].source, 'registry+string');
  });

  it('defaults source to string when the column is absent', () => {
    // Worksheets written before provenance existed must still parse, and they are all string-sourced.
    const tsv = 'label\tsuggested\trule\tcategory\tleft\tright\tstratum\tmechanism\tsim\tevidence\n' +
      'same\tsame\tpunctuation-only\tSoftware\tCobalt Strike\tCobalt-Strike\ta\tedit-similarity\t0.96\t\n';
    const parsed = fromTsv(tsv);
    assert.equal(parsed.pairs[0].source, 'string');
  });
});

describe('registryPairs', () => {
  const ctx = (entries: Array<[string, string]>) =>
    inventory(entries.map(([category, surface]) => [category, surface, [1]] as [string, string, number[]]));

  it('pairs the surfaces that share a canonical', () => {
    const result = registryPairs(
      { entities: { HackerGroup: { Sandworm: 'Sandworm', APT44: 'Sandworm' } } },
      ctx([['HackerGroup', 'Sandworm'], ['HackerGroup', 'APT44']])
    );
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].left, 'APT44');
    assert.equal(result.pairs[0].right, 'Sandworm');
    assert.equal(result.pairs[0].canonical, 'Sandworm');
  });

  it('proposes nothing for a canonical with a single surface', () => {
    const result = registryPairs(
      { entities: { Organization: { Microsoft: 'Microsoft' } } },
      ctx([['Organization', 'Microsoft']])
    );
    assert.equal(result.pairs.length, 0);
  });

  it('drops a surface the corpus never contained, and reports it', () => {
    // A pair naming a surface absent from the inventory is silently dropped by `gold build`.
    // Reporting it here is what catches registry/raw-unified drift instead of hiding it.
    const result = registryPairs(
      { entities: { HackerGroup: { Sandworm: 'Sandworm', APT44: 'Sandworm', UNC1151: 'Sandworm' } } },
      ctx([['HackerGroup', 'Sandworm'], ['HackerGroup', 'APT44']])
    );
    assert.equal(result.pairs.length, 1);
    assert.deepEqual(result.droppedKeys, [{ category: 'HackerGroup', surface: 'UNC1151' }]);
  });

  it('drops a surface that exists only under a different category', () => {
    // `TOR` is a registry Software key while the inventory has it elsewhere. Categories are
    // separate annotation universes, so a cross-category match is not a match.
    const result = registryPairs(
      { entities: { Software: { TOR: 'Tor', 'Tor Browser': 'Tor' } } },
      ctx([['Software', 'Tor Browser'], ['Infrastructure', 'TOR']])
    );
    assert.equal(result.pairs.length, 0);
    assert.deepEqual(result.droppedKeys, [{ category: 'Software', surface: 'TOR' }]);
  });

  it('honours skipCategories, so Domain stays excluded for both proposers', () => {
    const registry = { entities: { Domain: { 'a.evil.in': 'evil.in', 'evil.in': 'evil.in' } } };
    const inv = ctx([['Domain', 'a.evil.in'], ['Domain', 'evil.in']]);
    assert.equal(registryPairs(registry, inv).pairs.length, 1);
    assert.equal(registryPairs(registry, inv, { skipCategories: ['Domain'] }).pairs.length, 0);
  });

  it('keeps the string stratum when a mechanism fires', () => {
    const result = registryPairs(
      {
        entities: {
          HackerGroup: { 'UAC-0010': 'Armageddon', 'UAC-0010 (Armageddon)': 'Armageddon' },
        },
      },
      ctx([['HackerGroup', 'UAC-0010'], ['HackerGroup', 'UAC-0010 (Armageddon)']])
    );
    assert.equal(result.pairs[0].stratum, 'a');
    assert.equal(result.pairs[0].mechanism, 'identifier');
  });

  it('assigns provisional stratum c when no string mechanism fires', () => {
    // The registry cannot tell semantic-known from semantic-novel, so `c` is a starting point
    // the annotator promotes or demotes — never a finding.
    const result = registryPairs(
      { entities: { HackerGroup: { Sandworm: 'Sandworm', APT44: 'Sandworm' } } },
      ctx([['HackerGroup', 'Sandworm'], ['HackerGroup', 'APT44']])
    );
    assert.equal(result.pairs[0].stratum, 'c');
    assert.equal(result.pairs[0].mechanism, 'registry');
    assert.equal(result.pairs[0].sim, 0);
  });

  it('emits one row per folded pair when the registry holds case variants of a surface', () => {
    // The registry keys `CloudFlare` and `Cloudflare` separately; the inventory folded them into
    // one surface. Without deduplication that group yields two rows for the same pair, and the
    // annotator adjudicates the same question twice — with no guarantee of the same answer.
    const result = registryPairs(
      {
        entities: {
          Organization: {
            CloudFlare: 'Cloudflare',
            Cloudflare: 'Cloudflare',
            'Cloudflare Inc.': 'Cloudflare',
          },
        },
      },
      ctx([['Organization', 'Cloudflare'], ['Organization', 'Cloudflare Inc.']])
    );
    assert.equal(result.pairs.length, 1);
  });

  it('proposes, never labels', () => {
    const result = registryPairs(
      { entities: { HackerGroup: { Sandworm: 'Sandworm', APT44: 'Sandworm' } } },
      ctx([['HackerGroup', 'Sandworm'], ['HackerGroup', 'APT44']])
    );
    assert.equal(result.pairs[0].label, '');
    assert.equal(result.pairs[0].evidence, '');
  });

  describe('relation classification (reporting only)', () => {
    const relationOf = (category: string, left: string, right: string) => {
      const result = registryPairs(
        { entities: { [category]: { [left]: 'canon', [right]: 'canon' } } },
        ctx([[category, left], [category, right]])
      );
      return result.pairs[0].relation;
    };

    it('calls a host under its domain part-of', () => {
      assert.equal(relationOf('Domain', 'admin.certifiedauth.in', 'certifiedauth.in'), 'part-of');
    });

    it('calls two hosts under one domain siblings', () => {
      assert.equal(
        relationOf('Domain', 'admin.certifiedauth.in', 'analytics.certifiedauth.in'),
        'sibling'
      );
    });

    it('calls a version of a product instance-of', () => {
      assert.equal(relationOf('Software', 'Microsoft Office', 'Microsoft Office 2016'), 'instance-of');
    });

    it('leaves a genuine coreference merge unclassified', () => {
      assert.equal(relationOf('Organization', 'Cloudflare', 'Cloudflare Inc.'), 'unclassified');
    });
  });

  describe('parseRegistry', () => {
    it('accepts a well-formed registry', () => {
      const registry = parseRegistry({ entities: { HackerGroup: { APT44: 'Sandworm' } } });
      assert.equal(registry.entities.HackerGroup.APT44, 'Sandworm');
    });

    it('rejects a registry with no entities object', () => {
      // Silently yielding zero clusters would look like a working run that found nothing.
      assert.throws(() => parseRegistry({ HackerGroup: { APT44: 'Sandworm' } }), /entities/);
    });

    it('rejects a canonical that is not a string', () => {
      assert.throws(
        () => parseRegistry({ entities: { HackerGroup: { APT44: ['Sandworm'] } } }),
        /must map to a string/
      );
    });
  });

  describe('unionProposals', () => {
    const stringPair = {
      category: 'HackerGroup',
      left: 'UAC-0010',
      right: 'UAC-0010 (Armageddon)',
      stratum: 'a' as const,
      mechanism: 'identifier',
      sim: 0.8,
      label: '' as const,
      evidence: '' as const,
    };

    it('marks a pair both proposers found as registry+string, keeping the string stratum', () => {
      const merged = unionProposals(
        [stringPair],
        [{ ...stringPair, stratum: 'c' as const, mechanism: 'registry', sim: 0, canonical: 'Armageddon', relation: 'unclassified' as const }]
      );
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'registry+string');
      assert.equal(merged[0].stratum, 'a', 'the mechanism that explains the pair wins');
      assert.equal(merged[0].mechanism, 'identifier');
      assert.equal(merged[0].canonical, 'Armageddon', 'the registry canonical is still shown');
    });

    it('deduplicates regardless of how each proposer ordered the pair', () => {
      // The proposers order a pair by raw spelling, and they do not always hold the same spelling:
      // the inventory keeps the first-seen casing, the registry keeps its own. `Zebra` sorts before
      // `apple` while `Apple` sorts before `zebra`, so an order-sensitive key would let the same
      // question into the worksheet twice.
      const merged = unionProposals(
        [{ category: 'X', left: 'Apple', right: 'zebra', stratum: 'a' as const, mechanism: 'edit-similarity', sim: 0.8, label: '' as const, evidence: '' as const }],
        [{ category: 'X', left: 'Zebra', right: 'apple', stratum: 'c' as const, mechanism: 'registry', sim: 0, label: '' as const, evidence: '' as const, canonical: 'Fruit', relation: 'unclassified' as const }]
      );
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'registry+string');
    });

    it('keeps a string-only pair as string-sourced', () => {
      const merged = unionProposals([stringPair], []);
      assert.equal(merged[0].source, 'string');
      assert.equal(merged[0].canonical, undefined);
    });

    it('appends a registry-only pair with its canonical', () => {
      const merged = unionProposals(
        [],
        [{ category: 'HackerGroup', left: 'APT44', right: 'Sandworm', stratum: 'c' as const, mechanism: 'registry', sim: 0, label: '' as const, evidence: '' as const, canonical: 'Sandworm', relation: 'unclassified' as const }]
      );
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'registry');
      assert.equal(merged[0].stratum, 'c');
    });

    const embeddingPair = (left: string, right: string, cos = 0.85) => ({
      category: 'HackerGroup',
      left,
      right,
      stratum: 'c',
      mechanism: 'embedding',
      sim: cos,
      label: '' as const,
      evidence: '' as const,
      cos,
    });

    it('appends an embedding-only pair with source embedding', () => {
      const merged = unionProposals([], [], [embeddingPair('Fancy Bear', 'Sofacy')]);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'embedding');
      assert.equal(merged[0].mechanism, 'embedding');
    });

    it('merges a string+embedding pair under the string fields', () => {
      const merged = unionProposals(
        [stringPair],
        [],
        [embeddingPair('UAC-0010', 'UAC-0010 (Armageddon)')]
      );
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'embedding+string');
      assert.equal(merged[0].mechanism, 'identifier', 'the mechanism that explains the pair wins');
      assert.equal(merged[0].sim, 0.8);
    });

    it('merges a registry+embedding pair under the registry fields, keeping the canonical', () => {
      const merged = unionProposals(
        [],
        [{ category: 'HackerGroup', left: 'APT44', right: 'Sandworm', stratum: 'c' as const, mechanism: 'registry', sim: 0, label: '' as const, evidence: '' as const, canonical: 'Sandworm', relation: 'unclassified' as const }],
        [embeddingPair('APT44', 'Sandworm')]
      );
      assert.equal(merged.length, 1);
      assert.equal(merged[0].source, 'embedding+registry');
      assert.equal(merged[0].mechanism, 'registry');
      assert.equal(merged[0].canonical, 'Sandworm');
    });
  });

  it('summarises by category and relation', () => {
    const result = registryPairs(
      {
        entities: {
          Domain: { 'a.evil.in': 'evil.in', 'b.evil.in': 'evil.in', 'evil.in': 'evil.in' },
        },
      },
      ctx([['Domain', 'a.evil.in'], ['Domain', 'b.evil.in'], ['Domain', 'evil.in']])
    );
    const summary = registryPairsSummary(result.pairs);
    assert.deepEqual(
      summary.find((row) => row.relation === 'part-of'),
      { category: 'Domain', relation: 'part-of', pairs: 2 }
    );
    assert.deepEqual(
      summary.find((row) => row.relation === 'sibling'),
      { category: 'Domain', relation: 'sibling', pairs: 1 }
    );
  });
});

describe('closeIntoClusters with rung and rename labels', () => {
  const inv = inventory([
    ['HackerGroup', 'UAC-0002', [1]],
    ['HackerGroup', 'Sandworm', [2]],
    ['HackerGroup', 'APT44', [3]],
  ]);

  it('never merges a rung pair — cross-granularity co-reference is an edge, not an identity', () => {
    const { clusters, conflicts } = closeIntoClusters(
      [
        {
          category: 'HackerGroup',
          left: 'UAC-0002',
          right: 'Sandworm',
          label: 'rung',
          relation: 'part-of',
          direction: 'left',
          stratum: 'c',
        },
      ],
      inv
    );
    assert.equal(clusters.length, 0, 'a rung verdict creates no cluster');
    assert.equal(conflicts.length, 0);
  });

  it('never merges a rename pair — a rename is not an alias', () => {
    const { clusters } = closeIntoClusters(
      [
        {
          category: 'HackerGroup',
          left: 'APT44',
          right: 'Sandworm',
          label: 'rename',
          relation: 'renamed-to',
          direction: 'right',
          stratum: 'c',
        },
      ],
      inv
    );
    assert.equal(clusters.length, 0);
  });

  it('reports a rung pair whose endpoints a same-chain merged as a conflict', () => {
    // If UAC-0002 and Sandworm are one cluster via `same` verdicts, a rung verdict between them
    // contradicts the annotation: one node cannot sit on two rungs of itself.
    const { conflicts } = closeIntoClusters(
      [
        { category: 'HackerGroup', left: 'UAC-0002', right: 'Sandworm', label: 'same', stratum: 'c' },
        {
          category: 'HackerGroup',
          left: 'UAC-0002',
          right: 'Sandworm',
          label: 'rung',
          relation: 'part-of',
          direction: 'left',
          stratum: 'c',
        },
      ],
      inv
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].label, 'rung');
  });
});

describe('preLabel with embedding provenance', () => {
  const embPair = (
    left: string,
    right: string,
    overrides: Partial<WorksheetPair> = {}
  ): WorksheetPair => ({
    category: 'HackerGroup',
    left,
    right,
    stratum: 'c',
    mechanism: 'embedding',
    sim: 0.82,
    label: '',
    evidence: '',
    source: 'embedding',
    ...overrides,
  });

  it('re-attributes an embedding-only row that no string rule claims', () => {
    // `one-sided-digits` would fire on APT44/Sandworm-like rows and offer an explanation that
    // explains nothing; embedding-only rows get their own rule, exactly like registry-semantic.
    const [labelled] = preLabel([embPair('Fancy Bear', 'Sofacy')]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'embedding-neighbour');
  });

  it('keeps the string rule that claimed an embedding-corroborated pair', () => {
    const [labelled] = preLabel([
      embPair('Cobalt Strike', 'Cobalt-Strike', { category: 'Software', stratum: 'a' }),
    ]);
    assert.equal(labelled.rule, 'punctuation-only');
    assert.equal(labelled.suggested, 'same');
  });

  it('does not soften differing-digits for an embedding neighbour', () => {
    // A registry row softens `different` to review because the registry asserted a merge. An
    // embedding neighbour asserts nothing but proximity, so there is no conflict to surface.
    const [labelled] = preLabel([
      embPair('UAC-0010', 'UAC-0018', { stratum: 'a' }),
    ]);
    assert.equal(labelled.suggested, 'different');
    assert.equal(labelled.rule, 'differing-digits');
  });

  it('treats registry+string exactly like the legacy both value', () => {
    const [labelled] = preLabel([
      embPair('Microsoft Office 2010', 'Microsoft Office 2016', {
        category: 'Software',
        stratum: 'a',
        mechanism: 'edit-similarity',
        source: 'registry+string',
      }),
    ]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'registry-conflict');
  });

  it('lets registry guidance win on a registry+embedding row', () => {
    // Both proposers are non-string, but the registry one carries the stratum instructions the
    // annotator needs — registry-semantic explains what to do with the row.
    const [labelled] = preLabel([embPair('APT44', 'Sandworm', { source: 'embedding+registry' })]);
    assert.equal(labelled.suggested, 'review');
    assert.equal(labelled.rule, 'registry-semantic');
  });
});

describe('worksheet v2', () => {
  const row = (overrides: Partial<WorksheetRow> = {}): WorksheetRow => ({
    category: 'HackerGroup',
    left: 'UAC-0002',
    right: 'Sandworm',
    stratum: 'c',
    mechanism: 'registry',
    sim: 0,
    label: '',
    evidence: '',
    suggested: 'review',
    rule: 'registry-semantic',
    source: 'registry',
    ...overrides,
  });

  it('round-trips the four labels with relation and direction', () => {
    const parsed = fromTsv(
      toTsv([row({ label: 'rung', relation: 'part-of', direction: 'left' })])
    );
    assert.equal(parsed.pairs.length, 1);
    assert.equal(parsed.pairs[0].label, 'rung');
    assert.equal(parsed.pairs[0].relation, 'part-of');
    assert.equal(parsed.pairs[0].direction, 'left');
  });

  it('parses the 12-column v1 worksheet unchanged', () => {
    const tsv =
      'label\tsuggested\trule\tsource\tcategory\tleft\tright\tstratum\tmechanism\tsim\tcanonical\tevidence\n' +
      'same\tsame\tcross-script\tboth\tCountry\tIndia\tІндія\tb\ttransliteration\t0\tIndia\t\n';
    const parsed = fromTsv(tsv);
    assert.equal(parsed.pairs.length, 1);
    assert.equal(parsed.pairs[0].label, 'same');
    assert.equal(parsed.pairs[0].source, 'registry+string', 'legacy both normalizes to the v2 spelling');
  });

  it('rejects a rung label without a relation, naming the line', () => {
    const bad = toTsv([row({ label: 'rung', direction: 'left' })]);
    assert.throws(() => fromTsv(bad), /line 2.*relation/);
  });

  it('rejects a rename label without a direction, naming the line', () => {
    const bad = toTsv([row({ label: 'rename', relation: 'renamed-to' })]);
    assert.throws(() => fromTsv(bad), /line 2.*direction/);
  });

  it('counts corrections against the ensemble verdict when one is present', () => {
    const parsed = fromTsv(
      toTsv([
        row({ label: 'different', ensemble: 'same', agreement: 'agree', suggested: 'review' }),
        row({ left: 'A', right: 'B', label: 'same', ensemble: 'same', suggested: 'review' }),
      ])
    );
    assert.equal(parsed.corrected, 1, 'only the row where the human overrode the ensemble counts');
  });

  it('readRows keeps unlabelled rows and round-trips the file byte-identically', () => {
    const tsv = toTsv([
      row(),
      row({ left: 'APT44', right: 'Sandworm', label: 'rename', relation: 'renamed-to', direction: 'left', queue: 1, ensemble: 'rename:renamed-to:left', agreement: 'agree', claudeVerdict: 'rename:renamed-to:left', gptVerdict: 'rename:renamed-to:left', snippet: '[doc 3] …', llmRationale: 'stated rename', evidence: '[doc 3] "Sandworm (now APT44)"' }),
    ]);
    const rows = readRows(tsv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].label, '');
    assert.equal(toTsv(rows), tsv);
  });
});

describe('crossCategorySurfaces', () => {
  it('reports surfaces the extractor filed under more than one category', () => {
    // The SKEIN deck's "upstream category noise" threat: `Sandworm` as HackerGroup in one document
    // and Organization in another silos into two annotation universes and no within-category pair
    // can ever connect them. The statistic makes the exposure visible in the pairs report.
    const inv = inventory([
      ['HackerGroup', 'Sandworm', [1]],
      ['Organization', 'Sandworm', [2]],
      ['Software', 'Tool', [3]],
    ]);
    const rows = crossCategorySurfaces(inv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].surface, 'Sandworm');
    assert.deepEqual(rows[0].categories, ['HackerGroup', 'Organization']);
  });

  it('folds case when matching surfaces across categories', () => {
    const inv = inventory([
      ['HackerGroup', 'SANDWORM', [1]],
      ['Organization', 'Sandworm', [2]],
    ]);
    assert.equal(crossCategorySurfaces(inv).length, 1);
  });
});
