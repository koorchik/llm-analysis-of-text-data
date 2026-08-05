import { loadRunData, renderRunViewHtml } from '../src/RunView/runView';
import fs from 'fs/promises';
import path from 'path';

/**
 * Run playback viewer CLI:
 *
 *   npm run view -- --run <runDir> [--out <file>]
 *   npm run view -- --run <cloudRunDir> --run <localRunDir> --out compare.html
 *
 * Reads each run's decisions.jsonl (the replay journal — the run must have set DECISIONS_LOG=1),
 * artifacts/ (the document order + titles), registry.json and run-card.json, and writes ONE
 * self-contained HTML file (default: <runDir>/run-view.html). Open it in any browser — no server,
 * no network.
 *
 * Passing `--run` more than once puts every arm in the same page behind a model switcher, so the
 * same document can be read under each model. With several runs `--out` is required: writing into
 * the first run's directory would imply the page belongs to that run alone.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function args(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((token, index) => {
    if (token === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

async function main() {
  const runDirs = args('run');
  if (runDirs.length === 0) {
    console.error(
      'Usage: npm run view -- --run <runDir> [--run <runDir> …] [--out <file>]\n' +
        '  (--out is required when more than one --run is given)'
    );
    process.exit(1);
  }

  const out = arg('out') ?? (runDirs.length === 1 ? path.join(runDirs[0], 'run-view.html') : null);
  if (!out) {
    console.error('--out is required when comparing more than one run');
    process.exit(1);
  }

  const runs = [];
  for (const runDir of runDirs) runs.push(await loadRunData(runDir));
  await fs.writeFile(out, renderRunViewHtml(runs));

  for (const data of runs) {
    const repair = data.events.filter((event) => (event.docId ?? event.doc ?? -1) === -1).length;
    console.log(
      `${data.arm.condition} [${data.arm.provider}/${data.arm.model}] — ` +
        `${data.docOrder.length} document(s), ${data.events.length} event(s)` +
        (repair > 0 ? ` (+${repair} repair event(s))` : '')
    );
    if (!data.selfCheck.ok) {
      console.warn(
        `WARNING: ${data.runId} — replayed final state differs from registry.json; the page ` +
          'shows a banner for this arm. The journal may predate some operations.'
      );
    }
  }
  console.log(`wrote ${out}${runs.length > 1 ? ` — ${runs.length} arms, switchable in-page` : ''}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
