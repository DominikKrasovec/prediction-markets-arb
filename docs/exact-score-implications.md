# Exact-Score Market Implications

How Polymarket-style "Exact Score: A N - M B?" markets deterministically resolve every related scoring market for the same fixture. Used by Stage 3 to derive implication edges without an LLM call.

> **Status (verified 2026-05-29).** The exact-score implication **edge rule** shipped and is live: [`exact-score-implication.ts`](../services/pipeline/src/stage3-arb-detect/exact-score-implication.ts) (§7 item 1). Stage 3 emits the edges; they are consumed by the `arb-solver` service.
> **Retired since this doc was written:** the in-pipeline **arb scanner** and **implied-probability scanner** — `arb-scanner.ts`, `implied-probability-scanner.ts`, `scanForArbitrage`, `getFixtureSiblingsForImplied`, `getExactScoreSlotsForImpliedScan` (referenced in §4.3, §CP-Gap-1, and §8) **no longer exist.** When the pipeline's internal price-tracking + arb scanner was removed, pricing and arbitrage scoring moved entirely into the `arb-solver` service, which solves an LP over the world-state set (Ω) against **live CLOB-API quotes** rather than stale DB price writes (see the outcome-sets.ts:507 removal note and `services/arb-solver/`). Treat all scanner references below as historical design notes; the *outcome-set builders* they relied on still exist for Stage 3's M5 mutex inference.

## 1. Why this matters

Stage 1's [`text-deterministic-Z`](../services/pipeline/src/stage1-normalize/text-deterministic.ts) emits one normalization per `(scoreA, scoreB)` outcome plus an `'any_other'` catch-all sibling, all anchored to one `canonical_event = "<TeamA> vs <TeamB>"` (alphabetical sort).

**How Stage 2 actually groups these:** the [`canonical_key`](../services/pipeline/src/db/queries/questions.ts) encodes `cv_derived = value_primary_value_secondary` (e.g. `"2_1"`), so each `(scoreA, scoreB)` produces a **distinct** question — ~26 questions per fixture rather than one collapsed row. The `any_other_score` sibling has subject_raw `'any_other_score'` and ends up in its own question. The shared `canonical_event` is what lets Stage 2/3 nominate every scoreline question against the same fixture's sibling markets (match-winner, BTTS, O/U, etc.).

(An earlier draft of this doc claimed Stage 2 collapsed 26 outcomes into one question. That was aspirational, not the current behavior — kept the 26-question shape because the per-scoreline question carries the exact `(scoreA, scoreB)` values that the Stage 3 implication math reads from `ConditionCard.value_primary`/`value_secondary`. Collapsing to one question would require a market-level rule and a multi-member edge schema; not worth the cost.)

Stage 3 then needs to know that **`Exact 2-1`** is a YES-witness to many other markets on the same fixture:

| Other market type | Resolves YES when |
|---|---|
| `match_winner(A)` | `scoreA > scoreB` |
| `match_winner(B)` | `scoreB > scoreA` |
| `Draw` | `scoreA == scoreB` |
| `Both Teams to Score` (BTTS) | `scoreA > 0 AND scoreB > 0` |
| `Over N.5 goals` | `scoreA + scoreB > N` |
| `Under N.5 goals` | `scoreA + scoreB <= N` |
| `Team A scores N+` | `scoreA >= N` |
| `Team B scores N+` | `scoreB >= N` |
| `Team A wins by over N.5 goals` | `scoreA - scoreB > N` |
| `Team B wins by over N.5 goals` | `scoreB - scoreA > N` |
| `Exact A scoreA+1 - scoreB B?` etc. | mutually exclusive — always NO |

A single Exact Score row therefore implies (or contradicts) **every other scoring market for that fixture**. Each implication is a strict YES/NO with no fuzz — no probabilistic, no LLM judgment needed.

## 2. Data shape produced by Template Z

For `Exact Score: Arsenal FC 2 - 1 Chelsea FC?`:

