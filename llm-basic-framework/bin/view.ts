import { loadRunData, renderRunViewHtml } from '../src/RunView/runView';
import fs from 'fs/promises';
import path from 'path';

/**
 * Run playback viewer CLI:
 *
 *   npm run view -- --run <runDir> [--out <file>]
 *
 * Reads the run's decisions.jsonl (the replay journal — the run must have set DECISIONS_LOG=1),
 * artifacts/ (the document order + titles), registry.json and run-card.json, and writes ONE
 * self-contained HTML file (default: <runDir>/run-view.html). Open it in any browser — no server,
 * no network.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const runDir = arg('run');
  if (!runDir) {
    console.error('Usage: npm run view -- --run <runDir> [--out <file>]');
    process.exit(1);
  }

  const data = await loadRunData(runDir);
  const out = arg('out') ?? path.join(runDir, 'run-view.html');
  await fs.writeFile(out, renderRunViewHtml(data));

  const repair = data.events.filter((event) => (event.docId ?? event.doc ?? -1) === -1).length;
  console.log(
    `wrote ${out} — ${data.docOrder.length} document(s), ${data.events.length} event(s)` +
      (repair > 0 ? ` (+${repair} repair event(s))` : '')
  );
  if (!data.selfCheck.ok) {
    console.warn(
      'WARNING: replayed final state differs from registry.json — the page shows a banner; ' +
        'the journal may predate some operations (e.g. a run made without the v2 events).'
    );
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
