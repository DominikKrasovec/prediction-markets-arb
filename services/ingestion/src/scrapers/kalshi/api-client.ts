/**
 * Kalshi REST API client
 *
 * Production base URL : https://api.elections.kalshi.com/trade-api/v2
 * Demo base URL       : https://demo-api.kalshi.co/trade-api/v2
 *
 * NOTE: Despite the "elections" subdomain, the production URL covers ALL
 * Kalshi markets (economics, climate, sports, entertainment, etc.).
 *
 * Public endpoints (markets/events/orderbook) do NOT require auth.
 * Authenticated endpoints (portfolio, orders) require KALSHI-* headers.
 *
 * Rate limits (Basic tier):
 *   Read:  200 tokens/s  (most GET endpoints cost 10 tokens)
 *   Write: 100 tokens/s
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { createAuthHeaders, hasKalshiCredentials } from '@arb/kalshi-auth';
import { withRetry, createRateLimiter } from '../http-utils.js';
import {
  PARLAY_TICKER_RX,
  type KalshiEvent,
  type KalshiMarket,
  type FetchEventsOptions,
  type FetchMarketsOptions,
} from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('kalshi-api');

// ─── Configuration ───────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2';
}

function createAxiosInstance(): AxiosInstance {
  const instance = axios.create({
    baseURL: getBaseUrl(),
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Add auth headers dynamically when credentials are available
  if (hasKalshiCredentials()) {
    instance.interceptors.request.use((config) => {
      const method = (config.method ?? 'GET').toUpperCase();
      // The base URL is https://…/trade-api/v2 so the full path is:
      //   /trade-api/v2 + config.url  (config.url is relative, e.g. "/markets")
      const relativePath = config.url ?? '/';
      const basePathPrefix = new URL(getBaseUrl()).pathname; // "/trade-api/v2"
      const fullPath = basePathPrefix + relativePath.split('?')[0];
      const authHeaders = createAuthHeaders(method, fullPath);
      config.headers.set('KALSHI-ACCESS-KEY', authHeaders['KALSHI-ACCESS-KEY']);
      config.headers.set('KALSHI-ACCESS-TIMESTAMP', authHeaders['KALSHI-ACCESS-TIMESTAMP']);
      config.headers.set('KALSHI-ACCESS-SIGNATURE', authHeaders['KALSHI-ACCESS-SIGNATURE']);
      return config;
    });
  }

  return instance;
}

// Lazily-created singleton
let _client: AxiosInstance | null = null;
export function getClient(): AxiosInstance {
  if (!_client) _client = createAxiosInstance();
  return _client;
}

// ─── Per-platform config ────────────────────────────────────────────────────
// Kalshi docs say 200 tokens/s (Basic tier), 10 tokens/GET → 20 req/s.
// In practice, the bucket refills at ~100 tokens/s (not 200), so the
// sustained limit is ~10 req/s. We use 8 req/s to leave headroom.
// The rate limiter is module-level so ALL Kalshi requests in this process
// (scraper + resolution monitor) share the same budget.
const RETRY_OPTS = { label: '[kalshi]', baseDelayMs: 500, maxDelayMs: 32_000, maxRetries: 6 };
const throttle = createRateLimiter(15);

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Fetch all (or filtered) Kalshi events using cursor-based pagination.
 *
 * Pass `status: 'open'` to fetch only currently active events.
 * Leave `status` null to fetch all events (open, closed, settled).
 */
export async function fetchEvents(options: FetchEventsOptions = {}): Promise<{ totalEvents: number; totalMarkets: number }> {
  const {
    limit = 200,
    status = null,
    series_ticker = null,
    maxEvents = null,
    onBatch = null,
  } = options;

  const client = getClient();
  let totalEvents = 0;
  let totalMarkets = 0;
  let cursor: string | null = null;
  let hasMore = true;

  log.info(`Fetching Kalshi events (limit=${limit}, status=${status ?? 'all'})…`);

  while (hasMore) {
    // Server-side parlay exclusion — same rationale as fetchMarkets (KXMVE
    // universe explosion); the client-side filter below stays as backstop.
    const params: Record<string, any> = { limit, mve_filter: 'exclude' };
    if (cursor) params.cursor = cursor;
    if (status) params.status = status;
    if (series_ticker) params.series_ticker = series_ticker;

    const response = await withRetry(() => throttle(() => client.get('/events', { params })), RETRY_OPTS);
    const data = response.data as { events: Record<string, unknown>[]; cursor: string };

    const rawEvents = data.events ?? [];
    // End-of-pagination uses the UNFILTERED page length: a page that is all
    // parlays still has a cursor and must not terminate the crawl early.
    if (rawEvents.length === 0) { hasMore = false; break; }

    // Drop KXMVE* combination-parlay events before mapping (earliest skip —
    // the bulk endpoint can't exclude them server-side, so the bytes arrive
    // regardless, but we do no per-row work for them).
    const keptEvents = rawEvents.filter(
      (e) => !PARLAY_TICKER_RX.test(String(e.event_ticker ?? ''))
          && !PARLAY_TICKER_RX.test(String(e.series_ticker ?? '')),
    );
    const batchEvents: KalshiEvent[] = keptEvents.map(mapEvent);
    // NOTE: /events does NOT embed markets — fetch markets separately via fetchMarkets()
    const batchMarkets: KalshiMarket[] = [];

    totalEvents += batchEvents.length;
    totalMarkets += batchMarkets.length;

    if (onBatch) await onBatch(batchEvents, batchMarkets);

    cursor = data.cursor || null;
    if (!cursor) { hasMore = false; break; }
    if (maxEvents !== null && totalEvents >= maxEvents) { hasMore = false; break; }
  }

  return { totalEvents, totalMarkets };
}

