import type { Analyzer } from '../types';
import { transliterations, hasCyrillic } from './transliterate';

/**
 * Acronym / initialism keys.
 *
 * **An alias class neither edit distance nor name embeddings catch.** `СБУ` and
 * `Служба безпеки України` share almost no characters and no tokens, so every string metric scores
 * them near zero; a name embedding does little better, because the acronym carries no semantics. The
 * note rates this ★★★ with **no measured coverage** anywhere, and asks for it to get its own
 * micro-stratum in E0 precisely because it is invisible to everything else.
 *
 * Two directions, so a match can happen whichever form the query takes:
 *
 * - a multi-word phrase yields its initialism (`Security Service of Ukraine` → `ssu`, and with
 *   stopwords dropped → `ssu`);
 * - an all-caps short token is emitted as-is, so it can meet a phrase's initialism.
 *
 * Cyrillic phrases additionally yield the initialism of each transliteration, since `СБУ` may appear
 * romanized as `SBU` while the expansion appears in English.
 */

/**
 * Words skipped when forming an initialism. English function words plus the Ukrainian/Russian
 * prepositions that appear in agency names — `Служба безпеки України` has no article, but
 * `Міністерство внутрішніх справ України` does contain `справ`-type connectives in other names.
 */
const STOPWORDS = new Set([
  'of', 'the', 'and', 'for', 'in', 'on', 'at', 'to', 'a', 'an',
  'та', 'і', 'й', 'з', 'із', 'по', 'на', 'у', 'в', 'до', 'при',
]);

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Initialism of a phrase; `skipStopwords` decides whether function words contribute a letter. */
export function initialism(value: string, skipStopwords: boolean): string {
  const parts = words(value).filter(
    (word) => !(skipStopwords && STOPWORDS.has(word.toLowerCase()))
  );
  if (parts.length < 2) return '';
  return parts.map((word) => word[0]).join('').toLowerCase();
}

/** True for a short all-caps token — i.e. something that already looks like an acronym. */
export function looksLikeAcronym(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 8) return false;
  if (words(trimmed).length !== 1) return false;
  // No lowercase letters, and at least two letters overall.
  return trimmed === trimmed.toUpperCase() && (trimmed.match(/\p{L}/gu)?.length ?? 0) >= 2;
}

export const acronymAnalyzer: Analyzer = {
  id: 'acronym',
  keys(value: string): string[] {
    const keys = new Set<string>();

    if (looksLikeAcronym(value)) {
      keys.add(value.trim().toLowerCase());
      // A Cyrillic acronym romanizes to what an English report would print.
      if (hasCyrillic(value)) {
        keys.add(transliterations.kmu(value).trim().toLowerCase());
        keys.add(transliterations.bgn(value).trim().toLowerCase());
      }
    } else {
      // Both stopword policies, because "Security Service of Ukraine" is cited as both SSU and SSOU.
      for (const skipStopwords of [true, false]) {
        const acronym = initialism(value, skipStopwords);
        if (acronym.length >= 2) keys.add(acronym);
      }
      if (hasCyrillic(value)) {
        for (const romanize of [transliterations.kmu, transliterations.bgn]) {
          for (const skipStopwords of [true, false]) {
            const acronym = initialism(romanize(value), skipStopwords);
            if (acronym.length >= 2) keys.add(acronym);
          }
        }
      }
    }

    keys.delete('');
    return [...keys];
  },
};
