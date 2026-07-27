import type { DecisionEvent } from '../DecisionLog/DecisionLog';
import fs from 'fs/promises';

/**
 * Replay support for E8 (judge swap) and E9. The unit of replay is the logged **decision point**:
 * a mention, its category, its document, and the exact candidate list in the exact order the
 * original judge saw it. Re-deriving candidates would measure the generator, not the judge.
 */

/** The minimal decision-strategy surface a replay needs. M6 ships the real implementations. */
export interface ReplayStrategy {
  readonly id: string;
  decide(point: DecisionPoint): Promise<ReplayVerdict> | ReplayVerdict;
}

export interface DecisionPoint {
  mention: string;
  category: string;
  docId: number;
  candidates: DecisionEvent['candidates'];
}

export interface ReplayVerdict {
  decision: 'link' | 'mint' | 'defer';
  target: string | null;
  confidence?: number | null;
}

/**
 * Replays each point through the *original* logged verdict. Feeding a log through this must
 * reproduce that log exactly — verification item 7 of the plan. Without that check, E8's numbers
 * would measure the replayer rather than the judge.
 */
export class IdentityReplayStrategy implements ReplayStrategy {
  readonly id = 'identity';

  #byKey = new Map<string, ReplayVerdict>();

  constructor(events: DecisionEvent[]) {
    for (const event of events) {
      this.#byKey.set(decisionKey(event), {
        decision: event.decision,
        target: event.target,
        confidence: event.confidence ?? null,
      });
    }
  }

  decide(point: DecisionPoint): ReplayVerdict {
    const verdict = this.#byKey.get(decisionKey(point));
    if (!verdict) {
      throw new Error(`IdentityReplayStrategy: no logged verdict for ${decisionKey(point)}`);
    }
    return verdict;
  }
}

/**
 * Keyed by (docId, category, mention). Category is part of the key deliberately: one document can
 * carry the same surface string under two categories — confirmed in the corpus with `atera` as
 * both Organization and Software in doc 6280099 — and keying by mention alone loses one of them.
 */
export function decisionKey(point: {
  docId: number;
  category: string;
  mention: string;
}): string {
  return `${point.docId}|${point.category.toLowerCase()}|${point.mention.trim().toLowerCase()}`;
}

export function parseDecisionEvents(jsonl: string): DecisionEvent[] {
  const events: DecisionEvent[] = [];
  jsonl.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`replay: malformed JSON on line ${index + 1}`);
    }

    // A decision log interleaves llm-call events with decision events; only the latter replay.
    if (parsed.op !== 'decision') return;
    events.push(parsed as unknown as DecisionEvent);
  });
  return events;
}

export async function readDecisionEvents(filePath: string): Promise<DecisionEvent[]> {
  return parseDecisionEvents(await fs.readFile(filePath, 'utf8'));
}

export function toDecisionPoint(event: DecisionEvent): DecisionPoint {
  return {
    mention: event.mention,
    category: event.category,
    docId: event.docId,
    candidates: event.candidates,
  };
}

/**
 * Replays every logged decision point against `strategy`, preserving the original mention and
 * candidate set (and their order). Returns new events in the input order.
 */
export async function replayEvents(
  events: DecisionEvent[],
  strategy: ReplayStrategy
): Promise<DecisionEvent[]> {
  const out: DecisionEvent[] = [];
  for (const event of events) {
    const verdict = await strategy.decide(toDecisionPoint(event));
    out.push({
      ...event,
      decision: verdict.decision,
      target: verdict.target,
      confidence: verdict.confidence ?? null,
      strategy: strategy.id,
    });
  }
  return out;
}

export function serializeDecisionEvents(events: DecisionEvent[], runId?: string): string {
  return events
    .map((event) => JSON.stringify(runId ? { runId, op: 'decision', ...event } : { op: 'decision', ...event }))
    .join('\n')
    .concat(events.length ? '\n' : '');
}
