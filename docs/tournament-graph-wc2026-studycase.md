# Tournament graph — FIFA World Cup 2026 study case (2026-05-31; Tier B §7 added 2026-06-11)

The pilot for the tournament-structure layer (pipeline doc §12). Goal: from ONE real competition,
derive (a) the **generalizable `format_spec`** every competition needs, (b) the **edge-derivation
rules** that turn it into `implication_edges`, and (c) the **onboarding prompt** that extracts a
`format_spec` from web rules for the next competition. Grounded in the real WC events in the DB +
the official 2026 format. Companions: pipeline doc §4b (structural edges), §12 (tournament agent),
[[event-centric-stage2a-entity-resolution]] §16 (why this is the cross-event layer).

---

## 1. The real nodes we have (the graph is not hypothetical)

Measured `platform_events` whose title mentions the WC (the umbrella questions = graph nodes):

| Structural role | Real event examples (platform) | Edges? |
|---|---|---|
| **champion** | "2026 FIFA World Cup Winner" (poly/kalshi/predict) | yes — ladder top |
| **continent / confederation** | "Continent to Win the Men's World Cup" (kalshi) | yes — KB superset target |
| **reach_final** | "2026 FIFA World Cup: Nation to Reach Final" (poly) | yes — ladder |
| **reach_sf** | "World Cup Semifinals Qualifiers" (kalshi) | yes — ladder |
| **reach_qf** | "World Cup Quarterfinals Qualifiers" (kalshi) | yes — ladder |
| **reach_r16 / knockout** | "World Cup Round of 16 Qualifiers" (kalshi); "Team to advance to Knockout Stage" (poly) | yes — ladder |
| **group_advance** | "Will France qualify from World Cup Group I?" (kalshi) | yes — ladder + combinatorial |
| **group_winner** | "FIFA World Cup Group A Winner" (poly); "World Cup Group A Winner: Czechia" (predict) | yes — group Σ + ⟹ advance |
| **match_result** | the group/knockout "A vs B" fixtures | combinatorial (live) |
| **orthogonal_prop** | "Nation of Top Goalscorer", "Golden Boot", "Brazil: World Cup Squad" | **none** — independent islands |
| **non_structural noise** | "Trump attend the Final?", "game played in Massachusetts", "halftime performer" | **none** — never wire |

