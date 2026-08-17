# pipeline/src/stage1-normalize/

Stage 1: deterministic market enrichment. Each market that enters the `stage1_queue` runs through: regex featurisation → deterministic templates + KB resolution (T1 alias / T2 embedding / T3 create) → embedding. The event-centric rewire made Stage 1 deterministic-only — BOTH the full-run driver (`runStage1()` in `index.ts`) AND the daemon worker (`worker.ts`) — by removing the per-market/per-event LLM normalization pass (`llm-normalizer.ts` deleted). Template-miss markets carry no normalization row and are absorbed by the event layer at Stage 3b leg-mapping. The only LLM adjacent to Stage 1 is async entity-enrichment (metadata for new KB entities), gated by `ENTITY_ENRICHMENT_SKIP`.

## Files

| File | Role |
|------|------|
| `index.ts` | **Stage 1 orchestrator.** Drains `stage1_queue` in batches; applies sub-stages 1a–1f in order; enqueues completed markets to `stage23_queue`. Handles enrichment flush gate (calls entity enrichment workers every N new entities). Also hosts `featurizeMarket` and its module-private title-normalisation helpers (`normalizeTitle`, `extractWordBag`). |
| `worker.ts` | **Daemon worker.** Wraps `index.ts` logic for continuous daemon-mode operation; drains `stage1_queue` indefinitely using bounded concurrency. |
| `entity-extractor.ts` | `extractDates(text, source)`, `extractNumbers(text)`, `extractCurrencies(text)` — regex-based feature extraction. Called by `featurizeMarket` to fill `MarketFeatures` fields. |
| `hierarchy-detector.ts` | `detectHierarchy(market)` → detects condition signals (e.g., "if X then Y", "given that…") → sets `condition_signal` flags in `market_features`. |
| `outcome-space.ts` | `deriveOutcomeSpace(...)` → derives the outcome combination space of a multi-outcome market; used to build categorical outcome sets. |
| `text-deterministic.ts` | `normalizeTextDeterministic()` → unified candidate fetch for all platforms. Routes Kalshi rows to `tryNormalizeKalshiRow()` first; remaining rows run through `tryNormalizeText()` / `matchTemplate()`, the generic letter-labelled regex templates (E/F/G/H/J/…). Bulk-writes to `llm_market_normalizations`. |
| `emit-condition.ts` | The single validated emission door every handler's condition tuple passes through. An archetype fixes `condition_shape`, the legal temporal set, the direction class and the value arity, so a handler that picks an archetype cannot also pick a shape. Rejects (warn-and-null) rather than repairing — unshaped beats unsound. |
| `kalshi-deterministic.ts` | `tryNormalizeKalshiRow(row)` — four sub-passes in priority order: (1) typed-strike & custom-strike price ladders (BTC/ETH/SOL/S&P/Gold/DOGE), (2) MVE parlay series (KXMVESPORTS / KXMVECROSS — consumes `mve_selected_legs` structured array directly, no title regex), (3) player-stat props (KXNBAPTS / KXMLBHR / KXNHLGOAL / …) — emits `canonical_event = \`${canonical_subject} ${unit}\`` (e.g. `LeBron James points`), matching Polymarket Template E's deriveCanonicalEventCore output so the two platforms share a canonical_key on (player, stat, date, threshold). Routes the stat unit through `normalizePlayerStatUnit` for byte-equal alignment with Polymarket. (4) categorical "Who will win?" markets. All single-leg passes emit `leg_signatures: ['yes\|<ticker>']` via the `buildSingleLegSignature` helper; the parlay pass uses `buildParlayLegSignatures(legs)`. Both helpers reject sentinel placeholders (`'undefined'`, `'null'`, `''`) and return null rather than emit a poisoned signature — see [Sentinel guards](#sentinel-guards) below. |
| `platform-groups.ts` | `computePlatformGroup(...)` → the platform-specific outcome grouping key (native `platform_events` grouping hint); `extractPlatformGroups()` runs it over the market table. |
| `embedder.ts` | `embedMarkets(markets)` → calls the embedding model (configured in `config.embedding`) to generate semantic vectors. These market embeddings roll up into the event embeddings that feed the cross-platform event ANN (Stage 3a). Batch-processes to respect API limits. |
| `event-date-extractor.ts` | Deterministic *event*-date extractor — pulls the underlying-event timestamp from the most reliable platform signal (slug / Kalshi ticker / parlay legs / title) and only falls back to `markets.end_date` when none carry a date. `end_date` is the resolution time and is distorted by per-platform settlement policy, so cross-platform event matching needs this event time instead. |
| `weather-stations.ts` | Shared weather-station name normalization used by every weather normalizer — collapses Polymarket/Kalshi station text to one byte-equal `canonical_subject` ("Intl"→"International", drops trailing " Station"/", &lt;state&gt;", collapses whitespace). No hardcoded city→station map. |
| `infer-entity-scope.ts` | Structural sport/league inference at entity-registration time — stamps every team/person/asset entity with `sport_canonical` (and `league_canonical` where known) so the scope-aware T1/T2 KB resolver can disambiguate same-name entities and participant-overlap matches across platforms. KB-driven (valid leagues/sports come from `known_entities`). |
| `shape-temporal-validation.ts` | Single source of truth for valid `(condition_shape × temporal_semantics)` pairings across both deterministic templates and LLM extractions. `warnShapePair` is a runtime guard that logs a warning when a write site emits a pairing outside the allowed set. |
| `event-name-normalizer.ts` | `normalizeEventNoun`, `normalizeFixtureCanonicalEvent`, `normalizeOutcomeLabel`, `normalizePlayerStatUnit`, `yearFromIso`, and the **shared `deriveCanonicalEventCore`** helper used by `text-deterministic.ts` and `db/entity/backfill.ts`. Centralised so every write site (template, Stage 1f rewrite) produces the same canonical_event from the same KB-resolved inputs. Exports `EVENT_ANCHORED_KINDS` (championship_winner / election_outcome_winner / stage_advance — the kinds that opt into noun normalization with a year hint). `normalizePlayerStatUnit` is the single source of truth for stat-unit canonicalisation — Polymarket Template E and Kalshi Pass 3 both route through it so `points`/`home_runs`/`threes`/`stolen_bases` agree byte-for-byte (closes a prior plural/singular split that broke cross-platform `value_unit`, `condition_value`, AND `canonical_event`). |
| `unit-vocab.ts` | **Shared `value_unit` canonicalization (UNIT_VOCAB).** `canonicalUnit(rawUnit, ctx)` maps every emitted unit to ONE canonical form (count nouns plural; mass/marker units + currencies kept as-is; the match_spread goals-vs-points fork remapped to the sport's natural unit when sport/league ctx is known, NEVER guessed). Enforced at the two norm-assembly chokepoints: the `tryNormalizeText` build site (with structural-scope → KB-subject-sport fallback) and the `tryNormalizeKalshiRow` exit wrapper (`canonicalizeNormUnit`, which suffix-rewrites `condition_value` / player-prop `canonical_event` in lockstep). Genuinely distinct ladder units (tennis `sets`≠`games`, esports `maps`≠`rounds`, NBA/NHL series `games`) stay distinct — Stage-4's strict `value_unit IS NOT DISTINCT FROM` gates are intentionally untouched. |

## Sub-stage pipeline (live taxonomy)

Sub-stage labels as they appear in the run logs, sourced from `run.ts`,
`run-ingest-backfills.ts` (the shared ingest-backfill ladder, verbatim-shared
with daemon Loop 2) and `run-event-graph.ts`. Stage 0/0a and 1a–1h are
per-market / per-entity; Stage 2a–4 operate on the event graph. The live 2a/2b
are **deterministic** — the LLM `grouping_type` classify (2a-LLM) and LLM cluster
reconstruction (2b-LLM) are deferred enhancements (see `run-event-graph.ts`).

| Sub-stage | Entry point | Role / output |
|---|---|---|
| **0a** | `db/seed-entity-kb.ts` → `seedEntityKB()` | Seed/refresh the entity KB — structural sports/leagues/providers + team→league links, crypto assets, politics overrides. Re-applied (additive) each tick inside the ingest-backfill ladder. |
| **0** | `db/sync.ts` → `runSync()` | Sync scraper tables → pipeline `markets` table. |
| **1a** | `index.ts` → `featurizeMarket()` (via `entity-extractor.ts`) | Regex featurisation → `market_features` row (dates, numbers, currencies, named entities, condition signals). |
| **1b** | `text-deterministic.ts` + `kalshi-deterministic.ts` | Deterministic templates + KB resolution (T1 alias / T2 embedding / T3 create) → `llm_market_normalizations`. Template-miss ⇒ no row, deferred to the event layer at Stage 3b. |
| **1c** | `embedder.ts` → `embedMarkets()` | Embed markets → `markets.embedding` column (no `market_embeddings` table). |
| **1d** | `run-ingest-backfills.ts` → `enrichEntityMetadata()` | Seed KB-entity metadata from scraper category/tag signals; AUD-37 watermark-gated full-scan of `market_entity_links`. |
| **1e** | `entity-enrichment/index.ts` → `runEntityEnrichmentWorkers()` | LLM-driven entity enrichment (async queue drain) for KB entities the deterministic path left empty + `enrichment_status='pending'` rows; gated by `ENTITY_ENRICHMENT_SKIP`. |
| **1f** | `db/entity/backfill.ts` → `backfillSubjectsViaKB()` | KB-rewrite chokepoint — propagate canonical renames/merges back into every entity-name column (see [Stage 1f](#stage-1f--kb-rewrite-single-chokepoint-for-everything-is-kb-resolved) below). |
| **1g** | `run-ingest-backfills.ts` → `backfillSettlementInstrument()` | Stamp the `settlement_instrument` fact on `price_threshold` rows (shape-bridge cross-platform gate, migration 075); idempotent recompute-from-raw. |
| **1h** | `resolution-oracle.ts` → `runResolutionOraclePass()` + `backfillResolutionScope()` | Fill `resolution_source` (settlement authority, oracle parse — write-only, mig 068) and backfill `resolution_scope` for rows whose sync pre-dates the detector. |
| **2a** | `stage2-events/resolve-event-identity.ts` + `classify-grouping.ts` | Native-first (LLM-free) entity resolution at the event grain + classify `grouping_type` (`threshold_series` / `categorical_exclusive` / `bundle_nonexclusive`) from child shapes. |
| **2b** | `stage2-events/reconstruct-events.ts` | Singleton-wrap orphan markets into `platform_events` for platforms with no native grouping, so they enter the uniform 2c→3a→3b→4 path. |
| **2c** | `stage2-events/embed-events.ts` → `embedAllPlatformEvents()` | Embed every `platform_event` (cache-backed) → event embeddings that feed the cross-platform ANN. |
| **3a** | `stage3-events/ann-candidates.ts` | Cross-platform event ANN candidate-pair discovery over event embeddings → `stage3_event_candidates`. |
| **3b** | `stage3-events/confirm-deterministic.ts` (3b-pre) → `llm-event-match.ts` | Deterministic pair confirmation, then LLM `same_event` judgment over the residual ANN candidates (`STAGE3_SKIP_LLM`). |
| **4** | `stage4-events/finalize.ts` (+ `outcome-set-certifier.ts`) | Finalize the event graph — certify outcome sets/nodes and build the structural edges (threshold / mutex / equivalence / implication). |

## Kalshi trailing-9 strike quantization

Kalshi expresses "strictly above X" as `floor_strike = X − 0.01` (e.g. `71999.99` for ">= $72000") and "strictly below X" as `cap_strike = X − 0.01` (or `X − 0.0001` for index series like S&P 500). Since the underlying assets trade in $0.01 ticks, these are identical outcome sets to Polymarket's / Predict's `>=72000` / `<=72000` notation.

`kalshi-deterministic.ts` Pass 1 calls `quantizeKalshiStrike(value)` on both `floor_strike` and `cap_strike` before they become `value_primary` / `value_secondary`. The helper wraps `isKalshiTrailingNine()` from `@arb/types` and rounds to the integer ceiling only when the fractional part is `≈ 0.99` or `≈ 0.9999` (intentionally narrow — sports O/U lines like 22.5 and legitimate fractional crypto prices pass through unchanged).

Effect: Kalshi `>71999.99` and Polymarket `>=72000` now share the same `value_primary`, `condition_value`, and ultimately the same `canonical_event`, so the event matcher treats them as the same outcome instead of two near-equivalent legs. Without this they would differ by 0.01 and risk being split into separate legs.

The same quantization is also applied in `text-deterministic.ts` for the INDEX_VERBOSE pattern (see [text-deterministic.ts](text-deterministic.ts) calls to `isKalshiTrailingNine`). All Kalshi normalisation paths produce identical canonical values for the same outcome set.

Note: the `(m, e)` mantissa-exponent storage ([db migration 026](../../docker/migrations/026_value_mantissa_exp.sql)) currently decomposes whatever `value_primary` gets written via the generic `toME()`. After quantization Pass 1 writes the integer ceiling, so the stored `(m, e)` for `71999.99` is now `(72000, 0)` — matching Polymarket's representation bit-for-bit.

## Sentinel guards

`buildSingleLegSignature(platformTicker)` and `buildParlayLegSignatures(legs)` in `kalshi-deterministic.ts` are the only paths that write to `llm_market_normalizations.leg_signatures`. Both return `null` (column stays NULL) when:
- the input is missing / falsy, OR
- the input stringifies to `'undefined'`, `'null'`, or `''`, OR
- (parlay only) a leg's `side` is not literally `'yes'` / `'no'`.

A NULL signature is simply absent — downstream consumers skip the market rather than acting on it. A sentinel string in the signature would instead collapse every market carrying that sentinel into one equivalence pool under set ops — which is exactly what happened before the guards existed: 7,571 markets with `['yes\|undefined']` produced 244K bogus equivalence edges + 678K transitive derivatives in a single run of the old rule engine. (That leg-set-implication rule engine has since been retired in the event-centric rewire, but the sentinel hazard is intrinsic to the column, so the guards still matter.) Anytime you add a new emission site for `leg_signatures`, route it through these helpers.

## Stage 1f — KB rewrite (single chokepoint for "everything is KB-resolved")

`db/entity/backfill.ts:backfillSubjectsViaKB` is the single chokepoint that propagates KB renames (from Stage 1e enrichment swaps + merges) back into every text column that stores an entity name:

- `llm_market_normalizations.canonical_subject`
- `llm_market_normalizations.participants[]` (rewritten in BOTH subject and opponent positions — `array && oldPhrases` filter catches markets where the renamed entity is only an opponent)
- `llm_market_normalizations.canonical_event` (rebuilt via `deriveCanonicalEventCore` so sports H2H markets get the alphabetized "<a> vs <b>" of the *new* KB names)
- `llm_market_normalizations.resolved_entities[].canonical` (JSONB)
- `platform_events.canonical_subject` / `participants[]` / `canonical_event` (same rewrite rules; scope derived from the modal child market's league_id). Required so the event embeddings + cross-platform event matcher (Stage 3a ANN → Stage 3b LLM) keep seeing consistent canonical names after a KB merge.

Scope (sport, league) is part of the rename map key — `(phrase, domain, sport, league) → resolved`. Two phrases that collide across sports ("Houston" basketball vs soccer) resolve to different canonicals and don't cross-contaminate.

For structural-rename propagation INSIDE `known_entities` (a league/competition/sport rename → other entities' `metadata.league_canonical` / `sport_canonical`), see [`entity-enrichment/doc.md`](../entity-enrichment/doc.md) — that's handled atomically inside `mergeKnownEntities` and `applyEnrichment`.

## condition_shape doctrine (the spec)

`condition_shape` describes the **YES-region over the price/metric PATH**, not the
grouping topology. The canonical meanings every handler MUST stamp by:

| shape | meaning | example |
|---|---|---|
| `monotonic_threshold` | **touch/latch**: YES iff the metric EVER crosses the bound before the deadline (path-dependent; once true, stays true) | "Will BTC **reach** $100k by July?", "Will X **dip to** $40?", "When will Y happen — before D?" |
| `point_in_time` | **snapshot half-line**: YES iff the value is above/below the bound AT one defined moment | "ETH above $2,300 **on May 13, 5PM ET**", "IPO **closing** market cap above $1B" |
| `range_snapshot` | **snapshot interior bucket**: value lands in [lo,hi] at the defined moment / for the period total | Kalshi price buckets at 5pm; "CPI lands at 3.x%" |
| `cumulative_deadline` | latch on an event count/state by a deadline | (rare; prefer monotonic_threshold) |
| `binary_event` | non-numeric proposition | "Will the bill pass?" |
| `categorical_outcome` | one slot of a mutually-exclusive outcome partition | "Winner: Team A" leg of an H2H/negRisk event |

Rules that follow from the doctrine (enforced in stage3/stage4 — see
`stage3-events/numeric-region.ts`):
1. **touch ≢ snapshot**: a monotonic_threshold leg NEVER merges/equates with a
   point_in_time / range_snapshot leg at the same bound — EXCEPT when the underlying
   metric is itself non-decreasing over the window (cumulative counts: tweets posted,
   goals scored, funds committed — `temporal_semantics='during_period'` count domains),
   where touch ≡ terminal and either stamp is semantically equal. Even there, stamp the
   SNAPSHOT shape (`range_snapshot` buckets + boundary direction arms) so families stay
   contract-uniform; an open-top "200+" arm in a count family may stay
   monotonic_threshold (equivalent), but new handlers should prefer `point_in_time`.
2. **"ladder-ness" is NOT shape**: whether rungs nest (stricter ⟹ looser) derives from
   `condition_direction` + values, never from stamping 'monotonic_threshold'. Do not
   use the shape field to mean "this family is a ladder, not categorical buckets" —
   that was the Template-AK bug ("IPO closing market cap above $X" stamped monotonic;
   PM stamps the same title point_in_time; 14 cross-ref ground-truth pairs split).
3. **Emission contract**: one market family ⇒ one (shape × temporal × direction ×
   unit) stamp across ALL platforms. `market_cross_refs` pairs are dual-listings of the
   SAME market — any normalization-field disagreement on a cross-ref pair is a Stage-1
   bug by definition (asserted by `scripts/soundness-regression-asserts.ts`).
4. Verbs: reach/hit/cross/break/top/exceed/surpass/dip-to/touch ⇒ touch semantics;
   close/closing/settle/at <time>/on <date> (with a snapshot strike source) ⇒ snapshot;
   "above/below" alone is AMBIGUOUS — resolve from the resolution source (a dated
   snapshot oracle ⇒ point_in_time; "at any point" rules ⇒ monotonic_threshold).

## condition_date doctrine — in-period deadlines

**The rule:** an "in &lt;year&gt;" / "in &lt;month&gt;" (and "by &lt;period&gt;")
deadline means the **LAST day of that period at 23:59**, in the timezone the
market's RULES list — **DEFAULT UTC** when unspecified. The STORAGE convention is
unchanged by this reading: stamps stay the **padded period-START ISO +
`condition_date_precision`** (`'2027-01-01'` + `'year'` means "in/by 2027" — the
P6(a) convention). The period-END interpretation lives entirely in **consumer
semantics**: comparisons happen at the COARSER of the two grains and orderings
follow bucket-END logic (`util/date-grain-sql.ts` — coarse-grain equality proves
sameness; strict coarse-key ordering is sound precisely *because* the real
deadline of a coarse "by &lt;bucket&gt;" stamp is the bucket END). Never fabricate a
period-end day stamp for a coarse phrase: a `<last-day>` + `'day'` stamp falsely
admits day-grain compares against genuine day-precision twins. **EXCEPTION
class:** an EXPLICIT "end of &lt;period&gt;" phrase stamped at DAY precision names a
specific calendar day and must stamp the period's actual LAST day ("end of
2026" → `2026-12-31`; "end of February 2028" → `2028-02-29`, leap-correct via
`util/condition-date.ts` `monthEndIso`). Deterministic embodiments: Template
AD's slug-month `pad:'end'` stamp (byte-merges with the Polymarket "hit__ by
end of &lt;month&gt;" twin family) and `parseLooseDate`'s explicit
"end of &lt;period&gt;" branch in `text-deterministic.ts`.

## Caveats
- `NEW_ENTITY_FLUSH_THRESHOLD`, `MARKETS_FLUSH_INTERVAL`, and `ENTITY_ENRICHMENT_SKIP` are read **once** in `config.ts` (`config.stage1.*`). The readers — `stage1-normalize/index.ts` and `run.ts` — all go through `config`. See [`services/duplicates.md`](../../../duplicates.md) item 6.
- Template matching is the ONLY Stage-1 normalization path (no LLM — event-centric rewire); template-miss markets get no row and are deferred to the event layer. If templates are wrong they produce silent misfires — audit `text-deterministic.ts` and `kalshi-deterministic.ts` regularly.
- Embedding model changes require a full re-embed of all markets; there is no incremental model-version tracking.
- The **KB category-histogram gate** (migration 029, [db/doc.md](../db/doc.md)) had a `findOrCreateEntity` integration fed only by the now-removed LLM normalizer's `result.category_unified`. The deterministic templates (`kalshi-deterministic.ts`, `text-deterministic.ts`) pass `null`, so they feed the histogram via the unconditional increment only — the gate's findOrCreateEntity path is currently dormant.
- `embedder.ts` skips parlay markets by default (`config.embedding.skipParlayMarkets` = true unless `EMBED_PARLAYS=1`). Parlay titles compose uniquely and have no cross-platform ANN-match potential — they're paired structurally via the parlay-signature hash key in `kalshi-deterministic.ts`. Cuts embedding cost ~5x at the current data shape (parlays ≈ 83% of all markets).
- `embedder.ts` + `packages/llm/src/util/retry.ts`: 429 backoff now reads the `try again in Xms/Xs` phrase from the response body (precision-first, falls back to the seconds-rounded `Retry-After` header). 429s get a separate retry budget (20 attempts, default) so steady TPM-saturation chatter doesn't burn through the 5-attempt budget reserved for 5xx / network errors.
