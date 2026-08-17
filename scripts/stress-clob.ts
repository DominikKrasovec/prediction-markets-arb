/**
 * CLOB WSS stress test.
 *
 * Pulls a random sample of active markets from the scraper DB, subscribes via
 * the production ClobManager + adapters (real WSS connections to Polymarket /
 * Predict / Kalshi / Limitless), and tracks throughput + connection health.
 *
 * This bypasses the constraint graph: it's purely a CLOB-layer stress test,
 * not a solver test. `dirtySet` / LP / persistence are not exercised.
 *
 * Env:
 *   STRESS_N                  total markets to subscribe (default 10000)
 *   STRESS_PER_PLATFORM_CAP   optional per-platform cap (default ceil(N/4))
 *   STRESS_REPORT_INTERVAL_MS report cadence in ms (default 10000)
 *   STRESS_DURATION_S         auto-stop after N seconds, 0=forever (default 0)
 *   STRESS_TTFB_TRACK         track time-to-first-update per market (default 1)
 *
 * Run: bun scripts/stress-clob.ts
 */
import 'dotenv/config';
import { query, endPool } from '@arb/db';
import { ClobManager } from '../services/arb-solver/src/clob/manager.js';
import type { MarketSubscription, PriceUpdate } from '../services/arb-solver/src/clob/price-cache.js';
import type { ResolutionEvent } from '../services/arb-solver/src/clob/adapters/base.js';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('stress-clob');

const N                  = parseInt(process.env.STRESS_N ?? '10000', 10);
const PER_PLATFORM_CAP   = process.env.STRESS_PER_PLATFORM_CAP
  ? parseInt(process.env.STRESS_PER_PLATFORM_CAP, 10)
  : Math.ceil(N / 4);
const REPORT_INTERVAL_MS = parseInt(process.env.STRESS_REPORT_INTERVAL_MS ?? '10000', 10);
const DURATION_S         = parseInt(process.env.STRESS_DURATION_S ?? '0', 10);
const TTFB_TRACK         = process.env.STRESS_TTFB_TRACK !== '0';

const PLATFORMS: Platform[] = ['polymarket', 'predict', 'kalshi', 'limitless'];

interface MarketRow {
  id: number;
  platform: Platform;
  platform_id: string;
}

async function sampleMarkets(): Promise<MarketSubscription[]> {
  const out: MarketSubscription[] = [];
  for (const platform of PLATFORMS) {
    const rows = await query<MarketRow>(
      `SELECT id, platform, platform_id
         FROM markets
        WHERE platform = $1
          AND resolved_at IS NULL
          AND (status IS NULL OR status NOT IN ('closed','resolved','cancelled'))
          AND (end_date IS NULL OR end_date > NOW())
        ORDER BY random()
        LIMIT $2`,
      [platform, PER_PLATFORM_CAP],
    );
    for (const r of rows) {
      out.push({ marketId: r.id, platformId: r.platform_id, platform: r.platform });
    }
    log.info(`sampled ${rows.length} from ${platform}`);
  }
  return out;
}

interface PlatformStats {
  updates: number;
  updatesInWindow: number;
  resolutions: number;
  firstUpdateAt: number | null;
  lastUpdateAt: number | null;
  marketsSeen: Set<number>;
}

