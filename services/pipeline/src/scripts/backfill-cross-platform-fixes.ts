/**
 * One-shot backfill for three cross-platform-merging fixes shipped together:
 *
 *   1. Kalshi sports league_id from kalshi_events.product_metadata.competition
 *      — lifts coverage across non-parlay markets.
 *   2. Kalshi crypto hourly-candle HH:05 → HH:00 timestamp alignment
 *      — aligns CF Benchmarks publication time with Polymarket / Predict /
 *      Limitless's hour-boundary timestamps for the same candle.
 *   3. Polymarket / Limitless crypto resolution_source = 'CF Benchmarks'
 *      (Templates A and Q) and economic resolution_source = NULL
 *      — replaces the leaked code-path identifier ('text-deterministic-A')
 *      with the actual settlement-authority field so canonical_keys merge
 *      with Kalshi's KXBTC / KXETH / KXSOL price-ladder rows.
 *
 * Each fix is applied as a direct SQL UPDATE against `llm_market_normalizations`
 * — no re-normalization round-trip needed. The Stage 2 hash-key grouping that
 * runs after this script picks up the new canonical_keys and re-merges affected
 * markets into shared multi-platform questions.
 *
 * Run order:
 *   1. bun src/scripts/backfill-cross-platform-fixes.ts --dry-run    (preview)
 *   2. bun src/scripts/backfill-cross-platform-fixes.ts              (apply)
 *   3. Re-run the pipeline (the event graph re-projects questions in Stage 4) so
 *      the updated rows actually get re-grouped into the right questions.
 *
 * The script is idempotent — re-running it after a successful run is a no-op
 * (each UPDATE filters on the OLD field value so it only touches unmigrated rows).
 */
import { query } from '@arb/db';
import {
  KALSHI_COMPETITION_TO_LEAGUE,
  resolveKalshiCompetitionToLeagueId,
} from '../stage1-normalize/kalshi-deterministic.js';
import { createLogger } from '@arb/logger';

const log = createLogger('backfill-cross-platform-fixes');

const DRY_RUN = process.argv.includes('--dry-run');

// Hourly candle prefixes — must match HOURLY_CANDLE_CRYPTO_PREFIXES in
// kalshi-deterministic.ts. Duplicated here so the SQL filter is explicit and
// reviewable without import-spelunking. Update both together if it changes.
const HOURLY_CANDLE_PREFIX_SQL_LIST = [
  'KXBTC', 'KXBTCD',
  'KXETH', 'KXETHD',
  'KXSOL', 'KXSOLD', 'KXSOLE',
  'KXBNB', 'KXBNBD',
  'KXXRP', 'KXXRPD',
  'KXHYPE', 'KXHYPED',
  'KXDOGE', 'KXDOGED',
].map((s) => `'${s}'`).join(', ');

