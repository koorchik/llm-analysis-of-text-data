#!/usr/bin/env ts-node
/**
 * Rewrite `run-view.html` for run directories that already exist.
 *
 *   npm run regen-view -- <runDir> [<runDir> ...]
 *
 * The page is generated at the end of a run, so a change to the view would otherwise only reach
 * arms cheap enough to re-run. Nothing here touches the registry or the decision log — it reads the
 * same files the page always reads and re-renders them.
 */
import { promises as fs } from 'fs';

import { loadRunData, renderRunViewHtml } from '../src/RunView/runView';

async function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) throw new Error('usage: regen-view <runDir> [<runDir> ...]');
  for (const dir of dirs) {
    await fs.writeFile(`${dir}/run-view.html`, renderRunViewHtml(await loadRunData(dir)));
    console.log(`rewrote ${dir}/run-view.html`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
