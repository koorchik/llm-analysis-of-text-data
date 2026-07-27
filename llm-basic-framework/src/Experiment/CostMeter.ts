import type { LlmUsage } from '../LlmClient/LlmClientBackendBase';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export interface ModelPrice {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
}

export interface PriceTable {
  models: Record<string, ModelPrice>;
  providerDefaults: Record<string, ModelPrice>;
}

export interface CostRecord {
  operator: string;
  docId: number | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** null when the model has no price entry — NOT zero. See `unpricedModels`. */
  costUsd: number | null;
  latencyMs: number;
}

export interface CostTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over priced calls only. Read alongside `unpricedCalls` before quoting it. */
  costUsd: number;
  /** Calls whose model had no price entry, so their spend is missing from `costUsd`. */
  unpricedCalls: number;
  wallClockMs: number;
}

interface Params {
  runId: string;
  priceTable?: PriceTable;
  /** Defaults to <repo>/config/model-prices.json. */
  priceTablePath?: string;
}

const EMPTY_TOTALS = (): CostTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  wallClockMs: 0,
});

/**
 * Accumulates calls / tokens / dollars / wall-clock per (runId, operator, docId) — the RQ5
 * instrument, shared by every condition.
 *
 * Deliberate design choice: an unknown model yields `costUsd: null` and increments
 * `unpricedCalls`, it does not yield 0. A silent zero would make an expensive run look free,
 * which is exactly the failure mode a cost meter exists to prevent.
 */
export class CostMeter {
  public readonly runId: string;

  #prices: PriceTable;
  #records: CostRecord[] = [];
  #unpriced = new Set<string>();

  constructor(params: Params) {
    this.runId = params.runId;
    this.#prices = params.priceTable ?? CostMeter.loadPriceTable(params.priceTablePath);
  }

  static loadPriceTable(filePath?: string): PriceTable {
    const resolved = filePath ?? path.resolve(__dirname, '../../config/model-prices.json');
    if (!existsSync(resolved)) {
      console.warn(`CostMeter: no price table at ${resolved} — every call will be unpriced`);
      return { models: {}, providerDefaults: {} };
    }
    const raw = JSON.parse(readFileSync(resolved, 'utf8'));
    return {
      models: raw.models ?? {},
      providerDefaults: raw.providerDefaults ?? {},
    };
  }

  priceFor(provider: string, model: string): ModelPrice | null {
    const entry = this.#prices.models[model];
    if (entry && entry.inputPerMTok !== null && entry.outputPerMTok !== null) return entry;

    const fallback = this.#prices.providerDefaults[provider];
    if (fallback && fallback.inputPerMTok !== null && fallback.outputPerMTok !== null) {
      return fallback;
    }
    return null;
  }

  record(call: {
    operator: string;
    docId?: number | null;
    provider: string;
    model: string;
    usage: LlmUsage;
    latencyMs: number;
  }): CostRecord {
    const price = this.priceFor(call.provider, call.model);
    if (!price) this.#unpriced.add(`${call.provider}/${call.model}`);

    const costUsd =
      price === null
        ? null
        : (call.usage.inputTokens / 1_000_000) * price.inputPerMTok! +
          (call.usage.outputTokens / 1_000_000) * price.outputPerMTok!;

    const record: CostRecord = {
      operator: call.operator,
      docId: call.docId ?? null,
      provider: call.provider,
      model: call.model,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      costUsd,
      latencyMs: call.latencyMs,
    };

    this.#records.push(record);
    return record;
  }

  get records(): readonly CostRecord[] {
    return this.#records;
  }

  /** Model ids seen with no usable price entry. Surfaced in the run card. */
  get unpricedModels(): string[] {
    return [...this.#unpriced].sort();
  }

  totals(): CostTotals {
    return this.#records.reduce((acc, record) => {
      acc.calls += 1;
      acc.inputTokens += record.inputTokens;
      acc.outputTokens += record.outputTokens;
      acc.wallClockMs += record.latencyMs;
      if (record.costUsd === null) acc.unpricedCalls += 1;
      else acc.costUsd += record.costUsd;
      return acc;
    }, EMPTY_TOTALS());
  }

  #groupBy(key: (record: CostRecord) => string): Record<string, CostTotals> {
    const out: Record<string, CostTotals> = {};
    for (const record of this.#records) {
      const bucket = (out[key(record)] ??= EMPTY_TOTALS());
      bucket.calls += 1;
      bucket.inputTokens += record.inputTokens;
      bucket.outputTokens += record.outputTokens;
      bucket.wallClockMs += record.latencyMs;
      if (record.costUsd === null) bucket.unpricedCalls += 1;
      else bucket.costUsd += record.costUsd;
    }
    return out;
  }

  byOperator(): Record<string, CostTotals> {
    return this.#groupBy((record) => record.operator);
  }

  byDoc(): Record<string, CostTotals> {
    return this.#groupBy((record) => String(record.docId ?? 'none'));
  }

  /** Shape embedded in the run card. */
  summary() {
    return {
      runId: this.runId,
      totals: this.totals(),
      byOperator: this.byOperator(),
      unpricedModels: this.unpricedModels,
    };
  }
}
