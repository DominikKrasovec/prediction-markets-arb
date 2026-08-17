/**
 * Main scraper for Kalshi — fetches events + markets, stores to PostgreSQL
 */

import 'dotenv/config';
import { dbService } from './postgres.js';
import * as apiClient from './api-client.js';
import type { Scraper } from '../base.js';
import { createLogger } from '@arb/logger';

const log = createLogger('kalshi-scraper');

// ─── Event scraping ───────────────────────────────────────────────────────────

async function scrapeActive(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Kalshi: Scraping Active (Open) Markets ===\n');

  // Single global paginated crawl: GET /markets?status=open&limit=1000
  //
  // Previously we made one request per tracked series (2633 calls), because
  // we assumed we needed per-series filtering to detect new markets. In
  // practice Kalshi returns ALL open markets via the global status=open
  // endpoint in ~50 pages of 1000, which is ~56× fewer requests.
  //
  // Benefits:
  //   • ~50 requests instead of 2633 — drops Kalshi from ~600s to ~10s
  //   • Automatically discovers brand-new series with no separate discovery pass
  //   • No per-series loop, no 429 pressure
  //   • The rate limiter is still active (module-level in api-client.ts)

  let totalMarketsSaved = 0;
  let totalEventsSaved = 0;
  let pagesSeen = 0;

  log.info('Fetching all open markets + events via global paginated crawl (limit=1000)…');

  let totalFetched = 0;

  // Run events + markets crawls in parallel — events provides the parent
  // metadata (title, category, series_ticker) that downstream
  // enrichMarketCategoriesFromEvents and populatePlatformEvents rely on.
  // Without it WSS-arrived markets share an event row that's silently
  // missing category, and Stage 1b falls back to using the market title as
  // the event title (degraded LLM input).
  await Promise.all([
    apiClient.fetchEvents({
      limit: 200,
      status: 'open',
      onBatch: async (events) => {
        if (events.length) totalEventsSaved += await dbService.saveEvents(events);
      },
    }),
    apiClient.fetchMarkets({
      limit: 1000,
      status: 'open',
      onBatch: async (markets) => {
        pagesSeen++;
        totalFetched += markets.length;

        // Kalshi creates thousands of speculative markets at every possible
        // price level, most of which are never traded. Only save markets that
        // have actual trading activity or at least a non-zero bid/ask so we
        // don't bloat the DB and pipeline with hundreds of thousands of phantom
        // markets (zero volume, zero OI, zero bid).
        const withActivity = markets.filter((m) =>
          parseFloat(m.yes_bid_dollars ?? '0') > 0 ||
          parseFloat(m.yes_ask_dollars ?? '0') > 0 ||
          parseFloat(m.volume_fp ?? '0') > 0 ||
          parseFloat(m.open_interest_fp ?? '0') > 0
        );

        if (withActivity.length) totalMarketsSaved += await dbService.saveMarkets(withActivity);
        if (pagesSeen % 10 === 0) {
          log.info(`Progress: page ${pagesSeen}, ${totalMarketsSaved}/${totalFetched} markets saved (with activity) so far…`);
        }
      },
    }),
  ]);

  log.info(`\n✓ Kalshi: ${totalEventsSaved} events, ${totalMarketsSaved} active markets saved out of ${totalFetched} fetched (${pagesSeen} pages)`);
  return { totalEvents: totalEventsSaved, totalMarkets: totalMarketsSaved };
}

async function scrapeResolved(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Kalshi: Scraping Settled (Resolved) Events & Markets ===\n');

  let totalEventsSaved = 0;
  let totalMarketsSaved = 0;

  const [eventsResult, marketsResult] = await Promise.all([
    apiClient.fetchEvents({
      limit: 200,
      status: 'settled',
      onBatch: async (events) => {
        if (events.length) totalEventsSaved += await dbService.saveEvents(events);
      },
    }),
    apiClient.fetchMarkets({
      limit: 1000,
      status: 'settled',
      onBatch: async (markets) => {
        if (markets.length) totalMarketsSaved += await dbService.saveMarkets(markets);
      },
    }),
  ]);

  log.info(`✓ Fetched: ${eventsResult.totalEvents} events, ${marketsResult.totalMarkets} markets (settled)`);
  log.info(`✓ Saved:   ${totalEventsSaved} events, ${totalMarketsSaved} markets`);
  return { totalEvents: totalEventsSaved, totalMarkets: totalMarketsSaved };
}

