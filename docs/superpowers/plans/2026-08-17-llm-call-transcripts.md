# Per-Run LLM Call Transcripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the full request and response of every LLM call to per-document, per-operator files under `<runDir>/llm-calls/`, including failures, so a single call can be read and manually retried against another model.

**Architecture:** A single `LlmCallLog` class is injected into `LlmClient`, the one chokepoint every call already passes through with `operator` and `docId` attached — so capture needs no call-site changes. Two judges that validate responses additionally call `logOutcome()` so schema failures (which return HTTP 200 with unusable content) are marked on disk. The knob deliberately stays out of `RunConfig` so it cannot rotate any `runId`.

**Tech Stack:** TypeScript on Node 24, ts-node (no build step), node:test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-17-llm-call-transcripts-design.md` (repo root `docs/`, NOT `llm-basic-framework/docs/`).
- All code work happens in `llm-basic-framework/` — every path below is relative to it unless it starts with `../`.
- **The knob must NOT enter `RunConfig` or its `extra` block.** Folding it in would rotate every `runId` and make a logged run incomparable with the committed arms. `bin/app.ts` reads `LLM_LOG` and passes a directory to the client factory; nothing else.
- Default ON; `LLM_LOG=0` disables.
- **No truncation** of instructions, text, or response. Fidelity is the point.
- A logging failure must never kill a run: `LlmCallLog` catches its own write errors, warns once, continues.
- `prompts/` must not change (a prompt edit rotates every arm's runId and fails the suite until `prompts/manifest.json` is deliberately updated — out of scope).
- Full suite `npm test` (883 tests, ~15-35 s) and `npm run typecheck` must pass after every task; `test/gate.test.ts` must stay green with no fixture change.
- **NUL-byte hazard:** `src/Evaluation/gold.ts` and `src/EntityRegistry/EntityRegistry.ts` contain deliberate raw NUL bytes — `file` reports them as data and plain `grep` treats them as binary (use `grep -a`). Neither is touched by this plan; do not edit them.
- Commit after each task with the repo identity: `git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit …`, message ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: The `LlmCallLog` class

**Files:**
- Create: `src/LlmClient/LlmCallLog.ts`
- Test: `src/LlmClient/LlmCallLog.test.ts`

**Interfaces:**
- Consumes: `ensureDir` from `../utils/fsUtils` (signature: `(dir: string) => Promise<void>`; note `writeJsonAtomic` exists there too but is NOT used here — transcripts are write-once, and the `.tmp` rename dance would litter the directory on crash).
- Produces — Task 2 (`LlmClient`) and Task 4 (the judges) depend on these exact signatures:

```typescript
export interface LlmCallRecord {
  operator: string;
  docId: number | null;
  provider: string;
  model: string;
  sampling: Record<string, unknown>;
  instructions: string;
  text: string;
  response?: string;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  finishReason?: string;
  error?: string;
}

export interface LlmCallHandle {
  docId: number | null;
  seq: number;
}

export class LlmCallLog {
  constructor(params: { dir: string; runId?: string; enabled?: boolean });
  get enabled(): boolean;
  write(record: LlmCallRecord): Promise<LlmCallHandle | null>;
  logOutcome(handle: LlmCallHandle | null, outcome: { ok: boolean; detail: string }): Promise<void>;
}
```

`write` returns `null` when disabled. `logOutcome` tolerates a `null` handle (no-op), appends the outcome to both files, and renames the pair to `.FAILED.json`/`.FAILED.txt` when `ok` is false.

- [ ] **Step 1: Write the failing test**

Create `src/LlmClient/LlmCallLog.test.ts`:

```typescript
import { LlmCallLog } from './LlmCallLog';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`calllog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `llm-call-log-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    operator: 'link-judge',
    docId: 2660,
    provider: 'ollama',
    model: 'gemma4:e2b-16k',
    sampling: { maxTokens: 64000 },
    instructions: 'You are a link judge.\nCandidates:\n1. Sandworm',
    text: 'Adjudicate.',
    response: '{"decisions": []}',
    usage: { inputTokens: 1203, outputTokens: 88 },
    latencyMs: 14400,
    finishReason: 'stop',
    ...overrides,
  } as Parameters<LlmCallLog['write']>[0];
}

