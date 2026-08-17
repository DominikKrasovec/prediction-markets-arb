/**
 * Deterministic Stage 1b normalization for all platforms: dispatches Kalshi
 * rows to `tryNormalizeKalshiRow()` and everything else through the
 * title-regex template engine — a bank of letter-labelled title patterns, each
 * emitting one condition shape — falling back between the two.
 */
import { tryNormalizeKalshiRow, resolveKalshiCompetitionToLeagueId } from './kalshi-deterministic.js';
import { metricScopeFromKalshiSeries, parseMetricScopeFromTitle } from './metric-scope.js';
import { inferEntityScope } from './infer-entity-scope.js';
import { extractEventDate } from './event-date-extractor.js';
import {
  normalizeEventNoun,
  normalizeFixtureCanonicalEvent,
  normalizeOutcomeLabel,
  normalizePlayerStatUnit,
  yearFromIso,
  deriveCanonicalEventCore,
  fixtureSubjectOverride,
  EVENT_ANCHORED_KINDS,
} from './event-name-normalizer.js';
export { deriveCanonicalEventCore } from './event-name-normalizer.js';
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { bulkUpsertNormalizations } from '../db/queries/normalizations.js';
import { bulkUpdateMarketCategoryUnified } from '../db/queries/markets.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { stampDiscriminators } from '../discriminators/stamp.js';
import { beltHit } from '../discriminators/telemetry.js';
import { extractStatType } from '../discriminators/stat-vocab.js';
import { warnShapePair as warnShapePairBase } from './shape-temporal-validation.js';
// Every emission is checked against emit-condition's invariants before use.
import { validateConditionTuple, emitCondition, tupleToTemplateFields } from './emit-condition.js';
import { monthEndIso, inferYear, stampConditionDate } from '../util/condition-date.js';
import { extractPolymarketWeatherStation, stationAliasesFor, stripWeatherDateSuffix } from './weather-stations.js';
import {
  registerEntities,
  resolveSubjectAndParticipants,
  leagueResolver,
  warmKBCache,
  kbFactsHandle,
  scopeToEntityMetadata,
  loadStructuralSignalsIndex,
} from '../db/entity-registry.js';
import { looksLikePredicate, isNonEntityLabel, kbHasRealEntity, kbHasRealEntitySync } from '../db/entity/resolvers.js';
// Case/diacritic/whitespace-invariant name key, same normalization as the KB alias chain.
import { spaceInvariantVariant } from '../db/entity/tokens.js';
import { inferParticipantType } from '../db/entity/infer-participant-type.js';
import { canonicalUnit, isSportRemappableSpreadUnit, isSportRemappableTotalUnit } from './unit-vocab.js';

const log = createLogger('text-deterministic');
import type {
  LLMMarketNormalization,
  ConditionShape,
  ConditionDirection,
  ConditionMetric,
  TemporalSemantics,
  EventKind,
  MetricScope,
  ResolvedEntity,
  EntityType,
  UnifiedCategory,
} from '@arb/types';
import { isKalshiTrailingNine, MONOTONIC_TEMPORAL_SEMANTICS, POINT_IN_TIME_TEMPORAL_SEMANTICS } from '@arb/types';
import { unifiedToDomain, isFinancialCategory, isPoliticalCategory } from '../db/category-taxonomy.js';

import { gatedEventAlias } from '../util/event-alias.js';
export { gatedEventAlias };
import { formatConditionValue } from '../util/condition-value.js';
import { canonicalizeIntegerThreshold, canonicalizePlusNotation } from '../util/threshold-canonical.js';
import { nativeDraw } from '../util/native-exclusivity.js';
import { INTEGER_GRAIN_UNITS } from '../util/condition-shape.js';
import { deriveTennisTour, tennisTourLeague, qualifyTourCanonicalEvent } from './tennis-tour.js';

// Kalshi-specific fields are populated only when platform='kalshi'; NULL otherwise.
interface CandidateRow {
  market_id: number;
  platform: string;
  platform_id: string;
  title: string;
  end_date: string | null;
  category_unified: UnifiedCategory | null;
  hierarchy_type: string | null;
  hierarchy_value: string | null;
  hierarchy_level: number | null;
  feat_condition_shape: string | null;
  feat_condition_direction: string | null;
  feat_temporal: string | null;
  numbers: string | null;
  platform_event_id: string | null;
  event_match_context: string | null;
  raw: Record<string, unknown> | null;
  strike_type: string | null;
  floor_strike: string | null;
  cap_strike: string | null;
  custom_strike: string | null;
  event_ticker: string | null;
  event_title: string | null;
  strike_date: string | null;
  rules_primary: string | null;
  yes_sub_title: string | null;
  subtitle: string | null;
  occurrence_datetime: string | null;
  open_time?: string | null;
  expected_expiration_time: string | null;
  /** Kalshi MVE (parlay) structured leg list for `KXMVESPORTS*`/`KXMVECROSS*` markets, NULL otherwise. */
  mve_selected_legs: { side: string; market_ticker: string; event_ticker?: string }[] | null;
  /** Kalshi MVE collection ticker — sibling-parlay grouping key, NULL otherwise. */
  mve_collection_ticker: string | null;
  kalshi_competition: string | null;
  description: string | null;
  slug: string | null;
  non_kalshi_event_title: string | null;
  outcomes_raw: string[] | null;
  /** Sport scope for KB T1 disambiguation, populated by per-template regex or left null when the title carries no sport keyword. */
  sport_canonical: string | null;
  tags: string[] | null;
  market_category: string | null;
  parent_event_tags: string[] | null;
  limitless_market_type: string | null;
  limitless_home_team: string | null;
  limitless_away_team: string | null;
  /** `metadata.sportType` — e.g. 'football'; NULL for esports (use esportTitle). */
  limitless_sport_type: string | null;
  limitless_esport_title: string | null;
  limitless_league_name: string | null;
  /** `metadata.startMatchTimestampInUTC` — epoch SECONDS (string) of match start. */
  limitless_start_ts: string | null;
  limitless_event_id: string | null;
  limitless_grouping_type: string | null;
  /** `metadata.type` — 'negrisk' | 'ladder' | null (secondary soundness gate). */
  limitless_meta_type: string | null;
  native_question: string | null;
  is_neg_risk: boolean | null;
  pm_group_item_title: string | null;
}

export const CANDIDATE_ROW_SELECT_AND_JOINS = `
  SELECT m.id                                                    AS market_id,
         m.platform_id,
         m.platform,
         m.title,
         m.description,
         to_char(m.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date,
         m.category_unified,
         mf.hierarchy_type,
         mf.hierarchy_value,
         mf.hierarchy_level,
         mf.condition_shape                                      AS feat_condition_shape,
         mf.condition_direction                                  AS feat_condition_direction,
         mf.temporal_semantics                                   AS feat_temporal,
         mf.numbers::text                                        AS numbers,
         m.platform_event_id,
         -- longest H2H sibling title (" vs " / " vs. ") in the same event
         (SELECT sib.title
            FROM markets sib
           WHERE sib.platform_event_id = m.platform_event_id
             AND sib.platform = m.platform
             AND sib.id != m.id
             AND sib.title ~* ' vs\.? '
           ORDER BY length(sib.title) DESC
           LIMIT 1
         )                                                       AS event_match_context,
         mr.raw                                                  AS raw,
         mr.raw->>'strike_type'                                  AS strike_type,
         mr.raw->>'floor_strike'                                 AS floor_strike,
         mr.raw->>'cap_strike'                                   AS cap_strike,
         mr.raw->>'custom_strike'                                AS custom_strike,
         mr.raw->>'event_ticker'                                 AS event_ticker,
         ke.raw->>'title'                                        AS event_title,
         mr.raw->>'strike_date'                                  AS strike_date,
         mr.raw->>'rules_primary'                                AS rules_primary,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'yes_sub_title'         END AS yes_sub_title,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'subtitle'              END AS subtitle,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'occurrence_datetime'   END AS occurrence_datetime,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'open_time'             END AS open_time,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'expected_expiration_time' END AS expected_expiration_time,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->'mve_selected_legs'      END AS mve_selected_legs,
         CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'mve_collection_ticker' END AS mve_collection_ticker,
         CASE WHEN m.platform = 'kalshi'
              THEN ke.raw->'product_metadata'->>'competition'
         END                                                     AS kalshi_competition,
         m.slug                                                  AS slug,
         CASE WHEN m.platform <> 'kalshi' THEN pe.title END      AS non_kalshi_event_title,
         CASE
           WHEN jsonb_typeof(mr.raw->'outcomes') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(mr.raw->'outcomes'))
           WHEN jsonb_typeof(m.outcomes) = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(m.outcomes))
           ELSE NULL
         END                                                     AS outcomes_raw,
         CAST(NULL AS TEXT)                                      AS sport_canonical,
         m.tags                                                  AS tags,
         m.category                                              AS market_category,
         CASE WHEN m.platform = 'polymarket' THEN (
           SELECT ARRAY(
             SELECT (t->>'label')
               FROM polymarket_events pe2
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pe2.raw->'tags', '[]'::jsonb)) t
              WHERE pe2.id = m.platform_event_id
                AND t->>'label' IS NOT NULL
           )
         ) WHEN m.platform = 'predict' THEN (
           SELECT ARRAY(
             SELECT (t->>'name')
               FROM predict_categories pc
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
              WHERE pc.slug = m.category
                AND t->>'name' IS NOT NULL
           )
         ) ELSE NULL END                                         AS parent_event_tags,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'marketType'    END AS limitless_market_type,
         CASE WHEN m.platform = 'limitless' THEN btrim(mr.raw->'metadata'->>'homeTeam') END AS limitless_home_team,
         CASE WHEN m.platform = 'limitless' THEN btrim(mr.raw->'metadata'->>'awayTeam') END AS limitless_away_team,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'sportType'     END AS limitless_sport_type,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'esportTitle'   END AS limitless_esport_title,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'leagueName'    END AS limitless_league_name,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'startMatchTimestampInUTC' END AS limitless_start_ts,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->>'_limitlessEventId'         END AS limitless_event_id,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->>'_limitlessGroupingType'    END AS limitless_grouping_type,
         CASE WHEN m.platform = 'limitless' THEN mr.raw->'metadata'->>'type'          END AS limitless_meta_type,
         CASE WHEN m.platform = 'predict' THEN mr.raw->>'question'                    END AS native_question,
         CASE WHEN m.platform = 'predict' THEN (mr.raw->>'isNegRisk')::bool           END AS is_neg_risk,
         CASE WHEN m.platform = 'polymarket' THEN mr.raw->>'groupItemTitle'           END AS pm_group_item_title
  FROM markets m
  JOIN market_features mf ON mf.market_id = m.id
  LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
  LEFT JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker'
                             AND m.platform = 'kalshi'
  LEFT JOIN platform_events pe ON pe.platform = m.platform
                               AND pe.platform_event_id = m.platform_event_id
`;

export interface TemplateMatch {
  /** Subject phrase before KB resolution (e.g. "Bitcoin", "Lakers"). */
  subject_raw: string;
  /** Other participants (e.g. opposing team in H2H). All must T1-resolve. */
  participants_raw: string[];
  condition_shape: ConditionShape;
  condition_direction: ConditionDirection | null;
  condition_metric: ConditionMetric | null;
  temporal_semantics: TemporalSemantics | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  event_kind: EventKind;
  outcome_label: string | null;
  entity_type: 'asset' | 'team' | 'person' | 'location';
  participant_type_confidence?: 'high' | 'low';
  /** match_source telemetry tag — never the settlement authority; see resolution_source. */
  source_tag: string;
  /** Semantic settlement-authority string for canonical_key merging; undefined emits NULL, not source_tag. */
  resolution_source?: string | null;
  sport_canonical?: string | null;
  league_canonical?: string | null;
  canonical_event_override?: string | null;
  canonical_event_tour?: 'men' | 'women' | null;
  canonical_event_suffix?: string | null;
  condition_date_override?: string | null;
  condition_date_precision_override?: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  condition_date_source_override?: string | null;
  condition_date_force_null?: boolean;
  value_unit_inferred?: boolean;
  metric_scope?: MetricScope | null;
  subject_native_verified?: boolean;
}

interface DeterministicNormalizationHit {
  norm: LLMMarketNormalization;
  tag: string;
}

function warnShapePair(
  shape: ConditionShape | null,
  temporal: TemporalSemantics | null,
  tag: string,
): void {
  warnShapePairBase(shape, temporal, 'text-det', tag);
}



const PRICE_THRESHOLD_RX =
  /^(?:will\s+)?(?<asset>[A-Z][A-Za-z0-9 .]+?|[A-Z]{2,6})(?<!\sbe)\s+(?:price\s+)?(?<verb>above|below|exceeds?|reach(?:es)?|hits?|crosses?|breaks?|tops?|falls? below|drops? below|reaches?)\s+\$(?<value>[\d,]+(?:\.\d+)?)\s*(?<unit>[KMB])?\??$/i;
const PRICE_ON_DATE_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 .]+?|[A-Z]{2,6})\s+(?<verb>above|below)\s+(?<value>[\d,]+(?:\.\d+)?)\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{1,2}(?::\d{2})?[AP]M(?:-\d+(?::\d+)?[AP]M)?(?:\s+[A-Z]{2,3})?\??$/i;
const INDEX_VERBOSE_THRESHOLD_RX =
  /^Will the (?<asset>S&P\s+\d+|Nasdaq-\d+|Dow\s+Jones[A-Za-z ]*?) be (?<verb>above|below) (?<value>[\d,]+(?:\.\d+)?) (?:at the end of|on) [A-Za-z]+ \d{1,2}, \d{4} at \d{1,2}[ap]m [A-Z]{2,4}\?$/i;
const PRICE_OF_X_DATE_RX =
  /^will\s+the\s+price\s+of\s+(?<asset>[A-Z][A-Za-z0-9 ]+?)\s+(?:be\s+)?(?<verb>above|below|greater\s+than|less\s+than|reach|dip\s+to)\s+\$?(?<value>[\d,]+(?:\.\d+)?)(?:\s+on\s+.+)?\??$/i;
const PRICE_OF_X_RANGE_RX =
  /^will\s+the\s+price\s+of\s+(?<asset>[A-Z][A-Za-z0-9 ]+?)\s+be\s+between\s+\$?(?<lo>[\d,]+(?:\.\d+)?)\s+and\s+\$?(?<hi>[\d,]+(?:\.\d+)?)(?:\s+on\s+.+)?\??$/i;
const STOCK_HIT_HIGHLOW_RX =
  /^(?:will\s+)?(?<asset>[A-Z][A-Za-z0-9 ()&.,]+?)\s+hit\s+\((?<dir>HIGH|LOW)\)\s+\$(?<value>[\d,]+(?:\.\d+)?)(?:\s+.+)?\??$/i;
