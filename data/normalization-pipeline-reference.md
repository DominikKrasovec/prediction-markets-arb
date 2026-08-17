# Normalization pipeline — findings, caveats, and false-positive log

*Living reference doc. 2026-05-24 initial write, updated as work progresses. Consolidates investigation across [edge-investigation-2026-05-24.md](edge-investigation-2026-05-24.md), [cross-platform-audit-2026-05-24.md](cross-platform-audit-2026-05-24.md), and [audit-work-plan-2026-05-24.md](audit-work-plan-2026-05-24.md), plus everything learned during item-by-item implementation.*

This doc is the canonical place to look first before investigating cross-platform normalization, edge generation, or canonical_key issues. The other dated docs are the raw analysis; this one is the durable summary.

---

## 1. Core principles

These reshape how you should interpret every finding below.

### 1.1 Normalization is regex-first by design

Stage 1 LLM normalization is **intentionally skipped** to save cost. Pending rows in `stage1_queue.status='pending'` are markets where no deterministic handler yet matches — they are **not a backlog to drain**, they are a measurement of handler coverage gaps. The productive direction is always "add a deterministic handler for category X on platform Y", never "process the queue."

The team's goal: model as much as possible deterministically. The existing Kalshi-deterministic Stage 1 path already covers 97% of Kalshi sports markets without any LLM call ([kalshi-deterministic.ts](services/pipeline/src/stage1-normalize/kalshi-deterministic.ts)).

### 1.2 Cross-platform equivalence is expressed two ways

Both legitimate, both used:
- **Question-level merge** — both platforms' markets attach to the same `questions` row (multi-platform question). Happens when canonical_keys collide across platforms.
- **Edge-level equivalence** — separate questions linked by an `equivalence cross_platform` edge.

If you're auditing cross-platform reasoning, you must check both. "Zero crypto cross-platform edges" doesn't mean "no crypto cross-platform reasoning" — it means the matches happen at the question-merge layer instead.

### 1.3 canonical_key field 9 is `resolution_source`, not a path tag

