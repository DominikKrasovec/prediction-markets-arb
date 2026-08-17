import { describe, test, expect } from 'bun:test';
import { DivergenceDetector } from './detector.js';
import type { ReviewItem, SentinelTick, WatchPair } from './types.js';

const MIN = 60_000;

const mkPair = (over: Partial<WatchPair> = {}): WatchPair => ({
  pairId: 'eq:1:1-2',
  kind: 'equiv-edge',
  mode: 'equal',
  legA: { marketId: 1, platform: 'kalshi', platformId: 'K1', questionId: 10, label: 'Leg A' },
  legB: { marketId: 2, platform: 'polymarket', platformId: 'P1', questionId: 20, label: 'Leg B' },
  edgeId: 1,
  edgeType: 'equivalence',
  ...over,
});

const tick = (marketId: number, t: number, mid: number): SentinelTick => ({
  marketId,
  bestBid: mid - 0.01,
  bestAsk: mid + 0.01,
  timestamp: t,
});

function feed(d: DivergenceDetector, ticks: SentinelTick[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const t of ticks) out.push(...d.onTick(t));
  return out;
}

describe('DivergenceDetector — equal pairs', () => {
  test('converging pair never alerts (the healthy U5 case)', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    // Parity for 10 min, A diverges to 0.58, converges back under threshold
    // by 20 min, parity afterwards.
    const aMidAt = (t: number): number => {
      if (t === 10 * MIN) return 0.58; // spread 0.08 > 0.05 → episode opens
      if (t === 15 * MIN) return 0.56; // 0.06 still breached
      if (t === 20 * MIN) return 0.54; // 0.04 ≤ 0.05 → converged, episode closes
      return 0.5;
    };
    for (let t = 0; t <= 80 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, aMidAt(t)), tick(2, t + 1000, 0.5)]));
    }
    alerts.push(...d.sweep(90 * MIN));
    expect(alerts).toHaveLength(0);
    expect(d.statuses().every(s => s.state === 'idle')).toBe(true);
  });

  test('persistent divergence alerts ONCE, with hysteresis re-arm', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];

    // Phase 1: constant 0.10 spread, both legs ticking every 5 min for 2 h.
    for (let t = 0; t <= 120 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.6), tick(2, t + 1000, 0.5)]));
    }
    expect(alerts).toHaveLength(1); // exactly one alert despite 2 h of breach
    const first = alerts[0]!;
    expect(first.verdict).toBe('suspect-identity');
    expect(first.postSpike).toBe(false);
    expect(first.alertCount).toBe(1);
    expect(first.spread.direction).toBe('a-over-b');
    expect(first.spread.signConsistency).toBe(1);
    expect(first.legA.active).toBe(true);
    expect(first.legB.active).toBe(true);
    // Persistence: fired no earlier than the 60-min window.
    expect(first.alertedAt - first.episodeStartedAt).toBeGreaterThanOrEqual(60 * MIN);

    // Phase 2: dip to 0.04 — above the clear level (0.05 × 0.5 = 0.025) → the
    // pair stays alerted; re-breaching does NOT fire again.
    alerts.push(...feed(d, [tick(1, 125 * MIN, 0.54), tick(2, 125 * MIN + 1000, 0.5)]));
    alerts.push(...feed(d, [tick(1, 130 * MIN, 0.6), tick(2, 130 * MIN + 1000, 0.5)]));
    expect(alerts).toHaveLength(1);

    // Phase 3: deep clear (0.01 < 0.025) → re-armed.
    alerts.push(...feed(d, [tick(1, 135 * MIN, 0.51), tick(2, 135 * MIN + 1000, 0.5)]));
    expect(d.statuses()[0]!.state).toBe('idle');

    // Phase 4: fresh persistent breach → a SECOND alert after a full window.
    for (let t = 140 * MIN; t <= 205 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.6), tick(2, t + 1000, 0.5)]));
    }
    expect(alerts).toHaveLength(2);
    expect(alerts[1]!.alertCount).toBe(2);
    expect(alerts[1]!.firstAlertAt).toBe(first.alertedAt);
  });

  test('one leg quoted-but-inactive → verdict liveness, not suspect', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    // B quotes once at t=0 and never updates again; A keeps ticking at 0.60.
    alerts.push(...feed(d, [tick(2, 0, 0.5)]));
    for (let t = 1000; t <= 65 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.6)]));
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.verdict).toBe('liveness');
    expect(alerts[0]!.legA.active).toBe(true);
    expect(alerts[0]!.legB.active).toBe(false);
  });

  test('leg marked stale mid-episode → liveness alert via sweep (no ticks needed)', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    for (let t = 0; t <= 30 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.6), tick(2, t + 1000, 0.5)]));
    }
    expect(alerts).toHaveLength(0); // window not yet elapsed
    d.markStale([2], 30 * MIN); // B's feed dies (disconnect/resolution)
    alerts.push(...d.sweep(45 * MIN)); // window not elapsed yet
    expect(alerts).toHaveLength(0);
    alerts.push(...d.sweep(61 * MIN)); // window elapsed with a dead leg
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.verdict).toBe('liveness');
    expect(alerts[0]!.legB.active).toBe(false);
  });

  test('post-volume-spike divergence takes the fast path (alerts in ~10 min, flagged)', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    // 20 min of active parity on both legs (2-min cadence).
    for (let t = 0; t < 20 * MIN; t += 2 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.5), tick(2, t + 1000, 0.5)]));
    }
    // Info event: A jumps 0.50 → 0.65 (move 0.15 ≥ 0.10 within the 5-min
    // burst, ≥3 recent updates). B stays — it "didn't follow".
    for (let t = 20 * MIN; t <= 32 * MIN; t += 2 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.65), tick(2, t + 1000, 0.5)]));
    }
    expect(alerts).toHaveLength(1);
    const item = alerts[0]!;
    expect(item.postSpike).toBe(true);
    expect(item.spikeLeg).toBe('a');
    expect(item.verdict).toBe('suspect-identity');
    // Fired on the fast window (10 min), far before the 60-min normal window.
    expect(item.alertedAt - item.episodeStartedAt).toBeLessThan(15 * MIN);
    expect(item.alertedAt - item.episodeStartedAt).toBeGreaterThanOrEqual(10 * MIN);
  });

  test('joint repricing (both legs spike together) does NOT take the fast path', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    for (let t = 0; t < 20 * MIN; t += 2 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.5), tick(2, t + 1000, 0.5)]));
    }
    // Both legs jump on the news; they land 0.06 apart (breach) but BOTH moved.
    for (let t = 20 * MIN; t <= 34 * MIN; t += 2 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.68), tick(2, t + 1000, 0.62)]));
    }
    expect(alerts).toHaveLength(0); // normal 60-min window still running
    expect(d.statuses()[0]!.state).toBe('pending');
  });

  test('price-cache sentinel quotes (ask=$2) are ignored — no episode, no activity', () => {
    const d = new DivergenceDetector([mkPair()]);
    const alerts: ReviewItem[] = [];
    for (let t = 0; t <= 70 * MIN; t += 5 * MIN) {
      alerts.push(...d.onTick({ marketId: 1, bestBid: 0, bestAsk: 2.0, timestamp: t }));
      alerts.push(...feed(d, [tick(2, t + 1000, 0.5)]));
    }
    alerts.push(...d.sweep(80 * MIN));
    expect(alerts).toHaveLength(0);
    expect(d.statuses()[0]!.state).toBe('idle');
  });

  test('execution-aware crossable metric ignores wide-but-overlapping books', () => {
    const d = new DivergenceDetector([mkPair()], { useCrossablePrices: true });
    // Mid spread 0.12 would breach, but the books overlap → crossable 0.
    for (let t = 0; t <= 10 * MIN; t += 5 * MIN) {
      d.onTick({ marketId: 1, bestBid: 0.52, bestAsk: 0.72, timestamp: t });
      d.onTick({ marketId: 2, bestBid: 0.45, bestAsk: 0.55, timestamp: t + 1000 });
    }
    expect(d.statuses()[0]!.state).toBe('idle');

    // Truly crossed books (sell A at 0.62 vs buy B at 0.52) → breach opens.
    d.onTick({ marketId: 1, bestBid: 0.62, bestAsk: 0.64, timestamp: 15 * MIN });
    d.onTick({ marketId: 2, bestBid: 0.5, bestAsk: 0.52, timestamp: 15 * MIN + 1000 });
    expect(d.statuses()[0]!.state).toBe('pending');
  });

  test('unwatched market ticks are no-ops', () => {
    const d = new DivergenceDetector([mkPair()]);
    expect(d.onTick(tick(999, 0, 0.5))).toHaveLength(0);
  });
});

