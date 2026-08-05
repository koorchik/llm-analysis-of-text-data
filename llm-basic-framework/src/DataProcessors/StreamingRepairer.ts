import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import {
  EntityRegistry,
  type DeferredPair,
  type EntityRef,
  type GranularityEdgeKind,
  type SuspectPair,
} from '../EntityRegistry/EntityRegistry';
import type { CandidateGenerator, RegistryChange } from '../Normalization/types';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { buildComponents, capComponents, type SuspectComponent } from '../Repair/components';
import type { GlossIndex } from '../Repair/GlossIndex';
import { restampArtifacts } from '../Repair/restampArtifacts';
import {
  SuspectGenerator,
  eventsForDoc,
  parseThresholds,
  type SuspectThresholds,
} from '../Repair/SuspectGenerator';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { sortByNumericId } from '../utils/fsUtils';
import {
  extractAndParseJson,
  normalizeRepairReviews,
  type RepairOpVerdict,
  type StreamingArtifact,
} from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

interface Params {
  artifactsDir: string;
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  entityRegistry: EntityRegistry;
  decisionLog: DecisionLog;
  glossIndex: GlossIndex;
  /**
   * The phase-1 blocker, already `prepare()`d by its owner (`bin/app.ts` shares the normalizer's
   * instance). This class only ever calls `candidates()` on it, through `SuspectGenerator`.
   */
  blocker: CandidateGenerator;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
  /** Defaults to T6's conservative built-ins — see `parseThresholds` for why they default HIGH. */
  thresholds?: SuspectThresholds;
  /** 8000 — fits the 8k local window that the deferred consolidator's 22.6k prompt overflowed. */
  tokenCap?: number;
  /** Candidates kept per signal, per event; matches the normalizer's own `candidateK`. */
  suspectTopK?: number;
  /** Invalidates the phase-1 blocker index after every applied op (`RegistryChangeType` already
   * carries 'merge'|'split'|'move'); without it the blocker keeps answering from a stale index. */
  onRegistryChange?: (event: RegistryChange) => void;
}

/**
 * The unordered identity of a suspect pair — `(a, b)` and `(b, a)` are the same suspect, and a
 * coherence suspect (`b === a`) keys on its single entity twice. JSON-encoded per member rather
 * than string-joined, for the same collision reason `Repair/components.ts` documents: the real
 * category domain contains spaces, so `"A B C"` is ambiguous.
 */
