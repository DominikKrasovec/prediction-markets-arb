# Structural-edge rebuild

> STATUS (as of 2026-07-02): the four builders described here have SHIPPED —
> `same-event.ts` primitives + `numeric-ladder-xq`/`exact-score-derived`/
> `mutual-exclusion-xq`/`equivalence-edge` builders (3ca5679, 2026-06-05) plus
> the exact_score cross-kind family (~39k edges, 3a6a3ec/8e1f25d, 2026-06-07),
> `spread-winner` (70f57ff, migration 077, 2026-06-11), La-Liga drift (3a6a3ec),
> the RC1 home/away veto in `sameFixtureFragment` (f2ae0be, 2026-06-13),
> migration 064 `chk_edges_pattern` allow-list, and per-builder
> `statement_timeout` lift (23ab6d9, 2026-06-08). This doc remains the ordinal /
> same-event SPEC — but where it disagrees with `same-event.ts`, the CODE is
> truth (drift annotated inline below). The `stage4-events/` builder set is now
> much broader than the four listed (fixture-totals, margin-winner,
> scorer-implication, reach-threshold-chain, sigma-contradiction-belt, …).

Working spec for the deterministic cross-question edge layer that replaces the
retired Stage-3 implication rule zoo. Each consuming rule (numeric-ladder,
exact-score, mutual-exclusion, equivalence) is a deterministic EDGE builder, not
a hash-merge. This doc collects the shared primitives those builders depend on.

## `same_resolving_event` predicate

`services/pipeline/src/stage4-events/same-event.ts` ships the reusable
deterministic gate every cross-question edge rule MUST call before asserting an
edge between two outcome-nodes. It answers "do these two nodes resolve on the
SAME underlying happening?" and returns `'same' | 'different' | 'indeterminate'`.

### Why it exists (the verified live-data trap)

