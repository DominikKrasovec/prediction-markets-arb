/** Single source of truth for each platform's native mutex/residual signal, shared by the
 *  Stage-0 grouping stamp and the Stage-4 certifier. Pure. `nativeMutex` true/false/null means
 *  proven-mutex / proven-independent / no signal (caller falls back to heuristics). */

export type Platform = 'kalshi' | 'polymarket' | 'limitless' | 'predict';

/** A platform-native raw payload (market_metadata_raw.raw / kalshi_events.raw). */
export type NativeRaw = Record<string, unknown> | null | undefined;

function asBoolFlag(v: unknown): boolean | null {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

function isPresent(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** kalshi is the only platform that can return a positive `false` (a settlement fact). */
export function nativeMutex(platform: Platform, raw: NativeRaw): boolean | null {
  if (!raw) return null;
  switch (platform) {
    case 'kalshi':
      return asBoolFlag(raw['mutually_exclusive']);
    case 'polymarket':
      return asBoolFlag(raw['negRisk']) === true ? true : null;
    case 'limitless':
      if (isPresent(raw['negRiskMarketId'])) return true;
      return null;
    case 'predict':
      if (asBoolFlag(raw['isNegRisk']) === true) return true;
      return null;
    default:
      return null;
  }
}

// Deliberately narrow; kept in lock-step with placeholder-outcomes.ts OMEGA_RESIDUAL_RX.
export const NATIVE_RESIDUAL_RX =
  /^(?:other|the field|tbd|n\/a|draw|tie)$|\bends? in a (?:draw|tie)\b|\b(?:another (?:candidate|party|chef|team|player|contestant|driver|entrant|golfer|wrestler|fighter|option|nominee|name|club)|any other|the field)\b/i;

/** Tested against the bare label first (anchored), then the full title (Predict ships full
 *  titles like "Will X vs Y end in a draw?"). NULL-tolerant. */
export function nativeResidual(
  _platform: Platform,
  _raw: NativeRaw,
  label: string | null | undefined,
  title: string | null | undefined,
): boolean {
  return (
    NATIVE_RESIDUAL_RX.test((label ?? '').trim()) || NATIVE_RESIDUAL_RX.test((title ?? '').trim())
  );
}

// Canonical field-set for a fixture's DRAW slot (match_winner/halftime_leader only); NOT for
// award "Tie", UFC "no contest", or cricket side-prop "Draw" — different settlement semantics.
export const NATIVE_DRAW_SUBJECT = 'Draw';
export const NATIVE_DRAW_LABEL = 'draw';

export interface NativeDrawFields {
  subject_raw: string;
  outcome_label: string;
}

export function nativeDraw(): NativeDrawFields {
  return { subject_raw: NATIVE_DRAW_SUBJECT, outcome_label: NATIVE_DRAW_LABEL };
}

// PM's uppercase negRiskMarketID is deliberately omitted — present on negRisk:'false' markets too.
export function NATIVE_MUTEX_SQL(alias: string): string {
  return (
    `(${alias}.raw->>'negRisk' = 'true'` +
    ` OR ${alias}.raw->>'isNegRisk' = 'true'` +
    ` OR ${alias}.raw->>'negRiskMarketId' IS NOT NULL)`
  );
}