export function suspectPairKey(a: EntityRef, b: EntityRef): string {
  const left = JSON.stringify([a.category, a.canonical]);
  const right = JSON.stringify([b.category, b.canonical]);
  return left <= right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * **I1 — debt-free boundary** (design note, "Invariants"): after document `d`, every suspect the
 * document gathered has a verdict, an adjudicated memo, or a place in the spillover queue. Nothing
 * is ever silently dropped: a suspect that vanishes without one of those is a *lost* repair, which
 * the design's "registry is repair-debt-free at every boundary" claim depends on not happening.
 *
 * Exported as a free function (rather than living inside the class) so the violation itself is
 * directly testable — the class's own paths are written so it cannot fire, which would otherwise
 * make the assertion untestable and therefore unverifiable.
 */
export function assertSuspectsAccounted(
  docId: number,
  gathered: SuspectPair[],
  accounted: Set<string>
): void {
  const missing = gathered.filter((pair) => !accounted.has(suspectPairKey(pair.a, pair.b)));
  if (missing.length === 0) return;
  const named = missing
    .map((pair) => `${pair.a.category}/"${pair.a.canonical}" ~ ${pair.b.category}/"${pair.b.canonical}"`)
    .join(', ');
  throw new Error(
    `StreamingRepairer: I1 violated on document ${docId} — ${missing.length} gathered suspect(s) ` +
      `neither applied, adjudicated nor queued: ${named}`
  );
}

/**
 * **I2 — call cap** (design note; user ruling 2): one document pays for at most ONE first-attempt
 * repair-judge call. The completeness re-ask is budgeted and logged separately (`repair-judge-retry`,
 * itself capped at one), so it is not counted here.
 *
 * Counted per `docId` across the lifetime of one instance, not per `processDoc` invocation:
 * re-entering phase 2 for a document that already paid for a call *within the same process* is
 * exactly the budget bug this guards. Crash recovery is unaffected — it resumes in a fresh process
 * with empty counters (see the class comment's crash story).
 */
export function assertCallBudget(docId: number, firstAttempts: number): void {
  if (firstAttempts <= 1) return;
  throw new Error(
    `StreamingRepairer: I2 violated — ${firstAttempts} first-attempt repair-judge calls for document ${docId} (budget is 1)`
  );
}

/** How many mention snippets each entity contributes to its component block, most recent first. */
const EVIDENCE_PER_ENTITY = 3;
/** Hard ceiling on one rendered evidence line, so a long relation chain cannot dominate the block. */
const EVIDENCE_LINE_CHARS = 220;

/** One accepted op, with the component it belongs to and its entity names resolved to live refs. */
interface AcceptedOp {
  verdict: RepairOpVerdict;
  /** Index into the `due` component list. */
  component: number;
  /** merge.from · distinct.pair[0] · rung.finer · renamed.from · split.outOf · move.from · keep.entity */
  a: EntityRef;
  /** merge.into · distinct.pair[1] · rung.coarser · renamed.into · move.to — absent for split/keep. */
  b?: EntityRef;
}

const PAIR_OPS = new Set(['merge', 'distinct', 'rung', 'renamed']);

/**
 * Phase 2 of every document: synchronous, per-document registry repair (design note
 * `dissert/wiki/notes/streaming-repair-design.md`). Replaces the deferred `RegistryConsolidator`,
 * whose per-category saturation bet failed on the measured corpus — its Domain review arrived as one
 * 22,572-token prompt over 1,259 accumulated suspects. Event scoping dissolves that structurally:
 * the repair call is small *because* it runs every document.
 *
 * **Sequence** (Phase A read-only + LLM, Phase B mutate + save, matching `StreamingNormalizer`):
 * 1. `glossIndex.sync` + `eventsForDoc` — both pure functions of persisted registry state (design R5).
 * 2. Gather suspects: spillover (first-in) ∪ defer queue ∪ freshly generated (T6).
 * 3. Scope into components and cap them (T7); overflow is queued, never dropped.
 * 4. ONE `repair-judge` call over the due components. Usually there are none, and no call is made.
 * 5. Validate in code (wiki rule 7): schema (T2), listed-entity names, per-component completeness.
 * 6. Apply — code only, the full SKEIN v2 inventory: merge / distinct / rung / renamed / split / move / keep.
 * 7. Deterministic re-stamp of the affected artifacts (T8) — the only permitted artifact mutation.
 * 8. Bookkeeping and ONE `entityRegistry.save()`.
 * 9. Assert I1/I2 in memory (wiki rule 10: nothing reads `decisions.jsonl` at runtime).
 *
 * **Crash consistency.** The normalizer has already committed this document's artifact and registry
 * writes before phase 2 starts, so everything here is a repair of durable state. All of phase 2's
 * mutations land in ONE `save()`, and `setRepairedThrough(docId)` is part of that same write — so
 * `repairedThrough` can never claim a document whose repairs were not persisted. A crash between the
 * re-stamp (step 7) and that save re-runs phase 2 for the same document on resume, because
 * `repairedThrough < docId`: suspects re-derive identically from registry state, the `adjudicated`
 * memo suppresses everything already ruled on, and the re-stamp is idempotent (it rewrites an
 * artifact only when the rendered JSON actually differs). The cost of that window is therefore at
 * most one repeated repair call for the single in-flight document — the same one-in-flight-doc story
 * the streaming spec §5 tells for phase 1. Re-stamping *before* the save is deliberate in that
 * light: an artifact re-stamped through mutations that are then lost is re-derived correctly on the
 * next pass, whereas saving first and crashing before the re-stamp would leave artifacts pointing at
 * canonicals the registry no longer has, with `repairedThrough` already past them. The invariant
 * assertions run before that save for the same reason: a violated boundary must not be what gets
 * persisted, and since they throw, the on-disk registry stays exactly as phase 1 left it — including
 * the spillover queue this pass drained in memory but never committed.
 *
 * **Failure posture** (`StreamingNormalizer`'s): never abort a document. A repair-judge call that
 * throws sends every due pair to the spillover queue — logged and carried forward, so I1 still holds
 * and the next document picks the work back up.
 */
export class StreamingRepairer {
  #artifactsDir: string;
  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #entityRegistry: EntityRegistry;
  #decisionLog: DecisionLog;
  #glossIndex: GlossIndex;
  #prompts: PromptProvider;
  #suspects: SuspectGenerator;
  #tokenCap: number;
  #onRegistryChange?: (event: RegistryChange) => void;

  /** docId -> first-attempt repair-judge calls, the in-memory counter I2 is checked against. */
  #firstAttempts = new Map<number, number>();

  constructor(params: Params) {
    this.#artifactsDir = params.artifactsDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#entityRegistry = params.entityRegistry;
    this.#decisionLog = params.decisionLog;
    this.#glossIndex = params.glossIndex;
    this.#prompts = params.prompts ?? prompts;
    this.#tokenCap = params.tokenCap ?? 8000;
    this.#onRegistryChange = params.onRegistryChange;

    this.#suspects = new SuspectGenerator({
      registry: params.entityRegistry,
      glossIndex: params.glossIndex,
      blocker: params.blocker,
      thresholds:
        params.thresholds ?? {
          glossAnn: parseThresholds(undefined, 'glossAnn'),
          blocker: parseThresholds(undefined, 'blocker'),
          // Coherence reads the opposite way round from the other two: a suspect fires BELOW this
          // floor, so a LOW value is the conservative direction — the same "unconfigured runs stay
          // quiet" intent T6's high glossAnn/blocker defaults encode.
          coherence: 0.5,
        },
      topK: params.suspectTopK ?? 5,
    });
  }

  /** First-attempt repair calls charged to `docId` — for tests and the I2 assertion. */
  callsForDoc(docId: number): number {
    return this.#firstAttempts.get(docId) ?? 0;
  }

  /**
   * Standalone catch-up, for the `streamingRepairer` step and for a registry whose repair pass was
   * never run (an existing corpus, or a run that died mid-stream). Ascending document order, so the
   * `repairedThrough` high-water mark only ever moves forward.
   */
  async run(): Promise<void> {
    await this.#schemaRegistry.load();
    await this.#entityRegistry.load();
    if (!existsSync(this.#artifactsDir)) return;

    const files = sortByNumericId(await fs.readdir(this.#artifactsDir));
    for (const file of files) {
      const docId = await this.#docIdOf(file);
      if (docId === undefined) continue;
      if (docId <= this.#entityRegistry.repairState().repairedThrough) continue;
      await this.processDoc(file, docId);
    }
  }

  async processDoc(file: string, docId: number): Promise<void> {
    await this.#schemaRegistry.load();
    await this.#entityRegistry.load();

    console.time(`REPAIR ${file}`);
    try {
      // ---- Phase A: read-only + LLM ------------------------------------------------------------

      await this.#glossIndex.sync(this.#entityRegistry);
      const events = eventsForDoc(this.#entityRegistry, docId);

      const { gathered, consumedDeferred } = await this.#gather(events, docId);
      for (const pair of gathered) {
        await this.#decisionLog.log({
          doc: docId,
          op: 'suspect',
          pair: [pair.a.canonical, pair.b.canonical],
          categories: [pair.a.category, pair.b.category],
          signal: pair.signal,
          score: pair.score,
        });
      }

      const components = buildComponents(gathered);
      const evidence = await this.#gatherEvidence(components);
      const renderBlock = (component: SuspectComponent) => this.#renderComponent(component, 1, 1, evidence);
      const { due, spillover } = capComponents(components, renderBlock, this.#tokenCap);

      const spilled: SuspectPair[] = [...spillover];
      if (spillover.length > 0) {
        await this.#decisionLog.log({
          doc: docId,
          op: 'repair-spillover',
          size: spillover.length,
          reason: 'token-cap',
        });
      }

      let accepted: AcceptedOp[] = [];
      if (due.length > 0) {
        const outcome = await this.#adjudicate(due, evidence, docId);
        accepted = outcome.accepted;
        if (outcome.unresolved.length > 0) {
          spilled.push(...outcome.unresolved);
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-spillover',
            size: outcome.unresolved.length,
            reason: outcome.reason,
          });
        }
      }

      // ---- Phase B: mutate + save --------------------------------------------------------------

      const applied = await this.#apply(accepted, due, docId);
      spilled.push(...applied.rejected);
      if (applied.rejected.length > 0) {
        await this.#decisionLog.log({
          doc: docId,
          op: 'repair-spillover',
          size: applied.rejected.length,
          reason: 'op-rejected',
        });
      }

      if (applied.touched.size > 0) {
        await restampArtifacts({
          artifactsDir: this.#artifactsDir,
          entityRegistry: this.#entityRegistry,
          schemaRegistry: this.#schemaRegistry,
          files: this.#affectedFiles(applied.touched, docId),
        });
      }

      if (consumedDeferred.length > 0) this.#entityRegistry.clearDeferred(consumedDeferred);
      this.#entityRegistry.pushSpillover(spilled);
      this.#entityRegistry.setRepairedThrough(docId);

      // ---- Invariants (in-memory; nothing reads decisions.jsonl at runtime) ---------------------
      // Checked BEFORE the save, deliberately: a violated boundary invariant must not be the thing
      // that gets persisted. Throwing here leaves the on-disk registry exactly as phase 1 left it.

      assertSuspectsAccounted(docId, gathered, this.#accountedKeys(gathered, applied.applied, spilled));
      assertCallBudget(docId, this.callsForDoc(docId));

      // ONE save for every mutation above (global constraint: state written once per document).
      // The schema registry is never mutated here — the re-stamp only *reads* `resolveCategory` —
      // so there is nothing of ours to persist in it.
      await this.#entityRegistry.save();
    } finally {
      console.timeEnd(`REPAIR ${file}`);
    }
  }

  // --- step 2: gather ----------------------------------------------------------------------------

  /**
   * Spillover (first-in, per I1) ∪ defer-derived ∪ freshly generated suspects, deduplicated on the
   * unordered pair.
   *
   * Spillover and defer-derived pairs go through the same two filters `SuspectGenerator` already
   * applies to fresh ones: a member that is no longer a live canonical (absorbed by an earlier
   * document's merge/rename/split) drops out, and a pair whose adjudicated memo still matches its
   * current signature is suppressed. Both are what make the `''` sentinel behave — a retained
   * suspect from a low-confidence merge never matches, so it re-fires on the next occasion,
   * whereas a real `distinct` verdict stays suppressed until the members' content changes.
   */
  async #gather(
    events: ReturnType<typeof eventsForDoc>,
    docId: number
  ): Promise<{ gathered: SuspectPair[]; consumedDeferred: DeferredPair[] }> {
    const gathered: SuspectPair[] = [];
    const seen = new Set<string>();

    const admit = (pair: SuspectPair, prefiltered: boolean): void => {
      const key = suspectPairKey(pair.a, pair.b);
      if (seen.has(key)) return;
      if (!prefiltered && !this.#stillSuspect(pair)) return;
      seen.add(key);
      gathered.push(pair);
    };

    for (const pair of this.#entityRegistry.drainSpillover()) admit(pair, false);

    const consumedDeferred: DeferredPair[] = [];
    for (const entry of this.#entityRegistry.deferred()) {
      // Reviewed = consumed, whatever the verdict — the consolidator's rule
      // (`RegistryConsolidator.ts:275-277`): a pair left unpaired here must not re-queue forever.
      consumedDeferred.push(entry);
      const minted = this.#entityRegistry.resolve(entry.category, entry.mintedAs);
      if (!minted) continue; // the provisional mint was already absorbed — nothing left to decide
      for (const candidate of entry.candidates) {
        const resolved = this.#entityRegistry.resolve(entry.category, candidate);
        if (!resolved || resolved === minted) continue;
        admit(
          {
            a: { category: entry.category, canonical: minted },
            b: { category: entry.category, canonical: resolved },
            signal: 'defer',
            score: 1,
            docId: entry.docId,
          },
          false
        );
      }
    }

    // T6 already dropped self-hits, dead refs and signature-matched adjudications.
    for (const pair of await this.#suspects.suspectsFor(events, docId)) admit(pair, true);

    return { gathered, consumedDeferred };
  }

  /** Live members, and not already adjudicated under their current signature. */
  #stillSuspect(pair: SuspectPair): boolean {
    if (!this.#isLive(pair.a) || !this.#isLive(pair.b)) return false;
    const existing = this.#entityRegistry.findAdjudicated(pair.a, pair.b);
    if (!existing) return true;
    // '' is the "no computable signature" sentinel and must never compare equal to anything,
    // including itself — a sha256 hex digest never equals '', so `!==` already gives it that.
    return SuspectGenerator.signature(this.#entityRegistry, pair.a, pair.b) !== existing.signature;
  }

  #isLive(ref: EntityRef): boolean {
    return this.#entityRegistry.records(ref.category)[ref.canonical] !== undefined;
  }

  // --- step 4: render + call ---------------------------------------------------------------------

  /**
   * ONE `repair-judge` call over the due components, plus at most one completeness re-ask.
   *
   * Returns the accepted ops and, for components still incomplete after the re-ask, the suspects
   * that nothing ruled on — the caller queues those (I1).
   */
  async #adjudicate(
    due: SuspectComponent[],
    evidence: Map<string, string[]>,
    docId: number
  ): Promise<{ accepted: AcceptedOp[]; unresolved: SuspectPair[]; reason: string }> {
    const text = due.map((component, index) => this.#renderComponent(component, index + 1, due.length, evidence)).join('\n\n');

    // Charged and checked OUTSIDE the failure-tolerant block below: an I2 violation is a budget bug
    // in this class, not a provider failure, and must never be absorbed by the never-abort posture.
    this.#firstAttempts.set(docId, this.callsForDoc(docId) + 1);
    assertCallBudget(docId, this.callsForDoc(docId));

    let response: string | undefined;
    try {
      response = await this.#send(text, docId, 'repair-judge');
    } catch (error) {
      // Never abort the document (`StreamingNormalizer#linkJudge`'s posture): everything due is
      // queued for the next document rather than lost.
      console.error(`REPAIR-JUDGE failed for doc ${docId}, spilling every due suspect:`, error);
      return { accepted: [], unresolved: due.flatMap((component) => this.#allSuspectsOf(component, docId)), reason: 'judge-failed' };
    }

    let { accepted, incomplete } = await this.#validate(response, due, docId);

    if (incomplete.length > 0) {
      // ONE re-ask, containing only the components that were left incomplete — the same shape the
      // gloss retry takes (`StreamingNormalizer#validateGlosses`), so a model that keeps failing
      // cannot loop the document.
      const retryText = incomplete
        .map((componentIndex, position) => this.#renderComponent(due[componentIndex], position + 1, incomplete.length, evidence))
        .join('\n\n');
      let retryResponse: string | undefined;
      try {
        retryResponse = await this.#send(retryText, docId, 'repair-judge-retry');
      } catch (error) {
        console.error(`REPAIR-JUDGE-RETRY failed for doc ${docId}, spilling the incomplete components:`, error);
      }

      if (retryResponse !== undefined) {
        const retry = await this.#validate(retryResponse, incomplete.map((index) => due[index]), docId);
        // The re-ask re-states the whole component, so its verdicts REPLACE the first attempt's for
        // those components rather than merging with a set that was already judged incomplete.
        const retried = new Set(incomplete);
        accepted = accepted.filter((op) => !retried.has(op.component));
        accepted.push(
          ...retry.accepted.map((op) => ({ ...op, component: incomplete[op.component] }))
        );
        incomplete = retry.incomplete.map((index) => incomplete[index]);
      }
    }

    if (incomplete.length === 0) return { accepted, unresolved: [], reason: 'complete' };

    // Whatever the re-ask did settle still applies; only what it left open is queued.
    const covered = this.#coveredKeys(accepted);
    const unresolved = incomplete
      .flatMap((index) => this.#allSuspectsOf(due[index], docId))
      .filter((pair) => !covered.has(suspectPairKey(pair.a, pair.b)));
    return { accepted, unresolved, reason: 'incomplete' };
  }

  async #send(components: string, docId: number, kind: 'repair-judge' | 'repair-judge-retry'): Promise<string> {
    const instructions = this.#prompts.render('repair-judge', { components });
    const started = Date.now();
    console.time(`${kind.toUpperCase()} doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(
        instructions,
        'Adjudicate the suspect components listed in your instructions. Output the JSON reviews object only.',
        { operator: kind, docId }
      );
      return response.text;
    } finally {
      console.timeEnd(`${kind.toUpperCase()} doc ${docId}`);
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind,
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }

  /**
   * One component as the judge sees it — the design note's block shape
   * (`streaming-repair-design.md`, "The repair-judge call"):
   *
   * ```text
   * Component 1 of 2 · signal: gloss-ANN 0.87 + defer(link-judge, d4)
   *   A. Sandworm (HackerGroup)
   *      aliases: [Sandworm group, UAC-0002]  · minted d1
   *      gloss: "Russian GRU-attributed group, energy/SCADA targeting"
   *      evidence: d1 "the Sandworm group (also tracked as UAC-0002) deployed…"
   * ```
   *
   * Two additions to the illustrated shape, both required by the prompt's completeness rule (rule 6:
   * "every suspect pair listed in a component must receive exactly one op"): an explicit
   * `pairs to adjudicate` line and, for coherence suspects, a `coherence check` line. The note's
   * example is a two-entity component where the single pair is implicit; a three-entity component
   * with two edges is not, and a validator enforcing completeness must be checking against a list
   * the model was actually shown.
   */
  #renderComponent(
    component: SuspectComponent,
    index: number,
    total: number,
    evidence: Map<string, string[]>
  ): string {
    const letters = new Map<string, string>();
    component.entities.forEach((ref, position) => letters.set(refKey(ref), entityLetter(position)));

    const lines = [`Component ${index} of ${total} · signal: ${renderSignals(component)}`];

    for (const ref of component.entities) {
      const record = this.#entityRegistry.records(ref.category)[ref.canonical];
      const aliases = this.#entityRegistry
        .aliasSurfaces(ref.category, ref.canonical)
        // `mint` stores the canonical as its own first alias; the note's `aliases: []` for a
        // freshly-minted entity is what that exclusion looks like.
        .filter((surface) => surface.trim().toLowerCase() !== ref.canonical.trim().toLowerCase());
      const minted = record ? `d${record.firstSeen.doc}` : 'unknown';
      const gloss = record?.gloss ? `"${record.gloss}"` : '(none)';

      lines.push(`  ${letters.get(refKey(ref))}. ${ref.canonical} (${ref.category})`);
      lines.push(`     aliases: [${aliases.join(', ')}]  · minted ${minted}`);
      lines.push(`     gloss: ${gloss}`);
      for (const snippet of evidence.get(refKey(ref)) ?? ['(no stamped mention found)']) {
        lines.push(`     evidence: ${snippet}`);
      }
    }

    if (component.pairs.length > 0) {
      const pairs = component.pairs
        .map((pair) => {
          // Letter order, not the pair's own `(a, b)` order: `a` is whichever member this document's
          // event happened to probe from, which would otherwise read as `B–A` for no reason.
          const [first, second] = [letters.get(refKey(pair.a))!, letters.get(refKey(pair.b))!].sort();
          return `${first}–${second} (${signalLabel(pair)})`;
        })
        .join('; ');
      lines.push(`  pairs to adjudicate: ${pairs}`);
    }
    for (const ref of component.coherence) {
      lines.push(`  coherence check: ${letters.get(refKey(ref))} — does every listed alias belong to this entity?`);
    }

    return lines.join('\n');
  }

  /**
   * Evidence lines for every entity in every component: the most recent `EVIDENCE_PER_ENTITY`
   * stamped mentions, read from the artifacts themselves.
   *
   * The lookup is by `normalizedName` within the entity's own category — the stamp the normalizer
   * wrote — walking artifacts newest-first and stopping as soon as every entity is full. Artifacts
   * are named `<docId>.json`, so "recency" is the numeric file order. A snippet reconstructs the
   * mention's context deterministically from the artifact alone: the surface as extracted, the alias
   * it matched when that differs, and up to two relations the mention takes part in. This is a
   * deliberate simplification over quoting raw report text — the artifacts are already in the run
   * directory and are the *stamped* record, so evidence and re-stamp always agree about what a
   * mention resolved to. Only ever paid on a document that actually has due components.
   */
  async #gatherEvidence(components: SuspectComponent[]): Promise<Map<string, string[]>> {
    const wanted = new Map<string, EntityRef>();
    for (const component of components) {
      for (const ref of component.entities) wanted.set(refKey(ref), ref);
    }
    const evidence = new Map<string, string[]>();
    if (wanted.size === 0 || !existsSync(this.#artifactsDir)) return evidence;

    const files = sortByNumericId(await fs.readdir(this.#artifactsDir)).reverse();
    for (const file of files) {
      if (wanted.size === 0) break;
      let artifact: StreamingArtifact;
      try {
        artifact = JSON.parse((await fs.readFile(`${this.#artifactsDir}/${file}`)).toString()) as StreamingArtifact;
      } catch {
        continue; // an unreadable artifact costs evidence, never the document
      }
      const docId = Number(artifact.metadata?.id) || parseInt(file, 10) || 0;

      for (const entity of artifact.entities ?? []) {
        const key = refKey({ category: entity.category, canonical: entity.normalizedName ?? '' });
        if (!wanted.has(key)) continue;
        const snippets = evidence.get(key) ?? [];
        if (snippets.length >= EVIDENCE_PER_ENTITY) continue;
        snippets.push(renderSnippet(docId, entity.name, entity.matchedVia, artifact, entity.normalizedName!));
        evidence.set(key, snippets);
        if (snippets.length >= EVIDENCE_PER_ENTITY) wanted.delete(key);
      }
    }
    return evidence;
  }

  // --- step 5: validate --------------------------------------------------------------------------

  /**
   * Code validation after every prompt call (wiki rule 7), in three layers:
   *
   * (a) **schema** — `normalizeRepairReviews` (T2), which already drops unrecognized ops and demotes
   *     a missing/bad `confidence` to `'low'`;
   * (b) **listed names** — every entity an op names must case-insensitively match an entity listed in
   *     that component. A judge that invents a name is the repair-time equivalent of the link judge's
   *     unlisted-target problem, and the same strictness applies: reject the op, log it, adjudicate
   *     nothing;
   * (c) **completeness** — every suspect pair gets exactly one of merge/distinct/rung/renamed, and
   *     every coherence entity gets split/move ops or one keep. A second op for a pair already ruled
   *     on is rejected rather than applied, since "exactly one" is what makes the verdict set a
   *     function of the suspects.
   */
  async #validate(
    responseText: string,
    due: SuspectComponent[],
    docId: number
  ): Promise<{ accepted: AcceptedOp[]; incomplete: number[] }> {
    const reviews = normalizeRepairReviews(extractAndParseJson(responseText) || {}) || [];
    const accepted: AcceptedOp[] = [];
    const claimedPairs = new Set<string>();

    const reject = async (verdict: RepairOpVerdict, reason: string, detail: string) => {
      await this.#decisionLog.log({
        doc: docId,
        op: 'repair-op-rejected',
        verdict: verdict.op,
        reason,
        detail,
        by: 'StreamingRepairer',
      });
    };

    for (const review of reviews) {
      const componentIndex = review.component - 1;
      const component = due[componentIndex];
      if (!component) {
        await this.#decisionLog.log({
          doc: docId,
          op: 'repair-op-rejected',
          reason: 'unknown-component',
          detail: String(review.component),
          by: 'StreamingRepairer',
        });
        continue;
      }

      const listed = new Map(component.entities.map((ref) => [ref.canonical.trim().toLowerCase(), ref]));
      const find = (name: string) => listed.get(name.trim().toLowerCase());

      for (const verdict of review.ops) {
        const [nameA, nameB] = opEntityNames(verdict);
        const a = nameA ? find(nameA) : undefined;
        const b = nameB ? find(nameB) : undefined;
        if (!a || (nameB !== undefined && !b)) {
          await reject(verdict, 'unlisted-entity', [nameA, nameB].filter(Boolean).join(' ~ '));
          continue;
        }
        if ((verdict.op === 'split' || verdict.op === 'move') && !verdict.alias.trim()) {
          await reject(verdict, 'missing-alias', a.canonical);
          continue;
        }

        if (PAIR_OPS.has(verdict.op)) {
          const key = suspectPairKey(a, b!);
          if (claimedPairs.has(key)) {
            await reject(verdict, 'duplicate-op', `${a.canonical} ~ ${b!.canonical}`);
            continue;
          }
          claimedPairs.add(key);
        }

        accepted.push({ verdict, component: componentIndex, a, b });
      }
    }

    const incomplete: number[] = [];
    due.forEach((component, index) => {
      const ops = accepted.filter((op) => op.component === index);
      const covered = this.#coveredKeys(ops);
      const pairsDone = component.pairs.every((pair) => covered.has(suspectPairKey(pair.a, pair.b)));
      const coherenceDone = component.coherence.every((ref) =>
        ops.some(
          (op) =>
            ['split', 'move', 'keep'].includes(op.verdict.op) && refKey(op.a) === refKey(ref)
        )
      );
      if (!pairsDone || !coherenceDone) incomplete.push(index);
    });

    return { accepted, incomplete };
  }

  /** Pair keys an accepted op set rules on — pair ops by their two entities, coherence ops by theirs. */
  #coveredKeys(ops: AcceptedOp[]): Set<string> {
    const covered = new Set<string>();
    for (const op of ops) {
      if (PAIR_OPS.has(op.verdict.op) && op.b) covered.add(suspectPairKey(op.a, op.b));
      if (['split', 'move', 'keep'].includes(op.verdict.op)) covered.add(suspectPairKey(op.a, op.a));
    }
    return covered;
  }

  // --- step 6: apply -----------------------------------------------------------------------------

  /**
   * Applies accepted verdicts in the order the judge emitted them, re-checking liveness before each
   * one — an earlier op in the same component can absorb an endpoint a later op names. Every applied
   * mutation fires `onRegistryChange`, or the phase-1 blocker index goes stale.
   *
   * `rejected` collects the suspects of ops that could not be applied (a cross-category `rung`, a
   * registry primitive that refused): those pairs go back to the spillover queue, so a rejected op is
   * a deferral rather than a lost suspect (I1).
   */
  async #apply(
    accepted: AcceptedOp[],
    due: SuspectComponent[],
    docId: number
  ): Promise<{ applied: Set<string>; rejected: SuspectPair[]; touched: Set<string> }> {
    const applied = new Set<string>();
    const rejected: SuspectPair[] = [];
    const touched = new Set<string>();

    const spill = async (op: AcceptedOp, reason: string) => {
      await this.#decisionLog.log({
        doc: docId,
        op: 'repair-op-rejected',
        verdict: op.verdict.op,
        reason,
        detail: `${op.a.canonical}${op.b ? ` ~ ${op.b.canonical}` : ''}`,
        by: 'StreamingRepairer',
      });
      const b = PAIR_OPS.has(op.verdict.op) && op.b ? op.b : op.a;
      const key = suspectPairKey(op.a, b);
      // Re-queue the ORIGINAL suspect where one exists, so its signal and score survive into the
      // next document's component capping (and into RQ5's per-signal yield counts) rather than being
      // flattened to a scoreless synthetic pair that capping would evict first.
      const original = due[op.component]?.pairs.find((pair) => suspectPairKey(pair.a, pair.b) === key);
      rejected.push(original ?? { a: op.a, b, signal: b === op.a ? 'coherence' : 'union-blocker', score: 0, docId });
    };

    for (const op of accepted) {
      const { verdict, a, b } = op;
      if (!this.#isLive(a) || (b && !this.#isLive(b))) {
        // Absorbed by an earlier op in this same batch: the suspect no longer exists as posed, so it
        // needs no verdict (and `#accountedKeys` counts a dead member as resolved).
        await this.#decisionLog.log({
          doc: docId,
          op: 'repair-op-skipped',
          verdict: verdict.op,
          reason: 'endpoint-absorbed',
          detail: `${a.canonical}${b ? ` ~ ${b.canonical}` : ''}`,
          by: 'StreamingRepairer',
        });
        continue;
      }

      switch (verdict.op) {
        case 'merge': {
          // Mint-over-merge asymmetry at repair time (design note): a merge the judge cannot ground
          // in quoted evidence is applied as `distinct` with the retained-suspect sentinel, so it
          // re-fires the moment either member gains new evidence.
          if (verdict.confidence === 'low') {
            this.#adjudicateDistinct(a, b!, docId, '');
            await this.#logDistinct(a, b!, docId, verdict);
            applied.add(suspectPairKey(a, b!));
            break;
          }
          const survivor = this.#merge(a, b!, verdict);
          if (!survivor) {
            await spill(op, 'merge-refused');
            break;
          }
          if (a.category !== b!.category) {
            // The category correction is a result in its own right (`RegistryConsolidator.ts:341-347`).
            await this.#decisionLog.log({
              doc: docId,
              op: 'category-correction',
              from: { category: a.category, canonical: a.canonical },
              into: { category: b!.category, canonical: b!.canonical },
              by: 'StreamingRepairer',
            });
          }
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-merge',
            category: b!.category,
            from: a.canonical,
            // `applyMerges` picks the survivor by canonicalPolicy under transitive closure and
            // ignores the requested `into` — log what actually survived, never what was asked for.
            into: survivor,
            confidence: verdict.confidence,
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          this.#changed('merge', b!.category, survivor);
          touched.add(refKey({ category: b!.category, canonical: survivor }));
          applied.add(suspectPairKey(a, b!));
          break;
        }

        case 'distinct': {
          this.#adjudicateDistinct(a, b!, docId, SuspectGenerator.signature(this.#entityRegistry, a, b!));
          await this.#logDistinct(a, b!, docId, verdict);
          applied.add(suspectPairKey(a, b!));
          break;
        }

        case 'rung': {
          // Edge layers stay separated (wiki rule 5): a rung is a granularity edge and NEVER a merge.
          if (a.category !== b!.category) {
            await spill(op, 'cross-category-rung');
            break;
          }
          const kind: GranularityEdgeKind = verdict.edgeKind || 'part-of';
          const added = this.#entityRegistry.addGranularityEdge(a.category, {
            from: a.canonical,
            to: b!.canonical,
            kind,
            docId,
            decision: 'repairer',
            evidence: verdict.evidence || null,
          });
          if (!added) {
            await spill(op, 'edge-refused');
            break;
          }
          // Deviation from the design note, deliberate (§4.3 design R4): the pair is also recorded as
          // adjudicated. Without it a rung verdict leaves the pair unruled, so the same two entities
          // re-fire on every future signal and pay for a judge call that can only say `rung` again.
          this.#entityRegistry.pushAdjudicated({ a, b: b!, signature: SuspectGenerator.signature(this.#entityRegistry, a, b!), verdict: 'rung', docId });
          await this.#decisionLog.log({
            doc: docId,
            op: 'granularity-edge',
            category: a.category,
            from: a.canonical,
            to: b!.canonical,
            kind,
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          applied.add(suspectPairKey(a, b!));
          break;
        }

        case 'renamed': {
          if (a.category !== b!.category) {
            await spill(op, 'cross-category-rename');
            break;
          }
          // User ruling 1: a rename absorbs through `renameInto`, whose survivor is ALWAYS `to` —
          // canonicalPolicy has no opinion on which name is *current* and must not overrule it.
          if (!this.#entityRegistry.renameInto(a.category, { from: a.canonical, to: b!.canonical, docId, evidence: verdict.evidence || null })) {
            await spill(op, 'rename-refused');
            break;
          }
          // Both events are replayable (T11): the historical edge and the identity fold it implies.
          await this.#decisionLog.log({
            doc: docId,
            op: 'rename-edge',
            category: a.category,
            from: a.canonical,
            to: b!.canonical,
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-merge',
            category: a.category,
            from: a.canonical,
            into: b!.canonical,
            confidence: verdict.confidence,
            by: 'StreamingRepairer',
          });
          this.#changed('merge', a.category, b!.canonical);
          touched.add(refKey(b!));
          applied.add(suspectPairKey(a, b!));
          break;
        }

        case 'split': {
          const result = this.#entityRegistry.split(a.category, a.canonical, [verdict.alias], {
            docId,
            evidence: verdict.evidence || null,
          });
          if (!result) {
            await spill(op, 'split-refused');
            break;
          }
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-split',
            category: a.category,
            canonical: a.canonical,
            detached: result.moved,
            newCanonical: result.newCanonical,
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          this.#changed('split', a.category, result.newCanonical);
          touched.add(refKey(a));
          touched.add(refKey({ category: a.category, canonical: result.newCanonical }));
          applied.add(suspectPairKey(a, a));
          break;
        }

        case 'move': {
          if (!this.#entityRegistry.moveAlias(a, b!, verdict.alias, { docId, evidence: verdict.evidence || null })) {
            await spill(op, 'move-refused');
            break;
          }
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-move',
            alias: verdict.alias,
            from: a.canonical,
            to: b!.canonical,
            categories: [a.category, b!.category],
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          this.#changed('move', b!.category, b!.canonical);
          touched.add(refKey(a));
          touched.add(refKey(b!));
          applied.add(suspectPairKey(a, a));
          break;
        }

        case 'keep': {
          this.#entityRegistry.pushAdjudicated({
            a,
            b: a,
            signature: SuspectGenerator.signature(this.#entityRegistry, a, a),
            verdict: 'keep',
            docId,
          });
          await this.#decisionLog.log({
            doc: docId,
            op: 'repair-keep',
            category: a.category,
            entity: a.canonical,
            evidence: verdict.evidence || null,
            by: 'StreamingRepairer',
          });
          applied.add(suspectPairKey(a, a));
          break;
        }
      }
    }

    return { applied, rejected, touched };
  }

  /** Same-category `applyMerges`, or a cross-category `move` first. Returns the ACTUAL survivor. */
  #merge(a: EntityRef, b: EntityRef, verdict: RepairOpVerdict): string | undefined {
    if (a.category !== b.category) {
      // Upstream extraction misassigns categories (prompt rule 5); the correction is a `move` of the
      // whole record into the target category, then an ordinary same-category merge.
      if (!this.#entityRegistry.move(a.category, a.canonical, b.category)) return undefined;
      this.#changed('move', b.category, a.canonical);
      // `move` folds into an identically-named record when one already exists there, so the merge
      // may already be done by the time we get here.
      if (a.canonical === b.canonical) return b.canonical;
    }

    const summary = this.#entityRegistry.applyMerges(b.category, [
      {
        from: a.canonical,
        into: b.canonical,
        evidence: verdict.evidence || null,
        confidence: CONFIDENCE_SCORE[verdict.confidence],
      },
    ]);
    if (summary.survivors.length === 0) return undefined;
    return summary.survivors[0];
  }

  #adjudicateDistinct(a: EntityRef, b: EntityRef, docId: number, signature: string): void {
    this.#entityRegistry.pushAdjudicated({ a, b, signature, verdict: 'distinct', docId });
  }

  async #logDistinct(a: EntityRef, b: EntityRef, docId: number, verdict: RepairOpVerdict): Promise<void> {
    await this.#decisionLog.log({
      doc: docId,
      op: 'repair-distinct',
      pair: [a.canonical, b.canonical],
      categories: [a.category, b.category],
      confidence: verdict.confidence,
      // A demoted merge is not the same event as a judged `distinct`, and RQ2 scores them apart.
      demotedFrom: verdict.op === 'merge' ? 'merge' : null,
      by: 'StreamingRepairer',
    });
  }

  #changed(type: RegistryChange['type'], category: string, canonical: string): void {
    this.#onRegistryChange?.({ type, category, canonical });
  }

  // --- steps 7-9: re-stamp, bookkeeping, invariants -----------------------------------------------

  /**
   * The artifacts whose entities/relations can now resolve differently, derived from registry
   * provenance rather than by re-reading the corpus: every alias of a touched canonical carries the
   * `docId` that introduced it, and an artifact can only be affected by an op if it stamped one of
   * those surfaces. Cheap, and it never grows with corpus size. A listed file that does not exist is
   * skipped with a warning by `restampArtifacts` (T8's documented contract for exactly this caller).
   */
  #affectedFiles(touched: Set<string>, docId: number): string[] {
    const docs = new Set<number>([docId]);
    for (const key of touched) {
      const ref = parseRefKey(key);
      const record = this.#entityRegistry.records(ref.category)[ref.canonical];
      if (!record) continue;
      for (const alias of record.aliases) {
        if (alias.docId >= 0) docs.add(alias.docId);
      }
    }
    return sortByNumericId([...docs].map((id) => `${id}.json`));
  }

  /**
   * I1's accounting: a gathered suspect is settled when an op ruled on it, when the registry holds
   * an adjudicated memo for it, when it is in the queue that was just pushed, or when either member
   * stopped being a live canonical (absorbed — the suspect cannot exist any more).
   */
  #accountedKeys(gathered: SuspectPair[], applied: Set<string>, spilled: SuspectPair[]): Set<string> {
    const accounted = new Set<string>(applied);
    for (const pair of spilled) accounted.add(suspectPairKey(pair.a, pair.b));
    for (const entry of this.#entityRegistry.repairState().adjudicated) {
      accounted.add(suspectPairKey(entry.a, entry.b));
    }
    for (const pair of gathered) {
      if (!this.#isLive(pair.a) || !this.#isLive(pair.b)) accounted.add(suspectPairKey(pair.a, pair.b));
    }
    return accounted;
  }

  /** Every suspect a component carries, as pairs — the shape the spillover queue stores. */
  #allSuspectsOf(component: SuspectComponent, docId: number): SuspectPair[] {
    return [
      ...component.pairs,
      ...component.coherence.map(
        (ref): SuspectPair => ({ a: ref, b: ref, signal: 'coherence', score: 0, docId })
      ),
    ];
  }

  async #docIdOf(file: string): Promise<number | undefined> {
    try {
      const artifact = JSON.parse(
        (await fs.readFile(`${this.#artifactsDir}/${file}`)).toString()
      ) as StreamingArtifact;
      return Number(artifact.metadata?.id) || parseInt(file, 10) || 0;
    } catch {
      console.warn(`StreamingRepairer: skipping unreadable artifact ${file}`);
      return undefined;
    }
  }
}

