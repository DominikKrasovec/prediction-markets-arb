/**
 * `same_resolving_event` predicate — the deterministic gate the cross-question
 * edge rules call before asserting an edge between two outcome-nodes. Returns
 * 'same' | 'different' | 'indeterminate'.
 *
 * sameEventFragment (SQL) must stay in sync with sameResolvingEvent (TS);
 * parseGameOrdinal is the single ordinal source for both.
 */
import { config } from '../config.js';
import { foldLeagueKey, STAGE_SUFFIX_TOKENS, stripStageSuffix } from '../db/entity/taxonomy.js';
import { datePrecisionLadderSql, EVENING_DAY_SHIFT_MAX_UTC_HOUR } from '../util/date-grain-sql.js';
import {
  DAY_SHIFT_PRONE_SPORTS,
  DAY_SHIFT_PRONE_SPORTS_SQL,
  FIXTURE_START_KINDS_SQL,
  ambiguousEveningRefusalSql,
  fixtureStartInstantSql,
  fixtureStartVetoSql,
} from '../util/fixture-instant.js';
import { ESPORTS_GAMES, ESPORTS_UMBRELLA } from '../db/entity/sport-hierarchy.js';
import { discFoldFragment } from '../discriminators/fold-sql.js';
import { parseGameOrdinal, GAME_ORDINAL_RX } from '../discriminators/specs/game-ordinal.js';

/** Two-leg divergence veto threshold for sameFixtureFragment; env-overridable, default 3 days. */
export const FIXTURE_LEG_DIVERGENCE_MS =
  parseInt(process.env.FIXTURE_LEG_DIVERGENCE_MS ?? `${3 * 24 * 60 * 60 * 1000}`, 10);

/** Winner-type kinds needing known-compatible resolution_scope before 'same'; else 'indeterminate'. */
export const DECISIVE_KINDS: ReadonlySet<string> = new Set([
  'match_winner',
  'championship_winner',
  'halftime_leader',
  'both_teams_score',
]);

export { DAY_SHIFT_PRONE_SPORTS };

export function dayShiftGuardSqlForSportExprs(aSportExpr: string, bSportExpr: string): string {
  return `(${aSportExpr} IS NOT NULL AND ${bSportExpr} IS NOT NULL
                         AND lower(${aSportExpr}) NOT IN ${DAY_SHIFT_PRONE_SPORTS_SQL}
                         AND lower(${bSportExpr}) NOT IN ${DAY_SHIFT_PRONE_SPORTS_SQL})`;
}

function dayShiftGuardSql(a: string, b: string): string {
  return dayShiftGuardSqlForSportExprs(`${a}.sport`, `${b}.sport`);
}

export function dayShiftProneSqlForSportExprs(aSportExpr: string, bSportExpr: string): string {
  return `(lower(COALESCE(${aSportExpr}, '')) IN ${DAY_SHIFT_PRONE_SPORTS_SQL}
                         OR lower(COALESCE(${bSportExpr}, '')) IN ${DAY_SHIFT_PRONE_SPORTS_SQL})`;
}

function dayShiftProneSql(a: string, b: string): string {
  return dayShiftProneSqlForSportExprs(`${a}.sport`, `${b}.sport`);
}

export function scopesKnownAndConflictSql(a: string, b: string): string {
  return `(${a}.resolution_scope IS NOT NULL AND ${b}.resolution_scope IS NOT NULL
       AND ${a}.resolution_scope <> 'unspecified' AND ${b}.resolution_scope <> 'unspecified'
       AND ${a}.resolution_scope <> ${b}.resolution_scope)`;
}

/** Shared by sameEventFragment/sameFixtureFragment; kindGateSql scopes the arms to fixture kinds, null = unconditional. */
function fixtureStartConjuncts(a: string, b: string, kindGateSql: string | null): string {
  const aStart = fixtureStartInstantSql(a, '::timestamptz');
  const bStart = fixtureStartInstantSql(b, '::timestamptz');
  const arms = `${fixtureStartVetoSql(aStart, bStart)}
       AND ${ambiguousEveningRefusalSql(a, b, aStart, bStart, EVENING_DAY_SHIFT_MAX_UTC_HOUR, '::timestamptz')}`;
  return kindGateSql == null ? arms : `(NOT (${kindGateSql}) OR (${arms}))`;
}

