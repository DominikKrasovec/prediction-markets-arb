import { createHash } from 'node:crypto';

/**
 * Polymarket orderbook-summary hash.
 *
 * The CLOB server publishes a SHA-1 `hash` on every REST `/book` response and
 * every WS `book` snapshot. It is computed over the canonical `OrderBookSummary`
 * with the `hash` field blanked, serialized as compact JSON (no whitespace —
 * `JSON.stringify`'s default), in this exact field order:
 *
 *   market, asset_id, timestamp, hash, bids, asks,
 *   min_order_size, tick_size, neg_risk, last_trade_price
 *
 * `last_trade_price` must be included — omitting it is a common source of
 * hash mismatch. `bids`/`asks` are the raw level arrays exactly as the server
 * sent them (`{price, size}` strings, server order); a parse→stringify
 * round-trip preserves them byte-for-byte.
 *
 * The server emits one hash for a given book state and ships it identically
 * on REST and WS. The only fields a WS `book` frame omits are
 * `min_order_size` and `neg_risk`, both static per market — inject them
 * (from a REST `/book`) and the WS snapshot verifies too.
 */
export interface OrderBookSummaryLike {
  market: string;
  asset_id: string;
  timestamp: string;
  /** Raw level arrays as received: `{ price: string, size: string }`, server order. */
  bids: unknown[];
  asks: unknown[];
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
  last_trade_price: string;
}

/** Canonical SHA-1 of an OrderBookSummary (matches the server `hash`). */
export function orderBookSummaryHash(s: OrderBookSummaryLike): string {
  const ordered = {
    market: s.market,
    asset_id: s.asset_id,
    timestamp: s.timestamp,
    hash: '',
    bids: s.bids,
    asks: s.asks,
    min_order_size: s.min_order_size,
    tick_size: s.tick_size,
    neg_risk: s.neg_risk,
    last_trade_price: s.last_trade_price,
  };
  return createHash('sha1').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Verify a frame that already carries its own `hash` (a REST `/book` response,
 * which contains every hashed field). Returns:
 *   - `true`  — recomputed hash matches `frame.hash`
 *   - `false` — mismatch (book is not what the server hashed)
 *   - `null`  — frame has no string `hash` to check against (skip)
 */
export function verifySelfHash(frame: Partial<OrderBookSummaryLike> & { hash?: unknown }): boolean | null {
  if (typeof frame.hash !== 'string') return null;
  const computed = orderBookSummaryHash({
    market: String(frame.market ?? ''),
    asset_id: String(frame.asset_id ?? ''),
    timestamp: String(frame.timestamp ?? ''),
    bids: (frame.bids as unknown[]) ?? [],
    asks: (frame.asks as unknown[]) ?? [],
    min_order_size: String(frame.min_order_size ?? ''),
    tick_size: String(frame.tick_size ?? ''),
    neg_risk: Boolean(frame.neg_risk),
    last_trade_price: String(frame.last_trade_price ?? ''),
  });
  return computed === frame.hash;
}
