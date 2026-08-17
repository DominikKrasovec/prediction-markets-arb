# arb-solver/src/clob/perf-harness/

Isolated CLOB reconstruction + latency monitor. **Not** wired into the live arb-solver — this harness loads the same market set the solver would track, subscribes via the production adapters, and captures every tick to JSONL + an aggregate summary. The intent is to answer questions like "can one process actually subscribe to 33k markets?" and "what does end-to-end latency look like per platform?" before any LP / arb-detect path is exercised.

## Files

| File | Role |
|------|------|
| `index.ts` | CLI entry. Parses flags (`--duration-min`, `--platform`, `--max-subs`, …) and hands off to `run.ts`. |
| `run.ts` | **runHarness()** — loads subs, starts adapters, drives the summary timer, writes manifest/summary JSON. |
| `load-subs.ts` | SQL: edges-at-confidence → active questions → open markets → `MarketSubscription[]`. Mirrors the live solver loader. |
| `metrics.ts` | **MetricsAggregator** — per-platform throughput EMA, e2e/book latency histograms, msgKind breakdown, staleness. |
| `jsonl-sink.ts` | One JSONL file per platform inside `<runDir>/<platform>.jsonl`. Buffered 250 ms flush. |

## Output layout

```
<outRoot>/<runId>/
  manifest.json    # config + sub counts, written at startup
  kalshi.jsonl     # one row per emitted PriceUpdate
  polymarket.jsonl
  limitless.jsonl
  predict.jsonl
  summary.json     # final per-platform aggregates
```

`runId` = `<ISO-startTs>-<6-char nonce>`.

Each JSONL row:
```json
{
  "marketId": 12345,
  "platform": "polymarket",
  "bestBid": 0.42, "bestAsk": 0.45,
  "bidSize": 1000, "askSize": 800,
  "timestamp": 1737...,     // adapter emit ts
  "wireTs":   1737...,      // ws.on('message') ts
  "serverTs": 1737...,      // platform-reported ts (if any)
  "msgKind":  "snapshot"|"delta"|"full"|"unknown",
  "recvTs":   1737...        // when our callback fired (post-emit fanout)
}
```

## Latency definitions

| Metric | Formula | What it measures |
|--------|---------|------------------|
| `e2eLatencyMs` | `timestamp − serverTs` | server-side event → adapter emit (network + WS + parse + book) |
| `bookLatencyMs` | `timestamp − wireTs` | WS frame arrival → adapter emit (parse + book reconstruction only) |
| `recvLatencyMs` | `recvTs − timestamp` | adapter emit → harness callback (fanout-only — should be tiny) |

Server-ts presence per platform:
- **Polymarket** — `msg.timestamp` on most events
- **Kalshi** — `env.ts` / `env.msg.ts`
- **Limitless** — `msg.timestamp`
- **Predict** — `data.updateTimestampMs`

When `serverTs` is missing (some message kinds), `e2eLatencyMs` is not counted for that tick — only `bookLatencyMs` is.

## Caveats

- Latency uses **wall-clock `Date.now()`**; clock skew between our host and the platform shows up as a constant offset on `e2eLatencyMs`. NTP-sync your host for meaningful absolute numbers.
- Quantile histograms are FIFO-capped at 10k samples per platform/per metric. Reflects the **last 10k ticks**, not the full run.
- `--max-subs` filters AFTER the SQL load, then shuffles before slicing — small caps don't bias to specific market IDs.
- The harness creates its own `ClobManager`; the running `arb-solver` (if any) is unaffected, but the two will compete for the same WSS endpoints and Limitless will see two connections from the same API key.
