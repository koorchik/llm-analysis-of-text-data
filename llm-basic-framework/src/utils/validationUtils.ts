import { jsonrepair } from 'jsonrepair'

import LIVR from 'livr';
LIVR.Validator.defaultAutoTrim(true);

/**
 * The fixed extraction category vocabulary — single source for the LIVR oneOf rule below, the
 * `Category` union, and the `CATEGORIES` env-knob validation in `bin/app.ts`.
 */
export const CATEGORY_VALUES = [
  'Organization',
  'HackerGroup',
  'Software',
  'Country',
  'Individual',
  'Domain',
  'Sector',
  'Government Body',
  'Infrastructure',
  'Device',
] as const;

/**
 * Parse the `CATEGORIES` env knob. Unset/blank means "all categories" (undefined). Unknown names
 * throw — the knob must fail at startup, not silently filter everything out mid-run.
 */
export function parseCategories(raw: string | undefined): Category[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return undefined;
  const unknown = names.filter((name) => !(CATEGORY_VALUES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `CATEGORIES: unknown category ${unknown.map((name) => JSON.stringify(name)).join(', ')} — ` +
        `valid values: ${CATEGORY_VALUES.join(', ')}`
    );
  }
  return names as Category[];
}

const validator = new LIVR.Validator({
  entities: [{ default: [[]] }, {
    listOfObjects: [{
      name: ['required', 'string'],
      category: ['required', 'string', { oneOf: [...CATEGORY_VALUES] }],
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
  /**
   * The registry surface this mention actually hit (alias or rung name), stamped beside
   * `normalizedName`. The precondition for a repair re-stamp (`StreamingRepairer`, spec §4.3, and
   * the RQ3 batch-reference harness): mentions reassign by the alias they matched, never by the
   * now-ambiguous canonical (SKEIN v2 deck, repair).
   */
  matchedVia?: string;
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

const LINK_VERDICTS = ['link', 'mint', 'defer'] as const;
const LINK_EDGE_KINDS = ['coarsens-to', 'part-of'] as const;

/**
 * One verdict of the SKEIN v2 streaming linking judge (prompts/link-judge.md, copied verbatim
 * from the wiki prompt library 2026-08-04). Optional structure beyond the verdict, on `mint`: a
 * `parentCandidate` + `edgeKind` that code turns into a granularity edge. Empty strings mean
 * "absent" throughout (the LIVR default idiom).
 */
export interface LinkVerdict {
  mention: string;
  category: string;
  verdict: 'link' | 'mint' | 'defer';
  target: string;
  parentCandidate: string;
  edgeKind: (typeof LINK_EDGE_KINDS)[number] | '';
  /** 1-line name-independent description, required on mint/defer, '' on link (prompts/link-judge.md rule 4). */
  gloss: string;
  reasoning: string;
}

const linkVerdictsValidator = new LIVR.Validator({
  verdicts: [
    { default: [] },
    {
      listOfObjects: [
        {
          mention: [{ default: '' }, 'string'],
          category: [{ default: '' }, 'string'],
          verdict: [{ default: 'mint' }, 'string', { oneOf: [...LINK_VERDICTS] }],
          target: [{ default: '' }, 'string'],
          parentCandidate: [{ default: '' }, 'string'],
          edgeKind: [{ default: '' }, 'string'],
          gloss: [{ default: '' }, 'string'],
          reasoning: [{ default: '' }, 'string'],
        },
      ],
    },
  ],
});

export function normalizeLinkVerdicts(data: RawData): LinkVerdict[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.verdicts)) {
    for (const verdict of data.verdicts) {
      if (!verdict || typeof verdict !== 'object') continue;
      if (!LINK_VERDICTS.includes(verdict.verdict)) {
        verdict.verdict = 'mint'; // conservative default, per the prompt's own instruction
      }
      // Nulls are the prompt's own "absent" spelling; LIVR strings want ''.
      for (const field of ['target', 'parentCandidate', 'edgeKind', 'gloss', 'reasoning']) {
        if (verdict[field] === null || verdict[field] === undefined) verdict[field] = '';
      }
      if (verdict.edgeKind && !LINK_EDGE_KINDS.includes(verdict.edgeKind)) {
        verdict.edgeKind = '';
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
      if (verdict.verdict !== 'link') verdict.target = '';
      // A parent without a kind defaults to the safe reading: containment, fold off.
      if (verdict.parentCandidate.trim() && !verdict.edgeKind) verdict.edgeKind = 'part-of';
      if (!verdict.parentCandidate.trim()) verdict.edgeKind = '';
      // gloss is a duplicate-finding signal for mint/defer only; a "link" resolved the mention, so
      // any gloss the model decorated it with must not leak into duplicate search downstream.
      if (verdict.verdict === 'link') verdict.gloss = '';
      return verdict;
    });
}

function tokenizeForGloss(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * True when `gloss` merely restates the mention's own name rather than carrying the
 * name-independent evidence prompts/link-judge.md rule 4 requires ("must NOT restate or
 * paraphrase the name itself"). Case- and punctuation-insensitive; a gloss whose tokens are a
 * (non-empty) subset of the mention's tokens counts as a restatement — it adds nothing a
 * duplicate-finder could use that the name itself doesn't already give it.
 */
export function glossRestatesMention(gloss: string, mention: string): boolean {
  const glossTokens = tokenizeForGloss(gloss);
  if (glossTokens.length === 0) return false;
  const mentionTokens = new Set(tokenizeForGloss(mention));
  return glossTokens.every((token) => mentionTokens.has(token));
}

// ============================================================================
// Entity-repair judge (SKEIN v2, prompts/repair-judge.md)
//
// Ψ_repair reviews suspect components and emits one of 7 ops per pair/entity. Fields are
// op-specific in the prompt (merge{from,into} · distinct{pair} · rung{finer,coarser,edgeKind} ·
// renamed{from,to} · split{alias,outOf} · move{alias,from,to} · keep{entity}), but the parsed
// shape is flat — every RepairOpVerdict carries all fields, unused ones defaulting to ''/[] — so
// downstream code can switch on `op` without per-op parsing. `renamed`'s `to` maps onto the same
// `into` field `merge` uses; `move`'s `to` keeps its own name (a component/category target, not
// a survivor canonical).
// ============================================================================

export const REPAIR_OPS = ['merge', 'distinct', 'rung', 'renamed', 'split', 'move', 'keep'] as const;

export type RepairConfidence = 'high' | 'medium' | 'low';
const REPAIR_CONFIDENCES: RepairConfidence[] = ['high', 'medium', 'low'];
const REPAIR_EDGE_KINDS = ['coarsens-to', 'part-of'];

export interface RepairOpVerdict {
  op: (typeof REPAIR_OPS)[number];
  from: string;
  into: string; // merge; renamed maps to→into
  pair: string[]; // distinct
  finer: string;
  coarser: string;
  edgeKind: 'coarsens-to' | 'part-of' | ''; // rung
  alias: string;
  outOf: string; // split
  to: string; // move
  entity: string; // keep
  confidence: RepairConfidence; // default 'low' — a missing confidence must DEMOTE
  evidence: string;
}

export interface RepairReview {
  component: number;
  ops: RepairOpVerdict[];
}

const repairOpFields = {
  op: [{ default: '' }, 'string'],
  from: [{ default: '' }, 'string'],
  into: [{ default: '' }, 'string'],
  pair: [{ default: [] }, { listOf: 'string' }],
  finer: [{ default: '' }, 'string'],
  coarser: [{ default: '' }, 'string'],
  edgeKind: [{ default: '' }, 'string'],
  alias: [{ default: '' }, 'string'],
  outOf: [{ default: '' }, 'string'],
  to: [{ default: '' }, 'string'],
  entity: [{ default: '' }, 'string'],
  confidence: [{ default: '' }, 'string'],
  evidence: [{ default: '' }, 'string'],
};

const repairReviewsValidator = new LIVR.Validator({
  reviews: [
    { default: [] },
    {
      listOfObjects: [
        {
          component: [{ default: 0 }, 'positive_integer'],
          ops: [{ default: [] }, { listOfObjects: [repairOpFields] }],
        },
      ],
    },
  ],
});

/**
 * Validate a repair-judge response (see prompts/repair-judge.md). Follows the house LIVR idiom
 * (validationUtils.ts:109-112): a pre-coercion pass maps nulls to '' and resolves enums BEFORE
 * LIVR sees them, because one bad enum inside a listOfObjects item would otherwise sink the
 * entire list, not just that item.
 *
 * The one op-level departure from that idiom: an unrecognized `op` cannot be demoted to a safe
 * default the way `verdict`/`confidence` can (there is no neutral repair op), so it is dropped
 * from its review's `ops` array — logged via console.error — while the rest of the review, and
 * every other review, survives untouched.
 */
export function normalizeRepairReviews(data: RawData): RepairReview[] | undefined {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.reviews)) {
    // A missing/invalid `component` can't be demoted to a safe default (unlike op/confidence),
    // so the whole review is dropped here — before LIVR, since one bad positive_integer would
    // otherwise sink every review in the payload (the documented listOfObjects pitfall).
    data.reviews = data.reviews.filter((review: RawData) => {
      if (!review || typeof review !== 'object') return false;
      if (typeof review.component === 'string' && /^\d+$/.test(review.component.trim())) {
        review.component = Number(review.component.trim());
      }
      return Number.isInteger(review.component) && review.component > 0;
    });

    for (const review of data.reviews) {
      if (!Array.isArray(review.ops)) {
        review.ops = [];
        continue;
      }

      review.ops = review.ops.filter((op: RawData) => {
        if (!op || typeof op !== 'object' || !REPAIR_OPS.includes(op.op)) {
          console.error({ ERROR: 'repair-judge: dropping op with unrecognized "op"', op });
          return false;
        }
        return true;
      });

      for (const op of review.ops) {
        // Nulls are the prompt's own "absent" spelling; LIVR strings want ''.
        for (const field of ['from', 'into', 'finer', 'coarser', 'edgeKind', 'alias', 'outOf', 'to', 'entity', 'evidence']) {
          if (op[field] === null || op[field] === undefined) op[field] = '';
        }
        // renamed{from,to}: the parsed shape folds `to` onto the same `into` field `merge` uses.
        if (op.op === 'renamed') {
          op.into = op.to;
          op.to = '';
        }
        if (!Array.isArray(op.pair)) {
          op.pair = [];
        } else {
          op.pair = op.pair.filter((entry: unknown) => typeof entry === 'string');
        }
        if (op.edgeKind && !REPAIR_EDGE_KINDS.includes(op.edgeKind)) {
          op.edgeKind = '';
        }
        if (!REPAIR_CONFIDENCES.includes(op.confidence)) {
          op.confidence = 'low'; // mint-over-merge asymmetry: missing/bad confidence must DEMOTE
        }
      }
    }
  }

  const validData = repairReviewsValidator.validate(data);
  if (!validData) {
    console.log({ ERROR: repairReviewsValidator.getErrors() });
    return;
  }

  return validData.reviews.filter((review: RepairReview) => review.component > 0);
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

