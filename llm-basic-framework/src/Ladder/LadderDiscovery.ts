import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import {
  CategoryLadder,
  CategoryLadderRung,
  SchemaRegistry,
} from '../SchemaRegistry/SchemaRegistry';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import {
  LadderProposal,
  LadderRungProposal,
  extractAndParseJson,
  normalizeLadderProposal,
} from '../utils/validationUtils';

/** One ensemble member: a label for provenance plus the client that runs it. */
export interface EnsembleMember {
  label: string;
  client: LlmClient;
}

interface Params {
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  entityRegistry: EntityRegistry;
  decisionLog: DecisionLog;
  prompts?: PromptProvider;
  /** Ensemble size when `members` is not given — N runs of `llmClient`. Spec floor is 3. */
  ensembleN?: number;
  /** Multi-model ensemble (LADDER_ENSEMBLE_MODELS). Overrides `ensembleN`. */
  members?: EnsembleMember[];
  /** Surfaces required before a ladder is first discovered (prompt input floor is 8). */
  minExamples?: number;
  /** Surfaces sent to the prompt at most (prompt input ceiling is 20). */
  maxExamples?: number;
  /** Prompt id; `ladder-placed-v2` additionally returns a placement per supplied surface. */
  promptId?: string;
}

/** A validator finding. `hard` findings reject the whole run; soft ones adjust the rung. */
interface Violation {
  rule: string;
  detail: string;
  hard: boolean;
}

/**
 * Granularity-ladder bootstrap (SKEIN v2): fires the `ladder` prompt once per category when
 * enough real surface forms exist, re-fires when the surface pool has grown ≥2×, and caches the
 * result in the category's `ladder` field in `schema.json`.
 *
 * **Pure LLM discovery.** No external reference tables or parsers (CPE, PSL, ISO-3166, BGP) are
 * bound in code, and no `deterministic` flag exists — every rung is defeasible by construction
 * (wiki note `isa-vs-partof-flags`, 2026-08-04).
 *
 * **The model owns exactly one semantic judgment per rung** — `preserving`, from the in-prompt
 * fact-rewrite test. Code derives the edge label (`coarsens-to` ⇔ preserving, `part-of` ⇔
 * widening) and never asks for `edgeKind` or `foldByDefault`. The `move` is descriptive only.
 *
 * **Ensemble disagreement fills `disputed`.** The prompt runs N≥3 times; any rung whose
 * `preserving` is not unanimous across valid runs — or omitted by some run — has `disputed: true`
 * forced by code. The model's own self-report stays an OR-input, never the sole source.
 */
export class LadderDiscovery {
  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #entityRegistry: EntityRegistry;
  #decisionLog: DecisionLog;
  #prompts: PromptProvider;
  #ensembleN: number;
  #members?: EnsembleMember[];
  #minExamples: number;
  #maxExamples: number;
  #promptId: string;
  /** Categories attempted this process — a failed discovery is not retried on every document. */
  #attempted = new Set<string>();

  constructor(params: Params) {
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#entityRegistry = params.entityRegistry;
    this.#decisionLog = params.decisionLog;
    this.#prompts = params.prompts ?? prompts;
    this.#ensembleN = Math.max(params.ensembleN ?? 3, 1);
    this.#members = params.members;
    this.#minExamples = params.minExamples ?? 8;
    this.#maxExamples = params.maxExamples ?? 20;
    this.#promptId = params.promptId ?? 'ladder';
  }

