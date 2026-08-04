import { buildCategoryViews, renderRegistryHtml } from './registryView';
import type { GoldTable } from '../Evaluation/gold';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const table = (overrides: Partial<GoldTable> = {}): GoldTable => ({
  version: 'gold-aliases-v2',
  inputContentHash: 'hash',
  order: 'numeric-id',
  clusters: [
    { id: 'g1', category: 'HackerGroup', members: ['UAC-0002'], stratum: 'c', split: 'test' },
    { id: 'g2', category: 'HackerGroup', members: ['Sandworm', 'Voodoo Bear'], stratum: 'c', split: 'test', sources: ['registry'] },
    { id: 'g3', category: 'HackerGroup', members: ['APT44'], stratum: 'c', split: 'test' },
    { id: 'g4', category: 'HackerGroup', members: ['Turla'], stratum: 'a', split: 'test' },
    { id: 'g5', category: 'Software', members: ['Office 2016', 'MS Office 2016'], stratum: 'a', split: 'dev' },
  ],
  edges: [
    { category: 'HackerGroup', from: 'UAC-0002', to: 'Sandworm', kind: 'part-of', fromClusterId: 'g1', toClusterId: 'g2' },
    { category: 'HackerGroup', from: 'Sandworm', to: 'APT44', kind: 'renamed-to', fromClusterId: 'g2', toClusterId: 'g3' },
  ],
  nilLabels: [],
  ...overrides,
});

describe('buildCategoryViews', () => {
  it('places finer clusters under their coarser parent', () => {
    const views = buildCategoryViews(table());
    const hg = views.find((v) => v.category === 'HackerGroup')!;
    const root = hg.trees.find((t) => t.cluster.id === 'g2')!;
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].cluster.id, 'g1');
    assert.equal(root.children[0].edge!.kind, 'part-of');
  });

  it('keeps renames out of the hierarchy and reports them as links', () => {
    const views = buildCategoryViews(table());
    const hg = views.find((v) => v.category === 'HackerGroup')!;
    assert.equal(hg.renames.length, 1);
    assert.equal(hg.renames[0].edge.kind, 'renamed-to');
    assert.ok(!hg.trees.some((t) => t.cluster.id === 'g3' && t.children.length > 0));
  });

  it('lists merged clusters outside any hierarchy separately and counts singletons', () => {
    const views = buildCategoryViews(table());
    const sw = views.find((v) => v.category === 'Software')!;
    assert.deepEqual(sw.flatMerged.map((c) => c.id), ['g5']);
    const hg = views.find((v) => v.category === 'HackerGroup')!;
    assert.deepEqual(hg.singletons.map((c) => c.id), ['g4'], 'g1/g3 are in the hierarchy, g4 is a true singleton');
  });

  it('renders a multi-parent cluster under each parent, marked as repeated', () => {
    const t = table({
      edges: [
        { category: 'HackerGroup', from: 'UAC-0002', to: 'Sandworm', kind: 'part-of', fromClusterId: 'g1', toClusterId: 'g2' },
        { category: 'HackerGroup', from: 'UAC-0002', to: 'APT44', kind: 'part-of', fromClusterId: 'g1', toClusterId: 'g3' },
      ],
    });
    const hg = buildCategoryViews(t).find((v) => v.category === 'HackerGroup')!;
    const appearances = hg.trees.flatMap((root) => root.children).filter((c) => c.cluster.id === 'g1');
    assert.equal(appearances.length, 2);
    assert.equal(appearances.filter((a) => a.repeated).length, 1, 'second appearance is marked');
  });

  it('survives an edge cycle without hanging', () => {
    const t = table({
      edges: [
        { category: 'HackerGroup', from: 'UAC-0002', to: 'Sandworm', kind: 'part-of', fromClusterId: 'g1', toClusterId: 'g2' },
        { category: 'HackerGroup', from: 'Sandworm', to: 'UAC-0002', kind: 'part-of', fromClusterId: 'g2', toClusterId: 'g1' },
      ],
    });
    const hg = buildCategoryViews(t).find((v) => v.category === 'HackerGroup')!;
    assert.ok(hg.trees.length > 0, 'cycle participants still render somewhere');
  });
});

describe('renderRegistryHtml', () => {
  it('emits member names and escapes HTML-hostile characters', () => {
    const t = table({
      clusters: [
        { id: 'g1', category: 'Software', members: ['<script>alert(1)</script>', 'B & C'], stratum: 'a', split: 'test' },
      ],
      edges: [],
    });
    const html = renderRegistryHtml(t, { title: 'test' });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw member text is escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
    assert.ok(html.includes('B &amp; C'));
  });

  it('shows the edge kind as text, never colour alone', () => {
    const html = renderRegistryHtml(table(), { title: 'test' });
    assert.ok(html.includes('part-of'));
    assert.ok(html.includes('renamed-to'));
  });
});
