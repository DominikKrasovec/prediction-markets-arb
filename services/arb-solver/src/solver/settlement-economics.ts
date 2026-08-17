import type { Platform } from '@arb/types';

/**
 * Settlement economics: an "arb" whose annualized edge is below the market's
 * own annualized settlement wedge (ASW) at its lock-up horizon is negative-carry
 * money relative to that frontier, even when the LP certifies it risk-free.
 * Everything here is PURE and annotation-grade: it informs grading/reporting,
 * never the LP's soundness.
 */

export type AswPreset = 'min' | 'p01' | 'conservative';
export type AswShape = 'flat' | 'hump';

export interface AswCurve {
  preset: AswPreset;
  shape: AswShape;
}

export const ASW_PRESET_RATES: Record<AswPreset, number> = {
  min: 0.0306,
  p01: 0.0436,
  conservative: 0.0689,
};

export const DEFAULT_ASW_CURVE: AswCurve = { preset: 'min', shape: 'flat' };

/** Annualizing a sub-day lock-up would explode the exponent into meaninglessness. */
export const MIN_LOCKUP_DAYS = 1;

/** Shape-only knots, normalized at module load so the 0–350d mean multiplier is exactly 1. */
const HUMP_KNOTS_RAW: ReadonlyArray<readonly [number, number]> = [
  [0, 1.8],
  [5, 1.4],
  [20, 0.85],
  [90, 0.85],
  [150, 1.0],
  [230, 1.35],
  [260, 1.35],
  [350, 1.1],
];

function knotMean(knots: ReadonlyArray<readonly [number, number]>): number {
  let area = 0;
  for (let i = 1; i < knots.length; i++) {
    const [d0, m0] = knots[i - 1];
    const [d1, m1] = knots[i];
    area += ((m0 + m1) / 2) * (d1 - d0);
  }
  const span = knots[knots.length - 1][0] - knots[0][0];
  return span > 0 ? area / span : 1;
}

const HUMP_NORM = knotMean(HUMP_KNOTS_RAW);
const HUMP_KNOTS: ReadonlyArray<readonly [number, number]> = HUMP_KNOTS_RAW.map(
  ([d, m]) => [d, m / HUMP_NORM] as const,
);

function humpMultiplier(days: number): number {
  const first = HUMP_KNOTS[0];
  const last = HUMP_KNOTS[HUMP_KNOTS.length - 1];
  if (days <= first[0]) return first[1];
  if (days >= last[0]) return last[1];
  for (let i = 1; i < HUMP_KNOTS.length; i++) {
    const [d1, m1] = HUMP_KNOTS[i];
    if (days <= d1) {
      const [d0, m0] = HUMP_KNOTS[i - 1];
      const t = (days - d0) / (d1 - d0);
      return m0 + t * (m1 - m0);
    }
  }
  return last[1];
}

export function aswThreshold(days: number, curve: AswCurve = DEFAULT_ASW_CURVE): number {
  const base = ASW_PRESET_RATES[curve.preset];
  if (curve.shape === 'flat') return base;
  return base * humpMultiplier(Math.max(0, days));
}

/**
 * capital ≤ 0 → +∞ when edge > 0 (fully recycled ⟹ free carry), else 0.
 * gross ≤ 0 → −1 (total-loss floor). Non-finite inputs → NaN (caller must not demote on NaN).
 */
export function annualizedEdge(
  netEdgeUsd: number,
  capitalUsd: number,
  daysToResolution: number,
): number {
  if (!Number.isFinite(netEdgeUsd) || !Number.isFinite(capitalUsd) || !Number.isFinite(daysToResolution)) {
    return NaN;
  }
  if (capitalUsd <= 0) return netEdgeUsd > 0 ? Infinity : 0;
  const gross = 1 + netEdgeUsd / capitalUsd;
  if (gross <= 0) return -1;
  const days = Math.max(daysToResolution, MIN_LOCKUP_DAYS);
  return Math.pow(gross, 365 / days) - 1;
}

/** D(τ) implied by an annualized rate: D = (1 + asw)^(−τ/365). */
export function discountFactor(days: number, aswRate: number): number {
  if (!Number.isFinite(days) || !Number.isFinite(aswRate) || days <= 0) return 1;
  return Math.pow(1 + Math.max(0, aswRate), -days / 365);
}

export interface SettlementLag {
  undisputedDays: number;
  disputedP95Days: number;
}

export const DEFAULT_SETTLEMENT_LAGS: Record<Platform, SettlementLag> = {
  polymarket: { undisputedDays: 1, disputedP95Days: 7 },
  kalshi: { undisputedDays: 1, disputedP95Days: 1 },
  predict: { undisputedDays: 2, disputedP95Days: 7 },
  limitless: { undisputedDays: 1, disputedP95Days: 7 },
};

export interface SettlementLagOptions {
  disputed?: boolean;
  lags?: Partial<Record<Platform, SettlementLag>>;
}

export function settlementLagDays(platform: Platform, opts: SettlementLagOptions = {}): number {
  const lag = opts.lags?.[platform] ?? DEFAULT_SETTLEMENT_LAGS[platform];
  return opts.disputed ? lag.disputedP95Days : lag.undisputedDays;
}

