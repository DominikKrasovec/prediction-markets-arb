import WebSocket from 'ws';
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
import { orderBookSummaryHash, verifySelfHash } from './polymarket-hash.js';
import { bookLadderEnabled, maxLadderLevels, rejectCrossedBookEnabled } from '../token-map.js';

const log = createLogger('clob:polymarket');

const WS_URL = process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const REST_URL = process.env.POLYMARKET_REST_URL || 'https://clob.polymarket.com';
// Polymarket drops the connection if the client doesn't PING roughly every 10s.
const PING_INTERVAL_MS = 10_000;

const VERIFY_BOOK_HASH = process.env.POLYMARKET_VERIFY_BOOK_HASH !== '0';
const REST_RESYNC = process.env.POLYMARKET_REST_RESYNC !== '0';
const HASH_BOOTSTRAP = process.env.POLYMARKET_HASH_BOOTSTRAP === '1';

// Prices are penny-granular; below half a tick is float noise, not a real mismatch.
const BEST_MISMATCH_EPSILON = 1e-4;

// Only a streak this long escalates to a resync (single blips self-heal).
const BEST_MISMATCH_STREAK = 3;

// Per-asset resync rate limit so a transient race can't loop-resync.
const RESYNC_COOLDOWN_MS = 30_000;

// Coalesces per-event book-health WARNs into one census line per window.
const BOOK_HEALTH_FLUSH_MS = parseInt(
  process.env.POLYMARKET_BOOK_HEALTH_FLUSH_MS ?? '60000',
  10,
);

