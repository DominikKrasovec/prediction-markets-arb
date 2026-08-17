/**
 * Exponential-backoff retry wrapper for LLM / embedding API calls.
 *
 * Retries on:
 *   - HTTP 429  (rate limit / quota exceeded) — respects Retry-After header when present
 *   - HTTP 500, 502, 503, 504  (transient server errors)
 *   - Network-level errors (ECONNRESET, ETIMEDOUT, fetch failed, etc.)
 *
 * Does NOT retry on:
 *   - 400 Bad Request  (invalid input — retrying won't help)
 *   - 401 Unauthorized / 403 Forbidden  (credentials issue — fail fast)
 *
 * Default schedule: 1s → 2s → 4s → 8s → 16s (5 attempts, ~31s worst case).
 * For 429s the Retry-After header overrides the backoff delay.
 */

import { createLogger } from '@arb/logger';

const log = createLogger('retry');

export interface RetryOptions {
  /** Maximum attempts including the first try. Default: 5 */
  maxAttempts?: number;
  /**
   * Extra retry budget reserved for HTTP 429 (rate-limit). 429s should keep
   * retrying as long as the server says "try again in <reasonable>" because
   * each retry costs nothing; only 5xx / network errors should burn through
   * the small budget. Default: 20 additional attempts for 429s on top of
   * `maxAttempts`. Pass 0 to use a single shared budget.
   */
  maxRateLimitAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 30000 */
  maxDelayMs?: number;
  /** Jitter fraction [0, 1]. Default: 0.25  (±25%) */
  jitter?: number;
  /** Label for log messages */
  label?: string;
  /**
   * Awaited at the START of every attempt (including the first). A rate limiter
   * passes the group's "wait until the shared pause clears" gate here, so a 429
   * on ONE concurrent call holds back EVERY caller of the same group instead of
   * each one independently hammering the limit. Default: no-op.
   */
  beforeAttempt?: () => void | Promise<void>;
  /**
   * Called when a retry is scheduled, with the delay about to be slept and the
   * triggering error — BEFORE the sleep. A rate limiter publishes this delay to
   * the shared `pausedUntil` so other in-flight/queued callers back off too.
   */
  onRetryScheduled?: (delayMs: number, err: unknown) => void;
}

/** HTTP statuses that are safe to retry */
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

/** Substrings in error messages that indicate a transient network/timeout problem. */
const RETRYABLE_MSG = [
  'econnreset', 'etimedout', 'fetch failed', 'network error', 'socket hang up',
  'connection reset', 'timed out', 'timeout', 'request aborted', 'other side closed',
];

/**
 * Node/undici error codes for transient failures. DOMException-style timeout
 * `name`s go in RETRYABLE_NAMES below.
 */
const RETRYABLE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND',
]);

/**
 * Error `name`s for a transient abort/timeout. CRITICAL: a fetch timeout — from
 * `AbortSignal.timeout()` or undici's body/headers timeout — surfaces as a bare
 * `DOMException { name: 'TimeoutError', code: 23 }`, which is NOT an `instanceof
 * Error` in Node. The old classifier's `instanceof Error` gate silently dropped it
 * → `withRetry` rethrew → an uncaught fatal that killed long embed runs after tens
 * of thousands of successful calls. We now inspect any object's name/code/message.
 */
const RETRYABLE_NAMES = new Set(['TimeoutError', 'AbortError']);

export function isRetryable(err: unknown): boolean {
  // A concrete HTTP status decides on its own — never fall through to message
  // matching for it (a 400 whose body mentions "timeout" must NOT be retried).
  if (err instanceof ApiError && Number.isFinite(err.status)) {
    return RETRYABLE_HTTP.has(err.status);
  }
  if (err && typeof err === 'object') {
    const o = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof o.name === 'string' && RETRYABLE_NAMES.has(o.name)) return true;
    if (typeof o.code === 'string' && RETRYABLE_CODES.has(o.code)) return true;
    if (typeof o.message === 'string') {
      const msg = o.message.toLowerCase();
      if (RETRYABLE_MSG.some((s) => msg.includes(s))) return true;
    }
    // undici wraps the underlying failure as `TypeError: fetch failed` with the real
    // error on `.cause` — inspect one level deep (guard against self-reference).
    if (o.cause && o.cause !== err && isRetryable(o.cause)) return true;
  }
  return false;
}

