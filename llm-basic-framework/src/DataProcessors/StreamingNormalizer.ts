import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry, GranularityEdgeKind } from '../EntityRegistry/EntityRegistry';
import { LadderDiscovery } from '../Ladder/LadderDiscovery';
import { StringSimilarityGenerator } from '../Normalization/candidates/StringSimilarityGenerator';
import type { CandidateGenerator, Decision, DecisionRequest, DecisionStrategy } from '../Normalization/types';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { ensureDir, sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import {
  MentionRung,
  StreamingEntity,
  StreamingExtraction,
  extractAndParseJson,
  normalizeLinkVerdicts,
  normalizePairRuleVerdicts,
} from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

type Preprocessor = (
  content: string
) => Promise<{ text: string; metadata: Record<string, string | number> }>;

interface Params {
  inputDir: string; // extractions/
  outputDir: string; // artifacts/
  llmClient: LlmClient;
  schemaRegistry: SchemaRegistry;
  entityRegistry: EntityRegistry;
  countryNameNormalizer: CountryNameNormalizer;
  decisionLog: DecisionLog;
  sourceDir?: string; // original fetched docs — for the link-judge snippet
  preprocessor?: Preprocessor;
  candidateK?: number;
  candidateMinSim?: number;
  /** Defaults to the generator the M2.5 gate proved equivalent to the pre-M4 registry path. */
  candidateGenerator?: CandidateGenerator;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
  /**
   * The decision stage (M6). Omitted means the built-in `link-judge` path — since 2026-08-04 the
   * SKEIN v2 three-verdict judge (link | mint | defer with rung + parent-edge structure).
   *
   * Set it to run E1/E3/E8's alternative decision rules live. `bin/app.ts` wires it from
   * `DECISION_STRATEGY`.
   */
  decisionStrategy?: DecisionStrategy;
  /**
   * Granularity-ladder bootstrap (SKEIN v2). Optional so ladder-free arms remain runnable;
   * `bin/app.ts` wires it for the incremental flow.
   */
  ladderDiscovery?: LadderDiscovery;
}

/** What the judge (built-in or strategy port) decided for one mention. */
interface JudgeOutcome {
  kind: 'link' | 'mint' | 'defer';
  /** Validated candidate canonical, only for `link`. */
  target?: string;
  mentionRung?: MentionRung;
  /** Validated candidate canonical the mint sits under, when the judge related them. */
  parentCandidate?: string;
  edgeKind?: GranularityEdgeKind;
  reasoning?: string;
}

interface MentionPlan {
  entity: StreamingEntity;
  category: string; // canonical
  canonical?: string; // resolution result once known
  candidates: Array<{ name: string; sim: number; aliases: string[]; channel?: string; rung?: string }>;
  action: 'resolved' | 'mint' | 'judge';
  outcome?: JudgeOutcome;
}

/**
 * Candidates as the judge saw them, in the order shown. `channel` names the generator that
 * surfaced each one — everything is string similarity until M4 adds embedding/BM25/RRF channels,
 * and E4's per-channel candidate recall is scored off this field.
 */
function describeCandidates(
  candidates: MentionPlan['candidates']
): Array<{ name: string; sim: number; channel: string; surfaces: string[] }> {
  return candidates.map((candidate) => ({
    name: candidate.name,
    sim: Number(candidate.sim.toFixed(2)),
    channel: candidate.channel ?? 'string-sim',
    // The aliases as shown to the judge. M6: without these a replayed prompt is not the original
    // prompt, so E8 would attribute an input difference to the judge.
    surfaces: candidate.aliases,
  }));
}

export class StreamingNormalizer {
  public readonly inputDir: string;
  public readonly outputDir: string;

  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #entityRegistry: EntityRegistry;
  #countryNameNormalizer: CountryNameNormalizer;
  #decisionLog: DecisionLog;
  #sourceDir?: string;
  #candidateK: number;
  #candidateMinSim: number;
  #candidateGenerator: CandidateGenerator;
  #generatorPrepared = false;
  #preprocessor: Preprocessor = (content: string) =>
    Promise.resolve({ text: content, metadata: {} });

  #prompts: PromptProvider;
  #decisionStrategy?: DecisionStrategy;
  #ladderDiscovery?: LadderDiscovery;

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.#decisionStrategy = params.decisionStrategy;
    this.#ladderDiscovery = params.ladderDiscovery;
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#entityRegistry = params.entityRegistry;
    this.#countryNameNormalizer = params.countryNameNormalizer;
    this.#decisionLog = params.decisionLog;
    this.#sourceDir = params.sourceDir;
    this.#candidateK = params.candidateK ?? 5;
    this.#candidateMinSim = params.candidateMinSim ?? 0.5;
    this.#candidateGenerator = params.candidateGenerator ?? new StringSimilarityGenerator();

    if (params.preprocessor) {
      this.#preprocessor = params.preprocessor;
    }
  }

  async run() {
    await ensureDir(this.outputDir);
    const files = sortByNumericId(await fs.readdir(this.inputDir));
    for (const file of files) {
      await this.processFile(file);
    }
  }

  async processFile(file: string): Promise<boolean> {
    const outputFile = `${this.outputDir}/${file}`;
    if (existsSync(outputFile)) {
      console.log(`SKIP (exists) ${outputFile}`);
      return true;
    }

    const inputFile = `${this.inputDir}/${file}`;
    if (!existsSync(inputFile)) {
      console.log(`SKIP (no extraction) ${inputFile}`);
      return false;
    }

    await ensureDir(this.outputDir);
    await this.#schemaRegistry.load();
    await this.#entityRegistry.load();

    if (!this.#generatorPrepared) {
      // The snapshot is a live view over the registry, so preparing once is correct; index-bearing
      // generators are kept current by the onRegistryChange notifications below.
      await this.#candidateGenerator.prepare(this.#entityRegistry.snapshot());
      this.#generatorPrepared = true;
    }

    console.time(`NORMALIZE ${file}`);
    const extraction = JSON.parse(
      (await fs.readFile(inputFile)).toString()
    ) as StreamingExtraction;
    const docId = Number(extraction.metadata?.id) || parseInt(file, 10) || 0;
    const docDate = String(extraction.metadata?.date || 'unknown');

    // ---- Phase A: read-only + LLM verdicts (no state mutation on failure) ----

    // Category canonicalization (raw proposed names → canonical schema names)
    const plans: MentionPlan[] = extraction.entities.map((entity) => {
      let category = this.#schemaRegistry.resolveCategory(entity.category);
      if (!category) {
        console.warn(
          `StreamingNormalizer: unknown category "${entity.category}" in ${file} — admitting`
        );
        category = this.#schemaRegistry.admitCategory({
          name: entity.category,
          definition: '',
          doc: docId,
        });
      }
      return { entity, category, candidates: [], action: 'mint' as const };
    });

    // Ladder bootstrap (SKEIN v2): fire/refresh the granularity ladder for every category this
    // document touches, before judging — the judge's candidate lists label rungs from it.
    if (this.#ladderDiscovery) {
      for (const category of new Set(plans.map((plan) => plan.category))) {
        await this.#ladderDiscovery.maybeDiscover(category, docId);
      }
    }

    // Exact fast path, then candidates
    for (const plan of plans) {
      const resolved = this.#entityRegistry.resolve(plan.category, plan.entity.name);
      if (resolved) {
        plan.canonical = resolved;
        plan.action = 'resolved';
        continue;
      }
      // M4: candidate generation moved out of the registry behind the CandidateGenerator port, so
      // the E2/E4 arms can swap blockers without touching this orchestration.
      const generated = await this.#candidateGenerator.candidates({
        mention: plan.entity.name,
        category: plan.category,
        k: this.#candidateK,
        minSim: this.#candidateMinSim,
        docId,
      });
      plan.candidates = generated.map((candidate) => ({
        name: candidate.canonical,
        sim: candidate.sim,
        aliases: candidate.surfaces,
        channel: candidate.channel,
        // Rung-aware candidates: the judge's list labels which ladder rung each candidate sits on.
        rung: this.#entityRegistry.rungOf(plan.category, candidate.canonical),
      }));
      plan.action = plan.candidates.length > 0 ? 'judge' : 'mint';
    }

    // Link-judge: ONE batched call for all unresolved mentions with candidates.
    // Dedupe by (category, lowercased name) — the same mention may appear with several roles.
    const judgeBatch = new Map<string, MentionPlan>();
    for (const plan of plans) {
      if (plan.action !== 'judge') continue;
      const key = mentionKey(plan.category, plan.entity.name);
      if (!judgeBatch.has(key)) judgeBatch.set(key, plan);
    }

    if (judgeBatch.size > 0) {
      // M6: the decision stage is a port. With no strategy injected this uses the built-in
      // `link-judge` path — the SKEIN v2 three-verdict judge since 2026-08-04.
      const outcomeMap = this.#decisionStrategy
        ? await this.#strategyJudge([...judgeBatch.values()], extraction, docId, file)
        : await this.#linkJudge([...judgeBatch.values()], extraction, docId, file);

      for (const plan of plans) {
        if (plan.action !== 'judge') continue;
        const outcome = outcomeMap.get(mentionKey(plan.category, plan.entity.name));
        if (outcome) {
          plan.outcome = outcome;
          if (outcome.kind === 'link' && outcome.target) plan.canonical = outcome.target;
        } // else: judge failed or dropped the mention — stays a mint
      }
    }

    // Pair-rule discovery for never-seen co-occurrence signatures
    const novelSignatures = new Map<string, { a: MentionPlan; b: MentionPlan }>();
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) {
        const key = this.#schemaRegistry.signatureKey(
          { category: plans[i].category, role: plans[i].entity.role },
          { category: plans[j].category, role: plans[j].entity.role }
        );
        if (!this.#schemaRegistry.hasPairRule(key) && !novelSignatures.has(key)) {
          novelSignatures.set(key, { a: plans[i], b: plans[j] });
        }
      }
    }

    const pairRulePlans =
      novelSignatures.size > 0 ? await this.#pairRuleJudge([...novelSignatures.values()], docId) : [];

    // ---- Phase B: mutate + save + write ----

    for (const plan of plans) {
      if (plan.canonical && plan.action !== 'resolved') {
        // link verdict
        this.#entityRegistry.link(plan.category, plan.canonical, plan.entity.name, {
          docId,
          evidence: plan.outcome?.reasoning ?? null,
        });
        this.#candidateGenerator.onRegistryChange({
          type: 'link',
          category: plan.category,
          canonical: plan.canonical,
        });
        await this.#decisionLog.logDecision({
          docId,
          mention: plan.entity.name,
          category: plan.category,
          candidates: describeCandidates(plan.candidates),
          decision: 'link',
          target: plan.canonical,
        });
      } else if (!plan.canonical) {
        // mint (zero candidates, judge said mint or defer, or judge failed).
        // A defer is a PROVISIONAL mint: same registry write, plus a defer-queue entry the
        // consolidator reviews — and it scores as a withheld decision (protocol §5), so the
        // decision event stays `defer` with a null target.
        const deferred = plan.outcome?.kind === 'defer';
        plan.canonical = this.#entityRegistry.mint(plan.category, plan.entity.name, {
          doc: docId,
          date: docDate,
        });
        if (plan.outcome?.mentionRung) {
          this.#entityRegistry.setRung(plan.category, plan.canonical, plan.outcome.mentionRung);
        }
        this.#candidateGenerator.onRegistryChange({
          type: 'mint',
          category: plan.category,
          canonical: plan.canonical,
        });

        // A mint may carry a validated parent candidate — the "hard non-merge plus a connecting
        // edge" outcome. The edge kind came from the judge's preserving reading; provenance makes
        // it consolidator-confirmable.
        if (!deferred && plan.outcome?.parentCandidate && plan.outcome.edgeKind) {
          const added = this.#entityRegistry.addGranularityEdge(plan.category, {
            from: plan.canonical,
            to: plan.outcome.parentCandidate,
            kind: plan.outcome.edgeKind,
            docId,
            decision: 'judge',
            evidence: plan.outcome.reasoning ?? null,
          });
          if (added) {
            await this.#decisionLog.log({
              op: 'granularity-edge',
              doc: docId,
              category: plan.category,
              from: plan.canonical,
              to: plan.outcome.parentCandidate,
              kind: plan.outcome.edgeKind,
              mentionRung: plan.outcome.mentionRung ?? null,
              evidence: plan.outcome.reasoning ?? null,
            });
          }
        }

        if (deferred) {
          this.#entityRegistry.pushDeferred({
            category: plan.category,
            mention: plan.entity.name,
            mintedAs: plan.canonical,
            candidates: plan.candidates.map((candidate) => candidate.name),
            docId,
          });
          await this.#decisionLog.log({
            op: 'decision',
            docId,
            mention: plan.entity.name,
            category: plan.category,
            candidates: describeCandidates(plan.candidates),
            decision: 'defer',
            target: null,
            // Not part of the scoring contract — the provisional canonical, for state replay.
            mintedAs: plan.canonical,
          });
        } else {
          await this.#decisionLog.logDecision({
            docId,
            mention: plan.entity.name,
            category: plan.category,
            candidates: describeCandidates(plan.candidates),
            decision: 'mint',
            target: plan.canonical,
          });
        }
      }
    }

    for (const { rule, newRelationType } of pairRulePlans) {
      if (newRelationType) {
        this.#schemaRegistry.admitRelationType({
          name: newRelationType.name,
          definition: newRelationType.definition,
          doc: docId,
        });
      }
      this.#schemaRegistry.admitPairRule(rule, docId);
    }

    // Per-document resolution map: (canonical category, surface name) → canonical name
    const docMap = new Map<string, Map<string, string>>();
    for (const plan of plans) {
      let inner = docMap.get(plan.category);
      if (!inner) {
        inner = new Map();
        docMap.set(plan.category, inner);
      }
      inner.set(plan.entity.name, plan.canonical!);
    }

    // Stamp entities
    for (const plan of plans) {
      plan.entity.category = plan.category;
      plan.entity.normalizedName = plan.canonical;
      // The registry surface this mention hit, in stored casing — what a consolidator split
      // reassigns by. Registry writes above guarantee the lookup now resolves.
      plan.entity.matchedVia = this.#entityRegistry.matchedSurface(plan.category, plan.entity.name);
      if (plan.category.toLowerCase() === 'country') {
        const code = await this.#countryNameNormalizer.normalizeCountry(plan.entity.name, docId);
        if (code) plan.entity.code = code;
      }
    }

    // Stamp relations (relation.type stays raw — canonicalized at graph-build time)
    for (const relation of extraction.relations) {
      const headCategory = this.#schemaRegistry.resolveCategory(relation.headCategory) || relation.headCategory;
      const tailCategory = this.#schemaRegistry.resolveCategory(relation.tailCategory) || relation.tailCategory;
      relation.headCategory = headCategory;
      relation.tailCategory = tailCategory;
      relation.normalizedHead = this.#resolveEndpoint(docMap, headCategory, relation.head, file);
      relation.normalizedTail = this.#resolveEndpoint(docMap, tailCategory, relation.tail, file);
    }

    // State files before the artifact: idempotent mutations make crash-retry safe
    await this.#entityRegistry.save();
    await this.#schemaRegistry.save();
    await writeJsonAtomic(outputFile, {
      entities: extraction.entities,
      relations: extraction.relations,
      schemaProposals: extraction.schemaProposals,
      metadata: extraction.metadata,
    });
    console.timeEnd(`NORMALIZE ${file}`);
    console.log(`OUT FILE=${outputFile}`);
    return true;
  }

  #resolveEndpoint(
    docMap: Map<string, Map<string, string>>,
    category: string,
    name: string,
    file: string
  ): string {
    const fromDoc = docMap.get(category)?.get(name);
    if (fromDoc) return fromDoc;

    const fromRegistry = this.#entityRegistry.resolve(category, name);
    if (fromRegistry) return fromRegistry;

    console.warn(
      `StreamingNormalizer: relation endpoint "${name}" (${category}) in ${file} matches no entity — keeping raw name`
    );
    return name;
  }

  /**
   * The M6 decision port, in place of the built-in `link-judge` call.
   *
   * Returns the same `mentionKey → JudgeOutcome` shape `#linkJudge` does, so the caller is
   * identical either way. A strategy `defer` gets the same provisional-mint + defer-queue
   * treatment as the built-in judge's (scored per §5 of docs/statistical-protocol.md); strategy
   * ports carry no rung/parent structure.
   */
  async #strategyJudge(
    batch: MentionPlan[],
    extraction: StreamingExtraction,
    docId: number,
    file: string
  ): Promise<Map<string, JudgeOutcome>> {
    const strategy = this.#decisionStrategy!;
    const title = String(extraction.metadata?.title || 'untitled');
    const snippet = await this.#loadSnippet(file);

    const requests: DecisionRequest[] = batch.map((plan) => ({
      mention: plan.entity.name,
      category: plan.category,
      docId,
      docTitle: title,
      docSnippet: snippet,
      candidates: plan.candidates.map((candidate) => ({
        canonical: candidate.name,
        sim: candidate.sim,
        surfaces: candidate.aliases,
        channel: candidate.channel ?? 'string-sim',
      })),
    }));

    let decisions: Decision[];
    try {
      decisions = await strategy.decide(requests);
    } catch (error) {
      // Same failure posture as #linkJudge: mint-all is conservative and repairable by the
      // consolidator. Never abort the document.
      console.error(`DECISION (${strategy.id}) failed for doc ${docId}, minting all:`, error);
      return new Map();
    }

    if (decisions.length !== requests.length) {
      // The port's contract is one decision per request, in order. A strategy that breaks it would
      // otherwise silently misalign verdicts with mentions, which is unrecoverable after the fact.
      throw new Error(
        `DecisionStrategy '${strategy.id}' returned ${decisions.length} decisions for ${requests.length} requests`
      );
    }

    const outcomeMap = new Map<string, JudgeOutcome>();
    decisions.forEach((decision, index) => {
      const plan = batch[index];
      const key = mentionKey(plan.category, plan.entity.name);
      if (decision.kind === 'link' && decision.target) {
        // Accept links to actual candidates only, exactly as the built-in path does.
        const target = plan.candidates.find(
          (candidate) => candidate.name.toLowerCase() === decision.target!.trim().toLowerCase()
        );
        outcomeMap.set(
          key,
          target ? { kind: 'link', target: target.name } : { kind: 'mint' }
        );
        return;
      }
      outcomeMap.set(key, { kind: decision.kind === 'defer' ? 'defer' : 'mint' });
    });
    return outcomeMap;
  }

  /**
   * The built-in SKEIN v2 linking judge: ONE batched call per document against
   * `prompts/link-judge.md` (copied verbatim from the wiki prompt library). Everything the model
   * sees goes through the prompt's `{{docTitle}}/{{docSnippet}}/{{mentionsBatch}}` placeholders.
   *
   * Post-checks (code, belt and braces — the prompt states them too):
   * - `link` target must case-insensitively match a listed candidate, else the verdict is demoted
   *   to `mint`;
   * - `parentCandidate` must match a listed candidate, else the parent edge is dropped and the
   *   mint stands;
   * - `defer` is passed through — the caller mints provisionally and queues the pair.
   */
  async #linkJudge(
    batch: MentionPlan[],
    extraction: StreamingExtraction,
    docId: number,
    file: string
  ): Promise<Map<string, JudgeOutcome>> {
    const title = String(extraction.metadata?.title || 'untitled');
    const snippet = await this.#loadSnippet(file);

    const lines = batch.map((plan, index) => {
      const candidates =
        plan.candidates
          .map((candidate) => {
            const rung = candidate.rung ? ` [${candidate.rung}]` : ' [rung unknown]';
            return `${candidate.name}${rung} (aliases: ${candidate.aliases.join(', ')})`;
          })
          .join('; ') || '(none)';
      return `${index + 1}. "${plan.entity.name}" (${plan.category}); candidates: ${candidates}`;
    });

    const instructions = this.#prompts.render('link-judge', {
      docTitle: title,
      docSnippet: snippet,
      mentionsBatch: lines.join('\n'),
    });

    const started = Date.now();
    console.time(`LINK-JUDGE doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(
        instructions,
        'Resolve the mentions listed in your instructions. Output the JSON verdicts object only.',
        {
          operator: 'link-judge',
          docId,
        }
      );
      const verdicts = normalizeLinkVerdicts(extractAndParseJson(response.text) || {}) || [];

      const outcomeMap = new Map<string, JudgeOutcome>();
      // Key by category|mention, exactly as the caller does. Keying by mention alone silently lost a
      // verdict whenever one document carried the same surface under two categories — confirmed on
      // `atera`, extracted as both Organization and Software in doc 6280099. Both reach the judge as
      // separate numbered lines, but a name-only map collapses them to one entry, so one plan minted
      // regardless of the verdict and the surviving plan could be assigned the other's target.
      const batchByMention = new Map(
        batch.map((plan) => [mentionKey(plan.category, plan.entity.name), plan])
      );
      for (const verdict of verdicts) {
        // `category` has a LIVR default of '' — a model that omits it falls through to a name-only
        // lookup, but only when that surface is unambiguous in this batch. Guessing when two
        // categories share a surface is the very failure being fixed here.
        const plan =
          batchByMention.get(mentionKey(verdict.category ?? '', verdict.mention)) ??
          unambiguousPlan(batch, verdict.mention);
        if (!plan) continue;
        const key = mentionKey(plan.category, plan.entity.name);
        const findCandidate = (name: string) =>
          plan.candidates.find(
            (candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase()
          );

        const mentionRung = verdict.mentionRung || undefined;
        if (verdict.verdict === 'link') {
          const target = findCandidate(verdict.target);
          if (target) {
            outcomeMap.set(key, {
              kind: 'link',
              target: target.name,
              mentionRung,
              reasoning: verdict.reasoning || undefined,
            });
          } else {
            // Strict candidate matching: a link to an unlisted name is demoted to mint.
            outcomeMap.set(key, { kind: 'mint', mentionRung });
          }
          continue;
        }

        if (verdict.verdict === 'defer') {
          outcomeMap.set(key, {
            kind: 'defer',
            mentionRung,
            reasoning: verdict.reasoning || undefined,
          });
          continue;
        }

        // mint — possibly under a validated parent candidate
        const parent = verdict.parentCandidate ? findCandidate(verdict.parentCandidate) : undefined;
        if (verdict.parentCandidate && !parent) {
          console.warn(
            `LINK-JUDGE: parentCandidate "${verdict.parentCandidate}" for "${verdict.mention}" is not a listed candidate — edge dropped, mint stands`
          );
        }
        outcomeMap.set(key, {
          kind: 'mint',
          mentionRung,
          parentCandidate: parent?.name,
          edgeKind: parent ? (verdict.edgeKind || 'part-of') : undefined,
          reasoning: verdict.reasoning || undefined,
        });
      }
      return outcomeMap;
    } catch (error) {
      // Mint-all is conservative and repairable by the consolidator — never abort the doc
      console.error(`LINK-JUDGE failed for doc ${docId}, minting all:`, error);
      return new Map();
    } finally {
      console.timeEnd(`LINK-JUDGE doc ${docId}`);
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind: 'link-judge',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }

  async #pairRuleJudge(
    signatures: Array<{ a: MentionPlan; b: MentionPlan }>,
    docId: number
  ): Promise<
    Array<{ rule: { source: { category: string; role: string }; target: { category: string; role: string }; relation: string | null }; newRelationType?: { name: string; definition: string } }>
  > {
    const lines = signatures.map(
      ({ a, b }, index) =>
        `${index + 1}. ${a.category}/${a.entity.role} × ${b.category}/${b.entity.role}`
    );

    const instructions = this.#prompts.render('pair-rule', {
      knownRelationTypes: this.#schemaRegistry.renderKnownRelationTypes(),
    });

    const started = Date.now();
    console.time(`PAIR-RULES doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(
        instructions,
        `Signatures to rule on:\n${lines.join('\n')}`,
        { operator: 'pair-rule', docId }
      );
      const verdicts = normalizePairRuleVerdicts(extractAndParseJson(response.text) || {}) || [];

      const rules: Array<{
        rule: {
          source: { category: string; role: string };
          target: { category: string; role: string };
          relation: string | null;
        };
        newRelationType?: { name: string; definition: string };
      }> = [];

      for (const verdict of verdicts) {
        const signature = signatures[verdict.signature - 1];
        if (!signature) continue;

        const endpointA = { category: signature.a.category, role: signature.a.entity.role };
        const endpointB = { category: signature.b.category, role: signature.b.entity.role };

        if (verdict.relation === null) {
          rules.push({ rule: { source: endpointA, target: endpointB, relation: null } });
          continue;
        }

        // Orient source/target by matching the verdict's "Category/Role" strings
        const sourceKey = verdict.source.trim().toLowerCase();
        const keyA = `${endpointA.category}/${endpointA.role}`.toLowerCase();
        const [source, target] = sourceKey === keyA ? [endpointA, endpointB] : [endpointB, endpointA];

        const isKnown = this.#schemaRegistry.resolveRelationType(verdict.relation);
        rules.push({
          rule: { source, target, relation: verdict.relation },
          newRelationType: isKnown
            ? undefined
            : { name: verdict.relation, definition: verdict.definition },
        });
      }
      return rules;
    } catch (error) {
      // Leave signatures unruled — retried on the next doc where they co-occur
      console.error(`PAIR-RULES failed for doc ${docId}, leaving signatures unruled:`, error);
      return [];
    } finally {
      console.timeEnd(`PAIR-RULES doc ${docId}`);
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind: 'pair-rule',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }

  async #loadSnippet(file: string): Promise<string> {
    if (!this.#sourceDir) return '(no document text available)';
    try {
      const content = await fs.readFile(`${this.#sourceDir}/${file}`);
      const { text } = await this.#preprocessor(content.toString());
      return text.slice(0, 600).replace(/\s+/g, ' ').trim();
    } catch {
      return '(no document text available)';
    }
  }
}

/**
 * The one key used for every (category, mention) map in this file: the judge batch, the verdict map
 * and the lookups on both sides.
 *
 * Both parts are folded, including the category. Categories reaching this from a plan are already
 * canonical, but a category coming back from the judge is whatever the model typed, and a key built
 * two different ways is how the verdict-loss bug survived unnoticed in the first place.
 */
function mentionKey(category: string, mention: string): string {
  return `${category.trim().toLowerCase()}|${mention.trim().toLowerCase()}`;
}

/**
 * The plan for a surface, when exactly one plan in the batch carries it.
 *
 * Used only as a fallback for a verdict whose `category` the model omitted. Returning undefined for
 * an ambiguous surface is the whole point: the alternative is guessing which of two categories the
 * judge meant, which is what produced cross-category mis-assignment before.
 */
function unambiguousPlan(batch: MentionPlan[], mention: string): MentionPlan | undefined {
  const folded = mention.trim().toLowerCase();
  const matches = batch.filter((plan) => plan.entity.name.trim().toLowerCase() === folded);
  return matches.length === 1 ? matches[0] : undefined;
}
