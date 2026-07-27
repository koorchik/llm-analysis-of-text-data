import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, undefined, 2));
  await fs.rename(tmpPath, filePath);
}

export function sortByNumericId(files: string[]): string[] {
  return [...files].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

export function sanitizeSchemaName(name: string): string {
  return name
    .replace(/[;:"\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
}
