/**
 * IdentitySentinel — facade tying registry output (watch pairs) to the
 * divergence detector, classifier and sink. Self-contained: the host wires
 * `pump()` into the CLOB price-update hook and calls `sweep()` on a timer
 * (see sentinel/README.md for the exact wiring points in index.ts).
 */

import { DivergenceDetector } from './detector.js';
import { SentinelSink } from './sink.js';
import type {
  ReviewItem,
  SentinelConfig,
  SentinelSummary,
  SentinelTick,
  Verdict,
  WatchPair,
} from './types.js';

export class IdentitySentinel {
  private readonly detector: DivergenceDetector;
  readonly sink: SentinelSink;

  constructor(pairs: WatchPair[], cfg: Partial<SentinelConfig> = {}, sink?: SentinelSink) {
    this.detector = new DivergenceDetector(pairs, cfg);
    this.sink = sink ?? new SentinelSink();
  }

  /**
   * Feed one price update (call from the CLOB onPriceUpdate hook). Event time
   * is `tick.timestamp` — the sentinel never reads a wall clock. Returns any
   * alerts fired by this tick (already pushed to the sink).
   */
  pump(tick: SentinelTick): ReviewItem[] {
    const items = this.detector.onTick(tick);
    for (const item of items) this.sink.push(item);
    return items;
  }

  /** Mirror of priceCache.markStaleByIds — flag legs whose feed died/resolved. */
  markStale(marketIds: number[], now: number): void {
    this.detector.markStale(marketIds, now);
  }

  /**
   * Periodic evaluation (suggested: every 30–60 s, with `now = Date.now()` at
   * the call site — the only place wall time enters). Lets persistence windows
   * elapse and stale-leg liveness alerts fire without fresh ticks.
   */
  sweep(now: number): ReviewItem[] {
    const items = this.detector.sweep(now);
    for (const item of items) this.sink.push(item);
    return items;
  }

  /** Top-N active suspects + state counts — the operator/API surface. */
  summary(topN = 10): SentinelSummary {
    const statuses = this.detector.statuses();
    const byVerdict: Record<Verdict, number> = {
      'suspect-identity': 0,
      'segmentation-latency': 0,
      liveness: 0,
    };
    let pending = 0;
    let alerted = 0;
    const activeSuspects: ReviewItem[] = [];

    for (const s of statuses) {
      if (s.state === 'pending') pending++;
      if (s.state !== 'alerted' || !s.lastItem) continue;
      alerted++;
      byVerdict[s.lastItem.verdict]++;
      if (s.lastItem.verdict === 'suspect-identity') activeSuspects.push(s.lastItem);
    }

    // Post-spike alerts first (highest signal), then by observed spread size.
    activeSuspects.sort((a, b) => {
      if (a.postSpike !== b.postSpike) return a.postSpike ? -1 : 1;
      return b.spread.maxMetric - a.spread.maxMetric;
    });

    return {
      pairsWatched: this.detector.pairCount,
      pairsPending: pending,
      pairsAlerted: alerted,
      byVerdict,
      topSuspects: activeSuspects.slice(0, topN),
    };
  }

  get pairCount(): number {
    return this.detector.pairCount;
  }
}
