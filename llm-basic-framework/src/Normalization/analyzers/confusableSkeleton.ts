import type { Analyzer } from '../types';

/**
 * Unicode confusable skeleton (the idea behind UTS #39).
 *
 * **Mixed-script spoofing is real in this corpus and defeats every metric above.** A domain written
 * with Cyrillic `о` (U+043E) inside an otherwise-Latin word is a different byte string from its
 * Latin twin, so edit distance and token overlap both see two unrelated names — while a human, and
 * the attacker, see one. The note gives this ★★★ with no coverage in the literature it audits.
 *
 * The skeleton maps each confusable character to a single representative, so `аpple` (Cyrillic а) and
 * `apple` collapse to the same key. Note what this is *for*: it is a **recall** channel, surfacing
 * the pair for the judge to rule on. It must never decide identity by itself — a homoglyph domain is
 * frequently a *deliberately distinct* malicious host, and merging it with its legitimate twin would
 * be precisely the wrong answer. Same caution as the `accounts-ukr.net` family M2.5 found.
 *
 * This is a curated subset covering Cyrillic/Greek/Latin lookalikes and the digit-letter pairs that
 * actually occur, not the full UTS #39 confusables table (thousands of entries, most irrelevant to
 * Ukrainian CTI text). Documented as a subset rather than presented as complete.
 */

const CONFUSABLES: Record<string, string> = {
  // Cyrillic → Latin lookalikes.
  а: 'a', б: '6', в: 'b', г: 'r', д: 'd', е: 'e', ё: 'e', ж: 'x', з: '3', и: 'u',
  й: 'u', к: 'k', л: 'n', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c', т: 't',
  у: 'y', ф: 'o', х: 'x', ц: 'u', ч: '4', ш: 'w', щ: 'w', ъ: 'b', ы: 'bi', ь: 'b',
  э: 'e', ю: 'io', я: 'r', і: 'i', ї: 'i', є: 'e', ґ: 'r',

  // Greek → Latin lookalikes.
  α: 'a', β: 'b', γ: 'y', ε: 'e', ζ: 'z', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v',
  ο: 'o', ρ: 'p', σ: 'o', τ: 't', υ: 'v', χ: 'x', ω: 'w', Α: 'a', Β: 'b', Ε: 'e',
  Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',

  // NO digit→letter folding. It is the obvious thing to add for typosquat detection (`micr0soft` →
  // `microsoft`) and it is WRONG for this corpus: digits here are identity-bearing. Mapping 8→b
  // turned `АРТ28` into `apt2b`, so the homoglyph spoof failed to match `apt28` — the exact case
  // this analyzer exists for. It would equally corrupt `UAC-0010` (60 of 92 HackerGroup canonicals),
  // `CVE-2021-44228` and every version number. Caught by testing the analyzer against the real
  // spoof; recorded so it is not "helpfully" re-added.

  // Fullwidth and lookalike punctuation, which IDN abuse uses.
  '．': '.', '｡': '.', '。': '.', '－': '-', '‐': '-', '‑': '-', '–': '-', '—': '-',
};

/**
 * Collapse a string to its confusable skeleton.
 *
 * NFKC first, so fullwidth and compatibility forms fold before the table is applied; then
 * case-folded, so the skeleton is comparable to an `identity` key.
 */
export function skeleton(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase();
  let out = '';
  for (const char of normalized) out += CONFUSABLES[char] ?? char;
  return out;
}

export const confusableSkeletonAnalyzer: Analyzer = {
  id: 'confusable-skeleton',
  keys(value: string): string[] {
    const key = skeleton(value).trim();
    if (key.length === 0) return [];

    // Emit only when the skeleton actually differs from the plain case-folded form. Otherwise this
    // channel would duplicate `identity` on every pure-ASCII value, inflating its apparent recall
    // in E4 while contributing nothing.
    return key === value.trim().toLowerCase() ? [] : [key];
  },
};
