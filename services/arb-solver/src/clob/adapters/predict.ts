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
import { bookLadderEnabled, maxLadderLevels } from '../token-map.js';

const log = createLogger('clob:predict');

const WS_URL = process.env.PREDICT_WS_URL || 'wss://ws.predict.fun/ws';

// Predict's server closes a connection (code 1000) that subscribes to too many topics,
// so markets are sharded across connections; PREDICT_SHARD_SIZE overrides the default.
const DEFAULT_SHARD_SIZE = 500;
function readShardSize(): number {
  const raw = parseInt(process.env.PREDICT_SHARD_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARD_SIZE;
}

interface ShardConn extends ShardConnBase {
  /** Each Predict socket has its own requestId namespace, so the counter is per shard. */
  reqId: number;
}

/**
 * Predict.fun CLOB adapter (connection-sharded, wss://ws.predict.fun/ws). Heartbeat
 * `{type:"M", topic:"heartbeat", data:<ts>}` every 15s must be echoed or the connection
 * drops. platformId is the numeric Predict market id as a string. Markets are
 * partitioned into `shardSize` chunks, one WebSocket per chunk, each routing only its
 * own frames; reconnect/heartbeat/error handling are per connection.
 */
export class PredictAdapter extends BaseShardedAdapter<ShardConn> {
  readonly platform: Platform = 'predict';
  protected readonly log: Logger = log;
  protected readShardSize(): number {
    return readShardSize();
  }
  protected shardExtras(): Partial<ShardConn> {
    return { reqId: 1 };
  }

  async unsubscribe(marketIds: string[]): Promise<void> {
    for (const id of marketIds) {
      for (const shard of this.shards) {
        if (shard.ids.delete(id)) {
          this.sendUnsubscribe(shard, [id]);
        }
      }
      this.subscriptions.delete(id);
    }
  }

  /** Predict sends `x-api-key` when PREDICT_API_KEY is set (public streams work without it). */
  protected buildConnectHeaders(_shard: ShardConn): Record<string, string> {
    const apiKey = process.env.PREDICT_API_KEY;
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
  }

  /** Predict has no client keepalive; its heartbeat is an inbound echo handled in `handleMessage`. */
  protected openSocket(shard: ShardConn, headers: Record<string, string>, handlers: ShardSocketHandlers): WsLike {
    const ws = new WebSocket(WS_URL, { headers });
    return this.wireRawWs(ws, handlers, (code, reason) => {
      const detail = `code=${code} ${reason?.toString().slice(0, 100) ?? ''}`.trim();
      return {
        closeDetail: detail,
        disconnectedDetail: detail,
        logMessage: `WebSocket closed (${detail}), reconnecting…`,
      };
    });
  }

  protected handleFrame(shard: ShardConn, payload: unknown, wireTs: number, wireHr: number): void {
    try {
      const msg = JSON.parse((payload as import('ws').RawData).toString());
      this.dumpRaw(msg);
      this.handleMessage(shard, msg, wireTs, wireHr);
    } catch {
      // malformed; ignore
    }
  }

  protected sendSubscribe(shard: ShardConn, marketIds: string[]): void {
    const ws = shard.conn;
    if (!ws || ws.readyState !== WS_OPEN || marketIds.length === 0) return;
    for (const id of marketIds) {
      ws.send(
        JSON.stringify({
          method: 'subscribe',
          requestId: shard.reqId++,
          params: [`predictOrderbook/${id}`],
        }),
      );
    }
  }

  private sendUnsubscribe(shard: ShardConn, marketIds: string[]): void {
    const ws = shard.conn;
    if (!ws || ws.readyState !== WS_OPEN || marketIds.length === 0) return;
    for (const id of marketIds) {
      ws.send(
        JSON.stringify({
          method: 'unsubscribe',
          requestId: shard.reqId++,
          params: [`predictOrderbook/${id}`],
        }),
      );
    }
  }

  private handleMessage(shard: ShardConn, msg: any, wireTs: number, wireHr: number): void {
    if (msg.type === 'M' && msg.topic === 'heartbeat') {
      this.emitReliability('heartbeat_in', String(msg.data ?? ''), shard.connId);
      if (shard.conn?.readyState === WS_OPEN) {
        shard.conn.send(JSON.stringify({ method: 'heartbeat', data: msg.data }));
        this.emitReliability('heartbeat_out', String(msg.data ?? ''), shard.connId);
      }
      return;
    }

    if (msg.type === 'R') return; // subscribe/unsubscribe ack

    if (msg.type === 'M' && typeof msg.topic === 'string' && msg.topic.startsWith('predictOrderbook/')) {
      const platformId = msg.topic.slice('predictOrderbook/'.length);
      this.handleOrderbook(platformId, msg.data, wireTs, wireHr);
      return;
    }

    // some servers push naked payloads with marketId; best-effort fallback
    if (msg.data?.marketId != null) {
      this.handleOrderbook(String(msg.data.marketId), msg.data, wireTs, wireHr);
    }
  }

  private handleOrderbook(platformId: string, data: any, wireTs: number, wireHr: number): void {
    const sub = this.subscriptions.get(platformId);
    if (!sub || !data) return;

    const bids: [number, number][] = data.bids ?? [];
    const asks: [number, number][] = data.asks ?? [];

    // defensive re-pick despite Predict's pre-sorted guarantee, to survive a future protocol change
    let bestBid = 0;
    let bidSize = 0;
    let bestAsk = 2.0;
    let askSize = 0;

    for (const lvl of bids) {
      const p = Number(lvl[0]);
      const q = Number(lvl[1]);
      if (p > bestBid) {
        bestBid = p;
        bidSize = q;
      }
    }
    for (const lvl of asks) {
      const p = Number(lvl[0]);
      const q = Number(lvl[1]);
      if (bestAsk >= 2.0 || p < bestAsk) {
        bestAsk = p;
        askSize = q;
      }
    }

    const serverTs = typeof data.updateTimestampMs === 'number' ? data.updateTimestampMs : undefined;

    const update: PriceUpdate = {
      marketId: sub.marketId,
      platform: 'predict',
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
      // full depth ladder: Predict sends a full snapshot, so bids/asks ARE the full book
      ...(bookLadderEnabled()
        ? {
            askLevels: asks
              .map((l) => [Number(l[0]), Number(l[1])] as [number, number])
              .sort((a, b) => a[0] - b[0])
              .slice(0, maxLadderLevels()),
            bidLevels: bids
              .map((l) => [Number(l[0]), Number(l[1])] as [number, number])
              .sort((a, b) => b[0] - a[0])
              .slice(0, maxLadderLevels()),
          }
        : {}),
    };
    this.emit(update);
  }
}
