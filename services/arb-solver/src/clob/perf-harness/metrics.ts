import type { Platform } from '@arb/types';
import type { PriceUpdate } from '../price-cache.js';

/**
 * In-memory metrics aggregator for the CLOB perf harness.
 *
 * Captures, per platform: throughput (msgs/sec EMA over the last 10s),
 * latency (serverTs->emit and wireTs->emit), msgKind breakdown, distinct
 * markets observed, and per-market last-seen time.
 *
 * Each histogram is capped at MAX_SAMPLES and evicts the oldest sample FIFO,
 * so quantiles reflect only the most recent observations.
 */
const MAX_SAMPLES = 10_000;
const THROUGHPUT_EMA_ALPHA = 0.1; // ~10s window at 1s tick

/** Anything older than this is a "stale-snapshot" sample, not push latency.
 *  Predict's `updateTimestampMs` = orderbook last-update time, so an illiquid
 *  market reports a server-ts hours/days in the past. Including these would
 *  saturate the quantile estimator. They're tracked separately as `staleObs`. */
const E2E_STALE_CUTOFF_MS = 60_000;

class Histogram {
  private samples: number[] = [];
  add(v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    if (this.samples.length >= MAX_SAMPLES) this.samples.shift();
    this.samples.push(v);
  }
  count(): number {
    return this.samples.length;
  }
  quantile(q: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[idx];
  }
  mean(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
  }
  max(): number {
    if (this.samples.length === 0) return 0;
    let m = -Infinity;
    for (const v of this.samples) if (v > m) m = v;
    return m;
  }
}

export interface PlatformSnapshot {
  platform: Platform;
  totalTicks: number;
  msgsPerSec: number;          // 10s EMA
  marketsSeen: number;         // distinct marketId
  byKind: Record<string, number>;
  /** Per-outcome tick + market counts. Polymarket subscribes both YES and NO
   *  independently; this surfaces whether one side is silent. */
  byOutcome: { yes: { ticks: number; markets: number }; no: { ticks: number; markets: number }; none: { ticks: number; markets: number } };
  /** serverTs → emit (only counted for ticks with both fields, AND
   *  dt < E2E_STALE_CUTOFF_MS — older samples treated as snapshot-of-stale-book). */
  e2eLatencyMs: { count: number; p50: number; p95: number; p99: number; max: number; mean: number };
  /** wireTs → emit (parse + book reconstruction overhead). */
  bookLatencyMs: { count: number; p50: number; p95: number; p99: number; max: number; mean: number };
  /** Count of ticks where serverTs was present but dt >= cutoff. Indicates
   *  the platform is replaying old book state (not push latency). */
  staleObs: number;
}

class PlatformMetrics {
  totalTicks = 0;
  byKind = new Map<string, number>();
  markets = new Set<number>();
  marketLastSeen = new Map<number, number>();
  e2eLatency = new Histogram();
  bookLatency = new Histogram();
  staleObs = 0;
  byOutcomeTicks = { yes: 0, no: 0, none: 0 };
  byOutcomeMarkets = { yes: new Set<number>(), no: new Set<number>(), none: new Set<number>() };
  /** Tick count since the last tick on the EMA timer — reset by tick(). */
  private since = 0;
  private msgsPerSecEma = 0;

  record(u: PriceUpdate): void {
    this.totalTicks++;
    this.since++;
    this.markets.add(u.marketId);
    this.marketLastSeen.set(u.marketId, u.timestamp);
    const kind = u.msgKind ?? 'unknown';
    this.byKind.set(kind, (this.byKind.get(kind) ?? 0) + 1);

    const o = u.outcome === 'yes' || u.outcome === 'no' ? u.outcome : 'none';
    this.byOutcomeTicks[o]++;
    this.byOutcomeMarkets[o].add(u.marketId);

    if (u.serverTs != null && u.serverTs > 0) {
      const dt = u.timestamp - u.serverTs;
      if (dt >= E2E_STALE_CUTOFF_MS) {
        this.staleObs++;
      } else {
        // Negative E2E means our clock is behind the platform's — clamp to 0.
        this.e2eLatency.add(dt > 0 ? dt : 0);
      }
    }
    if (u.wireTs != null && u.wireTs > 0) {
      const dt = u.timestamp - u.wireTs;
      this.bookLatency.add(dt >= 0 ? dt : 0);
    }
  }

