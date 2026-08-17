/**
 * Limitless Exchange market scraper.
 */

import { dbService } from './postgres.js';
import { fetchActiveMarkets } from './api-client.js';
import type { Scraper } from '../base.js';
import { createLogger } from '@arb/logger';

const log = createLogger('limitless-scraper');

/**
 * Scrape only active CLOB markets and persist to DB (fast periodic cycle).
 */
export async function scrapeActive(): Promise<number> {
  log.info('\n=== Scraping Active CLOB Markets ===\n');

  let totalSaved = 0;

  await fetchActiveMarkets({
    clobOnly: true,
    onBatch: async (markets) => {
      const saved = await dbService.saveMarkets(markets);
      totalSaved += saved;
    },
  });

  log.info(`✓ Saved ${totalSaved} active CLOB markets to PostgreSQL`);
  return totalSaved;
}

/**
 * Scrape ALL market types (clob + amm + group).
 */
export async function scrapeAllMarkets(): Promise<number> {
  log.info('\n=== Scraping All Markets ===\n');

  let totalSaved = 0;

  await fetchActiveMarkets({
    clobOnly: false,
    onBatch: async (markets) => {
      const saved = await dbService.saveMarkets(markets);
      totalSaved += saved;
    },
  });

  log.info(`✓ Saved ${totalSaved} total markets to PostgreSQL`);
  return totalSaved;
}

/**
 * Full scrape: all market types (clob + amm + group).
 * Note: Limitless API only exposes active markets — there is no resolved-markets endpoint.
 */
export async function fullScrape(): Promise<void> {
  log.info('\nStarting full scrape (all market types)…');
  await scrapeAllMarkets();
  await dbService.getStats();
  log.info('Full scrape done.');
}

export const scraper: Scraper = {
  platform: 'limitless',
  db: dbService,
  scrapeActive,
  fullScrape,
};
