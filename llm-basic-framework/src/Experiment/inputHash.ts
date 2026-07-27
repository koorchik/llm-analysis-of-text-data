import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * The content-hash recipe, defined once here and used by both RunCard and bin/hash-input.ts.
 *
 * Recipe (the plan's M1 definition — a recipe, not a literal, because the previously recorded
 * constant `70563419bd76…` was not reproducible from any of sixteen candidate constructions and
 * was therefore withdrawn):
 *
 *   1. sha256 of each file's raw bytes
 *   2. sort by filename, lexically (byte order, not locale)
 *   3. join as `"{filename}  {hexdigest}\n"`  (two spaces, trailing newline on every line)
 *   4. sha256 of that manifest
 *
 * Only `.json` files are hashed by default, so an editor swapfile or a stray `.DS_Store`
 * cannot silently change the identity of a frozen corpus.
 */

export const MANIFEST_SEPARATOR = '  ';

export interface InputHashResult {
  contentHash: string;
  fileCount: number;
  /** The intermediate manifest, exposed so a mismatch can be diffed rather than guessed at. */
  manifest: string;
}

async function sha256OfFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function hashInputDir(
  dir: string,
  options: { extension?: string } = {}
): Promise<InputHashResult> {
  const extension = options.extension ?? '.json';
  const entries = (await fs.readdir(dir)).filter((file) => file.endsWith(extension));

  // Explicit byte-order sort: the default Array#sort comparison is already lexicographic by
  // UTF-16 code unit, but state it so the recipe does not depend on an unstated default.
  const sorted = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const lines: string[] = [];
  for (const file of sorted) {
    const digest = await sha256OfFile(path.join(dir, file));
    lines.push(`${file}${MANIFEST_SEPARATOR}${digest}\n`);
  }

  const manifest = lines.join('');
  const contentHash = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex');

  return { contentHash, fileCount: sorted.length, manifest };
}
