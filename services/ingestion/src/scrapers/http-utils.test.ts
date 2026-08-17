/**
 * Tests for the shared HTTP rate/concurrency limiters (http-utils.ts).
 *
 * These back the proactive per-venue throttles wired into the Kalshi, Limitless,
 * Polymarket (api-client) and Predict (api-client) clients — the limiter is the
 * hard floor that stops a catch-up burst from tripping a 429/ban loop, so its
 * spacing/ordering guarantees are load-bearing.
 */
import { describe, test, expect } from 'bun:test';
import { createRateLimiter, createConcurrencyLimiter } from './http-utils.js';

describe('createRateLimiter', () => {
  test('spaces calls one interval apart (caps throughput)', async () => {
    const maxRps = 40; // intervalMs = 25
    const limit = createRateLimiter(maxRps);
    const N = 8;

    const start = Date.now();
    await Promise.all(Array.from({ length: N }, () => limit(async () => Date.now())));
    const elapsed = Date.now() - start;

    // First slot is immediate; the remaining (N-1) are each intervalMs apart.
    // Expected floor = (N-1) * 25 = 175ms. Allow scheduler slack on the low side.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test('a single call is not delayed', async () => {
    const limit = createRateLimiter(5); // intervalMs = 200
    const start = Date.now();
    await limit(async () => 'ok');
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('returns the wrapped fn result', async () => {
    const limit = createRateLimiter(1000);
    await expect(limit(async () => 42)).resolves.toBe(42);
  });

  test('assigns distinct, monotonically increasing slots to a concurrent burst', async () => {
    const limit = createRateLimiter(50); // intervalMs = 20
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        limit(async () => {
          order.push(i);
          return i;
        }),
      ),
    );
    // Slots are claimed synchronously in call order, so bodies fire in that order.
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('createConcurrencyLimiter', () => {
  test('never exceeds the configured concurrency', async () => {
    const concurrency = 2;
    const limit = createConcurrencyLimiter(concurrency);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(concurrency);
    expect(peak).toBeGreaterThan(0);
  });

  test('returns the wrapped fn result', async () => {
    const limit = createConcurrencyLimiter(3);
    await expect(limit(async () => 'value')).resolves.toBe('value');
  });
});
