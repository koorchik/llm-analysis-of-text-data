import fs from 'fs/promises';
import path from 'path';

/**
 * Document-evidence snippets for the adjudication worksheet.
 *
 * Under a single-annotator protocol, evidence snippets are what carries validity instead of
 * inter-annotator agreement (GOLD-TABLE.md §7): every non-obvious silver label should point at
 * checkable document context. This module extracts that context mechanically — find where a
 * surface actually occurs in the fetched corpus and cut a window around it — so both the LLM
 * annotators and the human reviewer look at the same passage.
 *
 * A surface that never literally appears (extraction sometimes normalizes spellings) yields no
 * snippet, deliberately: inventing context would defeat the point. Callers report the miss count.
 */

export interface CorpusDoc {
  title: string;
  description: string;
  text: string;
}

/**
 * Strip HTML down to comparable text: tags out, common entities decoded, whitespace collapsed.
 *
 * A regex, not a parser, on purpose — the fetched `description`/`text` fields are simple editor
 * HTML (`<p>`, `<a>`, `&nbsp;`), and the output only needs to be searchable and readable, never
 * rendered.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Load the fetched CERT-UA corpus: one JSON per document, keyed by its numeric id. */
export async function loadCorpus(dir: string): Promise<Map<number, CorpusDoc>> {
  const corpus = new Map<number, CorpusDoc>();
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith('.json')) continue;
    const raw = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as {
      id?: number;
      title?: string;
      description?: string;
      text?: string;
    };
    if (typeof raw.id !== 'number') continue;
    corpus.set(raw.id, {
      title: raw.title ?? '',
      description: raw.description ?? '',
      text: raw.text ?? '',
    });
  }
  return corpus;
}

/**
 * Cut a window around the first case-insensitive occurrence of `surface` in `haystack`.
 * Returns null when the surface does not occur.
 */
function windowAround(haystack: string, surface: string, window: number): string | null {
  const index = haystack.toLowerCase().indexOf(surface.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - window);
  const end = Math.min(haystack.length, index + surface.length + window);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < haystack.length ? '…' : '';
  return `${prefix}${haystack.slice(start, end).trim()}${suffix}`;
}

/**
 * Extract up to `maxDocs` snippets for a surface from the documents it was inventoried in.
 *
 * Fields are searched title → description → text: the title names what the document is about,
 * so when a surface appears there the most informative context is the headline, not a sentence
 * fragment from the body.
 */
export function snippetsFor(
  surface: string,
  docIds: number[],
  corpus: Map<number, CorpusDoc>,
  options: { window?: number; maxDocs?: number } = {}
): string[] {
  const window = options.window ?? 120;
  const maxDocs = options.maxDocs ?? 2;

  const snippets: string[] = [];
  for (const docId of docIds) {
    if (snippets.length >= maxDocs) break;
    const doc = corpus.get(docId);
    if (!doc) continue;
    for (const field of [doc.title, doc.description, doc.text]) {
      const snippet = windowAround(stripHtml(field), surface, window);
      if (snippet !== null) {
        snippets.push(`[doc ${docId}] ${snippet}`);
        break;
      }
    }
  }
  return snippets;
}
