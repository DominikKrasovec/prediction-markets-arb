/**
 * lifecycle-bench — DB-less, instrumented mirrors of the three WSS lifecycle
 * watchers (Kalshi / Polymarket / Limitless).
 *
 * Each class reuses the DB-free `BaseLifecycleWatcher` (reconnect/backoff/refill
 * counters) and replicates its production sibling's connect / subscribe / frame
 * routing **verbatim**, but:
 *   - routes `created` / `resolved` detections to the {@link BenchSink} as
 *     `discovery` events INSTEAD of `dbService.saveMarkets` /
 *     `writeAndPublishResolution` — i.e. it measures discovery without persisting
 *     anything; and
 *   - emits `lifecycle` (connect→first-frame timing) and `reliability`
 *     (connect/disconnect/error/reconnect/heartbeat) events for the report.
 *
 * KEEP IN SYNC with the production watchers — every connection detail
 * (URL, subscribe frame, ping cadence, stale-watchdog timeout) is copied from:
 *   - services/ingestion/src/lifecycle/kalshi-lifecycle.ts
 *   - services/ingestion/src/lifecycle/polymarket-lifecycle.ts
 *   - services/ingestion/src/lifecycle/limitless-lifecycle.ts
 * If a prod connection detail changes, change it here too or the benchmark stops
 * measuring the real feed.
 */

import WebSocket from 'ws';
import { io, type Socket } from 'socket.io-client';
import { createAuthHeaders } from '@arb/kalshi-auth';
import { BaseLifecycleWatcher } from '../lifecycle/base-watcher.js';
import {
  hrNowMs,
  type BenchPlatform,
  type BenchSink,
  type LifecyclePhase,
  type ReliabilityKind,
} from './metrics.js';
import { extractServerTs } from './clock.js';
import { unifiedCategory, nativeType } from './classify.js';
import { classifyCategoryLabels } from './unified-category.js';
import { fetchEventByTicker } from '../scrapers/kalshi/api-client.js';

// ─── Shared bench base ─────────────────────────────────────────────────────────

abstract class BenchWatcherBase extends BaseLifecycleWatcher {
  protected connId = 0;
  private sawFirstMsgThisConn = false;

  constructor(
    logName: string,
    protected readonly platform: BenchPlatform,
    protected readonly sink: BenchSink,
    protected readonly clockOffsetMs: number,
    verbose: boolean,
  ) {
    // No refill callback (bench never persists / re-scrapes) and no onEvent hook.
    super(logName, null, verbose, null);
  }

  protected lc(phase: LifecyclePhase, detail?: string): void {
    this.sink.emit({
      type: 'lifecycle', platform: this.platform, phase,
      t: Date.now(), hr: hrNowMs(), connId: this.connId, detail,
    });
  }

  protected rel(kind: ReliabilityKind, detail?: string): void {
    this.sink.emit({
      type: 'reliability', platform: this.platform, kind,
      t: Date.now(), hr: hrNowMs(), connId: this.connId, detail,
    });
  }

  /**
   * Emit a discovery. `unifiedOverride` lets a platform supply an authoritative
   * unified category (e.g. Kalshi --kalshi-enrich via fetchEventByTicker)
   * instead of the frame-text classification. `recvT` is the FRAME-ARRIVAL wall
   * time — pass it when emission is deferred behind an async enrichment so the
   * detection latency reflects arrival, not the enrichment round-trip.
   */
  protected disc(
    kind: 'created' | 'resolved',
    id: string,
    payload: unknown,
    title?: string,
    unifiedOverride?: string,
    recvT: number = Date.now(),
  ): void {
    const { epochMs, field } = extractServerTs(payload, kind);
    const detectMs = epochMs !== null ? (recvT + this.clockOffsetMs) - epochMs : null;
    const native = nativeType(this.platform, payload);
    this.sink.captureRaw(this.platform, kind, payload);
    this.sink.emit({
      type: 'discovery', platform: this.platform, kind,
      t: recvT, hr: hrNowMs(), connId: this.connId,
      id, serverTs: epochMs, tsField: field, detectMs,
      marketType: unifiedOverride ?? unifiedCategory(this.platform, payload),
      nativeType: native.type, typeField: native.field, title,
    });
  }

  /** Every inbound frame; first one after (re)connect closes the first_message timing. */
  protected onFrame(isHeartbeat = false): void {
    this.sink.noteFrame(this.platform, Date.now(), isHeartbeat);
    if (!this.sawFirstMsgThisConn) {
      this.sawFirstMsgThisConn = true;
      this.lc('first_message');
    }
  }

  protected beginConnect(): void {
    this.connId++;
    this.sawFirstMsgThisConn = false;
    this.lc('connect_start');
  }
}

