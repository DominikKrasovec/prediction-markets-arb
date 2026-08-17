import type { Platform } from './platform.js';

export const UNIFIED_CATEGORIES = [
  'sports',
  'crypto',
  'election',
  'politics',
  'economic',
  'entertainment',
  'technology',
  'weather',
  'geopolitical',
  'other',
] as const;
export type UnifiedCategory = (typeof UNIFIED_CATEGORIES)[number];

export const SUBJECT_ENTITY_TYPES = [
  'person', 'organization', 'team', 'asset', 'location', 'event_name',
  // Typed separately so it never merges with candidate persons.
  'party',
] as const;
export type SubjectEntityType = (typeof SUBJECT_ENTITY_TYPES)[number];

export const STRUCTURAL_ENTITY_TYPES = [
  'league', 'sport', 'competition', 'data_provider',
] as const;
export type StructuralEntityType = (typeof STRUCTURAL_ENTITY_TYPES)[number];

export const ENTITY_TYPES = [
  ...SUBJECT_ENTITY_TYPES,
  ...STRUCTURAL_ENTITY_TYPES,
  'unknown',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

// Excludes location/event_name/structural types, where token overlap causes false matches.
export const FUZZY_MATCHABLE_ENTITY_TYPES = [
  'person', 'team', 'organization', 'asset',
] as const;
export type FuzzyMatchableEntityType = (typeof FUZZY_MATCHABLE_ENTITY_TYPES)[number];

// Must be scope-checked by (league, sport); same-name teams across leagues are distinct.
export const LEAGUE_SCOPED_ENTITY_TYPES = [
  'team', 'league', 'competition',
] as const;
export type LeagueScopedEntityType = (typeof LEAGUE_SCOPED_ENTITY_TYPES)[number];

/** Directed relation between two known_entities rows. */
export type EntityRelation =
  | 'plays_for'
  | 'competes_in'
  | 'part_of'
  | 'located_in'
  | 'covers';

export const RESOLUTION_KINDS = [
  'candle_data',
  'exchange_oracle',
  'league_official',
  'esports_stats',
  'election_authority',
  'media_consensus',
  'court_ruling',
  'tournament_official',
  'other',
] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

// Drives I-rules in Stage 3.
export const EVENT_KINDS = [
  'match_winner',
  'match_total_metric',
  'match_event_prop',
  'match_spread',
  'halftime_leader',
  'both_teams_score',
  'exact_score',
  'player_prop_threshold',
  'championship_winner',
  'stage_advance',
  'series_stage_winner',
  'price_threshold',
  'price_snapshot',
  'price_range_snapshot',
  'candle_direction',
  'econ_indicator_threshold',
  'count_threshold',
  'policy_action',
  'election_outcome_winner',
  'election_seat_winner',
  'primary_winner',
  'governing_coalition',
  'election_margin',
  'election_turnout',
  'election_vote_share',
  'person_action_count',
  'social_media_metric',
  'speech_mention',
  'approval_rating',
  'geopolitical_event',
  'government_shutdown',
  'weather_extreme',
  'award_winner',
  'media_release',
  'crypto_launch_fdv',
  'token_launch',
  'participation',
  'personnel_move',
  'other',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// Not yet wired into any edge/outcome-set consumer; treated as NULL by kind-heterogeneity checks.
export const SET_INERT_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'econ_indicator_threshold',
  'count_threshold',
]);

export function isSetInertEventKind(kind: string | null | undefined): boolean {
  return kind != null && (SET_INERT_EVENT_KINDS as ReadonlySet<string>).has(kind);
}

// Once decided these outcomes cannot reverse; excluded kinds have reversible/count semantics.
export const TERMINAL_MONOTONIC_EVENT_KINDS = [
  'championship_winner',
  'stage_advance',
  'series_stage_winner',
  'match_winner',
  'award_winner',
  'election_outcome_winner',
  'election_seat_winner',
  'primary_winner',
  'media_release',
] as const;
export type TerminalMonotonicEventKind = (typeof TERMINAL_MONOTONIC_EVENT_KINDS)[number];

// Assumes single-elimination; losers-bracket tournaments must be excluded by the consumer.
export const STAGE_EVENT_KINDS = [
  'championship_winner',
  'stage_advance',
  'series_stage_winner',
] as const;
export type StageEventKind = (typeof STAGE_EVENT_KINDS)[number];

