import { PromptProvider, prompts } from './PromptProvider';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, it } from 'node:test';

const PROMPTS_DIR = path.resolve(__dirname, '../../prompts');
/**
 * `prompts/manifest.json` is the extraction record: it was written by the script that mechanically
 * lifted each template out of the source, and it carries the sha256 of each prompt as extracted.
 *
 * This is the lock plan Risk #4 asks for. Byte-identity against the pre-M6 inline literals was
 * verified at extraction time; that check cannot be repeated once the literals are gone from the
 * source, so the manifest hashes take over as the guarantee. A prompt edit now fails the test below,
 * which is the point: prompt text is an experimental variable, so changing it must be a deliberate
 * act that also updates the manifest — and therefore every affected runId.
 */
const MANIFEST = JSON.parse(readFileSync(path.join(PROMPTS_DIR, 'manifest.json'), 'utf8')) as Record<
  string,
  { file: string; extractedFrom: string; sha256: string; variables: Array<{ placeholder: string }>; bytes: number }
>;


describe('PromptProvider', () => {
  it('finds every extracted prompt', () => {
    assert.deepEqual(prompts.ids(), Object.keys(MANIFEST).sort());
  });

  it('hashes match the manifest recorded at extraction time', () => {
    for (const [id, entry] of Object.entries(MANIFEST)) {
      assert.equal(prompts.get(id).sha256, entry.sha256, `${id} drifted from its extracted text`);
    }
  });

  it('every prompt is non-empty and byte-length matches the manifest', () => {
    for (const [id, entry] of Object.entries(MANIFEST)) {
      const { template } = prompts.get(id);
      assert.ok(template.length > 0, `${id} is empty`);
      assert.equal(Buffer.byteLength(template, 'utf8'), entry.bytes, `${id} byte length changed`);
    }
  });

  it('detects the placeholders the manifest recorded', () => {
    for (const [id, entry] of Object.entries(MANIFEST)) {
      assert.deepEqual(
        prompts.get(id).variables.slice().sort(),
        entry.variables.map((variable) => variable.placeholder).sort(),
        `${id} placeholders changed`
      );
    }
  });

  it('leaves no unrendered placeholder behind', () => {
    for (const id of prompts.ids()) {
      const { variables } = prompts.get(id);
      const supplied = Object.fromEntries(variables.map((name) => [name, `<${name}>`]));
      const rendered = prompts.render(id, supplied);
      assert.ok(!/\{\{\w+\}\}/.test(rendered), `${id} still contains a placeholder after render`);
      for (const name of variables) {
        assert.ok(rendered.includes(`<${name}>`), `${id} dropped ${name}`);
      }
    }
  });

  it('renders a static prompt to exactly its template', () => {
    // type-judge takes no variables, so render() must be the identity on it.
    assert.equal(prompts.render('type-judge'), prompts.get('type-judge').template);
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    const dir = makeTempPrompts({ 'repeat.md': 'a {{x}} b {{x}} c' });
    const provider = new PromptProvider({ dir });
    assert.deepEqual(provider.get('repeat').variables, ['x']);
    assert.equal(provider.render('repeat', { x: 'Q' }), 'a Q b Q c');
  });

  it('rejects a missing variable rather than shipping a literal placeholder', () => {
    const dir = makeTempPrompts({ 'needs.md': 'hello {{who}}' });
    const provider = new PromptProvider({ dir });
    assert.throws(() => provider.render('needs', {}), /needs who/);
  });

  it('rejects an unused variable, which usually means caller and template have drifted', () => {
    const dir = makeTempPrompts({ 'plain.md': 'no variables here' });
    const provider = new PromptProvider({ dir });
    assert.throws(() => provider.render('plain', { stray: 'x' }), /does not use stray/);
  });

  it('throws on an unknown prompt instead of falling back to a default', () => {
    assert.throws(() => prompts.get('no-such-prompt'), /no prompt "no-such-prompt"/);
  });

  it('hashesFor returns only the requested subset', () => {
    const subset = prompts.hashesFor(['link-judge', 'pair-rule']);
    assert.deepEqual(Object.keys(subset).sort(), ['link-judge', 'pair-rule']);
    assert.equal(subset['link-judge'], prompts.get('link-judge').sha256);
  });

  it('a prompt edit changes the hash, so it cannot slip into a run unrecorded', () => {
    const dir = makeTempPrompts({ 'p.md': 'original' });
    const before = new PromptProvider({ dir }).get('p').sha256;
    const dir2 = makeTempPrompts({ 'p.md': 'original ' }); // one trailing space
    const after = new PromptProvider({ dir: dir2 }).get('p').sha256;
    assert.notEqual(before, after);
  });

  it('psi-norm-batch is the published batch prompt and takes entityType', () => {
    // E1 scores the artifact this prompt produced; the interpolation point is part of its identity.
    const prompt = prompts.get('psi-norm-batch');
    assert.deepEqual(prompt.variables, ['entityType']);
    assert.match(prompts.render('psi-norm-batch', { entityType: 'HackerGroup' }), /HackerGroup/);
  });

  it('entity-matching prompts are domain-neutral and reject contextual roles as identity', () => {
    for (const id of ['ladder', 'link-judge', 'listwise-select', 'listwise-select-compact-v1', 'listwise-select-complete-v2', 'listwise-select-balanced-v3', 'comem-select']) {
      const prompt = prompts.get(id);
      assert.doesNotMatch(prompt.template, /cyber|CERT-UA|phishing|attacker|targeting/i, id);
      assert.match(prompt.template, /role/i, `${id} must explicitly reject role as identity evidence`);
    }
    for (const id of ['repair-judge', 'repair-judge-compact-v1']) {
      assert.match(prompts.get(id).template, /role/i, `${id} must reject role as identity evidence`);
    }
    assert.deepEqual(
      [...prompts.get('link-judge').variables].sort(),
      ['docSnippet', 'docTitle', 'mentionsBatch']
    );
  });
});

let tempCounter = 0;
function makeTempPrompts(files: Record<string, string>): string {
  const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs');
  // Content-derived so the helper stays deterministic without Date.now()/Math.random().
  const key = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 8);
  const dir = path.join(
    process.env.TMPDIR || '/tmp',
    `prompt-provider-test-${key}-${tempCounter++}`
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}