BO3/BO5 esports maps share `canonical_event` (all three "Heretics vs Gentle
Mates" maps), AND on Kalshi every map of a match carries the SAME
`occurrence_datetime` / minute-precision `condition_date`. So
subject + date + event_kind ALONE cannot separate Map 1 from Map 2 — fusing
them manufactures a fake arb. The only separator is the per-game / period
ORDINAL that lives BELOW `canonical_event`:

- **title text** — `"map 2"`, `"Map 2: …"` (the primary source)
- **Kalshi `event_ticker` suffix** — `"…MHPAR-2"` (originally intended as a
  fallback ordinal source)
- NOT `yes_sub_title` — verified `yes_sub_title="Over 2.5 maps"` is a
  series-total, not a per-game ordinal.

**Ordinal source precedence: title > Kalshi `event_ticker` suffix; NOT
`yes_sub_title`.**

> CODE DIVERGENCE (3ca5679): the `event_ticker` suffix fallback was REJECTED in
> the shipped `sameEventFragment` — its ORDINAL SOURCE WARNING now says "feed
> `game_ordinal()` the market TITLE only. Do NOT feed the raw Kalshi
> `event_ticker` '-N' suffix as an ordinal — ~43% of '-N' tickers are
> draft-rank / election-place / strike-index series (KXNBADRAFTPICK-3, …), not
> per-game ordinals (verified 627/1443)." Title is the ONLY ordinal source in code.

### The 3 tiers

1. **Tier 1 — within-platform identity.** Same `platform_event_id` AND ordinals
   match (both NULL, or equal int) → `'same'`.
   - **CONFIRMED (live probe):** Polymarket files ALL maps of a match under ONE
     `platform_event_id` (11,331 `"Map N: … Total Kills"` rows are
     `match_total_metric` under a single pe). So `platform_event_id`-equality
     ALONE is NOT sufficient — it would fuse Map 1 and Map 2. Tier 1 therefore
     requires same pe **AND** a matching ordinal.
2. **Tier 2 — cross-platform same-event.** All of: equal `event_kind`
   (NULL-tolerant — if either side is NULL we do NOT assert via Tier 2);
   sport/league compatible (NULL-tolerant, same rule as `ann-candidates`);
   equal `canonical_event` after light normalization
   (`lower(immutable_unaccent(btrim(…)))` in SQL; NFKD+strip-combining+lower+trim
   in TS); precision-aware date match (the EXACT `ann-candidates.ts` ladder,
   reusing `config.pairing.sameEvent*ToleranceMs`); and ORDINAL MATCH → `'same'`.
3. **Tier 3 — refusal.** If Tiers 1-2 fail AND the kind is a DECISIVE sports kind
   → `'indeterminate'` (NOT `'different'`). Otherwise `'different'`.

### DECISIVE_KINDS refusal — what it covers and what protects the rest

`DECISIVE_KINDS = {match_winner, championship_winner, halftime_leader,
both_teams_score}`.

- The refusal covers **winner-type** kinds where regulation-vs-overtime
  **scope** decides resolution and that scope is NOT yet rolled to the node grain
  (`resolution_scope` is per-market on `markets`, migration 052, but not on
  `platform_events` / `questions`). For those, "no ordinal" is genuinely
  ambiguous, so we refuse rather than guess.
- The refusal does NOT and need not cover the DOMINANT per-map family,
  `match_total_metric` (the 11k+ "Map N: … Total Kills" rows). That family is
  protected by the **ordinal-match requirement** in Tiers 1-2, not by the
  decisive refusal. An ordinal mismatch on a non-decisive kind correctly returns
  `'different'` — adjacent maps / candles are distinct happenings, not ambiguous.

### Precision-aware date ladder (single source of truth)

Mirrors `stage3-events/ann-candidates.ts` exactly, reading
`config.pairing.sameEvent*ToleranceMs`:

- NULL date either side → pass (open-ended markets stay pairable)
- year/month precision either side → skip date (futures match by name)
- both minute → within `sameEventCryptoToleranceMs` (±4 min, sub-candle so
  adjacent 5-min candles never cross)
- hour either side → within `sameEventHourToleranceMs` (±1 h)
- else → same calendar (UTC) day

### Ordinal extraction (`game_ordinal`)

`parseGameOrdinal(text)` (TS) and `game_ordinal(text)` (IMMUTABLE SQL) derive
from the SAME spec:

- FIRST match wins.
- `/\b(?:map|game|set|leg|frame)\s*#?\s*([1-9])\b/i` — allows digit 1-9 so NBA
  "Game 7" parses (word forms stop at 4). (Code `GAME_ORDINAL_RX` carries `\b`
  word-boundaries.)
- Word-form period ordinals: `1st|2nd|3rd|4th|first|second|third|fourth` before
  `half|quarter|period|set|map|game|inning` → 1..4.
- NEUTRAL (returns NULL) on series-level totals: `total maps/games/sets`,
  `best of N`, `over/under N maps/games/sets`. These are NOT per-game ordinals
  (verified `yes_sub_title="Over 2.5 maps"`). The series-total guard runs FIRST.
- NULL = "whole-match granularity" — correct for fixture-level winner markets
  that genuinely have no per-game split.

> CODE ADDS THREE MORE ARMS (spec above is STALE; `same-event.ts` is truth). The
> shipped `parseGameOrdinal` / `game_ordinal()` order is: series-total guard →
> `GAME_ORDINAL_RX` → word-form (`WORD_PERIOD_RX`) → **`PERIOD_DIGIT_RX`**
> (digit-form period ordinals, both orders: noun-first "period 2"/"inning 5" AND
> digit-first "5th inning"/"7th game" — covers N>4) → **`ABBREV_PERIOD_RX`**
> (betting-line markers 1H/2H, 1Q–4Q, H1/H2 → 1..4; 3ca5679) → **`HALFTIME_MARKER_RX`**
> checked LAST (bare "halftime"/"half-time"/"at (the) half" → ordinal 1; xplat
> finding #4, 9523156, 2026-07-02). All mirrored in the SQL `game_ordinal()`.
>
> TWO NEGATIVE GUARDS (parser mis-extraction census 2026-07-02 §1):
> **`FISCAL_PERIOD_RX`** — the abbreviated arms refuse when the Qn/nH/Hn token is
> year-adjacent ("Q2 2026", "Q2 of 2026", "Q2 FY2026", "2026 Q2"): those are
> fiscal quarters / half-years on econ & earnings titles (652 live non-sports
> questions carried a false ordinal), never betting-line markers.
> **`SEASON_GAME_PROSE_RX`** — the word-form + digit-ordinal-first arms refuse on
> "<ordinal> game/match of the [<year>] season" (deadline prose, 9 live rows).
> Both guards are mirrored per-arm (`AND NOT t ~* …`) in the SQL twin; live
> before/after 2026-07-02: 0 sports titles change ordinal.

TS/SQL parity is smoke-tested: a shared corpus runs through `parseGameOrdinal`
(unit test) and `game_ordinal()` (live-DB probe) and must agree. Postgres POSIX
regex uses `\m…\M` word boundaries and the `~*` / `(?i)` case-insensitive forms
(no JS `\b`).

### SQL surface

- `installSameEventSql()` — idempotent `CREATE OR REPLACE FUNCTION … IMMUTABLE`.
  Installed from code at the top of `runStage4()` (finalize.ts), NOT a migration,
  so it travels with a fresh DB wipe. No schema change required.
  > UPDATE (78c114a, audit #9): it now installs TWO functions — `game_ordinal(text)`
  > AND `league_stage_fold(text)` (the unified taxonomy `foldLeagueKey`: leading
  > season/year strip + stage-suffix strip + despace/lowercase; mirrors
  > `db/entity/taxonomy.ts`, keep in sync). The Tier-2 league conjunct folds via
  > `league_stage_fold` so 'La Liga'='LaLiga' and 'NBA Playoffs'='NBA'.
- `sameEventFragment(a, b)` — a WHERE/ON snippet a rule-builder drops between two
  node-fact CTE aliases. Asserts Tier 1 (pe + ordinal) OR Tier 2. The builder is
  responsible for the Tier-3 DECISIVE_KINDS refusal wrapping
  (`DECISIVE_KINDS_SQL` is exported for that).

### The node-fact join-CTE (TIMESTAMPTZ requirement)

Today feed-A nodes lack `condition_date` / ordinal / `platform_event_id` at the
node grain, so each consuming rule builds a join-CTE supplying the fixed column
shape the fragment expects:

```
platform_event_id (text), event_kind (text), sport (text), league (text),
canonical_event (text), condition_date (TIMESTAMPTZ), condition_date_precision (text),
title (text)
```

> SHIPPED (3ca5679): the join-CTE is no longer hand-built per rule — it is the
> single audited `nodeFactsCte()` in `stage4-events/node-facts.ts:106` (all
> consuming rules import it so they cannot drift). The shipped column shape has
> GROWN: it also carries `resolution_scope (text)` (migration 058; consumed by
> the FT/ET scope guard) plus `participants`, `metric_scope`, and
> `fixture_end_date` (markets.end_date of the rep member) for `sameFixtureFragment`.

**`condition_date` must be sourced as TIMESTAMPTZ.** It is TEXT on `questions` /
`llm_market_normalizations` and TIMESTAMPTZ only on `platform_events`. The CTE
therefore takes `condition_date` (+precision), `canonical_event`, `event_kind`,
`sport_canonical` / `league_canonical` from **`platform_events`**, and
`platform_event_id` + `title` (+ `market_metadata_raw.raw->>'event_ticker'` for
the Kalshi ordinal fallback) from `markets` / `market_metadata_raw`. The fragment
casts defensively (`::timestamptz`) so the EPOCH arithmetic stays valid.

When finalize is later extended to project these onto `questions` directly, the
CTE collapses to column reads — only the source-of-fields CTE changes, the
fragment is unchanged.

### Future relaxation path (out of Phase-0 scope) — MOSTLY SHIPPED

> SHIPPED (migration 058 `resolution_scope_rollup`, 3ca5679 + finalize
> projection): `resolution_scope` is now rolled up to `platform_events` (mode,
> mixed→unspecified) and projected onto `questions` (mixed→NULL). The single
> migration `058_resolution_scope_rollup.sql` covered both tables (not the two
> separate files this note predicted). `NodeFacts.resolutionScope` +
> `scopeKnownCompatible()` implement the CONSERVATIVE guard: a whole-match
> DECISIVE pair asserts `'same'` only when BOTH scopes are known-equal, else
> refuses. Two shipped EXEMPTIONS loosen the blanket refusal without new data:
> `isCompetitionGrainChampionship()` (775f95d, 2026-06-10 — a competition-grain
> `championship_winner` "wins the trophy" has no FT/ET ambiguity) and
> `NO_OVERTIME_CONCEPT_SPORTS` (509de3f, audit-r2 #3a — esports/tennis/volleyball
> have a single settlement basis). Known-conflicting concrete scopes still refuse.

The Tier-3 `'indeterminate'` refusal trades recall for soundness. Recall is
recovered when `resolution_scope` (regulation vs incl_overtime) is rolled up to
`platform_events` (mode, like `event_kind` in `rollup-event-identity.ts`
Phase 1b) and projected onto `questions`. With per-node scope known, a
decisive-kind pair whose scopes are both known and differ becomes `'different'`
(not refused), and matching scopes with a confirmed ordinal becomes `'same'`.
This needs `NNN_platform_event_resolution_scope.sql` +
`NNN_questions_resolution_scope.sql` and is a separate task.
