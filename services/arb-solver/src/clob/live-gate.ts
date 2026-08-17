/**
 * Live-active subscription gate.
 *
 * `getMarketsToTrack` derives its subscription list purely from the in-memory
 * cluster graph. The graph loader (`graph/loader.ts`) already gates its question
 * query on `resolved_at IS NULL AND (end_date IS NULL OR end_date > now())`, so
 * at the instant a graph is loaded the cluster markets are live. But the solver
 * is a long-lived process: between graph reloads a market can pass its
 * `end_date` or get resolved while still sitting in the cluster, so it stays
 * subscribed and streams nothing — it parks at the $2 ask sentinel (safely
 * excluded from the LP, so NOT a fake arb) and just wastes a CLOB slot + churn.
 *
 * This module re-checks liveness against the DB at subscribe time and drops any
 * candidate that is already resolved/expired BEFORE it is handed to the CLOB
 * manager. It is the same predicate the loader uses, applied a second time at
 * the subscription chokepoint (defence-in-depth: it also catches the reload-time
 * drift between the loader query and the subscribe query, and protects against a
 * future code path that adds non-loader-gated markets to a cluster).
 *
 * CONSERVATIVE BY CONSTRUCTION:
 *   - {@link filterSubsToLive} only ever REMOVES a sub (output ⊆ input); it can
 *     never ADD a market, so it cannot manufacture a subscription/arb.
 *   - {@link getLiveMarketIds} fails OPEN: if the DB query throws, the caller
 *     falls back to subscribing ALL candidates (a DB blip must not blind the
 *     solver by silently dropping every market).
 *
 * Flag: `CLOB_LIVE_SUBSCRIBE_GATE` (config.execution.liveSubscribeGate),
 * default ON; `=0` reverts to subscribe-all (no DB round-trip).
 */

import { query } from '@arb/db';
import type { MarketSubscription } from './price-cache.js';

/**
 * Pure filter (exported for unit tests): keep only the subscriptions whose
 * `marketId` is present in `liveIds`. Strictly a subset of `subs`, order
 * preserved — never adds a sub. A market may legitimately fan out into several
 * subscriptions (e.g. Polymarket YES + NO under two-sided books, or a Limitless
 * group wrapper expanded to child slugs); all of them share the parent
 * `marketId`, so a single liveness verdict per marketId keeps or drops the whole
 * fan-out together.
 */
export function filterSubsToLive(
  subs: readonly MarketSubscription[],
  liveIds: ReadonlySet<number>,
): MarketSubscription[] {
  return subs.filter((s) => liveIds.has(s.marketId));
}

/**
 * Return the subset of `candidateIds` that are still LIVE per the `markets`
 * table — i.e. `resolved_at IS NULL AND (end_date IS NULL OR end_date > now())`,
 * the exact predicate the graph loader gates its question query on.
 *
 * Returns `null` (NOT an empty set) when the DB query fails, so the caller can
 * distinguish "DB says nothing is live" (impossible in practice, but a real
 * empty result) from "the query errored — fall back to subscribe-all". Failing
 * open is the conservative choice: a transient DB error must not silently drop
 * every subscription and blind the solver to the live feed.
 */
export async function getLiveMarketIds(
  candidateIds: readonly number[],
): Promise<Set<number> | null> {
  if (candidateIds.length === 0) return new Set();
  try {
    const rows = await query<{ id: number }>(
      `SELECT id FROM markets
        WHERE id = ANY($1::int[])
          AND resolved_at IS NULL
          AND (end_date IS NULL OR end_date > now())`,
      [candidateIds as number[]],
    );
    return new Set(rows.map((r) => r.id));
  } catch {
    return null;
  }
}
