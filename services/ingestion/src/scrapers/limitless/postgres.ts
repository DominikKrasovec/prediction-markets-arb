/**
 * PostgreSQL persistence for Limitless Exchange market data.
 */

import { bulkUpsert } from '@arb/db';
import { BaseScraperPostgresService } from '../base-postgres.js';
import type { LimitlessMarket } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('limitless-db');

class PostgresService extends BaseScraperPostgresService {
  protected readonly label = 'limitless';

  async saveMarkets(markets: LimitlessMarket[]): Promise<number> {
    const pool = this.requirePool();
    if (!markets.length) return 0;

    const now = new Date();
    const columns = [
      'slug', 'address', 'condition_id', 'trade_type',
      'status', 'expired', 'expiration_ts', 'volume_num',
      'raw', 'db_updated_at',
    ];
    const rows = markets.map(m => [
      m.slug,
      m.address ?? null,
      m.conditionId ?? null,
      m.tradeType ?? null,
      m.status ?? null,
      m.expired ?? false,
      m.expirationTimestamp ?? null,
      m.volume ? parseFloat(m.volume) / 1e6 : null, // USDC 6-dec → nominal
      // raw = post-transform LimitlessMarket object (camelCase field names).
      // Downstream SQL reads camelCase fields directly from this JSON.
      JSON.stringify(m),
      now,
    ]);
    return bulkUpsert(pool, 'limitless_markets', ['slug'], columns, rows);
  }

  async getActiveClob(limit = 1000): Promise<LimitlessMarket[]> {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      `SELECT raw FROM limitless_markets
       WHERE trade_type = 'clob' AND expired = FALSE AND status = 'FUNDED'
       ORDER BY volume_num DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
    return rows.map((r: any) => r.raw as LimitlessMarket);
  }

  async getStats(): Promise<void> {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      `SELECT trade_type, status, COUNT(*) AS cnt
       FROM limitless_markets
       GROUP BY trade_type, status
       ORDER BY cnt DESC`,
    );
    log.info('\nLimitless markets by type/status:');
    for (const r of rows) {
      log.info(`  ${r.trade_type} / ${r.status}: ${r.cnt}`);
    }
  }
}

export const dbService = new PostgresService();
