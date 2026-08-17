import type { Cluster } from '../graph/types.js';
import type { PriceCache } from '../clob/price-cache.js';
import type { LPResult, ArbOpportunity, PortfolioLeg, LPProblem } from './types.js';
import {
  gradeExecution,
  applyOmegaGrade,
  DEFAULT_GRADE_THRESHOLDS,
  type GradeThresholds,
  type LegExecutionSignal,
} from './execution-grade.js';
import { computeOmegaAudit, type AuditPosition, type OmegaAudit } from './omega-audit.js';
import { marketToQuestion } from './omega-constraints.js';
import {
  annualizedEdge,
  aswThreshold,
  basketSettlementContext,
  daysToSettlement,
  effectiveLockedCapital,
  type SettlementLegFact,
} from './settlement-economics.js';
import { computeVenueFlag } from './venue-mismatch.js';
import { applyVenueRounding, type VenueRoundingResult } from './venue-constraints.js';

const MIN_SHARES_THRESHOLD = 1e-6;

/**
 * Extract a portfolio from the LP solution.
 * Only includes legs with non-trivial share allocations.
 *
 * Costs/profit are net of fees: the LP objective already folds the
 * per-share fee in, so `result.optimalCost` and the per-leg `cost` are
 * fee-inclusive. The execution grade is attached as an annotation — it never
 * changes which baskets qualify; depth/fee/staleness gating happens earlier
 * in the LP.
 */
