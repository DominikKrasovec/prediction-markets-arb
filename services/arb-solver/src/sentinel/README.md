# Identity-layer divergence sentinel

A self-contained module that turns the live CLOB price feed into a **free,
continuous false-positive detector on the identity layer**.

## What it asserts

The pipeline asserts equivalences in three places:

| Assertion | DB locus | Watch-pair kind |
|---|---|---|
| Two questions are the same event | `implication_edges` `edge_type='equivalence'` (patterns `cross_question_equiv`, `cross_ref_equiv`) | `equiv-edge` |
| Two markets are fungible members of one question | `question_members` (6,987 multi-platform questions) | `member-fungibility` |
| Two questions are mutually exclusive | `edge_type='mutual_exclusion'` | `mutex-edge` (optional, off by default) |

If those assertions are TRUE, prices must obey them once books are live:

- **equal pairs**: `|pYES_a − pYES_b|` must stay small — and crucially, must
  **re-converge after information events**;
- **mutex pairs**: `pYES_a + pYES_b ≤ 1 + fees` must hold.

**Paper grounding.** Reichenbach & Walther (paper2.txt) show mispricing on
Polymarket concentrates early in a contract's lifecycle and near resolution —
markets need time to incorporate news, but they DO incorporate it: truly
equivalent markets converge after information arrives. Krause
(*Same Bet, Different Markets*, LITERATURA/) and Gebele & Matthes's election
case show the converse signature: **divergence that never converges is exactly
what a semantic mismatch (or market segmentation) looks like** — e.g. Krause's
Atkins-testimony divergence. So: persistent post-news price disagreement
between asserted-equivalent legs, with BOTH books active, is evidence the
equivalence assertion itself is wrong — the identity-layer FP signal. The two
benign explanations are distinguishable: segmentation/latency oscillates or
converges; staleness shows a dead leg.

## Module map

```
sentinel/
  types.ts       WatchPair / SentinelTick / SentinelConfig / ReviewItem / verdicts
  registry.ts    buildWatchPairs(graph) — pure extraction from graph/loader types
  detector.ts    DivergenceDetector — per-pair event-driven state machine (time injected)
  classifier.ts  classifyEpisode — pure verdict logic + spread-history summary
  sink.ts        SentinelSink — ring buffer + JSONL append + log lines (NO DB tables)
  sentinel.ts    IdentitySentinel facade: pump / markStale / sweep / summary
  index.ts       public exports
```

## Detector state diagram

```
           metric > threshold              window elapsed (+ activity gate → verdict)
  ┌──────┐ ────────────────► ┌─────────┐ ─────────────────────► ┌─────────┐
  │ IDLE │                   │ PENDING │                        │ ALERTED │
  └──────┘ ◄──────────────── └─────────┘                        └─────────┘
     ▲      metric ≤ threshold (converged — the healthy U5          │
     │      case: equivalent legs re-converged; NO alert)           │
     └──────────────────────────────────────────────────────────────┘
              metric < threshold × clearRatio   (hysteresis re-arm;
              an alerted pair can never re-alert until it deep-clears)

  metric (mode 'equal'):  |mid_a − mid_b|   — or, with useCrossablePrices,
                          max(0, bid_a − ask_b, bid_b − ask_a)  (only
                          monetizable disagreement; immune to wide-book noise)
  metric (mode 'mutex'):  max(0, mid_a + mid_b − (1 + mutexFeeAllowance))

  PENDING window:  persistenceWindowMs (default 60 min)
                   → fastWindowMs (default 10 min) on the POST-SPIKE fast path:
                     exactly ONE leg spiked (|Δmid| ≥ 0.10 within 5 min, ≥3
                     updates) — info arrived, the other leg didn't follow.
                     Both legs spiking = joint repricing → normal window
                     (also downgrades a premature fast path when one feed ran
                     a second ahead of the other at episode open).

  Verdict at alert time (classifier.ts):
    one leg stale/inactive            → 'liveness'             (dead book)
    one-directional (sign consistency ≥ 0.9) + not converging
      + both legs active              → 'suspect-identity'     (THE signal)
    oscillating or converging         → 'segmentation-latency' (microstructure)
```

All time is injected: event time = `tick.timestamp`, periodic evaluation takes
an explicit `now`. There is no `Date.now()` anywhere in registry / detector /
classifier — fully deterministic and testable.

**Activity gate**: a leg is "active" only with ≥2 book updates in the last 30
min (update count is the volume proxy — the WSS feed exposes book updates, not
trades). A breach against an inactive leg is verdict `liveness`, never
`suspect-identity` — divergence against a dead book proves nothing.

## Wiring instructions (deferred — nothing is wired yet)

All hooks live in `services/arb-solver/src/index.ts`. Four touch points:

```ts
import { IdentitySentinel, buildWatchPairs, SentinelSink } from './sentinel/index.js';

let sentinel: IdentitySentinel | null = null;
const sentinelSink = new SentinelSink({
  jsonlPath: process.env.SENTINEL_JSONL ?? 'data/exports/sentinel-alerts.jsonl',
});
```

1. **Registry — inside `loadGraph()`** (and therefore on every `reloadGraph()`):
   the loaded `ConstraintGraph` is currently a local in `loadGraph()`; build the
   pairs right after `loadConstraintGraph(...)` returns:

   ```ts
   sentinel = new IdentitySentinel(buildWatchPairs(graph), {}, sentinelSink);
   ```

   Rebuilding on reload resets in-flight episodes — acceptable (graph reloads
   are rare; a stable pair re-enters PENDING within one window). Optionally
   pass `marketTitles` (one read-only `SELECT id, title FROM markets WHERE id =
   ANY($1)` over the watched ids) for human-readable labels; without it, labels
   fall back to `canonical_subject [shape value] @date`.