```ts
{
  subject_raw: 'Arsenal FC',
  participants_raw: ['Chelsea FC'],
  canonical_event_override: 'Arsenal FC vs Chelsea FC',    // alphabetical sort
  condition_shape: 'categorical_outcome',
  temporal_semantics: 'at_resolution',
  value_primary: 2,                                         // scoreA
  value_secondary: 1,                                       // scoreB
  value_unit: 'goals',
  outcome_label: '2-1',                                     // verbatim scoreline
  event_kind: 'exact_score',
  entity_type: 'team',
}
```

For `Exact Score: Any Other Score?` (the catch-all sibling):

```ts
{
  subject_raw: 'any_other_score',
  outcome_label: 'any_other',
  // value_primary / value_secondary / canonical_event_override are NULL —
  // Stage 2 joins via subject + platform_event_id to find the siblings.
}
```

## 3. Deterministic implication rules

Let `S(a,b)` denote the Exact Score outcome with `value_primary=a`, `value_secondary=b`. The implication relation `S(a,b) ⟹ T` means "if S(a,b) resolves YES, then T must resolve YES."

### 3.1 Match-winner implications

Given a sibling market `match_winner(SUBJECT, outcome_label='win')` on the same `canonical_event`:

| If outcome's subject equals | And | Then |
|---|---|---|
| `Team A` | `scoreA > scoreB` | `S(a,b) ⟹ match_winner(A)` (YES) |
| `Team A` | `scoreA <= scoreB` | `S(a,b) ⟹ match_winner(A)` (NO — mutex) |
| `Team B` | `scoreB > scoreA` | `S(a,b) ⟹ match_winner(B)` (YES) |
| `Team B` | `scoreB <= scoreA` | `S(a,b) ⟹ match_winner(B)` (NO — mutex) |

### 3.2 Draw / BTTS

| If | Then |
|---|---|
| `scoreA == scoreB` | `S(a,b) ⟹ Draw` (YES, equivalence with `event_kind='match_winner', outcome_label='draw'`) |
| `scoreA != scoreB` | `S(a,b) ⟹ Draw` (NO) |
| `scoreA > 0 AND scoreB > 0` | `S(a,b) ⟹ BTTS` (YES) |
| `scoreA == 0 OR scoreB == 0` | `S(a,b) ⟹ BTTS` (NO) |

### 3.3 Total goals (Over/Under)

Let `T = scoreA + scoreB`. For any Over/Under market with threshold `N.5`:

| | |
|---|---|
| `S(a,b) ⟹ Over N.5` YES | iff `T > N` |
| `S(a,b) ⟹ Over N.5` NO  | iff `T <= N` |
| `S(a,b) ⟹ Under N.5` YES | iff `T <= N` |
| `S(a,b) ⟹ Under N.5` NO | iff `T > N` |

**Concrete table for `S(2,1)` (T=3) against the common O/U lines:**

| Market | Resolution |
|---|---|
| Over 0.5 | YES |
| Over 1.5 | YES |
| Over 2.5 | YES |
| Over 3.5 | NO |
| Over 4.5 | NO |
| Under 0.5 | NO |
| Under 1.5 | NO |
| Under 2.5 | NO |
| Under 3.5 | YES |
| Under 4.5 | YES |

### 3.4 Team totals (individual scoring)

For a sibling `match_total_metric(subject=Team A, value_primary=N, condition_direction='above', value_unit='goals')`:

| | |
|---|---|
| `S(a,b) ⟹ A scores N+` YES | iff `scoreA >= N` |
| `S(a,b) ⟹ A scores N+` NO | iff `scoreA < N` |

Mirror for Team B.

### 3.5 Spread / margin

For a sibling `match_spread(subject=A, value_primary=N, condition_direction='above', value_unit='goals')`:

| | |
|---|---|
| `S(a,b) ⟹ A wins by over N.5` YES | iff `scoreA - scoreB > N` |
| `S(a,b) ⟹ A wins by over N.5` NO | iff `scoreA - scoreB <= N` |

