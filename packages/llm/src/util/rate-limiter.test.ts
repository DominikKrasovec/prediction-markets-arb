import { describe, test, expect } from 'bun:test';
import { GlobalLimiter } from './rate-limiter.js';
import { ApiError } from './retry.js';

describe('GlobalLimiter — concurrency cap', () => {
  test('never runs more than maxConcurrency fns at once', async () => {
    const lim = new GlobalLimiter(2, 'test');
    let active = 0;
    let maxActive = 0;
    const work = () =>
      lim.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return active;
      });
    await Promise.all(Array.from({ length: 8 }, work));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(active).toBe(0); // all permits released
  });

  test('permit hand-off does not lose or leak slots (all 8 complete)', async () => {
    const lim = new GlobalLimiter(3, 'test');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => lim.run(async () => i * 2)),
    );
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(lim.stats().inFlight).toBe(0);
  });
});

describe('GlobalLimiter — retry + shared backoff', () => {
  test('retries a transient failure then succeeds', async () => {
    const lim = new GlobalLimiter(2, 'test');
    let calls = 0;
    const result = await lim.run(
      async () => {
        calls++;
        if (calls < 2) throw new ApiError(503, 'unavailable');
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test("one caller's 429 retry-after pauses callers arriving during the pause (shared backoff)", async () => {
    // The realistic steady-state: a continuous stream of chunks. Once one call's
    // 429 sets the group pause, every call whose next attempt is gated DURING that
    // window waits — instead of each hammering the bucket independently. (A burst
    // already past its gate can't be un-fired; that's expected.)
    const lim = new GlobalLimiter(4, 'test');
    const t0 = Date.now();
    // A fails once with a wide ~300ms retry-after → publishes a group pause, then
    // succeeds. The window is deliberately large so the mid-pause assertions stay
    // robust even when the suite runs files in parallel under a loaded event loop.
    const a = lim.run(
      async () => {
        if (Date.now() - t0 < 250) throw new ApiError(429, 'rate limit', 300);
        return 'a';
      },
      { baseDelayMs: 1 },
    );
    // Give A a tick to fail + publish the pause, THEN submit B (arrives mid-pause).
    await new Promise((r) => setTimeout(r, 30));
    expect(lim.stats().pausedForMs).toBeGreaterThan(0); // pause is live
    let bStart = 0;
    const b = lim.run(async () => {
      bStart = Date.now() - t0;
      return 'b';
    });

    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(bStart).toBeGreaterThanOrEqual(150); // B held by the shared pause, not free at ~30ms
  });

  test('does not retry a non-retryable error (400)', async () => {
    const lim = new GlobalLimiter(1, 'test');
    let calls = 0;
    await expect(
      lim.run(async () => {
        calls++;
        throw new ApiError(400, 'bad request');
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // no retry
    expect(lim.stats().inFlight).toBe(0); // permit released on throw
  });
});
