import type { Analyzer } from '../types';

/**
 * Domain canonicalization. Domain is **53% of the frozen inventory** (1,929 of 3,392 pairs), so this
 * channel decides more of the candidate quality than any other.
 *
 * Applies, in order: NFKC → lower-case → strip scheme and userinfo → strip path/query/fragment →
 * strip a leading `www.` → strip a trailing dot → punycode/IDN awareness → optional eTLD+1.
 *
 * **A deliberate tension, resolved by emitting two keys rather than one.** M2.5 measured that
 * `accounts-ukr.net`, `accounts--ukr.net` and `accounts---ukr.net` already collide at similarity 1.0
 * under token-set Dice, and that they are plausibly *distinct typosquats*. eTLD+1 folding makes that
 * worse, not better: it would map `evil.ukr.net` and `mail.ukr.net` to the same key `ukr.net`,
 * collapsing an attacker-controlled subdomain into the legitimate registrable domain. For a CTI
 * corpus that is the wrong answer in the most consequential direction.
 *
 * So the analyzer emits the **full canonical host** as its primary key, and the eTLD+1 form only when
 * `includeRegistrableDomain` is explicitly enabled — off by default. E4 can then measure the
 * registrable-domain channel as its own arm and pay for it in precision knowingly, rather than
 * inheriting it silently. The note's ★★★ for domain canonicalization is about the NFKC/case/www/IDN
 * part, which is unambiguous; eTLD+1 is the part that needs a decision.
 */

/**
 * Public Suffix List subset, sufficient for this corpus.
 *
 * The real PSL is ~9,000 rules and a network dependency; committing a stale copy would be worse than
 * a documented subset. These cover the suffixes that occur in CERT-UA reporting: Ukrainian
 * second-level domains, the common gTLDs, and the multi-label suffixes that a naive "last two
 * labels" rule gets wrong (`co.uk`, `com.ua`).
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua', 'in.ua', 'kiev.ua', 'kyiv.ua', 'lviv.ua',
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.pl', 'com.tr', 'com.br', 'com.cn', 'co.jp',
  'com.au', 'co.nz', 'com.ru', 'net.ru', 'org.ru',
]);

export interface DomainOptions {
  /**
   * Also emit the eTLD+1 (registrable domain). **Off by default** — see the class comment: folding
   * `evil.ukr.net` into `ukr.net` merges an attacker subdomain with the legitimate domain.
   */
  includeRegistrableDomain?: boolean;
}

/** True when the value plausibly *is* a host, rather than prose that happens to contain a dot. */
export function looksLikeDomain(value: string): boolean {
  const host = canonicalHost(value);
  if (host.length === 0 || !host.includes('.')) return false;
  // No whitespace, and every label non-empty and label-legal.
  if (/\s/.test(host)) return false;
  return host.split('.').every((label) => label.length > 0 && /^[\p{L}\p{N}-]+$/u.test(label));
}

/** Scheme, credentials, port, path, query, fragment, leading `www.` and trailing dot all removed. */
export function canonicalHost(value: string): string {
  let host = value.normalize('NFKC').trim().toLowerCase();

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.replace(/^[^/@]*@/, ''); // userinfo
  host = host.split(/[/?#]/)[0]; // path, query, fragment
  host = host.replace(/:\d+$/, ''); // port
  host = host.replace(/^www\./, '');
  host = host.replace(/\.$/, ''); // fully-qualified trailing dot

  return host;
}

/**
 * eTLD+1 under the suffix subset above.
 *
 * Returns the host unchanged when it has too few labels to reduce, so callers never get an empty key.
 */
export function registrableDomain(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Punycode-decoded form, when the host is an IDN.
 *
 * Emitted as an extra key so a report writing `приклад.укр` can meet one writing `xn--...`. Decoding
 * is intentionally not implemented here — Node's `URL` does the encoding direction natively, and a
 * hand-rolled punycode decoder is a liability. Instead, both the raw ASCII form and the Unicode form
 * are emitted when `URL` can round-trip them.
 */
function idnVariants(host: string): string[] {
  const variants = new Set<string>();
  try {
    // `URL` normalizes to punycode on construction, giving the ASCII form for a Unicode host.
    const ascii = new URL(`http://${host}`).hostname;
    if (ascii && ascii !== host) variants.add(ascii);
  } catch {
    // Not a constructible host; the canonical form alone will have to do.
  }
  return [...variants];
}

export function domainCanonicalAnalyzer(options: DomainOptions = {}): Analyzer {
  const includeRegistrable = options.includeRegistrableDomain ?? false;

  return {
    id: includeRegistrable ? 'domain-canonical+etld1' : 'domain-canonical',
    keys(value: string): string[] {
      if (!looksLikeDomain(value)) return []; // no opinion on non-domains

      const host = canonicalHost(value);
      const keys = new Set<string>([host, ...idnVariants(host)]);

      if (includeRegistrable) {
        const registrable = registrableDomain(host);
        if (registrable !== host) keys.add(registrable);
      }

      keys.delete('');
      return [...keys];
    },
  };
}

/** Default instance: full host only, no eTLD+1 folding. */
export const domainCanonical = domainCanonicalAnalyzer();