/**
 * Delay parsed from a Retry-After header value (seconds int or HTTP-date).
 * Floor is 100ms — the previous 500ms floor was masking sub-second waits
 * (e.g. OpenAI rate-limit body says "try again in 52ms" while the
 * Retry-After header gets rounded up to 1 second; the body parser handles
 * that case more precisely via `parseRetryAfterFromBody`).
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return Math.max(seconds * 1000, 100);
  const date = new Date(header).getTime();
  if (!isNaN(date)) return Math.max(date - Date.now(), 100);
  return null;
}

/**
 * OpenAI / Anthropic / similar provider 429 bodies often say
 * "Please try again in 52ms" or "Please try again in 1.5s" — more precise
 * than the seconds-rounded Retry-After header. Returns the parsed delay in
 * ms, or null if no recognizable phrase is present.
 *
 * Floor 100ms to avoid hot loops; caller adds jitter on top.
 */
export function parseRetryAfterFromBody(body: string): number | null {
  // "try again in 52ms", "try again in 1.5s", "try again in 2 seconds"
  const m = body.match(/try again in\s+([0-9]*\.?[0-9]+)\s*(ms|s|seconds?)\b/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!isFinite(value) || value < 0) return null;
  const unit = m[2].toLowerCase();
  const ms = unit === 'ms' ? value : value * 1000;
  return Math.max(ms, 100);
}

/** Thin wrapper that preserves the HTTP status on thrown errors */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 5,
    maxRateLimitAttempts = 20,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = 0.25,
    label = 'api',
    beforeAttempt,
    onRetryScheduled,
  } = options;

  let lastErr: unknown;
  let attempt = 0;
  let nonRateLimitAttempts = 0;
  let rateLimitAttempts = 0;

  for (;;) {
    attempt++;
    if (beforeAttempt) await beforeAttempt();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (!isRetryable(err)) throw err;

      const is429 = err instanceof ApiError && err.status === 429;
      if (is429) rateLimitAttempts++; else nonRateLimitAttempts++;

      // Two separate budgets so a steady stream of 429s with short retry-afters
      // (the common case under TPM saturation) doesn't consume the small
      // 5xx/network budget. 429s are cheap and bounded by the actual wait, so
      // we tolerate many more attempts.
      const budgetExhausted =
        nonRateLimitAttempts >= maxAttempts ||
        rateLimitAttempts    >= maxRateLimitAttempts;
      if (budgetExhausted) break;

      // Determine delay:
      //   1. ApiError.retryAfterMs (parsed from header or body — most precise)
      //   2. Exponential backoff + jitter (network errors, 5xx without header)
      let delayMs: number;
      if (err instanceof ApiError && err.retryAfterMs !== null) {
        // Add a small jitter (±25% of base) on top of the precise retry-after
        // to avoid thundering-herd alignment when many parallel calls all see
        // the same "try again in 52ms" simultaneously.
        const jit = err.retryAfterMs * jitter * Math.random();
        delayMs = Math.max(err.retryAfterMs + jit, 100);
      } else {
        const expo = baseDelayMs * 2 ** (Math.min(nonRateLimitAttempts, 10) - 1);
        const capped = Math.min(expo, maxDelayMs);
        const jitterMs = capped * jitter * (Math.random() * 2 - 1); // ±jitter
        delayMs = Math.max(capped + jitterMs, 100);
      }

      const status = err instanceof ApiError ? err.status : 'net';
      const budgetLabel = is429
        ? `${rateLimitAttempts}/${maxRateLimitAttempts}rl`
        : `${nonRateLimitAttempts}/${maxAttempts}`;
      log.warn(
        `${label} attempt ${attempt} failed (${status}, ${budgetLabel}), ` +
        `retrying in ${Math.round(delayMs)}ms`
      );
      // Publish the delay to any shared limiter BEFORE sleeping, so concurrent
      // callers of the same group pause too (not just this one).
      onRetryScheduled?.(delayMs, err);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}
