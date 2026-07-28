import type { CandidateGenerator } from '../types';
import { Bm25Generator } from './Bm25Generator';
import { ExactMatchGenerator } from './ExactMatchGenerator';
import { RrfFusionGenerator } from './RrfFusionGenerator';
import { StringSimilarityGenerator } from './StringSimilarityGenerator';
import { TfidfNgramGenerator } from './TfidfNgramGenerator';

/**
 * Generator registry, so an experiment config can name a blocker as a string.
 *
 * `rrf` is absent by design: it takes child generators rather than plain options, so it cannot be
 * constructed from an id alone. M7's experiment loader builds it from the `children` block.
 */
export const GENERATORS: Record<string, (config?: Record<string, never>) => CandidateGenerator> = {
  exact: () => new ExactMatchGenerator(),
  'string-sim': () => new StringSimilarityGenerator(),
  'tfidf-ngram': () => new TfidfNgramGenerator(),
  bm25: () => new Bm25Generator(),
};

export { Bm25Generator, ExactMatchGenerator, RrfFusionGenerator, StringSimilarityGenerator, TfidfNgramGenerator };