const STOCK_HIT_HIGHLOW_POST_RX =
  /^(?:will\s+)?(?:the\s+)?(?<asset>[A-Z][A-Za-z0-9 ()&.,\/'\-]*?)\s+hit\s+\$?(?<value>[\d,]+(?:\.\d+)?)(?<pct>%)?\s*\((?<dir>HIGH|LOW)\)(?:\s+.+)?\??$/i;
const FX_PAIR_RX = /^(?<base>[A-Z]{3})\/(?<quote>[A-Z]{3})$/;
const STOCK_CLOSE_DATE_RX =
  /^(?:will\s+)?(?<asset>[A-Z][A-Za-z0-9 ()&.]+?)\s+close[sd]?\s+(?<verb>above|below)\s+\$(?<value>[\d,]+(?:\.\d+)?)\s+on\s+[A-Za-z]+\s+\d{1,2}\??$/i;
const STOCK_FINISH_WEEK_RX =
  /^(?:will\s+)?(?<asset>[A-Z][A-Za-z0-9 ()&.]+?)\s+finish\s+week\s+of\s+.+?\s+(?<verb>above|below)\s+\$(?<value>[\d,]+(?:\.\d+)?)\??$/i;
const CRYPTO_DIP_REACH_DATE_RX =
  /^will\s+(?<asset>[A-Z][A-Za-z0-9 ]+?)\s+(?<verb>dip\s+to|reach)\s+\$(?<value>[\d,]+(?:\.\d+)?)\s+on\s+[A-Za-z]+\s+\d{1,2}\??$/i;

function tryTemplateAssetPriceThreshold(row: CandidateRow): TemplateMatch | null {
  // Must be crypto/economic-flavored AND have a numeric threshold signal.
  if (!isFinancialCategory(row.category_unified)) return null;
  if (row.feat_condition_shape !== null &&
      row.feat_condition_shape !== 'monotonic_threshold' &&
      row.feat_condition_shape !== 'point_in_time' &&
      row.feat_condition_shape !== 'range_snapshot') return null;

  const rangeM = row.title.match(PRICE_OF_X_RANGE_RX);
  if (rangeM?.groups) {
    const tuple = emitCondition({
      archetype: 'terminal_range',
      tag: 'text-deterministic-A',
      eventKind: 'price_threshold',
      metric: 'price',
      temporal: 'on_date',
      value: {
        primary: parseFloat(rangeM.groups.lo.replace(/,/g, '')),
        secondary: parseFloat(rangeM.groups.hi.replace(/,/g, '')),
        unit: 'USD',
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: extractAssetName(rangeM.groups.asset.trim()),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'text-deterministic-A',
      resolution_source: cryptoResolutionSource(row.category_unified),
    };
  }

  type APattern =
    | 'PRICE_THRESHOLD'
    | 'PRICE_ON_DATE'
    | 'INDEX_VERBOSE'
    | 'STOCK_CLOSE_DATE'
    | 'STOCK_FINISH_WEEK'
    | 'CRYPTO_DIP_REACH'
    | 'PRICE_OF_X_DATE'
    | 'STOCK_HIT_HIGHLOW'
    | 'STOCK_HIT_POSTHL';
  const A_ORDER: ReadonlyArray<[APattern, RegExp]> = [
    ['PRICE_THRESHOLD',  PRICE_THRESHOLD_RX],
    ['PRICE_ON_DATE',    PRICE_ON_DATE_RX],
    ['INDEX_VERBOSE',    INDEX_VERBOSE_THRESHOLD_RX],
    ['STOCK_CLOSE_DATE', STOCK_CLOSE_DATE_RX],
    ['STOCK_FINISH_WEEK',STOCK_FINISH_WEEK_RX],
    ['CRYPTO_DIP_REACH', CRYPTO_DIP_REACH_DATE_RX],
    ['PRICE_OF_X_DATE',  PRICE_OF_X_DATE_RX],
    ['STOCK_HIT_HIGHLOW',STOCK_HIT_HIGHLOW_RX],
    ['STOCK_HIT_POSTHL', STOCK_HIT_HIGHLOW_POST_RX],
  ];
  let pattern: APattern | null = null;
  let m: RegExpMatchArray | null = null;
  for (const [tag, rx] of A_ORDER) {
    const hit = row.title.match(rx);
    if (hit?.groups) { pattern = tag; m = hit; break; }
  }
  if (!m?.groups || !pattern) return null;

  if (pattern === 'STOCK_HIT_POSTHL' && m.groups) {
    const dirPost: ConditionDirection =
      m.groups.dir.toUpperCase() === 'LOW' ? 'below' : 'above';
    const rawAsset = m.groups.asset.trim();
    const isPct = !!m.groups.pct;
    const fx = rawAsset.toUpperCase().match(FX_PAIR_RX);
    const subject = fx
      ? rawAsset.toUpperCase()
      : extractAssetName(rawAsset);
    const valuePost = parseFloat(m.groups.value.replace(/,/g, ''));
    if (!Number.isFinite(valuePost) || subject.length < 2) return null;
    const featT = row.feat_temporal as TemporalSemantics | null;
    const MONO_OK: ReadonlySet<TemporalSemantics> = new Set(MONOTONIC_TEMPORAL_SEMANTICS);
    const tuple = emitCondition(isPct ? {
      archetype: 'terminal_threshold',
      tag: 'text-deterministic-A',
      eventKind: 'price_threshold',
      metric: 'percentage',
      direction: dirPost,
      temporal: 'on_date',
      value: { primary: valuePost, unit: 'percent' },
    } : {
      archetype: 'path_touch',
      tag: 'text-deterministic-A',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: dirPost,
      temporal: featT && MONO_OK.has(featT) ? featT : 'by_date',
      value: { primary: valuePost, unit: fx?.groups ? fx.groups.quote : 'USD' },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subject,
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      ...(fx?.groups && !isPct ? { value_unit: fx.groups.quote } : {}),
      entity_type: 'asset',
      source_tag: 'text-deterministic-A',
      resolution_source: cryptoResolutionSource(row.category_unified),
    };
  }

  const verb = m.groups.verb?.toLowerCase().replace(/\s+/g, ' ') ?? '';
  const dirGroup = (m.groups.dir ?? '').toUpperCase();
  const direction: ConditionDirection =
    dirGroup === 'LOW' ? 'below' :
    dirGroup === 'HIGH' ? 'above' :
    /below|fall|drop|dip|less|low/.test(verb) ? 'below' : 'above';

  const MONO_VERBS = /^(reach(?:es)?|hit(?:s)?|exceed(?:s)?|cross(?:es)?|break(?:s)?|top(?:s)?|dip to)$/;
  const isMonotonic =
    pattern === 'STOCK_HIT_HIGHLOW' ||
    pattern === 'CRYPTO_DIP_REACH'  ||
    MONO_VERBS.test(verb);

  let value = parseFloat(m.groups.value.replace(/,/g, ''));
  if (pattern === 'INDEX_VERBOSE' && isKalshiTrailingNine(value)) {
    value = Math.round(value);
  }
  if (m.groups.unit) {
    const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
    value *= mult[m.groups.unit.toUpperCase()] ?? 1;
  }

  const featT = row.feat_temporal as TemporalSemantics | null;
  const MONO_OK: ReadonlySet<TemporalSemantics> = new Set(MONOTONIC_TEMPORAL_SEMANTICS);
  const PIT_OK:  ReadonlySet<TemporalSemantics> = new Set(POINT_IN_TIME_TEMPORAL_SEMANTICS);
  const temporal: TemporalSemantics = isMonotonic
    ? (featT && MONO_OK.has(featT) ? featT : 'by_date')
    : (featT && PIT_OK.has(featT)  ? featT : 'on_date');

  const tuple = emitCondition({
    archetype: isMonotonic ? 'path_touch' : 'terminal_threshold',
    tag: 'text-deterministic-A',
    eventKind: 'price_threshold',
    metric: 'price',
    direction,
    temporal,
    value: { primary: value, unit: 'USD' },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: extractAssetName(m.groups.asset.trim()),
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    source_tag: 'text-deterministic-A',
    resolution_source: cryptoResolutionSource(row.category_unified),
  };
}

function cryptoResolutionSource(category: UnifiedCategory | null): string | null {
  return category === 'crypto' ? 'CF Benchmarks' : null;
}

const H2H_VS_RX = /^(?:will\s+(?:the\s+)?)?(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+(?:vs\.?|v\.?|against)\s+(?:the\s+)?(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\??$/iu;

const B_SUFFIX_GUARDS: ReadonlyArray<RegExp> = [
  /\bend\s+in\s+a\s+draw\??\s*$/i,
  /:\s*both\s+teams?\s+to\s+score\??\s*$/i,
  /:\s*(?:match|total\s+sets?|set\s+\d+\s+games?|1h|2h)?\s*o\/u\s+\d/i,
  /:\s*draw\s+at\s+halftime\??\s*$/i,
  /\bwinner\??\s*$/i,
  /\btotal\s+runs?\??\s*$/i,
  /\bfirst\s+inning\s+runs?\??\s*$/i,
  /\bfirst\s+\d+\s+innings?(?:\s+(?:winner|tie))?\??\s*$/i,
  /\bmoneyline\??\s*$/i,
  /\b(?:\d{4}\s+)?\d+(?:st|nd|rd|th)?\s+round\s+series(?:\s+winner)?\??\s*$/i,
  /\b(?:league\s+of\s+legends|valorant|counter[- ]strike(?:\s+2)?|cs\s*2|cs:?\s*go|dota\s+2|overwatch(?:\s+2)?|rocket\s+league|starcraft(?:\s+2|\s+ii)?|call\s+of\s+duty|rainbow\s+six)\s+match\??\s*$/i,
  /\b(?:e?sports?|gaming)\s+match\??\s*$/i,
  /\bbe\s+the\s+matchup\b/i,
  /\bprofessional\s+\w+\s+game\??\s*$/i,
  /^what\s+will\s+the\s+announcers?\s+say\b/i,
];
const H2H_BEAT_RX = /^(?:will\s+(?:the\s+)?)?(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+(?:beat|defeat|win against)\s+(?:the\s+)?(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\??$/iu;
const H2H_OR_RX = /^(?:the\s+)?(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+or\s+(?:the\s+)?(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+to\s+win\??$/iu;
const H2H_SET_WINNER_RX = /^Set\s+(?<setn>\d+)\s+Winner:\s+(?<a>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}][\p{L}\p{M}\s.'\-]+?)\??$/iu;
const H2H_VS_WINNER_RX = /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+winner\??$/iu;
const H2H_GAME_N_WINNER_RX =
  /^Game\s+(?<n>\d+):\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+(?:at|@|vs\.?)\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+winner\??$/iu;
const WINNER_SUFFIX_CONTAMINATION_RX =
  /\b(?:total\s+runs?|first\s+inning\s+runs?|first\s+\d+\s+innings?|\d+(?:st|nd|rd|th)?\s+round\s+series|moneyline|professional\s+\w+\s+game|spread|both\s+teams?|over|under|cover|halftime)\b/i;
const H2H_PREFIXED_RX = /^[^:]+:\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)(?:\s*\(BO\d+\))?(?:\s+-\s+[^\n]*)?\??$/iu;
const H2H_MONEYLINE_RX = /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?):\s*(?:1H\s+|2H\s+)?Moneyline\??$/iu;

const CRICKET_PROP_RX =
  /\b(most\s+sixes|most\s+fours|most\s+runs|most\s+wickets|most\s+boundaries|(?:team\s+)?top\s+batter|(?:team\s+)?top\s+bowler|top\s+run\s+scorer|top\s+wicket(?:\s*-?\s*taker)?|highest\s+(?:opening\s+)?partnership|fall\s+of\s+(?:the\s+)?(?:first\s+)?wicket|method\s+of\s+dismissal|toss\s+match|toss\s+double|(?:who\s+)?wins?\s+the\s+toss|win\s+the\s+toss|match\s+drawn|completed\s+match|player\s+of\s+the\s+match|man\s+of\s+the\s+match)\b/i;

export function cricketSidePropKind(title: string): string | null {
  if (!title) return null;
  const dash = title.split(/\s+-\s+/);
  const tail = dash.length > 1 ? dash[dash.length - 1]! : title;
  const m = CRICKET_PROP_RX.exec(tail);
  if (!m) return null;
  return m[1]!.toLowerCase().replace(/^team\s+/, '').replace(/\s+/g, '_');
}

export function parseCricketSideProp(
  title: string,
): { propKind: string; side: string | 'draw' | null | 'unrecognized' } | null {
  if (!title) return null;
  const dash = title.split(/\s+-\s+/);
  const tail = (dash.length > 1 ? dash[dash.length - 1]! : title).trim();
  const m = CRICKET_PROP_RX.exec(tail);
  if (!m) return null;
  const propKind = m[1]!.toLowerCase().replace(/^team\s+/, '').replace(/\s+/g, '_');
  const pre = tail.slice(0, m.index).trim();
  if (pre.length > 0) return { propKind, side: 'unrecognized' };
  let rest = tail.slice(m.index + m[0]!.length).trim().replace(/\?+\s*$/, '').trim();
  rest = rest.replace(/^double\s+/i, '').replace(/^double$/i, '');
  if (rest === '') return { propKind, side: null };
  if (/^draw$/i.test(rest)) return { propKind, side: 'draw' };
  const sideM = rest.match(/^(?<side>.+?)\s+winner$/i);
  if (sideM?.groups) return { propKind, side: sideM.groups.side.trim() };
  return { propKind, side: 'unrecognized' };
}

const INNINGS_TIE_SUFFIX_RX =
  /^(?<fixture>.+?)\s+first\s+\d+\s+innings?\s+tie\??\s*$/iu;

const INNINGS_SCOPE_SUFFIX: Readonly<Partial<Record<MetricScope, string>>> = {
  first_3: 'first 3 innings',
  first_5: 'first 5 innings',
  first_7: 'first 7 innings',
};

function tryInningsTieLeg(row: CandidateRow): TemplateMatch | null {
  const m = row.title.match(INNINGS_TIE_SUFFIX_RX);
  if (!m?.groups) return null;
  const tickerScope = metricScopeFromKalshiSeries(row.event_ticker);
  const titleScope = parseMetricScopeFromTitle(row.title);
  if (tickerScope !== null && titleScope !== null && tickerScope !== titleScope) {
    log.warn(
      `Template B innings-tie bail: market ${row.market_id} ticker scope '${tickerScope}' ` +
      `disagrees with title scope '${titleScope}' in '${row.title}' — leaving unshaped`,
    );
    return null;
  }
  const scope = tickerScope ?? titleScope;
  const suffix = scope ? INNINGS_SCOPE_SUFFIX[scope] : undefined;
  if (!scope || !suffix) return null;
  const fx = m.groups.fixture.match(H2H_VS_RX);
  if (!fx?.groups) return null;
  const a = fx.groups.a.trim();
  const b = fx.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;
  const side = kalshiYstSide(row, a, b);
  if (side.kind === 'team' || side.kind === 'bail') {
    log.warn(
      `Template B innings-tie bail: market ${row.market_id} yes_sub_title is not a tie ` +
      `on '${row.title}' — leaving unshaped`,
    );
    return null;
  }
  const dl = drawLegMatch(a, b);
  if (!dl) return null;
  return { ...dl, canonical_event_suffix: suffix, metric_scope: scope };
}

type KalshiYstSide =
  | { kind: 'none' }
  | { kind: 'draw' }
  | { kind: 'team'; subject: string; opponent: string }
  | { kind: 'bail' };

function kalshiYstSide(row: CandidateRow, a: string, b: string): KalshiYstSide {
  if (row.platform !== 'kalshi') return { kind: 'none' };
  const yst = row.yes_sub_title?.trim();
  if (!yst) return { kind: 'none' };
  const fy = spaceInvariantVariant(yst);
  if (!fy) return { kind: 'none' };
  if (fy === 'tie' || fy === 'draw') return { kind: 'draw' };
  if (fy === spaceInvariantVariant(a)) return { kind: 'team', subject: a, opponent: b };
  if (fy === spaceInvariantVariant(b)) return { kind: 'team', subject: b, opponent: a };
  log.warn(
    `Template B yst-lift bail: market ${row.market_id} yes_sub_title '${yst}' matches neither parsed participant ('${a}' / '${b}') nor tie — leaving unshaped`,
  );
  return { kind: 'bail' };
}

const BINARY_OUTCOME_FOLDS = new Set(['yes', 'no', 'true', 'false']);

function nonKalshiOutcomesSide(row: CandidateRow, a: string, b: string): KalshiYstSide {
  const outs = row.outcomes_raw;
  if (!outs || outs.length !== 2) return { kind: 'none' };
  const f0 = spaceInvariantVariant(outs[0] ?? '');
  const f1 = spaceInvariantVariant(outs[1] ?? '');
  if (!f0 || !f1) return { kind: 'none' };
  if (BINARY_OUTCOME_FOLDS.has(f0) || BINARY_OUTCOME_FOLDS.has(f1)) return { kind: 'none' };
  if (f0 === 'tie' || f0 === 'draw') return { kind: 'draw' };

  const fa = spaceInvariantVariant(a);
  const fb = spaceInvariantVariant(b);
  const agrees = (x: string, y: string | null): boolean => {
    if (!y) return false;
    if (x === y) return true;
    return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
  };
  if (agrees(f0, fa)) return { kind: 'team', subject: a, opponent: b };
  if (agrees(f0, fb)) return { kind: 'team', subject: b, opponent: a };
  log.warn(
    `Template B native-outcome bail: market ${row.market_id} outcomes[0] '${outs[0]}' matches neither parsed participant ('${a}' / '${b}') nor tie — leaving unshaped`,
  );
  return { kind: 'bail' };
}

function h2hNativeSide(row: CandidateRow, a: string, b: string): KalshiYstSide {
  if (row.platform === 'kalshi') return kalshiYstSide(row, a, b);
  return nonKalshiOutcomesSide(row, a, b);
}

function h2hSubjectVerified(side: KalshiYstSide, opponentRaw: string): boolean {
  if (side.kind === 'team') return true;
  return !isAnonSubject(opponentRaw);
}

function drawLegMatch(
  a: string,
  b: string,
  canonicalEventOverride: string | null = null,
): TemplateMatch | null {
  const draw = nativeDraw();
  const tuple = emitCondition({
    archetype: 'fixture_outcome',
    topology: 'standalone_binary',
    tag: 'text-deterministic-B',
    eventKind: 'match_winner',
    metric: null,
    temporal: null,
    outcomeLabel: draw.outcome_label,
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: draw.subject_raw,
    participants_raw: [a, b],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-B',
    canonical_event_override: canonicalEventOverride,
  };
}

function tryTemplateH2hMatchup(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  if (row.platform === 'limitless') return null;

  {
    const prop = parseCricketSideProp(row.title);
    if (prop) {
      if (prop.side === 'unrecognized') {
        log.warn(
          `Template B cricket-prop bail: market ${row.market_id} unrecognized prop tail in '${row.title}' — leaving unshaped`,
        );
        return null;
      }
      const bareFixture = row.title.replace(/\s+-\s+[^\n]*$/, '').trim();
      const fx = row.title.match(H2H_PREFIXED_RX) ?? bareFixture.match(H2H_VS_RX);
      if (fx?.groups) {
        const a = fx.groups.a.trim();
        const b = fx.groups.b.trim();
        if (a.length >= 2 && b.length >= 2) {
          const suffix = `prop ${prop.propKind}`;
          // Draw side → Template-J convention (subject = the draw outcome).
          if (prop.side === 'draw') {
            const dl = drawLegMatch(a, b);
            if (!dl) return null;
            return {
              ...dl,
              outcome_label: prop.propKind,
              event_kind: 'other',
              canonical_event_suffix: suffix,
            };
          }
          let subject = a;
          let opponent = b;
          if (prop.side !== null) {
            const fs = spaceInvariantVariant(prop.side);
            if (fs && fs === spaceInvariantVariant(a)) { subject = a; opponent = b; }
            else if (fs && fs === spaceInvariantVariant(b)) { subject = b; opponent = a; }
            else {
              log.warn(
                `Template B cricket-prop bail: market ${row.market_id} prop side '${prop.side}' matches neither participant ('${a}' / '${b}') — leaving unshaped`,
              );
              return null;
            }
          }
          const propTuple = emitCondition({
            archetype: 'event_occurrence',
            tag: 'text-deterministic-B',
            eventKind: 'other',
            metric: null,
            temporal: null,
            outcomeLabel: prop.propKind,
          }, 'text-det');
          if (!propTuple) return null;
          return {
            subject_raw: subject,
            participants_raw: [opponent],
            ...tupleToTemplateFields(propTuple),
            entity_type: 'team',
            participant_type_confidence: 'low',
            source_tag: 'text-deterministic-B',
            canonical_event_suffix: suffix,
            subject_native_verified: !isAnonSubject(opponent),
          };
        }
      }
      return null;
    }
  }

  {
    const innings = tryInningsTieLeg(row);
    if (innings) return innings;
  }

  const gameN = row.title.match(H2H_GAME_N_WINNER_RX);
  if (gameN?.groups) {
    const a = gameN.groups.a.trim();
    const b = gameN.groups.b.trim();
    const n = parseInt(gameN.groups.n, 10);
    if (Number.isFinite(n) && !WINNER_SUFFIX_CONTAMINATION_RX.test(a) && !WINNER_SUFFIX_CONTAMINATION_RX.test(b)) {
      const sorted = a.toLowerCase() < b.toLowerCase() ? `${a} vs ${b}` : `${b} vs ${a}`;
      const gameSuffix = `game ${n}`;
      const side = h2hNativeSide(row, a, b);
      if (side.kind === 'bail') return null;
      if (side.kind === 'draw') {
        const dl = drawLegMatch(a, b, sorted);
        return dl ? { ...dl, canonical_event_suffix: gameSuffix } : null;
      }
      const tuple = emitCondition({
        archetype: 'fixture_outcome',
        topology: 'standalone_binary',
        tag: 'text-deterministic-B',
        eventKind: 'match_winner',
        metric: null,
        temporal: null,
      }, 'text-det');
      if (!tuple) return null;
      return {
        subject_raw: side.kind === 'team' ? side.subject : a,
        participants_raw: [side.kind === 'team' ? side.opponent : b],
        ...tupleToTemplateFields(tuple),
        entity_type: 'team',
        participant_type_confidence: 'low',
        source_tag: 'text-deterministic-B',
        canonical_event_override: sorted,
        canonical_event_suffix: gameSuffix,
        subject_native_verified: h2hSubjectVerified(side, side.kind === 'team' ? side.opponent : b),
      };
    }
  }
  const winnerMatch = row.title.match(H2H_VS_WINNER_RX);
  if (winnerMatch?.groups) {
    const a = winnerMatch.groups.a.trim();
    const b = winnerMatch.groups.b.trim();
    if (!WINNER_SUFFIX_CONTAMINATION_RX.test(a) && !WINNER_SUFFIX_CONTAMINATION_RX.test(b)) {
      const side = h2hNativeSide(row, a, b);
      if (side.kind === 'bail') return null;
      if (side.kind === 'draw') return drawLegMatch(a, b);
      const tuple = emitCondition({
        archetype: 'fixture_outcome',
        topology: 'standalone_binary',
        tag: 'text-deterministic-B',
        eventKind: 'match_winner',
        metric: null,
        temporal: null,
      }, 'text-det');
      if (!tuple) return null;
      return {
        subject_raw: side.kind === 'team' ? side.subject : a,
        participants_raw: [side.kind === 'team' ? side.opponent : b],
        ...tupleToTemplateFields(tuple),
        entity_type: 'team',
        participant_type_confidence: 'low',
        source_tag: 'text-deterministic-B',
        subject_native_verified: h2hSubjectVerified(side, side.kind === 'team' ? side.opponent : b),
      };
    }
  }

  for (const guard of B_SUFFIX_GUARDS) {
    if (guard.test(row.title)) return null;
  }
  if (/\b(?:n?rfi|yrfi|first\s+inning|runs?\s+scored|scored\s+in\s+the\s+first|no\s+runs?\s+first|total\s+runs?)\b/i.test(row.title)) return null;
  if (/\bgo(?:es|ing)?\s+to\s+(?:extra\s+innings?|overtime|a\s+shootout|penalties|extra\s+time)\b/i.test(row.title)) return null;
  if (/\b(?:to\s+score|scores?)\s+first\b/i.test(row.title)) return null;

  const setM = row.title.match(H2H_SET_WINNER_RX);
  const m =
    row.title.match(H2H_VS_RX) ??
    row.title.match(H2H_BEAT_RX) ??
    row.title.match(H2H_OR_RX) ??
    setM ??
    row.title.match(H2H_PREFIXED_RX);
  if (!m?.groups) return null;

  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  const side = h2hNativeSide(row, a, b);
  if (side.kind === 'bail') return null;
  if (side.kind === 'draw') return drawLegMatch(a, b);

  const tuple = emitCondition({
    archetype: 'fixture_outcome',
    topology: 'standalone_binary',
    tag: 'text-deterministic-B',
    eventKind: 'match_winner',
    metric: null,
    temporal: null,
    outcomeLabel: setM?.groups?.setn ? `set ${setM.groups.setn}` : null,
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: side.kind === 'team' ? side.subject : a,
    participants_raw: [side.kind === 'team' ? side.opponent : b],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-B',
    subject_native_verified: h2hSubjectVerified(side, side.kind === 'team' ? side.opponent : b),
  };
}

const CHAMPIONSHIP_RX =
  /^(?:will\s+(?:the\s+)?)?(?<team>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+(?:to\s+)?(?:win|be\s+the)\s+(?:the\s+)?(?:[\p{L}\p{M}\s.'\-0-9]*?)(?:championship|finals?|title|cup|series|tournament|league|award|grand[- ]?prix|open|nominee|nomination|drivers'?\s+champion|champion)\b.*\??$/iu;

const CHAMPIONSHIP_PREDICT_RX =
  /^(?:will\s+(?:the\s+)?)?(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'’\-\/]+?)\s+(?:to\s+)?(?:win|be\s+the)\s+(?:the\s+)?(?:Group\s+[A-L]\s+in\s+(?:the\s+)?)?(?:[\p{L}\p{M}\s.'’\-–—0-9\/]*?)(?:championship|finals?|title|cup|series|tournament|league|liga|award|grand[- ]?prix|open|nominee|nomination|drivers'?\s+champion|champion|conference|mvp|season|major|grand\s+slam)\b.*?\??$/iu;

const CHAMPIONSHIP_POLY_RX =
  /^(?:will\s+(?:the\s+)?)?(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s+(?:to\s+)?(?:win|be\s+the)\s+(?:the\s+)?(?:[\p{L}\p{M}\s.'’\-–—0-9]*?)(?:championship|finals?|title|cup|series|tournament|tour|league|liga|award|grand[- ]?prix|open|nominee|nomination|drivers'?\s+champion|champion|winner|trophy|medal|roland[- ]?garros|wimbledon|masters|classic|playoffs?|world\s+cup|olympics?|coach\s+of\s+the\s+year|player\s+of\s+the\s+year|defender\s+of\s+the\s+year|goalkeeper\s+of\s+the\s+year|rookie\s+of\s+the\s+year|most\s+valuable\s+player|mvp|cy\s+young|heisman|ballon|conn\s+smythe|calder|norris|vezina|selke|jack\s+adams|golden\s+boot|golden\s+glove|ligue\s+1|serie\s+a|eredivisie|super\s+lig|primeira|j-?league)\b.*\??$/iu;
const CHAMPIONSHIP_COUNT_TRAP_RX =
  /\bwin\s+(?:\d+\s*\+?\s*(?:or\s+more\s+)?(?:games?|matches?|races?|medals?|titles?|seats?|points?|goals?|wins?|blocks?)|(?:more\s+than|over|at\s+least|fewer\s+than|under|no\s+more\s+than|at\s+most)\s+\d+(?:\.\d+)?\s*(?:games?|matches?|races?|medals?|titles?|seats?|points?|goals?|wins?|blocks?)|the\s+most\b|at\s+least\s+\d)/i;

const NUMERIC_FRAGMENT_SUBJECT_RX = /^\d+\s+\p{Ll}/u;

function tryTemplateChampionshipWinner(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  if (/\bbe\s+the\s+matchup\b/i.test(row.title)) return null;
  if (row.platform === 'limitless' && row.title.includes(': ')) return null;
  if (/^who will\b/i.test(row.title)) return null;

  const tourSignals = {
    title: row.title,
    eventTitle: row.event_title ?? row.non_kalshi_event_title,
    kalshiCompetition: row.kalshi_competition,
    eventTicker: row.event_ticker,
    rulesPrimary: row.rules_primary,
  };
  const tour = deriveTennisTour(tourSignals);
  const tourLeague = tour ? tennisTourLeague(tourSignals) : null;

  if (row.platform === 'predict' && row.native_question) {
    const pm = row.native_question.match(CHAMPIONSHIP_PREDICT_RX);
    if (pm?.groups && !NUMERIC_FRAGMENT_SUBJECT_RX.test(pm.groups.team.trim())) {
      return {
        subject_raw: pm.groups.team.trim(),
        participants_raw: [],
        condition_shape: 'monotonic_threshold',
        condition_direction: 'below',
        condition_metric: null,
        temporal_semantics: 'at_resolution',
        value_primary: 1,
        value_secondary: null,
        value_unit: 'rank',
        outcome_label: null,
        event_kind: 'championship_winner',
        entity_type: 'team',
        participant_type_confidence: 'low',
        source_tag: 'text-deterministic-C',
        canonical_event_override: row.native_question,
        canonical_event_tour: tour,
        ...(tourLeague ? { league_canonical: tourLeague, sport_canonical: 'tennis' } : {}),
      };
    }
  }

  let m = row.title.match(CHAMPIONSHIP_RX);
  if (!m?.groups && row.platform !== 'kalshi' && !CHAMPIONSHIP_COUNT_TRAP_RX.test(row.title)) {
    m = row.title.match(CHAMPIONSHIP_POLY_RX);
  }
  if (!m?.groups) return null;
  // Count-placeholder fragment ("1 contenders") — never a real subject; bail
  // so the row stays unshaped rather than polluting the KB.
  if (NUMERIC_FRAGMENT_SUBJECT_RX.test(m.groups.team.trim())) return null;

  return {
    subject_raw: m.groups.team.trim(),
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    outcome_label: null,
    event_kind: 'championship_winner',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-C',
    canonical_event_override: row.title,
    canonical_event_tour: tour,
    ...(tourLeague ? { league_canonical: tourLeague, sport_canonical: 'tennis' } : {}),
  };
}

const STAT_LEADER_RX =
  /^will\s+(?<subject>[\p{Lu}][\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){0,4}?)\s+(?:lead\s+(?:the\s+)?[\p{L}& ]+?\s+in\s+[\p{L} ]+?|(?:hit|record|have|score|get|tally|make|win|strike\s+out)\s+the\s+most\b|have\s+the\s+(?:highest|lowest|best)\b|be\s+the\s+(?:top|leading)\s+(?:goal\s*)?scorer\b|be\s+the\s+(?:goalie|goalkeeper|player)\s+with\s+the\s+most\b|win\s+the\s+\d{4}\s+ipl\s+(?:purple|orange)\s+cap\b)/iu;

const STAT_LEADER_STAT_RX =
  /\blead\s+(?:the\s+)?[\p{L}& ]+?\s+in\s+(?<stat1>[\p{L} ]+?)(?:\s+(?:for|during|at|this|in)\b|$)|(?:hit|record|have|score|get|tally|make|strike\s+out)\s+the\s+most\s+(?<stat2>[\p{L} ]+?)(?:\s+(?:for|during|at|this|in)\b|$)|have\s+the\s+(?:highest|lowest|best)\s+(?<stat3>[\p{L} ]+?)(?:\s+(?:for|during|at|this|in)\b|$)|be\s+the\s+(?:top|leading)\s+(?<stat4>(?:goal\s*)?scorer)\b|(?<cap>(?:purple|orange)\s+cap)\b/iu;

export function statLeaderGatedEvent(subject: string, title: string): string {
  const yearM = title.match(/\b(20\d{2})\b/);
  const year = yearM ? yearM[1] : '';
  const sm = title.match(STAT_LEADER_STAT_RX);
  const g = sm?.groups;
  let stat = (g?.stat1 ?? g?.stat2 ?? g?.stat3 ?? g?.stat4 ?? g?.cap ?? '').trim();
  if (stat) {
    const w = stat.split(/\s+/);
    stat = w.slice(-2).join(' ');
  } else {
    stat = 'stat';
  }
  const composed = `${subject} ${stat} leader ${year}`.replace(/\s+/g, ' ').trim();
  return composed;
}

function tryTemplateStatLeader(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  if (/^who will\b/i.test(row.title)) return null;
  const m = row.title.match(STAT_LEADER_RX);
  if (!m?.groups) return null;
  return {
    subject_raw: m.groups.subject.trim(),
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    outcome_label: null,
    event_kind: 'championship_winner',
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-stat-leader',
    // Gated noun-phrase event, never the raw predicate question.
    canonical_event_override: row.non_kalshi_event_title ?? statLeaderGatedEvent(m.groups.subject.trim(), row.title),
  };
}

const ADVANCE_RX =
  /^(?:will\s+(?:the\s+)?)?(?<team>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+(?:to\s+)?(?:reach|advance(?:\s+to)?|make(?:\s+it\s+to)?)\s+(?:the\s+)?(?:[\p{L}\p{M}\s'\-]*?)(?:final|semi[- ]?final|quarter[- ]?final|round|playoff|conference\s+finals?)s?\b.*\??$/iu;

function tryTemplateTournamentStageAdvance(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  if (row.hierarchy_type !== 'tournament_round') return null;
  if (row.hierarchy_level != null && row.hierarchy_level >= 7) return null;

  const m = row.title.match(ADVANCE_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.team.trim(),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'stage_advance',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-D',
    canonical_event_override: row.title,
  };
}

const PLAYER_PROP_COLON_RX =
  /^(?!.*\svs?\.?\s)(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4}):\s*(?<value>\d+(?:\.\d+)?)\+\s*(?<unit>[a-zA-Z][a-zA-Z\s\-]*?)?\??$/u;
const PLAYER_PROP_VERB_RX =
  /^(?:will\s+)?(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4})\s+(?:score|record|hit|throw|run for|reach|tally|get|achieve)\s+(?<value>\d+(?:\.\d+)?)\+?\s*(?<unit>points?|rebounds?|assists?|goals?|home runs?|threes?|three[- ]pointers?|strikeouts?|blocks?|steals?|saves?|hits?|yards?|touchdowns?)\??$/iu;
const PLAYER_PROP_OVER_RX =
  /^(?!.*\bwins?\s+by\b)(?!.*\bloses?\s+by\b)(?!.*\b(?:score|scores|win|wins|beat|beats|finish|finishes)\s+(?:over|under)\b)(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4})\s+(?:over|under)\s+(?<value>\d+(?:\.\d+)?)\s+(?<unit>points?|rebounds?|assists?|goals?|home runs?|threes?|three[- ]pointers?|passing yards?|rushing yards?|receiving yards?|yards?|touchdowns?|strikeouts?|blocks?|steals?|saves?|hits?)\??$/iu;
const PLAYER_PROP_COLON_OU_RX =
  /^(?!.*\svs?\.?\s)(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4}):\s+(?:(?<stat>Points?|Rebounds?|Assists?|Goals?|Blocks?|Steals?|Saves?|Threes?|Three[- ]Pointers?|Kills?|Deaths?|Strikeouts?|RBIs?|Home\s+Runs?|Hits?|Yards?|Touchdowns?)\s+)?O\/U\s+(?<value>\d+(?:\.\d+)?)\??$/iu;
const PLAYER_PROP_COLON_OVER_RX =
  /^(?!.*\svs?\.?\s)(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4}):\s+(?<stat>Points?|Rebounds?|Assists?|Goals?|Blocks?|Steals?|Saves?|Threes?|Three[- ]Pointers?|Kills?|Deaths?|Strikeouts?|RBIs?|Home\s+Runs?|Hits?|Yards?|Touchdowns?)\s+(?<dir>Over|Under)\s+(?<value>\d+(?:\.\d+)?)\??$/iu;

const NON_PLAYER_METRIC_HEADER_RX =
  /^(?:total\s+)?(?:maps?|games?|rounds?|sets?|kills?|legs?|frames?|points?|series|total)(?:\s+total|\s+count)?$/i;

function tryTemplatePlayerProp(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;

  const plusM = row.title.match(PLAYER_PROP_COLON_RX) ?? row.title.match(PLAYER_PROP_VERB_RX);
  const m = plusM ??
    row.title.match(PLAYER_PROP_OVER_RX) ??
    row.title.match(PLAYER_PROP_COLON_OU_RX) ??
    row.title.match(PLAYER_PROP_COLON_OVER_RX);
  if (!m?.groups) return null;
  const isPlusNotation = plusM != null && /\+/.test(plusM[0]);

  if (NON_PLAYER_METRIC_HEADER_RX.test(m.groups.player.trim())) return null;

  const rawValue = parseFloat(m.groups.value);
  const dirGroup = (m.groups.dir ?? '').toLowerCase();
  const direction: ConditionDirection =
    dirGroup === 'under' ? 'below' :
    dirGroup === 'over' ? 'above' :
    /\bunder\b/i.test(row.title) ? 'below' : 'above';
  const statRaw = m.groups.stat ?? m.groups.unit ?? '';
  const unit = normalizePlayerStatUnit(statRaw, 'count');
  if (unit.length > 20) return null;

  const value = canonicalizeIntegerThreshold({
    direction: direction === 'below' ? 'below' : 'above',
    value: rawValue,
    unit,
    strictness: isPlusNotation ? 'inclusive' : 'strict',
  }).value;

  return {
    subject_raw: m.groups.player.trim(),
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: direction,
    condition_metric: 'count',
    temporal_semantics: 'during_period',
    value_primary: value,
    value_secondary: null,
    value_unit: unit,
    outcome_label: null,
    event_kind: 'player_prop_threshold',
    entity_type: 'person',
    source_tag: 'text-deterministic-E',
  };
}

const ELECTION_RX =
  /^(?:will\s+(?:the\s+)?)?(?<person>[\p{Lu}][\p{L}\p{M}.'’\-]+(?:\s+(?:[\p{Lu}][\p{L}\p{M}.'’\-]+|\p{Ll}{2,3})){0,5})\s+(?:to\s+)?win\s+(?:the\s+)?[\p{L}\p{M}\s\d'’\-]*?(?:election|primary|race|presidency|senate seat|house seat|governor(?:ship)?|mayor|nomination)\b.*\??$/iu;
const ELECTION_NOMINEE_RX =
  /^(?:will\s+(?:the\s+)?)?(?<person>[\p{Lu}][\p{L}\p{M}.'’\-]+(?:\s+(?:[\p{Lu}][\p{L}\p{M}.'’\-]+|\p{Ll}{2,3})){0,5})\s+(?:to\s+)?be\s+the\s+[\p{L}\p{M}0-9 .'’\-]*?(?:nominee|nomination)\b.*\??$/iu;
const NEXT_OFFICE_RX =
  /^(?:will\s+(?:the\s+)?)?(?<person>[\p{Lu}][\p{L}\p{M}.'’\-]+(?:\s+(?:[\p{Lu}][\p{L}\p{M}.'’\-]+|\p{Ll}{2,3})){0,5})\s+(?:to\s+)?be\s+(?:the\s+)?(?:next|first)\s+[\p{L}\p{M}\s'’\-]*?\b(?:prime\s+minister|premier|first\s+minister|chancellor|secretary[- ]?general|senate\s+majority\s+leader|speaker\s+of\s+the\s+house|chief\s+minister|taoiseach|president|mayor|governor)\b.*\??$/iu;

function tryTemplateElectionBinary(row: CandidateRow): TemplateMatch | null {
  if (!isPoliticalCategory(row.category_unified)) return null;
  if (/^who will win\b/i.test(row.title)) return null;

  const winM = row.title.match(ELECTION_RX);
  const altM = winM ? null : (row.title.match(ELECTION_NOMINEE_RX) ?? row.title.match(NEXT_OFFICE_RX));
  const m = winM ?? altM;
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.person.trim(),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'election_outcome_winner',
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-F',
    canonical_event_override: winM ? row.title : (row.non_kalshi_event_title ?? row.title),
  };
}

const CIVIC_LEGAL_TICKERS =
  /^KX(ARREST|FEDERALCHARGE|CHARGE|INDICT|CONVICT|SENTENC|CONGRESSTESTIFY|TESTIFY|RESIGN|EPSTEINLIST)/i;
const CIVIC_LEGAL_PERSON_RX =
  /^will\s+(?:the\s+)?(?<person>[\p{Lu}][\p{L}\p{M}.'’\-]+(?:\s+(?:[\p{Lu}][\p{L}\p{M}.'’\-]+|\p{Ll}{2,4})){0,5})\s+(?:be\s+|get\s+|to\s+)?(?:arrested|charged|indicted|convicted|sentenced|testif|resign|steps?\s+down|named\s+in|mentioned\s+in)/iu;

function tryTemplateCivicLegal(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'kalshi') return null;
  if (!CIVIC_LEGAL_TICKERS.test(row.event_ticker ?? '')) return null;
  const m = row.title.match(CIVIC_LEGAL_PERSON_RX);
  if (!m?.groups?.person) return null;
  return {
    subject_raw: m.groups.person.trim(),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'other',
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-civic-legal',
    canonical_event_override: row.title,
  };
}

const SINGLE_WIN_RX =
  /^will\s+(?:the\s+)?(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+win(?:\s+on\s+\d{4}-\d{2}-\d{2})?\??$/iu;

function tryTemplateSingleTeamWin(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(SINGLE_WIN_RX);
  if (!m?.groups) return null;

  const team = m.groups.team.trim();

  let canonicalEventOverride: string | null = null;
  let participantsOverride: string[] = [];
  const normalizedCtx = normalizeFixtureCanonicalEvent(row.event_match_context);
  const teams = normalizedCtx ? parseTeamsFromContext(normalizedCtx) : null;
  if (teams) {
    const [a, b] = teams;
    const stripClubSuffix = (s: string) =>
      s.toLowerCase().replace(/\s+(fc|bc|ac|cf|sc|cd|afc|united)$/i, '').trim();
    const subjectKey = stripClubSuffix(team);
    const aKey = stripClubSuffix(a);
    const bKey = stripClubSuffix(b);
    if (subjectKey === aKey || subjectKey === bKey) {
      const opponent = subjectKey === aKey ? b : a;
      const oppKey = stripClubSuffix(opponent);
      const sorted = subjectKey < oppKey
        ? `${subjectKey} vs ${oppKey}`
        : `${oppKey} vs ${subjectKey}`;
      canonicalEventOverride = sorted;
      participantsOverride = [opponent];
    }
  }

  return {
    subject_raw: team,
    participants_raw: participantsOverride,
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'match_winner',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-G',
    canonical_event_override: canonicalEventOverride,
  };
}

const H2H_OU_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-/]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-/]+?):\s*(?<pre>[\p{L}\p{M}\d\s.'\-/#]*?)\s*O\/U\s+(?<value>\d+(?:\.\d+)?)(?:\s+(?:total\s+)?(?<stat>corners?|cards?|goals?))?\s*\??$/iu;

const OU_ENUM_QUALIFIER_RX = /^(?:match|total\s+sets?|set\s+\d+\s+games?|1h|2h)$/i;
const OU_HALF_RX = /^(?<lead>.*?)\s*(?<h>1st|2nd|first|second)\s+half$/i;

function ouUnit(qualifier: string | undefined, value: number): string {
  if (qualifier) {
    const q = qualifier.toLowerCase();
    if (q.includes('sets')) return 'sets';
    if (q.includes('games') || q === 'match') return 'games';
  }
  if (value >= 50) return 'points';
  if (value <= 6.5) return 'goals';
  return 'games';
}

function ouQualifierScope(qualifier: string | undefined): MetricScope | null {
  if (!qualifier) return null;
  const q = qualifier.toLowerCase();
  if (q === '1h') return 'half_1';
  if (q === '2h') return 'half_2';
  if (/^set\s+\d+\s+games?$/.test(q)) return 'set';
  return null;
}

function tryTemplateH2hOverUnder(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(H2H_OU_RX);
  if (!m?.groups) return null;

  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  const value = parseFloat(m.groups.value);
  const preRaw = (m.groups.pre ?? '').trim();
  const stat = m.groups.stat?.toLowerCase();

  let subject_raw = a;
  let participants_raw = [b];
  let metric_scope: MetricScope | null;
  let qualifier: string | undefined;

  if (preRaw === '' || OU_ENUM_QUALIFIER_RX.test(preRaw)) {
    qualifier = preRaw === '' ? undefined : preRaw;
    metric_scope = ouQualifierScope(qualifier) ?? parseMetricScopeFromTitle(row.title);
  } else {
    const half = preRaw.match(OU_HALF_RX);
    if (half?.groups) {
      const lead = half.groups.lead.trim();
      if (lead !== '') return null;
      const h = half.groups.h.toLowerCase();
      metric_scope = h === '1st' || h === 'first' ? 'half_1' : 'half_2';
    } else {
      const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\.\s*$/, '').trim();
      const pk = key(preRaw);
      if (pk === key(a)) {
        subject_raw = a;
        participants_raw = [b];
      } else if (pk === key(b)) {
        subject_raw = b;
        participants_raw = [a];
      } else {
        return null;
      }
      metric_scope = 'team';
    }
  }

  const unit = stat ? stat.replace(/s$/, '') : ouUnit(qualifier, value);
  const unitExplicit = stat != null || (!!qualifier && /set|game|match/i.test(qualifier));

  return {
    subject_raw,
    participants_raw,
    condition_shape: 'monotonic_threshold',
    condition_direction: 'above',
    condition_metric: null,
    temporal_semantics: 'during_period',
    value_primary: value,
    value_secondary: null,
    value_unit: unit,
    outcome_label: null,
    event_kind: 'match_total_metric',
    entity_type: 'team',
    source_tag: 'text-deterministic-H',
    metric_scope,
    value_unit_inferred: !unitExplicit,
  };
}

const DRAW_FULL_RX =
  /^will\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+end\s+in\s+a\s+draw\??$/iu;
const DRAW_HALF_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?):\s*draw\s+at\s+halftime\??$/iu;

function tryTemplateDrawOutcome(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const full = row.title.match(DRAW_FULL_RX);
  const half = full ? null : row.title.match(DRAW_HALF_RX);
  const m = full ?? half;
  if (!m?.groups) return null;

  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  const draw = nativeDraw();
  return {
    subject_raw: draw.subject_raw,
    participants_raw: [a, b],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: draw.outcome_label,
    event_kind: full ? 'match_winner' : 'halftime_leader',
    metric_scope: full ? null : 'half_1',
    entity_type: 'team',
    source_tag: full ? 'text-deterministic-J' : 'text-deterministic-J-half',
  };
}

const LEADING_HALFTIME_RX =
  /^(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+leading\s+at\s+halftime\??$/iu;

function tryTemplateLeadingAtHalftime(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(LEADING_HALFTIME_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.team.trim(),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'halftime_leader',
    metric_scope: 'half_1',
    entity_type: 'team',
    source_tag: 'text-deterministic-K',
  };
}

const BOTH_SCORE_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?):\s*Both\s+Teams?\s+to\s+Score\??$/iu;
const BOTH_SCORE_DATE_RX =
  /^Both\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+and\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+score\s+on\s+/iu;

function tryTemplateBothTeamsToScore(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(BOTH_SCORE_RX) ?? row.title.match(BOTH_SCORE_DATE_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.a.trim(),
    participants_raw: [m.groups.b.trim()],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'both_teams_score',
    entity_type: 'team',
    source_tag: 'text-deterministic-L',
    ...(epochSecToIso(row.limitless_start_ts)
      ? {
          condition_date_override: epochSecToIso(row.limitless_start_ts),
          condition_date_precision_override: 'minute' as const,
          condition_date_source_override: 'limitless-match-start',
        }
      : {}),
  };
}

const MATCH_TOTAL_RX =
  /^(?<team1>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<team2>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?):\s*(?<value>\d+)\+\s*total\s+(?<stat>goals?|points?|cards?|corners?|runs?|kills?|sets?)\?$/iu;
const MATCH_TOTAL_AND_RX =
  /^(?<team1>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+and\s+(?<team2>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+have\s+(?<value>\d+)(?:\+|\s+or\s+more)\s+total\s+(?<stat>goals?|points?|cards?|corners?|runs?|kills?|sets?)\?$/iu;

function buildMatchTotalMatch(
  team1: string,
  team2: string,
  rawValue: number,
  stat: string,
  row: CandidateRow,
  sourceTag: string,
): TemplateMatch {
  const unit = stat.toLowerCase().replace(/s$/, '');
  const value = canonicalizePlusNotation(rawValue, unit).value;
  return {
    subject_raw: team1.trim(),
    participants_raw: [team2.trim()],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'above',
    condition_metric: 'count',
    temporal_semantics: 'during_period',
    value_primary: value,
    value_secondary: null,
    value_unit: unit,
    outcome_label: null,
    event_kind: 'match_total_metric',
    entity_type: 'team',
    source_tag: sourceTag,
    metric_scope: parseMetricScopeFromTitle(row.title),
    ...(epochSecToIso(row.limitless_start_ts)
      ? {
          condition_date_override: epochSecToIso(row.limitless_start_ts),
          condition_date_precision_override: 'minute' as const,
          condition_date_source_override: 'limitless-match-start',
        }
      : {}),
  };
}

function tryTemplateMatchTotalMetric(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(MATCH_TOTAL_RX);
  if (!m?.groups) return null;
  const rawValue = parseInt(m.groups.value, 10);
  return buildMatchTotalMatch(m.groups.team1, m.groups.team2, rawValue, m.groups.stat, row, 'text-deterministic-M');
}

function tryTemplateMatchTotalLimitless(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(MATCH_TOTAL_AND_RX);
  if (!m?.groups) return null;
  const rawValue = parseInt(m.groups.value, 10);
  return buildMatchTotalMatch(m.groups.team1, m.groups.team2, rawValue, m.groups.stat, row, 'text-deterministic-M2');
}

const CRYPTO_UP_DOWN_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 /()&.]+?)\s+Up\s+or\s+Down\s+-\s+.+$/i;
const CRYPTO_UP_DOWN_ON_DATE_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 /()&.]+?)\s+Up\s+or\s+Down\s+on\s+.+\??$/i;

function extractAssetName(raw: string): string {
  const parens = raw.match(/\(([A-Z0-9.!]{2,10})\)$/);
  if (parens) return parens[1];
  const slash = raw.match(/^([A-Z][A-Za-z0-9]+)\//);
  if (slash) return slash[1];
  return raw.trim();
}

const CANDLE_WINDOW_SLUG_RX = /(?:updown|up-or-down)-(?<w>hourly|daily|weekly|\d+\s*-?\s*min(?:ute)?s?|\d+\s*-?\s*hours?|\d+\s*-?\s*days?|\d+\s*-?\s*weeks?|\d+[mhdw])(?:-|$)/i;
const CANDLE_WINDOW_TITLE_RX = /up\s+or\s+down\s*-\s*(?<w>\d+\s*min(?:ute)?s?|\d+\s*hours?|\d+\s*days?|\d+\s*weeks?|hourly|daily|weekly)\b/i;
const CANDLE_TIME_RANGE_RX = /(?<h1>\d{1,2})(?::(?<m1>\d{2}))?\s*(?<ap1>[ap]m)\s*[-–]\s*(?<h2>\d{1,2})(?::(?<m2>\d{2}))?\s*(?<ap2>[ap]m)/i;

function normCandleWindowToken(raw: string): string | null {
  const t = raw.toLowerCase().replace(/[\s-]+/g, '');
  if (t === 'hourly') return '1h';
  if (t === 'daily') return '1d';
  if (t === 'weekly') return '1w';
  const m = t.match(/^(\d+)(mins?|minutes?|m|hours?|h|days?|d|weeks?|w)$/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  if (n <= 0) return null;
  const u = m[2]!;
  if (u.startsWith('m')) return n === 60 ? '1h' : `${n}m`;
  if (u.startsWith('h')) return `${n}h`;
  if (u.startsWith('d')) return `${n}d`;
  return `${n}w`;
}

function minutesToWindowToken(min: number): string | null {
  if (min <= 0) return null;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

function extractCandleWindow(title: string, slug: string | null): string | null {
  if (slug) {
    const sm = slug.match(CANDLE_WINDOW_SLUG_RX);
    const tok = sm?.groups?.w ? normCandleWindowToken(sm.groups.w) : null;
    if (tok) return tok;
  }
  const tm = title.match(CANDLE_WINDOW_TITLE_RX);
  const tok = tm?.groups?.w ? normCandleWindowToken(tm.groups.w) : null;
  if (tok) return tok;
  const rm = title.match(CANDLE_TIME_RANGE_RX);
  if (rm?.groups) {
    const to24 = (h: string, ap: string) => (parseInt(h, 10) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
    const start = to24(rm.groups.h1!, rm.groups.ap1!) * 60 + (rm.groups.m1 ? parseInt(rm.groups.m1, 10) : 0);
    let end = to24(rm.groups.h2!, rm.groups.ap2!) * 60 + (rm.groups.m2 ? parseInt(rm.groups.m2, 10) : 0);
    if (end <= start) end += 1440;
    return minutesToWindowToken(end - start);
  }
  return null;
}

function tryTemplateCryptoCandleDirection(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'crypto') return null;
  const m = row.title.match(CRYPTO_UP_DOWN_RX) ?? row.title.match(CRYPTO_UP_DOWN_ON_DATE_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: extractAssetName(m.groups.asset),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: 'above',
    condition_metric: 'price',
    temporal_semantics: 'on_date',
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: extractCandleWindow(row.title, row.slug),
    event_kind: 'candle_direction',
    entity_type: 'asset',
    source_tag: 'text-deterministic-N',
    resolution_source: 'CF Benchmarks',
  };
}

const SOCCER_EMOJI_RX =
  /^⚽\s+(?<league>[^,]+),\s*(?<team1>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<team2>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?),\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^\n]*$/u;

function tryTemplateSoccerEmojiH2h(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(SOCCER_EMOJI_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.team1.trim(),
    participants_raw: [m.groups.team2.trim()],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'match_winner',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-O',
  };
}

const WEATHER_RANGE_RX =
  /^will\s+the\s+(?:highest|lowest|maximum|minimum)\s+temperature\s+in\s+(?<city>[\p{L}][\p{L}\s]+?)\s+be\s+between\s+(?<lo>\d+(?:\.\d+)?)-(?<hi>\d+(?:\.\d+)?)°?(?<unit>[CF])\s+on\s+/iu;
const WEATHER_THRESHOLD_RX =
  /^will\s+the\s+(?:highest|lowest|maximum|minimum)\s+temperature\s+in\s+(?<city>[\p{L}][\p{L}\s]+?)\s+be\s+(?<val>\d+(?:\.\d+)?)°?(?<unit>[CF])\s+or\s+(?<dir>higher|above|lower|below)\s+on\s+/iu;
const WEATHER_EXACT_RX =
  /^will\s+the\s+(?:highest|lowest|maximum|minimum)\s+temperature\s+in\s+(?<city>[\p{L}][\p{L}\s]+?)\s+be\s+(?<val>\d+(?:\.\d+)?)°?(?<unit>[CF])\s+on\s+/iu;


function tryTemplateWeatherTemperature(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'weather') return null;

  const subjectFor = (cityRaw: string): string => {
    const city = cityRaw.trim();
    return extractPolymarketWeatherStation(row.description, city) ?? city;
  };

  const canonicalEventFor = (metricPhrase: string, cityRaw: string): string => {
    const metric = metricPhrase.toLowerCase();
    const noun = (metric === 'maximum' || metric === 'highest') ? 'highest temperature'
               : 'lowest temperature';
    return `${noun} in ${cityRaw.trim()}`;
  };

  const range = row.title.match(WEATHER_RANGE_RX);
  if (range?.groups) {
    const metricMatch = row.title.match(/^will\s+the\s+(highest|lowest|maximum|minimum)\s+temperature/i);
    const metricPhrase = metricMatch?.[1] ?? 'highest';
    const tuple = emitCondition({
      archetype: 'terminal_range',
      tag: 'text-deterministic-P',
      eventKind: 'weather_extreme',
      metric: null,
      temporal: 'on_date',
      value: {
        primary: parseFloat(range.groups.lo),
        secondary: parseFloat(range.groups.hi),
        unit: range.groups.unit.toLowerCase() === 'f' ? 'fahrenheit' : 'celsius',
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subjectFor(range.groups.city),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'location',
      source_tag: 'text-deterministic-P',
      canonical_event_override: canonicalEventFor(metricPhrase, range.groups.city),
      // resolution_source intentionally null — the station-qualified
      // canonical_subject IS the source of truth for weather.
      resolution_source: null,
    };
  }

  const threshold = row.title.match(WEATHER_THRESHOLD_RX);
  if (threshold?.groups) {
    const dir = /lower|below/i.test(threshold.groups.dir) ? 'below' : 'above';
    const metricMatch = row.title.match(/^will\s+the\s+(highest|lowest|maximum|minimum)\s+temperature/i);
    const metricPhrase = metricMatch?.[1] ?? 'highest';
    const weatherUnit = threshold.groups.unit.toLowerCase() === 'f' ? 'fahrenheit' : 'celsius';
    const weatherValue = canonicalizeIntegerThreshold({
      direction: dir,
      value: parseFloat(threshold.groups.val),
      unit: weatherUnit,
      strictness: 'inclusive',
    }).value;
    const tuple = emitCondition({
      archetype: 'terminal_threshold',
      tag: 'text-deterministic-P',
      eventKind: 'weather_extreme',
      metric: null,
      direction: dir as ConditionDirection,
      temporal: 'on_date',
      value: {
        primary: weatherValue,
        unit: weatherUnit,
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subjectFor(threshold.groups.city),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'location',
      source_tag: 'text-deterministic-P',
      canonical_event_override: canonicalEventFor(metricPhrase, threshold.groups.city),
      resolution_source: null,
    };
  }

  const exact = row.title.match(WEATHER_EXACT_RX);
  if (exact?.groups) {
    const val = parseFloat(exact.groups.val);
    const metricMatch = row.title.match(/^will\s+the\s+(highest|lowest|maximum|minimum)\s+temperature/i);
    const metricPhrase = metricMatch?.[1] ?? 'highest';
    const tuple = emitCondition({
      archetype: 'terminal_range',
      tag: 'text-deterministic-P',
      eventKind: 'weather_extreme',
      metric: null,
      temporal: 'on_date',
      value: {
        primary: val,
        secondary: val + 1,
        unit: exact.groups.unit.toLowerCase() === 'f' ? 'fahrenheit' : 'celsius',
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subjectFor(exact.groups.city),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'location',
      source_tag: 'text-deterministic-P',
      canonical_event_override: canonicalEventFor(metricPhrase, exact.groups.city),
      resolution_source: null,
    };
  }

  return null;
}

const SPREAD_RX =
  /^(?:(?<half>1H|2H)\s+)?Spread:\s+(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+\((?<sign>[+\-])(?<value>\d+(?:\.\d+)?)\)\??$/iu;

function tryTemplateSpreadBet(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(SPREAD_RX);
  if (!m?.groups) return null;

  const value = parseFloat(m.groups.value);
  const direction: ConditionDirection = m.groups.sign === '-' ? 'above' : 'below';

  const tuple = emitCondition({
    archetype: 'fixture_margin',
    tag: 'text-deterministic-R',
    eventKind: 'match_spread',
    metric: 'score',
    direction,
    temporal: 'at_resolution',
    value: { primary: value, unit: 'points' },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: m.groups.team.trim(),
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-R',
  };
}

const LIMITLESS_PRICE_UTC_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 ()&.]+?)\s+above\s+\$(?<value>[\d,]+(?:\.\d+)?)\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{1,2}:\d{2}\s+UTC\??$/i;

function tryTemplateLimitlessPriceUtc(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== null && !isFinancialCategory(row.category_unified)) return null;
  const m = row.title.match(LIMITLESS_PRICE_UTC_RX);
  if (!m?.groups) return null;

  const value = parseFloat(m.groups.value.replace(/,/g, ''));

  return {
    subject_raw: extractAssetName(m.groups.asset.trim()),
    participants_raw: [],
    condition_shape: 'point_in_time',
    condition_direction: 'above',
    condition_metric: 'price',
    temporal_semantics: 'on_date',
    value_primary: value,
    value_secondary: null,
    value_unit: 'USD',
    outcome_label: null,
    event_kind: 'price_threshold',
    entity_type: 'asset',
    source_tag: 'text-deterministic-Q',
    resolution_source: cryptoResolutionSource(row.category_unified),
  };
}

const ANYTIME_SCORER_RX =
  /^(?<player>[\p{Lu}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4}):\s*Anytime\s+(?:Goal)?(?:Scorer|Touchdown|Goalscorer)\??$/u;

function tryTemplateAnytimeScorer(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(ANYTIME_SCORER_RX);
  if (!m?.groups) return null;

  // event_occurrence: "scores at least one" anytime binary; null temporal
  // is legal for the archetype.
  const tuple = emitCondition({
    archetype: 'event_occurrence',
    tag: 'text-deterministic-S',
    eventKind: 'player_prop_threshold',
    metric: 'count',
    temporal: null,
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: m.groups.player.trim(),
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    // Live unit-without-value stamp ('goals', value_primary null) rides
    // outside the door's value slot — pre-port byte parity.
    value_unit: 'goals',
    entity_type: 'person',
    source_tag: 'text-deterministic-S',
  };
}

const ESPORTS_HANDICAP_RX =
  /^(?:Map|Game)\s+Handicap:\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-.]+?)\s+\(-(?<value>\d+(?:\.\d+)?)\)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-.]+?)\s+\(\+\d+(?:\.\d+)?\)\??$/iu;

function tryTemplateEsportsHandicap(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(ESPORTS_HANDICAP_RX);
  if (!m?.groups) return null;

  const tuple = emitCondition({
    archetype: 'fixture_margin',
    tag: 'text-deterministic-T',
    eventKind: 'match_spread',
    metric: 'score',
    direction: 'above',
    temporal: 'at_resolution',
    value: { primary: parseFloat(m.groups.value), unit: 'maps' },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: m.groups.a.trim(),
    participants_raw: [m.groups.b.trim()],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    source_tag: 'text-deterministic-T',
  };
}

function parseTeamsFromContext(ctx: string | null): [string, string] | null {
  if (!ctx) return null;
  let m = ctx.match(/^[^:]+:\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)(?:\s*\(BO\d+\))?(?:\s+-\s+[^\n]*)?\??$/iu);
  if (m?.groups) return [m.groups.a.trim(), m.groups.b.trim()];
  m = ctx.match(/^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\??$/iu);
  if (m?.groups) return [m.groups.a.trim(), m.groups.b.trim()];
  return null;
}

const ESPORTS_KILLS_OU_RX =
  /^Total\s+(?<stat>Kills?|Rounds?)\s+Over\/Under\s+(?<value>\d+(?:\.\d+)?)\s+in\s+(?<scope>Game|Map)\s+(?<n>\d+)\??$/i;
const ESPORTS_PLAIN_OU_RX =
  /^O\/U\s+(?<value>\d+(?:\.\d+)?)\s+(?<stat>Kills?|Rounds?|Maps?)\??$/i;
const ESPORTS_GAME_PROP_RX =
  /^(?<scope>Game|Map)\s+(?<n>\d+):\s+(?<pred>.+?)\s*\??$/i;
const ESPORTS_FIRST_BLOOD_RX =
  /^(?<pred>First\s+Blood)\s+in\s+(?<scope>Game|Map)\s+(?<n>\d+)\??$/i;
const ESPORTS_MAP_WINNER_RX = /^(?<scope>Map|Game)\s+(?<n>\d+)\s+Winner\??$/i;

function normEsportsLabel(s: string): string {
  return s.toLowerCase().replace(/\?+\s*$/, '').replace(/\s+/g, ' ').trim();
}

function tryTemplateEsportsSubGameProp(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;

  const teams = parseTeamsFromContext(row.event_match_context);
  if (!teams) return null;

  const [teamA, teamB] = teams;

  const ouM = row.title.match(ESPORTS_KILLS_OU_RX) ?? row.title.match(ESPORTS_PLAIN_OU_RX);
  if (ouM?.groups) {
    const unit = ouM.groups.stat.toLowerCase().replace(/s$/, '');
    const scopeLabel = ouM.groups.scope
      ? `${ouM.groups.scope.toLowerCase()} ${ouM.groups.n}`
      : null;
    return {
      subject_raw: teamA,
      participants_raw: [teamB],
      condition_shape: 'monotonic_threshold',
      condition_direction: 'above',
      condition_metric: null,
      temporal_semantics: 'during_period',
      value_primary: parseFloat(ouM.groups.value),
      value_secondary: null,
      value_unit: unit,
      outcome_label: scopeLabel,
      event_kind: 'match_total_metric',
      entity_type: 'team',
      source_tag: 'text-deterministic-U',
      metric_scope: ouM.groups.scope ? 'map' : null,
    };
  }

  const propM = row.title.match(ESPORTS_GAME_PROP_RX) ?? row.title.match(ESPORTS_FIRST_BLOOD_RX);
  if (propM?.groups) {
    const pred = normEsportsLabel(propM.groups.pred ?? '');
    const scope = `${propM.groups.scope.toLowerCase()} ${propM.groups.n}`;
    return {
      subject_raw: teamA,
      participants_raw: [teamB],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: pred ? `${pred} | ${scope}` : scope,
      event_kind: 'match_event_prop',
      entity_type: 'team',
      source_tag: 'text-deterministic-U',
    };
  }

  const mapW = row.title.match(ESPORTS_MAP_WINNER_RX);
  if (mapW?.groups) {
    const n = parseInt(mapW.groups.n, 10);
    const scope = mapW.groups.scope.toLowerCase();
    const sorted = teamA.toLowerCase() < teamB.toLowerCase()
      ? `${teamA} vs ${teamB}`
      : `${teamB} vs ${teamA}`;
    return {
      subject_raw: teamA,
      participants_raw: [teamB],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: `${scope} ${n}`,
      event_kind: 'match_winner',
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-U',
      canonical_event_override: sorted,
      canonical_event_suffix: `${scope} ${n}`,
    };
  }

  return null;
}

const SOCIAL_COUNT_RANGE_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)\s+(?:post|tweet|hit|reach|get)\s+(?<lo>[\d,]+(?:\s*(?:billion|million|thousand|B|M|K))?)\s*[-–]\s*(?<hi>[\d,]+(?:\s*(?:billion|million|thousand|B|M|K))?)\s+(?:(?:truth\s+social|twitter|x)\s+)?(?<unit>tweets?|times?|views?|followers?|subscribers?|posts?)(?:\s+.+)?\??$/iu;
const SOCIAL_COUNT_THRESHOLD_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)\s+(?:post|tweet|hit|reach|surpass|exceed)\s+(?<value>[\d,]+(?:\s*(?:billion|million|thousand|B|M|K))?)\+?\s+(?:(?:truth\s+social|twitter|x)\s+)?(?<unit>tweets?|times?|views?|followers?|subscribers?|posts?)(?:\s+.+)?\??$/iu;

function parseSocialValue(raw: string): number {
  const s = raw.replace(/,/g, '').trim();
  const mult: Record<string, number> = { billion: 1e9, b: 1e9, million: 1e6, m: 1e6, thousand: 1e3, k: 1e3 };
  const n = s.match(/^([\d.]+)\s*(\w+)?$/i);
  if (!n) return parseFloat(s) || 0;
  const base = parseFloat(n[1]);
  const suffix = (n[2] ?? '').toLowerCase();
  return base * (mult[suffix] ?? 1);
}

function tryTemplateSocialCountThreshold(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'politics' &&
      row.category_unified !== 'technology' &&
      row.category_unified !== 'entertainment') return null;

  const rangeM = row.title.match(SOCIAL_COUNT_RANGE_RX);
  if (rangeM?.groups) {
    const unit = rangeM.groups.unit.toLowerCase().replace(/s$/, '');
    const tuple = emitCondition({
      archetype: 'cumulative_count',
      arm: 'range',
      tag: 'text-deterministic-V',
      eventKind: 'social_media_metric',
      metric: 'count',
      temporal: 'during_period',
      value: { primary: parseSocialValue(rangeM.groups.lo), secondary: parseSocialValue(rangeM.groups.hi), unit },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: rangeM.groups.person.trim(),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'person',
      source_tag: 'text-deterministic-V',
    };
  }

  const threshM = row.title.match(SOCIAL_COUNT_THRESHOLD_RX);
  if (threshM?.groups) {
    const unit = threshM.groups.unit.toLowerCase().replace(/s$/, '');
    const monotone = unit !== 'follower' && unit !== 'subscriber';
    const tuple = emitCondition({
      archetype: monotone ? 'cumulative_count' : 'path_touch',
      ...(monotone ? { arm: 'above' as const, legacyMonotonicArm: true } : {}),
      tag: 'text-deterministic-V',
      eventKind: 'social_media_metric',
      metric: 'count',
      direction: 'above',
      temporal: 'during_period',
      value: { primary: parseSocialValue(threshM.groups.value), unit },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: threshM.groups.person.trim(),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'person',
      source_tag: 'text-deterministic-V',
    };
  }

  return null;
}

const PERSON_SAY_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)\s+say\s+["""'](?<word>[^"""']+)["""'](?:\s+\d+\+?\s+(?:or\s+more\s+)?times?)?\s+during\s+.+\??$/iu;
const PERSON_SAY_OR_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)\s+say\s+["""'](?<word1>[^"""']+)["""']\s+or\s+["""'](?<word2>[^"""']+)["""'](?:\s+\d+\+?\s+times?)?\s+during\s+.+\??$/iu;

function tryTemplatePersonSaysWord(row: CandidateRow): TemplateMatch | null {
  if (!isPoliticalCategory(row.category_unified) && row.category_unified !== 'entertainment') return null;

  const dateFromDescription = row.description
    ? extractEventDate({
        platform: row.platform,
        platform_id: row.platform_id,
        title: row.description,
        slug: null,
        end_date: row.end_date,
      })
    : null;

  const orM = row.title.match(PERSON_SAY_OR_RX);
  if (orM?.groups) {
    return {
      subject_raw: orM.groups.person.trim(),
      participants_raw: [],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: `${orM.groups.word1}|${orM.groups.word2}`,
      event_kind: 'speech_mention',
      entity_type: 'person',
      source_tag: 'text-deterministic-W',
      condition_date_override: dateFromDescription?.iso ?? null,
      condition_date_precision_override: dateFromDescription?.precision ?? null,
      condition_date_source_override: dateFromDescription ? `description-${dateFromDescription.source}` : null,
    };
  }

  const m = row.title.match(PERSON_SAY_RX);
  if (!m?.groups) return null;

  return {
    subject_raw: m.groups.person.trim(),
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: m.groups.word,
    event_kind: 'speech_mention',
    entity_type: 'person',
    source_tag: 'text-deterministic-W',
    condition_date_override: dateFromDescription?.iso ?? null,
    condition_date_precision_override: dateFromDescription?.precision ?? null,
    condition_date_source_override: dateFromDescription ? `description-${dateFromDescription.source}` : null,
  };
}

const BE_SAID_COUNT_RX =
  /^will\s+["“”'](?<word>[^"“”']+)["“”']\s+be\s+said\s+(?<n>\d+)\s*\+?\s*times?\s+during\s+(?<occasion>.+?)\??$/iu;

function tryTemplateWCount(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;

  const m = row.title.match(BE_SAID_COUNT_RX);
  if (!m?.groups) return null;
  const n = parseInt(m.groups.n, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const tuple = emitCondition({
    archetype: 'cumulative_count',
    arm: 'above',
    legacyMonotonicArm: true,
    tag: 'text-deterministic-W-count',
    eventKind: 'speech_mention',
    metric: 'count',
    direction: 'above',
    temporal: 'during_period',
    value: { primary: n, unit: 'times' },
  }, 'text-det');
  if (!tuple) return null;

  return {
    subject_raw: m.groups.occasion.trim(),
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    outcome_label: m.groups.word.trim(),
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-W-count',
  };
}

const APPROVAL_RANGE_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)'s?\s+(?:[\w]+\s+)?approval\s+rating\s+be\s+between\s+(?<lo>[\d.]+)%?\s+(?:and|[-–])\s+(?<hi>[\d.]+)%?(?:\s+on\s+.+)?\??$/iu;
const APPROVAL_THRESHOLD_RX =
  /^will\s+(?<person>[\p{Lu}][\p{L}\p{M}\s.']+?)'s?\s+(?:[\w]+\s+)?approval\s+rating\s+(?:be\s+)?(?<verb>above|below|hit|reach|exceed|<|>|≤|≥|≥?\s*|<=?\s*)\s*(?<value>[\d.]+)%?(?:\s+or\s+(?<dir>more|less|higher|lower))?(?<tail>\s+.+)?\??$/iu;
const APPROVAL_IN_YEAR_TAIL_RX = /^\s*in\s+(20\d{2})\s*\?*\s*$/i;
const APPROVAL_TOUCH_VERB_RX = /^(?:hit|reach|exceed)(?:s|es)?$/i;

function tryTemplateApprovalRating(row: CandidateRow): TemplateMatch | null {
  if (!isPoliticalCategory(row.category_unified)) return null;

  const rangeM = row.title.match(APPROVAL_RANGE_RX);
  if (rangeM?.groups) {
    const tuple = emitCondition({
      archetype: 'terminal_range',
      tag: 'text-deterministic-X',
      eventKind: 'approval_rating',
      metric: 'percentage',
      temporal: 'on_date',
      value: { primary: parseFloat(rangeM.groups.lo), secondary: parseFloat(rangeM.groups.hi), unit: 'percent' },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: rangeM.groups.person.trim(),
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'person',
      source_tag: 'text-deterministic-X',
    };
  }

  const threshM = row.title.match(APPROVAL_THRESHOLD_RX);
  if (!threshM?.groups) return null;

  const verb = (threshM.groups.verb ?? '').trim().toLowerCase();
  const dir = (threshM.groups.dir ?? '').toLowerCase();
  const direction: ConditionDirection =
    dir === 'less' || dir === 'lower' || verb === 'below' || verb === '<' || verb === '<=' ? 'below' : 'above';

  const tail = threshM.groups.tail ?? '';
  const isYearWindowTouch =
    APPROVAL_TOUCH_VERB_RX.test(verb) && APPROVAL_IN_YEAR_TAIL_RX.test(tail);
  const tuple = emitCondition(
    isYearWindowTouch
      ? {
          archetype: 'path_touch',
          tag: 'text-deterministic-X',
          eventKind: 'approval_rating',
          metric: 'percentage',
          direction,
          temporal: 'during_period',
          value: { primary: parseFloat(threshM.groups.value), unit: 'percent' },
        }
      : {
          archetype: 'terminal_threshold',
          tag: 'text-deterministic-X',
          eventKind: 'approval_rating',
          metric: 'percentage',
          direction,
          temporal: 'on_date',
          value: { primary: parseFloat(threshM.groups.value), unit: 'percent' },
        },
    'text-det');
  if (!tuple) return null;
  return {
    subject_raw: threshM.groups.person.trim(),
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'person',
    source_tag: 'text-deterministic-X',
  };
}

const WIN_THE_MATCH_RX =
  /^Will\s+(?<who>[\p{L}][\p{L}\p{M}\s./'\-]+?)\s+win\s+the\s+(?<event>.+?)\s+(?:match|game|fight)(?:\s+scheduled\s+for\s+[^?]+?)?\s*\??$/iu;

const WIN_THE_MATCH_SPORT_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  [/\bleague\s+of\s+legends\b/i,              'league of legends'],
  [/\bcounter[- ]strike(?:\s+2)?\b|\bcs\s*2\b|\bcs:?\s*go\b/i, 'cs2'],
  [/\bdota\s+2\b/i,                            'dota 2'],
  [/\brocket\s+league\b/i,                     'rocket league'],
  [/\bstarcraft(?:\s+2|\s+ii)?\b/i,            'starcraft 2'],
  [/\bcall\s+of\s+duty\b/i,                    'call of duty'],
  [/\brainbow\s+six\b/i,                       'rainbow six'],
  [/\bovervatch(?:\s+2)?\b|\boverwatch(?:\s+2)?\b/i, 'overwatch 2'],
  [/\bvalorant\b/i,                            'valorant'],
  [/\bpro\s+football\b|\bcollege\s+football\b|\bamerican\s+football\b/i, 'american football'],
  [/\bdarts\b/i,      'darts'],
  [/\btennis\b/i,     'tennis'],
  [/\bbasketball\b/i, 'basketball'],
  [/\bbaseball\b/i,   'baseball'],
  [/\bhockey\b/i,     'ice hockey'],
  [/\bsoccer\b/i,     'soccer'],
  [/\bgolf\b/i,       'golf'],
  [/\bcricket\b/i,    'cricket'],
  [/\bchess\b/i,      'chess'],
  [/\bsumo\b/i,       'sumo'],
  [/\bmma\b/i,        'mma'],
  [/\bboxing\b/i,     'boxing'],
  [/\bnascar\b/i,     'nascar'],
  [/\blacrosse\b/i,   'lacrosse'],
  [/\bsnooker\b/i,    'snooker'],
];

const TEAM_BASED_MATCH_SPORTS: ReadonlySet<string> = new Set([
  // KB canonicals — must match WIN_THE_MATCH_SPORT_KEYWORDS output AND the
  // sport rows seeded in seed-entity-kb.ts.
  'league of legends', 'cs2', 'dota 2', 'rocket league',
  'starcraft 2', 'call of duty', 'rainbow six', 'overwatch 2', 'valorant',
  'american football',
]);

const AMERICAN_FOOTBALL_GAME_TICKERS: ReadonlySet<string> = new Set([
  'KXNFLGAME', 'KXNCAAFGAME', 'KXCFLGAME',
]);
function americanFootballFromTicker(eventTicker: string | null): string | null {
  if (!eventTicker) return null;
  return AMERICAN_FOOTBALL_GAME_TICKERS.has(eventTicker.split('-')[0] ?? '')
    ? 'american football' : null;
}

const WIN_THE_MATCH_SPORT_TOURNAMENT_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:W|M)\d+\b/i,        'tennis'],
  [/\bATP\b|\bWTA\b|\bITF\b/, 'tennis'],
  [/\b(?:Wimbledon|US\s+Open|Australian\s+Open|Roland\s+Garros|French\s+Open)\b/i, 'tennis'],
  [/\bPDC\b|\bUK\s+Open\b|\bPremier\s+League\s+Darts\b/i, 'darts'],
];

function detectMatchSport(title: string): string | null {
  for (const [rx, canonical] of WIN_THE_MATCH_SPORT_KEYWORDS) {
    if (rx.test(title)) return canonical;
  }
  for (const [rx, canonical] of WIN_THE_MATCH_SPORT_TOURNAMENT_HINTS) {
    if (rx.test(title)) return canonical;
  }
  return null;
}

const WIN_THE_MATCH_EVENT_SPLIT_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s./'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s./'\-]+?)(?:\s*:\s*(?<ctx>.+?))?(?:\s+(?:league\s+of\s+legends|counter[- ]strike(?:\s+2)?|cs\s*2|cs:?\s*go|dota\s+2|rocket\s+league|starcraft(?:\s+2|\s+ii)?|call\s+of\s+duty|rainbow\s+six|overwatch(?:\s+2)?|valorant|pro\s+football|college\s+football|american\s+football|professional\s+mma|football|darts|tennis|basketball|baseball|hockey|soccer|golf|cricket|chess|sumo|mma|boxing|nascar|lacrosse|snooker))?$/iu;

function tryTemplateKalshiH2hWinner(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;

  const m = row.title.match(WIN_THE_MATCH_RX);
  if (!m?.groups) return null;
  const who = m.groups.who.trim();
  const event = m.groups.event.trim();

  const split = event.match(WIN_THE_MATCH_EVENT_SPLIT_RX);
  if (!split?.groups) return null;
  const a = split.groups.a.trim();
  const b = split.groups.b.trim();
  const ctx = split.groups.ctx?.trim();
  const canonicalEvent = ctx ? `${a} vs ${b}: ${ctx}` : `${a} vs ${b}`;
  const detectedSport = detectMatchSport(row.title) ?? americanFootballFromTicker(row.event_ticker);
  const entityType: 'team' | 'person' =
    detectedSport && TEAM_BASED_MATCH_SPORTS.has(detectedSport) ? 'team' : 'person';

  // Binary fixture outcome: derives binary_event with null direction/values;
  // null temporal is legal for the binary topology.
  const tuple = emitCondition({
    archetype: 'fixture_outcome',
    topology: 'standalone_binary',
    tag: 'text-deterministic-Y',
    eventKind: 'match_winner',
    metric: null,
    temporal: null,
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: who,
    participants_raw: [a, b],
    ...tupleToTemplateFields(tuple),
    entity_type: entityType,
    source_tag: 'text-deterministic-Y',
    sport_canonical: detectedSport,
    canonical_event_override: canonicalEvent,
  };
}

const EXACT_SCORE_RX =
  /^Exact\s+Score:\s+(?<a>.+?)\s+(?<sa>\d)\s+-\s+(?<sb>\d)\s+(?<b>.+?)\??$/u;
const EXACT_SCORE_ANY_OTHER_RX =
  /^Exact\s+Score:\s+Any\s+Other\s+Score\??$/i;

const PARENT_EVENT_VS_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s*$/u;

function stripParentEventMarketSuffix(title: string): string {
  const idx = title.lastIndexOf(' - ');
  if (idx <= 0) return title;
  return title.slice(0, idx).trim();
}

export function deriveCanonicalEvent(input: {
  template: TemplateMatch;
  canonical_subject: string;
  canonicalParticipants: string[];
  categoryUnified: string | null;
  title: string;
  nonKalshiEventTitle: string | null;
  eventDateIso: string | null;
}): string {
  const { template: tpl, canonical_subject, canonicalParticipants,
          categoryUnified, title, nonKalshiEventTitle, eventDateIso } = input;
  const rawCe = tpl.canonical_event_override
    ?? (nonKalshiEventTitle ? stripParentEventMarketSuffix(nonKalshiEventTitle) : null)
    ?? title;

  let core = deriveCanonicalEventCore({
    eventKind: tpl.event_kind,
    conditionShape: tpl.condition_shape,
    conditionMetric: tpl.condition_metric,
    valueUnit: tpl.value_unit,
    rawCanonicalEvent: rawCe,
    canonicalSubject: canonical_subject,
    canonicalParticipants,
    categoryUnified,
    eventDateIso,
  });
  if (tpl.canonical_event_tour && tpl.event_kind === 'championship_winner') {
    core = qualifyTourCanonicalEvent(core, tpl.canonical_event_tour);
  }
  return tpl.canonical_event_suffix ? `${core} ${tpl.canonical_event_suffix}` : core;
}

function extractAnyOtherTeams(row: CandidateRow): { a: string; b: string } | null {
  const candidates = [row.non_kalshi_event_title, row.event_match_context];
  for (const c of candidates) {
    if (!c) continue;
    const cleaned = stripParentEventMarketSuffix(c.trim());
    const m = cleaned.match(PARENT_EVENT_VS_RX);
    if (!m?.groups) continue;
    const a = m.groups.a.trim();
    const b = m.groups.b.trim();
    if (a.length < 2 || b.length < 2) continue;
    return { a, b };
  }
  return null;
}

function tryTemplateExactScore(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;

  if (EXACT_SCORE_ANY_OTHER_RX.test(row.title)) {
    const teams = extractAnyOtherTeams(row);
    if (!teams) return null;
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-Z',
      eventKind: 'exact_score',
      metric: null,
      direction: null,
      temporal: 'at_resolution',
      outcomeLabel: 'any_other',
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: teams.a,
      participants_raw: [teams.b],
      ...tupleToTemplateFields(tuple),
      entity_type: 'team',
      source_tag: 'text-deterministic-Z',
      canonical_event_override: teams.a.toLowerCase() < teams.b.toLowerCase()
        ? `${teams.a} vs ${teams.b}`
        : `${teams.b} vs ${teams.a}`,
    };
  }

  const m = row.title.match(EXACT_SCORE_RX);
  if (!m?.groups) return null;
  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  const sa = parseInt(m.groups.sa, 10);
  const sb = parseInt(m.groups.sb, 10);

  // Both team names must be substantial — refuse single-character or empty
  // captures that could only arise from a regex misfire.
  if (a.length < 2 || b.length < 2) return null;

  const tuple = emitCondition({
    archetype: 'categorical_selection',
    tag: 'text-deterministic-Z',
    eventKind: 'exact_score',
    metric: null,
    direction: null,
    temporal: 'at_resolution',
    value: { primary: sa, secondary: sb, unit: 'goals' },
    outcomeLabel: `${sa}-${sb}`,
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: a,
    participants_raw: [b],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    source_tag: 'text-deterministic-Z',
    canonical_event_override: a.toLowerCase() < b.toLowerCase()
      ? `${a} vs ${b}`
      : `${b} vs ${a}`,
  };
}

const FDV_LAUNCH_RX = /^(?<project>[\p{L}\p{M}][\p{L}\p{M}\d\s.'\-]*?)\s+FDV\s+above\s+\$?(?<amt>[\d.,]+)\s*(?<unit>K|M|B)?\s+one\s+day\s+after\s+launch\s*\??$/iu;

function tryTemplateCryptoLaunchFdv(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'crypto') return null;
  const m = row.title.match(FDV_LAUNCH_RX);
  if (!m?.groups) return null;
  const project = m.groups.project.trim();
  const amtNum = parseFloat(m.groups.amt.replace(/,/g, ''));
  if (!isFinite(amtNum) || amtNum <= 0) return null;
  const mult = m.groups.unit === 'B' ? 1e9
              : m.groups.unit === 'M' ? 1e6
              : m.groups.unit === 'K' ? 1e3 : 1;
  const valueUsd = amtNum * mult;
  const tuple = emitCondition({
    archetype: 'path_touch',
    tag: 'text-deterministic-AA',
    eventKind: 'crypto_launch_fdv',
    metric: 'price',
    direction: 'above',
    temporal: 'during_period',
    value: { primary: valueUsd, unit: 'USD' },
    date: { forceNull: true },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: project,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    source_tag: 'text-deterministic-AA',
    resolution_source: null,
    canonical_event_override: `${project} launch FDV`.toLowerCase(),
  };
}

const TOKEN_LAUNCH_RX = /^Will\s+(?<project>[\p{L}\p{M}][\p{L}\p{M}\d\s.'\-]*?)\s+launch\s+a\s+token\s+by\s+(?<date>.+?)\s*\??$/iu;

function tryTemplateTokenLaunchByDate(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'crypto') return null;
  const m = row.title.match(TOKEN_LAUNCH_RX);
  if (!m?.groups) return null;
  const project = m.groups.project.trim();
  const tuple = emitCondition({
    archetype: 'event_occurrence',
    tag: 'text-deterministic-AB',
    eventKind: 'token_launch',
    metric: null,
    temporal: 'by_date',
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: project,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    source_tag: 'text-deterministic-AB',
    resolution_source: null,
    canonical_event_override: `${project} token launch`.toLowerCase(),
  };
}

const FINISH_TOPN_RX =
  /^Will\s+(?<player>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+finish\s+in\s+(?:the\s+)?Top\s+(?<n>\d+)\s+at\s+(?:the\s+)?(?:(?<year>20\d{2})\s+)?(?<tournament>.+?)\s*\??$/iu;

function tryTemplatePlayerFinishPosition(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  const m = row.title.match(FINISH_TOPN_RX);
  if (!m?.groups) return null;
  const player = m.groups.player.trim();
  const n = parseInt(m.groups.n, 10);
  const year = m.groups.year;
  const tournament = m.groups.tournament.trim();
  if (!isFinite(n) || n <= 0) return null;
  return {
    subject_raw: player,
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: n,
    value_secondary: null,
    value_unit: 'rank',
    outcome_label: null,
    event_kind: 'player_prop_threshold',
    entity_type: 'person',
    source_tag: 'text-deterministic-AC',
    resolution_source: null,
    canonical_event_override: year ? `${year} ${tournament.toLowerCase()}` : tournament.toLowerCase(),
  };
}

const PREDICT_ARROW_TITLE_RX =
  /^(?<dir>[↑↓])\s*\$?(?<value>[\d.,]+)(?<pct>%)?\s*$/u;

const PREDICT_COMMODITY_SLUG_RX =
  /^(?<ticker>[a-z]{1,4})-hit-(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(?<year>20\d{2})$/i;

const PREDICT_STOCK_SLUG_RX =
  /^what-price-will-(?<ticker>[a-z0-9]+)-hit-in-(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(?<year>20\d{2})$/i;

// Slug for "what-will-fed-rate-hit-before-{year}".
const PREDICT_FEDRATE_SLUG_RX = /^what-will-fed-rate-hit-before-(?<year>20\d{2})$/i;

const PREDICT_TICKER_TO_NAME: Record<string, string> = {
  SI: 'Silver',
  GC: 'Gold',
  WTI: 'Crude Oil',
  CL: 'Crude Oil',
  NG: 'Natural Gas',
  AAPL: 'Apple',
  AMZN: 'Amazon',
  COIN: 'Coinbase',
  GOOGL: 'Alphabet',
  META: 'Meta',
  NFLX: 'Netflix',
  NVDA: 'Nvidia',
  PLTR: 'Palantir',
  SPY: 'S&P 500',
  TSLA: 'Tesla',
};

const MONTH_TO_NAME: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April',
  may: 'May', jun: 'June', jul: 'July', aug: 'August',
  sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};

function tryTemplatePredictArrowPriceThreshold(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict') return null;
  if (row.category_unified !== 'economic') return null;
  if (!row.market_category) return null;
  const titleMatch = row.title.match(PREDICT_ARROW_TITLE_RX);
  if (!titleMatch?.groups) return null;

  const dir = titleMatch.groups.dir as '↑' | '↓';
  const value = parseFloat(titleMatch.groups.value.replace(/,/g, ''));
  const isPct = titleMatch.groups.pct === '%';
  if (!isFinite(value) || value <= 0) return null;

  const direction: ConditionDirection = dir === '↑' ? 'above' : 'below';

  // Try the three slug shapes in order of specificity.
  const stockMatch = row.market_category.match(PREDICT_STOCK_SLUG_RX);
  const commodityMatch = !stockMatch ? row.market_category.match(PREDICT_COMMODITY_SLUG_RX) : null;
  const fedRateMatch = !stockMatch && !commodityMatch ? row.market_category.match(PREDICT_FEDRATE_SLUG_RX) : null;

  let ticker: string;
  let year: number;
  let monKey: string | null;
  let canonicalEventOverride: string;
  let conditionDate: string;
  if (stockMatch?.groups) {
    ticker = stockMatch.groups.ticker.toUpperCase();
    year = parseInt(stockMatch.groups.year, 10);
    monKey = stockMatch.groups.mon.toLowerCase();
    const assetName = PREDICT_TICKER_TO_NAME[ticker] ?? ticker;
    canonicalEventOverride = `Will ${assetName} (${ticker}) hit__ by end of ${MONTH_TO_NAME[monKey]}?`;
    const stamped = stampConditionDate({ kind: 'monthToken', mon: monKey, year, pad: 'end' });
    if (!stamped) return null;
    conditionDate = stamped.iso;
  } else if (commodityMatch?.groups) {
    ticker = commodityMatch.groups.ticker.toUpperCase();
    year = parseInt(commodityMatch.groups.year, 10);
    monKey = commodityMatch.groups.mon.toLowerCase();
    const assetName = PREDICT_TICKER_TO_NAME[ticker] ?? ticker;
    canonicalEventOverride = `Will ${assetName} (${ticker}) hit__ by end of ${MONTH_TO_NAME[monKey]}?`;
    const stamped = stampConditionDate({ kind: 'monthToken', mon: monKey, year, pad: 'end' });
    if (!stamped) return null;
    conditionDate = stamped.iso;
  } else if (fedRateMatch?.groups) {
    ticker = 'FED';
    year = parseInt(fedRateMatch.groups.year, 10);
    monKey = null;
    canonicalEventOverride = `Fed Funds Rate by end of ${year}`;
    conditionDate = `${year - 1}-12-31`;
  } else {
    return null;
  }

  const tuple = emitCondition({
    archetype: 'path_touch',
    tag: 'text-deterministic-AD',
    eventKind: 'price_threshold',
    metric: 'price',
    direction,
    temporal: 'by_date',
    value: { primary: value, unit: isPct ? null : 'USD' },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: ticker,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    source_tag: 'text-deterministic-AD',
    resolution_source: null,
    canonical_event_override: canonicalEventOverride,
    condition_date_override: conditionDate,
    condition_date_precision_override: 'day',
    condition_date_source_override: 'predict-category-slug',
  };
}

const COALITION_RX =
  /^(?:will\s+(?:the\s+)?(?:next\s+)?governing\s+coalition\s+(?:government\s+)?of\s+(?<country>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+(?:include|contain|consist\s+of|be\s+formed\s+by)\s+(?<parties>[\w\s\-/.&+]+?))\s*\??$/iu;

function tryTemplateCoalitionComposition(row: CandidateRow): TemplateMatch | null {
  if (!isPoliticalCategory(row.category_unified)) return null;
  const m = row.title.match(COALITION_RX);
  if (!m?.groups) return null;
  const country = m.groups.country.trim();
  const rawList = m.groups.parties.trim();
  const parties = rawList
    .split(/\s*(?:\+|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 1 && p.length <= 40);
  if (parties.length === 0) return null;
  // Sort + dedupe for hash-stable canonical_key regardless of listed order.
  const partySet = [...new Set(parties)].sort();
  return {
    subject_raw: country,
    participants_raw: partySet,
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: 'by_date',
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: partySet.join('+').toLowerCase(),
    event_kind: 'governing_coalition',
    entity_type: 'location',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-AE',
    canonical_event_override: `${country} governing coalition`.toLowerCase(),
  };
}

const KALSHI_TOTALS_RX =
  /^Will\s+(?<dir>over|under)\s+(?<value>\d+(?:\.\d+)?)\s+(?<metric>goals?|cards?|corners?|points?|runs?|sets?|games?|kills?|hits?|bases?|rebounds?|assists?|sixes?|fouls?)\s+be\s+scored\??$/i;
const KALSHI_BTTS_RX = /^Will\s+both\s+teams?\s+score\??$/i;
const KALSHI_EVENT_TITLE_VS_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'\-]+?)(?::\s*.+)?$/iu;

function tryTemplateKalshiTotalsBtts(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;
  if (!row.event_title) return null;
  const teamsM = row.event_title.match(KALSHI_EVENT_TITLE_VS_RX);
  if (!teamsM?.groups) return null;
  const a = teamsM.groups.a.trim();
  const b = teamsM.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;

  if (KALSHI_BTTS_RX.test(row.title)) {
    return {
      subject_raw: a,
      participants_raw: [b],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'both_teams_score',
      entity_type: 'team',
      source_tag: 'text-deterministic-AF',
    };
  }

  const totalsM = row.title.match(KALSHI_TOTALS_RX);
  if (totalsM?.groups) {
    const rawValue = parseFloat(totalsM.groups.value);
    const direction: ConditionDirection = totalsM.groups.dir.toLowerCase() === 'over' ? 'above' : 'below';
    const metric = totalsM.groups.metric.toLowerCase();
    const unit = metric.endsWith('s') ? metric : `${metric}s`;
    const value = canonicalizeIntegerThreshold({
      direction: direction === 'below' ? 'below' : 'above', value: rawValue, unit, strictness: 'strict',
    }).value;
    return {
      subject_raw: a,
      participants_raw: [b],
      condition_shape: 'monotonic_threshold',
      condition_direction: direction,
      condition_metric: null,
      temporal_semantics: 'during_period',
      value_primary: value,
      value_secondary: null,
      value_unit: unit,
      outcome_label: null,
      event_kind: 'match_total_metric',
      entity_type: 'team',
      source_tag: 'text-deterministic-AF',
    };
  }

  return null;
}


function splitColonSuffix(title: string): { context: string; outcome: string } | null {
  const idx = title.lastIndexOf(': ');
  if (idx < 0) return null;
  const context = title.slice(0, idx).trim();
  const outcome = title.slice(idx + 2).trim();
  if (!context || !outcome) return null;
  return { context, outcome };
}

const LIMITLESS_CATCHALL_RX =
  /^(?:others?|none|no\s+replacement|no\s+change\s*\([^)]*\)|no\s+(?:new\s+)?(?:funding|contract)\b.*|no\s+ipo\b.*|someone\s+else|other\s+candidate|tbd|tba)$/i;
function isLimitlessCatchall(outcome: string): boolean {
  return LIMITLESS_CATCHALL_RX.test(outcome.trim());
}

/** epoch-SECONDS string → ISO 'YYYY-MM-DDTHH:MM:SSZ'. Null on bad input. */
function epochSecToIso(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const n = parseInt(ts, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function limitlessEsportSport(esportTitle: string | null): string | null {
  switch ((esportTitle ?? '').toLowerCase()) {
    case 'league-of-legends': return 'league of legends';
    case 'valorant':          return 'valorant';
    case 'cs-go': case 'csgo': case 'cs2': return 'cs2';
    case 'dota-2': case 'dota2': return 'dota 2';
    default: return null;
  }
}

function tryTemplateLimitlessMatchWinner(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'sports') return null;
  if (row.limitless_market_type !== 'match_winner') return null;
  const home = (row.limitless_home_team ?? '').trim();
  const away = (row.limitless_away_team ?? '').trim();
  if (!home || !away) return null;
  const split = splitColonSuffix(row.title);
  if (!split) return null;
  const suffix = split.outcome;

  const isFootball = (row.limitless_sport_type ?? '').toLowerCase() === 'football';
  const sport = isFootball ? 'soccer' : limitlessEsportSport(row.limitless_esport_title);

  const base = {
    participants_raw: [] as string[],
    condition_shape: 'binary_event' as ConditionShape,
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    event_kind: 'match_winner' as EventKind,
    entity_type: 'team' as const,
    participant_type_confidence: 'high' as const,
    subject_native_verified: true,
    sport_canonical: sport,
    source_tag: 'limitless:match-winner',
    condition_date_override: epochSecToIso(row.limitless_start_ts),
    condition_date_precision_override: 'minute' as const,
    condition_date_source_override: 'limitless-match-start',
  };

  if (/^draw$/i.test(suffix)) {
    const draw = nativeDraw();
    return { ...base, subject_raw: draw.subject_raw, participants_raw: [home, away], outcome_label: draw.outcome_label };
  }
  if (suffix === home) return { ...base, subject_raw: home, participants_raw: [away], outcome_label: null };
  if (suffix === away) return { ...base, subject_raw: away, participants_raw: [home], outcome_label: null };
  return null;
}

const LIMITLESS_ELECTION_CTX_RX =
  /(election|nominee|presidential|gubernatorial|mayoral|prime\s+minister|party\s+winner|which\s+party)/i;
function tryTemplateLimitlessElection(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'election' && row.category_unified !== 'politics') return null;
  if (!row.limitless_event_id) return null;
  const split = splitColonSuffix(row.title);
  if (!split) return null;
  if (!LIMITLESS_ELECTION_CTX_RX.test(split.context)) return null;
  if (isLimitlessCatchall(split.outcome)) return null;
  const outcome = split.outcome.replace(/\s*\([A-Za-z.]{1,6}\)\s*$/, '').trim();
  if (outcome.length < 2) return null;
  return {
    subject_raw: outcome,
    participants_raw: [],
    condition_shape: 'categorical_outcome',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'election_outcome_winner',
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'limitless:election',
    canonical_event_override: split.context,
  };
}

const LIMITLESS_PRICE_BUCKET_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 .]+?)\s+price\s+on\s+(?<date>.+?)\?:\s*(?<bucket>.+)$/i;
const LIMITLESS_ATH_RX =
  /^(?<asset>[A-Z][A-Za-z0-9 .]+?)\s+all\s+time\s+high\s+by\s+(?<date>[A-Za-z]+\s+\d{1,2},?\s*\d{4})\??$/i;
const BUCKET_BELOW_RX = /^[<＜]\s*(?<hi>[\d.]+)\s*(?<u>[kmb])?$/i;
const BUCKET_ABOVE_RX = /^[≥>]\s*(?<lo>[\d.]+)\s*(?<u>[kmb])?$/i;
const BUCKET_RANGE_RX = /^(?<lo>[\d.]+)\s*[-–]\s*(?<hi>[\d.]+)\s*(?<u>[kmb])?$/i;
function bucketMult(u?: string): number {
  switch ((u ?? '').toLowerCase()) { case 'k': return 1e3; case 'm': return 1e6; case 'b': return 1e9; default: return 1; }
}
function limitlessTitleDate(dateStr: string, endDate: string | null): string | null {
  if (!/\d{4}/.test(dateStr) && !endDate) return null;
  const stamped = stampConditionDate({ kind: 'monthDay', text: dateStr, endDate });
  return stamped ? `${stamped.iso}T00:00:00Z` : null;
}
function tryTemplateLimitlessCrypto(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'crypto') return null;

  const pb = row.title.match(LIMITLESS_PRICE_BUCKET_RX);
  if (pb?.groups) {
    const asset = extractAssetName(pb.groups.asset.trim());
    const bucket = pb.groups.bucket.trim();
    const range = bucket.match(BUCKET_RANGE_RX);
    const below = bucket.match(BUCKET_BELOW_RX);
    const above = bucket.match(BUCKET_ABOVE_RX);
    let dir: ConditionDirection | null = null, vp: number, vs: number | null = null;
    if (range?.groups) {
      vp = parseFloat(range.groups.lo) * bucketMult(range.groups.u);
      vs = parseFloat(range.groups.hi) * bucketMult(range.groups.u);
    } else if (below?.groups) {
      dir = 'below'; vp = parseFloat(below.groups.hi) * bucketMult(below.groups.u);
    } else if (above?.groups) {
      dir = 'above'; vp = parseFloat(above.groups.lo) * bucketMult(above.groups.u);
    } else {
      return null;
    }
    const tuple = emitCondition({
      archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
      tag: 'limitless:crypto-bucket',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: dir,
      temporal: 'on_date',
      value: { primary: vp, secondary: vs, unit: 'USD' },
      outcomeLabel: bucket,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: asset,
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:crypto-bucket',
      resolution_source: cryptoResolutionSource(row.category_unified),
      canonical_event_override: `${asset} price on ${pb.groups.date.trim()}`,
      condition_date_override: limitlessTitleDate(pb.groups.date.trim(), row.end_date),
      condition_date_precision_override: 'day',
      condition_date_source_override: 'limitless-title-date',
    };
  }

  const ath = row.title.match(LIMITLESS_ATH_RX);
  if (ath?.groups) {
    const asset = extractAssetName(ath.groups.asset.trim());
    const tuple = emitCondition({
      archetype: 'bespoke',
      tag: 'limitless:crypto-ath',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: 'above',
      temporal: 'by_date',
      bespoke: {
        shape: 'binary_event',
        justification: 'dynamic prior-ATH strike: value unknowable at normalization (null value_primary) ' +
          'with direction above + metric price on a binary — no archetype reproduces it; live stamp ' +
          'pinned verbatim pending the ATH-direction adjudication (P9).',
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: asset,
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:crypto-ath',
      resolution_source: cryptoResolutionSource(row.category_unified),
      canonical_event_override: `${asset} all time high`,
      condition_date_override: limitlessTitleDate(ath.groups.date.trim(), row.end_date),
      condition_date_precision_override: 'day',
      condition_date_source_override: 'limitless-title-date',
    };
  }
  return null;
}

const LIMITLESS_GROUP_WINNER_RX = /\bgroup\s+[A-Z]{1,2}\s+winner$/i;
const LIMITLESS_CONF_CHAMP_RX   = /\bconference\s+champion$/i;
const LIMITLESS_STAT_AWARD_RX   = /\b(?:top\s+goalscorer|top\s+scorer(?:\s*\(nation\))?|most\s+(?:assists|goal\s+contributions|cards|goals))$/i;
const LIMITLESS_INDIV_AWARD_RX  = /\b(?:ballon\s*d['’]?or|player\s+of\s+the\s+year|drivers['’]?\s+champion|constructors['’]?\s+champion)\b/i;
const LIMITLESS_WHICH_WIN_RX    = /^which\s+(?<noun>continent|team|nation)\s+will\b.*\?$/i;
const LIMITLESS_SQUAD_RX        = /\bplayer\s+to\s+make\s+.+\s+squad$/i;
const LIMITLESS_ADVANCE_RX      = /\b(?:nation\s+to\s+reach\s+final|team\s+to\s+advance\s+to\s+.+|team\s+to\s+qualify\s+for\s+.+)$/i;
const LIMITLESS_NEXT_MANAGER_RX = /\bnext\s+.*\bmanager\b/i;
const LIMITLESS_NEXT_MGR_CLUB_RX = /\bnext\s+(?:permanent\s+)?(?<club>.+?)\s+manager\b/i;
const LIMITLESS_WHICH_LEAGUE_RX = /^which\s+league\s+will\s+.+\s+play\s+in\s+next\??$/i;
const LIMITLESS_NTH_PLACE_RX    = /\b\d+(?:st|nd|rd|th)\s+place$/i;
const LIMITLESS_MVP_RX          = /\bnamed\s+.*\bmvp\b/i;
const LIMITLESS_WINNER_CHAMP_RX = /\b(?:winner|champion)$/i;
function tryTemplateLimitlessSportsLadder(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'sports') return null;
  if (row.limitless_market_type === 'match_winner') return null;
  if (!row.limitless_event_id) return null;
  const split = splitColonSuffix(row.title);
  if (!split) return null;
  const { context, outcome } = split;
  if (isLimitlessCatchall(outcome)) return null;

  const winnerPick = (entity: 'team' | 'person' | 'location'): TemplateMatch => ({
    subject_raw: outcome,
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    outcome_label: null,
    event_kind: 'championship_winner',
    entity_type: entity,
    participant_type_confidence: 'low',
    source_tag: 'limitless:sports-winner',
    canonical_event_override: context,
  });
  const independentBinary = (entity: 'team' | 'person', eventKind: EventKind, tag: string): TemplateMatch => ({
    subject_raw: outcome,
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: eventKind,
    entity_type: entity,
    participant_type_confidence: entity === 'person' ? 'high' : 'low',
    source_tag: tag,
    canonical_event_override: context,
  });
  const categoricalPick = (entity: 'team' | 'person', eventKind: EventKind, tag: string): TemplateMatch => ({
    subject_raw: outcome,
    participants_raw: [],
    condition_shape: 'categorical_outcome',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: eventKind,
    entity_type: entity,
    participant_type_confidence: 'low',
    source_tag: tag,
    canonical_event_override: context,
  });

  if (LIMITLESS_GROUP_WINNER_RX.test(context)) return winnerPick('team');
  if (LIMITLESS_CONF_CHAMP_RX.test(context))   return winnerPick('team');
  if (LIMITLESS_STAT_AWARD_RX.test(context))   return winnerPick(/\(nation\)/i.test(context) ? 'team' : 'person');
  if (LIMITLESS_INDIV_AWARD_RX.test(context))  return winnerPick(/constructors/i.test(context) ? 'team' : 'person');
  const whichWin = context.match(LIMITLESS_WHICH_WIN_RX);
  if (whichWin?.groups) return winnerPick(whichWin.groups.noun.toLowerCase() === 'continent' ? 'location' : 'team');
  if (LIMITLESS_MVP_RX.test(context))          return categoricalPick('person', 'award_winner', 'limitless:sports-mvp');
  if (LIMITLESS_SQUAD_RX.test(context))        return independentBinary('person', 'other', 'limitless:squad');
  if (LIMITLESS_ADVANCE_RX.test(context))      return independentBinary('team', 'stage_advance', 'limitless:advance');
  if (LIMITLESS_NEXT_MANAGER_RX.test(context)) {
    const mgrM = context.match(LIMITLESS_NEXT_MGR_CLUB_RX);
    return {
      subject_raw: outcome,
      participants_raw: mgrM?.groups?.club ? [mgrM.groups.club.trim()] : [],
      condition_shape: 'categorical_outcome',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: 'at_resolution',
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'personnel_move',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'limitless:next-manager',
    };
  }
  if (LIMITLESS_WHICH_LEAGUE_RX.test(context)) return categoricalPick('team', 'other', 'limitless:sports-pickone');
  if (LIMITLESS_NTH_PLACE_RX.test(context))    return categoricalPick('team', 'other', 'limitless:sports-pickone');
  if (LIMITLESS_WINNER_CHAMP_RX.test(context)) return winnerPick('team');
  return null;
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const LIMITLESS_INFLATION_RX = new RegExp(`^(?<mon>${MONTHS})\\s+Inflation\\s+US\\s*-\\s*(?<freq>Annual|Monthly)$`, 'i');
const LIMITLESS_JOBS_RX = new RegExp(`^How\\s+many\\s+jobs\\s+added\\s+in\\s+(?<mon>${MONTHS})\\??$`, 'i');
const LIMITLESS_FED_RX  = new RegExp(`^Fed\\s+Decision\\s+in\\s+(?<mon>${MONTHS})\\??$`, 'i');
const LIMITLESS_NVDA_RX = new RegExp(`^What\\s+will\\s+(?<name>.+?)\\s+\\((?<ticker>[A-Z.]+)\\)\\s+hit\\s+in\\s+(?<mon>${MONTHS})\\s+(?<year>20\\d{2})\\??$`, 'i');
const PCT_CAP_LOW_RX  = /^[≤<]\s*(?<v>\d+(?:\.\d+)?)%$/;
const PCT_CAP_HIGH_RX = /^[≥>]\s*(?<v>\d+(?:\.\d+)?)%$/;
const PCT_RANGE_RX    = /^(?<lo>\d+(?:\.\d+)?)\s*[-–]\s*(?<hi>\d+(?:\.\d+)?)%?$/;
const PCT_POINT_RX    = /^(?<v>\d+(?:\.\d+)?)%$/;
const JOBS_RANGE_RX   = /^(?<lo>[\d.]+)\s*k?\s*[-–]\s*(?<hi>[\d.]+)\s*k$/i;
const JOBS_ABOVE_RX   = /^(?<lo>[\d.]+)\s*k\+$/i;
const JOBS_BELOW_RX   = /^[<]\s*(?<hi>[\d.]+)\s*k?$/i;
// The '+' (cumulative 'N+ bps') is CAPTURED — an open half-line
// bucket must not fold into the exact-move at/±N stamp.
const FED_RX          = /^(?:(?<mag>\d+)(?<plus>\+)?\s*bps\s+(?<dir>increase|decrease)|(?<nochange>No\s+change))$/i;
const ABOVEBELOW_USD_RX = /^(?<dir>above|below)\s+\$?(?<v>[\d,]+(?:\.\d+)?)$/i;
const LIMITLESS_EGGS_RX = new RegExp(`^Price of (?<subj>.+?) in (?<mon>${MONTHS})\\??$`, 'i');
const LIMITLESS_VALUATION_RX = /^(?<subj>.+?)\s+(?:IPO Closing Market Cap|next round valuation)$/i;
const LIMITLESS_ABOVE_BLANK_RX = /^(?:will\s+)?(?<subj>.+?)\s+(?:be\s+)?(?:above|hit)\s+__\b/i;
const LIMITLESS_ARROW_CTX_RX = new RegExp(`^(?:Which (?:price|levels?) will (?<subj>.+?) hit in (?<mon>${MONTHS})\\??|What level will (?:the )?(?<subj2>.+?) hit in (?<year>20\\d{2})\\??)$`, 'i');
const LIMITLESS_EARNINGS_RX = /^will\s+(?<name>.+?)\s+\((?<ticker>[A-Z.]+)\)\s+beat\s+quarterly\s+earnings\??$/i;
const DOLLAR_RANGE_RX = /^\$?(?<lo>[\d.]+)\s*[–-]\s*\$?(?<hi>[\d.]+)$/;
const DOLLAR_BELOW_RX = /^[<≤]\s*\$?(?<hi>[\d.]+)$/;
const DOLLAR_ABOVE_RX = /^[>≥]\s*\$?(?<lo>[\d.]+)\+?$/;
const B_RANGE_RX = /^\$?(?<a>[\d.]+)B\s*[-–]\s*\$?(?<b>[\d.]+)B$/i;
const B_ABOVE_RX = /^(?:above|[>≥])\s*\$?(?<lo>[\d.]+)B$/i;
const B_BELOW_RX = /^(?:below|[<≤])\s*\$?(?<hi>[\d.]+)B$/i;
const ARROW_RX = /^(?<dir>[↑↓])\s*\$?(?<v>[\d.,]+)$/;
const ABOVE_BLANK_VAL_RX = /^\$?(?<v>[\d,.]+)\s*(?<unit>[Bb])?\+?$/;
const MONTH_NUM: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
function properMonth(mon: string): string {
  const full = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const idx = MONTH_NUM[mon.slice(0, 3).toLowerCase()] ?? null;
  return idx == null ? mon : full[idx]!;
}
function limitlessMonthDate(mon: string, endDate: string | null): { iso: string; year: number } | null {
  const stamped = stampConditionDate({ kind: 'monthToken', mon, endDate, pad: 'start' });
  if (!stamped) return null;
  return { iso: `${stamped.iso}T00:00:00Z`, year: parseInt(stamped.iso.slice(0, 4), 10) };
}
function tryTemplateLimitlessEcon(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'economic') return null;

  const earn = row.title.match(LIMITLESS_EARNINGS_RX);
  if (earn?.groups) {
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag: 'limitless:econ-earnings',
      eventKind: 'other',
      metric: null,
      temporal: null,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: extractAssetName(`${earn.groups.name.trim()} (${earn.groups.ticker})`), participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-earnings', resolution_source: null,
    };
  }

  const split = splitColonSuffix(row.title);
  if (!split) return null;
  const { context, outcome } = split;
  if (isLimitlessCatchall(outcome)) return null;

  const infl = context.match(LIMITLESS_INFLATION_RX);
  if (infl?.groups) {
    let dir: ConditionDirection | null = null, vp: number, vs: number | null = null, m;
    if ((m = outcome.match(PCT_CAP_LOW_RX)))      { dir = 'below'; vp = parseFloat(m.groups!.v); }
    else if ((m = outcome.match(PCT_CAP_HIGH_RX))){ dir = 'above'; vp = parseFloat(m.groups!.v); }
    else if ((m = outcome.match(PCT_RANGE_RX)))   { vp = parseFloat(m.groups!.lo); vs = parseFloat(m.groups!.hi); }
    else if ((m = outcome.match(PCT_POINT_RX)))   { dir = 'at'; vp = parseFloat(m.groups!.v); }
    else return null;
    const date = limitlessMonthDate(infl.groups.mon, row.end_date);
    const yoy = infl.groups.freq.toLowerCase() === 'annual';
    const tuple = emitCondition({
      archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
      tag: 'limitless:econ-cpi',
      eventKind: 'other',
      metric: 'percentage',
      direction: dir,
      temporal: 'on_date',
      value: { primary: vp, secondary: vs, unit: 'percent' },
      outcomeLabel: outcome,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'US CPI', participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-cpi',
      canonical_event_override: `Inflation in ${properMonth(infl.groups.mon)} ${date?.year ?? ''} (CPI ${yoy ? 'YoY' : 'MoM'})`.trim(),
      condition_date_override: date?.iso ?? null,
      condition_date_precision_override: 'month',
      condition_date_source_override: 'limitless-title-month',
    };
  }

  const jobs = context.match(LIMITLESS_JOBS_RX);
  if (jobs?.groups) {
    let dir: ConditionDirection | null = null, vp: number, vs: number | null = null, m;
    if ((m = outcome.match(JOBS_RANGE_RX)))      { vp = parseFloat(m.groups!.lo) * 1000; vs = parseFloat(m.groups!.hi) * 1000; }
    else if ((m = outcome.match(JOBS_ABOVE_RX))) { dir = 'above'; vp = parseFloat(m.groups!.lo) * 1000; }
    else if ((m = outcome.match(JOBS_BELOW_RX))) { dir = 'below'; vp = parseFloat(m.groups!.hi) * 1000; }
    else return null;
    const date = limitlessMonthDate(jobs.groups.mon, row.end_date);
    const tuple = emitCondition({
      archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
      tag: 'limitless:econ-jobs',
      eventKind: 'other',
      metric: 'count',
      direction: dir,
      temporal: 'on_date',
      value: { primary: vp, secondary: vs, unit: 'jobs' },
      outcomeLabel: outcome,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'US Nonfarm Payrolls', participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-jobs',
      canonical_event_override: `Jobs numbers in ${properMonth(jobs.groups.mon)} ${date?.year ?? ''}?`.replace(/\s+\?/, '?'),
      condition_date_override: date?.iso ?? null,
      condition_date_precision_override: 'month',
      condition_date_source_override: 'limitless-title-month',
    };
  }

  // Fed decision (rate-CHANGE enum; NEVER the Kalshi rate-LEVEL ladder)
  const fed = context.match(LIMITLESS_FED_RX);
  if (fed?.groups) {
    const fm = outcome.match(FED_RX);
    if (!fm?.groups) return null;
    const fedIsCut = /decrease/i.test(fm.groups.dir ?? '');
    const fedOpen = !!fm.groups.plus;
    const bps = fm.groups.nochange ? 0 : parseInt(fm.groups.mag!, 10) * (fedIsCut ? -1 : 1);
    const date = limitlessMonthDate(fed.groups.mon, row.end_date);
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'limitless:econ-fed',
      eventKind: 'policy_action',
      metric: 'count',
      direction: fedOpen ? (fedIsCut ? 'below' : 'above') : 'at',
      temporal: 'at_resolution',
      value: { primary: bps, unit: 'bps' },
      outcomeLabel: outcome,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'Federal Reserve', participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-fed',
      canonical_event_override: `Fed rate decision in ${properMonth(fed.groups.mon)} ${date?.year ?? ''}`.trim(),
      condition_date_override: date?.iso ?? null,
      condition_date_precision_override: 'month',
      condition_date_source_override: 'limitless-title-month',
    };
  }

  const nvda = context.match(LIMITLESS_NVDA_RX);
  if (nvda?.groups) {
    const ab = outcome.match(ABOVEBELOW_USD_RX);
    if (!ab?.groups) return null;
    const asset = extractAssetName(`${nvda.groups.name.trim()} (${nvda.groups.ticker})`);
    const tuple = emitCondition({
      archetype: 'path_touch',
      tag: 'limitless:econ-stock',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: ab.groups.dir.toLowerCase() === 'below' ? 'below' : 'above',
      temporal: 'by_date',
      value: { primary: parseFloat(ab.groups.v.replace(/,/g, '')), unit: 'USD' },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: asset, participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-stock',
      resolution_source: null,
    };
  }

  const eggs = context.match(LIMITLESS_EGGS_RX);
  if (eggs?.groups) {
    let dir: ConditionDirection | null = null, vp: number, vs: number | null = null, m;
    if ((m = outcome.match(DOLLAR_RANGE_RX)))      { vp = parseFloat(m.groups!.lo); vs = parseFloat(m.groups!.hi); }
    else if ((m = outcome.match(DOLLAR_BELOW_RX))) { dir = 'below'; vp = parseFloat(m.groups!.hi); }
    else if ((m = outcome.match(DOLLAR_ABOVE_RX))) { dir = 'above'; vp = parseFloat(m.groups!.lo); }
    else return null;
    const date = limitlessMonthDate(eggs.groups.mon, row.end_date);
    const tuple = emitCondition({
      archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
      tag: 'limitless:econ-commodity',
      eventKind: 'price_snapshot',
      metric: 'price',
      direction: dir,
      temporal: 'on_date',
      value: { primary: vp, secondary: vs, unit: 'USD' },
      outcomeLabel: outcome,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: eggs.groups.subj.trim(), participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-commodity', resolution_source: null,
      canonical_event_override: `Price of ${eggs.groups.subj.trim()} in ${properMonth(eggs.groups.mon)} ${date?.year ?? ''}`.trim(),
      condition_date_override: date?.iso ?? null, condition_date_precision_override: 'month', condition_date_source_override: 'limitless-title-month',
    };
  }

  const val = context.match(LIMITLESS_VALUATION_RX);
  if (val?.groups) {
    let dir: ConditionDirection | null = null, vp: number, vs: number | null = null, m;
    if ((m = outcome.match(B_RANGE_RX)))      { const a = parseFloat(m.groups!.a) * 1e9, b = parseFloat(m.groups!.b) * 1e9; vp = Math.min(a, b); vs = Math.max(a, b); }
    else if ((m = outcome.match(B_ABOVE_RX))) { dir = 'above'; vp = parseFloat(m.groups!.lo) * 1e9; }
    else if ((m = outcome.match(B_BELOW_RX))) { dir = 'below'; vp = parseFloat(m.groups!.hi) * 1e9; }
    else return null;
    const tuple = emitCondition({
      archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
      tag: 'limitless:econ-valuation',
      eventKind: 'other',
      metric: 'price',
      direction: dir,
      temporal: 'on_date',
      value: { primary: vp, secondary: vs, unit: 'USD' },
      outcomeLabel: outcome,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: val.groups.subj.trim(), participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-valuation', resolution_source: null,
      canonical_event_override: context,
    };
  }

  const arrowCtx = context.match(LIMITLESS_ARROW_CTX_RX);
  if (arrowCtx?.groups) {
    const am = outcome.match(ARROW_RX);
    if (!am?.groups) return null;
    const subj = (arrowCtx.groups.subj ?? arrowCtx.groups.subj2 ?? '').trim();
    if (subj.length < 2) return null;
    const date = arrowCtx.groups.mon ? limitlessMonthDate(arrowCtx.groups.mon, row.end_date) : null;
    const tuple = emitCondition({
      archetype: 'path_touch',
      tag: 'limitless:econ-arrow',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: am.groups.dir === '↑' ? 'above' : 'below',
      temporal: 'by_date',
      value: { primary: parseFloat(am.groups.v.replace(/,/g, '')), unit: null },
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subj, participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-arrow', resolution_source: null,
      canonical_event_override: context,
      condition_date_override: date?.iso ?? null, condition_date_precision_override: date ? 'month' : undefined, condition_date_source_override: date ? 'limitless-title-month' : undefined,
    };
  }

  const aboveBlank = context.match(LIMITLESS_ABOVE_BLANK_RX);
  if (aboveBlank?.groups) {
    const vm = outcome.match(ABOVE_BLANK_VAL_RX);
    if (!vm?.groups) return null;
    const isB = (vm.groups.unit ?? '').toLowerCase() === 'b';
    const hadDollar = /\$/.test(outcome);
    const value = parseFloat(vm.groups.v.replace(/,/g, '')) * (isB ? 1e9 : 1);
    const subj = aboveBlank.groups.subj.trim();
    const tuple = emitCondition({
      archetype: 'path_touch',
      tag: 'limitless:econ-above',
      eventKind: 'price_threshold',
      metric: 'price',
      direction: 'above',
      temporal: 'by_date',
      value: { primary: value, unit: (isB || hadDollar) ? 'USD' : null }, // FX ratio / index → null
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subj, participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'asset',
      source_tag: 'limitless:econ-above', resolution_source: null,
      canonical_event_override: context,
    };
  }

  return null;
}

const VSPAIR_TITLE_RX = /^[A-Za-z0-9.&'’\- ]+\s+vs\s+[A-Za-z0-9.&'’\- ]+\s*$/i;
const VSPAIR_PAIR_RX = /1-day\s+candle\s+for\s+(?<a>[A-Za-z0-9.]+)\s*\/\s*(?<b>[A-Za-z0-9.]+)/i;
const VSPAIR_THRESHOLD_RX = /strictly\s+greater\s+than\s+(?<v>[\d.]+)/i;
const VSPAIR_DATE_RX = /\bon\s+(?<date>[A-Za-z]+\s+\d{1,2},\s*\d{4})(?:,?\s*at\s+\d{1,2}:\d{2}\s*UTC)?/i;
function tryTemplateLimitlessRatioPair(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'crypto' && row.category_unified !== 'economic') return null;
  if (!VSPAIR_TITLE_RX.test(row.title)) return null;
  const desc = row.description ?? '';
  const pair = desc.match(VSPAIR_PAIR_RX);
  const thr = desc.match(VSPAIR_THRESHOLD_RX);
  if (!pair?.groups || !thr?.groups) return null;
  const a = pair.groups.a.trim();
  const b = pair.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;
  const dateM = desc.match(VSPAIR_DATE_RX);
  let dateIso: string | null = null;
  if (dateM?.groups) {
    const d = new Date(`${dateM.groups.date} UTC`);
    if (!isNaN(d.getTime())) dateIso = `${d.toISOString().slice(0, 10)}T00:00:00Z`;
  }
  return {
    subject_raw: a,
    participants_raw: [b],
    condition_shape: 'binary_event',
    condition_direction: 'above',
    condition_metric: 'price',
    temporal_semantics: 'on_date',
    value_primary: parseFloat(thr.groups.v),
    value_secondary: null,
    value_unit: 'ratio',
    outcome_label: null,
    event_kind: 'other',
    entity_type: 'asset',
    source_tag: 'limitless:ratio-pair',
    resolution_source: null,
    // A/B is directional (numerator/denominator) — do NOT alphabetise.
    canonical_event_override: `${a} vs ${b}`,
    condition_date_override: dateIso,
    condition_date_precision_override: 'day',
    condition_date_source_override: 'limitless-description',
  };
}

const L7_PLAY_RX = /^(?:will\s+)?(?<player>.+?)\s+to\s+(?:play|start|feature|appear)\s+(?:vs\.?|against)\s+(?<opp>.+?)(?:\s+on\s+(?<date>.+?))?\??\s*$/i;
const L7_LEAVE_RX = /^(?:will\s+)?(?<person>.+?)\s+to\s+leave\s+(?<club>.+?)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_SIGN_CONTRACT_RX = /^(?:will\s+)?(?<person>.+?)\s+to\s+sign\s+a\s+new\s+contract\s+with\s+(?<club>.+?)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_SIGN_FOR_RX = /^(?:will\s+)?(?<person>.+?)\s+(?:to\s+)?sign\s+(?:for|with)\s+(?<club>.+?)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_CLUB_SIGN_RX = /^(?:will\s+)?(?<club>.+?)\s+to\s+sign\s+(?<player>.+?)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_MGR_OUT_RX = /^(?:will\s+)?(?<person>.+?)\s+out\s+as\s+(?<club>.+?)\s+(?:manager|head\s+coach|coach)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_MGR_APPOINT_RX = /^(?:will\s+)?(?<person>.+?)\s+(?:to\s+)?be\s+(?:appointed|confirmed)\s+as\s+(?:the\s+)?(?:next\s+)?(?<club>.+?)\s+(?:manager|head\s+coach|coach)\s+(?:by|before)\s+(?<date>.+?)\??\s*$/i;
const L7_RETIRE_RX = /^(?:will\s+)?(?<person>.+?)\s+(?:to\s+)?(?:announce\s+(?:his|her|their)\s+retirement|retire)\b/i;
function parseLooseDate(s: string | undefined, endDate: string | null): string | null {
  if (!s) return null;
  const stamped = stampConditionDate({ kind: 'monthDay', text: s, endDate });
  if (stamped) return `${stamped.iso}T00:00:00Z`;
  const endOf = /\bend\s+of\s+(?:the\s+)?(.+)$/i.exec(s);
  if (endOf) {
    const tail = endOf[1]!.trim().replace(/[?.\s]+$/, '');
    const monWord = /^[a-z]+/i.exec(tail)?.[0];
    if (monWord) {
      const yrTok = /\b(20\d{2})\b/.exec(tail);
      const monthEnd = stampConditionDate({
        kind: 'monthToken',
        mon: monWord,
        year: yrTok ? parseInt(yrTok[1]!, 10) : undefined,
        endDate,
        pad: 'end',
      });
      if (monthEnd) return `${monthEnd.iso}T00:00:00Z`;
    } else if (/^20\d{2}$/.test(tail)) {
      return `${tail}-12-31T00:00:00Z`;
    }
  }
  return null;
}
function tryTemplateLimitlessPersonnel(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'limitless') return null;
  if (row.category_unified !== 'sports') return null;
  if (row.limitless_event_id) return null;

  // event_occurrence: personnel/participation deadline binaries; null
  // temporal is legal.
  const binary = (
    subject: string, participant: string | null, eventKind: EventKind,
    date: string | undefined, tag: string,
  ): TemplateMatch | null => {
    const subj = subject.trim();
    if (subj.length < 2) return null;
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag,
      eventKind,
      metric: null,
      temporal: null,
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: subj,
      participants_raw: participant && participant.trim().length >= 2 ? [participant.trim()] : [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: tag,
      condition_date_override: parseLooseDate(date, row.end_date),
      condition_date_precision_override: 'day',
      condition_date_source_override: 'limitless-title-date',
    };
  };

  let m: RegExpMatchArray | null;
  if ((m = row.title.match(L7_PLAY_RX))?.groups)
    return binary(m.groups.player, m.groups.opp, 'participation', m.groups.date, 'limitless:participation');
  if ((m = row.title.match(L7_LEAVE_RX))?.groups)
    return binary(m.groups.person, m.groups.club, 'personnel_move', m.groups.date, 'limitless:transfer');
  if ((m = row.title.match(L7_SIGN_CONTRACT_RX))?.groups)
    return binary(m.groups.person, m.groups.club, 'personnel_move', m.groups.date, 'limitless:transfer');
  if ((m = row.title.match(L7_SIGN_FOR_RX))?.groups)
    return binary(m.groups.person, m.groups.club, 'personnel_move', m.groups.date, 'limitless:transfer');
  if ((m = row.title.match(L7_MGR_OUT_RX))?.groups)
    return binary(m.groups.person, m.groups.club, 'personnel_move', m.groups.date, 'limitless:manager');
  if ((m = row.title.match(L7_MGR_APPOINT_RX))?.groups)
    return binary(m.groups.person, m.groups.club, 'personnel_move', m.groups.date, 'limitless:manager');
  if ((m = row.title.match(L7_CLUB_SIGN_RX))?.groups)
    return binary(m.groups.player, m.groups.club, 'personnel_move', m.groups.date, 'limitless:transfer');
  if ((m = row.title.match(L7_RETIRE_RX))?.groups)
    return binary(m.groups.person, null, 'personnel_move', undefined, 'limitless:retirement');
  return null;
}

const PM_NEXT_MGR_RX =
  /^will\s+(?<cand>.+?)\s+(?:be\s+(?:appointed|named|hired|confirmed)\s+as\s+(?:the\s+)?(?:next\s+|permanent\s+)*(?:manager|head\s+coach|coach)\s+of\s+(?:the\s+)?(?<club1>.+?)|be\s+(?:the\s+)?next\s+(?:permanent\s+)?(?:manager|head\s+coach|coach)\s+of\s+(?:the\s+)?(?<club2>.+?))\??$/i;
const PM_MGR_OUT_RX =
  /^(?<person>.+?)\s+out\s+as\s+(?<club>.+?)\s+(?:manager|head\s+coach|coach)\s+(?:by|before)\s+(?<date>.+?)\??$/i;
const PM_ANON_CAND_RX = /^(?:coach\s+[a-j]|any\s+other|someone\s+else|another\s+(?:coach|manager)|field)\b/i;
function tryTemplatePmNextManager(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  if (row.category_unified !== 'sports') return null;
  if (/\bof the year\b/i.test(row.title)) return null;

  const out = row.title.match(PM_MGR_OUT_RX);
  if (out?.groups) {
    const person = out.groups.person.trim();
    if (person.length < 2 || PM_ANON_CAND_RX.test(person)) return null;
    return {
      subject_raw: person,
      participants_raw: [out.groups.club.trim()],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'personnel_move',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'pm:manager-out',
      condition_date_override: parseLooseDate(out.groups.date, row.end_date),
      condition_date_precision_override: 'day',
      condition_date_source_override: 'title-date',
    };
  }

  const nm = row.title.match(PM_NEXT_MGR_RX);
  if (nm?.groups) {
    const cand = nm.groups.cand.trim();
    const club = (nm.groups.club1 ?? nm.groups.club2 ?? '').trim();
    if (cand.length < 2 || club.length < 2 || PM_ANON_CAND_RX.test(cand)) return null;
    return {
      subject_raw: cand,
      participants_raw: [club],
      condition_shape: 'categorical_outcome',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: 'at_resolution',
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'personnel_move',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'pm:next-manager',
    };
  }
  return null;
}

const RELEGATION_SENTENCE_RX =
  /^(?:will\s+)?(?<club>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s+(?:be\s+|to\s+be\s+)?relegated\s+from\s+(?:the\s+)?(?<league>[\p{L}\p{M}\d\s.'’\-]+?)(?:\s+(?:in|after)\s+(?:the\s+)?(?<season>\d{4}[\-–—\/]\d{2,4})(?:\s+season)?)?\s*\??$/iu;
const RELEGATION_LIMITLESS_CTX_RX =
  /which\s+clubs?\s+(?:get|to\s+be)\s+relegated/i;

function normalizeRelegationLeague(raw: string): string {
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bepl\b/.test(t) || /english premier league/.test(t) || /^premier league$/.test(t)) return 'english premier league';
  if (/laliga|la liga/.test(t)) return 'la liga';
  if (/ligue\s*1/.test(t)) return 'ligue 1';
  if (/bundesliga/.test(t)) return 'bundesliga';
  if (/serie\s*a/.test(t)) return 'serie a';
  if (/eredivisie/.test(t)) return 'eredivisie';
  return t;
}

function normalizeRelegationSeason(raw: string | undefined): string {
  if (!raw) return '';
  const m = raw.match(/(\d{4})[\-–—\/](\d{2,4})/);
  if (!m) return raw.trim();
  const start = m[1]!;
  const endRaw = m[2]!;
  const end = endRaw.length === 4 ? endRaw.slice(2) : endRaw;
  return `${start}-${end}`;
}

function relegationMatch(
  club: string,
  league: string,
  season: string,
  entity: 'team',
  leagueCanonical: string | null,
): TemplateMatch {
  const leagueNorm = normalizeRelegationLeague(league);
  const seasonNorm = normalizeRelegationSeason(season);
  const event = [leagueNorm, seasonNorm, 'relegation'].filter((x) => x).join(' ');
  return {
    subject_raw: club,
    participants_raw: [],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'stage_advance',
    entity_type: entity,
    participant_type_confidence: 'high',
    sport_canonical: 'soccer',
    league_canonical: leagueCanonical,
    source_tag: 'text-deterministic-relegation',
    canonical_event_override: event,
  };
}

function tryTemplateRelegation(row: CandidateRow): TemplateMatch | null {
  if (row.category_unified !== 'sports') return null;

  if (row.platform === 'limitless') {
    const split = splitColonSuffix(row.title);
    if (!split) return null;
    if (!RELEGATION_LIMITLESS_CTX_RX.test(split.context)) return null;
    if (isLimitlessCatchall(split.outcome)) return null;
    const club = split.outcome.trim();
    if (club.length < 2) return null;
    const leagueRaw = split.context.split(RELEGATION_LIMITLESS_CTX_RX)[0]!
      .replace(/[\-–—:].*$/, '').trim() || split.context;
    const leagueNorm = normalizeRelegationLeague(leagueRaw);
    return relegationMatch(club, leagueNorm, '', 'team', leagueNorm);
  }

  const text = row.platform === 'predict' ? (row.native_question ?? '') : row.title;
  const m = text.match(RELEGATION_SENTENCE_RX);
  if (!m?.groups) return null;
  const club = m.groups.club.trim();
  const league = m.groups.league.trim();
  if (club.length < 2 || league.length < 2) return null;
  const leagueNorm = normalizeRelegationLeague(league);
  return relegationMatch(club, leagueNorm, m.groups.season ?? '', 'team', leagueNorm);
}


const PM_CPI_COUNTRY_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bSouth\s+Africa(?:n)?\b/i, 'South Africa CPI'],
  [/\bSouth\s+Korea(?:n)?\b/i,  'South Korea CPI'],
  [/\bU\.?K\.?\b/i,             'UK CPI'],
  [/\bArgentin(?:a|e|ian)\b/i,  'Argentina CPI'],
  [/\bBrazil(?:ian)?\b/i,       'Brazil CPI'],
  [/\bCanad(?:a|ian)\b/i,       'Canada CPI'],
  [/\bChin(?:a|ese)\b/i,        'China CPI'],
  [/\bEuro\s?zone\b/i,          'Eurozone CPI'],
  [/\bIndi(?:a|an)\b/i,         'India CPI'],
  [/\bJapan(?:ese)?\b/i,        'Japan CPI'],
  [/\bMexic(?:o|an)\b/i,        'Mexico CPI'],
  [/\bUS\b|\bU\.S\.\b|\bUnited\s+States\b/i, 'US CPI'],
];

/** Resolve a CPI country subject from the parent event title, or null. */
function pmCpiCountry(parentTitle: string | null): string | null {
  if (!parentTitle) return null;
  for (const [rx, subj] of PM_CPI_COUNTRY_MAP) {
    if (rx.test(parentTitle)) return subj;
  }
  return null;
}

const PM_INFL_US_PARENT_RX = new RegExp(`^(?<mon>${MONTHS})\\s+Inflation\\s+US\\s*-\\s*(?<freq>Annual|Monthly)\\b`, 'i');
const PM_INFL_COUNTRY_FREQ_RX = /\b(?<freq>Annual|Monthly)\b/i;
const PM_INFL_PARENT_MONTH_RX = new RegExp(`-\\s*(?<mon>${MONTHS})\\b`, 'i');
const PM_INFL_PARENT_YEAR_RX = /\b(?<year>20\d{2})\b/;

const PM_INFL_BETWEEN_RX = /between\s+(?<lo>-?\d+(?:\.\d+)?)%\s+and\s+(?<hi>-?\d+(?:\.\d+)?)%/i;
const PM_INFL_HIGH_RX = /(?:at\s+least|or\s+more|or\s+higher|greater\s+than|more\s+than|≥)\s*(?<v>-?\d+(?:\.\d+)?)%|≥\s*(?<v2>-?\d+(?:\.\d+)?)%/i;
const PM_INFL_LOW_RX = /(?:less\s+than\s+or\s+equal\s+to|less\s+than|or\s+less|at\s+most|≤)\s*(?<v>-?\d+(?:\.\d+)?)%|≤\s*(?<v2>-?\d+(?:\.\d+)?)%/i;
const PM_INFL_POINT_RX = /(?:increase\s+by|be|reach(?:\s+more\s+than)?)\s+(?<v>-?\d+(?:\.\d+)?)%/i;

function tryTemplatePmInflation(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  const title = row.title;
  if (!/inflation/i.test(title)) return null;

  const parent = row.non_kalshi_event_title;
  // CRITICAL: no country token → bail. NEVER default to US.
  const subject = pmCpiCountry(parent);
  if (!subject) return null;

  let freqRaw: string | null = null;
  let mon: string | null = null;
  let year: number | null = null;
  const usM = parent!.match(PM_INFL_US_PARENT_RX);
  if (usM?.groups) {
    freqRaw = usM.groups.freq;
    mon = usM.groups.mon;
  } else {
    freqRaw = parent!.match(PM_INFL_COUNTRY_FREQ_RX)?.groups?.freq ?? null;
    mon = parent!.match(PM_INFL_PARENT_MONTH_RX)?.groups?.mon ?? null;
  }
  year = parent!.match(PM_INFL_PARENT_YEAR_RX)?.groups?.year
    ? parseInt(parent!.match(PM_INFL_PARENT_YEAR_RX)!.groups!.year, 10)
    : (row.end_date ? new Date(row.end_date).getUTCFullYear() : null);
  const yoy = (freqRaw ?? 'Annual').toLowerCase() === 'annual';

  let shape: ConditionShape, dir: ConditionDirection | null, vp: number, vs: number | null = null, m;
  if ((m = title.match(PM_INFL_BETWEEN_RX))?.groups) {
    shape = 'range_snapshot'; dir = null;
    vp = parseFloat(m.groups.lo); vs = parseFloat(m.groups.hi);
  } else if ((m = title.match(PM_INFL_HIGH_RX))?.groups) {
    shape = 'point_in_time'; dir = 'above';
    vp = parseFloat(m.groups.v ?? m.groups.v2!);
  } else if ((m = title.match(PM_INFL_LOW_RX))?.groups) {
    shape = 'point_in_time'; dir = 'below';
    vp = parseFloat(m.groups.v ?? m.groups.v2!);
  } else if ((m = title.match(PM_INFL_POINT_RX))?.groups) {
    shape = 'point_in_time'; dir = 'at';
    vp = parseFloat(m.groups.v);
  } else {
    return null;
  }

  const period = mon ? `${properMonth(mon)} ${year ?? ''}`.trim() : `${year ?? ''}`.trim();
  const canonical_event_override = `Inflation in ${period} (CPI ${yoy ? 'YoY' : 'MoM'})`.replace(/\s+/g, ' ').trim();

  return {
    subject_raw: subject, participants_raw: [],
    condition_shape: shape, condition_direction: dir, condition_metric: 'percentage',
    temporal_semantics: 'on_date', value_primary: vp, value_secondary: vs, value_unit: 'percent',
    outcome_label: null, event_kind: 'other', entity_type: 'asset',
    source_tag: 'pm:inflation', resolution_source: null,
    canonical_event_override,
    metric_scope: null,
  };
}

const PM_INDEX_LEVEL_TITLE_RX =
  /^(?:will\s+)?(?:the\s+)?.+?\s+(?<verb>hit|reach|dip(?:\s+to)?)\s+\$?(?<v>[\d][\d,]*(?:\.\d+)?)\s*(?<scale>[KkMm])?\b/i;
const PM_INDEX_NAME_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:dubai|dfm)\b.*\breal\s+estate\s+index\b/i, 'Dubai Real Estate Index'],
];
function pmIndexName(parentTitle: string | null): string | null {
  if (!parentTitle) return null;
  for (const [rx, subj] of PM_INDEX_NAME_MAP) {
    if (rx.test(parentTitle)) return subj;
  }
  return null;
}
function tryTemplatePmIndexLevel(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  const subject = pmIndexName(row.non_kalshi_event_title);
  if (!subject) return null;

  const m = row.title.match(PM_INDEX_LEVEL_TITLE_RX);
  if (!m?.groups) return null;

  let v = parseFloat(m.groups.v.replace(/,/g, ''));
  const scale = m.groups.scale?.toLowerCase();
  if (scale === 'k') v *= 1e3;
  else if (scale === 'm') v *= 1e6;
  if (!Number.isFinite(v)) return null;

  const dir: ConditionDirection = /dip/i.test(m.groups.verb) ? 'below' : 'above';

  // hit/reach/dip are touch verbs → path_touch (derives the
  // monotonic_threshold/by_date this family must stay on).
  const tuple = emitCondition({
    archetype: 'path_touch',
    tag: 'pm:index-level',
    eventKind: 'price_threshold',
    metric: 'price',
    direction: dir,
    temporal: 'by_date',
    value: { primary: v, unit: null },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: subject, participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    source_tag: 'pm:index-level', resolution_source: null,
    metric_scope: null,
  };
}

const PM_RATE_BANK_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbank\s+of\s+england\b/i,         'Bank of England'],
  [/\bbank\s+of\s+japan\b/i,           'Bank of Japan'],
  [/\bbank\s+of\s+mexico\b/i,          'Bank of Mexico'],
  [/\bbank\s+of\s+canada\b/i,          'Bank of Canada'],
  [/\bbank\s+of\s+brazil\b/i,          'Bank of Brazil'],
  [/\bbank\s+of\s+israel\b/i,          'Bank of Israel'],
  [/\breserve\s+bank\s+of\s+australia\b/i, 'Reserve Bank of Australia'],
  [/\bcentral\s+bank\s+of\s+colombia\b/i,  'Central Bank of Colombia'],
  [/\b(?:ecb|european\s+central\s+bank)\b/i, 'European Central Bank'],
  [/\bfederal\s+reserve\b|\bthe\s+fed\b|\bfed\s+(?:decision|interest\s+rates|increase|decrease)/i, 'Federal Funds Rate'],
];
function pmRateBank(title: string, parentTitle: string | null): string | null {
  for (const [rx, subj] of PM_RATE_BANK_MAP) {
    if (rx.test(title) || (parentTitle && rx.test(parentTitle))) return subj;
  }
  return null;
}
const PM_RATE_MAG_DIR_RX =
  /(?<mag>\d+)\s*\+?\s*bps\b[^.]*?\b(?<dir1>increase|decrease|hike|cut)\b|(?<dir2>increase|decrease|hike|cut|increases|decreases)\b[^.]*?\b(?<mag2>\d+)\s*\+?\s*bps\b/i;
const PM_RATE_NOCHANGE_RX = /\bno\s+change\b/i;
const PM_RATE_BAIL_RX = /\babolish/i;
function tryTemplatePmRateDecision(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  const title = row.title;
  // Must look like a rate decision; bail on non-numeric political variants.
  if (!/\bbps\b|\binterest\s+rate|\brate\s+decision|no\s+change/i.test(title)) return null;
  if (PM_RATE_BAIL_RX.test(title)) return null;
  if (/\b(?:cut|pause)\b.*[–-].*\b(?:cut|pause)\b/i.test(title)) return null;

  const subject = pmRateBank(title, row.non_kalshi_event_title);
  if (!subject) return null;

  let dir: ConditionDirection, vp: number;
  const noChange = PM_RATE_NOCHANGE_RX.test(title) && !/\bbps\b/i.test(title);
  if (noChange) {
    dir = 'at'; vp = 0;
  } else {
    const m = title.match(PM_RATE_MAG_DIR_RX);
    if (!m?.groups) return null;
    const mag = parseInt(m.groups.mag ?? m.groups.mag2!, 10);
    if (!Number.isFinite(mag)) return null;
    const dirRaw = (m.groups.dir1 ?? m.groups.dir2 ?? '').toLowerCase();
    const isCut = /decrease|cut/.test(dirRaw);
    if (!isCut && !/increase|hike/.test(dirRaw)) return null;
    const cumulative = /\d\s*\+\s*bps\b/i.test(title);
    if (cumulative) {
      dir = isCut ? 'below' : 'above';
      vp = isCut ? -mag : mag;
    } else {
      dir = 'at';
      vp = isCut ? -mag : mag;
    }
  }

  return {
    subject_raw: subject, participants_raw: [],
    condition_shape: 'categorical_outcome', condition_direction: dir, condition_metric: 'count',
    temporal_semantics: 'at_resolution', value_primary: vp, value_secondary: null, value_unit: 'bps',
    outcome_label: null, event_kind: 'policy_action', entity_type: 'asset',
    source_tag: 'pm:rate-decision', resolution_source: null,
    participant_type_confidence: 'low',
    metric_scope: null,
  };
}


const PM_PCT_BETWEEN_RX =
  /^Will\s+(?<subj>.+?)\s+be\s+between\s+(?<lo>-?\d+(?:\.\d+)?)%?\s+and\s+(?<hi>-?\d+(?:\.\d+)?)%\s*\??$/i;
const PM_PCT_BELOW_RX =
  /^Will\s+(?<subj>.+?)\s+be\s+(?:less\s+than|lower\s+than|below|under)\s+(?<v>-?\d+(?:\.\d+)?)%\s*\??$/i;
const PM_PCT_ABOVE_RX =
  /^Will\s+(?<subj>.+?)\s+be\s+(?:at\s+least|above|over|greater\s+than|more\s+than)\s+(?<v>-?\d+(?:\.\d+)?)%\s*\??$/i;
const PM_PCT_ORMORE_RX =
  /^Will\s+(?<subj>.+?)\s+be\s+(?<v>-?\d+(?:\.\d+)?)%\s+or\s+(?<dir2>more|higher|less|lower)\s*\??$/i;

const PM_GDP_COUNTRY_RX =
  /^(?:the\s+)?(?<country>.+?)(?:['’]s)?\s+(?:Q[1-4]\s+20\d{2}\s+|20\d{2}\s+)?(?:annual\s+)?GDP\s+growth\b/i;

const PM_PCT_PERIOD_TOKENS_RX =
  /\((?:Y\/?Y|YoY|Q\/?Q|QoQ|M\/?M|MoM)\)|\b(?:YoY|QoQ|MoM)\b|\b(?:in|for)\s+Q[1-4]\s+20\d{2}\b|\bQ[1-4]\s+20\d{2}\b|\b20\d{2}\s+Q[1-4]\b|\b(?:in|for)\s+20\d{2}\b|\b20\d{2}\b|\bQ[1-4]\b/gi;

function tryTemplatePmPercentBucket(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  if (
    row.category_unified !== 'economic' &&
    row.category_unified !== 'politics' &&
    row.category_unified !== 'election'
  ) return null;

  const title = row.title;
  let dir: ConditionDirection | null = null;
  let vp: number;
  let vs: number | null = null;
  let subjPhrase: string;
  let m: RegExpMatchArray | null;
  if ((m = title.match(PM_PCT_BETWEEN_RX))?.groups) {
    const lo = parseFloat(m.groups.lo);
    const hi = parseFloat(m.groups.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
    vp = lo; vs = hi;
    subjPhrase = m.groups.subj;
  } else if ((m = title.match(PM_PCT_BELOW_RX))?.groups) {
    dir = 'below'; vp = parseFloat(m.groups.v);
    subjPhrase = m.groups.subj;
  } else if ((m = title.match(PM_PCT_ABOVE_RX))?.groups) {
    dir = 'above'; vp = parseFloat(m.groups.v);
    subjPhrase = m.groups.subj;
  } else if ((m = title.match(PM_PCT_ORMORE_RX))?.groups) {
    dir = /more|higher/i.test(m.groups.dir2) ? 'above' : 'below';
    vp = parseFloat(m.groups.v);
    subjPhrase = m.groups.subj;
  } else {
    return null;
  }
  if (!Number.isFinite(vp)) return null;

  if (/approval\s+rating/i.test(subjPhrase)) return null;

  let subject: string;
  const gdp = subjPhrase.match(PM_GDP_COUNTRY_RX);
  if (gdp?.groups && !/\d/.test(gdp.groups.country) && gdp.groups.country.length <= 30) {
    subject = `${gdp.groups.country.trim()} GDP`;
  } else {
    subject = subjPhrase
      .replace(PM_PCT_PERIOD_TOKENS_RX, ' ')
      .replace(/^\s*the\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject.length < 4 || subject.length > 60) return null;
    if (/\d|%/.test(subject)) return null;
    if (/\b(win|wins|won|beat|defeats?|margin\s+of\s+victory)\b/i.test(subject)) return null;
  }

  const tuple = emitCondition({
    archetype: vs != null ? 'terminal_range' : 'terminal_threshold',
    tag: 'pm:econ-pct-bucket',
    eventKind: 'other',
    metric: 'percentage',
    direction: dir,
    temporal: 'on_date',
    value: { primary: vp, secondary: vs, unit: 'percent' },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: subject,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    participant_type_confidence: 'low',
    source_tag: 'pm:econ-pct-bucket',
    resolution_source: null,
    metric_scope: null,
  };
}

const PM_COUNT_RANGE_RX =
  /^Will\s+(?<lo>\d[\d,]*)\s+to\s+(?<hi>\d[\d,]*)\s+(?<noun>[a-z][a-z\s-]*?)\s+occur\b(?<rest>.*?)\??$/i;
const PM_COUNT_BELOW_RX =
  /^Will\s+fewer\s+than\s+(?<v>\d[\d,]*)\s+(?<noun>[a-z][a-z\s-]*?)\s+occur\b(?<rest>.*?)\??$/i;
const PM_COUNT_ABOVE_RX =
  /^Will\s+(?<v>\d[\d,]*)\s+or\s+more\s+(?<noun>[a-z][a-z\s-]*?)\s+occur\b(?<rest>.*?)\??$/i;
const PM_THERE_BE_ATLEAST_RX =
  /^Will\s+there\s+be\s+at\s+least\s+(?<v>\d[\d,]*)\s+(?<noun>[a-z][a-z\s-]*?)\s+in\b(?<rest>.*?)\??$/i;

const PM_COUNT_FAMILY: ReadonlyArray<{
  nounRx: RegExp;
  subject: string;
  unit: string;
  eventKind: EventKind;
}> = [
  { nounRx: /^tornado(?:es)?$/i, subject: 'US Tornado Count', unit: 'tornadoes', eventKind: 'weather_extreme' },
  { nounRx: /^measles\s+cases$/i, subject: 'US Measles Cases', unit: 'cases', eventKind: 'other' },
];

function tryTemplatePmCountBucket(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;

  const title = row.title;
  let dir: ConditionDirection | null = null;
  let vp: number;
  let vs: number | null = null;
  let noun: string;
  let rest: string;
  let m: RegExpMatchArray | null;
  if ((m = title.match(PM_COUNT_RANGE_RX))?.groups) {
    const lo = parseInt(m.groups.lo.replace(/,/g, ''), 10);
    const hi = parseInt(m.groups.hi.replace(/,/g, ''), 10);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
    vp = lo; vs = hi;
    noun = m.groups.noun; rest = m.groups.rest ?? '';
  } else if ((m = title.match(PM_COUNT_BELOW_RX))?.groups) {
    dir = 'below';
    vp = parseInt(m.groups.v.replace(/,/g, ''), 10);
    noun = m.groups.noun; rest = m.groups.rest ?? '';
  } else if ((m = title.match(PM_COUNT_ABOVE_RX))?.groups) {
    dir = 'above';
    vp = parseInt(m.groups.v.replace(/,/g, ''), 10);
    noun = m.groups.noun; rest = m.groups.rest ?? '';
  } else if ((m = title.match(PM_THERE_BE_ATLEAST_RX))?.groups) {
    dir = 'above';
    vp = parseInt(m.groups.v.replace(/,/g, ''), 10);
    noun = m.groups.noun; rest = m.groups.rest ?? '';
  } else {
    return null;
  }
  if (!Number.isFinite(vp)) return null;

  const fam = PM_COUNT_FAMILY.find((f) => f.nounRx.test(noun.trim()));
  if (!fam) return null;
  if (!/\b(?:united\s+states|u\.?s\.?a?)\b/i.test(rest)) return null;

  const tuple = emitCondition(
    vs != null
      ? {
          archetype: 'cumulative_count',
          arm: 'range',
          tag: 'pm:count-bucket',
          eventKind: fam.eventKind,
          metric: 'count',
          temporal: 'during_period',
          value: { primary: vp, secondary: vs, unit: fam.unit },
        }
      : dir === 'above'
      ? {
          archetype: 'cumulative_count',
          arm: 'above',
          legacyMonotonicArm: true,
          tag: 'pm:count-bucket',
          eventKind: fam.eventKind,
          metric: 'count',
          direction: dir,
          temporal: 'during_period',
          value: { primary: vp, secondary: vs, unit: fam.unit },
        }
      : {
          archetype: 'cumulative_count',
          arm: 'below',
          tag: 'pm:count-bucket',
          eventKind: fam.eventKind,
          metric: 'count',
          direction: dir,
          temporal: 'on_date',
          value: { primary: vp, secondary: vs, unit: fam.unit },
        },
    'text-det');
  if (!tuple) return null;
  return {
    subject_raw: fam.subject,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'asset',
    participant_type_confidence: 'low',
    source_tag: 'pm:count-bucket',
    resolution_source:
      fam.eventKind === 'weather_extreme' &&
      row.description != null &&
      /\bNOAA\b|Storm\s+Prediction\s+Center/i.test(row.description)
        ? 'NOAA'
        : null,
    metric_scope: null,
  };
}

const PM_RT_SCORE_RX =
  /^Will\s+(?<movie>.+?)\s+score\s+at\s+least\s+(?<v>\d{1,3})\s+on\s+the\s+Rotten\s+Tomatoes\s+Tomatometer\s*\??$/i;

function tryTemplatePmRtScore(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  const m = row.title.match(PM_RT_SCORE_RX);
  if (!m?.groups) return null;
  const v = parseInt(m.groups.v, 10);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  const movie = m.groups.movie.trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  if (movie.length < 2) return null;
  return {
    subject_raw: movie,
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'above',
    condition_metric: 'score',
    temporal_semantics: 'at_resolution',
    value_primary: v,
    value_secondary: null,
    value_unit: 'score',
    outcome_label: null,
    event_kind: 'media_release',
    entity_type: 'asset',
    participant_type_confidence: 'low',
    source_tag: 'pm:rt-score',
    resolution_source: null,
    canonical_event_override: movie,
    metric_scope: null,
  };
}


const PM_GIT_SLOT_LABEL_RX =
  /^(?:map|game|set|race|round|quarter|period|half|inning|leg|matchday|day|week|stage)\s*\d+(?:\s+winner)?$/i;

const PM_GIT_PREAMBLE_RX = /^(?:will(?:\s+the)?)?$/i;

/** Any-of / count "win" phrasings that are NOT a single-winner slot (trap c). */
const PM_GIT_ANY_OF_WIN_RX =
  /^(?:to\s+)?wins?\s+(?:a|an|any|another|multiple|either|both|back[- ]to[- ]back|consecutive|at\s+least|\d)\b/i;

const PM_GIT_WIN_RX = /^(?:to\s+)?wins?\s+(?:the\s+)?(?<event>.+)$/i;

const PM_GIT_ELECTION_TAIL_RX =
  /\b(?:election|primary|primaries|caucus(?:es)?|presidency|senate\s+seat|house\s+seat|governorship|governor(?:'s)?\s+race|mayoral\s+(?:race|election)|mayor(?:'s)?\s+race|nomination|runoff|referendum|seat)\b/i;

const PM_GIT_CHAMPIONSHIP_TAIL_RX =
  /\b(?:championship|finals?|title|cup|series|tournament|tour|league|liga|award|grand[- ]?prix|open|trophy|medal|mvp|winner|derby|classic|invitational|masters|bowl|prize|slam|ballon\s+d['’]or|golden\s+(?:boot|glove|ball)|(?:player|coach|defender|goalkeeper|rookie|manager)\s+of\s+the\s+(?:year|tournament|season|month)|most\s+valuable\s+player|cy\s+young|heisman|conn\s+smythe|calder|norris|vezina|selke|roland[- ]?garros|wimbledon|olympics?|world\s+cup|playoffs?|conference|division|(?:top|leading)\s+(?:goal\s*)?scorer|sexiest\s+man\s+alive|eurovision|oscar|grammy|emmy)\b/i;

const PM_GIT_NOMINEE_RX = /^(?:to\s+)?be\s+the\s+.*?\b(?:nominee|nomination)\b/i;

const PM_GIT_NEXT_OFFICE_RX =
  /^(?:to\s+)?be\s+(?:the\s+)?(?:next|first)\s+[\p{L}\p{M}\s'’\-]*?\b(?:prime\s+minister|premier|first\s+minister|chancellor|secretary[- ]?general|senate\s+majority\s+leader|speaker\s+of\s+the\s+house|chief\s+minister|taoiseach|president|mayor|governor)\b/iu;

const PM_GIT_BE_SELECTED_RX =
  /^(?:to\s+)?be\s+(?:named|crowned|voted|selected\s+as|chosen\s+as)\s+(?:the\s+)?(?<event>.+)$|^(?:to\s+)?be\s+(?:drafted|selected|picked|taken)\s+(?:1st|first)\s+overall\b|^(?:to\s+)?be\s+the\s+(?:first|1st)\s+overall\s+pick\b/i;


const PM_GIT_MEMBERSHIP_EVENT_RX =
  /\bteam of the (?:year|season|tournament|decade|century)\b/i;

const PM_GIT_MULTI_LAUREATE_RX = /\bfields\s+medal\b/i;

const PM_GIT_EVENT_DEICTIC_RX = /^(?:the\s+)?(?:their|its|his|her)\b/i;
const PM_GIT_EVENT_BARE_RX =
  /^(?:the\s+)?(?:(?:eastern|western|northern|southern|central|atlantic|pacific|metropolitan|afc|nfc|american|national)\s+)?(?:conference\s+)?(?:division|league|series|tournament|finals?|conference|championship|title|cup|playoffs?)$/i;
const PM_GIT_EVENT_MEDAL_RX = /\b(?:gold|silver|bronze)\s+medal/i;

function pmGitOneWinnerEventOk(eventPhrase: string): boolean {
  if (PM_GIT_EVENT_DEICTIC_RX.test(eventPhrase)) return false;
  if (PM_GIT_EVENT_BARE_RX.test(eventPhrase)) return false;
  if (PM_GIT_EVENT_MEDAL_RX.test(eventPhrase)) return false;
  if (/\b20\d{2}\b/.test(eventPhrase)) return true;
  return /\p{Lu}/u.test(eventPhrase);
}

function pmGitLeaderEvent(git: string, row: CandidateRow): string | null {
  const parent = row.non_kalshi_event_title?.replace(/\?+\s*$/, '').trim();
  let ev: string;
  if (parent && !looksLikePredicate(parent)) {
    ev = parent;
  } else {
    const sm = row.title.match(STAT_LEADER_STAT_RX);
    const g = sm?.groups;
    const statFull = (g?.stat1 ?? g?.stat2 ?? g?.stat3 ?? g?.stat4 ?? g?.cap ?? '').trim();
    const lossy = !statFull || statFull.split(/\s+/).length > 2;
    const canonStat = lossy ? extractStatType(row.title) : null;
    if (lossy && !canonStat) return null;
    ev = lossy ? `${git} ${canonStat} leader` : statLeaderGatedEvent(git, row.title);
    const mon = row.title.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
    )?.[1];
    if (mon && !new RegExp(`\\b${mon}\\b`, 'i').test(ev)) ev = `${ev} ${mon}`;
  }
  if (!/\b20\d{2}\b/.test(ev)) {
    const y =
      row.title.match(/\b(20\d{2})\b/)?.[1] ??
      (row.end_date && /^20\d{2}/.test(row.end_date) ? row.end_date.slice(0, 4) : null);
    if (y) ev = `${ev} ${y}`;
  }
  return ev;
}

const PM_GIT_MOST_SEATS_RX = /^(?:to\s+)?wins?\s+the\s+most\s+seats\b/i;

const PM_GIT_LEADER_RX =
  /^(?:to\s+)?(?:(?:hits?|records?|scores?|gets?|tallies|tally|makes?|has|have|wins?|strikes?\s+out)\s+the\s+most\b|leads?\s+(?:the\s+)?[\p{L}& ]+?\s+in\b|(?:be|is)\s+the\s+(?:top|leading)\s+(?:goal\s*)?scorer\b|(?:be|is)\s+the\s+(?:goalie|goalkeeper|player)\s+with\s+the\s+most\b|(?:has|have)\s+the\s+(?:highest|lowest|best|most)\b)/iu;

const PM_GIT_ADVANCE_RX =
  /^(?:to\s+)?(?:qualif(?:y|ies)\s+for|advances?(?:\s+to)?|reach(?:es)?|makes?(?:\s+it)?(?:\s+to)?)\s+(?:the\s+)?(?<event>.+)$/i;
const PM_GIT_STAGE_TAIL_RX =
  /\b(?:finals?|semi[- ]?finals?|quarter[- ]?finals?|round(?:\s+of\s+\d+)?|playoffs?|postseason|league\s+phase|group\s+stage|knockouts?|knockout\s+(?:stage|round)|world\s+cup|olympics?|euros?\s*\d{0,4}|main\s+event|championship\s+game|conference\s+finals?)\b/i;

const PM_GIT_GENERIC_REFUSE_RX =
  /[<>≥≤]\s*\d|\$\s?\d|\d+(?:\.\d+)?\s*%|\d+\s*\+|\b(?:more|less|fewer|greater)\s+than\b|\bat\s+least\b|\bat\s+most\b|\bbetween\s+\d|\bor\s+more\b|\bor\s+fewer\b|\bvs\.?\s|\bversus\b|^not\b|\bo\/u\b/i;

function pmGitWinnerMatch(
  git: string,
  eventOverride: string,
  sourceTag: string,
  tour: 'men' | 'women' | null,
  tourLeague: string | null,
): TemplateMatch {
  return {
    subject_raw: git,
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    outcome_label: null,
    event_kind: 'championship_winner',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: sourceTag,
    canonical_event_override: eventOverride,
    canonical_event_tour: tour,
    ...(tourLeague ? { league_canonical: tourLeague, sport_canonical: 'tennis' } : {}),
  };
}


const PM_GIT_VALUED_RX =
  /^(?:to\s+)?(?<verb>wins?|records?|scores?|gets?|has|have|hits?|makes?|tall(?:y|ies)|reach(?:es)?)\s+(?:(?<pre>at\s+least|at\s+most|more\s+than|greater\s+than|fewer\s+than|less\s+than|no\s+more\s+than)\s+)?(?<val>\d+(?:\.\d+)?)\s*(?<plus>\+)?(?:\s*(?<post>or\s+more|or\s+fewer|or\s+better))?\s+(?<unit>[a-z][a-z]+)\b/i;

function pmGitCountUnit(verb: string, rawUnit: string): string | null {
  const u = rawUnit.toLowerCase();
  if (/^wins?$/i.test(verb) && /^(?:games?|matches?)$/.test(u)) return 'wins';
  const folded = normalizePlayerStatUnit(u, '');
  if (folded && INTEGER_GRAIN_UNITS.has(folded)) return folded;
  if (INTEGER_GRAIN_UNITS.has(u)) return u;
  return null;
}

function pmGitValuedThreshold(git: string, predicate: string, row: CandidateRow): TemplateMatch | null {
  const m = predicate.match(PM_GIT_VALUED_RX);
  if (!m?.groups) return null;
  const { verb, pre, val, plus, post, unit: rawUnit } = m.groups as Record<string, string | undefined>;
  const rawVal = parseFloat(val!);
  if (!Number.isFinite(rawVal)) return null;

  const p = (pre ?? '').toLowerCase();
  const q = (post ?? '').toLowerCase();
  const above = p === 'at least' || p === 'more than' || p === 'greater than' || plus === '+' || q === 'or more' || q === 'or better';
  const below = p === 'at most' || p === 'no more than' || p === 'fewer than' || p === 'less than' || q === 'or fewer';
  if (above === below) return null;
  const direction: 'above' | 'below' = above ? 'above' : 'below';
  const strictness: 'inclusive' | 'strict' =
    p === 'more than' || p === 'greater than' || p === 'fewer than' || p === 'less than' ? 'strict' : 'inclusive';

  const unit = pmGitCountUnit(verb!, rawUnit!);
  if (!unit) return null;

  const value = canonicalizeIntegerThreshold({ direction, value: rawVal, unit, strictness }).value;
  if (value == null || !Number.isFinite(value)) return null; // guard: never a NULL-value valued row

  return {
    subject_raw: git,
    participants_raw: [],
    condition_shape: 'monotonic_threshold',
    condition_direction: direction,
    condition_metric: 'count',
    temporal_semantics: 'at_resolution',
    value_primary: value,
    value_secondary: null,
    value_unit: unit,
    outcome_label: null,
    event_kind: 'player_prop_threshold',
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'pm:group-item-valued',
    canonical_event_override: `${git} ${unit}`,
  };
}


function tryTemplatePmGroupItem(row: CandidateRow): TemplateMatch | null {
  const m = tryTemplatePmGroupItemInner(row);
  return m ? { ...m, subject_native_verified: true } : null;
}

function tryTemplatePmGroupItemInner(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  const git = row.pm_group_item_title?.trim();
  if (!git || git.length < 2) return null;

  if (!kbHasRealEntitySync(git)) {
    if (isAnonymizedMarket(git)) return null;
    if (isNonEntityLabel(git)) return null;
    if (looksLikePredicate(git)) return null;
  }
  if (PM_GIT_SLOT_LABEL_RX.test(git)) return null; // trap (d): "Map 1 Winner", "Game 2"

  const title = row.title.trim();
  const idx = title.toLowerCase().indexOf(git.toLowerCase());
  if (idx < 0) return null;
  const pre = title.slice(0, idx).trim();
  if (!PM_GIT_PREAMBLE_RX.test(pre)) return null;
  const predicate = title
    .slice(idx + git.length)
    .replace(/[?!.]+\s*$/, '')
    .trim();
  if (predicate.length < 4) return null;

  const tourSignals = {
    title: row.title,
    eventTitle: row.non_kalshi_event_title,
    kalshiCompetition: null,
    eventTicker: null,
    rulesPrimary: null,
  };
  const tour = deriveTennisTour(tourSignals);
  const tourLeague = tour ? tennisTourLeague(tourSignals) : null;

  const generic = (): TemplateMatch | null => {
    if (PM_GIT_GENERIC_REFUSE_RX.test(predicate)) {
      const valued = pmGitValuedThreshold(git, predicate, row);
      if (valued) return valued;
      beltHit('pm_git_refuse');
      return null;
    }
    return {
      subject_raw: git,
      participants_raw: [],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'other',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'pm:group-item-binary',
      canonical_event_override: row.title,
    };
  };

  if (PM_GIT_LEADER_RX.test(predicate)) {
    if (PM_GIT_MOST_SEATS_RX.test(predicate)) {
      return {
        subject_raw: git,
        participants_raw: [],
        condition_shape: 'binary_event',
        condition_direction: null,
        condition_metric: null,
        temporal_semantics: null,
        value_primary: null,
        value_secondary: null,
        value_unit: null,
        outcome_label: null,
        event_kind: 'election_outcome_winner',
        entity_type: 'person',
        participant_type_confidence: 'low',
        source_tag: 'pm:group-item-election',
        canonical_event_override: row.non_kalshi_event_title ?? row.title,
      };
    }
    if (PM_GIT_EVENT_MEDAL_RX.test(predicate)) return generic();
    // Never stamp a raw-question parent title verbatim; the resulting event
    // must carry identity (year/proper noun).
    const leaderEvent = pmGitLeaderEvent(git, row);
    if (!leaderEvent || !pmGitOneWinnerEventOk(leaderEvent)) return generic();
    return {
      ...pmGitWinnerMatch(git, leaderEvent, 'pm:group-item-leader', tour, tourLeague),
      entity_type: 'person',
    };
  }

  const winM = predicate.match(PM_GIT_WIN_RX);
  if (winM?.groups) {
    // Trap (c): any-of/count wins are NOT single-winner slots.
    if (PM_GIT_ANY_OF_WIN_RX.test(predicate) || CHAMPIONSHIP_COUNT_TRAP_RX.test(title)) {
      return generic();
    }
    const eventPhrase = winM.groups.event.trim();
    if (PM_GIT_ELECTION_TAIL_RX.test(eventPhrase)) {
      return {
        subject_raw: git,
        participants_raw: [],
        condition_shape: 'binary_event',
        condition_direction: null,
        condition_metric: null,
        temporal_semantics: null,
        value_primary: null,
        value_secondary: null,
        value_unit: null,
        outcome_label: null,
        event_kind: 'election_outcome_winner',
        entity_type: 'person',
        participant_type_confidence: 'low',
        source_tag: 'pm:group-item-election',
        canonical_event_override: eventPhrase,
      };
    }
    if (PM_GIT_CHAMPIONSHIP_TAIL_RX.test(eventPhrase)) {
      if (PM_GIT_MULTI_LAUREATE_RX.test(eventPhrase)) return generic();
      if (PM_GIT_MEMBERSHIP_EVENT_RX.test(eventPhrase)) return generic();
      if (!pmGitOneWinnerEventOk(eventPhrase)) return generic();
      return pmGitWinnerMatch(git, eventPhrase, 'pm:group-item-champ', tour, tourLeague);
    }
    return generic();
  }

  if (PM_GIT_NOMINEE_RX.test(predicate) || PM_GIT_NEXT_OFFICE_RX.test(predicate)) {
    return {
      subject_raw: git,
      participants_raw: [],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'election_outcome_winner',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'pm:group-item-election',
      canonical_event_override: row.non_kalshi_event_title ?? row.title,
    };
  }
  const selM = predicate.match(PM_GIT_BE_SELECTED_RX);
  if (selM) {
    const eventPhrase =
      selM.groups?.event?.trim() ||
      predicate.replace(/^(?:to\s+)?be\s+(?:the\s+)?/i, '').trim();
    if (/^to\s/i.test(eventPhrase) || PM_GIT_MEMBERSHIP_EVENT_RX.test(eventPhrase)) {
      return generic();
    }
    if (PM_GIT_MULTI_LAUREATE_RX.test(eventPhrase)) return generic();
    if (!pmGitOneWinnerEventOk(eventPhrase)) return generic();
    return pmGitWinnerMatch(git, eventPhrase, 'pm:group-item-champ', tour, tourLeague);
  }

  const advM = predicate.match(PM_GIT_ADVANCE_RX);
  if (advM?.groups && PM_GIT_STAGE_TAIL_RX.test(advM.groups.event)) {
    return {
      subject_raw: git,
      participants_raw: [],
      condition_shape: 'binary_event',
      condition_direction: null,
      condition_metric: null,
      temporal_semantics: null,
      value_primary: null,
      value_secondary: null,
      value_unit: null,
      outcome_label: null,
      event_kind: 'stage_advance',
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'pm:group-item-advance',
      canonical_event_override: advM.groups.event.trim(),
    };
  }

  return generic();
}


const PREDICT_MONTH_NUM: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
// Month-end via the shared leap-correct helper (util/condition-date.ts
// monthEndIso, Date.UTC(y, m, 0)).

function parsePredictDate(s: string, endDate: string | null = null): { iso: string; precision: 'day' | 'month' | 'year' } | null {
  const txt = s.toLowerCase();
  const moM = txt.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  const yrM = txt.match(/\b(20\d{2})\b/);
  const dayM = txt.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/); // 1–2 digit day (never the 4-digit year)
  const day0 = (() => { const dm = txt.match(/(\d{1,2})(?:st|nd|rd|th)?/); return dm ? parseInt(dm[1], 10) : 1; })();
  const year = yrM ? parseInt(yrM[1], 10)
    : endDate != null ? inferYear(moM ? PREDICT_MONTH_NUM[moM[1]] : 1, day0, endDate)
    : new Date().getUTCFullYear();
  if (!moM) {
    return yrM ? { iso: `${year}-01-01`, precision: 'year' } : null;
  }
  const mo = PREDICT_MONTH_NUM[moM[1]];
  const mm = String(mo).padStart(2, '0');
  if (dayM) {
    const d = parseInt(dayM[1], 10);
    if (d >= 1 && d <= 31) return { iso: `${year}-${mm}-${String(d).padStart(2, '0')}`, precision: 'day' };
  }
  return { iso: monthEndIso(year, mo), precision: 'month' };
}

function parsePredictUsd(amt: string, unit: string | undefined): number | null {
  const n = parseFloat(amt.replace(/,/g, ''));
  if (!isFinite(n)) return null;
  const u = (unit ?? '').toUpperCase();
  const mult = u === 'B' ? 1e9 : u === 'M' ? 1e6 : u === 'K' ? 1e3 : 1;
  return n * mult;
}

const PREDICT_ADVANCE_RX =
  /^(?:will\s+)?(?:the\s+)?(?<team>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s+(?:to\s+)?(?:advance|reach|make\s+it)\s+to\s+(?:the\s+)?(?:[\p{L}\p{M}\d\s.'’\-]*?)(?:conference\s+finals?|nba\s+finals?|stanley\s+cup|super\s+bowl|world\s+series|finals?)\b.*\??$/iu;

function tryTemplatePredictStageAdvance(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict' || !row.native_question) return null;
  const m = row.native_question.match(PREDICT_ADVANCE_RX);
  if (!m?.groups) return null;
  const team = m.groups.team.trim();
  if (team.length < 2) return null;
  // event_occurrence: INDEPENDENT per-team advance binary, never
  // categorical (multiple teams advance).
  const tuple = emitCondition({
    archetype: 'event_occurrence',
    tag: 'text-deterministic-predict-advance',
    eventKind: 'stage_advance',
    metric: null,
    temporal: 'at_resolution',
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: team,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-predict-advance',
    canonical_event_override: row.native_question,
  };
}

const PM_PRIMARY_ADVANCE_DISTRICT_RX =
  /^Will\s+(?<cand>[\p{L}][\p{L}\p{M}\s.'’\-]+?)\s+advance\s+from\s+the\s+(?<state>[A-Z]{2})-(?<num>\d{1,2})\s+primary(?:\s+election)?\s*\??$/iu;
const PM_PRIMARY_ADVANCE_STATEWIDE_RX =
  /^Will\s+(?<cand>[\p{L}][\p{L}\p{M}\s.'’\-]+?)\s+advance\s+from\s+the\s+(?<year>20\d{2})\s+(?<state>[A-Za-z][A-Za-z ]+?)\s+(?<office>Governor|Senate)\s+primary\s+election\s*\??$/iu;
const PM_TOP_TWO_DISTRICT_STATES = new Set(['CA', 'WA']);
const PM_ADVANCE_TOP_N_RX = /\btop\s+(two|2|three|3|four|4)\b[^.]{0,120}?\badvance/i;
/** Residual/placeholder pseudo-candidates must never become KB persons. */
const PM_ADVANCE_PLACEHOLDER_RX = /\b(?:another|other|someone|anyone|no\s+one|nobody|neither|either)\b/i;
const PM_PRIMARY_DESCR_YEAR_RX = /\btake\s+place\s+on\s+[A-Z][a-z]+\s+\d{1,2},\s+(20\d{2})/;

function pmAdvanceRankWord(w: string): number {
  const t = w.toLowerCase();
  return t === 'two' || t === '2' ? 2 : t === 'three' || t === '3' ? 3 : 4;
}

function tryTemplatePmPrimaryAdvance(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'polymarket') return null;
  if (!/\badvance\s+from\b/i.test(row.title)) return null;

  let cand: string;
  let rank: number | null;
  let ce: string;
  let year: number | null = null;
  let yearSource = 'event-year';

  const d = row.title.match(PM_PRIMARY_ADVANCE_DISTRICT_RX);
  const s = d ? null : row.title.match(PM_PRIMARY_ADVANCE_STATEWIDE_RX);
  const topN = row.description?.match(PM_ADVANCE_TOP_N_RX);
  if (d?.groups) {
    const state = d.groups.state.toUpperCase();
    if (!PM_TOP_TWO_DISTRICT_STATES.has(state)) return null;
    cand = d.groups.cand.trim();
    rank = topN ? pmAdvanceRankWord(topN[1]!) : 2;
    const descrYear = row.description?.match(PM_PRIMARY_DESCR_YEAR_RX);
    if (descrYear) {
      year = parseInt(descrYear[1]!, 10);
    } else if (row.end_date && /^20\d{2}/.test(row.end_date)) {
      year = parseInt(row.end_date.slice(0, 4), 10);
      yearSource = 'end_date-year';
    }
    if (year == null || !Number.isInteger(year)) return null;
    ce = `${year} ${state.toLowerCase()}-${d.groups.num} primary`;
  } else if (s?.groups) {
    cand = s.groups.cand.trim();
    year = parseInt(s.groups.year, 10);
    const state = s.groups.state.trim();
    rank = topN ? pmAdvanceRankWord(topN[1]!)
         : /^(california|washington)$/i.test(state) ? 2 : null;
    if (rank == null) return null;
    ce = `${year} ${state.toLowerCase()} ${s.groups.office.toLowerCase()} primary`;
  } else {
    return null;
  }
  if (cand.length < 2 || PM_ADVANCE_PLACEHOLDER_RX.test(cand)) return null;

  const tuple = emitCondition({
    archetype: 'bespoke',
    tag: 'text-deterministic-pm-primary-advance',
    eventKind: 'primary_winner',
    metric: null,
    direction: 'below',
    temporal: 'at_resolution',
    value: { primary: rank, unit: 'rank' },
    bespoke: {
      shape: 'monotonic_threshold',
      justification: 'top-N primary advance rank latch (DW-58): rank<=N with N>1 — ' +
        'fixture_outcome.rank_latch pins N=1 and forces metric rank, but the election ' +
        'family stamps structural metric NULL; mirrors kalshi:primary-advance verbatim.',
    },
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: cand,
    participants_raw: [],
    ...tupleToTemplateFields(tuple),
    entity_type: 'person',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-pm-primary-advance',
    canonical_event_override: ce,
    condition_date_override: `${year}-01-01`,
    condition_date_precision_override: 'year',
    condition_date_source_override: yearSource,
  };
}

const PREDICT_ESPORTS_PREFIX_VS_RX =
  /^[^:]{1,60}:\s+(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)(?:\s*\(BO\d+\))?(?:\s+[-–—]\s+.*)?\s*\??$/iu;
const PREDICT_ESPORTS_BO_VS_RX =
  /^(?<a>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s+vs\.?\s+(?<b>[\p{L}\d][\p{L}\p{M}\d\s.'’\-]+?)\s*\(BO\d+\)(?:\s+[-–—]\s+.*)?\s*\??$/iu;

function tryTemplatePredictEsportsH2H(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict') return null;
  if (row.category_unified !== 'sports') return null;
  if (row.event_match_context) return null;
  // The matchup must be in this market's own title.
  if (!/\bvs\.?\b/i.test(row.title)) return null;
  const hasBoToken = /\(BO\d+\)/i.test(row.title);
  const esportsCue = /\b(?:lol|league\s+of\s+legends|dota(?:\s*2)?|cs\s*2|cs\s*:?\s*go|counter[\s-]?strike|valorant|esports?|competition\s+winner)\b/i.test(row.title);
  const hasColonPrefix = /^[^:]{1,60}:\s+/u.test(row.title) && esportsCue;
  if (!hasBoToken && !hasColonPrefix) return null;
  const m = hasColonPrefix
    ? row.title.match(PREDICT_ESPORTS_PREFIX_VS_RX)
    : row.title.match(PREDICT_ESPORTS_BO_VS_RX);
  if (!m?.groups) return null;
  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;
  if (a.includes(':') || b.includes(':')) return null;
  const tuple = emitCondition({
    archetype: 'fixture_outcome',
    topology: 'standalone_binary',
    tag: 'text-deterministic-predict-esports-h2h',
    eventKind: 'match_winner',
    metric: null,
    temporal: 'at_resolution',
  }, 'text-det');
  if (!tuple) return null;
  return {
    subject_raw: a,
    participants_raw: [a, b],
    ...tupleToTemplateFields(tuple),
    entity_type: 'team',
    participant_type_confidence: 'low',
    source_tag: 'text-deterministic-predict-esports-h2h',
  };
}

const MACRO_CUTCOUNT_RX = /^How many Fed rate cuts in (?<year>\d{4})\?:\s+(?<bucket>.+)$/i;
const MACRO_FEDDEC_RX   = /^Fed Decision in (?<month>[A-Za-z]+)\?:\s+(?<outcome>.+)$/i;
const MACRO_HIKE_RX     = /^Fed rate hike in (?<year>\d{4})\?$/i;
const MACRO_BOP_RX      = /^Balance of Power:\s+(?<year>\d{4}) Midterms:\s+(?<combo>.+)$/i;
const MACRO_PARTY_RX    = /^Which party will win the (?<chamber>Senate|House) in (?<year>\d{4})\?:\s+(?<party>.+)$/i;
const MACRO_CHAIN_RX    = /^What chain will Polymarket migrate to in (?<year>\d{4})\?:\s+(?<chain>.+)$/i;

function normBopCombo(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (/\bd\s+senate,?\s*d\s+house\b/.test(s) || /democrat.*sweep/.test(s)) return 'd-d';
  if (/\br\s+senate,?\s*r\s+house\b/.test(s) || /republican.*sweep/.test(s)) return 'r-r';
  if (/\bd\s+senate,?\s*r\s+house\b/.test(s)) return 'd-r';
  if (/\br\s+senate,?\s*d\s+house\b/.test(s)) return 'r-d';
  return 'other';
}

function tryTemplatePredictMacroPolitics(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict') return null;
  const t = row.title;

  let m = t.match(MACRO_CUTCOUNT_RX);
  if (m?.groups) {
    const year = m.groups.year;
    const bucket = m.groups.bucket.trim();
    const numM = bucket.match(/(\d+)/);
    const open = /^\s*\d+\s*\+/.test(bucket);
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-AG',
      eventKind: 'policy_action',
      metric: 'count',
      direction: open ? 'above' : numM ? 'at' : null,
      temporal: 'at_resolution',
      value: numM ? { primary: parseInt(numM[1], 10), unit: 'cuts' } : null,
      outcomeLabel: bucket.toLowerCase(),
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'Federal Reserve',
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      // Numberless buckets keep the live stamp's unit-without-value ('cuts'
      // rides outside the door's value slot — pre-port byte parity).
      ...(numM ? {} : { value_unit: 'cuts' }),
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `fed rate cuts count ${year}`,
      condition_date_override: `${year}-01-01`,
      condition_date_precision_override: 'year',
      condition_date_source_override: 'predict-title',
    };
  }

  m = t.match(MACRO_FEDDEC_RX);
  if (m?.groups) {
    const outcome = m.groups.outcome.trim();
    const bpsM = outcome.match(/(\d+)\s*\+?\s*bps/i);
    const open = /\d+\s*\+\s*bps/i.test(outcome);
    const isCut = /\b(?:decrease|cut)s?\b/i.test(outcome);
    const isHike = /\b(?:increase|hike)s?\b/i.test(outcome);
    const noChange = /\bno\s+change\b/i.test(outcome);
    const d = parsePredictDate(m.groups.month, row.end_date);
    let fedDir: ConditionDirection | null = null;
    let fedVal: { primary: number; unit: string } | null = null;
    if (noChange) {
      fedDir = 'at'; fedVal = { primary: 0, unit: 'bps' };
    } else if (bpsM && (isCut || isHike)) {
      const mag = parseInt(bpsM[1], 10);
      fedDir = open ? (isCut ? 'below' : 'above') : 'at';
      fedVal = { primary: isCut ? -mag : mag, unit: 'bps' };
    }
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-AG',
      eventKind: 'policy_action',
      metric: 'count',
      direction: fedDir,
      temporal: 'at_resolution',
      value: fedVal,
      outcomeLabel: outcome.toLowerCase(),
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'Federal Reserve',
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `fed decision ${m.groups.month.toLowerCase()}`,
      condition_date_override: d?.iso ?? null,
      condition_date_precision_override: d?.precision ?? null,
      condition_date_source_override: d ? 'predict-title' : null,
    };
  }

  m = t.match(MACRO_HIKE_RX);
  if (m?.groups) {
    const year = m.groups.year;
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag: 'text-deterministic-AG',
      eventKind: 'policy_action',
      metric: null,
      temporal: 'by_date',
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'Federal Reserve',
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `fed rate hike ${year}`,
      condition_date_override: `${year}-01-01`,
      condition_date_precision_override: 'year',
      condition_date_source_override: 'predict-title',
    };
  }

  m = t.match(MACRO_BOP_RX);
  if (m?.groups) {
    const year = m.groups.year;
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-AG',
      eventKind: 'election_outcome_winner',
      metric: null,
      temporal: 'at_resolution',
      outcomeLabel: normBopCombo(m.groups.combo),
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: `${year} US Midterm Elections`,
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'location',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `${year} us midterms balance of power`,
      condition_date_override: `${year}-11-03`,
      condition_date_precision_override: 'day',
      condition_date_source_override: 'predict-title',
    };
  }

  m = t.match(MACRO_PARTY_RX);
  if (m?.groups) {
    const year = m.groups.year;
    const chamber = m.groups.chamber.toLowerCase();
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-AG',
      eventKind: 'election_seat_winner',
      metric: null,
      temporal: 'at_resolution',
      outcomeLabel: m.groups.party.toLowerCase(),
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: `${year} US Midterm Elections`,
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'location',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `${year} us midterms ${chamber} control`,
      condition_date_override: `${year}-11-03`,
      condition_date_precision_override: 'day',
      condition_date_source_override: 'predict-title',
    };
  }

  m = t.match(MACRO_CHAIN_RX);
  if (m?.groups) {
    const year = m.groups.year;
    const tuple = emitCondition({
      archetype: 'categorical_selection',
      tag: 'text-deterministic-AG',
      eventKind: 'other',
      metric: null,
      temporal: 'at_resolution',
      outcomeLabel: m.groups.chain.toLowerCase(),
    }, 'text-det');
    if (!tuple) return null;
    return {
      subject_raw: 'Polymarket',
      participants_raw: [],
      ...tupleToTemplateFields(tuple),
      entity_type: 'team',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AG',
      canonical_event_override: `polymarket chain migration ${year}`,
      condition_date_override: `${year}-01-01`,
      condition_date_precision_override: 'year',
      condition_date_source_override: 'predict-title',
    };
  }

  return null;
}

const TWEET_COUNT_RX = /^Number of (?<person>.+?) tweets (?<window>.+?)\s+(?<year>\d{4}):\s+(?<bucket>.+)$/i;

function tryTemplatePredictTweetCount(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict') return null;
  const m = row.title.match(TWEET_COUNT_RX);
  if (!m?.groups) return null;
  const person = m.groups.person.trim();
  const window = m.groups.window.trim();
  const year = m.groups.year;
  const bucket = m.groups.bucket.trim();

  let lo: number | null = null, hi: number | null = null;
  let mm = bucket.match(/^(\d+)\s*-\s*(\d+)$/);
  if (mm) { lo = +mm[1]; hi = +mm[2]; }
  else if ((mm = bucket.match(/^(\d+)\+$/))) { lo = +mm[1]; hi = null; }
  else if ((mm = bucket.match(/between\s+(\d+)\s+and\s+(\d+)\s+times/i))) { lo = +mm[1]; hi = +mm[2]; }
  else if ((mm = bucket.match(/(\d+)\s+or\s+more\s+times/i))) { lo = +mm[1]; hi = null; }
  if (lo === null) return null;

  const windowEnd = window.split(/-|–|to/).pop()?.trim() ?? window;
  const d = parsePredictDate(`${windowEnd} ${year}`, row.end_date);
  const shared = {
    subject_raw: person,
    participants_raw: [],
    entity_type: 'person' as const,
    participant_type_confidence: 'high' as const,
    source_tag: 'text-deterministic-AH',
    canonical_event_override: `${person} tweet_count ${window} ${year}`.toLowerCase(),
    condition_date_override: d?.iso ?? null,
    condition_date_precision_override: d?.precision ?? null,
    condition_date_source_override: d ? 'predict-title' : null,
  };
  if (hi !== null) {
    const tuple = emitCondition({
      archetype: 'cumulative_count',
      arm: 'range',
      tag: 'text-deterministic-AH',
      eventKind: 'social_media_metric',
      metric: 'count',
      temporal: 'during_period',
      value: { primary: lo, secondary: hi, unit: 'tweet' },
      outcomeLabel: `${lo}-${hi}`,
    }, 'text-det');
    if (!tuple) return null;
    return { ...shared, ...tupleToTemplateFields(tuple) };
  }
  const tuple = emitCondition({
    archetype: 'cumulative_count',
    arm: 'above',
    legacyMonotonicArm: true,
    tag: 'text-deterministic-AH',
    eventKind: 'social_media_metric',
    metric: 'count',
    direction: 'above',
    temporal: 'during_period',
    value: { primary: lo, unit: 'tweet' },
    outcomeLabel: `${lo}+`,
  }, 'text-det');
  if (!tuple) return null;
  return { ...shared, ...tupleToTemplateFields(tuple) };
}

const ORD_LARGEST_RX = /^Will\s+(?<subj>.+?)\s+be\s+the\s+(?<ord>largest|(?:second|third|fourth|fifth)[- ]largest)\s+company\s+in\s+the\s+world\s+by\s+market\s+cap\s+(?:on|at|by)\s+(?<date>.+?)\s*\??$/iu;
const ORD_BESTAI_RX  = /^Will\s+(?<subj>.+?)\s+have\s+the\s+(?<ord>best|(?:second|third|fourth|fifth)\s+best|top)\s+AI\s+model\s+(?:at\s+the\s+end\s+of|by|before|on)\s+(?<date>.+?)\s*\??$/iu;
const ORD_KOL_RX     = /^Will\s+(?<subj>.+?)\s*(?:\(@[^)]+\))?\s+rank\s+(?:#(?<n>\d+)|on\s+the\s+top\s+(?<topn>\d+))\s+on\s+Xhunt'?s\s+(?:KOL\s+)?leaderboard\s+for\s+the\s+(?<lang>\w+)\s+Category\s+on\s+the\s+week\s+of\s+(?<date>.+?)\s*\??$/iu;
const ORD_RESIDUAL_RX = /^(?:Other$|Company [A-Z]$|any other company\b|none of the listed\b)/i;
const ORD_WORD_RANK: Record<string, number> = { largest: 1, best: 1, top: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

function ordWordToRank(ord: string): number {
  const w = ord.toLowerCase();
  if (w === 'largest' || w === 'best' || w === 'top') return 1;
  const lead = w.split(/[ -]/)[0];
  return ORD_WORD_RANK[lead] ?? 1;
}

function tryTemplatePredictOrdinalRanking(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict' || !row.native_question) return null;
  const q = row.native_question;

  let m = q.match(ORD_LARGEST_RX);
  if (m?.groups) {
    const subj = m.groups.subj.trim();
    if (ORD_RESIDUAL_RX.test(subj)) return null;
    const rank = ordWordToRank(m.groups.ord);
    const d = parsePredictDate(m.groups.date, row.end_date);
    const ordWord = m.groups.ord.toLowerCase().replace(/-/g, ' ');
    return {
      subject_raw: subj,
      participants_raw: [],
      condition_shape: 'categorical_outcome',
      condition_direction: 'at',
      condition_metric: 'rank',
      temporal_semantics: 'at_resolution',
      value_primary: rank,
      value_secondary: null,
      value_unit: 'rank',
      outcome_label: null,
      event_kind: 'other',
      entity_type: 'asset',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AJ',
      canonical_event_override: `${ordWord} company by market cap ${d?.iso ?? m.groups.date.trim().toLowerCase()}`,
      condition_date_override: d?.iso ?? null,
      condition_date_precision_override: d?.precision ?? null,
      condition_date_source_override: d ? 'predict-question' : null,
    };
  }

  m = q.match(ORD_BESTAI_RX);
  if (m?.groups) {
    const subj = m.groups.subj.trim();
    if (ORD_RESIDUAL_RX.test(subj)) return null;
    const rank = ordWordToRank(m.groups.ord);
    const d = parsePredictDate(m.groups.date, row.end_date);
    const ordWord = m.groups.ord.toLowerCase().replace(/\s+/g, ' ').trim();
    return {
      subject_raw: subj,
      participants_raw: [],
      condition_shape: 'categorical_outcome',
      condition_direction: 'at',
      condition_metric: 'rank',
      temporal_semantics: 'at_resolution',
      value_primary: rank,
      value_secondary: null,
      value_unit: 'rank',
      outcome_label: null,
      event_kind: 'other',
      entity_type: 'asset',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AJ',
      canonical_event_override: `${ordWord} ai model ${d?.iso ?? m.groups.date.trim().toLowerCase()}`,
      condition_date_override: d?.iso ?? null,
      condition_date_precision_override: d?.precision ?? null,
      condition_date_source_override: d ? 'predict-question' : null,
    };
  }

  m = q.match(ORD_KOL_RX);
  if (m?.groups) {
    const subj = m.groups.subj.trim();
    if (ORD_RESIDUAL_RX.test(subj)) return null;
    const lang = m.groups.lang.toLowerCase();
    const d = parsePredictDate(m.groups.date, row.end_date);
    const isMembership = row.is_neg_risk === false || m.groups.topn != null;
    const cutoff = m.groups.topn != null ? parseInt(m.groups.topn, 10)
                 : m.groups.n != null ? parseInt(m.groups.n, 10) : 1;
    const week = d?.iso ?? m.groups.date.trim().toLowerCase();
    return {
      subject_raw: subj,
      participants_raw: [],
      condition_shape: isMembership ? 'binary_event' : 'categorical_outcome',
      condition_direction: isMembership ? null : 'at',
      condition_metric: 'rank',
      temporal_semantics: 'at_resolution',
      value_primary: cutoff,
      value_secondary: null,
      value_unit: 'rank',
      outcome_label: null,
      event_kind: 'other',
      entity_type: 'person',
      participant_type_confidence: 'low',
      source_tag: 'text-deterministic-AJ',
      canonical_event_override: isMembership
        ? `xhunt kol leaderboard top ${cutoff} ${lang} week of ${week}`
        : `xhunt kol leaderboard ${lang} week of ${week}`,
      condition_date_override: d?.iso ?? null,
      condition_date_precision_override: d?.precision ?? null,
      condition_date_source_override: d ? 'predict-question' : null,
    };
  }

  return null;
}

const CF_IPO_MCAP_RX  = /^(?<company>.+?)\s+IPO\s+closing\s+market\s+cap\s+above\s+\$?(?<amt>[\d.,]+)\s*(?<unit>[KMB])?\s*\??$/iu;
const CF_FDV_RX       = /^(?<project>.+?)\s+(?:official\s+token\s+)?FDV\s+above\s+\$?(?<amt>[\d.,]+)\s*(?<unit>[KMB])?\s+one\s+day\s+after\s+launch\s*\??$/iu;
const CF_FUNDRAISE_RX = /^Over\s+\$?(?<amt>[\d.,]+)\s*(?<unit>[KkMmBb])?\s+committed\s+to\s+the\s+(?<project>.+?)\s+public\s+sale\s*\??$/iu;
const CF_TOKEN_RX     = /^Will\s+(?<project>.+?)\s+launch\s+(?:a|an|its|their|the)\s+(?:official\s+)?token\s+(?:by|in|before)\s+(?<date>.+?)\s*\??$/iu;
const CF_AIRDROP_RX   = /^Will\s+(?<project>.+?)\s+perform\s+an\s+airdrop\s+by\s+(?<date>.+?)\s*\??$/iu;
const CF_BARRIER_RX   = /^Will\s+(?<asset>.+?)\s+hit\s+\$(?<lo>[\d,]+)\s+or\s+\$(?<hi>[\d,]+)\s+first(?:\s+by\s+.+?)?\s*\??$/iu;
const CF_IPO_DEADLINE_RX = /^(?:Will\s+)?(?<company>.+?)\s+IPO\s+(?:before|by|in)\s+(?<date>.+?)\s*\??$/iu;

function tryTemplatePredictCryptoFinance(row: CandidateRow): TemplateMatch | null {
  if (row.platform !== 'predict' || !row.native_question) return null;
  if (row.category_unified !== 'crypto' && row.category_unified !== 'economic') return null;
  if (row.is_neg_risk === true) return null;
  const q = row.native_question;
  const base = {
    participants_raw: [] as string[],
    entity_type: 'asset' as const,
    participant_type_confidence: 'low' as const,
    source_tag: 'text-deterministic-AK',
    resolution_source: null as string | null,
  };

  let m = q.match(CF_IPO_MCAP_RX);
  if (m?.groups) {
    const usd = parsePredictUsd(m.groups.amt, m.groups.unit);
    if (usd === null) return null;
    const tuple = emitCondition({
      archetype: 'terminal_threshold',
      tag: 'text-deterministic-AK',
      eventKind: 'other',
      metric: 'price',
      direction: 'above',
      temporal: 'at_resolution',
      value: { primary: usd, unit: 'USD' },
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.company.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.company.trim()} ipo`.toLowerCase(),
    };
  }

  m = q.match(CF_FDV_RX);
  if (m?.groups) {
    const usd = parsePredictUsd(m.groups.amt, m.groups.unit);
    if (usd === null || usd <= 0) return null;
    const tuple = emitCondition({
      archetype: 'path_touch',
      tag: 'text-deterministic-AK',
      eventKind: 'crypto_launch_fdv',
      metric: 'price',
      direction: 'above',
      temporal: 'during_period',
      value: { primary: usd, unit: 'USD' },
      date: { forceNull: true },
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.project.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.project.trim()} launch FDV`.toLowerCase(),
    };
  }

  m = q.match(CF_FUNDRAISE_RX);
  if (m?.groups) {
    const usd = parsePredictUsd(m.groups.amt, m.groups.unit);
    if (usd === null) return null;
    const tuple = emitCondition({
      archetype: 'path_touch',
      tag: 'text-deterministic-AK',
      eventKind: 'other',
      metric: 'price',
      direction: 'above',
      temporal: 'during_period',
      value: { primary: usd, unit: 'USD' },
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.project.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.project.trim()} public sale`.toLowerCase(),
    };
  }

  m = q.match(CF_TOKEN_RX);
  if (m?.groups) {
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag: 'text-deterministic-AK',
      eventKind: 'token_launch',
      metric: null,
      temporal: 'by_date',
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.project.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.project.trim()} token launch`.toLowerCase(),
    };
  }

  m = q.match(CF_AIRDROP_RX);
  if (m?.groups) {
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag: 'text-deterministic-AK',
      eventKind: 'token_launch',
      metric: null,
      temporal: 'by_date',
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.project.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.project.trim()} token airdrop`.toLowerCase(),
    };
  }

  m = q.match(CF_BARRIER_RX);
  if (m?.groups) {
    const tuple = emitCondition({
      archetype: 'bespoke',
      tag: 'text-deterministic-AK',
      eventKind: 'other',
      metric: 'price',
      direction: null,
      temporal: 'during_period',
      value: {
        primary: parseFloat(m.groups.lo.replace(/,/g, '')),
        secondary: parseFloat(m.groups.hi.replace(/,/g, '')),
        unit: 'USD',
      },
      bespoke: {
        shape: 'categorical_outcome',
        justification: 'path-dependent 2-way barrier race: categorical_outcome+during_period is outside ' +
          'SHAPE_TEMPORAL_VALID — live stamp pinned verbatim pending adjudication A3 (extend the table ' +
          'deliberately or re-shape; never silently).',
      },
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.asset.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.asset.trim()} price barrier ${m.groups.lo.replace(/,/g, '')}-${m.groups.hi.replace(/,/g, '')}`.toLowerCase(),
    };
  }

  m = q.match(CF_IPO_DEADLINE_RX);
  if (m?.groups) {
    const tuple = emitCondition({
      archetype: 'event_occurrence',
      tag: 'text-deterministic-AK',
      eventKind: 'other',
      metric: null,
      temporal: 'by_date',
    }, 'text-det');
    if (!tuple) return null;
    return {
      ...base, subject_raw: m.groups.company.trim(),
      ...tupleToTemplateFields(tuple),
      canonical_event_override: `${m.groups.company.trim()} ipo`.toLowerCase(),
    };
  }

  return null;
}

const TEMPLATES: ReadonlyArray<(row: CandidateRow) => TemplateMatch | null> = [
  tryTemplateLimitlessMatchWinner,
  tryTemplateLimitlessSportsLadder,
  tryTemplateLimitlessElection,
  tryTemplateLimitlessCrypto,
  tryTemplateLimitlessEcon,
  tryTemplateLimitlessRatioPair,
  tryTemplateLimitlessPersonnel,
  tryTemplateRelegation,
  tryTemplatePmNextManager, // PM next-manager/coach + "out as" (personnel_move) — before C
  tryTemplatePmInflation,
  tryTemplatePmIndexLevel,
  tryTemplatePmRateDecision,
  tryTemplatePmPercentBucket,
  tryTemplatePmCountBucket,
  tryTemplatePmRtScore,
  tryTemplateAssetPriceThreshold,
  tryTemplateH2hOverUnder,
  tryTemplateDrawOutcome,
  tryTemplateBothTeamsToScore,
  tryTemplateKalshiH2hWinner,
  tryTemplateExactScore,
  tryTemplatePredictEsportsH2H,
  tryTemplatePredictStageAdvance,
  tryTemplatePmPrimaryAdvance,
  tryTemplateH2hMatchup,
  tryTemplatePredictMacroPolitics,
  tryTemplatePredictTweetCount,
  tryTemplatePredictOrdinalRanking,
  tryTemplateChampionshipWinner,
  tryTemplateStatLeader, // must come after C so COUNT_TRAP routes "win the most" here
  tryTemplateTournamentStageAdvance,
  tryTemplatePlayerProp,
  tryTemplateElectionBinary,
  tryTemplateSingleTeamWin,
  tryTemplateLeadingAtHalftime,
  tryTemplateMatchTotalMetric,
  tryTemplateMatchTotalLimitless,
  tryTemplateCryptoCandleDirection,
  tryTemplateSoccerEmojiH2h,
  tryTemplateWeatherTemperature,
  tryTemplateLimitlessPriceUtc,
  tryTemplateSpreadBet,
  tryTemplateAnytimeScorer,
  tryTemplateEsportsHandicap,
  tryTemplateEsportsSubGameProp,
  tryTemplateSocialCountThreshold,
  tryTemplatePersonSaysWord,
  tryTemplateWCount,
  tryTemplateApprovalRating,
  tryTemplateCryptoLaunchFdv,
  tryTemplateTokenLaunchByDate,
  tryTemplatePlayerFinishPosition,
  tryTemplatePredictArrowPriceThreshold,
  tryTemplatePredictCryptoFinance,
  tryTemplateCoalitionComposition,
  tryTemplateKalshiTotalsBtts,
  tryTemplateCivicLegal,
  tryTemplatePmGroupItem,
];

export function matchTemplate(row: CandidateRow): TemplateMatch | null {
  for (const tpl of TEMPLATES) {
    const hit = tpl(row);
    if (hit) return hit;
  }
  return null;
}

/** Exported for unit tests. */
export type { CandidateRow };


const _subjectSportCache = new Map<string, string | null>();

async function subjectSportFromKB(canonicalSubject: string): Promise<string | null> {
  const key = canonicalSubject.toLowerCase();
  const cached = _subjectSportCache.get(key);
  if (cached !== undefined) return cached;
  const rows = await query<{ sport_canonical: string }>(
    `SELECT DISTINCT sport_canonical
       FROM known_entities
      WHERE lower(canonical) = lower($1)
        AND sport_canonical IS NOT NULL`,
    [canonicalSubject],
  );
  const sport = rows.length === 1 ? rows[0].sport_canonical : null;
  _subjectSportCache.set(key, sport);
  return sport;
}

export async function tryNormalizeText(row: CandidateRow): Promise<DeterministicNormalizationHit | null> {
  const tpl = matchTemplate(row);
  if (!tpl) return null;

  if (!tpl.subject_native_verified && isAnonSubject(tpl.subject_raw)) {
    if (!(await kbHasRealEntity(tpl.subject_raw))) return null;
    beltHit('anon_door_kbhit', { subject: tpl.subject_raw });
  }

  const domainCategory = unifiedToDomain(row.category_unified ?? null);
  const structuralScope = inferEntityScope({
    platform:           row.platform,
    event_ticker:       row.event_ticker,
    tags:               row.tags ?? null,
    market_category:    row.market_category ?? null,
    parent_event_tags:  row.parent_event_tags ?? null,
  });
  const rawLeague = tpl.league_canonical ?? structuralScope?.league ?? null;
  let resolvedLeague: string | null = null;
  if (rawLeague) {
    const leagueHit = await leagueResolver.resolve(rawLeague, 'sports');
    resolvedLeague = leagueHit?.canonical ?? null;
  }
  const scope = {
    sport:  tpl.sport_canonical  ?? row.sport_canonical ?? structuralScope?.sport  ?? null,
    league: resolvedLeague,
  };

  const { subject: canonical_subject, participants: canonicalParticipants } =
    await resolveSubjectAndParticipants(
      tpl.subject_raw,
      tpl.participants_raw,
      domainCategory,
      scope,
    );

  if (tpl.value_unit) {
    let unitSport: string | null = scope.sport ?? null;
    const sportRemapPossible =
      (tpl.event_kind === 'match_spread' && isSportRemappableSpreadUnit(tpl.value_unit)) ||
      (tpl.event_kind === 'match_total_metric' &&
        tpl.value_unit_inferred === true &&
        isSportRemappableTotalUnit(tpl.value_unit));
    if (unitSport == null && sportRemapPossible) {
      unitSport = await subjectSportFromKB(canonical_subject);
    }
    tpl.value_unit = canonicalUnit(tpl.value_unit, {
      sport: unitSport,
      league: scope.league,
      eventKind: tpl.event_kind,
      metric: tpl.condition_metric,
      unitInferred: tpl.value_unit_inferred === true,
    });
  }

  const condition_value = formatConditionValue(
    tpl.condition_direction,
    tpl.value_primary,
    tpl.value_secondary,
    tpl.value_unit,
  );

  const typeIsLowConfidence = tpl.participant_type_confidence === 'low';
  const resolved_entities: ResolvedEntity[] = canonicalParticipants.map((name) => {
    let type: EntityType = tpl.entity_type;
    let typeBasis = 'template-high';
    if (typeIsLowConfidence) {
      const inferred = inferParticipantType({
        eventKind: tpl.event_kind,
        domainCategory,
        sport: scope.sport,
        name,
        isSubject: name === canonical_subject,
        title: row.title,
      });
      type = inferred?.type ?? 'unknown';
      typeBasis = inferred ? `rule:${inferred.basis}` : 'unknown';
    }
    const metadata: Record<string, string> = { type_basis: typeBasis, ...scopeToEntityMetadata(scope, type) };
    return { canonical: name, type, aliases: [], metadata };
  });

  let league_id: number | null = null;
  if (domainCategory === 'sports' && row.kalshi_competition) {
    league_id = await resolveKalshiCompetitionToLeagueId(row.kalshi_competition);
  }
  if (league_id == null && tpl.entity_type === 'team' && domainCategory === 'sports') {
    const entRow = await query<{ id: number; league_canonical: string | null }>(
      `SELECT id, league_canonical FROM known_entities WHERE lower(canonical) = lower($1)`,
      [canonical_subject],
    );
    const leagueCanonical = entRow[0]?.league_canonical;
    if (leagueCanonical) {
      const leagueHit = await leagueResolver.resolve(leagueCanonical, 'sports');
      if (leagueHit) league_id = leagueHit.id;
    }
  }

  const eventDate = tpl.condition_date_force_null
    ? null // genuinely-unknown date — never fabricate one
    : tpl.condition_date_override != null
    ? {
        iso: tpl.condition_date_override,
        precision: tpl.condition_date_precision_override ?? 'day',
        source: tpl.condition_date_source_override ?? 'template-override',
      }
    : extractEventDate(row);

  let conditionDateIso = tpl.condition_date_force_null
    ? null
    : (eventDate?.iso ?? row.end_date ?? null);
  let conditionDatePrecision: 'minute' | 'hour' | 'day' | 'month' | 'year' | null =
    eventDate?.precision ?? null;
  let conditionDateSource: string | null = eventDate?.source ?? null;

  if (EVENT_ANCHORED_KINDS.has(tpl.event_kind)) {
    const y = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date);
    if (y != null) {
      conditionDateIso = `${y}-01-01`;
      conditionDatePrecision = 'year';
      conditionDateSource = eventDate?.source
        ? `event-year-from-${eventDate.source}`
        : 'event-year-from-end_date';
    }
  }


  if (
    tpl.condition_metric === 'price' &&
    (tpl.condition_shape === 'point_in_time' || tpl.condition_shape === 'range_snapshot') &&
    eventDate?.precision === 'day' &&
    eventDate.iso &&
    row.end_date
  ) {
    const endDateIso = new Date(row.end_date).toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (endDateIso.slice(0, 10) === eventDate.iso.slice(0, 10)) {
      conditionDateIso = endDateIso;
      conditionDatePrecision = 'minute';
      conditionDateSource = 'end_date';
    }
  }

  const norm: LLMMarketNormalization = {
    market_id: row.market_id,
    canonical_subject,
    condition_value,
    condition_date: conditionDateIso,
    condition_date_precision: conditionDatePrecision,
    condition_date_source: conditionDateSource,
    canonical_event: deriveCanonicalEvent({
      template: tpl,
      canonical_subject,
      canonicalParticipants,
      categoryUnified: row.category_unified,
      title: row.title,
      nonKalshiEventTitle: row.non_kalshi_event_title,
      eventDateIso: eventDate?.iso ?? null,
    }).slice(0, 200),
    outcome_label: normalizeOutcomeLabel(tpl.outcome_label),
    resolved_entities,
    resolution_source: tpl.resolution_source !== undefined ? tpl.resolution_source : null,
    confidence: 0.95,
    condition_shape: tpl.condition_shape,
    condition_direction: tpl.condition_direction,
    condition_metric: tpl.condition_metric,
    temporal_semantics: tpl.temporal_semantics,
    value_primary: tpl.value_primary,
    value_secondary: tpl.value_secondary,
    value_unit: tpl.value_unit,
    participants: canonicalParticipants,
    category_unified: (row.category_unified as UnifiedCategory) ?? null,
    event_kind: tpl.event_kind,
    metric_scope: tpl.metric_scope
      ?? metricScopeFromKalshiSeries(row.event_ticker)
      ?? (row.category_unified === 'sports' ? parseMetricScopeFromTitle(row.title) : null),
    event_sourced: false,
    league_id,
    match_source: tpl.source_tag,
  };

  {
    const fixtureSubject = fixtureSubjectOverride({
      eventKind: norm.event_kind,
      metricScope: norm.metric_scope,
      participantCount: norm.participants?.length ?? 0,
      canonicalEvent: norm.canonical_event,
    });
    if (fixtureSubject) norm.canonical_subject = fixtureSubject;
  }

  warnShapePair(norm.condition_shape, norm.temporal_semantics, tpl.source_tag);
  validateConditionTuple(norm, 'text-det', tpl.source_tag);

  if (
    EVENT_ANCHORED_KINDS.has(tpl.event_kind) &&
    norm.canonical_event &&
    !looksLikePredicate(norm.canonical_event) &&
    !isNonEntityLabel(norm.canonical_event)
  ) {
    const aliases = gatedEventAlias(tpl.canonical_event_override ?? row.title)
      .filter((a) => a !== norm.canonical_event);
    resolved_entities.push({
      canonical: norm.canonical_event,
      type: 'event_name',
      aliases,
    });
  }

  if (tpl.event_kind === 'weather_extreme' && tpl.entity_type === 'location') {
    const cityMatch = /,\s*([^,]+)\s*$/.exec(canonical_subject);
    const city = cityMatch ? cityMatch[1].trim() : canonical_subject;
    resolved_entities.push({
      canonical: canonical_subject,
      type: 'location',
      aliases: stationAliasesFor(canonical_subject, city),
    });
  }

  await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCategory);
  return { norm, tag: tpl.source_tag };
}

export const TEXT_DET_CATEGORIES = [
  'sports', 'crypto', 'economic', 'election', 'politics', 'weather',
  'entertainment', 'technology',
];

export const TEXT_DET_LIVE_STATUSES = [
  'active', 'FUNDED', 'REGISTERED', 'PRICE_PROPOSED', 'PRICE_DISPUTED', 'UNPAUSED',
];

const TEXT_DET_BATCH_SIZE = parseInt(process.env.TEXT_DET_BATCH_SIZE ?? '500');
const TEXT_DET_CONCURRENCY = parseInt(process.env.TEXT_DET_CONCURRENCY ?? '8');

async function normalizeCandidateRow(
  row: CandidateRow,
): Promise<DeterministicNormalizationHit | null> {
  let hit: DeterministicNormalizationHit | null = null;
  if (row.platform === 'kalshi') hit = await tryNormalizeKalshiRow(row);
  if (!hit) hit = await tryNormalizeText(row);
  if (hit) {
    stampDiscriminators(
      { title: row.title, platform: row.platform, raw: row.raw ?? null, kb: kbFactsHandle() },
      hit.norm,
    );
  }
  return hit;
}

export async function normalizeTextDeterministic(): Promise<number> {
  await warmKBCache();
  await loadStructuralSignalsIndex();

  const maxMarkets = process.env.STAGE1_TEXT_DET_MAX_MARKETS
    ? parseInt(process.env.STAGE1_TEXT_DET_MAX_MARKETS, 10)
    : Infinity;

  let written = 0;
  let attempted = 0;
  let afterId = 0;
  const perTemplate = new Map<string, number>();

  while (attempted < maxMarkets) {
    const batchLimit = Math.min(TEXT_DET_BATCH_SIZE, maxMarkets - attempted);
    const rows = await query<CandidateRow>(`
        ${CANDIDATE_ROW_SELECT_AND_JOINS}
        WHERE m.resolved_at IS NULL
          AND m.status = ANY($4::text[])
          AND m.id > $1
          -- never normalize a stray KXMVE* parlay
          AND m.platform_id !~ '^KXMVE'
          AND (
            m.platform = 'kalshi'
            OR m.category_unified = ANY($2::text[])
          )
          AND NOT EXISTS (
            SELECT 1 FROM llm_market_normalizations n
            WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL
          )
        ORDER BY m.id
        LIMIT $3`,
      [afterId, TEXT_DET_CATEGORIES, batchLimit, TEXT_DET_LIVE_STATUSES],
    );

    if (rows.length === 0) break;

    afterId = Math.max(...rows.map(r => r.market_id));
    attempted += rows.length;

    const results = await mapWithConcurrency(rows, TEXT_DET_CONCURRENCY, async (row): Promise<DeterministicNormalizationHit | null> => {
      try {
        return await normalizeCandidateRow(row);
      } catch (err) {
        log.warn(`Market ${row.market_id} failed: ${(err as Error).message}`);
      }
      return null;
    });

    const hits = results.filter((r): r is DeterministicNormalizationHit => r !== null);
    if (hits.length > 0) {
      const norms = hits.map((h) => h.norm);
      await bulkUpsertNormalizations(norms);
      for (const hit of hits) {
        written++;
        perTemplate.set(hit.tag, (perTemplate.get(hit.tag) ?? 0) + 1);
      }
      try {
        await bulkUpdateMarketCategoryUnified(
          norms
            .filter((n) => n.category_unified != null && n.category_unified !== 'other')
            .map((n) => ({ marketId: n.market_id, categoryUnified: n.category_unified! })),
        );
      } catch (err) {
        log.warn(`bulkUpdateMarketCategoryUnified failed: ${(err as Error).message} — normalizations preserved`);
      }
    }

    process.stdout.write(
      `\r[text-deterministic] cursor=${afterId} attempted=${attempted} written=${written}  `,
    );
  }

  if (attempted > 0) process.stdout.write('\n');

  if (attempted === 0) {
    log.info('No candidate markets');
  } else {
    log.info(
      `${written}/${attempted} markets deterministically normalized; ` +
        `LLM fallback for the rest. Per template: ${JSON.stringify(
          Object.fromEntries(perTemplate),
        )}`,
    );
  }
  if (attempted >= maxMarkets) {
    log.info(`Reached STAGE1_TEXT_DET_MAX_MARKETS=${maxMarkets} cap — stopping`);
  }
  return written;
}

// Caller must have warmed the KB cache first (warmKBCache()) — this function doesn't, so the cache survives across batches.
export async function normalizeTextDeterministicBatch(
  marketIds: number[],
): Promise<Set<number>> {
  if (marketIds.length === 0) return new Set();

  const rows = await query<CandidateRow>(`
       ${CANDIDATE_ROW_SELECT_AND_JOINS}
       WHERE m.id = ANY($1::int[])
         -- never normalize a stray KXMVE* parlay
         AND m.platform_id !~ '^KXMVE'
         AND (
           m.platform = 'kalshi'
           OR m.category_unified = ANY($2::text[])
         )
         AND NOT EXISTS (
           SELECT 1 FROM llm_market_normalizations n
           WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL
         )`,
    [marketIds, TEXT_DET_CATEGORIES],
  );

  if (rows.length === 0) return new Set();

  const results = await mapWithConcurrency(
    rows,
    TEXT_DET_CONCURRENCY,
    async (row): Promise<DeterministicNormalizationHit | null> => {
      try {
        return await normalizeCandidateRow(row);
      } catch (err) {
        log.warn(`Market ${row.market_id} failed: ${(err as Error).message}`);
      }
      return null;
    },
  );

  const hits = results.filter((r): r is DeterministicNormalizationHit => r !== null);
  const normalizedIds = new Set<number>();

  if (hits.length > 0) {
    const norms = hits.map((h) => h.norm);
    await bulkUpsertNormalizations(norms);
    for (const hit of hits) normalizedIds.add(hit.norm.market_id);
    try {
      await bulkUpdateMarketCategoryUnified(
        norms
          .filter((n) => n.category_unified != null && n.category_unified !== 'other')
          .map((n) => ({ marketId: n.market_id, categoryUnified: n.category_unified! })),
      );
    } catch (err) {
      log.warn(`bulkUpdateMarketCategoryUnified failed: ${(err as Error).message} — normalizations preserved`);
    }
  }

  return normalizedIds;
}


const ANON_ROLE_NOUN_RX =
  /^(?:person|player|candidate|party|nation|placeholder|option|choice|team|company|club|league|show|movie|film|song|album|artist|character|contestant|participant|entrant|runner|individual|name|fighter|boxer|driver|golfer|jockey|horse|racer|rider|pitcher|batter|goalie|keeper|qb|coach|manager|leader|opponent|country|bank|buyer|app|coin|token|chef|couple|houseguest|gladiator|nominee)\s+(?:[A-Za-z]{1,2}|\d{1,2})$/i;

const ANON_RESIDUAL_RX =
  /^(?:other|another|someone\s+else|any\s+other|some\s+other|the\s+field|no\s+announcement|no\s+winner)\b/i;

export function isAnonSubject(subject: string): boolean {
  const s = subject.trim();
  if (!s) return true;
  if (ANON_ROLE_NOUN_RX.test(s)) return true;
  if (ANON_RESIDUAL_RX.test(s)) return true;
  if (/^[A-Z]$/.test(s)) return true;
  if (/^[a-z]{1,2}$/.test(s)) return true;
  if (/^will\s+(?:[A-Za-z]{1,2}|\d+)$/i.test(s)) return true;
  return false;
}

export function isAnonymizedMarket(label: string | null): boolean {
  if (!label) return false;
  const s = label.trim();
  if (!s) return false;
  if (ANON_ROLE_NOUN_RX.test(s)) return true;
  if (ANON_RESIDUAL_RX.test(s)) return true;
  if (/^[A-Z]$/.test(s)) return true;
  if (/^[a-z]{1,2}$/.test(s)) return true;
  return false;
}

const ANON_ROLE_NOUN_SQL =
  '(?:person|player|candidate|party|nation|placeholder|option|choice|team|company|club|league|show|movie|film|song|album|artist|character|contestant|participant|entrant|runner|individual|name|fighter|boxer|driver|golfer|jockey|horse|racer|rider|pitcher|batter|goalie|keeper|qb|coach|manager|leader|opponent|country|bank|buyer|app|coin|token|chef|couple|houseguest|gladiator|nominee)\\s+(?:[A-Za-z]{1,2}|\\d{1,2})';
const ANON_RESIDUAL_SQL =
  '(?:other|another|someone\\s+else|any\\s+other|some\\s+other|the\\s+field|no\\s+announcement|no\\s+winner)';

export function anonMarketSql(
  marketAlias: string,
  rawAlias: string,
  opts: { kbBypass?: boolean } = {},
): string {
  const label =
    `btrim(CASE ${marketAlias}.platform ` +
    `WHEN 'polymarket' THEN ${rawAlias}.raw->>'groupItemTitle' ` +
    `WHEN 'kalshi' THEN ${rawAlias}.raw->>'yes_sub_title' ` +
    `ELSE NULLIF(split_part(${marketAlias}.title, ': ', -1), ${marketAlias}.title) END)`;
  const branches =
    `lbl ~* '^${ANON_ROLE_NOUN_SQL}$' ` +
    `OR lbl ~* '^${ANON_RESIDUAL_SQL}\\y' ` +
    `OR lbl ~ '^[A-Z]$' ` +
    `OR lbl ~ '^[a-z]{1,2}$'`;
  const kbBypass = opts.kbBypass
    ? ` AND NOT EXISTS (SELECT 1 FROM known_entities _ke` +
      ` WHERE lower(immutable_unaccent(_ke.canonical)) = lower(immutable_unaccent(_a.lbl))` +
      ` AND (length(_a.lbl) > 2 OR _ke.canonical = _a.lbl)` +
      ` AND btrim(_ke.canonical) !~* '^(?:draw|tie)$'` +
      ` AND btrim(_ke.canonical) !~* '^(?:party|team)\\s+(?:[a-z]|\\d{1,2})$'` +
      ` AND btrim(_ke.canonical) !~* '^(?:artist|player|candidate|option|choice|contestant|driver|horse|fighter|entrant|golfer|chef|wrestler|nominee|pitcher|movie|song|film|show|manager|qb)\\s+(?:[a-z]{1,2}\\d{0,2}|\\d{1,2})$')`
    : '';
  return `(EXISTS (SELECT 1 FROM (SELECT (${label}) AS lbl) _a WHERE _a.lbl IS NOT NULL AND (${branches})${kbBypass}))`;
}

export function notAnonMarketSql(marketAlias: string, rawAlias: string): string {
  return `(NOT ${anonMarketSql(marketAlias, rawAlias, { kbBypass: true })})`;
}

