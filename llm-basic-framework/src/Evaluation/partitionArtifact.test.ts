import { elementKey, fromBatchEntitiesMap, type BatchEntitiesFile } from './partition';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Characterisation tests against the committed published Ψ_norm artifact.
 *
 * This is the only artifact E1 can be scored from, so the partition built from it must be
 * reproducible and its shape known before any comparison is drawn. These numbers are recorded
 * here so a future change to `fromBatchEntitiesMap` — or to the artifact — fails loudly instead
 * of silently shifting the E1 baseline.
 */

const ARTIFACT = path.resolve(
  __dirname,
  '../../../storage/cert.gov.ua/processed/entities-unified/gpt-5/entities.json'
);

const available = existsSync(ARTIFACT);
const load = (): BatchEntitiesFile => JSON.parse(readFileSync(ARTIFACT, 'utf8'));

const surfaceElements = (file: BatchEntitiesFile): Set<string> => {
  const elements = new Set<string>();
  for (const [category, mapping] of Object.entries(file.entities)) {
    for (const surface of Object.keys(mapping)) elements.add(elementKey(category, surface));
  }
  return elements;
};

test('the published artifact holds 3,392 (surface, category) pairs in 10 categories', { skip: !available }, () => {
  const file = load();
  const categories = Object.keys(file.entities);
  const pairs = categories.reduce((sum, category) => sum + Object.keys(file.entities[category]).length, 0);
  assert.equal(categories.length, 10);
  assert.equal(pairs, 3392, 'matches the frozen input inventory');
});

test('case folding merges 32 surface pairs but changes no cluster', { skip: !available }, () => {
  const file = load();
  // 3,392 raw pairs collapse to 3,360 case-folded element keys: 31 collision groups, one of
  // which has three variants (e.g. Organization "CloudFlare"/"Cloudflare").
  assert.equal(surfaceElements(file).size, 3360);

  // The collapsed variants already mapped to the same normalized name, so cluster count is
  // identical either way. Recorded because a *different* answer would mean case folding is
  // silently doing merge work that the published algorithm did not do.
  const folded = fromBatchEntitiesMap(file).restrictTo(surfaceElements(file));
  assert.equal(folded.size, 2673);
});

test('the artifact yields 2,673 clusters — one fewer than the published 2,674', { skip: !available }, () => {
  const file = load();
  const partition = fromBatchEntitiesMap(file).restrictTo(surfaceElements(file));

  // turskyi2025formal reports 2,674 canonical nodes. Rebuilding the partition from the released
  // artifact gives 2,673, case-sensitively and case-insensitively alike. The one-node gap is not
  // explained by case folding and is not reproducible from this file; E1 must therefore report
  // the figure it can derive (2,673) and note the discrepancy rather than quote 2,674.
  assert.equal(partition.size, 2673);
  assert.equal(partition.elementCount, 3360);
});

test('most clusters are singletons — the reduction is concentrated in a few big ones', { skip: !available }, () => {
  const file = load();
  const partition = fromBatchEntitiesMap(file).restrictTo(surfaceElements(file));
  const sizes = partition.clusters.map((cluster) => cluster.members.length).sort((a, b) => b - a);

  assert.equal(sizes.filter((size) => size === 1).length, 2411, 'singletons');
  assert.equal(sizes.filter((size) => size > 1).length, 262, 'clusters that merged anything');
  assert.equal(sizes[0], 60, 'largest cluster');
  // Pairwise metrics are dominated by these few clusters: 4,967 same-cluster pairs in total, so a
  // single wrong merge inside the 60-member cluster moves pairwise precision far more than a
  // wrong merge among singletons. Reported per stratum for exactly this reason.
  assert.equal(partition.pairCount(), 4967);
});

test('every surface form maps into exactly one cluster', { skip: !available }, () => {
  const file = load();
  const elements = surfaceElements(file);
  const partition = fromBatchEntitiesMap(file).restrictTo(elements);
  for (const element of elements) {
    assert.notEqual(partition.clusterIdOf(element), undefined, `${element} unassigned`);
  }
});
