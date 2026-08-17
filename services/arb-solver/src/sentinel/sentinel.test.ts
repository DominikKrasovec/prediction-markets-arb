import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentitySentinel } from './sentinel.js';
import { SentinelSink } from './sink.js';
import type { ReviewItem, SentinelTick, WatchPair } from './types.js';

const MIN = 60_000;

const mkPair = (
  pairId: string,
  aId: number,
  bId: number,
  over: Partial<WatchPair> = {},
): WatchPair => ({
  pairId,
  kind: 'equiv-edge',
  mode: 'equal',
  legA: { marketId: aId, platform: 'kalshi', platformId: `K${aId}`, questionId: aId * 10, label: `leg ${aId}` },
  legB: { marketId: bId, platform: 'polymarket', platformId: `P${bId}`, questionId: bId * 10, label: `leg ${bId}` },
  ...over,
});

const tick = (marketId: number, t: number, mid: number): SentinelTick => ({
  marketId,
  bestBid: mid - 0.01,
  bestAsk: mid + 0.01,
  timestamp: t,
});

/** Drive a persistent divergence on (aId, bId) from t0 for `mins` minutes. */
function diverge(s: IdentitySentinel, aId: number, bId: number, t0: number, mins: number, aMid: number, bMid: number): void {
  for (let t = t0; t <= t0 + mins * MIN; t += 5 * MIN) {
    s.pump(tick(aId, t, aMid));
    s.pump(tick(bId, t + 1000, bMid));
  }
}

describe('SentinelSink', () => {
  const item = (pairId: string, verdict: ReviewItem['verdict'] = 'suspect-identity'): ReviewItem => ({
    pairId,
    kind: 'equiv-edge',
    mode: 'equal',
    verdict,
    postSpike: false,
    spikeLeg: null,
    questionIds: [1, 2],
    legA: { marketId: 1, platform: 'kalshi', platformId: 'K1', questionId: 1, label: 'a', lastBid: 0.5, lastAsk: 0.52, lastUpdateAt: 0, active: true },
    legB: { marketId: 2, platform: 'polymarket', platformId: 'P1', questionId: 2, label: 'b', lastBid: 0.4, lastAsk: 0.42, lastUpdateAt: 0, active: true },
    spread: { samples: 3, maxMetric: 0.1, meanMetric: 0.1, lastMetric: 0.1, lastSigned: 0.1, signConsistency: 1, direction: 'a-over-b', converging: false },
    episodeStartedAt: 0,
    alertedAt: 60 * MIN,
    firstAlertAt: 60 * MIN,
    alertCount: 1,
  });

  test('ring buffer evicts oldest beyond capacity', () => {
    const sink = new SentinelSink({ ringCapacity: 2, logger: null });
    sink.push(item('p1'));
    sink.push(item('p2'));
    sink.push(item('p3'));
    expect(sink.size).toBe(2);
    expect(sink.recent(10).map(i => i.pairId)).toEqual(['p2', 'p3']);
  });

  test('JSONL append writes one parseable line per item', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-test-'));
    const path = join(dir, 'nested', 'alerts.jsonl'); // exercises mkdir -p
    const sink = new SentinelSink({ jsonlPath: path, logger: null });
    sink.push(item('p1'));
    sink.push(item('p2', 'liveness'));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map(l => JSON.parse(l) as ReviewItem);
    expect(parsed[0]!.pairId).toBe('p1');
    expect(parsed[1]!.verdict).toBe('liveness');
    expect(parsed[0]!.legA.marketId).toBe(1);
  });
});

describe('IdentitySentinel (facade)', () => {
  test('pump → alert lands in the sink; summary surfaces it as a top suspect', () => {
    const sink = new SentinelSink({ logger: null });
    const s = new IdentitySentinel([mkPair('eq:1:1-2', 1, 2)], {}, sink);
    diverge(s, 1, 2, 0, 70, 0.6, 0.5);

    expect(sink.size).toBe(1);
    const summary = s.summary();
    expect(summary.pairsWatched).toBe(1);
    expect(summary.pairsAlerted).toBe(1);
    expect(summary.byVerdict['suspect-identity']).toBe(1);
    expect(summary.topSuspects).toHaveLength(1);
    expect(summary.topSuspects[0]!.pairId).toBe('eq:1:1-2');
  });

  test('summary buckets verdicts; liveness alerts are not suspects', () => {
    const sink = new SentinelSink({ logger: null });
    const s = new IdentitySentinel(
      [mkPair('eq:1:1-2', 1, 2), mkPair('eq:2:3-4', 3, 4)],
      {},
      sink,
    );
    // Pair 1: persistent two-sided divergence → suspect-identity.
    diverge(s, 1, 2, 0, 70, 0.6, 0.5);
    // Pair 2: leg 4 quotes once then goes silent → liveness.
    s.pump(tick(4, 0, 0.5));
    for (let t = 1000; t <= 65 * MIN; t += 5 * MIN) s.pump(tick(3, t, 0.6));

    const summary = s.summary();
    expect(summary.pairsAlerted).toBe(2);
    expect(summary.byVerdict['suspect-identity']).toBe(1);
    expect(summary.byVerdict.liveness).toBe(1);
    expect(summary.topSuspects).toHaveLength(1);
    expect(summary.topSuspects[0]!.pairId).toBe('eq:1:1-2');
  });

  test('post-spike suspects rank above slow-drift suspects', () => {
    const sink = new SentinelSink({ logger: null });
    const s = new IdentitySentinel(
      [mkPair('slow', 1, 2), mkPair('spiky', 3, 4)],
      {},
      sink,
    );
    // Slow drift on pair 1 (bigger spread, but no spike).
    diverge(s, 1, 2, 0, 70, 0.68, 0.5);
    // Post-spike divergence on pair 2: active parity, then leg 3 jumps.
    for (let t = 0; t < 20 * MIN; t += 2 * MIN) {
      s.pump(tick(3, t, 0.5));
      s.pump(tick(4, t + 1000, 0.5));
    }
    for (let t = 20 * MIN; t <= 32 * MIN; t += 2 * MIN) {
      s.pump(tick(3, t, 0.65));
      s.pump(tick(4, t + 1000, 0.5));
    }

    const summary = s.summary();
    expect(summary.topSuspects).toHaveLength(2);
    expect(summary.topSuspects[0]!.pairId).toBe('spiky');
    expect(summary.topSuspects[0]!.postSpike).toBe(true);
    expect(summary.topSuspects[1]!.pairId).toBe('slow');
  });

  test('sweep fires window expiries without fresh ticks and sinks them', () => {
    const sink = new SentinelSink({ logger: null });
    const s = new IdentitySentinel([mkPair('eq:1:1-2', 1, 2)], {}, sink);
    // Open a breach, then go silent.
    diverge(s, 1, 2, 0, 20, 0.6, 0.5);
    expect(sink.size).toBe(0);
    const items = s.sweep(61 * MIN);
    expect(items).toHaveLength(1);
    expect(sink.size).toBe(1);
    // Silent books for 40+ min → activity gate fails → liveness, not suspect.
    expect(items[0]!.verdict).toBe('liveness');
  });
});