describe('LlmCallLog', () => {
  it('writes a json/txt pair under <docId>/<NNN>-<operator>, numbered per document', async () => {
    const dir = await scratchDir('basic');
    const log = new LlmCallLog({ dir, runId: 'run-abc' });

    await log.write(record());
    await log.write(record({ operator: 'repair-judge' }));
    await log.write(record({ docId: 2707 }));

    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.json')));
    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.txt')));
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.json')));
    // numbering is per document, so doc 2707 starts at 001 again
    assert.ok(existsSync(path.join(dir, '2707', '001-link-judge.json')));

    const parsed = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.json'))).toString()
    );
    assert.equal(parsed.runId, 'run-abc');
    assert.equal(parsed.operator, 'link-judge');
    assert.equal(parsed.docId, 2660);
    assert.equal(parsed.seq, 1);
    assert.equal(parsed.model, 'gemma4:e2b-16k');
    assert.deepEqual(parsed.sampling, { maxTokens: 64000 });
    assert.equal(parsed.response, '{"decisions": []}');
    assert.ok(typeof parsed.timestamp === 'string');
  });

  it('writes prompts verbatim and unescaped into the txt rendering', async () => {
    const dir = await scratchDir('txt');
    const log = new LlmCallLog({ dir });
    await log.write(record());

    const txt = (await fs.readFile(path.join(dir, '2660', '001-link-judge.txt'))).toString();
    assert.match(txt, /=== REQUEST \(ollama gemma4:e2b-16k\) ===/);
    // multi-line instructions survive as real newlines, not \n escapes
    assert.ok(txt.includes('You are a link judge.\nCandidates:\n1. Sandworm'));
    assert.match(txt, /=== RESPONSE \(14\.4s, in 1203 \/ out 88 tok, stop\) ===/);
    assert.ok(txt.includes('{"decisions": []}'));
  });

  it('puts docId-less calls in _no-doc', async () => {
    const dir = await scratchDir('nodoc');
    const log = new LlmCallLog({ dir });
    await log.write(record({ docId: null, operator: 'ladder' }));
    assert.ok(existsSync(path.join(dir, '_no-doc', '001-ladder.json')));
  });

  it('marks a record carrying an error as FAILED', async () => {
    const dir = await scratchDir('err');
    const log = new LlmCallLog({ dir });
    await log.write(record({ response: undefined, error: 'ECONNRESET: socket hang up' }));

    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.FAILED.json')));
    assert.ok(existsSync(path.join(dir, '2660', '001-link-judge.FAILED.txt')));
    assert.ok(!existsSync(path.join(dir, '2660', '001-link-judge.json')));
    const parsed = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.FAILED.json'))).toString()
    );
    assert.match(parsed.error, /ECONNRESET/);
  });

  it('logOutcome annotates a success and renames the pair on failure', async () => {
    const dir = await scratchDir('outcome');
    const log = new LlmCallLog({ dir });

    const okHandle = await log.write(record());
    await log.logOutcome(okHandle, { ok: true, detail: '3 decisions accepted' });
    const okJson = JSON.parse(
      (await fs.readFile(path.join(dir, '2660', '001-link-judge.json'))).toString()
    );
    assert.deepEqual(okJson.outcome, { ok: true, detail: '3 decisions accepted' });

    const badHandle = await log.write(record({ operator: 'repair-judge' }));
    await log.logOutcome(badHandle, { ok: false, detail: 'reviews schema failed' });
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.FAILED.json')));
    assert.ok(existsSync(path.join(dir, '2660', '002-repair-judge.FAILED.txt')));
    assert.ok(!existsSync(path.join(dir, '2660', '002-repair-judge.json')));
    const badTxt = (await fs.readFile(path.join(dir, '2660', '002-repair-judge.FAILED.txt'))).toString();
    assert.match(badTxt, /=== OUTCOME \(FAILED\) ===/);
    assert.ok(badTxt.includes('reviews schema failed'));
  });

  it('writes nothing when disabled, and returns a null handle', async () => {
    const dir = await scratchDir('off');
    const log = new LlmCallLog({ dir, enabled: false });
    const handle = await log.write(record());
    assert.equal(handle, null);
    assert.equal(existsSync(dir), false);
    // a null handle must be a safe no-op, not a crash
    await log.logOutcome(handle, { ok: false, detail: 'ignored' });
  });

  it('never throws when the directory cannot be written', async () => {
    const dir = await scratchDir('unwritable');
    // A FILE where the log wants a DIRECTORY: every mkdir/write beneath it fails with ENOTDIR.
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not a directory');

    const log = new LlmCallLog({ dir });
    const handle = await log.write(record());   // must not reject
    await log.logOutcome(handle, { ok: false, detail: 'also must not reject' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd llm-basic-framework && node --require ts-node/register --test src/LlmClient/LlmCallLog.test.ts`
Expected: FAIL — `LlmCallLog.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/LlmClient/LlmCallLog.ts`:

```typescript
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
  /** Per-document call counter — the pipeline is sequential per document. */
  readonly #seq = new Map<string, number>();
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

    const folder = record.docId === null ? '_no-doc' : String(record.docId);
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

    return { docId: record.docId, seq };
  }

  /**
   * Attach a validation verdict to an already-written call. A judge that got HTTP 200 with an
   * unusable body is invisible at the client seam — this is the hook that makes it visible.
   */
  async logOutcome(handle: LlmCallHandle | null, outcome: Outcome): Promise<void> {
    if (!this.#enabled || handle === null) return;

    const folder = handle.docId === null ? '_no-doc' : String(handle.docId);
    try {
      const dir = path.join(this.#dir, folder);
      const prefix = `${pad(handle.seq)}-`;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --require ts-node/register --test src/LlmClient/LlmCallLog.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass — this task adds a new file with no callers yet, so nothing else can move.

- [ ] **Step 6: Commit**

```bash
git add src/LlmClient/LlmCallLog.ts src/LlmClient/LlmCallLog.test.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "LlmCallLog: per-doc, per-operator LLM transcripts (json + txt, FAILED marking)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Capture every call from `LlmClient`

**Files:**
- Modify: `src/LlmClient/LlmClient.ts` — `Args` (line 19-24), class fields (27-29), constructor (31-35), `send` (41-66)
- Test: `src/LlmClient/LlmClient.calllog.test.ts` (create)

**Interfaces:**
- Consumes: `LlmCallLog`, `LlmCallRecord`, `LlmCallHandle` from Task 1 (exact shapes in that task's Interfaces block).
- Produces: optional `callLog?: LlmCallLog` on `LlmClient`'s constructor `Args`, and a public getter `get callLog(): LlmCallLog | undefined` (Task 4's judges reach the log through the client they already hold, so they need no new constructor parameter). `send()` gains no new parameters and its return type is unchanged; on success it returns the `LlmResponse` as before, on throw it re-throws the original error after writing a `.FAILED` pair. `LlmClient` also exposes `lastCallHandle(): LlmCallHandle | null` returning the handle of the most recent `send`, so a judge can annotate the call it just made.

- [ ] **Step 1: Write the failing test**

Create `src/LlmClient/LlmClient.calllog.test.ts`:

```typescript
import { LlmCallLog } from './LlmCallLog';
import { LlmClient } from './LlmClient';
import type { LlmBackendBase } from './LlmClientBackendBase';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`clientlog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `llm-client-log-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

/** A backend that answers, or throws, and records what sampling it was handed. */
function fakeBackend(options: { throws?: Error } = {}) {
  const seen: unknown[] = [];
  const backend = {
    provider: 'fakeprovider',
    model: 'fakemodel',
    // Deliberately rejects temperature — the log must record what was SENT, not what was asked for.
    sampling: { temperature: false, topP: true, seed: false },
    async send(_instructions: string, _text: string, effective: unknown) {
      seen.push(effective);
      if (options.throws) throw options.throws;
      return {
        text: '{"ok": true}',
        usage: { inputTokens: 11, outputTokens: 22 },
        model: 'fakemodel',
        latencyMs: 1500,
        finishReason: 'stop' as const,
      };
    },
  };
  return { backend: backend as unknown as LlmBackendBase, seen };
}

describe('LlmClient → LlmCallLog', () => {
  it('writes a transcript for a successful call, recording effective sampling', async () => {
    const dir = await scratchDir('ok');
    const { backend } = fakeBackend();
    const client = new LlmClient({
      backend,
      callLog: new LlmCallLog({ dir }),
      defaultCallOptions: { temperature: 0, topP: 0.9 },
    });

    await client.send('INSTRUCTIONS', 'TEXT', { operator: 'link-judge', docId: 42 });

    const file = path.join(dir, '42', '001-link-judge.json');
    assert.ok(existsSync(file));
    const parsed = JSON.parse((await fs.readFile(file)).toString());
    assert.equal(parsed.provider, 'fakeprovider');
    assert.equal(parsed.instructions, 'INSTRUCTIONS');
    assert.equal(parsed.text, 'TEXT');
    assert.equal(parsed.response, '{"ok": true}');
    assert.deepEqual(parsed.usage, { inputTokens: 11, outputTokens: 22 });
    // temperature was dropped by the backend's sampling support, so it must NOT appear
    assert.equal(parsed.sampling.temperature, undefined);
    assert.equal(parsed.sampling.topP, 0.9);
  });

  it('writes a FAILED transcript when the backend throws, and still re-throws', async () => {
    const dir = await scratchDir('throw');
    const { backend } = fakeBackend({ throws: new Error('ECONNRESET') });
    const client = new LlmClient({ backend, callLog: new LlmCallLog({ dir }) });

    await assert.rejects(
      () => client.send('I', 'T', { operator: 'repair-judge', docId: 7 }),
      /ECONNRESET/
    );

    const file = path.join(dir, '7', '001-repair-judge.FAILED.json');
    assert.ok(existsSync(file));
    const parsed = JSON.parse((await fs.readFile(file)).toString());
    assert.match(parsed.error, /ECONNRESET/);
    assert.equal(parsed.response, undefined);
  });

  it('works with no callLog injected (existing behaviour unchanged)', async () => {
    const { backend } = fakeBackend();
    const client = new LlmClient({ backend });
    const response = await client.send('I', 'T', { operator: 'ladder', docId: null });
    assert.equal(response.text, '{"ok": true}');
    assert.equal(client.lastCallHandle(), null);
  });

  it('exposes the handle of the last call for outcome annotation', async () => {
    const dir = await scratchDir('handle');
    const { backend } = fakeBackend();
    const client = new LlmClient({ backend, callLog: new LlmCallLog({ dir }) });

    await client.send('I', 'T', { operator: 'link-judge', docId: 5 });
    assert.deepEqual(client.lastCallHandle(), { docId: 5, seq: 1 });

    await client.callLog!.logOutcome(client.lastCallHandle(), { ok: false, detail: 'bad json' });
    assert.ok(existsSync(path.join(dir, '5', '001-link-judge.FAILED.json')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --require ts-node/register --test src/LlmClient/LlmClient.calllog.test.ts`
Expected: FAIL — `callLog` is not a known property of `Args`, `lastCallHandle` does not exist.

- [ ] **Step 3: Implement**

In `src/LlmClient/LlmClient.ts`:

1. Add the import at the top, next to the existing `CostMeter` type import:

```typescript
import type { LlmCallHandle, LlmCallLog } from './LlmCallLog';
```

2. Add to `interface Args`, after `costMeter?: CostMeter;`:

```typescript
  /**
   * Full-fidelity transcripts (spec 2026-08-17). Injected here rather than at call sites: every
   * operator in the codebase already funnels through `send`, so this covers all of them, including
   * ones added later.
   */
  callLog?: LlmCallLog;
```

3. Add fields next to `#costMeter`:

```typescript
  #callLog?: LlmCallLog;
  #lastHandle: LlmCallHandle | null = null;
```

and in the constructor, after `this.#costMeter = args.costMeter;`:

```typescript
    this.#callLog = args.callLog;
```

4. Replace the body of `send` with this version (the cost-metering and error re-throw behaviour is
unchanged — the log is added around it):

```typescript
  async send(
    instructions: string,
    text: string,
    options: LlmSendOptions = {}
  ): Promise<LlmResponse> {
    const { operator, docId, ...callOptions } = options;
    const effective = this.#resolveOptions(callOptions);
    this.#lastHandle = null;

    try {
      const response = await this.#backend.send(instructions, text, effective);

      this.#costMeter?.record({
        operator: operator ?? 'unknown',
        docId: docId ?? null,
        provider: this.#backend.provider,
        model: response.model,
        usage: response.usage,
        latencyMs: response.latencyMs,
      });

      this.#lastHandle =
        (await this.#callLog?.write({
          operator: operator ?? 'unknown',
          docId: docId ?? null,
          provider: this.#backend.provider,
          model: response.model,
          sampling: effective as Record<string, unknown>,
          instructions,
          text,
          response: response.text,
          usage: response.usage,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
        })) ?? null;

      return response;
    } catch (error) {
      // A failed call is the most interesting one to inspect, so it is transcribed too — then the
      // original error is re-thrown, leaving every caller's never-abort posture untouched.
      await this.#callLog?.write({
        operator: operator ?? 'unknown',
        docId: docId ?? null,
        provider: this.#backend.provider,
        model: this.#backend.model,
        sampling: effective as Record<string, unknown>,
        instructions,
        text,
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.trim() : String(error),
      });
      console.error(error);
      throw error;
    }
  }
```

5. Add two accessors next to the existing `get costMeter()`:

```typescript
  get callLog(): LlmCallLog | undefined {
    return this.#callLog;
  }

  /**
   * The transcript handle of the most recent `send`, or null when logging is off or the call
   * threw. A judge that validates the response annotates it through this.
   */
  lastCallHandle(): LlmCallHandle | null {
    return this.#lastHandle;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --require ts-node/register --test src/LlmClient/LlmClient.calllog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass. Every existing `LlmClient` construction omits `callLog`, so the log is inert in the whole suite and the gate is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/LlmClient/LlmClient.ts src/LlmClient/LlmClient.calllog.test.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "LlmClient: transcribe every call (and every failure) through LlmCallLog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `LLM_LOG` in bin/app.ts

**Files:**
- Modify: `bin/app.ts` — imports, `CONFIG` literal (near `repairTopK`, ~line 120), `createLlmClient` (line 331-345), and its two call sites (line 215, line 498)
- Modify: `../.gitignore` (repo root, one level above `llm-basic-framework/`)

**Interfaces:**
- Consumes: `LlmCallLog` from Task 1; `callLog?: LlmCallLog` constructor arg from Task 2.
- Produces: env contract `LLM_LOG=0` disables (default on); transcripts at `<runDir>/llm-calls/`. **Nothing is added to `RunConfig`** — verified by the runId probe in Step 4.

- [ ] **Step 1: Add the import and the CONFIG knob**

In `bin/app.ts`, add to the imports (match the file's existing import style):

```typescript
import { LlmCallLog } from '../src/LlmClient/LlmCallLog';
```

In the `CONFIG` object literal, after the `repairTopK:` entry:

```typescript
  // Full-fidelity LLM transcripts under `<runDir>/llm-calls/` (spec 2026-08-17). On by default.
  // Deliberately NOT part of the runId: writing files does not change what the pipeline computes,
  // and folding it in would rotate every arm's runId and make a logged run incomparable with the
  // committed ones. That is also why it does NOT appear in the `extra` block below.
  llmLog: process.env.LLM_LOG !== '0',
```

- [ ] **Step 2: Thread it through the client factory**

`createLlmClient` currently takes `(backend, costMeter)`. The run directory is only known after
`runConfig` is resolved, and the factory is called at line 215 (after `runDir` exists) and line 498
(inside `createProcessors`, which also has `runDir` in scope as `incrementalDir`'s parent — check
the enclosing function's parameters and pass the same value both times). Change the signature to
take the log:

```typescript
function createLlmClient(
  backend: LlmBackendBase,
  costMeter: CostMeter,
  callLog?: LlmCallLog
): LlmClient {
  return new LlmClient({
    backend,
    costMeter,
    ...(callLog ? { callLog } : {}),
    // Sampling defaults are per-call and get filtered per backend: LlmClient drops any
    // parameter the provider does not accept rather than forwarding it into a 400.
    defaultCallOptions: {
      ...(CONFIG.temperature !== undefined ? { temperature: CONFIG.temperature } : {}),
      ...(CONFIG.topP !== undefined ? { topP: CONFIG.topP } : {}),
      ...(CONFIG.maxTokens !== undefined ? { maxTokens: CONFIG.maxTokens } : {}),
      ...(CONFIG.seed !== null && !Number.isNaN(CONFIG.seed) ? { seed: CONFIG.seed } : {}),
    },
  });
}
```

At line 215, construct the log once (right after `runDir` is computed) and pass it:

```typescript
  const callLog = new LlmCallLog({
    dir: `${runDir}/llm-calls`,
    runId: runConfig.runId,
    enabled: CONFIG.llmLog,
  });
  const llmClient = createLlmClient(backend, costMeter, callLog);
```

The ladder-ensemble call site (line ~498, `createLlmClient(buildLlmBackend({ provider, model }), costMeter)`) must pass the SAME log instance so ensemble calls land in the same tree — thread the log into `createProcessors` alongside the other values it already receives, and pass it there too. Read the enclosing function signature first and follow the parameter style already in use.

- [ ] **Step 3: Ignore transcripts in git**

Append to the repo-root `.gitignore` (the file already ends with `storage/cert.gov.ua/processed/experiments/`):

```
llm-calls/
```

Honest note for whoever reads this later: `storage/cert.gov.ua/processed/experiments/` is ALREADY
ignored, yet 1663 files under it are tracked — the committed arms were force-added. `git add -f`
overrides ignore rules regardless of how specific they are, so this new line does not make a
force-add safe. Its value is that a plain `git add -A` can never sweep transcripts in, and that the
name documents the intent. The real protection is the docs note in Task 5.

- [ ] **Step 4: Verify by hand — transcripts appear, runId does NOT change**

The environment has a pre-existing Node v26 crash on `npm start` (`buffer-equal-constant-time` uses
the removed `SlowBuffer`); use a local, never-committed `NODE_OPTIONS` require-shim for these
probes. Recipe is in the branch's earlier work
(`.superpowers/sdd/2026-08-16-single-category-iteration-loop/task-3-report.md` if it still exists;
otherwise: a small CommonJS file that defines `Buffer.SlowBuffer`, loaded via
`NODE_OPTIONS="--require /tmp/slowbuffer-shim.cjs"`).

```bash
# runId must be IDENTICAL with and without the knob — it is not part of RunConfig
STEPS=streamingGraphBuilder FLOW=incremental OUTPUT_DIR=/tmp/llmlog-a npm start 2>&1 | grep '^RUN '
LLM_LOG=0 STEPS=streamingGraphBuilder FLOW=incremental OUTPUT_DIR=/tmp/llmlog-a npm start 2>&1 | grep '^RUN '
rm -rf /tmp/llmlog-a
```
Expected: the two runIds are the SAME. (Contrast with `CATEGORIES`, which by design changes it.)
If they differ, the knob leaked into `RunConfig` — fix that before continuing.

Then a real 1-doc capture:

```bash
mkdir -p /tmp/llmlog-one && cp ../storage/cert.gov.ua/fetched/20.json /tmp/llmlog-one/
INPUT_DIR=/tmp/llmlog-one OUTPUT_DIR=/tmp/llmlog-out CATEGORIES=Software \
  STEPS=streamingPipeline FLOW=incremental CONDITION=llmlog-probe DECISIONS_LOG=1 \
  timeout 900 npm start
find /tmp/llmlog-out -path '*llm-calls*' | head -20
```
Expected: files like `/tmp/llmlog-out/experiments/<runId>/llm-calls/20/001-<operator>.json` and
`.txt`. Open one `.txt` and confirm the prompt is readable with real newlines. Record what you saw
in the report, then `rm -rf /tmp/llmlog-one /tmp/llmlog-out`.

- [ ] **Step 5: Full suite + typecheck, commit**

Run: `npm test && npm run typecheck` — all pass.

```bash
git add bin/app.ts ../.gitignore
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "LLM_LOG knob: transcripts under <runDir>/llm-calls, deliberately out of the runId

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mark schema failures in the two validating judges

**Files:**
- Modify: `src/DataProcessors/StreamingNormalizer.ts` — the `#linkJudge` catch block (~line 701-706)
- Modify: `src/DataProcessors/StreamingRepairer.ts` — `#send` (line 512-537) and the judge path around `#validate` (line 451-484, 674)
- Test: `src/DataProcessors/StreamingNormalizer.calllog.test.ts` (create)

**Interfaces:**
- Consumes: `client.lastCallHandle()` and `client.callLog` from Task 2.
- Produces: nothing later tasks depend on.

Why this task exists: a judge that returns HTTP 200 with unparseable or schema-invalid content is
invisible at the client seam — the call *succeeded*. This is precisely the measured failure mode
the feature targets (`gemma4:e4b-32k`'s repair-judge failing the `reviews` schema on large
prompts), so it must show up as `.FAILED` on disk.

- [ ] **Step 1: Write the failing test**

Create `src/DataProcessors/StreamingNormalizer.calllog.test.ts`:

```typescript
import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { LlmCallLog } from '../LlmClient/LlmCallLog';
import { LlmClient } from '../LlmClient/LlmClient';
import type { LlmBackendBase } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`nlog${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `normalizer-calllog-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function backendReturning(text: string) {
  return {
    provider: 'fakeprovider',
    model: 'fakemodel',
    sampling: { temperature: true, topP: true, seed: true },
    async send() {
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fakemodel',
        latencyMs: 1,
        finishReason: 'stop' as const,
      };
    },
  } as unknown as LlmBackendBase;
}

describe('link-judge transcript outcome', () => {
  it('marks the transcript FAILED when the judge response is unusable', async () => {
    const dir = await scratchDir('badjson');
    await fs.writeFile(
      path.join(dir, 'extractions', '1.json'),
      JSON.stringify({
        entities: [{ name: 'UAC-0002', category: 'HackerGroup', role: 'Attacker' }],
        relations: [],
        schemaProposals: [],
        metadata: { id: 1, title: 'test report', date: '2024-01-01' },
      })
    );

    const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
    const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
    await schemaRegistry.load();
    await entityRegistry.load();
    schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
    // A near-miss candidate so the judge is actually consulted.
    entityRegistry.mint('HackerGroup', 'UAC-0002x', { doc: 0, date: '2023-01-01' });
    entityRegistry.setRung('HackerGroup', 'UAC-0002x', 'g1');
    await schemaRegistry.save();
    await entityRegistry.save();

    const callLog = new LlmCallLog({ dir: path.join(dir, 'llm-calls') });
    // Valid HTTP, useless body — the exact failure mode the feature exists for.
    const llmClient = new LlmClient({ backend: backendReturning('I am not JSON at all'), callLog });
    const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });

    const normalizer = new StreamingNormalizer({
      inputDir: path.join(dir, 'extractions'),
      outputDir: path.join(dir, 'artifacts'),
      llmClient,
      schemaRegistry,
      entityRegistry,
      countryNameNormalizer: new CountryNameNormalizer({ llmClient, decisionLog }),
      decisionLog,
    });

    await normalizer.processFile('1.json');

    const files = await fs.readdir(path.join(dir, 'llm-calls', '1'));
    const judged = files.filter((name) => name.includes('link-judge') && name.endsWith('.json'));
    assert.ok(judged.length > 0, 'a link-judge transcript was written');
    assert.ok(
      judged.every((name) => name.includes('.FAILED.')),
      `expected FAILED marking, got ${judged.join(', ')}`
    );
    // and the document still completed — never-abort posture unchanged
    assert.ok(existsSync(path.join(dir, 'artifacts', '1.json')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --require ts-node/register --test src/DataProcessors/StreamingNormalizer.calllog.test.ts`
Expected: FAIL — the transcript is written but not marked `.FAILED` (the judge swallowed the parse error).

- [ ] **Step 3: Implement in StreamingNormalizer**

In `#linkJudge`, capture the handle right after the `send` that produces `response`, then annotate in
the catch. Concretely: immediately after the `this.#llmClient.send(...)` call whose result is
assigned to `response` (the one with `operator: 'link-judge'`, ~line 622), add:

```typescript
      const transcript = this.#llmClient.lastCallHandle();
```

and in the existing catch block (which currently logs and returns an empty map), before the
`return new Map();`:

```typescript
      await this.#llmClient.callLog?.logOutcome(transcript, {
        ok: false,
        detail: `link-judge response unusable, minting all: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
```

Declare `let transcript: ReturnType<LlmClient['lastCallHandle']> = null;` next to the existing
hoisted `let response: LlmResponse | undefined;` so the catch can see it (the `try` may throw before
the assignment). Import the `LlmClient` type if it is not already imported in that file.

- [ ] **Step 4: Implement in StreamingRepairer**

`#send` (line 512) returns only `response.text`, so the judge path cannot see the handle. Change it
to capture the handle on the instance right after the send:

```typescript
      response = await this.#llmClient.send(
        instructions,
        'Adjudicate the suspect components listed in your instructions. Output the JSON reviews object only.',
        { operator: kind, docId }
      );
      this.#lastTranscript = this.#llmClient.lastCallHandle();
      return response.text;
```

with a new private field next to the class's other fields:

```typescript
  #lastTranscript: ReturnType<LlmClient['lastCallHandle']> = null;
```

Then, in the judge path, after `const accepted = await this.#validate(response, due, docId);`
(line ~465) and after the retry's `#validate` call, annotate:

```typescript
    const transcript = this.#lastTranscript;
    await this.#llmClient.callLog?.logOutcome(
      transcript,
      accepted.length > 0
        ? { ok: true, detail: `${accepted.length} op(s) accepted` }
        : { ok: false, detail: 'no repair op survived validation' }
    );
```

Place it immediately after each `#validate` call so the retry's transcript is annotated with the
retry's outcome, not the first attempt's.

- [ ] **Step 5: Run tests**

Run: `node --require ts-node/register --test src/DataProcessors/StreamingNormalizer.calllog.test.ts`
Expected: PASS.

Then the two neighbouring suites that exercise these judges hardest:
`node --require ts-node/register --test src/DataProcessors/StreamingNormalizer.judge.test.ts src/DataProcessors/StreamingRepairer.test.ts`
Expected: PASS, unchanged — they inject no `callLog`, so `logOutcome` is a no-op there.

- [ ] **Step 6: Full suite + typecheck, commit**

Run: `npm test && npm run typecheck` — all pass, gate untouched.

```bash
git add src/DataProcessors/StreamingNormalizer.ts src/DataProcessors/StreamingRepairer.ts src/DataProcessors/StreamingNormalizer.calllog.test.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "Judges mark unusable responses as FAILED transcripts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Document it, and final verification

**Files:**
- Modify: `docs/RUNNING-EXPERIMENTS.md` — add a subsection after the fast-iteration-loop section (§3b, added 2026-08-17); read the neighbouring headers first and follow the document's lettered-subsection convention
- Modify: `CLAUDE.md` (in `llm-basic-framework/`) — one line in the "Modifying the Pipeline" section listing the new knob alongside `DECISIONS_LOG`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: the documented contract; nothing downstream.

- [ ] **Step 1: Write the docs section**

Add to `docs/RUNNING-EXPERIMENTS.md` (numbering adjusted to the document's convention):

````markdown
## Reading what the model actually saw — `llm-calls/`

Every run writes the full request and response of every LLM call to
`<runDir>/llm-calls/<docId>/<NNN>-<operator>.json` plus a `.txt` rendering of the same content:

```
<runDir>/llm-calls/
  _no-doc/            # calls with no document attached
  20/
    001-link-judge.json        001-link-judge.txt
    002-repair-judge.FAILED.json   002-repair-judge.FAILED.txt
  24/
    001-link-judge.json        001-link-judge.txt
```

`NNN` counts calls within one document, in order. The `.json` is the machine-readable record —
provider, model, the **effective** sampling actually sent, instructions, text, response, usage,
latency — and is self-contained enough to retry by hand against another model. The `.txt` is the
same thing laid out for reading.

**`.FAILED` marks the calls worth looking at first.** A call is marked failed when the backend
threw (timeout, connection reset) *or* when the judge could not use the response — an
unparseable body or a schema violation, which is an HTTP 200 and therefore invisible in
`decisions.jsonl` beyond a retry counter. The `outcome` field in the `.json` says which.

On by default. `LLM_LOG=0` turns it off. The knob is deliberately **not** part of the `runId`:
writing transcripts does not change what the pipeline computes, so a logged run and an unlogged
one are directly comparable — unlike `CATEGORIES`, which changes the population and does rotate
the id.

A full 204-document run writes roughly 30–50 MB of transcripts. `llm-calls/` is in `.gitignore`,
but note that `git add -f` on a run directory overrides ignore rules: **do not force-add a run
directory that still has its transcripts**, or delete `llm-calls/` first.
````

Add to `CLAUDE.md` in the paragraph that mentions `DECISIONS_LOG=1`:

```
`LLM_LOG=0` disables the full request/response transcripts otherwise written to
`<runDir>/llm-calls/` (per document, per operator; `.FAILED` marks calls the judge could not use).
```

- [ ] **Step 2: Verify the docs against the implementation**

Re-read the section and check every claim against the code you wrote: path shape, `.FAILED`
semantics, the `outcome` field name, the `LLM_LOG=0` spelling, and the runId claim (which Step 4 of
Task 3 probed). Fix anything that drifted.

- [ ] **Step 3: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck` — all pass.

```bash
git add docs/RUNNING-EXPERIMENTS.md CLAUDE.md
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "Docs: llm-calls transcripts (layout, FAILED marking, LLM_LOG, git caution)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: End-to-end smoke on real documents**

Run three documents through the local judge with transcripts on, and inspect the result:

```bash
mkdir -p /tmp/llmlog-smoke && cp ../storage/cert.gov.ua/fetched/{20,24,26}.json /tmp/llmlog-smoke/
INPUT_DIR=/tmp/llmlog-smoke OUTPUT_DIR=/tmp/llmlog-smoke-out CATEGORIES=Software \
  STEPS=streamingPipeline FLOW=incremental CONDITION=llmlog-smoke DECISIONS_LOG=1 \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:e2b-16k \
  timeout 2700 npm start
```

(If Ollama has no `gemma4:e2b-16k`, use whatever `curl -s localhost:11434/api/tags` lists, or the
`.env` default; do not pull models and do not switch to an expensive one. The pipeline needs the
`NODE_OPTIONS` shim from Task 3 Step 4.)

Then assert, and put the real output in the report:
- `find /tmp/llmlog-smoke-out -path '*llm-calls*' -name '*.json' | wc -l` — non-zero, and the count
  matches the number of `"op":"llm-call"` lines in `decisions.jsonl`
  (`grep -ac '"op":"llm-call"' /tmp/llmlog-smoke-out/experiments/*/decisions.jsonl`);
- one `.txt` opened and confirmed readable — real newlines, full prompt, full response;
- whether any `.FAILED` files appeared, and if so what their `outcome` says (this is a finding
  about the model, not a bug, but report it);
- `du -sh` of the `llm-calls` directory, so the size-per-document estimate in the docs can be
  checked against reality — correct the docs figure if it is off by more than 2×.

Clean up `/tmp/llmlog-smoke*` afterwards and confirm `git status` is clean.

- [ ] **Step 5: Report**

Summarize: the files created, the smoke results (counts, size, any `.FAILED`), the confirmed
runId-stability probe, and any deviations from this plan.
