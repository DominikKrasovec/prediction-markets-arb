/**
 * Single-flight concurrency primitive.
 *
 * Deduplicates concurrent calls for the same `key` — if a Promise for `key`
 * is already in-flight, the second caller receives the SAME Promise instead of
 * starting a new one. This prevents redundant API calls (e.g., 10 parallel
 * embedding requests for "Solana" while stage 1b processes a burst of markets
 * that all share the same subject phrase).
 *
 * Design notes:
 * - The entry is removed in `.finally()` so a failed call doesn't poison the
 *   cache — the next caller will retry the underlying function.
 * - LRU cap (LRU_CAP): bounds memory if subject churn is very high. Evicts
 *   the insertion-order oldest entry when the cap is reached.
 * - Per-process scope only. For multi-worker deployments, rely on the DB
 *   UNIQUE constraint as the authoritative dedup guard; this map is purely a
 *   cost optimization, not a correctness primitive.
 */

const LRU_CAP = 10_000;

/** Separate map per T to preserve typing; keyed by string key. */
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  // Evict oldest entry when cap is reached (Map preserves insertion order).
  if (inflight.size >= LRU_CAP) {
    const oldestKey = inflight.keys().next().value;
    if (oldestKey !== undefined) inflight.delete(oldestKey);
  }

  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
