/**
 * Shared HTTP utilities: exponential backoff with full jitter + Retry-After support.
 *
 * Retry-After handling:
 *   - Numeric value → seconds to wait (capped at 60 s)
 *   - HTTP-date value → ms until that moment (capped at 60 s)
 *   - Absent → full-jitter exponential backoff
 *
 * "Full jitter" (AWS best-practice) picks a random delay in [0, cap] where
 * cap = min(maxDelayMs, baseDelayMs * 2^attempt).  This avoids thundering-herd
 * retries when many scrapers hit the same 429 at the same instant.
 */

import { createLogger } from '@arb/logger';

const log = createLogger('http');

export interface RetryOptions {
  /** Max number of retry attempts after the initial try. Default 6. */
  maxRetries?: number;
  /** Base delay in ms (doubles each attempt). Default 500. */
  baseDelayMs?: number;
  /** Hard cap on computed delay. Default 32_000. */
  maxDelayMs?: number;
  /** HTTP status codes that are safe to retry. Default: [429,500,502,503,504]. */
  retryableStatuses?: readonly number[];
  /** Prefix shown in retry log lines, e.g. '[kalshi]'. */
  label?: string;
}

const DEFAULT_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

function isRetryable(err: any, statuses: readonly number[]): boolean {
  const code: string | undefined = err.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND') return true;
  const status: number | undefined = err.response?.status;
  return status !== undefined && statuses.includes(status);
}

/** Parse Retry-After header → ms to wait, or null if absent/unparseable. */
function retryAfterMs(err: any): number | null {
  const header: string | undefined = err.response?.headers?.['retry-after'];
  if (!header) return null;
  const secs = parseFloat(header);
  if (!isNaN(secs)) return Math.min(secs * 1_000, 60_000);
  const ts = Date.parse(header);
  if (!isNaN(ts)) return Math.max(0, Math.min(ts - Date.now(), 60_000));
  return null;
}

/** Full-jitter delay: uniform in [0, min(maxDelayMs, baseDelayMs * 2^attempt)]. */
function jitter(attempt: number, base: number, cap: number): number {
  return Math.random() * Math.min(cap, base * Math.pow(2, attempt));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 6,
    baseDelayMs = 500,
    maxDelayMs = 32_000,
    retryableStatuses = DEFAULT_STATUSES,
    label = '',
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt >= maxRetries) break;
      if (!isRetryable(err, retryableStatuses)) throw err;

      const delay = retryAfterMs(err) ?? jitter(attempt, baseDelayMs, maxDelayMs);
      const status = err.response?.status ?? err.code ?? 'ERR';
      // Only log the last retry attempt or non-429 errors to reduce noise
      if (attempt + 1 === maxRetries || status !== 429) {
        log.warn(
          `${label ? label + ' ' : ''}retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms (${status}: ${err.message})`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Lightweight async concurrency limiter – no external dependency.
 * At most `concurrency` promises are in-flight at the same time.
 *
 * Usage:
 *   const limit = createConcurrencyLimiter(3);
 *   await Promise.all(items.map(item => limit(() => fetch(item))));
 */
export function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function dispatch() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    queue.shift()!();
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      dispatch();
    });
    try {
      return await fn();
    } finally {
      active--;
      dispatch();
    }
  };
}

/**
 * True requests-per-second rate limiter using a leaky-bucket slot system.
 *
 * Each call acquires the next available slot. Slots are spaced exactly
 * 1000/maxRps ms apart. If requests arrive faster than the rate, they queue
 * and wait for their slot — no request is dropped.
 *
 * This is safe in a single-threaded JS runtime: the slot assignment is
 * synchronous (no await between read and write of `nextSlotAt`), so two
 * concurrent callers always get distinct, non-overlapping slots.
 *
 * Usage:
 *   const limit = createRateLimiter(18);  // max 18 req/s
 *   await Promise.all(items.map(item => limit(() => fetch(item))));
 */
export function createRateLimiter(maxRps: number) {
  const intervalMs = 1000 / maxRps;
  let nextSlotAt = 0; // absolute timestamp (ms) of the next available slot

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    // Claim the next available slot (atomic — no await between read and write)
    const slot = Math.max(now, nextSlotAt);
    nextSlotAt = slot + intervalMs;

    const waitMs = slot - now;
    if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));

    return fn();
  };
}
