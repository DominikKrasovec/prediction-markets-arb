# Limitless Exchange — Integration Plan

> Reference: https://docs.limitless.exchange/api-reference/  
> Index: https://docs.limitless.exchange/llms.txt  
> OpenAPI: https://docs.limitless.exchange/openapi.json

---

## Overview

Limitless Exchange is a CLOB-based prediction market on **Base (chain 8453)**.
It is architecturally analogous to Polymarket — same CTF binary outcome model,
same EIP-712 order signing — but with a unified REST host, Socket.IO WebSocket,
and slug-addressed markets instead of token-ID addressed markets.

Integration mirrors the existing `scrapers/polymarket` + `clob/polymarket` pair
with adaptations listed in each section below.

---

## Platform Differences vs Existing Scrapers

| Concern | Polymarket | Predict | **Limitless** |
|---|---|---|---|
| Base URL(s) | `gamma-api.polymarket.com` + `clob.polymarket.com` | `api.predict.fun` | `api.limitless.exchange` (unified) |
| Auth header | HMAC `POLY_*` | `x-api-key` | `X-API-Key: lmts_…` |
| Market key | `conditionId` | numeric `marketId` | `slug` or contract address |
| Outcome tokens | `clobTokenIds[0/1]` | `outcomeIndex` | `positionIds[0]`=YES, `[1]`=NO |
| CLOB market flag | `negRisk` flag | always CLOB | `tradeType: clob` (also `amm`, `group`) |
| Chain | Polygon 137 | — | Base 8453 |
| Collateral | USDC.e | — | USDC (6 decimals) |
| WS protocol | raw WebSocket | raw WebSocket | **Socket.IO** (`/markets` namespace) |
| WS subscription | emit JSON `{"assets_ids":[...]}` | emit JSON topic | emit `subscribe_market_prices` |
| Rate limit | varies | varies | 2 concurrent, 300 ms between |

---

## 1. Scraper — Market Ingestion

**Target table:** `limitless_markets` (new, schema mirrors `polymarket_markets`)

**Key columns:** `slug TEXT PK`, `address TEXT`, `trade_type TEXT`, `raw JSONB`, `db_updated_at TIMESTAMPTZ`

### REST Endpoints Used

| Purpose | Endpoint | Notes |
|---|---|---|
| Full active market list | `GET /markets/active?page=N&limit=100` | Paginated; returns `{ data: Market[], totalMarketsCount }`. Filter `tradeType=clob` to skip AMM. |
| Lightweight slug list | `GET /markets/active/slugs` | Returns `[{ slug, strikePrice, ticker, deadline, markets? }]` — fast for change-detection polling |
| Single market detail | `GET /markets/:slug` | Returns venue addresses + `positionIds` needed for CLOB. Cache; venue data is static per market. |
| Search | `GET /markets/search?query=…` | Optional; useful for matching against pipeline subjects |
| Historical prices | `GET /markets/:slug/historical-price?interval=1h&from=…&to=…` | Intervals: `1m`,`1h`,`6h`,`1d`,`1w`,`all` |

### Market Response Shape (CLOB)

```ts
interface LimitlessMarket {
  id: number;
  address: string;           // contract address (0x…)
  conditionId: string;       // hex bytes32
  title: string;
  description: string;
  slug: string;              // primary key for all API calls
  collateralToken: { address: string; decimals: 6; symbol: 'USDC' };
  prices: [number, number];  // [YES%, NO%] in 0–100
  positionIds: [string, string]; // [YES tokenId, NO tokenId]
  venue: {
    exchange: string;  // verifyingContract for EIP-712 BUY
    adapter: string;   // approve CTF tokens here for SELL
  };
  tradeType: 'clob' | 'amm' | 'group';
  status: 'FUNDED' | 'RESOLVED' | string;
  expired: boolean;
  expirationTimestamp: number; // ms epoch
  volume: string;              // raw USDC (6 dec)
  volumeFormatted: string;
  liquidity: string;
  openInterest: string;
  categories: string[];
  tags: string[];
}
```

### Scraper Pattern (mirrors `scrapers/polymarket/gamma-api.ts`)

```
services/ingestion/src/scrapers/limitless/
  api-client.ts   — fetchActiveMarkets(options) with cursor pagination
  scraper.ts      — scrapeMarkets(), scrapeAllMarkets(), fullScrape()
  postgres.ts     — saveMarkets(markets[])
  types.ts        — LimitlessMarket, enums
  index.ts        — re-exports
```

#### Pagination loop (`api-client.ts`)

```ts
// GET /markets/active has page/limit params (no cursor token)
const BASE = 'https://api.limitless.exchange';

async function fetchActiveMarkets(opts: FetchOptions) {
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const res = await get('/markets/active', { page, limit: 100, tradeType: 'clob' });
    await opts.onBatch(res.data);
    hasMore = res.data.length === 100 && page * 100 < res.totalMarketsCount;
    page++;
  }
}
```

