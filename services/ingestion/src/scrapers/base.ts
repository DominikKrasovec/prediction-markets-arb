/**
 * Shared contract every market scraper fulfills, plus the runtime registry
 * that `run-all.ts` (and any future scheduler) iterates over.
 *
 * Why an interface (and not the existing free functions): each platform's
 * scrapeActive return type differs (some return raw counts, some return
 * `{totalMarkets, totalEvents}`, etc). The dispatcher doesn't care — it
 * only needs to call `db.connect()` then `scrapeActive()`. Typing that as
 * `Promise<unknown>` removes the 4 near-identical wrapper functions in
 * run-all.ts without forcing every platform to standardize its return
 * payload (which would be a bigger, riskier change).
 *
 * Platform-specific entrypoints (`fullScrape`, `scrapeResolved`,
 * `enrichMarketStats`, etc.) remain as named exports on each scraper
 * module — the interface is intentionally minimal.
 */
import type { Platform } from '@arb/types';

export interface ScraperDb {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface Scraper {
  readonly platform: Platform;
  readonly db: ScraperDb;
  /**
   * Discover & persist currently-active markets. Return type is per-platform
   * (each platform reports its own counts shape — the dispatcher ignores it).
   */
  scrapeActive(): Promise<unknown>;
  /**
   * One-shot full historical crawl: active + resolved + (where applicable)
   * archived markets. Used by the `scrape` CLI's default mode. Per-platform
   * implementations log their own progress and stats; return value is ignored.
   */
  fullScrape(): Promise<unknown>;
}
