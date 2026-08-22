import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { StringSimilarityGenerator } from '../Normalization/candidates/StringSimilarityGenerator';
import type { CandidateGenerator, Decision, DecisionRequest, DecisionStrategy } from '../Normalization/types';
import type { EmbeddingsClient } from '../EmbeddingsClient/EmbeddingsClient';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { ensureDir, sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import { spreadSample } from '../utils/sampleUtils';
import { cosineNormalized, l2Normalize } from '../utils/vectorUtils';
import {
  LinkVerdict,
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
  conceptRegistry: ConceptRegistry;
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
   * SKEIN v2 three-verdict judge (link | mint | defer with parent-edge structure).
   *
   * Set it to run E1/E3/E8's alternative decision rules live. `bin/app.ts` wires it from
   * `DECISION_STRATEGY`.
   */
  decisionStrategy?: DecisionStrategy;
  /**
   * Embeds the two endpoint names of every hierarchy edge so the edge can carry its
   * `similarityScore` (SKOS graph). Optional so embedding-free tests remain runnable — without it
   * every edge stores a null score, which `rollupTarget` treats as below any threshold.
   */
  embeddingsClient?: EmbeddingsClient;
  /**
   * Catch-up cadence: run a registry-wide review of a category after it has grown this many new
   * canonicals since the last pass. 0 disables the pass.
   */
  skosCatchupEvery?: number;
  /** How many canonicals one catch-up reviews — bounded so the ballot cannot grow with the registry. */
  skosCatchupWidth?: number;
  /**
   * Phase 2 of the synchronous per-document pipeline (T9's StreamingRepairer). Optional so
   * repairer-free arms and existing tests remain runnable; when present, `processFile` calls it
   * once this document's registry writes have landed — the repair pass sees a state it can trust.
   */
  repairer?: { processDoc(file: string, docId: number): Promise<void> };
  /**
   * Document arrival order for `run()` (E6/M7 order robustness). Defaults to numeric-id order;
   * `bin/app.ts` wires the ORDER-driven permutation. `processFile` callers are unaffected.
   */
  fileOrder?: (files: string[]) => string[];
  /**
   * Put unresolved mentions with ZERO identity candidates on the judge's ballot too (strategy
   * path only). Without this they mint silently and the hierarchy question is never asked — a
   * first-seen family (20 browsers + their base co-mentioned in one document) produces no edges
   * even though the ballot's pool contains everything needed. Costs ballot size, buys in-document
   * hierarchy for first-seen concepts; the catch-up pass exists to compensate when this is off.
   */
  judgeUnresolved?: boolean;
  /**
   * What the judge's `evidence:` block contains (snippet ablation):
   * - `head` (default) — the source document's first 600 characters, the historical behaviour.
   * - `none` — no source evidence at all.
   * - `anchored` — mention-anchored windows: ±150 characters around each judged mention's first
   *   occurrence in the source, overlapping windows merged, capped — so the evidence actually
   *   contains the mentions being judged instead of whatever the document led with.
   * - `per-mention` — the anchored windows, but numbered (`S1. …`) with each judge request
   *   carrying a `contextRef` naming the window(s) that contain its mention, so the ballot binds
   *   evidence to mentions explicitly and no window is silently truncated away from its mention.
   */
  snippetMode?: 'head' | 'none' | 'anchored' | 'per-mention';
}

/** What the judge (built-in or strategy port) decided for one mention. */
interface JudgeOutcome {
  kind: 'link' | 'mint' | 'defer';
  /** Validated candidate canonical, only for `link`. */
  target?: string;
  /** Validated candidate canonical the mint is related to, when the judge related them. */
  parentCandidate?: string;
  /** The ISO 25964 typing of the edge, when the judge gave one — see `Decision.broaderType`. */
  broaderType?: 'broaderGeneric' | 'broaderPartitive' | 'broaderInstantial' | null;
  /** True when the mention is the BROADER side: the stored edge runs parentCandidate → mention. */
  mentionIsBroader?: boolean;
  /** 1-line name-independent description (prompts/link-judge.md rule 4), mint/defer only. */
  gloss?: string;
  reasoning?: string;
}

interface MentionPlan {
  entity: StreamingEntity;
  category: string; // canonical
  canonical?: string; // resolution result once known
  candidates: Array<{ name: string; sim: number; aliases: string[]; channel?: string }>;
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
  #conceptRegistry: ConceptRegistry;
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
  #embeddingsClient?: EmbeddingsClient;
  #skosCatchupEvery: number;
  #skosCatchupWidth: number;
  /** Canonical count per category at its last catch-up, so the pass fires on growth, not per doc. */
  #catchUpAt = new Map<string, number>();
  #repairer?: Params['repairer'];
  #fileOrder: (files: string[]) => string[];
  #snippetMode: 'head' | 'none' | 'anchored' | 'per-mention';
  #judgeUnresolved: boolean;

  constructor(params: Params) {
    this.#prompts = params.prompts ?? prompts;
    this.#decisionStrategy = params.decisionStrategy;
    this.#embeddingsClient = params.embeddingsClient;
    this.#skosCatchupEvery = params.skosCatchupEvery ?? 25;
    this.#skosCatchupWidth = params.skosCatchupWidth ?? 40;
    this.#repairer = params.repairer;
    this.#fileOrder = params.fileOrder ?? sortByNumericId;
    this.#snippetMode = params.snippetMode ?? 'head';
    this.#judgeUnresolved = params.judgeUnresolved ?? false;
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#conceptRegistry = params.conceptRegistry;
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
    const files = this.#fileOrder(await fs.readdir(this.inputDir));
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
        await this.#conceptRegistry.load();
        const artifact = JSON.parse((await fs.readFile(outputFile)).toString()) as StreamingExtraction;
        const docId = resolveDocId(artifact.metadata, file);
        if (this.#conceptRegistry.repairState().repairedThrough < docId) {
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
    await this.#conceptRegistry.load();

    if (!this.#generatorPrepared) {
      // The snapshot is a live view over the registry, so preparing once is correct; index-bearing
      // generators are kept current by the onRegistryChange notifications below.
      await this.#candidateGenerator.prepare(this.#conceptRegistry.snapshot());
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

    // SKOS catch-up: once a category has grown enough new canonicals, review a sample of them
    // registry-wide, before judging this document — the judge then sees the post-merge registry.
    if (this.#skosCatchupEvery > 0) {
      for (const category of new Set(plans.map((plan) => plan.category))) {
        const count = Object.keys(this.#conceptRegistry.concepts(category)).length;
        const last = this.#catchUpAt.get(category) ?? 0;
        if (count - last >= this.#skosCatchupEvery) {
          await this.#skosCatchUp(category, docId);
          this.#catchUpAt.set(
            category,
            Object.keys(this.#conceptRegistry.concepts(category)).length
          );
        }
      }
    }

    // Exact fast path, then candidates
    for (const plan of plans) {
      const resolved = this.#conceptRegistry.resolve(plan.category, plan.entity.name);
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
      }));
      // Zero-candidate mentions historically minted without a judge call — silently skipping the
      // hierarchy question. With judgeUnresolved (strategy path only) they go on the ballot too:
      // identity is trivially NEW, but the parent can come from the shared pool (co-mentions).
      plan.action =
        plan.candidates.length > 0 || (this.#judgeUnresolved && this.#decisionStrategy)
          ? 'judge'
          : 'mint';
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

    // Endpoints are surface names until resolution below: either side may be another mention of
    // this same document, which does not exist as a canonical until its own plan lands.
    const pendingEdges: Array<{
      category: string;
      narrower: string;
      broader: string;
      type: 'broaderGeneric' | 'broaderPartitive' | 'broaderInstantial';
      evidence: string | null;
    }> = [];

    for (const plan of plans) {
      if (plan.canonical && plan.action !== 'resolved') {
        // link verdict
        this.#conceptRegistry.link(plan.category, plan.canonical, plan.entity.name, {
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
        plan.canonical = this.#conceptRegistry.mint(
          plan.category,
          plan.entity.name,
          { doc: docId, date: docDate },
          { definition: plan.outcome?.gloss ?? null }
        );
        this.#candidateGenerator.onRegistryChange({
          type: 'mint',
          category: plan.category,
          canonical: plan.canonical,
        });

        // A mint may carry a validated related entity — the "hard non-merge plus a connecting
        // edge" outcome. Held until every plan in this document has been written, because either
        // endpoint may be another mention of the same document, and `addBroaderEdge` requires
        // both endpoints to exist. A `b` verdict swaps the direction: the mint is the broader side.
        if (!deferred && plan.outcome?.parentCandidate && plan.outcome.broaderType) {
          const broaderSide = Boolean(plan.outcome.mentionIsBroader);
          pendingEdges.push({
            category: plan.category,
            narrower: broaderSide ? plan.outcome.parentCandidate : plan.canonical,
            broader: broaderSide ? plan.canonical : plan.outcome.parentCandidate,
            type: plan.outcome.broaderType,
            evidence: plan.outcome.reasoning ?? null,
          });
        }

        if (deferred) {
          this.#conceptRegistry.pushDeferred({
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

    // Hierarchy edges, once every mint in this document exists. Either endpoint named here can be
    // another mention of the same document; resolving both through the plans is what makes "A is
    // part of B" storable when A and B are first seen together.
    for (const edge of pendingEdges) {
      const resolveEndpoint = (name: string): string => {
        const plan = plans.find(
          (candidate) =>
            candidate.category === edge.category &&
            candidate.entity.name.trim().toLowerCase() === name.trim().toLowerCase()
        );
        return plan?.canonical ?? name;
      };
      const narrower = resolveEndpoint(edge.narrower);
      const broader = resolveEndpoint(edge.broader);
      if (broader === narrower) continue; // both sides resolved to the same canonical
      const similarityScore = await this.#similarity(narrower, broader);
      const added = this.#conceptRegistry.addBroaderEdge(edge.category, {
        narrower,
        broader,
        type: edge.type,
        similarityScore,
        docId,
        decision: 'judge',
        evidence: edge.evidence,
      });
      if (added) {
        await this.#decisionLog.log({
          op: 'broader-edge',
          doc: docId,
          category: edge.category,
          narrower,
          broader,
          type: edge.type,
          similarityScore,
          evidence: edge.evidence,
        });
      }
    }

    // Stamp entities
    for (const plan of plans) {
      plan.entity.category = plan.category;
      plan.entity.normalizedName = plan.canonical;
      // The registry surface this mention hit, in stored casing — what a StreamingRepairer (this
      // document's phase 2; the duplicate lives ≤1 document) split reassigns by. Registry writes
      // above guarantee the lookup now resolves.
      plan.entity.matchedVia = this.#conceptRegistry.matchedSurface(plan.category, plan.entity.name);
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
    await this.#conceptRegistry.save();
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

    const fromRegistry = this.#conceptRegistry.resolve(category, name);
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
   * treatment as the built-in judge's (scored per §5 of docs/statistical-protocol.md).
   */
  async #strategyJudge(
    batch: MentionPlan[],
    extraction: StreamingExtraction,
    docId: number,
    file: string
  ): Promise<Map<string, JudgeOutcome>> {
    const strategy = this.#decisionStrategy!;
    const title = String(extraction.metadata?.title || 'untitled');
    const perMention =
      this.#snippetMode === 'per-mention'
        ? await this.#indexedSnippet(file, batch.map((plan) => plan.entity.name))
        : null;
    const snippet = perMention
      ? perMention.evidence
      : await this.#loadSnippet(file, batch.map((plan) => plan.entity.name));

    // Every entity this document has put on the table: the candidates retrieved for any mention,
    // plus the other mentions being decided in this same call. A mention minted here can be the
    // parent of another mention in the same document, so both halves are needed.
    const pool = new Map<string, { canonical: string; surfaces: string[] }>();
    for (const plan of batch) {
      for (const candidate of plan.candidates) {
        pool.set(`${plan.category}|${candidate.name.toLowerCase()}`, {
          canonical: candidate.name,
          surfaces: candidate.aliases,
        });
      }
    }
    for (const plan of batch) {
      const key = `${plan.category}|${plan.entity.name.toLowerCase()}`;
      if (!pool.has(key)) pool.set(key, { canonical: plan.entity.name, surfaces: [plan.entity.name] });
    }

    const requests: DecisionRequest[] = batch.map((plan) => ({
      mention: plan.entity.name,
      category: plan.category,
      docId,
      docTitle: title,
      docSnippet: snippet,
      ...(perMention?.refs.get(plan.entity.name.trim().toLowerCase())
        ? { contextRef: perMention.refs.get(plan.entity.name.trim().toLowerCase()) }
        : {}),
      // A mention is never its own parent, and the registry stores edges within one category, so
      // the shared pool is filtered per request.
      pool: [...pool.entries()]
        .filter(
          ([key]) =>
            key.startsWith(`${plan.category}|`) &&
            key !== `${plan.category}|${plan.entity.name.toLowerCase()}`
        )
        .map(([, entry]) => entry),
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

      // mint/defer — the graph half, validated exactly as `#linkJudge` validates the built-in
      // judge's: the related entity must be one this document actually put on the table — another
      // mention's candidate, or another mention being decided in this same call.
      const parentKey = decision.parentCandidate
        ? `${plan.category}|${decision.parentCandidate.trim().toLowerCase()}`
        : undefined;
      const parent = parentKey ? pool.get(parentKey) : undefined;
      const broaderType = decision.broaderType ?? null;
      if (decision.parentCandidate && (!parent || !broaderType)) {
        console.warn(
          `DECISION (${strategy.id}): parentCandidate "${decision.parentCandidate}" for "${plan.entity.name}" is not in this document's pool or carries no relation — edge dropped, mint stands`
        );
      }
      // A gloss that only restates the mention gives the duplicate finder nothing; drop it rather
      // than re-asking, since the retry prompt belongs to the built-in judge.
      const gloss = decision.gloss?.trim();
      outcomeMap.set(key, {
        kind: decision.kind === 'defer' ? 'defer' : 'mint',
        parentCandidate: parent && broaderType ? parent.canonical : undefined,
        broaderType,
        mentionIsBroader: decision.mentionIsBroader,
        gloss: gloss && !glossRestatesMention(gloss, plan.entity.name) ? gloss : undefined,
        reasoning: decision.reason,
      });
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
    const snippet = await this.#loadSnippet(file, batch.map((plan) => plan.entity.name));
    const instructions = this.#prompts.render('link-judge', {
      docTitle: title,
      docSnippet: snippet,
      mentionsBatch: renderMentionLines(batch),
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

        if (verdict.verdict === 'link') {
          const target = findCandidate(verdict.target);
          if (target) {
            outcomeMap.set(key, {
              kind: 'link',
              target: target.name,
              reasoning: verdict.reasoning || undefined,
            });
          } else {
            // Strict candidate matching: a link to an unlisted name is demoted to mint.
            outcomeMap.set(key, { kind: 'mint' });
          }
          continue;
        }

        if (verdict.verdict === 'defer') {
          outcomeMap.set(key, {
            kind: 'defer',
            gloss: verdict.gloss || undefined,
            reasoning: verdict.reasoning || undefined,
          });
          continue;
        }

        // mint — possibly under a validated parent candidate. The built-in prompt still answers in
        // the legacy edgeKind vocabulary (frozen LLM-output dialect); it maps onto the ISO 25964
        // typing here.
        const parent = verdict.parentCandidate
          ? findCandidate(verdict.parentCandidate)
          : undefined;
        const broaderType =
          verdict.edgeKind === 'part-of'
            ? ('broaderPartitive' as const)
            : verdict.edgeKind === 'coarsens-to'
              ? ('broaderGeneric' as const)
              : null;
        if (verdict.parentCandidate && (!parent || !broaderType)) {
          console.warn(
            `LINK-JUDGE: parentCandidate "${verdict.parentCandidate}" for "${verdict.mention}" is not a listed candidate or carries no edge kind — edge dropped, mint stands`
          );
        }
        outcomeMap.set(key, {
          kind: 'mint',
          parentCandidate: parent && broaderType ? parent.name : undefined,
          broaderType,
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


  /**
   * Registry-wide review of a category, reusing the ordinary graph judge.
   *
   * The per-document judge only ever sees one report. This pass is the run's category-wide view,
   * and two things are visible in it that no document could show: duplicates minted far apart in
   * the stream, and hierarchy edges between entities no document co-mentioned. It asks the same
   * graph judge the same question it answers every document, with the registry's own canonicals as
   * the mentions. Fired on growth (`skosCatchupEvery` new canonicals), not per document.
   *
   * Three things differ from a document pass, and each is deliberate:
   *
   * 1. **A canonical is never offered itself.** Its own name is an exact match, so leaving it in the
   *    options makes every verdict a no-op.
   * 2. **A `link` verdict applies as a merge, not a link.** Both sides are canonicals carrying
   *    aliases, documents, glosses and edges; `ConceptRegistry.applyMerges` is the operation that
   *    folds those, picking the survivor under `canonicalPolicy`.
   * 3. **There is no source document**, so the judge works from names, aliases and glosses alone.
   *    The prompt's rules already forbid treating context as identity evidence, so nothing is lost
   *    beyond the alias/transliteration evidence a real document sometimes supplies.
   */
  async #skosCatchUp(category: string, docId: number): Promise<void> {
    if (!this.#decisionStrategy) return;

    const canonicals = Object.keys(this.#conceptRegistry.concepts(category));
    if (canonicals.length < 2) return;
    const sample = spreadSample(canonicals, this.#skosCatchupWidth);

    const requests: DecisionRequest[] = [];
    for (const canonical of sample) {
      const generated = await this.#candidateGenerator.candidates({
        mention: canonical,
        category,
        k: this.#candidateK,
        minSim: this.#candidateMinSim,
        docId,
      });
      const options = generated.filter((candidate) => candidate.canonical !== canonical);
      if (options.length === 0) continue;
      requests.push({
        mention: canonical,
        category,
        docId,
        docTitle: `registry review at ${canonicals.length} canonicals`,
        pool: options.map((candidate) => ({
          canonical: candidate.canonical,
          surfaces: candidate.surfaces,
        })),
        candidates: options.map((candidate) => ({
          canonical: candidate.canonical,
          sim: candidate.sim,
          surfaces: candidate.surfaces,
          channel: candidate.channel,
        })),
      });
    }
    if (requests.length === 0) return;

    let decisions: Decision[];
    try {
      decisions = await this.#decisionStrategy.decide(requests);
    } catch (error) {
      console.error(`SKOS CATCH-UP failed for ${category}:`, error);
      return;
    }
    if (decisions.length !== requests.length) return;

    const merges: Array<{ from: string; into: string; evidence?: string | null }> = [];
    const edges: Array<{
      narrower: string;
      broader: string;
      type: 'broaderGeneric' | 'broaderPartitive' | 'broaderInstantial';
      evidence: string | null;
    }> = [];

    decisions.forEach((decision, index) => {
      const mention = requests[index].mention;

      if (decision.kind === 'link' && decision.target && decision.target !== mention) {
        merges.push({ from: mention, into: decision.target, evidence: decision.reason });
        return;
      }

      if (decision.parentCandidate && decision.parentCandidate !== mention && decision.broaderType) {
        const broaderSide = Boolean(decision.mentionIsBroader);
        edges.push({
          narrower: broaderSide ? decision.parentCandidate : mention,
          broader: broaderSide ? mention : decision.parentCandidate,
          type: decision.broaderType,
          evidence: decision.reason ?? null,
        });
      }
    });

    let merged = 0;
    if (merges.length > 0) {
      const summary = this.#conceptRegistry.applyMerges(category, merges);
      merged = summary.removed.length;
      for (const merge of merges) {
        await this.#decisionLog.log({
          op: 'merge',
          doc: docId,
          category,
          from: merge.from,
          into: merge.into,
          by: 'skos-catch-up',
          evidence: merge.evidence ?? null,
        });
      }
    }

    // Edges land after the merges so an endpoint absorbed above resolves to its survivor.
    let edged = 0;
    for (const edge of edges) {
      const narrower = this.#conceptRegistry.resolve(category, edge.narrower) ?? edge.narrower;
      const broader = this.#conceptRegistry.resolve(category, edge.broader) ?? edge.broader;
      if (narrower === broader) continue;
      // `addBroaderEdge` is idempotent-true on a repeat, which would inflate `edged` and
      // double-journal — only genuinely new edges count and log.
      if (this.#conceptRegistry.broaderOf(category, narrower).some((existing) => existing.broader === broader)) {
        continue;
      }
      const similarityScore = await this.#similarity(narrower, broader);
      const added = this.#conceptRegistry.addBroaderEdge(category, {
        narrower,
        broader,
        type: edge.type,
        similarityScore,
        docId,
        decision: 'judge',
        evidence: edge.evidence,
      });
      if (added) {
        edged += 1;
        // Journaled per edge (unlike the ladder-era pass, which only kept counters) so the run
        // view's replay forest carries the catch-up's edges too, not just the per-document ones.
        await this.#decisionLog.log({
          op: 'broader-edge',
          doc: docId,
          category,
          narrower,
          broader,
          type: edge.type,
          similarityScore,
          by: 'skos-catch-up',
          evidence: edge.evidence,
        });
      }
    }

    await this.#decisionLog.log({
      op: 'skos-catch-up',
      doc: docId,
      category,
      reviewed: requests.length,
      merged,
      edged,
    });
  }

  /**
   * Cosine similarity between the embeddings of two canonical names — the `similarityScore` every
   * hierarchy edge carries. Cached by the EmbeddingCache, so repeats are free. Null without an
   * embeddings client; an embedding failure is fatal by design (a silently null score would make
   * every rollup stop at this edge and read as a semantic verdict rather than an outage).
   */
  async #similarity(a: string, b: string): Promise<number | null> {
    if (!this.#embeddingsClient) return null;
    const [va, vb] = await this.#embeddingsClient.embed([a, b], { operator: 'edge-similarity' });
    return cosineNormalized(l2Normalize(va), l2Normalize(vb));
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
      mentionsBatch: renderMentionLines(failing),
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

  async #loadSnippet(file: string, mentions: string[] = []): Promise<string> {
    if (this.#snippetMode === 'none') return '(no source evidence available)';
    if (!this.#sourceDir) return '(no source evidence available)';
    try {
      const content = await fs.readFile(`${this.#sourceDir}/${file}`);
      const { text } = await this.#preprocessor(content.toString());
      if (this.#snippetMode === 'anchored' || this.#snippetMode === 'per-mention') {
        return anchoredSnippet(text, mentions);
      }
      // 'head' — the historical behaviour, byte-identical: the document's first 600 characters.
      return text.slice(0, 600).replace(/\s+/g, ' ').trim();
    } catch {
      return '(no source evidence available)';
    }
  }

  /**
   * Per-mention evidence: the anchored windows, numbered `S1…Sn`, plus a mention → "S2"-style
   * reference map so the ballot can bind each mention to the window(s) containing it. Falls back
   * to null (caller uses the plain snippet path) when nothing anchors.
   */
  async #indexedSnippet(
    file: string,
    mentions: string[]
  ): Promise<{ evidence: string; refs: Map<string, string> } | null> {
    if (!this.#sourceDir) return null;
    try {
      const content = await fs.readFile(`${this.#sourceDir}/${file}`);
      const { text } = await this.#preprocessor(content.toString());
      return indexedWindows(text, mentions);
    } catch {
      return null;
    }
  }
}

/**
 * Mention-anchored evidence: ±150-character windows around each mention's first occurrence
 * (case-insensitive), overlapping windows merged, joined with an ellipsis, capped at ~1200
 * characters. Mentions the document does not literally contain (extraction paraphrases) simply
 * contribute no window; when nothing anchors, fall back to the head so the judge is never worse
 * off than the historical behaviour.
 */
function anchoredSnippet(text: string, mentions: string[], radius = 150, cap = 1200): string {
  const folded = text.toLowerCase();
  const windows: Array<[number, number]> = [];
  for (const mention of mentions) {
    const needle = mention.trim().toLowerCase();
    if (!needle) continue;
    const at = folded.indexOf(needle);
    if (at === -1) continue;
    windows.push([Math.max(0, at - radius), Math.min(text.length, at + needle.length + radius)]);
  }
  if (windows.length === 0) return text.slice(0, 600).replace(/\s+/g, ' ').trim();

  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [windows[0]];
  for (const [start, end] of windows.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  let out = merged
    .map(([start, end]) => text.slice(start, end).replace(/\s+/g, ' ').trim())
    .join(' … ');
  if (out.length > cap) out = out.slice(0, cap);
  return out;
}

/**
 * Numbered mention-anchored windows plus a mention → window-reference map (`per-mention` snippet
 * mode). Windows are built exactly like {@link anchoredSnippet}'s (±150 chars, merged when
 * overlapping) but each merged window keeps an id, so evidence is printed once and referenced per
 * mention — explicit binding without duplicated text.
 */
function indexedWindows(
  text: string,
  mentions: string[],
  radius = 150,
  cap = 1500
): { evidence: string; refs: Map<string, string> } | null {
  const folded = text.toLowerCase();
  const hits: Array<{ mention: string; start: number; end: number }> = [];
  for (const mention of mentions) {
    const needle = mention.trim().toLowerCase();
    if (!needle) continue;
    const at = folded.indexOf(needle);
    if (at === -1) continue;
    hits.push({
      mention: needle,
      start: Math.max(0, at - radius),
      end: Math.min(text.length, at + needle.length + radius),
    });
  }
  if (hits.length === 0) return null;

  hits.sort((a, b) => a.start - b.start);
  const windows: Array<{ start: number; end: number; mentions: string[] }> = [];
  for (const hit of hits) {
    const last = windows[windows.length - 1];
    if (last && hit.start <= last.end) {
      last.end = Math.max(last.end, hit.end);
      last.mentions.push(hit.mention);
    } else {
      windows.push({ start: hit.start, end: hit.end, mentions: [hit.mention] });
    }
  }

  const refs = new Map<string, string>();
  const parts: string[] = [];
  let used = 0;
  windows.forEach((window, index) => {
    const id = `S${index + 1}`;
    let body = text.slice(window.start, window.end).replace(/\s+/g, ' ').trim();
    if (used + body.length > cap) body = body.slice(0, Math.max(0, cap - used));
    used += body.length;
    if (body) parts.push(`${id}. "${body}"`);
    for (const mention of window.mentions) {
      refs.set(mention, refs.has(mention) ? `${refs.get(mention)},${id}` : id);
    }
  });

  return { evidence: parts.join(' '), refs };
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
function renderMentionLines(plans: MentionPlan[]): string {
  return plans
    .map((plan, index) => {
      const candidates =
        plan.candidates
          .map((candidate) => `${candidate.name} (aliases: ${candidate.aliases.join(', ')})`)
          .join('; ') || '(none)';
      return `${index + 1}. "${plan.entity.name}" (${plan.category}); candidates: ${candidates}`;
    })
    .join('\n');
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
