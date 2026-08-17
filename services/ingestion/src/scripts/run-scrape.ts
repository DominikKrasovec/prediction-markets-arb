/**
 * Standalone one-venue scrape runner — the `npm run scrape:<venue>` scripts
 * pointed at scraper.ts modules that only EXPORT fullScrape (no main guard),
 * so they exited 0 doing nothing (found during the 2026-07-08 e2e test,
 * Phase 1). Usage: bun src/scripts/run-scrape.ts <kalshi|polymarket|predict|limitless> [--full]
 *
 * Default is the ACTIVE-markets scrape. fullScrape walks the venue's entire
 * settled archive for kalshi/polymarket/predict (found the hard way in the
 * 2026-07-10 e2e test: 750k+ Polymarket archive rows flooded `markets` via the
 * warm-watermark sync passthrough, audit F-8) — that walk is now opt-in via
 * --full. Limitless is the exception: its fullScrape is already active-only
 * ("full" = all market TYPES, clob+amm+group) and its scrapeActive is
 * CLOB-only, which would DROP the negRisk-style `group` markets the pipeline
 * explodes at Stage 0 — so limitless defaults to fullScrape.
 */
import 'dotenv/config';
const venue = process.argv[2];
const full = process.argv.includes('--full');
if (!venue || !['kalshi', 'polymarket', 'predict', 'limitless'].includes(venue)) {
  console.error('usage: run-scrape.ts <kalshi|polymarket|predict|limitless> [--full]');
  process.exit(2);
}
const mod = await import(`../scrapers/${venue}/index.js`);
// The orchestrator connects each scraper's dbService before use; standalone we
// must do the same (connect() is idempotent, disconnect() ends the shared pool).
await mod.dbService.connect();
try {
  if (full || venue === 'limitless') {
    await mod.fullScrape();
  } else {
    await mod.scraper.scrapeActive();
  }
} finally {
  await mod.dbService.disconnect();
}
process.exit(0);
