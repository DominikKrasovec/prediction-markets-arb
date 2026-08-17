import 'dotenv/config';
import WebSocket from 'ws';
import { createAuthHeaders } from '@arb/kalshi-auth';
import type { Logger } from '@arb/logger';
import {
  BaseShardedAdapter,
  WS_OPEN,
  type ShardConnBase,
  type ShardSocketHandlers,
  type WsLike,
} from './base-sharded.js';
import type { MarketSubscription, PriceUpdate } from '../price-cache.js';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';
import { hrNowMs } from '../geo-compare/instrumentation.js';
import { bookLadderEnabled, maxLadderLevels } from '../token-map.js';

const log = createLogger('clob:kalshi');

const WS_PATH = '/trade-api/ws/v2';
const WS_URL = process.env.KALSHI_WS_URL ?? 'wss://api.elections.kalshi.com' + WS_PATH;
const REST_BASE = process.env.KALSHI_REST_URL ?? 'https://api.elections.kalshi.com';
const PING_INTERVAL_MS   = 10_000;

/** Opt-in REST orderbook cross-check (`KALSHI_VERIFY_REST=1`); off by default
 *  since it needs Kalshi creds and adds REST load. */
const VERIFY_REST = process.env.KALSHI_VERIFY_REST === '1';
const CROSSCHECK_INTERVAL_MS = parseInt(process.env.KALSHI_CROSSCHECK_INTERVAL_MS ?? '5000', 10) || 5_000;
const CROSSCHECK_SAMPLE = parseInt(process.env.KALSHI_CROSSCHECK_SAMPLE ?? '20', 10) || 20;
/** Divergence threshold in dollars; deliberately generous so a legitimate
 *  WSS-lead-REST timing race never triggers a re-anchor. */
const CROSSCHECK_TOLERANCE = parseFloat(process.env.KALSHI_CROSSCHECK_TOLERANCE ?? '') || 0.15;

