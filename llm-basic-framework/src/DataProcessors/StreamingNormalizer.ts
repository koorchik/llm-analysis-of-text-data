import { PromptProvider, prompts } from '../Normalization/PromptProvider';
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
  LinkVerdict,
  MentionRung,
  StreamingEntity,
  StreamingExtraction,
  extractAndParseJson,
  glossRestatesMention,
  normalizeLinkVerdicts,
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
  decisionLog: DecisionLog;
  sourceDir?: string;
  preprocessor?: Preprocessor;
  candidateK?: number;
  candidateMinSim?: number;
  /**
   * Fast-iteration category filter (spec 2026-08-16): when set, only mentions whose canonical
   * category is listed are normalized; everything else — and any relation touching it — is
   * dropped from plans and artifacts. Frozen extractions on disk are untouched. Unset = all.
   */
  categories?: string[];
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
  /**
   * Phase 2 of the synchronous per-document pipeline (T9's StreamingRepairer). Optional so
   * repairer-free arms and existing tests remain runnable; when present, `processFile` calls it
   * once this document's registry writes have landed — the repair pass sees a state it can trust.
   */
  repairer?: { processDoc(file: string, docId: number): Promise<void> };
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
  /** 1-line name-independent description (prompts/link-judge.md rule 4), mint/defer only. */
  gloss?: string;
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
  #decisionLog: DecisionLog;
  #sourceDir?: string;
  #candidateK: number;
  #candidateMinSim: number;
  #categories: Set<string> | null;
  #candidateGenerator: CandidateGenerator;
  #generatorPrepared = false;
  #preprocessor: Preprocessor = (content: string) =>
    Promise.resolve({ text: content, metadata: {} });

  #prompts: PromptProvider;
  #decisionStrategy?: DecisionStrategy;
  #ladderDiscovery?: LadderDiscovery;
  #repairer?: Params['repairer'];

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.#decisionStrategy = params.decisionStrategy;
    this.#ladderDiscovery = params.ladderDiscovery;
    this.#repairer = params.repairer;
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#entityRegistry = params.entityRegistry;
    this.#decisionLog = params.decisionLog;
    this.#sourceDir = params.sourceDir;
    this.#candidateK = params.candidateK ?? 5;
    this.#candidateMinSim = params.candidateMinSim ?? 0.5;
    this.#categories = params.categories ? new Set(params.categories) : null;
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
      if (this.#repairer) {
        // Crash recovery: a previous run can die between this document's artifact write and its
        // repairer call below — the artifact exists, but phase 2 never ran for it. Catch that up
        // here instead of silently skipping it forever.
        await this.#entityRegistry.load();
        const artifact = JSON.parse((await fs.readFile(outputFile)).toString()) as StreamingExtraction;
        const docId = resolveDocId(artifact.metadata, file);
        if (this.#entityRegistry.repairState().repairedThrough < docId) {
          await this.#repairer.processDoc(file, docId);
        }
      }
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
    const docId = resolveDocId(extraction.metadata, file);
    const docDate = String(extraction.metadata?.date || 'unknown');

    // ---- Phase A: read-only + LLM verdicts (no state mutation on failure) ----

    // CATEGORIES filter: match on the canonical category (fall back to the raw name when the
    // schema has not seen it yet — first-doc case), so raw variants of a kept category survive.
    const keptEntities = this.#categories
      ? extraction.entities.filter((entity) => {
          const canonical = this.#schemaRegistry.resolveCategory(entity.category) ?? entity.category;
          return this.#categories!.has(canonical);
        })
      : extraction.entities;

    // Category canonicalization (raw proposed names → canonical schema names)
    const plans: MentionPlan[] = keptEntities.map((entity) => {
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
        // StreamingRepairer (this document's phase 2; the duplicate lives ≤1 document) reviews —
        // and it scores as a withheld decision (protocol §5), so the decision event stays `defer`
        // with a null target.
        const deferred = plan.outcome?.kind === 'defer';
        plan.canonical = this.#entityRegistry.mint(
          plan.category,
          plan.entity.name,
          { doc: docId, date: docDate },
          { gloss: plan.outcome?.gloss ?? null }
        );
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
        // it StreamingRepairer (this document's phase 2; the duplicate lives ≤1 document)-confirmable.
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
            // Non-scoring: the gloss written onto the provisional mint, for replay/debugging.
            gloss: plan.outcome?.gloss ?? null,
          });
        } else {
          await this.#decisionLog.logDecision({
            docId,
            mention: plan.entity.name,
            category: plan.category,
            candidates: describeCandidates(plan.candidates),
            decision: 'mint',
            target: plan.canonical,
            // Non-scoring: the gloss written onto the mint, for replay/debugging.
            gloss: plan.outcome?.gloss ?? null,
          });
        }
      }
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
      // The registry surface this mention hit, in stored casing — what a StreamingRepairer (this
      // document's phase 2; the duplicate lives ≤1 document) split reassigns by. Registry writes
      // above guarantee the lookup now resolves.
      plan.entity.matchedVia = this.#entityRegistry.matchedSurface(plan.category, plan.entity.name);
    }

    // A relation with a filtered-out endpoint has no resolvable normalizedHead/Tail — drop it.
    const relations = extraction.relations ?? [];
    const keptRelations = this.#categories
      ? relations.filter((relation) => {
          const head =
            this.#schemaRegistry.resolveCategory(relation.headCategory) || relation.headCategory;
          const tail =
            this.#schemaRegistry.resolveCategory(relation.tailCategory) || relation.tailCategory;
          return this.#categories!.has(head) && this.#categories!.has(tail);
        })
      : relations;
    // Stamp relations (relation.type stays raw — canonicalized at graph-build time)
    for (const relation of keptRelations) {
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
      entities: keptEntities,
      relations: keptRelations,
      schemaProposals: extraction.schemaProposals,
      metadata: extraction.metadata,
    });
    console.timeEnd(`NORMALIZE ${file}`);
    console.log(`OUT FILE=${outputFile}`);
    // Phase 2, synchronous: the artifact and registry writes above are already durable, so the
    // repairer sees a state it can trust. Last statement — nothing here depends on it running.
    await this.#repairer?.processDoc(file, docId);
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
      // StreamingRepairer (this document's phase 2; the duplicate lives ≤1 document). Never abort
      // the document.
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
   * `prompts/link-judge.md`. Everything the model
   * sees goes through generic source-evidence and mention/candidate placeholders. The prompt forbids
   * treating contextual role, behavior, or relationships as identity evidence.
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
    const instructions = this.#prompts.render('link-judge', {
      docTitle: title,
      docSnippet: snippet,
      mentionsBatch: renderMentionLines(batch, this.#schemaRegistry),
    });

    const started = Date.now();
    console.time(`LINK-JUDGE doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    // Hoisted so the catch block can annotate the transcript even if the try throws before this
    // is assigned (e.g. `send` itself rejects).
    let transcript: ReturnType<LlmClient['lastCallHandle']> = null;
    try {
      response = await this.#llmClient.send(
        instructions,
        'Resolve the mentions listed in your instructions. Output the JSON verdicts object only.',
        {
          operator: 'link-judge',
          docId,
        }
      );
      transcript = this.#llmClient.lastCallHandle?.() ?? null;
      // HTTP 200 with unparseable or schema-invalid content is exactly the failure this method's
      // catch block exists to mark: an `|| {}`/`|| []` fallback here would silently treat "the
      // model returned garbage" the same as "the model correctly returned zero verdicts", so the
      // two are distinguished explicitly and the former is thrown to route through the catch.
      const parsed = extractAndParseJson(response.text);
      if (!parsed) {
        throw new Error('link-judge response was not valid JSON');
      }
      const verdicts = normalizeLinkVerdicts(parsed);
      if (!verdicts) {
        throw new Error('link-judge response failed verdicts schema validation');
      }

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

        const mentionRung = this.#validatedMentionRung(plan.category, verdict.mentionRung);
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
            gloss: verdict.gloss || undefined,
            reasoning: verdict.reasoning || undefined,
          });
          continue;
        }

        // mint — possibly under a validated parent candidate
        const parent = verdict.parentCandidate
          ? findCandidate(verdict.parentCandidate)
          : undefined;
        const edgeKind = parent
          ? this.#edgeKindForParent(plan.category, parent.rung)
          : undefined;
        if (verdict.parentCandidate && (!parent || !edgeKind)) {
          console.warn(
            `LINK-JUDGE: parentCandidate "${verdict.parentCandidate}" for "${verdict.mention}" is not supported by the active ladder and candidate list — edge dropped, mint stands`
          );
        }
        outcomeMap.set(key, {
          kind: 'mint',
          mentionRung,
          parentCandidate: edgeKind ? parent?.name : undefined,
          edgeKind,
          gloss: verdict.gloss || undefined,
          reasoning: verdict.reasoning || undefined,
        });
      }

      // Code-validate gloss on every mint/defer: one re-ask for failed descriptions before
      // falling back to no gloss. Gloss supports retrieval; it is not identity evidence.
      await this.#validateGlosses(outcomeMap, batch, title, snippet, docId);

      return outcomeMap;
    } catch (error) {
      // Mint-all is conservative and repairable by the StreamingRepairer (this document's phase
      // 2; the duplicate lives ≤1 document) — never abort the doc
      console.error(`LINK-JUDGE failed for doc ${docId}, minting all:`, error);
      await this.#llmClient.callLog?.logOutcome(transcript, {
        ok: false,
        detail: `link-judge response unusable, minting all: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
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

  #validatedMentionRung(category: string, requested: MentionRung | ''): MentionRung {
    const ladder = this.#schemaRegistry.getLadder(category);
    if (!ladder) return 'g0';
    const available = new Set(ladder.rungs.map((rung) => `g${rung.g}`));
    return requested && available.has(requested) ? requested : 'g0';
  }

  #edgeKindForParent(
    category: string,
    parentRung: string | undefined
  ): GranularityEdgeKind | undefined {
    if (!parentRung) return undefined;
    const rung = this.#schemaRegistry
      .getLadder(category)
      ?.rungs.find((candidate) => `g${candidate.g}` === parentRung);
    return rung?.edgeKind;
  }

  /**
   * A name-restating gloss gives the duplicate finder nothing beyond the name: re-ask once for
   * only those mentions, then proceed without a gloss rather than looping or inventing data. A
   * null/empty gloss is NOT a failure — the prompt instructs the model to answer null when the
   * source carries no name-independent description, so it is accepted without a retry or a flag.
   */
  async #validateGlosses(
    outcomeMap: Map<string, JudgeOutcome>,
    batch: MentionPlan[],
    title: string,
    snippet: string,
    docId: number
  ): Promise<void> {
    const failing = batch.filter((plan) => {
      const outcome = outcomeMap.get(mentionKey(plan.category, plan.entity.name));
      if (!outcome || (outcome.kind !== 'mint' && outcome.kind !== 'defer')) return false;
      const gloss = outcome.gloss ?? '';
      return Boolean(gloss.trim()) && glossRestatesMention(gloss, plan.entity.name);
    });
    if (failing.length === 0) return;

    const flagStillBad = async (plan: MentionPlan) => {
      const outcome = outcomeMap.get(mentionKey(plan.category, plan.entity.name))!;
      outcome.gloss = undefined;
      await this.#decisionLog.log({
        op: 'gloss-flagged',
        doc: docId,
        mention: plan.entity.name,
        category: plan.category,
        kind: outcome.kind,
      });
    };

    const instructions = this.#prompts.render('link-judge', {
      docTitle: title,
      docSnippet: snippet,
      mentionsBatch: renderMentionLines(failing, this.#schemaRegistry),
    });

    const started = Date.now();
    console.time(`LINK-JUDGE-RETRY doc ${docId}`);
    // Hoisted so the finally block can meter a call that may throw.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(
        instructions,
        'Resolve the mentions listed in your instructions. Output the JSON verdicts object only.',
        { operator: 'link-judge-retry', docId }
      );
      const verdicts = normalizeLinkVerdicts(extractAndParseJson(response.text) || {}) || [];

      for (const plan of failing) {
        const retryVerdict = findVerdict(verdicts, plan);
        const gloss = retryVerdict?.gloss?.trim();
        if (gloss && !glossRestatesMention(gloss, plan.entity.name)) {
          outcomeMap.get(mentionKey(plan.category, plan.entity.name))!.gloss = gloss;
        } else {
          await flagStillBad(plan);
        }
      }
    } catch (error) {
      // Never abort normalization because optional retrieval metadata could not be produced.
      console.error(`LINK-JUDGE-RETRY failed for doc ${docId}, proceeding without gloss:`, error);
      for (const plan of failing) await flagStillBad(plan);
    } finally {
      console.timeEnd(`LINK-JUDGE-RETRY doc ${docId}`);
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind: 'link-judge-retry',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }

  async #loadSnippet(file: string): Promise<string> {
    if (!this.#sourceDir) return '(no source evidence available)';
    try {
      const content = await fs.readFile(`${this.#sourceDir}/${file}`);
      const { text } = await this.#preprocessor(content.toString());
      return text.slice(0, 600).replace(/\s+/g, ' ').trim();
    } catch {
      return '(no source evidence available)';
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

/**
 * The judge's numbered mention+candidate list — prompts/link-judge.md's `{{mentionsBatch}}`
 * placeholder. Shared by the primary call and the one-shot gloss retry so a retry is provably the
 * same rendering, just over a smaller batch.
 */
function renderMentionLines(plans: MentionPlan[], schemaRegistry: SchemaRegistry): string {
  return plans
    .map((plan, index) => {
      const ladder = renderLadder(plan.category, schemaRegistry);
      const candidates =
        plan.candidates
          .map((candidate) => {
            const rung = candidate.rung ? ` [${candidate.rung}]` : ' [rung unknown]';
            return `${candidate.name}${rung} (aliases: ${candidate.aliases.join(', ')})`;
          })
          .join('; ') || '(none)';
      return `${index + 1}. "${plan.entity.name}" (${plan.category}); ladder: ${ladder}; candidates: ${candidates}`;
    })
    .join('\n');
}

function renderLadder(category: string, schemaRegistry: SchemaRegistry): string {
  const ladder = schemaRegistry.getLadder(category);
  if (!ladder) return '(none; use g0)';
  return ladder.rungs
    .map((rung) => {
      const relation = rung.g === 0
        ? 'observed entity'
        : `${rung.move ?? 'coarser'}; ${rung.preserving ? 'same referent' : 'containing referent'}`;
      return `g${rung.g}=${rung.alias} (${relation}; example: ${rung.example})`;
    })
    .join(' | ');
}

/** Find the verdict for one plan in a gloss-retry response without conflating categories. */
function findVerdict(verdicts: LinkVerdict[], plan: MentionPlan): LinkVerdict | undefined {
  const key = mentionKey(plan.category, plan.entity.name);
  const exact = verdicts.find((verdict) =>
    mentionKey(verdict.category || plan.category, verdict.mention) === key
  );
  if (exact) return exact;
  const folded = plan.entity.name.trim().toLowerCase();
  const matches = verdicts.filter((verdict) => verdict.mention.trim().toLowerCase() === folded);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The document id every downstream write keys on: the extraction/artifact's own `metadata.id`
 * when present, else the filename's numeric stem. Shared by the normal read path and the
 * SKIP-exists crash-recovery path (`processFile`), which reads it back off the already-written
 * artifact instead of the extraction.
 */
function resolveDocId(metadata: Record<string, string | number> | undefined, file: string): number {
  return Number(metadata?.id) || parseInt(file, 10) || 0;
}