/** Sports with no regulation-vs-overtime ambiguity; exempt from the DECISIVE unknown-scope refusal. */
export const NO_OVERTIME_CONCEPT_SPORTS: ReadonlySet<string> = new Set([
  ESPORTS_UMBRELLA,
  ...ESPORTS_GAMES,
  'tennis',
  'volleyball',
]);

const NO_OVERTIME_CONCEPT_SPORTS_SQL =
  `(${[...NO_OVERTIME_CONCEPT_SPORTS].map((s) => `'${s}'`).join(',')})`;

export const DECISIVE_KINDS_SQL =
  `('match_winner','championship_winner','halftime_leader','both_teams_score')`;

export { parseGameOrdinal, GAME_ORDINAL_RX };

/** Head-to-head (fixture-grain) shape discriminator for the championship_winner exemption. */
export const CHAMPIONSHIP_FIXTURE_GRAIN_RX =
  /\s(?:vs\.?|v\.?|versus)\s|\bbe the matchup\b/i;

/** POSIX mirror of CHAMPIONSHIP_FIXTURE_GRAIN_RX; keep both in sync. */
export const CHAMPIONSHIP_FIXTURE_GRAIN_SQL_RX =
  `\\s(vs\\.?|v\\.?|versus)\\s|\\mbe the matchup\\M`;

/** TRUE iff node is a COMPETITION-grain championship_winner (exempt from the unknown-scope refusal). */
export function isCompetitionGrainChampionship(
  f: Pick<NodeFacts, 'eventKind' | 'canonicalEvent' | 'title'>,
): boolean {
  return (
    f.eventKind === 'championship_winner' &&
    !CHAMPIONSHIP_FIXTURE_GRAIN_RX.test(f.canonicalEvent ?? '') &&
    !CHAMPIONSHIP_FIXTURE_GRAIN_RX.test(f.title ?? '') &&
    parseGameOrdinal(f.title) == null
  );
}

/** Node-grain facts the predicate compares, derived at query time by a join-CTE. */
export interface NodeFacts {
  platformEventId: string | null;
  canonicalEvent: string | null;
  conditionDate: Date | null;
  conditionDatePrecision: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  eventKind: string | null;
  sport: string | null;
  league: string | null;
  /** Regulation/incl_overtime/aggregate scope; NULL/'unspecified' means unknown. */
  resolutionScope?: string | null;
  /** 'draw' for a fixture's draw slot, 'decisive' for a named side. */
  drawAxis?: string | null;
  title: string | null;
}

function nullTol(a: string | null | undefined, b: string | null | undefined): boolean {
  return a == null || b == null || a === b;
}

/** Mirrors the SQL `league_stage_fold` installed by installSameEventSql(); keep in sync. */
export { foldLeagueKey };

function leagueCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  return a == null || b == null || foldLeagueKey(a) === foldLeagueKey(b);
}

