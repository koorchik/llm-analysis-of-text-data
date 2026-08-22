import { PromptProvider, prompts } from '../Normalization/PromptProvider';
import { DecisionLog } from '../DecisionLog/DecisionLog';
import type { LlmClient } from '../LlmClient/LlmClient';
import type { LlmResponse } from '../LlmClient/LlmClientBackendBase';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { ensureDir, sortByNumericId, writeJsonAtomic } from '../utils/fsUtils';
import { stringSimilarity } from '../utils/similarityUtils';
import {
  SchemaProposal,
  StreamingExtraction,
  extractAndParseJson,
  normalizeStreamingExtraction,
  normalizeTypeJudgeVerdicts,
} from '../utils/validationUtils';
import { existsSync } from 'fs';
import fs from 'fs/promises';

type Preprocessor = (
  content: string
) => Promise<{ text: string; metadata: Record<string, string | number> }>;

interface Params {
  /** Document arrival order for `run()` (E6/M7); defaults to numeric-id. */
  fileOrder?: (files: string[]) => string[];
  inputDir: string;
  outputDir: string;
  llmClient: LlmClient;
  preprocessor?: Preprocessor;
  schemaRegistry: SchemaRegistry;
  decisionLog: DecisionLog;
  typeSimThreshold?: number;
  /**
   * Prompt templates. Injectable so a variant arm (E8, prompt sensitivity) can supply its own
   * without touching this class; defaults to the shared `prompts/` directory.
   */
  prompts?: PromptProvider;
}

interface AmbiguousProposal {
  proposal: SchemaProposal;
  kind: 'category' | 'relationType';
  nearMatches: Array<{ name: string; definition: string; aliases: string[] }>;
}

export class StreamingExtractor {
  public readonly inputDir: string;
  public readonly outputDir: string;

  #llmClient: LlmClient;
  #schemaRegistry: SchemaRegistry;
  #decisionLog: DecisionLog;
  #typeSimThreshold: number;
  #preprocessor: Preprocessor = (content: string) =>
    Promise.resolve({ text: content, metadata: {} });

  #prompts: PromptProvider;

  #fileOrder?: (files: string[]) => string[];

  constructor(params: Params) {
    this.#fileOrder = params.fileOrder;
    this.#prompts = params.prompts ?? prompts;
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#llmClient = params.llmClient;
    this.#schemaRegistry = params.schemaRegistry;
    this.#decisionLog = params.decisionLog;
    this.#typeSimThreshold = params.typeSimThreshold ?? 0.6;

    if (params.preprocessor) {
      this.#preprocessor = params.preprocessor;
    }
  }

