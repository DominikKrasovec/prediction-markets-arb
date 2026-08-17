# arb-solver/src/clob/adapters/

One adapter per platform. Each adapter implements the `ClobAdapter` interface and is responsible for connecting to its platform's live price feed, converting ticks to the internal `PriceUpdate` format, and firing the registered `onPriceUpdate` / `onMarketResolved` callbacks.

## Files

| File | Role |
|------|------|
| `base.ts` | **ClobAdapter interface** + **BaseClobAdapter** abstract class. Defines the shared contract: `start`, `stop`, `subscribe`, `unsubscribe`, `onPriceUpdate`, `onMarketResolved`. Exports the `ResolutionEvent` type. (`PriceUpdate` and `MarketSubscription` are defined in `../price-cache.ts`.) Also provides the `CLOB_DUMP_RAW` raw-payload dump helper used by the perf harness. |
| `base-sharded.ts` | **BaseShardedAdapter** abstract class (extends `BaseClobAdapter`) + the `WsLike` transport abstraction. OWNS the per-shard connection lifecycle shared by all 4 adapters: shard partitioning (`partitionShards`/`makeShard`/`assignIdToShard`), the `connect()` envelope (connId alloc, `connect_start`/`ws_open`/`subscribe_sent`/`first_message`/`close`/`reconnect_scheduled` instrumentation), the single close handler that fires `emitConnectionStale` once, idempotent `scheduleReconnect`, and the keepalive timer scaffold. Per-platform behavior (transport build, subscribe frame shape, auth, book reconstruction, keepalive form, seq/hash/REST integrity) stays in the subclasses behind thin hooks (`openSocket`, `sendSubscribe`, `handleFrame`, + optional `buildConnectHeaders`/`keepaliveIntervalMs`/`onShardClose`/…). |
| `kalshi.ts` | **KalshiAdapter** — connects to the Kalshi WSS CLOB endpoint (`wss://api.elections.kalshi.com/trade-api/ws/v2`); RSA-PSS auth headers via `@arb/kalshi-auth` (`createAuthHeaders`); subscribes to the `orderbook_delta` channel and maintains local YES/NO bid books (YES ask = 1 − best NO bid). |
| `polymarket.ts` | **PolymarketAdapter** — connects to Polymarket CLOB WSS; subscribes by **clobTokenId** (`assets_ids`, `custom_feature_enabled:true`); maintains full depth per asset and handles `book` snapshots, `price_change` deltas, and `market_resolved` events. Two subscriptions per market (YES/NO tokens) are supported. |
| `limitless.ts` | **LimitlessAdapter** — connects to the Limitless **Socket.IO** `/markets` feed; each `orderbookUpdate` is a full snapshot (no deltas); subscribes via `subscribe_market_prices` and listens for `marketResolved`. CTF sizes are scaled by 1e6 (USDC base units). |
| `predict.ts` | **PredictAdapter** — connects to the Predict.fun WSS CLOB (`wss://ws.predict.fun/ws`); subscribes to `predictOrderbook/{marketId}` topics and echoes the server heartbeat. Sends an `x-api-key` header when `PREDICT_API_KEY` is set. |
| `_contract.test.ts` | Contract tests — drives each adapter with mock wire payloads and asserts `onPriceUpdate` fires correctly shaped `PriceUpdate` objects. |

## Adapter lifecycle
1. `ClobManager.startTracking(subs)` → calls `adapter.start(platformSubs)` for each platform
2. WSS / Socket.IO connects → adapter subscribes to the relevant channel/topics
3. Price tick arrives → adapter builds a `PriceUpdate` and calls `this.emit(update)`, fanning out to every `onPriceUpdate(update)` callback
4. Resolution event → adapter calls `this.emitResolution({ platform, platformId, winningOutcome, timestamp })`, fanning out to `onMarketResolved`
5. `ClobManager.stopAll()` → calls `adapter.stop()` on all adapters

## Caveats
- **All four adapters are push-based.** Kalshi/Polymarket/Predict use raw WS (`ws`); Limitless uses Socket.IO. None polls REST.
- `KalshiAdapter` and the ingestion Kalshi scraper share the **same** `@arb/kalshi-auth` package (`createAuthHeaders`) — there is no duplicated auth implementation.
- The per-shard reconnection loop (a 5 s `setTimeout(() => connect())`, idempotent via the `reconnectTimer` guard) lives in **`base-sharded.ts`** (`scheduleReconnect`), shared by all 4 adapters; the close/error handlers route through it. The reconnect is PER shard — one dead shard never affects others.
- `subscribe` / `unsubscribe` can be called after `start` to adjust the subscription set without a full reconnect.
- Prices are emitted in **dollars (0–1)**; a `bestAsk` sentinel of `2.0` means "no liquidity" and is excluded from the LP.
