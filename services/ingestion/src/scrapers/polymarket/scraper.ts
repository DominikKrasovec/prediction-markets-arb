/**
 * Main scraper for fetching Polymarket data and storing to PostgreSQL
 */

import { dbService } from './postgres.js';
import * as apiClient from './api-client.js';
import type { Scraper } from '../base.js';
import { createLogger } from '@arb/logger';

const log = createLogger('polymarket-scraper');

// ─── Active (open) markets only ──────────────────────────────────────────────

async function scrapeActive(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Scraping Active Events & Markets ===\n');

  try {
    let totalEventsSaved = 0;
    let totalMarketsSaved = 0;

    const { totalEvents, totalMarkets } = await apiClient.fetchEvents({
      limit: 1000,
      active: true,
      closed: false,
      onBatch: async (events, markets) => {
        if (events.length > 0) totalEventsSaved += await dbService.saveEvents(events);
        if (markets.length > 0) totalMarketsSaved += await dbService.saveMarkets(markets);
      },
    });

    log.info(`✓ Fetched: ${totalEvents} events, ${totalMarkets} markets (active)`);
    log.info(`✓ Saved:   ${totalEventsSaved} events, ${totalMarketsSaved} markets`);
    return { totalEvents, totalMarkets };
  } catch (error: any) {
    log.error('Error scraping active markets:', error.message);
    throw error;
  }
}

// ─── Resolved (closed) markets only ─────────────────────────────────────────

async function scrapeResolved(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Scraping Resolved (Closed) Events & Markets ===\n');

  try {
    let totalEventsSaved = 0;
    let totalMarketsSaved = 0;

    const { totalEvents, totalMarkets } = await apiClient.fetchEvents({
      limit: 1000,
      active: false,
      closed: true,
      onBatch: async (events, markets) => {
        if (events.length > 0) totalEventsSaved += await dbService.saveEvents(events);
        if (markets.length > 0) totalMarketsSaved += await dbService.saveMarkets(markets);
      },
    });

    log.info(`✓ Fetched: ${totalEvents} events, ${totalMarkets} markets (resolved)`);
    log.info(`✓ Saved:   ${totalEventsSaved} events, ${totalMarketsSaved} markets`);
    return { totalEvents, totalMarkets };
  } catch (error: any) {
    log.error('Error scraping resolved markets:', error.message);
    throw error;
  }
}

// ─── All markets (active + historical) ───────────────────────────────────────

async function scrapeAll(): Promise<{ totalEvents: number; totalMarkets: number }> {
  log.info('\n=== Scraping ALL Events & Markets ===\n');

  try {
    let totalEventsSaved = 0;
    let totalMarketsSaved = 0;
    let activeMarkets = 0;
    let closedMarkets = 0;
    let archivedMarkets = 0;

    const { totalEvents, totalMarkets } = await apiClient.fetchEvents({
      limit: 1000,
      maxEvents: null,
      active: null,
      closed: null,
      onBatch: async (events, markets) => {
        if (events.length > 0) totalEventsSaved += await dbService.saveEvents(events);

        if (markets.length > 0) {
          totalMarketsSaved += await dbService.saveMarkets(markets);
          activeMarkets  += markets.filter((m: any) => m.active && !m.closed).length;
          closedMarkets  += markets.filter((m: any) => m.closed).length;
          archivedMarkets += markets.filter((m: any) => m.archived).length;
        }
      },
    });

    log.info(`✓ Fetched: ${totalEvents} events, ${totalMarkets} markets`);
    log.info(`✓ Saved:   ${totalEventsSaved} events, ${totalMarketsSaved} markets`);
    log.info(`  Active: ${activeMarkets}  Closed: ${closedMarkets}  Archived: ${archivedMarkets}`);
    return { totalEvents, totalMarkets };
  } catch (error: any) {
    log.error('Error scraping all events:', error.message);
    throw error;
  }
}

// ─── Full scrape entry point ──────────────────────────────────────────────────

async function fullScrape(): Promise<void> {
  log.info('\nStarting full scrape (all statuses)…');

  const startTime = Date.now();
  try {
    await scrapeAll();

    const stats = await dbService.getStats();
    log.info(`\nMarkets: ${stats.markets}  Events: ${stats.events}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log.info(`Full scrape completed in ${duration}s`);
  } catch (error: any) {
    log.error('Full scrape failed:', error.message);
    throw error;
  }
}

async function showStats(): Promise<void> {
  const stats = await dbService.getStats();
  log.info(`Markets: ${stats.markets}  Events: ${stats.events}`);
}

export { scrapeActive, scrapeResolved, scrapeAll, fullScrape, showStats };

export const scraper: Scraper = {
  platform: 'polymarket',
  db: dbService,
  scrapeActive,
  fullScrape,
};