Mirror for Team B.

### 3.6 Sibling exact scores

All other `exact_score` rows on the same `canonical_event` are **mutually exclusive** — exactly one resolves YES:

| | |
|---|---|
| `S(a,b) AND S(a',b') with (a,b) != (a',b')` | impossible (M_mutex edge) |
| `S(a,b) ⟹ any_other` | NO if `(a,b)` is in the platform's listed grid; otherwise YES |

The set `{S(0,0), S(0,1), …, S(5,5), any_other}` is **exhaustive and mutually exclusive** — exactly one YES per fixture. This is a textbook `outcome_set(set_type='categorical')` for Stage 3's [outcome-sets.ts](../services/pipeline/src/stage3-arb-detect/outcome-sets.ts).

### 3.7 The `any_other` catch-all

`any_other` resolves YES iff the final scoreline is OUTSIDE the explicit grid Polymarket listed (typically 0-0 through 5-5 plus any pre-listed lopsided scores). Equivalently:

```
any_other ⟺ NOT (scoreA <= 5 AND scoreB <= 5)
         OR  the specific (scoreA,scoreB) was not in the listed grid
```

For implication purposes:
- `any_other ⟹ Over 5.5` YES (almost always — total ≥ 6 in any uncovered scoreline > 5-5)
- `any_other ⟹ NOT S(a,b)` for any `(a,b)` in the explicit grid

But we **cannot** derive `Over N.5` or `Under N.5` from `any_other` for N < 5 because the catch-all bucket contains scorelines on both sides of those thresholds.

## 4. How Stage 3 should consume these

### 4.1 New rule: I_exact_score

Proposed Stage 3 rule, fits between M5 (outcome_set) and I8 (parlay) in priority order:

```
For each candidate pair (q_exact, q_other) where q_exact is exact_score:
  Load q_exact's (value_primary, value_secondary) and canonical_event.
  Match q_other by canonical_event.

  Branch by q_other.event_kind:
    match_winner       → rule 3.1
    match_total_metric → rule 3.4 (or 3.3 if subject is the whole match)
    match_spread       → rule 3.5
    both_teams_score   → rule 3.2
    exact_score (≠)    → mutex (3.6)
    other              → null (defer to LLM)
```

All branches return either `strict_implication` (YES-side equivalence to a derived boolean), `mutual_exclusion`, or `null` (defer). No probabilistic edges.

### 4.2 Outcome set construction

`outcome-sets.ts` currently builds platform-native, threshold-series, tournament, and cross-platform sets — but **not** an exact_score categorical set. We add a new builder ([`insertExactScoreOutcomeSets`](../services/pipeline/src/db/queries/outcome-sets.ts)) that groups the ~26 exact_score sibling questions per fixture into one `set_type='categorical'` set, keyed by `(canonical_event, league_id, condition_date)`. Once the set is built:

- M5 (outcome-set exclusion) auto-fires between any two `exact_score` siblings — no I_exact_score code needed for the sibling-vs-sibling case.
- M3 stays available as a fallback (same canonical_event + categorical_outcome shape + different condition_value) for fixtures that for any reason missed the outcome-set step.
- The new I_exact_score rule (§4.1) handles the cross-event-kind cases — exact_score vs match_winner, BTTS, total goals, team totals, spread.

### 4.3 Cross-platform leverage

The high-value case: a Polymarket `Exact Score: Arsenal 2-1 Chelsea` market resolves YES, AND a Kalshi `KXEPLTOTAL-...-2` (Over 2.5) market on the same fixture is mispriced. Today these stay in separate questions because their `condition_shape`s differ. With I_exact_score wiring, the implication edge appears explicitly and the `arb-solver` service (which loads the edge graph and prices it against live CLOB quotes) finds the arbitrage.

## 5. Parlay-leg interactions

