import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';
import { endPool } from '@arb/db';
import { ClobManager } from '../manager.js';
import type { MarketSubscription, PriceUpdate } from '../price-cache.js';
import { loadClusterMarkets, summariseByPlatform, summariseByOutcome } from './load-subs.js';
import { MetricsAggregator, formatSnapshot, type PlatformSnapshot } from './metrics.js';
import { JsonlSink } from './jsonl-sink.js';

const log = createLogger('clob-perf');

export interface HarnessOptions {
  durationMs: number;
  minEdgeConfidence: number;
  outRoot: string;
  /** Limit to a single platform (`kalshi` / `polymarket` / `limitless` / `predict`). */
  platform?: Platform;
  /** Max subscriptions (after platform filter). 0 = no cap. */
  maxSubs?: number;
  /** Print per-platform summary table every N seconds. */
  summaryIntervalSec: number;
  /** Mark a market as "stale" if no tick in this many ms. */
  staleAfterMs: number;
  /** Persist a per-tick JSONL row? Default true; turn off for very long runs. */
  writeJsonl: boolean;
  /** Use the all-open SQL path instead of the edge-graph cluster load. */
  allOpen?: boolean;
  /** Subscribe to both YES and NO clobTokenIds per Polymarket market. */
  bothPolymarketSides?: boolean;
  /** Expand Limitless group-wrapper slugs to their child slugs. */
  expandLimitlessGroups?: boolean;
}

export async function runHarness(opts: HarnessOptions): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const runDir = join(opts.outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  log.info(`run dir: ${runDir}`);

  log.info(opts.allOpen ? 'loading ALL open markets from DB…' : 'loading cluster markets from DB…');
  const subs = await loadClusterMarkets({
    minEdgeConfidence: opts.minEdgeConfidence,
    platform: opts.platform,
    maxSubs: opts.maxSubs,
    allOpen: opts.allOpen,
    bothPolymarketSides: opts.bothPolymarketSides,
    expandLimitlessGroups: opts.expandLimitlessGroups,
  });
  const counts = summariseByPlatform(subs);
  const outcomes = summariseByOutcome(subs);
  log.info(`loaded ${subs.length} subs: platforms=${JSON.stringify(counts)} outcomes=${JSON.stringify(outcomes)}`);

  if (subs.length === 0) {
    log.warn('no markets to subscribe — exiting');
    await endPool();
    return;
  }

  const platforms = [...new Set(subs.map((s) => s.platform))].sort();

  const metrics = new MetricsAggregator();
  const sink = opts.writeJsonl ? new JsonlSink(runDir) : null;
  sink?.start(platforms);

  // Manifest: locked-in config + sub counts + run metadata. Written before we
  // start so a crash mid-run still leaves a record of what was attempted.
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        startedAt: new Date().toISOString(),
        opts,
        platforms,
        subCount: subs.length,
        countsByPlatform: counts,
      },
      null,
      2,
    ),
  );

  const manager = new ClobManager();
  manager.onPriceUpdate((u: PriceUpdate) => {
    metrics.record(u);
    sink?.write(u);
  });
  manager.onMarketResolved((ev) => {
    // Resolution events don't affect the perf harness — we just log them so
    // the user can correlate any throughput dips with markets falling out of
    // the subscription set.
    log.info(`resolution event: ${ev.platform}/${ev.platformId} -> ${ev.winningOutcome ?? '?'}`);
  });

  log.info(`starting CLOB adapters for ${platforms.length} platforms…`);
  await manager.startTracking(subs);
  log.info('adapters started; sampling begins now');

  const startedAt = Date.now();
  const endsAt = startedAt + opts.durationMs;

  // Console summary loop
  const summaryInterval = setInterval(() => {
    metrics.tick(opts.summaryIntervalSec);
    printSummary(metrics, startedAt, endsAt);
  }, opts.summaryIntervalSec * 1000);

  // Stale-market reporter (every 30 s)
  const staleInterval = setInterval(() => {
    const stale = metrics.staleMarkets(opts.staleAfterMs);
    for (const s of stale) {
      const pct = s.total > 0 ? ((s.stale / s.total) * 100).toFixed(1) : '0.0';
      log.info(`stale[${s.platform}]: ${s.stale}/${s.total} (${pct}%)`);
    }
  }, 30_000);

  // Wait for duration OR SIGINT
  await new Promise<void>((resolve) => {
    const stopTimer = setTimeout(resolve, opts.durationMs);
    const onSig = () => {
      log.warn('SIGINT received — stopping');
      clearTimeout(stopTimer);
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });

  clearInterval(summaryInterval);
  clearInterval(staleInterval);

  log.info('stopping adapters…');
  await manager.stopAll();
  await sink?.close();

  // Final summary
  const finalSnap = metrics.snapshot();
  const summary = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    subCount: subs.length,
    countsByPlatform: counts,
    platforms: finalSnap,
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  log.info('======= FINAL =======');
  for (const s of finalSnap) log.info(formatSnapshot(s));
  log.info(`wrote summary: ${join(runDir, 'summary.json')}`);

  await endPool();
}

function printSummary(metrics: MetricsAggregator, startedAt: number, endsAt: number): void {
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  const remainingSec = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  const snap = metrics.snapshot();
  const totalTicks = snap.reduce((s, p) => s + p.totalTicks, 0);
  log.info(`---- t=${elapsedSec}s remaining=${remainingSec}s total_ticks=${totalTicks} ----`);
  for (const s of snap) log.info(formatSnapshot(s));
}
