# arb-solver/src/clob/

CLOB (Central Limit Order Book) price subscription layer. Manages connections to all 4 platform price feeds and maintains an in-memory price cache that the solver loop reads.

## Files

| File | Role |
|------|------|
| `manager.ts` | **ClobManager** — single entry point; owns all 4 adapters. `startTracking(subs)` groups markets by platform and starts each adapter; `stopAll()`, `updateSubscriptions(newSubs)` (diff add/remove), and `unsubscribeMarket(id)` adjust the live set. Routes every adapter's price + resolution events to registered callbacks. Unconditionally it expands each VERIFIED Polymarket market into two token-level subscriptions (clobTokenIds[0]→`outcome:'yes'`, [1]→`'no'`) via `token-map.ts` before the adapter sees the list; `trackedMarkets` stores all subs per marketId so unsubscribe paths drop both tokens. Constructor accepts test seams (`adapters`, `tokenMapLoader`). |
| `token-map.ts` | **Token↔outcome mapping assert + expansion** (unconditional). `verifyTokenOutcomeMapping(clobTokenIds, outcomes)` accepts only affirmative-first complement label pairs (Yes/No, Up/Down, Over/Under, Odd/Even, "Over X"/"Under X") — inverted or unverifiable labels (e.g. team-vs-team) are rejected and the market keeps its one-sided condition_id sub (synthetic NO in lp-builder). `loadVerifiedPolymarketTokenMap` is the DB-backed loader (`polymarket_markets.raw`, lazy `@arb/db` import so the geo VPS stays DB-free); `expandTwoSidedSubscriptions` is the pure expansion. |
| `price-cache.ts` | **PriceCache** — in-memory `Map<marketId, PriceSnapshot>`. `track(id)` seeds a sentinel entry, `update(priceUpdate)` writes live prices, `markStale(platform)` / `markStaleByIds(ids)` flag entries as unpriced, `get(id, now?)` returns `undefined` when absent (and sentinel prices when stale), `setTtl(ms)` configures the quote-age TTL (a snapshot older than the TTL is reported stale by `get` even without an explicit `markStale`), `evict(keepIds)` drops untracked markets, `getLiveSnapshots()` returns non-sentinel rows for DB persistence (primary/YES books only). Also defines the `PriceUpdate` and `MarketSubscription` types. Updates tagged `outcome:'no'` go to a separate per-market NO-book slot read via `getNo(id, now?)` (same TTL/stale rules); they never clobber the YES snapshot. |

## Subsystems

| Folder | Purpose |
|--------|---------|
| [`adapters/`](adapters/doc.md) | One adapter per platform — each implements `ClobAdapter` and streams live price ticks |
| [`perf-harness/`](perf-harness/doc.md) | Standalone latency/throughput harness for the adapters (CLI, JSONL sink, metrics) |

## Interfaces

```typescript
// ClobAdapter (adapters/base.ts)
interface ClobAdapter {
  readonly platform: Platform;
  start(markets: MarketSubscription[]): Promise<void>;
  subscribe(markets: MarketSubscription[]): Promise<void>;
  unsubscribe(marketIds: string[]): Promise<void>;   // platform-native ids
  stop(): Promise<void>;
  onPriceUpdate(cb: (update: PriceUpdate) => void): void;     // register callback
  onMarketResolved(cb: (event: ResolutionEvent) => void): void;
}
```

```typescript
// PriceSnapshot (cache entry) / PriceUpdate (adapter emit) — prices in DOLLARS (0..1)
interface PriceSnapshot {
  marketId: number;
  bestBid: number;   // best YES bid ($); 0 = none
  bestAsk: number;   // best YES ask ($); 2.0 sentinel = no liquidity (excluded from LP)
  bidSize: number;
  askSize: number;
  lastUpdate: number;       // ms epoch — advances on EVERY frame
  lastTobChangeMs: number;  // ms epoch — when the top-of-book last actually MOVED
  staleSince: number | null;
}
```

## Caveats
- `ClobManager` does not retry individual adapter failures; it logs (`Promise.allSettled`) and continues. Each adapter handles its own reconnection.
- Stale markets stay in `PriceCache` with `staleSince != null` and report sentinel prices (`bestAsk=2.0`, `bestBid=0`); the LP excludes them. A quote that ages past the `setTtl(ms)` window (set from `config.execution.quoteTtlMs` at boot) is also reported with sentinel prices by `get`, even without an explicit `markStale`.
- A FROZEN-but-fresh book (the feed re-pushes an unchanged top-of-book so `lastUpdate` never ages, but the displayed level hasn't moved) is caught by the separate TOB-age gate `setTobTtl(ms)` (from `config.execution.tobTtlMs`, 5-min default): `get`/`getNo` report sentinel prices once `lastTobChangeMs` is older than `tobTtlMs`. `Infinity`/`0` disables it.
- Price units are **dollars (0–1)** throughout — not cents. The `2.0` ask sentinel is deliberately out-of-range so unpriced markets never enter a portfolio.
