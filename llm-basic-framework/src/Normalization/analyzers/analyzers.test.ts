import { ANALYZERS, resolveAnalyzers } from './index';
import { initialism, looksLikeAcronym } from './acronym';
import { skeleton } from './confusableSkeleton';
import { canonicalHost, domainCanonicalAnalyzer, looksLikeDomain, registrableDomain } from './domainCanonical';
import { extractIdentifiers } from './identifierRegex';
import { hasCyrillic, transliterations } from './transliterate';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const keys = (id: string, value: string): string[] =>
  ANALYZERS[id].keys(value, { category: 'HackerGroup' });

// --- identity ---------------------------------------------------------------------------------------

test('identity trims and case-folds, matching what resolve() considers the same name', () => {
  assert.deepEqual(keys('identity', '  APT28 '), ['apt28']);
  assert.deepEqual(keys('identity', 'apt28'), ['apt28']);
  assert.deepEqual(keys('identity', '   '), [], 'an empty key would match everything');
});

// --- identifierRegex: the M2.5 finding it exists to fix ---------------------------------------------

test('identifierRegex makes UAC-0010 and UAC-0010 (Armageddon) share an exact key', () => {
  // The measured failure: string similarity ranked UAC-0018/0050/0210 at 0.875 AHEAD of
  // UAC-0010 (Armageddon) at 0.8 — the query's own designation, fifth and barely inside k=5.
  assert.deepEqual(keys('identifier-regex', 'UAC-0010'), ['uac-0010']);
  assert.deepEqual(keys('identifier-regex', 'UAC-0010 (Armageddon)'), ['uac-0010']);
});

test('identifierRegex does NOT conflate different designations', () => {
  assert.notDeepEqual(keys('identifier-regex', 'UAC-0010'), keys('identifier-regex', 'UAC-0018'));
});

test('identifierRegex zero-pads so UAC-28 and UAC-0028 agree', () => {
  assert.deepEqual(keys('identifier-regex', 'UAC-28'), ['uac-0028']);
  assert.deepEqual(keys('identifier-regex', 'UAC-0028'), ['uac-0028']);
});

test('identifierRegex reads the Cyrillic spelling of the designation', () => {
  assert.deepEqual(keys('identifier-regex', 'УАЦ-0028'), ['uac-0028']);
});

test('identifierRegex handles separators and the other identifier forms', () => {
  assert.deepEqual(keys('identifier-regex', 'uac 0010'), ['uac-0010']);
  assert.deepEqual(keys('identifier-regex', 'CVE-2021-44228'), ['cve-2021-44228']);
  assert.deepEqual(keys('identifier-regex', 'AS15169'), ['as15169']);
  assert.deepEqual(keys('identifier-regex', '192.168.1.1'), ['ip:192.168.1.1']);
  assert.deepEqual(keys('identifier-regex', '10.0.0.0/8'), ['ip:10.0.0.0/8']);
  assert.deepEqual(keys('identifier-regex', 'd41d8cd98f00b204e9800998ecf8427e'), [
    'hash:d41d8cd98f00b204e9800998ecf8427e',
  ]);
});

test('identifierRegex rejects an impossible IPv4', () => {
  assert.deepEqual(keys('identifier-regex', '999.1.1.1'), [], 'octet > 255');
});

test('identifierRegex stays silent when there is no identifier', () => {
  // Silence, never a fallback to the raw string: a fallback would make every value match on this
  // channel and the analyzer would be worthless.
  assert.deepEqual(keys('identifier-regex', 'Fancy Bear'), []);
  assert.deepEqual(keys('identifier-regex', 'Windows 10'), [], 'a bare number is not an identifier');
});

test('identifierRegex is call-order independent', () => {
  // A shared /g regex carries lastIndex between calls; a fresh one per call is what prevents the
  // result depending on how many times the analyzer has run.
  const first = keys('identifier-regex', 'UAC-0010');
  keys('identifier-regex', 'UAC-9999 and UAC-8888');
  assert.deepEqual(keys('identifier-regex', 'UAC-0010'), first);
});

test('extractIdentifiers labels each form, for E3 policy dispatch', () => {
  const found = extractIdentifiers('UAC-0010 exploited CVE-2021-44228 from 10.0.0.1');
  assert.deepEqual(found.map((entry) => entry.label).sort(), ['cve', 'ipv4', 'uac']);
});

// --- transliterate ----------------------------------------------------------------------------------

