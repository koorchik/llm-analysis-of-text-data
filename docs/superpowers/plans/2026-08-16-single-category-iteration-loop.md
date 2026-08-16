# Single-Category Fast-Iteration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `CATEGORIES` env knob to the streaming pipeline, a `--category` flag to `evaluate`, and a committed 22-doc dev-Software subset, so one algorithm-iteration loop on the local e4b arm takes ~5–10 min instead of ~3.5 h.

**Architecture:** The knob filters extraction entities/relations at plan-build time inside `StreamingNormalizer.processFile` (frozen extractions on disk untouched); it folds into the `runId` via the `RunConfig.extra` block like every other arm knob. `evaluate --category` filters the *gold table* (clusters, edges, nilLabels) plus the NIL event stream — the predicted partition needs no filtering because `clusterMetrics` already calls `restrictTo(sharedElements)` (`src/Evaluation/clusterMetrics.ts:350-355`). A `make-subset` helper materializes a committed doc-id list into a scratch `INPUT_DIR`.

**Tech Stack:** TypeScript on Node 24, ts-node (no build step), node:test, LIVR validation.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-single-category-iteration-loop-design.md` (repo root `docs/`, NOT `llm-basic-framework/docs/`).
- All code work happens in `llm-basic-framework/` — every path below is relative to it unless it starts with `../`.
- With `CATEGORIES` unset, behavior must be byte-for-byte identical: `test/gate.test.ts` must pass with **no fixture change**.
- Unknown category names in `CATEGORIES` fail fast at startup, before any LLM call.
- Full suite `npm test` (~872 tests, ~15 s) and `npm run typecheck` must pass after every task.
- `prompts/` must not change (a prompt edit rotates every arm's runId and fails the suite until `prompts/manifest.json` is deliberately updated — out of scope).
- **NUL-byte hazard:** `src/Evaluation/gold.ts` and `src/EntityRegistry/EntityRegistry.ts` contain deliberate raw NUL bytes, so `file` reports them as data and plain `grep` treats them as binary (use `grep -a`). Edit them only with targeted string replacements — never reformat or rewrite the whole file.
- Commit after each task with the repo identity: `git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit …`, message ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `CATEGORY_VALUES` + `parseCategories` in validationUtils

**Files:**
- Modify: `src/utils/validationUtils.ts` (category vocabulary lives here — the LIVR `oneOf` list at ~line 10-23 and the `Category` union at ~line 33)
- Test: `src/utils/parseCategories.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const CATEGORY_VALUES: readonly Category[]` and `export function parseCategories(raw: string | undefined): Category[] | undefined` — Task 3 (`bin/app.ts`) imports both. `parseCategories` returns `undefined` for unset/empty input, throws `Error` naming the offending values otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/utils/parseCategories.test.ts`:

```typescript
import { CATEGORY_VALUES, parseCategories } from './validationUtils';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('parseCategories', () => {
  it('returns undefined for unset or empty input', () => {
    assert.equal(parseCategories(undefined), undefined);
    assert.equal(parseCategories(''), undefined);
    assert.equal(parseCategories('   '), undefined);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    assert.deepEqual(parseCategories('Software'), ['Software']);
    assert.deepEqual(parseCategories(' Software , HackerGroup '), ['Software', 'HackerGroup']);
  });

  it('accepts every canonical category, including the two-word one', () => {
    assert.deepEqual(parseCategories(CATEGORY_VALUES.join(',')), [...CATEGORY_VALUES]);
    assert.deepEqual(parseCategories('Government Body'), ['Government Body']);
  });

  it('throws on unknown names, listing them and the valid vocabulary', () => {
    assert.throws(() => parseCategories('Sofware'), /Sofware/);
    assert.throws(() => parseCategories('Software,Nope'), /Nope/);
    assert.throws(() => parseCategories('software'), /software/); // exact-case only
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd llm-basic-framework && node --require ts-node/register --test src/utils/parseCategories.test.ts`
Expected: FAIL — `CATEGORY_VALUES` / `parseCategories` are not exported.

- [ ] **Step 3: Implement**

