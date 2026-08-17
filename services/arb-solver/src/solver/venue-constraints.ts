import type { Platform } from '@arb/types';
import type { Cluster } from '../graph/types.js';
import type { LPProblem, LPResult } from './types.js';

// Per-venue execution micro-structure (tick/min-order/share-step), verified from official
// docs only; null = undocumented, and the rounding pass skips null fields (passthrough).
export interface VenueExecutionConstraints {
  // false: the rounding pass skips this venue entirely.
  verified: boolean;
  // Shares are rounded DOWN to a multiple of this; null = no share rounding.
  shareStep: number | null;
  // null = no minimum check; a leg landing below this (or zeroed) is flagged.
  minOrderShares: number | null;
  sources: string[];
}

export const VENUE_EXECUTION_CONSTRAINTS: Record<Platform, VenueExecutionConstraints> = {
  kalshi: {
    verified: true,
    shareStep: 1,
    minOrderShares: 1,
    sources: [
      'https://docs.kalshi.com/getting_started/fixed_point_migration',
      'https://docs.kalshi.com/api-reference/market/get-market',
    ],
  },
  polymarket: {
    verified: true,
    shareStep: null,
    minOrderShares: 5,
    sources: [
      'https://docs.polymarket.com/trading/orderbook',
      'https://docs.polymarket.com/developers/CLOB/orders/create-order',
    ],
  },
  limitless: {
    verified: false,
    shareStep: null,
    minOrderShares: null,
    sources: ['https://docs.limitless.exchange/api-reference/trading/create-order'],
  },
  predict: {
    verified: false,
    shareStep: null,
    minOrderShares: null,
    sources: [
      'https://dev.predict.fun/create-an-order-32534694e0',
      'https://dev.predict.fun/get-markets-25326905e0',
    ],
  },
};

const MIN_SHARES_THRESHOLD = 1e-6;

// Epsilon absorbs FP-noise so a step-multiple-up-to-float-error value (3.9999999998) stays
// 4; must match the solver's own dust convention (MIN_SHARES_THRESHOLD) or a within-dust
// integer plan loses a whole contract and gets falsely demoted.
export function floorToStep(shares: number, step: number): number {
  return Math.floor(shares / step + MIN_SHARES_THRESHOLD) * step;
}

export interface BelowMinLeg {
  marketId: number;
  side: 'YES' | 'NO';
  platform: Platform;
  shares: number;
  minOrderShares: number;
}

export interface VenueRoundingResult {
  applied: boolean;
  // Worst-state payout at rounded shares minus rounded cost, capped at the LP profit so
  // this pass can never report MORE profit than the solve did.
  roundedProfit: number;
  sharesRemoved: number;
  belowMinLegs: BelowMinLeg[];
}

// Post-solve venue-granularity rounding, tightening-only: every variable's shares round
// DOWN (never up) per-tranche, the basket is re-priced exactly at the rounded shares, and
// unverified venues pass through byte-identical. Demotion-only signal for the caller — this
// function never changes the basket that is actually reported.
export function applyVenueRounding(
  problem: LPProblem,
  result: LPResult,
  cluster: Cluster,
  lpProfit: number,
  constraints: Record<Platform, VenueExecutionConstraints> = VENUE_EXECUTION_CONSTRAINTS,
): VenueRoundingResult {
  const ladderMode = problem.guaranteedPayoutVarIndex !== undefined;

  const qidByMarket = new Map<number, number>();
  for (const [, question] of cluster.questions) {
    for (const mid of question.markets.keys()) qidByMarket.set(mid, question.questionId);
  }

  let applied = false;
  let sharesRemoved = 0;
  let roundedCost = 0;
  const roundedByVar = new Map<number, number>();
  const aggOriginal = new Map<string, number>();
  const aggRounded = new Map<string, { marketId: number; side: 'YES' | 'NO'; platform: Platform; shares: number }>();

  for (const v of problem.variables) {
    if (ladderMode && v.index === problem.guaranteedPayoutVarIndex) continue;
    const shares = result.values[v.index] ?? 0;
    if (shares < MIN_SHARES_THRESHOLD) continue;

    const c = constraints[v.platform];
    let rounded = shares;
    if (c?.verified) {
      applied = true;
      if (c.shareStep != null) rounded = floorToStep(shares, c.shareStep);
    }
    roundedByVar.set(v.index, rounded);
    sharesRemoved += shares - rounded;
    roundedCost += rounded * (v.askPrice + (v.feePerShare ?? 0));

    const key = `${v.marketId}:${v.side}`;
    aggOriginal.set(key, (aggOriginal.get(key) ?? 0) + shares);
    const agg = aggRounded.get(key);
    if (agg) agg.shares += rounded;
    else aggRounded.set(key, { marketId: v.marketId, side: v.side, platform: v.platform, shares: rounded });
  }

  // Facet-form / empty-Ω: no enumerated states to scan, so the bound comes from the facet
  // certificate G minus sharesRemoved — an understated bound, same direction as the state scan.
  let worstPayout: number;
  if (problem.facetForm !== undefined || cluster.validStates.length === 0) {
    const g = result.values[problem.guaranteedPayoutVarIndex!] ?? 0;
    worstPayout = Math.max(0, g - sharesRemoved);
  } else {
    worstPayout = Infinity;
    for (const state of cluster.validStates) {
      let payout = 0;
      for (const [index, rounded] of roundedByVar) {
        if (rounded <= 0) continue;
        const v = problem.variables[index];
        const resolvesYes = state.get(qidByMarket.get(v.marketId) ?? 0) ?? false;
        if ((v.side === 'YES' && resolvesYes) || (v.side === 'NO' && !resolvesYes)) payout += rounded;
      }
      if (payout < worstPayout) worstPayout = payout;
    }
    if (!Number.isFinite(worstPayout)) worstPayout = 0;
  }

  const roundedProfit = Math.min(lpProfit, worstPayout - roundedCost);

  const belowMinLegs: BelowMinLeg[] = [];
  for (const [key, agg] of aggRounded) {
    const c = constraints[agg.platform];
    if (!c?.verified || c.minOrderShares == null) continue;
    const original = aggOriginal.get(key) ?? 0;
    // Only a leg the LP actually allocated (original > 0) counts as below-minimum.
    if (original >= MIN_SHARES_THRESHOLD && agg.shares < c.minOrderShares - 1e-9) {
      belowMinLegs.push({
        marketId: agg.marketId,
        side: agg.side,
        platform: agg.platform,
        shares: agg.shares,
        minOrderShares: c.minOrderShares,
      });
    }
  }

  return { applied, roundedProfit, sharesRemoved, belowMinLegs };
}
