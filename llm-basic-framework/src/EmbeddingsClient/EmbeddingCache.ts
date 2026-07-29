import crypto from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Content-addressed vector cache, keyed by `(model, text)`.
 *
 * **Why this is not optional.** `CandidateGenerator.onRegistryChange` is synchronous, so an
 * index-bearing generator can only invalidate and rebuild lazily (the `TfidfNgramGenerator`
 * pattern). For a *string* generator a rebuild is microseconds; for an embedding generator it is an
 * API call per canonical, on every mint, for all 204 documents. Without a cache the encoder arms
 * cost more than the judge they are meant to be compared against, which would make the comparison
 * meaningless rather than merely expensive.
 *
 * **Deliberately outside `experiments/{runId}/`.** The vector for a given (model, text) is
 * run-independent, so scoping the cache per run would re-embed the entire registry on every seed —
 * and ≥3 seeds per condition is the protocol. Sharing it across runs is safe precisely because the
 * key includes the model id.
 *
 * Vectors are stored at full `JSON.stringify` precision, which round-trips a JS double exactly.
 * Rounding would shrink the file by ~40% and make a cached run return *different* similarities from
 * an uncached one — a reproducibility leak in exchange for disk, which is the wrong trade here.
 */
export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  entries: number;
}

interface CacheLine {
  k: string;
  /** The source text, kept so the cache is auditable and rebuildable rather than opaque. */
  t: string;
  v: number[];
}

/**
 * Hashes the *structure* rather than a concatenation: `JSON.stringify([model, text])` is
 * unambiguous, so no separator convention has to be defended and no (model, text) pair can collide
 * with another by running the two fields together.
 */
export function cacheKey(model: string, text: string): string {
  return crypto.createHash('sha256').update(JSON.stringify([model, text]), 'utf8').digest('hex');
}

export class EmbeddingCache {
  readonly filePath: string;

  #model: string;
  #vectors = new Map<string, number[]>();
  #hits = 0;
  #misses = 0;

  constructor(params: { dir: string; provider: string; model: string }) {
    this.#model = params.model;
    const slug = `${params.provider}-${params.model}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    this.filePath = path.join(params.dir, `${slug}.jsonl`);
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.filePath)) return;

    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CacheLine;
        if (parsed.k && Array.isArray(parsed.v)) this.#vectors.set(parsed.k, parsed.v);
      } catch {
        // A torn final line from an interrupted run is expected and harmless — that entry is simply
        // re-embedded. Anything else is also non-fatal: a cache that cannot be read is a cache miss,
        // never a failed run.
      }
    }
  }

  get(text: string): number[] | undefined {
    const hit = this.#vectors.get(cacheKey(this.#model, text));
    if (hit) this.#hits += 1;
    else this.#misses += 1;
    return hit;
  }

  /** Appends rather than rewriting, so a long run's work survives an interruption. */
  set(text: string, vector: number[]): void {
    const key = cacheKey(this.#model, text);
    if (this.#vectors.has(key)) return;
    this.#vectors.set(key, vector);

    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const line: CacheLine = { k: key, t: text, v: vector };
    appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
  }

  get stats(): EmbeddingCacheStats {
    return { hits: this.#hits, misses: this.#misses, entries: this.#vectors.size };
  }
}
