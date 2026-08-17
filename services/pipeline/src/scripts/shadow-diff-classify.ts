/**
 * Shadow-diff classification for the Stage-1 emission door: diffs a stored vs
 * recomputed field tuple and assigns one bucket, first match wins — EQUAL,
 * EXPECTED_FLIP, DOCUMENTED_EXCEPTION, LATENT_BUG, EXPECTED_BASELINE_DRIFT,
 * PORT_BLOCKER. A canonical_event diff is always PORT_BLOCKER unless it
 * matches one of the declared re-key transforms below.
 */
import { LEXICON_EXCEPTIONS } from '../util/condition-shape.js';
import { inferYear, parseMonthToken } from '../util/condition-date.js';
import { isIntegerGrainUnit } from '../util/threshold-canonical.js';

export interface TupleFields {
  event_kind: string | null;
  condition_shape: string | null;
  condition_direction: string | null;
  condition_metric: string | null;
  temporal_semantics: string | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  metric_scope: string | null;
  condition_date: string | null;
  condition_date_precision: string | null;
  condition_date_source: string | null;
  condition_value: string | null;
  canonical_event: string | null;
}

export const DIFF_FIELDS: ReadonlyArray<keyof TupleFields> = [
  'event_kind',
  'condition_shape',
  'condition_direction',
  'condition_metric',
  'temporal_semantics',
  'value_primary',
  'value_secondary',
  'value_unit',
  'metric_scope',
  'condition_date',
  'condition_date_precision',
  'condition_date_source',
  'condition_value',
  'canonical_event',
];

const NUMERIC_FIELDS = new Set<keyof TupleFields>(['value_primary', 'value_secondary']);

// Numeric fields compare by value (pg NUMERIC arrives as a string upstream).
export function fieldEqual(field: keyof TupleFields, a: TupleFields[keyof TupleFields], b: TupleFields[keyof TupleFields]): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (NUMERIC_FIELDS.has(field)) return Number(a) === Number(b);
  return a === b;
}

export function diffTuples(stored: TupleFields, recomputed: TupleFields): Array<keyof TupleFields> {
  return DIFF_FIELDS.filter((f) => !fieldEqual(f, stored[f], recomputed[f]));
}

export const O3_FAMILIES: ReadonlySet<string> = new Set([
  'limitless:crypto-bucket',
  'limitless:econ-cpi',
  'limitless:econ-jobs',
  'limitless:econ-commodity',
  'limitless:econ-valuation',
  'text-deterministic-A',
  'text-deterministic-X',
  'text-deterministic-V',
  'text-deterministic-AH',
]);

export const DATE1_FAMILIES: ReadonlySet<string> = new Set([
  'text-deterministic-AG',
  'text-deterministic-AH',
  'text-deterministic-AJ',
  'text-deterministic-AK',
]);

export const BESPOKE_REGISTRY: ReadonlyArray<{
  tag: string;
  ticket: string;
  axes: ReadonlySet<keyof TupleFields>;
  applies: (stored: TupleFields, recomputed: TupleFields) => boolean;
}> = [
  {
    tag: 'text-deterministic-AK',
    ticket: 'A3',
    axes: new Set(['condition_shape', 'temporal_semantics']),
    applies: (s, r) =>
      (s.condition_shape === 'categorical_outcome' && s.temporal_semantics === 'during_period') ||
      (r.condition_shape === 'categorical_outcome' && r.temporal_semantics === 'during_period'),
  },
  {
    tag: 'limitless:crypto-ath',
    ticket: 'ATH',
    axes: new Set(['condition_direction', 'condition_metric']),
    applies: (s, r) => s.condition_direction === 'above' || r.condition_direction === 'above',
  },
];

export type Bucket =
  | 'EQUAL'
  | 'EXPECTED_FLIP'
  | 'DOCUMENTED_EXCEPTION'
  | 'LATENT_BUG'
  | 'EXPECTED_BASELINE_DRIFT'
  | 'PORT_BLOCKER';

export interface Classification {
  bucket: Bucket;
  kind: string | null;
  diffs: Array<keyof TupleFields>;
}

export interface ClassifyInput {
  family: string;
  stored: TupleFields;
  // null = the current deterministic path no longer produces a row for this input.
  recomputed: TupleFields | null;
  now: Date;
  endDate: string | null;
  title: string;
  noRecomputeReason?: string;
}

const subsetOf = (diffs: ReadonlyArray<keyof TupleFields>, allowed: ReadonlySet<keyof TupleFields>): boolean =>
  diffs.every((d) => allowed.has(d));