// Per-connection asset cap: larger snapshot bursts risk a silent code=1006 drop.
const DEFAULT_SHARD_SIZE = 800;
function readShardSize(): number {
  const raw = parseInt(process.env.POLYMARKET_SHARD_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARD_SIZE;
}

interface AssetBook {
  bids: Map<string, number>;
  asks: Map<string, number>;
}

type ShardConn = ShardConnBase;

// `platformId` on a subscription is the clobTokenId, not the condition_id;
// callers must translate at the loader level.
export class PolymarketAdapter extends BaseShardedAdapter<ShardConn> {
  readonly platform: Platform = 'polymarket';
  protected readonly log: Logger = log;
  protected readShardSize(): number {
    return readShardSize();
  }
  // Keyed `${marketId}:${outcome}` so a two-sided subscription keeps separate books.
  private books = new Map<string, AssetBook>();
  private lastResyncAt = new Map<string, number>();
  private bestMismatchStreak = new Map<string, number>();
  private bookHealth = { mismatch: 0, crossed: 0, hashMismatch: 0 };
  private bookHealthFlushAt = 0;
  // Static fields a WS `book` frame omits, backfilled from REST per asset.
  private staticFields = new Map<string, { minOrderSize: string; negRisk: boolean }>();
  // Assets with a full snapshot applied; gates the best-cross-check during cold start.
  private snapshotReceived = new Set<string>();
  private hashStats = { verified: 0, mismatch: 0, unchecked: 0, skipped: 0 };
  private currentWireTs: number = 0;
  private currentWireHr: number = 0;
  private currentServerTs: number | undefined = undefined;
  private currentMsgKind: 'snapshot' | 'delta' | 'full' | 'unknown' = 'unknown';

  protected async onBeforeConnectAll(): Promise<void> {
    if (HASH_BOOTSTRAP) await this.bootstrapHashVerification();
  }

  async unsubscribe(marketIds: string[]): Promise<void> {
    for (const id of marketIds) {
      const sub = this.subscriptions.get(id);
      if (sub) this.books.delete(bookKey(sub));
      this.subscriptions.delete(id);
      this.lastResyncAt.delete(id);
      this.bestMismatchStreak.delete(id);
      this.snapshotReceived.delete(id);
      for (const shard of this.shards) shard.ids.delete(id);
    }
  }

  get shardCount(): number {
    return this.shards.length;
  }

  protected keepaliveIntervalMs(): number {
    return PING_INTERVAL_MS;
  }

  // Literal text `PING`, per Polymarket's documented keepalive form (not JSON).
  protected sendKeepalive(shard: ShardConn): void {
    if (shard.conn?.readyState === WS_OPEN) {
      try { shard.conn.send('PING'); } catch { /* socket dying; close handler reconnects */ }
    }
  }

  // Clears snapshot flags on close so a stale partial book can't be extended post-reconnect.
  protected onShardClose(shard: ShardConn): void {
    for (const id of shard.ids) this.snapshotReceived.delete(id);
  }

  protected openSocket(shard: ShardConn, _headers: Record<string, string>, handlers: ShardSocketHandlers): WsLike {
    const ws = new WebSocket(WS_URL);
    return this.wireRawWs(ws, handlers, (code, reason) => {
      const why = reason?.length ? ` ${reason.toString().slice(0, 100)}` : '';
      return {
        closeDetail: `code=${code}${why}`,
        disconnectedDetail: `code=${code}`,
        logMessage: `WebSocket closed (code=${code}${why}), reconnecting...`,
      };
    });
  }

  protected handleFrame(_shard: ShardConn, payload: unknown, wireTs: number, wireHr: number): void {
    try {
      const msgs = JSON.parse((payload as import('ws').RawData).toString());
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of arr) {
        this.dumpRaw(msg);
        this.currentWireTs = wireTs;
        this.currentWireHr = wireHr;
        this.currentServerTs =
          typeof msg.timestamp === 'number'
            ? msg.timestamp
            : typeof msg.timestamp === 'string'
              ? Number(msg.timestamp) || undefined
              : undefined;
        this.currentMsgKind = 'unknown';
        this.handleMessage(msg);
      }
    } catch {
      /* malformed */
    }
  }

  protected sendSubscribe(shard: ShardConn, assetIds: string[]): void {
    const ws = shard.conn;
    if (!ws || ws.readyState !== WS_OPEN || assetIds.length === 0) return;
    // `initial_dump:true` is what makes the server send the founding `book`
    // snapshot per asset; without it only price_change deltas stream.
    ws.send(
      JSON.stringify({
        type: 'market',
        operation: 'subscribe',
        assets_ids: assetIds,
        initial_dump: true,
        custom_feature_enabled: true,
      }),
    );
  }

  private handleMessage(msg: any): void {
    switch (msg.event_type) {
      case 'book':
        this.currentMsgKind = 'snapshot';
        this.handleBook(msg);
        break;
      case 'price_change':
        this.currentMsgKind = 'delta';
        this.handlePriceChange(msg);
        break;
      case 'market_resolved':
      case 'marketResolved':
        this.handleResolved(msg);
        break;
    }
  }

  private handleBook(msg: any): void {
    const sub = this.subscriptions.get(msg.asset_id);
    if (!sub) return;

    // Hash the server-ordered levels before they lose order in the bid/ask Maps.
    this.verifyBookSnapshot(msg);

    const bids = new Map<string, number>();
    const asks = new Map<string, number>();
    for (const level of msg.bids ?? []) {
      const size = parseFloat(level.size);
      if (size > 0) bids.set(level.price, size);
    }
    for (const level of msg.asks ?? []) {
      const size = parseFloat(level.size);
      if (size > 0) asks.set(level.price, size);
    }

    this.books.set(bookKey(sub), { bids, asks });
    this.snapshotReceived.add(msg.asset_id);
    this.emitBest(sub);
  }

  private verifyBookSnapshot(msg: any): void {
    if (!VERIFY_BOOK_HASH || typeof msg.hash !== 'string') return;
    // last_trade_price ships only on the first snapshot after (re)subscribe;
    // later refresh snapshots omit it and can't be reproduced, so skip them.
    if (msg.last_trade_price === undefined || msg.last_trade_price === null) {
      this.hashStats.skipped++;
      return;
    }
    const sf = this.staticFields.get(msg.asset_id);
    if (!sf) {
      this.hashStats.unchecked++;
      return;
    }
    const computed = orderBookSummaryHash({
      market: String(msg.market ?? ''),
      asset_id: String(msg.asset_id ?? ''),
      timestamp: String(msg.timestamp ?? ''),
      bids: msg.bids ?? [],
      asks: msg.asks ?? [],
      min_order_size: sf.minOrderSize,
      tick_size: String(msg.tick_size ?? ''),
      neg_risk: sf.negRisk,
      last_trade_price: String(msg.last_trade_price ?? ''),
    });
    if (computed === msg.hash) {
      this.hashStats.verified++;
      return;
    }
    this.hashStats.mismatch++;
    this.noteBookHealth('hashMismatch');
    this.emitReliability('error', 'book hash mismatch');
    void this.resyncAsset(msg.asset_id);
  }

  getHashStats(): { verified: number; mismatch: number; unchecked: number; skipped: number } {
    return { ...this.hashStats };
  }

  private handlePriceChange(msg: any): void {
    for (const change of msg.price_changes ?? []) {
      const sub = this.subscriptions.get(change.asset_id);
      if (!sub) continue;

      // Drop deltas before the founding snapshot lands: building on a partial
      // book would publish a wrong top-of-book. The snapshot always follows.
      if (!this.snapshotReceived.has(change.asset_id)) continue;

      const key = bookKey(sub);
      let book = this.books.get(key);
      if (!book) {
        book = { bids: new Map(), asks: new Map() };
        this.books.set(key, book);
      }

      const levels = change.side === 'BUY' ? book.bids : book.asks;
      const size = parseFloat(change.size ?? '0');
      if (size <= 0) {
        levels.delete(change.price);
      } else {
        levels.set(change.price, size);
      }

      this.emitBest(sub);
      this.verifyAgainstServerBest(sub, change);
    }
  }

  private handleResolved(msg: any): void {
    // Per CLOB WS docs, the condition ID is in msg.market, not msg.id.
    const platformId: string = msg.market ?? msg.condition_id ?? msg.conditionId ?? '';
    if (!platformId) return;
    this.emitResolution({
      platform: 'polymarket',
      platformId,
      winningOutcome: msg.winning_outcome ?? msg.winningOutcome ?? null,
      timestamp: msg.timestamp ?? msg.closedTime ?? undefined,
    });
  }

  private computeBest(book: AssetBook | undefined): {
    bestBid: number;
    bidSize: number;
    bestAsk: number;
    askSize: number;
  } {
    let bestBid = 0,
      bidSize = 0;
    let bestAsk = 2.0,
      askSize = 0; // sentinels: excluded from LP when no liquidity

    if (book) {
      for (const [price, size] of book.bids) {
        const p = parseFloat(price);
        if (p > bestBid) {
          bestBid = p;
          bidSize = size;
        }
      }
      for (const [price, size] of book.asks) {
        const p = parseFloat(price);
        if (bestAsk >= 2.0 || p < bestAsk) {
          bestAsk = p;
          askSize = size;
        }
      }
    }
    return { bestBid, bidSize, bestAsk, askSize };
  }

  private buildLadders(book: AssetBook | undefined): {
    askLevels?: Array<[number, number]>;
    bidLevels?: Array<[number, number]>;
  } {
    if (!bookLadderEnabled() || !book) return {};
    const cap = maxLadderLevels();
    let asks: Array<[number, number]> = [];
    for (const [price, size] of book.asks) {
      const p = parseFloat(price);
      if (Number.isFinite(p) && size > 0) asks.push([p, size]);
    }
    asks.sort((a, b) => a[0] - b[0]); // ascending: cheapest ask first
    const bids: Array<[number, number]> = [];
    for (const [price, size] of book.bids) {
      const p = parseFloat(price);
      if (Number.isFinite(p) && size > 0) bids.push([p, size]);
    }
    bids.sort((a, b) => b[0] - a[0]); // descending: best (highest) bid first
    // Crossed ask levels (at/below best bid) are out-of-order-delta artifacts; drop them.
    if (rejectCrossedBookEnabled() && bids.length > 0 && asks.length > 0) {
      const bestBid = bids[0][0];
      asks = asks.filter(([p]) => p > bestBid);
    }
    return { askLevels: asks.slice(0, cap), bidLevels: bids.slice(0, cap) };
  }

  private emitBest(sub: MarketSubscription): void {
    const book = this.books.get(bookKey(sub));
    const { bestBid, bidSize, bestAsk, askSize } = this.computeBest(book);

    // A crossed book (real bestBid >= real bestAsk) is corrupt; never publish it.
    const bothReal = bestBid > 0 && bestAsk < 2.0;
    if (rejectCrossedBookEnabled() && bothReal && bestBid >= bestAsk) {
      this.noteBookHealth('crossed');
      this.emitReliability('error', 'crossed book');
      void this.resyncAsset(sub.platformId);
      return;
    }

    const { askLevels, bidLevels } = this.buildLadders(book);

    this.emit({
      marketId: sub.marketId,
      platform: 'polymarket',
      bestBid,
      bestAsk,
      bidSize,
      askSize,
      timestamp: Date.now(),
      wireTs: this.currentWireTs || undefined,
      wireHr: this.currentWireHr || undefined,
      emitHr: hrNowMs(),
      serverTs: this.currentServerTs,
      msgKind: this.currentMsgKind,
      outcome: sub.outcome,
      askLevels,
      bidLevels,
    });
  }

  private verifyAgainstServerBest(sub: MarketSubscription, change: any): void {
    if (!this.snapshotReceived.has(change.asset_id)) return;
    const serverBid = parseMaybeFloat(change.best_bid);
    const serverAsk = parseMaybeFloat(change.best_ask);
    if (serverBid === undefined && serverAsk === undefined) return;

    const { bestBid, bestAsk } = this.computeBest(this.books.get(bookKey(sub)));

    // Compare only a side the server stated AND we have a real (non-sentinel) value for.
    const bidBad =
      serverBid !== undefined &&
      bestBid > 0 &&
      Math.abs(bestBid - serverBid) > BEST_MISMATCH_EPSILON;
    const askBad =
      serverAsk !== undefined &&
      bestAsk < 2.0 &&
      Math.abs(bestAsk - serverAsk) > BEST_MISMATCH_EPSILON;

    const assetId: string = change.asset_id;
    if (!bidBad && !askBad) {
      if (this.bestMismatchStreak.has(assetId)) this.bestMismatchStreak.delete(assetId);
      return;
    }
    const streak = (this.bestMismatchStreak.get(assetId) ?? 0) + 1;
    this.bestMismatchStreak.set(assetId, streak);
    if (streak < BEST_MISMATCH_STREAK) return;
    this.bestMismatchStreak.delete(assetId);

    this.noteBookHealth('mismatch');
    this.emitReliability('error', 'best mismatch');
    void this.resyncAsset(assetId);
  }

  private noteBookHealth(kind: 'mismatch' | 'crossed' | 'hashMismatch'): void {
    this.bookHealth[kind]++;
    const now = Date.now();
    if (this.bookHealthFlushAt === 0) {
      this.bookHealthFlushAt = now;
      return;
    }
    if (now - this.bookHealthFlushAt < BOOK_HEALTH_FLUSH_MS) return;
    const secs = Math.round((now - this.bookHealthFlushAt) / 1000);
    const { mismatch, crossed, hashMismatch } = this.bookHealth;
    if (mismatch + crossed + hashMismatch > 0) {
      log.warn(
        `book health (${secs}s): ${mismatch} best-mismatch, ${crossed} crossed, ` +
          `${hashMismatch} hash-mismatch → all resynced (coalesced)`,
      );
    }
    this.bookHealth = { mismatch: 0, crossed: 0, hashMismatch: 0 };
    this.bookHealthFlushAt = now;
  }

  private async resyncAsset(assetId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastResyncAt.get(assetId);
    if (last !== undefined && now - last < RESYNC_COOLDOWN_MS) return;
    this.lastResyncAt.set(assetId, now);

    if (REST_RESYNC) {
      const book = await this.fetchRestBook(assetId);
      if (book && this.applyRestBook(book)) return;
    }
    this.wsResubscribe(assetId);
  }

  private wsResubscribe(assetId: string): void {
    const shard = this.shards.find((s) => s.ids.has(assetId));
    if (shard?.conn?.readyState === WS_OPEN) this.sendSubscribe(shard, [assetId]);
  }

  private async fetchRestBook(assetId: string): Promise<any | null> {
    try {
      const r = await fetch(`${REST_URL}/book?token_id=${assetId}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  private applyRestBook(book: any): boolean {
    const sub = this.subscriptions.get(book.asset_id);
    if (!sub) return false;

    const ok = verifySelfHash(book);
    if (ok === false) {
      this.hashStats.mismatch++;
      log.warn(`REST book hash mismatch asset=${book.asset_id} — ignoring snapshot`);
      this.emitReliability('error', 'rest book hash mismatch');
      return false;
    }
    if (ok === true) this.hashStats.verified++;

    if (book.min_order_size !== undefined && book.neg_risk !== undefined) {
      this.staticFields.set(book.asset_id, {
        minOrderSize: String(book.min_order_size),
        negRisk: Boolean(book.neg_risk),
      });
    }

    const bids = new Map<string, number>();
    const asks = new Map<string, number>();
    for (const level of book.bids ?? []) {
      const size = parseFloat(level.size);
      if (size > 0) bids.set(level.price, size);
    }
    for (const level of book.asks ?? []) {
      const size = parseFloat(level.size);
      if (size > 0) asks.set(level.price, size);
    }
    this.books.set(bookKey(sub), { bids, asks });
    this.snapshotReceived.add(book.asset_id);
    this.emitBest(sub);
    return true;
  }

  async bootstrapHashVerification(concurrency = 16): Promise<number> {
    if (!VERIFY_BOOK_HASH || !REST_RESYNC) return 0;
    const ids = [...this.subscriptions.keys()];
    let i = 0;
    let primed = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        const book = await this.fetchRestBook(id);
        if (book && this.applyRestBook(book)) primed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    log.info(`hash-verify bootstrap: primed ${primed}/${ids.length} assets`);
    return primed;
  }
}

function bookKey(sub: MarketSubscription): string {
  return `${sub.marketId}:${sub.outcome ?? 'yes'}`;
}

function parseMaybeFloat(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}
