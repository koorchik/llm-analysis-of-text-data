import type { AdjudicatedPair, PairDirection, PairRelation } from './buildTable';
import { joinSources, sourceSet, type PairSource, type Suggestion } from './preLabel';

/**
 * TSV round-trip for the adjudication worksheet.
 *
 * **Why TSV and not the JSON.** The JSON is the canonical artifact, but ~2,000 objects is not
 * something a person reviews. A TSV opens in any spreadsheet, where the reviewer can sort by rule,
 * filter to one category, scan a column of suggestions and correct the wrong ones in bulk — which
 * is the actual shape of the work. The JSON is regenerated from the reviewed TSV.
 *
 * **Tab-separated, not comma.** Entity names in this corpus contain commas, parentheses and quotes
 * (`Держспецзв'язку`, `UAC-0010 (Armageddon)`). CSV quoting would then depend on every consumer
 * agreeing about escaping, and a spreadsheet that guesses wrong silently splits a name across two
 * columns. Tabs do not occur in these names at all, so the format has no escaping problem to get
 * wrong. Any literal tab or newline in a field is replaced by a space on write.
 *
 * **v2 (gold-by-projection amendment).** The worksheet carries the four-verdict vocabulary
 * (`same` | `different` | `rung` | `rename`, with `relation` + `direction` disambiguating the
 * non-flat ones) and the ensemble-annotation columns: per-model votes, agreement, the review
 * `queue` tier, auto-extracted document `snippet`s, and the models' `llmRationale`. v1 worksheets
 * (12 columns) still parse — every new column is resolved by header name and simply absent.
 */

const COLUMNS = [
  // The review surface: `queue` orders the file, `label` is the one column the human edits, and
  // `relation`/`direction` complete a `rung` or `rename` verdict. Kept leftmost so no scrolling.
  'queue',
  'label',
  'relation',
  'direction',
  // What the machines thought: rule suggestion, ensemble outcome, and the per-model votes that
  // are the row's provenance (they survive into the v2 table's edges).
  'suggested',
  'ensemble',
  'agreement',
  'claudeVerdict',
  'gptVerdict',
  'geminiVerdict',
  'rule',
  'source',
  // The pair itself and its context.
  'category',
  'left',
  'right',
  'stratum',
  'mechanism',
  'sim',
  'canonical',
  'snippet',
  'llmRationale',
  'evidence',
] as const;

type Column = (typeof COLUMNS)[number];

/** A full-fidelity worksheet row: everything `toTsv` writes and `readRows` preserves. */
export interface WorksheetRow {
  /** Review tier 1–5; the file is pre-sorted by it. Absent before `llm-annotate` runs. */
  queue?: number;
  /** The human verdict: '', 'same', 'different', 'rung' or 'rename'. */
  label: string;
  relation?: string;
  direction?: string;
  suggested: Suggestion;
  /** The agreed ensemble verdict in compact form, when the models agreed. */
  ensemble?: string;
  /** 'agree' | 'disagree' | 'unsure' | 'rule-only'. */
  agreement?: string;
  claudeVerdict?: string;
  gptVerdict?: string;
  geminiVerdict?: string;
  rule: string;
  source?: PairSource;
  category: string;
  left: string;
  right: string;
  stratum: string;
  mechanism: string;
  sim: number;
  canonical?: string;
  /** Auto-extracted document context (`left: … ‖ right: …`). Context for review. */
  snippet?: string;
  /** The agreeing model's short rationale. Context for review, never evidence. */
  llmRationale?: string;
  /** The evidence column `buildTable` carries into the table — human- or LLM-quoted. */
  evidence?: string;
}

/** Replace characters that would break the row/column structure. */
function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

function cellOf(row: WorksheetRow, column: Column): string {
  switch (column) {
    case 'queue':
      return row.queue === undefined ? '' : String(row.queue);
    case 'label':
      // Verbatim — the suggestion prefill happens once, in preLabel(), at proposal time. A write
      // that re-derived the label from `suggested` would silently restore labels the ensemble
      // deliberately cleared back to the review queue.
      return clean(row.label);
    case 'sim':
      return String(row.sim);
    case 'suggested':
      return row.suggested;
    default: {
      const value = row[column];
      return value === undefined ? '' : clean(String(value));
    }
  }
}

export function toTsv(rows: WorksheetRow[]): string {
  const lines = [COLUMNS.join('\t')];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => cellOf(row, column)).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse every row with full fidelity — including unlabelled ones.
 *
 * This is what `llm-annotate` reads and rewrites: it must not lose rows the human has not touched
 * yet, so it cannot go through `fromTsv`, which by design keeps only adjudicated verdicts.
 */