In `src/utils/validationUtils.ts`, add above the existing `const validator = new LIVR.Validator({...})`:

```typescript
/**
 * The fixed extraction category vocabulary — single source for the LIVR oneOf rule below, the
 * `Category` union, and the `CATEGORIES` env-knob validation in `bin/app.ts`.
 */
export const CATEGORY_VALUES = [
  'Organization',
  'HackerGroup',
  'Software',
  'Country',
  'Individual',
  'Domain',
  'Sector',
  'Government Body',
  'Infrastructure',
  'Device',
] as const;

/**
 * Parse the `CATEGORIES` env knob. Unset/blank means "all categories" (undefined). Unknown names
 * throw — the knob must fail at startup, not silently filter everything out mid-run.
 */
export function parseCategories(raw: string | undefined): Category[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
  const unknown = names.filter((name) => !(CATEGORY_VALUES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `CATEGORIES: unknown category ${unknown.map((name) => JSON.stringify(name)).join(', ')} — ` +
        `valid values: ${CATEGORY_VALUES.join(', ')}`
    );
  }
  return names as Category[];
}
```

Then replace the inline array in the LIVR rule so there is one source of truth:

```typescript
      category: ['required', 'string', { oneOf: [...CATEGORY_VALUES] }],
```

(Leave the existing `export type Category = 'Organization' | … | 'Device';` union untouched — no churn.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --require ts-node/register --test src/utils/parseCategories.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass — the LIVR rule change is value-identical, so the gate must be green.

- [ ] **Step 6: Commit**

```bash
git add src/utils/validationUtils.ts src/utils/parseCategories.test.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "CATEGORY_VALUES + parseCategories: category vocabulary as single exported source

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `categories` filter in StreamingNormalizer

**Files:**
- Modify: `src/DataProcessors/StreamingNormalizer.ts` — `interface Params` (~line 29), class fields (~line 111-130), constructor (~line 132+), `processFile` (~line 162-465)
- Test: `src/DataProcessors/StreamingNormalizer.categories.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 (takes a plain `string[]`; validation already happened in `bin/app.ts`).
- Produces: optional constructor param `categories?: string[]` on `StreamingNormalizer`. Semantics: when present, `processFile` drops every extraction entity whose *canonical* category (via `schemaRegistry.resolveCategory`, falling back to the raw name when unresolved) is not in the set, and every relation where either endpoint category is not in the set. The written artifact contains only kept entities/relations. When absent: exact current behavior.

- [ ] **Step 1: Write the failing test**

Create `src/DataProcessors/StreamingNormalizer.categories.test.ts` (scaffolding copied from the `setup` pattern in `StreamingNormalizer.judge.test.ts` — canned LLM, scratch dirs under `os.tmpdir()`):

```typescript
import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { StreamingNormalizer } from './StreamingNormalizer';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

let counter = 0;
async function scratchDir(tag: string): Promise<string> {
  const key = crypto.createHash('sha256').update(`cat${tag}${counter++}`).digest('hex').slice(0, 8);
  const dir = path.join(os.tmpdir(), `streaming-categories-${key}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'extractions'), { recursive: true });
  return dir;
}

function cannedLlm() {
  const prompts: string[] = [];
  const client = {
    async send(instructions: string) {
      prompts.push(instructions);
      return {
        text: '{"decisions": []}',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        latencyMs: 0,
        finishReason: 'stop' as const,
      };
    },
  };
  return { client: client as unknown as LlmClient, prompts };
}

