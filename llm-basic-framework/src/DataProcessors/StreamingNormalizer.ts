import { CountryNameNormalizer } from '../CountryNameNormalizer/CountryNameNormalizer';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import { EntityRegistry } from '../EntityRegistry/EntityRegistry';
import { StringSimilarityGenerator } from '../Normalization/candidates/StringSimilarityGenerator';
import type { CandidateGenerator } from '../Normalization/types';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { ensureDir, sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import {
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
}

interface MentionPlan {
  entity: StreamingEntity;
  category: string; // canonical
  canonical?: string; // resolution result once known
  candidates: Array<{ name: string; sim: number; aliases: string[]; channel?: string }>;
  action: 'resolved' | 'mint' | 'judge';
}

/**
 * Candidates as the judge saw them, in the order shown. `channel` names the generator that
 * surfaced each one — everything is string similarity until M4 adds embedding/BM25/RRF channels,
 * and E4's per-channel candidate recall is scored off this field.
 */
function describeCandidates(
  candidates: MentionPlan['candidates']
): Array<{ name: string; sim: number; channel: string }> {
  return candidates.map((candidate) => ({
    name: candidate.name,
    sim: Number(candidate.sim.toFixed(2)),
    channel: candidate.channel ?? 'string-sim',
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

  constructor(params: Params) {
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
      }));
      plan.action = plan.candidates.length > 0 ? 'judge' : 'mint';
    }

    // Link-judge: ONE batched call for all unresolved mentions with candidates.
    // Dedupe by (category, lowercased name) — the same mention may appear with several roles.
    const judgeBatch = new Map<string, MentionPlan>();
    for (const plan of plans) {
      if (plan.action !== 'judge') continue;
      const key = `${plan.category}|${plan.entity.name.trim().toLowerCase()}`;
      if (!judgeBatch.has(key)) judgeBatch.set(key, plan);
    }

    if (judgeBatch.size > 0) {
      const verdictMap = await this.#linkJudge([...judgeBatch.values()], extraction, docId, file);
      for (const plan of plans) {
        if (plan.action !== 'judge') continue;
        const key = `${plan.category}|${plan.entity.name.trim().toLowerCase()}`;
        const target = verdictMap.get(key);
        if (target) {
          plan.canonical = target;
        } // else: stays a mint
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
        // mint (zero candidates, judge said mint, or judge failed)
        plan.canonical = this.#entityRegistry.mint(plan.category, plan.entity.name, {
          doc: docId,
          date: docDate,
        });
        this.#candidateGenerator.onRegistryChange({
          type: 'mint',
          category: plan.category,
          canonical: plan.canonical,
        });
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

  async #linkJudge(
    batch: MentionPlan[],
    extraction: StreamingExtraction,
    docId: number,
    file: string
  ): Promise<Map<string, string>> {
    const title = String(extraction.metadata?.title || 'untitled');
    const snippet = await this.#loadSnippet(file);

    const lines = batch.map((plan, index) => {
      const candidates = plan.candidates
        .map((c) => `${c.name} [aliases: ${c.aliases.join(', ')}]`)
        .join('; ');
      return `${index + 1}. "${plan.entity.name}" (${plan.category}); candidates: ${candidates}`;
    });

    const instructions = `You are an entity-resolution judge for a cyber-incident knowledge base.
For each mention below, decide whether it refers to one of the known canonical entities of the same category (answer "link" with its name) or to an entity not seen before (answer "mint"). Only link when the evidence supports identity: shared naming, a stated alias in the document context, or an unambiguous abbreviation. Similar type or theme alone is NOT identity. If uncertain, prefer "mint" — duplicates are repairable later, wrong merges are not.

Output a single raw JSON object, no markdown fences, no commentary:
{ "verdicts": [ { "mention": "<mention>", "category": "<category>", "verdict": "link" | "mint", "target": "<canonical name when linking>" } ] }`;

    const text = `Document: "${title}" — context: ${snippet}
Mentions:
${lines.join('\n')}`;

    const started = Date.now();
    console.time(`LINK-JUDGE doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(instructions, text, {
        operator: 'link-judge',
        docId,
      });
      const verdicts = normalizeLinkVerdicts(extractAndParseJson(response.text) || {}) || [];

      const verdictMap = new Map<string, string>();
      const batchByMention = new Map(
        batch.map((plan) => [plan.entity.name.trim().toLowerCase(), plan])
      );
      for (const verdict of verdicts) {
        if (verdict.verdict !== 'link') continue;
        const plan = batchByMention.get(verdict.mention.trim().toLowerCase());
        if (!plan) continue;
        // Only accept links to actual candidates' canonical names
        const target = plan.candidates.find(
          (c) => c.name.toLowerCase() === verdict.target.trim().toLowerCase()
        );
        if (target) {
          verdictMap.set(`${plan.category}|${plan.entity.name.trim().toLowerCase()}`, target.name);
        }
      }
      return verdictMap;
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

    const instructions = `You maintain co-occurrence inference rules for a cyber-incident knowledge graph. When two entities with the type/role signatures below appear in the same incident report, what relationship — if any — does that co-occurrence imply BY DEFAULT? Answer conservatively: use null unless the signature itself implies a directed relationship. Symmetric signatures (both sides identical) usually imply null or a symmetric relation. Reuse a known relation type when one fits; otherwise propose a new one and include a one-line "definition".

Known relation types:
${this.#schemaRegistry.renderKnownRelationTypes()}

Output a single raw JSON object, no markdown fences, no commentary:
{ "rules": [ { "signature": <number>, "relation": "<type name or null>", "source": "<Category/Role>", "target": "<Category/Role>", "definition": "<only when proposing a new relation type>" } ] }`;

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