const O3_ALLOWED = new Set<keyof TupleFields>(['condition_direction', 'condition_value']);
function matchesO3(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!O3_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, O3_ALLOWED) || !diffs.includes('condition_direction')) return false;
  if (s.condition_direction !== null || r.condition_direction !== 'between') return false;
  if (diffs.includes('condition_value')) {
    if (s.condition_value == null || r.condition_value == null) return false;
    if (s.condition_value.replace('_', '-') !== r.condition_value) return false;
  }
  return true;
}

const DATE1_ALLOWED = new Set<keyof TupleFields>(['condition_date', 'condition_date_source']);
function matchesDate1(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!DATE1_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, DATE1_ALLOWED) || !diffs.includes('condition_date')) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  if (s.condition_date_precision !== 'year' || r.condition_date_precision !== 'year') return false;
  return (
    s.condition_date.slice(0, 4) === r.condition_date.slice(0, 4) &&
    s.condition_date.slice(4, 10) === '-12-31' &&
    r.condition_date.slice(4, 10) === '-01-01'
  );
}

const DATE2_ALLOWED = new Set<keyof TupleFields>(['condition_date', 'condition_date_source']);
function matchesDate2(s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>, endDate: string | null, now: Date): boolean {
  if (!subsetOf(diffs, DATE2_ALLOWED) || !diffs.includes('condition_date')) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  const sIso = s.condition_date.slice(0, 10);
  const rIso = r.condition_date.slice(0, 10);
  if (sIso.slice(4) !== rIso.slice(4)) return false;
  const sy = parseInt(sIso.slice(0, 4), 10);
  const ry = parseInt(rIso.slice(0, 4), 10);
  if (!Number.isFinite(sy) || !Number.isFinite(ry) || Math.abs(sy - ry) !== 1) return false;
  const month = parseInt(rIso.slice(5, 7), 10);
  const day = parseInt(rIso.slice(8, 10), 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return false;
  return ry === inferYear(month, day, endDate, now);
}

const DATE3_ALLOWED = new Set<keyof TupleFields>(['condition_date']);
function matchesDate3(s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!subsetOf(diffs, DATE3_ALLOWED)) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  const sIso = s.condition_date.slice(0, 10);
  const rIso = r.condition_date.slice(0, 10);
  if (sIso.slice(0, 7) !== rIso.slice(0, 7)) return false;
  if (sIso.slice(8) !== '28' || rIso.slice(8) !== '29' || rIso.slice(5, 7) !== '02') return false;
  const y = parseInt(rIso.slice(0, 4), 10);
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

export const DATE4_FAMILIES: ReadonlySet<string> = new Set([
  'limitless:participation',
  'limitless:transfer',
  'limitless:manager',
  'limitless:retirement',
  'pm:manager-out',
]);

const DATE4_ALLOWED = new Set<keyof TupleFields>(['condition_date']);
function matchesDate4(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>, title: string): boolean {
  if (!DATE4_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, DATE4_ALLOWED) || !diffs.includes('condition_date')) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  if (s.condition_date_precision !== 'day' || r.condition_date_precision !== 'day') return false;
  if (!/\bend\s+of\b/i.test(title)) return false;
  const sIso = s.condition_date.slice(0, 10);
  const rIso = r.condition_date.slice(0, 10);
  return (
    sIso.slice(0, 4) === rIso.slice(0, 4) &&
    sIso.slice(4) === '-01-01' &&
    rIso.slice(4) === '-12-31'
  );
}

export const DATE5_FAMILIES: ReadonlySet<string> = new Set([
  'text-deterministic-V',
  'pm:rate-decision',
  'pm:inflation',
  'limitless:econ-stock',
]);

const TITLE_MONTH_YEAR_GUARD_RX =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(20[2-3]\d)\b/i;

const DATE5_ALLOWED = new Set<keyof TupleFields>([
  'condition_date', 'condition_date_precision', 'condition_date_source',
]);
function matchesDate5(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>, title: string): boolean {
  if (!DATE5_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, DATE5_ALLOWED) || !diffs.includes('condition_date') || !diffs.includes('condition_date_precision')) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  if (s.condition_date_precision !== 'year' || r.condition_date_precision !== 'month') return false;
  if (s.condition_date_source !== 'title-year' || r.condition_date_source !== 'title-month-year') return false;
  const sIso = s.condition_date.slice(0, 10);
  const rIso = r.condition_date.slice(0, 10);
  if (sIso.slice(0, 4) !== rIso.slice(0, 4)) return false;
  if (sIso.slice(4) !== '-01-01' || rIso.slice(7) !== '-01') return false;
  const m = TITLE_MONTH_YEAR_GUARD_RX.exec(title);
  if (!m) return false;
  if (m[2] !== rIso.slice(0, 4)) return false;
  const titleMonth = parseMonthToken(m[1]!);
  return titleMonth != null && titleMonth === parseInt(rIso.slice(5, 7), 10);
}

