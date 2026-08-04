import type { EmbeddingsClient } from '../../EmbeddingsClient/EmbeddingsClient';
import {
  confusableSkeletonAnalyzer,
  identityAnalyzer,
  transliterateAnalyzer,
} from '../analyzers';
import type { CandidateGenerator } from '../types';
import { Bm25Generator } from './Bm25Generator';
import { EmbeddingGenerator } from './EmbeddingGenerator';
import { ExactMatchGenerator } from './ExactMatchGenerator';
import { RrfFusionGenerator } from './RrfFusionGenerator';
import { StringSimilarityGenerator } from './StringSimilarityGenerator';
import { TfidfNgramGenerator } from './TfidfNgramGenerator';

/**
 * What a generator may need beyond its own options. Passed to every factory whether it uses it or
 * not, because the alternative — a per-generator dependency union — makes the registry uncallable.
 */
export interface GeneratorDeps {
  embeddingsClient?: EmbeddingsClient;
}

/**
 * Generator registry, so an experiment config or `CANDIDATE_GENERATOR` can name a blocker as a
 * string.
 *
 * A bare `rrf` id is absent by design: it takes child generators rather than plain options, so a
 * custom composition comes from M7's experiment loader `children` block. `union` is the ONE named
 * composition — the SKEIN v2 deck's blocker, pinned here so `CANDIDATE_GENERATOR=union` selects
 * the method's arm exactly.
 */
export const GENERATORS: Record<string, (deps: GeneratorDeps) => CandidateGenerator> = {
  exact: () => new ExactMatchGenerator(),
  'string-sim': () => new StringSimilarityGenerator(),
  'tfidf-ngram': () => new TfidfNgramGenerator(),
  bm25: () => new Bm25Generator(),
  embedding: (deps) => {
    if (!deps.embeddingsClient) {
      throw new Error('Generator "embedding" requires an EmbeddingsClient');
    }
    return new EmbeddingGenerator({ embeddingsClient: deps.embeddingsClient });
  },
  /**
   * The SKEIN v2 union blocker: string similarity ∪ transliteration/Unicode-confusable skeleton
   * (the Cyrillic↔Latin channel is load-bearing on this corpus, not decorative) ∪ char-3-gram
   * TF-IDF ∪ multilingual dense over `name+gloss` ∪ BM25 — RRF-fused, scored max-over-aliases.
   */
  union: (deps) => {
    if (!deps.embeddingsClient) {
      throw new Error(
        'Generator "union" requires an EmbeddingsClient — the dense name+gloss channel is part of the union arm'
      );
    }
    return new RrfFusionGenerator({
      channel: 'union',
      children: [
        new StringSimilarityGenerator(),
        new StringSimilarityGenerator({
          analyzers: [identityAnalyzer, transliterateAnalyzer, confusableSkeletonAnalyzer],
          channel: 'translit',
        }),
        new TfidfNgramGenerator(),
        new Bm25Generator(),
        new EmbeddingGenerator({
          embeddingsClient: deps.embeddingsClient,
          representation: 'name+gloss',
        }),
      ],
    });
  },
};

/**
 * Resolves a generator id, **fatally** on an unknown one.
 *
 * Falling back to the default would run string similarity under another arm's name and put the
 * wrong label on a real result — the same rule `createDecisionStrategy` and `resolveAnalyzers`
 * already follow.
 */
export function resolveGenerator(id: string, deps: GeneratorDeps = {}): CandidateGenerator {
  const factory = GENERATORS[id];
  if (!factory) {
    throw new Error(
      `Unknown candidate generator "${id}". Available: ${Object.keys(GENERATORS).join(', ')} ` +
        '(unset = string-sim, the generator the M2.5 golden fixture pins)'
    );
  }
  return factory(deps);
}

export {
  Bm25Generator,
  EmbeddingGenerator,
  ExactMatchGenerator,
  RrfFusionGenerator,
  StringSimilarityGenerator,
  TfidfNgramGenerator,
};
