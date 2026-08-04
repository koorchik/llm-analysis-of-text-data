import {
  extractAndParseJson,
  normalizePairLabelVerdicts,
} from '../utils/validationUtils';
import type { WorksheetRow } from './worksheet';
import crypto from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Two-model ensemble silver labelling for the adjudication worksheet.
 *
 * Each model labels every selected pair independently (batched, with document context); the
 * verdicts land in per-model worksheet columns, and only *agreement* becomes a prefilled silver
 * label. The design premise, per GOLD-TABLE.md §7: the ensemble is triage, the human verdict is
 * the label. Both ensemble families are systems under test elsewhere in this framework, so
 * nothing a model says here is ever final — but disagreement between two frontier models is the
 * best available ranking of where human attention pays.
 *
 * Failure posture mirrors `StreamingNormalizer`: a batch whose response cannot be parsed or whose
 * verdict count mismatches is marked `unsure` wholesale — routed to the human — never silently
 * dropped and never misaligned.
 */

export interface PairAnnotation {
  verdict: 'same' | 'different' | 'rung' | 'rename' | 'unsure';
  relation: string;
  direction: string;
  rationale: string;
  quote: string;
}

/** The narrow slice of LlmClient this module needs — tests inject a canned one. */
export interface AnnotationClient {
  send(
    instructions: string,
    text: string,
    options?: { operator?: string; docId?: number | null }
  ): Promise<{ text: string }>;
}

export interface AnnotationCache {
  get(key: string): PairAnnotation | undefined;
  put(key: string, value: PairAnnotation): void;
}

const fold = (value: string) => value.trim().toLowerCase();

/** One row's identity across every map in this module. */
export function rowKey(row: { category: string; left: string; right: string }): string {
  return `${fold(row.category)}|${fold(row.left)}|${fold(row.right)}`;
}

/**
 * Cache key for one (prompt, pair) question. Keyed on the prompt hash so a prompt edit
 * invalidates every cached verdict by construction — the same philosophy as PromptProvider's
 * hashes: prompt text is an experimental variable, and answers to an old prompt are not answers
 * to the new one.
 */
export function annotationKey(promptSha: string, row: { category: string; left: string; right: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify([promptSha, rowKey(row)]), 'utf8').digest('hex');
}

/**
 * Append-only JSONL cache, one line per (prompt, pair) verdict — the run's audit trail as well
 * as its resume point. Committed to git deliberately: under a backend with no sampling lever
 * (Anthropic), reproducibility is by artifact, not by seed.
 */
export class JsonlAnnotationCache implements AnnotationCache {
  readonly filePath: string;
  #entries = new Map<string, PairAnnotation>();

  constructor(filePath: string) {
    this.filePath = filePath;
    if (!existsSync(filePath)) return;
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { k: string } & PairAnnotation;
      const { k, verdict, relation, direction, rationale, quote } = parsed;
      this.#entries.set(k, { verdict, relation, direction, rationale, quote });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): PairAnnotation | undefined {
    return this.#entries.get(key);
  }

  put(key: string, value: PairAnnotation): void {
    this.#entries.set(key, value);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify({ k: key, ...value, ts: new Date().toISOString() })}\n`, 'utf8');
  }
}

