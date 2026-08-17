import type { Cluster, WorldState } from '../graph/types.js';
import type { PriceCache } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { marketToQuestion } from './omega-constraints.js';
import { solveLP } from './solver.js';
import { NO_EXECUTION_GATE } from './types.js';
import type { LPProblem, LPResult, PortfolioLeg, ExecutionParams } from './types.js';

/** How an LPProblem is solved — defaults to the in-process `solveLP`. The daemon
 *  injects `pool.solve` here when SOLVER_WORKER_POOL is on so this rare path also
 *  runs off the event loop. The result/parse contract is identical either way. */
export type SolveFn = (lp: LPProblem) => Promise<LPResult>;
import {
  gradeExecution,
  DEFAULT_GRADE_THRESHOLDS,
  type GradeThresholds,
  worstGrade,
  type ExecutionGrade,
  type LegExecutionSignal,
} from './execution-grade.js';
import {
  basketSettlementContext,
  daysToSettlement,
  effectiveLockedCapital,
  type SettlementLegFact,
} from './settlement-economics.js';
import { computeVenueFlag } from './venue-mismatch.js';

const MIN_SHARES_THRESHOLD = 1e-6;

/**
 * A NON-certified, residual-tail near-arb (Axis 2, r̄>0). Recovered by dropping
 * the all-FALSE world on one or more non-exhaustive categorical sets. It pays $1
 * when a LISTED entity wins but $0 in the residual world (an unlisted outcome
 * wins / none win), so it is a positive-EV BET with a bounded fat tail — never a
 * risk-free arb. `worstStrictStatePayout` (computed over the FULL strict state set,
 * including the residual world) is the honest worst case, typically 0.
 */
export interface GradedResidualOpportunity {
  clusterId: number;
  legs: PortfolioLeg[];
  totalCost: number;
  /** edge = 1 − cost. Positive-EV only if edge > r̄; r̄ is unknown (no priced
   *  residual feed) → this is INFORMATIONAL triage, not an actionable arb. */
  edge: number;
  /** Worst payout over ALL strict states incl. the residual world (≈ 0). */
  worstStrictStatePayout: number;
  /** outcome_set ids whose all-FALSE world was dropped to recover this. */
  residualSetIds: number[];
  stateCount: number;
  marketCount: number;
  liquidityUsd: number;
  feesUsd: number;
  executionGrade: ExecutionGrade;
  executionReasons: string[];
  solveTimeMs: number;
  detectedAt: string;
  /** Distinct venues across the traded legs, first-seen order. */
  venues: string[];
  /** True ⟺ legs span ≥2 venues (independent settlement ⟹ tail risk). Flag only. */
  settlementVenueMismatch: boolean;
}

/**
 * Re-solve a cluster with the all-FALSE world(s) of its non-exhaustive categorical
 * sets DROPPED, to surface effectively-exhaustive near-arbs (open nominee/award/
 * election fields) that the strict worst-case LP rejects. Returns a NON-certified
 * GradedResidualOpportunity, or null when there is nothing to relax or no edge.
 *
 * Only called when the certified solve found nothing, and gated behind a flag
 * (config.execution.gradedResidualChannel, default off), because an unbounded
 * residual tail cannot be EV-floored (r̄ unknown ⟹ strict). It never writes
 * guaranteed_payout=1 and uses a distinct channel; the certified path is
 * untouched.
 */
