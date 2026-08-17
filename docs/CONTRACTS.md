# Platform contracts

This is the **spec** that every platform implementation must fulfill. Tests
in `*.test.ts` files next to the contracts enforce it; this doc explains
*why* each clause exists so a future-you (or a new platform integration) can
reason about edge cases.

When the contract changes, update **this doc, the tests, and the
implementations together** — never just two of three.

---

## 1. `Scraper` (REST market discovery)

Defined in [`services/ingestion/src/scrapers/base.ts`](../services/ingestion/src/scrapers/base.ts).

```ts
interface Scraper {
  readonly platform: Platform;
  readonly db: ScraperDb;            // connect / disconnect
  scrapeActive(): Promise<unknown>;  // per-platform return type
}
```

### Required behavior

1. **`platform`** is one of the canonical `Platform` literals
   (`'kalshi' | 'limitless' | 'polymarket' | 'predict'`). It must match the
   string written to `markets.platform` by this scraper's persistence
   layer.

2. **`db.connect()` is idempotent.** Calling it more than once with the
   same instance does not throw and does not open a second pool. After the
   first successful call, `db.isAvailable?.()` (if exposed) must return
   `true`.

3. **`db.disconnect()` releases the pool.** After `disconnect`, subsequent
   queries via `requirePool()`-style helpers must throw. (Implementation
   detail: today this calls the process-wide `endPool()` because all
   scrapers share one pool. A caller that disconnects one scraper while
   another is active is breaking the contract — currently not enforced at
   runtime, but tests must not depend on per-scraper isolated pools.)

4. **`scrapeActive()` is idempotent in its DB effect.** Calling it twice
   in a row produces the same rows in `<platform>_markets` (modulo the
   `db_updated_at` timestamp). It uses `bulkUpsert` on the platform's
   stable primary key (`ticker`, `condition_id`, `slug`, `id`).

5. **`scrapeActive()` return type is intentionally per-platform.** The
   interface specifies `Promise<unknown>` because the four platforms emit
   different summary shapes (`{totalEvents,totalMarkets}` for Kalshi /
   Polymarket, `{totalCategoriesSaved,totalMarketsSaved}` for Predict,
   `number` for Limitless). Callers that need uniform telemetry must do
   their own narrowing. **Do not** invent a synthetic uniform shape — the
   asymmetry reflects real per-platform output and forcing a fake
   uniformity hides bugs.

6. **No live API call in module top-level.** Every scraper module must be
   safe to `import` without network access. API calls happen inside
   `scrapeActive` and friends, never at import time.

### Adding a new platform

A new platform is conformant iff:
- it adds the literal to the `Platform` union in `@arb/types`,
- it implements `Scraper` and exports `export const scraper: Scraper = { … }`,
- it is registered in [`run-all.ts`](../services/ingestion/src/scrapers/run-all.ts) `SCRAPERS` array,
- it adds a `<platform>_markets` table to `init.sql`,
- all `_contract.test.ts` cases pass for it without modification.

---

## 2. `BaseScraperPostgresService` (persistence)

Defined in [`services/ingestion/src/scrapers/base-postgres.ts`](../services/ingestion/src/scrapers/base-postgres.ts).

### Required behavior of subclasses

1. **`label`** matches the `platform` literal of the owning scraper.
2. **`saveMarkets(markets: T[]): Promise<number>`** returns the count of
   rows touched by the upsert. `0` if input is empty. Must call
   `requirePool()` so missing-pool faults surface as a thrown error
   rather than silently scraping nothing. (All 4 platforms now share
   this contract; the prior Predict soft-fail variant was removed.)
3. **`saveEvents(events: T[]): Promise<number>`** — same shape; optional
   if the platform has no event concept (Limitless).
4. **All persistence is `bulkUpsert` on the platform-stable primary key.**
   Never `INSERT` without conflict handling.

### Optional behavior

- Read helpers (`getActiveMarkets`, `getKnownEventTickers`, etc.) are
  per-platform. They are NOT part of the `Scraper` interface and do not
  participate in contract tests, but they should be typed (no `any[]`
  return).

---

## 3. `ClobAdapter` (real-time price + resolution stream)

Defined in [`services/arb-solver/src/clob/adapters/base.ts`](../services/arb-solver/src/clob/adapters/base.ts).

