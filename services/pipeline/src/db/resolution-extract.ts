/**
 * Platform-native resolution extraction: pure mappers, raw scraper payload ->
 * { resolved_at, winning_outcome, outcomes, source }. Never guess: unresolved
 * or ambiguous returns null; timestamps prefer platform-native, else `observedAt`.
 */
import type { Platform } from '@arb/types';

export const PM_VOID_SENTINEL = 'VOID_5050';
export const KALSHI_VOID_SENTINEL = 'VOID';

/** Field semantics: `resolved_at` platform-native else observedAt else null; `winning_outcome` null means resolved but winner unknown. */
export interface ExtractedResolution {
  resolved_at: Date | null;
  winning_outcome: string | null;
  outcomes: string[] | null;
  source: string;
}

function parseDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    if (typeof v === 'string' && v.trim() === '') return null;
    const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : (v as any));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Tolerates a JSON-encoded string (Gamma stores `outcomes`/`outcomePrices` as '["Yes","No"]'). */
function parseStringArray(v: unknown): string[] | null {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return null; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((x) => String(x));
}

function parseNumberArray(v: unknown): number[] | null {
  const strs = parseStringArray(v);
  if (!strs) return null;
  const nums = strs.map((s) => Number(s));
  return nums.some((n) => !Number.isFinite(n)) ? null : nums;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

/** 'determined' (result known, settlement pending) resolves only when `result` is also populated. */
const KALSHI_SETTLED_STATUSES = new Set(['settled', 'finalized']);

export function extractKalshiResolution(
  raw: any,
  observedAt?: Date | null,
): ExtractedResolution | null {
  const status = String(raw?.status ?? '').toLowerCase();
  const result = String(raw?.result ?? '').toLowerCase();
  const resultKnown = result === 'yes' || result === 'no' || result === 'void';

  // Resolved iff fully settled, or `result` is already final — result is THE settlement field.
  if (!KALSHI_SETTLED_STATUSES.has(status) && !resultKnown) return null;

  const winning =
    result === 'yes' ? 'Yes'
    : result === 'no' ? 'No'
    : result === 'void' ? KALSHI_VOID_SENTINEL
    : null; // settled with empty/unrecognized result (e.g. scalar) → amendable later

  const marketType = raw?.market_type == null ? null : String(raw.market_type);
  const outcomes = marketType === null || marketType === 'binary' ? ['Yes', 'No'] : null;

  const native =
    parseDate(raw?.settled_time) ??
    parseDate(raw?.settlement_timestamp) ??
    parseDate(raw?.close_time) ??
    parseDate(raw?.expiration_time);

  return {
    resolved_at: native ?? observedAt ?? null,
    winning_outcome: winning,
    outcomes,
    source: `pipeline-sync/kalshi:${resultKnown ? 'result' : 'status'}${native ? '' : '@observed'}`,
  };
}

export function extractPolymarketResolution(
  raw: any,
  observedAt?: Date | null,
): ExtractedResolution | null {
  // Gate 1: closed or UMA-resolved — outcomePrices alone is not a signal (an OPEN market's live midpoint is often exactly [0.5,0.5]).
  const closed = asBool(raw?.closed);
  const umaResolved = String(raw?.umaResolutionStatus ?? '').toLowerCase() === 'resolved';
  if (!closed && !umaResolved) return null;

  const outcomes = parseStringArray(raw?.outcomes);
  const prices = parseNumberArray(raw?.outcomePrices);
  if (!outcomes || !prices || outcomes.length !== prices.length) return null;

  // Gate 2: prices must be settlement-shaped (0/0.5/1 @2dp) — a closed market not yet UMA-finalized is not resolved.
  const rounded = prices.map((p) => Math.round(p * 100) / 100);
  if (!rounded.every((p) => p === 0 || p === 0.5 || p === 1)) return null;

  const winnerIdxs = rounded.flatMap((p, i) => (p === 1 ? [i] : []));
  let winning: string | null = null;
  if (winnerIdxs.length === 1 && rounded.every((p, i) => i === winnerIdxs[0] || p === 0)) {
    winning = outcomes[winnerIdxs[0]] ?? null;
  } else if (rounded.every((p) => p === 0.5)) {
    winning = PM_VOID_SENTINEL;
  }
  // else: ambiguous shapes (e.g. ["1","1"], a Gamma DB error) — never guess, resolved with winner null.

  const native =
    parseDate(raw?.closedTime) ??
    parseDate(raw?.umaEndDate) ??
    parseDate(raw?.updatedAt);

  return {
    resolved_at: native ?? observedAt ?? null,
    winning_outcome: winning,
    outcomes,
    source: `pipeline-sync/polymarket:closed+outcomePrices${native ? '' : '@observed'}`,
  };
}

export function extractPredictResolution(
  raw: any,
  observedAt?: Date | null,
): ExtractedResolution | null {
  // 'REMOVED' is delisting, not resolution.
  if (String(raw?.status ?? '').toUpperCase() !== 'RESOLVED') return null;

  let resolution: any = raw?.resolution;
  if (typeof resolution === 'string') {
    try { resolution = JSON.parse(resolution); } catch { resolution = null; }
  }

  let outcomesArr: any[] | null = Array.isArray(raw?.outcomes) ? raw.outcomes : null;
  if (outcomesArr === null && typeof raw?.outcomes === 'string') {
    try {
      const parsed = JSON.parse(raw.outcomes);
      outcomesArr = Array.isArray(parsed) ? parsed : null;
    } catch { outcomesArr = null; }
  }

  let winning: string | null =
    resolution && typeof resolution.name === 'string' && resolution.name !== ''
      ? resolution.name
      : null;
  if (winning === null && outcomesArr) {
    // Fallback: the unique outcomes[] entry with status='WON'; 0 or >1 matches returns null.
    const won = outcomesArr.filter((o) => o && o.status === 'WON');
    if (won.length === 1 && typeof won[0].name === 'string' && won[0].name !== '') {
      winning = won[0].name;
    }
  }

  const labels = outcomesArr
    ? outcomesArr.map((o) => String(o?.name ?? '')).filter((s) => s !== '')
    : [];

  // No Predict API field carries a resolution timestamp — observedAt is the only source.
  return {
    resolved_at: observedAt ?? null,
    winning_outcome: winning,
    outcomes: labels.length > 0 ? labels : null,
    source: 'pipeline-sync/predict:status@observed',
  };
}

export function extractLimitlessResolution(
  raw: any,
  observedAt?: Date | null,
): ExtractedResolution | null {
  // Exploded group sub-markets inherit the parent's status/winningOutcomeIndex via spread — never extract here.
  if (raw?._limitlessEventId != null) return null;

  const status = String(raw?.status ?? '').toUpperCase();
  const idxRaw = raw?.winningOutcomeIndex;
  const idx = idxRaw == null || idxRaw === '' ? null : Number(idxRaw);
  const hasIdx = idx !== null && Number.isInteger(idx) && idx >= 0;

  // `expired=true` alone is deliberately not a resolution signal — the deadline passing doesn't mean the oracle has resolved.
  if (status !== 'RESOLVED' && !hasIdx) return null;

  const tokens = parseStringArray(raw?.outcomeTokens);
  let winning: string | null = null;
  if (hasIdx) {
    if (tokens && idx! < tokens.length) {
      winning = tokens[idx!];
    } else if (idx === 0) {
      winning = 'Yes';
    } else if (idx === 1) {
      winning = 'No';
    }
  } else if (typeof raw?.winningOutcome === 'string' && raw.winningOutcome !== '') {
    winning = raw.winningOutcome;
  }

  const native = parseDate(raw?.resolutionDate);
  return {
    resolved_at: native ?? observedAt ?? null,
    winning_outcome: winning,
    outcomes: tokens,
    source: `pipeline-sync/limitless:${hasIdx ? 'winningOutcomeIndex' : 'status'}${native ? '' : '@observed'}`,
  };
}

/** Extract platform-native resolution; null means the payload does not prove resolution. `observedAt` is the deterministic fallback timestamp. */
export function extractResolution(
  platform: Platform,
  raw: any,
  observedAt?: Date | null,
): ExtractedResolution | null {
  switch (platform) {
    case 'kalshi':     return extractKalshiResolution(raw, observedAt);
    case 'polymarket': return extractPolymarketResolution(raw, observedAt);
    case 'predict':    return extractPredictResolution(raw, observedAt);
    case 'limitless':  return extractLimitlessResolution(raw, observedAt);
  }
}
