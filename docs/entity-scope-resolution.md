# Entity scope resolution — sport, league, and cross-platform team unification

This doc explains how Stage 1 stamps `sport_canonical` and `league_canonical`
onto team / person entities so the KB resolves the same real-world team to
the same canonical name regardless of which platform's market mentioned it.

It's the system that fixes the originally-observed problem: a Polymarket
"Arsenal FC" market and a Limitless "Arsenal" market both referring to the
same EPL club ending up as separate KB entities and never matching as
sibling fixtures.

## Why scope matters

`known_entities` enforces uniqueness on `(canonical, sport_canonical, league_canonical)`
with `NULLS NOT DISTINCT`. That means:

- Two rows with `canonical='Houston'` differ legitimately if `sport_canonical='basketball'`
  on one (Houston Rockets) and `sport_canonical='soccer'` on another (Houston Dynamo).
- BUT two rows with `canonical='Arsenal FC'` differing only in `league_canonical`
  (`Premier League` vs `Champions League`) are an UNINTENDED SPLIT — they
  refer to the same club.

So the scope we stamp at INSERT time directly drives whether sibling markets
across platforms / competitions unify or split.

## Where scope comes from

Stage 1's [`tryNormalizeText`](../services/pipeline/src/stage1-normalize/text-deterministic.ts)
derives scope from three sources, in priority order:

1. **Title-extracted scope** (Template Y captures `"… darts match"` /
   `"… tennis match"` suffixes; some templates extract league names from
   prefixes like `"EPL: "`). Strongest signal — the template owner thought
   about it.
2. **Row-level structural signal** (currently unused, reserved).
3. **`inferEntityScope`** — the structural-data fallback. Reads:
   - Kalshi `event_ticker` prefix (e.g. `KXEPLGAME` → Premier League).
   - Polymarket / Limitless / Predict tag bag (`markets.tags[]`,
     `polymarket_events.raw->tags`, `markets.category`).

The resolved league string then runs through `leagueResolver.resolve()`
which normalises it to the KB canonical form (e.g. `UEFA Champions League`
→ `Champions League`).

The final `scope` object is passed to:
- `resolveSubjectAndParticipants()` — for scope-aware T1/T2 KB lookups.
- `scopeToEntityMetadata()` — converts to the metadata patch stamped on
  `resolved_entities[i].metadata` at `registerEntities()` time.

## The four-platform data shapes

| Platform | Signal location | Example |
|---|---|---|
| Kalshi | `mr.raw->>'event_ticker'` (prefix) | `KXEPLGAME-26MAY24CRYARS-CRY` |
| Polymarket | `m.tags[]` + `polymarket_events.raw->tags` | `{Sports, EPL, Soccer, Games, Premier League}` |
| Predict | `m.category` (slug) | `atp-grand-slam-champions-2026` |
| Limitless | `m.tags[]` + `m.category` | `{Football Matches, English Premier League, club_dominance}` |

For tennis specifically (audit 2026-05-21):

| Platform | Tennis markets | How sport is detected |
|---|---|---|
| Kalshi | 2,828 | `KXATPMATCH` / `KXWTAMATCH` / `KXFOMEN` / `KXGRANDSLAM` / `KXITTF` ticker prefixes |
| Polymarket | 525 | tags `{Tennis, ATP, WTA, Roland Garros}` — `ATP` alias resolves to "ATP Tour" league via KB |
| Predict | 5 | slug `atp-grand-slam-champions-2026` — token-splitter finds `atp` → ATP Tour |
| Limitless | 1 | tag `{Tennis}` — sport entity match (no league) |

## KB-driven structural index — runtime updates

The Kalshi ticker prefix mapping is **not hardcoded in source**. It lives in
each league entity's `metadata.platform_signals.kalshi_ticker_prefixes`
array. Example for Premier League in [`seed-entity-kb.ts`](../services/pipeline/src/db/seed-entity-kb.ts):

```jsonc
{
  "canonical": "Premier League",
  "type": "league",
  "metadata": {
    "kind": "league",
    "sport_canonical": "soccer",
    "country": "GB",
    "level": "top_flight",
    "platform_signals": {
      "kalshi_ticker_prefixes": [
        "KXEPLGAME", "KXEPLTOTAL", "KXEPLBTTS",
        "KXEPLSPREAD", "KXEPLGOAL", "KXEPL"
      ]
    }
  }
}
```

