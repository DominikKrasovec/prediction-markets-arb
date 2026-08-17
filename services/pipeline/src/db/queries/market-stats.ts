/**
 * Queries for market discovery / resolution statistics.
 *
 * `captureMarketSnapshot()` writes one row per platform into
 * `platform_market_snapshots`; called by live-monitor on its stats tick.
 */
import { query } from '@arb/db';
import type { Platform } from '@arb/types';

// Row shape written into platform_market_snapshots.
interface MarketSnapshot {
  id?: number;
  captured_at?: Date;
  platform: Platform;
  total_count: number;
  open_count: number;
  resolved_count: number;
  winner_fill_rate: number | null;
}

/**
 * Compute current counts for all 4 platforms from the `markets` table and
 * insert one snapshot row per platform into `platform_market_snapshots`.
 *
 * Called by the live-monitor stats timer (roughly once per hour).
 */
export async function captureMarketSnapshot(): Promise<MarketSnapshot[]> {
  const rows = await query<{
    platform: Platform;
    total_count: string;
    open_count: string;
    resolved_count: string;
    winner_fill_rate: string | null;
  }>(`
    SELECT
      platform,
      COUNT(*)::INT                                          AS total_count,
      COUNT(*) FILTER (WHERE resolved_at IS NULL)::INT      AS open_count,
      COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::INT  AS resolved_count,
      ROUND(
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND winning_outcome IS NOT NULL)::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0),
        4
      )                                                      AS winner_fill_rate
    FROM markets
    WHERE platform IN ('kalshi','polymarket','limitless','predict')
    GROUP BY platform
    ORDER BY platform
  `);

  if (rows.length === 0) return [];

  // Batch insert all platform rows in one query
  const values: unknown[] = [];
  const placeholders: string[] = [];
  rows.forEach((r, i) => {
    const base = i * 5;
    placeholders.push(
      `($${base + 1}, $${base + 2}::INT, $${base + 3}::INT, $${base + 4}::INT, $${base + 5})`
    );
    values.push(
      r.platform,
      parseInt(r.total_count, 10),
      parseInt(r.open_count, 10),
      parseInt(r.resolved_count, 10),
      r.winner_fill_rate !== null ? parseFloat(r.winner_fill_rate) : null
    );
  });

  await query(
    `INSERT INTO platform_market_snapshots
       (platform, total_count, open_count, resolved_count, winner_fill_rate)
     VALUES ${placeholders.join(', ')}`,
    values
  );

  return rows.map(r => ({
    platform: r.platform,
    total_count: parseInt(r.total_count, 10),
    open_count: parseInt(r.open_count, 10),
    resolved_count: parseInt(r.resolved_count, 10),
    winner_fill_rate: r.winner_fill_rate !== null ? parseFloat(r.winner_fill_rate) : null,
  }));
}