interface AnnotateOptions {
  client: AnnotationClient;
  /** The rendered gold-pair-label prompt. */
  instructions: string;
  /** Its sha256 — the cache-invalidation handle. */
  promptSha: string;
  cache?: AnnotationCache;
  /** Pairs per call. 20 keeps misalignment rare and a failed call cheap. */
  batchSize?: number;
  /** Document context per (category, surface); empty array when the corpus never spells it. */
  context?: (category: string, surface: string) => string[];
  /** Batches in flight at once. Default 1 (sequential); batches are independent, so raising this
   * is bounded only by the provider's rate limits. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const UNSURE: PairAnnotation = { verdict: 'unsure', relation: '', direction: '', rationale: '', quote: '' };

/** Annotate the given rows with ONE model. Call once per ensemble member. */
export async function annotatePairs(
  rows: WorksheetRow[],
  options: AnnotateOptions
): Promise<Map<string, PairAnnotation>> {
  const batchSize = options.batchSize ?? 20;
  const result = new Map<string, PairAnnotation>();

  const uncached: WorksheetRow[] = [];
  for (const row of rows) {
    const cached = options.cache?.get(annotationKey(options.promptSha, row));
    if (cached) result.set(rowKey(row), cached);
    else uncached.push(row);
  }

  // Group by category: one domain per call mirrors the link-judge's per-document batching and
  // keeps the model from blending, say, Software version conventions into HackerGroup designators.
  const byCategory = new Map<string, WorksheetRow[]>();
  for (const row of uncached) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }

  let done = result.size;
  const total = rows.length;

  const runBatch = async (batch: WorksheetRow[], mayHalve: boolean): Promise<void> => {
    let annotations: PairAnnotation[] | null = null;
    try {
      const response = await options.client.send(options.instructions, batchText(batch, options.context), {
        operator: 'gold-pair-label',
        docId: null,
      });
      annotations = alignVerdicts(response.text, batch.length);
    } catch (error) {
      if (mayHalve && batch.length > 1) {
        // One retry at half size, then give the remainder to the human. More persistence than
        // that trades annotator time for API stubbornness at the wrong rate.
        console.error(`gold-pair-label: batch of ${batch.length} failed (${error}), halving`);
        const middle = Math.ceil(batch.length / 2);
        await runBatch(batch.slice(0, middle), false);
        await runBatch(batch.slice(middle), false);
        return;
      }
      console.error(`gold-pair-label: batch of ${batch.length} failed (${error}), marking unsure`);
    }

    batch.forEach((row, index) => {
      const annotation = annotations?.[index] ?? UNSURE;
      result.set(rowKey(row), annotation);
      options.cache?.put(annotationKey(options.promptSha, row), annotation);
    });
    done += batch.length;
    options.onProgress?.(done, total);
  };

  // Flatten to a batch list and drain it with a small worker pool. Batches are independent —
  // each writes its own rows into the map and appends its own cache lines — so the only ordering
  // that matters is within a batch, which runBatch preserves.
  const batches: WorksheetRow[][] = [];
  for (const list of byCategory.values()) {
    for (let start = 0; start < list.length; start += batchSize) {
      batches.push(list.slice(start, start + batchSize));
    }
  }

  const concurrency = Math.max(1, options.concurrency ?? 1);
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (true) {
        const index = nextBatch++;
        if (index >= batches.length) return;
        await runBatch(batches[index], true);
      }
    })
  );

  return result;
}

function batchText(batch: WorksheetRow[], context?: (category: string, surface: string) => string[]): string {
  const lines = [`Category: ${batch[0].category}`, 'Pairs:'];
  for (const [index, row] of batch.entries()) {
    lines.push(`${index + 1}. "${row.left}" vs "${row.right}"`);
    for (const side of ['left', 'right'] as const) {
      const snippets = context?.(row.category, row[side]) ?? [];
      if (snippets.length > 0) lines.push(`   ${side} context: ${snippets.join(' ')}`);
    }
  }
  return lines.join('\n');
}

/** Parse one response and align it to the batch, or return null when that is impossible. */
function alignVerdicts(text: string, expected: number): PairAnnotation[] | null {
  const verdicts = normalizePairLabelVerdicts(extractAndParseJson(text) || {});
  if (!verdicts || verdicts.length !== expected) {
    // The contract is one verdict per pair, in order, with the index echoed. A count mismatch
    // cannot be repaired without guessing which pair the model skipped — see StreamingNormalizer's
    // identical posture on decisions.
    console.error(`gold-pair-label: expected ${expected} verdicts, got ${verdicts?.length ?? 'none'}`);
    return null;
  }
  // The echoed index catches a model answering out of order; trust it when consistent.
  const byIndex = new Map(verdicts.map((verdict) => [verdict.pair, verdict]));
  const aligned = byIndex.size === expected ? Array.from({ length: expected }, (_, i) => byIndex.get(i + 1)) : verdicts;
  if (aligned.some((verdict) => verdict === undefined)) return verdicts;
  return (aligned as PairAnnotation[]).map(({ verdict, relation, direction, rationale, quote }) => ({
    verdict,
    relation,
    direction,
    rationale,
    quote,
  }));
}