2. **Pump — inside the existing `clobManager.onPriceUpdate(...)` callback**,
   BEFORE the `if (!changed) return;` CDC short-circuit (the sentinel needs
   every update as its activity signal, including no-op TOB churn):

   ```ts
   clobManager.onPriceUpdate((update) => {
     if (update.outcome !== 'no') sentinel?.pump(update);  // YES-book only
     const changed = priceCache.update(update);
     if (!changed) return;
     ...
   ```

   `PriceUpdate` is structurally a `SentinelTick` (`marketId`, `bestBid`,
   `bestAsk`, `timestamp`) — no adapter needed. The `outcome !== 'no'` guard
   matters only if a subscription ever targets a NO-side book (Polymarket has
   one book per `clobTokenIds[i]`); spread math assumes pYES.

3. **Staleness — mirror every `priceCache.markStaleByIds(ids)`** (the
   resolution poll at step 4c and `handleResolutionEvent`):

   ```ts
   sentinel?.markStale(ids, Date.now());
   ```

4. **Sweep + summary — one new interval** next to the price-persist interval
   (this is the only place wall time enters):

   ```ts
   setInterval(() => {
     sentinel?.sweep(Date.now());
     const s = sentinel?.summary(10);
     if (s && s.byVerdict['suspect-identity'] > 0) {
       log.warn(`sentinel: ${s.byVerdict['suspect-identity']} active identity suspects`, s.topSuspects.map(i => i.pairId));
     }
   }, 60_000);
   ```

Scale check (run #230 DB, loader liveness predicates applied — probe
`data/exports/sentinel-pair-scale-probe.ts`): **3,876 watch pairs** (630
equiv-edge + 3,246 member-fungibility; 98% cross-platform), built in 24 ms.
The raw counts (2,983 equiv edges / 6,987 multi-platform questions) shrink
because the loader drops expired/archived members. Per-tick cost is O(pairs
watching that market) — for 1×1 pairs that is 1–2 monitor evaluations per
update. Mutex pairs are opt-in (`includeMutexEdges`, +6,574 pairs): the
loader's coarse `edge_type='mutual_exclusion'` also covers exact-score
mutexes — enable selectively or post-filter the pair list.

## What an operator does with an alert

Output channels: in-memory ring (`sentinel.sink.recent(n)`), JSONL stream
(one `ReviewItem` per line, promotable to a DB table by a future migration),
log lines (WARN for suspects), and `sentinel.summary(n).topSuspects`.

**`suspect-identity`** — review the equivalence assertion, not the prices:

1. The `ReviewItem` carries `edgeId` / `questionIds` / member market ids +
   titles. Pull the assertion:
   `SELECT * FROM implication_edges WHERE id = $edgeId;` plus the two
   questions' member markets and their `llm_market_normalizations` rows.
2. Compare resolution semantics across the legs (the Gebele & Matthes
   dimensions): reference source/oracle, temporal scope, exception rules —
   the famous miss is Kalshi NYC-temp (Central Park) vs PM (LaGuardia):
   textually near-identical, semantically different. A `member-fungibility`
   suspect means a Stage-2/3 question MERGE is wrong, not an edge.
3. If the assertion is wrong, the fix locus is **Stage-1/Stage-3 in the
   pipeline**: most observed false-equiv classes share
   the "Stage-1 leaves the discriminator in the title, not a gated field" root.
   Fix the handler/gate so the rebuild can't recreate the bad edge — do NOT
   hand-archive the edge as the "fix" (one-off DB surgery is wiped by the next
   `RESTART IDENTITY` rebuild; fixes must be pipeline paths).
4. If the assertion is RIGHT and books are deep on both sides — that is not a
   false positive, that is an arb the LP should already see (mutex suspects
   especially); cross-check `arbitrage_opportunities` for the cluster.

**`segmentation-latency`** — not an identity bug. Oscillating/converging
spread = limits-of-arbitrage friction (Krause's regulatory-segmentation
spreads; expected to compress as PM's US rollout proceeds). Useful as strategy
telemetry, not as a pipeline defect.

**`liveness`** — feed health, not identity: one leg's book is dead (no
updates / stale flag). Check the platform adapter, subscription, and the
quote-age TTL before reading anything semantic into the spread.

## Caveats

- **Latent until the CLOB feed runs.** The DB is structure-only today
  (memory: pipeline-liveness-state); the sentinel produces nothing without
  live `onPriceUpdate` traffic. It is wired-up-ready, not running.
- **Update count ≈ activity, not volume.** `PriceUpdate` has no trade volume;
  book-update cadence is the proxy. A market-maker bot re-quoting a dead
  market can look "active" — the post-spike fast path (which requires an
  actual price MOVE) is the higher-precision channel.
- **Mid-price default.** `|mid_a − mid_b|` flags non-monetizable
  disagreement on wide books too; flip `useCrossablePrices` for the
  execution-aware metric once books are live and depths are real.
- **Registry sees what the solver sees**: the loader filters
  `archived_at IS NULL`, `confidence ≥ minEdgeConfidence`, open members only.
  Equivalences the pipeline never asserted are invisible — this detects false
  POSITIVES, not recall misses (that's U6 resolved-outcome regression).