When an `exact_score` outcome appears as a leg of a Kalshi parlay (rare on the current data, but the `mve_selected_legs` schema supports it), the leg-set implication rule ([leg-set-implication.ts](../services/pipeline/src/stage3-arb-detect/leg-set-implication.ts)) treats it as an opaque `(side, ticker)` tuple — no special handling needed. The implication rules in §3 apply to the underlying single-leg `exact_score` market, and the parlay-vs-parlay or parlay-vs-single comparisons happen on ticker identity.

If we ever want richer reasoning — e.g. "this parlay leg `yes|Exact Arsenal 2-1` dominates that parlay leg `yes|Total Over 2.5`" — we'd need to surface the score values to the leg-set rule, which would need a schema extension (current `leg_signatures` is `<side>|<ticker>` only, no value payload). **Not recommended** until we see real demand: cross-platform parlay arb opportunities involving exact-score legs are vanishingly rare.

## 6. Edge cases the regex doesn't catch

- **Two-digit scores** (`Exact Score: Team A 12 - 8 Team B?`) — refused by Template Z's `\d` (single-digit only). Polymarket doesn't list >5-5 explicitly; >9-9 would be implausible. If a high-scoring sport (basketball futures) ever shows up with this shape, widen to `\d+`.
- **Non-soccer** — Template Z hard-gates `category_unified='sports'` and uses `value_unit='goals'`. For hockey ("goals") and rugby ("points"), the unit is wrong but the structure carries. Defer to a future per-sport unit map; sports.exact_score is currently 95%+ soccer.
- **Asymmetric platforms** — only Polymarket emits these. Kalshi/Predict/Limitless don't, so Stage 2 cross-platform matching for `exact_score` only matches Polymarket-to-Polymarket. The implication edges in §3 are the bridge to other platforms' markets on the same fixture (via canonical_event).

## 7. Open questions

1. ~~Should the I_exact_score rule emit edges PROACTIVELY ...~~ **Resolved (reactive).** Implemented in [`exact-score-implication.ts`](../services/pipeline/src/stage3-arb-detect/exact-score-implication.ts) — fires on pair nomination, using `canonical_event` (with team-order swap fallback via participants set) + `condition_date` to confirm same-fixture.
2. For `any_other`, can we tighten 3.7's "almost always" Over 5.5 implication if we record Polymarket's explicit grid in `outcome_sets.bundle_metadata`? Currently we'd need a per-fixture lookup. Tradeoff: minor coverage gain vs. schema complexity. **Open.**
3. Does `condition_value` need to carry the score string (e.g. `"2-1goals"`) for downstream consumers, or is `value_primary` + `value_secondary` + `outcome_label` sufficient? Currently storing `outcome_label='2-1'` only — Stage 3 rules read `value_primary/secondary` for the math. **Open** — note that `outcome_label` is currently **not persisted** (TS-only on `LLMMarketNormalization`; the column does not exist in `llm_market_normalizations`). See §8.5.

## Cross-platform compatibility — what works and what doesn't

The new system is **not "perfectly" cross-platform compatible**. Three concrete gaps as of this PR, observed against live snapshot data for an Arsenal-vs-Burnley fixture:

### CP-Gap 1: `canonical_event` divergence across platforms

Each platform's `canonical_event` carries that platform's idiom:

| Platform | Market | `canonical_event` |
|---|---|---|
| Polymarket exact_score (Template Z) | "Exact Score: Arsenal FC 2 - 1 Burnley FC?" | `Arsenal FC vs Burnley FC` (alphabetical sort) |
| Polymarket sub-markets | "Arsenal FC vs. Burnley FC: O/U 2.5" | `Arsenal FC vs. Burnley FC - More Markets` |
| Limitless | "Both Arsenal and Burnley score on May 18?" | `Both Arsenal and Burnley score on May 18?` |

`normalizeEvent()` (lowercase + strip punctuation) doesn't fix the divergence — Polymarket's "- More Markets" suffix and Limitless's whole-title phrasing still don't agree.