const DATE_EOM_ALLOWED = new Set<keyof TupleFields>([
  'condition_date', 'condition_date_precision', 'condition_date_source',
]);
const TITLE_DEADLINE_MONTH_RX =
  /\bby\s+end\s+of\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\bhit\b.*?\bin\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
function monthEndDayNum(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function matchesDateEom(s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>, title: string): boolean {
  if (!subsetOf(diffs, DATE_EOM_ALLOWED) || diffs.length === 0) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  const rIso = r.condition_date.slice(0, 10);
  const ry = parseInt(rIso.slice(0, 4), 10);
  const rm = parseInt(rIso.slice(5, 7), 10);
  const rd = parseInt(rIso.slice(8, 10), 10);
  if (!Number.isFinite(ry) || !Number.isFinite(rm) || !Number.isFinite(rd)) return false;
  if (r.condition_date_precision !== 'month' || rd !== monthEndDayNum(ry, rm)) return false;

  if (s.condition_date_source === 'title-month-year' && r.condition_date_source === 'title-month-year') {
    const sIso = s.condition_date.slice(0, 10);
    return (
      s.condition_date_precision === 'month' &&
      sIso.slice(0, 7) === rIso.slice(0, 7) &&
      sIso.slice(8, 10) === '01'
    );
  }

  if (s.condition_date_source === 'end_date' && r.condition_date_source === 'title-month-deadline') {
    if (s.condition_date_precision !== 'day') return false;
    const dm = TITLE_DEADLINE_MONTH_RX.exec(title);
    if (!dm) return false;
    const titleMonth = parseMonthToken(dm[1] ?? dm[2] ?? '');
    return titleMonth != null && titleMonth === rm;
  }
  return false;
}

export const A1_TOUCH_FAMILIES: ReadonlySet<string> = new Set([
  'text-deterministic-X',
  'kalshi:price-ladder',
]);

const A1_TOUCH_ALLOWED = new Set<keyof TupleFields>(['condition_shape', 'temporal_semantics']);
function matchesA1Touch(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>, title: string): boolean {
  if (!A1_TOUCH_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, A1_TOUCH_ALLOWED) || !diffs.includes('condition_shape') || !diffs.includes('temporal_semantics')) return false;
  if (s.event_kind !== 'approval_rating' || r.event_kind !== 'approval_rating') return false;
  if (s.condition_shape !== 'point_in_time' || r.condition_shape !== 'monotonic_threshold') return false;
  if (s.temporal_semantics !== 'on_date' || r.temporal_semantics !== 'during_period') return false;
  if (s.value_primary == null || s.value_secondary != null) return false;
  if (r.value_primary == null || r.value_secondary != null) return false;
  if (s.condition_direction !== r.condition_direction) return false;
  if (s.condition_direction !== 'above' && s.condition_direction !== 'below') return false;
  if (family === 'text-deterministic-X') {
    return (
      /\b(?:hit|reach|exceed)(?:s|es)?\b/i.test(title) &&
      /\bin\s+20\d{2}\s*\?*\s*$/i.test(title) &&
      !/\b(?:on|for)\s+\w+\s+\d{1,2}\b/i.test(title)
    );
  }
  return /\bduring\b/i.test(title);
}

export const CUM_CONV_FAMILIES: ReadonlySet<string> = new Set([
  'pm:count-bucket',
  'text-deterministic-AH',
  'kalshi:weather',
]);

const CUM_CONV_KALSHI_WINDOW_UNITS: ReadonlySet<string> = new Set(['tornado', 'tornadoes']);