export interface TeamMetadata {
  kind: 'team';
  league_canonical?: string;
  sport_canonical: string;
  country?: string;
}
export interface PersonMetadata {
  kind: 'person';
  role: 'athlete' | 'politician' | 'executive' | 'celebrity' | 'other';
  primary_team_canonical?: string;
  country?: string;
}
export interface AssetMetadata {
  kind: 'asset';
  asset_class: 'crypto' | 'stock' | 'fx' | 'commodity' | 'index';
  ticker?: string;
}
export interface LocationMetadata {
  kind: 'location';
  loc_kind: 'country' | 'city' | 'region' | 'venue';
  country?: string;
}
export interface OrganizationMetadata {
  kind: 'organization';
  org_kind: 'party' | 'company' | 'government' | 'club' | 'governing_body' | 'other';
  country?: string;
}
export interface LeagueMetadata {
  kind: 'league';
  sport_canonical: string;
  country?: string;
  level?: 'top_flight' | 'second_tier';
}
export interface SportMetadata {
  kind: 'sport';
}
export interface CompetitionMetadata {
  kind: 'competition';
  league_canonical?: string;
  sport_canonical?: string;
  scope: 'season' | 'tournament' | 'cup' | 'playoff';
}
export interface DataProviderMetadata {
  kind: 'data_provider';
  domain:
    | 'exchange'
    | 'oracle'
    | 'candle_aggregator'
    | 'esports_stats'
    | 'league_official'
    | 'media'
    | 'election_authority'
    | 'court';
  covers?: string[];
}

export type EntityMetadata =
  | TeamMetadata
  | PersonMetadata
  | AssetMetadata
  | LocationMetadata
  | OrganizationMetadata
  | LeagueMetadata
  | SportMetadata
  | CompetitionMetadata
  | DataProviderMetadata;

export interface ExtractedEntity {
  text: string;
  normalized: string;
  type: EntityType;
  source: 'title' | 'description';
}

export interface ResolvedEntity {
  canonical: string;
  type: EntityType;
  aliases: string[];
  // Partial metadata is merged into known_entities.metadata; missing keys are left absent.
  metadata?: Partial<EntityMetadata>;
}

export interface ExtractedDate {
  raw: string;
  parsed: Date;
  role: 'deadline' | 'event' | 'reference';
  source: 'title' | 'description' | 'end_date';
}

export interface ExtractedNumber {
  raw: string;
  value: number;
  unit: string | null;
  context: string;
}

export const HIERARCHY_TYPES = [
  'tournament_round',
  'date_threshold',
  'numeric_threshold',
  'sequential_stage',
] as const;
export type HierarchyType = (typeof HIERARCHY_TYPES)[number];

export const CONDITION_SHAPES = [
  'monotonic_threshold',
  'range_snapshot',
  'point_in_time',
  'cumulative_deadline',
  'binary_event',
  'categorical_outcome',
] as const;
export type ConditionShape = (typeof CONDITION_SHAPES)[number];

export const CONDITION_DIRECTIONS = ['above', 'below', 'between', 'at', 'exactly'] as const;
export type ConditionDirection = (typeof CONDITION_DIRECTIONS)[number];

// Incompatible metrics between two markets rule out any implication.
export const CONDITION_METRICS = ['price', 'count', 'percentage', 'rank', 'score', 'boolean'] as const;
export type ConditionMetric = (typeof CONDITION_METRICS)[number];

// NULL is NULL-tolerant, never equated to a specific scope. first_3/first_5/first_7 are
// independent partitions of the same game, not a ladder.
export const METRIC_SCOPES = [
  'game', 'team', 'first_3', 'first_5', 'first_7', 'half_1', 'half_2', 'quarter', 'period', 'set', 'map', 'series',
] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];

// A NULL scope may be identified with 'game' only, never with any value in this list.
export const SUB_FIXTURE_METRIC_SCOPES = [
  'team', 'first_3', 'first_5', 'first_7', 'half_1', 'half_2', 'quarter', 'period', 'set', 'map', 'series',
] as const satisfies ReadonlyArray<MetricScope>;
export type SubFixtureMetricScope = (typeof SUB_FIXTURE_METRIC_SCOPES)[number];

export const TEMPORAL_SEMANTICS = ['by_date', 'on_date', 'during_period', 'at_resolution'] as const;
export type TemporalSemantics = (typeof TEMPORAL_SEMANTICS)[number];

export const MONOTONIC_TEMPORAL_SEMANTICS = [
  'by_date', 'at_resolution', 'during_period',
] as const;
export type MonotonicTemporalSemantics = (typeof MONOTONIC_TEMPORAL_SEMANTICS)[number];

export const POINT_IN_TIME_TEMPORAL_SEMANTICS = [
  'on_date', 'at_resolution',
] as const;
export type PointInTimeTemporalSemantics = (typeof POINT_IN_TIME_TEMPORAL_SEMANTICS)[number];

