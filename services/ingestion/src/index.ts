import 'dotenv/config';
import { publish } from '@arb/event-bus';
import { runAllScrapers } from './scrapers/run-all.js';
import { runResolutionMonitor } from './resolution-monitor.js';
import { KalshiLifecycleWatcher } from './lifecycle/kalshi-lifecycle.js';
import { PolymarketLifecycleWatcher } from './lifecycle/polymarket-lifecycle.js';
import { LimitlessLifecycleWatcher } from './lifecycle/limitless-lifecycle.js';
import { refillKalshi, refillPolymarket, refillLimitless } from './lifecycle/gap-refill.js';
import { config } from './config.js';
import { createLogger } from '@arb/logger';

const log = createLogger('ingestion');

async function main() {
  log.info('Starting...');

  // CLOB orderbook streams live in services/arb-solver. This service owns
  // the slower-path REST scrapers + the WSS *lifecycle* watchers (new-market
  // and market-resolved push events — distinct from CLOB price ticks).

  // 1. Initial scrape — also connects every scraper's dbService singleton,
  //    which the lifecycle watchers below reuse for their writes.
  await scrapeAll();

  // 2. Schedule periodic scrapes
  setInterval(scrapeAll, config.scrapeIntervalMs);
  log.info(`Scrape interval: ${config.scrapeIntervalMs}ms`);

  // 3. Resolution monitor — slow-path detection of settled markets across
  //    all platforms. Complements the WSS lifecycle watchers below and is
  //    the only resolution path for Predict (no WSS channel).
  //    Uses a tail-scheduled setTimeout chain so overlapping invocations
  //    are impossible (relevant for Limitless which can take >5 min).
  const resolutionInterval = parseInt(
    process.env.RESOLUTION_POLL_INTERVAL_MS ?? '300000', // default 5 min
    10,
  );
  async function scheduleResolutionMonitor(): Promise<void> {
    try { await runResolutionMonitor(); } catch (err) {
      log.error('resolution monitor failed:', err);
    }
    setTimeout(scheduleResolutionMonitor, resolutionInterval);
  }
  scheduleResolutionMonitor();
  log.info(`Resolution-monitor interval: ${resolutionInterval}ms`);

  // 4. WSS lifecycle watchers — real-time `created` and `settled`/`resolved`
  //    push events. Each watcher persists creates to <platform>_markets and
  //    calls writeAndPublishResolution() on settles. On a WSS reconnect the
  //    refill callback fires a targeted REST query for the disconnect window
  //    so we don't need a full re-scrape to catch the gap.
  //    Predict is intentionally absent (no WSS lifecycle channel — covered
  //    by the periodic scrape + resolution monitor above).
  const watchers = [
    { name: 'kalshi',     watcher: new KalshiLifecycleWatcher(async (s) => { await refillKalshi(s); }) },
    { name: 'polymarket', watcher: new PolymarketLifecycleWatcher(async (s) => { await refillPolymarket(s); }) },
    { name: 'limitless',  watcher: new LimitlessLifecycleWatcher(async (s) => { await refillLimitless(s); }) },
  ];
  const connectResults = await Promise.allSettled(watchers.map((w) => w.watcher.connect()));
  for (const [i, r] of connectResults.entries()) {
    if (r.status === 'rejected') {
      log.error(`Lifecycle watcher (${watchers[i].name}) failed to connect:`, r.reason);
    }
  }

  // 5. Graceful shutdown — close WSS sockets cleanly so platforms see a
  //    normal close frame instead of a TCP timeout.
  const shutdown = () => {
    log.info('Shutting down...');
    for (const { watcher } of watchers) watcher.disconnect();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

async function scrapeAll() {
  log.info('Running all scrapers...');
  await runAllScrapers();

  try {
    await publish({ channel: 'markets', type: 'synced', data: { timestamp: new Date().toISOString() } });
  } catch {
    // Event bus may not be running yet
    log.warn('Could not publish to event bus (may not be running)');
  }
}

main().catch((err) => { log.error('fatal:', err); process.exit(1); });