#### Rate limiting note

300 ms minimum between requests (2 concurrent max).  
Reuse the exponential-backoff retry wrapper from `gamma-api.ts` (429, 502–504, ECONNABORTED).

---

## 2. CLOB Monitor — Orderbook & WebSocket

**Target tables:** `limitless_orderbook_snapshots` (optional persistent snapshots), live in-memory `LocalOrderBook` map.

### REST Orderbook

```
GET /markets/:slug/orderbook
```

Response:
```ts
{
  adjustedMidpoint: number;  // e.g. 0.75
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  lastTradePrice: number;
  maxSpread: number;
  minSize: number;
  tokenId: string;  // YES token positionId
}
```

No `neg_risk` flag, no SHA-1 hash reconciliation — Limitless does not expose server-side book hashes. **Drop the hash-check logic from the Polymarket orderbook manager.**

### WebSocket — Socket.IO (not raw WebSocket)

**URL:** `wss://ws.limitless.exchange/markets`  
**Library:** `socket.io-client` (not `ws`)  
**Auth:** `extraHeaders: { 'X-API-Key': 'lmts_…' }`

```ts
import { io, Socket } from 'socket.io-client';

const socket = io('wss://ws.limitless.exchange/markets', {
  transports: ['websocket'],
  extraHeaders: { 'X-API-Key': API_KEY },
});
```

#### Subscription

```ts
// Subscribe (replaces previous subscription — always send full list)
socket.emit('subscribe_market_prices', {
  marketSlugs: ['btc-100k-weekly', 'eth-above-3k-apr'],
});
```

⚠ Subscriptions **replace** — must re-send the complete slug list when adding markets.

#### Incoming events

| Event | Trigger | Payload |
|---|---|---|
| `orderbookUpdate` | Any bid/ask change on a CLOB market | `{ marketSlug, orderbook: { bids, asks, … }, timestamp }` |
| `newPriceData` | AMM price tick (not needed for CLOB arb) | `{ marketAddress, updatedPrices: {yes, no}, … }` |
| `marketCreated` | New market funded | `{ slug, title, type, groupSlug?, categoryIds?, createdAt }` |
| `marketResolved` | Market resolved | `{ slug, type, winningOutcome, winningIndex, resolutionDate }` |
| `positions` | Portfolio change (auth required) | position objects per market type |
| `system` | Subscription confirmations, errors | `{ message, … }` |
| `exception` | Server-side error | error object |

#### CLOB File Structure (mirrors `clob/polymarket`)

```
services/ingestion/src/clob/limitless/
  types.ts       — OrderLevel, OrderbookSnapshot, WsOrderbookUpdate, LimitlessMarketConfig
  orderbook.ts   — LocalOrderBook class (no SHA-1 hash; full-snapshot replace model)
  websocket.ts   — LimitlessWSManager using socket.io-client
  api-client.ts  — getOrderbook(slug): REST fallback / initial snapshot
  index.ts       — re-exports
```

#### LocalOrderBook differences vs Polymarket

- **No delta updates** — each `orderbookUpdate` is a full snapshot; replace bids/asks entirely.
- **No SHA-1 hash verification** — omit hash reconciliation.
- **No `neg_risk` field** — venue system handles this; not present in orderbook payload.
- **Price unit** — already decimal (0–1), not integer tick. No tick-size conversion.
- **Reconnect** — Socket.IO handles low-level reconnect; implement application-level re-subscribe on `connect` event.

#### LimitlessWSManager skeleton

```ts
export class LimitlessWSManager {
  private socket: Socket | null = null;
  private subscribedSlugs = new Set<string>();
  public readonly books = new Map<string, LocalOrderBook>();

  connect(): void {
    this.socket = io('wss://ws.limitless.exchange/markets', {
      transports: ['websocket'],
      extraHeaders: { 'X-API-Key': process.env.LIMITLESS_API_KEY! },
    });

    this.socket.on('connect', () => this.resubscribeAll());
    this.socket.on('orderbookUpdate', (msg) => this.handleOrderbookUpdate(msg));
    this.socket.on('marketCreated', (msg) => this.handleMarketCreated(msg));
    this.socket.on('marketResolved', (msg) => this.handleMarketResolved(msg));
    this.socket.on('exception', (err) => console.error('[LimitlessWS]', err));
  }

  addSlugs(slugs: string[]): void {
    for (const s of slugs) {
      this.subscribedSlugs.add(s);
      if (!this.books.has(s)) this.books.set(s, new LocalOrderBook(s));
    }
    this.resubscribeAll();
  }

  private resubscribeAll(): void {
    if (!this.socket?.connected) return;
    this.socket.emit('subscribe_market_prices', {
      marketSlugs: [...this.subscribedSlugs],
    });
  }

  private handleOrderbookUpdate(msg: WsOrderbookUpdate): void {
    const book = this.books.get(msg.marketSlug);
    if (book) book.applySnapshot(msg.orderbook, msg.timestamp);
  }
}
```

