# pipeline/src/

Root source of the pipeline service. Entry point dispatches to batch or daemon mode; all pipeline stages live in dedicated subfolders.

## Files at this level

| File | Role |
|------|------|
| `index.ts` | **Entry.** Reads `PIPELINE_MODE` env: if `daemon` → `runDaemon()` (never returns); otherwise → `runPipeline()` + tail-schedule periodic full runs. |
| `config.ts` | **All tunable parameters** loaded from env. Groups: `intervals` (full run, sync, enrichment), `pairing` (ANN k, similarity threshold), `embedding` (model, batch size), `llm` (model, batch sizes, temperature), `edge` (confidence threshold), `stage1` (flush thresholds, worker count), `arb` (min profit). |
| `run.ts` | **Full pipeline.** Orchestrates Stage 0 (seed KB + sync) → 1 (deterministic enrich) → 1d/1e (KB metadata + LLM entity enrichment) → 1f (KB subject backfill) → `runEventGraph()` (event-centric Stage 2+3+4). Wraps each stage with timing + error logging. |
| `run-event-graph.ts` | **Event-centric graph build** (replaces the retired Stage 2/3). Runs 2a rollup-identity → 2b singleton-wrap → 2c embed-events → 3a ANN candidates → 3b LLM event match → 4 finalize, then publishes `graph_updated`. See `runEventGraph()`. |
| `daemon.ts` | **Daemon mode.** Starts 3 parallel loops: (1) Stage 1 worker drain loop, (2) Sync loop (subscribes to `markets:synced` SSE → calls `runSync()`), (3) event-graph trigger loop (drains `stage23_queue` → `runEventGraph()`). |

## Subsystems

| Folder | Purpose |
|--------|---------|
| [`stage1-normalize/`](stage1-normalize/doc.md) | Deterministic market enrichment: regex features, template + KB normalization, embedding |
| `stage2-events/` | Event-identity roll-up, singleton-event reconstruction, and event embeddings (`rollup-event-identity.ts`, `reconstruct-events.ts`, `embed-events.ts`). |
| `stage3-events/` | Cross-platform event matching: ANN candidate discovery (`ann-candidates.ts`) + one LLM call per candidate pair to confirm same-event + leg mapping (`llm-event-match.ts`, `guards.ts`). |
| `stage4-events/` | Deterministic finalizer (`finalize.ts`): projects outcome-node `questions` + `outcome_sets`/slots, threshold-ladder edges, tournament structural edges (`tournament-edges.ts`), and contradiction detection (structure only — pricing & arb scoring live in the separate `arb-solver` service). |
| `stage3-arb-detect/` | Retired rule-engine zoo; only `contradiction-detector.ts` remains (consumed by `stage4-events/finalize.ts`). |
| [`entity-enrichment/`](entity-enrichment/doc.md) | Async LLM worker pool for entity KB deduplication and classification |
| [`db/`](db/doc.md) | All Postgres query modules + connection pool + sync helpers |
| [`util/`](util/doc.md) | Bounded concurrency helper |
| [`scripts/`](scripts/doc.md) | One-off backfill scripts |