export interface ConditionCard {
  question_id: number;
  canonical_subject: string;
  canonical_event: string | null;
  event_category: string | null;
  condition_shape: ConditionShape | null;
  condition_direction: ConditionDirection | null;
  condition_metric: ConditionMetric | null;
  // NULL = unknown; gates the cross-question total/winner equiv+ladder rules.
  metric_scope: MetricScope | null;
  temporal_semantics: TemporalSemantics | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  condition_date: string | null;
  // Drives Stage 3 date tolerance: minute=exact, hour=+-1h, day=normalizeDate(); NULL -> 'day'.
  condition_date_precision: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  // Non-null, non-compound values identify a single discrete categorical outcome.
  condition_value: string | null;
  participants: string[];
  hierarchy_type: HierarchyType | null;
  hierarchy_level: number | null;
  hierarchy_value: string | null;
  resolution_source: string | null;
  platform_group_id: string | null;
  league_id: number | null;
  competition_id: number | null;
  event_kind: EventKind | null;
  resolution_provider_id: number | null;
  resolution_kind: ResolutionKind | null;
  title: string | null;
  // Stage 3 skips candidate pairs where every market has resolved.
  open_member_count: number;
  // `["<side>|<kalshi_ticker>", ...]`; NULL unless both pair sides carry it.
  leg_signatures: string[] | null;
  // Distinguishes e.g. match_winner(team) from match_winner(draw).
  outcome_label: string | null;
}

// Edge-level pricing-haircut annotations only; the solver still hard-prunes the
// deterministic constraint regardless of tag, so basis_risk never changes which arbs surface.
export type BasisRisk =
  | 'none'
  | 'resolution_source'
  | 'date_difference'
  | 'platform_specific'
  | 'residual_tail'
  | 'cross_venue_settlement';

export interface MarketFeatures {
  market_id: number;
  platform: Platform;
  platform_id: string;
  normalized_title: string;
  title_words: string[];
  title_bigrams: string[];
  title_trigrams: string[];
  dates: ExtractedDate[];
  numbers: ExtractedNumber[];
  currencies: string[];
  hierarchy_type: HierarchyType | null;
  hierarchy_value: string | null;
  hierarchy_level: number | null;
  platform_group_id: string | null;
  platform_cross_ref: string | null;
  outcome_space: OutcomeSpace;
  // Regex-derived, parallel to LLM extraction; used as an LLM-skip gate in Stage 1b.
  condition_shape: ConditionShape | null;
  condition_direction: ConditionDirection | null;
  temporal_semantics: TemporalSemantics | null;
}

// 'finance' covers 'economic' and 'technology'; 'politics' covers 'election'/'politics'/'geopolitical'.
export const DOMAIN_CATEGORIES = [
  'sports', 'crypto', 'finance', 'politics', 'entertainment', 'weather', 'other',
] as const;
export type DomainCategory = (typeof DOMAIN_CATEGORIES)[number];

export const OUTCOME_SPACES = ['binary', 'categorical', 'numeric'] as const;
export type OutcomeSpace = (typeof OUTCOME_SPACES)[number];

export interface LLMMarketNormalization {
  market_id: number;
  canonical_subject: string;
  condition_value: string | null;
  condition_date: string | null;
  canonical_event: string;
  outcome_label: string | null;
  resolved_entities: ResolvedEntity[];
  resolution_source: string | null;
  confidence: number;
  // Nullable: old rows predate the condition taxonomy.
  condition_shape: ConditionShape | null;
  condition_direction: ConditionDirection | null;
  condition_metric: ConditionMetric | null;
  metric_scope: MetricScope | null;
  temporal_semantics: TemporalSemantics | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  // canonical_subject must be a member; drives Stage 2 shared_participants + Stage 3 rules.
  participants: string[];
  // Null only when the LLM call fails entirely.
  category_unified: UnifiedCategory | null;
  // True when semantic fields were inherited from a platform_events row, not extracted per-market.
  event_sourced?: boolean;
  resolution_provider_id?: number | null;
  resolution_kind?: ResolutionKind | null;
  league_id?: number | null;
  competition_id?: number | null;
  event_kind?: EventKind | null;
  // Transient LLM-extracted text, resolved into league_id/sport_canonical elsewhere; not written to DB.
  league_text?: string | null;
  sport_text?: string | null;
  // Which deterministic template or LLM call produced this row (distinct from resolution_source).
  match_source?: string | null;
  // NULL for non-Kalshi rows or any row whose normalizer couldn't assert a ticker identity.
  leg_signatures?: string[] | null;
  condition_date_precision?: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  // Audit-only; consumers should read condition_date_precision for tolerance, not this.
  condition_date_source?: string | null;
  // `{ <spec name>: <lowercase value> }`; a missing key means unknown, never ''.
  discriminators?: Record<string, string>;
}

