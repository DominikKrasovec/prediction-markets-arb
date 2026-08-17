/**
 * Unit tests for the live-active subscription gate's pure filter. No DB: the
 * DB-backed `getLiveMarketIds` is covered by a live diagnostic probe, and the
 * fail-open path is asserted at the call sites (index.ts / run-monitor/run.ts);
 * here we pin the deterministic filter logic that decides which subscriptions
 * survive a given liveness verdict.
 */
import { describe, test, expect } from 'bun:test';
import { filterSubsToLive } from './live-gate.js';
import type { MarketSubscription } from './price-cache.js';

const sub = (marketId: number, outcome?: 'yes' | 'no'): MarketSubscription => ({
  marketId,
  platform: 'kalshi',
  platformId: `T-${marketId}${outcome ? `-${outcome}` : ''}`,
  ...(outcome ? { outcome } : {}),
});

describe('filterSubsToLive', () => {
  test('keeps only subs whose marketId is live', () => {
    const subs = [sub(1), sub(2), sub(3)];
    const kept = filterSubsToLive(subs, new Set([1, 3]));
    expect(kept.map((s) => s.marketId)).toEqual([1, 3]);
  });

  test('strictly conservative: output is a subset of input, order preserved, never adds', () => {
    const subs = [sub(5), sub(2), sub(9), sub(2)];
    const kept = filterSubsToLive(subs, new Set([2, 9, 5]));
    expect(kept.every((s) => subs.includes(s))).toBe(true);
    expect(kept.map((s) => s.marketId)).toEqual([5, 2, 9, 2]);
  });

  test('empty live set drops everything (the all-expired case)', () => {
    expect(filterSubsToLive([sub(1), sub(2)], new Set())).toHaveLength(0);
  });

  test('empty input yields empty output', () => {
    expect(filterSubsToLive([], new Set([1, 2, 3]))).toHaveLength(0);
  });

  test('a fanned-out market (YES + NO share one marketId) is kept or dropped together', () => {
    const subs = [sub(1, 'yes'), sub(1, 'no'), sub(2, 'yes'), sub(2, 'no')];
    // marketId 1 live, 2 dead → both of 1's outcome subs survive, both of 2's go.
    const kept = filterSubsToLive(subs, new Set([1]));
    expect(kept.map((s) => [s.marketId, s.outcome])).toEqual([
      [1, 'yes'],
      [1, 'no'],
    ]);
  });
});
