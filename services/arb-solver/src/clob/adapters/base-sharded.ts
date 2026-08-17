import type { Platform } from '@arb/types';
import type { Logger } from '@arb/logger';
import { BaseClobAdapter } from './base.js';
import type { MarketSubscription } from '../price-cache.js';
import { hrNowMs } from '../geo-compare/instrumentation.js';

/** Generic connection-sharded CLOB adapter base: partitions the subscription-id space into
 *  shards of `shardSize`, one connection each, with reconnect/keepalive + a once-per-connection
 *  first_message gate. Per-platform value stays in the subclass hooks below. Emission order per
 *  (re)connect: connect_start -> ws_open+connected -> subscribe_sent -> first_message -> close+
 *  disconnected -> reconnect_scheduled+reconnect. connId is allocated lazily at first connect(),
 *  reused across reconnects. */

export const WS_OPEN = 1;

/** Minimal transport surface abstracting raw `ws` (poly/kalshi/predict) and socket.io
 *  (limitless); a subclass's `openSocket` builds the real transport and returns this view. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  readonly readyState: number;
}

/** Canonical lifecycle handlers a subclass's `openSocket` wires onto the transport's native events. */
export interface ShardSocketHandlers {
  onOpen(): void;
  /** `payload` is the raw transport payload (Buffer/string for raw ws, parsed object for socket.io). */
  onMessage(payload: unknown, wireTs: number, wireHr: number): void;
  onClose(detail: { closeDetail: string; disconnectedDetail: string | undefined; logMessage: string }): void;
  onError(message: string): void;
}

/** Per-shard connection skeleton owned by the base; the subclass's TShard adds platform extras. */
export interface ShardConnBase {
  /** Survives reconnects; 0 ⟹ not yet connected. */
  connId: number;
  ids: Set<string>;
  conn: WsLike | null;
  firstMsgSeen: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
}

/** Abstract sharded adapter; `TShard` is the subclass's shard type (ShardConnBase + extras). */
export abstract class BaseShardedAdapter<TShard extends ShardConnBase> extends BaseClobAdapter {
  abstract readonly platform: Platform;
  protected abstract readonly log: Logger;

  protected readonly reconnectDelayMs = 5_000;

  protected readonly shardSize = this.readShardSize();
  protected shards: TShard[] = [];
  protected nextConnId = 0;
  protected subscriptions = new Map<string, MarketSubscription>();

  async start(markets: MarketSubscription[]): Promise<void> {
    for (const m of markets) this.subscriptions.set(m.platformId, m);
    this.running = true;
    await this.onBeforeConnectAll();
    this.partitionShards();
    for (const shard of this.shards) this.connect(shard);
    this.onAfterStart();
  }