At Stage 1 startup, [`loadStructuralSignalsIndex`](../services/pipeline/src/db/entity/structural-signals.ts)
reads every `type='league'` and `type='competition'` row, builds an
in-memory prefix → league index sorted longest-first (so `KXNBAPTS` matches
before `KXNBA`), and logs any prefix-collision warnings.

### Adding a new Kalshi family at runtime — no redeploy

Operator runs ONE SQL UPDATE. Next pipeline run picks it up automatically
when `loadStructuralSignalsIndex()` re-runs.

```sql
-- Add a new prefix to an EXISTING league.  Use jsonb_build_object + || (not
-- jsonb_set!) so missing intermediate paths are created correctly.
UPDATE known_entities
   SET metadata = metadata || jsonb_build_object(
     'platform_signals',
     COALESCE(metadata->'platform_signals', '{}'::jsonb) || jsonb_build_object(
       'kalshi_ticker_prefixes',
       COALESCE(metadata->'platform_signals'->'kalshi_ticker_prefixes', '[]'::jsonb)
         || '["KXNEWPREFIX"]'::jsonb
     )
   )
 WHERE canonical = 'Premier League';
```

Or seed an entirely new league:

```sql
INSERT INTO known_entities (canonical, type, aliases, metadata, domain_category)
VALUES (
  'Saudi Pro League',
  'league',
  '["Saudi Pro League", "Saudi Premier League"]'::jsonb,
  '{
    "kind": "league",
    "sport_canonical": "soccer",
    "country": "SA",
    "platform_signals": {"kalshi_ticker_prefixes": ["KXSAUDIPRO"]}
  }'::jsonb,
  'sports'
);
```

There's still a small in-source `KALSHI_LEAGUE_FAMILIES` array in
[`infer-entity-scope.ts`](../services/pipeline/src/stage1-normalize/infer-entity-scope.ts)
that acts as a fallback for leagues whose seed migration isn't complete yet.
The KB-driven index always wins when both contain the same prefix. Once
every seeded league carries its `platform_signals`, the in-source array
can be emptied.

### Tag-bag KB lookup (Polymarket / Predict / Limitless)

[`lookupTagInKB`](../services/pipeline/src/stage1-normalize/infer-entity-scope.ts)
walks each tag (and slug-split tokens + bigrams) against the warm KB cache
(`_kbByCanonical` ∪ `_kbByAlias`). League/competition rows trump sport
rows, and ambiguous aliases (e.g. `"football"` matches both "american
football" and "soccer") are SKIPPED rather than picked arbitrarily —
falling through to platform-specific terminology fallback patterns.

The only platform-specific patterns kept in source are three Limitless
soccer indicators (`Football Matches`, `club_dominance`, `Off the Pitch`)
that aren't KB entities and have no clean home in the seed. Add new
patterns sparingly — the cleaner fix is usually to add an alias to an
existing KB entity.

## Cross-league competitions — the splitting hazard

Stamping `league_canonical` is dangerous when the league is a **cross-league
competition** (UCL, Europa League, Conference League, FIFA World Cup,
tennis Grand Slam). Teams in those competitions come from many different
HOME leagues:

- Arsenal plays in EPL (home league) AND Champions League (cross-league competition).
- Bayern plays in Bundesliga AND Champions League.
- France national team plays in FIFA World Cup AND friendlies.

If a UCL market stamps `league_canonical='Champions League'` on Arsenal,
the KB ends up with TWO Arsenal entities — one with `league='Premier League'`,
one with `league='Champions League'` — because the unique constraint
`(canonical, sport_canonical, league_canonical) NULLS NOT DISTINCT` treats
them as distinct, and `isScopeIncompatible` in [`register.ts`](../services/pipeline/src/db/entity/register.ts)
refuses to merge them.

### How we prevent the split

KB league entities marked `metadata.cross_league: true` cause Stage 1
inference to drop `league_canonical` from the scope, returning sport-only.

```jsonc
// services/pipeline/src/db/seed-entity-kb.ts
{
  "canonical": "Champions League",
  "type": "league",
  "metadata": {
    "kind": "league",
    "sport_canonical": "soccer",
    "level": "top_flight",
    "cross_league": true,         // ← THIS
    "platform_signals": { "kalshi_ticker_prefixes": ["KXUCLGAME", "KXUCL", …] }
  }
}
```

Currently flagged cross_league:
- `Champions League`, `Europa League`, `Conference League` (UEFA cross-league soccer)
- `FIFA World Cup` (national teams from different home leagues)
- `Grand Slam` (tennis cross-tour)

Adding more is one SQL UPDATE: `UPDATE known_entities SET metadata = metadata || '{"cross_league":true}'::jsonb WHERE canonical = '…';`.

### Person entities — never stamp league

[`scopeToEntityMetadata`](../services/pipeline/src/db/entity/types.ts) NEVER
stamps `league_canonical` for `type='person'`. Individual-sport players cross
tours / competitions all the time (Carlos Alcaraz plays ATP Tour AND Grand
Slams; Tiger Woods plays PGA Tour AND European Tour AND LIV Golf). Stamping
league on players would split the same player into per-tour rows.

Players still get `sport_canonical` stamped — that's stable (Alcaraz is
always tennis).

