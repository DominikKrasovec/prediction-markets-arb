/**
 * A belt whose capability has moved upstream stays in firing position, but
 * its hit counter should read 0 going forward; a nonzero reading flags it as
 * still needed. `beltHit(name)` increments an in-memory counter; counters are
 * flushed at stage end as a single structured log line, never written to the
 * DB — this telemetry is not authoritative.
 *
 * Two counter families:
 *   `belt.*` — de-loaded belts (`beltHit`).
 *   `disc.*` — Stage-1 stamp coverage histogram (`discCount`):
 *              `disc.<spec>.stamped` / `disc.<spec>.null` per emitted row.
 */

/** Process-global in-memory counter map. Reset per stage / per test. */
const counters = new Map<string, number>();

/**
 * Increments a de-loaded-belt hit counter, prefixed `belt.` in the flushed
 * census line. `meta` is accepted for call-site ergonomics but not
 * aggregated; add a dedicated counter for a breakdown.
 */
export function beltHit(name: string, _meta?: Record<string, unknown>): void {
  const key = `belt.${name}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/**
 * Stamp-coverage counter: `disc.<spec>.stamped` when a discriminator value was
 * written, `disc.<spec>.null` when the extractor returned null.
 */
export function discCount(spec: string, stamped: boolean): void {
  const key = `disc.${spec}.${stamped ? 'stamped' : 'null'}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/**
 * Roll-up consensus-conflict counter: a member set that disagrees on a
 * consensus-rolled field leaves the node NULL rather than picking a winner.
 * `n` is added, not set, so repeat feeds accumulate.
 */
export function rollupCount(name: string, n: number): void {
  if (n <= 0) return;
  const key = `rollup.${name}`;
  counters.set(key, (counters.get(key) ?? 0) + n);
}

/** Snapshot the current counters (sorted by key) — for the census harness + tests. */
export function beltCensus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...counters.keys()].sort()) out[k] = counters.get(k)!;
  return out;
}

/**
 * Emit the single structured `BELT_CENSUS { … }` log line and return the
 * snapshot. Call at stage end. `log` defaults to `console.log` so the module
 * stays dependency-light (no @arb/logger cycle); pass a logger to route it.
 */
export function flushBeltCensus(log: (msg: string) => void = console.log): Record<string, number> {
  const snap = beltCensus();
  log(`BELT_CENSUS ${JSON.stringify(snap)}`);
  return snap;
}

/** Reset all counters (test isolation / new stage). */
export function resetBeltCensus(): void {
  counters.clear();
}