  async subscribe(markets: MarketSubscription[]): Promise<void> {
    for (const m of markets) {
      this.subscriptions.set(m.platformId, m);
      this.assignIdToShard(m.platformId);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.onBeforeStop();
    for (const shard of this.shards) {
      if (shard.reconnectTimer) {
        clearTimeout(shard.reconnectTimer);
        shard.reconnectTimer = null;
      }
      this.stopKeepalive(shard);
      const conn = shard.conn;
      shard.conn = null;
      this.closeOnStop(conn);
    }
    this.shards = [];
  }

  protected partitionShards(): void {
    const ids = [...this.subscriptions.keys()];
    this.shards = [];
    const chunkCount = Math.max(1, Math.ceil(ids.length / this.shardSize));
    for (let c = 0; c < chunkCount; c++) {
      const chunk = ids.slice(c * this.shardSize, (c + 1) * this.shardSize);
      this.shards.push(this.makeShard(chunk));
    }
  }

  protected makeShard(ids: string[]): TShard {
    const base: ShardConnBase = {
      connId: 0,
      ids: new Set(ids),
      conn: null,
      firstMsgSeen: false,
      reconnectTimer: null,
      keepaliveTimer: null,
    };
    return { ...base, ...this.shardExtras() } as TShard;
  }

  /** Adds `id` to a shard with capacity (pushing it onto the live socket), else opens a fresh shard. */
  protected assignIdToShard(id: string): void {
    for (const shard of this.shards) {
      if (shard.ids.has(id)) return;
    }
    const target = this.shards.find((s) => s.ids.size < this.shardSize);
    if (target) {
      target.ids.add(id);
      this.onAssignToOpenShard(target, id);
      return;
    }
    const shard = this.makeShard([id]);
    this.shards.push(shard);
    if (this.running) this.connect(shard);
  }

  protected connect(shard: TShard): void {
    if (!this.running) return;

    // Header build runs before connId allocation, so an auth failure on a shard's first
    // connect emits with its still-0 connId (kalshi rebuilds RSA-PSS auth here and may throw).
    let headers: Record<string, string>;
    try {
      headers = this.buildConnectHeaders(shard);
    } catch (err: any) {
      this.onHeaderError(err, shard);
      if (this.running) this.scheduleReconnectWithEvents(shard);
      return;
    }

    if (shard.connId === 0) shard.connId = ++this.nextConnId;
    shard.firstMsgSeen = false;
    this.resetShardState(shard);
    this.emitLifecycle('connect_start', shard.connId, `${shard.ids.size} subs`);

    const handlers: ShardSocketHandlers = {
      onOpen: () => this.handleOpen(shard),
      onMessage: (payload, wireTs, wireHr) => this.handleMessageEnvelope(shard, payload, wireTs, wireHr),
      onClose: (detail) => this.handleClose(shard, shard.conn, detail),
      onError: (message) => {
        this.log.error('WebSocket error:', message);
        this.emitReliability('error', message, shard.connId);
      },
    };

    try {
      shard.conn = this.openSocket(shard, headers, handlers);
    } catch (err) {
      this.log.error(this.connectFailedLogPrefix(), err);
      shard.conn = null;
      if (this.running) this.scheduleReconnectWithEvents(shard);
    }
  }

  protected handleOpen(shard: TShard): void {
    this.log.info(this.connectedLogMessage());
    this.emitLifecycle('ws_open', shard.connId);
    this.emitReliability('connected');
    this.onOpen(shard);
  }

  /** Kalshi overrides to start the ping before subscribing; the emitted-event stream is identical either way. */
  protected onOpen(shard: TShard): void {
    this.sendSubscribe(shard, [...shard.ids]);
    this.emitLifecycle('subscribe_sent', shard.connId, `${shard.ids.size}`);
    this.startKeepalive(shard);
  }

  protected handleMessageEnvelope(shard: TShard, payload: unknown, wireTs: number, wireHr: number): void {
    if (!shard.firstMsgSeen) {
      shard.firstMsgSeen = true;
      this.emitLifecycle('first_message', shard.connId);
    }
    this.handleFrame(shard, payload, wireTs, wireHr);
  }

  protected handleClose(
    shard: TShard,
    conn: WsLike | null,
    detail: { closeDetail: string; disconnectedDetail: string | undefined; logMessage: string },
  ): void {
    this.stopKeepalive(shard);
    this.log.warn(detail.logMessage);
    this.emitLifecycle('close', shard.connId, detail.closeDetail);
    this.emitReliability('disconnected', detail.disconnectedDetail);
    this.emitConnectionStale([...shard.ids]);
    this.onShardClose(shard);
    // Ignore a stale close event fired after this shard's socket was already swapped/stopped.
    if (shard.conn === conn) shard.conn = null;
    if (this.running) this.scheduleReconnectWithEvents(shard);
  }

  protected scheduleReconnectWithEvents(shard: TShard): void {
    this.emitLifecycle('reconnect_scheduled', shard.connId);
    this.emitReliability('reconnect');
    this.scheduleReconnect(shard);
  }

  /** The `reconnectTimer` guard makes this idempotent — a shard never stacks two timers. */
  protected scheduleReconnect(shard: TShard): void {
    if (!this.running || shard.reconnectTimer) return;
    shard.reconnectTimer = setTimeout(() => {
      shard.reconnectTimer = null;
      this.connect(shard);
    }, this.reconnectDelayMs);
  }

  protected startKeepalive(shard: TShard): void {
    const ms = this.keepaliveIntervalMs();
    if (ms <= 0 || shard.keepaliveTimer) return;
    shard.keepaliveTimer = setInterval(() => this.sendKeepalive(shard), ms);
  }

  protected stopKeepalive(shard: TShard): void {
    if (shard.keepaliveTimer) {
      clearInterval(shard.keepaliveTimer);
      shard.keepaliveTimer = null;
    }
  }

  /** Called once during field init, so it must not touch instance state. */
  protected abstract readShardSize(): number;

  /** May throw synchronously for raw-ws construction failures (caught by connect()'s try/catch). */
  protected abstract openSocket(shard: TShard, headers: Record<string, string>, handlers: ShardSocketHandlers): WsLike;

  protected abstract sendSubscribe(shard: TShard, ids: string[]): void;

  protected abstract handleFrame(shard: TShard, payload: unknown, wireTs: number, wireHr: number): void;

  protected shardExtras(): Partial<TShard> {
    return {};
  }

  protected buildConnectHeaders(_shard: TShard): Record<string, string> {
    return {};
  }

  protected onHeaderError(err: any, shard: TShard): void {
    this.log.error(`Auth error: ${err.message}`);
    this.emitReliability('error', err.message, shard.connId);
  }

  /** Runs after connId alloc + firstMsgSeen reset, before connect_start. */
  protected resetShardState(_shard: TShard): void {}

  protected connectedLogMessage(): string {
    return 'WebSocket connected';
  }

  protected connectFailedLogPrefix(): string {
    return 'Connection failed:';
  }

  protected onAssignToOpenShard(shard: TShard, id: string): void {
    if (shard.conn?.readyState === WS_OPEN) this.sendSubscribe(shard, [id]);
  }

  protected onShardClose(_shard: TShard): void {}

  protected keepaliveIntervalMs(): number {
    return 0;
  }

  protected sendKeepalive(_shard: TShard): void {}

  protected closeOnStop(conn: WsLike | null): void {
    conn?.close();
  }

  protected async onBeforeConnectAll(): Promise<void> {}

  protected onAfterStart(): void {}

  protected onBeforeStop(): void {}

  /** Shared by poly/kalshi/predict; each passes a `closeDetail` formatter for its
   *  platform-specific close strings. */
  protected wireRawWs(
    ws: import('ws').default,
    handlers: ShardSocketHandlers,
    closeDetail: (code: number, reason: Buffer) => { closeDetail: string; disconnectedDetail: string | undefined; logMessage: string },
    extra?: (ws: import('ws').default) => void,
  ): WsLike {
    ws.on('open', () => handlers.onOpen());
    ws.on('message', (data: import('ws').RawData) => {
      const wireTs = Date.now();
      const wireHr = hrNowMs();
      handlers.onMessage(data, wireTs, wireHr);
    });
    ws.on('close', (code: number, reason: Buffer) => handlers.onClose(closeDetail(code, reason)));
    ws.on('error', (err: Error) => handlers.onError(err.message));
    extra?.(ws);
    return {
      send: (d: string) => ws.send(d),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      ping: () => ws.ping(),
      get readyState() {
        return ws.readyState;
      },
    };
  }
}