## Esports umbrella ↔ specific-game hierarchy

The KB seeds `esports`, `dota 2`, `cs2`, `league of legends`, `valorant`,
`rocket league`, `starcraft 2`, `call of duty`, `rainbow six`, `overwatch 2`
as peer `type='sport'` rows.  That works for direct identity (a market
about Valorant stamps `sport_canonical='valorant'`) but leaves a hierarchy
gap: **`esports` is the umbrella, the others are specific games under it.**

The hazard mirrors the cross-league splitting hazard above — the same
real-world team can arrive with different sport granularity depending on
which platform's tag-bag it came from:

| Platform | Tag-bag for a Dota 2 team market | Inferred sport (pre-fix) |
|---|---|---|
| Limitless | `{Sports, Esports, Limitless, Lumy}` | `esports` (umbrella only) |
| Polymarket | `{Sports, "Dota 2", Esports, Games}` | first match wins — could be either |
| Predict | slug `dota2-rnx-ngx-2026-05-10` | `dota 2` (game from slug) |
| Stage 1 templates | title `"Dota 2: REKONIX vs Nigma Galaxy"` | `dota 2` (game from title) |

Before the hierarchy fix, the umbrella row and the specific-game row were
treated as incompatible by `isScopeIncompatible` and the
`(canonical, sport_canonical, league_canonical) NULLS NOT DISTINCT` unique
constraint inserted them as separate `known_entities` rows.

### How the system unifies umbrella with specific games

The relation is enforced once at every resolver layer the same entity can
travel — Stage-1 scope inference, T1 cache lookup, T2 ANN, and the
register-side merge — all reading from
[`sport-hierarchy.ts`](../services/pipeline/src/db/entity/sport-hierarchy.ts):

1. **`areSportsCompatible(a, b)`** — declares the umbrella↔child relation
   in one place. Returns true when the two sport canonicals are equal OR
   when one side is `'esports'` and the other is in `ESPORTS_GAMES`.

2. **`register.ts:isScopeIncompatible`** — calls `areSportsCompatible`
   so Pass 1 / 2 / 3 / 3b in `findOrCreateEntity` stop refusing the merge.

3. **`register.ts` Path 1 canonical SQL filter** — broadened via
   `sportCompatibilityCandidates(incomingSport)` to include the umbrella
   counterpart, so a `sport='esports'` row in the DB is visible to a
   lookup carrying `incomingSport='dota 2'` (and vice versa). The JS-side
   `isScopeIncompatible` makes the final compatibility call.

4. **`register.ts:mergeEntityMetadata`** — when the merge happens, detects
   the umbrella → game upgrade case via `moreSpecificSport` and writes
   the specific game over the umbrella value (otherwise the
   first-write-wins JSONB merge would freeze the umbrella in place).

4b. **`worker.ts:prepareEnrichment`** — same upgrade applied on the
   enrichment worker's UPDATE path. The worker merges
   `{ ...resultMetadata, ...currentMetadata }` (existing wins) which would
   otherwise refuse to upgrade an `esports` row even when the LLM /
   heuristic resolved `cs2` from Limitless's `esportTitle` or a Polymarket
   tag. The override mirrors the register-side upgrade so both write paths
   converge on the specific game.

