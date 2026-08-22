import { ConceptRegistry } from '../ConceptRegistry/ConceptRegistry';
import { SchemaRegistry } from '../SchemaRegistry/SchemaRegistry';
import { ensureDir, sortByNumericId } from '../utils/fsUtils';
import { StreamingArtifact, StreamingEntity } from '../utils/validationUtils';
import fs from 'fs/promises';

export type EdgesFrom = 'layered' | 'extracted' | 'cooccurrence';

/** Edge *provenance* — not to be confused with the registry's granularity edge kinds. */
type EdgeKind = 'extracted' | 'inferred';

interface GraphNode {
  id: number;
  label: string;
  entityType: string;
  riskScore?: number;
  firstSeenDate: string;
}

interface GraphEdge {
  source: number;
  target: number;
  weight: number;
  edgeType: string;
  kind: EdgeKind;
  date: string;
  incidentIds: Set<number>;
}

interface Params {
  inputDir: string; // artifacts/
  outputDir: string; // .../graph
  schemaRegistry: SchemaRegistry;
  edgesFrom?: EdgesFrom;
  /** Identity graph. Loaded for parity with the pipeline; the builder emits the unfolded view —
   * coarser views are produced downstream by `npm run fold` / `ConceptRegistry.rollupTarget`. */
  conceptRegistry?: ConceptRegistry;
}

export class StreamingGraphBuilder {
  public readonly inputDir: string;
  public readonly outputDir: string;

  #schemaRegistry: SchemaRegistry;
  #conceptRegistry?: ConceptRegistry;
  #edgesFrom: EdgesFrom;

  constructor(params: Params) {
    this.inputDir = params.inputDir;
    this.outputDir = params.outputDir;
    this.#schemaRegistry = params.schemaRegistry;
    this.#conceptRegistry = params.conceptRegistry;
    this.#edgesFrom = params.edgesFrom ?? 'extracted';
  }

  async run() {
    await ensureDir(this.outputDir);
    await this.#schemaRegistry.load();
    if (this.#conceptRegistry) await this.#conceptRegistry.load();

    const files = sortByNumericId(await fs.readdir(this.inputDir));
    const allData: StreamingArtifact[] = [];
    for (const file of files) {
      console.log(`FILE=${file}`);
      const content = await fs.readFile(`${this.inputDir}/${file}`);
      allData.push(JSON.parse(content.toString()) as StreamingArtifact);
    }
    await this.#buildGraph(allData);
  }

  /**
   * The builder emits the unfolded graph — every canonical is its own node. Coarser views are a
   * downstream fold (`npm run fold`, `ConceptRegistry.rollupTarget`), never baked into the CSVs.
   * The identity projection is kept as a seam so a fold-at-build-time variant stays a one-function
   * change.
   */
  #project(_category: string, name: string): { label: string; widened: boolean } {
    return { label: name, widened: false };
  }

