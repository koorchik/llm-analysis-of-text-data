import assert from 'node:assert/strict';
import test from 'node:test';

import { hierarchyMetrics, mapCanonicalsToGold, readRegistryHierarchy } from './hierarchyMetrics';

const goldClusters = [
  { id: 'g1', category: 'Software', members: ['Microsoft Office', 'MS Office'] },
  { id: 'g2', category: 'Software', members: ['Microsoft Office 2010', 'Office 2010'] },
  { id: 'g3', category: 'Software', members: ['MS Word'] },
];

const goldEdges = [
  { category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'isa', fromClusterId: 'g2', toClusterId: 'g1' },
  { category: 'Software', from: 'MS Word', to: 'MS Office', kind: 'part-of', fromClusterId: 'g3', toClusterId: 'g1' },
];

const canonicals = [
  { category: 'Software', canonical: 'MS Office', surfaces: ['MS Office', 'Microsoft Office'] },
  { category: 'Software', canonical: 'Office 2010', surfaces: ['Office 2010', 'Microsoft Office 2010'] },
  { category: 'Software', canonical: 'MS Word', surfaces: ['MS Word'] },
];

test('a canonical maps to the gold cluster its surfaces belong to', () => {
  const mapped = mapCanonicalsToGold(canonicals, goldClusters);
  assert.equal(mapped.get('software|MS Office'), 'g1');
  assert.equal(mapped.get('software|Office 2010'), 'g2');
});

test('edges are scored between clusters, so the rung vocabulary does not matter', () => {
  // `coarsens-to` is the registry's word for what gold annotated as `isa`.
  const metrics = hierarchyMetrics({
    predictedEdges: [{ category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'coarsens-to' }],
    registryCanonicals: canonicals,
    goldClusters,
    goldEdges,
  });
  assert.equal(metrics.matched, 1);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 0.5, 'one of the two gold edges');
  assert.equal(metrics.kindAgreement, 1, 'coarsens-to folds onto isa');
});

test('an edge inside one gold cluster is collapsed, not a precision miss', () => {
  // "Microsoft Office is a part of MS Office" — the judge expressed a merge as a parent link. That
  // is a different defect from claiming a wrong hierarchy, so it must not dilute edge precision.
  const metrics = hierarchyMetrics({
    predictedEdges: [
      { category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'coarsens-to' },
      { category: 'Software', from: 'Microsoft Office', to: 'MS Office', kind: 'part-of' },
    ],
    registryCanonicals: [...canonicals, { category: 'Software', canonical: 'Microsoft Office', surfaces: ['Microsoft Office'] }],
    goldClusters,
    goldEdges,
  });
  assert.equal(metrics.collapsed, 1);
  assert.equal(metrics.predicted, 1, 'the collapsed edge is not counted as a hierarchy claim');
  assert.equal(metrics.precision, 1);
});

test('skipping an intermediate rung earns transitive credit but not an exact match', () => {
  const chainClusters = [
    { id: 'c1', category: 'Software', members: ['Office 2010'] },
    { id: 'c2', category: 'Software', members: ['Office'] },
    { id: 'c3', category: 'Software', members: ['Productivity suite'] },
  ];
  const chainGold = [
    { category: 'Software', from: 'Office 2010', to: 'Office', kind: 'isa', fromClusterId: 'c1', toClusterId: 'c2' },
    { category: 'Software', from: 'Office', to: 'Productivity suite', kind: 'isa', fromClusterId: 'c2', toClusterId: 'c3' },
  ];
  const metrics = hierarchyMetrics({
    predictedEdges: [{ category: 'Software', from: 'Office 2010', to: 'Productivity suite', kind: 'isa' }],
    registryCanonicals: [
      { category: 'Software', canonical: 'Office 2010', surfaces: ['Office 2010'] },
      { category: 'Software', canonical: 'Productivity suite', surfaces: ['Productivity suite'] },
    ],
    goldClusters: chainClusters,
    goldEdges: chainGold,
  });
  assert.equal(metrics.matched, 0);
  assert.equal(metrics.matchedTransitive, 1);
});

test('reachable recall only counts gold edges whose endpoints exist in the run', () => {
  const metrics = hierarchyMetrics({
    predictedEdges: [{ category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'coarsens-to' }],
    // MS Word never appeared in this run, so its gold edge was not available to find.
    registryCanonicals: canonicals.filter((entry) => entry.canonical !== 'MS Word'),
    goldClusters,
    goldEdges,
  });
  assert.equal(metrics.goldTotal, 2);
  assert.equal(metrics.goldReachable, 1);
  assert.equal(metrics.recall, 0.5);
  assert.equal(metrics.recallReachable, 1);
});

test('readRegistryHierarchy reads canonicals and edges out of a v3 registry, lifted to v6 vocabulary', () => {
  const { canonicals: read, edges } = readRegistryHierarchy({
    version: 3,
    canonicalPolicy: 'first-seen',
    categories: { Software: { 'MS Office': { aliases: [{ surface: 'MS Office' }, { surface: 'Microsoft Office' }], firstSeen: { doc: 1, date: '' } } } },
    granularityEdges: { Software: [{ from: 'Office 2010', to: 'MS Office', kind: 'coarsens-to', docId: 1, decision: 'judge' }] },
    renameEdges: {},
    deferQueue: [],
  });
  assert.deepEqual(read, [
    { category: 'Software', canonical: 'MS Office', surfaces: ['MS Office', 'Microsoft Office'] },
  ]);
  assert.deepEqual(edges, [
    // Legacy `coarsens-to` carried no finer reading, so it lifts onto an UNTYPED skos:broader.
    { category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'untyped' },
  ]);
});

test('readRegistryHierarchy scores v6 typed edges through the ISO 25964 vocabulary', () => {
  const { edges } = readRegistryHierarchy({
    version: 6,
    canonicalPolicy: 'first-seen',
    conceptSchemes: {
      Software: {
        'MS Office': { labels: [{ surface: 'MS Office', docId: 1, decision: 'mint' }], firstSeen: { doc: 1, date: '' } },
        'Office 2010': { labels: [{ surface: 'Office 2010', docId: 1, decision: 'mint' }], firstSeen: { doc: 1, date: '' } },
      },
    },
    broaderEdges: {
      Software: [
        { narrower: 'Office 2010', broader: 'MS Office', type: 'broaderInstantial', docId: 1, decision: 'judge' },
      ],
    },
    renameEdges: {},
    deferQueue: [],
    repair: { adjudicated: [], spillover: [], repairedThrough: -1 },
  });
  assert.deepEqual(edges, [
    { category: 'Software', from: 'Office 2010', to: 'MS Office', kind: 'broaderInstantial' },
  ]);
});
