/** SQL mirror of util/date-grain.ts: a coarse stamp is padded, so two dates may only be
 *  compared at the coarser of their two grains. Leaf — imports nothing from stage1/3/4. */

/** rank: year=3, month=2, day/finer/unknown=1 — MUST mirror precisionRank(). */
export function grainRankSql(precisionExpr: string): string {
  return `CASE ${precisionExpr} WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END`;
}

function coarserSliceLenSql(aPrecision: string, bPrecision: string): string {
  return `CASE GREATEST(${grainRankSql(aPrecision)}, ${grainRankSql(bPrecision)}) WHEN 3 THEN 4 WHEN 2 THEN 7 ELSE 10 END`;
}

/** Callers own NULL-date semantics — wrap in their own NULL arms. */
export function sameAtCoarserGrainSql(
  aDate: string,
  aPrecision: string,
  bDate: string,
  bPrecision: string,
): string {
  const len = coarserSliceLenSql(aPrecision, bPrecision);
  return `left(${aDate}, ${len}) = left(${bDate}, ${len})`;
}

// A US-evening fixture's UTC-minute stamp rolls past midnight onto the day-grain side's date+1.
export const EVENING_DAY_SHIFT_MAX_UTC_HOUR = 10;

/** `guardSql` must embed the caller's prone-sport exclusion (DAY_SHIFT_PRONE_SPORTS in same-event.ts). */
export function eveningDayShiftArmsSql(
  aAlias: string,
  bAlias: string,
  guardSql: string,
  dateCast = '',
): string {
  const aD = `${aAlias}.condition_date`;
  const bD = `${bAlias}.condition_date`;
  const aP = `${aAlias}.condition_date_precision`;
  const bP = `${bAlias}.condition_date_precision`;
  const aArith = `${aD}${dateCast}`;
  const bArith = `${bD}${dateCast}`;
  const aDate = dateCast ? `(${aD}${dateCast})` : aD;
  const bDate = dateCast ? `(${bD}${dateCast})` : bD;
  return `
                     OR (${guardSql}
                         AND ${aP} = 'minute' AND ${bP} = 'day'
                         AND EXTRACT(HOUR FROM ${aArith} AT TIME ZONE 'UTC') < ${EVENING_DAY_SHIFT_MAX_UTC_HOUR}
                         AND ${bDate}::date = ${aDate}::date - 1)
                     OR (${guardSql}
                         AND ${bP} = 'minute' AND ${aP} = 'day'
                         AND EXTRACT(HOUR FROM ${bArith} AT TIME ZONE 'UTC') < ${EVENING_DAY_SHIFT_MAX_UTC_HOUR}
                         AND ${aDate}::date = ${bDate}::date - 1)`;
}

export interface DateLadderOpts {
  /** Opt-in evening day-shift arm; requires the DAY_SHIFT_PRONE_SPORTS exclusion. */
  minuteVsDayEveningShiftGuardSql?: string;
  /** Opt-in: for a prone sport, compares the minute side's local day instead of raw UTC. */
  proneMinuteVsDayLocalDaySql?: string;
}

/** Shared tolerance CASE (incl. NULL-pass + coarse-grain skip guards); embed as `AND
 *  ${datePrecisionLadderSql(...)}`. Fixture joins must also AND util/fixture-instant.ts's veto. */
export function datePrecisionLadderSql(
  aAlias: string,
  bAlias: string,
  cryptoMs: string | number,
  hourMs: string | number,
  dateCast = '',
  opts: DateLadderOpts = {},
): string {
  const aD = `${aAlias}.condition_date`;
  const bD = `${bAlias}.condition_date`;
  const aP = `${aAlias}.condition_date_precision`;
  const bP = `${bAlias}.condition_date_precision`;
  const aArith = `${aD}${dateCast}`;
  const bArith = `${bD}${dateCast}`;
  const aDate = dateCast ? `(${aD}${dateCast})` : aD;
  const bDate = dateCast ? `(${bD}${dateCast})` : bD;
  const g = opts.minuteVsDayEveningShiftGuardSql;
  const eveningArms = g == null ? '' : eveningDayShiftArmsSql(aAlias, bAlias, g, dateCast);
  const prone = opts.proneMinuteVsDayLocalDaySql;
  const baseDayArm = prone == null
    ? `${aDate}::date = ${bDate}::date`
    : `CASE
                 WHEN (${prone}) AND ${aP} = 'minute' AND ${bP} = 'day'
                      AND EXTRACT(HOUR FROM ${aArith} AT TIME ZONE 'UTC') < ${EVENING_DAY_SHIFT_MAX_UTC_HOUR}
                   THEN ((${aDate}::date - 1) = ${bDate}::date)
                 WHEN (${prone}) AND ${bP} = 'minute' AND ${aP} = 'day'
                      AND EXTRACT(HOUR FROM ${bArith} AT TIME ZONE 'UTC') < ${EVENING_DAY_SHIFT_MAX_UTC_HOUR}
                   THEN ((${bDate}::date - 1) = ${aDate}::date)
                 ELSE ${aDate}::date = ${bDate}::date
               END`;
  return `(
           ${aD} IS NULL OR ${bD} IS NULL
           OR ${aP} IN ('year','month')
           OR ${bP} IN ('year','month')
           OR (CASE
                 WHEN ${aP} = 'minute' AND ${bP} = 'minute'
                   THEN ABS(EXTRACT(EPOCH FROM (${aArith} - ${bArith}))) * 1000 < ${cryptoMs}
                 WHEN ${aP} = 'hour' OR ${bP} = 'hour'
                   THEN ABS(EXTRACT(EPOCH FROM (${aArith} - ${bArith}))) * 1000 < ${hourMs}
                 ELSE (${baseDayArm}${eveningArms})
               END)
         )`;
}

/** Equal-at-coarser is FALSE — a padded placeholder must never decide an ordering it cannot prove. */
export function strictlyEarlierAtCoarserGrainSql(
  aDate: string,
  aPrecision: string,
  bDate: string,
  bPrecision: string,
): string {
  const len = coarserSliceLenSql(aPrecision, bPrecision);
  return `left(${aDate}, ${len}) < left(${bDate}, ${len})`;
}

/** Caller owns the calendar-anchor gate (precision in month/year on both sides) — see stage4-events/window-containment.ts. */
export function strictlyContainedInCoarserWindowSql(
  aDate: string,
  aPrecision: string,
  bDate: string,
  bPrecision: string,
): string {
  const bLen = `CASE ${grainRankSql(bPrecision)} WHEN 3 THEN 4 WHEN 2 THEN 7 ELSE 10 END`;
  return `(${grainRankSql(aPrecision)} < ${grainRankSql(bPrecision)}
           AND left(${aDate}, ${bLen}) = left(${bDate}, ${bLen}))`;
}
