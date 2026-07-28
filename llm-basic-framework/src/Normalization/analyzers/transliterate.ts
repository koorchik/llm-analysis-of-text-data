import type { Analyzer } from '../types';

/**
 * Cyrillic → Latin transliteration, one key per scheme.
 *
 * **Half of the stratum-(b) mechanism.** The research note marks transliteration-normalized matching
 * as having *no* coverage in the entity-resolution literature it audits ("no EM primary faces
 * transliteration, OCR noise, or emergent categories") and rates it ★★★. `Служба безпеки України`
 * and `Sluzhba bezpeky Ukrainy` share no characters at all, so every string metric scores them near
 * zero; they can only meet if one is transliterated.
 *
 * **`АРТ28` vs `APT28` is NOT this channel**, despite the research note using it as the stratum-(b)
 * example. Measured: Cyrillic `Р` is ER, so it transliterates to `r` and this analyzer yields
 * `art28` — which does not match `apt28`. That pair is a *homoglyph spoof*, handled by
 * `confusableSkeleton` (Cyrillic `р` → Latin `p`). Two distinct mechanisms hide behind "cross-script",
 * and E0 should build stratum (b) from both while E4 attributes recall to the right channel — a
 * transliteration arm scored on homoglyph pairs would look falsely useless, and vice versa.
 *
 * Three schemes are emitted because they disagree, and which one a CERT-UA author used is unknown:
 *
 * - **ISO 9** (1995) — reversible, one Latin character (with diacritics) per Cyrillic character.
 *   The scholarly standard.
 * - **KMU 55-2010** — Ukraine's official romanization for passports and place names, so the
 *   spelling most likely to appear in an English-language CERT-UA report.
 * - **BGN/PCGN** — the US/UK standard, common in international reporting.
 *
 * Emitting all three costs three keys and lets a match on any of them succeed, which is the right
 * trade for a recall-only channel. Diacritics are stripped from the ISO 9 key as a fourth variant,
 * since a report is unlikely to write `Ŝ`.
 *
 * Latin-script input yields no keys: transliterating it would duplicate `identity` for no gain.
 */

/** ISO 9:1995 — reversible, diacritics carry the distinctions. */
const ISO9: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g̀', д: 'd', е: 'e', є: 'ê', ж: 'ž', з: 'z',
  и: 'i', і: 'ì', ї: 'ï', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'č', ш: 'š', щ: 'ŝ',
  ь: '′', ю: 'û', я: 'â', ъ: '″', ы: 'y', э: 'è', ё: 'ë',
};

/** KMU 55-2010 — Ukraine's official romanization. Context rules handled separately below. */
const KMU: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'y', э: 'e', ё: 'e',
};

/** BGN/PCGN — the US/UK standard. */
const BGN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ь: '', ю: 'yu', я: 'ya', ъ: '', ы: 'y', э: 'e', ё: 'e',
};

const CYRILLIC = /[Ѐ-ӿ]/;

export function hasCyrillic(value: string): boolean {
  return CYRILLIC.test(value);
}

function applyTable(value: string, table: Record<string, string>): string {
  let out = '';
  for (const char of value.toLowerCase()) out += table[char] ?? char;
  return out;
}

/**
 * KMU 55-2010 with its word-initial rules: є/ї/й/ю/я romanize differently at the start of a word
 * (`ye/yi/y/yu/ya`) than inside one (`ie/i/i/iu/ia`). Skipping this would misspell exactly the
 * agency and place names the stratum is built from.
 */
function applyKmu(value: string): string {
  const initial: Record<string, string> = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
  const lower = value.toLowerCase();
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i];
    const previous = i > 0 ? lower[i - 1] : '';
    const atWordStart = i === 0 || !/[\p{L}\p{N}]/u.test(previous);
    out += atWordStart && initial[char] ? initial[char] : (KMU[char] ?? char);
  }
  return out;
}

export function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

export const transliterateAnalyzer: Analyzer = {
  id: 'transliterate',
  keys(value: string): string[] {
    if (!hasCyrillic(value)) return [];

    const iso9 = applyTable(value, ISO9);
    const keys = new Set<string>([
      iso9.trim(),
      // A report is unlikely to write Ŝ or ì, so the de-accented ISO 9 form is a real variant.
      stripDiacritics(iso9).trim(),
      applyKmu(value).trim(),
      applyTable(value, BGN).trim(),
    ]);

    keys.delete('');
    return [...keys];
  },
};

/** Named exports for tests and for the E0 stratum-(b) pair generator. */
export const transliterations = {
  iso9: (value: string) => applyTable(value, ISO9),
  iso9NoDiacritics: (value: string) => stripDiacritics(applyTable(value, ISO9)),
  kmu: applyKmu,
  bgn: (value: string) => applyTable(value, BGN),
};
