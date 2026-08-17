/**
 * Kalshi Scraper — Type Definitions
 *
 * Kalshi hierarchy:
 *   Series (e.g. "KXHIGHNY")
 *     └─ Events (e.g. "KXHIGHNY-24JAN01")
 *          └─ Markets (e.g. "KXHIGHNY-24JAN01-T60")
 *
 * Series are static metadata about a recurring contract type.
 * Events represent one instance of that series on a specific date/scenario.
 * Markets are the binary YES/NO tradeable contracts within an event.
 */

// ─── Combination-parlay filter ───────────────────────────────────────────────

/**
 * Kalshi publishes multi-leg combination parlays ("yes A, yes B, no C") under
 * the `KXMVE*` series (KXMVESPORTS, KXMVECROSS, …). They are book-stitched and
 * unprofitable and are dropped from the whole pipeline (decision 2026-05-29).
 *
 * Proven complete + safe against the live DB: every Kalshi market whose ticker
 * starts with `KXMVE` is a parlay, and zero single-leg keepers share the prefix.
 *
 * NOTE: Kalshi's bulk `/markets` + `/events` endpoints have no server-side
 * "exclude" filter, so parlays still arrive over the wire on the global crawl;
 * we drop them as early as possible (right after each page, before mapping) in
 * api-client.ts, with a backstop filter in postgres.ts `saveMarkets`/`saveEvents`.
 */
export const PARLAY_TICKER_RX = /^KXMVE/i;

// ─── Series ──────────────────────────────────────────────────────────────────

export interface KalshiSeries {
  ticker: string;
  frequency: string;
  title: string;
  category: string;
  tags: string[];
  settlement_sources: string[];
  // raw
  raw: Record<string, unknown>;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * NOTE on the `raw` column contract — Kalshi differs from polymarket/predict.
 *
 * postgres.ts stores `JSON.stringify(m.raw)` (the original API blob ONLY),
 * NOT `JSON.stringify(m)` (the typed wrapper). Downstream SQL consumers read
 * snake_case API fields directly (e.g. `mm.raw->>'event_ticker'`,
 * `mm.raw->>'settlement_timestamp'`). The Kalshi API already uses snake_case
 * matching the column expectations, so storing the wrapper would be a no-op
 * structural change while doubling the on-disk footprint.
 *
 * Do NOT change Kalshi's postgres.ts to `JSON.stringify(m)` without verifying
 * every `kalshi_markets.raw` / `kalshi_events.raw` reader still resolves
 * its fields correctly — the wrapped form would nest the API blob under a
 * `raw` subkey.
 */
export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string | null;
  title: string;
  category: string;
  status: string;
  open_time: string | null;
  close_time: string | null;
  expected_expiration_time: string | null;
  tags: string[];
  // raw
  raw: Record<string, unknown>;
}

// ─── Markets ─────────────────────────────────────────────────────────────────

/**
 * Market status values in API RESPONSES. Distinct from the QUERY-param enum
 * (`unopened|open|paused|closed|settled`): querying status=open returns
 * markets whose response status is 'active', settled ones come back
 * 'finalized'/'determined' (Kalshi docs Market schema, re-verified live
 * 2026-07-10 — the old response vocabulary matching the query enum is gone).
 */
export type KalshiMarketStatus =
  | 'initialized' | 'inactive' | 'active' | 'paused' | 'closed'
  | 'determined' | 'disputed' | 'amended' | 'finalized';

/** The QUERY-param status enum (GET /markets|/events `status=`) — unchanged by
 *  Kalshi; distinct from the response vocabulary above. */
export type KalshiMarketStatusQuery = 'unopened' | 'open' | 'paused' | 'closed' | 'settled';

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string | null;
  title: string;
  subtitle: string | null;
  status: KalshiMarketStatus;
  yes_bid_dollars: string | null;
  yes_ask_dollars: string | null;
  no_bid_dollars: string | null;
  no_ask_dollars: string | null;
  last_price_dollars: string | null;
  volume_fp: string | null;
  volume_24h_fp: string | null;
  open_interest_fp: string | null;
  close_time: string | null;
  expiration_time: string | null;
  settlement_value_dollars: string | null;
  settlement_ts: string | null;
  rules_primary: string | null;
  result: string | null;
  // raw
  raw: Record<string, unknown>;
}

// ─── API params ──────────────────────────────────────────────────────────────

export interface FetchEventsOptions {
  limit?: number;
  status?: string | null;
  series_ticker?: string | null;
  maxEvents?: number | null;
  onBatch?: ((events: KalshiEvent[], markets: KalshiMarket[]) => Promise<void>) | null;
}

export interface FetchMarketsOptions {
  limit?: number;
  status?: KalshiMarketStatusQuery | null;
  event_ticker?: string | null;
  series_ticker?: string | null;
  tickers?: string[] | null;
  maxMarkets?: number | null;
  onBatch?: ((markets: KalshiMarket[]) => Promise<void>) | null;
}