export function readRows(tsv: string): WorksheetRow[] {
  const lines = tsv.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('worksheet is empty');

  const header = lines[0].split('\t').map((h) => h.trim());
  const at = new Map<string, number>();
  for (const [index, name] of header.entries()) at.set(name, index);

  const required = ['label', 'suggested', 'category', 'left', 'right', 'stratum'];
  for (const name of required) {
    // Fatal: a silently missing column would drop every verdict in it and look like unfinished work.
    if (!at.has(name)) throw new Error(`worksheet is missing the "${name}" column`);
  }

  // Heal spreadsheet CSV-quoting on read: an editor that wraps a quote-bearing cell in outer
  // quotes and doubles the inner ones ("campaign ""X""") leaves exactly that shape — outer quotes
  // with every interior quote doubled. Unwrapping here means the damage never survives a
  // round-trip. A naturally quote-bearing cell is not CSV-shaped and passes through untouched.
  const unwrapCsvQuoting = (value: string): string => {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
    const inner = value.slice(1, -1);
    if (inner.replace(/""/g, '').includes('"')) return value; // a lone interior quote: not CSV
    return inner.replace(/""/g, '"');
  };

  const cell = (cells: string[], name: string): string => {
    const index = at.get(name);
    return index === undefined ? '' : unwrapCsvQuoting((cells[index] ?? '').trim());
  };

  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const optional = (name: string): string | undefined => {
      if (!at.has(name)) return undefined;
      const value = cell(cells, name);
      return value === '' ? undefined : value;
    };
    const queueRaw = optional('queue');
    return {
      queue: queueRaw === undefined ? undefined : Number(queueRaw),
      label: cell(cells, 'label'),
      relation: optional('relation'),
      direction: optional('direction'),
      suggested: (cell(cells, 'suggested') || 'review') as Suggestion,
      ensemble: optional('ensemble'),
      agreement: optional('agreement'),
      claudeVerdict: optional('claudeVerdict'),
      gptVerdict: optional('gptVerdict'),
      geminiVerdict: optional('geminiVerdict'),
      rule: cell(cells, 'rule') || 'none',
      source: optional('source'),
      category: cell(cells, 'category'),
      left: cell(cells, 'left'),
      right: cell(cells, 'right'),
      stratum: cell(cells, 'stratum') || 'a',
      mechanism: cell(cells, 'mechanism'),
      sim: Number(cell(cells, 'sim') || '0'),
      canonical: optional('canonical'),
      snippet: optional('snippet'),
      llmRationale: optional('llmRationale'),
      evidence: optional('evidence'),
    };
  });
}

export interface TsvParseResult {
  pairs: AdjudicatedPair[];
  /** Rows whose `label` holds no final verdict — still awaiting adjudication. */
  unlabelled: number;
  /** Rows whose `label` disagrees with the ensemble verdict (or, absent one, the rule suggestion). */
  corrected: number;
}

const FINAL_LABELS = new Set(['same', 'different', 'rung', 'rename']);
const RUNG_RELATIONS = new Set(['isa', 'part-of']);
const DIRECTIONS = new Set(['left', 'right']);

/** The human label in the compact `verdict[:relation:direction]` form the ensemble columns use. */
function compact(label: string, relation?: string, direction?: string): string {
  return [label, relation, direction].filter(Boolean).join(':');
}

export function fromTsv(tsv: string): TsvParseResult {
  const rows = readRows(tsv);

  const pairs: AdjudicatedPair[] = [];
  let unlabelled = 0;
  let corrected = 0;

  for (const [index, row] of rows.entries()) {
    const line = index + 2; // 1-based, after the header
    const label = row.label.trim().toLowerCase();

    if (!FINAL_LABELS.has(label)) {
      if (label !== '') {
        throw new Error(
          `worksheet line ${line}: label must be "same", "different", "rung", "rename" or empty, got "${label}"`
        );
      }
      unlabelled++;
      continue;
    }

    let relation = (row.relation ?? '').trim().toLowerCase();
    let direction = (row.direction ?? '').trim().toLowerCase();
    if (label === 'rung') {
      if (!RUNG_RELATIONS.has(relation)) {
        throw new Error(
          `worksheet line ${line}: a "rung" label requires relation "isa" or "part-of", got "${relation}"`
        );
      }
      if (!DIRECTIONS.has(direction)) {
        throw new Error(
          `worksheet line ${line}: a "rung" label requires direction "left" or "right" (the finer side), got "${direction}"`
        );
      }
    } else if (label === 'rename') {
      // The relation is implied — written out for the reader, defaulted for the writer.
      if (relation === '') relation = 'renamed-to';
      if (relation !== 'renamed-to') {
        throw new Error(
          `worksheet line ${line}: a "rename" label's relation can only be "renamed-to", got "${relation}"`
        );
      }
      if (!DIRECTIONS.has(direction)) {
        throw new Error(
          `worksheet line ${line}: a "rename" label requires direction "left" or "right" (the older designation), got "${direction}"`
        );
      }
    } else {
      relation = '';
      direction = '';
    }

    const reference = row.ensemble ?? (row.suggested === 'review' ? '' : row.suggested);
    if (reference !== '' && reference !== compact(label, relation || undefined, direction || undefined)) {
      corrected++;
    }

    pairs.push({
      category: row.category,
      left: row.left,
      right: row.right,
      label: label as AdjudicatedPair['label'],
      relation: (relation || undefined) as PairRelation | undefined,
      direction: (direction || undefined) as PairDirection | undefined,
      stratum: row.stratum,
      evidence: row.evidence,
      // Normalized to the canonical `+`-joined spelling, so the legacy `both` disappears on read.
      source: joinSources(sourceSet(row.source)),
      // Edge provenance: which rule claimed the row and how each ensemble member voted.
      rule: row.rule === 'none' ? undefined : row.rule,
      claudeVerdict: row.claudeVerdict,
      gptVerdict: row.gptVerdict,
      geminiVerdict: row.geminiVerdict,
    });
  }

  return { pairs, unlabelled, corrected };
}
