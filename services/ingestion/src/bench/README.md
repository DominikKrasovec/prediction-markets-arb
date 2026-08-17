# lifecycle-bench — new-market discovery diagnostics

Measures **how fast and how reliably we detect newly-created markets** on each
platform's discovery feed, **without writing any discovered market to the DB**.
It's the discovery-feed analogue of the CLOB price-feed harness in
`services/arb-solver/src/clob/geo-compare`: connect to the real feeds, run for a
fixed window, emit latency / reliability / throughput / detection metrics, print
a report. No `@arb/db` import → runs anywhere (local or a DB-less box).

Use it to debug the monitor locally, then run it on the server for longer to
collect a real sample of `created` events (which are rare minute-to-minute).

## What it measures

Two discovery paths, mirroring production (`services/ingestion/src/index.ts`):

| Path | Platforms | Source mirrored |
|------|-----------|-----------------|
| WSS lifecycle (`created`/`resolved` push) | kalshi, polymarket, limitless | `src/lifecycle/*-lifecycle.ts` |
| REST poll (published-desc head, diffed) | predict | `src/scrapers/predict/api-client.ts` |

Per WSS feed: connection handshake (connect→ws_open), subscribe latency
(ws_open→subscribe_sent), first-data-frame latency (subscribe→first push),
message + heartbeat throughput, uptime %, disconnects / errors / reconnects, and
**detection latency for BOTH creations and resolutions** — skew-corrected
`(localRecv + clockOffset) − serverTs` over every `created`/`resolved` event
whose payload carried a usable timestamp (creation ts for creations, settlement
ts for resolutions). An SNTP offset is sampled once at start so the number is
comparable across machines; bounded by NTP accuracy.

Per REST feed (Predict): two heads polled each tick — OPEN (creations) and
RESOLVED (resolutions) — with poll-latency distribution, markets per poll, and
new ids after the baseline poll; new ids are emitted as discovery events so
Predict joins the detection-latency and by-type views.

**Sorted by market type (UNIFIED).** Creations and resolutions are broken down by
the **unified cross-platform category** — the same 10-label vocabulary the
pipeline stamps onto `markets.category_unified` (sports / crypto / election /
politics / economic / entertainment / technology / weather / geopolitical /
other), via the same `classifyCategoryLabels` keyword classifier. That makes the
breakdown comparable across platforms — see the **Cross-platform category
matrix** (unified category × platform). A finer **native** label (kalshi
event-ticker series prefix e.g. `KXBTC15M`; predict `marketVariant`; limitless
venue type; polymarket category/negRisk) is kept alongside for drill-down.

## Run it

Run **from the repo root** (the Kalshi key path `KALSHI_KEY_PATH=./secrets/...`
and `.env` are resolved relative to CWD):

```bash
# bash / pwsh, from repo root
bun run services/ingestion/src/bench/run-bench.ts --duration 120

# or via the package script (it cd's to repo root for you)
bun --filter @arb/ingestion run bench:lifecycle -- --duration 120
```

Local debug examples:

```bash
# one platform, short, verbose
bun run services/ingestion/src/bench/run-bench.ts --platforms polymarket --duration 60 --verbose

# everything, quiet Predict's per-poll API logging
LOG_LEVEL=warn bun run services/ingestion/src/bench/run-bench.ts --duration 120
```

Server (longer window — this is the point of the tool; `created` events are
sparse, so an hour+ gives a real detection-latency sample):

```bash
bun run services/ingestion/src/bench/run-bench.ts --duration 3600 --label vps --out data/lifecycle-bench
```

### Flags

| flag | default | meaning |
|------|---------|---------|
| `--duration <sec>` | 120 | run window |
| `--platforms <csv>` | all | subset of `kalshi,polymarket,limitless,predict` |
| `--out <dir>` | `data/lifecycle-bench` | output root |
| `--label <str>` | hostname | run label (used in the run-id + report) |
| `--predict-poll <sec>` | 30 | Predict REST poll interval |
| `--status-every <sec>` | 15 | live status cadence (`0` = off) |
| `--raw-samples <n>` | 3 | dump up to n raw payloads per (platform,kind) to `raw-samples.jsonl` for field discovery (`0` = off) |
| `--kalshi-enrich` | off | resolve Kalshi unified category authoritatively via a read-only `fetchEventByTicker` lookup (`event.category`); off → frame-text classification only |
| `--no-ntp` | off | skip the SNTP offset (detection latency stays uncorrected) |
| `--verbose` | off | per-feed connection logging |

The harness stops early and still writes the report on `SIGINT`/`SIGTERM`, so
`Ctrl-C` on a long run produces a partial-but-valid report.

## Output

