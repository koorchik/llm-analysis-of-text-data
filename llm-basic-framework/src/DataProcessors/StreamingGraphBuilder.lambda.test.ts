import { StreamingGraphBuilder, parseLambda } from './StreamingGraphBuilder';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';

/**
 * λ-fold and the five-row projection contract. The critical row: weight is a distinct-incident
 * count RECOMPUTED from artifacts (incidentIds set union), never summed up the ladder — summing
 * would make every λ-sensitivity number measure the aggregation bug instead of the granularity
 * effect.
 */

let counter = 0;
async function scratch(): Promise<string> {
  const key = crypto.createHash('sha256').update(`lambda${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `graph-lambda-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'graph'), { recursive: true });
  return dir;
}

interface EntitySpec {
  name: string;
  category: string;
  role: string;
}

async function writeArtifact(
  dir: string,
  id: number,
  entities: EntitySpec[],
  relations: Array<{ head: EntitySpec; type: string; tail: EntitySpec }>
) {
  await fs.writeFile(
    path.join(dir, 'artifacts', `${id}.json`),
    JSON.stringify({
      entities: entities.map((entity) => ({ ...entity, normalizedName: entity.name })),
      relations: relations.map((relation) => ({
        head: relation.head.name,
        headCategory: relation.head.category,
        type: relation.type,
        tail: relation.tail.name,
        tailCategory: relation.tail.category,
        normalizedHead: relation.head.name,
        normalizedTail: relation.tail.name,
      })),
      schemaProposals: { categories: [], relationTypes: [] },
      metadata: { id, date: `2024-01-${String(id).padStart(2, '0')}` },
    })
  );
}

const actor: EntitySpec = { name: 'Sandworm', category: 'HackerGroup', role: 'Attacker' };
const office2010: EntitySpec = { name: 'Office 2010', category: 'Software', role: 'Target' };
const office2013: EntitySpec = { name: 'Office 2013', category: 'Software', role: 'Target' };

async function seededRegistry(dir: string): Promise<EntityRegistry> {
  const registry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  registry.mint('Software', 'Office 2010', { doc: 1, date: '01.01.2024' });
  registry.mint('Software', 'Office 2013', { doc: 1, date: '01.01.2024' });
  registry.mint('Software', 'Microsoft Office', { doc: 1, date: '01.01.2024' });
  registry.setRung('Software', 'Office 2010', 'g1');
  registry.setRung('Software', 'Office 2013', 'g1');
  registry.setRung('Software', 'Microsoft Office', 'g2');
  registry.addGranularityEdge('Software', {
    from: 'Office 2010', to: 'Microsoft Office', kind: 'coarsens-to', docId: 1, decision: 'judge',
  });
  registry.addGranularityEdge('Software', {
    from: 'Office 2013', to: 'Microsoft Office', kind: 'coarsens-to', docId: 2, decision: 'judge',
  });
  await registry.save();
  return registry;
}

async function build(
  dir: string,
  registry: EntityRegistry,
  lambda: string | undefined,
  interpretive = false
) {
  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const builder = new StreamingGraphBuilder({
    inputDir: path.join(dir, 'artifacts'),
    outputDir: path.join(dir, 'graph'),
    schemaRegistry,
    entityRegistry: registry,
    edgesFrom: 'extracted',
    lambda: parseLambda(lambda),
    interpretive,
  });
  await builder.run();
  const nodes = (await fs.readFile(path.join(dir, 'graph', 'nodes.csv'), 'utf8')).trim().split('\n');
  const edges = (await fs.readFile(path.join(dir, 'graph', 'edges.csv'), 'utf8')).trim().split('\n');
  return { nodes, edges };
}

test('λ=g0 (default) folds nothing — the detailed view is the unfolded graph', async () => {
  const dir = await scratch();
  const registry = await seededRegistry(dir);
  await writeArtifact(dir, 1, [actor, office2010], [{ head: actor, type: 'attacks', tail: office2010 }]);

  const { nodes } = await build(dir, registry, undefined);
  assert.ok(nodes.some((line) => line.includes('"Office 2010"')), 'leaf survives at λ=g0');
  assert.ok(!nodes.some((line) => line.includes('"Microsoft Office"')), 'no rung node materialized');
});

