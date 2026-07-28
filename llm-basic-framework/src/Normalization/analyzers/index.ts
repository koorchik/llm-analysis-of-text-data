import type { Analyzer } from '../types';
import { acronymAnalyzer } from './acronym';
import { confusableSkeletonAnalyzer } from './confusableSkeleton';
import { domainCanonical, domainCanonicalAnalyzer } from './domainCanonical';
import { identifierRegexAnalyzer } from './identifierRegex';
import { identityAnalyzer } from './identity';
import { transliterateAnalyzer } from './transliterate';

/**
 * The analyzer registry, mirroring `graph-data-analyzer/src/AnalysisRegistry.ts` as the plan asks.
 *
 * Keyed by id so an experiment config can name analyzers as strings
 * (`"analyzers": ["identity", "identifier-regex"]`) without importing anything.
 */
export const ANALYZERS: Record<string, Analyzer> = {
  identity: identityAnalyzer,
  transliterate: transliterateAnalyzer,
  'confusable-skeleton': confusableSkeletonAnalyzer,
  acronym: acronymAnalyzer,
  'domain-canonical': domainCanonical,
  'identifier-regex': identifierRegexAnalyzer,
};

export function resolveAnalyzers(ids: string[]): Analyzer[] {
  return ids.map((id) => {
    const analyzer = ANALYZERS[id];
    // Fatal rather than skipped: silently dropping an analyzer would make an E4 arm measure a
    // configuration it never ran, and the omission would be invisible in the results table.
    if (!analyzer) {
      throw new Error(`Unknown analyzer "${id}". Available: ${Object.keys(ANALYZERS).join(', ')}`);
    }
    return analyzer;
  });
}

export {
  acronymAnalyzer,
  confusableSkeletonAnalyzer,
  domainCanonical,
  domainCanonicalAnalyzer,
  identifierRegexAnalyzer,
  identityAnalyzer,
  transliterateAnalyzer,
};