// ─── Kalshi ────────────────────────────────────────────────────────────────────
// MIRRORS services/ingestion/src/lifecycle/kalshi-lifecycle.ts

const KALSHI_WS_PATH = '/trade-api/ws/v2';
const KALSHI_PING_INTERVAL_MS = 10_000;
const KALSHI_STALE_TIMEOUT_MS = 60_000;

/** Kalshi market_ticker = event_ticker + '-' + strikeId → drop the last segment. */
function deriveEventTicker(marketTicker: string): string {
  const parts = marketTicker.split('-');
  return parts.length >= 3 ? parts.slice(0, -1).join('-') : marketTicker;
}

export class KalshiLifecycleBench extends BenchWatcherBase {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private cmdId = 1;
  private lastMessageTs = 0;
  /** event_ticker → unified category, from the read-only event lookup (enrich mode). */
  private readonly catCache = new Map<string, string | undefined>();
  /** event_ticker → in-flight lookup, so a settlement burst of N same-event
   *  markets collapses to ONE fetch (mirrors prod ensureKalshiEvent coalescing).
   *  Without this, a NASDAQ-ladder hour-settle fired ~53 concurrent fetches for
   *  one event → a connection-refused storm (ECONNREFUSED ×53). */
  private readonly catInFlight = new Map<string, Promise<string | undefined>>();

  constructor(
    sink: BenchSink,
    clockOffsetMs: number,
    verbose: boolean,
    /**
     * When true, resolve each Kalshi market's UNIFIED category authoritatively
     * via a READ-ONLY `fetchEventByTicker` lookup (event.category → the shared
     * classifier) — exactly how the pipeline sources Kalshi category, minus the
     * DB write. Off by default: the WSS frame carries no category, so without
     * this we fall back to additional_metadata title-text classification.
     */
    private readonly enrich = false,
  ) {
    super('bench:kalshi', 'kalshi', sink, clockOffsetMs, verbose);
  }

  protected isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { resolve(); return; }
      this.beginConnect();

      const baseUrl = process.env.KALSHI_WS_URL ?? 'wss://api.elections.kalshi.com';
      const url = baseUrl.endsWith(KALSHI_WS_PATH) ? baseUrl : baseUrl + KALSHI_WS_PATH;

      let authHeaders: Record<string, string>;
      try {
        authHeaders = createAuthHeaders('GET', KALSHI_WS_PATH);
      } catch (err: any) {
        this.rel('error', `auth: ${err.message}`);
        reject(new Error(`Kalshi lifecycle WS auth failed: ${err.message}`));
        return;
      }

      this.logState(`Connecting to ${url}…`);
      this.ws = new WebSocket(url, { headers: authHeaders });

      const connectTimeout = setTimeout(() => {
        this.rel('error', 'connect timeout 15s');
        reject(new Error('Kalshi lifecycle WS connection timeout (15s)'));
        this.ws?.terminate();
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempts = 0;
        this.lc('ws_open');
        this.rel('connected');
        this.startPingInterval();
        this.sendSubscribe();
        this.lc('subscribe_sent', 'market_lifecycle_v2');
        this.handleReconnectRefill();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.lastMessageTs = Date.now();
        this.onFrame(false);
        try {
          const env = JSON.parse(data.toString()) as { type: string; msg?: any };
          this.handleEnvelope(env);
        } catch { /* malformed */ }
      });

      this.ws.on('pong', () => {
        this.lastMessageTs = Date.now();
        this.sink.noteFrame('kalshi', Date.now(), true);
        this.rel('heartbeat_in');
      });

      this.ws.on('close', (code, reason) => {
        this.stopPingInterval();
        this.disconnectedAt ??= new Date();
        this.lc('close', `code=${code}`);
        this.rel('disconnected', `code=${code} reason=${reason.toString() || 'none'}`);
        if (this.shouldReconnect) { this.lc('reconnect_scheduled'); this.rel('reconnect'); this.scheduleReconnect(); }
      });

      this.ws.on('error', (err) => {
        this.rel('error', err.message);
        this.log(`WS error: ${err.message}`, true);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }
    this.ws?.close(1000, 'intentional');
    this.ws = null;
  }

  private sendSubscribe(): void {
    this.ws?.send(JSON.stringify({
      id: this.cmdId++, cmd: 'subscribe', params: { channels: ['market_lifecycle_v2'] },
    }));
  }

  private handleEnvelope(env: { type: string; msg?: any }): void {
    if (env.type !== 'market_lifecycle_v2') return;
    const msg = env.msg;
    if (!msg) return;
    const eventType: string = msg.event_type ?? '';
    const ticker: string = msg.market_ticker ?? '';
    if (!ticker) return;
    if (eventType === 'created') {
      this.marketsCreated++;
      void this.emitKalshi('created', ticker, msg).catch((e: any) => this.log(`emit created err: ${e?.message}`, true));
    } else if (eventType === 'settled' || eventType === 'determined') {
      this.marketsResolved++;
      void this.emitKalshi('resolved', ticker, msg).catch((e: any) => this.log(`emit resolved err: ${e?.message}`, true));
    }
  }