  /** Called every `intervalSec` from the harness to update the throughput EMA. */
  tick(intervalSec: number): void {
    const rate = this.since / intervalSec;
    this.msgsPerSecEma = this.msgsPerSecEma === 0 ? rate : this.msgsPerSecEma * (1 - THROUGHPUT_EMA_ALPHA) + rate * THROUGHPUT_EMA_ALPHA;
    this.since = 0;
  }

  snapshot(platform: Platform): PlatformSnapshot {
    return {
      platform,
      totalTicks: this.totalTicks,
      msgsPerSec: this.msgsPerSecEma,
      marketsSeen: this.markets.size,
      byKind: Object.fromEntries(this.byKind),
      e2eLatencyMs: {
        count: this.e2eLatency.count(),
        p50: this.e2eLatency.quantile(0.50),
        p95: this.e2eLatency.quantile(0.95),
        p99: this.e2eLatency.quantile(0.99),
        max: this.e2eLatency.max(),
        mean: this.e2eLatency.mean(),
      },
      bookLatencyMs: {
        count: this.bookLatency.count(),
        p50: this.bookLatency.quantile(0.50),
        p95: this.bookLatency.quantile(0.95),
        p99: this.bookLatency.quantile(0.99),
        max: this.bookLatency.max(),
        mean: this.bookLatency.mean(),
      },
      staleObs: this.staleObs,
      byOutcome: {
        yes: { ticks: this.byOutcomeTicks.yes, markets: this.byOutcomeMarkets.yes.size },
        no: { ticks: this.byOutcomeTicks.no, markets: this.byOutcomeMarkets.no.size },
        none: { ticks: this.byOutcomeTicks.none, markets: this.byOutcomeMarkets.none.size },
      },
    };
  }
}

export class MetricsAggregator {
  private platforms = new Map<Platform, PlatformMetrics>();

  record(u: PriceUpdate): void {
    let pm = this.platforms.get(u.platform);
    if (!pm) {
      pm = new PlatformMetrics();
      this.platforms.set(u.platform, pm);
    }
    pm.record(u);
  }

  tick(intervalSec: number): void {
    for (const pm of this.platforms.values()) pm.tick(intervalSec);
  }

  snapshot(): PlatformSnapshot[] {
    return [...this.platforms.entries()]
      .map(([p, pm]) => pm.snapshot(p))
      .sort((a, b) => a.platform.localeCompare(b.platform));
  }

  /** Markets that have NOT received any tick since `cutoffMs`. */
  staleMarkets(cutoffMs: number): { platform: Platform; total: number; stale: number; subscribed: number }[] {
    const now = Date.now();
    const out: { platform: Platform; total: number; stale: number; subscribed: number }[] = [];
    for (const [p, pm] of this.platforms) {
      let stale = 0;
      for (const ts of pm.marketLastSeen.values()) {
        if (now - ts > cutoffMs) stale++;
      }
      out.push({ platform: p, total: pm.markets.size, stale, subscribed: 0 });
    }
    return out;
  }
}

/** Pretty-print one snapshot row for the console summary table. */
export function formatSnapshot(s: PlatformSnapshot): string {
  const kindStr = Object.entries(s.byKind)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  const staleSuffix = s.staleObs > 0 ? ` stale=${s.staleObs}` : '';
  const outStr = (() => {
    const parts: string[] = [];
    if (s.byOutcome.yes.ticks) parts.push(`yes=${s.byOutcome.yes.ticks}/${s.byOutcome.yes.markets}`);
    if (s.byOutcome.no.ticks) parts.push(`no=${s.byOutcome.no.ticks}/${s.byOutcome.no.markets}`);
    if (s.byOutcome.none.ticks) parts.push(`(no-outcome)=${s.byOutcome.none.ticks}/${s.byOutcome.none.markets}`);
    return parts.length ? ` outcome[ticks/mkts]: ${parts.join(' ')}` : '';
  })();
  return [
    `[${s.platform.padEnd(10)}]`,
    `ticks=${s.totalTicks.toString().padStart(8)}`,
    `mkts=${s.marketsSeen.toString().padStart(6)}`,
    `${s.msgsPerSec.toFixed(1).padStart(7)} msg/s`,
    `e2e p50/p95/p99=${s.e2eLatencyMs.p50}/${s.e2eLatencyMs.p95}/${s.e2eLatencyMs.p99} ms (n=${s.e2eLatencyMs.count})`,
    `book p50/p95/p99=${s.bookLatencyMs.p50}/${s.bookLatencyMs.p95}/${s.bookLatencyMs.p99} ms`,
    `${kindStr}${staleSuffix}${outStr}`,
  ].join('  ');
}
