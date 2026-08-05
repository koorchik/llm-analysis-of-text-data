import { ensureDir } from '../utils/fsUtils';
import fs from 'fs/promises';
import path from 'path';

interface Params {
  filePath: string;
  enabled: boolean;
  /** Stamped onto every event so a log is attributable after it leaves its run directory. */
  runId?: string;
}

/**
 * Known operators, kept as named strings for discoverability — but the union is **open**
 * (`(string & {})`) so a new decision strategy or repair operator can log without editing
 * this file. It was closed in v1, which made the log a bottleneck on every new operator.
 */
export type LlmCallKind =
  | 'extract'
  | 'type-judge'
  | 'link-judge'
  | 'link-judge-retry'
  | 'pair-rule'
  | 'consolidate'
  | 'country-normalize'
  | 'batch-normalize'
  | 'repair-judge'
  | 'repair-judge-retry'
  | (string & {});

export interface LlmCallEvent {
  doc: number;
  kind: LlmCallKind;
  seconds: number;
  model?: string;
  seed?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  /** null means unpriced, not free — see CostMeter. */
  costUsd?: number | null;
}

/** One candidate as it was shown to the judge, in the order it was shown. */
export interface DecisionCandidate {
  name: string;
  sim: number;
  /** Which generator surfaced it: 'string-sim', 'exact', 'embedding', 'bm25', 'rrf'… */
  channel: string;
  /**
   * The alias surfaces shown to the judge alongside this candidate, in the order shown.
   *
   * Recorded because the replay contract is "the exact candidate list in the exact order the
   * original judge saw it", and aliases are *part of what it saw* — `dong2023reveal` measures them
   * at +2–14 F1. Without them a replayed prompt is not the original prompt, so E8 would compare two
   * judges on different inputs and report the difference as a judge effect. The alias-aware
   * non-LLM arms (`exact-only`, `fellegi-sunter`) would likewise score against name-only evidence.
   *
   * Optional because logs written before M6 do not have it; consumers must treat a missing value as
   * "unknown", never as "no aliases".
   */
  surfaces?: string[];
}

/**
 * The shape Phase 1.1 of the research note specifies. Every normalization variant emits these,
 * and all merge/mint metrics are computed from this log plus the final registry.
 * `bin/replay.ts` consumes exactly this to re-run logged decision points against another judge.
 */
export interface DecisionEvent {
  mention: string;
  category: string;
  docId: number;
  candidates: DecisionCandidate[];
  decision: 'link' | 'mint' | 'defer';
  /**
   * The canonical this mention ended up attached to: the existing canonical for `link`, the
   * newly-minted canonical for `mint`, and `null` only for `defer` (no decision was made).
   *
   * Populated for mints on purpose: M2's `partition.ts` reconstructs the cluster partition from
   * this log alone, which needs mention → canonical for every decided mention. A null target on
   * mint would make every minted cluster unrecoverable from the log.
   */
  target: string | null;
  confidence?: number | null;
  /** Which DecisionStrategy produced this, so a replayed log is distinguishable. */
  strategy?: string;
  model?: string;
  seed?: number | null;
  /**
   * Non-scoring (T5): the judge's gloss on mint/defer, carried through for replay/debugging.
   * Absent on logs written before T5; null when the judge gave none or gloss validation failed.
   */
  gloss?: string | null;
}

export class DecisionLog {
  public readonly filePath: string;
  public readonly enabled: boolean;
  public readonly runId?: string;

  #dirReady = false;

  constructor(params: Params) {
    this.filePath = params.filePath;
    this.enabled = params.enabled;
    this.runId = params.runId;
  }

  async log(event: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    if (!this.#dirReady) {
      await ensureDir(path.dirname(this.filePath));
      this.#dirReady = true;
    }

    const stamped = this.runId ? { runId: this.runId, ...event } : event;
    await fs.appendFile(this.filePath, `${JSON.stringify(stamped)}\n`);
  }

  async logLlmCall(event: LlmCallEvent): Promise<void> {
    await this.log({ op: 'llm-call', ...event });
  }

  async logDecision(event: DecisionEvent): Promise<void> {
    await this.log({ op: 'decision', ...event });
  }
}
