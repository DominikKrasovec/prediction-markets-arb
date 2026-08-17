/**
 * PostgreSQL persistence for Kalshi scraper data
 */

import { bulkUpsert } from '@arb/db';
import { BaseScraperPostgresService } from '../base-postgres.js';
import { createLogger } from '@arb/logger';
import { fetchSeriesTitle } from './api-client.js';
import { PARLAY_TICKER_RX, type KalshiEvent, type KalshiMarket } from './types.js';

const log = createLogger('kalshi-db');

// Combination parlays are dropped at fetch time in api-client.ts (earliest
// skip). These saveMarkets/saveEvents filters are a backstop for any other
// caller (WSS lifecycle, single-event fetches) so a KXMVE row can never reach
// kalshi_markets / kalshi_events. See PARLAY_TICKER_RX in types.ts.

class PostgresService extends BaseScraperPostgresService {
  protected readonly label = 'kalshi';

  async saveEvents(events: KalshiEvent[]): Promise<number> {
    const pool = this.requirePool();
    if (!events.length) return 0;

    // Parlay safeguard (tier 1): never persist KXMVE* combination-parlay events.
    const kept = events.filter(
      (e) => !PARLAY_TICKER_RX.test(e.event_ticker) && !PARLAY_TICKER_RX.test(e.series_ticker ?? ''),
    );
    const skipped = events.length - kept.length;
    if (skipped > 0) log.info(`skipped ${skipped} KXMVE parlay event(s)`);
    if (!kept.length) return 0;
    events = kept;

    // Capture the series title into each event's raw blob under `series_title`.
    // This is the slug source for the canonical Kalshi *option* deep-link: the
    // website path is /markets/<series>/<event-web-slug>/<event_ticker>, where
    // <event-web-slug> = slugify(series.title) (NOT the event's own title —
    // those can diverge). Without the exact slug, Kalshi redirects and drops the
    // ?op_market_ticker param. Stored raw (not pre-slugified) so the render
    // layer owns slugification. The `/series` fetch is cached per-process and
    // deduped per distinct series, so this adds ~one REST call per new series
    // (events sharing a series cost nothing). Transient series-fetch failures
    // leave `series_title` absent — the row is still saved, fully backward
    // compatible; the option-URL builder falls back to the event-level form.
    await this.enrichSeriesTitles(events);

    const now = new Date();
    const columns = ['event_ticker', 'series_ticker', 'status', 'category', 'raw', 'db_updated_at'];
    const rows = events.map((e) => [
      e.event_ticker,
      e.series_ticker ?? null,
      e.status ?? null,
      e.category ?? null,
      JSON.stringify(e.raw),
      now,
    ]);
    return bulkUpsert(pool, 'kalshi_events', ['event_ticker'], columns, rows);
  }

  /**
   * Mutates each event's `raw` blob in place, adding `raw.series_title` (the
   * Kalshi series-level title) when it can be resolved. See the call site in
   * `saveEvents` for why this is the canonical option-deep-link slug source.
   *
   * Resolution order per event:
   *   1. `raw.series_ticker` (preferred) → fall back to `series_ticker` field.
   *   2. If the series ticker EQUALS the event ticker (one-off events whose
   *      event_ticker == series ticker, e.g. KXROLEINPRODUCTIONDOOMSDAY), the
   *      series title still lives on the /series object, so we still fetch it.
   *
   * Distinct series are fetched once (the api-client caches per-process), so a
   * batch of N events across K series costs at most K `/series` calls. A failed
   * or title-less series simply leaves `series_title` unset.
   */
  private async enrichSeriesTitles(events: KalshiEvent[]): Promise<void> {
    // Group events by their resolved series ticker so we fetch each series once.
    const bySeries = new Map<string, KalshiEvent[]>();
    for (const e of events) {
      const seriesTicker =
        (e.raw?.series_ticker as string | undefined) || e.series_ticker || '';
      if (!seriesTicker) continue;
      const list = bySeries.get(seriesTicker);
      if (list) list.push(e);
      else bySeries.set(seriesTicker, [e]);
    }

    for (const [seriesTicker, group] of bySeries) {
      let title: string | null | undefined;
      try {
        title = await fetchSeriesTitle(seriesTicker);
      } catch (err: any) {
        // Defensive: fetchSeriesTitle already swallows errors, but never let a
        // metadata-enrichment failure abort the (more important) event upsert.
        log.warn(`series_title fetch failed for ${seriesTicker}: ${err?.message ?? err}`);
        title = undefined;
      }
      if (typeof title !== 'string') continue; // null/undefined → leave unset
      for (const e of group) {
        if (e.raw && typeof e.raw === 'object') {
          (e.raw as Record<string, unknown>).series_title = title;
        }
      }
    }
  }

