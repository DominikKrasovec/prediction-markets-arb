/**
 * Stage 2a — classifies `threshold_series` grouping_type from normalized child
 * shapes, acting only on events the native classifiers left 'unknown'. Gate:
 * `subjects = 1 OR skeletons = 1` (rungs must be one ladder for monotonic
 * implication edges to be sound). Idempotent.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { beltHit } from '../discriminators/telemetry.js';

const log = createLogger('stage2a-classify');

/** Kinds whose children can all resolve YES independently — kept tight to unambiguous
 *  families; a possible winner/one-hot kind stays 'unknown' absent a native mutex proof. */
const CO_OCCURRABLE_KINDS: readonly string[] = [
  'player_prop_threshold',
  'match_total_metric',
  'match_spread',
  'both_teams_score',
  'stage_advance',
  'token_launch',
];

/** Gated by IS DISTINCT FROM so the populatePlatformEvents MIN()-aggregate can't
 *  revert the verdict to 'unknown'. */
export const MEMBER_STAMP_THRESHOLD_SQL =
  `UPDATE markets m
      SET grouping_type = 'threshold_series'
     FROM (SELECT unnest($1::text[]) AS platform, unnest($2::text[]) AS peid) v
    WHERE m.platform = v.platform
      AND m.platform_event_id = v.peid
      AND m.grouping_type IS DISTINCT FROM 'threshold_series'`;

/** Promotes only when rungs form a single monotone ladder: one subject (or one
 *  title-skeleton), >=2 distinct values, >=80% threshold-shaped, single direction, no non-ladder rung. */
export const PROMOTE_THRESHOLD_SERIES_SQL =
  `WITH ch AS (
     SELECT pe.id AS pe_id,
            n.canonical_subject AS subj,
            regexp_replace(lower(m.title), '[0-9][0-9.,]*', '#', 'g') AS skel,
            n.condition_shape AS shape, n.value_primary AS val,
            n.condition_direction AS dir
     FROM platform_events pe
     JOIN markets m ON m.platform = pe.platform
                   AND m.platform_event_id = pe.platform_event_id
     JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE pe.grouping_type = 'unknown'
   ),
   agg AS (
     SELECT pe_id,
            count(*) AS n,
            count(*) FILTER (WHERE shape IN ('monotonic_threshold','range_snapshot','point_in_time')) AS thresh,
            count(DISTINCT subj) AS subjects,
            count(DISTINCT skel) AS skeletons,
            count(DISTINCT val) FILTER (WHERE val IS NOT NULL) AS distinct_vals,
            count(DISTINCT dir) FILTER (WHERE dir IN ('above','below')) AS dir_ab,
            count(*) FILTER (WHERE dir NOT IN ('above','below') OR dir IS NULL OR val IS NULL) AS non_ladder
     FROM ch GROUP BY pe_id
   )
   UPDATE platform_events pe
      SET grouping_type = 'threshold_series', updated_at = NOW()
     FROM agg
    WHERE pe.id = agg.pe_id
      AND agg.n >= 2
      AND (agg.subjects = 1 OR (agg.skeletons = 1 AND agg.n >= 3))
      AND agg.distinct_vals >= 2
      AND agg.thresh::float / agg.n >= 0.8
      AND agg.dir_ab = 1
      AND agg.non_ladder = 0
   RETURNING pe.platform, pe.platform_event_id`;

/** A Kalshi pe whose children are all categorical_outcome boolean destinations with
 *  distinct yes_sub_titles and one shared subject is categorical_exclusive, not N free questions. */
export const PROMOTE_DESTINATION_CATEGORICAL_SQL =
  `WITH ch AS (
     SELECT pe.id AS pe_id, n.canonical_subject AS subj, mr.raw->>'yes_sub_title' AS yst,
            n.condition_shape AS shape, n.value_primary AS val, n.condition_metric AS metric
     FROM platform_events pe
     JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
     JOIN market_metadata_raw mr ON mr.market_id = m.id
     JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE pe.grouping_type = 'unknown' AND pe.platform = 'kalshi'
   ),
   agg AS (
     SELECT pe_id, count(*) AS n,
            count(*) FILTER (WHERE shape = 'categorical_outcome') AS cat,
            count(*) FILTER (WHERE metric = 'boolean') AS boolean_metric,
            count(*) FILTER (WHERE val IS NOT NULL) AS val_present,
            count(DISTINCT subj) AS subjects,
            count(DISTINCT yst) FILTER (WHERE yst IS NOT NULL) AS distinct_yst
     FROM ch GROUP BY pe_id
   )
   UPDATE platform_events pe SET grouping_type = 'categorical_exclusive', updated_at = NOW()
     FROM agg WHERE pe.id = agg.pe_id
       AND agg.n >= 2 AND agg.cat = agg.n AND agg.boolean_metric = agg.n
       AND agg.val_present = 0 AND agg.subjects = 1 AND agg.distinct_yst = agg.n
   RETURNING pe.platform, pe.platform_event_id`;

