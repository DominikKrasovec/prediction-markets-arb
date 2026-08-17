# ingestion/src/lifecycle/

WSS-based near-real-time market lifecycle watchers. Each platform watcher connects to its platform's WebSocket feed and detects new markets and resolution events as they happen.

## Files

| File | Role |
|------|------|
| `base-watcher.ts` | **BaseLifecycleWatcher** abstract class. Provides shared WSS infrastructure: `connect()`, `disconnect()`, `isConnected()`, `stats()`, reconnect scheduling, gap tracking (records disconnect timestamp → used by `gap-refill.ts` on reconnect). Subclasses must implement `connect()`, `disconnect()`, and `isConnected()`. |
| `kalshi-lifecycle.ts` | **KalshiLifecycleWatcher** — subscribes to `market_lifecycle_v2` channel via Kalshi WSS API using `@arb/kalshi-auth` for RSA-PSS signing. Fires on `created` and `settled`/`determined` events. |
| `polymarket-lifecycle.ts` | **PolymarketLifecycleWatcher** — subscribes to Polymarket WSS (`custom_feature_enabled: true`) for `new_market` and `market_resolved` events. |
| `limitless-lifecycle.ts` | **LimitlessLifecycleWatcher** — connects via socket.io to Limitless WSS. Handles `marketCreated` and `marketResolved` events. Circuit breaker slows reconnects after 10 consecutive failures. |
| `event-backfill.ts` | `ensureKalshiEvent(eventTicker)` / `ensurePolymarketEvent(eventId)` — REST follow-up that fills the parent `<platform>_events` row when a WSS `created` payload carries only the event id. Idempotent + per-id memoised so sibling-market arrivals collapse to one fetch. |
| `gap-refill.ts` | `refillKalshi(since)` / `refillPolymarket(since)` / `refillLimitless(since)` — on WSS reconnect, narrowly fetch markets created/settled during the disconnect window via REST. Wired into each watcher as its `refillCallback` from `ingestion/src/index.ts`. Predict is not included (no WSS — its scraper is REST-poll based). |

## Watcher interface (from base-watcher.ts)

```typescript
abstract class BaseLifecycleWatcher {
  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  protected abstract isConnected(): boolean;
  stats(): LifecycleStats; // { connected, reconnectCount, messagesReceived, marketsCreated, marketsResolved }
  protected handleReconnectRefill(): void;
  protected scheduleReconnect(): void;
}
```

## Caveats
- Lifecycle watchers are started by `ingestion/src/index.ts`. `arb-solver` also listens for resolution events from its CLOB adapters but those are separate WSS price-feed connections, not the lifecycle watchers here.
- `gap-refill.ts` issues REST calls during reconnect; if the gap was long, this can be a heavy burst. Rate-limiting should be considered for production.
- `writeAndPublishResolution` from `@arb/resolution-write` is the single source of truth for resolution writes — do not add direct DB writes for resolution elsewhere without going through that package.
- `KalshiLifecycleWatcher` requires the same RSA-PSS env vars as the scraper (`KALSHI_KEY_ID` + `KALSHI_KEY_PEM`/`KALSHI_KEY_PATH`). The signing impl is shared via `@arb/kalshi-auth` so the watcher and scraper cannot drift on auth semantics.