test('transliterate romanizes Cyrillic and stays silent on Latin', () => {
  assert.deepEqual(keys('transliterate', 'СБУ'), ['sbu']);
  assert.deepEqual(keys('transliterate', 'APT28'), [], 'no gain over identity');
});

test('transliterate emits several keys where the schemes disagree', () => {
  const produced = keys('transliterate', 'Служба безпеки України');
  // ISO 9 keeps diacritics (služba…), KMU and BGN differ on и/й/я endings.
  assert.ok(produced.length >= 3, `expected several schemes, got ${JSON.stringify(produced)}`);
  assert.ok(produced.some((key) => key.includes('sluzhba bezpeky ukrainy')), 'KMU form present');
  assert.ok(produced.some((key) => key.includes('služba')), 'ISO 9 form present');
  assert.ok(produced.some((key) => !/[^\x20-\x7e]/.test(key)), 'a plain-ASCII variant is present');
});

test('KMU applies its word-initial rule', () => {
  // є/ї/й/ю/я romanize as ye/yi/y/yu/ya at a word start and ie/i/i/iu/ia inside one.
  assert.ok(transliterations.kmu('Юрій').startsWith('yu'));
  assert.ok(transliterations.kmu('Крюк').includes('iu'), 'medial ю is iu');
});

test('АРТ28 vs APT28 is a HOMOGLYPH case, not a transliteration case', () => {
  // The research note offers this as its stratum-(b) example, but Cyrillic Р is ER: it transliterates
  // to r, so transliteration yields art28 and cannot match apt28. Recorded so E4 attributes recall
  // to the right channel — a transliteration arm scored on homoglyph pairs looks falsely useless.
  assert.deepEqual(keys('transliterate', 'АРТ28'), ['art28']);
  assert.notEqual(keys('transliterate', 'АРТ28')[0], keys('identity', 'APT28')[0]);

  assert.deepEqual(keys('confusable-skeleton', 'АРТ28'), ['apt28']);
  assert.equal(keys('confusable-skeleton', 'АРТ28')[0], keys('identity', 'APT28')[0], 'this channel matches');
});

test('hasCyrillic gates the analyzer', () => {
  assert.equal(hasCyrillic('СБУ'), true);
  assert.equal(hasCyrillic('SBU'), false);
});

// --- confusableSkeleton -----------------------------------------------------------------------------

test('confusableSkeleton folds Cyrillic and Greek lookalikes to Latin', () => {
  assert.deepEqual(keys('confusable-skeleton', 'аpple.com'), ['apple.com'], 'Cyrillic а');
  assert.deepEqual(keys('confusable-skeleton', 'gооgle.com'), ['google.com'], 'Cyrillic о twice');
});

test('confusableSkeleton NEVER folds digits — designations are identity-bearing', () => {
  // 8→b once turned АРТ28 into apt2b, so the spoof failed to match the very name it targets. It
  // would equally corrupt UAC-0010, CVE-2021-44228 and every version number.
  assert.equal(skeleton('apt28'), 'apt28');
  assert.equal(skeleton('uac-0010'), 'uac-0010');
  assert.equal(skeleton('cve-2021-44228'), 'cve-2021-44228');
  assert.equal(skeleton('windows 10'), 'windows 10');
});

test('confusableSkeleton stays silent when the skeleton adds nothing', () => {
  // Emitting on pure ASCII would duplicate identity and inflate this channel's apparent recall in E4.
  assert.deepEqual(keys('confusable-skeleton', 'apple.com'), []);
  assert.deepEqual(keys('confusable-skeleton', 'Fancy Bear'), []);
});

test('confusableSkeleton folds fullwidth punctuation used in IDN abuse', () => {
  assert.deepEqual(keys('confusable-skeleton', 'ukr．net'), ['ukr.net']);
});

// --- acronym ----------------------------------------------------------------------------------------

test('acronym makes the Ukrainian agency name meet its initialism', () => {
  // The ★★★ mechanism with no measured coverage anywhere: these share no characters and no tokens,
  // so every string metric AND every name embedding scores them near zero.
  const expansion = keys('acronym', 'Служба безпеки України');
  const short = keys('acronym', 'СБУ');
  assert.ok(expansion.includes('сбу'));
  assert.ok(expansion.includes('sbu'), 'romanized initialism, for an English-language report');
  assert.ok(short.includes('sbu'));
  assert.ok(short.some((key) => expansion.includes(key)), 'the two forms meet on a shared key');
});

