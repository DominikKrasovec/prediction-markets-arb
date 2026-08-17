/**
 * Deterministic bypass of Stage 1b LLM extraction for Kalshi markets whose
 * resolution is described by typed strike fields (greater/greater_or_equal/
 * less/less_or_equal/between); everything else falls through to the LLM path.
 */
import { query } from '@arb/db';
import { extractEventDate, type EventDate, type EventDatePrecision } from './event-date-extractor.js';
import { normalizeEventNoun, normalizeFixtureCanonicalEvent, normalizeOutcomeLabel, normalizePlayerStatUnit, yearFromIso, deriveCanonicalEventCore, fixtureSubjectOverride } from './event-name-normalizer.js';
import { registerEntities, resolveSubjectViaKB, providerResolver, leagueResolver, sportResolver, scopeToEntityMetadata, registerKBCacheInvalidator } from '../db/entity-registry.js';
import { resolveKalshiTickerPrefix } from '../entity-enrichment/entity-heuristic.js';
import type { KBLookupResult, KBScope } from '../db/entity-registry.js';
import type { LLMMarketNormalization, ConditionShape, ConditionDirection, ConditionMetric, TemporalSemantics, ResolvedEntity, UnifiedCategory, DataProviderMetadata, AssetMetadata, EventKind, SubjectEntityType, MetricScope } from '@arb/types';
import { isKalshiTrailingNine } from '@arb/types';
import { domainCategoryToProviderDomain, domainToResolutionKind, unifiedToDomain } from '../db/category-taxonomy.js';
import { parseMetricScopeFromTitle } from './metric-scope.js';
import { parseCandleWindow } from '../stage3-events/candle-window.js';
import { validateConditionTuple, emitCondition, type ConditionTuple } from './emit-condition.js';
import { extractKalshiWeatherStation, stationAliasesFor, stripWeatherDateSuffix } from './weather-stations.js';
import { looksLikePredicate, isNonEntityLabel } from '../db/entity/resolvers.js';
import { createLogger } from '@arb/logger';
import {
  lookupLadderSeries, extractSpreadFixture, parseGolfRoundScore, extractMusicUnitsSubject,
  parseTennisGamesSpread,
  extractRottenTomatoesSubject, isExactRottenTomatoesSeries,
  lookupWinnerSeries, extractSoccer1HFixture, extractMotorsportEvent,
  lookupDraftSeries, parseDraftPickNumber, parseDraftYear, draftCanonicalEvent,
  lookupMajorGrandSlamSeries, parseWinAChampionship, majorGrandSlamCanonicalEvent,
  extractF5SpreadFixture, parseGolfRoundTopN, golfRoundCanonicalEvent,
  lookupExactSetScoreSeries, parseExactSetScore,
  UFC_VICTORY_ROUND_PREFIX, parseUfcVictoryRound,
  UFC_METHOD_OF_VICTORY_PREFIX, parseUfcMethodOfVictory,
  WORLD_SERIES_MATCHUP_PREFIX, parseWorldSeriesMatchup,
  lookupSoccerCorrectScoreSeries, parseSoccerCorrectScore,
  lookupSetWinnerSeries, parseSetWinner,
  PGA_3BALL_PREFIX, parse3BallMatchup,
  FIRST_HURRICANE_PREFIX, parseFirstHurricane, firstHurricaneCanonicalEvent,
  EMMY_COUNT_PREFIX, parseEmmyCount,
  lookupAwardSeries, parseAwardTitle, isAwardTieNominee, awardCanonicalEvent,
  parseGolfRoundLeader, golfRoundLeaderCanonicalEvent,
  lookupDraftTopNSeries, parseDraftTopN, draftTopNCanonicalEvent,
  parseMidtermVoteTurnStatewide,
  parsePrimaryAdvance, primaryAdvanceCanonicalEvent,
  parseFedDecision, fedDecisionCanonicalEvent, fedDecisionStamp,
  type LadderSeriesSpec, type WinnerSeriesSpec, type DraftSeriesSpec,
} from './kalshi-series.js';
import { canonicalizeNormUnit } from './unit-vocab.js';
// A between strike whose bounds collapse to one point folds to the 'at' stamp, never a zero-width range.
import { snapshotStamp } from '../util/numeric-outcome.js';
import { stampConditionDate } from '../util/condition-date.js';

const log = createLogger('kalshi-deterministic');

import { gatedEventAlias } from '../util/event-alias.js';

const dedupeSorted = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))].sort();

const _providerMetaCache = new Map<number, DataProviderMetadata | null>();

const _providerHitCache = new Map<string, KBLookupResult | null>();

registerKBCacheInvalidator(() => {
  _providerHitCache.clear();
  _providerMetaCache.clear();
});

import { formatConditionValue } from '../util/condition-value.js';
import { canonicalizeIntegerThreshold, canonicalizeKalshiStrike } from '../util/threshold-canonical.js';
import { NATIVE_DRAW_SUBJECT } from '../util/native-exclusivity.js';

type TypedStrike = 'greater' | 'greater_or_equal' | 'less' | 'less_or_equal' | 'between';

const TYPED_STRIKE_SET: ReadonlySet<string> = new Set<TypedStrike>([
  'greater', 'greater_or_equal', 'less', 'less_or_equal', 'between',
]);

// lookupSeries: exact match first, then a prefix-scan for cadence-suffix variants (e.g. KXBTCD/KXBTCY).
interface SeriesMapEntry {
  subject: string;
  metric: ConditionMetric | null;  // null for non-quantitative-financial metrics (e.g. weather)
  unit: string;
  category: UnifiedCategory;
  resolutionSource: string | null;
  event_kind?: EventKind | null;
  entityType?: SubjectEntityType;
  aliases?: string[];
  perInstanceSubject?: (row: KalshiCandidateRow) => string | null;
  // windowCount marks an occurrence-tally series (routes through cumulative_count); never set on a snapshot statistic series.
  windowCount?: true;
}

// Default event_kind for a price-ladder series: 'economic' category -> econ_indicator_threshold, else count_threshold.
export function priceLadderDefaultEventKind(series: SeriesMapEntry): EventKind {
  return series.category === 'economic' ? 'econ_indicator_threshold' : 'count_threshold';
}

// Congress is keyed off the ticker's year segment: Kalshi mixes election-year and convening-year suffixes, so it can't be derived arithmetically.
const SEAT_SERIES_CONGRESS: Record<string, string> = { '27': '120th Congress', '29': '121st Congress' };
function seatCountCongressSubject(base: string): (row: KalshiCandidateRow) => string | null {
  return (row) => {
    const seg = (row.event_ticker?.split('-')[1] ?? '').match(/^\d+/)?.[0] ?? '';
    if (seg === '') return null; // no year segment → fall back to series.subject (base)
    const congress = SEAT_SERIES_CONGRESS[seg];
    return congress ? `${base} (${congress})` : `${base} (cycle ${seg})`;
  };
}

