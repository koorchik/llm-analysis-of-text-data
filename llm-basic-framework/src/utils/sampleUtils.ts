/**
 * A window onto a pool that is spread across it rather than taken from the front.
 *
 * `slice(0, max)` reads the *earliest-minted* entities, because the registry iterates canonicals in
 * insertion order. On a 121-surface Software pool with `max` 50 that means a registry-wide review
 * only ever sees the oldest 50, so anything minted later is never revisited. Striding covers the
 * whole pool at the same cost, and stays deterministic, which matters because the sample is part of
 * the runId's behaviour. (Lifted verbatim from the retired LadderDiscovery.)
 */
export function spreadSample<T>(items: T[], max: number): T[] {
  if (max <= 0 || items.length <= max) return items.slice();
  const step = items.length / max;
  const out: T[] = [];
  for (let index = 0; index < max; index++) out.push(items[Math.floor(index * step)]);
  return out;
}
