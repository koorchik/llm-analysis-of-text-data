#!/usr/bin/env ts-node
/**
 * Replay logged decision points against a different DecisionStrategy, emitting a new log with the
 * same mention and candidate set. This is what makes E8 (judge swap) cheap: the candidate
 * generator is held fixed by construction, so a delta measures the judge and nothing else.
 *
 *   npm run replay -- --in <decisions.jsonl> --out <replayed.jsonl> [--strategy identity]
 *   npm run replay -- --in <decisions.jsonl> --verify        # fidelity check, writes nothing
 *
 * `--verify` is verification item 7 of the refactor plan: replaying a log through the *same*
 * strategy must reproduce it exactly. Only the `identity` strategy exists in M1; M6 registers the
 * real ones (listwise-mint-candidate, exact-only, threshold, …).
 */
import {
  IdentityReplayStrategy,
  readDecisionEvents,
  replayEvents,
  serializeDecisionEvents,
  type ReplayStrategy,
} from '../src/Experiment/replayLog';
import fs from 'fs/promises';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const inPath = arg('in');
  const outPath = arg('out');
  const strategyId = arg('strategy') ?? 'identity';
  const verify = process.argv.includes('--verify');

  if (!inPath) {
    console.error('usage: replay --in <decisions.jsonl> [--out <file>] [--strategy identity] [--verify]');
    process.exit(2);
  }

  const events = await readDecisionEvents(inPath);
  console.log(`replay: ${events.length} decision points from ${inPath}`);
  if (events.length === 0) {
    console.warn('replay: no decision events found (a log with only llm-call rows replays to nothing)');
  }

  let strategy: ReplayStrategy;
  switch (strategyId) {
    case 'identity':
      strategy = new IdentityReplayStrategy(events);
      break;
    default:
      // Deliberately fatal: silently falling back to identity would make a swap look like a no-op.
      throw new Error(
        `Unknown strategy: ${strategyId}. Only 'identity' exists in M1; M6 adds the real strategies.`
      );
  }

  const replayed = await replayEvents(events, strategy);

  if (verify) {
    const differences = replayed.filter((event, index) => {
      const original = events[index];
      return (
        event.decision !== original.decision ||
        event.target !== original.target ||
        event.mention !== original.mention ||
        event.docId !== original.docId ||
        event.category !== original.category ||
        event.candidates.length !== original.candidates.length
      );
    });

    if (differences.length > 0) {
      console.error(`REPLAY FIDELITY FAILED: ${differences.length}/${events.length} points differ`);
      console.error(differences.slice(0, 5));
      process.exit(1);
    }
    console.log(`REPLAY FIDELITY OK: ${events.length}/${events.length} points reproduced exactly`);
    return;
  }

  const serialized = serializeDecisionEvents(replayed);
  if (outPath) {
    await fs.writeFile(outPath, serialized);
    console.log(`replay: wrote ${replayed.length} events to ${outPath} (strategy=${strategy.id})`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