// --- module helpers ------------------------------------------------------------------------------

/** The registry's own `confidence` column is numeric; the judge's is a three-valued enum. */
const CONFIDENCE_SCORE: Record<string, number> = { high: 1, medium: 0.5, low: 0 };

function refKey(ref: EntityRef): string {
  return JSON.stringify([ref.category, ref.canonical]);
}

function parseRefKey(key: string): EntityRef {
  const [category, canonical] = JSON.parse(key) as [string, string];
  return { category, canonical };
}

/** A..Z, then `E27`, `E28`… — the corpus's largest observed component is far below 26 entities. */
function entityLetter(position: number): string {
  return position < 26 ? String.fromCharCode(65 + position) : `E${position + 1}`;
}

const SIGNAL_LABELS: Record<SuspectPair['signal'], string> = {
  'gloss-ann': 'gloss-ANN',
  'union-blocker': 'union-blocker',
  coherence: 'coherence',
  defer: 'defer',
};

/** `gloss-ANN 0.87` — or `defer(link-judge, d4)`, which carries its document instead of a score. */
function signalLabel(pair: SuspectPair): string {
  if (pair.signal === 'defer') return `defer(link-judge, d${pair.docId})`;
  return `${SIGNAL_LABELS[pair.signal]} ${pair.score.toFixed(2)}`;
}

