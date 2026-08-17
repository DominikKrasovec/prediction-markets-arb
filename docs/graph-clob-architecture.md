# Graph ↔ CLOB architecture

How a row in `markets` becomes a subscription on a CLOB WebSocket, and how prices flow back into the solver. (See the staleness banner below: the write-side stage descriptions are pre-rewire; the read-side / CLOB layer is current.)

This is a newbie-oriented map of the read-side of the system (the arb-solver loop). If you want the write-side (how data lands in Postgres), read the per-stage `doc.md` files first ([pipeline/doc.md](../services/pipeline/doc.md), [ingestion/doc.md](../services/ingestion/doc.md)).

> **⚠️ STALENESS BANNER (2026-06-10).** The **write-side** half of this doc — the Stage 1→2→3 data-flow diagram, the "Per-stage walk", and the 2026-05-25 "Current state quantified" / "Critical issues" / "TODOs" census — describes the **pre-event-centric pipeline that has since been RETIRED.** That pipeline (`stage2-questions/` hash-key grouping + the Stage-3 `implication-edges.ts` rule zoo / `outcome-sets.ts`) was deleted in the event-centric rewire. The current pipeline is `stage1-normalize → stage2-events → stage3-events → stage4-events` (see [run.ts](../services/pipeline/src/run.ts) → [run-event-graph.ts](../services/pipeline/src/run-event-graph.ts)); `questions` / `question_members` / `implication_edges` / `outcome_sets` are now *projected* by `stage4-events/finalize.ts`, not produced by a per-pair rule engine. For the current architecture read [`architecture-snapshot-2026-05-29.md`](architecture-snapshot-2026-05-29.md) and [`event-centric-pipeline-2026-05-30.md`](event-centric-pipeline-2026-05-30.md).
>
> **What is still accurate and worth keeping in this doc:** the **read-side / CLOB layer** — the graph-loader contract, cluster-builder, the per-platform CLOB adapter protocol, PriceCache, and the solver loop. Those sections (`Graph layer` onward, plus the [CLOB perf-harness doc](./clob-perf-test.md) it links) match current code at the *contract* level. The CLOB-specific bug discussion (Polymarket `condition_id → clobTokenIds`, both-sides emit, Limitless child markets) is also still relevant — but verify each against current adapter code, since the live Polymarket adapter has since been reworked to *expect* a clobTokenId platformId.
>
> **SHIPPED SINCE, not yet reflected in the read-side prose below (audited 2026-07-02):**
> - **Depth-aware book ladder** (`CLOB_BOOK_LADDER=1`, default OFF) — all 4 adapters emit a full `[price,size]` ladder (`askLevels`/`bidLevels`); `lp-builder` splits a buy leg into one tranche per level (walk deeper for more $ at a worse price). See [token-map.ts:44](../services/arb-solver/src/clob/token-map.ts#L44), [price-cache.ts:23](../services/arb-solver/src/clob/price-cache.ts#L23). The `PriceUpdate { bestBid, bestAsk }` contract described below is now the *top-of-book* subset.
> - **Two-sided books** (unconditional) — the manager always expands each verified market into a real NO-token book; PriceCache routes YES/NO to separate entries. This *implements* issue #2's "buy NO directly vs synthetic-NO" fix. See [manager.ts:34](../services/arb-solver/src/clob/manager.ts#L34), [token-map.ts:9](../services/arb-solver/src/clob/token-map.ts#L9).
> - **Top-2-levels CDC** — PriceCache re-solves on a level-1 (2nd-best) ladder move, not just top-of-book. [price-cache.ts:161](../services/arb-solver/src/clob/price-cache.ts#L161).
> - **Solver worker pool** (`SOLVER_WORKER_POOL`, default OFF) — [solver-pool.ts](../services/arb-solver/src/solver/solver-pool.ts), wired in [index.ts:71](../services/arb-solver/src/index.ts#L71).
> - **GATE-0 boot self-check** in the graph loader — fail-safe to Σ≤1 if migration 061 (`outcome_sets.is_exhaustive`) is absent. [loader.ts:160](../services/arb-solver/src/graph/loader.ts#L160).
> - **Execution gate + graded residual + settlement-risk flag** (`f32f407`/`de749d3`/`1bc5791`, migs 062/063) — the solver now applies per-market fees, depth caps, quote-age TTL, leg grading, and a cross-venue-settlement TAIL flag.
> - **`run-monitor/run.ts`** — a read-only observation harness driving the byte-identical production solve path against live CLOB feeds with a full per-arb debug log (no DB writes). [run-monitor/run.ts](../services/arb-solver/src/run-monitor/run.ts).
>
> The historical 2026-05-25 figures (968 Kalshi-only, 1.03M markets, 432k edges) are a frozen pre-rewire snapshot — do **not** treat any count below as live; re-probe the current DB.

---

## TL;DR for a newbie

1. **`markets`** is the unified table of every open market on any platform.
2. **`questions`** are equivalence classes of markets ("these all bet on the same thing"). One market belongs to at most one question. Stage 1 normalizes each market into a `canonical_key`; Stage 2 collapses matching keys into one question.
3. **`implication_edges`** are directed logical relationships *between questions* — "A YES implies B YES", "A and B are mutually exclusive", etc. Stage 3 produces them.
4. **`outcome_sets`** are exhaustive groups of questions ("exactly one of these resolves YES"), e.g. all candidates in a single-winner event.
5. The **arb-solver** loads questions + edges + outcome_sets from the DB, finds connected-component **clusters**, derives the **market list to subscribe to**, opens **CLOB WebSockets** per platform, and on every price tick re-solves the LP for the affected cluster.

The thing that can ship a price update or not, all the way from `kalshi_markets.raw` → an `ArbOpportunity` row, lives entirely in `services/arb-solver/src/`.

---

## End-to-end data flow

```
PLATFORM APIs                                                                          
   │ scrape/poll                                                                       
   ▼                                                                                   
[ingestion/scrapers]                                                                   
   │ writes raw envelopes                                                              
   ▼                                                                                   
{kalshi_markets, polymarket_markets, limitless_markets, predict_markets}               
   │ sync (pipeline/db/sync.ts)                                                        
   ▼                                                                                   
[markets]   ← unified row per platform market                                          
   │ stage1_queue                                                                      
   ▼                                                                                   
[STAGE 1]   normalize: regex / Kalshi-deterministic / LLM fallback                     
   │ writes one row per market:                                                        
   ▼                                                                                   
[llm_market_normalizations]   canonical_subject, condition_*, value_*, participants[]  
   │ stage23_queue                                                                     
   ▼                                                                                   
[STAGE 2]   hashKeyGroupQuestions + ANN candidate generation                           
   │ writes:                                                                           
   ├─→ [questions]            one row per canonical_key                                
   └─→ [question_members]     market_id → question_id (PK on market_id)                
                                                                                       
[STAGE 3]   rule engine + LLM classifier + arb scanner                                 
   │ writes:                                                                           
   ├─→ [implication_edges]    A_qid → B_qid (edge_type, confidence, basis_risk)        
   ├─→ [outcome_sets]         { set_type: 'categorical' | 'threshold_series', … }      
   └─→ [outcome_set_slots]    set_id → question_id mapping                             
                                                                                       
═══════════════════════════ DB boundary ═══════════════════════════                    
                                                                                       
[arb-solver / graph/loader.ts]                                                         
   │ 3 SQL queries:                                                                    
   │   q1: questions ⋈ question_members ⋈ markets                                      
   │   q2: implication_edges where confidence ≥ MIN_EDGE_CONFIDENCE                    
   │   q3: outcome_sets ⋈ outcome_set_slots                                            
   │ output: ConstraintGraph { questions, edges, outcomeSets }                         
   ▼                                                                                   
[graph/cluster-builder.ts]                                                             
   │ BFS over edges+outcome_sets → Cluster[]                                           
   │ enumerateStates(cluster) → WorldState[]                                           
   ▼                                                                                   
[arb-solver/index.ts] getMarketsToTrack()                                              
   │ flattens all cluster.questions.markets → MarketSubscription[]                     
   ▼                                                                                   
[clob/ClobManager.startTracking(subs)]                                                 
   │ groups by platform, hands each adapter its slice                                  
   ▼                                                                                   
[clob/adapters/{kalshi,polymarket,limitless,predict}.ts]                               
   │ open WSS, parse messages, reconstruct local order books                           
   │ emit PriceUpdate { marketId, bestBid, bestAsk, … }                                
   ▼                                                                                   
[clob/PriceCache]   in-memory Map<marketId, snapshot>                                  
   │ on update: marketClusterIndex.get(marketId) → cluster.dirty = true                
   ▼                                                                                   
[solver/lp-builder + solver/solver.ts (HiGHS WASM)]                                    
   │ buildLP(cluster, priceCache) → LPProblem                                          
   │ solveLP() → SolverResult                                                          
   │ extractPortfolio() → ArbOpportunity | null                                        
   ▼                                                                                   
[arbitrage_opportunities] + event-bus arb:detected                                    
```

---

## Tables reference

### Core graph tables

| Table | Owner | Purpose | PK / unique |
|-------|-------|---------|-------------|
| `markets` | ingestion → pipeline/sync | Unified row per `(platform, platform_id)` open market. 28 columns; `raw` jsonb has the platform-native envelope. | id (PK), `(platform, platform_id)` unique |
| `llm_market_normalizations` | pipeline/stage1 | One row per market — `canonical_subject`, `condition_shape`, `condition_metric`, `value_primary`, `participants[]`, `leg_signatures[]`, etc. | market_id (PK) |
| `questions` | pipeline/stage2 | Equivalence class of markets sharing a `canonical_key`. Has cached `member_count`, `platform_count`, `open_member_count`, `best_*_price`. | id (PK), canonical_key unique |
| `question_members` | pipeline/stage2 | `(question_id, market_id)` link. One market belongs to at most one question. | market_id (PK), `(question_id, market_id)` unique |
| `implication_edges` | pipeline/stage3 | Directed edge between two questions. Carries `edge_type` (`strict_implication` / `mutual_exclusion` / `near_equivalence` / `equivalence` / `conditional`), `pattern`, `confidence`, `basis_risk`, `source` (`algorithmic` / `platform_structure` / `llm` / `transitive`). | id (PK) |
| `outcome_sets` | pipeline/stage3 | A group of questions where outcomes are jointly constrained: `categorical` (mutex+exhaustive) or `threshold_series` (monotone). | id (PK) |
| `outcome_set_slots` | pipeline/stage3 | `(set_id, slot_ordinal, question_id)` ordered membership. | `(set_id, slot_ordinal)` |
| `market_cross_refs` | ingestion/scrapers | Platform-published cross-platform links (today: only Polymarket → Predict via `polymarketConditionIds[]`). 1,852 rows. Used as a Stage 2 hint, not a cluster source. | `(source_market_id, target_platform, target_platform_id)` |

### Per-platform raw tables (one per scraper)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `kalshi_markets` | `ticker`, `event_ticker` | `raw` stores pre-transform snake_case envelope (load-bearing — see [duplicates.md §11](../services/duplicates.md)). |
| `polymarket_markets` | `condition_id` | `raw->'clobTokenIds'` is `[YES_tokenId, NO_tokenId]`; `raw->'negRisk'` flags negRisk markets; `raw->'negRiskMarketID'` groups them. |
| `limitless_markets` | `slug` | `raw->>'marketType'` = `'group'` (multi-outcome wrapper, has `raw->'markets'` array of children) or `'single'` (binary). Children of group wrappers are NOT stored as their own rows. |
| `predict_markets` | numeric id | Stored as string in `markets.platform_id`. |
| `kalshi_events`, `polymarket_events`, `predict_categories`, `platform_events` | event id | Group multiple markets that constitute one real-world event. |

### Runtime / harness tables

| Table | Owner | Purpose |
|-------|-------|---------|
| `clob_prices` | arb-solver/persistence.ts | Periodic snapshot of `PriceCache` for the dashboard. Currently empty (no live solver running). |
| `arbitrage_opportunities` | arb-solver/persistence.ts | Each solved opportunity (legs, profit, expiry). Currently empty. |
| `v_active_arbitrage` | view | Filter on `arbitrage_opportunities` for the dashboard. |
| `stage1_queue` | pipeline | Work-queue for Stage 1 — `status ∈ ('pending', 'done')`. Acts as a backlog by design (Stage 1 LLM-skip policy). |
| `stage23_queue` | pipeline | Trigger for incremental Stage 2+3 reruns. |
| `pipeline_state` | pipeline | Cursors and watermarks (e.g. `resolution_checkpoint_<platform>`). |
| `rule_engine_decisions` | pipeline/stage3 | Audit trail of every rule-engine verdict per pair (acts as a Stage 3 cache). |

---

## Per-stage walk

> **RETIRED-ARCHITECTURE NOTE (2026-06-10):** the Stage-2 and Stage-3 subsections below describe the *old* `stage2-questions/` hash-key grouping and the Stage-3 `implication-edges.ts` rule-engine zoo, **both of which were deleted in the event-centric rewire**. They are kept here only as historical context for the read-side contract. The current write-side is `stage2-events → stage3-events → stage4-events`; `questions` / `question_members` / `implication_edges` / `outcome_sets` are projected by [`stage4-events/finalize.ts`](../services/pipeline/src/stage4-events/finalize.ts). Stage 1 (`stage1-normalize/`) is still current and regex-first as described.

### Stage 1 — normalize (`pipeline/src/stage1-normalize/`)

**Input:** rows in `markets` that haven't been normalized yet (via `stage1_queue`).

**Output:** one row in `llm_market_normalizations` per market, with `canonical_subject`, `condition_*`, `value_*`, `participants[]`, `leg_signatures[]`, `outcome_label`, `condition_date`/`condition_date_precision`, `category_unified`.

**How:** regex-first pipeline. [`kalshi-deterministic.ts`](../services/pipeline/src/stage1-normalize/kalshi-deterministic.ts) handles Kalshi via four ordered sub-passes (typed-strike, MVE parlay series, player props, categorical). [`text-deterministic.ts`](../services/pipeline/src/stage1-normalize/text-deterministic.ts) handles cross-platform titles via templates E/F/G/H/J/.... Stage 1 is deterministic-only: a row that matches no template gets no normalization row at all and is deferred to the event layer at Stage 3b leg-mapping.

**Critical for graph:** `canonical_subject` (and the rest of the canonical-key fields) decides which question a market joins. A drift in normalization output causes Stage 2 to create a *new* question rather than joining the existing one — and the old question becomes an orphan.

### Stage 2 — questions (`pipeline/src/stage2-questions/`)

**Input:** normalized markets (`llm_market_normalizations`).

**Output:**
1. `questions` rows (one per distinct `canonical_key`),
2. `question_members` rows (one per market),
3. Stage-3 candidate pairs (for ANN-discovered cross-platform pairs that don't share a canonical_key).

**How:**
- [`hashKeyGroupQuestions`](../services/pipeline/src/db/queries/questions.ts) (SQL CTE) reads `llm_market_normalizations ⋈ markets`, GROUPs BY the 12 canonical-key components, builds the canonical_key string in SQL, INSERTs into `questions` with `ON CONFLICT (canonical_key) DO UPDATE`.
- [`linkMarketsToQuestions`](../services/pipeline/src/db/queries/questions.ts) rebuilds the same canonical_key per market and INSERTs into `question_members ON CONFLICT (market_id) DO UPDATE`.
- [`ann-search.ts`](../services/pipeline/src/stage2-questions/ann-search.ts) does pgvector cosine-similarity search across `market_embeddings` for cross-platform pairs that have different canonical_keys but high semantic similarity.

**Critical for graph:** `question_members` is the *only* place that maps a market to a question. If a market has a normalization but no `question_members` row, the solver can't reach it.

### Stage 3 — edges + outcome sets (`pipeline/src/stage3-arb-detect/`)

**Input:** candidate question pairs (from Stage 2) and the current question set.

**Output:**
- `implication_edges` (directed, with `edge_type` + `confidence`),
- `outcome_sets` + `outcome_set_slots` (categorical or threshold-series groups),
- `arbitrage_opportunities` (the scanner's findings — note this is computed at Stage 3 with stale prices; the arb-solver computes it again with live prices).

**How:** [`implication-edges.ts`](../services/pipeline/src/stage3-arb-detect/implication-edges.ts) is the rule-engine orchestrator. It applies rules in priority order: E0 platform-cross-ref → M5 outcome_set exclusion → LSI leg-set → I8/I9 parlay → X-checks → E2 near-equivalence → I1..I10 implications → M1..M7 exclusions → LLM fallback. First match wins.

[`outcome-sets.ts`](../services/pipeline/src/stage3-arb-detect/outcome-sets.ts) is where the negRisk-group / categorical exhaustion structure gets built. **This is the layer that should be linking the 3-way football outcomes — and currently isn't (see [§ Critical issues](#critical-issues) #3).**

### Graph layer (`arb-solver/src/graph/`)

**Reads:** `questions`, `question_members`, `markets`, `implication_edges`, `outcome_sets`, `outcome_set_slots`. Three SQL queries total. See [loader.ts](../services/arb-solver/src/graph/loader.ts).

**SQL filters applied at load time:**
- `questions.archived_at IS NULL`
- `markets.resolved_at IS NULL`
- `implication_edges.archived_at IS NULL`
- `implication_edges.confidence >= MIN_EDGE_CONFIDENCE` (default 0.70)

**Output:** `ConstraintGraph { questions: Map, edges: EdgeRef[], outcomeSets: OutcomeSetRef[] }`.

**Cluster building** ([cluster-builder.ts](../services/arb-solver/src/graph/cluster-builder.ts)): treats edges and outcome-set slots as an undirected adjacency relation, BFS to find connected components. Each connected component becomes a `Cluster`. Singleton questions (no edges, no outcome-set membership) form singleton clusters and are skipped by the solver (no arb possible without a relationship).

### CLOB layer (`arb-solver/src/clob/`)

**Input:** `MarketSubscription[]` flattened from all clusters. See [arb-solver/src/index.ts:56-75](../services/arb-solver/src/index.ts#L56-L75) `getMarketsToTrack()`.

**Internals:** [`ClobManager`](../services/arb-solver/src/clob/manager.ts) is a thin fan-out — it owns one of each adapter (kalshi / polymarket / limitless / predict) and routes each `MarketSubscription` to the right one. Each adapter is responsible for:
- opening + reconnecting its WSS,
- subscribing (`assets_ids` for polymarket, `market_tickers` for kalshi, `marketSlugs` for limitless, `predictOrderbook/{id}` topics for predict),
- parsing the wire payload, maintaining a local depth book,
- emitting `PriceUpdate { marketId, bestBid, bestAsk, bidSize, askSize, timestamp, wireTs?, serverTs?, msgKind?, outcome? }`.

See the [CLOB perf-harness doc](./clob-perf-test.md) for the per-platform protocol differences (YES-only vs both-sides, native server ts availability, multi-outcome expansion).

**PriceCache** ([price-cache.ts](../services/arb-solver/src/clob/price-cache.ts)): `Map<marketId, snapshot>`. Used by the LP builder. `staleSince != null` means "exclude from LP". Eviction triggers: market resolved (via WSS resolution event OR via the 60s `resolved_at` poll).

### Solver layer (`arb-solver/src/solver/`)

**Trigger:** debounced (`config.solver.debounceMs`, default 10 ms) after any price update lands on a market in a non-empty cluster.

**Pipeline:**
- [`state-enumerator.ts`](../services/arb-solver/src/solver/state-enumerator.ts) → all valid world states given outcome-set + edge constraints (precomputed once per graph reload).
- [`lp-builder.ts`](../services/arb-solver/src/solver/lp-builder.ts) → constructs the LP text in HiGHS format.
- [`solver.ts`](../services/arb-solver/src/solver/solver.ts) → loads HiGHS WASM (one-time, cached), solves the LP synchronously.
- [`portfolio.ts`](../services/arb-solver/src/solver/portfolio.ts) → maps LP variable values back to concrete market legs, filters by `config.solver.minProfit`.

**Output:** `ArbOpportunity | null`. If non-null, persisted to `arbitrage_opportunities` and broadcast on the event-bus channel `pipeline` as `arb:detected`. When an opportunity's profit drops below the threshold, `arb:expired` is published.

---

## Current state quantified

> **HISTORICAL (pre-rewire, 2026-05-25).** These counts describe the retired Stage-1/2/3 pipeline and are NOT live. The "orphan question" / "968 Kalshi edge endpoints" phenomenon was an artifact of that pipeline's hash-key drift; Stage 4 now re-projects questions from normalizations every run, so the orphan-edge framing no longer applies. Kept for history only.

Numbers from a live probe on 2026-05-25 (DB state — what the production solver would see if started right now):

| Layer | Metric | Count | Comment |
|-------|--------|------:|---------|
| markets | total | 1,032,122 | |
| markets | resolved | 0 | 214 marked `status='RESOLVED'` but `resolved_at IS NULL` — resolution-monitor incomplete (see [issue #5](#critical-issues)) |
| llm_market_normalizations | rows | 950,577 | 81,545 markets (~8%) have no normalization yet — pending `stage1_queue` |
| stage1_queue | `status='pending'` | 94,817 | Backlog by design (LLM skip policy) |
| stage1_queue | `status='done'` | 937,305 | |
| questions | total | 1,766,515 | |
| questions | `archived_at IS NULL` | 1,757,867 | |
| questions | with `question_members` row | 880,987 | **50%** — the other 876,880 are **orphan rows** (no current member) |
| question_members | rows | 951,666 | ~= the normalized open-market count |
| implication_edges | total | 432,533 | |
| implication_edges | active (`archived_at IS NULL`) | 432,533 | None archived yet |
| implication_edges | distinct questions touched | 44,238 | |
| implication_edges | distinct questions with a member row | **968** | **97.8% of edge endpoints are orphan questions** |
| outcome_sets | rows | 98,151 | |
| outcome_set_slots | rows | 552,963 | avg 5.6 slots per set |
| `market_cross_refs` | rows | 1,852 | Polymarket → Predict (`polymarketConditionIds`) only |

### What the production solver actually sees

Running the exact graph-loader SQL ([loader.ts:41-49](../services/arb-solver/src/graph/loader.ts#L41-L49)) **filtered to edge-touched questions**:

```
distinct questions returned : 968
distinct markets   returned : 979
platforms represented       : 1   ← kalshi only
```

The other 52,586 Polymarket questions, 1,853 Predict questions, and 632 Limitless questions all sit in `question_members` and have *zero edges* in `implication_edges`. The edge graph is referencing question IDs from a previous Stage 2 run, none of those question rows still have member markets.

---

## Critical issues

> **MOSTLY SUPERSEDED (2026-06-10).** Issue #1 (dormant edge graph / orphan questions) was a *pre-rewire* drift artifact and no longer applies — the event-centric Stage 4 re-projects questions+edges from current normalizations every run. Issues #2 (Polymarket subscribe id), #3 (negRisk outcome-sets), #4 (Limitless children), #5 (resolution monitor) describe genuine CLOB/data concerns, several of which have since been partially addressed (e.g. the live Polymarket adapter now *expects* a clobTokenId platformId and supports per-outcome books) — verify each against current adapter / Stage-4 code before acting. Issue #6 (cached `member_count`) is a reporting concern on a table the loader no longer leans on.

These were pipeline / data-integrity issues at the 2026-05-25 snapshot, not CLOB bugs.

### 1. Edge graph is dormant — only 968 of 44,238 edge endpoints are reachable  *(SUPERSEDED — pre-rewire artifact)*

The most damaging issue. `implication_edges` references 44k distinct question ids; only 968 of those questions currently have any market via `question_members`. The other 43k are orphan question rows from a prior Stage 2 run.

**Root cause:** Stage 1 normalizations were regenerated (likely via `backfillSubjectsViaKB` in [`db/entity/backfill.ts`](../services/pipeline/src/db/entity/backfill.ts)). New normalizations produce slightly different `canonical_key` strings → Stage 2 creates *new* question rows → old question rows survive, retaining their edges → those edges now point at unreachable questions.

**Symptom for the solver:** ALL of the edge graph is invisible except for the 968 Kalshi questions that happened to retain their canonical_key. The other 3 platforms have 55,071 questions in `question_members` but zero in any edge — so cross-platform arb (the entire reason this system exists) cannot fire.

**Fix:** rerun Stage 3 (`runStage3()` over the current question set) to regenerate edges against current question IDs, and add an orphan-question GC step. The architectural fix is for `updateAllQuestionCounts` to also archive `member_count = 0` orphans (the comment says they're "separately GC'd" — but no such code exists in the repo).

### 2. Polymarket adapter cannot subscribe with `condition_id`  *(FIXED — audited 2026-07-02)*

> **FIXED.** The live adapter now resolves `condition_id → clobTokenIds` via
> [`token-map.ts`](../services/arb-solver/src/clob/token-map.ts) and unconditionally
> (the `CLOB_TWO_SIDED_BOOKS` flag was removed 2026-07-06) subscribes to BOTH outcomes with
> the PriceCache keyed per side. The workaround below is now the production path, not a
> perf-harness-only hack.

`markets.platform_id` for Polymarket is the hex `condition_id`. The Polymarket CLOB WSS `assets_ids` field expects `clobTokenIds[i]` (a big decimal token id). Subscribing with a `condition_id` makes the WS server silently accept and never emit.

The perf-harness loader works around it ([load-subs.ts](../services/arb-solver/src/clob/perf-harness/load-subs.ts)) by translating `condition_id → clobTokenIds[0]` (YES) and `clobTokenIds[1]` (NO). **The live arb-solver adapter does not do this** — it passes `platform_id` straight through and gets nothing back.

**Fix (one of):**
- Store the YES and NO token IDs on `markets` (a `subscribe_id` jsonb column or two columns).
- OR have the adapter do the lookup at subscribe time (one extra SQL).
- AND emit two `MarketSubscription` rows per Polymarket market (one per outcome). The two CLOBs are independent — selling YES into the YES bid is NOT a substitute for buying NO directly.

### 3. negRisk multi-outcome groups have no Stage-3 mutex edges or outcome sets

Verified with a sample 3-way Polymarket football fixture (Red Star FC vs Rodez Aveyron Football, `negRiskMarketID = 0x3d40b00…`):

| outcome | question_id | exists in `implication_edges`? | exists in `outcome_set_slots`? |
|---------|-------------|--------------------------------|--------------------------------|
| Red Star FC | 17656560 | no | no |
| Draw | 17656561 | no | no |
| Rodez Aveyron Football | 17658254 | no | no |

So even with perfect prices on all three markets, the solver cannot reason about "exactly one of these resolves YES" — there are no edges to give the LP that constraint.

Stage 3's [`outcome-sets.ts`](../services/pipeline/src/stage3-arb-detect/outcome-sets.ts) is supposed to detect categorical-mutex groups; it isn't picking up Polymarket's negRisk grouping. Could be a missing detector (negRisk groups are recognizable via `polymarket_markets.raw->>'negRiskMarketID'` — the simplest possible categorical signal).

Also, the Stage 1 normalization labels the Draw question's `canonical_subject` as one of the team names (975 of 1,009 Polymarket Draw questions in the DB have a team-named canonical_subject), which makes downstream debugging confusing. The `canonical_key` does disambiguate.

### 4. Limitless multi-outcome children are not in `markets`  *(FIXED — audited 2026-07-02)*

> **FIXED (differently than proposed).** The fix landed in the pipeline sync, not the
> scraper: `expandMarketDocs` in [`db/sync.ts`](../services/pipeline/src/db/sync.ts) flattens
> Limitless `marketType='group'` rows into one `markets` row per child at sync time (native
> deterministic explode). Group children are now visible to the solver.

Of 1,101 open Limitless markets in the unified `markets` table:
- 643 are `marketType='single'` (binary)
- 458 are `marketType='group'` wrappers

The group wrappers point to 1,691 child markets (via `raw->'markets'`) — those children are **not** stored as their own rows in `limitless_markets` or `markets`. The perf-harness loader expands them at subscribe time; the live solver doesn't see them at all.

**Fix:** the Limitless scraper should persist child markets as their own rows. They have their own `slug`, `conditionId`, `tokens.yes`, `tokens.no`, and inherit a `groupId` from the parent.

### 5. Resolution monitor has gaps

214 markets carry `status='RESOLVED'` but `resolved_at IS NULL`. Those markets stay in the solver's tracked set forever; the only thing that evicts them is the WSS `market_resolved` event (Polymarket only) or the 60s `resolved_at` poll, neither of which fires when ingestion's resolution-monitor failed to update `resolved_at`.

Not a CLOB issue per se — but if the solver ever does run against a current graph, expect 200+ stale subscriptions to accumulate.

### 6. The `question.member_count` cached column is unreliable

`SUM(question.member_count) = 1,901,940` but `COUNT(*) FROM question_members = 951,666`. The cached column is ~2× the truth. `updateAllQuestionCounts` is meant to fix this but evidently isn't run in this DB, or runs after orphan rows are already disconnected.

Nothing in the arb-solver reads this column today (the graph loader joins to `question_members` directly), so it's a dashboard / reporting concern. But it's a smell — the `archived_at IS NULL AND open_member_count > 0` filter the loader uses to skip archived questions is also driven by this column, and the count is wrong.

---

## Deprecated / cleanup candidates

Code paths the graph→CLOB review surfaced that are still present but superseded:

### Now superseded — safe to remove on next pass

| Code | Where | Why it's dead |
|------|-------|---------------|
| Polymarket adapter's `outcome=undefined` legacy emit path | [polymarket.ts:268](../services/arb-solver/src/clob/adapters/polymarket.ts#L268) | The perf-harness now always passes `outcome:'yes' / 'no'`. The only remaining consumer of the "undefined outcome" path is the live arb-solver loop, which is itself broken (issue #2). Once the solver is fixed to pass both sides, the legacy branch can go. |
| Old Predict WSS URL (`wss://api.predict.org/ws`) | already deleted in this branch — confirm no reference remains | The wrong URL leaked through `dist/` siblings and bypassed the rewrite. The actual Predict WSS is `wss://ws.predict.fun/ws`. |
| `.js` / `.d.ts` / `.js.map` sibling files in `services/arb-solver/src/clob/` | deleted in this branch; do not regenerate | Came from a prior `tsc <file>` invocation that ignored `noEmit`. The `feedback_tsc_file_args` memory documents this; always use `tsc -p <project>`. |
| `polymarket_activities`, `polymarket_wallet_stats` tables | DB schema | Present in `\dt` output but not joined by any production query in the arb-solver path. Confirm with scraper before dropping. |

### Conditional / "delete after issue #1 fixed"

| Code | Why it'd be dead |
|------|------------------|
| `updateAllQuestionCounts`'s comment "(those are orphaned questions, separately GC'd)" — and the missing GC | The GC code doesn't exist. Either add it, or change the comment to admit orphans accumulate. |
| Stage 3 rule `I8 / I9 parlay regex` ([`parlay-implication.ts`](../services/pipeline/src/stage3-arb-detect/parlay-implication.ts)) | Stage 3 doc says these are "legacy regex-based, fallback when LSI doesn't apply". LSI (`leg-set-implication.ts`) supersedes them on every Kalshi×Kalshi pair with `leg_signatures`. Audit candidate once you re-run Stage 3. |
| Stage 1 `text-deterministic.ts:332` "legacy `source_tag` fallback" | Inline-documented as legacy; the resolution-source fix is documented in migration 048. |
| `arbitrage_opportunities` table view `v_active_arbitrage` | Empty today (no solver runs against current graph). Once solver runs, verify the view's filter still matches the writer's semantics. |

### Tables that look orphaned but are intentional

| Table | Why it stays |
|-------|--------------|
| `benchmark_markets`, `benchmark_normalizations` | Eval / regression fixtures — kept on purpose. |
| `market_cross_refs` | Platform-published cross-platform links (1,852 rows). Used as a Stage 2 hint signal — not the graph source. |
| `polymarket_events`, `kalshi_events`, `platform_events`, `predict_categories` | Group memberships at the platform level — feed Stage 3's event-zipper. |
| `dashboard_pairs`, `review_verdicts`, `review_verdict_history` | Dashboard manual-review surface. |

---

## TODOs, prioritized

> **STALE (2026-06-10).** The P0 items ("rerun Stage 3", "orphan-question GC") targeted the retired rule-engine pipeline and no longer apply. The P1–P3 CLOB / ingestion items (Polymarket subscribe id + both-sides, negRisk outcome-sets, Limitless children, resolution monitor) may still be partly open — cross-check against the live adapters and Stage-4 finalize before treating any as outstanding.

### P0 — blocks the solver from doing anything useful

1. **Rerun Stage 3** against the current `questions` + `question_members` so `implication_edges` references reachable questions again. After this, ~30k markets should become arb-solver-eligible (vs the current 979).
2. **Add an orphan-question GC** to `updateAllQuestionCounts`: `UPDATE questions SET archived_at = NOW() WHERE archived_at IS NULL AND member_count = 0`. Then run it. This isn't load-bearing yet but it'll prevent the same drift next cycle.

### P1 — needed for cross-platform arb to actually be tradeable

3. **Fix Polymarket subscribe ID + both-sides emit** in the live adapter (mirror what the perf-harness loader does):
   - Translate `condition_id → clobTokenIds[i]` at subscribe time (or add a `subscribe_id` column).
   - Subscribe to BOTH outcomes, emit one `PriceUpdate` per side with `outcome:'yes'/'no'`.
   - Make `PriceCache` keyed by `(marketId, outcome)`, not just `marketId`, so the LP can pick the cheaper of "buy NO directly" vs "sell YES synthetic NO".
4. **Build negRisk outcome-sets in Stage 3.** Polymarket `negRiskMarketID` is a clean grouping signal; emit a `categorical` `outcome_sets` row per group, with every question in the group as a slot. After this, the LP knows "exactly one resolves YES."

### P2 — capture markets we currently can't see

5. **Persist Limitless multi-outcome children** as their own `limitless_markets` / `markets` rows in the ingestion scraper. Today 1,691 child markets are entirely invisible to the solver.
6. **Fix Stage 1 canonical_subject for Polymarket negRisk Draw markets.** 975 of 1,009 Draw questions are labelled with a team name. Cosmetic but breaks dashboard reasoning.

### P3 — observability + housekeeping

7. **Resolution-monitor**: reconcile 214 markets where `status='RESOLVED'` but `resolved_at IS NULL`.
8. **Add a reconnect-event counter** to each CLOB adapter (close→open count). Today there's no visibility into how often each WSS drops.
9. **Delete deprecated paths** in the table above once their replacements have soaked.

---

## Newbie reading order

> **NOTE (2026-06-10):** steps 4–5 below point at the deleted `stage2-questions/` + `stage3-arb-detect/implication-edges.ts` rule zoo. For the current write-side read [`event-centric-pipeline-2026-05-30.md`](event-centric-pipeline-2026-05-30.md) and the live `stage2-events/` / `stage3-events/` / `stage4-events/` folders instead. Steps 1–3 and 6–9 (CONTRACTS, Stage 1, graph loader, CLOB, solver) are still accurate.

If you just landed in this repo and want to understand the graph→CLOB story end-to-end:

1. **[CONTRACTS.md](./CONTRACTS.md)** — the prose contract for adapters + resolution-write + sync.
2. **[pipeline/doc.md](../services/pipeline/doc.md)** — high-level pipeline anatomy.
3. **Stage 1**: [`pipeline/src/stage1-normalize/doc.md`](../services/pipeline/src/stage1-normalize/doc.md). Read `kalshi-deterministic.ts` first (most volume) — the other normalizers are the same shape.
4. **Stage 2**: [`db/queries/questions.ts`](../services/pipeline/src/db/queries/questions.ts) — the canonical_key construction lives there twice (in `hashKeyGroupQuestions` and in `linkMarketsToQuestions`). Both must stay byte-identical.
5. **Stage 3**: [`stage3-arb-detect/doc.md`](../services/pipeline/src/stage3-arb-detect/doc.md), then [`implication-edges.ts`](../services/pipeline/src/stage3-arb-detect/implication-edges.ts) (rule priority order is the central concept).
6. **Graph loader**: [`arb-solver/src/graph/loader.ts`](../services/arb-solver/src/graph/loader.ts) — just three SQL queries.
7. **CLOB**: [`clob-perf-test.md`](./clob-perf-test.md) covers the per-platform protocol differences. Then read [`clob/manager.ts`](../services/arb-solver/src/clob/manager.ts) + one adapter.
8. **Solver**: [`solver/doc.md`](../services/arb-solver/src/solver/doc.md).
9. Run the perf-harness with `--dump-raw 5 --duration-min 1 --all-open --max-subs 500` to watch real wire messages flow.

Keep this doc updated when issues #1–#4 are fixed — those are the only things between today's "0 cross-platform arbs" and a working solver.
