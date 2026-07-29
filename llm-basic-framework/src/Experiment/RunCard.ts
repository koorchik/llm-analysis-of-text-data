import type { EmbeddingCacheStats } from '../EmbeddingsClient/EmbeddingCache';
import { writeJsonAtomic } from '../utils/fsUtils';
import type { CostMeter } from './CostMeter';
import { hashInputDir } from './inputHash';
import type { ResolvedRunConfig } from './RunConfig';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export interface ResumeEvent {
  at: string;
  /** What was found already present, e.g. 'extractions/40102.json'. */
  skipped: string;
  note?: string;
}

export interface RunCardData {
  version: 'run-card-v1';
  runId: string;
  condition: string;
  createdAt: string;
  updatedAt: string;
  config: ResolvedRunConfig;
  resumeEvents: ResumeEvent[];
  cost: unknown | null;
  /**
   * M5. Cache hits are not CostMeter calls, so a fully-cached encoder arm reports **zero embedding
   * calls** — which reads as "embeddings never ran" unless the hit count sits next to it. Measured:
   * a warm re-run of the smoke corpus went from 16 calls / 59.5 s to 0 calls / 3.6 ms.
   */
  embeddingCache: EmbeddingCacheStats | null;
  /** Set once the run finishes cleanly; a card without it describes an incomplete run. */
  completedAt: string | null;
}

interface Params {
  /** `{OUTPUT_DIR}/experiments/{runId}` — the run's own directory. */
  runDir: string;
  config: ResolvedRunConfig;
  /** Injected so timestamps are testable. */
  now?: () => Date;
}

/**
 * The run card is the reproducibility record: config, git sha, prompt hashes, input content hash,
 * seed, sampling parameters (including which were dropped as unsupported), model ids, resume
 * events, and final cost totals.
 *
 * It records the **effective** sampling parameters from the client, not the requested ones, so a
 * card can never claim a `temperature: 0` that was dropped before the request left the process.
 */
export class RunCard {
  public readonly runDir: string;
  public readonly filePath: string;

  #data: RunCardData;
  #now: () => Date;

  constructor(params: Params) {
    this.runDir = params.runDir;
    this.filePath = path.join(params.runDir, 'run-card.json');
    this.#now = params.now ?? (() => new Date());

    const timestamp = this.#now().toISOString();
    this.#data = {
      version: 'run-card-v1',
      runId: params.config.runId,
      condition: params.config.condition,
      createdAt: timestamp,
      updatedAt: timestamp,
      config: params.config,
      resumeEvents: [],
      cost: null,
      embeddingCache: null,
      completedAt: null,
    };

    // Resuming into an existing run directory: keep the original createdAt and resume history
    // so the card describes the whole run, not just the latest process.
    if (existsSync(this.filePath)) {
      try {
        const previous = JSON.parse(readFileSync(this.filePath, 'utf8')) as RunCardData;
        if (previous.runId === this.#data.runId) {
          this.#data.createdAt = previous.createdAt ?? timestamp;
          this.#data.resumeEvents = previous.resumeEvents ?? [];
        } else {
          // Should be impossible — runId is the directory name. Loud rather than silent.
          console.warn(
            `RunCard: ${this.filePath} holds runId ${previous.runId} but this run is ${this.#data.runId}`
          );
        }
      } catch (error) {
        console.warn(`RunCard: could not read existing card at ${this.filePath}:`, error);
      }
    }
  }

  get data(): RunCardData {
    return this.#data;
  }

  /**
   * Records that a resume skipped existing work. The `existsSync` skips are what make a run
   * resumable, so a card that does not list them cannot explain a partial cost total.
   */
  noteResume(skipped: string, note?: string): void {
    this.#data.resumeEvents.push({ at: this.#now().toISOString(), skipped, note });
  }

  attachCost(meter: CostMeter): void {
    this.#data.cost = meter.summary();
  }

  /** Null is meaningful: it says the run had no embedding cache, not that it had zero hits. */
  attachEmbeddingCache(stats: EmbeddingCacheStats | null): void {
    this.#data.embeddingCache = stats;
  }

  markComplete(): void {
    this.#data.completedAt = this.#now().toISOString();
  }

  async save(): Promise<void> {
    this.#data.updatedAt = this.#now().toISOString();
    await writeJsonAtomic(this.filePath, this.#data);
  }

  /**
   * Recomputes the input content hash and checks it against the card. Guards the case where a
   * "frozen" corpus was edited between runs, which would silently invalidate every comparison.
   */
  async verifyInputHash(): Promise<{ ok: boolean; recorded: string; actual: string }> {
    const { contentHash } = await hashInputDir(this.#data.config.input.path);
    return {
      ok: contentHash === this.#data.config.input.contentHash,
      recorded: this.#data.config.input.contentHash,
      actual: contentHash,
    };
  }
}