export const MEMBER_STAMP_CATEGORICAL_SQL =
  `UPDATE markets m
      SET grouping_type = 'categorical_exclusive'
     FROM (SELECT unnest($1::text[]) AS platform, unnest($2::text[]) AS peid) v
    WHERE m.platform = v.platform
      AND m.platform_event_id = v.peid
      AND m.grouping_type IS DISTINCT FROM 'categorical_exclusive'`;

export async function classifyDestinationCategoricalFromShapes(): Promise<number> {
  const promoted = await query<{ platform: string; platform_event_id: string }>(
    PROMOTE_DESTINATION_CATEGORICAL_SQL,
  );
  if (promoted.length > 0) {
    await query(
      MEMBER_STAMP_CATEGORICAL_SQL,
      [promoted.map((r) => r.platform), promoted.map((r) => r.platform_event_id)],
    );
  }
  if (promoted.length > 0) {
    log.info(`Stage 2a classify: ${promoted.length} 'unknown' Kalshi events → 'categorical_exclusive' (multi-destination, AUD-07), members stamped`);
  }
  return promoted.length;
}

/** mutually_exclusive='true' proves one-of-n settlement (<=1 YES) -> categorical_exclusive.
 *  Never emits sum=1 by itself; finalize's certifier still gates exhaustivity. */
export const PROMOTE_NATIVE_MUTEX_CATEGORICAL_SQL =
  `UPDATE platform_events pe
      SET grouping_type = 'categorical_exclusive', updated_at = NOW()
     FROM kalshi_events ke
    WHERE pe.platform = 'kalshi'
      AND pe.grouping_type = 'unknown'
      AND pe.platform_event_id = 'kalshi:event:' || ke.event_ticker
      AND pe.platform_event_id !~ '(?i)MENTION|SAY|KXMVE'
      AND ke.raw->>'mutually_exclusive' = 'true'
      AND (SELECT count(*) FROM markets m
             WHERE m.platform = 'kalshi' AND m.platform_event_id = pe.platform_event_id) >= 2
   RETURNING pe.platform, pe.platform_event_id`;

/** mutually_exclusive='false' proves independent selection -> bundle_nonexclusive. */
export const PROMOTE_NATIVE_MUTEX_BUNDLE_SQL =
  `UPDATE platform_events pe
      SET grouping_type = 'bundle_nonexclusive', updated_at = NOW()
     FROM kalshi_events ke
    WHERE pe.platform = 'kalshi'
      AND pe.grouping_type = 'unknown'
      AND pe.platform_event_id = 'kalshi:event:' || ke.event_ticker
      AND pe.platform_event_id !~ '(?i)MENTION|SAY|KXMVE'
      AND ke.raw->>'mutually_exclusive' = 'false'
      AND (SELECT count(*) FROM markets m
             WHERE m.platform = 'kalshi' AND m.platform_event_id = pe.platform_event_id) >= 2
   RETURNING pe.platform, pe.platform_event_id`;

export async function classifyNativeMutexFromKalshi(): Promise<{ categorical: number; bundle: number }> {
  const cat = await query<{ platform: string; platform_event_id: string }>(
    PROMOTE_NATIVE_MUTEX_CATEGORICAL_SQL,
  );
  if (cat.length > 0) {
    await query(MEMBER_STAMP_CATEGORICAL_SQL, [cat.map((r) => r.platform), cat.map((r) => r.platform_event_id)]);
  }
  const bun = await query<{ platform: string; platform_event_id: string }>(
    PROMOTE_NATIVE_MUTEX_BUNDLE_SQL,
  );
  if (bun.length > 0) {
    await query(MEMBER_STAMP_BUNDLE_SQL, [bun.map((r) => r.platform), bun.map((r) => r.platform_event_id)]);
  }
  if (cat.length > 0 || bun.length > 0) {
    log.info(`Stage 2a classify: P-GROUP §3.7 native-mutex — ${cat.length} kalshi 'unknown' → categorical_exclusive (mutually_exclusive='true'), ${bun.length} → bundle_nonexclusive ('false'), members stamped`);
  }
  return { categorical: cat.length, bundle: bun.length };
}