5. **`cache.ts:_t1FromCache` Tier-1 sport axisScore** — treats a row whose
   `sport_canonical='esports'` as scope-agnostic-equivalent (score=1)
   when the caller's `scope.sport` is a specific esports game, and
   symmetrically.  Without this, T1 filtered the umbrella row out and
   the caller fell through to T2 even when the right row was sitting
   right there.

6. **`resolvers.ts:SubjectEntityResolver.resolveViaEmbedding`** — the
   Tier-2 ANN `scopeCompatible` helper calls `areSportsCompatible` so
   cosine-1.000 candidates like `"Invictus Gaming"` (candidate row
   `sport='esports'`) are accepted when the incoming hint is
   `sport='league of legends'` instead of being scope-rejected.

7. **`infer-entity-scope.ts` Pass B** — when the tag-bag yields both the
   umbrella and a specific game in the SAME market, the specific game
   wins regardless of tag order. The umbrella is held only as a fallback
   for markets that name no specific game at all.

**Where the umbrella↔child check does NOT apply (deliberately):**
different specific games (e.g. `cs2` vs `league of legends`) remain
incompatible. Esports orgs commonly field rosters across multiple games
— NAVI's CS2 roster and NAVI's LoL roster are different teams with
different rosters and different match outcomes. Keeping them as separate
KB rows is the correct behaviour; the `Scope conflict on alias merge`
warning that fires for such pairs is informational, not a bug.

### Net effect

An entity that first lands via a Limitless market (no game name in tags)
gets `sport='esports'`. The very next sync where the same team appears on
Predict or Polymarket with the game named, the existing umbrella row is
found via canonical match, the umbrella↔game compatibility check passes,
and the kept row's `sport_canonical` is **upgraded** from `esports` to
`dota 2`. No duplicate row, no `Scope conflict on alias merge` warning.

Markets that legitimately only carry the umbrella (no game-specific signal
anywhere) keep `sport='esports'` as a terminal state — the system never
guesses which game a generic-esports market belongs to.

### Adding a new esports game

1. Seed it as a `type='sport'` row in
   [`seed-entity-kb.ts`](../services/pipeline/src/db/seed-entity-kb.ts)
   alongside the existing games (dota 2, cs2, league of legends, valorant,
   ...).
2. Add the canonical (lowercased) to `ESPORTS_GAMES` in
   [`sport-hierarchy.ts`](../services/pipeline/src/db/entity/sport-hierarchy.ts).
   This is the only place the umbrella↔child relation is declared; the
   resolver paths read from this set.
3. Add platform-specific signal patterns where applicable:
   - Title regexes in `WIN_THE_MATCH_SPORT_KEYWORDS` /
     `WIN_THE_MATCH_EVENT_SPLIT_RX` ([text-deterministic.ts](../services/pipeline/src/stage1-normalize/text-deterministic.ts))
     if the game appears in title prefixes.
   - LEAGUE_KEYWORDS in [enrich-entity-metadata.ts](../services/pipeline/src/db/enrich-entity-metadata.ts)
     if the game's name appears in scraper tag bags.

## End-to-end verification — what works today

Cross-platform unification verified against live data for these scenarios:

| Same fixture across platforms | All three teams resolve to one KB row? |
|---|---|
| EPL Arsenal vs Burnley: Polymarket exact_score + Limitless BTTS + Kalshi `KXEPLGAME` | ✅ All stamp `sport='soccer', league='Premier League'` → Pass 1 match |
| UCL Arsenal: Polymarket UCL market + Kalshi `KXUCLGAME` (different home leagues across legs) | ✅ Both drop league_canonical via cross_league flag → Pass 1 matches existing Arsenal_EPL row by canonical+sport |
| Tennis Alcaraz: Polymarket ATP + Kalshi `KXFOMEN` (French Open) | ✅ Person entities never get league stamped → single Alcaraz row |
| NBA Lakers: Polymarket + Kalshi `KXNBAGAME` | ✅ Both stamp `sport='basketball', league='NBA'` |
| Dota 2 REKONIX: Limitless (tags `Esports` only) + Predict (slug `dota2-…`) + Polymarket (tags `"Dota 2", Esports`) | ✅ Limitless lands as `sport='esports'`; Predict/Polymarket merge via umbrella↔game compatibility and upgrade kept row to `sport='dota 2'` |

