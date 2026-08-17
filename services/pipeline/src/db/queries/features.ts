/**
 * Centralized queries for `market_features` table.
 */
import { query } from '@arb/db';
import type { MarketFeatures } from '@arb/types';

export async function insertMarketFeatures(features: MarketFeatures): Promise<void> {
  await query(
    `INSERT INTO market_features (
       market_id, platform, platform_id,
       normalized_title, title_words, title_bigrams, title_trigrams,
       dates, numbers, currencies,
       hierarchy_type, hierarchy_value, hierarchy_level,
       platform_group_id, platform_cross_ref,
       -- outcome_space intentionally not written (dead column)
       condition_shape, condition_direction, temporal_semantics
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18
     )
     ON CONFLICT (market_id) DO UPDATE SET
       normalized_title = EXCLUDED.normalized_title,
       title_words = EXCLUDED.title_words,
       dates = EXCLUDED.dates,
       numbers = EXCLUDED.numbers,
       hierarchy_type = EXCLUDED.hierarchy_type,
       hierarchy_value = EXCLUDED.hierarchy_value,
       hierarchy_level = EXCLUDED.hierarchy_level,
       platform_group_id = EXCLUDED.platform_group_id,
       platform_cross_ref = EXCLUDED.platform_cross_ref,
       condition_shape = EXCLUDED.condition_shape,
       condition_direction = EXCLUDED.condition_direction,
       temporal_semantics = EXCLUDED.temporal_semantics`,
    [
      features.market_id,
      features.platform,
      features.platform_id,
      features.normalized_title,
      JSON.stringify(features.title_words),
      JSON.stringify(features.title_bigrams),
      JSON.stringify(features.title_trigrams),
      JSON.stringify(features.dates),
      JSON.stringify(features.numbers),
      JSON.stringify(features.currencies),
      features.hierarchy_type,
      features.hierarchy_value,
      (() => {
        if (features.hierarchy_level == null) return null;
        const r = Math.round(features.hierarchy_level);
        return (r >= -2147483648 && r <= 2147483647) ? r : null;
      })(),
      features.platform_group_id,
      features.platform_cross_ref,
      // outcome_space omitted (dead column).
      features.condition_shape,
      features.condition_direction,
      features.temporal_semantics,
    ]
  );
}

/**
 * Bulk-insert an entire batch of market features in a single UNNEST query,
 * replacing 1-per-row round-trips with one DB call for the whole batch.
 */
export async function bulkInsertMarketFeatures(featuresList: MarketFeatures[]): Promise<void> {
  if (featuresList.length === 0) return;
  await query(
    `INSERT INTO market_features (
       market_id, platform, platform_id,
       normalized_title, title_words, title_bigrams, title_trigrams,
       dates, numbers, currencies,
       hierarchy_type, hierarchy_value, hierarchy_level,
       platform_group_id, platform_cross_ref,
       -- outcome_space intentionally not written (dead column)
       condition_shape, condition_direction, temporal_semantics
     )
     SELECT
       u.market_id, u.platform, u.platform_id,
       u.normalized_title,
       u.title_words::jsonb, u.title_bigrams::jsonb, u.title_trigrams::jsonb,
       u.dates::jsonb, u.numbers::jsonb, u.currencies::jsonb,
       u.hierarchy_type, u.hierarchy_value, u.hierarchy_level,
       u.platform_group_id, u.platform_cross_ref,
       u.condition_shape, u.condition_direction, u.temporal_semantics
     FROM UNNEST(
       $1::int[],
       $2::text[], $3::text[],
       $4::text[], $5::text[], $6::text[], $7::text[],
       $8::text[], $9::text[], $10::text[],
       $11::text[], $12::text[], $13::int[],
       $14::text[], $15::text[],
       $16::text[], $17::text[], $18::text[]
     ) AS u(
       market_id, platform, platform_id,
       normalized_title, title_words, title_bigrams, title_trigrams,
       dates, numbers, currencies,
       hierarchy_type, hierarchy_value, hierarchy_level,
       platform_group_id, platform_cross_ref,
       condition_shape, condition_direction, temporal_semantics
     )
     ON CONFLICT (market_id) DO UPDATE SET
       normalized_title = EXCLUDED.normalized_title,
       title_words = EXCLUDED.title_words,
       dates = EXCLUDED.dates,
       numbers = EXCLUDED.numbers,
       hierarchy_type = EXCLUDED.hierarchy_type,
       hierarchy_value = EXCLUDED.hierarchy_value,
       hierarchy_level = EXCLUDED.hierarchy_level,
       platform_group_id = EXCLUDED.platform_group_id,
       platform_cross_ref = EXCLUDED.platform_cross_ref,
       condition_shape = EXCLUDED.condition_shape,
       condition_direction = EXCLUDED.condition_direction,
       temporal_semantics = EXCLUDED.temporal_semantics`,
    [
      featuresList.map(f => f.market_id),
      featuresList.map(f => f.platform),
      featuresList.map(f => f.platform_id),
      featuresList.map(f => f.normalized_title),
      featuresList.map(f => JSON.stringify(f.title_words)),
      featuresList.map(f => JSON.stringify(f.title_bigrams)),
      featuresList.map(f => JSON.stringify(f.title_trigrams)),
      featuresList.map(f => JSON.stringify(f.dates)),
      featuresList.map(f => JSON.stringify(f.numbers)),
      featuresList.map(f => JSON.stringify(f.currencies)),
      featuresList.map(f => f.hierarchy_type ?? null),
      featuresList.map(f => f.hierarchy_value ?? null),
      featuresList.map(f => {
        if (f.hierarchy_level == null) return null;
        const rounded = Math.round(f.hierarchy_level);
        return (rounded >= -2147483648 && rounded <= 2147483647) ? rounded : null;
      }),
      featuresList.map(f => f.platform_group_id ?? null),
      featuresList.map(f => f.platform_cross_ref ?? null),
      // outcome_space omitted (dead column).
      featuresList.map(f => f.condition_shape ?? null),
      featuresList.map(f => f.condition_direction ?? null),
      featuresList.map(f => f.temporal_semantics ?? null),
    ]
  );
}

/**
 * Per-round-trip ID cap. A single `WHERE id = ANY($1)` over a very large
 * array tips pg's planner into a nonlinear scan that blows
 * `statement_timeout`. Single-column queries are tiny per row so the cap can
 * be generous; the planner stays on the primary-key index.
 */
const ID_CHUNK = 50_000;

/**
 * Return the set of market_ids that have a `market_features` row, restricted
 * to `marketIds`.
 *
 * Stage 2's ANN candidate filter uses this purely as a membership guard:
 * `findANNNeighbors` returns markets with an embedding, but embeddings are
 * produced in a separate pipeline step from features, so a neighbor can
 * exist without a features row. The filter drops candidates whose either
 * side is unfeaturized.
 *
 * The projection is deliberately minimal (market_id only): loading the full
 * row set (many JSONB columns, none of which the call site consumes) is a
 * reliable way to blow `statement_timeout` at cold-start scale.
 */
export async function loadFeaturizedMarketIds(marketIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (marketIds.length === 0) return out;
  for (let i = 0; i < marketIds.length; i += ID_CHUNK) {
    const chunk = marketIds.slice(i, i + ID_CHUNK);
    const rows = await query<{ market_id: number }>(
      `SELECT market_id FROM market_features WHERE market_id = ANY($1::int[])`,
      [chunk],
    );
    for (const r of rows) out.add(r.market_id);
  }
  return out;
}
