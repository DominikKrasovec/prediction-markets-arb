# pipeline

Multi-stage market enrichment, **event-centric** grouping, and structural-edge pipeline. Reads raw markets from Postgres, enriches and normalises them, rolls them up into cross-platform **events** (matched semantically), then projects outcome-node `questions` + `outcome_sets` and builds static structural edges. It builds **structure only**; the separate `arb-solver` service is the LP-over-Ω engine that consumes this graph (re-priced against live CLOB quotes) to find arb opportunities.

> **Event-centric rewire (2026-05).** Stages 2 and 3 were rewired from the old
> hash-key question grouping + implication rule-engine zoo (I1–I10 / M1–M9 /
> E1–E2 etc.) to an event-identity + cross-platform event-matching path. The old
> `stage2-questions/` directory and the Stage-3 rule engine were RETIRED. Only
> Stage-4 *static* edge builders run today (threshold ladders, exact-score-derived
> cross-kind edges, tournament structural edges, numeric/date/mutex cross-question
> edges, contradiction detection). See `MEMORY.md` (`project_event_centric_rewire`)
> for the full cutover record.

## Responsibilities
- **Stage 0** — Seed entity KB; sync raw platform tables → unified `markets` table
- **Stage 1** — Deterministic market enrichment: regex features, deterministic templates (no LLM), embedding, entity KB resolution, category taxonomy. Template-miss markets carry no normalization row and are absorbed by the event layer at Stage 3b leg-mapping.
- **Stage 2 (events)** — Roll markets up into `platform_events`: event-identity roll-up (category/event_kind/date), singleton-event reconstruction for orphan markets, native entity resolution, and event embeddings
- **Stage 3 (events)** — Match events cross-platform: ANN candidate discovery (no LLM) → deterministic crypto-candle + option-set/numeric confirmation → one LLM call per residual candidate to confirm same-event + leg mapping → `semantic_events`
- **Stage 4 (events)** — Deterministic finalizer: project outcome-node `questions` + `outcome_sets`/slots, build static structural edges (threshold ladders, exact-score-derived, tournament, numeric/date/mutex cross-question), run contradiction detection, then publish `graph_updated`. The in-pipeline arb scanner was retired — pricing/scoring live in arb-solver.
- **Entity enrichment** — Parallel worker pool that classifies and deduplicates KB entities via LLM

## Directory layout

```
pipeline/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 Entry: dispatch to run.ts (batch) or daemon.ts
    ├── config.ts                All tuning params loaded from env (intervals, thresholds, LLM model)
    ├── run.ts                   Full pipeline: Stage 0 → 1 → runEventGraph() in sequence
    ├── run-event-graph.ts       Event-centric Stage 2+3+4 build (2a→2b→2c→3a→3b→4)
    ├── daemon.ts                3 parallel loops: Stage1-workers + Sync + event-graph trigger
    ├── stage1-normalize/        Market enrichment workers → see stage1-normalize/doc.md
    ├── stage2-events/           Event-identity roll-up, singleton reconstruction, event embeddings
    ├── stage3-events/           Cross-platform event matching: ANN + deterministic confirm + LLM
    ├── stage4-events/           Deterministic finalizer: outcome-nodes, outcome_sets, static edges
    ├── stage3-arb-detect/       Retired rule zoo; only contradiction-detector.ts remains
    ├── entity-enrichment/       LLM entity KB worker pool → see entity-enrichment/doc.md
    ├── db/                      Postgres helpers and all query modules → see db/doc.md
    ├── util/                    Bounded concurrency helper, misc utils
    └── scripts/                 One-off backfill scripts
```

## Execution modes
- **Batch** (`PIPELINE_MODE` unset): run full pipeline once, then tail-schedule periodic runs
- **Daemon** (`PIPELINE_MODE=daemon`): 3 loops run continuously in parallel:
  1. Stage 1 workers (drain `stage1_queue`)
  2. Sync loop (listen for `markets:synced` SSE, then sync + enqueue)
  3. Event-graph trigger (drain `stage23_queue` → `runEventGraph()` for incremental runs)

## Caveats
- The only LLM in the core pipeline is the Stage-3b event matcher (gated by `STAGE3_SKIP_LLM`) plus the async entity-enrichment workers (gated by `ENTITY_ENRICHMENT_SKIP`). Stage 1 is deterministic-only after the event-centric rewire — there is no LLM normalization pass. LLM calls are rate-limited; batch sizes and flush thresholds are configurable via env.
- Deterministic matching runs before the LLM to save cost — `text-deterministic.ts` / `kalshi-deterministic.ts` at Stage 1, and the crypto-candle + option-set/numeric confirmers at Stage 3 before the LLM matcher.
- The `stage1_queue` and `stage23_queue` provide resumability; interrupted runs pick up where they left off.
- The full run (`run.ts`) also drains the entity enrichment queue at the end of Stage 1 — this can take significant time on first runs.
