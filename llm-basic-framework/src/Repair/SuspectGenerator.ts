import type { CandidateGenerator } from '../Normalization/types';
import { ConceptRegistry, type ConceptRef, type SuspectPair } from '../ConceptRegistry/ConceptRegistry';
import type { GlossIndex } from './GlossIndex';
import crypto from 'crypto';

/**
 * Pure-code suspect surfacing (T6) — no LLM call happens here. `StreamingRepairer` (T9) is the only
 * consumer: it derives one document's `RegistryEvent`s from the registry it just wrote
 * (`eventsForDoc`), feeds them to `suspectsFor`, and hands the result to the judge. Everything in
 * this file is deterministic given registry state, so it needs no persistence of its own — crash
 * recovery just re-derives events from whatever the registry last had on disk (design R5).
 */

// --- events --------------------------------------------------------------------------------------

/** One organic thing that happened to the registry on document `d` — a new canonical, or a new
 * surface linked onto an existing one. Never a repair operation (merge/split/move/rename): those are
 * the repairer's own output, not input to suspect generation. */
export interface RegistryEvent {
  type: 'mint' | 'alias-add';
  ref: ConceptRef;
  surface: string;
}

/**
 * Derives document `d`'s registry events from persisted state rather than a live log — crash-safe
 * and replayable, since it is a pure function of whatever `ConceptRegistry.load()` produced (design
 * R5; wiki rule 10 — nothing reads `decisions.jsonl` at runtime).
 *
 * - **mint** = every canonical whose `firstSeen.doc === d`, one event per canonical, `surface` its
 *   own name.
 * - **alias-add** = every `AliasRecord` with `docId === d && decision === 'link'`.
 *
 * `mint`'s own self-alias (`ConceptRegistry.mint` always stores the canonical as `aliases[0]` with
 * `decision: 'mint'`, `docId: firstSeen.doc`) is deliberately NOT read here — it would double the
 * mint into a phantom alias-add on the same document. Any other alias decision (`merge`, `split`,
 * `move`, `migrated`) is repair provenance, not an organic mention, and is excluded even when its
 * `docId` happens to equal `d`.
 */
export function eventsForDoc(registry: ConceptRegistry, docId: number): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  for (const category of registry.conceptSchemes()) {
    for (const [canonical, record] of Object.entries(registry.concepts(category))) {
      const ref: ConceptRef = { category, canonical };
      if (record.firstSeen.doc === docId) {
        events.push({ type: 'mint', ref, surface: canonical });
      }
      for (const alias of record.labels) {
        if (alias.docId === docId && alias.decision === 'link') {
          events.push({ type: 'alias-add', ref, surface: alias.surface });
        }
      }
    }
  }
  return events;
}

// --- thresholds ------------------------------------------------------------------------------------

export interface SuspectThresholds {
  /** Cosine-similarity floor for a `GlossIndex.nearest` neighbour to become a suspect, per category
   * (of the neighbour, not the probing entity — a noisier category needs stronger evidence
   * regardless of who is probing it); key `'default'` required. */
  glossAnn: Map<string, number>;
  /** `minSim` floor passed to `blocker.candidates`, per queried category; key `'default'` required. */
  blocker: Map<string, number>;
  /** Floor below which `GlossIndex.aliasCoherence` flags a just-linked alias as drifted. */
  coherence: number;
}

/** Conservative (high) built-in defaults, used only when no `spec` is supplied at all — see
 * {@link parseThresholds}'s doc comment for why they default high rather than matching the
 * normalizer's recall-oriented `candidateMinSim` (0.5, `StreamingNormalizer.ts:146`). */
const CONSERVATIVE_DEFAULT: Record<'glossAnn' | 'blocker', number> = {
  glossAnn: 0.92,
  blocker: 0.88,
};

/**
 * Parses the `"Category=0.97,default=0.85"` env format into a per-category threshold map.
 *
 * Every suspect this module surfaces costs a judge call (T7) and, if wrongly raised, risks the
 * mint-over-merge asymmetry running backwards (a spurious `distinct`/`merge` verdict on a pair that
 * was never really confusable). Unlike `CandidateGenerator.minSim` — recall-only, deliberately
 * permissive (`types.ts:4-9`) because a `DecisionStrategy` sits downstream to filter — nothing sits
 * between a suspect and the repairer's adjudication call here, so the threshold itself has to do
 * the precision work. That is why both channels default HIGH when unconfigured.
 *
 * `spec === undefined` (no env override at all) returns the single conservative `'default'` entry
 * for `kind`. Any other string is parsed strictly: comma-separated `key=value` pairs, whitespace
 * trimmed around both key and value, and a `'default'` entry is REQUIRED — a spec that forgets it
 * would leave every unlisted category with no floor at all, which fails loudly here rather than
 * silently at query time.
 */