export async function solveGradedResidual(
  cluster: Cluster,
  priceCache: PriceCache,
  exec: ExecutionParams = NO_EXECUTION_GATE,
  minEdge = 0.01,
  gradeThresholds: GradeThresholds = DEFAULT_GRADE_THRESHOLDS,
  now: number = Date.now(),
  solve: SolveFn = solveLP,
): Promise<GradedResidualOpportunity | null> {
  // The graded residual-tail channel re-solves the V-rep with the all-FALSE
  // world dropped, so it needs a real enumerated `validStates`. A relaxed
  // (over-capped, facet-only) or empty-Ω cluster has none, so there is nothing
  // to relax; refuse.
  if (cluster.relaxed || cluster.validStates.length === 0) return null;

  // Which categorical sets are non-exhaustive (carry an all-FALSE world)?
  const nonExhaustive = cluster.outcomeSets.filter(
    (s) => s.setType === 'categorical' && s.isExhaustive === false && s.slotQuestionIds.length >= 2,
  );
  if (nonExhaustive.length === 0) return null;

  // Drop every strict state in which one of those sets is ALL-FALSE (i.e. assume
  // each non-exhaustive field is, after all, won by a listed entity).
  const isAllFalseForSet = (state: WorldState, slotQids: number[]): boolean =>
    slotQids.every((qid) => state.get(qid) === false);
  const relaxedStates = cluster.validStates.filter(
    (state) => !nonExhaustive.some((s) => isAllFalseForSet(state, s.slotQuestionIds)),
  );
  // No state was actually dropped ⟹ no residual world present ⟹ nothing to recover.
  if (relaxedStates.length === 0 || relaxedStates.length === cluster.validStates.length) return null;

  const relaxedCluster: Cluster = { ...cluster, validStates: relaxedStates };
  const lp = buildLP(relaxedCluster, priceCache, exec);
  if (!lp) return null;

  const result = await solve(lp);
  if (result.status !== 'Optimal' || result.optimalCost >= 1.0) return null;
  const edge = 1.0 - result.optimalCost;
  if (edge < minEdge) return null;

  // Build legs (fee-inclusive) + execution signals — mirrors extractPortfolio.
  const legs: PortfolioLeg[] = [];
  const legSignals: LegExecutionSignal[] = [];
  const legFacts: SettlementLegFact[] = [];
  let totalCost = 0;
  let totalFees = 0;
  let minLiquidity = Infinity;

  for (const v of lp.variables) {
    const shares = result.values[v.index] ?? 0;
    if (shares < MIN_SHARES_THRESHOLD) continue;

    const snapshot = priceCache.get(v.marketId, now);
    const askSize = snapshot?.askSize ?? 0;
    const bidSize = snapshot?.bidSize ?? 0;
    const feeUsd = shares * (v.feePerShare ?? 0);
    const cost = shares * v.askPrice + feeUsd;
    totalCost += cost;
    totalFees += feeUsd;

    let platformId = '';
    let endDateMs: number | null = null;
    let negRiskEventId: string | null = null;
    for (const [, question] of cluster.questions) {
      const m = question.markets.get(v.marketId);
      if (m) {
        platformId = m.platformId;
        endDateMs = m.endDateMs ?? null;
        negRiskEventId = m.negRiskEventId ?? null;
        break;
      }
    }
    legFacts.push({ platform: v.platform, side: v.side, shares, endDateMs, negRiskEventId });

    const legDepth = v.side === 'YES' ? askSize : bidSize;
    const legLiquidity = legDepth * v.askPrice;
    if (legLiquidity < minLiquidity) minLiquidity = legLiquidity;

    const bestAsk = snapshot?.bestAsk ?? 0;
    const bestBid = snapshot?.bestBid ?? 0;
    const mid = (bestAsk + bestBid) / 2;
    const spread = mid > 1e-9 ? Math.max(0, bestAsk - bestBid) / mid : 0;
    const quoteAgeMs = snapshot && snapshot.lastUpdate > 0 ? Math.max(0, now - snapshot.lastUpdate) : 0;
    legSignals.push({ platform: v.platform, liquidityUsd: legLiquidity, quoteAgeMs, spread });

    legs.push({
      marketId: v.marketId, platform: v.platform, platformId, side: v.side,
      shares, askPrice: v.askPrice, bidPrice: snapshot?.bestBid ?? 0, askSize,
      feeUsd, cost,
      label: `BUY ${v.side} M${v.marketId} @ $${v.askPrice.toFixed(3)} on ${v.platform}`,
    });
  }
  if (legs.length === 0) return null;

  // Honest worst case over the FULL strict state set (incl. the residual world):
  // the basket pays $0 there, so this is typically 0. (Converged onto the single
  // `marketToQuestion` reverse-lookup, hoisted out of the per-state loop.)
  const m2q = marketToQuestion(cluster);
  let worstStrictStatePayout = Infinity;
  for (const state of cluster.validStates) {
    let payout = 0;
    for (const v of lp.variables) {
      const shares = result.values[v.index] ?? 0;
      if (shares < MIN_SHARES_THRESHOLD) continue;
      const qid = m2q.get(v.marketId) ?? 0;
      const resolvesYes = state.get(qid) ?? false;
      if ((v.side === 'YES' && resolvesYes) || (v.side === 'NO' && !resolvesYes)) payout += shares;
    }
    if (payout < worstStrictStatePayout) worstStrictStatePayout = payout;
  }

  // Settlement-economics annotation. Same demote-only grading as the certified
  // path: a residual-tail near-arb whose annualized edge sits below the
  // market's own funding frontier is negative-carry even if the listed-field
  // assumption holds.
  const settlementCfg = gradeThresholds.settlement;
  const settlementOn = settlementCfg?.enabled === true;
  const lagOpts = { disputed: settlementCfg?.disputedLag === true };
  const ctx = basketSettlementContext(legFacts, now, lagOpts);
  for (let i = 0; i < legSignals.length; i++) {
    const d = daysToSettlement(legFacts[i].endDateMs, now, legFacts[i].platform, lagOpts);
    if (d != null) legSignals[i].daysToResolution = d;
  }

  let { grade, reasons } = gradeExecution(
    legSignals,
    gradeThresholds,
    settlementOn
      ? {
          netEdgeUsd: edge,
          capitalUsd: effectiveLockedCapital(totalCost, ctx.recycledCapitalUsd),
          daysToSettlement: ctx.daysToSettlement,
        }
      : undefined,
  );

  // The same "no enumeration ⟹ unverified" rung the certified channel applies
  // in `applyOmegaGrade`, restated here because this channel never calls it. A
  // residual opportunity is derived from an enumeration, so
  // `relaxedStates.length === 0` is unreachable here — asserted defensively so
  // that if it ever becomes reachable, the row does not leave alert-eligible.
  if (relaxedStates.length === 0) {
    grade = worstGrade(grade, 'risky');
    reasons = [
      ...reasons,
      'unverified: relaxed-LP objective, no state enumeration backs this profit',
    ];
  }

  return {
    clusterId: cluster.id,
    legs,
    totalCost,
    edge,
    worstStrictStatePayout: worstStrictStatePayout === Infinity ? 0 : worstStrictStatePayout,
    residualSetIds: nonExhaustive.map((s) => s.setId),
    stateCount: relaxedStates.length,
    marketCount: cluster.marketIds.size,
    liquidityUsd: minLiquidity === Infinity ? 0 : minLiquidity,
    feesUsd: totalFees,
    executionGrade: grade,
    executionReasons: reasons,
    solveTimeMs: result.solveTimeMs,
    detectedAt: new Date().toISOString(),
    ...computeVenueFlag(legs),
  };
}
