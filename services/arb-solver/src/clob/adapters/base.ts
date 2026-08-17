import type { Platform } from '@arb/types';
import type { PriceUpdate, MarketSubscription } from '../price-cache.js';
import type {
  InstrEvent,
  LifecyclePhase,
  ReliabilityKind,
} from '../geo-compare/instrumentation.js';
import { hrNowMs } from '../geo-compare/instrumentation.js';

/** Resolution event emitted by a CLOB adapter when the platform pushes a
 *  market_resolved / marketResolved event on the orderbook socket. The
 *  arb-solver subscribes to these via `onMarketResolved` and evicts the
 *  market from the price cache + persists the settlement to the DB. */
export interface ResolutionEvent {
  platform: Platform;
  /** Platform-native market identifier — what we stored in `markets.platform_id`. */
  platformId: string;
  winningOutcome: string | null;
  /** Optional ISO timestamp from the platform; otherwise `new Date()` is used. */
  timestamp?: string;
}

/**
 * Uniform interface for all platform CLOB adapters.
 * Each adapter wraps platform-specific WS/polling logic.
 */
export interface ClobAdapter {
  readonly platform: Platform;
  start(markets: MarketSubscription[]): Promise<void>;
  onPriceUpdate(cb: (update: PriceUpdate) => void): void;
  onMarketResolved(cb: (event: ResolutionEvent) => void): void;
  /** Register an instrumentation sink (geo-compare). Additive, opt-in: when no
   *  callback is registered the adapter emits no instrumentation events. */
  onInstrumentation(cb: (e: InstrEvent) => void): void;
  subscribe(markets: MarketSubscription[]): Promise<void>;
  unsubscribe(marketIds: string[]): Promise<void>;
  /** Register a connection-staleness sink. Fired with the platform-native ids
   *  (clobTokenId / slug / ticker / predict id) of a shard whose socket just
   *  dropped, so the manager can sentinel those books until they re-snapshot.
   *  Additive: no-op when no sink is registered. */
  onConnectionStale(cb: (platformIds: string[]) => void): void;
  stop(): Promise<void>;
}

/**
 * Base adapter with shared infrastructure.
 * Platform-specific subclasses implement the actual WS/poll logic.
 */
export abstract class BaseClobAdapter implements ClobAdapter {
  abstract readonly platform: Platform;
  protected callbacks: Array<(update: PriceUpdate) => void> = [];
  protected resolutionCallbacks: Array<(event: ResolutionEvent) => void> = [];
  /** Connection-staleness sinks (markStale-on-disconnect). Empty ⟹
   *  emitConnectionStale is a no-op, so a subclass with no manager wired pays
   *  nothing. */
  protected staleCallbacks: Array<(platformIds: string[]) => void> = [];
  /** geo-compare instrumentation sinks. Empty ⟹ emitLifecycle/emitReliability
   *  are no-ops, so production runs (which never register) pay nothing. */
  protected instrCallbacks: Array<(e: InstrEvent) => void> = [];
  protected running = false;

  /** Remaining raw-payload dumps for this adapter when `CLOB_DUMP_RAW=1`. The
   *  perf harness uses this to verify what the wire actually carries (e.g. is
   *  Limitless's `orderbookUpdate` truly yes-only?). Decremented inside each
   *  subclass's `ws.on('message')` handler. */
  protected rawDumpsLeft: number = (() => {
    if (process.env.CLOB_DUMP_RAW !== '1') return 0;
    return parseInt(process.env.CLOB_DUMP_RAW_LIMIT ?? '10', 10) || 0;
  })();

  /** Called by subclasses inside their WS `message` handler. Prints the raw
   *  payload (first N per adapter) to stderr so the runner's tee captures it
   *  alongside the normal log stream. No-op when CLOB_DUMP_RAW is unset. */
  protected dumpRaw(payload: unknown): void {
    if (this.rawDumpsLeft <= 0) return;
    this.rawDumpsLeft--;
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const truncated = s.length > 1500 ? s.slice(0, 1500) + `…[${s.length} bytes]` : s;
    process.stderr.write(`[CLOB-RAW ${this.platform}] ${truncated}\n`);
  }

  onPriceUpdate(cb: (update: PriceUpdate) => void): void {
    this.callbacks.push(cb);
  }

  onMarketResolved(cb: (event: ResolutionEvent) => void): void {
    this.resolutionCallbacks.push(cb);
  }

  onInstrumentation(cb: (e: InstrEvent) => void): void {
    this.instrCallbacks.push(cb);
  }

  onConnectionStale(cb: (platformIds: string[]) => void): void {
    this.staleCallbacks.push(cb);
  }

  /** Fan a shard's platform-native ids out to the staleness sinks when its
   *  socket drops. The manager maps these to marketIds and sentinels the books
   *  until they re-snapshot — closing the window where a stale/partial book is
   *  served as fresh across a reconnect gap. No-op when no sink is registered. */
  protected emitConnectionStale(platformIds: string[]): void {
    if (this.staleCallbacks.length === 0 || platformIds.length === 0) return;
    for (const cb of this.staleCallbacks) cb(platformIds);
  }

  /** Emit a connection-lifecycle timing event. No-op when no sink registered. */
  protected emitLifecycle(phase: LifecyclePhase, connId: number, detail?: string): void {
    if (this.instrCallbacks.length === 0) return;
    const e: InstrEvent = {
      type: 'lifecycle',
      platform: this.platform,
      phase,
      t: Date.now(),
      hr: hrNowMs(),
      connId,
      detail: detail !== undefined ? detail.slice(0, 200) : undefined,
    };
    for (const cb of this.instrCallbacks) cb(e);
  }

  /** Emit a reliability event. No-op when no sink registered. */
  protected emitReliability(kind: ReliabilityKind, detail?: string, connId?: number): void {
    if (this.instrCallbacks.length === 0) return;
    const e: InstrEvent = {
      type: 'reliability',
      platform: this.platform,
      kind,
      t: Date.now(),
      hr: hrNowMs(),
      connId,
      detail: detail !== undefined ? detail.slice(0, 200) : undefined,
    };
    for (const cb of this.instrCallbacks) cb(e);
  }

  protected emit(update: PriceUpdate): void {
    for (const cb of this.callbacks) {
      cb(update);
    }
  }

  /** Adapter subclasses call this when the platform pushes a resolution
   *  event. The base class fans the event out to subscribers; the manager
   *  layer is responsible for the DB write + cache eviction. */
  protected emitResolution(event: ResolutionEvent): void {
    this.emitReliability('resolution', event.platformId);
    for (const cb of this.resolutionCallbacks) {
      cb(event);
    }
  }

  abstract start(markets: MarketSubscription[]): Promise<void>;
  abstract subscribe(markets: MarketSubscription[]): Promise<void>;
  abstract unsubscribe(marketIds: string[]): Promise<void>;
  abstract stop(): Promise<void>;
}
