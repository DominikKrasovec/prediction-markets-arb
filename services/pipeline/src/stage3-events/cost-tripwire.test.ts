/**
 * Stage-3b spend-guardrail unit tests. Pure
 * + seam-mocked (no DB) — the cost query is injected as a `CostSumQuery`, mirroring
 * the SQL-string / pure-function seams the neighbouring Stage-3 tests use
 * (llm-event-match-retry.test.ts). These pin:
 *   - the per-tick cap arithmetic (exact adherence + carry-over, never a drop),
 *   - the daily-cost tripwire (trips strictly OVER limit, LATCHES for the day,
 *     auto-clears on UTC-day rollover),
 *   - the cost SQL string invariants (UTC-day scoped sum over llm_logs.cost_usd).
 */
import { test, expect, beforeEach } from 'bun:test';
import {
  nextClaimSize,
  isOverDailyLimit,
  currentUtcDay,
  utcDayCostSumSql,
  checkDailyCostTripwire,
  peekDailyCostTripwire,
  __resetCostTripwireForTest,
  type CostSumQuery,
} from './cost-tripwire.js';

beforeEach(() => __resetCostTripwireForTest());

// Per-tick cap arithmetic

test('nextClaimSize: takes a full batch while under the cap', () => {
  expect(nextClaimSize(0, 2000, 200)).toBe(200);
  expect(nextClaimSize(1800, 2000, 200)).toBe(200);
});

test('nextClaimSize: shrinks the last claim to land EXACTLY on the cap', () => {
  // cap not a multiple of batch: 250 with batch 200 → 200 then 50.
  expect(nextClaimSize(200, 250, 200)).toBe(50);
});

test('nextClaimSize: returns 0 at/over the cap (tick must stop, backlog carries)', () => {
  expect(nextClaimSize(2000, 2000, 200)).toBe(0);
  expect(nextClaimSize(2050, 2000, 200)).toBe(0); // never negative
});

test('simulated drain never exceeds the cap and truncates exactly at it', () => {
  const cap = 2000;
  const batch = 200;
  // Pretend the queue is effectively infinite: every claim returns `claim` rows.
  let totalSeen = 0;
  let iterations = 0;
  let truncated = false;
  for (;;) {
    const claim = nextClaimSize(totalSeen, cap, batch);
    if (claim === 0) { truncated = true; break; }
    totalSeen += claim; // a full claim comes back (infinite queue)
    iterations++;
    if (iterations > 1000) throw new Error('drain did not terminate');
  }
  expect(totalSeen).toBe(cap);      // exact adherence
  expect(truncated).toBe(true);     // stopped on the cap, not an empty queue
  expect(iterations).toBe(cap / batch);
});

test('drain stops naturally (no truncation) when the queue empties below the cap', () => {
  const cap = 2000;
  const batch = 200;
  const queue = 350; // fewer pending than the cap
  let totalSeen = 0;
  let remainingInQueue = queue;
  let truncated = false;
  for (;;) {
    const claim = nextClaimSize(totalSeen, cap, batch);
    if (claim === 0) { truncated = true; break; }
    const got = Math.min(claim, remainingInQueue);
    if (got === 0) break; // empty queue → natural stop
    totalSeen += got;
    remainingInQueue -= got;
  }
  expect(totalSeen).toBe(queue);
  expect(truncated).toBe(false); // cap never reached → not a per-tick truncation
});

// Daily-cost breach decision

test('isOverDailyLimit: strictly over trips; equal does not', () => {
  expect(isOverDailyLimit(10.01, 10)).toBe(true);
  expect(isOverDailyLimit(10, 10)).toBe(false);
  expect(isOverDailyLimit(0, 10)).toBe(false);
});

// Persistent daily-cost tripwire

const fixedNow = new Date('2026-07-10T12:00:00Z');
const mockSum = (usd: number): CostSumQuery => async () => usd;

test('tripwire stays clear while under the limit', async () => {
  const tw = await checkDailyCostTripwire(10, mockSum(4.2), fixedNow);
  expect(tw.tripped).toBe(false);
  expect(tw.spentUsd).toBe(4.2);
  expect(tw.limitUsd).toBe(10);
  expect(tw.utcDay).toBe('2026-07-10');
});

test('tripwire trips once the day spend crosses the limit', async () => {
  const tw = await checkDailyCostTripwire(10, mockSum(10.5), fixedNow);
  expect(tw.tripped).toBe(true);
});

test('tripwire LATCHES: stays tripped the same day even if spend is later read lower', async () => {
  const trip = await checkDailyCostTripwire(10, mockSum(12), fixedNow);
  expect(trip.tripped).toBe(true);
  // A later read the SAME UTC day returns a lower figure (rows pruned / race) — the
  // persistent latch must keep it tripped so spend cannot resume mid-day.
  const later = await checkDailyCostTripwire(10, mockSum(3), fixedNow);
  expect(later.tripped).toBe(true);
  expect(later.spentUsd).toBe(3); // the reading updates…
  expect(peekDailyCostTripwire()?.tripped).toBe(true); // …but the latch holds
});

test('tripwire AUTO-CLEARS on UTC-day rollover (new day sum starts at 0)', async () => {
  const trip = await checkDailyCostTripwire(10, mockSum(15), fixedNow);
  expect(trip.tripped).toBe(true);
  const nextDay = new Date('2026-07-11T00:05:00Z');
  const fresh = await checkDailyCostTripwire(10, mockSum(0.4), nextDay);
  expect(fresh.tripped).toBe(false); // yesterday's latch does not carry over
  expect(fresh.utcDay).toBe('2026-07-11');
});

test('peek returns null before the first check, state after', async () => {
  expect(peekDailyCostTripwire()).toBeNull();
  await checkDailyCostTripwire(10, mockSum(1), fixedNow);
  expect(peekDailyCostTripwire()?.utcDay).toBe('2026-07-10');
});

// Cost SQL string invariants

test('utcDayCostSumSql sums llm_logs.cost_usd over the current UTC day', () => {
  const sql = utcDayCostSumSql();
  expect(sql).toContain('FROM llm_logs');
  expect(sql).toContain('SUM(cost_usd)');
  expect(sql).toContain(`AT TIME ZONE 'UTC'`);
  expect(sql).toContain(`date_trunc('day'`);
  expect(sql).toContain('created_at >='); // index-friendly range scan, not cast-per-row
});

test('currentUtcDay is a UTC YYYY-MM-DD independent of local offset', () => {
  // Same UTC calendar day regardless of host TZ.
  expect(currentUtcDay(new Date('2026-07-10T23:30:00Z'))).toBe('2026-07-10');
  expect(currentUtcDay(new Date('2026-07-11T00:30:00Z'))).toBe('2026-07-11');
});