  /**
   * Capture the frame-arrival time, optionally resolve the authoritative
   * category via a read-only event lookup, then emit. Title is pulled from
   * additional_metadata (where Kalshi nests it on WSS frames).
   */
  private async emitKalshi(kind: 'created' | 'resolved', ticker: string, msg: any): Promise<void> {
    const recvT = Date.now();
    const am = (msg.additional_metadata && typeof msg.additional_metadata === 'object') ? msg.additional_metadata : {};
    const title: string | undefined =
      (typeof am.title === 'string' ? am.title : undefined) ??
      (typeof am.name === 'string' ? am.name : undefined);
    let override: string | undefined;
    if (this.enrich) {
      // 'created' frames carry additional_metadata.event_ticker; 'resolved'
      // frames carry only market_ticker, so derive the event ticker from it —
      // Kalshi's convention is market_ticker = event_ticker + '-' + strikeId,
      // so dropping the final '-' segment recovers the event ticker.
      const et: string =
        (typeof am.event_ticker === 'string' && am.event_ticker) ? am.event_ticker :
        (typeof msg.event_ticker === 'string' && msg.event_ticker) ? msg.event_ticker :
        deriveEventTicker(ticker);
      if (et) override = await this.resolveCategory(et);
    }
    this.disc(kind, ticker, msg, title, override, recvT);
  }

  /** Read-only authoritative unified category for an event_ticker (cached +
   *  in-flight-coalesced, so a same-event settlement burst = ONE fetch). */
  private async resolveCategory(eventTicker: string): Promise<string | undefined> {
    if (this.catCache.has(eventTicker)) return this.catCache.get(eventTicker);
    const inflight = this.catInFlight.get(eventTicker);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const ev = await fetchEventByTicker(eventTicker);
        const cat = ev ? classifyCategoryLabels([ev.category, ev.title, ...(ev.tags ?? [])]) : undefined;
        this.catCache.set(eventTicker, cat); // cache success AND miss (avoid a re-fetch storm)
        return cat;
      } finally {
        this.catInFlight.delete(eventTicker);
      }
    })();
    this.catInFlight.set(eventTicker, p);
    return p;
  }

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.lastMessageTs = Date.now();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageTs > KALSHI_STALE_TIMEOUT_MS) {
        this.log(`No message for ${KALSHI_STALE_TIMEOUT_MS / 1000}s — forcing reconnect`, true);
        this.rel('error', 'stale-watchdog terminate');
        this.disconnectedAt ??= new Date();
        this.ws!.terminate();
        return;
      }
      this.ws.ping();
      this.rel('heartbeat_out');
    }, KALSHI_PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }
}

// ─── Polymarket ──────────────────────────────────────────────────────────────
// MIRRORS services/ingestion/src/lifecycle/polymarket-lifecycle.ts

const PM_WS_URL = process.env.POLYMARKET_WS_URL ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PM_PING_INTERVAL_MS = 5_000;
const PM_STALE_TIMEOUT_MS = 45_000;

export class PolymarketLifecycleBench extends BenchWatcherBase {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageTs = 0;

  constructor(sink: BenchSink, clockOffsetMs: number, verbose: boolean) {
    super('bench:polymarket', 'polymarket', sink, clockOffsetMs, verbose);
  }

  protected isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { resolve(); return; }
      this.beginConnect();

      this.logState(`Connecting to ${PM_WS_URL}…`);
      this.ws = new WebSocket(PM_WS_URL);

