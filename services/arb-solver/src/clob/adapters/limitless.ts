import { io, Socket } from 'socket.io-client';
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

const log = createLogger('clob:limitless');

const WS_URL = process.env.LIMITLESS_WS_URL || 'wss://ws.limitless.exchange/markets';

// Limitless's live universe is ~2.3k slugs, so this default keeps the whole platform on one shard.
const DEFAULT_SHARD_SIZE = 10_000;
function readShardSize(): number {
  const raw = parseInt(process.env.LIMITLESS_SHARD_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARD_SIZE;
}

interface ShardConn extends ShardConnBase {
  // Kept alongside the base's WsLike `conn` because Limitless's emit-based subscribe/lifecycle calls need the raw socket.
  socket: Socket | null;
}

/**
 * Limitless CLOB adapter (connection-sharded). Uses Socket.IO (not raw
 * WebSocket) on the /markets namespace; each orderbookUpdate is a full
 * snapshot, no deltas. Market slugs are partitioned into `shardSize` chunks,
 * one Socket.IO connection per chunk, reconnect/error handling per connection.
 */
export class LimitlessAdapter extends BaseShardedAdapter<ShardConn> {
  readonly platform: Platform = 'limitless';
  protected readonly log: Logger = log;
  protected readShardSize(): number {
    return readShardSize();
  }
  protected shardExtras(): Partial<ShardConn> {
    return { socket: null };
  }

  async unsubscribe(marketIds: string[]): Promise<void> {
    for (const id of marketIds) {
      this.subscriptions.delete(id);
      for (const shard of this.shards) {
        if (shard.ids.delete(id)) this.resubscribeShard(shard);
      }
    }
  }

  // Per-platform hooks

  protected connectedLogMessage(): string {
    return 'Socket.IO connected';
  }

  // Limitless subscribe is replace-semantics per connection: re-emit the shard's full slug set (`ids` arg ignored).
  protected sendSubscribe(shard: ShardConn, _ids: string[]): void {
    this.resubscribeShard(shard);
  }

  protected onAssignToOpenShard(shard: ShardConn, _id: string): void {
    this.resubscribeShard(shard);
  }

  protected closeOnStop(conn: WsLike | null): void {
    conn?.close();
  }

  // socket.io event vocabulary maps onto the base handlers: connect->onOpen, orderbookUpdate->onMessage, disconnect->onClose.
  protected openSocket(shard: ShardConn, _headers: Record<string, string>, handlers: ShardSocketHandlers): WsLike {
    const apiKey = process.env.LIMITLESS_API_KEY;
    const opts: Parameters<typeof io>[1] = {
      transports: ['websocket'],
      reconnection: false, // we handle reconnect ourselves for consistency
    };
    if (apiKey) (opts as any).extraHeaders = { 'X-API-Key': apiKey };

    const socket = io(WS_URL, opts);
    shard.socket = socket;

    socket.on('connect', () => handlers.onOpen());

    socket.on('disconnect', (reason: string) => {
      if (shard.socket === socket) shard.socket = null;
      handlers.onClose({ closeDetail: reason, disconnectedDetail: reason, logMessage: `Socket.IO disconnected: ${reason}` });
    });

    // Reconnects but must not emitConnectionStale (there was no live book to sentinel) — bypasses the close handler entirely.
    socket.on('connect_error', (err: Error) => {
      log.error(`Connection error: ${err.message}`);
      this.emitReliability('error', err.message);
      if (shard.socket === socket) shard.socket = null;
      if (this.running) this.scheduleReconnectWithEvents(shard);
    });

    socket.on('orderbookUpdate', (msg: any) => {
      const wireTs = Date.now();
      const wireHr = hrNowMs();
      handlers.onMessage(msg, wireTs, wireHr);
    });

    socket.emit('subscribe_market_lifecycle');

    socket.on('marketResolved', (payload: any) => {
      const slug: string = payload?.slug ?? payload?.marketSlug ?? '';
      if (!slug) return;
      this.emitResolution({
        platform: 'limitless',
        platformId: slug,
        winningOutcome: payload?.winningOutcome ?? null,
        timestamp: payload?.resolutionDate ?? payload?.timestamp,
      });
    });

    socket.on('exception', (err: any) => {
      log.error(`Server exception:`, err);
    });

    return {
      // subscribe + lifecycle are emit-based on the raw socket instead (see resubscribeShard).
      send: (_d: string) => {},
      close: () => socket.disconnect(),
      ping: () => {},
      get readyState() {
        return socket.connected ? WS_OPEN : 0;
      },
    };
  }

  protected handleFrame(_shard: ShardConn, payload: unknown, wireTs: number, wireHr: number): void {
    this.dumpRaw(payload);
    this.handleOrderbookUpdate(payload, wireTs, wireHr);
  }

  private resubscribeShard(shard: ShardConn): void {
    if (!shard.socket?.connected || shard.ids.size === 0) return;
    shard.socket.emit('subscribe_market_prices', {
      marketSlugs: [...shard.ids],
    });
  }

  private handleOrderbookUpdate(msg: any, wireTs: number, wireHr: number): void {
    const slug: string = msg.marketSlug ?? msg.market_slug ?? '';
    const sub = this.subscriptions.get(slug);
    if (!sub) return;

    const ob = msg.orderbook ?? msg;
    // Limitless sizes are USDC 6-decimal base units (raw 9_000_000 = 9 shares); divide so size is a share count like Kalshi/Polymarket.
    const USDC_SCALE = 1e6;
    const bids: { price: number; size: number }[] = (ob.bids ?? []).map((b: any) => ({
      price: Number(b.price),
      size: Number(b.size) / USDC_SCALE,
    }));
    const asks: { price: number; size: number }[] = (ob.asks ?? []).map((a: any) => ({
      price: Number(a.price),
      size: Number(a.size) / USDC_SCALE,
    }));

    const sortedBids = [...bids].sort((a, b) => b.price - a.price);
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price);

    const bestBid = sortedBids[0]?.price ?? 0;
    const bestAsk = sortedAsks[0]?.price ?? 2.0;
    const bidSize = sortedBids[0]?.size ?? 0;
    const askSize = sortedAsks[0]?.size ?? 0;

    // timestamp may be a numeric ms, a numeric-string ms, or an ISO-8601 string.
    const serverTsRaw = msg.timestamp ?? msg.ts;
    const serverTs =
      typeof serverTsRaw === 'number'
        ? serverTsRaw
        : typeof serverTsRaw === 'string'
          ? Number(serverTsRaw) || Date.parse(serverTsRaw) || undefined
          : undefined;

    const update: PriceUpdate = {
      marketId: sub.marketId,
      platform: 'limitless',
      bestBid,
      bestAsk,
      bidSize,
      askSize,
      timestamp: Date.now(),
      wireTs,
      wireHr,
      emitHr: hrNowMs(),
      serverTs,
      msgKind: 'full',
      // sortedAsks/sortedBids already are the complete book (a full snapshot); undefined when the ladder flag is off.
      ...(bookLadderEnabled()
        ? {
            askLevels: sortedAsks.slice(0, maxLadderLevels()).map((a) => [a.price, a.size] as [number, number]),
            bidLevels: sortedBids.slice(0, maxLadderLevels()).map((b) => [b.price, b.size] as [number, number]),
          }
        : {}),
    };

    this.emit(update);
  }
}
