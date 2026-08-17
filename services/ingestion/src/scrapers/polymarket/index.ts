/**
 * Main entry point for Polymarket data fetching module
 */

export * as apiClient from './api-client.js';
export { dbService } from './postgres.js';
export {} from './types.js';

export {
  scrapeActive,
  scrapeResolved,
  scrapeAll,
  fullScrape,
  showStats,
  scraper,
} from './scraper.js';
