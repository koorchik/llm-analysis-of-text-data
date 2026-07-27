import { hashInputDir } from './inputHash';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inputhash-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test('is reproducible across runs (verification item 6)', async () => {
  const dir = await fixture({ 'b.json': '{"b":1}', 'a.json': '{"a":1}' });
  const first = await hashInputDir(dir);
  const second = await hashInputDir(dir);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.fileCount, 2);
});

test('is independent of readdir order — manifest is sorted by filename', async () => {
  const dir = await fixture({ 'z.json': 'Z', 'a.json': 'A', 'm.json': 'M' });
  const { manifest } = await hashInputDir(dir);
  const names = manifest
    .trim()
    .split('\n')
    .map((line) => line.split('  ')[0]);
  assert.deepEqual(names, ['a.json', 'm.json', 'z.json']);
});

test('matches the documented recipe exactly', async () => {
  const dir = await fixture({ 'a.json': 'A', 'b.json': 'B' });
  const digestA = crypto.createHash('sha256').update('A').digest('hex');
  const digestB = crypto.createHash('sha256').update('B').digest('hex');
  const expectedManifest = `a.json  ${digestA}\nb.json  ${digestB}\n`;
  const expected = crypto.createHash('sha256').update(expectedManifest, 'utf8').digest('hex');

  const { manifest, contentHash } = await hashInputDir(dir);
  assert.equal(manifest, expectedManifest);
  assert.equal(contentHash, expected);
});

test('changes when any byte of any file changes', async () => {
  const dir = await fixture({ 'a.json': '{"v":1}' });
  const before = (await hashInputDir(dir)).contentHash;
  await fs.writeFile(path.join(dir, 'a.json'), '{"v":2}');
  const after = (await hashInputDir(dir)).contentHash;
  assert.notEqual(before, after);
});

test('changes when a file is renamed even if content is identical', async () => {
  const dirA = await fixture({ 'a.json': 'same' });
  const dirB = await fixture({ 'b.json': 'same' });
  assert.notEqual((await hashInputDir(dirA)).contentHash, (await hashInputDir(dirB)).contentHash);
});

test('ignores non-matching extensions, so stray files cannot change corpus identity', async () => {
  const dir = await fixture({ 'a.json': '{"a":1}' });
  const before = (await hashInputDir(dir)).contentHash;
  await fs.writeFile(path.join(dir, '.DS_Store'), 'junk');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'scratch');
  const after = await hashInputDir(dir);
  assert.equal(after.contentHash, before);
  assert.equal(after.fileCount, 1);
});
