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
  inputDir: string;
  outputDir: string;
  llmClient: LlmClient;
  preprocessor?: Preprocessor;
  schemaRegistry: SchemaRegistry;
  decisionLog: DecisionLog;
  typeSimThreshold?: number;
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

  constructor(params: Params) {
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
    const files = sortByNumericId(await fs.readdir(this.inputDir));
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

    const instructions = `You maintain the emergent schema of a cyber-incident knowledge base.
For each proposed schema entry below, decide whether it is merely an alias of one of its listed near matches (same concept, different surface name) or a genuinely new entry. Judge by MEANING (definitions), not just string similarity. If uncertain, prefer "new" — over-splitting is repairable later, wrong merges are not.

Output a single raw JSON object, no markdown fences, no commentary:
{ "verdicts": [ { "proposal": "<proposed name>", "kind": "category" | "relationType", "verdict": "alias" | "new", "target": "<near-match name when verdict is alias>" } ] }`;

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
      // Never lose the document over a judge call — admit-all is repairable by the consolidator
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
    return `### ROLE ###
You are a specialized AI model functioning as a high-precision data extraction engine. Your purpose is to parse unstructured text about cyber incidents and convert it into a structured JSON object according to the rules provided.

### KNOWN SCHEMA ###
The schema below was discovered from previously processed documents. REUSE its categories and relation types whenever they fit. Only propose a new category or relation type when nothing in the known schema fits; a proposal must include a one-line definition.

Known entity categories:
${this.#schemaRegistry.renderKnownCategories()}

Known relation types:
${this.#schemaRegistry.renderKnownRelationTypes()}

Roles are FIXED (never propose new roles):
  * \`Target\`: The ultimate entity being victimized or attacked.
  * \`Attacker\`: The aggressor, or any software, domain, or infrastructure directly controlled by and used by the aggressor to facilitate an attack.
  * \`Neutral\`: A third-party observer, security researcher, reporting agency, or any entity not directly involved in the conflict.

### WHAT TO EXTRACT ###
1. \`entities\`: every relevant entity as { "name", "category", "role" }.
   - \`category\`: a known category name, or your proposed new one (also listed in \`schemaProposals.categories\` with its definition).
   - \`role\`: exactly one of Target | Attacker | Neutral, per the RULES ENGINE below.
2. \`relations\`: every relationship STATED OR CLEARLY IMPLIED IN THE TEXT between two extracted entities, as { "head", "headCategory", "type", "tail", "tailCategory" }.
   - \`head\`/\`tail\` MUST exactly match \`name\` values from \`entities\`; \`headCategory\`/\`tailCategory\` their categories.
   - \`type\`: a known relation type name, or your proposed new one (also listed in \`schemaProposals.relationTypes\` with its definition).
   - Direction: head acts on tail (e.g., attacker attacks target).
   - Do NOT invent relations that the text does not support. It is correct to return few or no relations. Do NOT add a relation for every co-occurring pair.
3. \`schemaProposals\`: { "categories": [{ "name", "definition" }], "relationTypes": [{ "name", "definition" }] } — empty arrays when everything fit the known schema. Absence of new types is the normal case, not a failure.

### RULES ENGINE ###
Apply these rules in order. The logic here is absolute.

* **Rule 1: Role Assignment Logic**
  * An entity's role is determined by its function in the incident:
    * **Condition A: Assign "Attacker" Role** if the entity meets **any** of these criteria:
      * It is explicitly identified as the aggressor (e.g., a HackerGroup).
      * It is a resource directly controlled by the aggressor, such as:
        * **A.1: Malware/Tools:** Software used to perform the attack.
        * **A.2: C2 Infrastructure:** Domains or IPs used for command and control.
        * **A.3: Compromised Infrastructure:** Devices or servers that were taken over and then used to launch further attacks (e.g., botnets). This is the "Compromised Infrastructure Rule".
    * **Condition B: Assign "Target" Role** if the entity is the final recipient of the malicious activity and does not meet any criteria under Condition A.
    * **Condition C: Assign "Neutral" Role** if the entity is an observer, reporter, or researcher not involved in the conflict.

* **Rule 2: Implied Country Extraction**
  * **IF** you extract an entity representing a government body or agency,
  * **AND** the name of that entity explicitly contains the name of a country (e.g., "Ministry of Defence of **Ukraine**", "**US** Department of State"),
  * **THEN** you MUST also generate a second, separate country entity for that nation.
  * This new country entity MUST be assigned the **same role** as the government body it was derived from.

* **Rule 3: Strict Role Adherence**
  * The value for \`role\` MUST be chosen exclusively from the fixed list above (Target, Attacker, Neutral). Never invent or modify roles.

* **Rule 4: Deduplication**
  * The final \`entities\` list must not contain duplicates. An entity is a duplicate if its \`name\`, \`category\`, and \`role\` are all identical.

* **Rule 5: Negative Constraints (Exclusions)**
  * **DO NOT** extract the following:
    * The entity "CERT-UA". It is a reporting body to be ignored.
    * Generic, non-specific technologies like "the internet," "computers," or "networks" unless they refer to a specific, targeted infrastructure (e.g., "the Viasat satellite network").

### FINAL OUTPUT FORMAT ###
First think through the incident in free form (who did what to whom, with which tools). Keep this reasoning BRIEF and do NOT use curly braces { } anywhere in it. Then output a single raw JSON object: { "entities": [...], "relations": [...], "schemaProposals": {...} }. Do not wrap it in markdown code blocks. No commentary after the JSON. If nothing is found: { "entities": [], "relations": [], "schemaProposals": { "categories": [], "relationTypes": [] } }.

Apply these instructions to the text provided in the user's next message.`;
  }
}
