/**
 * BaseLifecycleWatcher — shared infrastructure for all WSS lifecycle watchers.
 *
 * Extracts the boilerplate that is identical across KalshiLifecycleWatcher,
 * PolymarketLifecycleWatcher, and LimitlessLifecycleWatcher:
 *   - Constructor fields (refillCallback, verbose, onEvent)
 *   - Public counters and stats()
 *   - handleReconnectRefill()  — identical across all platforms
 *   - scheduleReconnect()      — identical for raw-WS platforms (Kalshi, Polymarket)
 *   - log() / logState()       — identical across all platforms
 *
 * Subclasses must implement:
 *   - connect()       — platform-specific connection setup
 *   - disconnect()    — platform-specific teardown
 *   - isConnected()   — platform-specific connection state check
 */

import { createLogger } from '@arb/logger';

// ─── Reconnect constants (shared by Kalshi + Polymarket raw-WS watchers) ──────

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS  = 30_000;

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Called on reconnect with the moment the connection was lost (minus 1-min overlap). */
export type RefillCallback = (gapSince: Date) => Promise<void>;

/**
 * Called on every successful WSS new-market or settled write so the host can
 * mark its sync flag dirty immediately. Without this hook, new markets only
 * trigger a sync when the stats timer detects a counter delta minutes later.
 *
 * The callback is invoked synchronously from the message handler and must be
 * cheap (typically just `syncDirty = true`).
 */
export type LifecycleEventCallback = (kind: 'created' | 'resolved') => void;

export interface LifecycleStats {
  connected: boolean;
  reconnectCount: number;
  messagesReceived: number;
  marketsCreated: number;
  marketsResolved: number;
}

// ─── Base class ───────────────────────────────────────────────────────────────

export abstract class BaseLifecycleWatcher {
  /** Timestamp when the connection last dropped — used for REST refill window. */
  protected disconnectedAt: Date | null = null;
  protected shouldReconnect = true;
  protected reconnectAttempts = 0;
  protected reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  public reconnectCount = 0;
  public messagesReceived = 0;
  public marketsCreated = 0;
  public marketsResolved = 0;

  private readonly _log: ReturnType<typeof createLogger>;

  constructor(
    logName: string,
    protected readonly refillCallback: RefillCallback | null = null,
    protected readonly verbose = false,
    protected readonly onEvent: LifecycleEventCallback | null = null,
  ) {
    this._log = createLogger(logName);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  protected abstract isConnected(): boolean;

  stats(): LifecycleStats {
    return {
      connected: this.isConnected(),
      reconnectCount: this.reconnectCount,
      messagesReceived: this.messagesReceived,
      marketsCreated: this.marketsCreated,
      marketsResolved: this.marketsResolved,
    };
  }

  /**
   * On reconnect, fires the refill callback with a 1-minute overlap window
   * to cover any markets created/settled during the disconnect gap.
   * Identical across all platforms.
   */
  protected handleReconnectRefill(): void {
    if (!this.disconnectedAt || !this.refillCallback) {
      this.disconnectedAt = null;
      return;
    }
    const gapSince = new Date(this.disconnectedAt.getTime() - 60_000);
    this.disconnectedAt = null;
    this.refillCallback(gapSince).catch((err) =>
      this.log(`Refill callback error: ${err.message}`, true));
  }

  /**
   * Exponential-backoff reconnect scheduler for raw-WS platforms (Kalshi,
   * Polymarket). Limitless delegates reconnect to socket.io and does not call
   * this method.
   */
  protected scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.reconnectCount++;
    this.logState(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})…`);
    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((err) => this.log(`Reconnect failed: ${err.message}`, true));
    }, delay);
  }

  protected logState(msg: string): void {
    this._log.info(msg);
  }

  protected log(msg: string, isError = false): void {
    if (this.verbose || isError) {
      if (isError) { this._log.error(msg); } else { this._log.info(msg); }
    }
  }
}
