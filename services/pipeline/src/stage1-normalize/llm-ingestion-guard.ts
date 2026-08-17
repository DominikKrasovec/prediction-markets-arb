/**
 * LLM-path emission door: extends the same warn-and-pass guard the Stage-1
 * deterministic chokepoints use to the LLM normalization path, at its single
 * chokepoint — `upsertNormalization` (db/queries/normalizations.ts), the one
 * place a per-market LLM result becomes an llm_market_normalizations row (the
 * bulk variant is deterministic-only and already validated upstream).
 *
 * Two layers, applied in order:
 *
 *  1. DATE POST-COERCION to the storage convention (user decision, verbatim
 *     semantics): an "in <year>" / "in <month>" / "by <period>" deadline means
 *     the LAST day of that period at 23:59 in the market-rules timezone,
 *     DEFAULT UTC — but the STAMP is the padded period-START ISO +
 *     condition_date_precision ('year'/'month'); the period-END interpretation
 *     lives in consumer semantics (util/date-grain-sql orders by bucket-END).
 *     Concretely:
 *       · precision missing → derive from the ISO shape
 *         (YYYY → year + pad start, YYYY-MM → month + pad start,
 *          YYYY-MM-DD[Thh:mm…] → day, date unchanged);
 *       · ISO shape COARSER than the claimed precision ('2026' + 'day') →
 *         the shape wins (pad start + shape grain, logged);
 *       · period-END / interior date WITH coarse precision
 *         ('2026-12-31' + 'year', '2026-03-31' + 'month') → coerce to the
 *         padded period start with a logged note — a CONVENTION coercion, not
 *         data loss: compares at coarse grain only ever read the bucket.
 *     A date already at the period start (including a zero T00:00:00Z time
 *     suffix, the deterministic stamp style) passes byte-identical.
 *
 *  2. validateConditionTuple — warn-and-pass, mirroring the deterministic
 *     chokepoints' wiring; EMIT_CONDITION_STRICT=1 (tests / inventory scripts)
 *     turns warns into throws. This does NOT replace correctLLMTemporal — the
 *     shape×temporal COERCION for LLM output stays exactly where it is.
 *
 * Layering: imports emit-condition (leaf over types/logger/util) only — safe
 * to import from db/queries without a cycle.
 */
import type { LLMMarketNormalization } from '@arb/types';
import { createLogger } from '@arb/logger';
import { validateConditionTuple } from './emit-condition.js';

const log = createLogger('llm-ingest');

export type DateGrain = 'minute' | 'hour' | 'day' | 'month' | 'year';

export interface CoercedConditionDate {
  date: string | null;
  precision: DateGrain | null;
  /** Human-readable description of what changed; null = passed unchanged. */
  note: string | null;
  /** true = the input VIOLATED the convention (warn); false = a benign
   *  derivation (missing precision filled from the ISO shape — info). */
  violation: boolean;
}

const pass = (date: string | null, precision: DateGrain | null): CoercedConditionDate =>
  ({ date, precision, note: null, violation: false });

/** Zero time suffix (the deterministic stamp style) — counts as "no time
 *  component" for the period-start check. */
const ZERO_TIME = /^[T ]00:00(:00(\.0+)?)?(Z|\+00:00)?$/;

/**
 * Pure date post-coercion to the padded-START + precision storage convention.
 * Never throws; unparseable inputs pass through unchanged (the validator's
 * DATE_PRECISION warn picks up a precision-less date downstream).
 */