// --- row selection ------------------------------------------------------------------------------

interface SelectOptions {
  /** Rules whose rows are rule-labelled in bulk rather than LLM-annotated. */
  skipRules?: string[];
  /** Seeded sample size drawn from the skipped rules — the rule-error estimate. */
  spotCheck?: number;
  seed?: number;
}

/**
 * Stable [0,1) from a seed and a string — FNV-1a with the seed folded in, murmur3-finalized.
 * Same construction as `assignSplit`'s hash; seeded so different spot-check draws are possible
 * while any one draw is reproducible.
 */
function seededFraction(seed: number, value: string): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

/**
 * Which rows go to the ensemble.
 *
 * Everything except the skip-rule bulk (`differing-digits`: 1,700+ rows whose rationale is
 * structural — digits are identity in this corpus) — plus a seeded spot-check sample of that
 * bulk, so the rule's error rate is *measured*, not assumed: 60 rows at zero observed errors
 * bounds it at ≲5% by the rule of three. Rule-confident `same` rows ARE sent — a wrong `same`
 * bulk-accepted into transitive closure is the expensive failure mode, and there are only ~24.
 * Rows the human already labelled are never re-asked.
 */
export function selectForAnnotation(
  rows: WorksheetRow[],
  options: SelectOptions = {}
): { selected: WorksheetRow[]; spotCheckKeys: Set<string> } {
  const skipRules = new Set(options.skipRules ?? ['differing-digits']);
  const spotCheck = options.spotCheck ?? 60;
  const seed = options.seed ?? 42;

  const selected: WorksheetRow[] = [];
  const skipped: WorksheetRow[] = [];
  for (const row of rows) {
    // Whose label is it? `gold pairs` PRE-FILLS the label with the rule suggestion, and a prior
    // annotate run prefills the agreed ensemble verdict. Both are machine labels — re-annotatable,
    // the second for free via the cache. Only a label that deviates from both is a human verdict,
    // and a human verdict is final — the same ownership rule applyEnsemble applies.
    const rulePrefill = row.suggested !== 'review' && row.label === row.suggested;
    const ensemblePrefill =
      row.ensemble !== undefined && row.label !== '' && row.label === row.ensemble.split(':')[0];
    if (row.label !== '' && !rulePrefill && !ensemblePrefill) continue;
    (skipRules.has(row.rule) && !ensemblePrefill ? skipped : selected).push(row);
  }

  const sample = [...skipped]
    .sort((a, b) => seededFraction(seed, rowKey(a)) - seededFraction(seed, rowKey(b)))
    .slice(0, spotCheck);
  const spotCheckKeys = new Set(sample.map((row) => rowKey(row)));

  return { selected: [...selected, ...sample], spotCheckKeys };
}

// --- ensemble assembly --------------------------------------------------------------------------

/** The compact `verdict[:relation:direction]` spelling the worksheet's model columns use. */
export function compactVerdict(annotation: PairAnnotation): string {
  return [annotation.verdict, annotation.relation, annotation.direction].filter(Boolean).join(':');
}

const POSITIVE = new Set(['same', 'rung', 'rename']);