async function setup(tag: string, categories?: string[]) {
  const dir = await scratchDir(tag);
  await fs.writeFile(
    path.join(dir, 'extractions', '1.json'),
    JSON.stringify({
      entities: [
        { name: 'LummaStealer', category: 'Software', role: 'Neutral' },
        { name: 'PikaBot', category: 'Software', role: 'Neutral' },
        { name: 'UAC-0006', category: 'HackerGroup', role: 'Attacker' },
      ],
      relations: [
        // Software–Software: survives a Software-only filter
        {
          head: 'LummaStealer', headCategory: 'Software',
          tail: 'PikaBot', tailCategory: 'Software', type: 'used-with',
        },
        // HackerGroup–Software: one endpoint filtered → dropped
        {
          head: 'UAC-0006', headCategory: 'HackerGroup',
          tail: 'LummaStealer', tailCategory: 'Software', type: 'uses',
        },
      ],
      schemaProposals: [],
      metadata: { id: 1, title: 'test report', date: '2024-01-01' },
    })
  );

  const schemaRegistry = new SchemaRegistry({ filePath: path.join(dir, 'schema.json') });
  const entityRegistry = new EntityRegistry({ filePath: path.join(dir, 'registry.json') });
  await schemaRegistry.load();
  await entityRegistry.load();
  schemaRegistry.admitCategory({ name: 'Software', definition: '', doc: 0 });
  schemaRegistry.admitCategory({ name: 'HackerGroup', definition: '', doc: 0 });
  // Pre-register the pair signatures the kept mentions can form, so #pairRuleJudge never fires
  // and the canned LLM is never consulted (all mentions mint — no candidates exist).
  schemaRegistry.admitPairRule(
    {
      source: { category: 'Software', role: 'Neutral' },
      target: { category: 'Software', role: 'Neutral' },
      relation: null,
    },
    0
  );
  await schemaRegistry.save();
  await entityRegistry.save();

  const llm = cannedLlm();
  const decisionLog = new DecisionLog({ filePath: path.join(dir, 'decisions.jsonl'), enabled: true });
  const normalizer = new StreamingNormalizer({
    inputDir: path.join(dir, 'extractions'),
    outputDir: path.join(dir, 'artifacts'),
    llmClient: llm.client,
    schemaRegistry,
    entityRegistry,
    countryNameNormalizer: new CountryNameNormalizer({ llmClient: llm.client, decisionLog }),
    decisionLog,
    ...(categories ? { categories } : {}),
  });
  return { dir, normalizer, llm, entityRegistry };
}

describe('StreamingNormalizer CATEGORIES filter', () => {
  it('keeps only listed categories in registry and artifact, drops half-filtered relations', async () => {
    const { dir, normalizer, entityRegistry } = await setup('filter', ['Software']);
    await normalizer.processFile('1.json');

    const snapshot = entityRegistry.snapshot();
    assert.ok(snapshot.categories['Software'], 'Software entities minted');
    assert.equal(snapshot.categories['HackerGroup'], undefined, 'HackerGroup never entered the registry');

    const artifact = JSON.parse(
      (await fs.readFile(path.join(dir, 'artifacts', '1.json'))).toString()
    );
    assert.deepEqual(
      artifact.entities.map((e: { name: string }) => e.name).sort(),
      ['LummaStealer', 'PikaBot']
    );
    assert.equal(artifact.relations.length, 1);
    assert.equal(artifact.relations[0].type, 'used-with');
  });

  it('is a no-op when categories is omitted', async () => {
    const { dir, normalizer, entityRegistry } = await setup('noop');
    await normalizer.processFile('1.json');

    const snapshot = entityRegistry.snapshot();
    assert.ok(snapshot.categories['HackerGroup'], 'HackerGroup minted as before');

    const artifact = JSON.parse(
      (await fs.readFile(path.join(dir, 'artifacts', '1.json'))).toString()
    );
    assert.equal(artifact.entities.length, 3);
    assert.equal(artifact.relations.length, 2);
  });
});
```

Note: if `entityRegistry.snapshot()` turns out not to expose a `categories` map, assert through
`entityRegistry.resolve('HackerGroup', 'UAC-0006')` (must be `null`/`undefined` in the filtered
run, truthy in the no-op run) instead — check the real `EntityRegistry` API before guessing
(remember: `grep -a` for that file). Same if the no-op run's pair-rule judge fires for the
unregistered HackerGroup signatures: that is fine — the canned LLM answers `{"decisions": []}`
and the assertions above do not count calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --require ts-node/register --test src/DataProcessors/StreamingNormalizer.categories.test.ts`
Expected: first test FAILS (HackerGroup present in registry/artifact — the `categories` param is currently accepted-and-ignored by TypeScript? No: it will fail *compilation* with "Object literal may only specify known properties" — that counts as the failing state). Second test may already pass.