export function parseThresholds(spec: string | undefined, kind: 'glossAnn' | 'blocker'): Map<string, number> {
  if (spec === undefined) return new Map([['default', CONSERVATIVE_DEFAULT[kind]]]);

  const parsed = new Map<string, number>();
  for (const rawEntry of spec.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const eq = entry.indexOf('=');
    const key = eq === -1 ? '' : entry.slice(0, eq).trim();
    const value = eq === -1 ? NaN : Number(entry.slice(eq + 1).trim());
    if (!key || Number.isNaN(value)) {
      throw new Error(
        `SuspectGenerator: malformed ${kind} threshold entry "${entry}" in "${spec}" — expected "Category=0.9"`
      );
    }
    parsed.set(key, value);
  }

  if (!parsed.has('default')) {
    throw new Error(`SuspectGenerator: ${kind} threshold spec "${spec}" must include a "default" entry`);
  }
  return parsed;
}

function thresholdFor(map: Map<string, number>, category: string): number {
  const value = map.get(category) ?? map.get('default');
  if (value === undefined) {
    // Construction contract (doc comment above) requires 'default'; a caller that built the map by
    // hand and skipped it fails safe here — an unreachable floor (silence) rather than a crash mid-doc.
    console.warn(`SuspectGenerator: no "default" threshold entry — category "${category}" gets no probing`);
    return Number.POSITIVE_INFINITY;
  }
  return value;
}

function refKey(ref: ConceptRef): string {
  return `${ref.category} ${ref.canonical}`;
}

function refEquals(a: ConceptRef, b: ConceptRef): boolean {
  return a.category === b.category && a.canonical === b.canonical;
}

// --- SuspectGenerator --------------------------------------------------------------------------

export interface SuspectGeneratorParams {
  registry: ConceptRegistry;
  glossIndex: GlossIndex;
  /** Already `prepare()`d by the caller — this class only ever calls `candidates()` on it. */
  blocker: CandidateGenerator;
  thresholds: SuspectThresholds;
  /** Candidates kept per signal, per event. Matches `StreamingNormalizer`'s own default `k`
   * (`candidateK`) order of magnitude; small because every extra candidate is a possible judge call. */
  topK?: number;
}

export class SuspectGenerator {
  #registry: ConceptRegistry;
  #glossIndex: GlossIndex;
  #blocker: CandidateGenerator;
  #thresholds: SuspectThresholds;
  #topK: number;

  constructor(params: SuspectGeneratorParams) {
    this.#registry = params.registry;
    this.#glossIndex = params.glossIndex;
    this.#blocker = params.blocker;
    this.#thresholds = params.thresholds;
    this.#topK = params.topK ?? 5;
  }