const CUM_CONV_PM_RANGE_ALLOWED = new Set<keyof TupleFields>(['temporal_semantics']);
const CUM_CONV_PM_ABOVE_ALLOWED = new Set<keyof TupleFields>(['condition_shape', 'temporal_semantics']);
const CUM_CONV_AH_OPENTOP_ALLOWED = new Set<keyof TupleFields>([
  'condition_shape', 'condition_direction', 'condition_value',
]);
function matchesCumConv(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!CUM_CONV_FAMILIES.has(family)) return false;
  if (family === 'pm:count-bucket') {
    if (s.condition_direction === 'between') {
      if (!subsetOf(diffs, CUM_CONV_PM_RANGE_ALLOWED) || !diffs.includes('temporal_semantics')) return false;
      if (s.condition_shape !== 'range_snapshot' || r.condition_shape !== 'range_snapshot') return false;
      if (r.condition_direction !== 'between') return false;
      if (s.value_primary == null || s.value_secondary == null) return false;
      return s.temporal_semantics === 'on_date' && r.temporal_semantics === 'during_period';
    }
    if (s.condition_direction === 'above') {
      if (!subsetOf(diffs, CUM_CONV_PM_ABOVE_ALLOWED) ||
          !diffs.includes('condition_shape') || !diffs.includes('temporal_semantics')) return false;
      if (s.condition_shape !== 'point_in_time' || r.condition_shape !== 'monotonic_threshold') return false;
      if (r.condition_direction !== 'above') return false;
      if (s.value_primary == null || s.value_secondary != null || r.value_secondary != null) return false;
      return s.temporal_semantics === 'on_date' && r.temporal_semantics === 'during_period';
    }
    return false;
  }
  if (family === 'kalshi:weather') {
    if (!subsetOf(diffs, CUM_CONV_PM_ABOVE_ALLOWED) ||
        !diffs.includes('condition_shape') || !diffs.includes('temporal_semantics')) return false;
    const unit = s.value_unit?.toLowerCase();
    if (unit == null || !CUM_CONV_KALSHI_WINDOW_UNITS.has(unit)) return false;
    if (s.event_kind !== 'weather_extreme' || r.event_kind !== 'weather_extreme') return false;
    if (s.condition_shape !== 'point_in_time' || r.condition_shape !== 'monotonic_threshold') return false;
    if (s.condition_direction !== 'above' || r.condition_direction !== 'above') return false;
    if (s.value_primary == null || s.value_secondary != null || r.value_secondary != null) return false;
    return s.temporal_semantics === 'on_date' && r.temporal_semantics === 'during_period';
  }
  if (!subsetOf(diffs, CUM_CONV_AH_OPENTOP_ALLOWED) ||
      !diffs.includes('condition_shape') || !diffs.includes('condition_direction')) return false;
  if (s.condition_shape !== 'range_snapshot' || r.condition_shape !== 'monotonic_threshold') return false;
  if (s.condition_direction !== null || r.condition_direction !== 'above') return false;
  if (s.value_primary == null || s.value_secondary != null || r.value_secondary != null) return false;
  if (s.temporal_semantics !== 'during_period' || r.temporal_semantics !== 'during_period') return false;
  if (diffs.includes('condition_value')) {
    if (s.condition_value == null || r.condition_value == null) return false;
    if (`>=${s.condition_value}` !== r.condition_value) return false;
  }
  return true;
}

export const O8_BINARY_FAMILIES: ReadonlySet<string> = new Set([
  'text-deterministic-predict-esports-h2h',
]);

const O8_BINARY_ALLOWED = new Set<keyof TupleFields>(['condition_shape', 'temporal_semantics']);
function matchesO8Binary(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!O8_BINARY_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, O8_BINARY_ALLOWED) ||
      !diffs.includes('condition_shape') || !diffs.includes('temporal_semantics')) return false;
  if (s.event_kind !== 'match_winner' || r.event_kind !== 'match_winner') return false;
  if (s.condition_shape !== 'categorical_outcome' || r.condition_shape !== 'binary_event') return false;
  if (s.temporal_semantics !== null || r.temporal_semantics !== 'at_resolution') return false;
  if (s.condition_direction !== null || r.condition_direction !== null) return false;
  if (s.value_primary != null || r.value_primary != null) return false;
  if (s.value_secondary != null || r.value_secondary != null) return false;
  return true;
}

const KWIN_NULLDIR_ALLOWED = new Set<keyof TupleFields>(['condition_direction', 'condition_metric']);
const KWIN_NULLDIR_KINDS = new Set(['match_winner', 'championship_winner', 'halftime_leader']);
function matchesKwinNullDir(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (family !== 'kalshi:esports-winner' && !family.startsWith('kalshi:winner-')) return false;
  if (!subsetOf(diffs, KWIN_NULLDIR_ALLOWED) ||
      !diffs.includes('condition_direction') || !diffs.includes('condition_metric')) return false;
  if (s.condition_direction !== 'at' || r.condition_direction !== null) return false;
  if (s.condition_metric !== 'boolean' || r.condition_metric !== null) return false;
  if (s.event_kind == null || s.event_kind !== r.event_kind || !KWIN_NULLDIR_KINDS.has(s.event_kind)) return false;
  return true;
}