test('default edge mode is extracted-only even when a legacy pair rule is present', async () => {
  const dir = await scratch();
  const registry = await seededRegistry(dir);
  await writeArtifact(dir, 1, [actor, office2010], []);

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  await schemaRegistry.load();
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  schemaRegistry.admitCategory({ name: 'Software', definition: '', doc: 0 });
  schemaRegistry.admitPairRule(
    {
      source: { category: 'HackerGroup', role: 'Attacker' },
      target: { category: 'Software', role: 'Target' },
      relation: 'attacks',
    },
    0
  );
  await schemaRegistry.save();

  const builder = new StreamingGraphBuilder({
    inputDir: path.join(dir, 'artifacts'),
    outputDir: path.join(dir, 'graph'),
    schemaRegistry,
    entityRegistry: registry,
  });
  await builder.run();

  const edges = (await fs.readFile(path.join(dir, 'graph', 'edges.csv'), 'utf8')).trim().split('\n');
  assert.equal(edges.length, 1, 'only the CSV header: default mode ignores legacy pair rules');
});

test('coarse λ folds coarsens-to and RECOMPUTES weight as distinct incidents, never a sum', async () => {
  const dir = await scratch();
  const registry = await seededRegistry(dir);
  // ONE incident mentions both versions as targets of the same actor: folding to the product must
  // give the family edge weight 1 (one incident), not 2 (two child edges).
  await writeArtifact(dir, 1, [actor, office2010, office2013], [
    { head: actor, type: 'attacks', tail: office2010 },
    { head: actor, type: 'attacks', tail: office2013 },
  ]);
  // A second incident hits only one version — total distinct incidents on the folded edge: 2.
  await writeArtifact(dir, 2, [actor, office2010], [{ head: actor, type: 'attacks', tail: office2010 }]);

  const { nodes, edges } = await build(dir, registry, 'Software=g2,default=g0');
  assert.ok(nodes.some((line) => line.includes('"Microsoft Office"')), 'folded to the product');
  assert.ok(!nodes.some((line) => line.includes('"Office 2010"')), 'leaves folded away');

  const attackEdges = edges.filter((line) => line.includes('"attacks"'));
  assert.equal(attackEdges.length, 1, 'one folded edge');
  const weight = Number(attackEdges[0].split(';')[2]);
  assert.equal(weight, 2, 'distinct-incident count (1 from doc1 + 1 from doc2), NOT 3 summed');
});