---

## 3. Database Schema

New migration file: `docker/migrations/008_limitless.sql`

```sql
-- Market metadata
CREATE TABLE IF NOT EXISTS limitless_markets (
  slug            TEXT PRIMARY KEY,
  address         TEXT,
  condition_id    TEXT,
  trade_type      TEXT,           -- 'clob' | 'amm' | 'group'
  status          TEXT,
  expired         BOOLEAN DEFAULT FALSE,
  expiration_ts   BIGINT,
  volume_num      NUMERIC,
  raw             JSONB NOT NULL,
  db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS limitless_markets_trade_type ON limitless_markets(trade_type);
CREATE INDEX IF NOT EXISTS limitless_markets_status ON limitless_markets(status);

-- Optional: orderbook snapshots (for backtesting / audit)
CREATE TABLE IF NOT EXISTS limitless_orderbook_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL REFERENCES limitless_markets(slug),
  snapshot    JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS limitless_ob_slug_ts ON limitless_orderbook_snapshots(slug, captured_at DESC);
```

---

## 4. Pipeline Integration

### Scraper wiring (`scrapers/run-all.ts`)

Add alongside the existing scrapers:

```ts
import { dbService as limitlessDb } from './limitless/postgres.js';
import { fullScrape as limitlessFullScrape } from './limitless/scraper.js';

async function runLimitlessScraper() {
  await limitlessDb.connect();
  await limitlessFullScrape();
}

// add to Promise.allSettled([...]) in runAllScrapers()
```

### CLOB wiring

The existing CLOB monitors run inside `services/arb-solver`. Add `LimitlessWSManager` there the same way `polymarket` and `predict` CLOB clients are wired — initialise from scraped market slugs, pass orderbook deltas to the arb solver graph update hook.

### Platform type constant

Add `'limitless'` to the `Platform` union in `packages/types/src/platform.ts`.

---

## 5. Authentication

No credential derivation or HMAC per-request signing needed for read-only scraping.

```ts
const headers = {
  'X-API-Key': process.env.LIMITLESS_API_KEY,  // lmts_…
  'Content-Type': 'application/json',
};
```

API key is generated at limitless.exchange → profile → **Api keys**.  
Add `LIMITLESS_API_KEY=lmts_…` to `.env`.

For order placement (future): requires EIP-712 signing with `chainId: 8453`, `verifyingContract: venue.exchange`, domain name `"Limitless CTF Exchange"`.

---

## 6. Endpoint Quick Reference

| Category | Method | Path | Auth |
|---|---|---|---|
| Active markets (paginated) | GET | `/markets/active` | no |
| Active slugs (lightweight) | GET | `/markets/active/slugs` | no |
| Market detail + venue | GET | `/markets/:slug` | no |
| Search | GET | `/markets/search?query=` | no |
| Orderbook | GET | `/markets/:slug/orderbook` | no |
| Historical prices | GET | `/markets/:slug/historical-price` | no |
| Market events (trades) | GET | `/markets/:slug/events` | no |
| Portfolio positions | GET | `/portfolio/positions` | `X-API-Key` |
| Trade history | GET | `/portfolio/trades` | `X-API-Key` |
| Place order | POST | `/orders` | `X-API-Key` + EIP-712 sig |
| Cancel order | DELETE | `/orders/:orderId` | `X-API-Key` |
| Cancel batch | POST | `/orders/cancel-batch` | `X-API-Key` |
| Cancel all for market | DELETE | `/orders/all/:slug` | `X-API-Key` |
| User orders | GET | `/markets/:slug/user-orders` | `X-API-Key` |
| WS connection | Socket.IO | `wss://ws.limitless.exchange/markets` | `X-API-Key` header |

---

## 7. Key Differences to Watch During Implementation

1. **Socket.IO, not raw `ws`** — install `socket.io-client`. The existing `ws` library used for Polymarket and Predict does not speak the Socket.IO handshake protocol.

2. **Subscription is replace, not append** — keep a `Set<string>` of all slugs and re-emit the full set on every `addSlugs()` call and on every `connect` event.

3. **No book hash** — do not port the SHA-1 accuracy checker from `clob/polymarket/accuracy-checker.ts`. Limitless does not expose hash verification.

4. **Full snapshot model** — each `orderbookUpdate` replaces the full book. No price-change deltas. `LocalOrderBook.applySnapshot()` is the only update path.

5. **Slug is primary key** — use `slug` everywhere (not conditionId, not numeric id). Venue addresses and positionIds come from `GET /markets/:slug`; fetch once and cache.

6. **AMM markets exist** — filter `tradeType === 'clob'` to exclude AMM markets from CLOB monitoring. AMM price data comes via `newPriceData` WS event (different from CLOB `orderbookUpdate`).

7. **Rate limit** — 300 ms between requests, 2 concurrent. Add `await sleep(300)` between paginated scrape pages; use a semaphore or sequential awaits for the CLOB REST fallback.