/** Market tickers per shard connection (env `KALSHI_SHARD_SIZE`); <=0/NaN uses the default. */
const DEFAULT_SHARD_SIZE = 10_000;
function readShardSize(): number {
  const raw = parseInt(process.env.KALSHI_SHARD_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARD_SIZE;
}

/** Per-shard WebSocket connection. Book reconstruction (yesBids/noBids) stays
 *  global, keyed by market_ticker; auth, cmdId and the seq baseline are
 *  per-connection since Kalshi auth is per-WS-upgrade. */
interface ShardConn extends ShardConnBase {
  cmdId: number;
  orderbookSid: number | null;
  /** Next expected per-connection orderbook `seq`; `null` until the first
   *  seq-bearing frame (re)seeds it. A mismatch triggers a resync. */
  expectedSeq: number | null;
}

/** Kalshi CLOB adapter for the arb-solver (connection-sharded); platformId is
 *  the market ticker. Kalshi returns only YES/NO bids: YES ask = 1 - best NO
 *  bid, NO ask = 1 - best YES bid; PriceUpdate is always in YES terms. */
export class KalshiAdapter extends BaseShardedAdapter<ShardConn> {
  readonly platform: Platform = 'kalshi';
  protected readonly log: Logger = log;
  protected readShardSize(): number {
    return readShardSize();
  }
  protected shardExtras(): Partial<ShardConn> {
    return { cmdId: 1, orderbookSid: null, expectedSeq: null };
  }

  private yesBids = new Map<string, Map<string, number>>(); // ticker -> price -> size
  private noBids  = new Map<string, Map<string, number>>(); // ticker -> price -> size

  private crossCheckTimer: ReturnType<typeof setInterval> | null = null;
  private crossCheckCursor = 0;
  private crossCheckStats = { checked: 0, ok: 0, divergent: 0, reanchored: 0, fetchFail: 0 };

  private currentWireTs: number = 0;
  private currentWireHr: number = 0;
  private currentServerTs: number | undefined = undefined;
  private currentMsgKind: 'snapshot' | 'delta' | 'unknown' = 'unknown';

  async unsubscribe(marketIds: string[]): Promise<void> {
    for (const id of marketIds) {
      this.subscriptions.delete(id);
      this.yesBids.delete(id);
      this.noBids.delete(id);
      for (const shard of this.shards) shard.ids.delete(id);
    }
  }

  protected onAfterStart(): void {
    this.startCrossCheck();
  }

  protected onBeforeStop(): void {
    this.stopCrossCheck();
  }

  /** Kalshi auth is per-WS-upgrade: rebuild RSA-PSS headers at each connect. */
  protected buildConnectHeaders(_shard: ShardConn): Record<string, string> {
    return createAuthHeaders('GET', WS_PATH);
  }

  protected resetShardState(shard: ShardConn): void {
    shard.expectedSeq = null;
  }

  /** Kalshi logs "Connect failed:" (not "Connection failed:"). */
  protected connectFailedLogPrefix(): string {
    return 'Connect failed:';
  }

  protected onOpen(shard: ShardConn): void {
    this.startKeepalive(shard);
    this.sendSubscribe(shard, [...shard.ids]);
    this.emitLifecycle('subscribe_sent', shard.connId, `${shard.ids.size}`);
  }

  protected keepaliveIntervalMs(): number {
    return PING_INTERVAL_MS;
  }

  protected sendKeepalive(shard: ShardConn): void {
    if (shard.conn?.readyState === WS_OPEN) shard.conn.ping();
  }

  protected closeOnStop(conn: WsLike | null): void {
    conn?.close(1000, 'stop');
  }

  protected openSocket(shard: ShardConn, headers: Record<string, string>, handlers: ShardSocketHandlers): WsLike {
    const ws = new WebSocket(WS_URL, { headers });
    return this.wireRawWs(
      ws,
      handlers,
      (code, reason) => {
        const why = reason?.length ? ` ${reason.toString()}` : '';
        return {
          closeDetail: `code=${code}${why}`,
          disconnectedDetail: undefined,
          logMessage: `WebSocket closed (code=${code}${why}), reconnecting…`,
        };
      },
      (rawWs) => rawWs.on('pong', () => { /* latency measurement optional */ }),
    );
  }

  /** Prefers numeric `ts_ms`, else the ISO `ts` string, else a legacy numeric ts. */
  protected handleFrame(shard: ShardConn, payload: unknown, wireTs: number, wireHr: number): void {
    try {
      const env = JSON.parse((payload as import('ws').RawData).toString());
      this.dumpRaw(env);
      this.currentWireTs = wireTs;
      this.currentWireHr = wireHr;
      this.currentServerTs =
        typeof env.msg?.ts_ms === 'number'
          ? env.msg.ts_ms
          : typeof env.ts_ms === 'number'
            ? env.ts_ms
            : typeof env.msg?.ts === 'string'
              ? Date.parse(env.msg.ts) || undefined
              : typeof env.ts === 'number'
                ? env.ts
                : typeof env.msg?.ts === 'number'
                  ? env.msg.ts
                  : undefined;
      this.currentMsgKind = 'unknown';
      this.handleMessage(env, shard);
    } catch { /* malformed */ }
  }

  protected sendSubscribe(shard: ShardConn, tickers: string[]): void {
    const ws = shard.conn;
    if (!ws || ws.readyState !== WS_OPEN || !tickers.length) return;
    const id = shard.cmdId++;
    ws.send(JSON.stringify({
      id,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: tickers,
      },
    }));
  }

  private handleMessage(env: any, shard: ShardConn): void {
    switch (env.type) {
      case 'subscribed':
        shard.orderbookSid = env.msg?.sid ?? null;
        break;

      case 'orderbook_snapshot':
        if (!this.checkSeq(env, shard)) return;
        this.currentMsgKind = 'snapshot';
        this.handleSnapshot(env.msg);
        break;

      case 'orderbook_delta':
        if (!this.checkSeq(env, shard)) return;
        this.currentMsgKind = 'delta';
        this.handleDelta(env.msg);
        break;

      case 'error':
        log.error(`WS error ${env.msg?.code}: ${env.msg?.msg}`);
        break;

      default:
        break;
    }
  }

  /** Validates the monotonic per-connection `seq` on orderbook frames against
   *  `shard.expectedSeq`; a mismatch triggers a resync and the frame is dropped
   *  (returns `false`) so it is never applied to the book. */
  private checkSeq(env: any, shard: ShardConn): boolean {
    const seq = env.seq;
    if (typeof seq !== 'number') return true;

    if (shard.expectedSeq === null) {
      shard.expectedSeq = seq + 1;
      return true;
    }

    if (seq === shard.expectedSeq) {
      shard.expectedSeq = seq + 1;
      return true;
    }

    const expected = shard.expectedSeq;
    log.warn(
      `seq gap on conn ${shard.connId}: expected ${expected}, got ${seq} — resyncing`,
    );
    this.emitReliability('error', `seq gap exp=${expected} got=${seq}`, shard.connId);
    this.resyncShard(shard);
    return false;
  }

  /** Drops the socket to force a fresh orderbook_snapshot on reconnect. */
  private resyncShard(shard: ShardConn): void {
    shard.expectedSeq = null;
    const ws = shard.conn;
    if (ws) {
      try { ws.close(1000, 'seq-gap resync'); } catch { /* already closing */ }
    } else if (this.running) {
      this.scheduleReconnect(shard);
    }
  }

  private handleSnapshot(msg: any): void {
    const ticker = msg.market_ticker;
    const sub = this.subscriptions.get(ticker);
    if (!sub) return;

    // yes_dollars_fp/no_dollars_fp: [priceDollars, size] pairs, price in 0..1; `yes`/`no` is the legacy fallback.
    const yesBids = new Map<string, number>();
    const noBids  = new Map<string, number>();

    for (const [price, size] of (msg.yes_dollars_fp ?? msg.yes ?? [])) {
      yesBids.set(price, parseFloat(size));
    }
    for (const [price, size] of (msg.no_dollars_fp ?? msg.no ?? [])) {
      noBids.set(price, parseFloat(size));
    }

    this.yesBids.set(ticker, yesBids);
    this.noBids.set(ticker, noBids);
    this.emitPriceUpdate(ticker, sub);
  }

  private handleDelta(msg: any): void {
    const ticker = msg.market_ticker;
    const sub = this.subscriptions.get(ticker);
    if (!sub) return;

    const levels = msg.side === 'yes' ? this.yesBids.get(ticker) : this.noBids.get(ticker);
    if (!levels) return; // no snapshot yet

    const delta = parseFloat(msg.delta_fp ?? msg.delta ?? '0'); // price_dollars/delta_fp, legacy price/delta fallback
    const price = (msg.price_dollars ?? msg.price) as string;
    const current = levels.get(price) ?? 0;
    const newSize = current + delta;

    if (newSize <= 0) {
      levels.delete(price);
    } else {
      levels.set(price, newSize);
    }

    this.emitPriceUpdate(ticker, sub);
  }

  private emitPriceUpdate(ticker: string, sub: MarketSubscription): void {
    const yesBids = this.yesBids.get(ticker);
    const noBids  = this.noBids.get(ticker);

    let bestYesBid = 0;
    let bidSize = 0;
    if (yesBids?.size) {
      for (const [price, size] of yesBids) {
        const p = parseFloat(price);
        if (p > bestYesBid) { bestYesBid = p; bidSize = size; }
      }
    }

    let bestYesAsk = 2.0; // sentinel = excluded
    let askSize = 0; // best YES ask = 1 - highest NO price
    if (noBids?.size) {
      let bestNoBid = 0;
      for (const [price, size] of noBids) {
        const p = parseFloat(price);
        if (p > bestNoBid) { bestNoBid = p; askSize = size; }
      }
      if (bestNoBid > 0) bestYesAsk = 1.0 - bestNoBid;
    }

    const { askLevels, bidLevels } = this.buildLadders(yesBids, noBids);

    const update: PriceUpdate = {
      marketId: sub.marketId,
      platform: 'kalshi',
      bestBid: bestYesBid,
      bestAsk: bestYesAsk,
      bidSize,
      askSize,
      timestamp: Date.now(),
      wireTs: this.currentWireTs || undefined,
      wireHr: this.currentWireHr || undefined,
      emitHr: hrNowMs(),
      serverTs: this.currentServerTs,
      msgKind: this.currentMsgKind,
      askLevels,
      bidLevels,
    };
    this.emit(update);
  }

  /** Kalshi quotes both sides as bids: the YES ask ladder is synthesized from
   *  NO bids via price 1-q. No-op (returns `{}`) unless CLOB_BOOK_LADDER=1. */
  private buildLadders(
    yesBids: Map<string, number> | undefined,
    noBids: Map<string, number> | undefined,
  ): { askLevels?: Array<[number, number]>; bidLevels?: Array<[number, number]> } {
    if (!bookLadderEnabled()) return {};
    const cap = maxLadderLevels();

    const bidLevels: Array<[number, number]> = [];
    if (yesBids) {
      for (const [price, size] of yesBids) {
        const p = parseFloat(price);
        if (Number.isFinite(p) && size > 0) bidLevels.push([p, size]);
      }
    }
    bidLevels.sort((a, b) => b[0] - a[0]); // descending, best first

    const askLevels: Array<[number, number]> = [];
    if (noBids) {
      for (const [price, size] of noBids) {
        const q = parseFloat(price);
        if (Number.isFinite(q) && size > 0) {
          const yesAsk = 1.0 - q;
          if (yesAsk > 0) askLevels.push([yesAsk, size]);
        }
      }
    }
    askLevels.sort((a, b) => a[0] - b[0]); // ascending, cheapest first

    return { askLevels: askLevels.slice(0, cap), bidLevels: bidLevels.slice(0, cap) };
  }

  private bestPrice(levels: Map<string, number> | undefined): number {
    let best = 0;
    if (levels) for (const p of levels.keys()) { const x = parseFloat(p); if (x > best) best = x; }
    return best;
  }

  /** Null on any HTTP/parse error. */
  private async fetchRestOrderbook(ticker: string): Promise<{ yes: Map<string, number>; no: Map<string, number> } | null> {
    try {
      const path = `/trade-api/v2/markets/${ticker}/orderbook`;
      const r = await fetch(`${REST_BASE}${path}`, { headers: createAuthHeaders('GET', path) });
      if (!r.ok) return null;
      const j: any = await r.json();
      const ob = j.orderbook_fp ?? j.orderbook ?? {};
      const yes = new Map<string, number>();
      const no = new Map<string, number>();
      for (const [p, s] of ob.yes_dollars ?? ob.yes ?? []) { const n = parseFloat(s); if (n > 0) yes.set(String(p), n); }
      for (const [p, s] of ob.no_dollars ?? ob.no ?? []) { const n = parseFloat(s); if (n > 0) no.set(String(p), n); }
      return { yes, no };
    } catch {
      return null;
    }
  }

  /** A mismatch is re-confirmed with a second fetch to discard WSS-vs-REST
   *  timing races before re-anchoring the book from REST. */
  private async crossCheckTicker(ticker: string): Promise<void> {
    if (!this.subscriptions.has(ticker)) return;
    const rest = await this.fetchRestOrderbook(ticker);
    if (!rest) { this.crossCheckStats.fetchFail++; return; }
    this.crossCheckStats.checked++;

    const diverges = (r: { yes: Map<string, number>; no: Map<string, number> }) => {
      const restYes = this.bestPrice(r.yes), restNo = this.bestPrice(r.no);
      const ourYes = this.bestPrice(this.yesBids.get(ticker)), ourNo = this.bestPrice(this.noBids.get(ticker));
      const yesBad = restYes > 0 && Math.abs(ourYes - restYes) > CROSSCHECK_TOLERANCE;
      const noBad = restNo > 0 && Math.abs(ourNo - restNo) > CROSSCHECK_TOLERANCE;
      return { bad: yesBad || noBad, ourYes, ourNo, restYes, restNo };
    };

    if (!diverges(rest).bad) { this.crossCheckStats.ok++; return; }
    // Confirm with a fresh fetch — a real desync persists, a tick-lag race clears.
    const confirm = await this.fetchRestOrderbook(ticker);
    if (!confirm) { this.crossCheckStats.fetchFail++; return; }
    const d = diverges(confirm);
    if (!d.bad) { this.crossCheckStats.ok++; return; }

    this.crossCheckStats.divergent++;
    log.warn(
      `rest divergence ${ticker} ours[yesBid=${d.ourYes} noBid=${d.ourNo}] ` +
        `rest[yesBid=${d.restYes} noBid=${d.restNo}] → re-anchor from REST`,
    );
    this.emitReliability('error', 'kalshi rest divergence');
    const sub = this.subscriptions.get(ticker);
    if (sub) {
      this.yesBids.set(ticker, confirm.yes);
      this.noBids.set(ticker, confirm.no);
      this.crossCheckStats.reanchored++;
      this.emitPriceUpdate(ticker, sub);
    }
  }

  /** Cross-check the next `CROSSCHECK_SAMPLE` tickers in rotation (concurrently). */
  private async runCrossCheckBatch(): Promise<void> {
    const tickers = [...this.subscriptions.keys()];
    if (!tickers.length) return;
    const batch: string[] = [];
    for (let i = 0; i < Math.min(CROSSCHECK_SAMPLE, tickers.length); i++) {
      batch.push(tickers[this.crossCheckCursor % tickers.length]);
      this.crossCheckCursor++;
    }
    await Promise.all(batch.map((t) => this.crossCheckTicker(t)));
  }

  /** Start the periodic REST cross-check driver (no-op unless KALSHI_VERIFY_REST). */
  private startCrossCheck(): void {
    if (!VERIFY_REST || this.crossCheckTimer) return;
    log.info(`REST cross-check on: ${CROSSCHECK_SAMPLE} markets / ${CROSSCHECK_INTERVAL_MS}ms`);
    this.crossCheckTimer = setInterval(() => { void this.runCrossCheckBatch(); }, CROSSCHECK_INTERVAL_MS);
  }

  private stopCrossCheck(): void {
    if (this.crossCheckTimer) { clearInterval(this.crossCheckTimer); this.crossCheckTimer = null; }
  }

  /** Snapshot of the REST cross-check tally (for harness reporting). */
  getCrossCheckStats(): { checked: number; ok: number; divergent: number; reanchored: number; fetchFail: number } {
    return { ...this.crossCheckStats };
  }
}