const KNOWN_SERIES_MAP: Record<string, SeriesMapEntry> = {
  KXBTC:      { subject: 'BTC',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXBTCD:     { subject: 'BTC',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXETH:      { subject: 'ETH',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXETHD:     { subject: 'ETH',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXSOL:      { subject: 'SOL',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXSOLD:     { subject: 'SOL',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXSOLE:     { subject: 'SOL',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXBNB:      { subject: 'BNB',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXBNBD:     { subject: 'BNB',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXXRP:      { subject: 'XRP',          metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXHYPE:     { subject: 'HYPE',         metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXDOGE:     { subject: 'DOGE',         metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXDOGED:    { subject: 'DOGE',         metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXSHIBA:    { subject: 'SHIB',         metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXSHIBAD:   { subject: 'SHIB',         metric: 'price', unit: 'USD', category: 'crypto',     resolutionSource: 'CF Benchmarks', event_kind: 'price_threshold' },
  KXNASDAQ:   { subject: 'NASDAQ 100',   metric: 'price', unit: 'USD', category: 'economic',  resolutionSource: null, event_kind: 'price_threshold' },
  KXINXU:     { subject: 'S&P 500',      metric: 'price', unit: 'USD', category: 'economic',  resolutionSource: null, event_kind: 'price_threshold' },
  KXGOLD:     { subject: 'Gold',         metric: 'price', unit: 'USD', category: 'economic',  resolutionSource: null, event_kind: 'price_threshold' },
  KXHOIL:     { subject: 'Heating Oil',  metric: 'price', unit: 'USD', category: 'economic',  resolutionSource: null, event_kind: 'price_threshold' },
  KXWTI:      { subject: 'WTI Crude Oil', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXBRENT:    { subject: 'Brent Crude Oil', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXSILVER:   { subject: 'Silver',        metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXCOPPER:   { subject: 'Copper',        metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXNATGAS:   { subject: 'Natural Gas',   metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXAAAGAS:   { subject: 'US Gasoline Price', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: 'AAA', event_kind: 'price_threshold' },
  KXJETFUEL:  { subject: 'Jet Fuel Price', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: 'EIA', event_kind: 'price_threshold' },

  KXH200MS:    { subject: 'NVIDIA H200',     metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXH100MS:    { subject: 'NVIDIA H100',     metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXB200MS:    { subject: 'NVIDIA B200',     metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXA100MS:    { subject: 'NVIDIA A100',     metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXRTX5090MS: { subject: 'NVIDIA RTX 5090', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },

  // KXINX (shorter prefix) must be listed after KXINXU so the prefix-scan doesn't misroute KXINXU tickers to KXINX.
  KXINX:      { subject: 'S&P 500',       metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXDJI:      { subject: 'Dow Jones Industrial Average', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },

  KXCPI:           { subject: 'US CPI',          metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXCPIYOY:        { subject: 'US CPI',          metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXCPICORE:       { subject: 'US Core CPI',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXCPICOREYOY:    { subject: 'US Core CPI',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXAIRFARECPI:    { subject: 'US Airline Fare CPI', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'BLS' },
  KXUSGASCPI:      { subject: 'US Gasoline CPI', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'BLS' },
  KXHIGHINFLATION: { subject: 'US CPI',          metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXLCPIMAXYOY:    { subject: 'US CPI',          metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' }, // "inflation surge" YoY ladder
  KXCOREUND:       { subject: 'US Core CPI',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' }, // Core CPI YoY "fall below"
  KXPCECORE:       { subject: 'US Core PCE',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BEA' },
  KXUSPPI:         { subject: 'US PPI',          metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXSHELTERCPI:    { subject: 'US Shelter CPI',  metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'BLS' },
  KXUSEDCARCPI:    { subject: 'US Used Cars and Trucks CPI', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'BLS' },
  KXTOBACCPI:      { subject: 'US Tobacco CPI',  metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'BLS' },
  KXTRUFEGGS:      { subject: 'US Eggs Price',   metric: 'price', unit: 'USD', category: 'economic', resolutionSource: 'Truflation' }, // Truflation US CPI Eggs Index, $/dozen

  KXDECPIPREL:     { subject: 'Germany CPI',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Destatis' },
  KXFRCPIPREL:     { subject: 'France CPI',      metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INSEE' },
  KXITCPIPREL:     { subject: 'Italy CPI',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Istat' },
  KXEZCPIYOYF:     { subject: 'Eurozone CPI',    metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Eurostat' },
  KXCACPIYOY:      { subject: 'Canada CPI',      metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Statistics Canada' },
  KXCHCPIYOY:      { subject: 'China CPI',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'NBS China' },
  KXBRAZILINF:     { subject: 'Brazil CPI',      metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'IBGE' },
  KXARMOMINF:      { subject: 'Argentina CPI',   metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INDEC' },     // MoM inflation
  KXJPMOMINF:      { subject: 'Japan CPI',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Statistics Bureau of Japan' }, // MoM inflation

  KXFED:           { subject: 'Federal Funds Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Federal Reserve' },
  KXFEDDECISION:   { subject: 'Federal Funds Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Federal Reserve' },
  KXRATECUTCOUNT:  { subject: 'Federal Funds Rate Cuts', metric: 'count', unit: 'cuts', category: 'economic', resolutionSource: 'Federal Reserve' },

  KXUSTYLD:        { subject: 'US Treasury Yield', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'US Treasury' },
  KXTNOTED:        { subject: 'US 10-Year Treasury Yield', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'US Treasury' },
  KXTNOTEW:        { subject: 'US 10-Year Treasury Yield', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'US Treasury' },
  KXNOTE10:        { subject: 'US 10-Year Treasury Yield', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'US Treasury' }, // 10Y yield end-of-month level
  KX30YUSTW:       { subject: 'US 30-Year Treasury Yield', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'US Treasury' }, // 30Y yield weekly

  KXMORTGAGERATE:  { subject: 'US 30-Year Mortgage Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Freddie Mac' },
  KXFM30YMTG:      { subject: 'US 30-Year Mortgage Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Freddie Mac' }, // Freddie Mac PMMS

  KXPAYROLLS:      { subject: 'US Nonfarm Payrolls', metric: 'count', unit: 'jobs', category: 'economic', resolutionSource: 'BLS' },
  KXADP:           { subject: 'US ADP Employment Change', metric: 'count', unit: 'jobs', category: 'economic', resolutionSource: 'ADP' },
  KXUE:            { subject: 'Canada Unemployment Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Statistics Canada' },
  KXU3MAX:         { subject: 'US U-3 Unemployment Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  // KXU3 must be listed explicitly: the prefix-scan would otherwise match KXU3MAX first.
  KXU3:            { subject: 'US U-3 Unemployment Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' }, // monthly U-3 level
  KXUKUNRATE:      { subject: 'UK Unemployment Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'ONS' },
  KXJOBLESSCLAIMS: { subject: 'US Initial Jobless Claims', metric: 'count', unit: 'claims', category: 'economic', resolutionSource: 'US Department of Labor' },
  KXBRAZILU:       { subject: 'Brazil Unemployment Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'IBGE' },
  KXYOUTHUN:       { subject: 'US Youth Unemployment Rate (16-24)', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' },
  KXNFPROD:        { subject: 'US Nonfarm Productivity', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BLS' }, // YoY productivity growth

  KXGDPNOM:        {
    subject: 'Nominal GDP',  // generic fallback only — perInstanceSubject is authoritative
    metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null,
    perInstanceSubject: extractKxgdpnomSubject,
  },
  KXEZGDPQOQF:     { subject: 'Eurozone GDP',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Eurostat' },
  KXEZGDPYOYF:     { subject: 'Eurozone GDP',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Eurostat' },
  KXDEGDPYOYF:     { subject: 'Germany GDP',      metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Destatis' },
  KXFRGDPQOQP:     { subject: 'France GDP',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INSEE' },
  KXFRGDPYOYP:     { subject: 'France GDP',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INSEE' },
  KXITGDPQOQA:     { subject: 'Italy GDP',        metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Istat' },
  KXITGDPYOYA:     { subject: 'Italy GDP',        metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Istat' },
  KXESGDPQOQF:     { subject: 'Spain GDP',        metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INE Spain' },
  KXESGDPYOYF:     { subject: 'Spain GDP',        metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'INE Spain' },
  KXCHGDPYOY:      { subject: 'China GDP',        metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'NBS China' },
  KXUKGDPMOM:      { subject: 'UK GDP',           metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'ONS' },
  KXGDP:           { subject: 'US GDP',           metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BEA' }, // real GDP QoQ growth
  KXGDPYEAR:       { subject: 'US GDP',           metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BEA' }, // annual GDP growth bucket-tiling
  KXNGDPQ:         { subject: 'US GDP',           metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BEA' }, // nominal GDP QoQ growth
  KXBRAZILGDP:     { subject: 'Brazil GDP',       metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'IBGE' },
  KXDEGDPQOQF:     { subject: 'Germany GDP',      metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'Destatis' }, // QoQ flash

  KXAUWPCC:        { subject: 'Australia Westpac Consumer Confidence', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'Westpac' },
  KXAUNABCONF:     { subject: 'Australia NAB Business Confidence', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'NAB' },
  KXDEZEW:         { subject: 'Germany ZEW Economic Sentiment', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'ZEW' },
  KXDEGFK:         { subject: 'Germany GfK Consumer Confidence', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'GfK' },
  KXDEIFO:         { subject: 'Germany Ifo Business Climate', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'Ifo Institute' },
  KXUSMICHCSP:     { subject: 'US Michigan Consumer Sentiment', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'University of Michigan' },

  KXEURUSD:        { subject: 'EUR/USD',          metric: 'price', unit: 'USD', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },
  KXUSDJPY:        { subject: 'USD/JPY',          metric: 'price', unit: 'JPY', category: 'economic', resolutionSource: null, event_kind: 'price_threshold' },

  KXTARIFFRATEPRC:   { subject: 'China Tariff Rate',  metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'USITC' },
  KXTARIFFRATECAN:   { subject: 'Canada Tariff Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'USITC' },
  KXTARIFFRATEEU:    { subject: 'EU Tariff Rate',     metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'USITC' },
  KXTARIFFRATEINDIA: { subject: 'India Tariff Rate',  metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'USITC' },
  KXEFFTARIFF:       { subject: 'US Effective Tariff Rate', metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: 'BEA' },
  KXTARIFFREVENUE:   { subject: 'US Tariff Revenue', metric: 'price', unit: 'USD', category: 'economic', resolutionSource: 'US Treasury' },

  KXTSAW:          { subject: 'US TSA Airport Screenings', metric: 'count', unit: 'passengers', category: 'economic', resolutionSource: 'TSA' },
  KXTRUEV:         { subject: 'Truflation EV Commodity Index', metric: 'count', unit: 'index_value', category: 'economic', resolutionSource: 'Truflation' },
  KXTRUFTSA:       { subject: 'Truflation TSA Airport Passengers', metric: 'count', unit: 'passengers', category: 'economic', resolutionSource: 'Truflation' },
  KXEHSALES:       { subject: 'US Existing Home Sales', metric: 'count', unit: 'homes_millions', category: 'economic', resolutionSource: 'NAR' },
  KXUSFLYCAN:      { subject: 'US Flight Cancellations', metric: 'count', unit: 'flights', category: 'economic', resolutionSource: 'FlightAware' },

  KXHOUSINGSTART:  { subject: 'US Housing Starts',   metric: 'count', unit: 'units', category: 'economic', resolutionSource: 'US Census Bureau' },
  KXNHSALES:       { subject: 'US New Home Sales',   metric: 'count', unit: 'homes', category: 'economic', resolutionSource: 'US Census Bureau' },
  KXCANHOUSTART:   { subject: 'Canada Housing Starts', metric: 'count', unit: 'units', category: 'economic', resolutionSource: 'CMHC' },
  KXNYCRENTSY:     { subject: 'New York City Rent',  metric: 'percentage', unit: 'percent', category: 'economic', resolutionSource: null }, // rent growth %
  KXARTISTSTREAMSY:{
    subject: 'Music Artist Streams',  // generic fallback only
    metric: 'count', unit: 'streams', category: 'entertainment', resolutionSource: 'Luminate',
    entityType: 'person',
    perInstanceSubject: extractKxartistsstreamsySubject,
  },
  KXSPACEXCOUNT:   { subject: 'SpaceX Launch Count', metric: 'count', unit: 'launches', category: 'economic', resolutionSource: 'SpaceX' },


  KXAPRPOTUS:          { subject: 'Donald Trump', metric: 'percentage', unit: 'percent', category: 'politics', resolutionSource: 'RealClearPolitics', entityType: 'person', aliases: ['Trump'], event_kind: 'approval_rating' },
  KXTRUMPAPPROVALYEAR: { subject: 'Donald Trump', metric: 'percentage', unit: 'percent', category: 'politics', resolutionSource: 'VoteHub',           entityType: 'person', aliases: ['Trump'], event_kind: 'approval_rating' },

  KXTRUMPACT:          { subject: 'Donald Trump', metric: 'count', unit: 'actions',       category: 'politics', resolutionSource: 'White House',       entityType: 'person' },
  KXTRUTHSOCIAL:       { subject: 'Donald Trump', metric: 'count', unit: 'posts',         category: 'politics', resolutionSource: 'Truth Social',      entityType: 'person' },
  KXTRUMPDELETE:       { subject: 'Donald Trump', metric: 'count', unit: 'deleted_posts', category: 'politics', resolutionSource: 'Truth Social',      entityType: 'person' },
  KXTRUMPENDORSEMENTS: { subject: 'Donald Trump', metric: 'count', unit: 'endorsements',  category: 'politics', resolutionSource: 'Truth Social',      entityType: 'person' },
  KXTRUMPENDORSELOSS:  { subject: 'Donald Trump', metric: 'count', unit: 'primary_losses', category: 'election', resolutionSource: null,               entityType: 'person' },
  KXTRUMPNUMSTATES:    { subject: 'Donald Trump', metric: 'count', unit: 'states',        category: 'politics', resolutionSource: 'VISITAREA',         entityType: 'person' },

  KXEOTRUMPTERM:       { subject: 'Donald Trump', metric: 'count', unit: 'executive_orders', category: 'politics', resolutionSource: 'White House', entityType: 'person' },
  KXEOWEEK:            { subject: 'Donald Trump', metric: 'count', unit: 'executive_orders', category: 'politics', resolutionSource: 'White House', entityType: 'person' },
  KXBILLSCOUNT:        { subject: 'Donald Trump', metric: 'count', unit: 'bills',            category: 'politics', resolutionSource: 'White House', entityType: 'person' },
  KXPARDONSTRUMP:      { subject: 'Donald Trump', metric: 'count', unit: 'pardons',          category: 'politics', resolutionSource: 'White House', entityType: 'person' },

  KXSHAKETRUMPXI:      { subject: 'Trump–Xi Handshake', metric: 'count', unit: 'seconds',    category: 'politics', resolutionSource: null,           entityType: 'event_name' },
  KXLASTWORDCOUNT:     { subject: "Lawrence O'Donnell Trump Mentions", metric: 'count', unit: 'mentions', category: 'politics', resolutionSource: 'MSNBC', entityType: 'event_name' },
  KXMUSKCHALLENGERS:   { subject: 'Elon Musk',    metric: 'count', unit: 'endorsements',     category: 'election', resolutionSource: null,           entityType: 'person', aliases: ['Musk'] },

  KXHORMUZWEEKLY:      { subject: 'Strait of Hormuz Transits', metric: 'count', unit: 'transits',     category: 'politics', resolutionSource: 'IMF PortWatch',   entityType: 'event_name' },
  KXNEWSCOTUSCONF:     { subject: 'Supreme Court Confirmations', metric: 'count', unit: 'justices',  category: 'politics', resolutionSource: 'US Senate',       entityType: 'event_name' },
  KXFEDCHAIRCOUNT:     { subject: 'Fed Chair Senate Confirmation Vote', metric: 'count', unit: 'votes', category: 'election', resolutionSource: 'US Senate',    entityType: 'event_name' },

  RSENATESEATS:      { subject: 'Republican US Senate Seats',            metric: 'count', unit: 'seats', category: 'election', resolutionSource: null, entityType: 'event_name' },
  KXDSENATESEATS:    { subject: 'Democratic US Senate Seats',            metric: 'count', unit: 'seats', category: 'election', resolutionSource: null, entityType: 'event_name', perInstanceSubject: seatCountCongressSubject('Democratic US Senate Seats') },
  KXDSENATESEATSH:   { subject: 'Democratic US Senate Seats (120th Congress)', metric: 'count', unit: 'seats', category: 'election', resolutionSource: null, entityType: 'event_name' },
  KXDHOUSESEATSDIR:  { subject: 'Democratic US House Seats',             metric: 'count', unit: 'seats', category: 'election', resolutionSource: null, entityType: 'event_name' },
  KXTXHOUSEDEMSEATS: { subject: 'Texas Democratic US House Seats',       metric: 'count', unit: 'seats', category: 'election', resolutionSource: null, entityType: 'event_name' },


  KXHIGHAUS:  { subject: 'Austin',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHCHI:  { subject: 'Chicago',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHDEN:  { subject: 'Denver',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHLAX:  { subject: 'Los Angeles',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHMIA:  { subject: 'Miami',          metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHNY:   { subject: 'New York City',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHPHIL: { subject: 'Philadelphia',   metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTATL: { subject: 'Atlanta',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTBOS: { subject: 'Boston',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTDAL: { subject: 'Dallas',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTDC:  { subject: 'Washington DC',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTHOU: { subject: 'Houston',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTLV:  { subject: 'Las Vegas',      metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTMIN: { subject: 'Minneapolis',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTNOLA:{ subject: 'New Orleans',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTOKC: { subject: 'Oklahoma City',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTPHX: { subject: 'Phoenix',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTSATX:{ subject: 'San Antonio',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTSEA: { subject: 'Seattle',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXHIGHTSFO: { subject: 'San Francisco',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTATL:  { subject: 'Atlanta',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTAUS:  { subject: 'Austin',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTBOS:  { subject: 'Boston',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTCHI:  { subject: 'Chicago',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTDAL:  { subject: 'Dallas',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTDC:   { subject: 'Washington DC',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTDEN:  { subject: 'Denver',         metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTHOU:  { subject: 'Houston',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTLAX:  { subject: 'Los Angeles',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTLV:   { subject: 'Las Vegas',      metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTMIA:  { subject: 'Miami',          metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTMIN:  { subject: 'Minneapolis',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTNOLA: { subject: 'New Orleans',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTNYC:  { subject: 'New York City',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTOKC:  { subject: 'Oklahoma City',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTPHIL: { subject: 'Philadelphia',   metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTPHX:  { subject: 'Phoenix',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTSATX: { subject: 'San Antonio',    metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTSEA:  { subject: 'Seattle',        metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXLOWTSFO:  { subject: 'San Francisco',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXTEMPNYCH: { subject: 'New York City',  metric: null, unit: 'fahrenheit', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },

  KXRAINAUSM: { subject: 'Austin',         metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINCHIM: { subject: 'Chicago',        metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINDALM: { subject: 'Dallas',         metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINDENM: { subject: 'Denver',         metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINHOUM: { subject: 'Houston',        metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINLAXM: { subject: 'Los Angeles',    metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINMIAM: { subject: 'Miami',          metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINSEAM: { subject: 'Seattle',        metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINSFOM: { subject: 'San Francisco',  metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINNYCM: { subject: 'New York City',  metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },
  KXRAINNYC:  { subject: 'New York City',  metric: 'count', unit: 'inches', category: 'weather', resolutionSource: null, entityType: 'location', event_kind: 'weather_extreme' },

  // KXHURCTOTMAJ needs its own entry so exact-match wins before the KXHURCTOT prefix-scan would otherwise absorb it.
  KXTORNADO:    { subject: 'US Tornado Count',              metric: 'count', unit: 'tornadoes',  category: 'weather', resolutionSource: 'NOAA', entityType: 'event_name', event_kind: 'weather_extreme', windowCount: true },
  KXHURCTOT:    { subject: 'Atlantic Hurricane Count',       metric: 'count', unit: 'hurricanes', category: 'weather', resolutionSource: 'NOAA', entityType: 'event_name', event_kind: 'weather_extreme' },
  KXHURCTOTMAJ: { subject: 'Atlantic Major Hurricane Count', metric: 'count', unit: 'hurricanes', category: 'weather', resolutionSource: 'NOAA', entityType: 'event_name', event_kind: 'weather_extreme' },
  KXTROPSTORM:  { subject: 'Atlantic Tropical Storm Count',  metric: 'count', unit: 'storms',     category: 'weather', resolutionSource: 'NOAA', entityType: 'event_name', event_kind: 'weather_extreme' },
};

// Cadence suffix regex: up to 4 digits + a known cadence-letter set, remainder capped at ~6 chars so it can't over-match series like KXFEDEMPLOYEES.
const SERIES_VARIANT_SUFFIX_RX = /^(\d{0,4})(D|W|M|Y|U|MON|EOD|EOY|MAX|MIN|MOM|YOY|QOQ|A|E|F|P)?$/;
const MAX_VARIANT_REMAINDER_LEN = 6;

export function lookupSeries(eventTicker: string | null): SeriesMapEntry | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split('-')[0];
  if (!prefix) return null;
  if (KNOWN_SERIES_MAP[prefix]) return KNOWN_SERIES_MAP[prefix];
  // Prefix-scan requires the remainder to be a known cadence suffix, else 'KXFEDEMPLOYEES' would falsely match 'KXFED'.
  const sortedKeys = Object.keys(KNOWN_SERIES_MAP).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (!prefix.startsWith(key)) continue;
    const remainder = prefix.slice(key.length);
    if (remainder === '') return KNOWN_SERIES_MAP[key];
    if (remainder.length <= MAX_VARIANT_REMAINDER_LEN
        && SERIES_VARIANT_SUFFIX_RX.test(remainder)) {
      return KNOWN_SERIES_MAP[key];
    }
  }
  return null;
}

// Kalshi's hourly-candle strike_date is the CF Benchmarks publish time (HH:05), 5 min after the true candle boundary (HH:00) other platforms use.
const HOURLY_CANDLE_CRYPTO_PREFIXES: ReadonlySet<string> = new Set([
  'KXBTC', 'KXBTCD',
  'KXETH', 'KXETHD',
  'KXSOL', 'KXSOLD', 'KXSOLE',
  'KXBNB', 'KXBNBD',
  'KXXRP', 'KXXRPD',
  'KXHYPE', 'KXHYPED',
  'KXDOGE', 'KXDOGED',
]);

export function isHourlyCandleCryptoSeries(eventTicker: string | null): boolean {
  if (!eventTicker) return false;
  const prefix = eventTicker.split('-')[0];
  return prefix != null && HOURLY_CANDLE_CRYPTO_PREFIXES.has(prefix);
}

export function alignHourlyCandleTimestamp(iso: string | null): string | null {
  if (!iso) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.getUTCMinutes() === 5 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    d.setUTCMinutes(0);
    return d.toISOString().replace(/\.000Z$/, 'Z');
  }
  return iso;
}

// Date precedence: weatherObsDate > strikeDateAligned > referencePeriodDate > occurrence_datetime > tickerDate > end_date.
export function resolveTypedStrikeDate(opts: {
  weatherObsDate: EventDate | null;
  strikeDateAligned: string | null;
  isHourlyCandle: boolean;
  rawStrikeDate: string | null;
  occurrenceDatetime: string | null;
  tickerDate: EventDate | null;
  endDate: string | null;
}): { iso: string | null; precision: EventDatePrecision | null; source: string | null } {
  const { weatherObsDate, strikeDateAligned, isHourlyCandle, rawStrikeDate, occurrenceDatetime, tickerDate, endDate } = opts;
  const referencePeriodDate =
    tickerDate && (tickerDate.precision === 'month' || tickerDate.precision === 'year')
      ? tickerDate
      : null;

  const iso = weatherObsDate?.iso
    ?? strikeDateAligned
    ?? referencePeriodDate?.iso
    ?? occurrenceDatetime
    ?? tickerDate?.iso
    ?? endDate
    ?? null;

  // Precision MUST mirror the `iso` precedence order exactly.
  const precision: EventDatePrecision | null =
    weatherObsDate ? weatherObsDate.precision
    : strikeDateAligned ? (isHourlyCandle && strikeDateAligned !== rawStrikeDate ? 'hour' : 'minute')
    : referencePeriodDate ? referencePeriodDate.precision
    : occurrenceDatetime ? 'minute'
    : tickerDate ? tickerDate.precision
    : endDate ? 'day'
    : null;

  const source = weatherObsDate
    ? `weather-obs-${weatherObsDate.source}`
    : strikeDateAligned
      ? (isHourlyCandle && strikeDateAligned !== rawStrikeDate
          ? 'kalshi-strike-date-aligned-hourly-candle'
          : 'kalshi-strike-date')
      : referencePeriodDate ? referencePeriodDate.source
        : occurrenceDatetime ? 'kalshi-occurrence-datetime'
          : (tickerDate?.source ?? (endDate ? 'end_date' : null));

  return { iso, precision, source };
}

// Sport canonical names must match a known_entities canonical of type='sport' (lowercase).
export interface KalshiLeagueMapEntry {
  league: string;           // canonical_subject for the type='league' KB row
  sport: string;            // canonical_subject for the type='sport' parent
  aliases?: string[];       // optional aliases to seed on creation
  // true creates a type='competition' entity (one-off tournament) instead of type='league'.
  asCompetition?: boolean;
}

export const KALSHI_COMPETITION_TO_LEAGUE: Readonly<Record<string, KalshiLeagueMapEntry>> = {
  'EPL':                       { league: 'English Premier League', sport: 'soccer', aliases: ['EPL','Premier League','English Premiership'] },
  'La Liga':                   { league: 'La Liga',                sport: 'soccer' },
  'Serie A':                   { league: 'Serie A',                sport: 'soccer' },
  'Brasileiro Serie A':        { league: 'Brasileiro Série A',     sport: 'soccer', aliases: ['Brasileiro Serie A','Brasileirão','Campeonato Brasileiro Série A'] },
  'Brasileiro':                { league: 'Brasileiro Série A',     sport: 'soccer' },
  'Bundesliga':                { league: 'Bundesliga',             sport: 'soccer' },
  'Ligue 1':                   { league: 'Ligue 1',                sport: 'soccer' },
  'MLS':                       { league: 'MLS',                    sport: 'soccer' },
  'Eredivisie':                { league: 'Eredivisie',             sport: 'soccer' },
  'Liga Portugal':             { league: 'Liga Portugal',          sport: 'soccer', aliases: ['Primeira Liga','Liga NOS'] },
  'Saudi Pro League':          { league: 'Saudi Pro League',       sport: 'soccer', aliases: ['SPL'] },
  'Israeli Super League':      { league: 'Israeli Premier League', sport: 'soccer', aliases: ['Israeli Super League','Ligat ha\'Al'] },
  'Bolivia Premier Division':  { league: 'Bolivia Premier Division', sport: 'soccer', aliases: ['LFPB','División Profesional'] },
  'FIFA World Cup':            { league: 'FIFA World Cup',         sport: 'soccer', asCompetition: true },
  'Copa do Brasil':            { league: 'Copa do Brasil',         sport: 'soccer', asCompetition: true },
  'Pro Basketball (M)':        { league: 'NBA',                    sport: 'basketball' },
  'Pro Basketball (W)':        { league: 'WNBA',                   sport: 'basketball' },
  'Pro Basketball Draft':      { league: 'NBA Draft',              sport: 'basketball', asCompetition: true },
  'College Basketball (M)':    { league: 'NCAA Men\'s Basketball', sport: 'basketball (ncaa)', aliases: ['NCAAB','College Basketball','March Madness'] },
  'Pro Baseball':              { league: 'MLB',                    sport: 'baseball' },
  'Korea KBO':                 { league: 'KBO',                    sport: 'baseball' },
  'Japan NPB':                 { league: 'NPB',                    sport: 'baseball' },
  'Pro Football':              { league: 'NFL',                    sport: 'american football' },
  'College Football':          { league: 'NCAA Football',          sport: 'american football (ncaa)', aliases: ['NCAAF','College Football'] },
  'NHL':                       { league: 'NHL',                    sport: 'ice hockey' },
  'ITF':                       { league: 'ITF',                    sport: 'tennis', aliases: ['International Tennis Federation'] },
  'ATP Rome':                  { league: 'ATP Tour',               sport: 'tennis' },
  'WTA Rome':                  { league: 'WTA Tour',               sport: 'tennis' },
  'PGA Championship':          { league: 'PGA Championship',       sport: 'golf', asCompetition: true },
  'IPL':                       { league: 'IPL',                    sport: 'cricket' },
  'County Championship':       { league: 'County Championship',    sport: 'cricket', aliases: ['English County Championship'] },
  'UFC':                       { league: 'UFC',                    sport: 'mma' },
  'Boxing':                    { league: 'Boxing',                 sport: 'boxing' },  // treats sport-name=league-name for general Boxing tag
  // 'squash' must be seeded in known_entities before the auto-seeder can link these.
  'Pro Squash (M)':            { league: 'PSA World Tour',         sport: 'squash', aliases: ['PSA Tour'] },
  'Pro Squash (W)':            { league: 'PSA World Tour',         sport: 'squash' },
  'NASCAR Cup Series':         { league: 'NASCAR Cup Series',      sport: 'nascar' },
  'NASCAR O\'Reilly Auto Parts Series': { league: 'NASCAR Xfinity Series', sport: 'nascar', aliases: ['NASCAR O\'Reilly Auto Parts Series'] },
  'NASCAR Truck Series':       { league: 'NASCAR Truck Series',    sport: 'nascar' },
  'NWSL':                      { league: 'NWSL',                   sport: 'soccer', aliases: ['National Women\'s Soccer League'] },
  'USL Championship':          { league: 'USL Championship',       sport: 'soccer', aliases: ['USL'] },
  'Chinese Super League':      { league: 'chinese super league',   sport: 'soccer', aliases: ['Chinese Super League','CSL'] },
  'Belgian Pro League':        { league: 'Belgian Pro League',     sport: 'soccer' },
  'Greece Super League':       { league: 'Greek Super League',     sport: 'soccer', aliases: ['Super League Greece'] },
  'Korea K League 1':          { league: 'K League 1',             sport: 'soccer' },
  'Argentina Primera Division':{ league: 'Argentine Primera División', sport: 'soccer', aliases: ['Argentina Primera Division','Liga Profesional Argentina'] },
  'Champions League':          { league: 'Champions League',       sport: 'soccer' },
  'Champions League Womens':   { league: 'UEFA Women\'s Champions League', sport: 'soccer', aliases: ['Champions League Womens','UWCL'] },
  'Europa League':             { league: 'Europa League',          sport: 'soccer' },
  'Conference League':         { league: 'Conference League',      sport: 'soccer' },
  'College Baseball':          { league: 'NCAA Baseball',          sport: 'baseball', aliases: ['College Baseball','NCAA Baseball'] },
  'College Basketball (W)':    { league: 'NCAA Women\'s Basketball', sport: 'basketball (ncaa)', aliases: ['NCAAW','College Basketball (W)'] },
  'College Lacrosse':          { league: 'NCAA Lacrosse',          sport: 'lacrosse', aliases: ['College Lacrosse','NCAA Lacrosse'] },
  'National Rugby League':     { league: 'NRL',                    sport: 'rugby league', aliases: ['National Rugby League'] },
  'Super League Rugby':        { league: 'Super League',           sport: 'rugby league', aliases: ['Super League Rugby'] },
  'Gallagher Premiership':     { league: 'Gallagher Premiership Rugby', sport: 'rugby union', aliases: ['Gallagher Premiership','English Premiership Rugby'] },
  'Premier League Darts':      { league: 'Premier League Darts',   sport: 'darts' },
  'Sumo Wrestling':            { league: 'Grand Sumo Tournament',  sport: 'sumo', aliases: ['Sumo Wrestling','Honbasho'], asCompetition: true },
  'PGA':                       { league: 'PGA Tour',               sport: 'golf' },
  'Truist Championship':       { league: 'PGA Tour',               sport: 'golf' },
  'Kroger Queen City Championship presented by P&G': { league: 'LPGA Tour', sport: 'golf', aliases: ['LPGA Tour'] },
  'Mizuho Americas Open':      { league: 'LPGA Tour',              sport: 'golf' },
  'Estrella Damm Catalunya Championship': { league: 'DP World Tour', sport: 'golf', aliases: ['European Tour','DP World Tour'] },
  'Ryder Cup':                 { league: 'Ryder Cup',              sport: 'golf', asCompetition: true },
  'Presidents Cup':            { league: 'Presidents Cup',         sport: 'golf', asCompetition: true },
  'ATP French Open':           { league: 'ATP Tour',               sport: 'tennis' },
  'WTA French Open':           { league: 'WTA Tour',               sport: 'tennis' },
  // Esports families left unmapped — see header doc; "League of Legends" etc.
  // are sport-level entities, not league-level, and Kalshi's competition tag
  // doesn't distinguish specific tournaments.
};

function lookupCompetitionByPrefix(competition: string): KalshiLeagueMapEntry | null {
  if (competition.startsWith('ATP ') || competition.startsWith('ATP Challenger ')) {
    return { league: 'ATP Tour', sport: 'tennis' };
  }
  if (competition.startsWith('WTA ') || competition.startsWith('WTA 125K ') || competition.startsWith('WTA Challenger ')) {
    return { league: 'WTA Tour', sport: 'tennis' };
  }
  return null;
}

// Returns null for an unmapped competition string rather than auto-coining a new league (curated map only).
export async function resolveKalshiCompetitionToLeagueId(
  competition: string | null | undefined,
): Promise<number | null> {
  if (!competition) return null;
  const entry = KALSHI_COMPETITION_TO_LEAGUE[competition]
    ?? lookupCompetitionByPrefix(competition);
  if (!entry) return null;

  // Sport must resolve before the league auto-seed so the entity_relations link has a valid parent.
  const sportHit = await sportResolver.resolve(entry.sport, 'sports');
  if (!sportHit) {
    log.warn(
      `Cannot resolve/auto-seed league "${entry.league}" — parent sport `
      + `"${entry.sport}" not in known_entities. Seed the sport entity first.`,
    );
    return null;
  }

  const resolved = await leagueResolver.resolve(
    entry.league,
    'sports',
    { sport_canonical: entry.sport },
    { aliases: entry.aliases ?? [] },
  );
  if (!resolved) {
    log.warn(`Auto-seed of league "${entry.league}" returned null — likely cross-type conflict`);
    return null;
  }

  await query(
    `INSERT INTO entity_relations (parent_id, child_id, relation)
     VALUES ($1, $2, 'part_of')
     ON CONFLICT (parent_id, child_id, relation) DO NOTHING`,
    [resolved.id, sportHit.id],
  );

  return resolved.id;
}

export interface KalshiCandidateRow {
  market_id: number;
  platform_id: string;
  title: string;
  end_date: string | null;
  category_unified: UnifiedCategory | null;
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
  expected_expiration_time?: string | null;
  mve_selected_legs: { side: string; market_ticker: string; event_ticker?: string }[] | null;
  mve_collection_ticker: string | null;
  kalshi_competition: string | null;
}

interface KalshiNormalizationHit {
  norm: LLMMarketNormalization;
  tag: string;
}

function toNumber(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Kalshi encodes strict-above as floor = X - 0.01 (or -0.0001 for indices); rounds up so it matches the >= X threshold other platforms quote.
export function quantizeKalshiStrike(value: number | null): number | null {
  if (value == null) return null;
  return isKalshiTrailingNine(value) ? Math.round(value) : value;
}

export function resolvePriceLadderStamp(
  sd: { shape: ConditionShape; direction: ConditionDirection },
  floor: number | null,
  cap: number | null,
): { shape: ConditionShape; direction: ConditionDirection; value_primary: number | null; value_secondary: number | null } {
  if (sd.direction === 'above') {
    return { shape: sd.shape, direction: sd.direction, value_primary: floor, value_secondary: null };
  }
  if (sd.direction === 'below') {
    return { shape: sd.shape, direction: sd.direction, value_primary: cap, value_secondary: null };
  }
  if (floor != null && cap != null && floor === cap) {
    const at = snapshotStamp({ kind: 'at', v: floor });
    return { shape: at.shape, direction: at.direction, value_primary: at.vp, value_secondary: at.vs };
  }
  return { shape: sd.shape, direction: sd.direction, value_primary: floor, value_secondary: cap };
}

// KXTRUMPAPPROVALYEAR routes as during_period (window match); KXAPRPOTUS stays a dated snapshot.
export function isVoteHubApprovalYearTicker(eventTicker: string | null | undefined): boolean {
  return eventTicker != null && /^KXTRUMPAPPROVALYEAR(?:-|$)/.test(eventTicker.toUpperCase());
}


function deriveShapeAndDirection(
  strike_type: string,
): { shape: ConditionShape; direction: ConditionDirection } | null {
  switch (strike_type) {
    case 'greater':
    case 'greater_or_equal':
      return { shape: 'point_in_time', direction: 'above' };
    case 'less':
    case 'less_or_equal':
      return { shape: 'point_in_time', direction: 'below' };
    case 'between':
      return { shape: 'range_snapshot', direction: 'between' };
    default:
      return null;
  }
}

function deriveCustomStrike(
  rules: string | null,
): { shape: ConditionShape; direction: ConditionDirection; floor: number | null; cap: number | null } | null {
  if (!rules) return null;
  const range = rules.match(/is between\s+([\d.]+)-([\d.]+)/i);
  if (range) return { shape: 'range_snapshot', direction: 'between', floor: parseFloat(range[1]), cap: parseFloat(range[2]) };
  const above = rules.match(/is above\s+([\d.]+)/i);
  if (above) return { shape: 'point_in_time', direction: 'above', floor: parseFloat(above[1]), cap: null };
  const below = rules.match(/is below\s+([\d.]+)/i) ?? rules.match(/is less than\s+([\d.]+)/i);
  if (below) return { shape: 'point_in_time', direction: 'below', floor: null, cap: parseFloat(below[1]) };
  return null;
}

type StrikeDerivation = {
  shape: ConditionShape;
  direction: ConditionDirection;
  floor: number | null;
  cap: number | null;
  strikeType?: TypedStrike | null;
};

// Normalizes Kalshi's three strike encodings (top-level typed, nested custom, rules_primary prose) into one (shape, direction, floor, cap).
export function deriveStrike(row: {
  strike_type: string | null;
  floor_strike: string | null;
  cap_strike: string | null;
  custom_strike: string | null;
  rules_primary: string | null;
}): StrikeDerivation | null {
  let type = row.strike_type;
  let floorStr = row.floor_strike;
  let capStr = row.cap_strike;

  if (type === 'custom' && row.custom_strike) {
    try {
      const nested = JSON.parse(row.custom_strike) as { strike_type?: unknown; floor_strike?: unknown; cap_strike?: unknown };
      if (typeof nested.strike_type === 'string') {
        type = nested.strike_type;
        floorStr = typeof nested.floor_strike === 'string' ? nested.floor_strike : null;
        capStr = typeof nested.cap_strike === 'string' ? nested.cap_strike : null;
      }
    } catch {
      /* malformed JSON → fall through to the prose fallback */
    }
  }

  if (type && TYPED_STRIKE_SET.has(type)) {
    const sd = deriveShapeAndDirection(type);
    if (sd) return { ...sd, floor: toNumber(floorStr), cap: toNumber(capStr), strikeType: type as TypedStrike };
  }

  // strike_type='structured' numeric ladders carry the real threshold in floor/cap with an opaque uuid in custom_strike; only routes here when a typed floor/cap is present.
  if (row.strike_type === 'structured') {
    const f = toNumber(floorStr);
    const c = toNumber(capStr);
    if (f != null || c != null) {
      // floor+cap → between(range); floor-only → above(greater); cap-only → below(less).
      const structuredType: TypedStrike =
        f != null && c != null ? 'between' : f != null ? 'greater' : 'less';
      const sd = deriveShapeAndDirection(structuredType);
      if (sd) return { ...sd, floor: f, cap: c, strikeType: structuredType };
    }
  }

  // Legacy prose fallback ('above'/'below') is always STRICT — there is no >=/<= form in the text.
  if (row.strike_type === 'custom') {
    const prose = deriveCustomStrike(row.rules_primary);
    return prose ? { ...prose, strikeType: prose.direction === 'below' ? 'less' : 'greater' } : null;
  }
  return null;
}

// MVE (parlay) event_tickers are AND-conjunctions of N legs; the structured leg list is raw->'mve_selected_legs'.
const PARLAY_SERIES_PREFIXES: readonly string[] = [
  'KXMVESPORTS',   // esports multi-game parlays (~212k)
  'KXMVECROSS',    // cross-category parlays (~140k)
];

function isParlaySeries(eventTicker: string | null): boolean {
  if (!eventTicker) return false;
  return PARLAY_SERIES_PREFIXES.some((p) => eventTicker.startsWith(p));
}


interface StatSeriesSpec {
  expectedUnit: string; // canonical value_unit; '' = require unit from title
  category: UnifiedCategory;
  leagueCanonical: string | null; // KB-seeded league name for league_id resolution
  sport: string | null; // KB-canonical sport name — matches metadata.sport_canonical
}

const PLAYER_STAT_SERIES_MAP: Record<string, StatSeriesSpec> = {
  KXNBAPTS:  { expectedUnit: 'points',     category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' },
  KXNBAREB:  { expectedUnit: 'rebounds',   category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' },
  KXNBAAST:  { expectedUnit: 'assists',    category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' },
  KXNBASTL:  { expectedUnit: 'steals',     category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' },
  KXNBABLK:  { expectedUnit: 'blocks',     category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' },
  KXNBA:     { expectedUnit: '',           category: 'sports', leagueCanonical: 'NBA', sport: 'basketball' }, // mixed; require unit in title
  KXMLBHR:   { expectedUnit: 'home_runs',  category: 'sports', leagueCanonical: 'MLB', sport: 'baseball' },
  KXMLBKS:   { expectedUnit: 'strikeouts', category: 'sports', leagueCanonical: 'MLB', sport: 'baseball' },
  KXNHLGOAL: { expectedUnit: 'goals',      category: 'sports', leagueCanonical: 'NHL', sport: 'ice hockey' },
  KXNHLPTS:  { expectedUnit: 'points',     category: 'sports', leagueCanonical: 'NHL', sport: 'ice hockey' },
  KXNHLAST:  { expectedUnit: 'assists',    category: 'sports', leagueCanonical: 'NHL', sport: 'ice hockey' },
  KXNFLSEASONRECYDS:  { expectedUnit: 'receiving_yards', category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
  KXNFLSEASONPASSYDS: { expectedUnit: 'passing_yards',   category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
  KXNFLSEASONRSHYDS:  { expectedUnit: 'rushing_yards',   category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
  KXMLBSEASONHR:      { expectedUnit: 'home_runs',       category: 'sports', leagueCanonical: 'MLB', sport: 'baseball' },
  KXNFLSEASONRSHTD:   { expectedUnit: 'rushing_touchdowns',   category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
  KXNFLSEASONRECTD:   { expectedUnit: 'receiving_touchdowns', category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
  KXNFLSEASONREC:     { expectedUnit: 'receptions',           category: 'sports', leagueCanonical: 'NFL', sport: 'american football' },
};

// Order matters: longer/more-specific prefixes first so KXNBAPTS wins over KXNBA.
const PLAYER_STAT_PREFIXES: readonly string[] = [
  'KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBASTL', 'KXNBABLK',
  'KXMLBHR', 'KXMLBKS',
  'KXNHLGOAL', 'KXNHLPTS', 'KXNHLAST',
  'KXNFLSEASONRECYDS', 'KXNFLSEASONPASSYDS', 'KXNFLSEASONRSHYDS',
  // 'KXNFLSEASONREC' is a startsWith-prefix of the '…RECYDS'/'…RECTD' tickers, so it must be listed after both.
  'KXNFLSEASONRSHTD', 'KXNFLSEASONRECTD', 'KXNFLSEASONREC',
  'KXMLBSEASONHR',
  'KXNBA',
];

export function resolvePlayerStatSeries(
  eventTicker: string | null | undefined,
): { prefix: string; spec: StatSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = PLAYER_STAT_PREFIXES.find((p) => eventTicker.startsWith(p));
  return prefix ? { prefix, spec: PLAYER_STAT_SERIES_MAP[prefix]! } : null;
}

// Uses 'u' flag for full Unicode property escapes so accented names (José Ramírez, …) match.
const PLAYER_STAT_RX = /^(?<player>[\p{Lu}\p{Lt}][\p{L}\p{M}.'\-]+(?:\s+[\p{L}\p{M}.'\-]+){0,4}):\s*(?<value>\d+(?:\.\d+)?)\+\s*(?<unit>home runs?|three[- ]pointers?|threes?|rebounds?|assists?|points?|strikeouts?|blocks?|steals?|goals?|saves?|hits?|walks?|stolen bases?|rbis?|yards?|touchdowns?|doubles?|runs?)?\??$/u;

const SEASON_STAT_RX =
  /^Will\s+.+?\s+record\s+(?<value>\d+(?:\.\d+)?)\+\s+[A-Za-z][A-Za-z ]+?\s+during\b.*\bregular season\b/i;

export function parseSeasonStatThreshold(title: string): number | null {
  const m = title.match(SEASON_STAT_RX);
  return m?.groups?.value ? parseFloat(m.groups.value) : null;
}

// Uses the same unit normalizer as Polymarket Template E so both platforms produce byte-identical canonical units.
function normalizeStatUnit(raw: string | undefined, fallback: string): string {
  return normalizePlayerStatUnit(raw, fallback);
}

// Returns null (not a placeholder string) when platform_id is missing/sentinel, so Stage 3 declines the pair instead of collapsing sentinel-tagged markets.
function buildSingleLegSignature(platformTicker: string | null | undefined): string[] | null {
  if (!platformTicker) return null;
  const t = String(platformTicker);
  if (t === 'undefined' || t === 'null' || t === '') return null;
  return [`yes|${t}`];
}

// Returns null if any leg lacks side/market_ticker or is a sentinel value (same null-not-placeholder rule as buildSingleLegSignature).
function buildParlayLegSignatures(
  legs: { side: string; market_ticker: string }[],
): string[] | null {
  const out: string[] = [];
  for (const l of legs) {
    if (!l.side || !l.market_ticker) return null;
    const side = String(l.side);
    const ticker = String(l.market_ticker);
    if (side !== 'yes' && side !== 'no') return null;
    if (ticker === 'undefined' || ticker === 'null' || ticker === '') return null;
    out.push(`${side}|${ticker}`);
  }
  return out.sort();
}

function deterministicAssetMetadata(subject: string, category: UnifiedCategory): Partial<AssetMetadata> {
  if (category === 'crypto') {
    return { kind: 'asset', asset_class: 'crypto', ticker: subject };
  }
  if (/NASDAQ|S&P/i.test(subject)) {
    return { kind: 'asset', asset_class: 'index', ticker: subject };
  }
  return { kind: 'asset', asset_class: 'commodity' };
}


function extractKxartistsstreamsySubject(row: KalshiCandidateRow): string | null {
  const src = row.event_title ?? row.title;
  if (!src) return null;
  const m = src.match(/^(.+?)\s+Streams\s+in\s+\d{4}\s*\??\s*$/i);
  const subject = m?.[1]?.trim();
  if (subject && subject.length >= 1 && subject.length <= 80) return subject;
  const mt = (row.title ?? '').match(/^Will\s+(.+?)\s+have\s+[\d.]+\s*\w*\s+Streams\s+on\s+Luminate/i);
  return mt?.[1]?.trim() ?? null;
}

function extractKxgdpnomSubject(row: KalshiCandidateRow): string | null {
  const src = row.event_title ?? row.title;
  if (!src) return null;
  const m = src.match(/^(.+?)\s+Nominal\s+GDP\b/i);
  const country = m?.[1]?.trim();
  if (country && country.length >= 1 && country.length <= 40) return `${country} Nominal GDP`;
  return null;
}

// Two strings that fold equal are a Tier-1 exact/alias hit, not a Tier-2 fuzzy merge.
function foldPerInstanceSubject(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Rejects a Tier-2 KB resolution that isn't fold-equal to the extracted subject (blocks cross-country/cross-artist collapse via embedding similarity).
export function acceptPerInstanceSubject(
  subjectInput: string,
  resolvedCanonical: string,
  isPerInstance: boolean,
): string {
  if (!isPerInstance) return resolvedCanonical;
  if (resolvedCanonical === subjectInput) return resolvedCanonical;
  return foldPerInstanceSubject(resolvedCanonical) === foldPerInstanceSubject(subjectInput)
    ? resolvedCanonical
    : subjectInput;
}

// assembleKalshiNorm centralizes date precedence, condition_value formatting, and leg_signatures defaults shared by every Kalshi handler.

interface KalshiNormParts {
  subject: string;
  // canonical_event: callers still apply their own .slice(0, 200) cap.
  canonicalEvent: string;
  shape: ConditionShape;
  direction: ConditionDirection | null;
  metric: ConditionMetric | null;
  temporal: TemporalSemantics | null;
  valuePrimary: number | null;
  valueSecondary?: number | null;
  valueUnit: string | null;
  // conditionValue omitted -> derived via formatConditionValue(direction, values, unit).
  conditionValue?: string | null;
  // date omitted -> default occurrence_datetime ?? end_date precedence.
  date?: { iso: string | null; precision: EventDatePrecision | null; source: string | null };
  outcomeLabel?: string | null;
  resolvedEntities: ResolvedEntity[];
  resolutionSource?: string | null;
  // metricScope: non-null always wins; omitted falls back to parseMetricScopeFromTitle(row.title).
  metricScope?: MetricScope | null;
  // participants passed through unsorted as given; callers own dedupeSorted (do not auto-sort here).
  participants: string[];
  category: UnifiedCategory | null;
  leagueId?: number | null;
  eventKind?: EventKind | null;
  // Omitted -> buildSingleLegSignature(row.platform_id).
  legSignatures?: string[] | null;
}

// value_unit arrives foldUnit()-ed; the exit wrapper's canonicalizeNormUnit restores canonical casing in both value_unit and condition_value together.
function tupleConditionParts(t: ConditionTuple): Pick<KalshiNormParts,
  'shape' | 'direction' | 'metric' | 'temporal' | 'valuePrimary' | 'valueSecondary' | 'valueUnit'> {
  return {
    shape: t.condition_shape,
    direction: t.condition_direction,
    metric: t.condition_metric,
    temporal: t.temporal_semantics,
    valuePrimary: t.value_primary,
    valueSecondary: t.value_secondary,
    valueUnit: t.value_unit,
  };
}


function kalshiSeriesPrefix(row: KalshiCandidateRow): string | null {
  return row.event_ticker ? row.event_ticker.split('-')[0] : null;
}

function seriesSpecFor<T>(row: KalshiCandidateRow, map: Record<string, T>): T | null {
  const prefix = kalshiSeriesPrefix(row);
  if (!prefix) return null;
  return map[prefix] ?? null;
}

async function resolveLeague(league: string | null | undefined): Promise<{ id: number | null; canonical: string | null }> {
  if (!league) return { id: null, canonical: null };
  const lh = await leagueResolver.resolve(league, 'sports');
  return { id: lh?.id ?? null, canonical: lh?.canonical ?? null };
}

// Returns undefined (not {}) when metadata is empty, so we never stamp an empty object over an existing value.
function metaOrUndef(meta: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function scopedEntityMetadata(scope: KBScope | null | undefined, entityType: string): Record<string, string> | undefined {
  return metaOrUndef(scopeToEntityMetadata(scope, entityType));
}

// DEADLINE precedence (expected_expiration_time before end_date) is for 'before <date>' questions; distinct from the DEFAULT occurrence-based precedence used by fixture questions.
function kalshiExpirationDate(row: KalshiCandidateRow): { iso: string | null; precision: EventDatePrecision | null; source: string | null } {
  return {
    iso: row.expected_expiration_time ?? row.end_date ?? null,
    precision: (row.expected_expiration_time || row.end_date) ? 'day' : null,
    source: row.expected_expiration_time ? 'kalshi-expected-expiration-time' : (row.end_date ? 'end_date' : null),
  };
}

function assembleKalshiNorm(
  row: KalshiCandidateRow,
  parts: KalshiNormParts,
  tag: string,
): LLMMarketNormalization {
  // DEFAULT date precedence: occurrence_datetime (minute) -> end_date (day) -> null.
  const date = parts.date ?? {
    iso: row.occurrence_datetime ?? row.end_date ?? null,
    precision: row.occurrence_datetime ? ('minute' as const) : (row.end_date ? ('day' as const) : null),
    source: row.occurrence_datetime ? 'kalshi-occurrence-datetime' : (row.end_date ? 'end_date' : null),
  };
  const metricScope: MetricScope | null = (parts.metricScope ?? null) !== null
    ? (parts.metricScope as MetricScope)
    : (parts.category === 'sports' ? parseMetricScopeFromTitle(row.title) : null);
  return {
    market_id: row.market_id,
    canonical_subject: parts.subject,
    condition_value: parts.conditionValue !== undefined
      ? parts.conditionValue
      : formatConditionValue(parts.direction, parts.valuePrimary, parts.valueSecondary ?? null, parts.valueUnit),
    condition_date: date.iso,
    condition_date_precision: date.precision,
    condition_date_source: date.source,
    canonical_event: parts.canonicalEvent,
    outcome_label: parts.outcomeLabel ?? null,
    resolved_entities: parts.resolvedEntities,
    resolution_source: parts.resolutionSource ?? null,
    confidence: 1.0,
    condition_shape: parts.shape,
    condition_direction: parts.direction,
    condition_metric: parts.metric,
    metric_scope: metricScope,
    temporal_semantics: parts.temporal,
    value_primary: parts.valuePrimary,
    value_secondary: parts.valueSecondary ?? null,
    value_unit: parts.valueUnit,
    participants: parts.participants,
    category_unified: parts.category,
    event_sourced: false,
    league_id: parts.leagueId ?? null,
    event_kind: parts.eventKind ?? null,
    match_source: tag,
    leg_signatures: parts.legSignatures !== undefined
      ? parts.legSignatures
      : buildSingleLegSignature(row.platform_id),
  };
}

// Tries price-ladder, then parlay, then player-stat sub-parsers in order; returns null (falls through to text-det/LLM) if none match.
export async function tryNormalizeKalshiRow(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const hit = await tryNormalizeKalshiRowInner(row);
  if (!hit) return null;
  canonicalizeNormUnit(hit.norm);
  validateConditionTuple(hit.norm, 'kalshi-det', hit.tag);
  return hit;
}

// Pass 0: KX{ASSET}15M candle-direction markets mirror the cross-platform 'Up or Down' candle_direction shape so the Stage-3b matcher aligns them.
function tryCryptoCandleDirection(row: KalshiCandidateRow): KalshiNormalizationHit | null {
  if (row.category_unified != null && row.category_unified !== 'crypto') return null;
  const prefix = kalshiSeriesPrefix(row);
  if (!prefix || !/15M$/.test(prefix)) return null;

  const w = parseCandleWindow(row.title);
  if (!w) return null;

  const openIso = row.open_time;
  if (!openIso) return null;
  const open = new Date(openIso);
  if (Number.isNaN(open.getTime())) return null;

  const asset = w.asset;
  const resolved_entities: ResolvedEntity[] = [{ canonical: asset, type: 'asset', aliases: [] }];
  const norm = assembleKalshiNorm(row, {
    subject: asset,
    canonicalEvent: `${asset} Up or Down`,
    shape: 'binary_event',
    direction: 'above',            // YES = price rose over the candle window
    metric: 'price',
    temporal: 'on_date',
    valuePrimary: null,
    valueUnit: null,
    outcomeLabel: `${w.durationMin}m`,
    date: { iso: openIso, precision: 'minute', source: 'kalshi-candle-open' },
    resolvedEntities: resolved_entities,
    participants: [],
    category: 'crypto',
    eventKind: 'candle_direction',
    resolutionSource: 'CF Benchmarks',
  }, 'kalshi:crypto-candle');
  return { norm, tag: 'kalshi:crypto-candle' };
}

async function tryNormalizeKalshiRowInner(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  // Must run before the price-ladder pass: its variant-scan would otherwise claim '*15M' tickers as an absolute price threshold.
  const candle = tryCryptoCandleDirection(row);
  if (candle) return candle;

  const series = lookupSeries(row.event_ticker);
  if (series) {
    const sdv = deriveStrike(row);
    if (sdv) {
      const floor = quantizeKalshiStrike(sdv.floor);
      const cap   = quantizeKalshiStrike(sdv.cap);
      const stampRaw = resolvePriceLadderStamp(sdv, floor, cap);
      const stamp = (() => {
        if ((stampRaw.direction === 'above' || stampRaw.direction === 'below') &&
            stampRaw.value_primary != null && sdv.strikeType != null) {
          const strictness =
            sdv.strikeType === 'greater_or_equal' || sdv.strikeType === 'less_or_equal'
              ? 'inclusive' as const : 'strict' as const;
          const c = canonicalizeIntegerThreshold({
            direction: stampRaw.direction,
            value: stampRaw.value_primary,
            unit: series.unit,
            strictness,
          });
          return { ...stampRaw, value_primary: c.value };
        }
        return stampRaw;
      })();
      const tag = series.category === 'weather' ? 'kalshi:weather' : 'kalshi:price-ladder';
      const isApprovalYearTouch =
        isVoteHubApprovalYearTicker(row.event_ticker) &&
        (stamp.direction === 'above' || stamp.direction === 'below');
      const isWindowCount = series.windowCount === true && stamp.direction !== 'at';
      const tuple = stamp.value_primary != null
        ? emitCondition({
            archetype: isApprovalYearTouch
              ? 'path_touch'
              : isWindowCount
              ? 'cumulative_count'
              : stamp.direction === 'between' ? 'terminal_range' : 'terminal_threshold',
            tag,
            eventKind: series.event_kind ?? priceLadderDefaultEventKind(series),
            metric: series.metric,
            direction: stamp.direction,
            temporal: isApprovalYearTouch
              ? 'during_period'
              : isWindowCount
              ? (stamp.direction === 'below' ? 'on_date' : 'during_period')
              : 'on_date',
            ...(isWindowCount
              ? {
                  arm: (stamp.direction === 'between' ? 'range' : stamp.direction) as 'range' | 'above' | 'below',
                  ...(stamp.direction === 'above' ? { legacyMonotonicArm: true as const } : {}),
                }
              : {}),
            value: { primary: stamp.value_primary, secondary: stamp.value_secondary, unit: series.unit },
          }, 'kalshi-det')
        : null;
      if (tuple) {
        const domainCategory =
          series.category === 'economic' ? 'finance' :
          series.category === 'weather'  ? 'weather' :
          (series.category === 'election' || series.category === 'politics') ? 'politics' :
          'crypto';
        const subjectInput =
          (series.perInstanceSubject && series.perInstanceSubject(row))
          ?? (series.category === 'weather'
                ? extractKalshiWeatherStation(row.rules_primary, series.subject)
                : null)
          ?? series.subject;
        const isPerInstance = series.perInstanceSubject != null;
        const canonical_subject = acceptPerInstanceSubject(
          subjectInput,
          await resolveSubjectViaKB(subjectInput, domainCategory),
          isPerInstance,
        );
        const entityType = series.entityType ?? 'asset';
        const dynamicAliases = series.category === 'weather'
          ? stationAliasesFor(subjectInput, series.subject)
          : isPerInstance
            ? (subjectInput !== canonical_subject ? [subjectInput] : [])
            : (subjectInput !== series.subject ? [subjectInput, series.subject] : [series.subject]);
        const aliasSet = new Set<string>([...dynamicAliases, ...(series.aliases ?? [])]);
        aliasSet.delete(canonical_subject); // canonical isn't its own alias
        const resolved_entities: ResolvedEntity[] = [{
          canonical: canonical_subject,
          type: entityType,
          aliases: [...aliasSet],
          metadata: entityType === 'asset'
            ? deterministicAssetMetadata(series.subject, series.category)
            : undefined,
        }];
        const isHourlyCandle = isHourlyCandleCryptoSeries(row.event_ticker);
        const strikeDateAligned = isHourlyCandle
          ? alignHourlyCandleTimestamp(row.strike_date)
          : row.strike_date;
        const weatherObsDate = series.category === 'weather' && row.event_ticker
          ? extractEventDate({
              platform: 'kalshi',
              platform_id: row.event_ticker,
              title: row.title,
              slug: null,
              end_date: null,
            })
          : null;
        const tickerDate = (!weatherObsDate && !strikeDateAligned && row.platform_id)
          ? extractEventDate({
              platform: 'kalshi',
              platform_id: row.platform_id,
              title: row.title,
              slug: null,
              end_date: null,
            })
          : null;
        const tsDate = resolveTypedStrikeDate({
          weatherObsDate,
          strikeDateAligned,
          isHourlyCandle,
          rawStrikeDate: row.strike_date,
          occurrenceDatetime: row.occurrence_datetime,
          tickerDate,
          endDate: row.end_date,
        });
        const rawCanonicalEvent = row.event_title ?? row.title;
        const canonicalEvent = series.category === 'weather'
          ? stripWeatherDateSuffix(rawCanonicalEvent)
          : rawCanonicalEvent;
        const norm = assembleKalshiNorm(row, {
          subject: canonical_subject,
          canonicalEvent,
          ...tupleConditionParts(tuple),
          date: tsDate,
          resolvedEntities: resolved_entities,
          resolutionSource: series.resolutionSource ?? null,
          metricScope: null,
          participants: dedupeSorted([canonical_subject]),
          category: series.category,
          eventKind: series.event_kind ?? priceLadderDefaultEventKind(series),
        }, tag);
        if (series.resolutionSource) {
          const _resolveKey = `${series.resolutionSource}:${domainCategory}`;
          if (!_providerHitCache.has(_resolveKey)) {
            _providerHitCache.set(
              _resolveKey,
              await providerResolver.resolve(
                series.resolutionSource,
                domainCategory,
                { domain: domainCategoryToProviderDomain(domainCategory) },
              ),
            );
          }
          const provHit = _providerHitCache.get(_resolveKey) ?? null;
          if (provHit) {
            norm.resolution_provider_id = provHit.id;
            let meta: DataProviderMetadata | null;
            if (_providerMetaCache.has(provHit.id)) {
              meta = _providerMetaCache.get(provHit.id)!;
            } else {
              const metaRows = await query<{ metadata: DataProviderMetadata | null }>(
                `SELECT metadata FROM known_entities WHERE id = $1`, [provHit.id],
              );
              meta = metaRows[0]?.metadata ?? null;
              _providerMetaCache.set(provHit.id, meta);
            }
            if (meta?.kind === 'data_provider') {
              norm.resolution_kind = domainToResolutionKind(meta.domain);
            }
          }
        }
        await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCategory);
        return { norm, tag };
      }
    }
  }

  if (isParlaySeries(row.event_ticker)) {
    const legs = row.mve_selected_legs;
    if (legs && legs.length > 0) {
      const parlayCategory: UnifiedCategory = row.event_ticker?.startsWith('KXMVESPORTS') ? 'sports' : 'other';

      const legSignatures = buildParlayLegSignatures(legs);
      if (!legSignatures) return null;
      const legSigStr = legSignatures.join(';');
      const canonicalEvent = `parlay[${legSigStr}]`;

      const participantList = Array.from(new Set(legs.map((l) => l.market_ticker))).sort();

      const parlayCanonicalSubject = canonicalEvent;

      const parlayEventDate = extractEventDate({
        platform: 'kalshi',
        platform_id: row.platform_id,
        title: row.title,
        slug: null,
        end_date: row.end_date,
        mve_selected_legs: row.mve_selected_legs,
      });
      const parlayNorm: LLMMarketNormalization = {
        market_id: row.market_id,
        canonical_subject: parlayCanonicalSubject,
        condition_value: legSignatures.join(' AND '),
        condition_date: parlayEventDate?.iso ?? row.end_date ?? null,
        condition_date_precision: parlayEventDate?.precision ?? (row.end_date ? 'day' : null),
        condition_date_source: parlayEventDate?.source ?? (row.end_date ? 'end_date' : null),
        canonical_event: canonicalEvent,
        outcome_label: null,
        resolved_entities: [],
        resolution_source: null,
        confidence: 1.0,
        condition_shape: 'binary_event',
        condition_direction: null,
        condition_metric: null,
        metric_scope: null,
        temporal_semantics: 'at_resolution',
        value_primary: null,
        value_secondary: null,
        value_unit: null,
        participants: dedupeSorted(participantList),
        category_unified: parlayCategory,
        event_sourced: false,
        match_source: 'kalshi:parlay:mve',
        leg_signatures: legSignatures,
      };
      return { norm: parlayNorm, tag: 'kalshi:parlay:mve' };
    }
    return null;
  }

  if (row.strike_type === 'structured') {
    const statHit = resolvePlayerStatSeries(row.event_ticker);
    if (statHit) {
      const spec = statHit.spec;
      let playerRaw: string | undefined;
      let value: number | undefined;
      let rawUnit: string | undefined;
      const colon = row.title.match(PLAYER_STAT_RX);
      if (colon?.groups?.player && colon.groups.value) {
        playerRaw = colon.groups.player.trim();
        value = parseFloat(colon.groups.value);
        rawUnit = colon.groups.unit;
      } else if (row.yes_sub_title) {
        const seasonValue = parseSeasonStatThreshold(row.title);
        if (seasonValue != null) {
          playerRaw = row.yes_sub_title.trim();
          value = seasonValue;
          rawUnit = undefined; // unit is fixed by the series → expectedUnit (authoritative)
        }
      }
      if (playerRaw && value != null) {
        const unit = normalizeStatUnit(rawUnit, spec.expectedUnit);
        const fromFloor = unit ? canonicalizeKalshiStrike('greater', toNumber(row.floor_strike), null, unit) : null;
        const canonValue = fromFloor != null
          ? fromFloor.value
          : canonicalizeIntegerThreshold({ direction: 'above', value, unit, strictness: 'inclusive' }).value;
        const tuple = unit
          ? emitCondition({
              archetype: 'cumulative_count',
              arm: 'above',
              legacyMonotonicArm: true,
              tag: 'kalshi:player-stat',
              eventKind: 'player_prop_threshold',
              metric: 'count',
              direction: 'above',
              temporal: 'during_period',
              value: { primary: canonValue, unit },
            }, 'kalshi-det')
          : null;
        if (tuple) {
          const canonical_subject = await resolveSubjectViaKB(
            playerRaw,
            'sports',
            { sport: spec.sport, league: spec.leagueCanonical },
          );
          const statLeague = await resolveLeague(spec.leagueCanonical);
          const resolved_entities: ResolvedEntity[] = [
            {
              canonical: canonical_subject,
              type: 'person',
              aliases: [playerRaw],
              metadata: scopedEntityMetadata({ sport: spec.sport, league: statLeague.canonical }, 'person'),
            },
          ];
          const statLeagueId: number | null = statLeague.id;
          const playerPropCanonicalEvent = `${canonical_subject} ${unit}`;
          const statNorm = assembleKalshiNorm(row, {
            subject: canonical_subject,
            canonicalEvent: playerPropCanonicalEvent,
            ...tupleConditionParts(tuple),
            resolvedEntities: resolved_entities,
            participants: dedupeSorted([canonical_subject]),
            category: spec.category,
            leagueId: statLeagueId,
            eventKind: 'player_prop_threshold',
          }, 'kalshi:player-stat');
          await registerEntities(row.market_id, canonical_subject, resolved_entities, unifiedToDomain(spec.category));
          return { norm: statNorm, tag: 'kalshi:player-stat' };
        }
      }
    }
  }

  if (row.yes_sub_title && /^who will win\b/i.test(row.title)) {
    const candidateRaw = row.yes_sub_title.trim();
    if (candidateRaw) {
      const titleLower = row.title.toLowerCase();
      const isElectionByCategory =
        row.category_unified === 'election' ||
        row.category_unified === 'politics' ||
        row.category_unified === 'geopolitical';
      const isElectionByTitle =
        /\b(?:election|primary|race|presidency|senate|governor(?:ship)?|mayor(?:al)?|nomination|congress(?:ional)?|state\s+house|state\s+assembly|state\s+senate|house\s+of\s+representatives)\b/.test(titleLower);
      const eventKind: EventKind =
        (isElectionByCategory || (row.category_unified == null && isElectionByTitle))
          ? 'election_outcome_winner'
          : 'championship_winner';
      const category: UnifiedCategory =
        eventKind === 'election_outcome_winner' ? 'election' : 'sports';
      const domainCat = unifiedToDomain(category);
      const canonical_subject = await resolveSubjectViaKB(candidateRaw, domainCat);
      const kalshiPrefix = kalshiSeriesPrefix(row);
      const categoricalSport = (category === 'sports' && kalshiPrefix)
        ? (resolveKalshiTickerPrefix(kalshiPrefix)?.sport ?? null)
        : null;
      const categoricalScopeMeta = scopeToEntityMetadata(
        { sport: categoricalSport, league: null },
        'unknown',
      );
      const resolved_entities: ResolvedEntity[] = [
        {
          canonical: canonical_subject,
          type: 'unknown',
          aliases: [candidateRaw],
          metadata: metaOrUndef(categoricalScopeMeta),
        },
      ];
      const categoricalEventDate = extractEventDate({
        platform: 'kalshi',
        platform_id: row.platform_id,
        title: row.title,
        slug: null,
        end_date: row.end_date,
        mve_selected_legs: null,
      });
      const rawCanonicalEvent = (() => {
        if (eventKind === 'election_outcome_winner' || eventKind === 'championship_winner') {
          return normalizeEventNoun(row.title, yearFromIso(categoricalEventDate?.iso)) || row.title;
        }
        if (category === 'sports') {
          return normalizeFixtureCanonicalEvent(row.title) || row.title;
        }
        return row.title;
      })();
      const categoricalLeagueId = category === 'sports'
        ? await resolveKalshiCompetitionToLeagueId(row.kalshi_competition)
        : null;
      const isWinnerKind = eventKind === 'championship_winner' || eventKind === 'election_outcome_winner';
      const categoricalDate = {
        iso: isWinnerKind && categoricalEventDate?.iso
          ? `${yearFromIso(categoricalEventDate.iso) ?? new Date(categoricalEventDate.iso).getUTCFullYear()}-01-01`
          : (categoricalEventDate?.iso ?? row.end_date ?? null),
        precision: isWinnerKind
          ? ('year' as const)
          : (categoricalEventDate?.precision ?? (row.end_date ? ('day' as const) : null)),
        source: isWinnerKind ? 'event-year' : (categoricalEventDate?.source ?? (row.end_date ? 'end_date' : null)),
      };
      let categoricalCondParts: Pick<KalshiNormParts,
        'shape' | 'direction' | 'metric' | 'temporal' | 'valuePrimary' | 'valueSecondary' | 'valueUnit'>;
      if (isWinnerKind) {
        categoricalCondParts = {
          shape: 'monotonic_threshold', direction: 'below', metric: null,
          temporal: 'at_resolution', valuePrimary: 1, valueSecondary: null, valueUnit: 'rank',
        };
      } else {
        const tuple = emitCondition({
          archetype: 'fixture_outcome',
          topology: 'standalone_binary',
          tag: 'kalshi:categorical',
          eventKind,
          metric: null,
          temporal: null,
        }, 'kalshi-det');
        if (!tuple) return null; // unreachable for a zero-arity binary spec
        categoricalCondParts = tupleConditionParts(tuple);
      }
      const categoricalNorm = assembleKalshiNorm(row, {
        subject: canonical_subject,
        canonicalEvent: rawCanonicalEvent.slice(0, 200),
        ...categoricalCondParts,
        date: categoricalDate,
        outcomeLabel: normalizeOutcomeLabel(candidateRaw),
        resolvedEntities: resolved_entities,
        participants: dedupeSorted([canonical_subject]),
        category,
        leagueId: categoricalLeagueId,
        eventKind,
      }, 'kalshi:categorical');
      if (
        (eventKind === 'election_outcome_winner' || eventKind === 'championship_winner') &&
        categoricalNorm.canonical_event
      ) {
        resolved_entities.push({
          canonical: categoricalNorm.canonical_event,
          type: 'event_name',
          aliases: gatedEventAlias(row.title).filter((a) => a !== categoricalNorm.canonical_event),
        });
      }
      await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCat);
      return { norm: categoricalNorm, tag: 'kalshi:categorical' };
    }
  }

  const perDistrictHit = await tryPerDistrictMidtermElection(row);
  if (perDistrictHit) return perDistrictHit;

  const primaryRangeHit = await tryPrimaryRangeElection(row);
  if (primaryRangeHit) return primaryRangeHit;

  const nbaNhlSeriesHit = await tryNbaNhlSeries(row);
  if (nbaNhlSeriesHit) return nbaNhlSeriesHit;

  const placeFirstHit = await tryPlaceFirstPrimary(row);
  if (placeFirstHit) return placeFirstHit;

  const finishHit = await tryPlayerFinishPosition(row);
  if (finishHit) return finishHit;

  const gamePropHit = await tryPlayerGameCombinedStat(row);
  if (gamePropHit) return gamePropHit;

  const econExactHit = await tryEconExactValue(row);
  if (econExactHit) return econExactHit;

  const nextTeamHit = await tryNextTeamTransfer(row);
  if (nextTeamHit) return nextTeamHit;

  const tournamentHit = await tryTournamentRoundAdvance(row);
  if (tournamentHit) return tournamentHit;

  const wcElimSquadHit = await tryWorldCupElimSquad(row);
  if (wcElimSquadHit) return wcElimSquadHit;

  const esportsHit = await tryEsportsWinner(row);
  if (esportsHit) return esportsHit;

  const musicChartHit = await tryMusicChartPosition(row);
  if (musicChartHit) return musicChartHit;

  const gameTotalHit = await tryGameTotal(row);
  if (gameTotalHit) return gameTotalHit;

  const nextMgrHit = await tryNextManagerCoach(row);
  if (nextMgrHit) return nextMgrHit;

  const mgrOutHit = await tryManagerOut(row);
  if (mgrOutHit) return mgrOutHit;

  const participationHit = await tryPlayerParticipation(row);
  if (participationHit) return participationHit;

  const speechMentionHit = await tryKalshiSpeechMention(row);
  if (speechMentionHit) return speechMentionHit;

  const firstScorerHit = await tryFirstGoalScorer(row);
  if (firstScorerHit) return firstScorerHit;

  const seasonWinsHit = await trySeasonWins(row);
  if (seasonWinsHit) return seasonWinsHit;

  const mlbSpreadHit = await tryMlbSpread(row);
  if (mlbSpreadHit) return mlbSpreadHit;

  const golfMakeCutHit = await tryGolfMakeCut(row);
  if (golfMakeCutHit) return golfMakeCutHit;

  const musicAchievementHit = await tryMusicArtistAchievement(row);
  if (musicAchievementHit) return musicAchievementHit;

  const golfEagleHit = await tryGolfEagle(row);
  if (golfEagleHit) return golfEagleHit;

  const performerHit = await tryPerformerParticipation(row);
  if (performerHit) return performerHit;

  const eurovisionHit = await tryEurovisionRank(row);
  if (eurovisionHit) return eurovisionHit;

  const majorHit = await tryWinAMajorGrandSlam(row);
  if (majorHit) return majorHit;

  const f5SpreadHit = await tryMlbF5Spread(row);
  if (f5SpreadHit) return f5SpreadHit;

  const golfRoundTopHit = await tryGolfRoundFinishPosition(row);
  if (golfRoundTopHit) return golfRoundTopHit;

  const exactSetHit = await tryExactSetScore(row);
  if (exactSetHit) return exactSetHit;

  const ufcVicRoundHit = await tryUfcVictoryRound(row);
  if (ufcVicRoundHit) return ufcVicRoundHit;

  const ufcMovHit = await tryUfcMethodOfVictory(row);
  if (ufcMovHit) return ufcMovHit;

  const wsMatchupHit = await tryWorldSeriesMatchup(row);
  if (wsMatchupHit) return wsMatchupHit;

  const correctScoreHit = await trySoccerCorrectScore(row);
  if (correctScoreHit) return correctScoreHit;

  const setWinnerHit = await trySetWinner(row);
  if (setWinnerHit) return setWinnerHit;

  const threeBallHit = await try3BallMatchup(row);
  if (threeBallHit) return threeBallHit;

  const firstHurricaneHit = await tryFirstHurricane(row);
  if (firstHurricaneHit) return firstHurricaneHit;

  const emmyCountHit = await tryEmmyCount(row);
  if (emmyCountHit) return emmyCountHit;

  const awardHit = await tryAwardWinner(row);
  if (awardHit) return awardHit;

  const golfLeadHit = await tryGolfRoundLeader(row);
  if (golfLeadHit) return golfLeadHit;

  const draftTopNHit = await tryDraftTopN(row);
  if (draftTopNHit) return draftTopNHit;

  const voteTurnHit = await tryStatewideVoteTurnout(row);
  if (voteTurnHit) return voteTurnHit;

  const primaryAdvHit = await tryPrimaryAdvance(row);
  if (primaryAdvHit) return primaryAdvHit;

  const fedHit = await tryCentralBankRateDecision(row);
  if (fedHit) return fedHit;

  const sportsPartHit = await trySportsParticipation(row);
  if (sportsPartHit) return sportsPartHit;

  const topNRankHit = await tryTopNRank(row);
  if (topNRankHit) return topNRankHit;

  const ladderSeries = lookupLadderSeries(row.event_ticker);
  if (ladderSeries) {
    const ladderHit = await shapeThresholdLadder(row, ladderSeries.prefix, ladderSeries.spec);
    if (ladderHit) return ladderHit;
  }
  const winnerSeries = lookupWinnerSeries(row.event_ticker);
  if (winnerSeries) {
    const winnerHit = await shapeCategoricalWinner(row, winnerSeries.prefix, winnerSeries.spec);
    if (winnerHit) return winnerHit;
  }
  const draftSeries = lookupDraftSeries(row.event_ticker);
  if (draftSeries) {
    const draftHit = await shapeDraftPick(row, draftSeries.prefix, draftSeries.spec);
    if (draftHit) return draftHit;
  }

  return null; // No Kalshi parser matched — falls through to text-det templates or LLM
}


export function spreadCoverSubject(
  eventKind: string | null | undefined,
  canonicalSubject: string | null | undefined,
): string | null {
  if (eventKind !== "match_spread") return null;
  const s = canonicalSubject?.trim();
  return s && s.length > 0 ? s : null;
}

async function shapeThresholdLadder(
  row: KalshiCandidateRow,
  prefix: string,
  spec: LadderSeriesSpec,
): Promise<KalshiNormalizationHit | null> {
  if (spec.requireStrikeType && row.strike_type !== spec.requireStrikeType) return null;

  let subjectRaw: string | null = null;
  let opponentRaw: string | null = null;
  let eventOverride: string | null = null;
  if (spec.subjectGrain === "titleTeam") {
    const fx = extractSpreadFixture(row);
    if (!fx) return null;
    subjectRaw = fx.team;
    opponentRaw = fx.opponent;
  } else if (spec.subjectGrain === "titleGamesSpread") {
    const gs = parseTennisGamesSpread(row.title);
    if (!gs) return null;
    subjectRaw = gs.player;
    opponentRaw = gs.opponent;
  } else if (spec.subjectGrain === "yesSubTitlePerson") {
    const g = parseGolfRoundScore(row);
    if (!g) return null;
    subjectRaw = g.player;
    eventOverride = "round " + g.round;
  } else {
    if (spec.eventKind === "media_release" && spec.unit === "score") {
      if (!isExactRottenTomatoesSeries(row.event_ticker)) return null;
      subjectRaw = extractRottenTomatoesSubject(row.title);
    } else {
      subjectRaw = extractMusicUnitsSubject(row.title);
    }
    if (!subjectRaw) return null;
  }

  const sdv = deriveStrike(row);
  if (!sdv) return null;
  const direction = sdv.direction;
  if (direction !== "above" && direction !== "below" && direction !== "between") return null;
  const floor = quantizeKalshiStrike(sdv.floor);
  const cap = quantizeKalshiStrike(sdv.cap);
  let value_primary: number | null;
  let value_secondary: number | null = null;
  if (spec.valueSource === "floor") value_primary = floor;
  else if (spec.valueSource === "cap") value_primary = cap;
  else {
    value_primary = direction === "above" ? floor : direction === "below" ? cap : floor;
    value_secondary = direction === "between" ? cap : null;
  }
  if (value_primary == null) return null;
  if ((direction === "above" || direction === "below") && sdv.strikeType != null) {
    const strictness =
      sdv.strikeType === "greater_or_equal" || sdv.strikeType === "less_or_equal"
        ? "inclusive" as const : "strict" as const;
    value_primary = canonicalizeIntegerThreshold({ direction, value: value_primary, unit: spec.unit, strictness }).value;
  }

  const ladderTag = "kalshi:ladder-" + prefix;
  let tuple: ConditionTuple | null;
  if (spec.eventKind === "match_spread") {
    if (direction === "between") return null;
    tuple = emitCondition({
      archetype: "fixture_margin",
      tag: ladderTag,
      eventKind: spec.eventKind,
      metric: spec.metric,
      direction,
      temporal: "at_resolution",
      value: { primary: value_primary, unit: spec.unit },
    }, "kalshi-det");
  } else if (prefix === "KXRT") {
    if (direction === "between") return null; // requireStrikeType 'greater' — unreachable
    tuple = emitCondition({
      archetype: "path_touch",
      tag: ladderTag,
      eventKind: spec.eventKind,
      metric: spec.metric,
      direction,
      temporal: "at_resolution",
      value: { primary: value_primary, unit: spec.unit },
    }, "kalshi-det");
  } else if (direction === "between") {
    tuple = emitCondition({
      archetype: "cumulative_count",
      arm: "range",
      tag: ladderTag,
      eventKind: spec.eventKind,
      metric: spec.metric,
      temporal: "during_period",
      value: { primary: value_primary, secondary: value_secondary, unit: spec.unit },
    }, "kalshi-det");
  } else {
    tuple = emitCondition({
      archetype: "cumulative_count",
      arm: direction,
      legacyMonotonicArm: true,
      tag: ladderTag,
      eventKind: spec.eventKind,
      metric: spec.metric,
      direction,
      temporal: "at_resolution",
      value: { primary: value_primary, unit: spec.unit },
    }, "kalshi-det");
  }
  if (!tuple) return null;

  const domainCat = spec.category === "sports" ? "sports" : "entertainment";
  const subjScope = spec.sport
    ? scopeToEntityMetadata({ sport: spec.sport, league: spec.league }, spec.subjectType)
    : {};
  const canonical_subject = await resolveSubjectViaKB(
    subjectRaw, domainCat, spec.sport ? { sport: spec.sport, league: spec.league } : undefined);

  let leagueId: number | null = null;
  if (spec.league) {
    leagueId = (await resolveLeague(spec.league)).id;
  }
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: spec.subjectType,
      aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [],
      metadata: metaOrUndef(subjScope) },
  ];

  let opponentCanonical: string | null = null;
  if (opponentRaw && (spec.subjectType === "team" || spec.subjectType === "person")) {
    opponentCanonical = await resolveSubjectViaKB(opponentRaw, "sports", { sport: spec.sport, league: spec.league });
    if (opponentCanonical && opponentCanonical !== canonical_subject) {
      resolved_entities.push({ canonical: opponentCanonical, type: spec.subjectType, aliases: opponentRaw !== opponentCanonical ? [opponentRaw] : [] });
    }
  }

  const dateIso = row.occurrence_datetime ?? row.end_date ?? null;
  const participants = dedupeSorted(opponentCanonical ? [canonical_subject, opponentCanonical] : [canonical_subject]);

  let canonical_event: string;
  if (spec.subjectGrain === "titleTeam" || spec.subjectGrain === "titleGamesSpread") {
    canonical_event = deriveCanonicalEventCore({
      eventKind: spec.eventKind, conditionShape: "monotonic_threshold", conditionMetric: spec.metric,
      valueUnit: spec.unit, rawCanonicalEvent: row.event_title ?? row.title,
      canonicalSubject: canonical_subject, canonicalParticipants: participants,
      categoryUnified: "sports", eventDateIso: dateIso,
    });
  } else if (spec.subjectGrain === "yesSubTitlePerson") {
    const eventDate = extractEventDate({ platform: "kalshi", platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
    const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
    const tm = (row.rules_primary ?? "").match(/of the\s+(?<t>.+?)(?:,|\.|$)/i);
    const tournament = (tm?.groups?.t ?? "tournament").toLowerCase().trim();
    canonical_event = year + " " + tournament + " " + eventOverride;
  } else {
    canonical_event = canonical_subject;
  }

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    ...tupleConditionParts(tuple),
    metricScope: parseMetricScopeFromTitle(row.title),
    resolvedEntities: resolved_entities,
    participants,
    category: spec.category === "sports" ? "sports" : "entertainment",
    leagueId,
    eventKind: spec.eventKind,
  }, "kalshi:ladder-" + prefix);
  const coverSubject = spreadCoverSubject(spec.eventKind, canonical_subject);
  if (coverSubject) (norm.discriminators ??= {}).cover_subject = coverSubject;
  await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCat === "sports" ? "sports" : "entertainment");
  return { norm, tag: norm.match_source! };
}

function prefixYearOnce(year: number, evtNorm: string): string {
  return new RegExp(`^${year}(?:[\\s-]|$)`).test(evtNorm) ? evtNorm : `${year} ${evtNorm}`;
}

async function shapeCategoricalWinner(
  row: KalshiCandidateRow,
  prefix: string,
  spec: WinnerSeriesSpec,
): Promise<KalshiNormalizationHit | null> {
  const winnerRaw = (row.yes_sub_title ?? "").trim();
  if (!winnerRaw) return null;
  const isResidual = spec.residualRX != null && spec.residualRX.test(winnerRaw);

  if (spec.eventFrom === "fixture") {
    const fx = extractSoccer1HFixture(row.rules_primary);
    if (!fx) return null;
    const pair = [fx.a, fx.b].sort((x, y) => x.localeCompare(y));
    const aCanon = await resolveSubjectViaKB(pair[0], "sports", { sport: spec.sport, league: spec.league });
    const bCanon = await resolveSubjectViaKB(pair[1], "sports", { sport: spec.sport, league: spec.league });
    if (aCanon === bCanon) return null;
    const fixtureCanon = [aCanon, bCanon].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    const canonical_event = fixtureCanon.join(" vs ");
    if (isResidual) {
      return await emitWinnerNorm(row, prefix, spec, NATIVE_DRAW_SUBJECT, canonical_event, fixtureCanon, null, true);
    }
    const winnerCanon =
      winnerRaw === pair[0] ? aCanon : winnerRaw === pair[1] ? bCanon
        : await resolveSubjectViaKB(winnerRaw, "sports", { sport: spec.sport, league: spec.league });
    return await emitWinnerNorm(row, prefix, spec, winnerRaw, canonical_event, fixtureCanon, winnerCanon, false);
  }

  if (spec.eventFrom === "eventTitle") {
    const evtRaw = (row.event_title ?? "").trim();
    if (!evtRaw) return null;
    const eventDate = extractEventDate({ platform: "kalshi", platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
    const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
    const evtNorm = evtRaw.toLowerCase().replace(/\s+/g, " ").replace(/[?？]+\s*$/, "").trim();
    const canonical_event = prefixYearOnce(year, evtNorm);
    const domain = spec.subjectCategory ?? "sports";
    if (isResidual) {
      return await emitWinnerNorm(row, prefix, spec, winnerRaw, canonical_event, [], null, true, domain, normalizeOutcomeLabel(winnerRaw) ?? winnerRaw.trim());
    }
    const winnerCanon = await resolveSubjectViaKB(winnerRaw, domain, spec.sport ? { sport: spec.sport, league: spec.league } : undefined);
    return await emitWinnerNorm(row, prefix, spec, winnerRaw, canonical_event, [winnerCanon], winnerCanon, false, domain, "Draw");
  }

  const raceRaw = extractMotorsportEvent(row.title);
  if (!raceRaw) return null;
  const eventDate = extractEventDate({ platform: "kalshi", platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const canonical_event = normalizeEventNoun(raceRaw, year) || raceRaw.toLowerCase();
  const winnerCanon = await resolveSubjectViaKB(winnerRaw, "sports", { sport: spec.sport, league: spec.league });
  return await emitWinnerNorm(row, prefix, spec, winnerRaw, canonical_event, [winnerCanon], winnerCanon, false, "sports", "Draw");
}

export const SINGLE_WINNER_RANK_KINDS: ReadonlySet<string> = new Set(['championship_winner', 'award_winner']);
export function singleWinnerRankFields(
  eventKind: string,
  isResidual: boolean,
): { valuePrimary: number | null; valueUnit: string | null } {
  return !isResidual && SINGLE_WINNER_RANK_KINDS.has(eventKind)
    ? { valuePrimary: 1, valueUnit: 'rank' }
    : { valuePrimary: null, valueUnit: null };
}

async function emitWinnerNorm(
  row: KalshiCandidateRow,
  prefix: string,
  spec: WinnerSeriesSpec,
  winnerRaw: string,
  canonical_event: string,
  fixtureCanon: string[],
  winnerCanon: string | null,
  subjectIsResidual: boolean,
  category: "sports" | "entertainment" = "sports",
  residualLabel: string = NATIVE_DRAW_SUBJECT,
): Promise<KalshiNormalizationHit | null> {
  const canonical_subject = subjectIsResidual ? residualLabel : (winnerCanon ?? winnerRaw);
  const resolved_entities: ResolvedEntity[] = [];
  if (spec.eventFrom === "fixture") {
    for (const t of fixtureCanon) resolved_entities.push({ canonical: t, type: "team", aliases: [] });
  } else if (winnerCanon && !subjectIsResidual) {
    resolved_entities.push({ canonical: winnerCanon, type: spec.subjectType, aliases: winnerRaw !== winnerCanon ? [winnerRaw] : [] });
  }
  let leagueId: number | null = null;
  if (spec.league) { leagueId = (await resolveLeague(spec.league)).id; }
  const rankFields = singleWinnerRankFields(spec.eventKind, subjectIsResidual);
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: "categorical_outcome",
    direction: null,
    metric: null,
    temporal: "at_resolution",
    valuePrimary: rankFields.valuePrimary,
    valueUnit: rankFields.valueUnit,
    conditionValue: "winner=" + normalizeOutcomeLabel(winnerRaw),
    outcomeLabel: normalizeOutcomeLabel(winnerRaw),
    resolvedEntities: resolved_entities,
    metricScope: spec.metricScope,
    participants: spec.eventFrom === "fixture" ? dedupeSorted(fixtureCanon) : dedupeSorted([canonical_subject]),
    category,
    leagueId,
    eventKind: spec.eventKind,
  }, "kalshi:winner-" + prefix);
  if (canonical_subject && !subjectIsResidual) {
    await registerEntities(row.market_id, canonical_subject, resolved_entities, category === "entertainment" ? "entertainment" : "sports");
  }
  return { norm, tag: norm.match_source! };
}

async function shapeDraftPick(
  row: KalshiCandidateRow,
  prefix: string,
  spec: DraftSeriesSpec,
): Promise<KalshiNormalizationHit | null> {
  const slotRaw = (row.yes_sub_title ?? "").trim();
  if (!slotRaw) return null;
  const year = parseDraftYear(row.event_ticker) ?? 2026;

  let pickN: number | null = null;
  let canonical_event: string;
  let slotType: "player" | "team" = spec.slotType;
  let condValuePrefix: string;

  if (spec.branch === "pick") {
    pickN = parseDraftPickNumber(row.event_ticker);
    if (pickN == null) return null;
    canonical_event = draftCanonicalEvent(spec, year, pickN, null);
    condValuePrefix = "player";
    slotType = "player";
  } else if (spec.branch === "team") {
    const pm = row.title.match(/^Will\s+(?<player>.+?)\s+be\s+drafted\s+by\b/i);
    const playerForEvent = pm?.groups?.player?.trim() ?? null;
    if (!playerForEvent) return null;
    canonical_event = draftCanonicalEvent(spec, year, null, playerForEvent);
    condValuePrefix = "team";
    slotType = "team";
  } else {
    canonical_event = draftCanonicalEvent(spec, year, null, null);
    condValuePrefix = spec.slotType;
    slotType = spec.slotType;
  }

  const entityType: SubjectEntityType = slotType === "player" ? "person" : "team";
  const subjScope = scopeToEntityMetadata({ sport: spec.sport, league: spec.league }, entityType);
  const canonical_subject = await resolveSubjectViaKB(slotRaw, "sports", { sport: spec.sport, league: spec.league });
  const lh = await resolveLeague(spec.league);
  const leagueId = lh.id;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: entityType,
      aliases: slotRaw !== canonical_subject ? [slotRaw] : [],
      metadata: metaOrUndef(subjScope) },
  ];

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: "categorical_outcome",
    direction: "at",
    metric: "boolean",
    temporal: "at_resolution",
    valuePrimary: pickN,
    valueUnit: pickN != null ? "pick" : null,
    conditionValue: condValuePrefix + "=" + normalizeOutcomeLabel(slotRaw),
    date: { iso: year + "-01-01", precision: "year", source: "event-year" },
    outcomeLabel: normalizeOutcomeLabel(slotRaw),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: "sports",
    leagueId,
    eventKind: "championship_winner",
  }, "kalshi:draft-pick");
  void prefix;
  await registerEntities(row.market_id, canonical_subject, resolved_entities, "sports");
  return { norm, tag: "kalshi:draft-pick" };
}


const MIDTERM_MOV_TITLE_RX =
  /^Will the margin of victory for (?<party>Republicans?|Democrats?)\s+in\s+the\s+(?<state>[A-Za-z][A-Za-z .'\-]+?)(?:'s)?\s+(?<district>\d{1,2}(?:st|nd|rd|th)?)\s+District\s+(?<chamber>House|Senate)\s+election\b/i;

const MIDTERM_VOTETURN_TITLE_RX =
  /^Will the total vote count for all participants in\s+(?<state>[A-Za-z][A-Za-z .'\-]+?)\s+(?<district>\d{1,2})\s+(?<chamber>House|Senate)\s+General\s+Election\b/i;

// The per-district regex is tried before the statewide one (statewide would otherwise over-match a per-district title).
const MIDTERM_MOV_STATEWIDE_RX =
  /^Will the margin of victory for (?<party>Republicans?|Democrats?)\s+in\s+the\s+(?:(?<stateH>[A-Za-z][A-Za-z .'\-]+?)\s+House\s+election|(?<chamber>U\.S\.\s+Senate|governor)\s+election\s+in\s+(?<stateO>[A-Za-z][A-Za-z .'\-]+?))\s+be\s+at\s+least\s+\d/i;

export function parseMidtermMovStatewide(
  title: string,
): { party: string; state: string; chamber: 'house' | 'senate' | 'governor'; subjectRaw: string } | null {
  const m = title.match(MIDTERM_MOV_STATEWIDE_RX);
  if (!m?.groups) return null;
  const g = m.groups;
  if (g.stateH) {
    const state = g.stateH.trim();
    return { party: g.party, state, chamber: 'house', subjectRaw: `${state} house race` };
  }
  const state = g.stateO.trim();
  const chamber = /senate/i.test(g.chamber) ? 'senate' : 'governor';
  return { party: g.party, state, chamber, subjectRaw: `${state} ${chamber} race` };
}

function normalizeDistrict(d: string): string {
  const stripped = d.replace(/(?:st|nd|rd|th)$/i, '');
  const n = parseInt(stripped, 10);
  if (!Number.isFinite(n)) return stripped;
  return n.toString().padStart(2, '0');
}

function partyToOutcomeLabel(p: string): string {
  const lc = p.toLowerCase();
  if (lc.startsWith('republican')) return 'republican';
  if (lc.startsWith('democrat')) return 'democratic';
  return lc;
}

// Appends ' margin'/' turnout' so MOV and VOTETURN markets for the same district never collapse onto one canonical_subject.
export function midtermSubjectWithMetric(baseSubject: string, isMov: boolean): string {
  const suffix = isMov ? ' margin' : ' turnout';
  return baseSubject.toLowerCase().endsWith(suffix) ? baseSubject : `${baseSubject}${suffix}`;
}

// Cycle year is the hardcoded constant 2026 for all KXMIDTERM* markets — do not derive it from extractEventDate (settlement-derived, not trustworthy here).
export const MIDTERM_CYCLE_YEAR = 2026;
export function midtermCycleYear(): number {
  return MIDTERM_CYCLE_YEAR;
}

export function midtermConditionTuple(
  isMov: boolean,
  direction: 'above' | 'below',
  valuePrimary: number,
): ConditionTuple | null {
  return emitCondition({
    archetype: 'terminal_threshold',
    tag: isMov ? 'kalshi:midterm-mov' : 'kalshi:midterm-voteturn',
    eventKind: isMov ? 'election_margin' : 'election_turnout',
    metric: null,
    direction,
    temporal: 'at_resolution',
    value: { primary: valuePrimary, secondary: null, unit: isMov ? 'percentage points' : 'votes' },
  }, 'kalshi-det');
}

// Folds party into canonical_subject so opposite-party margin rows for the same race never collapse onto one KB entity.
export function electionMarginSubjectWithParty(
  baseSubject: string,
  party: string | null,
): string {
  if (!party) return baseSubject;
  const lbl = partyToOutcomeLabel(party);
  const suffix = ` (${lbl})`;
  return baseSubject.toLowerCase().endsWith(suffix.toLowerCase()) ? baseSubject : `${baseSubject}${suffix}`;
}

async function tryPerDistrictMidtermElection(
  row: KalshiCandidateRow,
): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker) return null;
  const isMov = ticker.startsWith('KXMIDTERMMOV');
  const isTurn = ticker.startsWith('KXMIDTERMVOTETURN');
  if (!isMov && !isTurn) return null;
  if (!row.strike_type || !TYPED_STRIKE_SET.has(row.strike_type)) return null;

  const sd = deriveShapeAndDirection(row.strike_type);
  if (!sd) return null;
  const floor = toNumber(row.floor_strike);
  const cap = toNumber(row.cap_strike);
  const valuePrimary = sd.direction === 'above' ? floor
    : sd.direction === 'below' ? cap
    : floor;
  const valueSecondary = sd.direction === 'between' ? cap : null;
  if (valuePrimary == null) return null;

  const districtMatch = isMov
    ? row.title.match(MIDTERM_MOV_TITLE_RX)
    : row.title.match(MIDTERM_VOTETURN_TITLE_RX);

  let subjectRaw: string;
  let party: string | null;
  if (districtMatch?.groups) {
    const g = districtMatch.groups;
    subjectRaw = `${g.state.trim()} ${normalizeDistrict(g.district)} ${g.chamber.toLowerCase()} race`;
    party = isMov ? g.party : null;
  } else if (isMov) {
    const sw = parseMidtermMovStatewide(row.title);
    if (!sw) return null;
    subjectRaw = sw.subjectRaw;
    party = sw.party;
  } else {
    return null;
  }

  subjectRaw = midtermSubjectWithMetric(subjectRaw, isMov);

  const year = midtermCycleYear();
  const canonicalEvent = `${year} ${subjectRaw.toLowerCase()}`;

  const canonicalSubject = await resolveSubjectViaKB(subjectRaw, 'politics');
  const unit = isMov ? 'percentage points' : 'votes';

  const gatedSubject = electionMarginSubjectWithParty(canonicalSubject, party);

  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'event_name', aliases: [subjectRaw] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title).filter((a) => a !== canonicalEvent) },
  ];
  let condParts: Pick<KalshiNormParts,
    'shape' | 'direction' | 'metric' | 'temporal' | 'valuePrimary' | 'valueSecondary' | 'valueUnit'>;
  if (sd.direction === 'above' || sd.direction === 'below') {
    const tuple = midtermConditionTuple(isMov, sd.direction, valuePrimary);
    if (!tuple) return null; // unreachable for a finite arity-1 threshold spec
    condParts = tupleConditionParts(tuple);
  } else {
    condParts = {
      shape: sd.shape, direction: sd.direction, metric: null,
      temporal: 'at_resolution', valuePrimary, valueSecondary, valueUnit: unit,
    };
  }
  const norm = assembleKalshiNorm(row, {
    subject: gatedSubject,
    canonicalEvent,
    ...condParts,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: party ? partyToOutcomeLabel(party) : null,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([gatedSubject]),
    category: 'election',
    leagueId: null,
    eventKind: isMov ? 'election_margin' : 'election_turnout',
  }, isMov ? 'kalshi:midterm-mov' : 'kalshi:midterm-voteturn');

  await registerEntities(row.market_id, canonicalSubject, norm.resolved_entities, 'politics');
  return { norm, tag: norm.match_source! };
}

export type PrimaryRangeParse =
  | { shape: 'range'; candidate: string; year: number | null; event: string; lo: number; hi: number }
  | { shape: 'tail'; candidate: string; year: number | null; event: string; lo: number };

const PRIMARY_MOV_TITLE_RX =
  /^Will the margin of victory for (?<cand>.+?) in (?<event>.+?) be (?:between (?<lo>\d+(?:\.\d+)?)% and (?<hi>\d+(?:\.\d+)?)%|above (?<above>\d+(?:\.\d+)?)%)\s*\??$/i;
const VOTE_PRIMARY_TITLE_RX =
  /^Will (?<cand>.+?) receive (?:between (?<lo>\d+(?:\.\d+)?)% and (?<hi>\d+(?:\.\d+)?)%|at least (?<atleast>\d+(?:\.\d+)?)%) of the popular vote in (?<event>.+?)\s*\??$/i;

function primaryRangeFromGroups(
  g: Record<string, string | undefined>,
  tailKey: 'above' | 'atleast',
): PrimaryRangeParse | null {
  const candidate = g.cand?.trim();
  const event = g.event?.trim().replace(/^the\s+/i, '').replace(/\s+/g, ' ');
  if (!candidate || !event) return null;
  if (/^who$/i.test(candidate)) return null;
  const ym = event.match(/\b(20\d{2})\b/);
  const year = ym ? parseInt(ym[1]!, 10) : null;
  if (g.lo != null && g.hi != null) {
    const lo = parseFloat(g.lo);
    const hi = parseFloat(g.hi);
    if (Number.isNaN(lo) || Number.isNaN(hi) || hi <= lo) return null;
    return { shape: 'range', candidate, year, event, lo, hi };
  }
  const tailRaw = g[tailKey];
  if (tailRaw == null) return null;
  const lo = parseFloat(tailRaw);
  if (Number.isNaN(lo)) return null;
  return { shape: 'tail', candidate, year, event, lo };
}

export function parsePrimaryMov(title: string): PrimaryRangeParse | null {
  const m = title.match(PRIMARY_MOV_TITLE_RX);
  if (!m?.groups) return null;
  return primaryRangeFromGroups(m.groups, 'above');
}

export function parseVotePrimary(title: string): PrimaryRangeParse | null {
  const m = title.match(VOTE_PRIMARY_TITLE_RX);
  if (!m?.groups) return null;
  return primaryRangeFromGroups(m.groups, 'atleast');
}

async function tryPrimaryRangeElection(
  row: KalshiCandidateRow,
): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker) return null;
  const isMov = ticker.startsWith('KXPRIMARYMOV');
  const isVote = ticker.startsWith('KXVOTEPRIMARY');
  if (!isMov && !isVote) return null;

  const parsed = isMov ? parsePrimaryMov(row.title) : parseVotePrimary(row.title);
  if (!parsed) return null;

  const unit = isMov ? 'percentage points' : 'percent';
  const eventKind: EventKind = isMov ? 'election_margin' : 'election_vote_share';
  const tag = isMov ? 'kalshi:primary-mov' : 'kalshi:vote-primary';
  const metricSuffix = isMov ? 'margin' : 'vote share';
  const year = parsed.year
    ?? yearFromIso(row.end_date)
    ?? yearFromIso(row.occurrence_datetime)
    ?? 2026;

  const canonicalEvent =
    `${parsed.event} ${parsed.candidate} ${metricSuffix}`.toLowerCase().slice(0, 200);
  const canonicalSubject = await resolveSubjectViaKB(parsed.candidate, 'politics');

  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'person',
      aliases: parsed.candidate !== canonicalSubject ? [parsed.candidate] : [] },
    { canonical: canonicalEvent, type: 'event_name',
      aliases: gatedEventAlias(row.title).filter((a) => a !== canonicalEvent) },
  ];

  const tuple = parsed.shape === 'range'
    ? emitCondition({
        archetype: 'terminal_range',
        tag,
        eventKind,
        metric: null,
        temporal: 'on_date',
        value: { primary: parsed.lo, secondary: parsed.hi, unit },
      }, 'kalshi-det')
    : emitCondition({
        archetype: 'terminal_threshold',
        tag,
        eventKind,
        metric: null,
        direction: 'above',
        temporal: 'at_resolution',
        value: { primary: parsed.lo, unit },
      }, 'kalshi-det');
  if (!tuple) return null;

  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent,
    ...tupleConditionParts(tuple),
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'election',
    leagueId: null,
    eventKind,
  }, tag);
  await registerEntities(row.market_id, canonicalSubject, resolved_entities, 'politics');
  return { norm, tag: norm.match_source! };
}


const PLACE_FIRST_TITLE_RX =
  /^Will\s+(?<candidate>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+place\s+first\s+in\s+the\s+(?<year>20\d{2})\s+(?<district>[A-Z]{2}(?:-\d{1,2})?)\s+primary\??$/iu;

async function tryPlaceFirstPrimary(
  row: KalshiCandidateRow,
): Promise<KalshiNormalizationHit | null> {
  if (!row.yes_sub_title) return null;
  const m = row.title.match(PLACE_FIRST_TITLE_RX);
  if (!m?.groups) return null;

  const candidate = row.yes_sub_title.trim();
  const year = parseInt(m.groups.year, 10);
  const district = m.groups.district;
  const partyRaw = (row.subtitle ?? '').replace(/^::\s*/, '').trim() || null;
  const canonicalEvent = primaryAdvanceCanonicalEvent(year, district, null);

  const canonicalSubject = await resolveSubjectViaKB(candidate, 'politics');

  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'person', aliases: candidate !== canonicalSubject ? [candidate] : [] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent,
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: 1,
    valueUnit: 'rank',
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: partyRaw ? normalizeOutcomeLabel(partyRaw) : null,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'election',
    leagueId: null,
    eventKind: 'election_outcome_winner',
  }, 'kalshi:place-first-primary');

  await registerEntities(row.market_id, canonicalSubject, norm.resolved_entities, 'politics');
  return { norm, tag: 'kalshi:place-first-primary' };
}


const PGA_TOP_TITLE_RX =
  /^(?<tournament>[^:]+?):\s*Will\s+(?<player>[\p{L}][\p{L}\p{M}\s.'\-]+?)\s+finish\s+top\s+(?<n>\d+)\??$/iu;

const PGA_TOP_PREFIX_RX = /^KXPGATOP(?<n>\d+)/;

async function tryPlayerFinishPosition(
  row: KalshiCandidateRow,
): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker) return null;
  const prefixMatch = ticker.match(PGA_TOP_PREFIX_RX);
  if (!prefixMatch?.groups) return null;
  const titleMatch = row.title.match(PGA_TOP_TITLE_RX);
  if (!titleMatch?.groups) return null;

  const tournament = titleMatch.groups.tournament.trim();
  const player = titleMatch.groups.player.trim();
  const nFromTitle = parseInt(titleMatch.groups.n, 10);
  const nFromPrefix = parseInt(prefixMatch.groups.n, 10);
  if (nFromTitle !== nFromPrefix) return null;
  const n = nFromTitle;

  const eventDate = extractEventDate({
    platform: 'kalshi',
    platform_id: row.platform_id,
    title: row.title,
    slug: null,
    end_date: row.end_date,
    mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;

  const canonicalEvent = `${year} ${tournament.toLowerCase()}`;
  const canonicalSubject = await resolveSubjectViaKB(player, 'sports');

  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'person', aliases: [player] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent,
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: n,
    valueUnit: 'rank',
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:player-finish-position');

  await registerEntities(row.market_id, canonicalSubject, norm.resolved_entities, 'sports');
  return { norm, tag: 'kalshi:player-finish-position' };
}

interface GameStatSpec {
  expectedUnit: string;
  sport: string;
  leagueCanonical: string;
  category: UnifiedCategory;
}

const PLAYER_GAME_STAT_SERIES_MAP: Record<string, GameStatSpec> = {
  KXMLBHRR: { expectedUnit: 'hits_runs_rbis', sport: 'baseball', leagueCanonical: 'MLB', category: 'sports' },
};

const PLAYER_GAME_PROP_SUBTITLE_RX = /^(?<player>.+?):\s*(?<value>\d+(?:\.\d+)?)\+\s*$/;

async function tryPlayerGameCombinedStat(
  row: KalshiCandidateRow,
): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, PLAYER_GAME_STAT_SERIES_MAP);
  if (!spec) return null;
  if (row.strike_type !== 'greater') return null;

  const m = (row.yes_sub_title ?? '').match(PLAYER_GAME_PROP_SUBTITLE_RX);
  if (!m?.groups?.player || !m.groups.value) return null;
  const playerRaw = m.groups.player.trim();
  const titleN = parseFloat(m.groups.value); // integer N from "N+"; == floor_strike + 0.5
  if (!playerRaw || Number.isNaN(titleN)) return null;
  const unit = spec.expectedUnit;
  const fromFloor = canonicalizeKalshiStrike('greater', toNumber(row.floor_strike), null, unit);
  const value = fromFloor != null
    ? fromFloor.value
    : canonicalizeIntegerThreshold({ direction: 'above', value: titleN, unit, strictness: 'inclusive' }).value;

  const tuple = emitCondition({
    archetype: 'cumulative_count',
    arm: 'above',
    legacyMonotonicArm: true,
    tag: 'kalshi:player-game-prop',
    eventKind: 'player_prop_threshold',
    metric: 'count',
    direction: 'above',
    temporal: 'during_period',
    value: { primary: value, unit },
  }, 'kalshi-det');
  if (!tuple) return null;

  const canonical_subject = await resolveSubjectViaKB(
    playerRaw,
    'sports',
    { sport: spec.sport, league: spec.leagueCanonical },
  );
  const leagueHit = await resolveLeague(spec.leagueCanonical);
  const playerScopeMeta = scopeToEntityMetadata(
    { sport: spec.sport, league: leagueHit.canonical },
    'person',
  );
  const resolved_entities: ResolvedEntity[] = [
    {
      canonical: canonical_subject,
      type: 'person',
      aliases: [playerRaw],
      metadata: metaOrUndef(playerScopeMeta),
    },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: `${canonical_subject} ${unit}`,
    ...tupleConditionParts(tuple),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: spec.category,
    leagueId: leagueHit.id,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:player-game-prop');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, unifiedToDomain(spec.category));
  return { norm, tag: 'kalshi:player-game-prop' };
}

interface EconExactSpec {
  subject: string;
  resolutionSource: string;
}

const ECON_EXACT_VALUE_SERIES: Record<string, EconExactSpec> = {
  KXECONSTATCPI:        { subject: 'US CPI',                   resolutionSource: 'BLS' }, // MoM
  KXECONSTATCPIYOY:     { subject: 'US CPI',                   resolutionSource: 'BLS' }, // YoY
  KXECONSTATCPICORE:    { subject: 'US Core CPI',              resolutionSource: 'BLS' }, // core MoM
  KXECONSTATCORECPIYOY: { subject: 'US Core CPI',              resolutionSource: 'BLS' }, // core YoY
  KXECONSTATU3:         { subject: 'US U-3 Unemployment Rate', resolutionSource: 'BLS' },
};

export function parseEconExactValue(customStrike: string | null): number | null {
  if (!customStrike) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(customStrike); } catch { return null; }
  const v = (parsed as { Value?: unknown } | null)?.Value;
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

async function tryEconExactValue(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, ECON_EXACT_VALUE_SERIES);
  if (!spec) return null;
  if (row.strike_type !== 'custom') return null;
  const value_primary = parseEconExactValue(row.custom_strike);
  if (value_primary == null) return null;

  const tuple = emitCondition({
    archetype: 'terminal_threshold',
    tag: 'kalshi:econ-exact-value',
    eventKind: 'price_snapshot',
    metric: 'percentage',
    direction: 'at',
    temporal: 'on_date',
    value: { primary: value_primary, unit: 'percent' },
  }, 'kalshi-det');
  if (!tuple) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi',
    platform_id: row.platform_id,
    title: row.title,
    slug: null,
    end_date: null,
  });
  const canonical_subject = await resolveSubjectViaKB(spec.subject, 'finance');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: spec.subject !== canonical_subject ? [spec.subject] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ?? row.title,
    ...tupleConditionParts(tuple),
    conditionValue: `=${value_primary}percent`,
    date: {
      iso: eventDate?.iso ?? row.end_date ?? null,
      precision: eventDate?.precision ?? (row.end_date ? 'day' : null),
      source: eventDate?.source ?? (row.end_date ? 'end_date' : null),
    },
    outcomeLabel: row.yes_sub_title, // 'Exactly 3.7%'
    resolvedEntities: resolved_entities,
    resolutionSource: spec.resolutionSource,
    participants: dedupeSorted([canonical_subject]),
    category: 'economic',
    eventKind: 'price_snapshot',
  }, 'kalshi:econ-exact-value');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'finance');
  return { norm, tag: 'kalshi:econ-exact-value' };
}

interface NextTeamSpec {
  sport: string | null;
  league: string | null;
  destType: 'team' | 'club' | 'league';
}

const NEXT_TEAM_SERIES: Record<string, NextTeamSpec> = {
  KXNEXTTEAMNBA: { sport: 'basketball',        league: 'NBA', destType: 'team' },
  KXNEXTTEAMNFL: { sport: 'american football', league: 'NFL', destType: 'team' },
  KXNEXTTEAMNHL: { sport: 'ice hockey',        league: 'NHL', destType: 'team' },
  KXNEXTTEAMMLB: { sport: 'baseball',          league: 'MLB', destType: 'team' },
  KXJOINCLUB:    { sport: 'soccer',            league: null,  destType: 'club' },
  KXJOINRONALDO: { sport: 'soccer',            league: null,  destType: 'club' },
  KXJOINLEAGUE:  { sport: 'soccer',            league: null,  destType: 'league' },
};

const NEXT_TEAM_TITLE_A_RX = /^What will be (.+?)'s next team\?$/;
const NEXT_TEAM_TITLE_B_RX = /^Where will (.+?) go next\?$/;
const NEXT_TEAM_RESIDUAL_RX = /\bretires?\b|^stays with |no team/i;

export function parseNextTeamSubject(title: string): string | null {
  const a = title.match(NEXT_TEAM_TITLE_A_RX);
  if (a?.[1]) return a[1].trim();
  const b = title.match(NEXT_TEAM_TITLE_B_RX);
  return b?.[1]?.trim() ?? null;
}

async function tryNextTeamTransfer(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, NEXT_TEAM_SERIES);
  if (!spec) return null;
  const subjectRaw = parseNextTeamSubject(row.title);
  if (!subjectRaw) return null;
  const dest = (row.yes_sub_title ?? '').trim();
  if (!dest) return null;
  const isResidual = NEXT_TEAM_RESIDUAL_RX.test(dest);
  const outcomeLabel = isResidual ? 'No transfer / Retires' : dest;

  const canonical_subject = await resolveSubjectViaKB(subjectRaw, 'sports', { sport: spec.sport, league: spec.league });
  let leagueId: number | null = null;
  let leagueCanonical: string | null = null;
  if (spec.league) {
    const l = await resolveLeague(spec.league);
    leagueId = l.id;
    leagueCanonical = l.canonical;
  }
  const playerScope = scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    {
      canonical: canonical_subject,
      type: 'person',
      aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [],
      metadata: metaOrUndef(playerScope),
    },
  ];
  if (!isResidual && spec.destType !== 'league') {
    const destCanonical = await resolveSubjectViaKB(dest, 'sports', { sport: spec.sport, league: spec.league });
    resolved_entities.push({ canonical: destCanonical, type: 'team', aliases: dest !== destCanonical ? [dest] : [] });
  }

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ?? row.title,
    shape: 'categorical_outcome',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: spec.destType === 'league' ? 'league' : 'team',
    conditionValue: `dest=${normalizeOutcomeLabel(outcomeLabel)}`,
    date: kalshiExpirationDate(row),
    outcomeLabel: normalizeOutcomeLabel(outcomeLabel),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'personnel_move',
  }, 'kalshi:next-team-transfer');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:next-team-transfer' };
}

interface NextMgrSpec { sport: string | null; league: string | null; }
const NEXT_MGR_SERIES: Record<string, NextMgrSpec> = {
  KXNEXTNBACOACH:      { sport: 'basketball',        league: 'NBA' },
  KXNEXTMANAGERMANU:   { sport: 'soccer',            league: 'EPL' },
  KXNEXTMANAGEREPL:    { sport: 'soccer',            league: 'EPL' },
  KXNEXTMANAGERLALIGA: { sport: 'soccer',            league: 'LaLiga' },
  KXNEXTMANAGERMLB:    { sport: 'baseball',          league: 'MLB' },
  KXNCAAMBNEXTCOACH:   { sport: 'basketball',        league: 'NCAAB' },
  KXCOACHONDATE:       { sport: 'american football', league: 'NFL' },
};
const K_NEXT_MGR_TITLE_RX = /^who\s+will\s+be\s+(?:the\s+)?(?:next\s+)?(?:head\s+coach|manager|coach)\s+of\s+(?:the\s+)?(?<club>.+?)(?:\s+for\s+week\s+\d+)?\??$/i;
const K_NEXT_MGR_WILLBE_RX = /^will\s+.+?\s+be\s+the\s+next\s+(?:permanent\s+)?(?:head\s+coach|manager|coach)\s+of\s+(?:the\s+)?(?<club>.+?)\??$/i;

async function tryNextManagerCoach(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, NEXT_MGR_SERIES);
  if (!spec) return null;
  const candRaw = (row.yes_sub_title ?? '').trim();
  if (!candRaw) return null;
  const clubM = row.title.match(K_NEXT_MGR_TITLE_RX) ?? row.title.match(K_NEXT_MGR_WILLBE_RX);
  const clubRaw = clubM?.groups?.club?.trim();
  if (!clubRaw) return null;

  const canonical_subject = await resolveSubjectViaKB(candRaw, 'sports', { sport: spec.sport, league: spec.league });
  const clubCanonical = await resolveSubjectViaKB(clubRaw, 'sports', { sport: spec.sport, league: spec.league });
  let leagueId: number | null = null, leagueCanonical: string | null = null;
  if (spec.league) { const l = await resolveLeague(spec.league); leagueId = l.id; leagueCanonical = l.canonical; }
  const candScope = scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: candRaw !== canonical_subject ? [candRaw] : [], metadata: metaOrUndef(candScope) },
    { canonical: clubCanonical, type: 'team', aliases: clubRaw !== clubCanonical ? [clubRaw] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: `next ${clubCanonical.toLowerCase()} manager`,
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    date: kalshiExpirationDate(row),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject, clubCanonical]),
    category: 'sports',
    leagueId,
    eventKind: 'personnel_move',
  }, 'kalshi:next-manager');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:next-manager' };
}

const K_MGR_OUT_RX = /^will\s+.+?\s+cease\s+to\s+be\s+(?:manager|head\s+coach|coach)\s+of\s+(?<club>.+?)\s+(?:by|before)\s+(?<date>.+?)\??$/i;
async function tryManagerOut(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== 'KXMANAGERSOUT') return null;
  const personRaw = (row.yes_sub_title ?? '').trim();
  const clubM = row.title.match(K_MGR_OUT_RX);
  const clubRaw = clubM?.groups?.club?.trim();
  if (!personRaw || !clubRaw) return null;
  const canonical_subject = await resolveSubjectViaKB(personRaw, 'sports', { sport: 'soccer', league: null });
  const clubCanonical = await resolveSubjectViaKB(clubRaw, 'sports', { sport: 'soccer', league: null });
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: personRaw !== canonical_subject ? [personRaw] : [] },
    { canonical: clubCanonical, type: 'team', aliases: clubRaw !== clubCanonical ? [clubRaw] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: `${canonical_subject.toLowerCase()} out as ${clubCanonical.toLowerCase()}`,
    shape: 'binary_event',
    direction: null,
    metric: null,
    temporal: null,
    valuePrimary: null,
    valueUnit: null,
    date: kalshiExpirationDate(row),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject, clubCanonical]),
    category: 'sports',
    leagueId: null,
    eventKind: 'personnel_move',
  }, 'kalshi:manager-out');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:manager-out' };
}

const SPEECH_MENTION_SERIES_RX = /(?:MENTION|SAY)/;
export const K_SPEECH_SHAPE_A_RX =
  /^will\s+(?<who>.+?)\s+say\s+["“”'][^"“”']+["“”']\s+before\s+(?<deadline>.+?)\??$/iu;
export const K_SPEECH_SHAPE_B_RX =
  /^what\s+will\s+(?<who>.+?)\s+say\s+(?<prep>during|at|in)\s+(?<occasion>.+?)\??$/iu;
export const K_SPEECH_ROLE_NOUN_RX =
  /^(?:the\s+announcers|any\b|.*\b(?:coach|player|cast|contestant|commentator|panel|panelist|host)s?\b)/i;

export async function tryKalshiSpeechMention(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (!prefix || !SPEECH_MENTION_SERIES_RX.test(prefix)) return null;

  const word = ((): string | null => {
    if (row.custom_strike) {
      try {
        const parsed = JSON.parse(row.custom_strike) as { Word?: unknown };
        if (typeof parsed.Word === 'string' && parsed.Word.trim()) return parsed.Word.trim();
      } catch { /* fall through to yes_sub_title */ }
    }
    const yst = (row.yes_sub_title ?? '').trim();
    return yst.length > 0 ? yst : null;
  })();
  if (!word) return null;
  const outcomeLabel = normalizeOutcomeLabel(word);
  if (!outcomeLabel) return null;

  const aM = row.title.match(K_SPEECH_SHAPE_A_RX);
  const bM = aM ? null : row.title.match(K_SPEECH_SHAPE_B_RX);
  const whoRaw = (aM?.groups?.who ?? bM?.groups?.who)?.trim();
  if (!whoRaw) return null;
  const occasionRaw = bM?.groups?.occasion?.trim() ?? null;

  const isRoleNoun = K_SPEECH_ROLE_NOUN_RX.test(whoRaw);

  const date = aM
    ? {
        iso: row.expected_expiration_time ?? row.occurrence_datetime ?? row.end_date ?? null,
        precision: (row.expected_expiration_time || row.occurrence_datetime || row.end_date) ? ('day' as const) : null,
        source: row.expected_expiration_time
          ? 'kalshi-expected-expiration-time'
          : (row.occurrence_datetime ? 'kalshi-occurrence-datetime' : (row.end_date ? 'end_date' : null)),
      }
    : undefined; // Shape B → assembleKalshiNorm default (occurrence_datetime → end_date)

  const occasionPhrase = occasionRaw ?? (aM?.groups?.deadline?.trim() ?? null);

  if (isRoleNoun) {
    const eventScopedSubject = (occasionRaw ?? row.event_title ?? row.title).trim();
    const canonicalEvent = (aM
      ? `what will the speakers say ${occasionPhrase ? `before ${occasionPhrase.toLowerCase()}` : 'before deadline'}`
      : `what will the speakers say during ${(occasionRaw ?? eventScopedSubject).toLowerCase()}`
    ).slice(0, 200);
    const resolved_entities: ResolvedEntity[] = [
      { canonical: eventScopedSubject, type: 'event_name', aliases: [] },
    ];
    const norm = assembleKalshiNorm(row, {
      subject: eventScopedSubject,
      canonicalEvent,
      shape: 'binary_event',
      direction: null,
      metric: null,
      temporal: null,
      valuePrimary: null,
      valueUnit: null,
      ...(date ? { date } : {}),
      outcomeLabel,
      resolvedEntities: resolved_entities,
      participants: dedupeSorted([eventScopedSubject]),
      category: row.category_unified,
      eventKind: 'speech_mention',
    }, 'kalshi:speech-mention');
    return { norm, tag: 'kalshi:speech-mention' };
  }

  const domainCategory = unifiedToDomain(row.category_unified);
  const canonical_subject = await resolveSubjectViaKB(whoRaw, domainCategory);
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: whoRaw !== canonical_subject ? [whoRaw] : [] },
  ];
  const canonicalEvent = (aM
    ? `what will ${canonical_subject.toLowerCase()} say ${occasionPhrase ? `before ${occasionPhrase.toLowerCase()}` : 'before deadline'}`
    : `what will ${canonical_subject.toLowerCase()} say during ${(occasionRaw ?? '').toLowerCase()}`
  ).slice(0, 200);
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    shape: 'binary_event',
    direction: null,
    metric: null,
    temporal: null,
    valuePrimary: null,
    valueUnit: null,
    ...(date ? { date } : {}),
    outcomeLabel,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: row.category_unified,
    eventKind: 'speech_mention',
  }, 'kalshi:speech-mention');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCategory);
  return { norm, tag: 'kalshi:speech-mention' };
}

interface ParticipationSpec { sport: string; league: string; }
const PARTICIPATION_SERIES: Record<string, ParticipationSpec> = {
  KXMLBDEBUT:  { sport: 'baseball',   league: 'MLB' },
  KXNBARETURN: { sport: 'basketball', league: 'NBA' },
  KXMLBRETURN: { sport: 'baseball',   league: 'MLB' },
};
const K_PARTICIPATION_RX = /^will\s+(?<player>.+?)\s+play\s+in\s+a\s+game\s+for\s+(?:any\s+team\s+in\s+the\s+\w+|(?:the\s+)?(?<team>.+?))\s*(?:after\s+(?<after>[A-Z][a-z]+ \d{1,2}, \d{4})\s+and\s+)?before\s+(?<before>[A-Z][a-z]+ \d{1,2}, \d{4})\??$/i;
function kParseDate(s: string | undefined): string | null {
  if (!s) return null;
  const stamped = stampConditionDate({ kind: 'monthDay', text: s, endDate: null });
  return stamped ? `${stamped.iso}T00:00:00Z` : null;
}
async function tryPlayerParticipation(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, PARTICIPATION_SERIES);
  if (!spec) return null;
  const m = row.title.match(K_PARTICIPATION_RX);
  if (!m?.groups?.player) return null;
  const playerRaw = m.groups.player.trim();
  const teamRaw = m.groups.team?.trim();
  const ystDate = (row.yes_sub_title ?? '').match(/^before\s+(?<date>[A-Z][a-z]+ \d{1,2}, \d{4})$/i);
  const deadlineIso = kParseDate(ystDate?.groups?.date) ?? kParseDate(m.groups.before) ?? row.expected_expiration_time ?? row.end_date ?? null;
  const startIso = kParseDate(m.groups.after);

  const canonical_subject = await resolveSubjectViaKB(playerRaw, 'sports', { sport: spec.sport, league: spec.league });
  const lh = await resolveLeague(spec.league);
  const leagueId = lh.id;
  const playerScope = scopeToEntityMetadata({ sport: spec.sport, league: lh.canonical }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: playerRaw !== canonical_subject ? [playerRaw] : [], metadata: metaOrUndef(playerScope) },
  ];
  let participants = [canonical_subject];
  if (teamRaw) {
    const teamCanonical = await resolveSubjectViaKB(teamRaw, 'sports', { sport: spec.sport, league: spec.league });
    resolved_entities.push({ canonical: teamCanonical, type: 'team', aliases: teamRaw !== teamCanonical ? [teamRaw] : [] });
    participants = [canonical_subject, teamCanonical];
  }
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ? normalizeFixtureCanonicalEvent(row.event_title) : `${canonical_subject.toLowerCase()} plays`,
    shape: 'monotonic_threshold',
    direction: null,
    metric: null,
    temporal: 'by_date',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: startIso ? `window=${startIso.slice(0, 10)}..${(deadlineIso ?? '').slice(0, 10)}` : `before=${(deadlineIso ?? '').slice(0, 10)}`,
    date: {
      iso: deadlineIso,
      precision: deadlineIso ? 'day' : null,
      source: ystDate ? 'kalshi-yes-sub-title' : (row.expected_expiration_time ? 'kalshi-expected-expiration-time' : 'end_date'),
    },
    resolvedEntities: resolved_entities,
    participants,
    category: 'sports',
    leagueId,
    eventKind: 'participation',
  }, 'kalshi:player-participation');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:player-participation' };
}

interface FirstScorerSpec { sport: string; league: string }
export const FIRST_SCORER_SERIES: Record<string, FirstScorerSpec> = {
  KXNHLFIRSTGOAL: { sport: 'ice hockey', league: 'NHL' },
};
export const K_FIRST_SCORER_RX = /^(?<player>.+?):\s*First\s+Goalscorer\s*\??$/i;

export function parseFirstScorerTitle(title: string): string | null {
  const m = title.match(K_FIRST_SCORER_RX);
  const raw = m?.groups?.player?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function firstScorerConditionTuple(): ConditionTuple | null {
  return emitCondition({
    archetype: 'event_occurrence',
    tag: 'kalshi:first-goal-scorer',
    eventKind: 'player_prop_threshold',
    metric: 'rank',
    temporal: 'at_resolution',
  }, 'kalshi-det');
}

async function tryFirstGoalScorer(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, FIRST_SCORER_SERIES);
  if (!spec) return null;
  const titlePlayer = parseFirstScorerTitle(row.title);
  if (!titlePlayer) return null;
  const playerRaw = row.yes_sub_title?.trim() || titlePlayer;

  const tuple = firstScorerConditionTuple();
  if (!tuple) return null; // door rejection = template miss (unshaped beats unsound)

  const canonical_subject = await resolveSubjectViaKB(playerRaw, 'sports', { sport: spec.sport, league: spec.league });
  const lh = await resolveLeague(spec.league);
  const leagueId = lh.id;
  const playerScope = scopeToEntityMetadata({ sport: spec.sport, league: lh.canonical }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: playerRaw !== canonical_subject ? [playerRaw] : [], metadata: metaOrUndef(playerScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: `${canonical_subject.toLowerCase()} first goalscorer`,
    ...tupleConditionParts(tuple),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:first-goal-scorer');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:first-goal-scorer' };
}

interface TournamentAdvanceSpec {
  league: string | null;
  sport: string | null;
  category: UnifiedCategory;
  subjectType: SubjectEntityType;
  roundFromTicker: boolean;
  fixedRound?: string;
  fixedRemaining?: number;
}

const TOURNAMENT_ADVANCE_SERIES: Record<string, TournamentAdvanceSpec> = {
  KXMARMADROUND:   { league: "NCAA Men's Basketball", sport: 'basketball',        category: 'sports', subjectType: 'team', roundFromTicker: true },
  KXWMARMADROUND:  { league: "NCAA Women's Basketball", sport: 'basketball',      category: 'sports', subjectType: 'team', roundFromTicker: true },
  KXWCROUND:       { league: 'FIFA World Cup',        sport: 'soccer',            category: 'sports', subjectType: 'team', roundFromTicker: true },
  KXWCGROUPQUAL:   { league: 'FIFA World Cup',        sport: 'soccer',            category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Round of 32 (group qualify)', fixedRemaining: 32 },
  KXNCAAFPLAYOFF:  { league: 'NCAA Football',         sport: 'american football', category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'College Football Playoff', fixedRemaining: 12 },
  KXNFLPLAYOFF:    { league: 'NFL',                   sport: 'american football', category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Playoffs', fixedRemaining: 14 },
  KXNCAABBPLAYOFFS:{ league: 'NCAA Baseball',         sport: 'baseball',          category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'College World Series', fixedRemaining: 8 },
  KXMLBPLAYOFFS:   { league: 'MLB',                   sport: 'baseball',          category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Playoffs', fixedRemaining: 12 },
  KXWNBAPLAYOFF:   { league: 'WNBA',                  sport: 'basketball',        category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Playoffs', fixedRemaining: 8 },
  KXNCAAMLAXF4:    { league: 'NCAA Lacrosse',         sport: 'lacrosse',          category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Semifinals', fixedRemaining: 4 },
  KXIPLFINALS:     { league: 'IPL',                   sport: 'cricket',           category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Final', fixedRemaining: 2 },
  KXIPLPLAYOFF:    { league: 'IPL',                   sport: 'cricket',           category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Playoffs', fixedRemaining: 4 },
  KXEPLTOP4:       { league: 'English Premier League', sport: 'soccer',           category: 'sports', subjectType: 'team', roundFromTicker: false, fixedRound: 'Top 4 (UCL qualification)', fixedRemaining: 4 },
  KXEUROVISIONFIRSTSFINAL:  { league: null, sport: null, category: 'entertainment', subjectType: 'event_name', roundFromTicker: false, fixedRound: 'Grand Final', fixedRemaining: 26 },
  KXEUROVISIONSECONDSFINAL: { league: null, sport: null, category: 'entertainment', subjectType: 'event_name', roundFromTicker: false, fixedRound: 'Grand Final', fixedRemaining: 26 },
};

const ADVANCE_ROUND_CODES: Record<string, { name: string; remaining: number }> = {
  R32: { name: 'Round of 32', remaining: 32 }, R16: { name: 'Round of 16', remaining: 16 }, R8: { name: 'Round of 8', remaining: 8 },
  F4: { name: 'Semifinals', remaining: 4 }, T2: { name: 'Championship Game', remaining: 2 },
  RO16: { name: 'Round of 16', remaining: 16 }, QUAR: { name: 'Quarterfinals', remaining: 8 }, SEMI: { name: 'Semifinals', remaining: 4 }, FINAL: { name: 'Final', remaining: 2 },
  QF: { name: 'Quarterfinals', remaining: 8 }, FIN: { name: 'Final', remaining: 2 },
};

async function tryTournamentRoundAdvance(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker) return null;
  const prefix = ticker.split('-')[0];
  const spec = TOURNAMENT_ADVANCE_SERIES[prefix];
  if (!spec) return null;
  const subjectRaw = (row.yes_sub_title ?? '').trim();
  if (!subjectRaw) return null;
  const seg = ticker.split('-')[1] ?? '';
  const yy = seg.slice(0, 2);
  const yearNum = parseInt(yy, 10);
  if (Number.isNaN(yearNum)) return null;
  const year = 2000 + yearNum;

  let roundName: string;
  let remaining: number;
  if (spec.roundFromTicker) {
    const code = seg.replace(/^\d{2,4}/, '');
    const r = ADVANCE_ROUND_CODES[code];
    if (!r) return null; // unknown round-code → defer to LLM rather than guess
    roundName = r.name;
    remaining = r.remaining;
  } else {
    roundName = spec.fixedRound!;
    remaining = spec.fixedRemaining!;
  }

  const domainCat = unifiedToDomain(spec.category);
  const canonical_subject = await resolveSubjectViaKB(subjectRaw, domainCat, { sport: spec.sport, league: spec.league });
  let leagueId: number | null = null;
  let leagueCanonical: string | null = null;
  if (spec.league) {
    const l = await resolveLeague(spec.league);
    leagueId = l.id;
    leagueCanonical = l.canonical;
  }
  const subjScope = scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, spec.subjectType);
  const resolved_entities: ResolvedEntity[] = [
    {
      canonical: canonical_subject,
      type: spec.subjectType,
      aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [],
      metadata: metaOrUndef(subjScope),
    },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ?? row.title,
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'by_date',
    valuePrimary: remaining,
    valueUnit: 'teams_remaining',
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: `reach ${roundName}`,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: spec.category,
    leagueId,
    eventKind: 'stage_advance',
  }, 'kalshi:tournament-round-advance');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCat);
  return { norm, tag: 'kalshi:tournament-round-advance' };
}


interface SeasonWinsSpec {
  sport: string;
  league: string;
  teamFromTitle: RegExp;
}
export const SEASON_WINS_SERIES: Record<string, SeasonWinsSpec> = {
  KXNFLWINS:   { sport: 'football', league: 'NFL',
                 teamFromTitle: /^Will\s+the\s+(?<team>.+?)\s+pro\s+football\s+team\s+win\s+at\s+least\s+\d+\s+games?\s+this\s+season\??$/i },
  KXNCAAFWINS: { sport: 'football', league: 'NCAA',
                 teamFromTitle: /^Will\s+(?<team>.+?)\s+win\s+at\s+least\s+\d+\s+games?\s+this\s+season\??$/i },
  KXMLBWINS:   { sport: 'baseball', league: 'MLB',
                 teamFromTitle: /^Will\s+(?<team>.+?)\s+win\s+at\s+least\s+\d+\s+games?\s+this\s+season\??$/i },
  KXWNBAWINS:  { sport: 'basketball', league: 'WNBA',
                 teamFromTitle: /^Will\s+the\s+(?<team>.+?)\s+Women['’]s\s+Pro\s+Basketball\s+team\s+win\s+at\s+least\s+\d+\s+games?\s+this\s+season\??$/i },
  KXNBAWINS:   { sport: 'basketball', league: 'NBA',
                 teamFromTitle: /^Will\s+the\s+(?<team>.+?)\s+Pro\s+Basketball\s+team\s+(?:win\s+at\s+least\s+\d+\s+games?|record\s+at\s+least\s+\d+\s+wins?)\s+in\s+the\s+\d{4}-\d{2}\s+regular\s+season\??$/i },
  KXNCAAMBWINS: { sport: 'basketball (ncaa)', league: 'NCAAB',
                 teamFromTitle: /^Will\s+(?<team>.+?)\s+win\s+at\s+least\s+\d+\s+games?\s+this\s+season\??$/i },
};

export function classifySeasonWinsSeries(eventTicker: string | null): string | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split('-')[0];
  return prefix && SEASON_WINS_SERIES[prefix] ? prefix : null;
}

export function parseSeasonWinThreshold(floorStrike: string | null, yesSubTitle: string | null): number | null {
  if (floorStrike != null && floorStrike.trim() !== '') {
    const n = Number(floorStrike);
    if (!Number.isNaN(n)) return n;
  }
  const m = (yesSubTitle ?? '').match(/^(?<n>\d+)\s*\+?\s*wins?$/i);
  return m?.groups?.n ? parseInt(m.groups.n, 10) : null;
}

async function trySeasonWins(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = classifySeasonWinsSeries(row.event_ticker);
  if (!prefix) return null;
  if (row.strike_type !== 'greater_or_equal') return null;
  const spec = SEASON_WINS_SERIES[prefix];
  const tm = row.title.match(spec.teamFromTitle);
  const teamRaw = tm?.groups?.team?.trim();
  if (!teamRaw) return null;
  const threshold = parseSeasonWinThreshold(row.floor_strike, row.yes_sub_title);
  if (threshold == null) return null;

  const fromFloor = canonicalizeKalshiStrike('greater_or_equal', toNumber(row.floor_strike), null, 'wins');
  const canonThreshold = fromFloor != null
    ? fromFloor.value
    : canonicalizeIntegerThreshold({ direction: 'above', value: threshold, unit: 'wins', strictness: 'inclusive' }).value;

  const tuple = emitCondition({
    archetype: 'cumulative_count',
    arm: 'above',
    legacyMonotonicArm: true,
    tag: 'kalshi:season-wins',
    eventKind: 'player_prop_threshold',
    metric: 'count',
    direction: 'above',
    temporal: 'at_resolution',
    value: { primary: canonThreshold, unit: 'wins' },
  }, 'kalshi-det');
  if (!tuple) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;

  const canonical_subject = await resolveSubjectViaKB(teamRaw, 'sports', { sport: spec.sport, league: spec.league });
  const lh = await resolveLeague(spec.league);
  const leagueId = lh.id;
  const leagueCanonical = lh.canonical;
  const subjScope = scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, 'team');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'team',
      aliases: teamRaw !== canonical_subject ? [teamRaw] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  const canonicalEvent = `${canonical_subject} ${spec.league} season wins ${year}`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    ...tupleConditionParts(tuple),
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:season-wins');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:season-wins' };
}

const MLB_SPREAD_TITLE_RX = /^(?<team>.+?)\s+wins\s+by\s+over\s+(?<value>\d+(?:\.\d+)?)\s+runs\??$/i;

export function parseMlbSpread(title: string): { team: string; value: number } | null {
  const m = title.match(MLB_SPREAD_TITLE_RX);
  if (!m?.groups) return null;
  const team = m.groups.team.trim();
  const value = parseFloat(m.groups.value);
  if (!team || Number.isNaN(value)) return null;
  return { team, value };
}

async function tryMlbSpread(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== 'KXMLBSPREAD') return null;
  if (row.strike_type !== 'greater') return null;
  const parsed = parseMlbSpread(row.title);
  if (!parsed) return null;
  const fs = row.floor_strike != null && row.floor_strike.trim() !== '' ? Number(row.floor_strike) : NaN;
  const rawValue = !Number.isNaN(fs) ? fs : parsed.value;
  if (Number.isNaN(rawValue)) return null;
  const value = canonicalizeKalshiStrike('greater', rawValue, null, 'runs')?.value ?? rawValue;

  const tuple = emitCondition({
    archetype: 'fixture_margin',
    tag: 'kalshi:mlb-spread',
    eventKind: 'match_spread',
    metric: 'score',
    direction: 'above',
    temporal: 'at_resolution',
    value: { primary: value, unit: 'runs' },
  }, 'kalshi-det');
  if (!tuple) return null;

  const dateIso = row.occurrence_datetime ?? row.end_date ?? null;
  const canonical_subject = await resolveSubjectViaKB(parsed.team, 'sports', { sport: 'baseball', league: 'MLB' });
  const lh = await resolveLeague('MLB');
  const leagueId = lh.id;
  const leagueCanonical = lh.canonical;
  const subjScope = scopeToEntityMetadata({ sport: 'baseball', league: leagueCanonical }, 'team');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'team',
      aliases: parsed.team !== canonical_subject ? [parsed.team] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  const fx = extractSpreadFixture(row);
  let opponentCanonical: string | null = null;
  if (fx?.opponent) {
    opponentCanonical = await resolveSubjectViaKB(fx.opponent, 'sports', { sport: 'baseball', league: 'MLB' });
    if (opponentCanonical && opponentCanonical !== canonical_subject) {
      resolved_entities.push({
        canonical: opponentCanonical, type: 'team',
        aliases: fx.opponent !== opponentCanonical ? [fx.opponent] : [],
        metadata: metaOrUndef(subjScope),
      });
    }
  }
  const canonicalEvent = (opponentCanonical && opponentCanonical !== canonical_subject)
    ? deriveCanonicalEventCore({
        eventKind: 'match_spread',
        conditionShape: 'point_in_time',
        conditionMetric: 'score',
        valueUnit: 'runs',
        rawCanonicalEvent: row.event_title ?? row.title,
        canonicalSubject: canonical_subject,
        canonicalParticipants: [canonical_subject, opponentCanonical],
        categoryUnified: 'sports',
        eventDateIso: dateIso,
      })
    : `mlb spread ${(row.event_ticker ?? row.title).toLowerCase()}`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    ...tupleConditionParts(tuple),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'match_spread',
  }, 'kalshi:mlb-spread');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:mlb-spread' };
}

async function tryWinAMajorGrandSlam(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupMajorGrandSlamSeries(row.event_ticker);
  if (!series) return null;
  const parsed = parseWinAChampionship(row.title);
  if (!parsed) return null;
  const canonical_subject = await resolveSubjectViaKB(parsed.player, 'sports', { sport: series.spec.sport, league: null });
  const subjScope = scopeToEntityMetadata({ sport: series.spec.sport, league: null }, 'person');
  const canonical_event = majorGrandSlamCanonicalEvent(parsed.competitionNoun, parsed.year);
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person',
      aliases: parsed.player !== canonical_subject ? [parsed.player] : [],
      metadata: metaOrUndef(subjScope) },
    { canonical: canonical_event, type: 'event_name', aliases: gatedEventAlias(row.title).filter((a) => a !== canonical_event) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: 1,
    valueUnit: 'rank',
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'championship_winner',
  }, 'kalshi:win-a-major');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:win-a-major' };
}

async function tryMlbF5Spread(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== 'KXMLBF5SPREAD') return null;
  if (row.strike_type !== 'greater') return null;
  const fx = extractF5SpreadFixture(row);
  if (!fx) return null;
  const floorN = row.floor_strike != null && row.floor_strike.trim() !== '' ? Number(row.floor_strike) : NaN;
  const rawValue = !Number.isNaN(floorN) ? floorN : fx.value;
  if (Number.isNaN(rawValue)) return null;
  const value = canonicalizeKalshiStrike('greater', rawValue, null, 'runs')?.value ?? rawValue;
  const tuple = emitCondition({
    archetype: 'fixture_margin',
    tag: 'kalshi:mlb-f5-spread',
    eventKind: 'match_spread',
    metric: 'score',
    direction: 'above',
    temporal: 'at_resolution',
    value: { primary: value, unit: 'runs' },
  }, 'kalshi-det');
  if (!tuple) return null;
  const canonical_subject = await resolveSubjectViaKB(fx.team, 'sports', { sport: 'baseball', league: 'MLB' });
  const lh = await resolveLeague('MLB');
  const leagueId = lh.id;
  const leagueCanonical = lh.canonical;
  const subjScope = scopeToEntityMetadata({ sport: 'baseball', league: leagueCanonical }, 'team');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'team',
      aliases: fx.team !== canonical_subject ? [fx.team] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  let opponentCanonical: string | null = null;
  if (fx.opponent) {
    opponentCanonical = await resolveSubjectViaKB(fx.opponent, 'sports', { sport: 'baseball', league: 'MLB' });
    if (opponentCanonical && opponentCanonical !== canonical_subject) {
      resolved_entities.push({ canonical: opponentCanonical, type: 'team', aliases: fx.opponent !== opponentCanonical ? [fx.opponent] : [] });
    }
  }
  const fixtureKey = (row.event_ticker ?? row.title).toLowerCase();
  const canonicalEvent = `mlb spread first 5 ${fixtureKey}`;
  const participants = dedupeSorted(opponentCanonical ? [canonical_subject, opponentCanonical] : [canonical_subject]);
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    ...tupleConditionParts(tuple),
    metricScope: 'first_5',
    resolvedEntities: resolved_entities,
    participants,
    category: 'sports',
    leagueId,
    eventKind: 'match_spread',
  }, 'kalshi:mlb-f5-spread');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:mlb-f5-spread' };
}

async function tryGolfRoundFinishPosition(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const parsed = parseGolfRoundTopN(row.event_ticker, row.title);
  if (!parsed) return null;
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const canonicalEvent = golfRoundCanonicalEvent(year, parsed.tournament, parsed.round);
  const canonical_subject = await resolveSubjectViaKB(parsed.player, 'sports', { sport: 'golf', league: null });
  const subjScope = scopeToEntityMetadata({ sport: 'golf', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: parsed.player !== canonical_subject ? [parsed.player] : [], metadata: metaOrUndef(subjScope) },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title).filter((a) => a !== canonicalEvent) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: parsed.n,
    valueUnit: 'rank',
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:golf-round-finish-position');
  await registerEntities(row.market_id, canonical_subject, norm.resolved_entities, 'sports');
  return { norm, tag: 'kalshi:golf-round-finish-position' };
}

const GOLF_MAKECUT_TITLE_RX = /^(?<tournament>.+?):\s*Will\s+.+?\s+make\s+the\s+cut\??$/i;

async function tryGolfMakeCut(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== 'KXPGAMAKECUT') return null;
  const player = (row.yes_sub_title ?? '').trim();
  if (!player) return null;
  const tm = row.title.match(GOLF_MAKECUT_TITLE_RX);
  const tournament = tm?.groups?.tournament?.trim() ?? null;
  if (!tournament) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;

  const canonical_subject = await resolveSubjectViaKB(player, 'sports', { sport: 'golf', league: null });
  const subjScope = scopeToEntityMetadata({ sport: 'golf', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person',
      aliases: player !== canonical_subject ? [player] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  const canonicalEvent = `${year} ${tournament.toLowerCase()} make cut`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: 'make cut',
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:golf-make-cut');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:golf-make-cut' };
}

interface MusicAchievementSpec {
  label: string;
  titleRX: RegExp;
  eventKind: EventKind;
  resolutionSource: string | null;
}
export const MUSIC_ACHIEVEMENT_SERIES: Record<string, MusicAchievementSpec> = {
  KX1SONG:        { label: '#1 hit',       titleRX: /\bhave\s+a\s+#?\s*1\s+hit\b/i,        eventKind: 'other',         resolutionSource: 'Billboard' },
  KX10SONG:       { label: 'top 10 song',  titleRX: /\bhave\s+a\s+top\s+10\s+song\b/i,     eventKind: 'other',         resolutionSource: 'Billboard' },
  KX20SONG:       { label: 'top 20 song',  titleRX: /\bhave\s+a\s+top\s+20\s+song\b/i,     eventKind: 'other',         resolutionSource: 'Billboard' },
  KX1ALBUM:       { label: '#1 album',     titleRX: /\bhave\s+a\s+#?\s*1\s+album\b/i,      eventKind: 'other',         resolutionSource: 'Billboard' },
  KXALBUMRELEASE: { label: 'new album',    titleRX: /\brelease\s+a\s+new\s+album\b/i,      eventKind: 'media_release', resolutionSource: null },
  KXSONGRELEASE:  { label: 'new song',     titleRX: /\brelease\s+a\s+new\s+song\b/i,       eventKind: 'media_release', resolutionSource: null },
};

async function tryMusicArtistAchievement(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = row.event_ticker ? row.event_ticker.split('-')[0] : null;
  if (!prefix) return null;
  const spec = MUSIC_ACHIEVEMENT_SERIES[prefix];
  if (!spec) return null;
  const artist = (row.yes_sub_title ?? '').trim();
  if (!artist) return null;
  if (!spec.titleRX.test(row.title)) return null;
  if (isNonEntityLabel(artist)) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;

  const canonical_subject = await resolveSubjectViaKB(artist, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: artist !== canonical_subject ? [artist] : [] },
  ];
  const canonicalEvent = `${year} ${spec.label}`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: spec.label,
    outcomeLabel: artist,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    resolutionSource: spec.resolutionSource,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    eventKind: spec.eventKind,
  }, 'kalshi:music-achievement');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:music-achievement' };
}

export const GOLF_EAGLE_TITLE_RX = /^Will\s+(?<player>.+?)\s+have\s+an\s+eagle\s+in\s+Round\s+(?<round>\d+)\s*\??$/i;
async function tryGolfEagle(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = row.event_ticker ? row.event_ticker.split('-')[0] : null;
  if (prefix !== 'KXPGAEAGLE') return null;
  const tm = row.title.match(GOLF_EAGLE_TITLE_RX);
  if (!tm?.groups) return null;
  const round = parseInt(tm.groups.round, 10);
  if (!Number.isInteger(round)) return null;
  const player = (row.yes_sub_title ?? '').trim() || tm.groups.player.trim();
  if (!player || isNonEntityLabel(player)) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const tournament = (row.event_title ?? '').replace(/:\s*Eagle\s+in\s+Round.*$/i, '').trim().toLowerCase() || 'tournament';

  const canonical_subject = await resolveSubjectViaKB(player, 'sports', { sport: 'golf', league: null });
  const subjScope = scopeToEntityMetadata({ sport: 'golf', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person',
      aliases: player !== canonical_subject ? [player] : [],
      metadata: Object.keys(subjScope).length > 0 ? subjScope : undefined },
  ];
  const canonicalEvent = `${year} ${tournament} eagle round ${round}`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent,
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `eagle round ${round}`,
    outcomeLabel: player,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:golf-eagle');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:golf-eagle' };
}

interface PerformerParticipationSpec { role: string; }
export const PERFORMER_PARTICIPATION_SERIES: Record<string, PerformerParticipationSpec> = {
  KXWORLDCUPHALFTIME:     { role: 'perform' },
  KXROLEATEVENTCOACHELLA: { role: 'headline' },
  KXSNLHOST:              { role: 'host' },
  KXPERFORMVS:            { role: 'perform' },
  KXFEATURE:              { role: 'feature' },
};

async function tryPerformerParticipation(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = row.event_ticker ? row.event_ticker.split('-')[0] : null;
  if (!prefix) return null;
  const spec = PERFORMER_PARTICIPATION_SERIES[prefix];
  if (!spec) return null;
  const performer = (row.yes_sub_title ?? '').trim();
  if (!performer || isNonEntityLabel(performer)) return null;
  const evtRaw = (row.event_title ?? row.title ?? '').trim();
  if (!evtRaw) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const evtNorm = evtRaw.toLowerCase().replace(/^who\s+will\s+/i, '').replace(/[?？]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const canonicalEvent = `${year} ${evtNorm}`;

  const canonical_subject = await resolveSubjectViaKB(performer, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: performer !== canonical_subject ? [performer] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: spec.role,
    outcomeLabel: performer,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    eventKind: 'participation',
  }, 'kalshi:performer-participation');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:performer-participation' };
}

export const EUROVISION_RANK_TITLE_RX = /^Will\s+(?<country>.+?)\s+be\s+Top\s+(?<n>\d+)\s*\??$/i;
async function tryEurovisionRank(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = row.event_ticker ? row.event_ticker.split('-')[0] : null;
  if (prefix !== 'KXEUROVISIONRANK') return null;
  const tm = row.title.match(EUROVISION_RANK_TITLE_RX);
  if (!tm?.groups) return null;
  const n = parseInt(tm.groups.n, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  const country = (row.yes_sub_title ?? '').trim() || tm.groups.country.trim();
  if (!country || isNonEntityLabel(country)) return null;

  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;

  const canonical_subject = await resolveSubjectViaKB(country, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: country !== canonical_subject ? [country] : [] },
  ];
  const canonicalEvent = `${year} eurovision grand final rank ${canonical_subject}`;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: 'rank',
    temporal: 'at_resolution',
    valuePrimary: n,
    valueUnit: 'rank',
    conditionValue: `top ${n}`,
    outcomeLabel: `Top ${n}`,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    eventKind: 'other',
  }, 'kalshi:eurovision-rank');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:eurovision-rank' };
}

interface SportsParticipationSpec {
  sport: string;
  league: string | null;
  subjectType: 'person' | 'team';
  role: string;              // condition_value tag (compete / start / score_goal / all_team_selection)
  subjectFromTitle?: RegExp; // named group 'subject'; falls back to yes_sub_title when absent
}
const SPORTS_PARTICIPATION_SERIES: Record<string, SportsParticipationSpec> = {
  KXPGACOMPETE:    { sport: 'golf',       league: null,   subjectType: 'person', role: 'compete' },
  KXWCSTART:       { sport: 'soccer',     league: null,   subjectType: 'person', role: 'start', subjectFromTitle: /^Will\s+(?<subject>.+?)\s+start\s+for\b/i },
  KXWCPLAYERGOALS: { sport: 'soccer',     league: null,   subjectType: 'person', role: 'score_goal' },
  KXWNBAALLTEAM:   { sport: 'basketball', league: 'WNBA', subjectType: 'person', role: 'all_team_selection' },
  KXNBACUPQUAL:     { sport: 'basketball',            league: 'NBA',           subjectType: 'team',   role: 'qualify_cup_finals' },
  KXNBAPLAYIN:      { sport: 'basketball',            league: 'NBA',           subjectType: 'team',   role: 'qualify_playin' },
  KXNBAPLAYOFF:     { sport: 'basketball',            league: 'NBA',           subjectType: 'team',   role: 'qualify_playoff' },
  KXNCAAFQF:        { sport: 'american football (ncaa)', league: 'NCAA Football', subjectType: 'team', role: 'qualify_cfp_quarterfinals' },
  KXNCAAFSF:        { sport: 'american football (ncaa)', league: 'NCAA Football', subjectType: 'team', role: 'qualify_cfp_semifinals' },
  KXWNBAALLDEFENSE: { sport: 'basketball',            league: 'WNBA',          subjectType: 'person', role: 'all_defensive_selection' },
  KXWNBAALLSTARS:   { sport: 'basketball',            league: 'WNBA',          subjectType: 'person', role: 'all_star_selection' },
  KXMLBALLSTAR:     { sport: 'baseball',              league: null,            subjectType: 'person', role: 'all_star_selection' },
  KXMLBHRDERBYQUAL: { sport: 'baseball',              league: null,            subjectType: 'person', role: 'hr_derby_selection' },
  KXBBALLTEAMUSA:   { sport: 'basketball',            league: null,            subjectType: 'person', role: 'olympic_roster_selection' },
  KXNBAHALLOFFAME:  { sport: 'basketball',            league: null,            subjectType: 'person', role: 'hall_of_fame_finalist' },
  KXNFLHALLOFFAME:  { sport: 'american football',     league: null,            subjectType: 'person', role: 'hall_of_fame_inductee' },
};
async function trySportsParticipation(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, SPORTS_PARTICIPATION_SERIES);
  if (!spec) return null;
  let subjectRaw = (row.yes_sub_title ?? '').trim();
  if (spec.subjectFromTitle) {
    const m = row.title.match(spec.subjectFromTitle);
    const s = m?.groups?.subject?.trim();
    if (s) subjectRaw = s;
  }
  if (!subjectRaw || isNonEntityLabel(subjectRaw)) return null;
  const evtRaw = (row.event_title ?? '').trim();
  if (!evtRaw) return null;
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const evtNorm = evtRaw.toLowerCase().replace(/[?？]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const canonicalEvent = prefixYearOnce(year, evtNorm);

  const canonical_subject = await resolveSubjectViaKB(subjectRaw, 'sports', { sport: spec.sport, league: spec.league });
  let leagueId: number | null = null;
  let leagueCanonical: string | null = null;
  if (spec.league) {
    const l = await resolveLeague(spec.league);
    leagueId = l.id;
    leagueCanonical = l.canonical;
  }
  const subjScope = scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, spec.subjectType);
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: spec.subjectType, aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [], metadata: metaOrUndef(subjScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: spec.role,
    outcomeLabel: subjectRaw,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'participation',
  }, 'kalshi:sports-participation');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:sports-participation' };
}

interface TopNRankSpec {
  category: 'sports' | 'entertainment';
  subjectType: 'person' | 'team' | 'event_name';
  sport: string | null;
  league: string | null;
}
const TOPN_RANK_SERIES: Record<string, TopNRankSpec> = {
  KXNCAAFTOPAPRANK:    { category: 'sports',        subjectType: 'team',       sport: 'american football (ncaa)', league: 'NCAA Football' },
  KXNFLT100TOP:        { category: 'sports',        subjectType: 'person',     sport: 'american football',        league: 'NFL' },
  KXTITLEDTUESTOP:     { category: 'sports',        subjectType: 'person',     sport: null,                       league: null },
  KXLOVEISLANDUKRANK:  { category: 'entertainment', subjectType: 'event_name', sport: null,                       league: null },
  KXLOVEISLANDUSARANK: { category: 'entertainment', subjectType: 'event_name', sport: null,                       league: null },
};
async function tryTopNRank(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, TOPN_RANK_SERIES);
  if (!spec) return null;
  const subjectRaw = (row.yes_sub_title ?? '').trim();
  if (!subjectRaw || isNonEntityLabel(subjectRaw)) return null;

  const topM = row.title.match(/\btop\s+(?<n>\d+)\b/i);
  const placeM = row.title.match(/\bfinish\s+(?:(?<n>\d+)\s+place|(?<no>\d+)(?:st|nd|rd|th))\b/i);
  let n: number;
  let direction: 'below' | 'at';
  let outcomeLabel: string;
  let conditionValue: string;
  if (topM?.groups) {
    n = parseInt(topM.groups.n, 10);
    direction = 'below';
    outcomeLabel = `Top ${n}`;
    conditionValue = `top ${n}`;
  } else if (placeM?.groups) {
    n = parseInt(placeM.groups.n ?? placeM.groups.no, 10);
    direction = 'at';
    outcomeLabel = `Place ${n}`;
    conditionValue = `place ${n}`;
  } else {
    return null; // no rank token → defer (unshaped beats a guessed rank grain)
  }
  if (!Number.isInteger(n) || n <= 0) return null;

  const domainCat = spec.category === 'sports' ? 'sports' : 'entertainment';
  const scope = spec.sport ? { sport: spec.sport, league: spec.league } : undefined;
  const canonical_subject = await resolveSubjectViaKB(subjectRaw, domainCat, scope);
  let leagueId: number | null = null;
  let leagueCanonical: string | null = null;
  if (spec.league) {
    const l = await resolveLeague(spec.league);
    leagueId = l.id;
    leagueCanonical = l.canonical;
  }
  const subjScope = spec.sport ? scopeToEntityMetadata({ sport: spec.sport, league: leagueCanonical }, spec.subjectType) : {};
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: spec.subjectType, aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [], metadata: metaOrUndef(subjScope) },
  ];

  const evtRaw = (row.event_title ?? row.title ?? '').trim();
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const evtNorm = evtRaw.toLowerCase().replace(/[?？]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const canonicalEvent = `${year} ${evtNorm}`;

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    shape: 'monotonic_threshold',
    direction,
    metric: 'rank',
    temporal: 'at_resolution',
    valuePrimary: n,
    valueUnit: 'rank',
    conditionValue,
    outcomeLabel,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: spec.category,
    leagueId,
    eventKind: 'other',
  }, 'kalshi:topn-rank');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, domainCat);
  return { norm, tag: 'kalshi:topn-rank' };
}


async function tryAwardWinner(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupAwardSeries(row.event_ticker);
  if (!series) return null;
  const nominee = (row.yes_sub_title ?? '').trim();
  if (!nominee) return null;
  const parsed = parseAwardTitle(row.title);
  if (!parsed) return null;
  const canonical_event = awardCanonicalEvent(parsed.year, series.spec.awardNoun, parsed.category);
  const isTie = isAwardTieNominee(nominee);

  const canonical_subject = isTie
    ? `${canonical_event} tie`
    : await resolveSubjectViaKB(nominee, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [];
  if (!isTie) {
    resolved_entities.push({
      canonical: canonical_subject, type: 'event_name',
      aliases: nominee !== canonical_subject ? [nominee] : [],
    });
  }
  resolved_entities.push({
    canonical: canonical_event, type: 'event_name',
    aliases: gatedEventAlias(row.title).filter((a) => a !== canonical_event),
  });

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    ...singleWinnerRankFields('award_winner', isTie),
    conditionValue: 'winner=' + normalizeOutcomeLabel(nominee),
    outcomeLabel: normalizeOutcomeLabel(nominee),
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    leagueId: null,
    eventKind: 'award_winner',
  }, 'kalshi:award-winner');
  if (canonical_subject) await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:award-winner' };
}

async function tryGolfRoundLeader(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const parsed = parseGolfRoundLeader(row.event_ticker, row);
  if (!parsed) return null;
  const eventDate = extractEventDate({
    platform: 'kalshi', platform_id: row.platform_id, title: row.title,
    slug: null, end_date: row.end_date, mve_selected_legs: null,
  });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const canonical_event = golfRoundLeaderCanonicalEvent(year, parsed.tournament, parsed.round);
  const canonical_subject = await resolveSubjectViaKB(parsed.player, 'sports', { sport: 'golf', league: null });
  const subjScope = scopeToEntityMetadata({ sport: 'golf', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person',
      aliases: parsed.player !== canonical_subject ? [parsed.player] : [],
      metadata: metaOrUndef(subjScope) },
    { canonical: canonical_event, type: 'event_name',
      aliases: gatedEventAlias(row.title).filter((a) => a !== canonical_event) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    ...singleWinnerRankFields('championship_winner', false),
    conditionValue: 'winner=' + normalizeOutcomeLabel(parsed.player),
    outcomeLabel: normalizeOutcomeLabel(parsed.player),
    metricScope: null,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'championship_winner',
  }, 'kalshi:golf-round-leader');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:golf-round-leader' };
}

async function tryDraftTopN(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupDraftTopNSeries(row.event_ticker);
  if (!series) return null;
  const parsed = parseDraftTopN(row.event_ticker, row);
  if (!parsed) return null;
  const canonical_event = draftTopNCanonicalEvent(parsed.year, series.spec.league);
  const canonical_subject = await resolveSubjectViaKB(
    parsed.player, 'sports', { sport: series.spec.sport, league: series.spec.league });
  const subjScope = scopeToEntityMetadata({ sport: series.spec.sport, league: series.spec.league }, 'person');
  const lh = await resolveLeague(series.spec.league);
  const leagueId = lh.id;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person',
      aliases: parsed.player !== canonical_subject ? [parsed.player] : [],
      metadata: metaOrUndef(subjScope) },
    { canonical: canonical_event, type: 'event_name',
      aliases: gatedEventAlias(row.title).filter((a) => a !== canonical_event) },
  ];

  let condParts: Pick<KalshiNormParts,
    'shape' | 'direction' | 'metric' | 'temporal' | 'valuePrimary' | 'valueUnit' | 'conditionValue'>;
  if (parsed.kind === 'rank_threshold') {
    condParts = {
      shape: 'monotonic_threshold', direction: 'below', metric: null,
      temporal: 'at_resolution', valuePrimary: parsed.rankN, valueUnit: 'rank',
    };
  } else {
    condParts = {
      shape: 'binary_event', direction: 'at', metric: 'boolean',
      temporal: 'at_resolution', valuePrimary: null, valueUnit: null,
      conditionValue: 'drafted 1st round',
    };
  }

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    ...condParts,
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'player_prop_threshold',
  }, 'kalshi:draft-topn');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:draft-topn' };
}

async function tryStatewideVoteTurnout(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker || !ticker.startsWith('KXMIDTERMVOTETURN')) return null;
  if (!row.strike_type || !TYPED_STRIKE_SET.has(row.strike_type)) return null;
  const parsed = parseMidtermVoteTurnStatewide(row.title);
  if (!parsed) return null;

  const sd = deriveShapeAndDirection(row.strike_type);
  if (!sd) return null;
  const floor = toNumber(row.floor_strike);
  const cap = toNumber(row.cap_strike);
  const valuePrimary = sd.direction === 'above' ? floor : sd.direction === 'below' ? cap : floor;
  const valueSecondary = sd.direction === 'between' ? cap : null;
  if (valuePrimary == null) return null;

  const subjectRaw = midtermSubjectWithMetric(parsed.subjectRaw, false);
  const year = midtermCycleYear();
  const canonicalEvent = `${year} ${subjectRaw.toLowerCase()}`;
  const canonicalSubject = await resolveSubjectViaKB(subjectRaw, 'politics');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'event_name', aliases: [subjectRaw] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title) },
  ];

  let condParts: Pick<KalshiNormParts,
    'shape' | 'direction' | 'metric' | 'temporal' | 'valuePrimary' | 'valueSecondary' | 'valueUnit'>;
  if (sd.direction === 'above' || sd.direction === 'below') {
    const tuple = midtermConditionTuple(false, sd.direction, valuePrimary);
    if (!tuple) return null;
    condParts = tupleConditionParts(tuple);
  } else {
    condParts = {
      shape: sd.shape, direction: sd.direction, metric: null,
      temporal: 'at_resolution', valuePrimary, valueSecondary, valueUnit: 'votes',
    };
  }
  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent,
    ...condParts,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'election',
    leagueId: null,
    eventKind: 'election_turnout',
  }, 'kalshi:midterm-voteturn');
  await registerEntities(row.market_id, canonicalSubject, norm.resolved_entities, 'politics');
  return { norm, tag: norm.match_source! };
}

const PRIMARY_ADVANCE_PREFIXES: ReadonlyArray<string> = ['KXCAPRIMARY', 'KXWAPRIMARY'];
async function tryPrimaryAdvance(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker || !PRIMARY_ADVANCE_PREFIXES.some((p) => ticker.startsWith(p))) return null;
  if (!row.yes_sub_title) return null;
  const parsed = parsePrimaryAdvance(row.title);
  if (!parsed) return null;

  const candidate = row.yes_sub_title.trim();
  const partyRaw = (row.subtitle ?? '').replace(/^::\s*/, '').trim() || null;
  const canonicalEvent = primaryAdvanceCanonicalEvent(parsed.year, parsed.district, null);
  const canonicalSubject = await resolveSubjectViaKB(candidate, 'politics');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'person', aliases: candidate !== canonicalSubject ? [candidate] : [] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title).filter((a) => a !== canonicalEvent) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent,
    shape: 'monotonic_threshold',
    direction: 'below',
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: 2,
    valueUnit: 'rank',
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: partyRaw ? normalizeOutcomeLabel(partyRaw) : null,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'election',
    leagueId: null,
    eventKind: 'primary_winner',
  }, 'kalshi:primary-advance');
  await registerEntities(row.market_id, canonicalSubject, resolved_entities, 'politics');
  return { norm, tag: 'kalshi:primary-advance' };
}

async function tryCentralBankRateDecision(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const ticker = row.event_ticker;
  if (!ticker || !ticker.startsWith('KXFEDDECISION')) return null;
  const parsed = parseFedDecision(row.title);
  if (!parsed) return null;

  const canonicalEvent = fedDecisionCanonicalEvent(parsed.month, parsed.year);
  const magLabel = parsed.action === 'maintain'
    ? 'maintain'
    : `${parsed.action} ${parsed.isStrictGreater ? '>' : ''}${Math.abs(parsed.bps)}bps`;
  const canonicalSubject = `${canonicalEvent} (${magLabel})`;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonicalSubject, type: 'event_name', aliases: [] },
    { canonical: canonicalEvent, type: 'event_name', aliases: gatedEventAlias(row.title).filter((a) => a !== canonicalEvent) },
  ];
  const stamp = fedDecisionStamp(parsed);
  if (!stamp) return null; // pathological '>0bps' — unshaped beats unsound
  const tuple = emitCondition({
    archetype: 'categorical_selection',
    tag: 'kalshi:central-bank-rate',
    eventKind: 'policy_action',
    metric: 'count',
    direction: stamp.direction,
    temporal: 'at_resolution',
    value: { primary: stamp.bps, unit: 'bps' },
    outcomeLabel: magLabel,
  }, 'kalshi-det');
  if (!tuple) return null;
  const norm = assembleKalshiNorm(row, {
    subject: canonicalSubject,
    canonicalEvent: canonicalEvent.slice(0, 200),
    ...tupleConditionParts(tuple),
    conditionValue: magLabel,
    outcomeLabel: magLabel,
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonicalSubject]),
    category: 'economic',
    leagueId: null,
    eventKind: 'policy_action',
  }, 'kalshi:central-bank-rate');
  await registerEntities(row.market_id, canonicalSubject, resolved_entities, 'finance');
  return { norm, tag: 'kalshi:central-bank-rate' };
}

async function tryExactSetScore(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupExactSetScoreSeries(row.event_ticker);
  if (!series) return null;
  const parsed = parseExactSetScore(row, series.spec);
  if (!parsed) {
    log.warn(
      `kalshi:exact-set-score bail: market ${row.market_id} title '${row.title}' / yst '${row.yes_sub_title ?? ''}' failed parse or yst cross-check — leaving unshaped`,
    );
    return null;
  }
  const scope = { sport: series.spec.sport, league: null };
  const winnerCanon = await resolveSubjectViaKB(parsed.winner, 'sports', scope);
  const loserCanon = await resolveSubjectViaKB(parsed.loser, 'sports', scope);
  if (!winnerCanon || !loserCanon || winnerCanon === loserCanon) return null;

  const subjScope = scopeToEntityMetadata({ sport: series.spec.sport, league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: winnerCanon, type: 'person',
      aliases: parsed.winner !== winnerCanon ? [parsed.winner] : [],
      metadata: metaOrUndef(subjScope) },
    { canonical: loserCanon, type: 'person',
      aliases: parsed.loser !== loserCanon ? [parsed.loser] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  const pair = [winnerCanon, loserCanon]
    .sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const canonical_event = `${pair.join(' vs ')} set score`;
  const norm = assembleKalshiNorm(row, {
    subject: winnerCanon,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: parsed.setsWon,
    valueSecondary: parsed.setsLost,
    valueUnit: 'sets',
    outcomeLabel: normalizeOutcomeLabel(`${winnerCanon} wins ${parsed.setsWon}-${parsed.setsLost}`),
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([winnerCanon, loserCanon]),
    category: 'sports',
    leagueId: null,
    eventKind: 'exact_score',
  }, 'kalshi:exact-set-score');
  await registerEntities(row.market_id, winnerCanon, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:exact-set-score' };
}

async function tryUfcVictoryRound(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== UFC_VICTORY_ROUND_PREFIX) return null;
  const parsed = parseUfcVictoryRound(row);
  if (!parsed) {
    log.warn(
      `kalshi:ufc-vic-round bail: market ${row.market_id} title '${row.title}' / yst '${row.yes_sub_title ?? ''}' failed parse or yst cross-check — leaving unshaped`,
    );
    return null;
  }
  const scope = { sport: 'mma', league: null };
  const subjScope = scopeToEntityMetadata({ sport: 'mma', league: null }, 'person');
  const aCanon = await resolveSubjectViaKB(parsed.a, 'sports', scope);
  const bCanon = await resolveSubjectViaKB(parsed.b, 'sports', scope);
  if (!aCanon || !bCanon || aCanon === bCanon) return null;
  const pair = [aCanon, bCanon].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const canonical_event = `${pair.join(' vs ')} round of victory`;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: aCanon, type: 'person',
      aliases: parsed.a !== aCanon ? [parsed.a] : [],
      metadata: metaOrUndef(subjScope) },
    { canonical: bCanon, type: 'person',
      aliases: parsed.b !== bCanon ? [parsed.b] : [],
      metadata: metaOrUndef(subjScope) },
  ];
  let canonical_subject: string;
  let outcome_label: string;
  let conditionValueOverride: string | undefined;
  let condition_metric: ConditionMetric;
  let value_primary: number | null;
  let value_unit: string | null;
  let registerAs: string;
  if (parsed.kind === 'round') {
    const fw = parsed.winner.toLowerCase().replace(/\s+/g, '');
    canonical_subject =
      fw === parsed.a.toLowerCase().replace(/\s+/g, '') ? aCanon : bCanon;
    outcome_label =
      normalizeOutcomeLabel(`${canonical_subject} to win in round ${parsed.round}`) ??
      `${canonical_subject.toLowerCase()} to win in round ${parsed.round}`;
    condition_metric = 'count';
    value_primary = parsed.round;
    value_unit = 'rounds';
    registerAs = canonical_subject;
  } else {
    canonical_subject = `${canonical_event} decision or draw`;
    outcome_label = 'decision / draw / no contest';
    conditionValueOverride = `winner=${outcome_label}`;
    condition_metric = 'boolean';
    value_primary = null;
    value_unit = null;
    registerAs = aCanon;
  }
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: 'at',
    metric: condition_metric,
    temporal: 'at_resolution',
    valuePrimary: value_primary,
    valueUnit: value_unit,
    ...(conditionValueOverride !== undefined ? { conditionValue: conditionValueOverride } : {}),
    outcomeLabel: outcome_label,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([aCanon, bCanon]),
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:ufc-vic-round');
  await registerEntities(row.market_id, registerAs, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:ufc-vic-round' };
}


async function tryUfcMethodOfVictory(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  if (kalshiSeriesPrefix(row) !== UFC_METHOD_OF_VICTORY_PREFIX) return null;
  const parsed = parseUfcMethodOfVictory(row);
  if (!parsed) {
    log.warn(`kalshi:ufc-mov bail: market ${row.market_id} title '${row.title}' / cs '${row.custom_strike ?? ''}' failed parse — leaving unshaped`);
    return null;
  }
  const scope = { sport: 'mma', league: null };
  const subjScope = scopeToEntityMetadata({ sport: 'mma', league: null }, 'person');
  const aCanon = await resolveSubjectViaKB(parsed.a, 'sports', scope);
  const bCanon = await resolveSubjectViaKB(parsed.b, 'sports', scope);
  if (!aCanon || !bCanon || aCanon === bCanon) return null;
  const pair = [aCanon, bCanon].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const canonical_event = `${pair.join(' vs ')} method of victory`;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: aCanon, type: 'person', aliases: parsed.a !== aCanon ? [parsed.a] : [], metadata: metaOrUndef(subjScope) },
    { canonical: bCanon, type: 'person', aliases: parsed.b !== bCanon ? [parsed.b] : [], metadata: metaOrUndef(subjScope) },
  ];

  let canonical_subject: string;
  let outcome_label: string;
  let conditionValue: string;
  let value_primary: number | null;
  let registerAs: string;
  if (parsed.kind === 'method') {
    canonical_subject = parsed.winner === parsed.a ? aCanon : bCanon;
    outcome_label = normalizeOutcomeLabel(`${canonical_subject} by ${parsed.method}`) ?? `${canonical_subject} by ${parsed.method}`;
    value_primary = parsed.methodOrdinal;
    conditionValue = `method=${parsed.method.toLowerCase()}`;
    registerAs = canonical_subject;
  } else {
    canonical_subject = `${canonical_event} draw or no contest`;
    outcome_label = 'draw / no contest';
    value_primary = null;
    conditionValue = 'method=draw / no contest';
    registerAs = aCanon;
  }

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: 'at',
    metric: 'boolean',
    temporal: 'at_resolution',
    valuePrimary: value_primary,
    valueUnit: null,
    conditionValue,
    outcomeLabel: outcome_label,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([aCanon, bCanon]),
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:ufc-method-of-victory');
  await registerEntities(row.market_id, registerAs, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:ufc-method-of-victory' };
}

async function tryWorldSeriesMatchup(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  if (kalshiSeriesPrefix(row) !== WORLD_SERIES_MATCHUP_PREFIX) return null;
  const parsed = parseWorldSeriesMatchup(row);
  if (!parsed) return null;
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const evtNorm = (row.event_title ?? 'championship series matchup').toLowerCase().replace(/\s+/g, ' ').replace(/[?？]+\s*$/, '').trim();
  const canonical_event = `${year} ${evtNorm}`;
  const canonical_subject = parsed.pair;
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `matchup=${normalizeOutcomeLabel(parsed.pair)}`,
    outcomeLabel: parsed.pair,
    resolvedEntities: [],
    participants: [canonical_subject],
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:ws-matchup-pair');
  return { norm, tag: 'kalshi:ws-matchup-pair' };
}

async function trySoccerCorrectScore(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupSoccerCorrectScoreSeries(row.event_ticker);
  if (!series) return null;
  const parsed = parseSoccerCorrectScore(row);
  if (!parsed) {
    log.warn(`kalshi:soccer-correct-score bail: market ${row.market_id} title '${row.title}' / yst '${row.yes_sub_title ?? ''}' failed parse or score cross-check — leaving unshaped`);
    return null;
  }
  const scope = { sport: 'soccer', league: null };
  const subjScope = scopeToEntityMetadata({ sport: 'soccer', league: null }, 'team');
  const homeCanon = await resolveSubjectViaKB(parsed.home, 'sports', scope);
  const awayCanon = await resolveSubjectViaKB(parsed.away, 'sports', scope);
  if (!homeCanon || !awayCanon || homeCanon === awayCanon) return null;
  const pair = [homeCanon, awayCanon].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const canonical_event = pair.join(' vs ') + series.spec.canonicalSuffix;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: homeCanon, type: 'team', aliases: parsed.home !== homeCanon ? [parsed.home] : [], metadata: metaOrUndef(subjScope) },
    { canonical: awayCanon, type: 'team', aliases: parsed.away !== awayCanon ? [parsed.away] : [], metadata: metaOrUndef(subjScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: homeCanon,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: parsed.homeGoals,
    valueSecondary: parsed.awayGoals,
    valueUnit: 'goals',
    outcomeLabel: `${parsed.homeGoals}-${parsed.awayGoals}`,
    resolvedEntities: resolved_entities,
    metricScope: series.spec.scope,
    participants: dedupeSorted([homeCanon, awayCanon]),
    category: 'sports',
    leagueId: null,
    eventKind: 'exact_score',
  }, 'kalshi:soccer-correct-score');
  await registerEntities(row.market_id, homeCanon, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:soccer-correct-score' };
}

async function trySetWinner(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const series = lookupSetWinnerSeries(row.event_ticker);
  if (!series) return null;
  const parsed = parseSetWinner(row.event_ticker, row);
  if (!parsed) {
    log.warn(`kalshi:set-winner bail: market ${row.market_id} title '${row.title}' failed parse — leaving unshaped`);
    return null;
  }
  const scope = { sport: series.spec.sport, league: null };
  const subjScope = scopeToEntityMetadata({ sport: series.spec.sport, league: null }, 'person');
  const aCanon = await resolveSubjectViaKB(parsed.a, 'sports', scope);
  const bCanon = await resolveSubjectViaKB(parsed.b, 'sports', scope);
  if (!aCanon || !bCanon || aCanon === bCanon) return null;
  const winnerCanon = parsed.player.toLowerCase().replace(/\s+/g, '') === parsed.a.toLowerCase().replace(/\s+/g, '') ? aCanon : bCanon;
  const pair = [aCanon, bCanon].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const canonical_event = `${pair.join(' vs ')} set ${parsed.setOrdinal}`;
  const resolved_entities: ResolvedEntity[] = [
    { canonical: aCanon, type: 'person', aliases: parsed.a !== aCanon ? [parsed.a] : [], metadata: metaOrUndef(subjScope) },
    { canonical: bCanon, type: 'person', aliases: parsed.b !== bCanon ? [parsed.b] : [], metadata: metaOrUndef(subjScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: winnerCanon,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `winner=${normalizeOutcomeLabel(winnerCanon)}`,
    outcomeLabel: normalizeOutcomeLabel(winnerCanon),
    metricScope: 'set',
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([aCanon, bCanon]),
    category: 'sports',
    leagueId: null,
    eventKind: 'match_winner',
  }, 'kalshi:set-winner');
  await registerEntities(row.market_id, winnerCanon, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:set-winner' };
}

async function try3BallMatchup(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  if (kalshiSeriesPrefix(row) !== PGA_3BALL_PREFIX) return null;
  const parsed = parse3BallMatchup(row);
  if (!parsed) return null;
  const evtRaw = (row.event_title ?? '').trim();
  if (!evtRaw) return null;
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const evtNorm = evtRaw.toLowerCase().replace(/\s+/g, ' ').replace(/[?？]+\s*$/, '').trim();
  const canonical_event = `${year} ${evtNorm}`;
  const canonical_subject = await resolveSubjectViaKB(parsed.player, 'sports', { sport: 'golf', league: null });
  if (!canonical_subject) return null;
  const subjScope = scopeToEntityMetadata({ sport: 'golf', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: parsed.player !== canonical_subject ? [parsed.player] : [], metadata: metaOrUndef(subjScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `winner=${normalizeOutcomeLabel(parsed.player)}`,
    outcomeLabel: normalizeOutcomeLabel(parsed.player),
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:golf-3ball');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:golf-3ball' };
}

async function tryFirstHurricane(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  if (kalshiSeriesPrefix(row) !== FIRST_HURRICANE_PREFIX) return null;
  const parsed = parseFirstHurricane(row.event_ticker, row);
  if (!parsed) return null;
  const canonical_event = firstHurricaneCanonicalEvent(parsed.year, parsed.basin);
  const norm = assembleKalshiNorm(row, {
    subject: parsed.storm, // literal name — no KB resolve, no registration
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: null,
    metric: null,
    temporal: 'at_resolution',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `storm=${normalizeOutcomeLabel(parsed.storm)}`,
    date: { iso: `${parsed.year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: parsed.storm,
    resolvedEntities: [],
    participants: [parsed.storm],
    category: 'weather',
    leagueId: null,
    eventKind: 'weather_extreme',
  }, 'kalshi:first-hurricane');
  return { norm, tag: 'kalshi:first-hurricane' };
}

async function tryEmmyCount(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  if (kalshiSeriesPrefix(row) !== EMMY_COUNT_PREFIX) return null;
  const parsed = parseEmmyCount(row);
  if (!parsed) return null;
  const eventDate = extractEventDate({ platform: 'kalshi', platform_id: row.platform_id, title: row.title, slug: null, end_date: row.end_date, mve_selected_legs: null });
  const year = yearFromIso(eventDate?.iso) ?? yearFromIso(row.end_date) ?? 2026;
  const canonical_event = `${year} emmy awards ${parsed.show.toLowerCase()}`;
  const canonical_subject = await resolveSubjectViaKB(parsed.show, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: parsed.show !== canonical_subject ? [parsed.show] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event.slice(0, 200),
    shape: 'categorical_outcome',
    direction: 'at',
    metric: 'count',
    temporal: 'at_resolution',
    valuePrimary: parsed.count,
    valueUnit: 'awards',
    conditionValue: `count=${parsed.count}`,
    date: { iso: `${year}-01-01`, precision: 'year', source: 'event-year' },
    outcomeLabel: `exactly ${parsed.count}`,
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    leagueId: null,
    eventKind: 'other',
  }, 'kalshi:emmy-count');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:emmy-count' };
}

const WC_STAGE_VOCAB: readonly string[] = [
  'Group Stage', 'Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Runner-Up', 'Outright Winner',
];

export function wcStageOrdinal(stage: string): number | null {
  const i = WC_STAGE_VOCAB.indexOf(stage);
  return i >= 0 ? i + 1 : null;
}
const WC_STAGEOFELIM_TITLE_RX =
  /^Will (?<team>.+?) (?:get eliminated in|win) the .+? (?:of|in) the 2026 Men's FIFA World Cup\?$/;
const WC_2026_PERIOD_DATE = '2026-06-01';

async function tryWorldCupElimSquad(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (prefix !== 'KXWCSTAGEOFELIM' && prefix !== 'KXWCSQUAD') return null;

  if (prefix === 'KXWCSTAGEOFELIM') {
    const m = row.title.match(WC_STAGEOFELIM_TITLE_RX);
    const team = m?.groups?.team?.trim();
    const stage = (row.yes_sub_title ?? '').trim();
    const stageOrdinal = wcStageOrdinal(stage);
    if (!team || !stage || stageOrdinal === null) return null;
    const canonical_subject = await resolveSubjectViaKB(team, 'sports', { sport: 'soccer', league: null });
    const teamScope = scopeToEntityMetadata({ sport: 'soccer', league: null }, 'team');
    const resolved_entities: ResolvedEntity[] = [
      { canonical: canonical_subject, type: 'team', aliases: team !== canonical_subject ? [team] : [], metadata: Object.keys(teamScope).length > 0 ? teamScope : undefined },
    ];
    const norm = assembleKalshiNorm(row, {
      subject: canonical_subject,
      canonicalEvent: row.event_title ?? row.title,
      shape: 'categorical_outcome',
      direction: 'at',
      metric: 'boolean',
      temporal: 'at_resolution',
      valuePrimary: stageOrdinal,
      valueUnit: null,
      conditionValue: `stage:${stage}`, // distinguishes the 7 sibling mutex slots
      date: { iso: WC_2026_PERIOD_DATE, precision: 'month', source: 'wc-2026-period' },
      outcomeLabel: stage,
      resolvedEntities: resolved_entities,
      participants: dedupeSorted([canonical_subject]),
      category: 'sports',
      eventKind: 'stage_advance',
    }, 'kalshi:wc-stage-of-elim');
    await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
    return { norm, tag: 'kalshi:wc-stage-of-elim' };
  }

  const player = (row.yes_sub_title ?? '').trim();
  if (!player) return null;
  const country = (row.rules_primary ?? '').match(/final squad for the (.+?) national team/)?.[1]?.trim()
    ?? row.title.match(/be in the (.+?) (?:World Cup |FIFA )/i)?.[1]?.trim()
    ?? null;
  const canonical_subject = await resolveSubjectViaKB(player, 'sports', { sport: 'soccer', league: null });
  const playerScope = scopeToEntityMetadata({ sport: 'soccer', league: null }, 'person');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'person', aliases: player !== canonical_subject ? [player] : [], metadata: metaOrUndef(playerScope) },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ?? row.title,
    shape: 'binary_event',
    direction: 'at',
    metric: 'boolean',
    temporal: 'during_period',
    valuePrimary: null,
    valueUnit: null,
    conditionValue: `squad:${country ?? ''}`,
    date: { iso: WC_2026_PERIOD_DATE, precision: 'month', source: 'wc-2026-period' },
    outcomeLabel: 'in squad',
    resolvedEntities: resolved_entities,
    participants: dedupeSorted([canonical_subject]),
    category: 'sports',
    eventKind: 'other',
  }, 'kalshi:wc-squad');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:wc-squad' };
}

export const PERIOD_WINNER_SERIES: Record<string, MetricScope> = {
  KXEPL1H:        'half_1',
  KXLALIGA1H:     'half_1',
  KXLIGUE11H:     'half_1',
  KXSERIEA1H:     'half_1',
  KXBUNDESLIGA1H: 'half_1',
  KXATPSETWINNER: 'set',
  KXWTASETWINNER: 'set',
  KXATPMATCH:     'game',
  KXWTAMATCH:     'game',
};

export function periodWinnerMetricScope(eventTicker: string | null): MetricScope | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split('-')[0];
  if (!prefix) return null;
  return PERIOD_WINNER_SERIES[prefix] ?? null;
}


const SERIES_FIXTURE_RX =
  /\bin the (?<a>[A-Z][\w.'&\-]*(?:\s+[\w.'&\-]+){0,4}?)\s+vs\.?\s+(?<b>[A-Z][\w.'&\-]*(?:\s+[\w.'&\-]+){0,4}?)\s+(?:\d+(?:st|nd|rd|th)\s+round\s+)?series\b/i;
const SERIES_SCORE_RX =
  /^Will\s+(?<team>[A-Z][\w.'&\-]*(?:\s+[\w.'&\-]+){0,4}?)\s+win\s+(?<sa>\d)-(?<sb>\d)\b/i;
const SERIES_SPREAD_RX =
  /^Will\s+(?<team>[A-Z][\w.'&\-]*(?:\s+[\w.'&\-]+){0,4}?)\s+cover\s+(?<sign>[+\-])(?<value>\d+(?:\.\d+)?)\s+games\b/i;

type SeriesKind = 'score' | 'games' | 'spread';

export function classifyNbaNhlSeries(eventTicker: string | null): SeriesKind | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split('-')[0] ?? '';
  if (!/^KX(?:NBA|NHL)SERIES(?:SCORE|GAMES|SPREAD)$/.test(prefix)) return null;
  if (prefix.endsWith('SCORE')) return 'score';
  if (prefix.endsWith('GAMES')) return 'games';
  return 'spread';
}

export function extractSeriesFixture(title: string): { a: string; b: string } | null {
  const m = title.match(SERIES_FIXTURE_RX);
  if (!m?.groups) return null;
  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;
  return { a, b };
}

async function tryNbaNhlSeries(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const kind = classifyNbaNhlSeries(row.event_ticker);
  if (!kind) return null;
  const fixture = extractSeriesFixture(row.title);
  if (!fixture) return null; // unparseable fixture -> defer (never a fake hub)

  const sport = row.event_ticker!.startsWith('KXNBA') ? 'basketball' : 'ice hockey';
  const aCanon = await resolveSubjectViaKB(fixture.a, 'sports', { sport, league: null });
  const bCanon = await resolveSubjectViaKB(fixture.b, 'sports', { sport, league: null });
  if (aCanon === bCanon) return null;
  const pair = [aCanon, bCanon].sort((x, y) => x.localeCompare(y));
  const fixtureEvent = `${pair[0]} vs ${pair[1]} series`;
  const subjScope = scopeToEntityMetadata({ sport, league: null }, 'team');
  const teamEntities: ResolvedEntity[] = [aCanon, bCanon].map((c, i) => ({
    canonical: c,
    type: 'team',
    aliases: (i === 0 ? fixture.a : fixture.b) !== c ? [i === 0 ? fixture.a : fixture.b] : [],
    metadata: metaOrUndef(subjScope),
  }));
  const leagueId = await resolveKalshiCompetitionToLeagueId(row.kalshi_competition);

  const sharedParts = {
    canonicalEvent: fixtureEvent,
    category: 'sports' as UnifiedCategory,
    leagueId,
    metricScope: 'series' as MetricScope,
  };

  if (kind === 'games') {
    if (row.strike_type !== 'greater') return null;
    const value_primary = toNumber(row.floor_strike);
    if (value_primary == null) return null;
    const norm = assembleKalshiNorm(row, {
      ...sharedParts,
      subject: fixtureEvent,
      shape: 'monotonic_threshold',
      direction: 'above',
      metric: 'count',
      temporal: 'during_period',
      valuePrimary: value_primary,
      valueUnit: 'games',
      resolvedEntities: teamEntities,
      participants: dedupeSorted([aCanon, bCanon]),
      eventKind: 'match_total_metric',
    }, 'kalshi:nba-nhl-series');
    await registerEntities(row.market_id, fixtureEvent, teamEntities, 'sports');
    return { norm, tag: 'kalshi:nba-nhl-series' };
  }

  if (kind === 'score') {
    const m = row.title.match(SERIES_SCORE_RX);
    if (!m?.groups) return null;
    const sa = parseInt(m.groups.sa, 10);
    const sb = parseInt(m.groups.sb, 10);
    const winnerRaw = m.groups.team.trim();
    const winnerCanon = await resolveSubjectViaKB(winnerRaw, 'sports', { sport, league: null });
    const winnerEntities: ResolvedEntity[] =
      winnerCanon === aCanon || winnerCanon === bCanon
        ? teamEntities
        : [...teamEntities, { canonical: winnerCanon, type: 'team', aliases: winnerRaw !== winnerCanon ? [winnerRaw] : [], metadata: metaOrUndef(subjScope) }];
    const norm = assembleKalshiNorm(row, {
      ...sharedParts,
      subject: winnerCanon,
      shape: 'categorical_outcome',
      direction: null,
      metric: null,
      temporal: 'at_resolution',
      valuePrimary: sa,
      valueSecondary: sb,
      valueUnit: 'games',
      conditionValue: `${sa}-${sb}`,
      outcomeLabel: `${sa}-${sb}`,
      resolvedEntities: winnerEntities,
      participants: dedupeSorted([aCanon, bCanon]),
      eventKind: 'exact_score',
    }, 'kalshi:nba-nhl-series');
    await registerEntities(row.market_id, winnerCanon, winnerEntities, 'sports');
    return { norm, tag: 'kalshi:nba-nhl-series' };
  }

  const m = row.title.match(SERIES_SPREAD_RX);
  if (!m?.groups) return null;
  const value = parseFloat(m.groups.value);
  if (!Number.isFinite(value)) return null;
  const direction: ConditionDirection = m.groups.sign === '-' ? 'above' : 'below';
  const tuple = emitCondition({
    archetype: 'fixture_margin',
    tag: 'kalshi:nba-nhl-series',
    eventKind: 'match_spread',
    metric: 'score',
    direction,
    temporal: 'at_resolution',
    value: { primary: value, unit: 'games' },
  }, 'kalshi-det');
  if (!tuple) return null;
  const teamRaw = m.groups.team.trim();
  const teamCanon = await resolveSubjectViaKB(teamRaw, 'sports', { sport, league: null });
  const spreadEntities: ResolvedEntity[] =
    teamCanon === aCanon || teamCanon === bCanon
      ? teamEntities
      : [...teamEntities, { canonical: teamCanon, type: 'team', aliases: teamRaw !== teamCanon ? [teamRaw] : [], metadata: metaOrUndef(subjScope) }];
  const norm = assembleKalshiNorm(row, {
    ...sharedParts,
    subject: teamCanon,
    ...tupleConditionParts(tuple),
    resolvedEntities: spreadEntities,
    participants: dedupeSorted([aCanon, bCanon]),
    eventKind: 'match_spread',
  }, 'kalshi:nba-nhl-series');
  await registerEntities(row.market_id, teamCanon, spreadEntities, 'sports');
  return { norm, tag: 'kalshi:nba-nhl-series' };
}

const ESPORTS_MAP_SERIES: ReadonlySet<string> = new Set(['KXLOLMAP', 'KXCS2MAP', 'KXDOTA2MAP', 'KXVALORANTMAP', 'KXCODMAP', 'KXR6MAP']);
const ESPORTS_GAME_SERIES: ReadonlySet<string> = new Set(['KXLOLGAME', 'KXCS2GAME', 'KXDOTA2GAME', 'KXVALORANTGAME', 'KXR6GAME']);
const ESPORTS_CHAMP_SERIES: ReadonlySet<string> = new Set(['KXCS2', 'KXR6', 'KXOVERWATCH', 'KXROCKETLEAGUE']);
const ESPORTS_MAP_RX = /^Will\s+(.+?)\s+win\s+map\s+(\d+)\s+in\s+the\s+(.+?)\s+vs\.?\s+(.+?)\s+match\?$/i;
const ESPORTS_GAME_RX = new RegExp(
  '^Will\\s+(.+?)\\s+win\\s+the\\s+(.+?)\\s+vs\\.?\\s+(.+?)\\s+(?:League of Legends|Valorant|Dota 2|Call of Duty|R6|CS2|Counter-Strike|Overwatch|Rocket League)\\s+match\\?$',
  'i',
);
const ESPORTS_CHAMP_RX = /^Will\s+(.+?)\s+win\s+(.+?)\?$/i;

async function tryEsportsWinner(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const prefix = kalshiSeriesPrefix(row);
  if (!prefix) return null;
  const winner = (row.yes_sub_title ?? '').trim();
  if (!winner) return null;

  if (ESPORTS_CHAMP_SERIES.has(prefix)) {
    const m = row.title.match(ESPORTS_CHAMP_RX);
    const tournament = m?.[2]?.trim();
    if (!tournament) return null;
    const canonical_subject = await resolveSubjectViaKB(tournament, 'sports');
    const winnerCanonical = await resolveSubjectViaKB(winner, 'sports');
    const resolved_entities: ResolvedEntity[] = [
      { canonical: canonical_subject, type: 'event_name', aliases: tournament !== canonical_subject ? [tournament] : [] },
      { canonical: winnerCanonical, type: 'team', aliases: winner !== winnerCanonical ? [winner] : [] },
    ];
    const norm = assembleKalshiNorm(row, {
      subject: winnerCanonical,
      canonicalEvent: tournament,
      shape: 'binary_event',
      direction: null,
      metric: null,
      temporal: 'on_date',
      valuePrimary: null,
      valueUnit: null,
      conditionValue: `team=${normalizeOutcomeLabel(winner)}`,
      outcomeLabel: normalizeOutcomeLabel(winner),
      resolvedEntities: resolved_entities,
      metricScope: null,
      participants: dedupeSorted([winnerCanonical]),
      category: 'sports',
      eventKind: 'championship_winner',
    }, 'kalshi:esports-winner');
    await registerEntities(row.market_id, winnerCanonical, resolved_entities, 'sports');
    return { norm, tag: 'kalshi:esports-winner' };
  }

  let teamA: string;
  let teamB: string;
  let mapN: string | null = null;
  if (ESPORTS_MAP_SERIES.has(prefix)) {
    const m = row.title.match(ESPORTS_MAP_RX);
    if (!m) return null;
    mapN = m[2];
    teamA = m[3].trim();
    teamB = m[4].trim();
  } else if (ESPORTS_GAME_SERIES.has(prefix)) {
    const m = row.title.match(ESPORTS_GAME_RX);
    if (!m) return null;
    teamA = m[2].trim();
    teamB = m[3].trim();
  } else {
    return null;
  }
  const pair = [teamA, teamB].sort((a, b) => a.localeCompare(b));
  const fixtureEvent = pair.join(' vs '); // bare 'A vs B' — NO ' Map N'
  const teamACanon = await resolveSubjectViaKB(pair[0], 'sports');
  const teamBCanon = await resolveSubjectViaKB(pair[1], 'sports');
  if (teamACanon === teamBCanon) return null;
  const winnerCanonical =
    winner === pair[0] ? teamACanon : winner === pair[1] ? teamBCanon : await resolveSubjectViaKB(winner, 'sports');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: teamACanon, type: 'team', aliases: pair[0] !== teamACanon ? [pair[0]] : [] },
    { canonical: teamBCanon, type: 'team', aliases: pair[1] !== teamBCanon ? [pair[1]] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: winnerCanonical,
    canonicalEvent: fixtureEvent,
    shape: 'binary_event',
    direction: null,
    metric: null,
    temporal: 'on_date',
    valuePrimary: mapN ? Number(mapN) : null,
    valueUnit: null,
    conditionValue: `winner=${normalizeOutcomeLabel(winner)}`, // distinguishes the 2 siblings
    outcomeLabel: winner,
    resolvedEntities: resolved_entities,
    metricScope: mapN ? 'map' : 'game',
    participants: dedupeSorted([teamACanon, teamBCanon]),
    category: 'sports',
    eventKind: 'match_winner',
  }, 'kalshi:esports-winner');
  await registerEntities(row.market_id, winnerCanonical, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:esports-winner' };
}

interface MusicChartSpec {
  subjectFrom: 'rules' | 'yes_sub';
  fixedPosition: number | null; // null = Group A, read position from yes_sub_title (#1..#10)
  dateKind: 'weekly' | 'annual' | 'monthly';
  resolutionSource: string;
}

const MUSIC_CHART_SERIES: Record<string, MusicChartSpec> = {
  KXBBCHARTPOSITIONSONG:    { subjectFrom: 'rules',   fixedPosition: null, dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXBBCHARTPOSITIONALBUM:   { subjectFrom: 'rules',   fixedPosition: null, dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXTOPSONG:                { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXTOPALBUM:               { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXBILLBOARDRUNNERUPSONG:  { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXBILLBOARDRUNNERUPALBUM: { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'weekly',  resolutionSource: 'Billboard' },
  KXTOPSONGSPOTIFYUSA:      { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPSONGSPOTIFY:         { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMSPOTIFYUSA:     { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMSPOTIFY:        { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPARTISTUSA:           { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPSONGRUNNERUPUSA:     { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPSONGSPOTIFYRUNNERUP: { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMSPOTIFYRUNNERUP:{ subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMRUNNERUPUSA:    { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPARTISTRUNNERUP:      { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPARTISTRUNNERUPUSA:   { subjectFrom: 'yes_sub', fixedPosition: 2,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPSONGTHIRD:           { subjectFrom: 'yes_sub', fixedPosition: 3,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPSONGTHIRDUSA:        { subjectFrom: 'yes_sub', fixedPosition: 3,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMTHIRDUSA:       { subjectFrom: 'yes_sub', fixedPosition: 3,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPALBUMTHIRD:          { subjectFrom: 'yes_sub', fixedPosition: 3,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXTOPARTISTTHIRD:         { subjectFrom: 'yes_sub', fixedPosition: 3,    dateKind: 'annual',  resolutionSource: 'Spotify' },
  KXRANKLISTSONGSPOTUSA:    { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'monthly', resolutionSource: 'Spotify' },
  KXRANKLISTSONGSPOTGLOBAL: { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'monthly', resolutionSource: 'Spotify' },
  KXRANKLIST1SONG:          { subjectFrom: 'yes_sub', fixedPosition: 1,    dateKind: 'monthly', resolutionSource: 'Billboard' },
};

const MUSIC_MONTH_NUM: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function extractMusicChartSubject(row: Pick<KalshiCandidateRow, 'rules_primary' | 'title' | 'yes_sub_title'>, subjectFrom: 'rules' | 'yes_sub'): string | null {
  if (subjectFrom === 'yes_sub') return (row.yes_sub_title ?? '').trim() || null;
  const m = (row.rules_primary ?? '').match(/^If (.+?) by .+? is ranked #\d+ on the Billboard (?:Hot 100|200)/);
  if (m?.[1]) return m[1].trim();
  const t = (row.title ?? '').match(/^Will (.+?) be (?:#\d+ )?on the Billboard (?:Hot 100|200)/);
  return t?.[1]?.trim() ?? null;
}

function buildMusicChartDate(
  row: Pick<KalshiCandidateRow, 'title' | 'rules_primary'>,
  dateKind: 'weekly' | 'annual' | 'monthly',
): { iso: string | null; precision: EventDatePrecision | null; source: string | null } {
  const text = `${row.title ?? ''} ${row.rules_primary ?? ''}`;
  if (dateKind === 'weekly') {
    const m = text.match(/(?:during the week of|for the Week of)\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
    const mo = m ? MUSIC_MONTH_NUM[m[1].toLowerCase()] : undefined;
    if (m && mo) {
      const iso = `${m[3]}-${String(mo).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
      return { iso, precision: 'day', source: 'chart-week' };
    }
  } else if (dateKind === 'annual') {
    const m = text.match(/\b(20\d{2})\b/);
    if (m) return { iso: `${m[1]}-01-01`, precision: 'year', source: 'chart-year' };
  } else {
    const m = text.match(/\bin\s+([A-Za-z]+)\s+(\d{4})/i);
    const stamped = m
      ? stampConditionDate({ kind: 'monthToken', mon: m[1], year: parseInt(m[2], 10), pad: 'start' })
      : null;
    if (stamped) return { iso: stamped.iso, precision: stamped.precision, source: 'chart-month' };
  }
  return { iso: null, precision: null, source: null };
}

async function tryMusicChartPosition(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, MUSIC_CHART_SERIES);
  if (!spec) return null;
  const subjectRaw = extractMusicChartSubject(row, spec.subjectFrom);
  if (!subjectRaw) return null;
  let position: number;
  if (spec.fixedPosition == null) {
    const p = parseInt((row.yes_sub_title ?? '').trim(), 10);
    if (Number.isNaN(p)) return null;
    position = p;
  } else {
    position = spec.fixedPosition;
  }
  const date = buildMusicChartDate(row, spec.dateKind);
  const tuple = emitCondition({
    archetype: 'terminal_threshold',
    tag: 'kalshi:music-chart-position',
    eventKind: 'other',
    metric: 'rank',
    direction: 'at',
    temporal: 'on_date',
    value: { primary: position, unit: 'rank' },
  }, 'kalshi-det');
  if (!tuple) return null;
  const canonical_subject = await resolveSubjectViaKB(subjectRaw, 'entertainment');
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: 'event_name', aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [] },
  ];
  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: row.event_title ?? row.title,
    ...tupleConditionParts(tuple),
    date,
    outcomeLabel: row.yes_sub_title,
    resolvedEntities: resolved_entities,
    resolutionSource: spec.resolutionSource,
    participants: dedupeSorted([canonical_subject]),
    category: 'entertainment',
    eventKind: 'other',
  }, 'kalshi:music-chart-position');
  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'entertainment');
  return { norm, tag: 'kalshi:music-chart-position' };
}

interface GameTotalSpec {
  unit: string;
  scope: string | null; // 'F5'/'1H'/'2H' — keep period ladders in separate questions
  sub: 'combined' | 'team';
  entity: 'team' | 'person';
  sport: string | null;
  metric: 'score' | 'count';
  seriesTotal?: boolean;
}

const GAME_TOTAL_SERIES: Record<string, GameTotalSpec> = {
  KXMLBTOTAL:     { unit: 'runs',   scope: null, sub: 'combined', entity: 'team',   sport: 'baseball',           metric: 'score' },
  KXMLBF5TOTAL:   { unit: 'runs',   scope: 'F5', sub: 'combined', entity: 'team',   sport: 'baseball',           metric: 'score' },
  KXMLBTEAMTOTAL: { unit: 'runs',   scope: null, sub: 'team',     entity: 'team',   sport: 'baseball',           metric: 'score' },
  KXNBATEAMTOTAL: { unit: 'points', scope: null, sub: 'team',     entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXNBATOTAL:     { unit: 'points', scope: null, sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXNBA1HTOTAL:   { unit: 'points', scope: '1H', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXNBA2HTOTAL:   { unit: 'points', scope: '2H', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXNHLTOTAL:     { unit: 'goals',  scope: null, sub: 'combined', entity: 'team',   sport: 'ice hockey',         metric: 'score' },
  KXKBOTOTAL:     { unit: 'runs',   scope: null, sub: 'combined', entity: 'team',   sport: 'baseball',           metric: 'score' },
  KXIPLTEAMTOTAL: { unit: 'runs',   scope: null, sub: 'team',     entity: 'team',   sport: 'cricket',            metric: 'score' },
  KXATPGTOTAL:    { unit: 'games',  scope: null, sub: 'combined', entity: 'person', sport: 'tennis',             metric: 'count' },
  KXUFLTOTAL:     { unit: 'points', scope: null, sub: 'combined', entity: 'team',   sport: 'american football',  metric: 'score' },
  KXWNBA1HTOTAL:  { unit: 'points', scope: '1H', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXWNBATOTAL:    { unit: 'points', scope: null, sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXCS2TOTALMAPS: { unit: 'maps',   scope: null, sub: 'combined', entity: 'team',   sport: null,                 metric: 'count', seriesTotal: true },
  KXLOLTOTALMAPS: { unit: 'maps',   scope: null, sub: 'combined', entity: 'team',   sport: null,                 metric: 'count', seriesTotal: true },
  KXCODTOTALMAPS: { unit: 'maps',   scope: null, sub: 'combined', entity: 'team',   sport: null,                 metric: 'count', seriesTotal: true },
  KXUCLTOTAL:     { unit: 'goals',  scope: null, sub: 'combined', entity: 'team',   sport: 'soccer',             metric: 'score' },
  KXUCL1HTOTAL:   { unit: 'goals',  scope: '1H', sub: 'combined', entity: 'team',   sport: 'soccer',             metric: 'score' },
  KXNBASUMMERTOTAL: { unit: 'points', scope: null, sub: 'combined', entity: 'team', sport: 'basketball',         metric: 'score' },
  KXUECLTEAMTOTAL: { unit: 'goals',  scope: null, sub: 'team',     entity: 'team',   sport: 'soccer',             metric: 'score' },
  KXMLSTEAMTOTAL:  { unit: 'goals',  scope: null, sub: 'team',     entity: 'team',   sport: 'soccer',             metric: 'score' },
  KXWNBA2HTOTAL:  { unit: 'points', scope: '2H', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXWNBA1QTOTAL:  { unit: 'points', scope: '1Q', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXWNBA2QTOTAL:  { unit: 'points', scope: '2Q', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXWNBA3QTOTAL:  { unit: 'points', scope: '3Q', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
  KXWNBA4QTOTAL:  { unit: 'points', scope: '4Q', sub: 'combined', entity: 'team',   sport: 'basketball',         metric: 'score' },
};

export function gameTotalMetricScope(spec: GameTotalSpec): MetricScope {
  if (spec.seriesTotal) return 'series';
  if (spec.sub === 'team') return 'team';
  switch (spec.scope) {
    case 'F5': return 'first_5';
    case '1H': return 'half_1';
    case '2H': return 'half_2';
    case '1Q': case '2Q': case '3Q': case '4Q': return 'quarter';
    default:   return 'game';
  }
}

const GT_ESPORTS_TITLE_RX = /in the (.+?) vs\.? (.+?) (?:CS2|CSGO|League of Legends|Call of Duty|Dota 2|Valorant|R6|Counter-Strike|Overwatch|Rocket League) match\??/i;
const GT_COMBINED_TITLE_RX = /^(?:Game\s+\d+:\s*)?(.+?)\s+(?:vs\.?|at)\s+(.+?)(?::|\s+(?:Total|First|first|\d))/i;
const GT_TEAM_TITLE_RX = /^Will\s+(.+?)\s+score\s+over\s+[\d.]+/i;
const GT_RULES_FIXTURE_RX = /(?:in the|of the)\s+([A-Z][\w.'&\-]*(?:\s+[\w.'&\-]+){0,3}?)\s+(?:vs\.?|at|and)\s+([A-Za-z0-9][\w.'&\-]*(?:\s+[\w.'&\-]+){0,3}?)\s+(?:professional|Pro Basketball|CS2|CSGO|League of Legends|Call of Duty|Dota 2|Valorant|R6|Counter-Strike|Overwatch|Rocket League)\b/i;

export function extractGameTotalFixture(
  row: Pick<KalshiCandidateRow, 'title' | 'rules_primary'>,
  sub: 'combined' | 'team',
): { subject: string; opponent: string | null } | null {
  if (sub === 'team') {
    const t = row.title.match(GT_TEAM_TITLE_RX);
    if (!t?.[1]) return null;
    const subject = t[1].trim();
    const rm = (row.rules_primary ?? '').match(GT_RULES_FIXTURE_RX);
    let opponent: string | null = null;
    if (rm) {
      const a = rm[1].trim();
      const b = rm[2].trim();
      opponent = a.toLowerCase() === subject.toLowerCase() ? b : a;
    }
    return { subject, opponent };
  }
  const et = row.title.match(GT_ESPORTS_TITLE_RX);
  if (et?.[1] && et[2]) return { subject: et[1].trim(), opponent: et[2].trim() };
  const ct = row.title.match(GT_COMBINED_TITLE_RX);
  if (ct?.[1] && ct[2]) return { subject: ct[1].trim(), opponent: ct[2].trim() };
  const rm = (row.rules_primary ?? '').match(GT_RULES_FIXTURE_RX);
  if (rm?.[1] && rm[2]) return { subject: rm[1].trim(), opponent: rm[2].trim() };
  return null;
}

async function tryGameTotal(row: KalshiCandidateRow): Promise<KalshiNormalizationHit | null> {
  const spec = seriesSpecFor(row, GAME_TOTAL_SERIES);
  if (!spec) return null;
  if (row.strike_type !== 'greater') return null;
  const value_primary = toNumber(row.floor_strike);
  if (value_primary == null) return null;

  const fixture = extractGameTotalFixture(row, spec.sub);
  if (!fixture) return null; // unparseable fixture → defer to LLM (never a fake hub)
  const { subject: subjectRaw, opponent: opponentRaw } = fixture;

  const canonical_subject = await resolveSubjectViaKB(subjectRaw, 'sports', { sport: spec.sport, league: null });
  const subjScope = scopeToEntityMetadata({ sport: spec.sport, league: null }, spec.entity);
  const resolved_entities: ResolvedEntity[] = [
    { canonical: canonical_subject, type: spec.entity, aliases: subjectRaw !== canonical_subject ? [subjectRaw] : [], metadata: metaOrUndef(subjScope) },
  ];
  let opponentCanonical: string | null = null;
  if (opponentRaw) {
    opponentCanonical = await resolveSubjectViaKB(opponentRaw, 'sports', { sport: spec.sport, league: null });
    resolved_entities.push({ canonical: opponentCanonical, type: spec.entity, aliases: opponentRaw !== opponentCanonical ? [opponentRaw] : [], metadata: metaOrUndef(subjScope) });
  }
  const fixtureEvent = normalizeFixtureCanonicalEvent(`${subjectRaw} vs ${opponentRaw ?? ''}`.trim()) || `${subjectRaw} vs ${opponentRaw ?? ''}`.trim();
  const canonical_event = spec.scope ? `${fixtureEvent} ${spec.scope}` : fixtureEvent;
  const leagueId = await resolveKalshiCompetitionToLeagueId(row.kalshi_competition);

  const norm = assembleKalshiNorm(row, {
    subject: canonical_subject,
    canonicalEvent: canonical_event,
    shape: 'monotonic_threshold',
    direction: 'above',
    metric: spec.metric,
    temporal: 'during_period',
    valuePrimary: value_primary,
    valueUnit: spec.unit,
    outcomeLabel: spec.scope,
    resolvedEntities: resolved_entities,
    metricScope: gameTotalMetricScope(spec),
    participants: dedupeSorted(opponentCanonical ? [canonical_subject, opponentCanonical] : [canonical_subject]),
    category: 'sports',
    leagueId,
    eventKind: 'match_total_metric',
  }, 'kalshi:game-total');

  {
    const fixtureSubject = fixtureSubjectOverride({
      eventKind: norm.event_kind,
      metricScope: norm.metric_scope,
      participantCount: norm.participants?.length ?? 0,
      canonicalEvent: norm.canonical_event,
    });
    if (fixtureSubject) norm.canonical_subject = fixtureSubject;
  }

  await registerEntities(row.market_id, canonical_subject, resolved_entities, 'sports');
  return { norm, tag: 'kalshi:game-total' };
}

