import { jsonrepair } from 'jsonrepair'

import LIVR from 'livr';
LIVR.Validator.defaultAutoTrim(true);

const validator = new LIVR.Validator({
  entities: [{ default: [[]] }, {
    listOfObjects: [{
      name: ['required', 'string'],
      category: ['required', 'string', { 
        oneOf: [
          'Organization', 
          'HackerGroup', 
          'Software', 
          'Country', 
          'Individual', 
          'Domain', 
          'Sector', 
          'Government Body', 
          'Infrastructure', 
          'Device'
        ] 
      }],
      role: ['required', 'string', { oneOf: ['Target', 'Attacker', 'Neutral'] }]
    }]
  }]
});

interface RawData {
  [key: string]: any
};

export type Category = 
  | 'Organization' 
  | 'HackerGroup' 
  | 'Software' 
  | 'Country' 
  | 'Individual' 
  | 'Domain' 
  | 'Sector' 
  | 'Government Body' 
  | 'Infrastructure' 
  | 'Device';

export type Role = 'Target' | 'Attacker' | 'Neutral';

export interface Entity {
  name: string;
  category: Category;
  role: Role;
  embedding?: number[];
  normalizedName?: string;
  code?: string; // For countries
}

export interface UnifiedData {
  entities: Entity[];
  metadata?: Record<string, string | number>;
}

export function extractAndParseJson(text: string): RawData | undefined {
  const matched = text.match(/\{[\s\S]+\}/g);
  if (!matched) return;

  try {
    const repaired = jsonrepair(matched[0]);
    return JSON.parse(repaired);
  } catch (error) {
    return;
  }
}