// ─── Markets ─────────────────────────────────────────────────────────────────

/**
 * Fetch markets with cursor-based pagination.
 *
 * Filter by event_ticker, series_ticker, and/or status.
 */
export async function fetchMarkets(options: FetchMarketsOptions = {}): Promise<{ totalMarkets: number }> {
  const {
    limit = 1000,
    status = null,
    event_ticker = null,
    series_ticker = null,
    tickers = null,
    maxMarkets = null,
    onBatch = null,
  } = options;

  const client = getClient();
  let totalMarkets = 0;
  let cursor: string | null = null;
  let hasMore = true;

  // Per-call log removed — progress is reported by the caller every N series.

  while (hasMore) {
    // mve_filter=exclude: drop multivariate-event (KXMVE* combination-parlay)
    // markets SERVER-side. Kalshi's parlay universe exploded by 2026-07 to the
    // point that unfiltered status=open pages were ~1000/1000 parlays (~3 real
    // markets per page, 270+ pages for <1k keepers — 2026-07-10 e2e test).
    // Verified live: with the filter, pages come back 1000/1000 real markets.
    // PARLAY_TICKER_RX below stays as a client-side backstop.
    const params: Record<string, any> = { limit, mve_filter: 'exclude' };
    if (cursor) params.cursor = cursor;
    if (status) params.status = status;
    if (event_ticker) params.event_ticker = event_ticker;
    if (series_ticker) params.series_ticker = series_ticker;
    if (tickers && tickers.length > 0) params.tickers = tickers.join(',');

    const response = await withRetry(() => throttle(() => client.get('/markets', { params })), RETRY_OPTS);
    const data = response.data as { markets: Record<string, unknown>[]; cursor: string };

    const rawMarkets = data.markets ?? [];
    // End-of-pagination uses the UNFILTERED page length: a page that is all
    // parlays still has a cursor and must not terminate the crawl early.
    if (rawMarkets.length === 0) { hasMore = false; break; }

    // Drop KXMVE* combination-parlay markets before mapping (earliest skip —
    // the bulk endpoint can't exclude them server-side, so the bytes arrive
    // regardless, but we do no per-row work for them).
    const keptMarkets = rawMarkets.filter(
      (m) => !PARLAY_TICKER_RX.test(String(m.ticker ?? ''))
          && !PARLAY_TICKER_RX.test(String(m.event_ticker ?? '')),
    );
    const batch: KalshiMarket[] = keptMarkets.map((m) => mapMarket(m));
    totalMarkets += batch.length;

    if (onBatch) await onBatch(batch);

    cursor = data.cursor || null;
    if (!cursor) { hasMore = false; break; }
    if (maxMarkets !== null && totalMarkets >= maxMarkets) { hasMore = false; break; }
  }

  return { totalMarkets };
}

/** Shape of `GET /markets/{ticker}/orderbook` — only the field we read. */
type OrderbookResponse = {
  orderbook_fp?: {
    yes_dollars: [string, string][];
    no_dollars: [string, string][];
  } | null;
};

/**
 * Fetch a single market's REST orderbook snapshot.
 * Returns null on error (market not found, etc.)
 */