export interface Question {
  id: number;
  canonical_key: string;
  canonical_subject: string;
  condition_shape: ConditionShape | null;
  condition_value: string | null;
  condition_date: string | null;
  condition_date_precision: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  event_category: string | null;
  member_count: number;
  platform_count: number;
  // Stage 3 skips candidate pairs where this is 0 on both sides.
  open_member_count: number;
  // Set when every member resolves; loaders filter archived_at IS NULL.
  archived_at: string | null;
  best_yes_price: number | null;
  best_no_price: number | null;
  best_yes_market_id: number | null;
  best_no_market_id: number | null;
  participants: string[];
  // Per-key consensus: present only if every member carrying it agrees on the value.
  discriminators?: Record<string, string>;
}

export interface QuestionMember {
  question_id: number;
  market_id: number;
  platform: Platform;
  yes_price: number | null;
  no_price: number | null;
}

// Same CHECK as markets.grouping_type / platform_events.grouping_type (docker/init.sql),
// pinned by db-check-parity.test.ts.
export const GROUPING_TYPES = [
  'threshold_series',
  'categorical_exclusive',
  'bundle_nonexclusive',
  'unknown',
] as const;
export type GroupingType = (typeof GROUPING_TYPES)[number];

// Same CHECK on llm_market_normalizations.outcome_role and questions.outcome_role
// (docker/init.sql, pinned by db-check-parity.test.ts); never rename these values.
export const OUTCOME_ROLES = [
  'contender',
  'draw',
  'tie',
  'residual',
  'placeholder',
  'over',
  'under',
  'negation',
  'void',
  'exact_score',
] as const;
export type OutcomeRole = (typeof OUTCOME_ROLES)[number];

export const OUTCOME_SET_TYPES = ['tournament', 'categorical', 'threshold_series'] as const;
export type OutcomeSetType = (typeof OUTCOME_SET_TYPES)[number];

export interface OutcomeSet {
  id: number;
  event_identity: string;
  set_type: OutcomeSetType;
  set_name: string;
  slot_count: number;
  confidence: number;
  source: 'platform_native' | 'llm_normalized' | 'embedding';
}

export interface OutcomeSetSlot {
  set_id: number;
  slot_ordinal: number;
  question_id: number;
}

export const EDGE_TYPES = [
  'strict_implication', 'equivalence', 'conditional',
  'probabilistic', 'mutual_exclusion', 'near_equivalence',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

// Must stay in lock-step with the live chk_edges_pattern CHECK (diffed by
// soundness-regression-asserts); edgeContractSql() makes a typo'd label a compile error.
export const EDGE_PATTERNS = [
  'date_threshold', 'numeric_threshold', 'tournament_advancement', 'cross_set_tournament',
  'sequential_stage', 'cross_platform', 'llm_detected',
  'participant_superset', 'parlay_leg_dominance', 'parlay_subset',
  'numeric_ladder_xq', 'exact_score_derived', 'cross_question_equiv',
  'cross_question_mutex', 'date_implication',
  'exact_score_winner', 'exact_score_draw', 'exact_score_total_over',
  'exact_score_total_under', 'exact_score_btts', 'cross_question_mutex_spread',
  'elimination_reach',
  'cross_ref_equiv',
  'margin_winner',
  'shape_bridge',
  'window_containment',
  'spread_winner',
  'elimination_stage_mutex', 'group_champion_superset', 'host_stage_mutex',
  'btts_total_over', 'team_game_total_over', 'spread_total_over',
  'fixture_total_ladder', 'slice_game_total_over', 'kalshi_strike_ladder',
  'media_release_ladder', 'first_anytime_scorer',
  'election_precondition',
  'numeric_threshold_raw',
  'cross_question_mutex_halftime',
  'primary_rank_ladder',
  'rate_decision_bridge',
] as const;
export type EdgePattern = (typeof EDGE_PATTERNS)[number];

export const EDGE_SOURCES = ['algorithmic', 'llm', 'platform_structure'] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

export interface ImplicationEdge {
  id: number;
  antecedent_question_id: number;
  consequent_question_id: number;
  edge_type: EdgeType;
  pattern: EdgePattern | null;
  confidence: number;
  deterministic: boolean;
  source: EdgeSource;
  reasoning: string | null;
  basis_risk: BasisRisk | null;
  risk_detail: string | null;
}

// Must stay in lock-step with the DB chk_arb_type CHECK. lp_solver = certified arb;
// lp_solver_graded = graded residual-tail near-arb, never guaranteed_payout=1.
export const ARB_TYPES = [
  'implication_single',
  'implication_multi_leg',
  'equivalence_cross_platform',
  'transitivity_violation',
  'complementary',
  'lp_solver',
  'lp_solver_graded',
] as const;
export type ArbType = (typeof ARB_TYPES)[number];

export interface ArbLeg {
  market_id: number;
  platform: Platform;
  side: 'YES' | 'NO';
  price: number;
  label: string;
}

// Distinct from the edge-level BasisRisk defined above.
export type BasisRiskSeverity = 'none' | 'low' | 'high';
