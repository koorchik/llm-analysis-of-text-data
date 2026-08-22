import { registryToTurtle } from './skosExport';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const record = (surfaces: string[], definition: string | null = null) => ({
  labels: surfaces.map((surface) => ({ surface, docId: 1, decision: 'mint' as const })),
  definition,
  firstSeen: { doc: 1, date: '' },
});

const registry = {
  version: 6 as const,
  canonicalPolicy: 'first-seen' as const,
  conceptSchemes: {
    Software: {
      'MS Office': record(['MS Office', 'Microsoft Office'], 'an office suite'),
      'Office 2010': record(['Office 2010']),
      Standalone: record(['Standalone']),
    },
    HackerGroup: {
      Sandworm: record(['Sandworm']),
      APT44: record(['APT44']),
    },
  },
  broaderEdges: {
    Software: [
      {
        narrower: 'Office 2010',
        broader: 'MS Office',
        type: 'broaderInstantial' as const,
        similarityScore: 0.91,
        docId: 1,
        decision: 'judge' as const,
      },
    ],
  },
  renameEdges: {
    HackerGroup: [
      { from: 'Sandworm', to: 'APT44', kind: 'renamed-to' as const, docId: 1, decision: 'repairer' as const },
    ],
  },
  deferQueue: [],
  repair: { adjudicated: [], spillover: [], repairedThrough: -1 },
};

test('maps the registry onto SKOS/iso-thes: schemes, concepts, labels, typed broader edges', () => {
  const turtle = registryToTurtle(registry);

  assert.match(turtle, /<urn:skein:scheme:Software> a skos:ConceptScheme/);
  assert.match(turtle, /<urn:skein:Software:MS%20Office> a skos:Concept/);
  assert.match(turtle, /skos:inScheme <urn:skein:scheme:Software>/);
  assert.match(turtle, /skos:prefLabel "MS Office"/);
  assert.match(turtle, /skos:altLabel "Microsoft Office"/);
  assert.match(turtle, /skos:definition "an office suite"/);

  // The typed iso-thes edge carries the RDF 1.2 similarity annotation; the plain skos:broader is
  // the materialized inference for consumers without a reasoner.
  assert.match(
    turtle,
    /<urn:skein:Software:Office%202010> isothes:broaderInstantial <urn:skein:Software:MS%20Office> \{\| skein:similarityScore 0\.91 \|\} \./
  );
  assert.match(
    turtle,
    /<urn:skein:Software:Office%202010> skos:broader <urn:skein:Software:MS%20Office> \./
  );
  assert.doesNotMatch(turtle, /skein:relation/, 'the typed predicate supersedes the relation annotation');

  // Top concepts: hierarchy roots only — flat concepts are not marked.
  assert.match(turtle, /skos:hasTopConcept <urn:skein:Software:MS%20Office>/);
  assert.doesNotMatch(turtle, /skos:hasTopConcept <urn:skein:Software:Standalone>/);

  // Renames are history, not thesaurus relations — custom vocabulary, never skos:broader.
  assert.match(turtle, /<urn:skein:HackerGroup:Sandworm> skein:renamedTo <urn:skein:HackerGroup:APT44> \./);
});

test('is deterministic and honours the category filter', () => {
  assert.equal(registryToTurtle(registry), registryToTurtle(registry), 'byte-identical re-export');
  const onlySoftware = registryToTurtle(registry, { category: 'software' });
  assert.doesNotMatch(onlySoftware, /HackerGroup/);
  assert.match(onlySoftware, /MS%20Office/);
});

test('escapes quotes and minted IRIs survive names with spaces and punctuation', () => {
  const tricky = {
    ...registry,
    conceptSchemes: {
      Software: {
        'Foo "Bar"': record(['Foo "Bar"', 'foo/bar']),
      },
    },
    broaderEdges: {},
    renameEdges: {},
  };
  const turtle = registryToTurtle(tricky);
  assert.match(turtle, /skos:prefLabel "Foo \\"Bar\\""/);
  assert.match(turtle, /<urn:skein:Software:Foo%20%22Bar%22>/);
  assert.match(turtle, /skos:altLabel "foo\/bar"/);
});
