import { ensureDir } from '../utils/fsUtils';
import fs from 'fs/promises';
import path from 'path';

/**
 * One LLM call as written to disk. `response`/`usage`/`latencyMs`/`finishReason` are absent when
 * the call threw; `error` is present in exactly that case.
 */
export interface LlmCallRecord {
  operator: string;
  docId: number | null;
  provider: string;
  model: string;
  /** The EFFECTIVE sampling options — what the backend was really sent. */
  sampling: Record<string, unknown>;
  instructions: string;
  text: string;
  response?: string;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  finishReason?: string;
  error?: string;
}

/** Identifies the written pair so a later validation verdict can be attached to it. */
export interface LlmCallHandle {
  docId: number | null;
  seq: number;
  /** Needed so an outcome is attached to this exact call, not merely to this seq. */
  operator: string;
  /** The `<NNN>-<docId>` folder this call was written to. */
  folder: string;
}

interface Params {
  /** `<runDir>/llm-calls`. */
  dir: string;
  runId?: string;
  /** Defaults to true; `bin/app.ts` passes false for LLM_LOG=0. */
  enabled?: boolean;
}

interface Outcome {
  ok: boolean;
  detail: string;
}

/**
 * Full-fidelity transcripts of every LLM call, one pair of files per call:
 * `<dir>/<docId>/<NNN>-<operator>.json` (machine-readable, replayable by hand) and `.txt`
 * (the same content rendered for reading). A call that failed — either because the backend threw
 * or because a judge rejected the response — is suffixed `.FAILED`.
 *
 * Deliberately NOT part of RunConfig: writing these files does not change pipeline behaviour, and
 * folding the knob into the runId would rotate every arm's directory and make a logged run
 * incomparable with the committed ones.
 */
export class LlmCallLog {
  readonly #dir: string;
  readonly #runId?: string;
  readonly #enabled: boolean;
  /** Per-document call counter, keyed by folder name — the pipeline is sequential per document. */
  readonly #seq = new Map<string, number>();
  /** docId → folder name, so every call for a document lands in the same numbered folder. */
  readonly #folders = new Map<string, string>();
  #seeded = false;
  #warned = false;

