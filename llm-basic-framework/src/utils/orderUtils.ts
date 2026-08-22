import { mulberry32 } from '../Evaluation/bootstrap';
import { sortByNumericId } from './fsUtils';

/**
 * Document arrival order — the E6/M7 order-robustness knob.
 *
 * A streaming pipeline's registry is path-dependent by construction (first-seen minting, catch-up
 * timing, edge accumulation), so the arrival order is an experimental variable, not an accident of
 * the filesystem. `ORDER` selects it and is folded into the runId; the cross-order agreement of
 * the resulting registries (npm run order-ari) is the stability measurement.
 *
 * - `numeric-id`   — ascending document id; the stream's natural (chronological) order. Default.
 * - `reverse`      — descending document id; the adversarial "future first" order.
 * - `seededShuffle:<seed>` — deterministic Fisher–Yates permutation over the numeric-id order,
 *   driven by mulberry32 (the same seeded PRNG the bootstrap uses) so a shuffle is reproducible
 *   from its seed alone.
 */
export type OrderSpec = string;

export function validateOrderSpec(spec: OrderSpec): void {
  if (spec === 'numeric-id' || spec === 'reverse') return;
  const match = /^seededShuffle:(\d+)$/.exec(spec);
  if (match) return;
  throw new Error(
    `ORDER "${spec}" is not one of: numeric-id | reverse | seededShuffle:<seed>`
  );
}

export function orderFiles(files: string[], spec: OrderSpec): string[] {
  validateOrderSpec(spec);
  const base = sortByNumericId(files);
  if (spec === 'numeric-id') return base;
  if (spec === 'reverse') return base.slice().reverse();

  const seed = Number(/^seededShuffle:(\d+)$/.exec(spec)![1]);
  const rng = mulberry32(seed);
  // Fisher–Yates over the canonical base order, so the permutation depends only on the seed and
  // the file set — never on filesystem enumeration order.
  const out = base.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