- [ ] **Step 3: Implement**

In `src/DataProcessors/StreamingNormalizer.ts`:

1. Add to `interface Params` (after `candidateMinSim?: number;`):

```typescript
  /**
   * Fast-iteration category filter (spec 2026-08-16): when set, only mentions whose canonical
   * category is listed are normalized; everything else — and any relation touching it — is
   * dropped from plans and artifacts. Frozen extractions on disk are untouched. Unset = all.
   */
  categories?: string[];
```

2. Add the private field next to `#candidateMinSim`:

```typescript
  #categories: Set<string> | null;
```

and in the constructor:

```typescript
    this.#categories = params.categories ? new Set(params.categories) : null;
```

3. In `processFile`, right after `const extraction = JSON.parse(...)` and before the
`const plans: MentionPlan[] = extraction.entities.map(...)` line, insert:

```typescript
    // CATEGORIES filter: match on the canonical category (fall back to the raw name when the
    // schema has not seen it yet — first-doc case), so raw variants of a kept category survive.
    const keptEntities = this.#categories
      ? extraction.entities.filter((entity) => {
          const canonical = this.#schemaRegistry.resolveCategory(entity.category) ?? entity.category;
          return this.#categories!.has(canonical);
        })
      : extraction.entities;
```

and change the plan build to map over `keptEntities`:

```typescript
    const plans: MentionPlan[] = keptEntities.map((entity) => {
```

4. Replace the relation-stamping loop header (currently
`for (const relation of extraction.relations) {` under the `// Stamp relations` comment) with:

```typescript
    // A relation with a filtered-out endpoint has no resolvable normalizedHead/Tail — drop it.
    const keptRelations = this.#categories
      ? extraction.relations.filter((relation) => {
          const head =
            this.#schemaRegistry.resolveCategory(relation.headCategory) || relation.headCategory;
          const tail =
            this.#schemaRegistry.resolveCategory(relation.tailCategory) || relation.tailCategory;
          return this.#categories!.has(head) && this.#categories!.has(tail);
        })
      : extraction.relations;
    for (const relation of keptRelations) {
```

5. In the `writeJsonAtomic(outputFile, {...})` call at the end of `processFile`, write the kept
lists instead of the raw extraction fields:

```typescript
      entities: keptEntities,
      relations: keptRelations,
```