export function coerceLLMConditionDate(
  date: string | null | undefined,
  precision: DateGrain | null | undefined,
): CoercedConditionDate {
  const p = precision ?? null;
  if (date == null || date.trim() === '') {
    // precision without a date is meaningless — drop it so the row can't
    // claim a grain it has no date for.
    return p == null
      ? pass(date ?? null, null)
      : { date: date ?? null, precision: null, note: `dropped precision '${p}' on a null condition_date`, violation: true };
  }

  const s = date.trim();
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(.*))?)?$/.exec(s);
  if (!m) return pass(date, p); // unparseable — leave for the validator
  const [, yy, mm, dd, rest] = m;
  if (dd != null && rest !== '' && !ZERO_TIME.test(rest ?? '')) {
    // Day ISO with a NON-zero / malformed time tail. A well-formed time keeps
    // day handling below; anything else passes through untouched.
    if (!/^[T ]\d{2}:\d{2}/.test(rest ?? '')) return pass(date, p);
  }
  const shape = dd != null ? ('day' as const) : mm != null ? ('month' as const) : ('year' as const);
  const hasTime = dd != null && rest !== '' && rest != null;
  const zeroTime = hasTime && ZERO_TIME.test(rest!);

  const padStart = (grain: 'year' | 'month'): string =>
    grain === 'year' ? `${yy}-01-01` : `${yy}-${mm ?? '01'}-01`;

  // ── precision missing → derive from the ISO shape ─────────────────────────
  if (p == null) {
    if (shape === 'year') {
      return { date: padStart('year'), precision: 'year', note: `derived 'year' from ISO shape '${s}' → padded start`, violation: false };
    }
    if (shape === 'month') {
      return { date: padStart('month'), precision: 'month', note: `derived 'month' from ISO shape '${s}' → padded start`, violation: false };
    }
    return { date: s, precision: 'day', note: `derived 'day' from ISO shape '${s}'`, violation: false };
  }

  // ── ISO shape coarser than the claimed precision → the shape wins ─────────
  // (a time-bearing day ISO ranks sub-day, so 'hour'/'minute' claims on it pass).
  const rank: Record<DateGrain, number> = { year: 3, month: 2, day: 1, hour: 0, minute: 0 };
  const shapeRank = shape === 'day' ? (hasTime ? 0 : 1) : rank[shape];
  if (shapeRank > rank[p]) {
    if (shape === 'day') {
      // bare day ISO claiming hour/minute — no time component to back the claim.
      return {
        date: s, precision: 'day',
        note: `bare day ISO '${s}' claimed precision '${p}' — shape wins ('day')`,
        violation: true,
      };
    }
    return {
      date: padStart(shape), precision: shape,
      note: `ISO shape '${s}' is ${shape}-grain but claimed precision '${p}' — shape wins, padded start`,
      violation: true,
    };
  }

  // ── coarse precision: the date must be the padded period START ────────────
  if (p === 'year' || p === 'month') {
    const atStart = p === 'year'
      ? (mm == null || mm === '01') && (dd == null || dd === '01')
      : dd == null || dd === '01';
    if (atStart && (!hasTime || zeroTime)) return pass(date, p);
    return {
      date: padStart(p), precision: p,
      note: `period-END/interior date '${s}' with coarse precision '${p}' → padded start (convention, not data loss — compares are coarse-grain)`,
      violation: true,
    };
  }

  // day / hour / minute claims on a day-shaped ISO — fine as-is (a coarser
  // CLAIM than the time component carries is a safe under-claim).
  return pass(date, p);
}

/**
 * The LLM ingestion door: date post-coercion + validateConditionTuple
 * (warn-and-pass). Pure — returns a new object when anything changed, the
 * input object untouched. Call sites gate on match_source == null (the LLM
 * discriminator); deterministic rows are validated at their own chokepoints.
 */
export function guardLLMNormalization(norm: LLMMarketNormalization): LLMMarketNormalization {
  const tag = norm.match_source ?? 'llm';
  const { date, precision, note, violation } = coerceLLMConditionDate(
    norm.condition_date, norm.condition_date_precision ?? null,
  );

  let out = norm;
  if (date !== norm.condition_date || precision !== (norm.condition_date_precision ?? null)) {
    out = { ...norm, condition_date: date, condition_date_precision: precision };
  }
  if (note) {
    const line = `DATE_COERCION: ${note} (market ${norm.market_id}, ${tag})`;
    if (violation) log.warn(line);
    else log.info(line);
  }

  // Warn-and-pass door (throws only under EMIT_CONDITION_STRICT=1 — tests and
  // the read-only inventory scripts). The prefix union is pinned to the two
  // deterministic chokepoints by emit-condition.ts; the value is only a log
  // tag, so the LLM path threads its own and casts.
  validateConditionTuple(out, 'llm-ingest', tag);
  return out;
}
