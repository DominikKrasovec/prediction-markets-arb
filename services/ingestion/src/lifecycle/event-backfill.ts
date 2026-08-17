/**
 * Lifecycle event-backfill helpers.
 *
 * When a WSS market_created push arrives, the lifecycle watcher writes a row
 * to the platform-specific markets table immediately — but the parent event
 * row is NOT in the WSS payload for either Kalshi (`event_ticker` only) or
 * Polymarket (`event_id` only, no embedded title/category). Without a parent
 * event row, downstream `enrichMarketCategoriesFromEvents` produces NULL
 * category, `populatePlatformEvents` falls back to the market question text
 * as the event title, and Stage 1b's LLM input is degraded.
 *
 * This module makes a single REST follow-up call to the platform's events
 * endpoint via the existing rate-limited singleton clients, then upserts the
 * row. The (`hasEvent` → fetch → save) path is short-circuited on cache hits,
 * so a typical session only fetches once per distinct event_ticker / eventId.
 *
 * In-process LRU caches are used to coalesce simultaneous WSS bursts of N
 * markets sharing the same event into a single REST call.
 */

import { dbService as kalshiDb } from '../scrapers/kalshi/postgres.js';
import { dbService as polyDb } from '../scrapers/polymarket/postgres.js';
import { fetchEventByTicker } from '../scrapers/kalshi/api-client.js';
import { fetchEventById } from '../scrapers/polymarket/api-client.js';
import { createLogger } from '@arb/logger';

const log = createLogger('event-backfill');

// ─── Per-process caches ─────────────────────────────────────────────────────

const KALSHI_CACHE_MAX = 5_000;
const POLY_CACHE_MAX   = 5_000;

/** Set of Kalshi event_tickers known to exist in the DB or just upserted. */
const kalshiKnown = new Set<string>();
/** Set of Polymarket event ids known to exist in the DB or just upserted. */
const polyKnown   = new Set<string>();

/**
 * Map from event-key → in-flight Promise. Coalesces concurrent WSS arrivals
 * for the same event into a single REST fetch + upsert. Resolved promises
 * are removed; rejected promises are also removed so a transient failure
 * doesn't permanently block re-fetch on the next arrival.
 */
const kalshiInFlight = new Map<string, Promise<void>>();
const polyInFlight   = new Map<string, Promise<void>>();

function rememberLRU(set: Set<string>, key: string, max: number): void {
  if (set.size >= max) {
    // Cheap LRU approximation: drop the oldest insertion.
    const firstKey = set.values().next().value;
    if (firstKey !== undefined) set.delete(firstKey);
  }
  set.add(key);
}

// ─── Kalshi ────────────────────────────────────────────────────────────────

/**
 * Ensure a `kalshi_events` row exists for `eventTicker`. Idempotent / safe to
 * call from the WSS hot path: the in-process cache short-circuits >99% of
 * calls, the DB existence probe handles process restarts, and concurrent
 * calls for the same ticker share a single REST round-trip.
 *
 * Failures (REST 4xx/5xx, missing event) are logged and swallowed — the
 * subsequent `runSync()` will simply fall back to the market title for the
 * platform_events row, exactly as before this function existed.
 */
export async function ensureKalshiEvent(eventTicker: string): Promise<void> {
  if (!eventTicker) return;
  if (kalshiKnown.has(eventTicker)) return;

  const inFlight = kalshiInFlight.get(eventTicker);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      if (await kalshiDb.hasEvent(eventTicker)) {
        rememberLRU(kalshiKnown, eventTicker, KALSHI_CACHE_MAX);
        return;
      }
      const ev = await fetchEventByTicker(eventTicker);
      if (!ev) return; // 404 / network error already logged
      await kalshiDb.saveEvents([ev]);
      rememberLRU(kalshiKnown, eventTicker, KALSHI_CACHE_MAX);
    } catch (err: any) {
      log.error(
        `[kalshi] ensureKalshiEvent(${eventTicker}) failed:`,
        err?.message ?? err,
      );
    } finally {
      kalshiInFlight.delete(eventTicker);
    }
  })();

  kalshiInFlight.set(eventTicker, promise);
  return promise;
}

/**
 * Bulk version: given a batch of distinct event_tickers, fetch+upsert any
 * that aren't already in `kalshi_events`. Used by the bulk scraper after
 * `saveMarkets()` to backfill events for newly-seen tickers in one pass.
 */
export async function ensureKalshiEventsBatch(eventTickers: string[]): Promise<number> {
  if (eventTickers.length === 0) return 0;
  const distinct = Array.from(new Set(eventTickers.filter(Boolean)));
  if (distinct.length === 0) return 0;

  // One DB query for the whole set instead of N existence probes.
  const known = await kalshiDb.getKnownEventTickers();
  const missing = distinct.filter((t) => !known.has(t));

  // Mark already-in-DB tickers as cached so they short-circuit on the WSS
  // hot path. We DO NOT blanket-cache every distinct ticker: a 404 / network
  // error on a missing ticker must remain re-fetchable, otherwise a transient
  // propagation delay between Kalshi creating the market and exposing its
  // event row would permanently suppress backfill for that event_ticker
  // for the entire process lifetime.
  for (const t of distinct) {
    if (known.has(t)) rememberLRU(kalshiKnown, t, KALSHI_CACHE_MAX);
  }
  if (missing.length === 0) return 0;

  // Sequential fetch — the singleton client's token-bucket throttle already
  // paces these. A parallel Promise.all would all wait on the same bucket.
  let saved = 0;
  for (const ticker of missing) {
    const ev = await fetchEventByTicker(ticker).catch(() => null);
    if (!ev) continue; // leave uncached so a later call can retry
    saved += await kalshiDb.saveEvents([ev]).catch(() => 0);
    rememberLRU(kalshiKnown, ticker, KALSHI_CACHE_MAX);
  }
  return saved;
}

// ─── Polymarket ────────────────────────────────────────────────────────────

/**
 * Ensure a `polymarket_events` row exists for `eventId`. Same semantics as
 * `ensureKalshiEvent` — see that docstring for the rationale.
 */
export async function ensurePolymarketEvent(eventId: string): Promise<void> {
  if (!eventId) return;
  if (polyKnown.has(eventId)) return;

  const inFlight = polyInFlight.get(eventId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      if (await polyDb.hasEvent(eventId)) {
        rememberLRU(polyKnown, eventId, POLY_CACHE_MAX);
        return;
      }
      const ev = await fetchEventById(eventId).catch(() => null);
      if (!ev) return;
      await polyDb.saveEvents([ev]);
      rememberLRU(polyKnown, eventId, POLY_CACHE_MAX);
    } catch (err: any) {
      log.error(
        `[polymarket] ensurePolymarketEvent(${eventId}) failed:`,
        err?.message ?? err,
      );
    } finally {
      polyInFlight.delete(eventId);
    }
  })();

  polyInFlight.set(eventId, promise);
  return promise;
}