async function main(): Promise<void> {
  log.info({ dryRun: DRY_RUN }, 'starting backfill');

  // Step 1: Kalshi sports league_id backfill.
  //
  // For each distinct kalshi_events.product_metadata.competition value, look
  // up (and auto-seed if needed) the corresponding league entity via
  // resolveKalshiCompetitionToLeagueId, then UPDATE affected
  // llm_market_normalizations rows in one pass per competition.
  //
  // Excludes rows that already have league_id set: Kalshi's player-stat path
  // (KXNBAPTS / KXNBAREB / KXMLBHR / …) populates those via
  // PLAYER_STAT_SERIES_MAP and must not be overwritten.
  log.info('── Step 1: Kalshi sports league_id ─────────────────────────');

  const competitions = await query<{ competition: string; n_markets: number }>(
    `SELECT ke.raw->'product_metadata'->>'competition' AS competition,
            COUNT(*) AS n_markets
       FROM markets m
       JOIN market_metadata_raw mr ON mr.market_id = m.id
       JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker'
       JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
      WHERE m.platform = 'kalshi'
        AND m.category_unified = 'sports'
        AND lmn.league_id IS NULL
        AND ke.raw->'product_metadata'->>'competition' IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC`,
  );
  log.info({ distinct_competitions: competitions.length, total_markets: competitions.reduce((s, r) => s + Number(r.n_markets), 0) },
    'kalshi competitions with no league_id');

  // Map distinct competition strings → league_id (auto-seeding the KB).
  const compToLeagueId = new Map<string, number>();
  for (const { competition, n_markets } of competitions) {
    const inMap = KALSHI_COMPETITION_TO_LEAGUE[competition] != null;
    const id = await resolveKalshiCompetitionToLeagueId(competition);
    if (id == null) {
      log.warn({ competition, n_markets, in_map: inMap }, 'unmapped competition — markets stay with league_id=NULL');
      continue;
    }
    compToLeagueId.set(competition, id);
    log.info({ competition, league_id: id, n_markets }, 'resolved competition');
  }

  let leagueRowsUpdated = 0;
  if (!DRY_RUN) {
    for (const [competition, leagueId] of compToLeagueId) {
      const result = await query<{ updated: number }>(
        `WITH updated AS (
           UPDATE llm_market_normalizations lmn
              SET league_id = $1
            FROM markets m
            JOIN market_metadata_raw mr ON mr.market_id = m.id
            JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker'
            WHERE lmn.market_id = m.id
              AND m.platform = 'kalshi'
              AND m.category_unified = 'sports'
              AND lmn.league_id IS NULL
              AND ke.raw->'product_metadata'->>'competition' = $2
            RETURNING 1
         )
         SELECT COUNT(*)::int AS updated FROM updated`,
        [leagueId, competition],
      );
      const n = result[0]?.updated ?? 0;
      leagueRowsUpdated += n;
      if (n > 0) log.info({ competition, league_id: leagueId, rows: n }, 'updated');
    }
  }
  log.info({ dry_run: DRY_RUN, rows_updated: leagueRowsUpdated }, 'Step 1 complete');

  // Step 2: Kalshi crypto hourly-candle HH:05 → HH:00 alignment.
  //
  // CF Benchmarks publishes the hourly BTC / ETH / SOL / … index at HH:05:00Z;
  // Polymarket / Predict / Limitless tag the same candle at HH:00:00Z. Snap
  // condition_date back to the hour boundary for hourly-candle series only
  // (KXBTC, KXBTCD, KXETH, …), leaving 15-min (KXBTC15M @ HH:50) and
  // long-term (KXBTCMAX @ HH:59) markets untouched. Also flips
  // condition_date_precision 'minute' → 'hour' to match.
  log.info('── Step 2: Kalshi crypto HH:05 → HH:00 alignment ───────────');

  const previewStep2 = await query<{ n_markets: number }>(
    `SELECT COUNT(*)::int AS n_markets
       FROM markets m
       JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
      WHERE m.platform = 'kalshi'
        AND m.category_unified = 'crypto'
        AND lmn.condition_shape IN ('point_in_time','range_snapshot')
        AND split_part(m.platform_id, '-', 1) IN (${HOURLY_CANDLE_PREFIX_SQL_LIST})
        AND EXTRACT(MINUTE FROM lmn.condition_date::timestamptz) = 5
        AND EXTRACT(SECOND FROM lmn.condition_date::timestamptz) = 0`,
  );
  log.info({ markets_to_align: previewStep2[0]?.n_markets ?? 0 }, 'kalshi crypto markets at HH:05:00');

  let alignedRowsUpdated = 0;
  if (!DRY_RUN) {
    const r = await query<{ updated: number }>(
      // to_char with ISO 8601 mask preserves the format the runtime Stage 1
      // path emits (Date.toISOString()) — `2026-05-10T10:00:00Z`. The default
      // timestamptz::text cast would emit `2026-05-10 10:00:00+00` (space
      // separator, +00 instead of Z), which doesn't byte-match Polymarket's
      // ISO-formatted dates and would prevent the canonical_key merge.
      `WITH updated AS (
         UPDATE llm_market_normalizations lmn
            SET condition_date = to_char(
                  (lmn.condition_date::timestamptz - INTERVAL '5 minutes') AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ),
                condition_date_precision = 'hour',
                condition_date_source = COALESCE(lmn.condition_date_source, '') || ':aligned-hourly-candle'
          FROM markets m
          WHERE lmn.market_id = m.id
            AND m.platform = 'kalshi'
            AND m.category_unified = 'crypto'
            AND lmn.condition_shape IN ('point_in_time','range_snapshot')
            AND split_part(m.platform_id, '-', 1) IN (${HOURLY_CANDLE_PREFIX_SQL_LIST})
            AND EXTRACT(MINUTE FROM lmn.condition_date::timestamptz) = 5
            AND EXTRACT(SECOND FROM lmn.condition_date::timestamptz) = 0
            AND lmn.condition_date_source NOT LIKE '%aligned-hourly-candle%'
          RETURNING 1
       )
       SELECT COUNT(*)::int AS updated FROM updated`,
    );
    alignedRowsUpdated = r[0]?.updated ?? 0;
  }
  log.info({ dry_run: DRY_RUN, rows_updated: alignedRowsUpdated }, 'Step 2 complete');

  // Step 3a: Polymarket / Limitless / Predict crypto resolution_source = 'CF Benchmarks'.
  //
  // Templates A (price thresholds), Q (Limitless UTC-clock prices), and N
  // (candle direction "Up or Down" momentum bets) stamp resolution_source
  // with CF Benchmarks so canonical_keys carry the actual settlement-authority
  // field. 'text-deterministic-N' also appears on Predict rows (same template
  // engine via the cross-platform candidate query path); those already share
  // canonical_keys with the Polymarket / Limitless rows, so they continue to
  // merge among themselves after this UPDATE.
  log.info('── Step 3a: Polymarket/Limitless/Predict crypto → resolution_source=\'CF Benchmarks\' ─');

  const previewStep3a = await query<{ n_markets: number }>(
    `SELECT COUNT(*)::int AS n_markets
       FROM markets m
       JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
      WHERE m.platform IN ('polymarket', 'limitless', 'predict')
        AND m.category_unified = 'crypto'
        AND lmn.resolution_source IN ('text-deterministic-A', 'text-deterministic-Q', 'text-deterministic-N')`,
  );
  log.info({ markets_to_update: previewStep3a[0]?.n_markets ?? 0 }, 'crypto markets carrying leaked code-path tag');

  let cryptoResUpdated = 0;
  if (!DRY_RUN) {
    const r = await query<{ updated: number }>(
      `WITH updated AS (
         UPDATE llm_market_normalizations lmn
            SET resolution_source = 'CF Benchmarks'
          FROM markets m
          WHERE lmn.market_id = m.id
            AND m.platform IN ('polymarket', 'limitless', 'predict')
            AND m.category_unified = 'crypto'
            AND lmn.resolution_source IN ('text-deterministic-A', 'text-deterministic-Q', 'text-deterministic-N')
          RETURNING 1
       )
       SELECT COUNT(*)::int AS updated FROM updated`,
    );
    cryptoResUpdated = r[0]?.updated ?? 0;
  }
  log.info({ dry_run: DRY_RUN, rows_updated: cryptoResUpdated }, 'Step 3a complete');

  // Step 3b: Polymarket / Limitless non-crypto Template A → resolution_source=NULL.
  //
  // S&P 500, NASDAQ, Gold, oil etc.: Kalshi emits NULL resolutionSource for
  // KXNASDAQ / KXINXU / KXGOLD / KXWTI / KXBRENT (no named third-party
  // oracle), so Polymarket should also stamp NULL to align canonical_keys.
  log.info('── Step 3b: Polymarket/Limitless economic → resolution_source=NULL ──────');

  const previewStep3b = await query<{ n_markets: number }>(
    `SELECT COUNT(*)::int AS n_markets
       FROM markets m
       JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
      WHERE m.platform IN ('polymarket', 'limitless')
        AND m.category_unified = 'economic'
        AND lmn.resolution_source IN ('text-deterministic-A', 'text-deterministic-Q')`,
  );
  log.info({ markets_to_update: previewStep3b[0]?.n_markets ?? 0 }, 'economic markets carrying leaked code-path tag');

  let econResUpdated = 0;
  if (!DRY_RUN) {
    const r = await query<{ updated: number }>(
      `WITH updated AS (
         UPDATE llm_market_normalizations lmn
            SET resolution_source = NULL
          FROM markets m
          WHERE lmn.market_id = m.id
            AND m.platform IN ('polymarket', 'limitless')
            AND m.category_unified = 'economic'
            AND lmn.resolution_source IN ('text-deterministic-A', 'text-deterministic-Q')
          RETURNING 1
       )
       SELECT COUNT(*)::int AS updated FROM updated`,
    );
    econResUpdated = r[0]?.updated ?? 0;
  }
  log.info({ dry_run: DRY_RUN, rows_updated: econResUpdated }, 'Step 3b complete');

  // Summary
  log.info({
    dry_run: DRY_RUN,
    step1_league_id_updates: leagueRowsUpdated,
    step2_hh05_alignment_updates: alignedRowsUpdated,
    step3a_crypto_resolution_source_updates: cryptoResUpdated,
    step3b_economic_resolution_source_updates: econResUpdated,
  }, 'BACKFILL SUMMARY');

  if (DRY_RUN) {
    log.info('Dry run — no rows updated. Re-run without --dry-run to apply.');
  } else {
    log.info('Backfill complete. Now re-run the pipeline (Stage 4 re-projects questions) to regroup affected markets into shared questions.');
  }
}

main().catch((err) => {
  log.error({ err }, 'backfill failed');
  process.exit(1);
});