**Mitigation in this PR**: the implied-probability scanner uses [`getFixtureSiblingsForImplied`](../services/pipeline/src/db/queries/outcome-sets.ts) with `q.participants && $1::text[]` (any-overlap on participant set) plus `condition_date` instead of exact `canonical_event` matching. Catches cross-platform siblings whose KB resolution agrees on ≥1 team name.

The rule-engine path (`detectExactScoreImplication.sameFixture`) likewise falls back to participants-set equality when normalized canonical_events disagree.

### CP-Gap 2: KB alias drift on team names

Same team appears as different canonical names across platforms (and sometimes within one platform):

| Surface | KB-resolved name |
|---|---|
| Limitless "Arsenal" | `Arsenal` |
| Polymarket "Arsenal FC" (Template Z) | `Arsenal FC` |
| Polymarket "Burnley FC" (Template Z subject) | `Burnley FC` |
| Polymarket "Burnley" (Template L participant) | `Burnley` |

Same fixture, four different canonical names. When the KB lacks an alias linking these, participants-set match fails — even after CP-Gap 1's mitigation.

**Not fixable in this PR.** Surfaces a pre-existing data-quality issue in [`entity-registry.ts`](../services/pipeline/src/db/entity-registry.ts) — aliasing needs to be tightened so "Arsenal" / "Arsenal FC" / "Arsenal Football Club" / "Arsenal F.C." all map to one entity. Until then, the implied-probability scanner will find cross-platform siblings only when KB happens to agree on at least one team name, which it usually does for one of the two teams (the high-cardinality entity) but not always both.

### CP-Gap 3: Polymarket-only exact_score emission

Only Polymarket emits `Exact Score: A N - M B?` markets — 16,777 in current snapshot across 981 fixtures, 100% Polymarket. Kalshi / Limitless / Predict / Predyx don't have an equivalent product. So the cross-platform arb opportunity is asymmetric: **Polymarket exact_score prices imply probabilities; the sibling questions priced on other platforms are the counterparties**. Same-platform Polymarket arb (exact_score → its own BTTS / O/U sibling) also works and is the dominant case in the snapshot.

### CP-Gap 4: Migration 036 + Template Z reprocess not yet applied

The new pipeline has **zero data live yet**:
- `llm_market_normalizations.outcome_label` column doesn't exist in your DB until `036_outcome_label.sql` runs.
- Zero rows in `llm_market_normalizations` have `event_kind='exact_score'` — Template Z was wired but Stage 1 hasn't reprocessed Polymarket markets since.

To activate: apply migration 036, then re-run Stage 1 on the Polymarket markets matching `^Exact Score:` (or wait for the next full Stage-1 cycle to pick them up). Stage 2 + Stage 3 will then have inputs.

### Tracker: what works today vs needs follow-up

| Concern | Status | Notes |
|---|---|---|
| Same-platform Polymarket exact_score → BTTS / O/U / spread / match_winner | ✅ works | Participants intersect via shared KB names within Polymarket |
| Cross-platform exact_score → Kalshi totals/BTTS/match_winner | ⚠ partial | Works when KB aliases both teams' names. Misses on KB drift. |
| Cross-platform exact_score → Limitless BTTS/totals | ⚠ partial | Same — KB-dependent. Limitless's verbatim-title canonical_event is bypassed by the participants-set query. |
| `any_other_score` implications for Over N.5 with N < 5 | ⚠ bounded | Computed as upper-bound only (any_other could be anywhere in the residual). |
| Match_winner with `outcome_label='draw'` | ✅ works after migration 036 + reprocess | Pre-reprocess, draws masquerade as team-win and the rule is conservative. |
| Match_winner team identification across platforms | ⚠ KB-dependent | Subject must match fixture's team_a or team_b canonical name exactly. |

## 8. Research — what else is possible with this data

This section came from a follow-on research pass after the rule landed. The market counts cited are from a Stage-1 snapshot (2026-05-21).