  async saveMarkets(markets: KalshiMarket[]): Promise<number> {
    const pool = this.requirePool();
    if (!markets.length) return 0;

    // Parlay safeguard (tier 1): never persist KXMVE* combination-parlay markets.
    const kept = markets.filter(
      (m) => !PARLAY_TICKER_RX.test(m.ticker) && !PARLAY_TICKER_RX.test(m.event_ticker),
    );
    const skipped = markets.length - kept.length;
    if (skipped > 0) log.info(`skipped ${skipped} KXMVE parlay market(s)`);
    if (!kept.length) return 0;
    markets = kept;

    const now = new Date();
    const columns = [
      'ticker', 'event_ticker', 'status',
      'yes_bid', 'yes_ask',
      'volume', 'raw', 'db_updated_at',
    ];
    const rows = markets.map((m) => [
      m.ticker,
      m.event_ticker,
      m.status,
      m.yes_bid_dollars ? parseFloat(m.yes_bid_dollars) : null,
      m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
      m.volume_fp ? parseFloat(m.volume_fp) : 0,
      // raw = pre-transform API blob (m.raw), NOT the typed KalshiMarket object.
      // Downstream SQL (platform-groups.ts, sync.ts) reads snake_case fields
      // (e.g. event_ticker, series_ticker) from this JSON.
      // Contrast: polymarket/limitless/predict store the post-transform object.
      JSON.stringify(m.raw),
      now,
    ]);
    return bulkUpsert(pool, 'kalshi_markets', ['ticker'], columns, rows);
  }

  /**
   * Returns the distinct series_tickers for all Kalshi markets currently
   * tracked in the unified `markets` table. Used by scrapeActive to discover
   * new events within each series on every cycle.
   */
  async getTrackedSeriesTickers(): Promise<string[]> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ series_ticker: string }>(`
      SELECT DISTINCT ke.series_ticker
      FROM   kalshi_markets km
      JOIN   markets m  ON m.platform_id = km.ticker AND m.platform = 'kalshi'
      JOIN   kalshi_events ke ON ke.event_ticker = km.event_ticker
    `);
    return rows.map((r) => r.series_ticker);
  }

  /**
   * Returns true iff a row for the given event_ticker already exists in
   * `kalshi_events`. Used by the WSS lifecycle handler and `scrapeActive`
   * to decide whether a single-event REST fetch is needed (avoiding a
   * round-trip per market when most events are already known).
   */
  async hasEvent(eventTicker: string): Promise<boolean> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM kalshi_events WHERE event_ticker = $1) AS exists`,
      [eventTicker],
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Returns the set of event_tickers already stored. Used by the bulk
   * scraper to compute `unseen = scrapedTickers \ knownTickers` cheaply
   * (one query, server-side filter) instead of N existence probes.
   */
  async getKnownEventTickers(): Promise<Set<string>> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ event_ticker: string }>(
      `SELECT event_ticker FROM kalshi_events`,
    );
    return new Set(rows.map((r) => r.event_ticker));
  }
}

export const dbService = new PostgresService();
