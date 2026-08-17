/**
 * Shared connect/disconnect/isAvailable boilerplate for every scraper's
 * `postgres.ts`. Subclasses only implement the platform-specific
 * `saveX()` / read-helper methods.
 *
 * Behavioral notes preserved from the four prior implementations:
 *   - `connect()` is idempotent (no-op when already connected).
 *   - `disconnect()` calls @arb/db's `endPool()` (the pool is shared across
 *     all scrapers — `endPool()` shuts it down process-wide).
 *   - `isAvailable()` is true iff we've successfully connected AND the pool
 *     reference is still non-null.
 *   - The success log is `✓ PostgreSQL connected: <label>` to match the
 *     pre-refactor format that operators grep for.
 */
import type { Pool } from 'pg';
import { getPool, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('db');

export abstract class BaseScraperPostgresService {
  pool: Pool | null = null;
  isConnected = false;

  /** Human-readable platform label used in connect/disconnect logs. */
  protected abstract readonly label: string;

  async connect(): Promise<void> {
    if (this.isConnected) return;
    try {
      this.pool = getPool();
      await this.pool.query('SELECT 1');
      this.isConnected = true;
      log.info(`PostgreSQL connected: ${this.label}`);
    } catch (error: any) {
      log.error(`Failed to connect to PostgreSQL (${this.label}):`, error.message);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await endPool();
      this.pool = null;
      this.isConnected = false;
    }
  }

  isAvailable(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Throws if the pool isn't ready. Convenience for subclass methods that
   * need a non-null pool reference; previously each method open-coded the
   * `if (!this.isAvailable()) throw …` pattern.
   */
  protected requirePool(): Pool {
    if (!this.isAvailable()) throw new Error('PostgreSQL not connected');
    return this.pool!;
  }
}
