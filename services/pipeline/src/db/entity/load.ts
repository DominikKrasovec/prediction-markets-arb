/**
 * Bulk entity-KB loader for Stage 2 question grouping.
 *
 * Loads per-market entity weights in a single flat SELECT. Pair-overlap is
 * computed on demand in `kbEntityOverlap()` (see stage2-questions/ann-search.ts)
 * for the exact pairs that ANN candidate filtering needs — usually <= |markets|
 * x 20 pairs after dedup. On-demand JS Jaccard keeps each pair lookup
 * O(min(|entities_a|, |entities_b|)) instead of computing the full weighted
 * Jaccard in SQL, which blows up on hub entities linked to thousands of markets.
 */

import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { EntityKB, EntityWeightMap, MarketTotalMap } from './types.js';

const log = createLogger('entity-kb');

/** Canonical pair key — always lower id first */
export function overlapKey(aId: number, bId: number): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

/**
 * Type-weight schedule mirrors the prior SQL CASE.  person/team/asset are
 * canonical-identity strong; organization is moderately discriminating;
 * event_name and location are weaker (often shared across many markets);
 * unknown gets the floor weight.
 *
 * Kept in code rather than as a `known_entities` column so a schema change
 * isn't required to tune the schedule.  If the set grows, consider promoting
 * to a typed lookup table.
 */
const TYPE_WEIGHTS: Readonly<Record<string, number>> = {
  person: 1.0,
  team: 1.0,
  asset: 1.0,
  organization: 0.8,
  event_name: 0.7,
  location: 0.6,
};
const TYPE_WEIGHT_DEFAULT = 0.4;

function typeWeight(t: string | null): number {
  if (t == null) return TYPE_WEIGHT_DEFAULT;
  return TYPE_WEIGHTS[t] ?? TYPE_WEIGHT_DEFAULT;
}

/**
 * Load per-market entity weights for `marketIds`.  Single flat SELECT joining
 * `market_entity_links` to `known_entities`; no self-join, no CTE.  Caller
 * computes pair overlap on demand via `kbEntityOverlap()`.
 *
 * The returned `entityWeights` map only contains markets that actually have
 * at least one KB link — a missing key means "no KB data for this market".
 */
export async function loadEntityKB(marketIds: number[]): Promise<EntityKB> {
  if (marketIds.length === 0) {
    return { entityWeights: new Map(), marketTotals: new Map() };
  }

  const rows = await query<{ market_id: number; entity_id: number; type: string | null }>(
    `SELECT mel.market_id, mel.entity_id, ke.type
       FROM market_entity_links mel
       JOIN known_entities ke ON mel.entity_id = ke.id
      WHERE mel.market_id = ANY($1)`,
    [marketIds],
  );

  const entityWeights: EntityWeightMap = new Map();
  const marketTotals: MarketTotalMap = new Map();

  for (const r of rows) {
    const w = typeWeight(r.type);
    let inner = entityWeights.get(r.market_id);
    if (!inner) {
      inner = new Map();
      entityWeights.set(r.market_id, inner);
    }
    // De-dup within a (market, entity) — schema has a unique constraint, but
    // be tolerant of join-order surprises. First weight wins.
    if (!inner.has(r.entity_id)) {
      inner.set(r.entity_id, w);
      marketTotals.set(r.market_id, (marketTotals.get(r.market_id) ?? 0) + w);
    }
  }

  log.info(
    `KB loaded: ${entityWeights.size} markets with links (of ${marketIds.length} requested), ` +
    `${rows.length} link rows`,
  );

  return { entityWeights, marketTotals };
}
