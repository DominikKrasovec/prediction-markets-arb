/**
 * One-off backfill: populates llm_market_normalizations.league_id for
 * existing Kalshi sports markets by re-running
 * resolveKalshiCompetitionToLeagueId.
 *
 * Scope: kalshi sports markets that have a kalshi_competition value and lmn
 * with NULL league_id. The first call per competition auto-seeds the league
 * + entity_relations 3-level link (with proper sport linkage); subsequent
 * markets hit the T1 cache.
 *
 * Usage:
 *   PG_HOST=localhost PG_PORT=5433 PG_USER=arb PG_PASSWORD=arb_local_dev \
 *     PG_DATABASE=prediction_arb \
 *     npx tsx services/pipeline/src/scripts/backfill-kalshi-league-id.ts
 *
 * Side effects:
 *   - UPDATE llm_market_normalizations.league_id for matched rows
 *   - INSERT into known_entities for any missing league canonicals
 *   - INSERT into entity_relations (parent=league, child=sport, part_of)
 */
import { query, endPool } from '@arb/db';
import { resolveKalshiCompetitionToLeagueId } from '../stage1-normalize/kalshi-deterministic.js';
import { createLogger } from '@arb/logger';

const log = createLogger('backfill-kalshi-league-id');

interface Row {
  market_id: number;
  competition: string;
}

async function main(): Promise<void> {
  const t0 = Date.now();

  // 1) Distinct competitions among markets needing league_id. Resolving each
  //    competition once (auto-seeding on first miss) is the slow part; we then
  //    bulk-UPDATE per competition value.
  const competitions = await query<{ competition: string; markets: number }>(`
    SELECT ke.raw->'product_metadata'->>'competition' AS competition,
           COUNT(*) AS markets
    FROM markets m
    JOIN market_metadata_raw mr ON mr.market_id = m.id
    JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker'
    JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
    WHERE m.platform = 'kalshi'
      AND m.category_unified = 'sports'
      AND lmn.league_id IS NULL
      AND ke.raw->'product_metadata'->>'competition' IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`);

  log.info(`Found ${competitions.length} distinct competitions covering ${competitions.reduce((s, r) => s + Number(r.markets), 0)} markets`);

  let updatedRows = 0;
  let resolvedCompetitions = 0;
  let unresolvedCompetitions = 0;

  for (const c of competitions) {
    const leagueId = await resolveKalshiCompetitionToLeagueId(c.competition);
    if (leagueId == null) {
      unresolvedCompetitions++;
      log.info(`UNRESOLVED "${c.competition}" (${c.markets} markets) — not in curated map or sport missing`);
      continue;
    }
    resolvedCompetitions++;

    // Bulk update all markets for this competition value
    const res = await query<{ updated: number }>(`
      WITH updated AS (
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
      [leagueId, c.competition]);
    const n = res[0]?.updated ?? 0;
    updatedRows += n;
    log.info(`"${c.competition}" → league_id=${leagueId} : updated ${n} rows`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Done. ${resolvedCompetitions} competitions resolved, ${unresolvedCompetitions} unresolved. Total rows updated: ${updatedRows}. Elapsed: ${elapsed}s`);

  await endPool();
}

main().catch((err) => {
  log.error(`Backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