/**
 * The component header's signal summary: each distinct signal once, at its strongest score.
 * Coherence is named without a score — T7's `SuspectComponent.coherence` keeps only the entity ref,
 * so the drift score is not available here and printing a `0.00` would be a lie, not a default.
 */
function renderSignals(component: SuspectComponent): string {
  const strongest = new Map<string, SuspectPair>();
  for (const pair of component.pairs) {
    const current = strongest.get(pair.signal);
    if (!current || pair.score > current.score) strongest.set(pair.signal, pair);
  }
  const parts = [...strongest.values()].map(signalLabel);
  if (component.coherence.length > 0) parts.push('coherence');
  return parts.join(' + ') || 'none';
}

/**
 * One evidence line: `d12 "Sandworm group" (as Sandworm) — Sandworm -[attacks]-> Ukrenergo`. Built
 * from the artifact only, so it is reproducible from the run directory with no source-text access.
 */
function renderSnippet(
  docId: number,
  name: string,
  matchedVia: string | undefined,
  artifact: StreamingArtifact,
  canonical: string
): string {
  const via = matchedVia && matchedVia !== name ? ` (as ${matchedVia})` : '';
  const relations = (artifact.relations ?? [])
    .filter((relation) => relation.normalizedHead === canonical || relation.normalizedTail === canonical)
    .slice(0, 2)
    .map((relation) => `${relation.head} -[${relation.type}]-> ${relation.tail}`)
    .join('; ');
  const line = `d${docId} "${name}"${via}${relations ? ` — ${relations}` : ''}`;
  return line.length > EVIDENCE_LINE_CHARS ? `${line.slice(0, EVIDENCE_LINE_CHARS - 1)}…` : line;
}

/**
 * The entity names one op refers to, in `(a, b)` role order — `undefined` for `b` when the op names
 * a single entity. `renamed`'s `to` already arrives folded onto `into` (T2's normalizer), and
 * `split`/`move`'s `alias` is a surface form, not an entity, so it is validated separately.
 */
function opEntityNames(verdict: RepairOpVerdict): [string, string | undefined] {
  switch (verdict.op) {
    case 'merge':
    case 'renamed':
      return [verdict.from, verdict.into];
    case 'distinct':
      return [verdict.pair[0] ?? '', verdict.pair[1] ?? ''];
    case 'rung':
      return [verdict.finer, verdict.coarser];
    case 'split':
      return [verdict.outOf, undefined];
    case 'move':
      return [verdict.from, verdict.to];
    case 'keep':
    default:
      return [verdict.entity, undefined];
  }
}
