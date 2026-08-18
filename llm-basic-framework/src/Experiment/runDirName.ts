import { existsSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Run directories are named `<YYYY-MM-DD-HHmm>-<runId>` so `ls experiments/` reads chronologically.
 *
 * The date is presentation only: it is NEVER part of the `runId`, which is a hash of config + git
 * sha + prompt hashes and must stay stable for the same code and config. A dated `runId` would
 * change every day and break both resume and cross-run comparability.
 */
const START_PREFIX = /^\d{4}-\d{2}-\d{2}-(?:\d{4}-)?/;

/** Strips current timestamp and legacy date prefixes. Undated names pass through unchanged. */
export function stripRunDate(dirName: string): string {
  return dirName.replace(START_PREFIX, '');
}

/** The `YYYY-MM-DD-HHmm` of a Date in local time, matching what a reader sees in their shell. */
export function runStartStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * Resolve the directory for a run, reusing an existing one when this runId has already started.
 *
 * Resume safety is the whole point: the pipeline's `SKIP (exists)` recovery finds work by path, so
 * computing a fresh `<now>-<runId>` for an existing run would silently re-extract and
 * re-judge every document. An existing directory for this runId therefore always wins, whatever
 * date (or no date) it carries.
 */
export function resolveRunDir(experimentsDir: string, runId: string, now: Date): string {
  if (existsSync(experimentsDir)) {
    const existing = readdirSync(experimentsDir).find((name) => stripRunDate(name) === runId);
    if (existing) return path.join(experimentsDir, existing);
  }
  return path.join(experimentsDir, `${runStartStamp(now)}-${runId}`);
}