```ts
interface ClobAdapter {
  readonly platform: Platform;
  start(markets: MarketSubscription[]): Promise<void>;
  onPriceUpdate(cb: (u: PriceUpdate) => void): void;
  onMarketResolved(cb: (e: ResolutionEvent) => void): void;
  subscribe(markets: MarketSubscription[]): Promise<void>;
  unsubscribe(marketIds: string[]): Promise<void>;
  stop(): Promise<void>;
}
```

### Required behavior

1. **`platform`** is a canonical `Platform` literal and matches the
   `platform` field of every `PriceUpdate` and `ResolutionEvent` this
   adapter emits.

2. **`start()` is idempotent.** Two consecutive `start()` calls do not
   open two connections; the second returns successfully without
   re-subscribing.

3. **`stop()` is safe after `start()` failed.** A caller that catches a
   `start()` error must be able to call `stop()` for cleanup without
   throwing.

4. **`onPriceUpdate` / `onMarketResolved` are fan-out.** Registering N
   callbacks must result in N invocations per event. Callbacks must not
   throw (the adapter should not crash if a callback throws, but this is
   currently not enforced).

5. **`subscribe()` and `unsubscribe()` are idempotent per-market.**
   Subscribing a market that's already subscribed is a no-op. Unsubscribing
   an unknown market does not throw.

6. **`ResolutionEvent.winningOutcome` is `null` when ambiguous.** Never a
   default string. The arb-solver discriminates `null` from any real
   value and re-checks `null` cases via the REST resolution monitor.

7. **`ResolutionEvent.platformId`** is the same identifier used by the
   `markets.platform_id` column for this platform. Cross-referencing must
   work without normalization.

### Adding a new platform CLOB adapter

A new adapter is conformant iff:
- it extends `BaseClobAdapter`,
- it sets `readonly platform = '<platform>'`,
- it calls `this.emit(update)` for every price tick and
  `this.emitResolution(event)` for every settlement push,
- all `adapters/_contract.test.ts` cases pass for it without modification.

---

## 4. Resolution write semantics

Defined in [`services/ingestion/src/lifecycle/resolution-write.ts`](../services/ingestion/src/lifecycle/resolution-write.ts).

`writeResolution()` returns one of four outcomes:

| Outcome              | Pre-state                         | Post-state                                |
|----------------------|-----------------------------------|-------------------------------------------|
| `'created'`          | row exists, `resolved_at IS NULL` | `resolved_at`, `winning_outcome` filled   |
| `'amended'`          | row exists, `resolved_at` set, `winning_outcome IS NULL` | `winning_outcome` filled, `resolved_at` unchanged |
| `'already_resolved'` | row exists, both fields set       | unchanged                                 |
| `'not_found'`        | no row for `(platform, platform_id)` | unchanged                              |

Idempotency rules:
- `resolved_at` is **never** overwritten once set. Earlier (more
  accurate) timestamps win via `COALESCE(resolved_at, $2)`.
- `winning_outcome` is **never** overwritten by `NULL`. Same `COALESCE`
  pattern.
- The pair `(platform, platform_id)` is the natural key — every writer
  must pass both.

`writeAndPublishResolution()` publishes a `markets/resolved` event on
both `'created'` and `'amended'` outcomes (with an `amended:true` flag in
the latter case so subscribers can deduplicate). Test coverage must
include both branches.

---

## 5. Stage 1 shape×temporal pairing

See [`services/pipeline/src/stage1-normalize/shape-temporal-validation.ts`](../services/pipeline/src/stage1-normalize/shape-temporal-validation.ts).

A single map — `SHAPE_TEMPORAL_VALID` — is the source of truth for both
the deterministic template engine and the LLM normalizer. It reflects
what templates actually emit *and* what is semantically defensible:
e.g. `monotonic_threshold + during_period` for sports O/U totals, and
`binary_event + on_date` for crypto candle direction.

- `warnShapePair()` is a runtime guard for the deterministic templates.
  Anything outside the map logs a warning at emission time (does NOT
  throw — surfacing regressions is enough).
- `correctLLMTemporal()` is the LLM-output sanity check. Pairs in the
  map pass through unchanged; pairs outside fall back to the canonical
  default for the shape (see `DEFAULT_TEMPORAL`). Deterministic
  templates bypass it entirely.

