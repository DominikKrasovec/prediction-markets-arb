/**
 * PostgreSQL connection and data persistence for Polymarket data
 */

import { bulkUpsert } from '@arb/db';
import { BaseScraperPostgresService } from '../base-postgres.js';
import type { PolymarketMarket, PolymarketEvent } from './types.js';

class PostgresService extends BaseScraperPostgresService {
  protected readonly label = 'polymarket';

  async saveMarkets(markets: PolymarketMarket[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(markets) || !markets.length) return 0;

    const now = new Date();
    const columns = ['condition_id', 'event_id', 'slug', 'active', 'closed', 'volume_num', 'raw', 'db_updated_at'];
    const rows = markets.map(m => [
      m.conditionId,
      m.eventId || null,
      m.slug || null,
      m.active ?? true,
      m.closed ?? false,
      m.volumeNum || 0,
      JSON.stringify(m),
      now,
    ]);
    return await bulkUpsert(pool, 'polymarket_markets', ['condition_id'], columns, rows);
  }

  async saveEvents(events: PolymarketEvent[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(events) || !events.length) return 0;

    const now = new Date();
    const columns = ['id', 'slug', 'raw', 'db_updated_at'];
    const rows = events.map(e => [
      e.id,
      e.slug || null,
      JSON.stringify(e),
      now,
    ]);
    return await bulkUpsert(pool, 'polymarket_events', ['id'], columns, rows);
  }

  async getActiveMarkets(limit = 1000) {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      `SELECT raw, db_created_at, db_updated_at FROM polymarket_markets
       WHERE active = true AND closed = false
       ORDER BY volume_num DESC LIMIT $1`,
      [limit]
    );
    return rows.map(r => ({ ...r.raw, dbCreatedAt: r.db_created_at, dbUpdatedAt: r.db_updated_at }));
  }

  async getMarket(conditionId: string) {
    const pool = this.requirePool();
    const { rows } = await pool.query(
      `SELECT raw, db_created_at, db_updated_at FROM polymarket_markets WHERE condition_id = $1`,
      [conditionId]
    );
    if (!rows.length) return null;
    return { ...rows[0].raw, dbCreatedAt: rows[0].db_created_at, dbUpdatedAt: rows[0].db_updated_at };
  }

  async getStats() {
    const pool = this.requirePool();
    const [markets, events] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM polymarket_markets'),
      pool.query('SELECT COUNT(*) as c FROM polymarket_events'),
    ]);
    return {
      markets: parseInt(markets.rows[0].c),
      events: parseInt(events.rows[0].c),
    };
  }

  /**
   * Returns true iff a row for the given event id already exists.
   * Used by the WSS lifecycle handler before issuing a single-event REST
   * fetch — avoids a fetch+upsert round trip per WSS market when the event
   * is already known (e.g. a sibling market arrived earlier in the session).
   */
  async hasEvent(eventId: string): Promise<boolean> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM polymarket_events WHERE id = $1) AS exists`,
      [eventId],
    );
    return rows[0]?.exists ?? false;
  }
}

const dbService = new PostgresService();
export { dbService };
