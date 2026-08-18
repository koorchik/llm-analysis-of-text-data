import { resolveRunDir, runStartStamp, stripRunDate } from './runDirName';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
function scratchDir(tag: string): string {
  const key = crypto.createHash('sha256').update(`rundir${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `run-dir-name-${key}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

describe('stripRunDate', () => {
  it('removes a YYYY-MM-DD prefix', () => {
    assert.equal(stripRunDate('2026-08-06-psi-link-gemma-e4b-union-934e13d70482'), 'psi-link-gemma-e4b-union-934e13d70482');
  });

  it('removes a YYYY-MM-DD-HHmm prefix', () => {
    assert.equal(
      stripRunDate('2026-08-06-1345-psi-link-gemma-e4b-union-934e13d70482'),
      'psi-link-gemma-e4b-union-934e13d70482'
    );
  });

  it('leaves undated (legacy) names alone', () => {
    assert.equal(stripRunDate('psi-link-default-4ee484f372fc'), 'psi-link-default-4ee484f372fc');
  });

  it('strips only the leading date, not digits inside the runId', () => {
    // A condition name may itself contain digits and dashes; only a real leading date goes.
    assert.equal(stripRunDate('2026-08-06-arm-2026-08-99-abc'), 'arm-2026-08-99-abc');
    assert.equal(stripRunDate('20260806-psi-link-abc'), '20260806-psi-link-abc');
  });
});

describe('runStartStamp', () => {
  it('formats local date and time with zero padding', () => {
    assert.equal(runStartStamp(new Date(2026, 7, 6, 13, 45)), '2026-08-06-1345');
    assert.equal(runStartStamp(new Date(2026, 0, 2, 0, 5)), '2026-01-02-0005');
  });
});

describe('resolveRunDir', () => {
  const runId = 'psi-link-default-4ee484f372fc';

  it('creates a dated path when nothing exists yet', () => {
    const dir = scratchDir('new');
    assert.equal(
      resolveRunDir(dir, runId, new Date(2026, 7, 17)),
      path.join(dir, `2026-08-17-0000-${runId}`)
    );
  });

  it('reuses an existing dated directory for the same runId — resume must not fork', () => {
    const dir = scratchDir('resume');
    fs.mkdirSync(path.join(dir, `2026-08-04-${runId}`), { recursive: true });

    // A run that started on the 4th and is resumed on the 17th keeps its original directory,
    // otherwise the SKIP-exists recovery would find an empty tree and redo every document.
    assert.equal(
      resolveRunDir(dir, runId, new Date(2026, 7, 17)),
      path.join(dir, `2026-08-04-${runId}`)
    );
  });

  it('reuses an existing timestamped directory for the same runId', () => {
    const dir = scratchDir('timestamp-resume');
    fs.mkdirSync(path.join(dir, `2026-08-04-1327-${runId}`), { recursive: true });
    assert.equal(
      resolveRunDir(dir, runId, new Date(2026, 7, 17, 10, 30)),
      path.join(dir, `2026-08-04-1327-${runId}`)
    );
  });

  it('reuses an undated legacy directory', () => {
    const dir = scratchDir('legacy');
    fs.mkdirSync(path.join(dir, runId), { recursive: true });
    assert.equal(resolveRunDir(dir, runId, new Date(2026, 7, 17)), path.join(dir, runId));
  });

  it('does not confuse a different runId that shares a prefix', () => {
    const dir = scratchDir('other');
    fs.mkdirSync(path.join(dir, `2026-08-04-${runId}-extra`), { recursive: true });
    assert.equal(
      resolveRunDir(dir, runId, new Date(2026, 7, 17)),
      path.join(dir, `2026-08-17-0000-${runId}`)
    );
  });
});
