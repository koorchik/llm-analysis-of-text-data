import { validateGoldTable } from '../Evaluation/gold';
import {
  addSingletons,
  assignSplit,
  buildGoldTable,
  closeIntoClusters,
  deriveNilLabels,
  type AdjudicatedPair,
} from './buildTable';
import type { Inventory } from './inventory';
import { proposePairs } from './proposePairs';
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