(`plans` stamps `plan.entity` in place and every plan's entity IS an element of `keptEntities`, so
this writes the stamped objects — same aliasing the current code relies on with
`extraction.entities`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --require ts-node/register --test src/DataProcessors/StreamingNormalizer.categories.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass. The gate (`test/gate.test.ts`) and walkthrough (`test/walkthrough.test.ts`) construct the normalizer without `categories`, so they exercise the no-op path and must be untouched.

- [ ] **Step 6: Commit**

```bash
git add src/DataProcessors/StreamingNormalizer.ts src/DataProcessors/StreamingNormalizer.categories.test.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "StreamingNormalizer: optional categories filter at plan-build time

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `CATEGORIES` through bin/app.ts and the runId

**Files:**
- Modify: `bin/app.ts` — the `CONFIG` literal (~line 55-135, add near `repairTopK`), the `runConfig = resolveRunConfig({... extra: {...}})` block (~line 161-205), and the `new StreamingNormalizer({...})` call (~line 542)

**Interfaces:**
- Consumes: `parseCategories` from Task 1 (`import { parseCategories } from '../src/utils/validationUtils';` — check the existing import block first; app.ts may already import from validationUtils), `categories?: string[]` param from Task 2.
- Produces: env contract `CATEGORIES=Software[,HackerGroup,…]`; run-card `extra.categories: string[] | null`; startup throw on unknown names.

- [ ] **Step 1: Add the knob to CONFIG**

In the `CONFIG` object literal, after the `repairTopK:` entry:

```typescript
  // Fast-iteration category filter (spec 2026-08-16): only listed canonical categories are
  // normalized; unset means all. parseCategories throws on unknown names at startup — module
  // evaluation time, before any LLM call. Folds into the runId below: a filtered run measures a
  // different population and must never share a directory with (or resume) a full arm.
  categories: parseCategories(process.env.CATEGORIES),
```

- [ ] **Step 2: Fold into the runId**

In the `extra: {...}` block of `resolveRunConfig`, after `repairTopK: CONFIG.repairTopK ?? null,`:

```typescript
      categories: CONFIG.categories ?? null,
```

- [ ] **Step 3: Pass to the normalizer**

In the `new StreamingNormalizer({...})` construction, next to the other spread-conditionals:

```typescript
    ...(CONFIG.categories ? { categories: CONFIG.categories } : {}),
```

- [ ] **Step 4: Verify fail-fast and runId isolation by hand**

```bash
CATEGORIES=Sofware FLOW=incremental npm start 2>&1 | head -5
```
Expected: immediate `Error: CATEGORIES: unknown category "Sofware" — valid values: …`, no `RUN <runId>` line, no LLM traffic.

```bash
STEPS=streamingGraphBuilder FLOW=incremental OUTPUT_DIR=/tmp/catid-a npm start 2>&1 | grep '^RUN '
CATEGORIES=Software STEPS=streamingGraphBuilder FLOW=incremental OUTPUT_DIR=/tmp/catid-a npm start 2>&1 | grep '^RUN '
rm -rf /tmp/catid-a
```
Expected: two different runIds (the knob is in the hash). `streamingGraphBuilder` on an empty run dir makes zero LLM calls, so this probe is free; if it errors on the empty registry after printing `RUN`, that is fine — the runId line is the assertion.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, gate untouched.

- [ ] **Step 6: Commit**

```bash
git add bin/app.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "CATEGORIES env knob: startup-validated, runId-folded, wired to StreamingNormalizer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `evaluate --category`

**Files:**
- Modify: `src/Evaluation/gold.ts` — add `selectCategory` next to `selectSplit` (~line 279). **NUL-byte hazard — targeted edits only.**
- Modify: `bin/evaluate.ts` — `Args` interface (~line 46), `parseArgs` (~line 56-95), usage string (~line 125), `main()` (~line 130-180)
- Test: `src/Evaluation/gold.test.ts` — append a `describe` block

**Interfaces:**
- Consumes: `GoldTable` shape (`clusters[].category`, `edges[].category`, `nilLabels[].category` all exist — verified).
- Produces: `export function selectCategory(table: GoldTable, category: string): GoldTable` (case-insensitive on the category name, consistent with `elementKey`'s lowercasing); CLI contract `--category <name>`.

- [ ] **Step 1: Write the failing test**

Append to `src/Evaluation/gold.test.ts` (match the file's existing import style — it already imports from `./gold`; add `selectCategory` to that import):

```typescript
describe('selectCategory', () => {
  const table = {
    version: 'gold-aliases-v2',
    inputContentHash: 'x',
    order: 'numeric-id',
    clusters: [
      { id: 'g1', category: 'Software', members: ['LummaStealer', 'Lumma'], stratum: 'a', split: 'dev' },
      { id: 'g2', category: 'HackerGroup', members: ['UAC-0006', 'UAC-6'], stratum: 'a', split: 'dev' },
    ],
    edges: [
      { category: 'Software', from: 'Lumma', to: 'LummaStealer', kind: 'isa' },
      { category: 'HackerGroup', from: 'UAC-6', to: 'UAC-0006', kind: 'isa' },
    ],
    nilLabels: [
      { docId: 1, category: 'Software', mention: 'LummaStealer', label: 'known', clusterId: 'g1' },
      { docId: 1, category: 'HackerGroup', mention: 'UAC-0006', label: 'known', clusterId: 'g2' },
    ],
  } as unknown as GoldTable;

  it('keeps only the named category across clusters, edges and nilLabels', () => {
    const sliced = selectCategory(table, 'Software');
    assert.deepEqual(sliced.clusters.map((c) => c.id), ['g1']);
    assert.equal(sliced.edges.length, 1);
    assert.equal(sliced.edges[0].category, 'Software');
    assert.deepEqual(sliced.nilLabels.map((l) => l.mention), ['LummaStealer']);
  });

  it('matches case-insensitively, like elementKey does', () => {
    assert.equal(selectCategory(table, 'software').clusters.length, 1);
  });

  it('returns empty slices for a category with no gold rows', () => {
    assert.equal(selectCategory(table, 'Device').clusters.length, 0);
  });
});
```

(If `gold.test.ts` does not already import `GoldTable` as a type or `assert`/`describe`/`it`, extend its imports accordingly — copy the file's own conventions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --require ts-node/register --test src/Evaluation/gold.test.ts`
Expected: FAIL — `selectCategory` is not exported.

- [ ] **Step 3: Implement `selectCategory`**

In `src/Evaluation/gold.ts`, directly after the `selectSplit` function body:

```typescript
/**
 * Restrict a gold table to one category — the fast-iteration loop's scoring slice
 * (spec 2026-08-16). Unlike selectSplit there is no membership subtlety: clusters, edges and NIL
 * labels all carry the category directly. Case-insensitive to match elementKey's lowercasing.
 */
export function selectCategory(table: GoldTable, category: string): GoldTable {
  const want = category.trim().toLowerCase();
  const match = (name: string) => name.trim().toLowerCase() === want;
  return {
    ...table,
    clusters: table.clusters.filter((cluster) => match(cluster.category)),
    edges: (table.edges ?? []).filter((edge) => match(edge.category)),
    nilLabels: table.nilLabels.filter((label) => match(label.category)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --require ts-node/register --test src/Evaluation/gold.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Wire the CLI flag**

In `bin/evaluate.ts`:

1. `Args` interface: add `category?: string;`
2. `parseArgs` switch: add

```typescript
      case '--category':
        args.category = argv[++i];
        break;
```

3. Usage string: change to

```
'usage: evaluate --gold <gold.json> [--split test|dev] [--category <name>] --run <runDir> [--run …] [--batch <entities.json>] [--json out.json]'
```

4. `main()`, after `const table = selectSplit(fullTable, args.split);` add:

```typescript
  const scored = args.category ? selectCategory(table, args.category) : table;
```

then replace every subsequent use of `table` in `main()` with `scored` (the `goldPartition`,
`labeledPairs`, `goldSummary` — both call sites — and `nilObservations` calls). Add
`selectCategory` to the existing `../src/Evaluation/gold` import.

5. NIL event stream: where events are mapped into `nilObservations`, filter first when the flag is
set — otherwise every out-of-category decision inflates the "no gold NIL label" warning:

```typescript
    const scoredEvents = args.category
      ? events.filter(
          (event) =>
            (event.category ?? '').trim().toLowerCase() === args.category!.trim().toLowerCase()
        )
      : events;
```

and pass `scoredEvents.map(...)` to `nilObservations`.

6. Make the slice visible in output — after the existing `split=…` console line, add:

```typescript
  if (args.category) {
    console.log(
      `category=${args.category} — single-category slice: NON-REPORTABLE, for fast iteration only`
    );
  }
```

- [ ] **Step 6: End-to-end check against a committed run**

```bash
npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software \
  --run ../storage/cert.gov.ua/processed/experiments/psi-link-gemma-e4b-union-934e13d70482
```
Expected: runs to completion; the gold summary line shows a much smaller cluster count than the
full dev split (10 multi-member Software clusters + Software singletons); the NON-REPORTABLE line
prints; no crash on NIL metrics. Then run once WITHOUT `--category` and confirm the numbers match
the pre-change output for the same command (no regression when the flag is off).

- [ ] **Step 7: Full suite + typecheck, commit**

Run: `npm test && npm run typecheck` — all pass.

```bash
git add src/Evaluation/gold.ts src/Evaluation/gold.test.ts bin/evaluate.ts
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "evaluate --category: single-category gold slice for the fast-iteration loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Committed 22-doc subset + make-subset helper

**Files:**
- Create: `gold/subsets/dev-software-22.txt`
- Create: `bin/make-subset.ts`
- Modify: `package.json` (add `"make-subset": "ts-node bin/make-subset.ts"` to scripts)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: CLI contract `npm run make-subset -- --list gold/subsets/dev-software-22.txt --from ../storage/cert.gov.ua/fetched --to <dir>`; the list-file format (one filename per line, `#` comments and blank lines ignored).

- [ ] **Step 1: Write the list file**

Create `gold/subsets/dev-software-22.txt` with exactly this content:

```
# Greedy covering set for the dev-split Software multi-member gold clusters (gold-aliases-v2):
# every one of the 21 member surfaces appears in >=2 of these docs' frozen gpt-5 extractions.
# Generated 2026-08-16 (spec: docs/superpowers/specs/2026-08-16-single-category-iteration-loop-design.md).
# Greedy: docs ranked by distinct members hit, ties to the lower numeric id; output sorted numerically.
20.json
24.json
26.json
2660.json
2707.json
2724.json
3028.json
10011.json
39934.json
40102.json
619229.json
703548.json
861292.json
1229152.json
1563322.json
3804703.json
6276567.json
6276824.json
6277063.json
6277285.json
6277896.json
6280422.json
```

- [ ] **Step 2: Write `bin/make-subset.ts`**

```typescript
#!/usr/bin/env ts-node
/**
 * Materialize a committed doc-list into a scratch INPUT_DIR for the fast-iteration loop
 * (spec 2026-08-16). Copies, never links: a run must not be able to mutate the corpus.
 *
 *   npm run make-subset -- --list gold/subsets/dev-software-22.txt \
 *                          --from ../storage/cert.gov.ua/fetched --to /tmp/subset-dev-software
 */
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

interface Args {
  list?: string;
  from?: string;
  to?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--list':
        args.list = argv[++i];
        break;
      case '--from':
        args.from = argv[++i];
        break;
      case '--to':
        args.to = argv[++i];
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.list || !args.from || !args.to) {
    console.error('usage: make-subset --list <file> --from <srcDir> --to <destDir>');
    process.exit(2);
  }

  const lines = (await fs.readFile(args.list, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const missing = lines.filter((file) => !existsSync(path.join(args.from!, file)));
  if (missing.length > 0) {
    // Fail before copying anything: a partial subset would score as a mysteriously-shrunken run.
    throw new Error(`missing from ${args.from}: ${missing.join(', ')}`);
  }

  await fs.mkdir(args.to, { recursive: true });
  for (const file of lines) {
    await fs.copyFile(path.join(args.from, file), path.join(args.to, file));
  }
  console.log(`${lines.length} docs → ${args.to}`);
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
```

Add to `package.json` scripts (next to `"hash-input"`):

```json
    "make-subset": "ts-node bin/make-subset.ts",
```

- [ ] **Step 3: Verify by running it**

```bash
npm run make-subset -- --list gold/subsets/dev-software-22.txt \
  --from ../storage/cert.gov.ua/fetched --to /tmp/subset-check
ls /tmp/subset-check | wc -l   # expect 22
rm -rf /tmp/subset-check
npm run make-subset -- --list gold/subsets/dev-software-22.txt \
  --from /nonexistent --to /tmp/subset-check 2>&1 | head -2   # expect the missing-files error, and
ls /tmp/subset-check 2>&1      # expect "No such file" — nothing was copied
```

- [ ] **Step 4: Typecheck + full suite, commit**

Run: `npm run typecheck && npm test` — all pass (no production code touched).

```bash
git add gold/subsets/dev-software-22.txt bin/make-subset.ts package.json
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "dev-software-22 subset list + make-subset helper for the fast-iteration loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Document the loop in RUNNING-EXPERIMENTS.md

**Files:**
- Modify: `docs/RUNNING-EXPERIMENTS.md` — add a new section after the streaming-run section (find the section describing full streaming runs / §3a replay; append the new section after it, renumbering nothing)

**Interfaces:**
- Consumes: every contract from Tasks 1–5 (env knob, flag, helper, list file).
- Produces: the documented loop; nothing downstream.

- [ ] **Step 1: Write the section**

Add to `docs/RUNNING-EXPERIMENTS.md` (adjust the section number to fit the document's actual numbering — read the neighboring headers first):

````markdown
## Fast iteration loop — single category, dev split (NON-REPORTABLE)

For algorithm iteration only. Every number this loop produces is non-reportable three times over:
dev split, single-category slice, subset corpus. Promotion ladder: iterate here → confirm on
full-corpus `CATEGORIES=Software` (~1 h on the local arm) → only then run the full test-split
protocol on all arms.

Why Software: it holds the densest gold signal (40 test + 10 dev multi-member clusters of 110
total) while Domain — 57% of all judge decisions on the e4b baseline — is almost entirely
singletons. The 22-doc list covers every member surface of all 10 dev-split Software multi-member
clusters at least twice.

```bash
# One-time per iteration session: materialize the committed subset
npm run make-subset -- --list gold/subsets/dev-software-22.txt \
  --from ../storage/cert.gov.ua/fetched --to /tmp/subset-dev-software

# Run the arm (pre-seed frozen extractions for these 22 docs per RUN-STREAMING.md §4 first)
INPUT_DIR=/tmp/subset-dev-software OUTPUT_DIR=/tmp/fastloop-out \
  STEPS=streamingPipeline FLOW=incremental CONDITION=fastloop-software \
  CATEGORIES=Software \
  LLM_PROVIDER=ollama LLM_MODEL=gemma4:e4b-32k \
  CANDIDATE_GENERATOR=union EMBEDDINGS=1 EMBEDDINGS_PROVIDER=ollama EMBEDDINGS_MODEL=embeddinggemma \
  DECISIONS_LOG=1 npm start

# Score on dev, Software only
npm run evaluate -- --gold gold/gold.json --split dev --allow-dev --category Software \
  --run /tmp/fastloop-out/experiments/<runId>
```

`CATEGORIES` drops non-listed mentions (and relations touching them) at plan-build time inside
`streamingNormalizer`; frozen extractions are untouched. It folds into the runId, so a filtered
run can never share a directory with a full arm. The input-hash mismatch against the frozen
corpus is expected — same status as the smoke test in RUN-STREAMING.md §3.

Every algorithm edit changes the runId (dirty-diff hash), so each iteration lands in a fresh run
directory under `/tmp/fastloop-out` — compare `results.json` across iterations, and delete the
directory when the session is done.
````

- [ ] **Step 2: Verify the docs' claims against the implementation**

Re-read the section and check each command verbatim against Tasks 1–5's actual contracts (flag
names, script name, list path). Run the `make-subset` command from the block once to prove it is
copy-pasteable.

- [ ] **Step 3: Commit**

```bash
git add docs/RUNNING-EXPERIMENTS.md
git -c user.name="Viktor Turskyi" -c user.email="koorchik@gmail.com" commit -m "Docs: fast single-category iteration loop (dev split, non-reportable)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite, typecheck, gate**

```bash
npm test && npm run typecheck
```
Expected: all ~872+ tests pass (including `test/gate.test.ts` with its original fixture) plus the new ones from Tasks 1, 2, 4.

- [ ] **Step 2: One real end-to-end smoke of the whole loop**

Run the three commands from the new RUNNING-EXPERIMENTS.md section against a **cheap judge stand-in** if Ollama/e4b is not available in the environment (any configured provider works — the loop's plumbing, not its score, is what's being smoked): materialize subset → pre-seed the 22 frozen extractions per RUN-STREAMING.md §4 → run with `CATEGORIES=Software` → `evaluate --split dev --allow-dev --category Software`. Expected: the run directory's `decisions.jsonl` contains ONLY Software-category decision events (`grep -a '"op":"decision"' | grep -v Software` → empty), and evaluate prints the NON-REPORTABLE line with plausible Software-slice numbers. If no LLM provider is reachable at all, run the pipeline with `REPAIR=0` against the pre-seeded extractions and accept judge-call failures — the category-purity grep on whatever events landed is still the assertion. Report honestly in the summary which variant ran.

- [ ] **Step 3: Report**

Summarize: what changed, the new loop commands, measured subset run time if a real model ran, and the reminder that all loop numbers are non-reportable.