```
<out>/lifecycle-bench-<runId>/
  manifest.json      run metadata (label, clock offset, source commit, dbWrites:false)
  lifecycle.jsonl    per-connection phase timings (connect_start → first_message)
  reliability.jsonl  connect / disconnect / error / reconnect / heartbeat
  discovery.jsonl    created / resolved detections (id, serverTs, detectMs, tsField, marketType, typeField)
  poll.jsonl         Predict REST poll cycles (pollKind: created | resolved)
  raw-samples.jsonl  first N raw payloads per (platform,kind) — field discovery
  summary.json       aggregated metrics (same data the report renders)
  report.md          the markdown report (also printed to stdout)
```

`*.jsonl` are the durable per-event record for long runs; `summary.json` /
`report.md` are the aggregation. Re-aggregating a long run from the JSONL (rather
than trusting only the in-memory report) is a safe future extension.

## Credentials

- **Polymarket** — none (public).
- **Limitless** — lifecycle feed works without a key; `LIMITLESS_API_KEY` is sent
  if present.
- **Kalshi** — needs `KALSHI_KEY_ID` + `KALSHI_KEY_PATH` (or `KALSHI_KEY_PEM`).
  Auth failure (e.g. missing key file) is reported as a connect error, not a crash.
- **Predict** — needs `PREDICT_API_KEY`, else the REST poll is skipped with a warn.

`*_WS_URL` env overrides (`KALSHI_WS_URL`, `POLYMARKET_WS_URL`, `LIMITLESS_WS_URL`)
are honoured, identical to the production watchers.

> When debugging inside a git **worktree**, `.env` and `secrets/` are gitignored
> and therefore absent — copy them in (`cp ../../../.env .` / `cp -r
> ../../../secrets .`) or run from the main checkout. On the server the main
> checkout already has both.

## Guarantees & caveats

- **No DB writes.** Nothing here imports `@arb/db`; `created`/`resolved` events
  are recorded as metrics instead of being persisted. This is the "diagnostics
  only, no writes yet" mode.
- **Keep in sync with prod.** `lifecycle-bench.ts` copies each production
  watcher's connection details (URL, subscribe frame, ping cadence,
  stale-watchdog timeout). If a prod watcher's connection detail changes, update
  it here too or the benchmark stops measuring the real feed. The reconnect /
  backoff machinery is *shared* (it extends the same DB-free
  `BaseLifecycleWatcher`), so that part can't drift.
- **`created` events are rare.** A short local run mostly validates
  connectivity + handshake/subscribe latency + Predict polling; detection-latency
  samples accumulate over longer windows (run on the server).
- **Detection-latency field provenance** is reported per platform (the
  `ts field(s)` column) so you can see *which* payload field supplied the server
  timestamp. Platforms/events without a usable timestamp report arrival only.
- **Field findings** (from `raw-samples.jsonl`, 2026-06-15 — WSS frames are
  lighter than the REST objects):
  - Kalshi `created` → top level is only `market_ticker` / `open_ts` / `close_ts`
    (scheduled, *future*) / `event_type` / `price_level_structure`; the
    descriptive fields (`title`, `yes_sub_title`, `rules_primary`, `event_ticker`)
    are nested under **`additional_metadata`** (the bench descends into it).
    `resolved` → only `market_ticker` / `determination_ts` / `result` /
    `settlement_value` — **no title, no event_ticker** (event ticker is derived
    from `market_ticker` by dropping the strike segment).
  - Polymarket `new_market` → creation ts falls through to the frame `timestamp`
    (no `createdAt` in the WSS frame); type from `category` if present, else a
    `negRisk` structural label.
  - Limitless `marketCreated` → `createdAt` (ISO) + `categoryIds` (opaque numeric,
    no names) + `type` (CLOB/AMM); `marketResolved` → `resolutionDate`. Type buckets
    by venue `type` since the frame has no category names.
  - Predict markets → `createdAt` (ISO) for creations; **resolved markets carry NO
    settlement timestamp** (only an outcome `resolution` object), so Predict
    resolution latency is unavailable by design (count only). Type = `marketVariant`
    (CRYPTO_UP_DOWN / SPORTS_MATCH / …), not the per-candle `categoryTitle`.
- **Predict REST poll** samples the published-desc head (bounded by
  `maxCategories`), not the whole catalogue — correct for discovery-latency
  timing, but a market created far down an unusual sort could be missed.
- **Unified bucketing** uses `classifyCategoryLabels` — currently a *vendored
  copy* (`unified-category.ts`) of the pipeline's classifier
  (`services/pipeline/src/db/category-taxonomy.ts`), because a DB-less benchmark
  can't import `@arb/pipeline` (would pull `@arb/db`). The `UNIFIED_CATEGORIES`
  enum itself is imported from `@arb/types`, so only the keyword regex is
  duplicated — **keep it in sync**. The clean fix is the hoist below.

## Hoisting `classifyCategoryLabels` into `@arb/types` (the single-source fix)