**All four platforms carry the WC — they just title it differently (the matcher's whole job).** The
individual game markets exist everywhere but only Limitless says "World Cup" in the market title:

| Same match | Kalshi | Polymarket | Limitless |
|---|---|---|---|
| Argentina v Algeria | `KXWCGAME` "Argentina vs Algeria Winner?" | tag `fifa-world-cup` "Argentina vs. Algeria" | "World Cup, Argentina vs Algeria, Jun 17, 2026" |
| Czechia v Mexico | (KXWCGAME, A/Draw/B) | "Czechia vs. Mexico" | "World Cup, Czech Republic vs Mexico, Jun 25, 2026" |

Counts: Kalshi `KXWCGAME` = 54 game markets (+ `KXWCSTAGEOFELIM` 47, `KXWCGROUPQUAL`/`KXWCGROUPWIN` 12
each, `KXWCROUND` 4, `KXWCCONTINENT` = the superset target, `KXWCAWARD`/`KXWCSQUAD`/`KXWCGOALLEADER`);
Polymarket carries the games as `"TeamA vs. TeamB"` (3-way) + the futures; Predict carries WC futures /
group-winner markets but appears to lack the per-game markets (its "matches" are esports). This is the
cross-platform matching surface — same match, **different title, date source, and entity spelling**
(`Czechia`↔`Czech Republic`, `Bosnia and Herzegovina`↔`Bosnia-Herzegovina`, `DR Congo`↔`Congo DR`) —
exactly what embed→ANN→LLM + KB canonicalization + the §13 date gate exist to reconcile.

**Two hazards the study case surfaces up front:**
1. **Competition disambiguation.** "World Cup" also matches **Cricket World Cup, T20 World Cup,
   Esports World Cup, ICC ... World Cup League Two** (all present in the DB). The tournament_state is
   keyed to a specific KB competition entity — `(competition, edition, sport)` — NOT the string
   "world cup". This is the §15 group-scoping discipline at the competition level.
2. **Not every node is structural.** Props (top scorer, squad) are orthogonal islands; trivia (Trump,
   venue, halftime) is noise. The `node_roles` map must be specific enough to *exclude* both — a
   wrongly-wired prop manufactures a fake implication.

---

## 2. The generalizable `format_spec` (the structure to put in place)

> CODE PIVOT (T4, 2026-06-07 — `stage4-events/tournament-edges.ts` is truth):
> the SHIPPED `TournamentFormatSpec` implements a SUBSET of this design plus a
> GATED-field node source. Live role classification does NOT use the `node_roles`
> title regex (retained only for the onboarding / non-Kalshi path); it uses
> `seriesResolvers` + `kalshiEventTickerPrefix` reading the Kalshi
> `event_ticker` + `yes_sub_title` ONLY (blocker B — `pe.title` is leak-poisoned,
> see `[[project_entity_value_label_leak]]`). Shipped spec keys:
> `reachLadder`, `extraImplications`, `supersets`, `nodeRoles`,
> `competitionTitleAliases`, `kalshiEventTickerPrefix`, `seriesResolvers`,
> `finalFixture` (F2 rule), `groupAggregate` + `hostAggregate` (Tier B). The
> `stages[]`/`bracket`/`draw` design keys live on as out-of-code reference data
> in the live `tournament_states.format_spec` jsonb (merge-upsert preserves them).

One JSON document per competition edition, persisted as `tournament_states.format_spec` (pipeline doc
§12). Designed to cover groups+knockout (WC), pure knockout (most cups), and round-robin leagues by
varying `stages[].kind`. WC 2026 instance (format confirmed from official sources — see §6):

```jsonc
{
  "competition": {
    "canonical": "FIFA World Cup",
    "edition": "2026",
    "sport": "soccer",
    "kb_competition_aliases": ["FIFA World Cup", "Men's World Cup", "2026 World Cup", "World Cup"],
    "disambiguation": "men's association football; NOT Cricket/T20/Esports/Women's World Cup"
  },

  // Ordered stages. `order` ascending = earlier in time / easier to reach.
  "stages": [
    { "id": "group", "kind": "round_robin_groups", "order": 0,
      "groups": ["A","B","C","D","E","F","G","H","I","J","K","L"],
      "teams_per_group": 4, "matches_per_team": 3,
      "advancement": { "top_n_per_group": 2, "plus_best_ranked": { "place": 3, "count": 8 },
                       "advance_to": "r32",
                       "tiebreakers": ["goal_diff","goals_scored","head_to_head","fair_play","lots"] } },
    { "id": "r32",   "kind": "knockout", "order": 1, "slots": 32, "advance_to": "r16" },
    { "id": "r16",   "kind": "knockout", "order": 2, "slots": 16, "advance_to": "qf" },
    { "id": "qf",    "kind": "knockout", "order": 3, "slots": 8,  "advance_to": "sf" },
    { "id": "sf",    "kind": "knockout", "order": 4, "slots": 4,  "advance_to": "final" },
    { "id": "final", "kind": "knockout", "order": 5, "slots": 2,  "advance_to": "champion" },
    { "id": "third_place", "kind": "knockout", "order": 5, "slots": 2, "side_branch": true }
  ],

  // The monotonic implication chain (deepest ⟹ shallowest). Drives the STATIC edges.
  "reach_ladder": ["champion","final","sf","qf","r16","r32"],
  // group_winner is a strict strengthening of advancing.
  "group_relations": { "group_winner_implies": "r32", "group_advance_is": "r32" },

  // KB superset target(s): the deepest role implies an aggregate over a KB hierarchy.
  "supersets": [
    { "from": "champion", "to": "confederation_champion", "via_kb": "team→confederation" }
  ],

  // COMBINATORIAL layer — REAL bracket (ESPN + Wikipedia, fetched 2026-05-31).
  // R32 feeders are group positions ("1A"=Group A winner, "2B"=Group B runner-up,
  // "3rd:C/E/F/H/I"=one of the best third-placed teams from that eligible set).
  "bracket": {
    "source": "espn.com/soccer/bracket + en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage",
    "r32": [
      { "match": 73, "feeders": ["2A","2B"] },              { "match": 74, "feeders": ["1E","3rd:A/B/C/D/F"] },
      { "match": 75, "feeders": ["1F","2C"] },              { "match": 76, "feeders": ["1C","2F"] },
      { "match": 77, "feeders": ["1I","3rd:C/D/F/G/H"] },   { "match": 78, "feeders": ["2E","2I"] },
      { "match": 79, "feeders": ["1A","3rd:C/E/F/H/I"] },   { "match": 80, "feeders": ["1L","3rd:E/H/I/J/K"] },
      { "match": 81, "feeders": ["1D","3rd:B/E/F/I/J"] },   { "match": 82, "feeders": ["1G","3rd:A/E/H/I/J"] },
      { "match": 83, "feeders": ["2K","2L"] },              { "match": 84, "feeders": ["1H","2J"] },
      { "match": 85, "feeders": ["1B","3rd:E/F/G/I/J"] },   { "match": 86, "feeders": ["1J","2H"] },
      { "match": 87, "feeders": ["1K","3rd:D/E/I/J/L"] },   { "match": 88, "feeders": ["2D","2G"] }
    ],
    "r16": [ {"match":89,"feeders":["W73","W75"]}, {"match":90,"feeders":["W74","W77"]},
             {"match":91,"feeders":["W76","W78"]}, {"match":92,"feeders":["W79","W80"]},
             {"match":93,"feeders":["W83","W84"]}, {"match":94,"feeders":["W81","W82"]},
             {"match":95,"feeders":["W86","W88"]}, {"match":96,"feeders":["W85","W87"]} ],
    "qf": [ {"match":97,"feeders":["W89","W90"]}, {"match":98,"feeders":["W93","W94"]},
            {"match":99,"feeders":["W91","W92"]}, {"match":100,"feeders":["W95","W96"]} ],
    "sf": [ {"match":101,"feeders":["W97","W98"]}, {"match":102,"feeders":["W99","W100"]} ],
    "third_place": { "match":103, "feeders":["L101","L102"] },
    "final": { "match":104, "feeders":["W101","W102"] }
  },
  // Draw LOADED (espn.com/soccer/table, 2026-05-31) — full 48-team roster persisted
  // in tournament_states.format_spec.draw. Abbreviated here:
  "draw": { "source": "espn.com/soccer/table", "groups": {
    "A": ["Mexico","South Africa","South Korea","Czechia"],
    "I": ["France","Senegal","Iraq","Norway"],
    "J": ["Argentina","Algeria","Austria","Jordan"]
    /* …B–H, K, L persisted in DB… */
  } },
  // Still needed: FIFA's best-third ALLOCATION table (which specific 3rd fills each
  // "3rd:…" slot given which 8 thirds qualify — combinatorial).

  // How to map a market/event TITLE to a structural role (used to attach edges to real nodes).
  // `subject_axis`: where the team identity lives — the outcome-node subject vs the title.
  "node_roles": [
    { "role": "champion",        "title_match": "winner|win(s)? the (men'?s|2026) .*world cup", "subject_axis": "team" },
    { "role": "confederation_champion", "title_match": "continent .* win", "subject_axis": "confederation" },
    { "role": "reach_final",     "title_match": "reach .* final|final qualif",      "subject_axis": "team" },
    { "role": "reach_sf",        "title_match": "sem?i[- ]?final",                  "subject_axis": "team" },
    { "role": "reach_qf",        "title_match": "quarter[- ]?final",                "subject_axis": "team" },
    { "role": "reach_r16",       "title_match": "round of 16|knockout stage",       "subject_axis": "team" },
    { "role": "reach_r32",       "title_match": "round of 32",                      "subject_axis": "team" },
    { "role": "group_advance",   "title_match": "qualify from .* group|advance from .* group", "subject_axis": "team", "group_from_title": true },
    { "role": "group_winner",    "title_match": "group [a-l] winner|finish first .* group [a-l]", "subject_axis": "team", "group_from_title": true },
    { "role": "match_result",    "title_match": " vs | v\\. ",                      "subject_axis": "two_teams" },
    { "role": "orthogonal_prop", "title_match": "top ?scorer|golden boot|golden glove|squad|goals|assists", "edges": "none" },
    { "role": "non_structural",  "title_match": "attend|played in|halftime|venue|host", "edges": "none" }
  ]
}
```

---

## 3. Edge-derivation rules (format_spec + KB → implication_edges)

Two tiers, by what they need. **All edges are tagged with `tournament_state_id` so they're reversible
(pipeline doc §12).**

### Tier A — STATIC structural edges (no live state; the buildable-now part)
Derived purely from `reach_ladder` + `group_relations` + `supersets` + the KB. For each **team T** that
has a node at two adjacent ladder levels:

1. **Monotonic ladder** — `[T champion] ⟹ [T reach_final] ⟹ [T reach_sf] ⟹ [T reach_qf] ⟹
   [T reach_r16] ⟹ [T reach_r32]`. Reaching a deeper stage implies reaching every shallower one, so the
   YES price must be monotonically non-increasing; a violation is a riskless arb. *(I3/I4.)*
2. **Group-winner ⟹ advance** — `[T win Group A] ⟹ [T advance from Group A] (= reach_r32)`.
3. **Group Σ-exclusivity** — "Group A Winner" over the 4 group teams is a categorical `outcome_set`
   (exactly one wins) → the buy-all-NO arb, handled by the LP with no edge.
4. **KB superset** — `[T champion] ⟹ [confederation(T) wins]` → wires every champion node to the real
   "Continent to Win the Men's World Cup" event via the KB `team→confederation` relation. *(I6.)*

Worked arb: P("Argentina win WC") must be ≤ P("Argentina reach final") ≤ P("Argentina reach SF") ≤ …;
and P("Argentina win WC") ≤ P("South America wins WC"). Any inversion across these *separate events*
(even on one platform) is an arb the LP now sees because the edges link the clusters.

### Tier B — COMBINATORIAL / live edges (need the bracket + resolution state; the agent's job)
Need `bracket` + `draw` + live match results:
- group match results → final group table → who finishes 1st/2nd/best-3rd (the `advancement` rule +
  tiebreakers) → which teams fill which `bracket` R32 slots.
- bracket position → who plays whom in R32 → constrains reach_r16, etc.
- on each resolution: eliminated teams' deeper-stage nodes become impossible (narrows Ω); filled
  bracket slots make downstream pairings deterministic. → update `resolution_state`, re-emit
  `graph_updated`.

**Worked path (real bracket).** A Group A winner ("1A") enters at **R32 match 79** → wins → **R16
match 92** → **QF match 99** → **SF match 102** → **Final 104**. So with the bracket loaded, even
*before* the draw:
- `reach_r16("1A team") ⟺ win(match 79)`, `reach_qf ⟺ win(79)∧win(92)`, … `champion ⟺ win 79,92,99,102,104` — the ladder edges of Tier A get a concrete match-path backing.
- **Bracket-distance mutual exclusion (new, combinatorial):** two teams in the *same* R32 match (e.g. 1A vs the 3rd from C/E/F/H/I) are mutually exclusive from R16 onward; two teams in opposite halves can only both appear in the Final — so "both reach SF" is feasible but "both win" is not. These cross-team constraints are *not* derivable from the per-team ladder; they need the bracket.
- **Best-third coupling:** match 79's opponent is one of `3rd:C/E/F/H/I` — so "1A reaches R16" is coupled to *which* of those groups' thirds qualify (the allocation table). This is the irreducibly combinatorial bit.
- **Live:** when match 79 resolves, the loser's reach_r16/qf/sf/champion nodes → 0 (Ω narrows); the winner is pinned into match 92.

Tier B is exactly why §12 is an *agent*, not a static rule: it needs the format-specific bracket
(now loaded) + the time-varying resolution state. Tier A ships first (the kept I3/I4/I6 wired into
Stage 4); Tier B layers on.

---

## 4. The onboarding prompt (extract `format_spec` from web rules)

For the NEXT competition, feed the LLM the fetched rules/bracket text + the list of that competition's
real event titles (the nodes), and get back a `format_spec`. Contract sketch:

> *You are modelling a sports competition's structure for an arbitrage engine. Given the official rules
> and the list of market titles, output a `format_spec` JSON (schema below). Rules: (1) `stages` MUST be
> a total order; `reach_ladder` lists them deepest→shallowest. (2) Advancement counts MUST reconcile:
> Σ(top_n_per_group × groups) + best_ranked.count == next stage `slots`. (3) `node_roles.title_match`
> patterns MUST exclude other competitions sharing the name and non-structural/prop markets — when
> unsure, mark a role `"edges":"none"` rather than risk a false implication. (4) Only emit a `bracket`
> if the official source gives the slot→group-position mapping; else leave `source:"needs_official"`.
> (5) Never invent teams, dates, or bracket slots not in the source.*

Deterministic guards on the output (mirroring the edge-soundness workflow): the advancement-count
reconciliation (rule 2), `reach_ladder` is a strict order, and every `node_roles` regex compiles and
matches ≥1 real event title (else the role is dead and dropped).

---

## 5. Persistence + wiring (maps onto existing schema)

- `tournament_states` (pipeline doc §12): `competition_id → known_entities`, `format_spec jsonb`
  (§2), `resolution_state jsonb` (Tier B live state), `active`, timestamps.
- `implication_edges.tournament_state_id` (pipeline doc §12 ALTER) tags every edge this layer writes →
  killing a tournament's state removes its edges (reversible).
- Tier A runs in the **structural-edge-builder** (the deferred Stage-4 step that wires I3/I4/I6); it
  reads `format_spec` + the role-mapped nodes + KB, no live state. Tier B runs in the **agent**,
  subscribing to resolution events.

### Shipped — Tier A (2026-05-31)
- **`docker/migrations/054_tournament_states.sql`** (+ init.sql mirror): `tournament_states` table +
  `implication_edges.tournament_state_id`. Applied live.
- **`stage4-events/tournament-edges.ts`**:
  - `deriveTournamentEdges(spec, nodes, confederationOf)` — the PURE engine (ladder + group⟹advance +
    KB superset), **8 unit tests pass** (`tournament-edges.test.ts`): adjacency-only edges, no
    cross-team links, superset only to the right confederation, props/missing-endpoints emit nothing,
    dedup + no self-edges.
  - `WC_2026_FORMAT_SPEC` (with `nodeRoles` title→role patterns + competition aliases for the
    Cricket/T20/Esports disambiguation).
  - `buildTournamentEdges()` — loads active `tournament_states`, classifies each competition's
    outcome-nodes by `nodeRoles`, derives, upserts edges tagged `tournament_state_id`. Wired into
    `runStage4` after the threshold edges; **guarded** (no states / no role-nodes ⇒ 0 edges).
- **WC `format_spec` persisted** in `tournament_states` (8 roles, 6-level ladder).
- **Verification:** engine via unit tests; node-loading SQL validated against the live schema (0 WC
  role-nodes today — the WC `questions` don't exist until the event graph runs, so it no-ops cleanly).
  The end-to-end edge counts land with the deferred cutover (apply 051 → run the event graph → WC
  outcome-nodes appear → Tier-A edges materialize). `tsc` clean.

> SHIPPED/GENERALIZED SINCE (supersedes the "0 role-nodes / no-ops" line above):
> §7 shows Tier-A + Tier-B edges materializing live on run #230 (2026-06-11). The
> Tier-A engine was GENERALIZED beyond WC (775f95d, 2026-06-10): the live source
> uses the gated `resolveStageClassFromSpec` + `loadTournamentMarketNodeRows`
> (real markets via `question_members`, blocker A) driven by per-competition
> `seriesResolvers`, and `PIPELINE_FORMAT_SPECS`/`seedTournamentStates` now seed
> FOUR specs on every Stage-4 pass — WC 2026, March Madness 2027, CFB Playoff
> 2026-27, College Baseball WS 2026. Added: the F2 `finalFixture` standing rule
> (`deriveFinalWinnerEdges`: final-winner(X)⟹champion(X) + champion/final-winner
> mutex, ONE direction only), the edition-digit scoping belt, and migration 064
> `chk_edges_pattern` allow-listing the tier-A patterns.

---

## 6. What to plug in from the web (the precise shopping list)

Format CONFIRMED (used above): 48 teams; 12 groups A–L of 4; round-robin, 3 matches each; **top 2 per
group + 8 best third-placed → Round of 32**; R32 → R16 → QF → SF → Final (MetLife, Jul 19); 104
matches; group stage Jun 11–27, R32 from Jun 29; tiebreakers GD → goals → H2H → fair-play → lots.

DONE (fetched 2026-05-31, in §2 `bracket`):
1. ✅ **R32 slot mapping + full bracket flow** — R32 matches 73–88 with group-position feeders, R16
   89–96, QF 97–100, SF 101–102, Final 104, third-place 103 (ESPN + Wikipedia).

STILL NEEDED for full Tier B:
2. **The best-third allocation table** — FIFA's fixed table picking *which* specific group's third fills
   each `3rd:…` slot given which 8 thirds qualify. The eligible SET per slot is captured (`3rd:C/E/F/H/I`
   etc.); the resolution within it is the combinatorial table.
3. **The draw** — the 48 teams' actual group assignments (`draw.groups`). ESPN showed positional slots
   only; need the team roster per group (e.g. the FIFA draw result) to attach team nodes.

Item 2 is the last genuinely hard, competition-specific bit; item 3 is data. With the bracket already
loaded, Tier A (static edges) needs nothing more, and Tier B is modelable now except the best-third
resolution.

**Tier B data status (2026-05-31):**
- ✅ Full bracket flow (R32→Final) loaded in §2.
- **Best-third table:** the eligible-SET per slot is captured in the bracket (`3rd:C/E/F/H/I` etc.).
  The full FIFA resolution table (which specific third → which slot, across the ~hundreds of
  which-8-of-12-qualify combinations) is deliberately *not* transcribed here — it's a bulk official
  lookup the agent loads at run time, not structure. Hand it over (or the FIFA bracket PDF) when we run
  Tier B live; transcribing it by hand would risk errors.
- **Draw:** ✅ LOADED — all 48 teams across groups A–L (espn.com/soccer/table, 2026-05-31), persisted
  in `tournament_states.format_spec.draw`. Cross-checks with the DB (e.g. Group A's South Korea +
  Czechia match the Limitless "South Korea vs Czech Republic" fixture; France in Group I).
- **Only remaining gap:** the FIFA best-third allocation table (item above).

Sources for the confirmed format:
[2026 FIFA World Cup — Wikipedia](https://en.wikipedia.org/wiki/2026_FIFA_World_Cup),
[FIFA — World Cup 2026 format](https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/fifa-world-cup-2026-hosts-cities-dates-usa-mexico-canada),
[Al Jazeera — what to expect from the 48-team format](https://www.aljazeera.com/sports/2026/5/14/fifa-world-cup-2026-what-to-expect-from-the-48-team-format).

---

## 7. Tier B — status (2026-06-11): static-unconditional subset SHIPPED; conditional classes designed, not emitted

The §3 Tier-B surface was classified against the LIVE run-#230 population
(assessment + live counts: `docs/research/wc-tierb-design-2026-06-11.md`; probes
`probe-wc-tierb-{population,population2,sizing}-2026-06-11.ts`) into
(a) unconditional-once-format-fixed → BUILT, (b) Σ-expressible in the existing
outcome_set representation → BUILT, (c) genuinely conditional on outcomes →
DESIGN ONLY. **The fake-arb invariant ruled the cut: nothing conditional was
emitted as a deterministic edge.**

### Shipped — Tier B (a)+(b) (2026-06-11)
- **`stage4-events/tournament-edges-tierb.ts`** (+ 28 unit tests), wired into
  `runStage4` after the tier-A pass; all edges tagged `tournament_state_id`;
  patterns allow-listed by **migration 078** (written APPEND-defensively — it
  parses the live CHECK and unions its labels, because sibling migration 077
  landed mid-wave; a frozen list would have erased `spread_winner`):
  - `elimination_stage_mutex` — eliminated-at-S(T) ⊥ reach-D(T), D strictly
    deeper (+ elim-at-group ⊥ group_winner via the extraImplication). Closes
    the hole where {elim-qf=1 ∧ reach-sf=1} was a valid Ω world (the positive
    reach nodes are not cells of the per-team Σ≤1 set). Champion consequents
    excluded — champion ⊥ elim is the same-set Σ≤1 constraint. **743 edges**
    on #230 (705 ladder + 38 group_winner).
  - `group_champion_superset` — champion(T) ⟹ "a team from Group g(T) wins"
    (KXWCGROUPWINNER), membership from the KXWCGROUPQUAL ticker letter,
    cross-checked against `format_spec.draw` (45 AGREE / 0 DISAGREE / 5
    accepted spelling-variance misses). **47 edges**; mutex side covered
    transitively by the existing Σ≤1 platform set over the 12 cells.
  - `host_stage_mutex` — hosts are FORMAT-FIXED: reach-S(USA/Mexico/Canada) ⊥
    strictly-shallower KXWCSTAGE-26HOST cell (42), plus cell('Winning the
    Final') ⊥ champion(non-host) (44) — the F2-sound direction only.
    Settlement-scope cuts: NO champion(host)×cell edges (awarded/unplayed
    final worlds are real — F2 doctrine), NO reach-final × SF-cell pair (the
    partition splits the final into losing/winning cells). **86 edges**.
  - **Champion Σ≤1 outcome set** (class (b), source `tournament_champion`):
    the 47 per-team Outright-Winner cells live in 47 different platform
    events, so NO existing set asserted "at most one champion" (probed). One
    categorical Σ≤1 per tournament_state, `is_exhaustive=FALSE`, the
    wc_elimination materialization pattern. **1 set / 47 slots**.
  - Conflict belt: a question whose gated member rows classify differently
    (the live sibling-leg defect class) gets NO tier-B node. (Tier A's node
    pass has the same theoretical exposure without the belt — ledgered, 0
    conflicting KXWC questions live.)
- **Gates run:** unit tests + tsc; migration 078 applied live (idempotent,
  31→31 labels, none lost); EXPLAIN + transactional dry-run on #230
  (`probe-wc-tierb-dryrun-2026-06-11.ts`, output committed) — 876/876 edges
  inserted, samples eyeballed against the real draw (every superset edge
  matches §2 `draw`), negative checks 0, the four new mirrored asserts 0
  IN-TXN on the populated graph, rollback verified; asserts control board
  unchanged from baseline (the documented pre-rebuild profile), new asserts
  green at 0 live.
- **Already covered, no build:** per-group group-winner partitions (11 Σ=1
  semantic + 1 Σ≤1 platform set live), the 12-cell group-aggregate partition
  (Σ≤1 platform set), per-fixture 3-way sets.

### Still conditional — class (c), DESIGN ONLY (the §12 agent's runtime)
- **Bracket-distance mutual exclusion** (same-R32-match teams exclusive from
  R16 on; half separation): WHICH slot a team occupies depends on its group
  FINISH — an outcome. Emitting these unconditionally is exactly the unsound
  class this repo exists to prevent.
- **Group-standings combinatorics** ("wins matches 1+2+3 ⟹ wins group",
  tiebreakers incl. lots): ≥3-ary, no sound pairwise residue.
- **Best-third allocation coupling**: conditional AND data-blocked (§6 item 2).
- **Reach-stage cardinalities** (exactly 2 reach the final, …): unconditional
  but Σ=k is not representable (categorical sets are exactly-1/≤1); only k=1
  (champion) shipped.
- **Representation decision (proposed, not built):** *resolution
  recompilation*, not guarded edges. `tournament_states.resolution_state`
  records resolved facts (match results, final group tables, filled bracket
  slots); a resolution-event consumer re-derives tier B and emits relations
  whose conditions are now FACTS as ordinary 2-literal edges (tagged,
  reversible), then `graph_updated`. Until resolution: nothing. The
  alternative — guarded 3-literal edges (`condition_question_id` on
  implication_edges + a clause-aware state-enumerator) — prices conditional
  structure pre-resolution but changes the solver contract for near-zero
  pre-resolution arb yield; revisit only if cross-market conditional pricing
  materializes. The **knockout-fixture standing rule** (R32+ fixture-winner(T)
  ⟹ reach-next-stage(T), the F2 generalization) is the recompiler's first
  free win: the fixture listing itself encodes the resolved condition; 0
  knockout fixtures exist today, so it ships when the population does.

### Data gaps flagged in passing
- `known_entities` carries **0** `confederation` metadata rows → the tier-A
  champion⟹continent superset channel (KXWCCONTINENT, 5 live cells) emits 0
  edges until the KB is backfilled. KB surface, not tournament surface.
- KXWCSTAGE-26HOST's 7 cells sit in NO outcome set (platform-native set
  builder skips the event) — the host-cell partition Σ≤1 would be a free
  (b)-class addition for whoever owns the platform-set surface.