  /**
   * Probes every event for candidate duplicates and, for alias-adds, a coherence drift — then
   * short-circuits every resulting pair against `ConceptRegistry.findAdjudicated` before returning it.
   *
   * Two signals per event:
   * - **union-blocker** — `blocker.candidates({mention: surface, category: c, k, minSim})` for
   *   EVERY registered category `c` (soft blocking: an in-category near-duplicate the normalizer's
   *   own candidate generator missed is as much a suspect as a cross-category one), per-category
   *   `thresholds.blocker` floor. Self-hits (the candidate resolving back to the event's own ref)
   *   are dropped.
   * - **gloss-ann** — `glossIndex.nearest(ref, k)` (cross-category, self already excluded by
   *   `GlossIndex`), filtered by the NEIGHBOUR's own category `thresholds.glossAnn` floor.
   *
   * Alias-add events additionally probe `aliasCoherence(ref, surface)` — mints never do, since a
   * mint's surface IS the canonical's own name (nothing to have drifted from). Below
   * `thresholds.coherence` it becomes a single-entity suspect (`b === a`, `signal: 'coherence'`).
   *
   * `surface` is passed through verbatim, never re-cased or re-trimmed — `GlossIndex.aliasCoherence`'s
   * leave-one-out exclusion keys on exact rendered text against the stored `AliasRecord.surface`
   * (T4 finding), so re-casing here would silently break that exclusion.
   *
   * Within one call, unordered pairs are deduped (first occurrence wins — events, then categories,
   * then candidates, all processed in a fixed order, so this is deterministic) before the adjudicated
   * check runs, so a pair surfaced twice by different signals only pays for one `findAdjudicated` +
   * `signature` computation.
   */
  async suspectsFor(events: RegistryEvent[], docId: number): Promise<SuspectPair[]> {
    const categories = this.#registry.conceptSchemes();
    const seen = new Set<string>();
    const suspects: SuspectPair[] = [];

    const emit = (pair: SuspectPair): void => {
      const key = [refKey(pair.a), refKey(pair.b)].sort().join('|');
      if (seen.has(key)) return;
      seen.add(key);

      const existing = this.#registry.findAdjudicated(pair.a, pair.b);
      if (existing) {
        const currentSignature = SuspectGenerator.signature(this.#registry, pair.a, pair.b);
        // '' is the "no computable signature" sentinel (retained suspect, low-confidence merge) and
        // must never compare equal to anything, including itself — a real sha256 hex digest never
        // equals '', so the plain !== below already gives '' its "always re-fires" behaviour for free.
        if (currentSignature === existing.signature) return;
      }
      suspects.push(pair);
    };

    for (const event of events) {
      for (const category of categories) {
        const minSim = thresholdFor(this.#thresholds.blocker, category);
        const candidates = await this.#blocker.candidates({
          mention: event.surface,
          category,
          k: this.#topK,
          minSim,
        });
        for (const candidate of candidates) {
          const b: ConceptRef = { category, canonical: candidate.canonical };
          if (refEquals(b, event.ref)) continue; // self-hit
          emit({ a: event.ref, b, signal: 'union-blocker', score: candidate.sim, docId });
        }
      }

      const neighbors = await this.#glossIndex.nearest(event.ref, this.#topK);
      for (const neighbor of neighbors) {
        const floor = thresholdFor(this.#thresholds.glossAnn, neighbor.ref.category);
        if (neighbor.sim < floor) continue;
        emit({ a: event.ref, b: neighbor.ref, signal: 'gloss-ann', score: neighbor.sim, docId });
      }

      if (event.type === 'alias-add') {
        const coherence = await this.#glossIndex.aliasCoherence(event.ref, event.surface);
        if (coherence < this.#thresholds.coherence) {
          emit({ a: event.ref, b: event.ref, signal: 'coherence', score: coherence, docId });
        }
      }
    }

    return suspects;
  }

  /**
   * The re-fire key: sha256 over both members' content, member order irrelevant
   * (`signature(a, b) === signature(b, a)`).
   *
   * Content per member = its sorted, case-folded alias-surface set plus its gloss — the same notion
   * of "has this entity's evidence changed" `GlossIndex`'s own `#signatureFor` uses for re-embed
   * staleness, applied here to re-fire staleness instead. Each member's half is serialized
   * independently, then the two halves are sorted (not the raw refs) before hashing, so which one
   * the caller happened to pass as `a` vs `b` never changes the digest. A member unknown to the
   * registry (already absorbed elsewhere) serializes as an empty surface set + null gloss — harmless
   * here, since `findAdjudicated` prunes stale entries naming a dead canonical before this is ever
   * compared against one (`ConceptRegistry.#pruneAdjudicated`).
   */
  static signature(registry: ConceptRegistry, a: ConceptRef, b: ConceptRef): string {
    const half = (ref: ConceptRef): string => {
      const surfaces = [...new Set(registry.labelSurfaces(ref.category, ref.canonical).map((s) => s.trim().toLowerCase()))].sort();
      // Persisted-signature dialect, FROZEN at the v5 vocabulary: the literal `gloss` key ships
      // inside `repair.adjudicated[].signature` strings in committed registries — renaming it
      // would mark every stored adjudication stale and re-fire re-adjudication across the corpus.
      const gloss = registry.concepts(ref.category)[ref.canonical]?.definition ?? null;
      return JSON.stringify({ surfaces, gloss });
    };
    const halves = [half(a), half(b)].sort();
    return crypto.createHash('sha256').update(halves.join(' ')).digest('hex');
  }
}
