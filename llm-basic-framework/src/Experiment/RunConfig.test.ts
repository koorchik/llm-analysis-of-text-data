import { TfidfNgramGenerator, resolveGenerator } from '../Normalization/candidates';
import { canonicalJson, computeRunId, type GitState, type RunConfigInput } from './RunConfig';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const GIT: GitState = { sha: 'abc123', dirty: false, diffHash: null };

const base = (): RunConfigInput => ({
  condition: 'psi-link-baseline',
  orchestration: 'streaming',
  input: { path: '/frozen', contentHash: 'deadbeef', fileCount: 204 },
  llm: { provider: 'openai', model: 'gpt-5' },
  sampling: {
    effective: { seed: 1 },
    supported: { temperature: true, seed: true, topP: true },
  },
  seed: 1,
  order: 'chronological',
});

test('canonicalJson sorts object keys recursively but preserves array order', () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: [3, 1, 2] } });
  const b = canonicalJson({ a: { c: [3, 1, 2], d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":[3,1,2],"d":2},"b":1}');
});

test('same config + same git sha → same runId', () => {
  assert.equal(computeRunId(base(), GIT, {}), computeRunId(base(), GIT, {}));
});

test('runId is stable under key reordering of the config object', () => {
  const reordered: RunConfigInput = {
    order: 'chronological',
    seed: 1,
    sampling: base().sampling,
    llm: { model: 'gpt-5', provider: 'openai' },
    input: { fileCount: 204, contentHash: 'deadbeef', path: '/frozen' },
    orchestration: 'streaming',
    condition: 'psi-link-baseline',
  };
  assert.equal(computeRunId(reordered, GIT, {}), computeRunId(base(), GIT, {}));
});

test('a different seed produces a different runId — two seeds cannot collide', () => {
  const other = { ...base(), seed: 2, sampling: { ...base().sampling, effective: { seed: 2 } } };
  assert.notEqual(computeRunId(other, GIT, {}), computeRunId(base(), GIT, {}));
});

test('a different git sha produces a different runId even for identical config', () => {
  const moved: GitState = { sha: 'def456', dirty: false, diffHash: null };
  assert.notEqual(computeRunId(base(), moved, {}), computeRunId(base(), GIT, {}));
});

test('a dirty tree with a different diff produces a different runId', () => {
  const dirtyA: GitState = { sha: 'abc123', dirty: true, diffHash: 'diff-a' };
  const dirtyB: GitState = { sha: 'abc123', dirty: true, diffHash: 'diff-b' };
  // Without the diff hash these two would share a runId and silently resume each other.
  assert.notEqual(computeRunId(base(), dirtyA, {}), computeRunId(base(), dirtyB, {}));
  assert.notEqual(computeRunId(base(), dirtyA, {}), computeRunId(base(), GIT, {}));
});

test('a changed prompt hash produces a different runId (load-bearing from M6)', () => {
  assert.notEqual(
    computeRunId(base(), GIT, { 'link-judge': 'hash-v1' }),
    computeRunId(base(), GIT, { 'link-judge': 'hash-v2' })
  );
});

test('a different input content hash produces a different runId', () => {
  const other = { ...base(), input: { ...base().input, contentHash: 'cafebabe' } };
  assert.notEqual(computeRunId(other, GIT, {}), computeRunId(base(), GIT, {}));
});

test('runId is filesystem-safe and carries a readable condition prefix', () => {
  const messy = { ...base(), condition: 'psi link/baseline:v2' };
  const runId = computeRunId(messy, GIT, {});
  assert.match(runId, /^[a-zA-Z0-9._-]+$/);
  assert.ok(runId.startsWith('psi-link-baseline-v2-'));
});

test('effective sampling, not requested sampling, feeds the runId', () => {
  // Two runs that requested temperature 0 but landed on different effective values (because one
  // provider dropped it) must not share an id.
  const dropped = {
    ...base(),
    sampling: { effective: {}, supported: { temperature: false, seed: false, topP: false } },
  };
  assert.notEqual(computeRunId(dropped, GIT, {}), computeRunId(base(), GIT, {}));
});

// --- M5: the candidates block in `extra` ------------------------------------------------------

test('four candidate generators produce four DISTINCT runIds', () => {
  // The failure this prevents: E4 varies the blocker while holding the judge fixed, so two arms can
  // differ *only* by generator. Without the generator in `extra` they share a runId, share
  // `experiments/{runId}/`, and silently resume each other through the `existsSync` skips.
  const withGenerator = (id: string) => {
    const generator = resolveGenerator(id);
    return computeRunId(
      { ...base(), extra: { candidateGenerator: generator.id, candidateGeneratorConfig: generator.config } },
      GIT,
      {}
    );
  };

  const runIds = ['exact', 'string-sim', 'tfidf-ngram', 'bm25'].map(withGenerator);
  assert.equal(new Set(runIds).size, 4, `expected 4 distinct runIds, got ${JSON.stringify(runIds)}`);
});

test('a generator config change alone forks the runId', () => {
  const threeGram = new TfidfNgramGenerator({ n: 3 });
  const fourGram = new TfidfNgramGenerator({ n: 4 });
  const idFor = (generator: { id: string; config: Record<string, unknown> }) =>
    computeRunId(
      { ...base(), extra: { candidateGenerator: generator.id, candidateGeneratorConfig: generator.config } },
      GIT,
      {}
    );

  assert.notEqual(idFor(threeGram), idFor(fourGram));
});

test('an unknown generator id is FATAL rather than falling back to the default', () => {
  // Silently running string similarity under the embedding arm's name would put the wrong label on
  // a real result — the same rule createDecisionStrategy follows.
  assert.throws(() => resolveGenerator('embeddings'), /Unknown candidate generator "embeddings"/);
});

test('the embedding generator refuses to be built without an EmbeddingsClient', () => {
  assert.throws(() => resolveGenerator('embedding'), /requires an EmbeddingsClient/);
});