  async run() {
    await ensureDir(this.outputDir);
    const files = (this.#fileOrder ?? sortByNumericId)(await fs.readdir(this.inputDir));
    for (const file of files) {
      await this.processFile(file);
    }
  }

  // Returns true when the extraction file exists (pre-existing or just written)
  async processFile(file: string): Promise<boolean> {
    const outputFile = `${this.outputDir}/${file}`;
    if (existsSync(outputFile)) {
      console.log(`SKIP (exists) ${outputFile}`);
      return true;
    }

    await ensureDir(this.outputDir);
    await this.#schemaRegistry.load();

    console.log(`IN FILE=${this.inputDir}/${file}`);
    const content = await fs.readFile(`${this.inputDir}/${file}`);
    const data = await this.#preprocessor(content.toString());
    const docId = Number(data.metadata.id) || parseInt(file, 10) || 0;

    const started = Date.now();
    console.time(`LLM EXTRACTION ${file}`);
    const response = await this.#llmClient.send(this.#buildInstructions(), data.text, {
      operator: 'extract',
      docId,
    });
    console.timeEnd(`LLM EXTRACTION ${file}`);
    const spent = (Date.now() - started) / 1000;
    await this.#decisionLog.logLlmCall({
      doc: docId,
      kind: 'extract',
      seconds: spent,
      model: response.model,
      promptTokens: response.usage.inputTokens,
      completionTokens: response.usage.outputTokens,
    });

    const rawData = extractAndParseJson(response.text);
    const extraction = rawData && normalizeStreamingExtraction(rawData);
    if (!extraction) {
      // Write nothing, mutate nothing — the document is retried on the next run
      console.error(`EXTRACTION FAILED for ${file} — no valid JSON in LLM response`);
      return false;
    }

    await this.#resolveSchemaProposals(extraction, docId);

    // State before output: idempotent admits make a crash between the writes safe
    await this.#schemaRegistry.save();
    await writeJsonAtomic(outputFile, {
      entities: extraction.entities,
      relations: extraction.relations,
      schemaProposals: extraction.schemaProposals,
      metadata: { ...data.metadata, llmProcessingTimeSeconds: spent },
    });
    console.log(`OUT FILE=${outputFile}`);
    return true;
  }

  async #resolveSchemaProposals(extraction: StreamingExtraction, docId: number): Promise<void> {
    // Relation types used in relations but neither known nor proposed → implicit proposals
    const proposedTypes = new Set(
      extraction.schemaProposals.relationTypes.map((p) => p.name.toLowerCase())
    );
    for (const relation of extraction.relations) {
      if (
        !this.#schemaRegistry.resolveRelationType(relation.type) &&
        !proposedTypes.has(relation.type.trim().toLowerCase())
      ) {
        extraction.schemaProposals.relationTypes.push({ name: relation.type, definition: '' });
        proposedTypes.add(relation.type.trim().toLowerCase());
      }
    }

    const categoryPlan = this.#planProposals(
      'category',
      this.#collapseProposals(extraction.schemaProposals.categories),
      extraction
    );
    const relationTypePlan = this.#planProposals(
      'relationType',
      this.#collapseProposals(extraction.schemaProposals.relationTypes),
      extraction
    );

    const ambiguous = [...categoryPlan.ambiguous, ...relationTypePlan.ambiguous];
    const aliasVerdicts = new Map<string, string>(); // `${kind}|${lowercased proposal}` → canonical

    if (ambiguous.length > 0) {
      const verdicts = await this.#typeJudge(ambiguous, docId);
      for (const verdict of verdicts) {
        if (verdict.verdict !== 'alias') continue;
        const canonical =
          verdict.kind === 'category'
            ? this.#schemaRegistry.resolveCategory(verdict.target)
            : this.#schemaRegistry.resolveRelationType(verdict.target);
        if (canonical) {
          aliasVerdicts.set(`${verdict.kind}|${verdict.proposal.trim().toLowerCase()}`, canonical);
        }
      }
    }

    for (const plan of [categoryPlan, relationTypePlan]) {
      for (const { proposal, kind, collapsedInto } of plan.all) {
        if (collapsedInto) continue; // handled after its survivor below
        const aliasTarget = aliasVerdicts.get(`${kind}|${proposal.name.trim().toLowerCase()}`);
        if (aliasTarget) {
          this.#addAlias(kind, aliasTarget, proposal.name, docId);
          await this.#decisionLog.log({
            doc: docId,
            op: `alias-${kind === 'category' ? 'category' : 'relation-type'}`,
            proposal: proposal.name,
            target: aliasTarget,
          });
        } else {
          this.#admit(kind, proposal, extraction, docId);
        }
      }
      // Collapsed proposals become aliases of whatever their survivor resolved to
      for (const { proposal, kind, collapsedInto } of plan.all) {
        if (!collapsedInto) continue;
        const canonical =
          kind === 'category'
            ? this.#schemaRegistry.resolveCategory(collapsedInto)
            : this.#schemaRegistry.resolveRelationType(collapsedInto);
        if (canonical) this.#addAlias(kind, canonical, proposal.name, docId);
      }
    }
  }

  // Intra-document collapse: doc 1 proposing "ThreatActor" and "Threat Actor" must not admit both
  #collapseProposals(
    proposals: SchemaProposal[]
  ): Array<{ proposal: SchemaProposal; collapsedInto?: string }> {
    const result: Array<{ proposal: SchemaProposal; collapsedInto?: string }> = [];
    const survivors: SchemaProposal[] = [];

    for (const proposal of proposals) {
      const survivor = survivors.find(
        (candidate) => stringSimilarity(candidate.name, proposal.name) >= this.#typeSimThreshold
      );
      if (survivor) {
        result.push({ proposal, collapsedInto: survivor.name });
      } else {
        survivors.push(proposal);
        result.push({ proposal });
      }
    }
    return result;
  }

  #planProposals(
    kind: 'category' | 'relationType',
    collapsed: Array<{ proposal: SchemaProposal; collapsedInto?: string }>,
    extraction: StreamingExtraction
  ): {
    all: Array<{ proposal: SchemaProposal; kind: 'category' | 'relationType'; collapsedInto?: string }>;
    ambiguous: AmbiguousProposal[];
  } {
    const ambiguous: AmbiguousProposal[] = [];
    const all = collapsed.map(({ proposal, collapsedInto }) => ({ proposal, kind, collapsedInto }));

    for (const { proposal, collapsedInto } of collapsed) {
      if (collapsedInto) continue;
      const resolved =
        kind === 'category'
          ? this.#schemaRegistry.resolveCategory(proposal.name)
          : this.#schemaRegistry.resolveRelationType(proposal.name);
      if (resolved) continue; // already known — nothing to judge or admit

      const nearMatches =
        kind === 'category'
          ? this.#schemaRegistry.findSimilarCategories(proposal.name, this.#typeSimThreshold)
          : this.#schemaRegistry.findSimilarRelationTypes(proposal.name, this.#typeSimThreshold);

      if (nearMatches.length > 0) {
        ambiguous.push({
          proposal,
          kind,
          nearMatches: nearMatches.map((match) => ({
            name: match.entry.name,
            definition: match.entry.definition,
            aliases: match.entry.aliases,
          })),
        });
      }
    }
    return { all, ambiguous };
  }

  #admit(
    kind: 'category' | 'relationType',
    proposal: SchemaProposal,
    extraction: StreamingExtraction,
    docId: number
  ): void {
    if (kind === 'category') {
      const examples = extraction.entities
        .filter((entity) => entity.category === proposal.name)
        .slice(0, 3)
        .map((entity) => entity.name);
      this.#schemaRegistry.admitCategory({
        name: proposal.name,
        definition: proposal.definition,
        examples,
        doc: docId,
      });
    } else {
      this.#schemaRegistry.admitRelationType({
        name: proposal.name,
        definition: proposal.definition,
        doc: docId,
      });
    }
  }

  #addAlias(
    kind: 'category' | 'relationType',
    canonical: string,
    alias: string,
    docId: number
  ): void {
    if (kind === 'category') {
      this.#schemaRegistry.addCategoryAlias(canonical, alias, docId);
    } else {
      this.#schemaRegistry.addRelationTypeAlias(canonical, alias, docId);
    }
  }

  async #typeJudge(
    ambiguous: AmbiguousProposal[],
    docId: number
  ): Promise<Array<{ proposal: string; kind: 'category' | 'relationType'; verdict: string; target: string }>> {
    const lines = ambiguous.map((item, index) => {
      const matches = item.nearMatches
        .map(
          (match) =>
            `\`${match.name}\` (${match.definition || 'no definition'}${
              match.aliases.length ? `; aliases: ${match.aliases.join(', ')}` : ''
            })`
        )
        .join('; ');
      return `${index + 1}. proposal \`${item.proposal.name}\` (kind: ${item.kind}; definition: ${
        item.proposal.definition || 'none given'
      }) — near matches: ${matches}`;
    });

    const instructions = this.#prompts.render('type-judge');

    const started = Date.now();
    console.time(`TYPE-JUDGE doc ${docId}`);
    // Hoisted so the finally block can log tokens for a call that may have thrown.
    let response: LlmResponse | undefined;
    try {
      response = await this.#llmClient.send(instructions, lines.join('\n'), {
        operator: 'type-judge',
        docId,
      });
      const verdicts = normalizeTypeJudgeVerdicts(extractAndParseJson(response.text) || {});
      return verdicts || [];
    } catch (error) {
      // Never lose the document over a judge call — admit-all is repairable later (schema drift
      // is out of StreamingRepairer's scope; the RQ3 batch-reference harness's schema pass covers it)
      console.error(`TYPE-JUDGE failed for doc ${docId}, admitting all proposals:`, error);
      return [];
    } finally {
      console.timeEnd(`TYPE-JUDGE doc ${docId}`);
      await this.#decisionLog.logLlmCall({
        doc: docId,
        kind: 'type-judge',
        seconds: (Date.now() - started) / 1000,
        model: response?.model,
        promptTokens: response?.usage.inputTokens,
        completionTokens: response?.usage.outputTokens,
      });
    }
  }

  #buildInstructions(): string {
    return this.#prompts.render('extract-streaming', {
      knownCategories: this.#schemaRegistry.renderKnownCategories(),
      knownRelationTypes: this.#schemaRegistry.renderKnownRelationTypes(),
    });
  }
}
