/** Fixture START-INSTANT extraction + divergence veto. Venues stamp "when is
 *  this game" differently, so a same-fixture join on calendar dates alone can
 *  fuse two different games of one series. DOCTRINE: two markets are the same
 *  fixture only when start instants agree within FIXTURE_START_TOLERANCE_MS
 *  in UTC epoch -- never on calendar-date equality alone. */

export const FIXTURE_START_KINDS: ReadonlySet<string> = new Set([
  'match_total_metric', 'match_spread', 'match_winner', 'both_teams_score',
  'exact_score', 'halftime_leader', 'match_event_prop', 'player_prop_threshold',
]);

/** SQL tuple twin of FIXTURE_START_KINDS -- keep in sync. */
export const FIXTURE_START_KINDS_SQL =
  `(${[...FIXTURE_START_KINDS].map((k) => `'${k}'`).join(',')})`;

/** Cross-venue deltas stay well under 10h; adjacent fixtures start >=14h apart. */
export const FIXTURE_START_TOLERANCE_MS =
  parseInt(process.env.FIXTURE_START_TOLERANCE_MS ?? `${10 * 60 * 60 * 1000}`, 10);

export const FIXTURE_LOCAL_DATE_ZONE = 'America/New_York';

/** Back-to-back/series sports where a calendar-ambiguous evening stamp can bridge two real fixtures. */
export const DAY_SHIFT_PRONE_SPORTS: ReadonlySet<string> = new Set([
  'baseball',
  'basketball',
  'ice hockey',
  'hockey',
]);

export const DAY_SHIFT_PRONE_SPORTS_SQL = `('baseball','basketball','ice hockey','hockey')`;

export interface FixtureInstantCols {
  platform: string;
  conditionDate: string;
  conditionDatePrecision: string;
  fixtureEndDate: string;
}

function colsFor(alias: string, cols?: Partial<FixtureInstantCols>): FixtureInstantCols {
  return {
    platform: cols?.platform ?? `${alias}.platform`,
    conditionDate: cols?.conditionDate ?? `${alias}.condition_date`,
    conditionDatePrecision: cols?.conditionDatePrecision ?? `${alias}.condition_date_precision`,
    fixtureEndDate: cols?.fixtureEndDate ?? `${alias}.fixture_end_date`,
  };
}

/** Two trusted sources only, else NULL: self-consistent Polymarket end_date, or
 *  any 'minute'-precision condition_date. Kalshi/Predict end_dates are untrusted. */
export function fixtureStartInstantSql(
  alias: string,
  dateCast = '',
  cols?: Partial<FixtureInstantCols>,
): string {
  const c = colsFor(alias, cols);
  return `CASE
        WHEN ${c.platform} = 'polymarket'
             AND ${c.fixtureEndDate} IS NOT NULL
             AND ${c.conditionDate} IS NOT NULL
             AND ${c.conditionDatePrecision} = 'day'
             AND (${c.fixtureEndDate} AT TIME ZONE '${FIXTURE_LOCAL_DATE_ZONE}')::date
               = (${c.conditionDate}${dateCast} AT TIME ZONE 'UTC')::date
          THEN ${c.fixtureEndDate}
        WHEN ${c.conditionDatePrecision} = 'minute' AND ${c.conditionDate} IS NOT NULL
          THEN ${c.conditionDate}${dateCast}
        ELSE NULL
      END`;
}

/** Refuse-only: fires only when both instants are known and diverge; one-side-NULL abstains. */
export function fixtureStartVetoSql(aStartExpr: string, bStartExpr: string): string {
  return `NOT (
         ${aStartExpr} IS NOT NULL AND ${bStartExpr} IS NOT NULL
         AND ABS(EXTRACT(EPOCH FROM (${aStartExpr} - ${bStartExpr}))) * 1000
             >= ${FIXTURE_START_TOLERANCE_MS}
       )`;
}

/** A pre-dawn-UTC minute stamp is ambiguous against a bare 'day' date with no
 *  instant on a DAY_SHIFT_PRONE_SPORTS pair. */
