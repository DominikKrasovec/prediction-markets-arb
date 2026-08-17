/**
 * Process-wide rate limiter for a single API rate-limit group (e.g. all OpenAI
 * embedding calls, which share one account-level TPM/RPM bucket).
 *
 * WHY: retry/backoff used to be PER-CALL. With multiple concurrent callers
 * (Stage 1c market embeds, Stage 2c event embeds, Stage 2a entity-resolver
 * embeds all hitting text-embedding-3-small), a 429 on one call made only THAT
 * call back off while the others kept hammering the same bucket → sustained
 * thrash. This limiter makes the limit GLOBAL across callers:
 *
 *   1. A counting semaphore caps total in-flight requests for the group (the
 *      single throttle, replacing each caller's own mapWithConcurrency limit).
 *   2. A shared `pausedUntil` — when ANY call schedules a retry (429 retry-after,
 *      5xx, or a timeout), every other in-flight/queued call of the group waits
 *      until the pause clears before its next attempt. One caller's retry-after
 *      now holds back the whole group.
 *
 * Deliberately NOT token-aware (no TPM accounting): the shared backoff converges
 * to the real limit reactively, which is enough here (see the embeddings plan).
 * Per-process scope (like single-flight) — the pipeline runs as one process.
 */
import { createLogger } from '@arb/logger';
import { withRetry, type RetryOptions } from './retry.js';

const log = createLogger('rate-limit');

export class GlobalLimiter {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  /** Epoch ms until which the whole group is paused (shared backoff). */
  private pausedUntil = 0;
  /** Warn-throttle so a sustained pause doesn't spam the log. */
  private lastPauseLogAt = 0;

  constructor(
    private readonly maxConcurrency: number,
    private readonly label: string,
  ) {}

  /** Acquire one permit (counting semaphore with direct hand-off on release). */
  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    // At capacity — queue. The permit is handed off directly on release, so the
    // in-flight count is NOT incremented again here (it was never decremented).
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the permit straight to the next waiter (count unchanged)
    else this.inFlight--; // nobody waiting → free the slot
  }

  /** Publish a shared pause (max-merged so the longest 429 retry-after wins). */
  private pause(delayMs: number): void {
    const until = Date.now() + delayMs;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    const now = Date.now();
    if (now - this.lastPauseLogAt > 1000) {
      this.lastPauseLogAt = now;
      log.warn(
        `${this.label}: group paused ${Math.round(delayMs)}ms ` +
          `(${this.inFlight} in-flight, ${this.waiters.length} queued)`,
      );
    }
  }

  /** Block until any active shared pause clears. */
  private async waitForPause(): Promise<void> {
    for (;;) {
      const wait = this.pausedUntil - Date.now();
      if (wait <= 0) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /**
   * Run `fn` under the group's concurrency + shared-backoff budget, with the
   * same retry semantics as `withRetry` (the limiter just wires the shared pause
   * into withRetry's hooks). The permit is held across all retries of one call
   * so a paused call doesn't free its slot to a caller that would only re-hit
   * the limit.
   */
  async run<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    await this.acquire();
    try {
      return await withRetry(fn, {
        ...opts,
        label: opts.label ?? this.label,
        beforeAttempt: () => this.waitForPause(),
        onRetryScheduled: (delayMs) => this.pause(delayMs),
      });
    } finally {
      this.release();
    }
  }

  /** Snapshot for tests / observability. */
  stats(): { inFlight: number; queued: number; pausedForMs: number } {
    return {
      inFlight: this.inFlight,
      queued: this.waiters.length,
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
    };
  }
}

/**
 * The single process-wide limiter for OpenAI embeddings (text-embedding-3-small).
 * BOTH embedding entry points route through it — `embedTexts` (raw fetch; Stage
 * 1c/2c) and `OpenAIProvider.embed` (SDK; Stage 2a resolvers) — so they share one
 * concurrency budget and one shared backoff. Tune with `EMBED_API_CONCURRENCY`
 * (now a GLOBAL cap, not per-caller). Default 4 — the shared backoff makes it
 * self-correcting if the account TPM is hit.
 */
export const embeddingLimiter = new GlobalLimiter(
  Math.max(1, parseInt(process.env.EMBED_API_CONCURRENCY ?? '4', 10) || 4),
  'embed',
);
