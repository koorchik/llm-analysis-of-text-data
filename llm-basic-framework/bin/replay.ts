#!/usr/bin/env ts-node
/**
 * Replay logged decision points against a different DecisionStrategy, emitting a new log with the
 * same mention and candidate set. This is what makes E8 (judge swap) cheap: the candidate
 * generator is held fixed by construction, so a delta measures the judge and nothing else.
 *
 *   npm run replay -- --in <decisions.jsonl> --out <replayed.jsonl> [--strategy exact-only]
 *   npm run replay -- --in <decisions.jsonl> --verify        # fidelity check, writes nothing
 *   npm run replay -- --list-strategies
 *
 * `--verify` is verification item 7 of the refactor plan: replaying a log through the *same*
 * strategy must reproduce it exactly.
 *
 * Only the **offline** strategies are replayable here — they make no LLM calls, so scoring an
 * alternative decision rule over a logged run costs nothing. The batched LLM strategies are excluded
 * on purpose: they exist to make one call per document, and replaying them a mention at a time would
 * both multiply their cost and change the context the judge sees, so the result would not be the
 * arm being named. Run those live instead:
 *   DECISION_STRATEGY=comem-select CONDITION=e2-comem FLOW=incremental DECISIONS_LOG=1 npm start
 */
import {
  DECISION_STRATEGIES,
  OFFLINE_STRATEGY_IDS,
  createOfflineStrategy,
  isOfflineStrategyId,
} from '../src/Normalization/decision';
import { StrategyReplayAdapter } from '../src/Experiment/StrategyReplayAdapter';
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

/** A numeric flag, or undefined so the strategy's own default applies. */
function num(name: string): number | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  // Fatal rather than falling back: a typo'd --threshold silently reverting to 0.8 would put the
  // wrong number in the results table under the right label.
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${value}"`);
  return parsed;
}

async function main() {
  const inPath = arg('in');
  const outPath = arg('out');
  const strategyId = arg('strategy') ?? 'identity';
  const verify = process.argv.includes('--verify');

  if (process.argv.includes('--list-strategies')) {
    console.log(['identity', ...OFFLINE_STRATEGY_IDS].join('\n'));
    return;
  }

  if (!inPath) {
    console.error(
      'usage: replay --in <decisions.jsonl> [--out <file>] [--strategy <id>] [--verify]\n' +
        `       replayable strategies: ${['identity', ...OFFLINE_STRATEGY_IDS].join(', ')}`
    );
    process.exit(2);
  }

  const events = await readDecisionEvents(inPath);
  console.log(`replay: ${events.length} decision points from ${inPath}`);
  if (events.length === 0) {
    console.warn('replay: no decision events found (a log with only llm-call rows replays to nothing)');
  }

  let strategy: ReplayStrategy;
  let adapter: StrategyReplayAdapter | undefined;
  if (strategyId === 'identity') {
    strategy = new IdentityReplayStrategy(events);
  } else if (isOfflineStrategyId(strategyId)) {
    adapter = new StrategyReplayAdapter(
      createOfflineStrategy(strategyId, {
        threshold: num('threshold'),
        deferBand: num('defer-band'),
        minMargin: num('min-margin'),
        upper: num('upper'),
        lower: num('lower'),
        noDefer: process.argv.includes('--no-defer'),
        caseSensitive: process.argv.includes('--case-sensitive'),
      })
    );
    strategy = adapter;
  } else if (strategyId in DECISION_STRATEGIES) {
    // Deliberately fatal rather than "helpfully" running it: an LLM strategy replayed one mention
    // at a time is a different arm from the same strategy run batched, and silently substituting
    // one for the other would put a wrong cost figure next to a real quality figure.
    throw new Error(
      `Strategy '${strategyId}' makes LLM calls and is not replayable one decision point at a time. ` +
        `Run it live: DECISION_STRATEGY=${strategyId} CONDITION=<arm-name> FLOW=incremental npm start. ` +
        `Replayable: ${['identity', ...OFFLINE_STRATEGY_IDS].join(', ')}`
    );
  } else {
    // Deliberately fatal: silently falling back to identity would make a swap look like a no-op.
    throw new Error(
      `Unknown strategy: ${strategyId}. Replayable: ${['identity', ...OFFLINE_STRATEGY_IDS].join(', ')}`
    );
  }

  const replayed = await replayEvents(events, strategy);

  if (adapter && adapter.missingSurfaces > 0) {
    // Loud, because a silently degraded arm looks like a genuinely weaker one. Pre-M6 logs did not
    // record the alias surfaces the judge saw, so alias-sensitive strategies scored on names alone.
    console.warn(
      `REPLAY WARNING: ${adapter.missingSurfaces} candidate(s) had no logged alias surfaces ` +
        `(pre-M6 log). '${strategyId}' scored them on canonical names alone — treat its numbers as a ` +
        'lower bound, not a measurement.'
    );
  }

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