| Within-platform competition cases | Same team across competitions unified? |
|---|---|
| Arsenal in EPL match AND Arsenal in UCL match (both Polymarket) | ✅ UCL market drops league (cross_league); EPL market sets it; Pass 1 finds EPL row, no split |
| Bayern in Bundesliga AND UCL | ✅ Same as above |
| Alcaraz in ATP tournament AND French Open | ✅ Person — no league ever |
| REKONIX in Polymarket Dota 2 AND Limitless generic Esports | ✅ Umbrella↔game compatibility in `isScopeIncompatible` + sport upgrade in `mergeEntityMetadata` |

## The full Stage 1 chain — what stamps what

```
Market row
  │
  ▼
tryNormalizeText (text-deterministic.ts)
  │
  ├── matchTemplate(row) → tpl (regex match, may set tpl.sport_canonical)
  │
  ├── inferEntityScope({platform, event_ticker, tags, market_category, parent_event_tags})
  │      │
  │      ├── Kalshi ticker prefix
  │      │    ├── (a) Dynamic KB index from metadata.platform_signals  ← runtime-updatable
  │      │    └── (b) KALSHI_LEAGUE_FAMILIES in-source fallback
  │      │
  │      └── Tag-bag KB lookup
  │           ├── Pass A: league/competition match (cross_league filter applied)
  │           ├── Pass B: sport entity match (specific esports game beats umbrella `esports`)
  │           └── Pass C: SPORT_ONLY_FALLBACK_PATTERNS for platform terminology
  │
  ├── scope = { sport: tpl.sport ?? row.sport ?? inferred.sport,
  │             league: leagueResolver.resolve(tpl.league ?? inferred.league) }
  │
  ├── resolveSubjectAndParticipants(subject, participants, domain, scope)
  │      └── KB T1/T2/T3 resolution; scope filters incompatible same-name rows
  │
  ├── scopeMetadata = scopeToEntityMetadata(scope, tpl.entity_type)
  │      ├── type='team'   → {sport_canonical?, league_canonical?}   ← league only when not cross-league
  │      ├── type='person' → {sport_canonical?}                       ← never league
  │      └── other types   → {}
  │
  ├── resolved_entities[i] = { canonical, type, aliases, metadata: scopeMetadata }
  │
  └── registerEntities(market_id, canonical_subject, resolved_entities, domain)
         │
         ├── For each entity:
         │    ├── Pass 1: canonical match with scope filter (esports umbrella↔game
         │    │           candidates expanded via sportCompatibilityCandidates)
         │    ├── Pass 2: alias match
         │    ├── Pass 3: token fuzzy match with scope guard
         │    │           (isScopeIncompatible treats esports↔game as compatible)
         │    ├── mergeEntityMetadata: upgrade existing sport='esports' to the
         │    │   specific game when the incoming entity names it
         │    └── INSERT new row with metadata.sport_canonical / league_canonical
         │         (generated columns auto-populate from metadata)
         │
         └── market_entity_links junction row
```

## Alias vs canonical — the third splitting hazard

Beyond the umbrella-vs-game hierarchy, there's a subtler splitting pattern:
**emitting a KB alias as `sport_canonical` instead of the canonical itself.**

The KB seeds, for example, `canonical='cs2'` with aliases `['counter-strike 2',
'csgo', 'cs:go', ...]`. A Stage-1 template that returns the alias string
`'counter-strike 2'` for the detected sport produces an entity with
`metadata.sport_canonical='counter-strike 2'`. Another platform's Stage-1
path producing the canonical `'cs2'` would then look like a scope conflict
under `(canonical, sport_canonical, league_canonical) NULLS NOT DISTINCT`
even though both refer to the same sport — splitting the team's KB row.

`registerEntities` defends against this by calling
[`resolveTaxonomyCanonical`](../services/pipeline/src/db/entity/taxonomy.ts)
(in-process warm KB cache lookup, alias-aware, hyphen/underscore-normalised)
on every incoming `metadata.sport_canonical` and `metadata.league_canonical`
**before** any matching or stamping. Aliases get normalised to their KB
canonical form regardless of which template / heuristic emitted them.

Truly novel values (a sport not yet seeded in KB) are left untouched — the
LLM enrichment path will either resolve them through its slow path or
T3-create a new `type='sport'` row.