      const connectTimeout = setTimeout(() => {
        this.rel('error', 'connect timeout 15s');
        reject(new Error('Polymarket lifecycle WS connection timeout (15s)'));
        this.ws?.terminate();
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempts = 0;
        this.lc('ws_open');
        this.rel('connected');
        this.ws!.send(JSON.stringify({ assets_ids: [], type: 'market', custom_feature_enabled: true }));
        this.lc('subscribe_sent', 'custom_feature_enabled');
        this.startPingInterval();
        this.handleReconnectRefill();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.lastMessageTs = Date.now();
        const raw = data.toString();
        if (raw === 'PONG') { this.sink.noteFrame('polymarket', Date.now(), true); this.rel('heartbeat_in'); return; }
        this.onFrame(false);
        try {
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) { for (const item of parsed) this.handleMessage(item); }
            else this.handleMessage(parsed);
          }
        } catch { /* malformed */ }
      });

      this.ws.on('close', (code, reason) => {
        this.stopPingInterval();
        this.disconnectedAt ??= new Date();
        this.lc('close', `code=${code}`);
        this.rel('disconnected', `code=${code} reason=${reason.toString() || 'none'}`);
        if (this.shouldReconnect) { this.lc('reconnect_scheduled'); this.rel('reconnect'); this.scheduleReconnect(); }
      });

      this.ws.on('error', (err) => {
        this.rel('error', err.message);
        this.log(`WS error: ${err.message}`, true);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }
    this.ws?.close(1000, 'intentional');
    this.ws = null;
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const eventType: string = msg.event_type ?? msg.type ?? '';
    if (eventType === 'new_market') {
      const conditionId: string = msg.condition_id ?? msg.conditionId ?? '';
      if (!conditionId) return;
      this.marketsCreated++;
      this.disc('created', conditionId, msg, msg.question ?? msg.slug);
    } else if (eventType === 'market_resolved') {
      const conditionId: string = msg.condition_id ?? msg.conditionId ?? '';
      if (!conditionId) return;
      this.marketsResolved++;
      this.disc('resolved', conditionId, msg);
    }
  }

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.lastMessageTs = Date.now();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageTs > PM_STALE_TIMEOUT_MS) {
        this.log(`No message for ${PM_STALE_TIMEOUT_MS / 1000}s — forcing reconnect`, true);
        this.rel('error', 'stale-watchdog terminate');
        this.disconnectedAt ??= new Date();
        this.ws!.terminate();
        return;
      }
      this.ws.send('PING');
      this.rel('heartbeat_out');
    }, PM_PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }
}

// ─── Limitless ───────────────────────────────────────────────────────────────
// MIRRORS services/ingestion/src/lifecycle/limitless-lifecycle.ts

const LIMITLESS_WS_URL = process.env.LIMITLESS_WS_URL
  ? `${process.env.LIMITLESS_WS_URL}/markets`
  : 'wss://ws.limitless.exchange/markets';
const LIMITLESS_RECONNECT_DELAY_MS = 1_000;
const LIMITLESS_RECONNECT_DELAY_MAX_MS = 60_000;

export class LimitlessLifecycleBench extends BenchWatcherBase {
  private socket: Socket | null = null;

  constructor(sink: BenchSink, clockOffsetMs: number, verbose: boolean) {
    super('bench:limitless', 'limitless', sink, clockOffsetMs, verbose);
  }

  protected isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  connect(): Promise<void> {
    if (this.socket?.connected) return Promise.resolve();
    this.beginConnect();

    return new Promise((resolve, reject) => {
      const apiKey = process.env.LIMITLESS_API_KEY;
      const opts: Parameters<typeof io>[1] = {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: LIMITLESS_RECONNECT_DELAY_MS,
        reconnectionDelayMax: LIMITLESS_RECONNECT_DELAY_MAX_MS,
        reconnectionAttempts: Infinity,
        timeout: 15_000,
      };
      if (apiKey) (opts as any).extraHeaders = { 'X-API-Key': apiKey };

      this.logState(`Connecting to ${LIMITLESS_WS_URL}…`);
      this.socket = io(LIMITLESS_WS_URL, opts);

      let settled = false;
      const settle = (err?: Error) => { if (settled) return; settled = true; if (err) reject(err); else resolve(); };

      this.socket.once('connect', () => settle());
      this.socket.once('connect_error', (err: Error) => settle(err));

      this.socket.on('connect', () => {
        this.lc('ws_open');
        this.rel('connected');
        this.socket!.emit('subscribe_market_lifecycle');
        this.lc('subscribe_sent', 'subscribe_market_lifecycle');
        this.handleReconnectRefill();
      });

      this.socket.on('disconnect', (reason: string) => {
        this.disconnectedAt ??= new Date();
        this.lc('close', `reason=${reason}`);
        this.rel('disconnected', `reason=${reason}`);
      });

      this.socket.on('reconnect_attempt', (n: number) => {
        // socket.io owns the (re)connect handshake; mark the attempt + a fresh
        // connect_start so the next connect→first-frame timing is captured.
        this.beginConnect();
        this.lc('reconnect_scheduled', `attempt=${n}`);
        this.rel('reconnect', `attempt=${n}`);
      });

      this.socket.on('connect_error', (err: Error) => {
        this.rel('error', err.message);
        this.log(`WS error: ${err.message}`, true);
      });

      this.socket.on('marketCreated', (data: any) => {
        this.onFrame(false);
        const slug: string = data?.slug ?? '';
        if (!slug) return;
        this.marketsCreated++;
        this.disc('created', slug, data, data?.title);
      });

      this.socket.on('marketResolved', (data: any) => {
        this.onFrame(false);
        const slug: string = data?.slug ?? '';
        if (!slug) return;
        this.marketsResolved++;
        this.disc('resolved', slug, data);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.socket?.disconnect();
    this.socket = null;
  }
}