const DW58_RANK_ALLOWED = new Set<keyof TupleFields>([
  'condition_shape', 'condition_direction', 'condition_metric',
  'value_primary', 'value_unit', 'condition_value', 'canonical_event',
]);
function matchesDw58Rank(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (family !== 'kalshi:primary-advance') return false;
  if (!subsetOf(diffs, DW58_RANK_ALLOWED) ||
      !diffs.includes('condition_shape') || !diffs.includes('condition_direction') ||
      !diffs.includes('value_primary')) return false;
  if (s.event_kind !== 'primary_winner' || r.event_kind !== 'primary_winner') return false;
  if (s.condition_shape !== 'binary_event' || r.condition_shape !== 'monotonic_threshold') return false;
  if (s.condition_direction !== 'at' || r.condition_direction !== 'below') return false;
  if (s.condition_metric !== 'boolean' || r.condition_metric !== null) return false;
  if (s.value_primary != null || Number(r.value_primary) !== 2) return false;
  if (s.value_secondary != null || r.value_secondary != null) return false;
  if (s.value_unit !== null || String(r.value_unit).toLowerCase() !== 'rank') return false;
  if (s.condition_value !== 'advances' || r.condition_value !== '<=2rank') return false;
  if (diffs.includes('canonical_event')) {
    const sc = s.canonical_event ?? '';
    const rc = r.canonical_event ?? '';
    if (!rc.endsWith(' primary') || !sc.endsWith(' primary')) return false;
    const base = rc.slice(0, -'primary'.length);
    if (!sc.startsWith(base)) return false;
    const seg = sc.slice(base.length, -' primary'.length).trim();
    if (!/^[a-z][a-z ]{2,40}$/.test(seg)) return false;
  }
  return true;
}

function matchesDw58dPlaceFirst(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (family !== 'kalshi:place-first-primary') return false;
  if (diffs.length !== 1 || diffs[0] !== 'canonical_event') return false;
  if (s.event_kind !== 'election_outcome_winner' || r.event_kind !== 'election_outcome_winner') return false;
  const sc = s.canonical_event ?? '';
  const rc = r.canonical_event ?? '';
  if (!rc.endsWith(' primary') || !sc.endsWith(' primary')) return false;
  const base = rc.slice(0, -'primary'.length);
  if (!sc.startsWith(base)) return false;
  const seg = sc.slice(base.length, -' primary'.length).trim();
  return /^[a-z][a-z ]{2,40}$/.test(seg);
}
const DEGENERATE_AT_ALLOWED = new Set<keyof TupleFields>([
  'condition_direction', 'value_secondary', 'condition_value', 'condition_shape',
]);
function matchesKalshiDegenerateAt(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!family.startsWith('kalshi')) return false;
  if (!subsetOf(diffs, DEGENERATE_AT_ALLOWED) || !diffs.includes('condition_direction')) return false;
  if (s.condition_direction !== 'between' || r.condition_direction !== 'at') return false;
  if (s.value_primary == null || s.value_secondary == null) return false;
  if (Number(s.value_primary) !== Number(s.value_secondary)) return false;
  if (r.value_primary == null || Number(r.value_primary) !== Number(s.value_primary)) return false;
  if (r.value_secondary != null) return false;
  if (diffs.includes('condition_shape') &&
      !(s.condition_shape === 'range_snapshot' && r.condition_shape === 'point_in_time')) return false;
  return true;
}

const THRESH_CANON_ALLOWED = new Set<keyof TupleFields>(['value_primary', 'condition_value']);
function matchesThreshCanon(s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!subsetOf(diffs, THRESH_CANON_ALLOWED) || !diffs.includes('value_primary')) return false;
  if (s.condition_direction !== r.condition_direction) return false;
  if (s.condition_direction !== 'above' && s.condition_direction !== 'below') return false;
  if (s.value_secondary != null || r.value_secondary != null) return false;
  if (s.value_primary == null || r.value_primary == null) return false;
  if (s.value_unit == null || r.value_unit == null) return false;
  if (String(s.value_unit).toLowerCase() !== String(r.value_unit).toLowerCase()) return false;
  if (!isIntegerGrainUnit(s.value_unit)) return false;
  const sv = Number(s.value_primary);
  const rv = Number(r.value_primary);
  if (!Number.isInteger(sv)) return false;
  if (Math.abs(Math.abs(rv - sv) - 0.5) > 1e-9) return false;
  if (Math.abs((rv * 2) - Math.round(rv * 2)) > 1e-9 || Number.isInteger(rv)) return false;
  if (diffs.includes('condition_value')) {
    if (s.condition_value == null || r.condition_value == null) return false;
    const op = s.condition_direction === 'above' ? '>=' : '<=';
    const unit = String(r.value_unit);
    if (`${op}${rv}${unit}` !== r.condition_value) return false;
  }
  return true;
}