Stage-1 emitters are still expected to use canonicals directly (see
`WIN_THE_MATCH_SPORT_KEYWORDS` in
[text-deterministic.ts](../services/pipeline/src/stage1-normalize/text-deterministic.ts)
and `KNOWN_SERIES_MAP` in
[kalshi-deterministic.ts](../services/pipeline/src/stage1-normalize/kalshi-deterministic.ts));
the register-side canonicalisation is defence-in-depth, not a license to
emit aliases freely.

## Failure modes — known limitations

1. **KB seed not re-run after code change.** The cross_league flags and
   platform_signals only take effect after the seed is applied (idempotent
   `INSERT … ON CONFLICT DO UPDATE`). Until then, Stage 1 falls back to
   the in-source `KALSHI_LEAGUE_FAMILIES` (no cross_league filter), and
   UCL Arsenal would still split.

2. **Tag bags with no KB match.** If a market's tags don't include any
   recognizable league/sport/alias AND the platform isn't Kalshi,
   `inferEntityScope` returns null. The entity registers without scope
   metadata (`{kind: 'team'}` only) and depends on the post-hoc
   `enrichEntityMetadata` (Stage 1d) to fill via tag keywords — which has
   its own coverage gaps for impoverished tag sets.

3. **Sport-only fallback can't disambiguate.** Limitless "Football" tag
   matches both soccer AND american football aliases in KB. The
   disambiguation rule (skip on multi-match) lets the platform-specific
   `club_dominance` fallback catch it. But a market tagged ONLY
   `{Football, Lumy}` on Limitless would still return null.

4. **Player team affiliation.** A player who changes teams (transfer
   between leagues) won't get a re-stamp on their existing row — the
   stamping is one-time at INSERT. If the player was first seen in
   `tennis` context and later appears in `golf` context (rare for
   real players), the KB has them as tennis. Esports umbrella → game is
   the ONE re-stamp the merge path performs (see hierarchy section
   above); other sport changes are not auto-upgraded.

## How to verify it's working

```sql
-- 1. Confirm structural signals loaded
SELECT canonical, metadata->'platform_signals'->'kalshi_ticker_prefixes' AS prefixes,
       metadata->>'cross_league' AS cross_league
  FROM known_entities WHERE type='league'
   AND (metadata->'platform_signals' IS NOT NULL OR metadata->>'cross_league' IS NOT NULL)
ORDER BY canonical;

-- 2. Confirm a key team has sport scope after Stage 1 ran
SELECT canonical, sport_canonical, league_canonical, metadata
  FROM known_entities WHERE canonical IN ('Arsenal FC', 'Burnley', 'Real Madrid CF');

-- 3. Confirm cross-platform team unification: same canonical across all platforms
SELECT n.canonical_subject, COUNT(DISTINCT m.platform) AS platforms,
       array_agg(DISTINCT m.platform) AS platform_list
  FROM llm_market_normalizations n
  JOIN markets m ON m.id = n.market_id
 WHERE n.canonical_subject = 'Arsenal FC'
 GROUP BY 1;
-- Expect platforms ≥ 2 if cross-platform unification is working
```

## Adding a new league/sport — operator checklist

1. **Seed the entity** if not already present (via [`seed-entity-kb.ts`](../services/pipeline/src/db/seed-entity-kb.ts)
   followed by re-running the seed; or via direct INSERT for runtime).
2. **Set `metadata.sport_canonical`** to the canonical sport name (must
   match an existing `type='sport'` row in KB, otherwise the generated
   column populates from a non-existent sport).
3. **Add `metadata.platform_signals.kalshi_ticker_prefixes`** if Kalshi
   has ticker families for this league. Prefixes go in DESCENDING
   specificity order (longest matches first ARE selected first by the
   loader's sort).
4. **Add `metadata.cross_league: true`** ONLY if the league is a
   cross-league competition (teams from multiple home leagues compete).
   Domestic top-flight leagues (NBA, EPL, Bundesliga, MLS, etc.) leave
   this off.
5. **Re-run Stage 1** so the dynamic signals index reloads and
   `enrichEntityMetadata` re-stamps existing entities.

For high-stakes additions, run the inference test suite:
`bun test src/stage1-normalize/infer-entity-scope.test.ts`
