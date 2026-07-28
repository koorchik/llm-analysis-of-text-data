import type { Analyzer } from '../types';

/**
 * Extracts structured identifier forms as their own matching keys.
 *
 * **This analyzer exists because M2.5 measured the failure it fixes.** 60 of 92 `HackerGroup`
 * canonicals in the frozen corpus are `UAC-####` designations, and they score 0.75–0.875 against
 * each other on the shared prefix alone. Concretely, query `UAC-0010` retrieved `UAC-0018`,
 * `UAC-0050` and `UAC-0210` at 0.875 **ahead of** `UAC-0010 (Armageddon)` at 0.8 — its own
 * designation, ranked fifth and only just inside `k = 5`. String similarity ranks
 * structurally-similar-but-unrelated identifiers above the true alias, and no amount of metric
 * tuning fixes that: the *number* is the identity, and the surrounding text is noise.
 *
 * Emitting the normalized identifier as a separate key makes `UAC-0010` and
 * `UAC-0010 (Armageddon)` share an exact key, so they meet at similarity 1 regardless of the rest of
 * the string. `cheng2025ctinexus` uses IOC-protection regexes for the mirror-image reason — to stop
 * *near*-identifiers being merged.
 *
 * Deliberately conservative: only forms whose equality really is identity. No generic number
 * extraction, because "Windows 10" and "Windows 11" would then collide on nothing meaningful.
 */

interface Pattern {
  readonly label: string;
  readonly regex: RegExp;
  /** Canonical key form. Receives the whole match plus capture groups. */
  readonly key: (match: RegExpMatchArray) => string;
}

/**
 * Unicode-safe word boundaries.
 *
 * `\b` is **ASCII-only**, even with the `u` flag: between the start of a string and Cyrillic `у`
 * there is no `\b`, so `/\bуац/u` can never match `УАЦ-0028`. Measured, not assumed — the Cyrillic
 * designation form silently produced no keys until these replaced `\b`.
 */
const LEFT = '(?<![\\p{L}\\p{N}])';
const RIGHT = '(?![\\p{L}\\p{N}])';

const PATTERNS: Pattern[] = [
  {
    // CERT-UA actor designations: UAC-0010, UAC-0010 (Armageddon), УАЦ-0028 (Cyrillic spelling).
    // Two digits minimum: a report may write the shorthand `UAC-28`, but a single digit would let
    // stray prose like "UAC 5" register as a designation.
    label: 'uac',
    regex: new RegExp(`${LEFT}(?:uac|уац)[\\s._-]*(\\d{2,5})${RIGHT}`, 'giu'),
    key: (match) => `uac-${match[1].padStart(4, '0')}`,
  },
  {
    label: 'cve',
    regex: new RegExp(`${LEFT}cve[\\s._-]*(\\d{4})[\\s._-]*(\\d{4,7})${RIGHT}`, 'giu'),
    key: (match) => `cve-${match[1]}-${match[2]}`,
  },
  {
    // Autonomous system numbers.
    label: 'asn',
    regex: new RegExp(`${LEFT}as[\\s._-]*(\\d{1,10})${RIGHT}`, 'giu'),
    key: (match) => `as${match[1]}`,
  },
  {
    // IPv4, optionally with a CIDR suffix. Kept verbatim; equality of an address is identity.
    label: 'ipv4',
    regex: new RegExp(`${LEFT}(\\d{1,3}(?:\\.\\d{1,3}){3})(\\/\\d{1,2})?${RIGHT}`, 'gu'),
    key: (match) => `ip:${match[1]}${match[2] ?? ''}`,
  },
  {
    // Hex digests: md5 (32), sha1 (40), sha256 (64). Length pins the algorithm.
    label: 'hash',
    regex: new RegExp(`${LEFT}([0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})${RIGHT}`, 'giu'),
    key: (match) => `hash:${match[1].toLowerCase()}`,
  },
];

/** Valid IPv4 octets only — the regex alone would accept 999.1.1.1. */
function isPlausibleIpv4(key: string): boolean {
  const address = key.replace(/^ip:/, '').split('/')[0];
  return address.split('.').every((octet) => Number(octet) <= 255);
}

export const identifierRegexAnalyzer: Analyzer = {
  id: 'identifier-regex',
  keys(value: string): string[] {
    const keys = new Set<string>();

    for (const pattern of PATTERNS) {
      // Fresh regex per call: a shared /g regex carries `lastIndex` between calls, which would make
      // results depend on call order — the exact class of nondeterminism M2.5 was about.
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      for (const match of value.matchAll(regex)) {
        const key = pattern.key(match);
        if (pattern.label === 'ipv4' && !isPlausibleIpv4(key)) continue;
        keys.add(key);
      }
    }

    // Emits nothing when the value carries no identifier. The generator unions analyzer keys, so an
    // empty result simply means this channel has no opinion — it must not fall back to the raw
    // string, or every value would match on this channel and the analyzer would be useless.
    return [...keys];
  },
};

/** Exposed for tests and for the E3 policy dispatch, which routes by identifier form. */
export function extractIdentifiers(value: string): Array<{ label: string; key: string }> {
  const found: Array<{ label: string; key: string }> = [];
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of value.matchAll(regex)) {
      const key = pattern.key(match);
      if (pattern.label === 'ipv4' && !isPlausibleIpv4(key)) continue;
      found.push({ label: pattern.label, key });
    }
  }
  return found;
}