test('part-of folds only in an interpretive view, and every folded edge is marked inferred', async () => {
  const dir = await scratch();
  const registry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  registry.mint('GovernmentBody', 'Unit 74455', { doc: 1, date: '01.01.2024' });
  registry.mint('GovernmentBody', 'GRU', { doc: 1, date: '01.01.2024' });
  registry.setRung('GovernmentBody', 'Unit 74455', 'g0');
  registry.setRung('GovernmentBody', 'GRU', 'g1');
  registry.addGranularityEdge('GovernmentBody', {
    from: 'Unit 74455', to: 'GRU', kind: 'part-of', docId: 1, decision: 'judge',
  });
  await registry.save();

  const unit: EntitySpec = { name: 'Unit 74455', category: 'GovernmentBody', role: 'Attacker' };
  await writeArtifact(dir, 1, [actor, unit], [{ head: unit, type: 'attributed-to', tail: actor }]);

  // Non-interpretive: the widening edge does NOT fold.
  const plain = await build(dir, registry, 'GovernmentBody=g1,default=g0');
  assert.ok(plain.nodes.some((line) => line.includes('"Unit 74455"')), 'part-of stays unfolded by default');

  // Interpretive: it folds, and the touched edge is downgraded to inferred.
  const dir2 = await scratch();
  const registry2 = new EntityRegistry({ filePath: path.join(dir2, 'registry.json') });
  await registry2.load();
  registry2.mint('HackerGroup', 'Sandworm', { doc: 1, date: '01.01.2024' });
  registry2.mint('GovernmentBody', 'Unit 74455', { doc: 1, date: '01.01.2024' });
  registry2.mint('GovernmentBody', 'GRU', { doc: 1, date: '01.01.2024' });
  registry2.setRung('GovernmentBody', 'Unit 74455', 'g0');
  registry2.setRung('GovernmentBody', 'GRU', 'g1');
  registry2.addGranularityEdge('GovernmentBody', {
    from: 'Unit 74455', to: 'GRU', kind: 'part-of', docId: 1, decision: 'judge',
  });
  await registry2.save();
  await writeArtifact(dir2, 1, [actor, unit], [{ head: unit, type: 'attributed-to', tail: actor }]);

  const folded = await build(dir2, registry2, 'GovernmentBody=g1,default=g0', true);
  assert.ok(!folded.nodes.some((line) => line.includes('"Unit 74455"')), 'widened into the agency');
  assert.ok(folded.nodes.some((line) => line.includes('"GRU"')));
  const edge = folded.edges.find((line) => line.includes('"attributed-to"'));
  assert.ok(edge, 'edge survives the fold');
  assert.ok(edge!.includes(';inferred;'), 'attribution widening is an interpretation — inferred');

  const lambdaCard = JSON.parse(await fs.readFile(path.join(dir2, 'graph', 'lambda.json'), 'utf8'));
  assert.equal(lambdaCard.interpretive, true, 'the view labels itself interpretive');
});

test('a diamond resolves by the documented deterministic choice: oldest edge wins', async () => {
  const dir = await scratch();
  const registry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await registry.load();
  registry.mint('Software', 'Office 365', { doc: 1, date: '01.01.2024' });
  registry.mint('Software', 'Microsoft Office', { doc: 1, date: '01.01.2024' });
  registry.mint('Software', 'Hosted Services', { doc: 1, date: '01.01.2024' });
  registry.setRung('Software', 'Office 365', 'g1');
  registry.setRung('Software', 'Microsoft Office', 'g2');
  registry.setRung('Software', 'Hosted Services', 'g2');
  // Two eligible parents; the docId-5 edge is older than docId-9.
  registry.addGranularityEdge('Software', {
    from: 'Office 365', to: 'Hosted Services', kind: 'coarsens-to', docId: 5, decision: 'judge',
  });
  registry.addGranularityEdge('Software', {
    from: 'Office 365', to: 'Microsoft Office', kind: 'coarsens-to', docId: 9, decision: 'judge',
  });
  await registry.save();

  const o365: EntitySpec = { name: 'Office 365', category: 'Software', role: 'Target' };
  await writeArtifact(dir, 1, [actor, o365], [{ head: actor, type: 'attacks', tail: o365 }]);

  const { nodes } = await build(dir, registry, 'Software=g2,default=g0');
  assert.ok(nodes.some((line) => line.includes('"Hosted Services"')), 'oldest edge won the diamond');
  assert.ok(!nodes.some((line) => line.includes('"Microsoft Office"')), 'the newer parent lost');
});

test('rounding down: the climb stops rather than overshoot the λ rung', async () => {
  const dir = await scratch();
  const registry = await seededRegistry(dir);
  // λ=g3 for Software, but the ladder tops out at the g2 product — round down to g2.
  await writeArtifact(dir, 1, [actor, office2010], [{ head: actor, type: 'attacks', tail: office2010 }]);
  const { nodes } = await build(dir, registry, 'Software=g3,default=g0');
  assert.ok(nodes.some((line) => line.includes('"Microsoft Office"')), 'stopped at the populated g2');
});

test('parseLambda rejects malformed entries loudly', () => {
  assert.throws(() => parseLambda('Software=g9'), /LAMBDA entry/);
  assert.throws(() => parseLambda('Software'), /LAMBDA entry/);
  assert.deepEqual(parseLambda('Software=g2,default=g1'), {
    default: 'g1',
    perCategory: { Software: 'g2' },
  });
});
