import { query } from '@arb/db';
import type { ArbOpportunity } from './solver/types.js';
import type { GradedResidualOpportunity } from './solver/graded-residual.js';
import type { PriceSnapshot } from './clob/price-cache.js';

/**
 * Persist an LP-detected arbitrage opportunity to the database.
 */
export async function persistOpportunity(opp: ArbOpportunity): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO arbitrage_opportunities
       (arb_type, antecedent_platform, consequent_platform, strategy,
        legs, cost, max_profit, basis_risk, basis_risk_detail, current,
        cluster_id, portfolio_cost, guaranteed_payout, solve_time_ms,
        state_count, market_count, worst_state_payout, liquidity_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE,
             $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      'lp_solver',
      opp.legs[0]?.platform ?? 'unknown',
      opp.legs.length > 1 ? opp.legs[opp.legs.length - 1].platform : opp.legs[0]?.platform ?? 'unknown',
      `cluster_${opp.clusterId}`,
      JSON.stringify(opp.legs),
      opp.totalCost,
      opp.profit,
      'none', // certified arb (worst-case LP); the graded residual_tail channel sets this
      // Execution profile in the (text) detail column: grade, reasons, fees
      // already folded into cost/profit, and the cross-venue settlement-risk
      // flag (legs spanning >=2 venues settle independently — tail risk, not
      // guaranteed). Annotation only — never filters the arb.
      JSON.stringify({
        execution_grade: opp.executionGrade,
        execution_reasons: opp.executionReasons,
        fees_usd: opp.feesUsd,
        settlement_venue_mismatch: opp.settlementVenueMismatch,
        venues: opp.venues,
      }),
      opp.clusterId,
      opp.totalCost,
      opp.guaranteedPayout,
      opp.solveTimeMs,
      opp.stateCount,
      opp.marketCount,
      opp.worstEnumeratedStatePayout,
      opp.liquidityUsd,
    ]
  );
  return rows[0]?.id ?? 0;
}

/**
 * Persist a NON-certified graded residual-tail near-arb (Axis 2, r̄>0). Written to
 * a SEPARATE channel so it can never be mistaken for a risk-free arb:
 * arb_type='lp_solver_graded', basis_risk='residual_tail', guaranteed_payout =
 * the honest worst-case payout (≈ $0 in the residual world — NOT 1). ON CONFLICT
 * refreshes so re-detection of the same cluster does not throw on the unique key.
 */
export async function persistGradedResidual(opp: GradedResidualOpportunity): Promise<number> {
  const detail = JSON.stringify({
    note: 'NON-CERTIFIED residual-tail bet — pays $0 if an unlisted outcome wins; surface only when edge > r̄ (r̄ unknown ⟹ informational triage, never auto-trade as risk-free).',
    residual_set_ids: opp.residualSetIds,
    edge: opp.edge,
    execution_grade: opp.executionGrade,
    execution_reasons: opp.executionReasons,
    fees_usd: opp.feesUsd,
    settlement_venue_mismatch: opp.settlementVenueMismatch,
    venues: opp.venues,
  });
  const rows = await query<{ id: number }>(
    `INSERT INTO arbitrage_opportunities
       (arb_type, antecedent_platform, consequent_platform, strategy,
        legs, cost, max_profit, basis_risk, basis_risk_detail, current,
        cluster_id, portfolio_cost, guaranteed_payout, solve_time_ms,
        state_count, market_count, worst_state_payout, liquidity_usd)
     VALUES ('lp_solver_graded', $1, $2, $3, $4, $5, $6, 'residual_tail', $7, TRUE,
             $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (arb_type, antecedent_platform, consequent_platform, strategy)
       DO UPDATE SET legs = EXCLUDED.legs, cost = EXCLUDED.cost,
         max_profit = EXCLUDED.max_profit, basis_risk_detail = EXCLUDED.basis_risk_detail,
         current = TRUE, portfolio_cost = EXCLUDED.portfolio_cost,
         guaranteed_payout = EXCLUDED.guaranteed_payout, solve_time_ms = EXCLUDED.solve_time_ms,
         state_count = EXCLUDED.state_count, market_count = EXCLUDED.market_count,
         worst_state_payout = EXCLUDED.worst_state_payout, liquidity_usd = EXCLUDED.liquidity_usd,
         detected_at = NOW()
     RETURNING id`,
    [
      opp.legs[0]?.platform ?? 'unknown',
      opp.legs.length > 1 ? opp.legs[opp.legs.length - 1].platform : opp.legs[0]?.platform ?? 'unknown',
      `cluster_${opp.clusterId}`,
      JSON.stringify(opp.legs),
      opp.totalCost,
      opp.edge,
      detail,
      opp.clusterId,
      opp.totalCost,
      opp.worstStrictStatePayout, // honest: NOT guaranteed (≈ 0 in the residual world)
      opp.solveTimeMs,
      opp.stateCount,
      opp.marketCount,
      opp.worstStrictStatePayout,
      opp.liquidityUsd,
    ]
  );
  return rows[0]?.id ?? 0;
}

/**
 * Expire LP-solver opportunities (certified + graded) that are no longer detected.
 */
export async function expireStaleOpportunities(activeClusterIds: number[]): Promise<number> {
  if (activeClusterIds.length === 0) {
    const rows = await query<{ count: string }>(
      `WITH updated AS (
         UPDATE arbitrage_opportunities SET current = FALSE
         WHERE arb_type IN ('lp_solver','lp_solver_graded') AND current = TRUE
         RETURNING 1
       ) SELECT count(*)::text AS count FROM updated`
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  const rows = await query<{ count: string }>(
    `WITH updated AS (
       UPDATE arbitrage_opportunities SET current = FALSE
       WHERE arb_type IN ('lp_solver','lp_solver_graded') AND current = TRUE
         AND cluster_id IS NOT NULL AND cluster_id != ALL($1::int[])
       RETURNING 1
     ) SELECT count(*)::text AS count FROM updated`,
    [activeClusterIds]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Batch-persist live CLOB prices to the clob_prices table.
 */
export async function persistPrices(snapshots: PriceSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;

  // Build multi-row upsert
  const values: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const s of snapshots) {
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, 'clob', NOW())`);
    params.push(s.marketId, s.bestBid, s.bestAsk, s.bidSize, s.askSize);
  }

  await query(
    `INSERT INTO clob_prices (market_id, best_bid, best_ask, bid_size, ask_size, source, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (market_id) DO UPDATE SET
       best_bid = EXCLUDED.best_bid,
       best_ask = EXCLUDED.best_ask,
       bid_size = EXCLUDED.bid_size,
       ask_size = EXCLUDED.ask_size,
       updated_at = NOW()`,
    params
  );
}
