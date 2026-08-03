import { embeddingPairs } from './embeddingPairs';
import type { Inventory } from './inventory';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const inventory = (entries: Array<[string, string]>): Inventory => ({
  sourceDir: '/fake',
  inputContentHash: 'hash',
  order: 'numeric-id',
  entries: entries.map(([category, surface]) => ({
    category,
    surface,
    docIds: [1],
    occurrences: 1,
  })),
});

/** A fake EmbeddingsClient: canned unit vectors by text, batched exactly like the real one. */
const fakeClient = (vectors: Record<string, number[]>) => ({
  embed: async (inputs: string[]): Promise<number[][]> =>
    inputs.map((text) => {
      const vector = vectors[text];
      if (!vector) throw new Error(`no canned vector for "${text}"`);
      return vector;
    }),
});

describe('embeddingPairs', () => {
  it('proposes cosine neighbours above the threshold as provisional stratum (c)', async () => {
    const { pairs } = await embeddingPairs(
      inventory([
        ['HackerGroup', 'Fancy Bear'],
        ['HackerGroup', 'Sofacy'],
        ['HackerGroup', 'Turla'],
      ]),
      fakeClient({
        'Fancy Bear': [1, 0, 0],
        Sofacy: [0.9, 0.435889894354067, 0], // cos ≈ 0.9 with Fancy Bear
        Turla: [0, 0, 1], // orthogonal to both
      }),
      { minCos: 0.6 }
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].left, 'Fancy Bear');
    assert.equal(pairs[0].right, 'Sofacy');
    assert.equal(pairs[0].stratum, 'c');
    assert.equal(pairs[0].mechanism, 'embedding');
    assert.equal(pairs[0].sim, 0.9);
    assert.equal(pairs[0].label, '');
  });

  it('never pairs across categories', async () => {
    const { pairs } = await embeddingPairs(
      inventory([
        ['HackerGroup', 'Sandworm'],
        ['Software', 'Sandworm Tool'],
      ]),
      fakeClient({ Sandworm: [1, 0], 'Sandworm Tool': [1, 0] }),
      { minCos: 0.6 }
    );
    assert.equal(pairs.length, 0);
  });

  it('keeps only the top-k neighbours per surface — a pair survives via either endpoint', async () => {
    // Every B ranks A first (their mutual cosines are lower than their cosine to A), so with k=1
    // the B–B pairs are in nobody's top-k and must not appear, even though they clear the
    // threshold. The A–B pairs all survive because each B nominates A.
    const { pairs } = await embeddingPairs(
      inventory([
        ['X', 'A'],
        ['X', 'B1'],
        ['X', 'B2'],
        ['X', 'B3'],
        ['X', 'B4'],
      ]),
      fakeClient({
        A: [1, 0, 0, 0, 0],
        B1: [0.99, Math.sqrt(1 - 0.99 ** 2), 0, 0, 0],
        B2: [0.98, 0, Math.sqrt(1 - 0.98 ** 2), 0, 0],
        B3: [0.97, 0, 0, Math.sqrt(1 - 0.97 ** 2), 0],
        B4: [0.96, 0, 0, 0, Math.sqrt(1 - 0.96 ** 2)],
      }),
      { k: 1, minCos: 0.6 }
    );
    assert.equal(pairs.length, 4, 'only the A–B pairs; no B–B pair is in anyone\'s top-1');
    assert.ok(pairs.every((pair) => pair.left === 'A' || pair.right === 'A'));
  });

  it('re-attributes a pair a string mechanism explains, exactly like the registry proposer', async () => {
    const { pairs } = await embeddingPairs(
      inventory([
        ['HackerGroup', 'UAC-0010'],
        ['HackerGroup', 'UAC-0010 (Armageddon)'],
      ]),
      fakeClient({ 'UAC-0010': [1, 0], 'UAC-0010 (Armageddon)': [1, 0] }),
      { minCos: 0.6 }
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].stratum, 'a');
    assert.equal(pairs[0].mechanism, 'identifier');
  });

  it('emits each pair once even though both endpoints neighbour each other', async () => {
    const { pairs } = await embeddingPairs(
      inventory([
        ['X', 'Alpha'],
        ['X', 'Beta'],
      ]),
      fakeClient({ Alpha: [1, 0], Beta: [1, 0] }),
      { minCos: 0.6 }
    );
    assert.equal(pairs.length, 1);
  });

  it('skips configured categories entirely — their surfaces are never embedded', async () => {
    let embedded: string[] = [];
    const client = {
      embed: async (inputs: string[]): Promise<number[][]> => {
        embedded = embedded.concat(inputs);
        return inputs.map(() => [1, 0]);
      },
    };
    await embeddingPairs(
      inventory([
        ['Domain', 'a.example.com'],
        ['Domain', 'b.example.com'],
        ['Software', 'Tool'],
      ]),
      client,
      { skipCategories: ['Domain'], minCos: 0.6 }
    );
    assert.deepEqual(embedded, ['Tool']);
  });

  it('returns every considered cosine for threshold tuning, not only the survivors', async () => {
    const { cosines, stats } = await embeddingPairs(
      inventory([
        ['X', 'A'],
        ['X', 'B'],
      ]),
      fakeClient({ A: [1, 0], B: [0, 1] }), // cos 0 — below any sensible threshold
      { minCos: 0.6 }
    );
    assert.equal(stats.proposed, 0);
    assert.equal(cosines.length, 1, 'the rejected candidate cosine is still reported');
  });
});