The vendored copy exists only because the classifier lives in `@arb/pipeline`.
The proper fix is to move it to `@arb/types` (which already owns
`UNIFIED_CATEGORIES`) so the pipeline AND this bench import one copy.

**Why it can't be done inside this worktree.** `.claude/worktrees/*`'s
`node_modules` is a **junction into the main checkout**, and `@arb/*` resolve
through it via the `source`/`bun` export conditions to **main's**
`packages/types/src` (verified with `tsc --traceResolution` and
`import.meta.resolve`). So edits to *this worktree's* `packages/types` are never
consumed — neither tsc nor bun sees them. A shared-package change must be made
where `@arb/types` actually resolves: the **main checkout** (or a normal
`git worktree` outside `.claude/worktrees`, which gets its own real install).

**Procedure (do it on a normal branch off main, or after merging this branch):**
1. `packages/types/src/pipeline.ts`: add the `KEYWORDS` const + `classifyCategoryLabels`
   function after `UNIFIED_CATEGORIES` (it's pure — depends only on that enum).
   It auto-surfaces via `index.ts`'s `export * from './pipeline.js'`.
2. `services/pipeline/src/db/category-taxonomy.ts`: delete the local definition,
   add `export { classifyCategoryLabels } from '@arb/types';`. The two importers
   (`db/sync.ts`, `db/market-normalizer.ts`) import via `./category-taxonomy.js`,
   so they need **zero** edits.
3. `services/ingestion/src/bench/classify.ts`: import `classifyCategoryLabels`
   from `@arb/types`; **delete `unified-category.ts`**.
4. Build + verify: `npx tsc --build packages/types --noEmit` then
   `... services/pipeline --noEmit` and `... services/ingestion --noEmit`
   (composite/project-references rebuild `@arb/types` first). 9 consumers, all
   additive — no signature changes.

Because the bench files (`classify.ts`, `unified-category.ts`) exist **only on
this branch**, keep the hoist atomic: do all four steps on the bench branch and
validate them in a non-junctioned checkout, OR merge the bench first and then do
the hoist on main. Don't split steps 1-2 onto main and 3-4 onto the worktree.

The same reasoning applies if we later want a **DB-free Kalshi ticker→category
classifier** in the bench (`resolveKalshiTickerPrefix` / series maps): hoist the
pure taxonomy into a shared package rather than vendoring ~350 prefix entries.
- **Kalshi unified classification — three tiers** (the pipeline's authoritative
  source is the *event* category, `kalshi_events.category`, from the Kalshi API —
  NOT the ticker):
  1. *created* frames → the bench reads `additional_metadata.title` etc. and runs
     the unified classifier (free, no network). Good for crypto/price/weather/
     clearly-titled sports.
  2. *resolved* frames are sparse (ticker only) → free classification yields
     `other`; the **native** series-prefix column is the usable signal.
  3. `--kalshi-enrich` (opt-in) → resolve the **authoritative** unified category
     via a **read-only** `fetchEventByTicker` lookup (`event.category` →
     classifier), cached per event_ticker. This is how the pipeline sources Kalshi
     category, minus the DB write; it correctly maps esports/tennis
     (`KXCS2MAP`, `KXLOLTOTALMAPS`, `KXITFWMATCH`) → `sports`. Cost: one
     rate-limited REST GET per distinct event (markets arrive at <1 Hz, so cheap).
     Arrival time is captured before the fetch, so detection latency is not
     inflated by the round-trip.
  - The codebase also has a **DB-free ticker→sport/category classifier**
    (`entity-heuristic.resolveKalshiTickerPrefix`, `kalshi-deterministic`'s
    series maps) that could give a zero-network deterministic signal, but it
    lives in `@arb/pipeline` — reusing it from this service hits the same
    shared-package boundary as `classifyCategoryLabels` (see the hoist note
    below). `--kalshi-enrich` sidesteps that by using the in-service read-only
    REST path, which is also strictly more accurate (ground-truth category).
- **Latent prod finding (not the bench's bug):** `services/ingestion/src/lifecycle/
  kalshi-lifecycle.ts` reads `msg.event_ticker` at the TOP level of the `created`
  frame, but that field is nested under `additional_metadata` (top-level is
  `undefined`). So `ensureKalshiEvent` early-returns and the parent
  `kalshi_events` row / category enrichment never fires for WSS-created Kalshi
  markets, and the saved market gets `event_ticker=''`. Worth a separate fix
  (read from `additional_metadata.event_ticker`, or derive from `market_ticker`).
- **Detection latency is windowed.** Only samples in `[-60s, +120s]` count as a
  real-time-push measurement. Future-dated timestamps (a scheduled open/close
  field, e.g. Kalshi `open_ts`) and stale events (a subscribe-time backlog/replay
  burst, common on Limitless) are tallied under `excl. future/stale/no-ts` rather
  than polluting the p50.