export interface EnsembleSummary {
  agree: number;
  /** Of `agree`: rows where every voter concurred with none unsure. */
  unanimous: number;
  disagree: number;
  unsure: number;
  ruleOnly: number;
  /** Rows whose label the human set — untouchable, sunk to the done tier. */
  human: number;
  prefilled: number;
  spotCheckContradictions: number;
  /** Agreed ensemble verdicts that contradicted a rule-prefilled label outside the spot-check. */
  ruleContradictions: number;
}

/** The ensemble's votes, one map per model. `gemini` optional — two voters keep the old semantics. */
export interface EnsembleVotes {
  claude?: Map<string, PairAnnotation>;
  gpt?: Map<string, PairAnnotation>;
  gemini?: Map<string, PairAnnotation>;
}

/**
 * Fold the models' annotations into the worksheet: per-model vote columns, agreement, the
 * prefilled silver label where a majority exists, and the review-queue tier the file is sorted by.
 *
 * **Majority voting.** A verdict needs ≥2 identical `(verdict, relation, direction)` votes. With
 * two voters that is unanimity (`agree`, the original semantics); with three, a 2-of-3 majority
 * (`majority`) also prefills — the dissenting vote stays visible in its column — and full
 * concurrence is `unanimous`. Fewer than two concurring non-unsure votes is `disagree` when two
 * voters actively conflict, `unsure` when the votes are mostly abstentions.
 *
 * Queue tiers: 1 disagreement (highest information — including rows that contradict a rule) ·
 * 2 unsure · 3 majority/unanimous positive (the human confirms every positive; a wrong `same`
 * corrupts a cluster through closure) · 4 majority `different` (skim) · 5 done: rule bulk, human
 * verdicts, and — with three voters — unanimous `different`, which three independent models is
 * enough certainty for.
 *
 * **Label ownership.** A rule prefill (`label === suggested`) and a previous ensemble prefill
 * (`label` matches the recorded `ensemble`) are machine labels — re-derived freely. Anything else
 * a non-empty label could be is the human's: preserved verbatim, row sunk to tier 5 as `human`.
 */