  /**
   * Trigger check for one category (called per document, cheap on the no-op path): fire when no
   * ladder is cached and ≥ `minExamples` distinct surfaces exist; re-fire when the pool has grown
   * ≥2× since the cached ladder (the deck's re-versioning rule).
   */
  async maybeDiscover(category: string, docId: number): Promise<CategoryLadder | undefined> {
    const cached = this.#schemaRegistry.getLadder(category);
    const surfaces = this.#surfaces(category);

    if (!cached) {
      if (surfaces.length < this.#minExamples) return undefined;
      const attemptKey = `${category}#1`;
      if (this.#attempted.has(attemptKey)) return undefined;
      this.#attempted.add(attemptKey);
      return this.#discover(category, docId, surfaces, 1);
    }

    if (surfaces.length >= 2 * Math.max(cached.exampleCount, 1)) {
      const attemptKey = `${category}#${cached.version + 1}`;
      if (this.#attempted.has(attemptKey)) return cached;
      this.#attempted.add(attemptKey);
      return (await this.#discover(category, docId, surfaces, cached.version + 1)) ?? cached;
    }

    return cached;
  }

  /** Distinct alias surfaces of a category, first-seen order, case-folded dedupe. */
  #surfaces(category: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const [, record] of Object.entries(this.#entityRegistry.records(category))) {
      for (const alias of record.aliases) {
        const key = alias.surface.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(alias.surface.trim());
      }
    }
    return out;
  }

  async #discover(
    category: string,
    docId: number,
    surfaces: string[],
    version: number
  ): Promise<CategoryLadder | undefined> {
    const definition =
      this.#schemaRegistry.getCategories().find((entry) => entry.name === category)?.definition ??
      '';
    const examples = surfaces.slice(0, this.#maxExamples);
    const prompt = this.#prompts.render(this.#promptId, {
      CATEGORY: category,
      DEFINITION: definition || '(no definition recorded — derive from the examples)',
      EXAMPLES: examples.join(', '),
    });

    const members: EnsembleMember[] =
      this.#members ??
      Array.from({ length: this.#ensembleN }, (_, index) => ({
        label: `run-${index + 1}`,
        client: this.#llmClient,
      }));

    const runs: Array<{ label: string; proposal: LadderProposal; violations: Violation[] }> = [];
    const rejectedRuns: Array<{ label: string; violations: Violation[] }> = [];

    for (const member of members) {
      const proposal = await this.#fireOnce(member, prompt, category, docId);
      if (!proposal) {
        rejectedRuns.push({
          label: member.label,
          violations: [{ rule: 'parse', detail: 'no parseable ladder JSON', hard: true }],
        });
        continue;
      }
      const violations = validateRun(category, proposal);
      if (violations.some((violation) => violation.hard)) {
        rejectedRuns.push({ label: member.label, violations });
        continue;
      }
      runs.push({ label: member.label, proposal, violations });
    }

    if (runs.length === 0) {
      console.warn(
        `LadderDiscovery: no valid ladder for "${category}" after ${members.length} run(s) — leaving uncached`
      );
      await this.#decisionLog.log({
        op: 'discover-ladder',
        doc: docId,
        category,
        version,
        outcome: 'rejected',
        rejectedRuns,
      });
      return undefined;
    }

    const { ladder, disagreements } = buildConsensus(runs.map((run) => run.proposal));
    const cachedLadder: CategoryLadder = {
      version,
      exampleCount: surfaces.length,
      runs: members.length,
      models: members.map((member) => member.label),
      rungs: ladder,
      placements: runs[0].proposal.placements ?? [],
      rejected: runs[0].proposal.rejected,
      notes: runs[0].proposal.notes,
      disagreements,
      discoveredAtDoc: docId,
    };

    this.#schemaRegistry.setLadder(category, cachedLadder, docId);
    await this.#bindRegistry(category, cachedLadder, docId);
    await this.#decisionLog.log({
      op: 'discover-ladder',
      doc: docId,
      category,
      version,
      outcome: 'cached',
      ladder: cachedLadder,
      validRuns: runs.length,
      softViolations: runs.flatMap((run) =>
        run.violations.map((violation) => `${run.label}: ${violation.rule} — ${violation.detail}`)
      ),
      rejectedRuns,
    });
    console.log(
      `LADDER ${category} v${version}: ${cachedLadder.rungs.length} rung(s) from ${runs.length}/${members.length} valid run(s)`
    );
    return cachedLadder;
  }

  /**
   * Retroactive rung binding — the pending-bucket payoff, pure code, zero LLM cost.
   *
   * The prompt requires every rung's `example` to be drawn from the input examples where one
   * already sits at that rung, and the inputs came from THIS registry — so after a ladder lands,
   * canonicals matching rung examples get their rung stamped, and consecutive matched rungs get
   * the derived granularity edge. Exact/alias resolution only (no reference tables, no fuzzing):
   * pure-LLM discovery stays intact, and star groups (`:*`) never bind — they are computed fold
   * targets, never real registry entities.
   */
  /**
   * Give existing entities their rung once a ladder lands.
   *
   * **Creates no edges, deliberately.** Until 2026-08-21 this chained consecutive rung *examples*
   * into a granularity edge, assuming a g0 example and a g1 example are one entity at two levels.
   * They are not — each rung cites whatever surface it happened to pick — so the chain manufactured
   * `Adobe Illustrator CC -coarsens-to-> MS Office`, `CVE-2020-7048 -coarsens-to-> MS Office`,
   * `Intel -coarsens-to-> Adobe`. On the committed arms those fabrications were 15 of 129 edges
   * (opus-5), 21 of 82 (e2b) and 25 of 33 (e4b). An edge asserts a relation between two specific
   * entities and may only come from a judge that was shown both.
   */
  async #bindRegistry(category: string, ladder: CategoryLadder, docId: number): Promise<void> {
    const matched: Array<{ rung: CategoryLadderRung; canonical: string }> = [];
    for (const rung of ladder.rungs) {
      if (rung.example.includes(':*')) continue;
      const canonical = this.#entityRegistry.resolve(category, rung.example);
      if (!canonical) continue;
      this.#entityRegistry.setRung(category, canonical, `g${rung.g}` as 'g0' | 'g1' | 'g2' | 'g3');
      matched.push({ rung, canonical });
    }

    // Placements: the discovery call already read every supplied surface in order to derive the
    // ladder, so it can say where each one sits at no extra cost. This is the catch-up for
    // everything minted before the ladder existed.
    const available = new Set(ladder.rungs.map((rung) => rung.g));
    let bound = matched.length;
    for (const placement of ladder.placements ?? []) {
      if (!placement.surface || !available.has(placement.g)) continue;
      const canonical = this.#entityRegistry.resolve(category, placement.surface);
      if (!canonical) continue;
      if (matched.some((entry) => entry.canonical === canonical)) continue;
      this.#entityRegistry.setRung(
        category,
        canonical,
        `g${placement.g}` as 'g0' | 'g1' | 'g2' | 'g3'
      );
      bound += 1;
    }

    await this.#decisionLog.log({
      op: 'ladder-placements',
      doc: docId,
      category,
      version: ladder.version,
      bound,
      offered: (ladder.placements ?? []).length + matched.length,
    });
  }

  async #fireOnce(
    member: EnsembleMember,
    prompt: string,
    category: string,
    docId: number
  ): Promise<LadderProposal | undefined> {
    const started = Date.now();
    let response: LlmResponse | undefined;
    try {
      response = await member.client.send(prompt, `Derive the ladder for category "${category}".`, {
        operator: 'ladder',
        docId,
      });
      return normalizeLadderProposal(extractAndParseJson(response.text) || {});
    } catch (error) {
      console.error(`LADDER call failed for "${category}" (${member.label}):`, error);
      return undefined;
    } finally {
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind: 'ladder',
        seconds: (Date.now() - started) / 1000,
        model: response?.model ?? member.label,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }
}

