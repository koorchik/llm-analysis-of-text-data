import { ensureDir } from '../utils/fsUtils';
import fs from 'fs/promises';
import path from 'path';

interface Params {
  filePath: string;
  enabled: boolean;
}

export type LlmCallKind = 'extract' | 'type-judge' | 'link-judge' | 'pair-rule' | 'consolidate';

export class DecisionLog {
  public readonly filePath: string;
  public readonly enabled: boolean;

  #dirReady = false;

  constructor(params: Params) {
    this.filePath = params.filePath;
    this.enabled = params.enabled;
  }

  async log(event: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    if (!this.#dirReady) {
      await ensureDir(path.dirname(this.filePath));
      this.#dirReady = true;
    }

    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`);
  }

  async logLlmCall(event: { doc: number; kind: LlmCallKind; seconds: number }): Promise<void> {
    await this.log({ op: 'llm-call', ...event });
  }
}
