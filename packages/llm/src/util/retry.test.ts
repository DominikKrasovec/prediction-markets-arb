import { describe, test, expect } from 'bun:test';
import { parseRetryAfterFromBody, parseRetryAfterMs, isRetryable, ApiError, withRetry } from './retry.js';

describe('isRetryable — timeouts & transient errors', () => {
  test('DOMException TimeoutError (fetch/AbortSignal.timeout) is retryable', () => {
    // The exact crash class. In Node a DOMException is NOT instanceof Error (the old
    // `instanceof Error` gate dropped it → fatal); the name-based check below works
    // regardless of runtime (Bun makes DOMException an Error, Node does not).
    const dom = new DOMException('The operation timed out.', 'TimeoutError');
    expect(isRetryable(dom)).toBe(true);
  });

  test('AbortError DOMException is retryable', () => {
    expect(isRetryable(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  test('undici timeout codes are retryable', () => {
    expect(isRetryable({ name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT', message: 'x' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
  });

  test('TypeError: fetch failed (with a timeout cause) is retryable via cause', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' };
    expect(isRetryable(err)).toBe(true);
  });

  test('timeout-worded Error messages are retryable', () => {
    expect(isRetryable(new Error('Request timed out.'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  test('retryable HTTP statuses on ApiError', () => {
    expect(isRetryable(new ApiError(503, 'unavailable'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'rate limit'))).toBe(true);
  });

  test('a real 400/401 is NOT retried even if its body mentions "timeout"', () => {
    expect(isRetryable(new ApiError(400, 'bad request: timeout param invalid'))).toBe(false);
    expect(isRetryable(new ApiError(401, 'unauthorized'))).toBe(false);
  });

  test('non-transient errors are not retryable', () => {
    expect(isRetryable(new Error('TypeError: cannot read property of undefined'))).toBe(false);
    expect(isRetryable('a string')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });

  test('withRetry actually retries a DOMException TimeoutError and then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new DOMException('The operation timed out.', 'TimeoutError');
        return 'ok';
      },
      { label: 'test', baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});

describe('parseRetryAfterFromBody', () => {
  test('parses OpenAI-style "Please try again in 52ms"', () => {
    const body = '{"error":{"message":"Rate limit ... Please try again in 52ms. Visit ..."}}';
    expect(parseRetryAfterFromBody(body)).toBe(100); // floored
  });

  test('parses sub-second milliseconds at boundary', () => {
    expect(parseRetryAfterFromBody('try again in 250ms')).toBe(250);
    expect(parseRetryAfterFromBody('try again in 99ms')).toBe(100); // floor
  });

  test('parses fractional seconds — "1.5s"', () => {
    expect(parseRetryAfterFromBody('try again in 1.5s')).toBe(1500);
  });

  test('parses "N seconds" word form', () => {
    expect(parseRetryAfterFromBody('try again in 2 seconds')).toBe(2000);
    expect(parseRetryAfterFromBody('try again in 1 second')).toBe(1000);
  });

  test('returns null when no recognizable phrase', () => {
    expect(parseRetryAfterFromBody('unrelated error message')).toBeNull();
    expect(parseRetryAfterFromBody('')).toBeNull();
  });

  test('case-insensitive', () => {
    expect(parseRetryAfterFromBody('TRY AGAIN IN 500ms')).toBe(500);
  });
});

describe('parseRetryAfterMs', () => {
  test('parses integer seconds', () => {
    expect(parseRetryAfterMs('1')).toBe(1000);
    expect(parseRetryAfterMs('30')).toBe(30000);
  });

  test('returns null for missing header', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
  });

  test('parses HTTP-date — clamped to >= 100ms', () => {
    // Past date: should clamp to floor 100ms (not negative)
    const ms = parseRetryAfterMs(new Date(Date.now() - 60000).toUTCString());
    expect(ms).toBe(100);
  });

  test('floor changed from 500ms to 100ms (regression check for sub-second 429s)', () => {
    // "1" second header used to clamp to 1000ms (still ok), but the floor
    // applied to date math used to be 500 — now 100. Confirm small values
    // are not over-inflated.
    expect(parseRetryAfterMs('0')).toBe(100);
  });
});