/** Returns null when the end date is unknown; caller must treat that as "cannot prove below-frontier". */
export function daysToSettlement(
  endDateMs: number | null | undefined,
  nowMs: number,
  platform: Platform,
  opts: SettlementLagOptions = {},
): number | null {
  if (endDateMs == null || !Number.isFinite(endDateMs)) return null;
  const horizonDays = Math.max(0, (endDateMs - nowMs) / 86_400_000);
  return horizonDays + settlementLagDays(platform, opts);
}

export interface NegRiskRecycle {
  nettableUnits: number;
  /** (m − 1) · nettableUnits. */
  recycledUsd: number;
}

/** Conversion needs a COMPLETE NO-subset, so the nettable unit count is min(shares) across the m legs. */
export function negRiskRecycledCapital(noLegShares: number[]): NegRiskRecycle {
  const m = noLegShares.length;
  if (m < 2 || noLegShares.some((s) => !Number.isFinite(s) || s < 0)) {
    return { nettableUnits: 0, recycledUsd: 0 };
  }
  const nettableUnits = Math.min(...noLegShares);
  return { nettableUnits, recycledUsd: (m - 1) * nettableUnits };
}

export function effectiveLockedCapital(grossCapitalUsd: number, recycledUsd: number): number {
  return Math.max(0, grossCapitalUsd - Math.max(0, recycledUsd));
}

export type MarketStructure =
  | { kind: 'binary' }
  | { kind: 'negRisk'; nOutcomes: number };

/** Kalshi pays collateral APY (offsets the wedge's opportunity cost); floors the residual at this share of the binary rate. */
export const KALSHI_COLLATERAL_APY = 0.04;
export const KALSHI_RESIDUAL_WEDGE_SHARE = 0.25;

export interface WedgeOptions {
  curve?: AswCurve;
  aswRateOverride?: number;
  kalshiCollateralApy?: number;
  kalshiResidualWedgeShare?: number;
}

/** negRisk conversion divides the binary wedge across the n−1 nettable NO legs. */
export function settlementWedge(
  platform: Platform,
  structure: MarketStructure,
  days: number,
  opts: WedgeOptions = {},
): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const base = opts.aswRateOverride ?? aswThreshold(days, opts.curve ?? DEFAULT_ASW_CURVE);
  const apy = opts.kalshiCollateralApy ?? KALSHI_COLLATERAL_APY;
  const floorShare = opts.kalshiResidualWedgeShare ?? KALSHI_RESIDUAL_WEDGE_SHARE;
  const rate = platform === 'kalshi' ? Math.max(base - apy, base * floorShare) : base;
  let wedge = 1 - discountFactor(days, rate);
  if (structure.kind === 'negRisk') {
    wedge /= Math.max(1, structure.nOutcomes - 1);
  }
  return wedge;
}

export interface ParitySide {
  platform: Platform;
  structure: MarketStructure;
}

export interface ParityWedge {
  wedgeA: number;
  wedgeB: number;
  combinedWedge: number;
  /** Two discounted near-certain complements price at ≈ 1 − wedgeA − wedgeB, not exactly 1. */
  parityBandCenter: number;
}

export function expectedParityWedge(
  a: ParitySide,
  b: ParitySide,
  days: number,
  opts: WedgeOptions = {},
): ParityWedge {
  const wedgeA = settlementWedge(a.platform, a.structure, days, opts);
  const wedgeB = settlementWedge(b.platform, b.structure, days, opts);
  return { wedgeA, wedgeB, combinedWedge: wedgeA + wedgeB, parityBandCenter: 1 - wedgeA - wedgeB };
}

export interface SettlementLegFact {
  platform: Platform;
  side: 'YES' | 'NO';
  shares: number;
  /** null/undefined = unknown horizon. */
  endDateMs: number | null | undefined;
  /** PM negRiskMarketID; null = not negRisk. */
  negRiskEventId: string | null | undefined;
}

export interface BasketSettlementContext {
  /** MAX over legs with a known end date (locked until the last leg settles); with partial
   *  coverage this is a LOWER bound, which only overstates the annualized edge. */
  daysToSettlement: number | null;
  horizonCoverage: number;
  recycledCapitalUsd: number;
}

export function basketSettlementContext(
  legs: SettlementLegFact[],
  nowMs: number,
  opts: SettlementLagOptions = {},
): BasketSettlementContext {
  let maxDays: number | null = null;
  let known = 0;
  const noBaskets = new Map<string, number[]>();

  for (const leg of legs) {
    const d = daysToSettlement(leg.endDateMs, nowMs, leg.platform, opts);
    if (d != null) {
      known++;
      if (maxDays == null || d > maxDays) maxDays = d;
    }
    if (leg.side === 'NO' && leg.negRiskEventId) {
      const arr = noBaskets.get(leg.negRiskEventId);
      if (arr) arr.push(leg.shares);
      else noBaskets.set(leg.negRiskEventId, [leg.shares]);
    }
  }

  let recycledCapitalUsd = 0;
  for (const shares of noBaskets.values()) {
    recycledCapitalUsd += negRiskRecycledCapital(shares).recycledUsd;
  }

  return {
    daysToSettlement: maxDays,
    horizonCoverage: legs.length > 0 ? known / legs.length : 0,
    recycledCapitalUsd,
  };
}