/**
 * Per-run semantic validators — the prompt already warns about every one of these, and code
 * checks them anyway (deck rule 7: belt and braces).
 */
export function validateRun(category: string, proposal: LadderProposal): Violation[] {
  const violations: Violation[] = [];
  const rungs = [...proposal.ladder].sort((a, b) => a.g - b.g);

  // Category itself is never a rung — drop the offender rather than the run.
  const categoryKey = category.trim().toLowerCase();
  proposal.ladder = rungs.filter((rung) => {
    const isCategoryItself =
      rung.example.trim().toLowerCase() === categoryKey ||
      rung.alias.trim().toLowerCase() === categoryKey;
    if (isCategoryItself && rung.g > 0) {
      violations.push({
        rule: 'category-as-rung',
        detail: `dropped g${rung.g} "${rung.example}" — the category itself is never a rung`,
        hard: false,
      });
      return false;
    }
    return true;
  });
  const kept = proposal.ladder;

  if (!kept.some((rung) => rung.g === 0)) {
    violations.push({ rule: 'missing-g0', detail: 'no g0 rung', hard: true });
    return violations;
  }
  if (kept.length > 4) {
    violations.push({ rule: 'max-rungs', detail: `${kept.length} rungs (max 4)`, hard: true });
  }
  const gs = kept.map((rung) => rung.g);
  if (new Set(gs).size !== gs.length) {
    violations.push({ rule: 'duplicate-g', detail: `g values ${gs.join(',')}`, hard: true });
  }

  // Soft: a non-g0 rung without a usable preserving verdict falls back to widening (fold stays
  // off — the safe failure) and is marked disputed.
  for (const rung of kept) {
    if (rung.g === 0) continue;
    if (rung.preserving === undefined) {
      violations.push({
        rule: 'missing-preserving',
        detail: `g${rung.g} "${rung.example}" — forced preserving: false (safe default), disputed`,
        hard: false,
      });
      rung.preserving = false;
      rung.disputed = true;
    }
    if (!rung.foldTest.trim()) {
      violations.push({
        rule: 'missing-foldtest',
        detail: `g${rung.g} "${rung.example}" — no foldTest recorded, disputed`,
        hard: false,
      });
      rung.disputed = true;
    } else {
      if (!rung.foldTest.includes('->')) {
        violations.push({
          rule: 'foldtest-no-rewrite',
          detail: `g${rung.g} "${rung.example}" — foldTest has no rewrite pair`,
          hard: true,
        });
      }
      const verdictSaysPreserving = /same claim/i.test(rung.foldTest);
      const verdictSaysWidening = /different thing|different subject|about a different/i.test(
        rung.foldTest
      );
      if (rung.preserving === true && verdictSaysWidening && !verdictSaysPreserving) {
        violations.push({
          rule: 'foldtest-contradicts-preserving',
          detail: `g${rung.g} "${rung.example}" — foldTest reads widening but preserving: true`,
          hard: true,
        });
      }
      if (rung.preserving === false && verdictSaysPreserving && !verdictSaysWidening) {
        violations.push({
          rule: 'foldtest-contradicts-preserving',
          detail: `g${rung.g} "${rung.example}" — foldTest reads preserving but preserving: false`,
          hard: true,
        });
      }
    }
  }

  // Ordering: widening never precedes blurring — once preserving: false, no later true.
  let widened = false;
  for (const rung of kept) {
    if (rung.g === 0) continue;
    if (rung.preserving === false) widened = true;
    else if (widened && rung.preserving === true) {
      violations.push({
        rule: 'blur-above-widening',
        detail: `g${rung.g} "${rung.example}" is preserving above a widening rung`,
        hard: true,
      });
    }
  }

  // Gate 3: one coarsening, one rung — never a star group AND a part-of rung to the same anchor.
  const starAnchors = kept
    .filter((rung) => rung.example.includes(':*'))
    .map((rung) => rung.example.split(':*')[0].trim().toLowerCase());
  for (const rung of kept) {
    if (rung.preserving !== false) continue;
    const anchor = rung.example.trim().toLowerCase();
    if (starAnchors.some((star) => star && (anchor === star || anchor.includes(star)))) {
      violations.push({
        rule: 'star-and-partof-same-anchor',
        detail: `star group and part-of rung both target "${rung.example}" (gate 3)`,
        hard: true,
      });
    }
  }

  return violations;
}

