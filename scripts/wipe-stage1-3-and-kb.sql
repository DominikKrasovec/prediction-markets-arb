-- Wipe Stage 1-3 derived + KB tables for a clean histogram-audit re-run.
-- Does NOT touch raw platform tables (kalshi_markets, polymarket_markets, etc.)
-- or the unified `markets` table itself.
--
-- Run with:
--   docker exec -i prediction-arb-pg psql -U arb -d prediction_arb \
--     < scripts/wipe-stage1-3-and-kb.sql
--
-- ⚠️ EMBEDDING-PRESERVING WIPE — RUN THE DUMP STEP FIRST (optional but recommended).
-- This TRUNCATE discards platform_events (step 5), taking its ~27.5k embeddings
-- with it. To avoid re-embedding every event against the OpenAI API on the next
-- rebuild, seed the persistent `event_embedding_cache` BEFORE wiping:
--   bun services/pipeline/src/scripts/dump-event-embeddings.ts   # then run this file
-- Stage 2c then RESTORES each unchanged event (exact natural-key + content_hash +
-- model match) and only re-embeds true misses. The cache table is in the NOT-WIPED
-- block below, so it survives this script. (The cache is also kept warm at embed
-- time, so the dump is only strictly required the FIRST time.) See docs/kb/OPERATIONS.md §1.
--
-- After wiping, rerun the pipeline. NOTE (post event-centric rewire): Stage 1 has
-- NO LLM normalization (deterministic templates + KB only). For an LLM-free run use
-- ENTITY_ENRICHMENT_SKIP=1 (skips the entity-metadata LLM — the only Stage-1-adjacent
-- LLM) and STAGE3_SKIP_LLM=1 (skips the cross-platform event matcher). KB T2 +
-- markets/platform_events embeddings still call the OpenAI EMBEDDINGS API (not a chat LLM).

BEGIN;

-- 1. KB + all directly-dependent tables. CASCADE handles entity_relations,
--    market_entity_links, entity_category_counts, entity_enrichment_queue,
--    and FK references on llm_market_normalizations.{resolution_provider_id,
--    league_id, competition_id}.
TRUNCATE TABLE known_entities                  RESTART IDENTITY CASCADE;

-- 2. Stage 1b normalizations (in case CASCADE didn't reach them all).
TRUNCATE TABLE llm_market_normalizations       RESTART IDENTITY CASCADE;

-- 3. Subject-resolution cache (rebuilt by Stage 1 templates / LLM).
TRUNCATE TABLE entity_subjects                 RESTART IDENTITY CASCADE;

-- 4. Stage 1a features. Markets keep their text content; features get rebuilt.
TRUNCATE TABLE market_features                 RESTART IDENTITY CASCADE;

-- 5. Platform-events normalization state.
TRUNCATE TABLE platform_events                 RESTART IDENTITY CASCADE;

-- 6. Stage 2 outputs: questions + members.
TRUNCATE TABLE questions                       RESTART IDENTITY CASCADE;

-- 7. Stage 3 outputs: outcome sets + implication edges + arbs.
TRUNCATE TABLE outcome_sets                    RESTART IDENTITY CASCADE;
TRUNCATE TABLE implication_edges               RESTART IDENTITY CASCADE;
TRUNCATE TABLE arbitrage_opportunities         RESTART IDENTITY CASCADE;
TRUNCATE TABLE edge_contradictions             RESTART IDENTITY CASCADE;

-- 7b. Event-centric layer (migration 051): semantic events + the ANN→LLM
--     candidate queue. CASCADE clears _platforms / _legs. platform_events
--     (truncated in step 5) takes its embeddings with it.
TRUNCATE TABLE semantic_events                 RESTART IDENTITY CASCADE;
TRUNCATE TABLE stage3_event_candidates         RESTART IDENTITY CASCADE;

-- 8. Queues (else Stage 1 thinks every market is already processed).
TRUNCATE TABLE stage1_queue                    RESTART IDENTITY CASCADE;
TRUNCATE TABLE stage23_queue                   RESTART IDENTITY CASCADE;
-- rule_engine_queue / rule_engine_decisions: DROPPED by migration 081
-- (Wave 1 item 1.2, 2026-06-12) — removed from this wipe list.

-- 9. Manual reviews. These are derivative audit logs; safe to drop on a
--    re-run since the new run will regenerate.
TRUNCATE TABLE review_verdicts                 RESTART IDENTITY CASCADE;
TRUNCATE TABLE review_verdict_history          RESTART IDENTITY CASCADE;

-- 10. Cross-platform reference detections (derived from raw markets).
TRUNCATE TABLE market_cross_refs               RESTART IDENTITY CASCADE;

-- NOT WIPED (intentional):
--   event_embedding_cache    — persistent embedding cache (migration 090). Keyed on
--                              (platform, platform_event_id) + content_hash + model;
--                              Stage 2c restores unchanged events from it instead of
--                              re-embedding ~27.5k rows. MUST survive the wipe — it is
--                              the whole point of the mechanism. Not referenced by any
--                              TRUNCATE/CASCADE above.
--   tournament_states        — web/LLM-sourced REFERENCE data (format_spec/bracket/draw).
--                              competition_id is a soft int ref (no FK to known_entities,
--                              migration 054) precisely so this TRUNCATE CASCADE preserves it.
--   markets                  — unified table, populated by sync.ts from raw tables
--   market_metadata_raw      — raw API metadata snapshot (provenance)
--   market_prices            — price history (independent of stage 1-3)
--   clob_prices              — CLOB price snapshots
--   platform_market_snapshots — market state snapshots
--   llm_logs                 — historical LLM cost / latency audit
--   pipeline_runs            — pipeline run history
--   pipeline_state           — long-running daemon state
--   dashboard_pairs          — saved dashboard configurations
--   <all raw scraper tables>: kalshi_markets, kalshi_events, polymarket_*,
--                             predict_*, limitless_*

COMMIT;

-- Sanity check after the wipe.
SELECT
  (SELECT COUNT(*) FROM known_entities)              AS known_entities,
  (SELECT COUNT(*) FROM market_entity_links)         AS links,
  (SELECT COUNT(*) FROM entity_category_counts)      AS hist_rows,
  (SELECT COUNT(*) FROM llm_market_normalizations)   AS norms,
  (SELECT COUNT(*) FROM market_features)             AS features,
  (SELECT COUNT(*) FROM platform_events)             AS platform_events,
  (SELECT COUNT(*) FROM questions)                   AS questions,
  (SELECT COUNT(*) FROM implication_edges)           AS edges,
  (SELECT COUNT(*) FROM arbitrage_opportunities)     AS arbs,
  (SELECT COUNT(*) FROM markets)                     AS markets_kept,
  (SELECT COUNT(*) FROM market_metadata_raw)         AS raw_metadata_kept;