**Data quantification:**
- 16,777 Polymarket markets matching `^Exact Score:` across 981 distinct `platform_event_id` fixtures (~17 markets/fixture average; range 0-0 through 7-2 plus `Any Other Score?`).
- 100% `category_unified = 'sports'`; soccer-dominant.
- Sibling-market populations on the same fixtures: 980 Polymarket BTTS, 5,314 Polymarket "X vs Y: O/U N" totals; Kalshi has 109,858 "over/under N goals" single-legs (most of these are parlay-flattened LSI tickers, not all soccer).

### 8.1 Cross-platform value: implied O/U from exact-score prices — **shipped, since retired** (see status banner at top)

The 26 exact_score outcome prices on a fixture form a categorical distribution: `Σ p(scoreline) = 1`. Once the exact_score outcome set ([§4.2](#42-outcome-set-construction)) is built and slot-linked, the existing `scanOutcomeSetCompleteness` pattern in [`arb-scanner.ts`](../services/pipeline/src/stage3-arb-detect/arb-scanner.ts) already flags `Σ YES < $1` (buy all → guaranteed payout) and `Σ NO < $(n-1)` (sell all → guaranteed payout) opportunities — free wins from the new outcome set with zero new code.

The richer cross-platform opportunity is **implied probability synthesis**. This was implemented in-pipeline as `implied-probability-scanner.ts` (invoked from `scanForArbitrage`) but has since been **removed** along with the rest of the in-pipeline arb scanner — the equivalent reasoning now happens in `arb-solver` over live quotes. The original design, for reference:

1. Load the N scoreline sibling prices per fixture (`getExactScoreSlotsForImpliedScan`).
2. For each implied-market candidate (BTTS, Over N.5 / Under N.5 for N=0..5, Draw, Team-A wins, Team-B wins), compute the contributing scoreline set via the §3 algebra.
3. Compute LOWER bound (explicit scorelines only) and UPPER bound (lower + `p(any_other)`). For Over N.5 with N >= 5, `any_other` is definitely YES so it folds into LOWER too.
4. Find matching sibling questions on the same fixture via `getFixtureSiblingsForImplied` (normalized `canonical_event` + `condition_date` + matching `event_kind`).
5. Emit arb candidate when:
   - `sibling.best_yes_price + minProfit < lower bound` → BUY YES on sibling (underpriced).
   - `sibling.best_no_price  + minProfit < 1 - upper bound` → BUY NO on sibling (underpriced).
6. Confidence = 0.85 (not 1.0) so the arb solver weighs these below pure-deterministic edges.

**Reach (snapshot)**: 981 exact_score fixtures × ~1-3 sibling questions per fixture ≈ 1-3k implied-edge checks per scan cycle. Negligible CPU.

**Future extension**: maximum-entropy or Poisson-mixture fit (see §8.2) would tighten the LOWER bound when `any_other` is large by allocating its mass according to the explicit-scoreline shape. Not shipped — current bound-based approach catches the obvious mispricings without modeling risk.

### 8.2 Reverse: derive an exact-score prior from sibling markets

The inverse direction is harder but conceptually symmetric. Given:
- `p(Team A wins)`, `p(Team B wins)`, `p(Draw)` (sum = 1, three constraints)
- `p(Over 1.5)`, `p(Over 2.5)`, …, `p(Over 5.5)` (six monotonic constraints on `P(total > N)`)
- `p(BTTS)` (one constraint)

We have ~10 linear constraints on the 26 unknowns (`p_{a,b}` for a,b in 0..5 plus `p_any_other`). Underdetermined — infinite solutions. To pick one:
- **Maximum entropy** prior subject to the constraints: pick the `p_{a,b}` distribution that maximises `-Σ p log p`. Closed-form via Lagrange multipliers for the linear constraints; one Newton iteration converges fast in practice (~20 vars, 10 constraints).
- **Poisson-mixture prior**: assume goals are independent Poisson with means `λ_A, λ_B`, fit `λ_A, λ_B` from `p(Draw)` and `p(Team A wins)`, then `p(a,b) = Poisson(a; λ_A) · Poisson(b; λ_B)`. Closed-form, but assumes independence — known to underprice draws in real soccer data ("draw bias"). A Dixon-Coles correction adds a low-score adjustment parameter; calibrate once across all fixtures.

**Use case**: flag mispriced specific scorelines (`q_S(a,b).best_yes_price` materially diverges from the prior-derived `p_{a,b}`). Caveat: priors are noisy on rare scores (7-1, 6-3) where empirical frequency is dominated by sampling error. Restrict to common scorelines (sum ≤ 4) for actionable signal.

**Effort to ship**: medium. A scanner-side `computeExactScorePrior(questionSet, mode='maxent'|'poisson')` helper, a new `arb_prior_disagreement` candidate type, and a calibration script to set `epsilon` per scoreline-bucket. Math is well-established; the integration work is the cost.

### 8.3 Extend Template Z beyond soccer

Database snapshot shows zero non-Polymarket exact-score markets and zero non-soccer Polymarket exact-score markets — the regex hard-gates `category_unified='sports'` and Polymarket lists exact scores only for soccer in our window.

The structurally-adjacent formats we DO see, but Template Z deliberately ignores:
- **Golf**: "Will the winning golfer's final score be -1 to -3?" — range-bucketed totals over a tournament, not a per-fixture (a,b) scoreline. Owned by a different (existing) template family.
- **NBA/MLB**: no "Exact Score" markets observed. Both have far richer scoring distributions and Polymarket doesn't price them this way; the categorical wouldn't fit the page even if attempted.
- **Hockey** / **Rugby**: no exact-score markets in the current data.

**Recommendation**: no Template Z extension is justified by current data. If hockey/rugby exact-score markets ever appear:
1. Widen the regex's `\d` to `\d+` (two-digit scores aren't currently tolerated for soccer because of false matches like "Stade Brestois 29", but hockey/rugby titles wouldn't carry a year fragment).
2. Add a per-sport `value_unit` map (`goals` for soccer/hockey, `points` for rugby/basketball). The cleanest spot is a `unitForSport(category, sport_canonical)` helper that Template Z consults; the rule in [`exact-score-implication.ts`](../services/pipeline/src/stage3-arb-detect/exact-score-implication.ts) already gates by unit equality so unit-mismatched pairs won't accidentally fire.
3. Drop the `\d` ceiling: outliers like 7-2 already appear in soccer (33 markets with `scoreA > 5`); the current regex matches them. Two-digit ceiling would only matter for basketball / cricket / american-football if those ever surface.

Until then this section is a watch-list, not a backlog item.

### 8.4 Parlay-leg extension — measured cost

**Two distinct questions here. Don't conflate them.**

**Q1: Is the parlay-leg infrastructure widely used across sports?** YES, massively. Snapshot counts of distinct leg-ticker families (`KX*` prefix on Kalshi `leg_signatures`):

| Sport / family | Multi-leg appearances | Family examples |
|---|---|---|
| NBA player props | 2.0M+ | `KXNBAPTS`, `KXNBAREB`, `KXNBAAST`, `KXNBABLK`, `KXNBASTL`, `KXNBA3PT` |
| MLB | 686k | `KXMLBGAME`, `KXMLBTOTAL`, `KXMLBKS`, `KXMLBSPREAD`, `KXMLBHIT`, `KXMLBHR` |
| Soccer (EPL/LaLiga/SerieA/Bundes/Ligue1/UCL/IPL) | ~870k | `KXEPLGAME`, `KXEPLTOTAL`, `KXEPLBTTS`, `KXEPLSPREAD`, `KXLALIGABTTS`, etc. |
| Tennis | 115k | `KXATPMATCH`, `KXWTAMATCH` |
| Golf | 196k | `KXPGATOP`, `KXPGATOUR`, `KXPGAMAKECUT`, `KXPGAMAJORWIN` |
| NHL, WNBA, NFL, UFC | ~200k combined | `KXNHL*`, `KXWNBA*`, `KXNFL*`, `KXUFC*` |

Total: **575k multi-leg parlay normalizations** across 216 distinct ticker families. The leg-set rule ([`leg-set-implication.ts`](../services/pipeline/src/stage3-arb-detect/leg-set-implication.ts)) already handles all of these via opaque `(side, ticker)` set ops — no schema gap, no missing sports. Earlier wording in this section gave a misleading impression of low usage; the leg-set rule is one of Stage 3's biggest deterministic-edge producers.

**Q2: Are there `exact_score` legs specifically?** NO. Distinct family scan (`SELECT DISTINCT regexp_replace(unnest(leg_signatures), '^(yes|no)\|(KX[A-Z]+).*', '\2')`) returns 216 prefixes, none of which is an exact-score family. The Kalshi sport-result families are `*GAME` (winner), `*TOTAL` (O/U), `*BTTS`, `*SPREAD`, `*GOAL` (first-scorer-ish) — never an `(a, b)` scoreline. Polymarket doesn't emit parlays.

So the schema-extension question is narrow: **the cost only applies if Kalshi ever publishes an exact-score parlay family**.

If it ever does, the schema cost is:
- Migration 032: widen `leg_signatures` column from `text[]` to `jsonb[]` (or a parallel `leg_payloads jsonb` column), carrying `{side, ticker, event_kind, value_primary, value_secondary, value_unit}` per leg — but only for legs that need value-aware comparison.
- Backfill cost: ~580k existing rows get a JSON shape (cheap one-pass UPDATE since `leg_signatures` is already populated).
- `leg-set-implication.ts` parser change: union-type leg signatures with structured matching.

**Estimate**: ~2-3 days of engineering plus migration backfill. Not justified until a parlay with exact-score legs is actually published — and given Kalshi's existing sport-result families don't cover exact scores even for soccer (where the Polymarket product clearly has demand), it's unlikely to land soon.

### 8.5 Persist `outcome_label` to unlock match-winner / draw implications — **shipped**

Originally docs noted that rule 3.1 (`exact_score ⟹ match_winner`) and the draw half of 3.2 were un-implementable because `outcome_label` lived only on the TS interface.

Shipped in this PR via migration [`036_outcome_label.sql`](../docker/migrations/036_outcome_label.sql):
- `outcome_label TEXT` added to `llm_market_normalizations` with a partial btree index.
- `upsertNormalization` + `bulkUpsertNormalizations` write the column.
- `hashKeyGroupQuestions` and `linkMarketsToQuestions` append `COALESCE(n.outcome_label, '')` to the canonical_key (positioned terminally so pre-migration NULL-only rows produce byte-stable keys).
- `ConditionCard` extended with `outcome_label`; `load-condition-cards.ts` selects it.
- `detectExactScoreImplication` now branches on `match_winner` (team-win vs draw via `outcome_label`).

Backfill path: any market reprocessed by Stage 1 picks up the new label. Until Stage 1 reprocesses, the rule's match_winner branches fall through cleanly (`outcome_label IS NULL` for legacy rows is conservatively interpreted as "team-win" but the canonical_subject match against `exact.participants` will still gate spurious edges).

### 8.6 Fix `formatConditionValue` to encode `value_secondary` when present — **shipped**

Both `formatConditionValue` implementations (`text-deterministic.ts`, `kalshi-deterministic.ts`) now include `value_secondary` in the direction=null default case: `"2_1goals"` instead of `"2goals"`. After this fix, the exact_score sibling outcome set ([§4.2](#42-outcome-set-construction)) goes from ~6 slots/fixture (one per scoreA) to the intended ~26 slots/fixture, tightening M5's mutex coverage by ~4×. Also fixes the latent range_snapshot lo/hi collapse for Template A range markets.