export async function fetchOrderbook(ticker: string): Promise<{ yes_dollars: [string, string][]; no_dollars: [string, string][] } | null> {
  try {
    const client = getClient();
    const response = await withRetry(() => throttle(() => client.get(`/markets/${encodeURIComponent(ticker)}/orderbook`)), RETRY_OPTS);
    return (response.data as OrderbookResponse).orderbook_fp ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single Kalshi event by ticker. Returns the parsed `KalshiEvent`
 * (mapped through the same `mapEvent` shape used by the bulk path) or null
 * on 404 / network failure. Uses the shared rate-limited singleton client so
 * WSS-driven event lookups share the same token bucket as the bulk scraper.
 *
 * The endpoint is `GET /events/{event_ticker}` per Kalshi v2 docs.
 */
export async function fetchEventByTicker(eventTicker: string): Promise<KalshiEvent | null> {
  try {
    const client = getClient();
    const response = await withRetry(
      () => throttle(() => client.get(`/events/${encodeURIComponent(eventTicker)}`)),
      RETRY_OPTS,
    );
    const raw = (response.data as { event?: Record<string, unknown> })?.event;
    if (!raw) return null;
    return mapEvent(raw);
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    log.error(`fetchEventByTicker(${eventTicker}) failed:`, err?.message ?? err);
    return null;
  }
}

// ─── Series ────────────────────────────────────────────────────────────────

/**
 * Per-process cache of series_ticker → series title (or null when the series
 * has no title / the fetch 404s). The Kalshi `/series/{ticker}` object is
 * static recurring metadata, and many events share one series, so caching the
 * title coalesces what would otherwise be one REST call per event into one per
 * distinct series for the whole process lifetime.
 *
 * `null` is a *negative* cache entry (looked up, none found) so we don't re-hit
 * the endpoint every batch; a transient network error is NOT cached (we return
 * undefined and leave the key unset so a later call retries).
 */
const seriesTitleCache = new Map<string, string | null>();

/**
 * Fetch a Kalshi series' human-readable `title` via `GET /series/{ticker}`.
 *
 * This title is the slug source for the canonical Kalshi *option* deep-link:
 * the website path is `/markets/<series>/<event-web-slug>/<event_ticker>` and
 * the middle `<event-web-slug>` is `slugify(series.title)` — NOT derived from
 * the event's own `title`/`sub_title` (which can differ, e.g. series
 * "WHO WILL BE PLAYING WHAT IN AVENGERS DOOMSDAY" →
 * `who-will-be-playing-what-in-avengers-doomsday`, while the event title is
 * "Avengers: Doomsday: Cast"). A wrong middle segment makes Kalshi redirect to
 * its own slug and DROP the `op_market_ticker` query param, so we must capture
 * this exact field. We store the raw title (slugify happens at render time).
 *
 * Returns the title string, or `null` if the series exists but has no title,
 * or `undefined` on network/transient failure (caller leaves it uncaptured).
 */
export async function fetchSeriesTitle(seriesTicker: string): Promise<string | null | undefined> {
  if (!seriesTicker) return undefined;
  if (seriesTitleCache.has(seriesTicker)) return seriesTitleCache.get(seriesTicker);
  try {
    const client = getClient();
    const response = await withRetry(
      () => throttle(() => client.get(`/series/${encodeURIComponent(seriesTicker)}`)),
      RETRY_OPTS,
    );
    const series = (response.data as { series?: Record<string, unknown> })?.series;
    const title = series && typeof series.title === 'string' && series.title.length > 0
      ? series.title
      : null;
    seriesTitleCache.set(seriesTicker, title); // caches both hits and confirmed-empty
    return title;
  } catch (err: any) {
    if (err?.response?.status === 404) {
      seriesTitleCache.set(seriesTicker, null); // confirmed absent — negative cache
      return null;
    }
    // Transient failure: leave the key unset so a later call retries.
    log.error(`fetchSeriesTitle(${seriesTicker}) failed:`, err?.message ?? err);
    return undefined;
  }
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

// Raw API rows are `Record<string, unknown>` (true API boundary). Each mapper
// is the single point where we narrow the unknown blob into the typed
// `KalshiEvent` / `KalshiMarket` shape — no `any` leaks past these functions.

function mapEvent(raw: Record<string, unknown>): KalshiEvent {
  const tags = raw.tags;
  return {
    event_ticker: String(raw.event_ticker ?? ''),
    series_ticker: (raw.series_ticker as string | null) ?? null,
    title: String(raw.title ?? ''),
    category: String(raw.category ?? ''),
    status: String(raw.status ?? ''),
    open_time: (raw.open_time as string | null) ?? null,
    close_time: (raw.close_time as string | null) ?? null,
    expected_expiration_time: (raw.expected_expiration_time as string | null) ?? null,
    tags: Array.isArray(tags) ? (tags as string[]) : [],
    raw,
  };
}

function mapMarket(raw: Record<string, unknown>, eventTickerFallback?: string): KalshiMarket {
  return {
    ticker: String(raw.ticker ?? ''),
    event_ticker: (raw.event_ticker as string | undefined) ?? eventTickerFallback ?? '',
    series_ticker: (raw.series_ticker as string | null) ?? null,
    title: String(raw.title ?? ''),
    subtitle: (raw.subtitle as string | null) ?? null,
    status: (raw.status as KalshiMarket['status']) ?? 'closed', // absent status = treat as dead, never fake-active
    yes_bid_dollars: (raw.yes_bid_dollars as string | null) ?? null,
    yes_ask_dollars: (raw.yes_ask_dollars as string | null) ?? null,
    no_bid_dollars: (raw.no_bid_dollars as string | null) ?? null,
    no_ask_dollars: (raw.no_ask_dollars as string | null) ?? null,
    last_price_dollars: (raw.last_price_dollars as string | null) ?? null,
    volume_fp: (raw.volume_fp as string | null) ?? null,
    volume_24h_fp: (raw.volume_24h_fp as string | null) ?? null,
    open_interest_fp: (raw.open_interest_fp as string | null) ?? null,
    close_time: (raw.close_time as string | null) ?? null,
    expiration_time: (raw.expiration_time as string | null) ?? null,
    settlement_value_dollars: (raw.settlement_value_dollars as string | null) ?? null,
    settlement_ts: (raw.settlement_ts as string | null) ?? null,
    rules_primary: (raw.rules_primary as string | null) ?? null,
    result: (raw.result as string | null) ?? null,
    raw,
  };
}