export function normalizeRawData(data: RawData): UnifiedData | undefined {
  const validData = validator.validate(data);
  console.log(data);
  if (!validData) {
    console.log({ERROR: validator.getErrors()});
    return;
  }

  // Filter out empty entities and normalize domain names to lowercase
  validData.entities = validData.entities
    .filter((entity: Entity) => entity.name && entity.name.trim())
    .map((entity: Entity) => {
      if (entity.category === 'Domain') {
        entity.name = entity.name.toLowerCase();
      }
      return entity;
    });

  // Remove duplicates based on name, category, and role
  const seen = new Set<string>();
  validData.entities = validData.entities.filter((entity: Entity) => {
    const key = `${entity.name}|${entity.category}|${entity.role}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return validData as UnifiedData;
}

// ============================================================================
// Streaming pipeline (SKEIN v2) — additive; the legacy validator above stays
// untouched for the batch pipeline.
//
// LIVR note: `required` + defaultAutoTrim(true) rejects the WHOLE payload when
// one list item has an empty-string field, so all nested string fields use
// { default: '' } + post-filtering, and enum fields get a pre-coercion pass.
// ============================================================================

export interface StreamingEntity {
  name: string;
  category: string; // open string — emergent schema
  role: Role;
  normalizedName?: string;
  code?: string;
}

export interface StreamingRelation {
  head: string;
  headCategory: string;
  type: string;
  tail: string;
  tailCategory: string;
  normalizedHead?: string;
  normalizedTail?: string;
}

export interface SchemaProposal {
  name: string;
  definition: string;
}

export interface SchemaProposals {
  categories: SchemaProposal[];
  relationTypes: SchemaProposal[];
}

export interface StreamingExtraction {
  entities: StreamingEntity[];
  relations: StreamingRelation[];
  schemaProposals: SchemaProposals;
  metadata?: Record<string, string | number>;
}

export type StreamingArtifact = StreamingExtraction;

const STREAMING_ROLES: Role[] = ['Target', 'Attacker', 'Neutral'];

const proposalListRules = [
  { default: [] },
  {
    listOfObjects: [
      {
        name: [{ default: '' }, 'string'],
        definition: [{ default: '' }, 'string'],
      },
    ],
  },
];

const streamingExtractionValidator = new LIVR.Validator({
  entities: [
    { default: [] },
    {
      listOfObjects: [
        {
          name: [{ default: '' }, 'string'],
          category: [{ default: '' }, 'string'], // open string — no oneOf
          role: [{ default: 'Neutral' }, 'string', { oneOf: STREAMING_ROLES }],
        },
      ],
    },
  ],
  relations: [
    { default: [] },
    {
      listOfObjects: [
        {
          head: [{ default: '' }, 'string'],
          headCategory: [{ default: '' }, 'string'],
          type: [{ default: '' }, 'string'],
          tail: [{ default: '' }, 'string'],
          tailCategory: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
  schemaProposals: [
    { default: { categories: [], relationTypes: [] } },
    {
      nested_object: {
        categories: proposalListRules,
        relationTypes: proposalListRules,
      },
    },
  ],
});

export function normalizeStreamingExtraction(data: RawData): StreamingExtraction | undefined {
  if (!data || typeof data !== 'object') return;

  // Pre-coercion: one hallucinated enum value must not sink the whole document
  if (Array.isArray(data.entities)) {
    for (const entity of data.entities) {
      if (entity && typeof entity === 'object' && !STREAMING_ROLES.includes(entity.role)) {
        entity.role = 'Neutral';
      }
    }
  }

  const validData = streamingExtractionValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: streamingExtractionValidator.getErrors() });
    return;
  }

  validData.entities = validData.entities
    .filter((entity: StreamingEntity) => entity.name?.trim() && entity.category?.trim())
    .map((entity: StreamingEntity) => {
      if (entity.category === 'Domain') {
        entity.name = entity.name.toLowerCase();
      }
      return entity;
    });

  const seenEntities = new Set<string>();
  validData.entities = validData.entities.filter((entity: StreamingEntity) => {
    const key = `${entity.name}|${entity.category}|${entity.role}`;
    if (seenEntities.has(key)) return false;
    seenEntities.add(key);
    return true;
  });

  // Relations must reference extracted entities by surface name (spec §3.3)
  const entityNames = new Set(validData.entities.map((e: StreamingEntity) => e.name));
  validData.relations = validData.relations.filter(
    (relation: StreamingRelation) =>
      relation.head?.trim() &&
      relation.tail?.trim() &&
      relation.type?.trim() &&
      relation.headCategory?.trim() &&
      relation.tailCategory?.trim() &&
      entityNames.has(relation.head) &&
      entityNames.has(relation.tail)
  );

  const dedupeProposals = (proposals: SchemaProposal[]): SchemaProposal[] => {
    const seenNames = new Set<string>();
    return proposals.filter((proposal) => {
      const key = proposal.name?.trim().toLowerCase();
      if (!key || seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
  };
  validData.schemaProposals.categories = dedupeProposals(validData.schemaProposals.categories);
  validData.schemaProposals.relationTypes = dedupeProposals(validData.schemaProposals.relationTypes);

  return validData as StreamingExtraction;
}

export interface LinkVerdict {
  mention: string;
  category: string;
  verdict: 'link' | 'mint';
  target: string;
}

const linkVerdictsValidator = new LIVR.Validator({
  verdicts: [
    { default: [] },
    {
      listOfObjects: [
        {
          mention: [{ default: '' }, 'string'],
          category: [{ default: '' }, 'string'],
          verdict: [{ default: 'mint' }, 'string', { oneOf: ['link', 'mint'] }],
          target: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
});

export function normalizeLinkVerdicts(data: RawData): LinkVerdict[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.verdicts)) {
    for (const verdict of data.verdicts) {
      if (verdict && typeof verdict === 'object' && !['link', 'mint'].includes(verdict.verdict)) {
        verdict.verdict = 'mint'; // conservative default, per the prompt's own instruction
      }
    }
  }

  const validData = linkVerdictsValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: linkVerdictsValidator.getErrors() });
    return;
  }

  return validData.verdicts
    .filter((verdict: LinkVerdict) => verdict.mention?.trim())
    .map((verdict: LinkVerdict) => {
      if (verdict.verdict === 'link' && !verdict.target?.trim()) {
        verdict.verdict = 'mint';
      }
      return verdict;
    });
}

export interface PairRuleVerdict {
  signature: number;
  relation: string | null;
  source: string;
  target: string;
  definition: string;
}

const pairRuleVerdictsValidator = new LIVR.Validator({
  rules: [
    { default: [] },
    {
      listOfObjects: [
        {
          signature: [{ default: 0 }, 'positive_integer'],
          relation: [{ default: '' }, 'string'],
          source: [{ default: '' }, 'string'],
          target: [{ default: '' }, 'string'],
          definition: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
});

export function normalizePairRuleVerdicts(data: RawData): PairRuleVerdict[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.rules)) {
    for (const rule of data.rules) {
      if (rule && typeof rule === 'object' && (rule.relation === null || rule.relation === undefined)) {
        rule.relation = '';
      }
    }
  }

  const validData = pairRuleVerdictsValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: pairRuleVerdictsValidator.getErrors() });
    return;
  }

  return validData.rules
    .filter((rule: { signature: number }) => rule.signature > 0)
    .map((rule: PairRuleVerdict & { relation: string }) => {
      const relation = rule.relation.trim();
      const isNone = !relation || ['none', 'null'].includes(relation.toLowerCase());
      return { ...rule, relation: isNone ? null : relation };
    });
}

export interface TypeJudgeVerdict {
  proposal: string;
  kind: 'category' | 'relationType';
  verdict: 'alias' | 'new';
  target: string;
}

const typeJudgeVerdictsValidator = new LIVR.Validator({
  verdicts: [
    { default: [] },
    {
      listOfObjects: [
        {
          proposal: [{ default: '' }, 'string'],
          kind: [{ default: '' }, 'string', { oneOf: ['category', 'relationType'] }],
          verdict: [{ default: 'new' }, 'string', { oneOf: ['alias', 'new'] }],
          target: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
});

export function normalizeTypeJudgeVerdicts(data: RawData): TypeJudgeVerdict[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.verdicts)) {
    for (const verdict of data.verdicts) {
      if (verdict && typeof verdict === 'object') {
        if (!['category', 'relationType'].includes(verdict.kind)) verdict.kind = 'category';
        if (!['alias', 'new'].includes(verdict.verdict)) verdict.verdict = 'new';
      }
    }
  }

  const validData = typeJudgeVerdictsValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: typeJudgeVerdictsValidator.getErrors() });
    return;
  }

  return validData.verdicts
    .filter((verdict: TypeJudgeVerdict) => verdict.proposal?.trim())
    .map((verdict: TypeJudgeVerdict) => {
      if (verdict.verdict === 'alias' && !verdict.target?.trim()) {
        verdict.verdict = 'new';
      }
      return verdict;
    });
}

export interface PairLabelVerdict {
  pair: number;
  verdict: 'same' | 'different' | 'rung' | 'rename' | 'unsure';
  relation: string;
  direction: string;
  rationale: string;
  quote: string;
}

const PAIR_LABEL_VERDICTS = ['same', 'different', 'rung', 'rename', 'unsure'];
const RUNG_RELATIONS = ['isa', 'part-of'];
const PAIR_DIRECTIONS = ['left', 'right'];

const pairLabelVerdictsValidator = new LIVR.Validator({
  verdicts: [
    { default: [] },
    {
      listOfObjects: [
        {
          pair: [{ default: 0 }, 'positive_integer'],
          verdict: [{ default: 'unsure' }, 'string', { oneOf: PAIR_LABEL_VERDICTS }],
          relation: [{ default: '' }, 'string'],
          direction: [{ default: '' }, 'string'],
          rationale: [{ default: '' }, 'string'],
          quote: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
});

/**
 * Validate a gold-pair-label response (see prompts/gold-pair-label.md).
 *
 * The coercion posture is the house one — invalid means `unsure`, never a guess: an unknown
 * verdict, a `rung` without a legal relation+direction, or a `rename` without a direction all
 * demote to `unsure`, which routes the row to the human queue. Flat verdicts get their
 * relation/direction cleared so a model that decorates "same" with "isa" cannot smuggle
 * structure past the worksheet's own validation.
 */
export function normalizePairLabelVerdicts(data: RawData): PairLabelVerdict[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.verdicts)) {
    for (const verdict of data.verdicts) {
      if (!verdict || typeof verdict !== 'object') continue;
      // LIVR defaults apply to `undefined` only; the prompt's schema says `null` explicitly.
      if (verdict.relation === null || verdict.relation === undefined) verdict.relation = '';
      if (verdict.direction === null || verdict.direction === undefined) verdict.direction = '';
      if (verdict.rationale === null || verdict.rationale === undefined) verdict.rationale = '';
      if (verdict.quote === null || verdict.quote === undefined) verdict.quote = '';
      if (!PAIR_LABEL_VERDICTS.includes(verdict.verdict)) {
        verdict.verdict = 'unsure'; // conservative default, per the prompt's own instruction
      }
    }
  }

  const validData = pairLabelVerdictsValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: pairLabelVerdictsValidator.getErrors() });
    return;
  }

  return validData.verdicts.map((verdict: PairLabelVerdict) => {
    if (verdict.verdict === 'rung') {
      if (!RUNG_RELATIONS.includes(verdict.relation) || !PAIR_DIRECTIONS.includes(verdict.direction)) {
        return { ...verdict, verdict: 'unsure' as const, relation: '', direction: '' };
      }
      return verdict;
    }
    if (verdict.verdict === 'rename') {
      if (!PAIR_DIRECTIONS.includes(verdict.direction)) {
        return { ...verdict, verdict: 'unsure' as const, relation: '', direction: '' };
      }
      return { ...verdict, relation: 'renamed-to' };
    }
    return { ...verdict, relation: '', direction: '' };
  });
}