  // Copied from DataGraphBuilder — emergent categories fall through to the default branches
  #calculateRiskScore(category: string, role: string): number {
    if (role === 'Attacker') {
      switch (category) {
        case 'HackerGroup':
          return 9.0;
        case 'Software':
          return 8.0;
        case 'Domain':
          return 8.0;
        case 'Organization':
          return 9.0;
        case 'Country':
          return 10.0;
        case 'Individual':
          return 8.5;
        case 'Government Body':
          return 9.5;
        case 'Infrastructure':
          return 8.0;
        case 'Device':
          return 7.5;
        case 'Sector':
          return 7.0;
        default:
          return 7.0;
      }
    } else if (role === 'Target') {
      switch (category) {
        case 'Organization':
          return 8.0;
        case 'Country':
          return 8.0;
        case 'Domain':
          return 7.0;
        case 'Software':
          return 6.0;
        case 'Individual':
          return 7.5;
        case 'Government Body':
          return 9.0;
        case 'Infrastructure':
          return 8.5;
        case 'Device':
          return 6.5;
        case 'Sector':
          return 7.5;
        default:
          return 6.0;
      }
    } else {
      // Neutral
      return 5.0;
    }
  }

  // Legacy hardcoded rules — used ONLY by the 'cooccurrence' baseline mode
  // (copied verbatim from DataGraphBuilder#inferRelationship)
  #inferRelationship(
    entity1: StreamingEntity,
    entity2: StreamingEntity
  ): { source: StreamingEntity; target: StreamingEntity; edgeType: string } | null {
    const roles = [entity1.role, entity2.role].sort().join('-');
    const categories = [entity1.category, entity2.category].sort().join('-');

    if (
      categories.includes('Sector') &&
      (categories.includes('Organization') || categories.includes('Government Body'))
    ) {
      const org = entity1.category === 'Sector' ? entity2 : entity1;
      const sector = entity1.category === 'Sector' ? entity1 : entity2;
      return { source: org, target: sector, edgeType: 'belongs_to_sector' };
    }

    switch (roles) {
      case 'Attacker-Target': {
        const source = entity1.role === 'Attacker' ? entity1 : entity2;
        const target = entity1.role === 'Target' ? entity1 : entity2;
        return { source, target, edgeType: 'attacks' };
      }

      case 'Attacker-Attacker': {
        if (entity1.category === 'Sector' || entity2.category === 'Sector') {
          const attacker = entity1.category === 'Sector' ? entity2 : entity1;
          const target = entity1.category === 'Sector' ? entity1 : entity2;
          return { source: attacker, target: target, edgeType: 'attacks' };
        }

        if (entity1.category === 'HackerGroup' && entity2.category === 'HackerGroup') {
          return { source: entity1, target: entity2, edgeType: 'collaborates_with' };
        }

        const categoryPriority: Record<string, number> = {
          HackerGroup: 1,
          Individual: 2,
          Country: 3,
          'Government Body': 3,
          Organization: 4,
          Software: 5,
          Domain: 6,
          Infrastructure: 6,
          Device: 6,
        };

        const priority1 = categoryPriority[entity1.category] || 99;
        const priority2 = categoryPriority[entity2.category] || 99;

        const actor = priority1 <= priority2 ? entity1 : entity2;
        const asset = priority1 <= priority2 ? entity2 : entity1;

        if (
          ['HackerGroup', 'Individual', 'Organization'].includes(actor.category) &&
          ['Country', 'Government Body'].includes(asset.category)
        ) {
          return { source: actor, target: asset, edgeType: 'is_attributed_to' };
        }

        if (
          ['HackerGroup', 'Individual', 'Country', 'Government Body', 'Organization'].includes(
            actor.category
          ) &&
          ['Software', 'Domain', 'Infrastructure', 'Device'].includes(asset.category)
        ) {
          return { source: actor, target: asset, edgeType: 'uses_infrastructure' };
        }

        return { source: actor, target: asset, edgeType: 'collaborates_with' };
      }

      case 'Attacker-Neutral': {
        const source = entity1.role === 'Neutral' ? entity1 : entity2;
        const target = entity1.role === 'Attacker' ? entity1 : entity2;
        return { source, target, edgeType: 'mentioned_in_context_of' };
      }

      case 'Neutral-Target': {
        const source = entity1.role === 'Neutral' ? entity1 : entity2;
        const target = entity1.role === 'Target' ? entity1 : entity2;
        return { source, target, edgeType: 'mentioned_in_context_of' };
      }

      default: {
        if (roles === 'Target-Target') {
          return { source: entity1, target: entity2, edgeType: 'co_targeted' };
        }
        return { source: entity1, target: entity2, edgeType: 'related_to' };
      }
    }
  }

  async #buildGraph(data: StreamingArtifact[]): Promise<void> {
    const nodeMap = new Map<string, GraphNode>();
    const edges: Omit<GraphEdge, 'weight'>[] = [];
    let nodeIdCounter = 1;

    const nodeKey = (category: string, normalizedName: string) =>
      `${category}\u0000${normalizedName}`; // NUL join: safe even if a name contains ":"

    const getOrCreateNode = (
      entity: StreamingEntity,
      date: string
    ): { node: GraphNode; widened: boolean } => {
      const entityType = entity.category;
      const projected = this.#project(entityType, entity.normalizedName || entity.name);
      const label = projected.label;
      const key = nodeKey(entityType, label);

      if (!nodeMap.has(key)) {
        nodeMap.set(key, {
          id: nodeIdCounter++,
          label,
          entityType,
          riskScore: this.#calculateRiskScore(entity.category, entity.role),
          firstSeenDate: date,
        });
      } else {
        const existingNode = nodeMap.get(key)!;
        if (
          date !== 'unknown' &&
          (existingNode.firstSeenDate === 'unknown' || date < existingNode.firstSeenDate)
        ) {
          existingNode.firstSeenDate = date;
        }
      }
      return { node: nodeMap.get(key)!, widened: projected.widened };
    };

    const convertToISO8601 = (dateStr: string): string => {
      if (!dateStr || dateStr === 'unknown') return 'unknown';
      if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
        return dateStr.split('T')[0];
      }
      const match = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (match) {
        const [, day, month, year] = match;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
      console.warn(`Unexpected date format: '${dateStr}'. Treating as unknown.`);
      return 'unknown';
    };

    const addEdge = (
      source: GraphNode,
      target: GraphNode,
      edgeType: string,
      kind: EdgeKind,
      date: string,
      incidentId: number,
      // Projection contract: an endpoint folded through a `part-of` edge makes the edge an
      // interpretation — `inferred` propagates, `extracted` does not survive a widening fold.
      widened = false
    ) => {
      if (source.id === target.id) return;
      edges.push({
        source: source.id,
        target: target.id,
        edgeType,
        kind: widened ? 'inferred' : kind,
        date,
        incidentIds: new Set([incidentId]),
      });
    };

    console.log(`Building graph (edgesFrom=${this.#edgesFrom})...`);
    for (const incident of data) {
      const date = convertToISO8601(String(incident.metadata?.date || 'unknown'));
      const incidentId = Number(incident.metadata?.id) || 0;
      const { entities, relations } = incident;

      // 1. Create all nodes mentioned in the incident
      entities.forEach((entity) => getOrCreateNode(entity, date));

      // 2. Extracted relation edges (modes: extracted, layered)
      //    Track which unordered entity pairs are covered by an extracted relation
      const extractedPairs = new Set<string>();
      if (this.#edgesFrom !== 'cooccurrence') {
        for (const relation of relations || []) {
          const headProjection = this.#project(
            relation.headCategory,
            relation.normalizedHead || relation.head
          );
          const tailProjection = this.#project(
            relation.tailCategory,
            relation.normalizedTail || relation.tail
          );
          const headKey = nodeKey(relation.headCategory, headProjection.label);
          const tailKey = nodeKey(relation.tailCategory, tailProjection.label);
          const headNode = nodeMap.get(headKey);
          const tailNode = nodeMap.get(tailKey);
          if (!headNode || !tailNode) {
            console.warn(
              `Skipping relation "${relation.head}" -[${relation.type}]-> "${relation.tail}" in incident ${incidentId}: endpoint has no node`
            );
            continue;
          }
          const edgeType =
            this.#schemaRegistry.resolveRelationType(relation.type) || relation.type;
          addEdge(
            headNode,
            tailNode,
            edgeType,
            'extracted',
            date,
            incidentId,
            headProjection.widened || tailProjection.widened
          );
          extractedPairs.add([headKey, tailKey].sort().join('|'));
        }
      }

      // 3. Pair-based edges
      if (this.#edgesFrom !== 'extracted' && entities.length >= 2) {
        for (let i = 0; i < entities.length; i++) {
          for (let j = i + 1; j < entities.length; j++) {
            const entity1 = entities[i];
            const entity2 = entities[j];

            if (this.#edgesFrom === 'cooccurrence') {
              // Legacy 2025-baseline: hardcoded rules over every pair
              const relationship = this.#inferRelationship(entity1, entity2);
              if (relationship) {
                const source = getOrCreateNode(relationship.source, date);
                const target = getOrCreateNode(relationship.target, date);
                addEdge(
                  source.node,
                  target.node,
                  relationship.edgeType,
                  'inferred',
                  date,
                  incidentId,
                  source.widened || target.widened
                );
              }
              continue;
            }

            // Layered: pair-rule fallback only where no extracted relation covers the pair
            const key1 = nodeKey(
              entity1.category,
              this.#project(entity1.category, entity1.normalizedName || entity1.name).label
            );
            const key2 = nodeKey(
              entity2.category,
              this.#project(entity2.category, entity2.normalizedName || entity2.name).label
            );
            if (extractedPairs.has([key1, key2].sort().join('|'))) continue;

            const rule = this.#schemaRegistry.getPairRule(
              this.#schemaRegistry.signatureKey(
                { category: entity1.category, role: entity1.role },
                { category: entity2.category, role: entity2.role }
              )
            );
            if (!rule || rule.relation === null) continue;

            // Orient by matching each entity against the rule's source signature
            const matchesSource = (entity: StreamingEntity) =>
              entity.category === rule.source.category && entity.role === rule.source.role;
            const [source, target] = matchesSource(entity1)
              ? [entity1, entity2]
              : [entity2, entity1];

            const sourceNode = getOrCreateNode(source, date);
            const targetNode = getOrCreateNode(target, date);
            addEdge(
              sourceNode.node,
              targetNode.node,
              rule.relation,
              'inferred',
              date,
              incidentId,
              sourceNode.widened || targetNode.widened
            );
          }
        }
      }
    }

    // Aggregation per (source, target, edgeType, kind) — spec §3.6
    console.log('Aggregating edges...');
    const edgeMap = new Map<string, GraphEdge>();
    for (const edge of edges) {
      const key = `${edge.source}-${edge.target}-${edge.edgeType}-${edge.kind}`;

      if (edgeMap.has(key)) {
        const existing = edgeMap.get(key)!;
        edge.incidentIds.forEach((id) => existing.incidentIds.add(id));
        existing.weight = existing.incidentIds.size;
        if (edge.date !== 'unknown' && (existing.date === 'unknown' || edge.date < existing.date)) {
          existing.date = edge.date;
        }
      } else {
        edgeMap.set(key, { ...edge, weight: 1, incidentIds: new Set(edge.incidentIds) });
      }
    }

    // nodes.csv — format unchanged: Id;Label;EntityType;RiskScore;Date
    const nodesContent: string[] = ['Id;Label;EntityType;RiskScore;Date'];
    const nodes = Array.from(nodeMap.values()).sort((a, b) => a.id - b.id);
    for (const node of nodes) {
      const riskScore = node.riskScore?.toFixed(1) || '0.0';
      nodesContent.push(
        `${node.id};"${node.label.replace(/"/g, '""')}";"${node.entityType}";${riskScore};${node.firstSeenDate}`
      );
    }
    await fs.writeFile(`${this.outputDir}/nodes.csv`, nodesContent.join('\n'));

    // edges.csv — gains the Kind column: Source;Target;Weight;EdgeType;Kind;Date
    const edgesContent: string[] = ['Source;Target;Weight;EdgeType;Kind;Date'];
    const aggregatedEdges = Array.from(edgeMap.values()).sort((a, b) => {
      if (a.source !== b.source) return a.source - b.source;
      return a.target - b.target;
    });
    for (const edge of aggregatedEdges) {
      edgesContent.push(
        `${edge.source};${edge.target};${edge.weight};"${edge.edgeType.replace(/"/g, '""')}";${edge.kind};${edge.date}`
      );
    }
    await fs.writeFile(`${this.outputDir}/edges.csv`, edgesContent.join('\n'));

    console.log(`Graph built with ${nodes.length} nodes and ${aggregatedEdges.length} edges`);
    console.log(`Output files: ${this.outputDir}/nodes.csv and ${this.outputDir}/edges.csv`);
  }
}