function norm(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function scopeKnownCompatible(a: NodeFacts, b: NodeFacts): boolean {
  const sa = a.resolutionScope, sb = b.resolutionScope;
  return (
    sa != null && sb != null &&
    sa !== 'unspecified' && sb !== 'unspecified' &&
    sa === sb
  );
}

function scopesKnownAndConflict(a: NodeFacts, b: NodeFacts): boolean {
  const sa = a.resolutionScope, sb = b.resolutionScope;
  return (
    sa != null && sb != null &&
    sa !== 'unspecified' && sb !== 'unspecified' &&
    sa !== sb
  );
}

/** NULL or year/month precision either side always passes the date match; else tolerance ladder in config.pairing.sameEvent*ToleranceMs. */
function eveningDayShiftMatch(minuteSide: NodeFacts, daySide: NodeFacts): boolean {
  if (minuteSide.conditionDatePrecision !== 'minute' || daySide.conditionDatePrecision !== 'day') return false;
  const ms = minuteSide.sport?.toLowerCase(), ds = daySide.sport?.toLowerCase();
  if (ms == null || ds == null) return false;
  if (DAY_SHIFT_PRONE_SPORTS.has(ms) || DAY_SHIFT_PRONE_SPORTS.has(ds)) return false;
  const md = minuteSide.conditionDate!, dd = daySide.conditionDate!;
  if (md.getUTCHours() >= EVENING_DAY_SHIFT_MAX_UTC_HOUR) return false;
  const prevDay = new Date(md.getTime() - 24 * 60 * 60 * 1000);
  return dd.toISOString().slice(0, 10) === prevDay.toISOString().slice(0, 10);
}

function dateSame(a: NodeFacts, b: NodeFacts): boolean {
  const ad = a.conditionDate, bd = b.conditionDate;
  const ap = a.conditionDatePrecision, bp = b.conditionDatePrecision;
  if (ad == null || bd == null) return true;
  if (ap === 'year' || ap === 'month' || bp === 'year' || bp === 'month') return true;
  const diff = Math.abs(ad.getTime() - bd.getTime());
  if (ap === 'minute' && bp === 'minute') return diff < config.pairing.sameEventCryptoToleranceMs;
  if (ap === 'hour' || bp === 'hour') return diff < config.pairing.sameEventHourToleranceMs;
  return (
    ad.toISOString().slice(0, 10) === bd.toISOString().slice(0, 10) ||
    eveningDayShiftMatch(a, b) ||
    eveningDayShiftMatch(b, a)
  );
}

/** 'same' = safe to relate; 'indeterminate' = cannot prove, do not relate; 'different' = safe to not relate. */
export function sameResolvingEvent(a: NodeFacts, b: NodeFacts): 'same' | 'different' | 'indeterminate' {
  const ordA = parseGameOrdinal(a.title);
  const ordB = parseGameOrdinal(b.title);
  const ordinalsMatch = ordA === ordB;

  // Tier 1: platform_event_id alone isn't sufficient (multi-map events share one id), so ordinal must also match.
  if (
    a.platformEventId != null && b.platformEventId != null &&
    a.platformEventId === b.platformEventId &&
    ordinalsMatch
  ) {
    return 'same';
  }

  const tier2 =
    a.eventKind != null && b.eventKind != null && a.eventKind === b.eventKind &&
    nullTol(a.sport, b.sport) && leagueCompatible(a.league, b.league) &&
    norm(a.canonicalEvent) != null && norm(a.canonicalEvent) === norm(b.canonicalEvent) &&
    dateSame(a, b) &&
    ordinalsMatch;
  if (tier2) {
    if (scopesKnownAndConflict(a, b)) return 'indeterminate';

    // Whole-match DECISIVE kinds need known-compatible scope unless exempt.
    const kind = a.eventKind as string;
    const wholeMatch = ordA == null && ordB == null;
    if (DECISIVE_KINDS.has(kind) && wholeMatch && !scopeKnownCompatible(a, b)) {
      const knownConflict = scopesKnownAndConflict(a, b);
      const noOvertimeConcept =
        (a.sport != null && NO_OVERTIME_CONCEPT_SPORTS.has(a.sport.toLowerCase())) ||
        (b.sport != null && NO_OVERTIME_CONCEPT_SPORTS.has(b.sport.toLowerCase()));
      const drawVsDraw = a.drawAxis === 'draw' && b.drawAxis === 'draw';
      if (
        knownConflict ||
        !(
          (isCompetitionGrainChampionship(a) && isCompetitionGrainChampionship(b)) ||
          noOvertimeConcept ||
          drawVsDraw
        )
      ) {
        return 'indeterminate';
      }
    }
    return 'same';
  }

  const kind = a.eventKind ?? b.eventKind;
  if (kind != null && DECISIVE_KINDS.has(kind)) {
    return 'indeterminate';
  }
  return 'different';
}

/** Single-pass DISTINCT ON scan (hash-joinable); never a per-pair correlated EXISTS inside an O(n²) edge join. */
export function kalshiSeriesCte(name: string): string {
  return `${name} AS (
      SELECT DISTINCT ON (qm.question_id) qm.question_id,
             split_part(r.raw->>'event_ticker', '-', 1) AS series
      FROM question_members qm
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw r ON r.market_id = m.id
      WHERE r.raw->>'event_ticker' IS NOT NULL
      ORDER BY qm.question_id, m.id
    )`;
}

/** Idempotent (CREATE OR REPLACE); Postgres POSIX word boundaries are \m/\M, not \b. */
export function installSameEventSql(): string {
  return `
    CREATE OR REPLACE FUNCTION league_stage_fold(t text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $league_stage_fold$
      SELECT lower(replace(
               CASE
                 -- acronym-championship guard: keep 'PGA Championship' whole, distinct from 'PGA Tour'
                 WHEN s.base ~* '^[a-z0-9]{2,4}\\s+championship\\s*$'
                   OR s.stripped = ''
                   OR s.stripped ~* '^(${STAGE_SUFFIX_TOKENS})$'
                   THEN s.base
                 ELSE s.stripped
               END, ' ', ''))
      FROM (SELECT b.base,
                   btrim(regexp_replace(b.base,
                     '\\s+(${STAGE_SUFFIX_TOKENS})\\s*$',
                     '', 'i')) AS stripped
            FROM (SELECT regexp_replace(btrim(t),
                    '^(19|20)\\d{2}([\\s–-]\\d{2})?\\s+', '') AS base) b) s;
    $league_stage_fold$;`;
}

/** Source CTE must expose the NodeFacts column shape — build with nodeFactsCte() in node-facts.ts. */
export function sameEventFragment(a: string, b: string): string {
  const c = config.pairing;
  const identityFold = discFoldFragment(a, b);
  return `(
       (
         ${a}.platform_event_id = ${b}.platform_event_id
       )
       OR (
         ${a}.event_kind IS NOT NULL AND ${b}.event_kind IS NOT NULL AND ${a}.event_kind = ${b}.event_kind
         AND (${a}.sport  IS NULL OR ${b}.sport  IS NULL OR ${a}.sport  = ${b}.sport)
         -- league fold key equality
         AND (${a}.league IS NULL OR ${b}.league IS NULL OR league_stage_fold(${a}.league) = league_stage_fold(${b}.league))
         AND lower(immutable_unaccent(btrim(${a}.canonical_event))) = lower(immutable_unaccent(btrim(${b}.canonical_event)))
         AND lower(immutable_unaccent(btrim(${a}.canonical_event))) IS NOT NULL
         -- date ladder + evening day-shift arm
         AND ${datePrecisionLadderSql(a, b, c.sameEventCryptoToleranceMs, c.sameEventHourToleranceMs, '::timestamptz', { minuteVsDayEveningShiftGuardSql: dayShiftGuardSql(a, b), proneMinuteVsDayLocalDaySql: dayShiftProneSql(a, b) })}
         -- fixture start-instant veto + ambiguous-evening refusal
         AND ${fixtureStartConjuncts(a, b, `${a}.event_kind IN ${FIXTURE_START_KINDS_SQL}`)}
         -- known-conflict scope refusal
         AND NOT ${scopesKnownAndConflictSql(a, b)}
         -- FT/ET scope guard, whole-match grain only
         AND NOT (
           ${a}.event_kind IN ${DECISIVE_KINDS_SQL}
           AND (${a}.discriminators->>'game_ordinal') IS NULL
           AND (${b}.discriminators->>'game_ordinal') IS NULL
           AND NOT (
             ${a}.resolution_scope IS NOT NULL AND ${b}.resolution_scope IS NOT NULL
             AND ${a}.resolution_scope <> 'unspecified' AND ${b}.resolution_scope <> 'unspecified'
             AND ${a}.resolution_scope = ${b}.resolution_scope
           )
           AND NOT (
             ${a}.event_kind = 'championship_winner'
             AND COALESCE(${a}.canonical_event, '') !~* '${CHAMPIONSHIP_FIXTURE_GRAIN_SQL_RX}'
             AND COALESCE(${b}.canonical_event, '') !~* '${CHAMPIONSHIP_FIXTURE_GRAIN_SQL_RX}'
             AND COALESCE(${a}.title, '')           !~* '${CHAMPIONSHIP_FIXTURE_GRAIN_SQL_RX}'
             AND COALESCE(${b}.title, '')           !~* '${CHAMPIONSHIP_FIXTURE_GRAIN_SQL_RX}'
             AND NOT ( -- recorded scope divergence not overridden
               ${a}.resolution_scope IS NOT NULL AND ${b}.resolution_scope IS NOT NULL
               AND ${a}.resolution_scope <> 'unspecified' AND ${b}.resolution_scope <> 'unspecified'
               AND ${a}.resolution_scope <> ${b}.resolution_scope
             )
           )
           -- no-overtime-concept exemption
           AND NOT (
             (   lower(COALESCE(${a}.sport, '')) IN ${NO_OVERTIME_CONCEPT_SPORTS_SQL}
              OR lower(COALESCE(${b}.sport, '')) IN ${NO_OVERTIME_CONCEPT_SPORTS_SQL})
             AND NOT (
               ${a}.resolution_scope IS NOT NULL AND ${b}.resolution_scope IS NOT NULL
               AND ${a}.resolution_scope <> 'unspecified' AND ${b}.resolution_scope <> 'unspecified'
               AND ${a}.resolution_scope <> ${b}.resolution_scope
             )
           )
           -- draw x draw exemption
           AND NOT (
             COALESCE(${a}.discriminators->>'draw_axis', '') = 'draw'
             AND COALESCE(${b}.discriminators->>'draw_axis', '') = 'draw'
             AND NOT (
               ${a}.resolution_scope IS NOT NULL AND ${b}.resolution_scope IS NOT NULL
               AND ${a}.resolution_scope <> 'unspecified' AND ${b}.resolution_scope <> 'unspecified'
               AND ${a}.resolution_scope <> ${b}.resolution_scope
             )
           )
         )
       )
     )${identityFold ? `\n     AND ${identityFold}` : ''}`;
}

/** Not used by fixture-totals/spread-winner/scorer-implication: their Kalshi legs pad end_date onto the same boundary, so those use the start-instant veto instead. */
export function fixtureEndDateVetoSql(a: string, b: string): string {
  return `NOT (
         ${a}.fixture_end_date IS NOT NULL AND ${b}.fixture_end_date IS NOT NULL
         AND ${a}.platform_event_id IS DISTINCT FROM ${b}.platform_event_id
         AND ABS(EXTRACT(EPOCH FROM (${a}.fixture_end_date::timestamptz - ${b}.fixture_end_date::timestamptz))) * 1000
             >= ${FIXTURE_LEG_DIVERGENCE_MS}
       )`;
}

export function sameFixtureFragment(a: string, b: string): string {
  const c = config.pairing;
  const identityFold = discFoldFragment(a, b);
  return `(
       lower(immutable_unaccent(btrim(${a}.canonical_event))) = lower(immutable_unaccent(btrim(${b}.canonical_event)))
       AND lower(immutable_unaccent(btrim(${a}.canonical_event))) IS NOT NULL
       -- identical alphabetized participant set
       AND ${a}.participants IS NOT NULL AND ${b}.participants IS NOT NULL
       AND ${a}.participants = ${b}.participants
       -- consequent must be whole-game or unknown scope
       AND (${b}.metric_scope IS NULL OR ${b}.metric_scope = 'game')
       -- date gate: same ladder as sameEventFragment
       AND ${datePrecisionLadderSql(a, b, c.sameEventCryptoToleranceMs, c.sameEventHourToleranceMs, '::timestamptz', { minuteVsDayEveningShiftGuardSql: dayShiftGuardSql(a, b) })}
       -- fixture end-date veto
       AND ${fixtureEndDateVetoSql(a, b)}
       -- fixture start-instant veto
       AND ${fixtureStartConjuncts(a, b, null)}
     )${identityFold ? `\n     AND ${identityFold}` : ''}`;
}