function newPlatformStats(): PlatformStats {
  return {
    updates: 0,
    updatesInWindow: 0,
    resolutions: 0,
    firstUpdateAt: null,
    lastUpdateAt: null,
    marketsSeen: new Set(),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  log.info(`Starting stress test — N=${N} per_platform_cap=${PER_PLATFORM_CAP} report=${REPORT_INTERVAL_MS}ms duration=${DURATION_S || 'forever'}s`);

  const markets = await sampleMarkets();
  log.info(`Total sampled markets: ${markets.length}`);
  if (markets.length === 0) {
    log.error('No markets sampled — check DB filters / connectivity');
    await endPool();
    process.exit(1);
  }

  const subscribedByPlatform = new Map<Platform, number>();
  for (const m of markets) {
    subscribedByPlatform.set(m.platform, (subscribedByPlatform.get(m.platform) ?? 0) + 1);
  }

  const stats = new Map<Platform, PlatformStats>();
  for (const p of PLATFORMS) stats.set(p, newPlatformStats());

  // Per-market time-to-first-update (ms from startTracking returning).
  // Only the first sample per market is recorded.
  const ttfbByMarket = new Map<number, number>();
  let subscribedAt = 0;

  const manager = new ClobManager();

  manager.onPriceUpdate((update: PriceUpdate) => {
    const s = stats.get(update.platform);
    if (!s) return;
    s.updates += 1;
    s.updatesInWindow += 1;
    s.lastUpdateAt = update.timestamp;
    if (s.firstUpdateAt === null) s.firstUpdateAt = update.timestamp;
    s.marketsSeen.add(update.marketId);
    if (TTFB_TRACK && subscribedAt > 0 && !ttfbByMarket.has(update.marketId)) {
      ttfbByMarket.set(update.marketId, update.timestamp - subscribedAt);
    }
  });

  manager.onMarketResolved((ev: ResolutionEvent) => {
    const s = stats.get(ev.platform);
    if (!s) return;
    s.resolutions += 1;
    log.info(`resolution ${ev.platform}/${ev.platformId} → ${ev.winningOutcome ?? '?'}`);
  });

  log.info('Calling startTracking...');
  const t0 = Date.now();
  await manager.startTracking(markets);
  subscribedAt = Date.now();
  log.info(`startTracking returned in ${subscribedAt - t0}ms`);

  let lastReportAt = subscribedAt;
  const reportInterval = setInterval(() => {
    const now = Date.now();
    const windowMs = now - lastReportAt;
    lastReportAt = now;
    const elapsedS = (now - subscribedAt) / 1000;
    const mem = process.memoryUsage();

    const lines: string[] = [];
    lines.push(
      `== T+${elapsedS.toFixed(0)}s  rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB ==`,
    );
    let totalWin = 0, totalAll = 0;
    for (const p of PLATFORMS) {
      const s = stats.get(p)!;
      const subbed = subscribedByPlatform.get(p) ?? 0;
      const rateWin = (s.updatesInWindow / (windowMs / 1000)).toFixed(1);
      const rateAvg = elapsedS > 0 ? (s.updates / elapsedS).toFixed(1) : '0.0';
      const coverage = subbed > 0 ? ((s.marketsSeen.size / subbed) * 100).toFixed(1) : '0.0';
      const lastAgo = s.lastUpdateAt ? `${((now - s.lastUpdateAt) / 1000).toFixed(0)}s` : 'never';
      lines.push(
        `  ${p.padEnd(11)} subs=${String(subbed).padStart(5)} ` +
        `seen=${String(s.marketsSeen.size).padStart(5)} (${coverage.padStart(5)}%) ` +
        `upd=${String(s.updates).padStart(7)} ` +
        `now=${rateWin.padStart(7)}/s avg=${rateAvg.padStart(7)}/s ` +
        `last=${lastAgo.padStart(5)} ` +
        `resolved=${s.resolutions}`,
      );
      totalWin += s.updatesInWindow;
      totalAll += s.updates;
      s.updatesInWindow = 0;
    }
    lines.push(
      `  TOTAL       upd=${String(totalAll).padStart(7)} ` +
      `now=${(totalWin / (windowMs / 1000)).toFixed(1).padStart(7)}/s ` +
      `avg=${(totalAll / Math.max(elapsedS, 1)).toFixed(1).padStart(7)}/s`,
    );

    if (TTFB_TRACK && ttfbByMarket.size > 0) {
      const vals = [...ttfbByMarket.values()].sort((a, b) => a - b);
      const p50 = vals[Math.floor(vals.length * 0.5)];
      const p99 = vals[Math.floor(vals.length * 0.99)];
      lines.push(`  ttfb        n=${vals.length} p50=${p50}ms p99=${p99}ms max=${vals[vals.length - 1]}ms`);
    }

    console.log(lines.join('\n'));
  }, REPORT_INTERVAL_MS);

  const finalReport = () => {
    const now = Date.now();
    const totalElapsedS = (now - startedAt) / 1000;
    console.log('\n========== FINAL ==========');
    console.log(`Duration: ${totalElapsedS.toFixed(1)}s`);
    for (const p of PLATFORMS) {
      const s = stats.get(p)!;
      const subbed = subscribedByPlatform.get(p) ?? 0;
      const cov = subbed > 0 ? ((s.marketsSeen.size / subbed) * 100).toFixed(1) : '0.0';
      const silent = subbed - s.marketsSeen.size;
      console.log(
        `  ${p.padEnd(11)} subs=${subbed} seen=${s.marketsSeen.size} silent=${silent} (cov=${cov}%) ` +
        `upd=${s.updates} avg=${(s.updates / Math.max(totalElapsedS, 1)).toFixed(1)}/s ` +
        `resolved=${s.resolutions}`,
      );
    }
    if (TTFB_TRACK && ttfbByMarket.size > 0) {
      const vals = [...ttfbByMarket.values()].sort((a, b) => a - b);
      const pick = (q: number) => vals[Math.floor(vals.length * q)];
      console.log(
        `  ttfb n=${vals.length} p50=${pick(0.5)}ms p90=${pick(0.9)}ms p99=${pick(0.99)}ms max=${vals[vals.length - 1]}ms`,
      );
    }
    const mem = process.memoryUsage();
    console.log(`  mem rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
    console.log('===========================\n');
  };

  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  if (DURATION_S > 0) {
    durationTimer = setTimeout(() => {
      log.info(`Duration ${DURATION_S}s elapsed — stopping`);
      shutdown().catch((err) => log.error('shutdown error:', err));
    }, DURATION_S * 1000);
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reportInterval);
    if (durationTimer) clearTimeout(durationTimer);
    finalReport();
    log.info('Stopping adapters...');
    await manager.stopAll();
    await endPool();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('Running. Ctrl+C to stop.');
}

main().catch(async (err) => {
  log.error('Fatal:', err);
  try { await endPool(); } catch { /* ignore */ }
  process.exit(1);
});
