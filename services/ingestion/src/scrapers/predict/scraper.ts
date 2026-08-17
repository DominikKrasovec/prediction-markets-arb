/**
 * Main scraper for fetching Predict data and storing to PostgreSQL
 */

import 'dotenv/config';
import { dbService } from './postgres.js';
import * as apiClient from './api-client.js';
import { MarketStatus, CategorySortBy } from './types.js';
import type { Scraper } from '../base.js';
import { createLogger } from '@arb/logger';

const log = createLogger('predict-scraper');

async function scrapeCategories(): Promise<{ totalCategories: number; totalMarkets: number }> {
  log.info('\n=== Scraping All Categories (with Markets) ===\n');

  try {
    let totalCategoriesSaved = 0;
    let totalMarketsSaved = 0;

    const { totalCategories, totalMarkets } = await apiClient.fetchCategories({
      first: 50,
      maxCategories: null,
      status: null,
      sort: CategorySortBy.PUBLISHED_AT_DESC,
      onBatch: async (categories, markets) => {
        if (categories.length > 0) {
          const saved = await dbService.saveCategories(categories);
          totalCategoriesSaved += saved;
        }
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Total fetched: ${totalCategories} categories, ${totalMarkets} markets`);
    log.info(`✓ Saved to PostgreSQL: ${totalCategoriesSaved} categories, ${totalMarketsSaved} markets`);

    return { totalCategories, totalMarkets };
  } catch (error: any) {
    log.error('Error scraping categories:', error.message);
    throw error;
  }
}

async function scrapeActive(): Promise<{ totalCategoriesSaved: number; totalMarketsSaved: number }> {
  log.info('\n=== Scraping Active (Open) Categories & Markets ===\n');

  try {
    let totalCategoriesSaved = 0;
    let totalMarketsSaved = 0;

    await apiClient.fetchCategories({
      first: 50,
      status: MarketStatus.OPEN,
      sort: CategorySortBy.VOLUME_24H_DESC,
      onBatch: async (categories, markets) => {
        if (categories.length > 0) {
          const saved = await dbService.saveCategories(categories);
          totalCategoriesSaved += saved;
        }
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Saved ${totalCategoriesSaved} active categories, ${totalMarketsSaved} markets`);

    return { totalCategoriesSaved, totalMarketsSaved };
  } catch (error: any) {
    log.error('Error scraping active categories:', error.message);
    throw error;
  }
}

async function scrapeResolved(): Promise<{ totalCategoriesSaved: number; totalMarketsSaved: number }> {
  log.info('\n=== Scraping Resolved Categories & Markets ===\n');

  try {
    let totalCategoriesSaved = 0;
    let totalMarketsSaved = 0;

    await apiClient.fetchCategories({
      first: 50,
      status: MarketStatus.RESOLVED,
      sort: CategorySortBy.PUBLISHED_AT_DESC,
      onBatch: async (categories, markets) => {
        if (categories.length > 0) {
          const saved = await dbService.saveCategories(categories);
          totalCategoriesSaved += saved;
        }
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Saved ${totalCategoriesSaved} resolved categories, ${totalMarketsSaved} markets`);

    return { totalCategoriesSaved, totalMarketsSaved };
  } catch (error: any) {
    log.error('Error scraping resolved categories:', error.message);
    throw error;
  }
}

async function scrapeMarkets(): Promise<number> {
  log.info('\n=== Scraping All Markets ===\n');

  try {
    let totalMarketsSaved = 0;

    await apiClient.fetchMarkets({
      first: 50,
      maxMarkets: null,
      status: null,
      onBatch: async (markets) => {
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Saved ${totalMarketsSaved} markets to PostgreSQL`);

    return totalMarketsSaved;
  } catch (error: any) {
    log.error('Error scraping markets:', error.message);
    throw error;
  }
}

async function scrapeActiveMarkets(): Promise<number> {
  log.info('\n=== Scraping Active Markets ===\n');

  try {
    let totalMarketsSaved = 0;

    await apiClient.fetchMarkets({
      first: 50,
      status: MarketStatus.OPEN,
      onBatch: async (markets) => {
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Saved ${totalMarketsSaved} active markets`);

    return totalMarketsSaved;
  } catch (error: any) {
    log.error('Error scraping active markets:', error.message);
    throw error;
  }
}

async function scrapeResolvedMarkets(): Promise<number> {
  log.info('\n=== Scraping Resolved Markets ===\n');

  try {
    let totalMarketsSaved = 0;

    await apiClient.fetchMarkets({
      first: 50,
      status: MarketStatus.RESOLVED,
      onBatch: async (markets) => {
        if (markets.length > 0) {
          const saved = await dbService.saveMarkets(markets);
          totalMarketsSaved += saved;
        }
      }
    });

    log.info(`\n✓ Saved ${totalMarketsSaved} resolved markets`);

    return totalMarketsSaved;
  } catch (error: any) {
    log.error('Error scraping resolved markets:', error.message);
    throw error;
  }
}

async function scrapeTags(): Promise<number> {
  log.info('\n=== Scraping Tags ===\n');

  try {
    const tags = await apiClient.fetchTags();

    if (tags.length > 0) {
      const saved = await dbService.saveTags(tags);
      log.info(`✓ Saved ${saved} tags to PostgreSQL`);

      log.info('Tags:');
      tags.forEach((tag: any) => {
        log.info(`  ${tag.id}: ${tag.name}`);
      });

      return saved;
    } else {
      log.info('No tags found');
      return 0;
    }
  } catch (error: any) {
    log.error('Error scraping tags:', error.message);
    throw error;
  }
}

/**
 * Ordering note (audit-r3 #14): scrapeMarkets (/v1/markets) runs AFTER
 * scrapeCategories and its payload shape carries NO categoryId/categoryTitle
 * (live probe 2026-07-02: 0/25,000 markets had categoryId), so it used to
 * clobber every category-enriched raw blob. scrapeMarkets is deliberately KEPT
 * (not dropped) because the categories path does NOT cover all markets — the
 * same probe found 468 live OPEN markets present only in /v1/markets — and the
 * clobber is instead fixed at the save layer: dbService.saveMarkets merges
 * category/stats enrichment keys from the stored raw under any incoming payload
 * that lacks them (see PRESERVED_RAW_KEYS in postgres.ts).
 */
async function fullScrape(): Promise<void> {
  log.info('\n=== Full Scrape (Categories + Markets + Tags + Stats) ===\n');

  try {
    await scrapeCategories();
    await scrapeMarkets();
    await scrapeTags();
    await enrichMarketStats();
    await displayStats();
  } catch (error: any) {
    log.error('Error in full scrape:', error.message);
    throw error;
  }
}

async function enrichMarketStats(): Promise<number | undefined> {
  log.info('\n=== Enriching Markets with Stats (Volume/Liquidity) ===\n');

  try {
    const marketIds = await dbService.getAllMarketIds();
    log.info(`Found ${marketIds.length} markets to enrich`);

    if (marketIds.length === 0) {
      log.info('No active markets found');
      return;
    }

    let totalEnriched = 0;

    await apiClient.fetchMarketStatsBatch(marketIds, {
      concurrency: 5,
      delayMs: 150,
      onBatch: async (batchResults) => {
        if (batchResults.length > 0) {
          const enriched = await dbService.enrichMarketStats(batchResults);
          totalEnriched += enriched;
        }
      },
    });

    log.info(`\n✓ Enriched ${totalEnriched} markets with volume stats`);
    return totalEnriched;
  } catch (error: any) {
    log.error('Error enriching market stats:', error.message);
    log.info('Continuing despite stats enrichment error...');
  }
}

async function displayStats(): Promise<void> {
  log.info('\n=== Database Statistics ===\n');

  try {
    const stats = await dbService.getStats();

    log.info(`  Categories: ${stats.categories}`);
    log.info(`  Markets: ${stats.markets}`);
    log.info(`  Tags: ${stats.tags}`);
  } catch (error: any) {
    log.error('Error displaying stats:', error.message);
    throw error;
  }
}

export {
  scrapeActive,
  scrapeActive as scrapeActiveCategories,
  scrapeResolved,
  scrapeResolved as scrapeResolvedCategories,
  fullScrape,
  // standalone helpers (callable directly)
  scrapeCategories,
  scrapeMarkets,
  scrapeActiveMarkets,
  scrapeResolvedMarkets,
  scrapeTags,
  enrichMarketStats,
  displayStats,
};

export const scraper: Scraper = {
  platform: 'predict',
  db: dbService,
  scrapeActive,
  fullScrape,
};
