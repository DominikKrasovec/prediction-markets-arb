// Pure extraction of settlement-instrument/candle/dimension facts from raw market metadata.

/** The settlement_instrument fact vocabulary. NULL = unknown. */
export type SettlementInstrument =
  | 'cf-benchmarks'
  | 'binance'
  | 'pyth'
  | 'aaa'
  | `futures:${string}`;

/** Futures-settled with NO pinned contract — never bridgeable cross-platform. */
export const FUTURES_UNPINNED = 'futures:unpinned' as const;

const CF_BENCHMARKS_RE = /CF Benchmarks/i;
// '.' matches the hyphen/space in "front-month".
const KALSHI_FUTURES_LANG_RE = /NYMEX|front.month|contract/i;
const NON_KALSHI_FUTURES_LANG_RE = /Active Month|front.month|futures/i;
// Case-sensitive on purpose: lowercase 'aaa' false-positives inside URLs like gasprices.aaa.com.
const AAA_RE = /\bAAA\b/;
const BINANCE_RE = /Binance/i;
const PYTH_RE = /Pyth/i;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Pure; returns null for unknown/odd raw shapes.
export function extractSettlementInstrument(
  platform: string,
  raw: unknown,
): SettlementInstrument | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (platform === 'kalshi') {
    const rules = asString(r.rules_primary);
    if (CF_BENCHMARKS_RE.test(rules)) return 'cf-benchmarks';
    const cs = r.custom_strike;
    const contract =
      cs !== null && typeof cs === 'object' && !Array.isArray(cs)
        ? asString((cs as Record<string, unknown>).front_month_contract).trim()
        : '';
    if (contract !== '' && contract !== 'N/A') return `futures:${contract}`;
    if (AAA_RE.test(rules)) return 'aaa';
    if (KALSHI_FUTURES_LANG_RE.test(rules)) return FUTURES_UNPINNED;
    return null;
  }

  const description = asString(r.description);
  if (BINANCE_RE.test(description)) return 'binance';
  if (PYTH_RE.test(description)) return 'pyth';
  if (AAA_RE.test(description)) return 'aaa';
  if (NON_KALSHI_FUTURES_LANG_RE.test(description)) return FUTURES_UNPINNED;
  return null;
}

/** `<oracle>|tie:<up|down|5050>` composite candle settlement identity. NULL = unknown, never matchable. */
export type CandleSettlement = string;

/** Chainlink data-stream slug inside a rules/description URL. */
const CHAINLINK_STREAM_RE = /data\.chain\.link\/streams\/([a-z0-9-]+)/i;
const CHAINLINK_SLUG_DECORATION_RE = /-(datalink|streams)$/;
const CF_BENCHMARKS_RTI = 'cf-benchmarks-rti:60s';
const BINANCE_CANDLE = 'binance';

// Checked first — Predict's text also contains a plain 'greater than', misread by comparator-first order.
const TIE_5050_RE = /\b50\s*[-/]\s*50\b/;
/** "greater than or equal to" / "at least" / "or equal to" — a tie resolves UP. */
const TIE_UP_RE = /greater than or equal to|\bat least\b|\bor equal to\b/i;
/** "strictly greater than" / "must exceed" — a tie resolves DOWN (the NO side). */
const TIE_DOWN_RE = /strictly (greater|higher|above)|\bmust exceed\b/i;

/** Concatenate every free-text field a venue may carry the settlement prose in. */
function settlementText(r: Record<string, unknown>): string {
  return [
    r.description, r.rules_primary, r.rules_secondary, r.resolutionSource, r.resolvedBy,
  ].map(asString).join('\n');
}