  constructor(params: Params) {
    this.#dir = params.dir;
    this.#runId = params.runId;
    this.#enabled = params.enabled ?? true;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async write(record: LlmCallRecord): Promise<LlmCallHandle | null> {
    if (!this.#enabled) return null;

    await this.#seedFromDisk();
    const folder = this.#folderFor(record.docId);
    const seq = (this.#seq.get(folder) ?? 0) + 1;
    this.#seq.set(folder, seq);

    const failed = record.error !== undefined;
    const base = this.#basePath(folder, seq, record.operator, failed);

    try {
      await ensureDir(path.join(this.#dir, folder));
      await fs.writeFile(
        `${base}.json`,
        `${JSON.stringify(
          {
            ...(this.#runId ? { runId: this.#runId } : {}),
            seq,
            timestamp: new Date().toISOString(),
            ...record,
          },
          undefined,
          2
        )}\n`
      );
      await fs.writeFile(`${base}.txt`, render(record));
    } catch (error) {
      this.#warnOnce(error);
    }

    return { docId: record.docId, seq, operator: record.operator, folder };
  }

  /**
   * Attach a validation verdict to an already-written call. A judge that got HTTP 200 with an
   * unusable body is invisible at the client seam — this is the hook that makes it visible.
   */
  async logOutcome(handle: LlmCallHandle | null, outcome: Outcome): Promise<void> {
    if (!this.#enabled || handle === null) return;

    try {
      const dir = path.join(this.#dir, handle.folder);
      // Match the seq AND the operator: a resumed run can leave a previous attempt's files in the
      // same folder, and a seq-only prefix would annotate — or rename to .FAILED — the wrong call.
      const prefix = `${pad(handle.seq)}-${sanitize(handle.operator)}.`;
      const names = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix));

      const jsonName = names.find((name) => name.endsWith('.json'));
      const txtName = names.find((name) => name.endsWith('.txt'));
      if (!jsonName || !txtName) return;

      const jsonPath = path.join(dir, jsonName);
      const txtPath = path.join(dir, txtName);

      const parsed = JSON.parse((await fs.readFile(jsonPath)).toString());
      parsed.outcome = outcome;
      await fs.writeFile(jsonPath, `${JSON.stringify(parsed, undefined, 2)}\n`);
      await fs.appendFile(
        txtPath,
        `\n=== OUTCOME (${outcome.ok ? 'ok' : 'FAILED'}) ===\n${outcome.detail}\n`
      );

      // A rejected response is a failure even though the call returned 200 — rename so the
      // directory listing alone shows where to look.
      if (!outcome.ok && !jsonName.includes('.FAILED.')) {
        await fs.rename(jsonPath, jsonPath.replace(/\.json$/, '').concat('.FAILED.json'));
        await fs.rename(txtPath, txtPath.replace(/\.txt$/, '').concat('.FAILED.txt'));
      }
    } catch (error) {
      this.#warnOnce(error);
    }
  }

  /**
   * `<NNN>-<docId>`, numbered in the order documents are first seen — which IS the processing
   * order, since a document's first call happens while it is being processed. Without the prefix
   * a directory listing sorts lexicographically (`10011` before `2681`) and tells you nothing
   * about what ran when.
   */
  #folderFor(docId: number | null): string {
    if (docId === null) return '_no-doc';
    const key = String(docId);
    const existing = this.#folders.get(key);
    if (existing) return existing;

    const folder = `${pad(this.#folders.size + 1)}-${key}`;
    this.#folders.set(key, folder);
    return folder;
  }

  /**
   * Rebuild the document-order and per-document counters from what is already on disk.
   *
   * A resumed run is a second process writing into the same directory: without this it would
   * restart both counters at 1 and overwrite the first attempt's transcripts — destroying exactly
   * the diagnostic record this class exists to keep, in the crash case where it matters most.
   */
  async #seedFromDisk(): Promise<void> {
    if (this.#seeded) return;
    this.#seeded = true;

    try {
      const entries = await fs.readdir(this.#dir, { withFileTypes: true });
      const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

      for (const folder of folders.sort()) {
        const docKey = folder === '_no-doc' ? null : folder.replace(/^\d+-/, '');
        if (docKey !== null) this.#folders.set(docKey, folder);

        const files = await fs.readdir(path.join(this.#dir, folder));
        const maxSeq = files.reduce((max, name) => {
          const seq = Number(name.slice(0, name.indexOf('-')));
          return Number.isFinite(seq) && seq > max ? seq : max;
        }, 0);
        if (maxSeq > 0) this.#seq.set(folder, maxSeq);
      }
    } catch {
      // No directory yet (the common case: a fresh run) — nothing to seed.
    }
  }

  #basePath(folder: string, seq: number, operator: string, failed: boolean): string {
    const name = `${pad(seq)}-${sanitize(operator)}${failed ? '.FAILED' : ''}`;
    return path.join(this.#dir, folder, name);
  }

  /** Logging must never kill a run — warn once and let the pipeline continue. */
  #warnOnce(error: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(
      `LlmCallLog: cannot write transcripts to ${this.#dir} — continuing without them:`,
      error instanceof Error ? error.message : error
    );
  }
}

function pad(seq: number): string {
  return String(seq).padStart(3, '0');
}

/** Operators are code constants, but a path separator in one would silently scatter files. */
function sanitize(operator: string): string {
  return operator.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function render(record: LlmCallRecord): string {
  const head = `=== REQUEST (${record.provider} ${record.model}) ===`;
  const sampling = Object.keys(record.sampling).length > 0
    ? `--- sampling ---\n${JSON.stringify(record.sampling)}\n`
    : '';
  const request = `${head}\n${sampling}--- instructions ---\n${record.instructions}\n--- text ---\n${record.text}\n`;

  if (record.error !== undefined) {
    return `${request}\n=== ERROR ===\n${record.error}\n`;
  }

  const seconds = ((record.latencyMs ?? 0) / 1000).toFixed(1);
  const usage = record.usage
    ? `, in ${record.usage.inputTokens} / out ${record.usage.outputTokens} tok`
    : '';
  const finish = record.finishReason ? `, ${record.finishReason}` : '';
  return `${request}\n=== RESPONSE (${seconds}s${usage}${finish}) ===\n${record.response ?? ''}\n`;
}
