import type { DecisionEvent } from '../DecisionLog/DecisionLog';
import {
  Partition,
  elementKey,
  fromBatchEntitiesMap,
  fromDecisionEvents,
  fromGoldClusters,
  fromRegistry,
  pairKey,
  sharedElements,
} from './partition';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const shape = (partition: Partition): string[][] =>
  partition.clusters
    .map((cluster) => [...cluster.members].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('elementKey lowercases and trims, and can drop the category', () => {
  assert.equal(elementKey('HackerGroup', '  APT28 '), 'hackergroup|apt28');
  assert.equal(elementKey('HackerGroup', 'APT28', { includeCategory: false }), 'apt28');
});

test('the same surface under two categories is two distinct elements', () => {
  // Confirmed in the corpus: `atera` is both Organization and Software in doc 6280099.
  assert.notEqual(elementKey('Organization', 'atera'), elementKey('Software', 'atera'));
});

test('Partition rejects an element in two clusters', () => {
  assert.throws(
    () => Partition.fromGroups([['a', 'b'], ['b', 'c']]),
    /appears in clusters/
  );
});

test('pairKeys and pairCount agree, and count C(n,2) per cluster', () => {
  const partition = Partition.fromGroups([['a', 'b', 'c'], ['d', 'e'], ['f']]);
  // C(3,2)=3, C(2,2)=1, C(1,2)=0 → 4
  assert.equal(partition.pairCount(), 4);
  assert.equal(partition.pairKeys().size, 4);
  assert.ok(partition.pairKeys().has(pairKey('a', 'b')));
  assert.equal(partition.pairKeys().has(pairKey('a', 'd')), false);
});

test('pairKey is order-independent', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
});

test('pairKey cannot confuse pairs whose elements contain spaces', () => {
  // A space-joined key would make these two distinct pairs collide, silently conflating them in
  // every pairwise metric. Element keys really do contain spaces: `hackergroup|fancy bear`.
  assert.notEqual(pairKey('x y', 'z'), pairKey('x', 'y z'));
});

test('restrictTo drops unlisted elements and now-empty clusters', () => {
  const partition = Partition.fromGroups([['a', 'b'], ['c', 'd'], ['e']]);
  const restricted = partition.restrictTo(['a', 'b', 'c']);
  assert.deepEqual(shape(restricted), [['a', 'b'], ['c']]);
  assert.equal(restricted.size, 2);
});

// --- Source 1: registry -----------------------------------------------------------------------

test('fromRegistry builds one cluster per canonical, canonical included as a member', () => {
  const partition = fromRegistry({
    HackerGroup: {
      APT28: { aliases: ['APT28', 'Fancy Bear', 'Sofacy'] },
      Sandworm: { aliases: ['Sandworm'] },
    },
  });
  assert.deepEqual(shape(partition), [
    ['hackergroup|apt28', 'hackergroup|fancy bear', 'hackergroup|sofacy'],
    ['hackergroup|sandworm'],
  ]);
});

test('fromRegistry reads the v2 alias-object shape too', () => {
  const partition = fromRegistry({
    version: 2,
    categories: {
      HackerGroup: {
        APT28: { aliases: [{ surface: 'APT28' }, { surface: 'Fancy Bear' }] },
      },
    },
  });
  assert.deepEqual(shape(partition), [['hackergroup|apt28', 'hackergroup|fancy bear']]);
});

test('fromRegistry reads any versioned registry, not only the exact version it was written for', () => {
  // SKEIN v2 shipped registry v3 (rungs, edge layers, deferQueue). A predicate pinned to
  // `version === 2` silently fell through to the v1 branch and read the WHOLE file as the
  // category map — turning `granularityEdges`/`deferQueue` into phantom clusters and leaving
  // the real ones unscored. Anything with a `categories` map must be read through it.
  const partition = fromRegistry({
    version: 3,
    canonicalPolicy: 'first-seen',
    categories: {
      HackerGroup: {
        APT28: { aliases: [{ surface: 'APT28' }, { surface: 'Fancy Bear' }] },
      },
    },
    granularityEdges: [{ category: 'HackerGroup', from: 'APT28', to: 'Russia', kind: 'part-of' }],
    renameEdges: [],
    deferQueue: [{ mention: 'UAC-0002', category: 'HackerGroup' }],
  } as never);

  assert.deepEqual(
    shape(partition),
    [['hackergroup|apt28', 'hackergroup|fancy bear']],
    'only the real category survives — edge layers are not clusters'
  );
});

// --- Source 2: gold ---------------------------------------------------------------------------

test('fromGoldClusters preserves gold cluster ids', () => {
  const partition = fromGoldClusters([
    { id: 'g0007', category: 'HackerGroup', members: ['APT28', 'Fancy Bear', 'УАЦ-0028'] },
  ]);
  assert.equal(partition.clusters[0].id, 'g0007');
  assert.equal(partition.clusters[0].members.length, 3);
});