describe('DivergenceDetector — mutex pairs', () => {
  const mux = mkPair({
    pairId: 'mux:9:1-2',
    kind: 'mutex-edge',
    mode: 'mutex',
    edgeId: 9,
    edgeType: 'mutual_exclusion',
  });

  test('persistent Σ > 1+fees violation alerts; review item carries the overshoot', () => {
    const d = new DivergenceDetector([mux]);
    const alerts: ReviewItem[] = [];
    // 0.60 + 0.55 = 1.15 → overshoot beyond 1.02 = 0.13 > 0.03 threshold.
    for (let t = 0; t <= 70 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.6), tick(2, t + 1000, 0.55)]));
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.mode).toBe('mutex');
    expect(alerts[0]!.verdict).toBe('suspect-identity');
    expect(alerts[0]!.spread.lastMetric).toBeCloseTo(0.13, 6);
  });

  test('Σ ≤ 1+fees never alerts', () => {
    const d = new DivergenceDetector([mux]);
    const alerts: ReviewItem[] = [];
    for (let t = 0; t <= 70 * MIN; t += 5 * MIN) {
      alerts.push(...feed(d, [tick(1, t, 0.55), tick(2, t + 1000, 0.4)]));
    }
    alerts.push(...d.sweep(80 * MIN));
    expect(alerts).toHaveLength(0);
    expect(d.statuses()[0]!.state).toBe('idle');
  });
});