async function scrapeAll(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Kalshi: Scraping ALL Events & Markets ===\n');

  let totalEventsSaved = 0;
  let totalMarketsSaved = 0;
  let openMarkets = 0;
  let closedMarkets = 0;
  let settledMarkets = 0;

  const [eventsResult, marketsResult] = await Promise.all([
    apiClient.fetchEvents({
      limit: 200,
      status: null,
      onBatch: async (events) => {
        if (events.length) totalEventsSaved += await dbService.saveEvents(events);
      },
    }),
    apiClient.fetchMarkets({
      limit: 1000,
      status: null,
      onBatch: async (markets) => {
        if (markets.length) {
          totalMarketsSaved += await dbService.saveMarkets(markets);
          // Response-vocabulary statuses (query 'open' ⇒ response 'active',
          // settled ⇒ 'finalized'/'determined') — the old literals counted 0.
          openMarkets    += markets.filter((m) => m.status === 'active').length;
          closedMarkets  += markets.filter((m) => m.status === 'closed').length;
          settledMarkets += markets.filter((m) => m.status === 'finalized' || m.status === 'determined').length;
        }
      },
    }),
  ]);

  log.info(`✓ Fetched: ${eventsResult.totalEvents} events, ${marketsResult.totalMarkets} markets`);
  log.info(`✓ Saved:   ${totalEventsSaved} events, ${totalMarketsSaved} markets`);
  log.info(`  Open: ${openMarkets}  Closed: ${closedMarkets}  Settled: ${settledMarkets}`);
  return { totalEvents: totalEventsSaved, totalMarkets: totalMarketsSaved };
}

// ─── Open-only discovery scrape ──────────────────────────────────────────────

/**
 * Crawls all currently open Kalshi events + markets (no series filter).
 *
 * Cheaper than fullScrape: skips closed/settled history entirely.
 * Used by the monitor every DISCOVERY_INTERVAL_CYCLES to pick up brand-new
 * series that scrapeActive (which only loops over already-tracked series)
 * would otherwise miss.
 */
export async function scrapeOpenDiscovery(): Promise<void> {
  log.info('\n[kalshi] Starting open-only discovery scrape…');

  let totalEventsSaved = 0;
  let totalMarketsSaved = 0;

  await Promise.all([
    apiClient.fetchEvents({
      limit: 200,
      status: 'open',
      onBatch: async (events) => {
        if (events.length) totalEventsSaved += await dbService.saveEvents(events);
      },
    }),
    apiClient.fetchMarkets({
      limit: 1000,
      status: 'open',
      onBatch: async (markets) => {
        if (markets.length) totalMarketsSaved += await dbService.saveMarkets(markets);
      },
    }),
  ]);

  log.info(`Discovery scrape done: ${totalEventsSaved} events, ${totalMarketsSaved} markets saved.`);
}

// ─── Full scrape entry point ──────────────────────────────────────────────────

export async function fullScrape(): Promise<void> {
  log.info('\nStarting full scrape (all statuses)…');
  try {
    await scrapeAll();
    log.info('Full scrape done.');
  } catch (error: any) {
    log.error('Full scrape failed:', error.message);
    throw error;
  }
}

export { scrapeActive, scrapeResolved };

export const scraper: Scraper = {
  platform: 'kalshi',
  db: dbService,
  scrapeActive,
  fullScrape,
};

// ─── Standalone execution ─────────────────────────────────────────────────────

if (process.argv[1]?.replace(/\\/g, '/').includes('kalshi/scraper')) {
  (async () => {
    await dbService.connect();
    const arg = process.argv[2];
    if (arg === '--all') {
      await scrapeAll();
    } else if (arg === '--resolved') {
      await scrapeResolved();
    } else {
      await scrapeActive();
    }
    await dbService.disconnect();
  })().catch((err) => log.error('fatal:', err));
}