/**
 * Ensemble consensus: the first valid run is the base ladder; every non-g0 rung is checked
 * against the other valid runs. Rungs are matched by case-folded example, falling back to the
 * same g position. Non-unanimous `preserving` or omission by any run forces `disputed: true`.
 */
export function buildConsensus(proposals: LadderProposal[]): {
  ladder: CategoryLadderRung[];
  disagreements: string[];
} {
  const base = proposals[0];
  const others = proposals.slice(1);
  const disagreements: string[] = [];

  const match = (
    proposal: LadderProposal,
    rung: LadderRungProposal
  ): LadderRungProposal | undefined => {
    const byExample = proposal.ladder.find(
      (candidate) =>
        candidate.example.trim().toLowerCase() === rung.example.trim().toLowerCase()
    );
    return byExample ?? proposal.ladder.find((candidate) => candidate.g === rung.g);
  };

  const ladder: CategoryLadderRung[] = [...base.ladder]
    .sort((a, b) => a.g - b.g)
    .map((rung) => {
      let disputed = rung.disputed;
      if (rung.g > 0) {
        for (const [index, other] of others.entries()) {
          const matched = match(other, rung);
          if (!matched) {
            disputed = true;
            disagreements.push(
              `g${rung.g} "${rung.example}": omitted by run ${index + 2}`
            );
          } else if (matched.g > 0 && matched.preserving !== rung.preserving) {
            disputed = true;
            disagreements.push(
              `g${rung.g} "${rung.example}": preserving ${rung.preserving} vs ${matched.preserving} (run ${index + 2})`
            );
          }
        }
      }
      const out: CategoryLadderRung = {
        g: rung.g,
        alias: rung.alias,
        example: rung.example,
        disputed,
      };
      if (rung.move) out.move = rung.move;
      if (rung.g > 0) {
        out.preserving = rung.preserving;
        out.foldTest = rung.foldTest;
        // The one derivation the redesign centralises: edge label from the preserving flag —
        // never from the move, never from the model.
        out.edgeKind = rung.preserving ? 'coarsens-to' : 'part-of';
      }
      return out;
    });

  return { ladder, disagreements };
}