const AJ_REKEY_ALLOWED = new Set<keyof TupleFields>(['condition_date', 'canonical_event']);
function matchesAjEndDate(
  family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>,
  endDate: string | null, now: Date,
): boolean {
  if (family !== 'text-deterministic-AJ') return false;
  if (!subsetOf(diffs, AJ_REKEY_ALLOWED) ||
      !diffs.includes('condition_date') || !diffs.includes('canonical_event')) return false;
  if (s.condition_date == null || r.condition_date == null) return false;
  if (s.canonical_event == null || r.canonical_event == null) return false;
  if (s.condition_date_precision !== r.condition_date_precision) return false;
  if (s.condition_date_source !== r.condition_date_source) return false;
  const sIso = s.condition_date.slice(0, 10);
  const rIso = r.condition_date.slice(0, 10);
  if (sIso.slice(4) !== rIso.slice(4)) return false;
  if (sIso === rIso) return false;
  const month = parseInt(rIso.slice(5, 7), 10);
  const day = parseInt(rIso.slice(8, 10), 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return false;
  if (parseInt(rIso.slice(0, 4), 10) !== inferYear(month, day, endDate, now)) return false;
  if (!s.canonical_event.includes(sIso)) return false;
  return s.canonical_event.split(sIso).join(rIso) === r.canonical_event;
}

export const MIDTERM_FAMILIES: ReadonlySet<string> = new Set([
  'kalshi:midterm-mov', 'kalshi:midterm-voteturn',
]);

const MIDTERM_REKEY_ALLOWED = new Set<keyof TupleFields>(['condition_date', 'canonical_event']);
function matchesMidtermCycle(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): boolean {
  if (!MIDTERM_FAMILIES.has(family)) return false;
  if (!subsetOf(diffs, MIDTERM_REKEY_ALLOWED) || !diffs.includes('canonical_event')) return false;
  if (s.canonical_event == null || r.canonical_event == null) return false;
  const sm = /^(20\d\d) (.+)$/.exec(s.canonical_event);
  const rm = /^2026 (.+ (?:margin|turnout))$/.exec(r.canonical_event);
  if (!sm || !rm || sm[2] !== rm[1]) return false;
  if (sm[1] === '2026') return false;
  if (s.condition_date_precision !== 'year' || r.condition_date_precision !== 'year') return false;
  if (diffs.includes('condition_date')) {
    if (s.condition_date == null || r.condition_date == null) return false;
    if (s.condition_date.slice(0, 10) !== `${sm[1]}-01-01`) return false;
    if (r.condition_date.slice(0, 10) !== '2026-01-01') return false;
  }
  return true;
}

function matchesDeclaredRekey(
  family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>,
  endDate: string | null, now: Date,
): string | null {
  if (matchesAjEndDate(family, s, r, diffs, endDate, now)) return 'AJ_ENDDATE';
  if (matchesMidtermCycle(family, s, r, diffs)) return 'MIDTERM_CYCLE';
  return null;
}

const LEXICON_AXES = new Set<keyof TupleFields>(['condition_shape', 'temporal_semantics', 'condition_direction']);
const TOUCH_SNAPSHOT_PAIR = new Set(['monotonic_threshold', 'point_in_time']);

function matchesDocumentedException(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): string | null {
  for (const ex of LEXICON_EXCEPTIONS) {
    if (ex.tag !== family) continue;
    if (!subsetOf(diffs, LEXICON_AXES)) continue;
    if (diffs.includes('condition_shape')) {
      if (!TOUCH_SNAPSHOT_PAIR.has(s.condition_shape ?? '') || !TOUCH_SNAPSHOT_PAIR.has(r.condition_shape ?? '')) continue;
    }
    return ex.ticket;
  }
  for (const b of BESPOKE_REGISTRY) {
    if (b.tag !== family) continue;
    if (!subsetOf(diffs, b.axes)) continue;
    if (!b.applies(s, r)) continue;
    return b.ticket;
  }
  return null;
}

const SHAPE_TEMPORAL_AXES = new Set<keyof TupleFields>(['condition_shape', 'temporal_semantics']);

function matchesLatentBug(family: string, s: TupleFields, r: TupleFields, diffs: Array<keyof TupleFields>): string | null {
  if (family === 'text-deterministic-X' && subsetOf(diffs, SHAPE_TEMPORAL_AXES) &&
      TOUCH_SNAPSHOT_PAIR.has(s.condition_shape ?? '') && TOUCH_SNAPSHOT_PAIR.has(r.condition_shape ?? '')) {
    return 'A1';
  }
  if (family === 'limitless:econ-above' && subsetOf(diffs, SHAPE_TEMPORAL_AXES) &&
      TOUCH_SNAPSHOT_PAIR.has(s.condition_shape ?? '') && TOUCH_SNAPSHOT_PAIR.has(r.condition_shape ?? '')) {
    return 'A2';
  }
  if (family === 'text-deterministic-AK' && subsetOf(diffs, SHAPE_TEMPORAL_AXES) &&
      ((s.condition_shape === 'categorical_outcome' && s.temporal_semantics === 'during_period') ||
       (r.condition_shape === 'categorical_outcome' && r.temporal_semantics === 'during_period'))) {
    return 'A3';
  }
  if (family === 'limitless:crypto-ath' &&
      subsetOf(diffs, new Set<keyof TupleFields>(['condition_direction', 'condition_metric'])) &&
      (s.condition_direction === 'above' || r.condition_direction === 'above')) {
    return 'ATH';
  }
  return null;
}

const IPO_MCAP_RX = /IPO closing market cap above/i;
const END_DATE_SOURCES = new Set<string | null>([null, 'end_date', 'event-year-from-end_date']);

function baselineDriftKind(field: keyof TupleFields, s: TupleFields, r: TupleFields, title: string): string | null {
  switch (field) {
    case 'metric_scope':
      return s.metric_scope == null && r.metric_scope != null ? 'metric_scope-5c5369b' : null;
    case 'condition_shape':
      return (s.event_kind === 'match_spread' || IPO_MCAP_RX.test(title)) &&
        s.condition_shape === 'monotonic_threshold' && r.condition_shape === 'point_in_time'
        ? 'spread-073' : null;
    case 'temporal_semantics':
      return (s.event_kind === 'match_spread' || IPO_MCAP_RX.test(title)) &&
        r.temporal_semantics === 'at_resolution'
        ? 'spread-073' : null;
    case 'condition_date':
    case 'condition_date_precision':
    case 'condition_date_source': {
      if (s.event_kind === 'crypto_launch_fdv' && r.condition_date == null) return 'fdv-073';
      if (END_DATE_SOURCES.has(s.condition_date_source) && END_DATE_SOURCES.has(r.condition_date_source)) {
        return 'end-date-moved';
      }
      return null;
    }
    default:
      return null;
  }
}

export function classifyRow(input: ClassifyInput): Classification {
  const { family, recomputed, now, endDate, title } = input;
  let { stored } = input;

  if (recomputed == null) {
    return { bucket: 'PORT_BLOCKER', kind: `NO_RECOMPUTE(${input.noRecomputeReason ?? 'template-miss'})`, diffs: [] };
  }

  // Normalize a unit that differs from recomputed only by pluralization before
  // diffing, so a stale-vocabulary row surfaces as drift, not an unexplained diff.
  let unitVocabDrift = false;
  const su = stored.value_unit?.toLowerCase();
  const ru = recomputed.value_unit?.toLowerCase();
  if (su != null && ru != null && su !== ru && (`${su}s` === ru || su === `${ru}s`)) {
    unitVocabDrift = true;
    stored = {
      ...stored,
      value_unit: recomputed.value_unit,
      condition_value:
        stored.condition_value != null && stored.condition_value.toLowerCase().endsWith(su)
          ? stored.condition_value.slice(0, stored.condition_value.length - su.length) + ru
          : stored.condition_value,
    };
  }
  const withUnitDrift = (c: Classification): Classification =>
    unitVocabDrift ? { ...c, kind: c.kind == null ? 'unit-vocab-evolved' : `${c.kind}+unit-vocab-evolved` } : c;

  const diffs = diffTuples(stored, recomputed);
  if (unitVocabDrift && diffs.length === 0) {
    return { bucket: 'EXPECTED_BASELINE_DRIFT', kind: 'unit-vocab-evolved', diffs };
  }
  if (diffs.length === 0) return { bucket: 'EQUAL', kind: null, diffs };

  if (diffs.includes('canonical_event')) {
    const rekey = matchesDeclaredRekey(family, stored, recomputed, diffs, endDate, now);
    if (rekey != null) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: rekey, diffs });
    if (matchesDw58Rank(family, stored, recomputed, diffs)) {
      return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DW58_RANK', diffs });
    }
    if (matchesDw58dPlaceFirst(family, stored, recomputed, diffs)) {
      return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DW58D_PLACEFIRST', diffs });
    }
    return withUnitDrift({ bucket: 'PORT_BLOCKER', kind: 'CANONICAL_EVENT', diffs });
  }

  if (matchesO3(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'O3', diffs });
  if (matchesDate1(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE1', diffs });
  if (matchesDate2(stored, recomputed, diffs, endDate, now)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE2', diffs });
  if (matchesDate3(stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE3', diffs });
  if (matchesDate4(family, stored, recomputed, diffs, title)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE4', diffs });
  // DATE5 can compose with an already-matched O3 flip on the same row; check
  // the residual (non-date) diffs against O3 separately rather than rejecting.
  {
    const dateDiffs = diffs.filter((d) => DATE5_ALLOWED.has(d));
    const residual = diffs.filter((d) => !DATE5_ALLOWED.has(d));
    if (dateDiffs.length > 0 && matchesDate5(family, stored, recomputed, dateDiffs, title)) {
      if (residual.length === 0) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE5', diffs });
      if (matchesO3(family, stored, recomputed, residual)) {
        return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'O3+DATE5', diffs });
      }
    }
  }
  if (matchesDateEom(stored, recomputed, diffs, title)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DATE_EOM', diffs });
  if (matchesA1Touch(family, stored, recomputed, diffs, title)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'A1_TOUCH', diffs });
  if (matchesCumConv(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'CUM_CONV', diffs });
  if (matchesO8Binary(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'O8_BINARY', diffs });
  if (matchesKwinNullDir(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'KWIN_NULLDIR', diffs });
  if (matchesDw58Rank(family, stored, recomputed, diffs)) return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'DW58_RANK', diffs });
  if (matchesKalshiDegenerateAt(family, stored, recomputed, diffs)) {
    return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'KALSHI_DEGENERATE_AT', diffs });
  }
  if (matchesThreshCanon(stored, recomputed, diffs)) {
    return withUnitDrift({ bucket: 'EXPECTED_FLIP', kind: 'THRESH_CANON', diffs });
  }

  const exception = matchesDocumentedException(family, stored, recomputed, diffs);
  if (exception != null) return withUnitDrift({ bucket: 'DOCUMENTED_EXCEPTION', kind: exception, diffs });

  const latent = matchesLatentBug(family, stored, recomputed, diffs);
  if (latent != null) return withUnitDrift({ bucket: 'LATENT_BUG', kind: latent, diffs });

  const driftKinds = new Set<string>();
  let allDrift = true;
  for (const f of diffs) {
    const k = baselineDriftKind(f, stored, recomputed, title);
    if (k == null) { allDrift = false; break; }
    driftKinds.add(k);
  }
  if (allDrift && driftKinds.size > 0) {
    return withUnitDrift({ bucket: 'EXPECTED_BASELINE_DRIFT', kind: [...driftKinds].sort().join('+'), diffs });
  }

  return withUnitDrift({ bucket: 'PORT_BLOCKER', kind: `UNEXPLAINED(${diffs.join(',')})`, diffs });
}

export const SCOREBOARD_FIELDS: ReadonlyArray<keyof TupleFields> = [
  'event_kind',
  'condition_shape',
  'condition_direction',
  'condition_metric',
  'temporal_semantics',
  'value_primary',
  'value_secondary',
  'value_unit',
  'metric_scope',
  'condition_date',
  'condition_value',
  'canonical_event',
];

export function pairDrifts(field: keyof TupleFields, a: TupleFields, b: TupleFields): boolean {
  const va = a[field];
  const vb = b[field];
  if (va == null || vb == null) return false;
  if (NUMERIC_FIELDS.has(field)) return Number(va) !== Number(vb);
  if (field === 'value_unit') return String(va).toLowerCase() !== String(vb).toLowerCase();
  if (field === 'condition_date') {
    const pa = a.condition_date_precision;
    const pb = b.condition_date_precision;
    const grain = pa === 'year' || pb === 'year' ? 4 : pa === 'month' || pb === 'month' ? 7 : 10;
    return String(va).slice(0, grain) !== String(vb).slice(0, grain);
  }
  return va !== vb;
}