/** Two subtractive arms: (a) kind-heterogeneous (>=2 distinct event_kinds — can't be
 *  one-hot), (b) kind-homogeneous + co-occurrable ({@link CO_OCCURRABLE_KINDS}). */
export const PROMOTE_SHAPED_BUNDLE_SQL =
  `WITH ch AS (
     SELECT pe.id AS pe_id, n.condition_shape AS shape, n.event_kind AS kind
     FROM platform_events pe
     JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
     JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE pe.grouping_type = 'unknown'
   ),
   agg AS (
     SELECT pe_id,
            count(*) AS n,
            count(*) FILTER (WHERE shape IS NOT NULL) AS shaped,
            count(DISTINCT kind) FILTER (WHERE kind IS NOT NULL) AS kinds,
            count(*) FILTER (WHERE kind IS NOT NULL AND kind <> ALL($1::text[])) AS bad_kinds
     FROM ch GROUP BY pe_id
   )
   UPDATE platform_events pe
      SET grouping_type = 'bundle_nonexclusive', updated_at = NOW()
     FROM agg
    WHERE pe.id = agg.pe_id
      AND agg.n >= 2
      AND agg.shaped = agg.n
      AND (agg.kinds >= 2 OR (agg.kinds = 1 AND agg.bad_kinds = 0))
   RETURNING pe.platform, pe.platform_event_id`;

export const MEMBER_STAMP_BUNDLE_SQL =
  `UPDATE markets m
      SET grouping_type = 'bundle_nonexclusive'
     FROM (SELECT unnest($1::text[]) AS platform, unnest($2::text[]) AS peid) v
    WHERE m.platform = v.platform
      AND m.platform_event_id = v.peid
      AND m.grouping_type IS DISTINCT FROM 'bundle_nonexclusive'`;

export async function classifyShapedBundleFromShapes(): Promise<number> {
  const promoted = await query<{ platform: string; platform_event_id: string }>(
    PROMOTE_SHAPED_BUNDLE_SQL,
    [CO_OCCURRABLE_KINDS],
  );
  if (promoted.length > 0) {
    await query(
      MEMBER_STAMP_BUNDLE_SQL,
      [promoted.map((r) => r.platform), promoted.map((r) => r.platform_event_id)],
    );
    log.info(`Stage 2a classify: ${promoted.length} 'unknown' events → 'bundle_nonexclusive' (P-GROUP §3.7 c2: hetero / co-occurrable shaped), members stamped`);
  }
  return promoted.length;
}

/** Recall telemetry: multi-child (>=2) platform_events still 'unknown' after all reclassifiers ran. */
export async function censusGroupingUnknownMultichild(): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
        SELECT pe.id
        FROM platform_events pe
        JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
        WHERE pe.grouping_type = 'unknown'
        GROUP BY pe.id HAVING count(m.id) >= 2
     ) s`,
  );
  const n = Number(r[0]?.n ?? 0);
  for (let i = 0; i < n; i++) beltHit('grouping_unknown_multichild');
  log.info(`Stage 2a classify: belt.grouping_unknown_multichild=${n} (multi-child PEs left 'unknown')`);
  return n;
}

export async function classifyThresholdSeriesFromShapes(): Promise<number> {
  const promoted = await query<{ platform: string; platform_event_id: string }>(
    PROMOTE_THRESHOLD_SERIES_SQL,
  );
  const n = promoted.length;

  // Without this, the next sync's MIN()-aggregate would revert pe.grouping_type on upsert.
  if (n > 0) {
    await query(
      MEMBER_STAMP_THRESHOLD_SQL,
      [promoted.map((r) => r.platform), promoted.map((r) => r.platform_event_id)],
    );
  }

  log.info(`Stage 2a classify: ${n} 'unknown' events → 'threshold_series' (single-subject monotonic ladders), member markets stamped`);
  await classifyDestinationCategoricalFromShapes();
  await classifyNativeMutexFromKalshi();
  await classifyShapedBundleFromShapes();
  await censusGroupingUnknownMultichild();
  return n;
}