test('acronym emits both stopword policies', () => {
  // "Security Service of Ukraine" is cited as both SSU and SSOU.
  const produced = keys('acronym', 'Security Service of Ukraine');
  assert.ok(produced.includes('ssu'), 'stopwords dropped');
  assert.ok(produced.includes('ssou'), 'stopwords kept');
});

test('acronym ignores a single word and very long strings', () => {
  assert.deepEqual(keys('acronym', 'Sandworm'), [], 'one word has no initialism');
  assert.equal(initialism('OneWord', true), '');
});

test('looksLikeAcronym accepts short all-caps tokens only', () => {
  assert.equal(looksLikeAcronym('SBU'), true);
  assert.equal(looksLikeAcronym('СБУ'), true);
  assert.equal(looksLikeAcronym('Sbu'), false, 'mixed case is a word');
  assert.equal(looksLikeAcronym('A'), false, 'too short to be informative');
  assert.equal(looksLikeAcronym('VERYLONGACRONYM'), false);
});

// --- domainCanonical --------------------------------------------------------------------------------

test('domainCanonical strips scheme, credentials, port, path and www', () => {
  assert.deepEqual(keys('domain-canonical', 'https://www.Ukr.NET:443/mail?a=1#x'), ['ukr.net']);
  assert.deepEqual(keys('domain-canonical', 'user:pw@mail.gov.ua/inbox'), ['mail.gov.ua']);
  assert.equal(canonicalHost('UKR.NET.'), 'ukr.net', 'trailing dot removed');
});

test('domainCanonical does NOT fold to eTLD+1 by default', () => {
  // The M2.5 tension: folding evil.ukr.net into ukr.net merges an attacker-controlled subdomain with
  // the legitimate registrable domain — the wrong answer in the most consequential direction.
  assert.deepEqual(keys('domain-canonical', 'evil.ukr.net'), ['evil.ukr.net']);
  assert.equal(keys('domain-canonical', 'evil.ukr.net')[0] === 'ukr.net', false);
});

test('the eTLD+1 channel is available but must be asked for explicitly', () => {
  const withRegistrable = domainCanonicalAnalyzer({ includeRegistrableDomain: true });
  const produced = withRegistrable.keys('evil.ukr.net', { category: 'Domain' });
  assert.ok(produced.includes('evil.ukr.net'), 'the full host is still primary');
  assert.ok(produced.includes('ukr.net'), 'and the registrable domain is an additional key');
  assert.equal(withRegistrable.id, 'domain-canonical+etld1', 'the id records the choice');
});

test('registrableDomain respects multi-label suffixes', () => {
  assert.equal(registrableDomain('mail.gov.ua'), 'mail.gov.ua', 'gov.ua is a public suffix');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('sub.example.co.uk'), 'example.co.uk');
});

test('domainCanonical stays silent on prose', () => {
  assert.deepEqual(keys('domain-canonical', 'not a domain at all'), []);
  assert.deepEqual(keys('domain-canonical', 'Fancy Bear'), []);
  assert.equal(looksLikeDomain('hello world.com'), false, 'whitespace disqualifies it');
});

test('the punctuation-variant domains M2.5 found remain DISTINCT under this analyzer', () => {
  // They collide at similarity 1.0 under token-set Dice because tokenization discards punctuation.
  // domainCanonical keeps them apart, which is the point: they are plausibly separate typosquats.
  const a = keys('domain-canonical', 'accounts-ukr.net');
  const b = keys('domain-canonical', 'accounts--ukr.net');
  assert.notDeepEqual(a, b);
});

// --- registry ---------------------------------------------------------------------------------------

test('resolveAnalyzers maps ids and fails loudly on an unknown one', () => {
  assert.deepEqual(
    resolveAnalyzers(['identity', 'identifier-regex']).map((analyzer) => analyzer.id),
    ['identity', 'identifier-regex']
  );
  // Silently dropping one would make an E4 arm measure a configuration it never ran.
  assert.throws(() => resolveAnalyzers(['identity', 'nope']), /Unknown analyzer "nope"/);
});

test('every registered analyzer returns an array and never throws on odd input', () => {
  for (const [id, analyzer] of Object.entries(ANALYZERS)) {
    for (const value of ['', '   ', '???', '💥', 'a'.repeat(500)]) {
      const produced = analyzer.keys(value, { category: 'X' });
      assert.ok(Array.isArray(produced), `${id} returned a non-array`);
      assert.ok(produced.every((key) => typeof key === 'string' && key.length > 0), `${id} emitted an empty key`);
    }
  }
});