// Both halves (oracle + tie rule) are required: a known oracle with an unreadable tie rule is not a settlement identity.
export function extractCandleSettlement(
  platform: string,
  raw: unknown,
): CandleSettlement | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = settlementText(raw as Record<string, unknown>);
  if (text.trim() === '') return null;

  let oracle: string | null = null;
  const slug = CHAINLINK_STREAM_RE.exec(text);
  if (slug) {
    const s = slug[1]!.toLowerCase().replace(CHAINLINK_SLUG_DECORATION_RE, '');
    if (s !== '') oracle = `chainlink:${s}`;
  } else if (CF_BENCHMARKS_RE.test(text)) {
    oracle = CF_BENCHMARKS_RTI;
  } else if (BINANCE_RE.test(text)) {
    oracle = BINANCE_CANDLE;
  }
  if (oracle == null) return null;

  const tie =
    TIE_5050_RE.test(text) ? '5050' :
    TIE_UP_RE.test(text)   ? 'up' :
    TIE_DOWN_RE.test(text) ? 'down' :
    null;
  if (tie == null) return null;

  // platform is deliberately not part of the token: same stream + same tie rule is the same question.
  void platform;
  return `${oracle}|tie:${tie}`;
}

// Deliberately empty: no two candle oracles are known to agree in sign within a tick.
export const COMPATIBLE_CANDLE_SETTLEMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [];

// NULL on either side is NOT compatible — the caller decides skip-vs-defer.
export function candleSettlementCompatible(
  a: CandleSettlement | null,
  b: CandleSettlement | null,
): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  return COMPATIBLE_CANDLE_SETTLEMENT_PAIRS.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}

/** The settlement-dimension vocabulary. NULL = unknown (never refuses anything). */
export type SettlementDimension =
  | 'motorsport:race-p1'
  | 'motorsport:constructor-points';

const CONSTRUCTOR_POINTS_RX = 'constructor who scored the most points|highest constructor score';
const RACE_P1_RX = 'finish(es)? in (exactly )?first in the main race';

const CONSTRUCTOR_POINTS_RE = new RegExp(CONSTRUCTOR_POINTS_RX, 'i');
const RACE_P1_RE = new RegExp(RACE_P1_RX, 'i');

// Platform-independent: same quantity across venues yields the same token; constructor-points tested first.
export function extractSettlementDimension(
  platform: string,
  raw: unknown,
): SettlementDimension | null {
  void platform;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // description (PM/Predict/Limitless) + rules_primary (Kalshi) only — never the title.
  const text = `${asString(r.description)}\n${asString(r.rules_primary)}`;
  if (text.trim() === '') return null;
  if (CONSTRUCTOR_POINTS_RE.test(text)) return 'motorsport:constructor-points';
  if (RACE_P1_RE.test(text)) return 'motorsport:race-p1';
  return null;
}

// SQL twin of extractSettlementDimension (same fields/order/literals) for unshaped markets.
export function settlementDimensionSql(rawExpr: string): string {
  const text = `concat_ws(E'\\n', ${rawExpr}->>'description', ${rawExpr}->>'rules_primary')`;
  return `CASE
            WHEN ${text} ~* '${CONSTRUCTOR_POINTS_RX}' THEN 'motorsport:constructor-points'
            WHEN ${text} ~* '${RACE_P1_RX}' THEN 'motorsport:race-p1'
          END`;
}

// Negated SQL twin of settlementDimensionConflict: true (pair kept) unless both sides are
// known and differ.
export function settlementDimensionCompatibleSql(dimExprA: string, dimExprB: string): string {
  return `NOT (
         ${dimExprA} IS NOT NULL AND ${dimExprB} IS NOT NULL
         AND ${dimExprA} IS DISTINCT FROM ${dimExprB}
       )`;
}

// True only when both sides are known and unequal; NULL on either side is not a conflict.
export function settlementDimensionConflict(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a != null && b != null && a !== b;
}

/** The conflicting pair inside a set of dimensions, or null when known dimensions agree. */
export function settlementDimensionSetConflict(
  dims: Iterable<string | null | undefined>,
): [string, string] | null {
  const known = [...new Set([...dims].filter((d): d is string => d != null && d !== ''))].sort();
  return known.length >= 2 ? [known[0], known[1]] : null;
}