export function ambiguousEveningRefusalSql(
  a: string,
  b: string,
  aStartExpr: string,
  bStartExpr: string,
  maxUtcHour: number,
  dateCast = '',
  sportCols?: { a: string; b: string },
): string {
  const aSport = sportCols?.a ?? `${a}.sport`;
  const bSport = sportCols?.b ?? `${b}.sport`;
  const proneSql = `(lower(COALESCE(${aSport}, '')) IN ${DAY_SHIFT_PRONE_SPORTS_SQL}
              OR lower(COALESCE(${bSport}, '')) IN ${DAY_SHIFT_PRONE_SPORTS_SQL})`;
  const arm = (m: string, d: string, dStart: string) => `(
           ${m}.condition_date_precision = 'minute' AND ${m}.condition_date IS NOT NULL
           AND ${d}.condition_date_precision = 'day' AND ${d}.condition_date IS NOT NULL
           AND ${dStart} IS NULL
           AND EXTRACT(HOUR FROM ${m}.condition_date${dateCast} AT TIME ZONE 'UTC') < ${maxUtcHour}
           AND ${proneSql}
         )`;
  return `NOT (${arm(a, b, bStartExpr)}
         OR ${arm(b, a, aStartExpr)})`;
}

/** TS mirrors of the SQL above -- keep in sync. */
export interface FixtureInstantFacts {
  platform: string | null | undefined;
  end_date?: Date | string | null;
  condition_date: string | null | undefined;
  condition_date_precision?: string | null;
}

/** YYYY-MM-DD of an epoch instant in FIXTURE_LOCAL_DATE_ZONE (DST-correct). */
function localDateKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FIXTURE_LOCAL_DATE_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function parseInstantMs(v: Date | string): number {
  if (v instanceof Date) return v.getTime();
  // widen the Postgres bare-hour offset ('+00') to ISO ('+00:00'); naive timestamps anchor as UTC
  const t = v.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(t);
  return Date.parse(hasZone ? t : t + 'Z');
}

export function fixtureStartInstantMs(f: FixtureInstantFacts): number | null {
  const prec = (f.condition_date_precision ?? '').toLowerCase();
  const d = f.condition_date?.trim() ?? '';
  if (f.platform === 'polymarket' && f.end_date != null && prec === 'day'
      && /^\d{4}-\d{2}-\d{2}/.test(d)) {
    const endMs = parseInstantMs(f.end_date);
    if (Number.isFinite(endMs) && localDateKey(endMs) === d.slice(0, 10)) return endMs;
    return null;
  }
  if (prec === 'minute' && /^\d{4}-\d{2}-\d{2}[T ]/.test(d)) {
    const ms = parseInstantMs(d);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function fixtureStartInstantsDiverge(aMs: number | null, bMs: number | null): boolean {
  if (aMs == null || bMs == null) return false;
  return Math.abs(aMs - bMs) >= FIXTURE_START_TOLERANCE_MS;
}

export function ambiguousEveningConflict(
  a: FixtureInstantFacts,
  b: FixtureInstantFacts,
  maxUtcHour: number,
  aSport: string | null | undefined,
  bSport: string | null | undefined,
): boolean {
  const prone = DAY_SHIFT_PRONE_SPORTS.has((aSport ?? '').toLowerCase())
    || DAY_SHIFT_PRONE_SPORTS.has((bSport ?? '').toLowerCase());
  if (!prone) return false;
  const arm = (m: FixtureInstantFacts, d: FixtureInstantFacts): boolean => {
    if ((m.condition_date_precision ?? '').toLowerCase() !== 'minute') return false;
    if ((d.condition_date_precision ?? '').toLowerCase() !== 'day') return false;
    if (d.condition_date == null || fixtureStartInstantMs(d) != null) return false;
    const ms = fixtureStartInstantMs(m);
    if (ms == null) return false;
    return new Date(ms).getUTCHours() < maxUtcHour;
  };
  return arm(a, b) || arm(b, a);
}