// --- Source 3: decision log -------------------------------------------------------------------

const decision = (over: Partial<DecisionEvent>): DecisionEvent => ({
  mention: 'x',
  category: 'HackerGroup',
  docId: 1,
  candidates: [],
  decision: 'mint',
  target: 'x',
  ...over,
});

test('fromDecisionEvents groups a mint and a later link into one cluster', () => {
  const partition = fromDecisionEvents([
    decision({ mention: 'APT28', decision: 'mint', target: 'APT28', docId: 1 }),
    decision({ mention: 'Fancy Bear', decision: 'link', target: 'APT28', docId: 2 }),
  ]);
  assert.deepEqual(shape(partition), [['hackergroup|apt28', 'hackergroup|fancy bear']]);
});

test('fromDecisionEvents is order-independent', () => {
  const events = [
    decision({ mention: 'A', decision: 'mint', target: 'A' }),
    decision({ mention: 'B', decision: 'link', target: 'A' }),
    decision({ mention: 'C', decision: 'link', target: 'B' }),
  ];
  const forward = shape(fromDecisionEvents(events));
  const reverse = shape(fromDecisionEvents([...events].reverse()));
  assert.deepEqual(forward, [['hackergroup|a', 'hackergroup|b', 'hackergroup|c']]);
  assert.deepEqual(forward, reverse);
});

test('fromDecisionEvents skips defer — a withheld decision asserts no membership', () => {
  const partition = fromDecisionEvents([
    decision({ mention: 'A', decision: 'mint', target: 'A' }),
    decision({ mention: 'B', decision: 'defer', target: null }),
  ]);
  assert.deepEqual(shape(partition), [['hackergroup|a']]);
  assert.equal(partition.clusterIdOf('hackergroup|b'), undefined);
});

test('fromDecisionEvents keeps two categories of one mention apart', () => {
  const partition = fromDecisionEvents([
    decision({ mention: 'atera', category: 'Organization', target: 'Atera Networks', docId: 6280099 }),
    decision({ mention: 'atera', category: 'Software', target: 'Atera', docId: 6280099 }),
  ]);
  assert.equal(partition.size, 2);
  assert.equal(
    partition.sameCluster('organization|atera', 'software|atera'),
    false,
    'the two atera mentions must not be merged'
  );
});

// --- Source 4: batch entities.json ------------------------------------------------------------

test('fromBatchEntitiesMap groups surfaces sharing a normalized name', () => {
  const partition = fromBatchEntitiesMap({
    entities: {
      HackerGroup: {
        'Armageddon/Gamaredon': 'Armageddon',
        'UAC-0010 (Armageddon)': 'Armageddon',
        Armageddon: 'Armageddon',
        Sandworm: 'Sandworm',
      },
    },
  });
  assert.deepEqual(shape(partition), [
    [
      'hackergroup|armageddon',
      'hackergroup|armageddon/gamaredon',
      'hackergroup|uac-0010 (armageddon)',
    ],
    ['hackergroup|sandworm'],
  ]);
});

test('a canonical that is not a surface still connects, then drops under restrictTo', () => {
  // The batch arm invents English canonicals. "Microsoft Corporation" was never a surface form,
  // so it must not survive as an element — but it must first connect MSFT to Microsoft Corp.
  const partition = fromBatchEntitiesMap({
    entities: {
      Organization: {
        MSFT: 'Microsoft Corporation',
        'Microsoft Corp': 'Microsoft Corporation',
      },
    },
  });
  assert.equal(partition.elementCount, 3, 'phantom canonical present before restriction');

  const goldElements = ['organization|msft', 'organization|microsoft corp'];
  const restricted = partition.restrictTo(goldElements);
  assert.deepEqual(shape(restricted), [['organization|microsoft corp', 'organization|msft']]);
  assert.equal(restricted.elementCount, 2, 'phantom dropped');
  assert.equal(
    restricted.sameCluster('organization|msft', 'organization|microsoft corp'),
    true,
    'the connection it made survives its own removal'
  );
});

test('identity mapping yields singletons, not one big cluster', () => {
  const partition = fromBatchEntitiesMap({
    entities: { Country: { Ukraine: 'Ukraine', Poland: 'Poland' } },
  });
  assert.equal(partition.size, 2);
});

// --- comparison surface -----------------------------------------------------------------------

test('sharedElements is the intersection of the two universes', () => {
  const a = Partition.fromGroups([['x', 'y'], ['z']]);
  const b = Partition.fromGroups([['y', 'z', 'w']]);
  assert.deepEqual(sharedElements(a, b).sort(), ['y', 'z']);
});
