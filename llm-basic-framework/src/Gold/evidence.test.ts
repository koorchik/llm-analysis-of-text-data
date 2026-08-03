import { loadCorpus, snippetsFor, type CorpusDoc } from './evidence';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const doc = (overrides: Partial<CorpusDoc> = {}): CorpusDoc => ({
  title: '',
  description: '',
  text: '',
  ...overrides,
});

describe('snippetsFor', () => {
  it('finds a surface in the title and prefixes the doc id', () => {
    const corpus = new Map([[7, doc({ title: 'Атака UAC-0010 на державні установи' })]]);
    const snippets = snippetsFor('UAC-0010', [7], corpus);
    assert.equal(snippets.length, 1);
    assert.match(snippets[0], /^\[doc 7\]/);
    assert.match(snippets[0], /UAC-0010/);
  });

  it('strips HTML tags and decodes entities before matching', () => {
    const corpus = new Map([
      [3, doc({ description: '<p class="x">від імені&nbsp;Адміністрації Держспецзв’язку</p>' })],
    ]);
    const [snippet] = snippetsFor('Держспецзв’язку', [3], corpus);
    assert.ok(snippet !== undefined, 'the surface sits inside HTML');
    assert.ok(!snippet.includes('<p'), 'tags are stripped');
    assert.ok(!snippet.includes('&nbsp;'), 'entities are decoded');
  });

  it('prefers title over description over text', () => {
    const corpus = new Map([
      [1, doc({ title: 'Sandworm attacks', description: 'Sandworm again', text: 'Sandworm thrice' })],
    ]);
    const [snippet] = snippetsFor('Sandworm', [1], corpus);
    assert.match(snippet, /attacks/);
  });

  it('is case-insensitive', () => {
    const corpus = new Map([[1, doc({ text: 'the SANDWORM group' })]]);
    assert.equal(snippetsFor('Sandworm', [1], corpus).length, 1);
  });

  it('windows the match with ellipses instead of returning the whole document', () => {
    const long = `${'a'.repeat(500)} Sandworm ${'b'.repeat(500)}`;
    const corpus = new Map([[1, doc({ text: long })]]);
    const [snippet] = snippetsFor('Sandworm', [1], corpus, { window: 40 });
    assert.ok(snippet.length < 150, `snippet stays near the window size, got ${snippet.length}`);
    assert.match(snippet, /…/);
    assert.match(snippet, /Sandworm/);
  });

  it('returns at most maxDocs snippets, skipping documents without the surface', () => {
    const corpus = new Map([
      [1, doc({ text: 'nothing here' })],
      [2, doc({ text: 'Sandworm one' })],
      [3, doc({ text: 'Sandworm two' })],
      [4, doc({ text: 'Sandworm three' })],
    ]);
    const snippets = snippetsFor('Sandworm', [1, 2, 3, 4], corpus, { maxDocs: 2 });
    assert.equal(snippets.length, 2);
    assert.match(snippets[0], /^\[doc 2\]/);
    assert.match(snippets[1], /^\[doc 3\]/);
  });

  it('returns nothing when the surface never literally appears', () => {
    const corpus = new Map([[1, doc({ text: 'extraction normalized this name away' })]]);
    assert.deepEqual(snippetsFor('Fancy Bear', [1], corpus), []);
  });

  it('collapses whitespace so a snippet never breaks a TSV row', () => {
    const corpus = new Map([[1, doc({ text: 'before\n\nSandworm\tafter' })]]);
    const [snippet] = snippetsFor('Sandworm', [1], corpus);
    assert.ok(!/[\t\n\r]/.test(snippet));
  });
});

describe('loadCorpus', () => {
  it('reads fetched CERT-UA JSON files keyed by numeric id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-'));
    await fs.writeFile(
      path.join(dir, '42.json'),
      JSON.stringify({ id: 42, title: 'T', description: '<p>D</p>', text: '<p>X</p>', tags: [] })
    );
    await fs.writeFile(path.join(dir, 'not-a-doc.txt'), 'ignored');
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.size, 1);
    assert.equal(corpus.get(42)?.title, 'T');
  });
});