export function extractPortfolio(
  result: LPResult,
  problem: LPProblem,
  cluster: Cluster,
  priceCache: PriceCache,
  minProfit: number,
  gradeThresholds: GradeThresholds = DEFAULT_GRADE_THRESHOLDS,
  now: number = Date.now(),
  omegaOpts: { maxStates: number; clusterSizeCap: number } = { maxStates: 10_000, clusterSizeCap: 200 },
): ArbOpportunity | null {
  if (result.status !== 'Optimal') return null;

  // Depth-aware profit-max LP: the objective is `cost - G` (= -profit), so
  // the basket profit is `-optimalCost` and the guaranteed payout is the
  // solved G value. The min-cost-$1 LP normalizes to a $1 guaranteed payout,
  // so its profit is `1 - optimalCost`.
  const ladderMode = problem.guaranteedPayoutVarIndex !== undefined;
  if (!ladderMode && result.optimalCost >= 1.0) return null;

  const guaranteedPayout = ladderMode
    ? result.values[problem.guaranteedPayoutVarIndex!] ?? 0
    : 1.0;
  const profit = ladderMode ? -result.optimalCost : 1.0 - result.optimalCost;
  // The only post-solver filter: a >=minProfit profit floor. All other
  // filtering (ROI%, execution grade, liquidity, settlement carry) is
  // deferred to post-run analysis. Fees + depth caps are applied inside the LP.
  if (profit < minProfit) return null;

  const legs: PortfolioLeg[] = [];
  const legSignals: LegExecutionSignal[] = [];
  const legFacts: SettlementLegFact[] = [];
  let totalCost = 0;
  let totalFees = 0;
  let minLiquidity = Infinity;

  // Depth-aware aggregation: a (marketId, side) leg may be split into several
  // tranche variables. Accumulate each (marketId, side) into a single
  // PortfolioLeg: shares/cost/fee are sums; askPrice becomes the blended
  // average; `depthProfile` records each consumed tranche. The non-ladder
  // path has exactly one variable per (marketId, side).
  interface LegAccum {
    marketId: number;
    platform: PortfolioLeg['platform'];
    side: 'YES' | 'NO';
    shares: number;
    costExFee: number; // Σ shares·askPrice (pre-fee), for the blended price
    feeUsd: number;
    depthProfile: Array<{ price: number; shares: number }>;
  }
  const accums = new Map<string, LegAccum>();
  const order: string[] = [];
  for (const v of problem.variables) {
    // Skip the guaranteed-payout variable G (ladder mode): it is a payout slack,
    // not a tradeable leg (marketId -1).
    if (ladderMode && v.index === problem.guaranteedPayoutVarIndex) continue;
    const shares = result.values[v.index] ?? 0;
    if (shares < MIN_SHARES_THRESHOLD) continue;
    const key = `${v.marketId}:${v.side}`;
    let acc = accums.get(key);
    if (!acc) {
      acc = {
        marketId: v.marketId,
        platform: v.platform,
        side: v.side,
        shares: 0,
        costExFee: 0,
        feeUsd: 0,
        depthProfile: [],
      };
      accums.set(key, acc);
      order.push(key);
    }
    acc.shares += shares;
    acc.costExFee += shares * v.askPrice;
    acc.feeUsd += shares * (v.feePerShare ?? 0);
    acc.depthProfile.push({ price: v.askPrice, shares });
  }

  for (const key of order) {
    const acc = accums.get(key)!;
    const snapshot = priceCache.get(acc.marketId, now);
    const bidPrice = snapshot?.bestBid ?? 0;
    const askSize = snapshot?.askSize ?? 0;
    const bidSize = snapshot?.bidSize ?? 0;
    const shares = acc.shares;
    const feeUsd = acc.feeUsd;
    const cost = acc.costExFee + feeUsd;
    // Blended average price across the consumed tranches (= cost-ex-fee / shares).
    const askPrice = shares > 0 ? acc.costExFee / shares : 0;
    totalCost += cost;
    totalFees += feeUsd;

    // Find the market ref from the cluster (platformId + settlement fields).
    let platformId = '';
    let endDateMs: number | null = null;
    let negRiskEventId: string | null = null;
    for (const [, question] of cluster.questions) {
      const market = question.markets.get(acc.marketId);
      if (market) {
        platformId = market.platformId;
        endDateMs = market.endDateMs ?? null;
        negRiskEventId = market.negRiskEventId ?? null;
        break;
      }
    }
    legFacts.push({ platform: acc.platform, side: acc.side, shares, endDateMs, negRiskEventId });

    const isLadder = acc.depthProfile.length > 1;
    // Liquidity (USD available on the side we lift): non-ladder uses the
    // top-of-book figure (legDepth * askPrice); a depth-aware ladder uses the
    // dollars actually consumed across the filled tranches, i.e. how deep the
    // fill walked.
    const legDepth = acc.side === 'YES' ? askSize : bidSize;
    const legLiquidity = isLadder ? acc.costExFee : legDepth * askPrice;
    if (legLiquidity < minLiquidity) minLiquidity = legLiquidity;

    // Execution signals for the grade.
    const bestAsk = snapshot?.bestAsk ?? 0;
    const bestBid = snapshot?.bestBid ?? 0;
    const mid = (bestAsk + bestBid) / 2;
    const spread = mid > 1e-9 ? Math.max(0, bestAsk - bestBid) / mid : 0;
    const quoteAgeMs = snapshot && snapshot.lastUpdate > 0 ? Math.max(0, now - snapshot.lastUpdate) : 0;
    legSignals.push({ platform: acc.platform, liquidityUsd: legLiquidity, quoteAgeMs, spread });
    // (daysToResolution is attached below, after the basket settlement context
    // is derived with the configured lag table — same index order as legFacts.)

    legs.push({
      marketId: acc.marketId,
      platform: acc.platform,
      platformId,
      side: acc.side,
      shares,
      askPrice,
      bidPrice,
      askSize,
      feeUsd,
      cost,
      label: `BUY ${acc.side} M${acc.marketId} @ $${askPrice.toFixed(3)} on ${acc.platform}`,
      levelsConsumed: acc.depthProfile.length,
      ...(isLadder ? { depthProfile: acc.depthProfile } : {}),
    });
  }

  if (legs.length === 0) return null;

  // Cross-venue settlement risk flag (annotation only — never filters).
  const venueFlag = computeVenueFlag(legs);

  // Settlement economics — annotation only, never gates the LP. tau = days
  // to redemption (end_date + per-platform settlement lag), basket max. PM
  // negRisk NO-baskets recycle (m-1)*min-shares per event, so the
  // annualized-edge denominator is the effective locked capital. The grade
  // demotes (never upgrades) when the annualized edge is below the
  // settlement-frontier curve.
  const settlementCfg = gradeThresholds.settlement;
  const settlementOn = settlementCfg?.enabled === true;
  const lagOpts = { disputed: settlementCfg?.disputedLag === true };
  const ctx = basketSettlementContext(legFacts, now, lagOpts);
  // Attach per-leg horizons for the grader (legSignals[i] ↔ legFacts[i]).
  for (let i = 0; i < legSignals.length; i++) {
    const d = daysToSettlement(legFacts[i].endDateMs, now, legFacts[i].platform, lagOpts);
    if (d != null) legSignals[i].daysToResolution = d;
  }
  const effectiveCapital = effectiveLockedCapital(totalCost, ctx.recycledCapitalUsd);
  const tau = ctx.daysToSettlement;
  const annEdge = settlementOn && tau != null ? annualizedEdge(profit, effectiveCapital, tau) : null;
  const frontier = settlementOn && tau != null && settlementCfg
    ? aswThreshold(tau, settlementCfg.curve)
    : null;

  // Always pass the basket economics: the settlement-frontier demotion inside
  // gradeExecution is independently gated on `thresholds.settlement.enabled`,
  // while the edge-magnitude tripwire needs `netEdgeUsd` regardless of the
  // settlement flag — coupling the tripwire to settlementOn would make
  // disabling settlement silently disable a soundness gate.
  let { grade: executionGrade, reasons: executionReasons } = gradeExecution(
    legSignals,
    gradeThresholds,
    { netEdgeUsd: profit, capitalUsd: effectiveCapital, daysToSettlement: tau },
  );

  // Venue-granularity rounding — annotation only. Only meaningful on the
  // depth-aware ladder path, where the LP solution is the executable plan in
  // absolute shares (the min-cost LP normalizes to a $1 payout, a scale-free
  // rate, so rounding its fractional shares would be meaningless). Round
  // each leg's shares down to the venue's doc-verified granularity, re-price,
  // and demote (never upgrade, never change the basket) when the rounded
  // profit dies or a leg lands below the venue minimum order size.
  const venueRoundingOn = gradeThresholds.venueRounding?.enabled !== false;
  let venueRounding: VenueRoundingResult | null = null;
  if (ladderMode && venueRoundingOn) {
    const vr = applyVenueRounding(problem, result, cluster, profit);
    if (vr.applied) {
      venueRounding = vr;
      executionReasons = [...executionReasons];
      if (vr.belowMinLegs.length > 0) {
        executionGrade = 'risky'; // worst grade — a demotion by construction
        const detail = vr.belowMinLegs
          .map((l) => `${l.side} M${l.marketId} ${l.shares.toFixed(2)}<${l.minOrderShares} on ${l.platform}`)
          .join('; ');
        executionReasons.push(`below venue minimum order size after rounding: ${detail}`);
      }
      if (vr.roundedProfit < minProfit) {
        executionGrade = 'risky';
        executionReasons.push(
          `venue rounding kills profit: $${profit.toFixed(4)} → $${vr.roundedProfit.toFixed(4)} < $${minProfit.toFixed(2)}`,
        );
      }
    }
  }

  // Compute worst-state payout.
  //
  // Facet-form / empty-Ω: an H-rep LPProblem carries no enumerated
  // `validStates`, and a V-rep cluster can also arrive with an empty
  // enumeration. Scanning zero states would leave `worstPayout = Infinity` —
  // a fabricated "infinite guarantee". The sound worst case is the facet
  // certificate itself: the coverage row proves the basket pays >=
  // `guaranteedPayout` over K superset of Ω, so `guaranteedPayout` is a
  // sound lower bound on the worst-world payout.
  let worstPayout: number;
  if (problem.facetForm !== undefined || cluster.validStates.length === 0) {
    worstPayout = guaranteedPayout;
  } else {
    const m2q = marketToQuestion(cluster);
    worstPayout = Infinity;
    for (const state of cluster.validStates) {
      let payout = 0;
      for (const v of problem.variables) {
        // Skip the guaranteed-payout slack G (ladder mode) — not a position.
        if (ladderMode && v.index === problem.guaranteedPayoutVarIndex) continue;
        const shares = result.values[v.index] ?? 0;
        if (shares < MIN_SHARES_THRESHOLD) continue;

        const qid = m2q.get(v.marketId) ?? 0;
        const resolvesYes = state.get(qid) ?? false;
        if ((v.side === 'YES' && resolvesYes) || (v.side === 'NO' && !resolvesYes)) {
          payout += shares;
        }
      }
      if (payout < worstPayout) worstPayout = payout;
    }
  }

  // Ω-liveness audit + soundness grade. Audits every Ω-defining book (the
  // closure of the fired portfolio: all partition siblings + hard-edge
  // neighbours), not just the traded legs. The liveness-relaxed recheck is
  // the refusal authority; a failed recheck / duplicate-suspect basket /
  // pinned Ω forces `blocked` (never persisted).
  const positions: AuditPosition[] = legs.map((l) => ({
    marketId: l.marketId,
    side: l.side,
    shares: l.shares,
  }));
  const omegaAudit: OmegaAudit = computeOmegaAudit(
    cluster,
    positions,
    totalCost,
    minProfit,
    priceCache,
    now,
    omegaOpts,
  );
  {
    const demoted = applyOmegaGrade(executionGrade, executionReasons, omegaAudit);
    executionGrade = demoted.grade;
    executionReasons = demoted.reasons;
  }

  return {
    clusterId: problem.clusterId,
    legs,
    totalCost,
    omegaAudit,
    // Min-cost LP normalizes to a $1 guaranteed payout; the depth-aware profit-max
    // LP guarantees G (= Σ matched shares across the whole basket).
    guaranteedPayout,
    profit,
    profitPct: (profit / totalCost) * 100,
    stateCount: cluster.validStates.length,
    marketCount: cluster.marketIds.size,
    worstEnumeratedStatePayout: worstPayout,
    liquidityUsd: minLiquidity === Infinity ? 0 : minLiquidity,
    feesUsd: totalFees,
    executionGrade,
    executionReasons,
    // Risky arbs persist but never alert/auto-execute; blocked never reaches
    // here (routed to ARB-REFUSED upstream).
    eligibleForAutoExecution: executionGrade === 'clean' || executionGrade === 'caution',
    solveTimeMs: result.solveTimeMs,
    detectedAt: new Date().toISOString(),
    venues: venueFlag.venues,
    settlementVenueMismatch: venueFlag.settlementVenueMismatch,
    // Venue-rounding annotation (only when the pass ran and touched a leg).
    ...(venueRounding
      ? {
          venueRoundedProfit: venueRounding.roundedProfit,
          venueRoundingSharesRemoved: venueRounding.sharesRemoved,
        }
      : {}),
    // Settlement-economics annotation (only populated when the flag is ON).
    ...(settlementOn
      ? {
          daysToSettlement: tau,
          horizonCoverage: ctx.horizonCoverage,
          recycledCapitalUsd: ctx.recycledCapitalUsd,
          effectiveCapitalUsd: effectiveCapital,
          annualizedEdge: annEdge,
          aswThreshold: frontier,
          belowSettlementFrontier:
            annEdge != null && frontier != null && Number.isFinite(annEdge) && annEdge < frontier,
          settlementCurve: settlementCfg
            ? `${settlementCfg.curve.preset}/${settlementCfg.curve.shape}`
            : undefined,
        }
      : {}),
  };
}