The canonical_key is `subject|shape|direction|metric|value|unit|temporal|date|**resolution_source**|canonical_event|outcome_label` (per [questions.ts:126-133](services/pipeline/src/db/queries/questions.ts#L126-L133)).

When you see `Kalshi`, `text-deterministic-F`, `text-deterministic-T`, `text-deterministic-W` in field 9, those are **placeholder values written by handlers that didn't know the real source**. They are not platform tags or path tags. The fix is to populate them with the real data provider (Accuweather, NWS, CF Benchmarks, BLS, etc.), not to remove or normalize the field.

---

## 2. Top findings

### 2.1 The implication graph (~432k edges) is dominated by structural-grouping artifacts

- 73% of edges (315,778) are intra-outcome-set / intra-platform-event
- 99% of within-grouping edges come from two patterns: plain `mutual_exclusion` between categorical slots (229k) and `numeric_threshold strict_implication` between ladder buckets (86k)
- Only 27% (116,755) edges actually cross structural boundaries
- 95% of questions have zero edges; action concentrates in ~44k high-degree hubs (BTC, SOL, ETH, parties)

### 2.2 Cross-platform reach is tiny — and almost entirely football clubs

- 432,533 edges total
- 876 actually connect questions on different platforms (0.2%)
- 100% of those 876 are `event_category='sports'`
- 97.8% are polymarket↔predict (876 edges)
- Top subjects: FC Barcelona, Real Madrid, AC Milan, Hamburger SV, La Liga / Premier League / Bundesliga / Ligue 1 clubs
- Zero cross-platform edges for crypto, weather, election, economic, politics

### 2.3 Question merging IS happening for crypto — hidden in question rows, not edges

- 608 crypto questions are multi-platform (mostly BTC/ETH binary_event hourly candles across polymarket+predict)
- 66% of BTC binary_event questions merged poly↔predict
- These produce no inter-question edges because they ARE one question
- So "0 crypto cross-platform edges" understates the matching that's actually happening

### 2.4 The single biggest structural blocker

Field 9 placeholder resolution_sources (`Kalshi`, `text-deterministic-F`, etc.) prevent canonical_key collision across platforms. **It cascades from the fact that handlers haven't been written for each category × platform combination yet.** Each new handler that writes the real provider name unlocks cross-platform merging for its slice.

---

## 3. Caveats — things to remember when working

### 3.1 Where the data actually lives

- **`markets.raw` is NULL for Kalshi markets.** The typed_strike fields (`strike_type`, `floor_strike`, `cap_strike`, `expected_expiration_time`, `rules_primary`, `yes_sub_title`, `occurrence_datetime`) live in `kalshi_markets.raw`. Join on `kalshi_markets.ticker = markets.platform_id` to get them. Forgetting this leads to wrong "zero typed_strike" findings.
- **`category_unified` is on `markets`, not `llm_market_normalizations`.** When asking "does platform X have category Y markets?", filter `markets.category_unified='Y'` directly. Filtering on the lmn join silently drops unprocessed markets.
- **`platform_event_id` is populated for Kalshi weather markets** even without normalization (156 distinct platform_events for 909 weather markets). Structure exists upstream of Stage 1.

### 3.2 canonical_key construction subtleties

Reading [questions.ts:23-180](services/pipeline/src/db/queries/questions.ts#L23-L180):

- **Field 5 (cv_derived)** falls back to `value_primary` when `condition_value` is empty. This is what keeps two BTC point_in_time markets with different thresholds in distinct question buckets even when `condition_value` is unset.
- **Field 6 (vu_derived)** maps `USD`, `USDT`, and `NULL` all to empty string — Tether peg is treated as equivalent to USD for bucketing.
- **Field 8 (date)** is precision-aware:
  - `year`/`month` precision → date dropped (event-anchored merging takes over)
  - `minute`/`hour` precision → full ISO timestamp preserved
  - `day` or NULL → truncated to `YYYY-MM-DD`
  - **Implication**: two questions with same logical date but different precision (`day` vs `minute`) produce different canonical_keys. This explains many `near_equivalence` near-duplicates (12,340 / 12,352).
- **Field 10 (norm_ce)** normalizes canonical_event for price shapes — hardcoded to 'price range snapshot' (range_snapshot+price), 'candle direction' (point_in_time+price), 'price reaches threshold' (monotonic_threshold+price). For binary_event / categorical_outcome the LLM phrase is kept and matters.
- **Field 11 (outcome_label)** was added in migration 036 to keep Team-A-wins markets distinct from Draw markets on the same fixture.

### 3.3 KNOWN_SERIES_MAP semantics

The Kalshi-deterministic handler keys off `split_part(event_ticker, '-', 1)` and looks up the series prefix in `KNOWN_SERIES_MAP`. **It uses exact match first, then a prefix-scan fallback** so `KXBTCD`, `KXBTCY`, `KXBTCMON`, `KXBTCW` all resolve to the `KXBTC` entry. So you don't need explicit entries per time-window variant — one canonical entry per asset is usually enough.

Each entry sets: `subject`, `metric`, `unit`, `category` (UnifiedCategory), `resolutionSource`. **Always populate resolutionSource with the real provider** — that's what enables cross-platform merging.

### 3.4 Resolution_source is semantically load-bearing

Different resolution sources legitimately produce different question buckets. Kalshi crypto resolves via CF Benchmarks BRTI/ERTI (real-time index), Polymarket crypto may resolve via Coinbase or Binance. These can settle differently in edge cases (5-second windows around volatile prints). **Don't "fix" the resolution_source field by removing it — populate it correctly.**

Currently:
- Kalshi crypto (BTC/ETH/etc. in KNOWN_SERIES_MAP): `'CF Benchmarks'` ✓
- Kalshi sports / weather / economic / election: fallback `'Kalshi'` (placeholder, semantically wrong) ✗
- Polymarket via text-deterministic-F: `'text-deterministic-F'` (placeholder, semantically wrong) ✗

### 3.5 entity_relations graph is empty for sports persons

Of 806,333 distinct Kalshi sports subjects (mostly player names like "Yordan Alvarez"), **zero have `plays_for` rows in `entity_relations`**. The known_entities KB has 5,946 sports entities (92% with sport_canonical, 48% with league_canonical) but the relational graph between them isn't populated.

So you can't walk `person → plays_for → team → competes_in → league` to backfill `league_id`. The realistic substitute: derive league directly from Kalshi series prefix (`KXMLB*` → MLB, `KXNFL*` → NFL).

### 3.6 condition_date_precision is mandatory metadata

If a handler emits a date but doesn't set `condition_date_precision`, the canonical_key falls back to day-truncation. That breaks merging for any market expressed at higher precision (e.g., minute-precision crypto candles).

### 3.7 NULLS NOT DISTINCT on (canonical, sport, league) in known_entities

Migration on `known_entities` uses `UNIQUE NULLS NOT DISTINCT (canonical, sport_canonical, league_canonical)` so two entities with the same name in different sport/league pairs stay separate (Phoenix Suns vs Phoenix Mercury). Be careful when seeding entities — leaving sport/league NULL means "non-sport entity, only one per name allowed".

### 3.8 Cross-platform merges happen via canonical_key collision

If two markets across platforms hash to the same canonical_key, they merge into one question. **For this to happen, EVERY one of the 11 canonical_key fields must agree** (after the normalization rules in §3.2). The most common blockers:
- Field 9 (resolution_source) — see §3.4
- Field 10 (canonical_event wording) — "2028 us presidential election" ≠ "2028 presidential election"
- Field 5/6 (value/unit format) — Kalshi `>=86.25USD/t.oz` vs Polymarket `86.25` in title only
- Field 8 (date precision) — minute vs day

### 3.9 Multi-platform questions are NOT detected by joining `questions` to `markets`

A question's platform set is found by going through `question_members → markets`. The question table doesn't carry a platform field directly. Subqueries like:

```sql
(SELECT array_agg(DISTINCT m.platform ORDER BY m.platform)
 FROM question_members qm JOIN markets m ON m.id=qm.market_id
 WHERE qm.question_id=q.id)
```

are the canonical way to get platform list per question.

---

## 4. False positives — things I thought were bugs but weren't

Recording these so future investigations don't repeat the same mistakes.

### 4.1 ❌ "Kalshi has 0 weather markets"

**False.** Kalshi has 909 weather markets, all with `category_unified='weather'` and `platform_event_id` populated (156 distinct events). They have `canonical_subject=NULL` because no deterministic handler covers them yet. The mistake was looking at `llm_market_normalizations` rows instead of `markets` rows. Always filter on `markets.category_unified`, never on `lmn.*`, when asking "does platform X have category Y markets?"

### 4.2 ❌ "1,419 Kalshi sports markets are weather-titled (miscategorized)"

**False.** I title-grep'd for `%hurricane%` etc. and got 1,419 markets categorized as sports. Those are **multi-leg parlays** like "yes CAR Hurricanes, yes Rory McIlroy" — "CAR Hurricanes" is the **Carolina Hurricanes NHL team**, not weather. Title-keyword filtering is a noisy heuristic in a database with sports parlays. Always disambiguate by looking at full titles.

### 4.3 ❌ "Crypto naming is inconsistent across platforms"

**False.** BTC=BTC=BTC across Kalshi, Polymarket, Predict, Limitless. ETH/SOL/XRP/DOGE/HYPE/BNB all align. The cross-platform crypto reach problem is NOT naming — it's resolution_source (§3.4), shape encoding for some products, and the fact that some product types only exist on one platform.

### 4.4 ❌ "Election Dem/Rep cross-platform matching is broken"

**False, working as intended.** Democratic Party appears in 1,017 Kalshi + 514 Polymarket markets, none merged. But each refers to a different race (state, year, chamber, district). Kalshi state-level Senate races and Polymarket national presidential markets correctly stay distinct via `canonical_event` + `outcome_label`. The 9,940 election `near_equivalence` edges are intra-platform same-race near-duplicates, not failed cross-platform matches.

### 4.5 ❌ "Drain the Stage 1 LLM queue"

**Wrong direction.** The queue is intentionally not being drained — LLM normalization is skipped to save cost. The 92,520 pending rows are markets without a deterministic handler match, NOT a backlog. The fix is always "add a regex/pattern handler", never "process more LLM calls". See §1.1.

### 4.6 ❌ "near_equivalence cross_platform edges are failed cross-platform matches"

**False.** 99.7% (12,311 of 12,352) are SAME-platform near-duplicates (polymarket↔polymarket: 7,118; kalshi↔kalshi: 5,192). Only 41 actually bridge platforms. The label is misleading — `pattern='cross_platform'` marks edges produced by the cross-platform similarity matcher, not edges whose endpoints disagree on platform. These 12k same-platform near-equivalences are **canonical_key collisions due to date-precision drift** (e.g., 'minute' vs 'hour'), not cross-platform matching failures.

### 4.7 ❌ "Path tag in canonical_key field 9 is a structural bug"

**False, the field is `resolution_source`** (§1.3). It's semantically meaningful — different real resolution sources legitimately settle differently. The bug is that handlers without a known source write placeholders like `'Kalshi'` or `'text-deterministic-F'` into the slot. Fixing the placeholders (not removing the field) is the answer.

### 4.8 ❌ "Polymarket BTC `binary_event` is a threshold market without a populated threshold"

**False.** Polymarket BTC `binary_event` markets are **"Bitcoin Up or Down — May 10, 6:45AM-7:00AM ET"** — directional 5-minute candle markets ("will BTC close higher than open in this window"). They have no threshold because they're not threshold markets. No semantic equivalence exists between these and Kalshi's strike-snapshot markets. The "shape unification" recommendation was based on a wrong premise. Only the smaller polymarket subset (221 `point_in_time` + 32 `monotonic_threshold` BTC markets) are real thresholds.

### 4.9 ❌ "Kalshi sports league_id backfill addresses 864k markets"

**False.** Only ~2,000 markets are addressable via direct KB join (`known_entities.league_canonical` populated). The other 862k have player-name subjects, and `entity_relations.plays_for` is empty (§3.5). The actual high-leverage path is **deriving league from Kalshi series prefix** (`KXMLB*` → MLB) rather than walking the KB graph. The bulk-backfill framing was misleading.

### 4.10 ❌ "Need to add SPX/SPY/XAUUSD/etc. aliases to the KB"

**False.** Aliases already exist on the canonical entries (`S&P 500` has `[SPX, SPY, sp500, ...]`, `Gold` has `[XAU, XAUUSD, ...]`). The actual bug is **duplicate `known_entities` rows** registered in `domain_category='crypto'` (id=6944 SPX, id=6928 WTI, id=6936 XAUUSD, etc.) that the alias resolver hits first, short-circuiting the canonical-entity lookup. Fix is duplicate cleanup + FK re-routing, not alias addition.

### 4.11 ❌ "Index naming inconsistency is a normalization bug"

**Partially false.** Kalshi using `S&P 500` and Polymarket using `SPX`/`SPY` IS the surface symptom, but the underlying cause is item #4.10 — the alias resolver isn't routing them to the same canonical entity because of the duplicate rows in `known_entities`. Fix the duplicates, the alias resolver does the rest.

### 4.12 ❌ "Mention markets being Polymarket-exclusive is a normalization gap"

**False.** Kalshi (CFTC-regulated) doesn't list mention/tweet/speech markets. "Elon Musk # tweets in May 2026", "What will Trump say at China State Banquet" etc. are **real product gaps**, not normalization failures. No fix possible — the markets don't exist on the other side.

### 4.13 ❌ "Sports league_id is missing because the LLM didn't extract it"

**Misleading framing.** The KB has the league data for ~48% of sports entities. The leak is in the **per-market normalization step** writing `llm_market_normalizations.league_id` — the deterministic Kalshi sports path doesn't populate the FK even when the KB knows the league. (For per-player markets, the bigger issue is the empty `entity_relations` graph blocking walks — see §3.5.)

### 4.14 ❌ "canonical_event wording variance is a major merger blocker"

**Lower leverage than expected.** 810,929 distinct canonical_event values for 870,770 questions (1.07 per event). Only 1,040 "would-merge" groups (2,535 questions) have exactly 2 distinct canonical_events that wording-normalization could collapse. Long tail of groups with 100-560 events per group are likely semantically different (Trump-tweet keyword variations) and would cause false merges if normalized. ~1-3k merges max impact.

---

## 5. Workflow conventions

### 5.1 Querying Kalshi market data

Always use `kalshi_markets.raw` joined via `markets.platform_id = kalshi_markets.ticker`. Example pattern:

```sql
SELECT m.id, m.category_unified, km.raw->>'strike_type', km.raw->>'floor_strike'
FROM markets m
JOIN kalshi_markets km ON km.ticker = m.platform_id
WHERE m.platform = 'kalshi';
```

### 5.2 Measuring deterministic-handler coverage

```sql
SELECT m.platform, m.category_unified,
       COUNT(*) AS total,
       COUNT(lmn.market_id) AS normalized,
       COUNT(*) - COUNT(lmn.market_id) AS pending
FROM markets m
LEFT JOIN llm_market_normalizations lmn ON lmn.market_id = m.id
GROUP BY m.platform, m.category_unified;
```

`pending = total - normalized` is the count of markets without a deterministic handler match (the right metric for measuring handler-gap impact, not "queue backlog").

### 5.3 Adding a new Kalshi series to the deterministic handler

1. Find the series prefix(es) via `split_part(event_ticker, '-', 1)`
2. Sample `rules_primary` to identify the real resolution_source (e.g., "Accuweather", "National Weather Service", "CF Benchmarks", "BLS", "NOAA NHC")
3. Add one entry to `KNOWN_SERIES_MAP` per canonical asset/series (prefix-scan catches variants like `KXBTCD`, `KXBTCY`, etc.)
4. Set the proper `category` (`weather`, `economic`, `crypto`, etc.)
5. **Critically**, set `resolutionSource` to the real provider name, not a placeholder

### 5.4 Checking cross-platform question merges

```sql
SELECT q.id, q.canonical_subject,
       (SELECT array_agg(DISTINCT m.platform ORDER BY m.platform)
        FROM question_members qm JOIN markets m ON m.id = qm.market_id
        WHERE qm.question_id = q.id) AS platforms
FROM questions q
WHERE q.id IN (...)
```

The question doesn't carry a `platforms` field — derive via `question_members → markets`.

### 5.5 Identifying which canonical_key field is blocking a merge

When two markets that "should" merge produce different canonical_keys, decompose each:

```sql
SELECT q.canonical_key,
       split_part(q.canonical_key, '|', 1) AS subject,
       split_part(q.canonical_key, '|', 2) AS shape,
       split_part(q.canonical_key, '|', 3) AS direction,
       split_part(q.canonical_key, '|', 4) AS metric,
       split_part(q.canonical_key, '|', 5) AS value,
       split_part(q.canonical_key, '|', 6) AS unit,
       split_part(q.canonical_key, '|', 7) AS temporal,
       split_part(q.canonical_key, '|', 8) AS date,
       split_part(q.canonical_key, '|', 9) AS resolution_source,
       split_part(q.canonical_key, '|', 10) AS canonical_event,
       split_part(q.canonical_key, '|', 11) AS outcome_label
FROM questions q WHERE ...;
```

Diff the 11 fields side by side — usually one or two fields disagree and that tells you exactly where the normalization is leaking.

---

## 6. Schema / code reference

| File | Purpose |
|---|---|
| [services/pipeline/src/stage1-normalize/kalshi-deterministic.ts](services/pipeline/src/stage1-normalize/kalshi-deterministic.ts) | KNOWN_SERIES_MAP + typed-strike handler. **The file to extend for any new Kalshi series.** |
| [services/pipeline/src/stage1-normalize/text-deterministic.ts](services/pipeline/src/stage1-normalize/text-deterministic.ts) | Text-pattern deterministic handlers (the F/T/W/P variants). 2,500+ lines. |
| [services/pipeline/src/stage1-normalize/weather-stations.ts](services/pipeline/src/stage1-normalize/weather-stations.ts) | Shared weather station extraction (`extractKalshiWeatherStation`, `extractPolymarketWeatherStation`) + `stationAliasesFor` for KB alias-chain merging across platforms. |
| [services/pipeline/src/scripts/backfill-kalshi-weather.ts](services/pipeline/src/scripts/backfill-kalshi-weather.ts) | Scoped backfill script (also covers other categories via `CATEGORY=<x>` env var). Pattern to copy for any new deterministic handler. |
| [services/pipeline/src/scripts/backfill-polymarket-weather.ts](services/pipeline/src/scripts/backfill-polymarket-weather.ts) | Scoped Polymarket weather backfill via Template P. |
| [services/pipeline/src/stage1-normalize/worker.ts](services/pipeline/src/stage1-normalize/worker.ts) | Stage 1 worker pool that drains stage1_queue. |
| [services/pipeline/src/stage1-normalize/llm-normalizer.ts](services/pipeline/src/stage1-normalize/llm-normalizer.ts) | LLM fallback path (intentionally not run). |
| [services/pipeline/src/db/queries/questions.ts](services/pipeline/src/db/queries/questions.ts) | `hashKeyGroupQuestions` — canonical_key construction. Where field-9 = resolution_source is set in stone. |
| [services/pipeline/src/db/entity-registry.ts](services/pipeline/src/db/entity-registry.ts) | KB lookup, leagueResolver, providerResolver, scopeToEntityMetadata. |
| [docker/init.sql](docker/init.sql) | Master schema: markets, questions, llm_market_normalizations, known_entities, entity_relations, implication_edges. |
| [docker/migrations/015_stage1_queue.sql](docker/migrations/015_stage1_queue.sql) | stage1_queue with FOR UPDATE SKIP LOCKED. |
| [docker/migrations/022_entity_enrichment_queue.sql](docker/migrations/022_entity_enrichment_queue.sql) | entity_enrichment_queue for follow-up entity metadata. |
| [docker/migrations/036_outcome_label.sql](docker/migrations/036_outcome_label.sql) | outcome_label addition (canonical_key field 11). |
| [docker/migrations/037_condition_date_precision.sql](docker/migrations/037_condition_date_precision.sql) | condition_date_precision (drives canonical_key date format). |
| [docker/migrations/038_questions_condition_date_precision.sql](docker/migrations/038_questions_condition_date_precision.sql) | Precision roll-up to questions. |
| [docker/migrations/040_merge_ticker_duplicate_entities.sql](docker/migrations/040_merge_ticker_duplicate_entities.sql) | Merge SPX/WTI/XAUUSD/XAGUSD duplicates into S&P 500/WTI Crude Oil/Gold/Silver canonical entities; re-route FK refs. |
| [docker/migrations/041_backfill_canonical_subject_for_merged_entities.sql](docker/migrations/041_backfill_canonical_subject_for_merged_entities.sql) | lmn.canonical_subject backfill after migration 040. |
| [docker/migrations/042_upgrade_price_snapshot_date_precision.sql](docker/migrations/042_upgrade_price_snapshot_date_precision.sql) | Day → minute precision upgrade for price snapshots via end_date (with day-agreement safety check). |
| [docker/migrations/043_backfill_polymarket_weather_resolution_source.sql](docker/migrations/043_backfill_polymarket_weather_resolution_source.sql) | Backfill resolution_source + condition_direction for Polymarket weather (superseded by null-source convention; kept for history). |

---

## 6.5 Per-platform coverage drill-down (2026-05-24 snapshot)

End-to-end view of normalization coverage by platform × category. Captures the state after items #5/weather/league_id/economic/single-subject-politics shipped. Refresh this section after any new handler rolls out.

### Kalshi (~924k markets, 94.7% normalized)

| category | total | normalized | % | gap notes |
|---|---:|---:|---:|---|
| sports | 891,733 | 864,224 | 96.9% | parlays (858k via `kalshi:parlay:mve`) + `kalshi:player-stat` (1,671) + `kalshi:categorical` (1,073). Gap = per-team threshold series (KXNFLWINS 544, KXMLBHRR 534, KXMLBTOTAL 308, KXNCAAFWINS 387) |
| crypto | 4,347 | 4,052 | 93.2% | `KNOWN_SERIES_MAP` covers tokens. Gap = custom-strike DOGE variants |
| weather | 909 | 838 | 92.2% | shipped via `kalshi:weather` (KNOWN_SERIES_MAP). Gap = hurricanes/earthquakes/climate (non-threshold semantics) |
| economic | 5,599 | 3,419 | 61.1% | shipped via KNOWN_SERIES_MAP. Gap = `KXECONSTAT*` (571 custom-strike), `KXFEDDECISION` (70), `KXIPO*`, `KXEARNINGSMENTION*` |
| election | 12,034 | 1,726 | 14.3% | single-subject thresholds done. **Bulk gap = per-district `KXMIDTERMMOV` (3,944) + `KXMIDTERMVOTETURN` (2,510) + `KXCAPRIMARY` categorical (529)** |
| politics | 1,629 | 148 | 9.1% | single-subject thresholds done. Small gap remaining |
| entertainment | 7,728 | 51 | 0.7% | `KXMARMADROUND` (555), `KXARTISTSTREAMS*` (943+319+370), `KXBBCHARTPOSITION*` (660), `KXAMA` (305), `KXRT` (248) — all structured/custom strikes |
| technology | 434 | 10 | 2.3% | low priority |
| geopolitical | 59 | 0 | 0% | tiny |

Top Kalshi normalization paths: `kalshi:parlay:mve` (857,964), `kalshi:price-ladder` (7,660), `kalshi:player-stat` (1,671), `kalshi:categorical` (1,073), `kalshi:weather` (838), various `text-deterministic-*` for sports.

### Polymarket (~104k markets, ~65% normalized)

| category | total | normalized | % | template paths + gap |
|---|---:|---:|---:|---|
| weather | 3,839 | 3,823 | **99.6%** | Template P (station-aware, other-agent's work) |
| crypto | 9,179 | 7,650 | 83.3% | Templates A/Q/U/Z, mostly Up-or-Down candles |
| sports | 67,400 | 49,890 | 74.0% | Templates G/H/J/K/L/Y. **17,510 gap — championship-winner / season-stat-leader / qualification patterns ("Will [Team] win [Year] [Tournament]?")** |
| economic | 2,900 | 712 | 24.6% | Template N/U gaps |
| election | 13,355 | 1,984 | 14.9% | Template F. Gap = anonymized "Person T" / "Candidate I" district nominee markets |
| politics | 3,422 | 289 | 8.4% | "Will [Person] be arrested" / "tariff rate" / binary politicals |
| entertainment | 2,770 | 40 | 1.4% | underbuilt |
| technology | 651 | 0 | 0% | not addressed |
| geopolitical | 192 | 0 | 0% | not addressed |

Polymarket template alphabet: Z (16,765), U (10,887), N (6,352), H (5,944), R (4,039), P (3,823 — weather), G (2,217), J (2,015), A (2,010), B (2,000), F (1,984), K (1,962). Templates D-Y handle different shape/category combos.

### Predict.fun (~2.8k markets, ~54% normalized)

| category | total | normalized | % | notes |
|---|---:|---:|---:|---|
| crypto | 1,409 | 940 | 66.7% | Template N (Up-or-Down candles — same product as Polymarket) |
| sports | 961 | 571 | 59.4% | Templates B/G/J overlap Polymarket sports template set |
| economic | 288 | 0 | **0%** | **`↑ $390` / `↓ 1.25%` Up-or-Down candle format (unicode arrow titles) — no template covers these yet** |
| entertainment | 76 | 0 | 0% | tiny |
| politics | 27 | 0 | 0% | tiny |
| election | 7 | 0 | 0% | tiny |

Predict gap pattern: "[Tournament] Winner: [Team]" (sports), "[Project] FDV above $XM one day after launch?" (crypto), "↑/↓" arrow markets (economic).

### Limitless (~1.1k markets, ~53% normalized)

| category | total | normalized | % | notes |
|---|---:|---:|---:|---|
| sports | 846 | 517 | 61.1% | Templates M/B/L — "BUNDL, Bayern München vs 1. FC Köln" format |
| crypto | 173 | 92 | 53.2% | Template N (Up-or-Down) |
| economic | 60 | 0 | 0% | "Which levels will KOSPI hit in May?" multi-outcome |
| election | 11 | 0 | 0% | tiny |
| politics | 5 | 0 | 0% | tiny |

---

## 6.6 Cross-platform overlap matrix

(Subject, shape) tuples that exist on 2+ platforms. **"In bridge"** = normalized markets sharing the same `canonical_subject` and `condition_shape` across platforms; **"merging"** = `questions.platform_count ≥ 2` (the canonical_key actually collides).

| category | shape | platforms | bridge subjects | bridge markets | actually merging | utilization |
|---|---|---|---:|---:|---:|---:|
| crypto | binary_event | poly+predict+limitless | 3 | 3,654 | ~3,654 | ~100% ✓ |
| crypto | binary_event | poly+limitless | 5 | 3,615 | included above | — |
| election | binary_event | kalshi+poly | 218 | 2,632 | 126 | **5%** ❌ |
| sports | binary_event | **all 4 platforms** | 51 | 2,527 | partial | low |
| sports | binary_event | kalshi+poly | 279 | 2,064 | partial | low |
| crypto | point_in_time | kalshi+poly | 3 | 1,790 | 32 | **2%** ❌ |
| crypto | range_snapshot | kalshi+poly | 4 | 1,646 | 0 | **0%** ❌ |
| sports | binary_event | kalshi+poly+predict | 57 | 1,017 | partial | low |
| sports | monotonic_threshold | kalshi+poly | 34 | 1,016 | 0 | **0%** ❌ |
| sports | binary_event | poly+predict | 79 | 991 | ~250 (football clubs) | ~25% |
| sports | monotonic_threshold | limitless+poly | 52 | 836 | 0 | **0%** ❌ |
| sports | binary_event | kalshi+limitless+poly | 36 | 637 | partial | low |
| sports | binary_event | limitless+poly+predict | 27 | 466 | partial | low |
| crypto | point_in_time | kalshi+limitless+poly | 1 | 400 | included in crypto PIT | — |
| sports | binary_event | limitless+poly | 30 | 334 | partial | low |
| weather | range_snapshot | kalshi+poly | 3 | 270 | ~8 (Miami/LA/Austin) | ~3% |
| weather | point_in_time | kalshi+poly | 3 | 70 | small | low |
| politics | point_in_time | kalshi+poly | 1 | 55 | 0 (Trump approval) | **0%** ❌ |

**Confirmed actually-merging today** (from `questions.platform_count ≥ 2`):

| event_category | shape | multi-platform questions | total member markets |
|---|---|---:|---:|
| crypto | binary_event | 1,841 | 5,540 |
| sports | binary_event | 247 | 647 |
| election | binary_event | 63 | 126 |
| crypto | point_in_time | 16 | 32 |

### Unrealized cross-platform potential, by blocker

| blocker | shape | bridge markets | merging | gap |
|---|---|---:|---:|---:|
| **canonical_event wording variance** | sports binary_event (kalshi+poly, all-4-platforms etc.) | ~8,068 | ~647 | ~7,400 |
| **canonical_event wording variance** | election binary_event (kalshi+poly) | 2,632 | 126 | ~2,500 |
| **canonical_event + resolution_source placeholders** | sports monotonic_threshold | 1,852 | 0 | 1,852 |
| **resolution_source placeholder + date precision** | crypto point_in_time / range_snapshot (kalshi+poly) | 3,836 | 32 | ~3,800 |
| **resolution_source placeholder + date precision** | weather range_snapshot / point_in_time (kalshi+poly) | 340 | ~8 | ~330 |
| **resolution_source placeholder + date precision** | politics point_in_time (Trump approval) | 55 | 0 | 55 |

**Highest-leverage next actions for cross-platform unlock** (by unlocked markets):

| action | unlocks | difficulty |
|---|---:|---|
| Normalize canonical_event wording for sports/election (strip year suffix, alias league names, etc.) | ~9,900 markets | medium |
| Fix Polymarket Template P/X/etc. to emit real resolution_source from description | ~4,200 markets | small per template |
| Polymarket year-precision for "in 2026" markets | ~55 (Trump approval), generalises further | small |
| Build per-subject Kalshi extractor for `KXMIDTERMMOV` / `KXMIDTERMVOTETURN` | ~6,500 within-Kalshi (no cross-platform target) | medium |
| Extend Polymarket sports templates for "Will [Team] win [Year] [Tournament]" patterns | ~17k Polymarket sports + cross-platform | medium-large |
| Predict.fun arrow-symbol economic parser | 288 + Predict↔Poly economic overlap | small |

---

## 6.7 Cross-platform pair pattern catalog (2026-05-24)

Concrete cross-platform pairs surfaced via the dashboard UI showed multiple distinct merge-blocking patterns. Each pattern is logged here with the specific blocker so a future agent can tell at a glance which pattern a new screenshot belongs to and which fix it needs.

**Read this section together with §6.6 (overlap matrix)**: §6.6 quantifies the surface area, §6.7 names the patterns inside it. The "blocker" column tells you what's currently in the way; the "fix" column says what kind of change unblocks it.

### Pattern A1 — "Will X win [Year] [Office]?" vs "[Office] [Year]" (presidential nomination / president)

Example: Predict "Will Marco Rubio win the 2028 Republican presidential nomination?" vs Kalshi "Republican Presidential Nominee 2028 - Marco Rubio".

- **Status**: Polymarket side IS normalized through `normalizeEventNoun` (Template F, `election_outcome_winner` kind) → `canonical_event="2028 republican presidential nomination"`.
- **Blocker on Kalshi side**: the "A and B as Presidential Ticket" combinatorial markets (39 markets in the Rubio sample alone) have NO Kalshi template. They're not in any `KNOWN_SERIES_MAP` entry; they don't match `kalshi:categorical`; they fall through unnormalized.
- **Fix**: add a Kalshi template for the combinatorial-ticket pattern (`KXPRESPERSON*` series-level handler) that emits `canonical_event="2028 republican presidential nomination"` and `outcome_label` carrying both names.

### Pattern A2 — "Will [Team/Country] win the [Year] [Tournament]?" championship winner

Examples: "Will Ecuador win the 2026 FIFA World Cup?" / "Will Uruguay win the 2026 FIFA World Cup?" / "Will the Carolina Hurricanes win the 2026 NHL Stanley Cup?" / "Will Kylian Mbappé win the 2026 Ballon d'Or?" / "Will Oscar Piastri be the 2026 F1 Drivers' Champion?".

- **Status**: Kalshi side normalized via `championship_winner` event_kind (`canonical_event="2026 fifa world cup"` after `normalizeEventNoun`). Predict side normalized similarly.
- **Blocker on Polymarket side**: no Polymarket template covers this surface pattern. The 6+ Polymarket Ecuador/Croatia/etc. WC markets have no lmn rows at all.
- **Fix**: add Polymarket template for `^Will\s+(.+?)\s+win\s+(?:the\s+)?(\d{4}\s+.+?)\??$` → `canonical_event` = `normalizeEventNoun(<event>, <year>)`, `canonical_subject` = team/country, shape = `binary_event`, kind = `championship_winner`.

### Pattern B — district elections, Kalshi short form vs Predict long form

Examples: Kalshi "New Mexico Senate winner? - In 2026 - Republican party" vs Predict "Will the Republicans win the New Mexico Senate race in 2026? - Republican". Or Kalshi "PA-07 House winner? - In 2026 - Democratic party" vs Predict "Will the Democratic Party win the PA-07 House seat?".

- **Status**: Kalshi side uses series prefixes like `KXMIDTERMHOUSE*`, `KXMIDTERMSENATE*` — currently in the long-tail unnormalized bucket (per-district subject, doesn't fit single-subject `KNOWN_SERIES_MAP`). Predict side may be via Template B/G.
- **Blocker**: dual blocker — Kalshi-side has no per-district handler AT ALL; even if it did, the canonical_event wording ("Senate winner" vs "Senate race in 2026") + outcome_label phrasing ("Republican party" vs "Republican") would differ.
- **Fix**: (i) Kalshi per-district handler that extracts state/district + chamber + party from rules_primary and emits canonical_event like `"2026 new mexico senate race"`; (ii) outcome_label stem mapping `"Republican party" → "Republican"`, `"Democratic Party" → "Democratic"`.

### Pattern C — district nominees, candidate as subject

Examples: Kalshi "NY-07 Democratic nominee? - In 2026 - Antonio Reynoso" vs Predict "Will Antonio Reynoso be the Democratic nominee for NY-07?".

- **Status**: Same as B but at the nomination/primary level (one specific candidate is subject).
- **Blocker**: same dual blocker as B.
- **Fix**: same per-district handler; canonical_event format like `"2026 ny-07 democratic primary"`.

### Pattern D — stock price hit (LOW/HIGH) in month

Example: Predict "Will Apple (AAPL) hit (LOW) $232 in May? - ↓ $232" vs Polymarket "Will Apple (AAPL) hit (LOW) $232 in May?".

- **Status**: Polymarket normalized through Template (likely U), `canonical_event="What will Apple (AAPL) hit in May 2026?"`, `condition_value=>=232USD`, shape `monotonic_threshold`.
- **Blocker**: Predict side has NO lmn row for this pattern. Predict template for stock-price markets is missing.
- **Fix**: add Predict template for `^Will\s+.+?\((\w+)\)\s+hit\s+\((LOW|HIGH)\)\s+\$?([\d,.]+)\s+in\s+(\w+)\??$`.

### Pattern E — per-fixture same title across Predict ↔ Polymarket

Examples: "Will Austria win on 2026-06-17?" / "Will Croatia win on 2026-06-27?" / "Will Japan win on 2026-06-14?" — IDENTICAL titles on both platforms.

- **Status**: Polymarket emits `canonical_event="Netherlands vs Japan"` (fixture form — extracted opponent). Predict emits `canonical_event="Will Japan win on 2026-06-14?"` (verbatim question).
- **Blocker on Predict side**: Predict template doesn't extract the opponent from another data source (slug? outcomes? platform_event_id?). With only one team named in the title, Predict can't reconstruct the fixture identity.
- **Fix**: Predict template upgrade — pull opponent from `markets.outcomes` array or `markets.slug` so canonical_event = `"team a vs team b"`. Or fallback to canonical-event = `"<team> 2026-06-14"` so at least the same date/team aligns across platforms.

### Pattern F — token launch by date

Example: Predict "Will MetaMask launch a token by June 30? - June 30" vs Polymarket "Will MetaMask launch a token by June 30, 2026?".

- **Status**: Both platforms have these markets, **NEITHER is normalized**. No template exists for this surface pattern.
- **Blocker**: missing template on both sides.
- **Fix**: add deterministic template on both sides for `^Will\s+(.+?)\s+launch\s+a\s+token\s+by\s+(.+?)\??$`. Subject = project name, shape = `binary_event`, kind = `token_launch`. Date suffix normalized via `normalizeEventDate` to year-precision.

### Pattern G — FDV after launch threshold

Examples: "GRVT FDV above $800M one day after launch?" / "Surf FDV above $50M one day after launch?" / "o1 FDV above $200M one day after launch?" — on Predict and Polymarket.

- **Status**: Both platforms have these markets, **NEITHER is normalized**. No template covers this.
- **Blocker**: missing template on both sides.
- **Fix**: add deterministic template for `^(.+?)\s+FDV\s+above\s+\$([\d,.]+[KMB]?)\s+one\s+day\s+after\s+launch\??$`. Subject = project, shape = `monotonic_threshold`, condition_value = parsed amount, kind = `crypto_launch_fdv`.

### Pattern H — World Cup group winner

Example: Predict "Will Paraguay win Group D in the 2026 FIFA World Cup?" vs Polymarket "Will Paraguay win Group D in the 2026 World Cup?" (note: "FIFA" omitted on one side).

- **Status**: Both should normalize via existing championship-related templates.
- **Blocker**: tiny wording difference ("FIFA World Cup" vs "World Cup") + "Group D" remains in canonical_event.
- **Fix**: `normalizeEventNoun` alias map: `"fifa world cup"` ≡ `"world cup"` ≡ `"soccer world cup"`. Plus keep "Group X" in canonical_event so they still discriminate from the overall WC winner question.

### Pattern I — same product across Predict ↔ Polymarket but blocked by Predict outcome_label decoration

Examples: Predict outcome_labels `"↑ $410"`, `"↓ $232"`, `"Draw (Brazil vs. Morocco)"`, `"$200M"` while Polymarket outcome_labels are empty or `"draw"`.

- **Status**: When canonical_event aligns, the merge is blocked by canonical_key field 11 (`outcome_label`).
- **Blocker**: Predict's outcome_label includes price arrow + amount, or full team list parenthetical.
- **Fix**: Predict-side outcome_label normalization — strip leading `↑`/`↓` + dollar amount; strip parenthetical team lists; lowercase "Draw" → "draw".

### Pattern J — same product, slightly different category mapping

Example: Kalshi "Fed Decision in June? - 50+ bps increase" vs Predict "Will the Fed increase interest rates by 50+ bps after the June 2026 meeting?".

- **Status**: Kalshi categorical, Predict question-form. Both have outcome_label `"50+ bps increase"` (close).
- **Blocker**: canonical_event differs ("Fed Decision in June?" vs verbose Predict form).
- **Fix**: alias map `"Fed Decision in <Month>"` ≡ `"<Month> Fed meeting"` in canonical-event normalization.

### Determinism summary

All 10 patterns are deterministically solvable with extensions to:
- `normalizeFixtureCanonicalEvent` (Patterns E partially, H, J)
- New templates on platforms that don't currently cover the pattern (Patterns A1 Kalshi-ticket, A2 Polymarket-championship, D Predict-stock, F+G both-platforms token/FDV)
- `normalizeEventNoun` alias/synonym extensions (Patterns A2 word stemming, H WC variants, J Fed-decision wording)
- `outcome_label` normalization (Pattern I, B, C party-name stemming)

None require LLM. The "missing template" cases mean a clear+rerun does NOT pick them up automatically — those markets remain unnormalized until the new template is added.

---

## 7. Implementation findings (running log)

What we learned while actually shipping the audit items. Append-only — each section dated.

### 7.1 KB index alias cleanup (item #5, 2026-05-24) → no cross-platform unlock

Migrations 040 (merge duplicates SPX/WTI/XAUUSD/XAGUSD into S&P 500/WTI Crude Oil/Gold/Silver) and 041 (lmn.canonical_subject backfill) shipped cleanly. Net result: **zero new cross-platform merges**.

**The blocker turned out to be product encoding, not naming or KB cleanup.** Kalshi commodities/indexes are encoded as `condition_shape='point_in_time'` (snapshot threshold at a specific moment), while Polymarket's same-asset markets are encoded as `condition_shape='monotonic_threshold'` (cumulative "hit X anytime in window") or `binary_event` (Up-or-Down 5-min candles). These are economically distinct products and the classifier is doing the right thing keeping them apart.

| asset | Kalshi shape | Polymarket shape |
|---|---|---|
| Gold | `point_in_time` (200) | `monotonic_threshold` (31), `binary_event` (3) |
| S&P 500 | `point_in_time` (127) | `binary_event` (6) |
| WTI Crude Oil | `point_in_time` (114), `range_snapshot` (13) | `point_in_time` (33), `monotonic_threshold` (38) |

Example titles confirming the semantic gap:
- **Kalshi PIT**: "Will the gold close price be above 3813.99 USD/t.oz on May 29, 2026 at 5:00 PM EDT?" — single moment
- **Polymarket MT**: "Will Gold (XAUUSD) hit (LOW) $4,400 Week of May 11 2026?" — cumulative window

Conclusion: **cross-platform reach for commodities/indexes is structurally limited by product differences**, not normalization. The KB cleanup was still correct hygiene (no false aliasing, registrar won't recreate duplicates), but it doesn't move the cross-platform needle for this category.

### 7.2 Date precision: don't blindly trust end_date (migration 042, 2026-05-24)

Added a day → minute upgrade rule for `condition_metric='price' AND condition_shape IN ('point_in_time','range_snapshot')` on Polymarket. Used `markets.end_date` as the upgraded timestamp, but **only when the extracted day-precision date and end_date agree on the UTC day**.

The safety check matters. 9,743 of 56,824 candidate markets have end_date that doesn't agree on day with the title-extracted date — those are skipped to preserve existing day-precision merges. Sample disagreements:
- Sports games at night: game on "May 13" extracts as `2026-05-13` but end_date is `2026-05-14 00:30Z` (timezone artifact, game runs past midnight UTC)
- Weekly/monthly markets: title says "Week of May 11" → extracted `2026-05-11`, end_date is `2026-05-15 21:00Z` (window end)
- Predict.fun sports: end_date set to midnight-next-day as platform placeholder, not the real game time

**Caveat for future work**: `markets.end_date` is the platform's settlement-window-end timestamp, NOT necessarily the real resolution moment. For some platforms (Polymarket commodity markets) it's accurate; for others (Predict sports) it's a placeholder. Always validate against an independent signal (title-extracted date) before using.

WTI in particular surfaced an interesting case: Polymarket WTI `end_date = 2026-05-11 21:00Z` (5pm ET Pyth close), Kalshi WTI `condition_date = 2026-05-11 15:00Z` (NYMEX settle). These are **semantically different resolution moments** for the same physical contract. Different data sources can produce different settle values in volatile windows. Not a bug to chase — the platforms genuinely measure different things.

### 7.3 Kalshi weather handler (item #2, 2026-05-24)

Extended `KNOWN_SERIES_MAP` with 50 weather series entries. 838 of 909 weather markets normalized in 5 seconds, zero LLM cost.

**Key design decision: canonical_subject carries the station, not just the city.** Format `"<Station>, <City>"`. The station IS the resolution source of truth for weather — data aggregators (Wunderground, NWS, Accuweather) are conduits reading the same physical instrument. So canonical_subject is the station; `resolution_source` is set to NULL for all weather markets.

Generic-city series (KXLOWT*, KXHIGHT* — Atlanta/Boston/etc.) use just the city name as fallback because Kalshi's rules don't name a station for them. They won't cross-platform-merge with Polymarket's station-specific subjects — which is correct: a generic "Chicago" NWS report doesn't tell us whether it sourced from O'Hare or Midway.

### 7.3a Weather station extraction: pure-text, mechanical normalization, no hardcoded maps

Implementation in [weather-stations.ts](services/pipeline/src/stage1-normalize/weather-stations.ts):

- **`extractKalshiWeatherStation(rules_primary, city)`** — regex `recorded (?:at|in)\s+(.+?)\s+for\s+` (Kalshi rules format)
- **`extractPolymarketWeatherStation(description, city)`** — regex `recorded at\s+(?:the\s+)?(.+?)\s+Station\b` (Polymarket description format)
- **`normalizeStationName(raw, city)`** — mechanical rules only:
  - strip `" Station"`, 2-letter state suffix (`, IL` / `, CA`)
  - `Intl` → `International` (true alias expansion)
  - hyphen → space (`Austin-Bergstrom` = `Austin Bergstrom`)
  - strip trailing `", <city-word-prefix>"` (so `Central Park, New York` with city=`New York City` → `Central Park`)
  - **Deliberately does NOT strip `" International Airport"` / `" Airport"` suffix** — collapsing `"Miami International Airport"` to bare `"Miami"` loses the station qualifier and creates ambiguity. Two earlier iterations tried this; reverted both times when the precision loss outweighed the merge gain.

### 7.3b Cross-platform alignment via KB alias chain (NOT canonical_subject normalization)

The two platforms use different wording for the same physical station:
- Kalshi: "Austin Bergstrom" (short)
- Polymarket: "Austin-Bergstrom International Airport" (verbose)

Forcing one side to mimic the other's wording would either lose precision (strip suffix everywhere) or require hardcoded knowledge (per-city short→long map). Neither is satisfying.

**Solution: register multiple equivalent forms as aliases of the same KB entity.** Both handlers call `stationAliasesFor(canonicalSubject, city)` which emits the alternate forms (with/without `"International"`, with/without trailing `"Airport"`, bare-station, etc.). When the second platform processes a market, the KB's alias-match path in `findOrCreateEntity` finds the entity created by the first platform — both end up writing the same `canonical_subject` to lmn even though their input strings differed.

Concrete result: 3 cities now merge cross-platform via this alias chain:

| canonical_subject | Kalshi markets | Polymarket markets |
|---|---:|---:|
| Miami International Airport, Miami | 18 | 154 |
| Los Angeles Airport, Los Angeles | 18 | 77 |
| Austin Bergstrom, Austin | 18 | 55 |

= **8 canonical_key merge pairs**. The canonical wording is whichever side processed first — but both platforms agree, so merges work.

### 7.3c Weather cross-platform: structurally limited cities

Some cities legitimately don't merge because the platforms reference different physical stations — correctly distinguished:

| city | Kalshi station | Polymarket station | reason |
|---|---|---|---|
| NYC | Central Park (NWS KNYC) | LaGuardia (KLGA) | different physical stations |
| Chicago | Midway (KMDW) | O'Hare (KORD) | different physical stations |
| Houston | (generic, NWS report) | William P. Hobby Airport | Kalshi unnamed → conservative non-merge |
| Denver | (generic) | Buckley Space Force Base | Polymarket uses unusual station |
| Dallas | (generic) | Dallas Love Field | could be DFW or DAL; Kalshi unnamed |
| Atlanta, SF, Seattle, Phoenix, etc. | (generic) | airport-specific | Kalshi rules don't name station — conservative non-merge |

The conservative-non-merge cases are still candidates for Stage 2/3 `near_equivalence cross_platform` edges if the underlying values align — that's the right layer for "probably same but not certain" reasoning.

### 7.3d Polymarket Template P fixes (companion to Kalshi weather work)

Template P (`tryTemplateP` in text-deterministic.ts) had three bugs surfaced during this work:
1. **`resolution_source = 'text-deterministic-P'` placeholder** — now set to `null` (the station is the source of truth)
2. **`condition_direction = null` for range_snapshot** — now `'between'` to match Kalshi convention
3. **Station extractor regex `[^.]+?` rejected station names with periods** — "William P. Hobby Airport" failed; switched to `.+?` lazy match capped at " Station" boundary

Migration 043 backfilled the existing 3,823 Polymarket weather rows for the first two fixes. The third (station extraction) only affected new rows; existing rows were rebuilt via the backfill script.

**Net result for weather**: 838 Kalshi + 3,823 Polymarket weather markets normalized. 8 canonical_key cross-platform merge pairs. KB alias chain preserves canonical_subject precision on both sides.

### 7.5 Pattern A2 Polymarket championship + normalizer stems (2026-05-25)

Pattern A2 (§6.7) wasn't a missing template — Template C already covered "Will X win the YYYY [Tournament]?" titles, with the broadened middle-group fix shipped in 2026-05-24. The actual blocker was two-fold:

1. **stage1_queue 'pending' markets aren't re-evaluated when templates change.** The Stage 1 batch path only runs `normalizeTextDeterministicBatch` on UNFEATURIZED markets. Already-featurized markets sitting in `stage1_queue.status='pending'` (3,786 Polymarket championship-style titles) only get processed by the streaming worker, which calls `processMarketBatchLLM` ONLY (skipped in regex-first mode). Fix: run `backfill-text-det-scoped.ts` with `PATTERN='Will % win the 202%'`.

2. **Kalshi championship_winner emits different canonical_event than Polymarket.** Kalshi "Will Curacao win the Final of the 2026 Men's FIFA World Cup?" → `"final of the 2026 world cup"`; Polymarket "Will Cape Verde win the 2026 FIFA World Cup?" → `"2026 world cup"`. Two new stems in `normalizeEventNoun`:
   - Strip leading `"final of (the) "` prefix (winning the final IS winning the championship).
   - Reorder trailing `"X in YYYY"` → `"YYYY X"` so Kalshi `"ballon d or in 2026"` matches Polymarket `"2026 ballon d or"`. Guarded by no-other-year-in-head.

Migration 046 backfilled 47 + 439 existing rows. Polymarket championship_winner: 274 → **1,561** (+5.7×). Cross-platform candidate events now include `2026 pga championship` (265 markets, 2 platforms), `2026 world cup` (163), `2026 truist championship` (146), `2026 mls cup` (60), conference finals MVPs, China Super League.

### 7.6 Pattern E Predict per-fixture opponent extraction (2026-05-25)

Predict per-fixture markets ("Will Croatia win on 2026-06-23?") emit `canonical_event` = bare team name after `normalizeFixtureCanonicalEvent` strips the suffix. They can never merge with Polymarket fixture form "team a vs team b". Four fixes:

1. **Template G now consults `event_match_context`** (sibling H2H title in same `platform_event_id`) — when subject team is one of the H2H pair, emit `canonical_event_override = "alpha_a vs alpha_b"`.
2. **`event_match_context` SQL: `~* ' vs '` → `~* ' vs\.? '`** so Predict's "Will Croatia vs. Panama end in a draw?" sibling titles (with period) are picked up. Same fix applied in `backfill-text-det-scoped.ts`.
3. **`normalizeFixtureCanonicalEvent` now alpha-sorts "X vs Y"** at the end. Polymarket "Morocco vs Brazil" → "Brazil vs Morocco" so platform team-order doesn't matter. Migration 047 backfilled 6,797 existing rows.
4. **Club-code-suffix tolerance in subject↔context membership check.** "Sevilla FC" (title) vs "Sevilla" (sibling-stripped) compared via `\s+(fc|bc|ac|cf|sc|cd|afc|united)$` strip on both sides.

Predict per-fixture: 216 markets re-normalized. Cross-platform fixture events now include all-4-platform `aurora vs team falcons` (39), 3-platform soccer (`fc barcelona vs real madrid`, `aston villa vs liverpool`, La Liga + Ligue 1 + Bundesliga).

### 7.7 Resolution_source placeholder cleanup (migration 048, 2026-05-25)

Per §1.3 / §3.4: canonical_key field 9 is `resolution_source`. Placeholders `text-deterministic-*` (60,378 rows) and the literal `"Kalshi"` (860,708 rows on non-crypto Kalshi) are code-path tags, never real sources. Both BLOCK cross-platform merges because they differ across platforms for the same logical question.

Migration 048 NULLed all placeholders. Convention: NULL when no real source is known (already adopted for weather §8.3 and crypto via `backfill-cross-platform-fixes.ts`).

Did NOT unlock additional crypto merges (other-agent already populated CF Benchmarks correctly). Modest contribution to sports merges (most sports value came from Pattern A2 + E above).

### 7.8 Pattern B/C Kalshi per-district midterm handlers (2026-05-25)

Three new Kalshi-deterministic passes for multi-subject election series that can't fit `KNOWN_SERIES_MAP`:

- **`kalshi:midterm-mov`** (`KXMIDTERMMOV*`): "Will the margin of victory for {party} in the {state}'s {district} District House election be at least N percentage points?" — extracts state/district/party from title; threshold from typed-strike fields. Emits `event_kind='election_margin'`, `outcome_label='republican'|'democratic'`, `canonical_event='YYYY {state} {district} house race'`. **3,269 markets normalized** (out of 3,944).
- **`kalshi:midterm-voteturn`** (`KXMIDTERMVOTETURN*`): vote-count thresholds. Same subject extraction, no party. `event_kind='election_turnout'`. **2,130 markets** (out of 2,510).
- **`kalshi:place-first-primary`** (`KXCAPRIMARY*` + variants): "Will {candidate} place first in the {year} {district} primary?" — candidate from `yes_sub_title`, party from `subtitle "::Democratic"`. `event_kind='election_outcome_winner'`, `canonical_event='YYYY {district} {party} primary'`. **287 markets** (out of 529).

Two new event_kinds added: `election_margin`, `election_turnout`. Largely within-Kalshi reach (Polymarket doesn't trade margin/turnout); cross-platform target only on the primary nominee subset (Pattern C).

### 7.9 Session 2026-05-25 cross-platform delta (Stage 2 rehashed)

| category | xplat questions (start of 05-24) | (start of 05-25) | (final) | xplat markets (start of 05-24) | (final) |
|---|---:|---:|---:|---:|---:|
| sports | 247 | 247 | **544** | 647 | **2,716** |
| crypto | 608 | 641 | 724 | 1,805 | 2,089 |
| election | 63 | 63 | 63 | 126 | 126 |

Sports: +120% questions, +320% markets cross-platform over baseline. Crypto +19% questions. Election unchanged (per-district work is within-Kalshi). The big sports jump is Pattern A2 (championship) + Pattern E (Predict per-fixture) + alpha-sort migration 047 + resolution_source NULLing migration 048.

### 7.4 Kalshi sports league_id resolution (item #4, 2026-05-24)

**Coverage on addressable surface: 5.8% → 94%** (5,842 of 6,216 single-event Kalshi sports markets now carry `league_id`).

The audit doc's "864k markets need league_id" framing was misleading: 858,168 of those are `KXMVE*` parlays (multi-event combos like KXMVESPORTSMULTIGAMEEXTENDED, KXMVECROSSCATEGORY, KXMVENBASINGLEGAME). Parlays correctly don't carry a single league_id at the parlay level — each leg references its own single-event market with its own league. Treat the 33,565 single-event markets as the real surface.

**3-level KB auto-seeding pattern introduced** ([kalshi-deterministic.ts:resolveKalshiCompetitionToLeagueId](services/pipeline/src/stage1-normalize/kalshi-deterministic.ts)):
1. Look up Kalshi competition string in curated `KALSHI_COMPETITION_TO_LEAGUE` map (`{league, sport, aliases?, asCompetition?}`)
2. Resolve parent sport via `sportResolver.resolve(...)` (returns null if sport missing — refuse to seed orphan league)
3. Resolve-or-create league via `leagueResolver.resolve(...)` with `extraMetadata={sport_canonical}` (triggers T3 INSERT if missing; populates the generated `sport_canonical` column)
4. INSERT entity_relations row `(parent=league, child=sport, relation='part_of')` ON CONFLICT DO NOTHING (idempotent)

8 entities auto-seeded during the backfill: `NCAA Men's Basketball`, `PSA World Tour`, `NCAA Women's Basketball`, `NCAA Baseball`, `UEFA Women's Champions League`, `Argentine Primera División`, plus `squash` sport (created by sportResolver) and `Grand Sumo Tournament` competition. All have proper part_of links.

**Esports correctly stay unresolved**: Kalshi's "League of Legends" / "CS2" / "Dota 2" / "Valorant" / "Rocket League" / "Rainbow Six Siege" / "Call of Duty" tags refer to the broad esport, not a specific tournament. These are stored as `type='sport'` in the KB, which `leagueResolver` doesn't match (it accepts ['league','competition']). Result: 9 competitions covering 374 markets stay with `league_id=NULL` — semantically correct, not a bug.

**Why the existing handler was leaking before**: `resolveKalshiCompetitionToLeagueId` already existed but most of its 168 distinct competitions weren't in the map (only ~20 were). And it returned null when the canonical league didn't exist in KB rather than auto-creating it. The fix layered: enrich the map (+22 entries), add prefix-tier fallback for ATP/WTA tournament cities, auto-seed missing canonicals.

**Pattern to reuse**: this auto-seeding approach generalizes. Any time we have a "tag → entity" map and the entity might not exist yet, we should:
- Require the curated map entry (refuse to invent entities from arbitrary strings)
- Auto-seed the entity with proper parent/structural metadata via the resolver
- Insert the entity_relations link explicitly

## 8. Updated caveat list (new entries from §7 work)

Adding to §3 — these are the gotchas surfaced during implementation:

### 8.1 `markets.end_date` ≠ resolution moment for all platforms

Polymarket commodity markets: `end_date` IS the resolution timestamp (5pm Pyth close for crude, 4pm NYSE close for S&P 500, etc.).
Predict.fun sports markets: `end_date` is a midnight-next-day placeholder, not the actual game time.
Kalshi: events have `expected_expiration_time` (typically the moment Kalshi expects to resolve) — close to but not always equal to `markets.end_date`.

**Always require day-agreement with an independently-extracted date before treating end_date as authoritative.** See migration 042 for the canonical safety check.

### 8.2 Kalshi commodity vs Polymarket commodity = different products

Even though Kalshi and Polymarket both list "Gold" markets and the canonical_subject is the same, the products differ:
- Kalshi: `point_in_time` snapshot ("close above X at 5pm EDT") — single-moment threshold
- Polymarket: `monotonic_threshold` ("hit X anytime this week") — cumulative path-dependent

These can't merge cross-platform and shouldn't be. The shape classifier correctly distinguishes them.

### 8.3 Weather: the station IS the resolution source — aggregators are noise

Earlier framing: "Wunderground vs NWS prevents weather merge because resolution_source differs in canonical_key field 9". **Superseded.**

The correct framing: the weather station IS the physical source of truth. Wunderground, NWS, and Accuweather all read from the same ASOS/AWOS instrument and report the same value (modulo QA timing). The "data aggregator" identity is conduit, not source.

Current convention (as of §7.3): **`resolution_source` is NULL for all weather markets** on both platforms. The station-qualified `canonical_subject` carries the source-of-truth signal. Markets with same station merge; markets with different physical stations (Chicago Midway vs O'Hare) correctly stay distinct.

If a future weather product introduces meaningful aggregator differences (e.g., one platform uses a derived index that materially diverges from raw station data), revisit this.

### 8.4 Kalshi sports league_id ≠ "all sports markets"

858,168 (96%) of Kalshi sports markets are `KXMVE*` parlays. They don't carry a single league_id by design. Always filter to `event_ticker NOT LIKE 'KXMVE%'` (or check for parlay flag) before measuring league_id coverage.

### 8.5 KB auto-seeding requires parent sport to exist

When auto-seeding a new league/competition entity, the parent sport MUST already exist in `known_entities` with `type='sport'`. The resolver refuses to seed an orphan league. If a Kalshi tag references a sport we haven't seeded yet (e.g. "squash" wasn't seeded; sportResolver T3-created it inline during the league backfill), the sport gets created automatically too — which works because `sportResolver` will T3-create on miss.

### 8.7 KB alias chain unblocks platform-wording mismatch without canonical_subject loss

When two platforms use different wording for the same entity (e.g. Kalshi `"Austin Bergstrom"` vs Polymarket `"Austin-Bergstrom International Airport"`), the choice has historically been between:
- Force both to a shared canonical (loses precision on one side), OR
- Maintain a hardcoded alias map (loses dynamic extractability)

**Third path**: each handler keeps its own preferred wording as the `canonical` it passes to `registerEntities`, but the `aliases` array on the `ResolvedEntity` lists ALL equivalent forms. The first platform to process creates the KB entity with its wording as canonical and seeds aliases including the other platform's expected wording. When the second platform processes, `findOrCreateEntity`'s Pass-2 alias match finds the existing entity and returns its canonical. Both platforms end up writing the same canonical_subject to lmn → canonical_key merges.

Pattern in [weather-stations.ts:stationAliasesFor](services/pipeline/src/stage1-normalize/weather-stations.ts). Generalizable to any case where platforms differ only in formatting verbosity (suffixes, abbreviations, separators). Whichever platform creates the entity first sets the canonical wording — accept that and don't fight it.

### 8.8 The KB resolver is order-dependent

The `findOrCreateEntity` flow: Pass 1 (exact canonical) → Pass 2 (alias match) → Pass 3b (pre-insert alias collision check) → INSERT. The FIRST market to register a given entity determines the canonical wording for that entity. Subsequent merges via alias-match adopt the existing canonical.

**Implication**: re-running backfills can produce different canonical strings depending on which platform's worker runs first. The actual canonical_subject value in lmn is platform-of-first-touch-dependent. This is fine as long as both platforms end up agreeing — but worth knowing when debugging "why does this market have subject X instead of Y".

To force a specific platform's wording, run that platform's backfill first, then the other. Or seed the KB with a manual canonical before any backfill.

### 8.6 Esports treated as sports, not leagues

`known_entities` stores League of Legends, Counter-Strike 2, Dota 2, Valorant, etc. as `type='sport'`. `leagueResolver.resolve` filters by `type ∈ ('league','competition')` so these never match — by design. Kalshi's "League of Legends" competition tag is sport-level (refers to the game broadly), not league-level (LCK/LCS/Worlds are specific leagues). Don't try to force them into league_id.

## 9. Updated false-positive list (new entries from §7 work)

### 9.1 ❌ "864k Kalshi sports markets need league_id backfill"

**Misleading framing**. 858,168 of those are parlays that shouldn't carry single league_id. The real addressable surface is 33,565 single-event markets, and the work plan was sized against the wrong baseline.

### 9.2 ❌ "KB index alias cleanup unlocks ~600 commodity cross-platform merges"

**Wrong premise**. Even after cleaning up duplicate entities and backfilling canonical_subject, the cross-platform merge count stayed at zero because the dominant blocker for commodities is shape encoding (Kalshi PIT vs Polymarket MT/BE), not naming. The cleanup was still correct hygiene.

### 9.3 ❌ "Weather cross-platform reach via canonical_key collision remains effectively zero"

**Superseded.** When this was written, I had `resolution_source='National Weather Service'` on Kalshi side and `'Wunderground'` on Polymarket — field 9 mismatch blocked merges. The current convention (§8.3) sets `resolution_source=null` for all weather and uses the station-qualified canonical_subject as the source-of-truth signal.

Combined with the KB alias chain (§7.3b), 3 cities now merge cross-platform: Miami International Airport (172 markets), Los Angeles Airport (95), Austin Bergstrom (73). 8 actual canonical_key merge pairs.

Cities with genuinely different stations (NYC Central Park vs LaGuardia; Chicago Midway vs O'Hare) and cities where Kalshi's rules don't name a station (generic-city series) still don't merge — that's semantically correct, not a gap.

### 9.4 ❌ "Strip 'International Airport' suffix to align cross-platform"

**Tried and reverted.** Stripping `" International Airport"` / `" Airport"` from station names collapses `"Miami International Airport"` to bare `"Miami"` and `"Los Angeles International Airport"` to bare `"Los Angeles"` — losing the station qualifier entirely. Bare `"Miami"` is ambiguous (could be any weather measurement in Miami) and creates fragile false merges if the catalog ever grows beyond the airport.

The right approach is alias-chain merging (§7.3b): keep the verbose canonical_subject on each side, register both short and long forms as aliases of the same KB entity, let `findOrCreateEntity`'s alias-match path collapse them.

### 9.5 ❌ "Polymarket Template P station extractor handles all stations"

**Bug found**. The original regex was `[^.]+?` which excludes periods — but stations like `"William P. Hobby Airport"` and `"John F. Kennedy International Airport"` contain periods. Switched to `.+?` lazy match capped at `" Station\b"` boundary. Always test station-extraction regex against names containing punctuation.

---

## 10. Related docs

- [edge-investigation-2026-05-24.md](edge-investigation-2026-05-24.md) — initial 432k-edge analysis (graph structure, edge types, cross-platform reach)
- [cross-platform-audit-2026-05-24.md](cross-platform-audit-2026-05-24.md) — diagnostic companion to edge-investigation; root-cause hypotheses
- [audit-work-plan-2026-05-24.md](audit-work-plan-2026-05-24.md) — sized work plan after scoping pass (this doc supersedes the analysis sections of the audit doc)

If you're starting fresh, **read this doc first** then dip into the dated ones for the supporting evidence.