export function applyEnsemble(
  rows: WorksheetRow[],
  votes: EnsembleVotes,
  spotCheckKeys: Set<string> = new Set()
): { rows: WorksheetRow[]; summary: EnsembleSummary } {
  const summary: EnsembleSummary = {
    agree: 0,
    unanimous: 0,
    disagree: 0,
    unsure: 0,
    ruleOnly: 0,
    human: 0,
    prefilled: 0,
    spotCheckContradictions: 0,
    ruleContradictions: 0,
  };

  const voters = (['claude', 'gpt', 'gemini'] as const).filter((name) => votes[name] !== undefined);

  const out = rows.map((row) => {
    const key = rowKey(row);

    const rulePrefill = row.suggested !== 'review' && row.label === row.suggested;
    const ensemblePrefill =
      row.label !== '' && row.ensemble !== undefined && row.label === row.ensemble.split(':')[0];
    const humanLabel = row.label !== '' && !rulePrefill && !ensemblePrefill;

    if (humanLabel) {
      // Final. Not re-judged, not re-sorted into a review tier — done.
      summary.human++;
      return { ...row, agreement: 'human', queue: 5 };
    }

    const cast = voters
      .map((name) => ({ name, vote: votes[name]!.get(key) }))
      .filter((entry): entry is { name: (typeof voters)[number]; vote: PairAnnotation } => entry.vote !== undefined);

    if (cast.length === 0) {
      // A --limit run annotates a slice; anything already carrying ensemble columns from an
      // earlier run keeps them verbatim rather than being stamped back to rule-only.
      if (row.agreement !== undefined && row.agreement !== '') return { ...row };
      summary.ruleOnly++;
      return { ...row, agreement: 'rule-only', queue: 5 };
    }

    const next: WorksheetRow = {
      ...row,
      claudeVerdict: votes.claude?.get(key) ? compactVerdict(votes.claude.get(key)!) : row.claudeVerdict,
      gptVerdict: votes.gpt?.get(key) ? compactVerdict(votes.gpt.get(key)!) : row.gptVerdict,
      geminiVerdict: votes.gemini?.get(key) ? compactVerdict(votes.gemini.get(key)!) : row.geminiVerdict,
    };

    // Tally non-unsure votes by compact verdict. A voter whose map lacks the row (errored even
    // after halving) is an abstention, exactly like an explicit unsure.
    const groups = new Map<string, PairAnnotation[]>();
    for (const { vote } of cast) {
      if (vote.verdict === 'unsure') continue;
      const compact = compactVerdict(vote);
      groups.set(compact, [...(groups.get(compact) ?? []), vote]);
    }
    const top = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];

    if (top.length < 2) {
      // No majority. Two actively conflicting verdicts are a disagreement; otherwise it is
      // abstention-dominated and lands as unsure. A machine prefill loses its support either way.
      const label = rulePrefill && !spotCheckKeys.has(key) ? row.label : '';
      if (groups.size >= 2) {
        summary.disagree++;
        return { ...next, ensemble: undefined, agreement: 'disagree', label, queue: 1 };
      }
      summary.unsure++;
      return { ...next, ensemble: undefined, agreement: 'unsure', label, queue: 2 };
    }

    // Majority. Prefer a vote that carries a quote, then one with a rationale, as the row's face.
    const agreed = top.find((vote) => vote.quote) ?? top.find((vote) => vote.rationale) ?? top[0];
    const ensemble = compactVerdict(agreed);
    const isUnanimous = top.length === voters.length;
    summary.agree++;
    if (isUnanimous) summary.unanimous++;
    const agreement = voters.length === 2 ? 'agree' : isUnanimous ? 'unanimous' : 'majority';

    if (spotCheckKeys.has(key)) {
      // The sample exists to test the rule. Confirmation stays bulk; contradiction goes first.
      const confirms = row.label !== '' && agreed.verdict === row.label;
      if (!confirms) {
        summary.spotCheckContradictions++;
        return { ...next, ensemble, agreement, label: '', queue: 1 };
      }
      return { ...next, ensemble, agreement, queue: 5 };
    }

    // A rule-prefilled label the majority contradicts is the registry-conflict situation again —
    // two mechanisms disagreeing — and must surface at the top, not sink into a bulk tier
    // wearing the rule's label.
    if (rulePrefill && agreed.verdict !== row.label) {
      summary.ruleContradictions++;
      return { ...next, ensemble, agreement, label: '', queue: 1 };
    }

    const prefill = row.label === '' || ensemblePrefill;
    if (prefill) summary.prefilled++;
    const rationale = agreed.rationale || top.map((vote) => vote.rationale).find(Boolean) || '';
    const quote = agreed.quote || top.map((vote) => vote.quote).find(Boolean) || '';
    return {
      ...next,
      ensemble,
      agreement,
      label: prefill ? agreed.verdict : row.label,
      relation: prefill ? agreed.relation || undefined : row.relation,
      direction: prefill ? agreed.direction || undefined : row.direction,
      llmRationale: rationale || row.llmRationale,
      // Born evidence-bearing: a majority positive grounded in a quoted snippet fills the evidence
      // column (annotator kind `llm` in the eventual table); `different` needs no evidence.
      evidence:
        prefill && POSITIVE.has(agreed.verdict) && quote && !row.evidence ? quote : row.evidence,
      // With three voters, unanimous `different` needs no human at all; everything else keeps the
      // confirm/skim split.
      queue: POSITIVE.has(agreed.verdict) ? 3 : isUnanimous && voters.length >= 3 ? 5 : 4,
    };
  });

  out.sort(
    (a, b) =>
      (a.queue ?? 5) - (b.queue ?? 5) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
      b.sim - a.sim ||
      (a.left < b.left ? -1 : a.left > b.left ? 1 : 0) ||
      (a.right < b.right ? -1 : a.right > b.right ? 1 : 0)
  );

  return { rows: out, summary };
}
