import type { AdjudicatedPair } from './buildTable';
import type { PairSource, PreLabelled } from './preLabel';

/**
 * TSV round-trip for the adjudication worksheet.
 *
 * **Why TSV and not the JSON.** The JSON is the canonical artifact, but 1,624 objects is not
 * something a person reviews. A TSV opens in any spreadsheet, where the reviewer can sort by rule,
 * filter to one category, scan a column of suggestions and correct the wrong ones in bulk — which
 * is the actual shape of the work. The JSON is regenerated from the reviewed TSV.
 *
 * **Tab-separated, not comma.** Entity names in this corpus contain commas, parentheses and quotes
 * (`Держспецзв'язку`, `UAC-0010 (Armageddon)`). CSV quoting would then depend on every consumer
 * agreeing about escaping, and a spreadsheet that guesses wrong silently splits a name across two
 * columns. Tabs do not occur in these names at all, so the format has no escaping problem to get
 * wrong. Any literal tab or newline in a field is replaced by a space on write.
 */

const COLUMNS = [
  'label',
  'suggested',
  'rule',
  'source',
  'category',
  'left',
  'right',
  'stratum',
  'mechanism',
  'sim',
  'canonical',
  'evidence',
] as const;

/** `label` comes first on purpose: it is the only column you edit, so it should not need scrolling. */
function clean(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

export function toTsv(pairs: PreLabelled[]): string {
  const lines = [COLUMNS.join('\t')];
  for (const pair of pairs) {
    lines.push(
      [
        // Pre-filled with the suggestion so an untouched row is already a usable verdict — except
        // for `review`, which is deliberately not a valid label and so cannot slip through.
        pair.suggested === 'review' ? '' : pair.suggested,
        pair.suggested,
        pair.rule,
        pair.source ?? 'string',
        clean(pair.category),
        clean(pair.left),
        clean(pair.right),
        pair.stratum,
        pair.mechanism,
        String(pair.sim),
        clean(pair.canonical ?? ''),
        clean(pair.evidence ?? ''),
      ].join('\t')
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface TsvParseResult {
  pairs: AdjudicatedPair[];
  /** Rows whose `label` is neither `same` nor `different` — still awaiting your verdict. */
  unlabelled: number;
  /** Rows whose `label` disagrees with the machine suggestion. Your corrections. */
  corrected: number;
}

export function fromTsv(tsv: string): TsvParseResult {
  const lines = tsv.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('worksheet is empty');

  const header = lines[0].split('\t').map((h) => h.trim());
  const indexOf = (name: string) => {
    const index = header.indexOf(name);
    // Fatal: a silently missing column would drop every verdict in it and look like unfinished work.
    if (index < 0) throw new Error(`worksheet is missing the "${name}" column`);
    return index;
  };

  const at = {
    label: indexOf('label'),
    suggested: indexOf('suggested'),
    category: indexOf('category'),
    left: indexOf('left'),
    right: indexOf('right'),
    stratum: indexOf('stratum'),
    evidence: header.indexOf('evidence'),
    // Optional, unlike the columns above: worksheets written before provenance existed must still
    // parse, and every row in one of those is string-sourced by definition.
    source: header.indexOf('source'),
  };

  const pairs: AdjudicatedPair[] = [];
  let unlabelled = 0;
  let corrected = 0;

  for (const [offset, line] of lines.slice(1).entries()) {
    const cells = line.split('\t');
    const label = (cells[at.label] ?? '').trim().toLowerCase();
    const suggested = (cells[at.suggested] ?? '').trim().toLowerCase();

    if (label !== 'same' && label !== 'different') {
      if (label !== '') {
        throw new Error(
          `worksheet line ${offset + 2}: label must be "same", "different" or empty, got "${label}"`
        );
      }
      unlabelled++;
      continue;
    }
    if (suggested !== '' && suggested !== label) corrected++;

    pairs.push({
      category: (cells[at.category] ?? '').trim(),
      left: (cells[at.left] ?? '').trim(),
      right: (cells[at.right] ?? '').trim(),
      label,
      stratum: (cells[at.stratum] ?? 'a').trim(),
      evidence: at.evidence >= 0 ? (cells[at.evidence] ?? '').trim() : undefined,
      source: at.source >= 0 ? ((cells[at.source] ?? '').trim() as PairSource) || 'string' : 'string',
    });
  }

  return { pairs, unlabelled, corrected };
}
