import 'dotenv/config';
import type { Scraper } from './base.js';
import { scraper as polymarket } from './polymarket/scraper.js';
import { scraper as predict }    from './predict/scraper.js';
import { scraper as kalshi }     from './kalshi/scraper.js';
import { scraper as limitless }  from './limitless/scraper.js';
import { createLogger } from '@arb/logger';

const log = createLogger('scraper');

/**
 * Registry of every market scraper. To add a new platform: implement the
 * `Scraper` interface in its `scraper.ts` and add it here — no other
 * changes are needed in the dispatcher.
 *
 * Exported so live-monitor / monitor-scrapers / any future scheduler can
 * iterate it without re-importing every platform's `dbService` and
 * `scrapeActive` individually.
 */
export const SCRAPERS: readonly Scraper[] = [polymarket, predict, limitless, kalshi];

export async function runAllScrapers(): Promise<void> {
  const results = await Promise.allSettled(
    SCRAPERS.map(async (s) => {
      await s.db.connect();
      await s.scrapeActive();
    }),
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      log.error('Failed:', r.reason);
    }
  }
}

// Allow standalone execution
if (process.argv[1]?.endsWith('run-all.ts') || process.argv[1]?.endsWith('run-all.js')) {
  runAllScrapers().catch((err) => log.error('fatal:', err));
}
