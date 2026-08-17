-- =============================================================
-- Prediction Markets Arbitrage — PostgreSQL Schema
-- Requires: pgvector/pgvector:pg16 Docker image
-- =============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Migration 049: diacritic folding for SQL-side entity lookups (matches foldAscii).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- IMMUTABLE unaccent wrapper (migration 049) — required for expression indexes.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- IMMUTABLE stems helper (migration 035) — drives the known_entities.stems_tsv
-- STORED generated column (canonical + every alias, Snowball-stemmed).
CREATE OR REPLACE FUNCTION compute_entity_stems_tsv(
    canonical_in TEXT,
    aliases_in   JSONB
) RETURNS tsvector
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT to_tsvector(
        'english'::regconfig,
        coalesce(canonical_in, '') || ' ' ||
        coalesce(
            (SELECT string_agg(elem, ' ')
               FROM jsonb_array_elements_text(aliases_in) AS elem),
            ''
        )
    );
$$;

-- =============================================================
-- SCRAPER TABLES: Raw data from platform APIs (replaces MongoDB)
-- Supported platforms: Kalshi, Limitless, Polymarket, Predict.
-- =============================================================

-- ── POLYMARKET ──

CREATE TABLE polymarket_markets (
    condition_id    TEXT PRIMARY KEY,
    event_id        TEXT,
    slug            TEXT,
    active          BOOLEAN DEFAULT TRUE,
    closed          BOOLEAN DEFAULT FALSE,
    volume_num      NUMERIC DEFAULT 0,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pm_markets_event ON polymarket_markets(event_id);
CREATE INDEX idx_pm_markets_slug ON polymarket_markets(slug);
CREATE INDEX idx_pm_markets_active ON polymarket_markets(active, closed);
CREATE INDEX idx_pm_markets_volume ON polymarket_markets(volume_num DESC);
CREATE INDEX idx_pm_markets_updated ON polymarket_markets(db_updated_at);

CREATE TABLE polymarket_events (
    id              TEXT PRIMARY KEY,
    slug            TEXT,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pm_events_slug ON polymarket_events(slug);
CREATE INDEX idx_pm_events_updated ON polymarket_events(db_updated_at);

CREATE TABLE polymarket_activities (
    proxy_wallet        TEXT NOT NULL,
    transaction_hash    TEXT NOT NULL,
    event_timestamp     BIGINT NOT NULL,
    condition_id        TEXT,
    raw                 JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (proxy_wallet, transaction_hash, event_timestamp)
);

CREATE INDEX idx_pm_activities_wallet ON polymarket_activities(proxy_wallet);
CREATE INDEX idx_pm_activities_condition ON polymarket_activities(condition_id);
CREATE INDEX idx_pm_activities_ts ON polymarket_activities(event_timestamp DESC);

CREATE TABLE polymarket_wallet_stats (
    proxy_wallet    TEXT PRIMARY KEY,
    pnl             NUMERIC,
    volume_traded   NUMERIC,
    raw             JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pm_stats_pnl ON polymarket_wallet_stats(pnl DESC);
CREATE INDEX idx_pm_stats_volume ON polymarket_wallet_stats(volume_traded DESC);

-- ── PREDICT ──

CREATE TABLE predict_categories (
    id              INTEGER PRIMARY KEY,
    slug            TEXT,
    status          TEXT,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pr_cat_slug ON predict_categories(slug);
CREATE INDEX idx_pr_cat_status ON predict_categories(status);
CREATE INDEX idx_pr_cat_updated ON predict_categories(db_updated_at);

CREATE TABLE predict_markets (
    id              INTEGER PRIMARY KEY,
    condition_id    TEXT,
    category_id     INTEGER,
    category_slug   TEXT,
    status          TEXT,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pr_markets_condition ON predict_markets(condition_id);
CREATE INDEX idx_pr_markets_cat ON predict_markets(category_id);
CREATE INDEX idx_pr_markets_cat_slug ON predict_markets(category_slug);
CREATE INDEX idx_pr_markets_status ON predict_markets(status);
CREATE INDEX idx_pr_markets_updated ON predict_markets(db_updated_at);

CREATE TABLE predict_tags (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PROBABLE ── (removed; platform deprecated, see migration 009)

-- ── KALSHI ── (see migration 008_kalshi.sql for the authoritative schema)

CREATE TABLE IF NOT EXISTS kalshi_events (
    event_ticker    TEXT PRIMARY KEY,
    series_ticker   TEXT,
    status          TEXT,
    category        TEXT,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ke_events_series   ON kalshi_events(series_ticker);
CREATE INDEX IF NOT EXISTS idx_ke_events_status   ON kalshi_events(status);
CREATE INDEX IF NOT EXISTS idx_ke_events_category ON kalshi_events(category);
CREATE INDEX IF NOT EXISTS idx_ke_events_updated  ON kalshi_events(db_updated_at);

CREATE TABLE IF NOT EXISTS kalshi_markets (
    ticker          TEXT PRIMARY KEY,
    event_ticker    TEXT,
    status          TEXT,
    yes_bid         NUMERIC,
    yes_ask         NUMERIC,
    volume          NUMERIC DEFAULT 0,
    raw             JSONB NOT NULL,
    db_created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_km_markets_event   ON kalshi_markets(event_ticker);
CREATE INDEX IF NOT EXISTS idx_km_markets_status  ON kalshi_markets(status);
CREATE INDEX IF NOT EXISTS idx_km_markets_volume  ON kalshi_markets(volume DESC);
CREATE INDEX IF NOT EXISTS idx_km_markets_updated ON kalshi_markets(db_updated_at);

-- ── LIMITLESS ── (see migration 008_limitless.sql)

CREATE TABLE IF NOT EXISTS limitless_markets (
    slug            TEXT PRIMARY KEY,
    address         TEXT,
    condition_id    TEXT,
    trade_type      TEXT,           -- 'clob' | 'amm' | 'group'
    status          TEXT,
    expired         BOOLEAN DEFAULT FALSE,
    expiration_ts   BIGINT,
    volume_num      NUMERIC,
    raw             JSONB NOT NULL,
    db_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS limitless_markets_trade_type ON limitless_markets(trade_type);
CREATE INDEX IF NOT EXISTS limitless_markets_status     ON limitless_markets(status);
CREATE INDEX IF NOT EXISTS limitless_markets_expired    ON limitless_markets(expired);

CREATE TABLE IF NOT EXISTS limitless_orderbook_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT NOT NULL REFERENCES limitless_markets(slug),
    snapshot    JSONB NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS limitless_ob_slug_ts
    ON limitless_orderbook_snapshots(slug, captured_at DESC);

-- ── DASHBOARD PAIRS ──

CREATE TABLE dashboard_pairs (
    id              SERIAL PRIMARY KEY,
    label           TEXT NOT NULL,
    markets         JSONB NOT NULL DEFAULT '{}',
    notes           TEXT DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- MARKETS: Normalized from scraper tables by correlation pipeline
-- =============================================================
CREATE TABLE markets (
    id              SERIAL PRIMARY KEY,
    platform        VARCHAR(20) NOT NULL,
    platform_id     VARCHAR(255) NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    normalized_text TEXT,
    source_hash     VARCHAR(64),
    status          VARCHAR(20),
    end_date        TIMESTAMPTZ,
    volume          DECIMAL DEFAULT 0,
    outcomes        JSONB,
    category        VARCHAR(255),
    tags            TEXT[],
    tag_slugs       TEXT[],
    slug            VARCHAR(500),
    url             TEXT,
    winning_outcome VARCHAR(255),
    raw             JSONB,

    -- Vector embedding
    embedding       vector(1536),
    embedding_model VARCHAR(50),
    -- When `embedding` was last (re)written (migration 093). Drives the Stage-3a
    -- market-ANN fallback's incremental anchor gate: a steady tick only re-probes
    -- markets embedded since the last pass instead of re-scanning all ~121k.
    embedded_at     TIMESTAMPTZ,

    -- Platform-native event grouping (migration 006)
    platform_event_id TEXT,
    grouping_type     TEXT
        CHECK (grouping_type IN (
            'threshold_series',
            'categorical_exclusive',
            'bundle_nonexclusive',
            'unknown'
        )),

    -- Resolution-timing scope (migration 052) — sport-agnostic soundness
    -- dimension: settled at end of regulation (tie possible) vs on the final
    -- result incl. overtime/ET/shootout/penalties (decides a winner) vs aggregate.
    -- Parsed deterministically from the description at sync; the Stage 3b matcher
    -- guard refuses to merge markets of differing scope into one outcome-node.
    resolution_scope  TEXT
        CHECK (resolution_scope IS NULL OR resolution_scope IN (
            'regulation', 'incl_overtime', 'aggregate', 'unspecified'
        )),

    -- Cross-platform unified category (migration 014)
    category_unified  VARCHAR(20)
        CONSTRAINT markets_category_unified_chk
        CHECK (category_unified IS NULL OR category_unified IN (
            'sports','crypto','election','politics','economic',
            'entertainment','technology','weather','geopolitical','other'
        )),

    -- Sync tracking
    synced_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(platform, platform_id)
);

CREATE INDEX idx_markets_embedding ON markets
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 32, ef_construction = 200);

-- Incremental anchor gate for the Stage-3a market-ANN fallback (migration 093):
-- lets an incremental tick index-scan only markets embedded since the watermark
-- instead of seq-scanning the whole embedded population. Partial (embedded rows).
CREATE INDEX IF NOT EXISTS idx_markets_embedded_at ON markets (embedded_at)
    WHERE embedding IS NOT NULL;

CREATE INDEX idx_markets_platform ON markets(platform);
CREATE INDEX idx_markets_status ON markets(status);
CREATE INDEX idx_markets_source_hash ON markets(source_hash);
CREATE INDEX idx_markets_category ON markets(category);
CREATE INDEX idx_markets_tags ON markets USING gin(tags);
CREATE INDEX idx_markets_tag_slugs ON markets USING gin(tag_slugs);
CREATE INDEX idx_markets_title_trgm ON markets USING gin(title gin_trgm_ops);
CREATE INDEX idx_markets_platform_event ON markets(platform, platform_event_id)
    WHERE platform_event_id IS NOT NULL;
CREATE INDEX idx_markets_grouping_type ON markets(grouping_type)
    WHERE grouping_type IS NOT NULL;
CREATE INDEX idx_markets_category_unified ON markets(category_unified);

-- =============================================================
-- PLATFORM EVENTS: Platform-native event grouping (migration 006)
-- One row per (platform, platform_event_id). Child markets reference
-- this via markets.platform_event_id. Semantic fields extracted once
-- per event; child normalizations may inherit from here.
-- =============================================================
CREATE TABLE platform_events (
    id                 SERIAL PRIMARY KEY,
    platform           TEXT    NOT NULL,
    platform_event_id  TEXT    NOT NULL,
    grouping_type      TEXT    NOT NULL DEFAULT 'unknown'
        CHECK (grouping_type IN (
            'threshold_series',
            'categorical_exclusive',
            'bundle_nonexclusive',
            'unknown'
        )),
    title              TEXT    NOT NULL,
    resolution_source  TEXT,
    deadline           DATE,
    unit               TEXT,
    -- Semantic fields — populated by per-event LLM normalisation run
    canonical_subject  TEXT,
    canonical_event    TEXT,
    participants       TEXT[]  NOT NULL DEFAULT '{}',
    child_count        INTEGER NOT NULL DEFAULT 0,
    llm_normalized     BOOLEAN NOT NULL DEFAULT FALSE,
    -- child_count snapshot taken at the moment llm_normalized was last set.
    -- When the materialiser bumps child_count above this value, Stage 1b
    -- re-runs to incorporate the new children. See migration 019.
    last_normalized_child_count INTEGER,
    -- Migration 051: event-level embedding for the cross-platform ANN matcher (Stage 2c/3a).
    embedding          vector(1536),
    embedding_model    TEXT,
    embedded_at        TIMESTAMPTZ,
    -- Migration 053: Stage 2a identity roll-up — category + resolution timestamp
    -- rolled up from children so Stage 3a candidacy gates at the event grain.
    -- condition_date is minute-grained (crypto candles); `deadline` (DATE) stays
    -- as the coarse fallback. condition_date_precision drives the precision-aware
    -- date gate (minute→exact ±240s, day→same-day, year/month→skip date).
    category                 TEXT,
    condition_date           TIMESTAMPTZ,
    condition_date_precision TEXT
        CHECK (condition_date_precision IS NULL OR condition_date_precision IN
               ('minute','hour','day','month','year')),
    -- Migration 055: native-first entity-layer scope (resolve-event-identity.ts).
    -- Two-level Stage 3a gate (sport coarse + league fine, both NULL-tolerant);
    -- league is NULL for cross-league competitions (UCL/World Cup) and non-sports.
    sport_canonical          TEXT,
    league_canonical         TEXT,
    -- Migration 058: resolution-timing scope rolled up from child markets
    -- (rollup-event-identity Phase 1c, mode() with mixed→'unspecified'). DIFFERENT
    -- axis from sport/league above — see markets.resolution_scope (mig 052).
    resolution_scope         TEXT
        CONSTRAINT platform_events_resolution_scope_chk
        CHECK (resolution_scope IS NULL OR resolution_scope IN
               ('regulation','incl_overtime','aggregate','unspecified')),
    -- Migration 056: event-level kind rolled up from child normalizations (phase 1b).
    event_kind         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (platform, platform_event_id)
);
CREATE INDEX idx_platform_events_event_kind ON platform_events(event_kind)
    WHERE event_kind IS NOT NULL;

CREATE INDEX idx_platform_events_llm ON platform_events (platform, platform_event_id)
    WHERE llm_normalized = FALSE
       OR last_normalized_child_count IS NULL
       OR child_count > last_normalized_child_count;
CREATE INDEX idx_platform_events_subject ON platform_events(canonical_subject)
    WHERE canonical_subject IS NOT NULL;
CREATE INDEX idx_platform_events_embedding
    ON platform_events USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;
-- Incremental anchor gate for Stage-3a event-ANN (migration 093): an incremental
-- tick index-scans only events embedded since the watermark, not all ~49k.
CREATE INDEX IF NOT EXISTS idx_platform_events_embedded_at ON platform_events (embedded_at)
    WHERE embedding IS NOT NULL;
CREATE INDEX idx_platform_events_category ON platform_events(category)
    WHERE category IS NOT NULL;
CREATE INDEX idx_platform_events_sport ON platform_events(sport_canonical)
    WHERE sport_canonical IS NOT NULL;
CREATE INDEX idx_platform_events_league ON platform_events(league_canonical)
    WHERE league_canonical IS NOT NULL;
CREATE INDEX idx_platform_events_resolution_scope ON platform_events(resolution_scope)
    WHERE resolution_scope IS NOT NULL;
CREATE INDEX idx_platform_events_condition_date ON platform_events(condition_date)
    WHERE condition_date IS NOT NULL;

-- =============================================================
-- EVENT EMBEDDING CACHE (migration 090): embedding-preserving wipe.
-- Persistent cache of platform_events embeddings keyed on the natural key
-- (platform, platform_event_id) + content_hash (sha256 of the exact embed-input,
-- buildEventEmbeddingInput) + embedding_model. Stage 2c restores an exact match
-- instead of re-embedding ~27.5k events after a wipe. NOT wiped by
-- scripts/wipe-stage1-3-and-kb.sql (survives the TRUNCATE by design).
-- =============================================================
CREATE TABLE event_embedding_cache (
    platform          TEXT NOT NULL,
    platform_event_id TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    embedding         vector(1536) NOT NULL,
    embedding_model   TEXT NOT NULL,
    cached_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (platform, platform_event_id)
);

-- =============================================================
-- SEMANTIC EVENTS (migration 051): cross-platform event identity.
-- One row per real event; bound to N platform_events via
-- semantic_event_platforms; per-outcome legs in semantic_event_legs.
-- Outcome-nodes (the `questions` rows) are PROJECTED from the legs in
-- Stage 4 — the legs reference markets(id), not questions(id).
-- =============================================================
CREATE TABLE semantic_events (
    id                 SERIAL PRIMARY KEY,
    canonical_event    TEXT    NOT NULL,
    canonical_subject  TEXT,
    grouping_kind      TEXT    NOT NULL CHECK (grouping_kind IN
                          ('categorical_exclusive','threshold_series','bundle_nonexclusive')),
    participants       TEXT[]  NOT NULL DEFAULT '{}',
    deadline_window    TSTZRANGE,
    confidence         NUMERIC NOT NULL,
    llm_model          TEXT    NOT NULL,
    match_reasoning    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at        TIMESTAMPTZ
);
CREATE INDEX idx_semantic_events_subject ON semantic_events(canonical_subject)
    WHERE archived_at IS NULL AND canonical_subject IS NOT NULL;
CREATE INDEX idx_semantic_events_kind_active ON semantic_events(grouping_kind)
    WHERE archived_at IS NULL;
CREATE INDEX idx_semantic_events_window ON semantic_events USING gist(deadline_window)
    WHERE archived_at IS NULL;

CREATE TABLE semantic_event_platforms (
    semantic_event_id  INTEGER NOT NULL REFERENCES semantic_events(id) ON DELETE CASCADE,
    platform_event_id  INTEGER NOT NULL REFERENCES platform_events(id) ON DELETE CASCADE,
    match_confidence   NUMERIC NOT NULL,
    llm_pass_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (semantic_event_id, platform_event_id)
);
CREATE INDEX idx_sep_platform_event ON semantic_event_platforms(platform_event_id);

CREATE TABLE semantic_event_legs (
    id                 SERIAL PRIMARY KEY,
    semantic_event_id  INTEGER NOT NULL REFERENCES semantic_events(id) ON DELETE CASCADE,
    outcome_id         TEXT    NOT NULL,
    outcome_label      TEXT    NOT NULL,
    outcome_subject    TEXT,
    outcome_ordinal    INTEGER,
    is_residual        BOOLEAN NOT NULL DEFAULT FALSE,
    platform           TEXT    NOT NULL,
    market_id          INTEGER REFERENCES markets(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (semantic_event_id, outcome_id, platform, market_id)
);
CREATE INDEX idx_sel_market    ON semantic_event_legs(market_id);
CREATE INDEX idx_sel_event_out ON semantic_event_legs(semantic_event_id, outcome_id);

CREATE TABLE stage3_event_candidates (
    id                 SERIAL PRIMARY KEY,
    platform_event_a   INTEGER NOT NULL REFERENCES platform_events(id) ON DELETE CASCADE,
    platform_event_b   INTEGER NOT NULL REFERENCES platform_events(id) ON DELETE CASCADE,
    cosine_distance    NUMERIC NOT NULL,
    status             TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','done','failed','skipped')),
    semantic_event_id  INTEGER REFERENCES semantic_events(id),
    llm_reasoning      TEXT,
    -- Migration 067: bounded transient-failure retry counter (markTransientFailure /
    -- requeueSalvageableFailedCandidates re-arm a row while retry_count < N).
    retry_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at       TIMESTAMPTZ,
    UNIQUE (platform_event_a, platform_event_b),
    CHECK (platform_event_a < platform_event_b)
);
CREATE INDEX idx_stage3_pending ON stage3_event_candidates(status, cosine_distance)
    WHERE status = 'pending';

-- =============================================================
-- MARKET METADATA RAW: Raw JSON from MongoDB for platform-native fields
-- =============================================================
CREATE TABLE market_metadata_raw (
    market_id       INTEGER PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
    raw             JSONB NOT NULL,
    synced_at       TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- MARKET CROSS REFS: platform-native cross-platform links
-- Predict.fun publishes `polymarketConditionIds[]` and
-- `kalshiMarketTicker` on each market row. These are ground-truth
-- equivalence links we trust without any LLM / similarity matching.
-- =============================================================
CREATE TABLE market_cross_refs (
    source_market_id    INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    target_platform     VARCHAR(20) NOT NULL,
    target_platform_id  TEXT NOT NULL,
    target_market_id    INTEGER REFERENCES markets(id) ON DELETE SET NULL,
    source_field        VARCHAR(40) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_market_id, target_platform, target_platform_id)
);

CREATE INDEX idx_market_cross_refs_target
  ON market_cross_refs (target_platform, target_platform_id);

CREATE INDEX idx_market_cross_refs_resolved
  ON market_cross_refs (target_market_id)
  WHERE target_market_id IS NOT NULL;

-- =============================================================
-- MARKET FEATURES: Stage 1 deterministic extraction output
-- =============================================================
CREATE TABLE market_features (
    market_id           INTEGER PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
    platform            VARCHAR(20) NOT NULL,
    platform_id         VARCHAR(255) NOT NULL,

    -- Text normalization
    normalized_title    TEXT NOT NULL,
    title_words         JSONB NOT NULL,
    title_bigrams       JSONB NOT NULL,
    title_trigrams      JSONB NOT NULL,

    -- Regex NER
    entities            JSONB NOT NULL DEFAULT '[]',
    dates               JSONB NOT NULL DEFAULT '[]',
    numbers             JSONB NOT NULL DEFAULT '[]',
    currencies          JSONB NOT NULL DEFAULT '[]',

    -- Hierarchy markers
    hierarchy_type      VARCHAR(30),
    hierarchy_value     TEXT,
    hierarchy_level     DOUBLE PRECISION,

    -- Platform-native grouping
    platform_group_id   VARCHAR(255),
    platform_cross_ref  VARCHAR(255),

    -- Classification
    outcome_space       VARCHAR(20) NOT NULL DEFAULT 'binary'
                            CONSTRAINT chk_features_outcome_space
                            CHECK (outcome_space IN ('binary','categorical','numeric')),

    -- Regex-derived condition signals (parallel to LLM extraction).
    -- Populated by detectConditionSignals() in Stage 1a; consumed as an
    -- LLM-skip gate by text-deterministic normalization in Stage 1b.
    condition_shape       VARCHAR(40),
    condition_direction   VARCHAR(20),
    temporal_semantics    VARCHAR(20),

    processed_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_features_platform ON market_features(platform);
CREATE INDEX idx_features_platform_group ON market_features(platform_group_id);
CREATE INDEX idx_features_hierarchy ON market_features(hierarchy_type);
CREATE INDEX idx_features_condition_shape ON market_features(condition_shape) WHERE condition_shape IS NOT NULL;

-- =============================================================
-- ENTITY KNOWLEDGE BASE: Persistent cross-market entity graph
-- Accumulates every entity the LLM discovers. Aliases are merged
-- across runs so "BTC"↔"Bitcoin" is learned once and reused forever.
-- =============================================================
CREATE TABLE known_entities (
    id              SERIAL PRIMARY KEY,
    canonical       TEXT NOT NULL,
    type            VARCHAR(20) NOT NULL DEFAULT 'unknown',
    aliases         JSONB NOT NULL DEFAULT '[]',
    domain_category VARCHAR(30) NOT NULL DEFAULT 'other'
                        CONSTRAINT chk_entities_domain_category
                        CHECK (domain_category IN ('sports','crypto','finance','politics','entertainment','weather','other')),
    -- Entity KB refactor (migration 016): per-type structured data.
    -- Source of truth for league_canonical / sport_canonical (extracted via generated columns).
    metadata        JSONB NOT NULL DEFAULT '{}',
    league_canonical TEXT GENERATED ALWAYS AS (metadata->>'league_canonical') STORED,
    sport_canonical  TEXT GENERATED ALWAYS AS (metadata->>'sport_canonical')  STORED,
    -- Migration 035: stemmed canonical+aliases for the Pass-3 lemma-subset merge gate.
    stems_tsv       TSVECTOR GENERATED ALWAYS AS (compute_entity_stems_tsv(canonical, aliases)) STORED,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    -- Two distinct real-world entities may share a canonical name as long as they have
    -- different (sport_canonical, league_canonical) pairs — e.g. Phoenix Suns (NBA/basketball)
    -- vs Phoenix Mercury (WNBA/basketball), or ECHL (ice hockey) vs a fictional ECHL (soccer).
    -- NULLS NOT DISTINCT: NULL values are treated as equal so non-sport / cross-league
    -- entities remain constrained to one row per name.
    CONSTRAINT known_entities_canonical_sport_league_key UNIQUE NULLS NOT DISTINCT (canonical, sport_canonical, league_canonical)
);

ALTER TABLE known_entities
    ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending','enriched','failed','manual'));

CREATE INDEX idx_entities_canonical ON known_entities(canonical);
-- Migration 035: GIN over the stemmed canonical+alias tsvector.
CREATE INDEX idx_known_entities_stems_tsv ON known_entities USING gin(stems_tsv);
-- Migration 049: sargable folded-lowercase canonical for Tier-1 lookups.
CREATE INDEX idx_known_entities_canonical_folded
    ON known_entities (lower(immutable_unaccent(canonical)));
-- Migration 092: bare lower(canonical) index for the hot `lower(canonical) = $1`
-- KB register/resolve probes (the folded index above does NOT serve this shape).
CREATE INDEX IF NOT EXISTS idx_known_entities_lower_canonical
    ON known_entities (lower(canonical));
CREATE INDEX idx_entities_type ON known_entities(type);
CREATE INDEX idx_entities_domain_category ON known_entities(domain_category);
CREATE INDEX idx_entities_aliases ON known_entities USING gin(aliases jsonb_path_ops);
CREATE INDEX idx_entities_league ON known_entities(league_canonical)
    WHERE league_canonical IS NOT NULL;
CREATE INDEX idx_entities_sport ON known_entities(sport_canonical)
    WHERE sport_canonical IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_enrichment_pending
    ON known_entities(id)
    WHERE enrichment_status = 'pending';

-- Cross-entity directed graph (migration 016).
--   plays_for    person      → team
--   competes_in  team        → league
--   part_of      league      → sport  |  competition → league
--   located_in   team/org    → location
--   covers       data_provider → league / sport
CREATE TABLE entity_relations (
    parent_id   INT NOT NULL REFERENCES known_entities(id) ON DELETE CASCADE,
    child_id    INT NOT NULL REFERENCES known_entities(id) ON DELETE CASCADE,
    relation    VARCHAR(20) NOT NULL
        CHECK (relation IN ('plays_for', 'competes_in', 'part_of', 'located_in', 'covers')),
    PRIMARY KEY (parent_id, child_id, relation)
);
CREATE INDEX idx_entity_relations_child  ON entity_relations(child_id, relation);
CREATE INDEX idx_entity_relations_parent ON entity_relations(parent_id, relation);

-- Junction: which entities appear in which markets
CREATE TABLE market_entity_links (
    market_id       INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    entity_id       INTEGER NOT NULL REFERENCES known_entities(id) ON DELETE CASCADE,
    is_subject      BOOLEAN DEFAULT FALSE,
    PRIMARY KEY(market_id, entity_id)
);

CREATE INDEX idx_entity_links_entity ON market_entity_links(entity_id);
CREATE INDEX idx_entity_links_market ON market_entity_links(market_id);

-- Migration 022: Entity-enrichment work queue
--
-- The Kalshi deterministic Stage 1 path creates known_entities rows with no
-- metadata (no role, no primary_team_canonical, no sport_canonical). The LLM
-- normalizer path populates those — so any entity created deterministically
-- needs a follow-up enrichment pass. Workers claim rows via
-- FOR UPDATE SKIP LOCKED, batch entities into the entity_enrichment LLM
-- prompt, then UPSERT metadata back into known_entities.
CREATE TABLE IF NOT EXISTS entity_enrichment_queue (
    id          BIGSERIAL PRIMARY KEY,
    entity_id   INTEGER NOT NULL REFERENCES known_entities(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','skipped')),
    type_hint   TEXT,
    reason      TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    claimed_by  TEXT,
    claimed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_enrichment_pending
    ON entity_enrichment_queue (created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_entity_enrichment_processing
    ON entity_enrichment_queue (claimed_at)
    WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_entity_enrichment_failed
    ON entity_enrichment_queue (id)
    WHERE status = 'failed';

-- =============================================================
-- LLM MARKET NORMALIZATIONS: Stage 1b LLM-extracted canonical fields
-- One row per market, cached forever. Handles entity resolution
-- that regex cannot: "USA"↔"United States", "LAL"↔"Lakers"
-- =============================================================
CREATE TABLE llm_market_normalizations (
    market_id           INTEGER PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
    canonical_subject   TEXT NOT NULL,
    condition_value     TEXT,
    condition_date      TEXT,
    canonical_event     TEXT NOT NULL,
    resolved_entities   JSONB NOT NULL DEFAULT '[]',
    resolution_source   TEXT,
    confidence          DECIMAL NOT NULL DEFAULT 0,
    -- Phase 1: Condition Structure Taxonomy
    condition_shape     VARCHAR(30),
    condition_direction VARCHAR(20),
    condition_metric    VARCHAR(20),
    -- Migration 060: metric_scope — which slice of a fixture a total/winner
    -- measures (team vs combined-game vs first-N-innings/half/set, full-match vs
    -- first-half winner). Stage-1 deterministic (Kalshi ticker + title parser),
    -- NOT an LLM field. NULL = unknown/whole-match. Gates the cross-question
    -- total/winner equiv+ladder rules (both-known-and-differ; sameSliceScopeSql
    -- additionally refuses NULL against a sub-fixture slice).
    -- Migration 095: 'first_3' / 'first_7' — KXMLBF3/F5/F7 are THREE independent
    -- innings cut-points on one game, never a ladder.
    metric_scope        VARCHAR(20)
                            CONSTRAINT lmn_metric_scope_chk
                            CHECK (metric_scope IS NULL OR metric_scope IN (
                              'game','team','first_3','first_5','first_7','half_1','half_2','quarter','period','set','map','series','season'
                            )),
    temporal_semantics  VARCHAR(20),
    value_primary       NUMERIC,
    value_secondary     NUMERIC,
    value_unit          VARCHAR(20),
    -- Mantissa-exponent form: value = m × 10^e  (migration 026)
    -- Preserves decimal precision for O/U lines (22.5), large market-caps, etc.
    -- Both columns are NULL when value_primary / value_secondary is NULL.
    value_primary_m     BIGINT,
    value_primary_e     SMALLINT,
    value_secondary_m   BIGINT,
    value_secondary_e   SMALLINT,
    -- Sorted, deduped canonical names of entities whose outcome determines
    -- resolution. canonical_subject MUST be a member of participants.
    participants        TEXT[] NOT NULL DEFAULT '{}',
    -- TRUE when semantic fields were inherited from platform_events (migration 006)
    event_sourced       BOOLEAN NOT NULL DEFAULT FALSE,
    -- Entity KB refactor (migration 016): structural FKs into known_entities.
    -- All nullable; populated by Stage 1b post-processing via leagueResolver / providerResolver.
    resolution_provider_id INT REFERENCES known_entities(id),
    resolution_kind     VARCHAR(30)
                            CONSTRAINT chk_norm_resolution_kind
                            CHECK (resolution_kind IS NULL OR resolution_kind IN (
                              'candle_data','exchange_oracle','league_official','esports_stats',
                              'election_authority','media_consensus','court_ruling','tournament_official','other'
                            )),
    league_id           INT REFERENCES known_entities(id),
    competition_id      INT REFERENCES known_entities(id),
    event_kind          VARCHAR(40),
    -- Migration 030: which template/pass produced this normalization (telemetry).
    match_source        TEXT,
    -- Migration 031: sorted per-leg signatures for combination-parlay detection.
    leg_signatures      TEXT[],
    -- Per-market outcome role within its event's outcome set (no owning migration —
    -- applied live alongside the Ω placeholder-exclusion work; mirrors questions.outcome_role).
    outcome_role        TEXT
                            CONSTRAINT lmn_outcome_role_chk
                            CHECK (outcome_role IS NULL OR outcome_role IN (
                              'contender','draw','tie','residual','placeholder',
                              'over','under','negation','void','exact_score'
                            )),
    -- Migration 036: per-market outcome label (e.g. 'draw' for draw markets,
    -- '2-1' for exact-score scorelines). Lets canonical_key distinguish
    -- Team-A-wins from Draw markets on the same fixture (they otherwise
    -- collide on subject + shape + condition_value).
    outcome_label       TEXT,
    -- Migration 037: precision metadata for condition_date.  Drives Stage 2/3
    -- comparison tolerance: minute=exact, hour=±1h, day=normalizeDate(),
    -- month/year=defer to canonical_event grouping.
    condition_date_precision TEXT
        CONSTRAINT llm_market_normalizations_condition_date_precision_chk
        CHECK (condition_date_precision IS NULL OR condition_date_precision IN
               ('minute','hour','day','month','year')),
    condition_date_source    TEXT,
    -- Migration 075: settlement instrument for price_threshold markets (e.g. the
    -- exact index/candle a crypto threshold settles against). Backfilled by
    -- Stage-1g backfillSettlementInstrument every tick.
    settlement_instrument    TEXT,
    -- Migration 086 (WP-1.1): the DiscriminatorSpec registry JSONB — Stage-1
    -- stamps (metric_scope, party, game_ordinal, tour_gender, ...). Keys are
    -- spec names, values lowercase strings; missing key = NULL = unknown; a
    -- gatedField spec's value always mirrors its typed column (dual-write).
    discriminators      JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lmn_discriminators ON llm_market_normalizations USING gin (discriminators);
CREATE INDEX idx_norm_subject ON llm_market_normalizations(canonical_subject);
CREATE INDEX idx_norm_match_source ON llm_market_normalizations(match_source)
    WHERE match_source IS NOT NULL;
CREATE INDEX idx_norm_leg_signatures ON llm_market_normalizations USING gin(leg_signatures)
    WHERE leg_signatures IS NOT NULL;
CREATE INDEX idx_norm_shape ON llm_market_normalizations(condition_shape);
CREATE INDEX idx_norm_outcome_label ON llm_market_normalizations(outcome_label)
    WHERE outcome_label IS NOT NULL;
-- Incremental gate for the settlement-instrument backfill (migration 094):
-- keyset scan over newly-normalized price_threshold rows instead of a full scan.
CREATE INDEX IF NOT EXISTS idx_lmn_price_threshold_created
    ON llm_market_normalizations (created_at, market_id)
    WHERE event_kind = 'price_threshold';
CREATE INDEX idx_norm_temporal ON llm_market_normalizations(temporal_semantics);
CREATE INDEX idx_norm_participants ON llm_market_normalizations USING gin(participants);
CREATE INDEX idx_norm_event_sourced ON llm_market_normalizations(event_sourced)
    WHERE event_sourced = TRUE;
-- Partial indexes on entity-KB FKs (only resolved rows pay index cost).
CREATE INDEX idx_norm_resolution_provider ON llm_market_normalizations(resolution_provider_id)
    WHERE resolution_provider_id IS NOT NULL;
CREATE INDEX idx_norm_league ON llm_market_normalizations(league_id)
    WHERE league_id IS NOT NULL;
CREATE INDEX idx_norm_competition ON llm_market_normalizations(competition_id)
    WHERE competition_id IS NOT NULL;
CREATE INDEX idx_norm_event_kind ON llm_market_normalizations(event_kind)
    WHERE event_kind IS NOT NULL;

-- =============================================================
-- QUESTIONS: Abstract platform-agnostic questions
-- Groups all markets asking the same thing into one entity.
-- =============================================================
CREATE TABLE questions (
    id                  SERIAL PRIMARY KEY,
    canonical_key       TEXT NOT NULL UNIQUE,
    canonical_subject   TEXT NOT NULL,
    condition_shape     VARCHAR(30),
    condition_value     TEXT,
    condition_date      TEXT,
    -- Migration 038: rolled up from member normalizations. NULL → 'day' by convention.
    condition_date_precision TEXT
        CONSTRAINT questions_condition_date_precision_chk
        CHECK (condition_date_precision IS NULL OR condition_date_precision IN
               ('minute','hour','day','month','year')),
    event_category      TEXT,
    -- Migration 039: combination-parlay flag (multi-leg nodes are excluded from Ω).
    is_parlay           BOOLEAN NOT NULL DEFAULT FALSE,
    -- Outcome role within the owning outcome set (no owning migration — applied live
    -- alongside the Ω placeholder-exclusion work; mirrors llm_market_normalizations).
    outcome_role        TEXT
        CONSTRAINT questions_outcome_role_chk
        CHECK (outcome_role IS NULL OR outcome_role IN (
          'contender','draw','tie','residual','placeholder',
          'over','under','negation','void','exact_score'
        )),
    member_count        INTEGER DEFAULT 0,
    platform_count      INTEGER DEFAULT 0,
    best_yes_price      DECIMAL,
    best_no_price       DECIMAL,
    best_yes_market_id  INTEGER,
    best_no_market_id   INTEGER,
    -- Sorted, deduped canonical entities (copied from representative member's
    -- normalization). Powers Stage 3 M4/I6 set-based rules.
    participants        TEXT[] NOT NULL DEFAULT '{}',
    -- Migration 057: rich normalization fields projected onto the node layer from a
    -- deterministic representative member (finalize.ts). Feed the rebuilt
    -- cross-question edge rules. league_id is a soft ref (NO FK) so reference data
    -- survives `TRUNCATE known_entities CASCADE`. resolution_kind is ADDED but not
    -- yet projected (~0% populated — backfill pending).
    canonical_event     TEXT,
    event_kind          VARCHAR(40),
    condition_direction VARCHAR(20),
    condition_metric    VARCHAR(20),
    -- Migration 060: metric_scope projected from member markets (finalize, mixed→NULL).
    metric_scope        VARCHAR(20)
                            CONSTRAINT questions_metric_scope_chk
                            CHECK (metric_scope IS NULL OR metric_scope IN (
                              'game','team','first_3','first_5','first_7','half_1','half_2','quarter','period','set','map','series','season'
                            )),
    value_primary       NUMERIC,
    value_secondary     NUMERIC,
    value_unit          VARCHAR(20),
    value_primary_m     BIGINT,
    value_primary_e     SMALLINT,
    value_secondary_m   BIGINT,
    value_secondary_e   SMALLINT,
    temporal_semantics  VARCHAR(20),
    league_id           INT,
    -- Migration 058: resolution-timing scope projected from member markets
    -- (finalize.ts, mixed→NULL). Powers the conservative FT/ET same-event guard.
    resolution_scope    TEXT
                            CONSTRAINT questions_resolution_scope_chk
                            CHECK (resolution_scope IS NULL OR resolution_scope IN (
                              'regulation','incl_overtime','aggregate','unspecified'
                            )),
    resolution_kind     VARCHAR(30)
                            CONSTRAINT questions_resolution_kind_chk
                            CHECK (resolution_kind IS NULL OR resolution_kind IN (
                              'candle_data','exchange_oracle','league_official','esports_stats',
                              'election_authority','media_consensus','court_ruling','tournament_official','other'
                            )),
    -- Migration 086 (WP-1.1): finalize per-key CONSENSUS roll-up of the node's
    -- member discriminators (a key survives iff all carrying members agree).
    discriminators      JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_questions_discriminators ON questions USING gin (discriminators);
CREATE INDEX idx_questions_subject ON questions(canonical_subject);
CREATE INDEX idx_questions_event ON questions(event_category);
CREATE INDEX idx_questions_shape ON questions(condition_shape);
CREATE INDEX idx_questions_participants ON questions USING gin(participants);
-- Migration 057: rule-gate partial indexes on projected node fields.
CREATE INDEX idx_questions_event_kind ON questions(event_kind) WHERE event_kind IS NOT NULL;
CREATE INDEX idx_questions_direction ON questions(condition_direction) WHERE condition_direction IS NOT NULL;
CREATE INDEX idx_questions_value_unit ON questions(value_unit) WHERE value_unit IS NOT NULL;
CREATE INDEX idx_questions_league ON questions(league_id) WHERE league_id IS NOT NULL;
CREATE INDEX idx_questions_resolution_scope ON questions(resolution_scope) WHERE resolution_scope IS NOT NULL;
CREATE INDEX idx_questions_metric_scope ON questions(metric_scope) WHERE metric_scope IS NOT NULL;
CREATE INDEX idx_questions_outcome_role ON questions(outcome_role) WHERE outcome_role IS NOT NULL;

-- =============================================================
-- QUESTION MEMBERS: Market → Question mapping
-- =============================================================
CREATE TABLE question_members (
    question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    market_id       INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    platform        VARCHAR(20) NOT NULL,
    yes_price       DECIMAL,
    no_price        DECIMAL,
    PRIMARY KEY(question_id, market_id),
    CONSTRAINT question_members_market_id_unique UNIQUE(market_id)
);

CREATE INDEX idx_qm_question ON question_members(question_id);
CREATE INDEX idx_qm_market ON question_members(market_id);

-- =============================================================
-- OUTCOME SETS: Mutually exclusive exhaustive question groups
-- Replaces market_groups / group_members
-- =============================================================
CREATE TABLE outcome_sets (
    id                  SERIAL PRIMARY KEY,
    event_identity      TEXT NOT NULL UNIQUE,
    set_type            VARCHAR(30) NOT NULL
                            CONSTRAINT chk_outcome_sets_type
                            CHECK (set_type IN ('tournament','categorical','threshold_series','bundle')),
    set_name            TEXT NOT NULL,
    slot_count          INTEGER DEFAULT 0,
    confidence          DECIMAL DEFAULT 0,
    source              VARCHAR(30) NOT NULL,
    -- Σ=1 (exactly one TRUE) only when the slots PROVABLY partition the outcome space
    -- (negRisk / numeric tiling / has a residual "Other" slot); otherwise Σ≤1 (mutex —
    -- the all-FALSE world is real). Set by finalize per categorical set; see migration 061.
    -- DEFAULT FALSE (migration 070, AUD-35): an unset/unknown set FAILS SAFE to Σ≤1 —
    -- DEFAULT TRUE was the single direction that can manufacture a fake buy-all-YES arb.
    is_exhaustive       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_outcome_sets_type ON outcome_sets(set_type);
CREATE INDEX idx_outcome_sets_source ON outcome_sets(source);

COMMENT ON COLUMN outcome_sets.is_exhaustive IS
  'Categorical-only: TRUE = provable partition (Σ=1, exactly one slot TRUE); '
  'FALSE = mutual-exclusion only (Σ≤1, the all-FALSE world is real). DEFAULT FALSE '
  '(migration 070, AUD-35) fails safe — an unset/unknown set is treated as non-exhaustive. '
  'finalize.ts writes it explicitly for every categorical set (negRisk/numeric-tiling/'
  'residual ⟹ TRUE). Ignored for threshold_series (own k+1 partition) and bundle/tournament.';

-- =============================================================
-- OUTCOME SET SLOTS: OutcomeSet → Question mapping
-- =============================================================
CREATE TABLE outcome_set_slots (
    set_id          INTEGER NOT NULL REFERENCES outcome_sets(id) ON DELETE CASCADE,
    slot_ordinal    INTEGER NOT NULL,
    question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    PRIMARY KEY(set_id, slot_ordinal),
    UNIQUE(set_id, question_id)
);

CREATE INDEX idx_oss_set ON outcome_set_slots(set_id);
CREATE INDEX idx_oss_question ON outcome_set_slots(question_id);

-- =============================================================
-- OUTCOME SET DUPLICATE SUSPECTS (migration 089): Ω-liveness §4 / F-5.
-- Duplicate-partition twin pairs found at Stage-4 finalize (Arm D): two co-slots
-- of ONE categorical set that resolve for the SAME real-world cell but are not a
-- full settlement-signature match. The finalize gate drops the duplicate slot +
-- demotes the set Σ=1→Σ≤1 + records the pair here; the arb-solver loader unions
-- these into duplicateSuspectPairs before its runtime belt so the durable fix
-- materializes on the next rebuild. Additive/reversible (DROP degrades to
-- solver-belt-only).
-- =============================================================
CREATE TABLE outcome_set_duplicate_suspects (
    set_id          INTEGER NOT NULL REFERENCES outcome_sets(id) ON DELETE CASCADE,
    question_a_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    question_b_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (set_id, question_a_id, question_b_id),
    CONSTRAINT chk_osds_pair_order CHECK (question_a_id < question_b_id)
);

CREATE INDEX idx_osds_set ON outcome_set_duplicate_suspects(set_id);
CREATE INDEX idx_osds_qa ON outcome_set_duplicate_suspects(question_a_id);
CREATE INDEX idx_osds_qb ON outcome_set_duplicate_suspects(question_b_id);

-- =============================================================
-- TOURNAMENT STATES (migration 054): cross-event tournament layer.
-- One row per competition edition holding the web/LLM-extracted structure
-- (format_spec) + live resolution_state. Edges this layer writes are tagged
-- with tournament_state_id (below) so they're rebuildable/removable as a unit.
-- =============================================================
CREATE TABLE tournament_states (
    id                SERIAL PRIMARY KEY,
    -- Soft reference (NO FK): reference data must survive `TRUNCATE known_entities
    -- CASCADE` (the stage1-3+kb wipe). TRUNCATE CASCADE ignores ON DELETE and would
    -- truncate any FK-referencing table. Resolve by (canonical, edition) at use-time.
    competition_id    INTEGER,
    canonical         TEXT    NOT NULL,
    edition           TEXT    NOT NULL,
    sport             TEXT,
    external_source   TEXT,
    format_spec       JSONB   NOT NULL,
    resolution_state  JSONB   NOT NULL DEFAULT '{}',
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (canonical, edition)
);
CREATE INDEX idx_tournament_states_active ON tournament_states(id) WHERE active;

-- =============================================================
-- IMPLICATION EDGES: Core directed graph between Questions
-- antecedent ⟹ consequent
-- "If antecedent resolves YES, consequent must also resolve YES"
-- =============================================================
CREATE TABLE implication_edges (
    id                      SERIAL PRIMARY KEY,

    antecedent_question_id  INTEGER NOT NULL REFERENCES questions(id),
    consequent_question_id  INTEGER NOT NULL REFERENCES questions(id),

    edge_type               VARCHAR(30) NOT NULL
                                CONSTRAINT chk_edges_edge_type
                                CHECK (edge_type IN (
                                  'strict_implication','equivalence','conditional',
                                  'probabilistic','mutual_exclusion','near_equivalence'
                                )),
    -- Allow-list mirrors EDGE_PATTERNS in packages/types/src/pipeline.ts (43 labels,
    -- migrations 059/064/065/071/072/076-088; 'transitive' dropped by 081). Keep the
    -- inline CHECK and the named chk_edges_pattern (added below) in lock-step — the
    -- soundness-regression asserts pin both against EDGE_PATTERNS.
    pattern                 VARCHAR(30)
                                CHECK (pattern IS NULL OR pattern IN (
                                  'date_threshold','numeric_threshold','tournament_advancement','cross_set_tournament',
                                  'sequential_stage','cross_platform','llm_detected',
                                  'participant_superset','parlay_leg_dominance','parlay_subset',
                                  -- Migration 059: rebuilt cross-question edge-rule labels
                                  'numeric_ladder_xq','exact_score_derived','cross_question_equiv',
                                  'cross_question_mutex','date_implication',
                                  -- Migration 064: exact-score derivation arms + spread mutex + elimination
                                  'exact_score_winner','exact_score_draw','exact_score_total_over',
                                  'exact_score_total_under','exact_score_btts',
                                  'cross_question_mutex_spread','elimination_reach',
                                  -- Migration 065: Predict→Polymarket conditionId ground-truth equivalence
                                  'cross_ref_equiv',
                                  -- Migrations 071-077: builder-wave labels
                                  'margin_winner','shape_bridge','window_containment','spread_winner',
                                  -- Migration 078: tier-B tournament labels
                                  'elimination_stage_mutex','group_champion_superset','host_stage_mutex',
                                  -- Migration 079: fixture totals + strike ladder
                                  'btts_total_over','team_game_total_over','spread_total_over',
                                  'fixture_total_ladder','slice_game_total_over','kalshi_strike_ladder',
                                  -- Migration 080: media-release ladder + scorer props
                                  'media_release_ladder','first_anytime_scorer',
                                  -- Migrations 082-084
                                  'election_precondition','numeric_threshold_raw','cross_question_mutex_halftime',
                                  -- Migration 085 (DW-58; label applied on the live DB — builder still parked)
                                  'primary_rank_ladder',
                                  -- Migration 087 (B-48 cross-venue rate-decision bridge)
                                  'rate_decision_bridge'
                                )),

    confidence              DECIMAL NOT NULL DEFAULT 0,
    deterministic           BOOLEAN DEFAULT FALSE,
    source                  VARCHAR(20) NOT NULL
                                CONSTRAINT chk_edges_source
                                CHECK (source IN ('algorithmic','llm','platform_structure')),
    confirmed               BOOLEAN NOT NULL DEFAULT FALSE,
    reasoning               TEXT,
    -- Phase 1: Basis risk annotation.
    -- WP-1.4 / migration 088: widened VARCHAR(20)->VARCHAR(30) to hold the 22-char
    -- 'cross_venue_settlement' tag (P-BASIS, spec §3.3). Mirrors BasisRisk in
    -- packages/types/src/pipeline.ts.
    basis_risk              VARCHAR(30),
    risk_detail             TEXT,
    -- Migration 028: operator acknowledgement timestamp for basis-risk review.
    basis_risk_ack_at       TIMESTAMPTZ DEFAULT NULL,
    -- Migration 054: tournament-layer edge ownership (NULL for all other edges).
    tournament_state_id     INTEGER REFERENCES tournament_states(id) ON DELETE CASCADE,

    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(antecedent_question_id, consequent_question_id)
);

-- Second, redundant named copy of the pattern allow-list (migration 023 convention;
-- the live DB carries BOTH). Keep in lock-step with the inline CHECK above — the
-- EDGE_PATTERNS parity assert pins the two against each other.
ALTER TABLE implication_edges ADD CONSTRAINT chk_edges_pattern
    CHECK (pattern IS NULL OR pattern IN (
      'date_threshold','numeric_threshold','tournament_advancement','cross_set_tournament',
      'sequential_stage','cross_platform','llm_detected',
      'participant_superset','parlay_leg_dominance','parlay_subset',
      'numeric_ladder_xq','exact_score_derived','cross_question_equiv',
      'cross_question_mutex','date_implication',
      'exact_score_winner','exact_score_draw','exact_score_total_over',
      'exact_score_total_under','exact_score_btts',
      'cross_question_mutex_spread','elimination_reach',
      'cross_ref_equiv',
      'margin_winner','shape_bridge','window_containment','spread_winner',
      'elimination_stage_mutex','group_champion_superset','host_stage_mutex',
      'btts_total_over','team_game_total_over','spread_total_over',
      'fixture_total_ladder','slice_game_total_over','kalshi_strike_ladder',
      'media_release_ladder','first_anytime_scorer',
      'election_precondition','numeric_threshold_raw','cross_question_mutex_halftime',
      'primary_rank_ladder','rate_decision_bridge'
    ));

CREATE INDEX idx_edges_antecedent ON implication_edges(antecedent_question_id);
CREATE INDEX idx_edges_consequent ON implication_edges(consequent_question_id);
CREATE INDEX idx_edges_type ON implication_edges(edge_type);
CREATE INDEX idx_edges_source ON implication_edges(source);
CREATE INDEX idx_edges_confirmed ON implication_edges(confirmed);
CREATE INDEX idx_edges_tournament_state ON implication_edges(tournament_state_id)
    WHERE tournament_state_id IS NOT NULL;

-- =============================================================
-- MARKET PRICES: Live price tracking for arbitrage
-- =============================================================
CREATE TABLE market_prices (
    market_id       INTEGER PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
    yes_price       DECIMAL NOT NULL DEFAULT 0.5,
    no_price        DECIMAL NOT NULL DEFAULT 0.5,
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- CLOB PRICES: Live bid/ask from CLOB feeds (arb-solver service)
-- =============================================================
CREATE TABLE clob_prices (
    market_id       INTEGER PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
    best_bid        DECIMAL,
    best_ask        DECIMAL,
    bid_size        DECIMAL,
    ask_size        DECIMAL,
    source          VARCHAR(10) NOT NULL DEFAULT 'clob',
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- ARBITRAGE OPPORTUNITIES
-- =============================================================
CREATE TABLE arbitrage_opportunities (
    id                      SERIAL PRIMARY KEY,
    edge_id                 INTEGER REFERENCES implication_edges(id) ON DELETE CASCADE,
    arb_type                VARCHAR(40) NOT NULL DEFAULT 'implication_single'
                                CONSTRAINT chk_arb_type
                                CHECK (arb_type IN (
                                  'implication_single','implication_multi_leg','equivalence_cross_platform',
                                  'transitivity_violation','complementary',
                                  'lp_solver',         -- migration 062: certified LP-over-Ω arb
                                  'lp_solver_graded'   -- migration 063: graded residual-tail near-arb
                                )),
    antecedent_platform     VARCHAR(20) NOT NULL,
    consequent_platform     VARCHAR(20) NOT NULL,
    strategy                TEXT NOT NULL,
    legs                    JSONB NOT NULL DEFAULT '[]',
    cost                    DECIMAL NOT NULL,
    max_profit              DECIMAL NOT NULL,
    basis_risk              VARCHAR(20) NOT NULL DEFAULT 'none',  -- migration 063: fits 'residual_tail'
    basis_risk_detail       TEXT,
    current                 BOOLEAN DEFAULT TRUE,
    detected_at             TIMESTAMPTZ DEFAULT NOW(),
    -- LP solver columns
    cluster_id              INTEGER,
    portfolio_cost          DECIMAL,
    guaranteed_payout       DECIMAL DEFAULT 1.0,
    solve_time_ms           INTEGER,
    state_count             INTEGER,
    market_count            INTEGER,
    worst_state_payout      DECIMAL,
    liquidity_usd           DECIMAL
);

-- Unique constraint: for edge-based arbs use edge_id, for others use arb_type + leg market ids
-- We use a partial unique index: edge_id is unique when not null
CREATE UNIQUE INDEX arbitrage_opportunities_edge_unique ON arbitrage_opportunities(edge_id) WHERE edge_id IS NOT NULL;
-- For non-edge arbs, use arb_type + strategy hash as conflict target
ALTER TABLE arbitrage_opportunities ADD CONSTRAINT arbitrage_opportunities_unique_key
    UNIQUE (arb_type, antecedent_platform, consequent_platform, strategy);

CREATE INDEX idx_arb_current ON arbitrage_opportunities(current);
CREATE INDEX idx_arb_profit ON arbitrage_opportunities(max_profit DESC);
CREATE INDEX idx_arb_detected ON arbitrage_opportunities(detected_at DESC);

-- =============================================================
-- PIPELINE RUNS
-- =============================================================
CREATE TABLE pipeline_runs (
    id              SERIAL PRIMARY KEY,
    run_type        VARCHAR(20) NOT NULL,
    triggered_by    VARCHAR(20),
    phase1_stats    JSONB,
    phase2_stats    JSONB,
    phase3_stats    JSONB,
    costs           JSONB,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    status          VARCHAR(20) DEFAULT 'running',
    error           TEXT
);

-- =============================================================
-- LLM LOGS: Per-call cost and latency tracking
-- =============================================================
CREATE TABLE llm_logs (
    id              SERIAL PRIMARY KEY,
    pipeline_run_id INTEGER REFERENCES pipeline_runs(id),
    phase           VARCHAR(40) NOT NULL,
    provider        VARCHAR(30) NOT NULL,
    model           VARCHAR(50) NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    cost_usd        DECIMAL NOT NULL DEFAULT 0,
    success         BOOLEAN NOT NULL DEFAULT TRUE,
    error           TEXT,
    context         JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_logs_run ON llm_logs(pipeline_run_id);
CREATE INDEX idx_llm_logs_phase ON llm_logs(phase);
CREATE INDEX idx_llm_logs_created ON llm_logs(created_at);

-- =============================================================
-- PIPELINE STATE: Per-platform watermarks
-- =============================================================
CREATE TABLE pipeline_state (
    platform            VARCHAR(20) PRIMARY KEY,
    last_synced_at      TIMESTAMPTZ,
    last_processed_at   TIMESTAMPTZ,
    markets_count       INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO pipeline_state (platform) VALUES
    ('kalshi'), ('limitless'), ('polymarket'), ('predict');

-- =============================================================
-- PIPELINE HEARTBEATS: daemon liveness pulse (migration 091, F-4)
-- One row per component (upserted by db/heartbeat.ts's dedicated timer);
-- soak-watchdog.ts reads beat_at back to detect a dead/slept daemon.
-- =============================================================
CREATE TABLE pipeline_heartbeats (
    component  TEXT PRIMARY KEY,
    beat_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pid        INTEGER,
    hostname   TEXT,
    beats      BIGINT NOT NULL DEFAULT 0,
    detail     JSONB
);

-- =============================================================
-- REVIEW ANNOTATIONS: Human-in-the-loop verdicts for pipeline outputs
-- (migration 004)
-- =============================================================
CREATE TABLE review_verdicts (
    id            SERIAL PRIMARY KEY,
    kind          VARCHAR(30) NOT NULL,
    ref_id        INTEGER     NOT NULL,
    verdict       VARCHAR(20) NOT NULL DEFAULT 'pending',
    corrections   JSONB       NOT NULL DEFAULT '{}',
    notes         TEXT,
    reviewer      VARCHAR(80),
    reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, ref_id)
);

CREATE INDEX idx_review_verdicts_kind    ON review_verdicts(kind);
CREATE INDEX idx_review_verdicts_verdict ON review_verdicts(kind, verdict);

-- Append-only audit trail for replay / training dataset generation
CREATE TABLE review_verdict_history (
    id            SERIAL PRIMARY KEY,
    kind          VARCHAR(30) NOT NULL,
    ref_id        INTEGER     NOT NULL,
    verdict       VARCHAR(20) NOT NULL,
    corrections   JSONB       NOT NULL DEFAULT '{}',
    notes         TEXT,
    reviewer      VARCHAR(80),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_review_verdict_history_ref ON review_verdict_history(kind, ref_id);

CREATE OR REPLACE FUNCTION review_verdicts_history_trg() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO review_verdict_history (kind, ref_id, verdict, corrections, notes, reviewer)
    VALUES (NEW.kind, NEW.ref_id, NEW.verdict, NEW.corrections, NEW.notes, NEW.reviewer);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_verdicts_history
AFTER INSERT OR UPDATE ON review_verdicts
FOR EACH ROW EXECUTE FUNCTION review_verdicts_history_trg();

-- (rule_engine_queue / rule_engine_decisions were dropped by migration 081 —
-- the deterministic rule-engine LLM queue was retired; do not re-create them.)

-- =============================================================
-- ENTITY CATEGORY COUNTS (migration 029): per-entity category histograms.
-- Deterministic gate before any LLM merge call so the same surface form
-- ("Trump") cannot collapse across unrelated categories.
-- =============================================================
CREATE TABLE entity_category_counts (
    entity_id       INTEGER NOT NULL REFERENCES known_entities(id) ON DELETE CASCADE,
    category        TEXT    NOT NULL,
    n               INTEGER NOT NULL DEFAULT 0,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (entity_id, category)
);
CREATE INDEX idx_ecc_entity ON entity_category_counts(entity_id);

COMMENT ON TABLE entity_category_counts IS
  'Per-entity category histogram. Single-row UPSERT on every market_entity_links insert; rewritten in merge.ts when two entities collapse.';
COMMENT ON COLUMN entity_category_counts.category IS
  'markets.category_unified value at the moment the link was written. NULL category rows are not stored — the backfill catches them later.';

-- Summary view used by the audit query in db/health-checks.ts and the dashboard.
CREATE OR REPLACE VIEW entity_category_summary AS
SELECT
  ecc.entity_id,
  SUM(ecc.n)                                         AS total_obs,
  MAX(ecc.n) * 1.0 / NULLIF(SUM(ecc.n), 0)           AS dominant_share,
  COUNT(*)                                           AS distinct_categories,
  (SELECT ecc2.category
     FROM entity_category_counts ecc2
     WHERE ecc2.entity_id = ecc.entity_id
     ORDER BY ecc2.n DESC, ecc2.category ASC
     LIMIT 1)                                        AS dominant_category
FROM entity_category_counts ecc
GROUP BY ecc.entity_id;

-- =============================================================
-- ENTITY SUBJECTS: subject-phrase embeddings for Tier-2 resolution
-- =============================================================
CREATE TABLE entity_subjects (
    subject_text      TEXT NOT NULL,
    canonical_subject TEXT NOT NULL,
    embedding         VECTOR(1536) NOT NULL,
    domain_category   VARCHAR(30) NOT NULL DEFAULT 'other',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subject_text, domain_category)
);
CREATE INDEX idx_entity_subjects_embedding ON entity_subjects USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_entity_subjects_domain ON entity_subjects(domain_category);

-- =============================================================
-- EDGE CONTRADICTIONS: detected by Phase 5 contradiction scanner
-- =============================================================
CREATE TABLE edge_contradictions (
    id         SERIAL PRIMARY KEY,
    edge_a_id  INTEGER NOT NULL REFERENCES implication_edges(id) ON DELETE CASCADE,
    edge_b_id  INTEGER          REFERENCES implication_edges(id) ON DELETE CASCADE,
    kind       VARCHAR(40) NOT NULL,
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (edge_a_id, edge_b_id, kind)
);

-- =============================================================
-- VIEWS
-- =============================================================

CREATE VIEW v_active_arbitrage AS
SELECT
    ao.*,
    ie.edge_type,
    ie.pattern,
    ie.reasoning as edge_reasoning,
    ie.deterministic
FROM arbitrage_opportunities ao
LEFT JOIN implication_edges ie ON ao.edge_id = ie.id
WHERE ao.current = TRUE
ORDER BY ao.max_profit DESC;

CREATE VIEW v_question_summary AS
SELECT
    q.*,
    COUNT(DISTINCT qm.market_id) AS actual_member_count,
    COUNT(DISTINCT qm.market_id) FILTER (WHERE qm.platform = 'kalshi')     AS kalshi_count,
    COUNT(DISTINCT qm.market_id) FILTER (WHERE qm.platform = 'limitless')  AS limitless_count,
    COUNT(DISTINCT qm.market_id) FILTER (WHERE qm.platform = 'polymarket') AS polymarket_count,
    COUNT(DISTINCT qm.market_id) FILTER (WHERE qm.platform = 'predict')    AS predict_count,
    COUNT(DISTINCT ie_a.id) + COUNT(DISTINCT ie_c.id) AS edge_count
FROM questions q
LEFT JOIN question_members qm ON q.id = qm.question_id
LEFT JOIN implication_edges ie_a ON ie_a.antecedent_question_id = q.id
LEFT JOIN implication_edges ie_c ON ie_c.consequent_question_id = q.id
GROUP BY q.id;

CREATE VIEW v_outcome_set_detail AS
SELECT
    os.*,
    oss.slot_ordinal,
    oss.question_id,
    q.canonical_subject,
    q.condition_value,
    q.best_yes_price,
    q.best_no_price
FROM outcome_sets os
JOIN outcome_set_slots oss ON os.id = oss.set_id
JOIN questions q ON oss.question_id = q.id
ORDER BY os.id, oss.slot_ordinal;

-- =============================================================
-- FUNCTIONS: Transitive graph traversal (question-centric)
-- =============================================================

-- Forward: all questions implied by start_question_id (A ⟹ B ⟹ C...)
CREATE OR REPLACE FUNCTION get_implied_questions(start_question_id INTEGER)
RETURNS TABLE(question_id INTEGER, depth INTEGER, path INTEGER[]) AS $$
    WITH RECURSIVE implied AS (
        SELECT consequent_question_id AS question_id, 1 AS depth,
               ARRAY[start_question_id, consequent_question_id] AS path
        FROM implication_edges
        WHERE antecedent_question_id = start_question_id
          AND deterministic = TRUE

        UNION ALL

        SELECT ie.consequent_question_id, i.depth + 1,
               i.path || ie.consequent_question_id
        FROM implied i
        JOIN implication_edges ie ON ie.antecedent_question_id = i.question_id
        WHERE ie.deterministic = TRUE
          AND ie.consequent_question_id != ALL(i.path)
          AND i.depth < 10
    )
    SELECT * FROM implied;
$$ LANGUAGE SQL;

-- Reverse: all questions that imply target_question_id (...C ⟹ B ⟹ A)
CREATE OR REPLACE FUNCTION get_implying_questions(target_question_id INTEGER)
RETURNS TABLE(question_id INTEGER, depth INTEGER, path INTEGER[]) AS $$
    WITH RECURSIVE implying AS (
        SELECT antecedent_question_id AS question_id, 1 AS depth,
               ARRAY[target_question_id, antecedent_question_id] AS path
        FROM implication_edges
        WHERE consequent_question_id = target_question_id
          AND deterministic = TRUE

        UNION ALL

        SELECT ie.antecedent_question_id, i.depth + 1,
               i.path || ie.antecedent_question_id
        FROM implying i
        JOIN implication_edges ie ON ie.consequent_question_id = i.question_id
        WHERE ie.deterministic = TRUE
          AND ie.antecedent_question_id != ALL(i.path)
          AND i.depth < 10
    )
    SELECT * FROM implying;
$$ LANGUAGE SQL;

-- =============================================================
-- Migrations 015-017 (appended): stage1 queue + market resolution + question lifecycle
-- =============================================================

-- Migration 015: Stage 1 work queue
--
-- Replaces the "drain the unfeaturized markets table" pattern with an
-- explicit work queue. Each row represents one market that needs Stage 1
-- processing (featurize → LLM normalize → embed). Workers claim rows via
-- `SELECT ... FOR UPDATE SKIP LOCKED` so multiple in-process workers (and,
-- in the future, multiple processes) can run concurrently without stepping
-- on each other.
--
-- The queue is populated whenever a market is upserted in db/sync.ts. Once
-- a worker finishes a market it marks the row done. Failed rows record the
-- error and the attempts counter so retries are explicit.

CREATE TABLE IF NOT EXISTS stage1_queue (
    id          BIGSERIAL PRIMARY KEY,
    market_id   INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    claimed_by  TEXT,
    claimed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (market_id)
);

-- Lookup index for claim queries (skip locked).
CREATE INDEX IF NOT EXISTS idx_stage1_queue_pending
    ON stage1_queue (created_at)
    WHERE status = 'pending';

-- Lookup for stuck `processing` rows (worker died). A periodic janitor can
-- reset rows whose claimed_at is older than a threshold.
CREATE INDEX IF NOT EXISTS idx_stage1_queue_processing
    ON stage1_queue (claimed_at)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_stage1_queue_failed
    ON stage1_queue (id)
    WHERE status = 'failed';

-- Migration 018: Stage 2/3 trigger queue
--
-- Markets inserted here by Stage 1 when fully processed. Drained by
-- run.ts / daemon when count ≥ 1k-threshold or Stage 1 finishes.
-- Enables incremental Stage 2 ANN (new × all_active vs all × all).
CREATE TABLE IF NOT EXISTS stage23_queue (
    id          BIGSERIAL PRIMARY KEY,
    market_id   INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (market_id)
);

CREATE INDEX IF NOT EXISTS idx_stage23_queue_created
    ON stage23_queue (created_at);

-- Migration 016: Market resolution lifecycle
--
-- Adds two columns to `markets` so the pipeline can distinguish a market
-- that is still tradable (resolved_at IS NULL) from one that has already
-- settled. `winning_outcome` already exists in the schema — Migration 016
-- just adds the timestamp + provenance + the index downstream queries
-- need to filter cheaply.
--
-- See docs/plan-resolution-detection.md (Step 1) for the architecture.

ALTER TABLE markets
    ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolution_source TEXT;

-- Filter index for "is this market still active?" queries.
CREATE INDEX IF NOT EXISTS idx_markets_resolved_at
    ON markets (resolved_at)
    WHERE resolved_at IS NOT NULL;

-- Lookup index for "give me all open markets" path used by Stage 1/2/3.
CREATE INDEX IF NOT EXISTS idx_markets_open
    ON markets (id)
    WHERE resolved_at IS NULL;
-- Migration 017: Question + edge lifecycle
--
-- Adds `open_member_count` + `archived_at` to `questions` and `archived_at`
-- to `implication_edges` so Stage 3 (and the arb-solver) can cheaply skip
-- pairs whose underlying markets have all resolved.
--
-- Semantics:
--   - questions.open_member_count = COUNT(question_members where market not resolved)
--     Recomputed at the end of Stage 2.
--   - questions.archived_at is set when open_member_count drops to 0 with
--     member_count > 0 (i.e. all members resolved — not "no members were
--     ever attached").
--   - implication_edges.archived_at is set when both endpoint questions are
--     archived. The arb-solver loader filters archived_at IS NULL.

ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS open_member_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_questions_open
    ON questions (id)
    WHERE archived_at IS NULL AND open_member_count > 0;

-- Migration 039: fast scan of live non-parlay nodes (Ω excludes parlays).
CREATE INDEX IF NOT EXISTS idx_questions_non_parlay_active
    ON questions (id)
    WHERE is_parlay = FALSE AND archived_at IS NULL;

ALTER TABLE implication_edges
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_implication_edges_active
    ON implication_edges (antecedent_question_id, consequent_question_id)
    WHERE archived_at IS NULL;

-- Migration 019: platform_events re-normalization counter
-- (Applied inline above via last_normalized_child_count column)

-- =============================================================
-- Migration 020: Market discovery & resolution statistics
-- =============================================================

-- ── 1. Point-in-time snapshot table ──────────────────────────────────────────
-- Written by the live-monitor every stats window (~60 min).
-- Lets you reconstruct "how many were open on date X?" which cannot be
-- derived from event timestamps alone.

CREATE TABLE IF NOT EXISTS platform_market_snapshots (
    id            SERIAL PRIMARY KEY,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    platform      VARCHAR(20) NOT NULL,

    total_count    INT NOT NULL DEFAULT 0,
    open_count     INT NOT NULL DEFAULT 0,
    resolved_count INT NOT NULL DEFAULT 0,

    -- Fraction of resolved markets that have a non-null winning_outcome.
    winner_fill_rate NUMERIC(5,4),

    CONSTRAINT pms_platform_chk
        CHECK (platform IN ('kalshi','polymarket','limitless','predict'))
);

CREATE INDEX IF NOT EXISTS idx_pms_captured_at
    ON platform_market_snapshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_pms_platform_captured
    ON platform_market_snapshots (platform, captured_at DESC);

-- ── 2. platform_created_at column (migration 021) ────────────────────────────
ALTER TABLE markets
    ADD COLUMN IF NOT EXISTS platform_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_markets_platform_created_at
    ON markets (platform, platform_created_at)
    WHERE platform_created_at IS NOT NULL;

-- ── 3. synced_at index (needed for views below) ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_markets_synced_at
    ON markets (synced_at)
    WHERE synced_at IS NOT NULL;

-- ── 4. Daily discovery view ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_market_discovery_daily AS
SELECT
    DATE_TRUNC('day', COALESCE(platform_created_at, synced_at) AT TIME ZONE 'UTC') AS day,
    platform,
    COUNT(*)                                          AS discovered,
    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)  AS already_resolved,
    COUNT(*) FILTER (WHERE resolved_at IS NULL)      AS still_open
FROM markets
WHERE COALESCE(platform_created_at, synced_at) IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ── 5. Daily resolution view ──────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_market_resolution_daily AS
SELECT
    DATE_TRUNC('day', resolved_at AT TIME ZONE 'UTC') AS day,
    platform,
    COUNT(*)                                            AS resolved,
    COUNT(*) FILTER (WHERE winning_outcome IS NOT NULL) AS with_winner,
    COUNT(*) FILTER (WHERE winning_outcome IS NULL)     AS without_winner,
    COUNT(*) FILTER (WHERE resolution_source LIKE '%/poll')   AS via_poll,
    COUNT(*) FILTER (WHERE resolution_source LIKE '%/gap%')   AS via_gap_refill,
    COUNT(*) FILTER (WHERE resolution_source LIKE '%wss%'
                       OR  resolution_source LIKE '%/lifecycle%') AS via_wss
FROM markets
WHERE resolved_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ── 6. Weekly cohort view ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_market_cohort_weekly AS
SELECT
    DATE_TRUNC('week', COALESCE(platform_created_at, synced_at) AT TIME ZONE 'UTC') AS discovery_week,
    platform,
    COUNT(*)                                          AS cohort_size,
    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)  AS resolved_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)
        / NULLIF(COUNT(*), 0), 1
    )::FLOAT8                                         AS pct_resolved,
    AVG(
        EXTRACT(EPOCH FROM (resolved_at - COALESCE(platform_created_at, synced_at))) / 86400.0
    ) FILTER (WHERE resolved_at IS NOT NULL)::FLOAT8  AS avg_days_to_resolve,
    PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (resolved_at - COALESCE(platform_created_at, synced_at))) / 86400.0
    ) FILTER (WHERE resolved_at IS NOT NULL)::FLOAT8  AS median_days_to_resolve
FROM markets
WHERE COALESCE(platform_created_at, synced_at) IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- =============================================================
-- WAL / checkpoint tuning — prevents the 276GB-vhdx incident
-- where heavy bulk-INSERT cycles (Stage 1 featurization, Stage 1e
-- enrichment, repeated TRUNCATE+reload) outran the checkpointer and
-- WAL accumulated unboundedly. ALTER SYSTEM writes to
-- postgresql.auto.conf which persists across restarts.
-- =============================================================
ALTER SYSTEM SET max_wal_size = '2GB';
ALTER SYSTEM SET min_wal_size = '128MB';
ALTER SYSTEM SET checkpoint_timeout = '5min';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;

-- =============================================================
-- Disk-bloat safeguards — prevents the 2026-05-20 268GB-vhdx incident
-- where ad-hoc queries (sorts/hash-joins on markets.embedding + raw
-- JSONB) spilled tens of GB to base/pgsql_tmp before crashing Docker.
-- temp_file_limit is the load-bearing guard: any session spilling more
-- than 100GB to disk dies with a loud error instead of filling the VHD.
-- Sparse-mode WSL distros reclaim the freed blocks immediately after, so
-- the cap can be generous; the goal is to catch infinite-loop pathologies,
-- not to constrain legitimate Stage 2 self-joins on the questions table.
-- =============================================================
ALTER SYSTEM SET work_mem = '64MB';                            -- fewer spills (default 4MB)
ALTER SYSTEM SET temp_file_limit = '100GB';                    -- hard cap per session — sparse-mode reclaims after
ALTER SYSTEM SET log_temp_files = '64MB';                      -- log any spill ≥64MB to spot culprits
ALTER SYSTEM SET statement_timeout = '10min';                  -- kill queries hung > 10min
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min'; -- reap leaked transactions

SELECT pg_reload_conf();