The pairing table in `packages/llm/prompts/extraction/system.md` must
agree with the map. Tests in `shape-temporal-validation.test.ts` pin
both surfaces against the same set.

---

## 6. KB taxonomy hierarchy

See [`services/pipeline/src/db/entity-registry.ts`](../services/pipeline/src/db/entity-registry.ts).

`known_entities` rows form a strict hierarchy:

```
domain_category (column, enum)     ← level 0: ('sports','crypto','finance','politics','entertainment','other')
  └─ sport_canonical (column,       ← level 1: 'sport'-typed row's canonical
        derived from metadata)         appears in level-2/3 metadata
       └─ league_canonical (column,  ← level 2: 'league'-typed row's canonical
             derived from metadata)     appears in level-3 metadata
            └─ team / person / asset / event_name  ← level 3
```

**Invariants enforced by health checks** (`db/health-checks.ts`):

| Check | Invariant |
|-------|-----------|
| H4 | `domain_category` ∈ the 6 allowed values |
| H6 | Every non-null `sport_canonical` references an existing `type='sport'` row |
| H7 | Every non-null `league_canonical` references an existing `type='league'` row |
| H8 | `type` ∈ `ENTITY_TYPES` from `@arb/types` |
| H9 | Sports-domain teams/persons have `sport_canonical` set |
| H10 | Typed FK columns (`league_id`/`competition_id`/`resolution_provider_id`) point at rows of the matching `type` |

**Esports umbrella ↔ specific-game** (a level-1 caveat): the KB seeds the
umbrella `esports` and the specific games (`dota 2`, `cs2`, `league of
legends`, `valorant`, `rocket league`, `starcraft 2`, `call of duty`,
`rainbow six`, `overwatch 2`) as peer `type='sport'` rows.
[`sport-hierarchy.ts`](../services/pipeline/src/db/entity/sport-hierarchy.ts)
declares the umbrella↔child relation in one place. The resolver paths
([`register.ts`](../services/pipeline/src/db/entity/register.ts) +
[`infer-entity-scope.ts`](../services/pipeline/src/stage1-normalize/infer-entity-scope.ts))
treat the pair as compatible — same team across platforms with different
sport granularity unifies, and `sport_canonical='esports'` is upgraded to
the specific game when one becomes known. See
[`entity-scope-resolution.md`](./entity-scope-resolution.md#esports-umbrella--specific-game-hierarchy)
for the full rationale.

**Wiring**:

- `resolveTaxonomyCanonical(candidate, kind)` — alias/canonical lookup (with
  hyphen/underscore tolerance) returns the level-1 canonical form. Wired
  into `entity-enrichment/worker.ts:prepareEnrichment` so every new
  enrichment normalises `sport_canonical` / `league_canonical` against
  the KB before persistence.
- `sportResolver.resolve(...)` / `leagueResolver.resolve(...)` — the unified
  level-1 INSERT-or-MERGE path. The worker calls these with the
  taxonomy-flavoured `ResolveOptions` (`aliases`, `lowercaseCanonical`,
  `initialEnrichmentStatus: 'enriched'`, `forceSportsDomain`) when the
  LLM proposes a new sport/league. For a new league, the worker passes
  the resolved parent sport via `extraMetadata.sport_canonical` so the
  level-1 row inherits its parent.
- LLM prompt (`packages/llm/prompts/entity_enrichment/system.md`) receives
  `known_sports` and `known_leagues` lists per batch and is **required**
  to either pick an existing canonical or propose a new one *plus aliases*
  *plus parent sport*. Schema mandates this; system.md repeats it with
  examples.

**Three-source schema drift**: every LLM task has its schema defined in
three places (runtime `RUNTIME_SCHEMAS`, on-disk `schema.json`, and the
generator `build-schemas.ts`). The runtime version is canonical
(`prompt-loader.ts:30` precedence). Parity is enforced by
`packages/llm/src/schemas.test.ts` across all three tasks.

---

## What we deliberately do NOT contract-test

- **LLM output content.** Non-deterministic, expensive. We test the
  *schema* of responses and the *correction* logic on synthetic inputs.
- **Live API responses.** Fixtured into `__fixtures__/*.json` per
  platform; tests run against the fixture.
- **End-to-end pipeline runs.** Too slow, too flaky; the unit + contract
  layer must be enough.
- **DB state from a running system.** Any test that needs DB state must
  set it up synthetically inside the test, never read live data.
