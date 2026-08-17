import { publish } from '@arb/event-bus';
import type { ArbOpportunity } from './solver/types.js';

export async function publishArbDetected(opp: ArbOpportunity): Promise<void> {
  try {
    await publish({
      channel: 'arbitrage',
      type: 'arb:detected',
      data: {
        source: 'lp_solver',
        clusterId: opp.clusterId,
        profit: opp.profit,
        profitPct: opp.profitPct,
        totalCost: opp.totalCost,
        legCount: opp.legs.length,
        marketCount: opp.marketCount,
        stateCount: opp.stateCount,
        liquidityUsd: opp.liquidityUsd,
        solveTimeMs: opp.solveTimeMs,
      },
    });
  } catch {
    // Event bus may not be running
  }
}

export async function publishArbExpired(clusterId: number): Promise<void> {
  try {
    await publish({
      channel: 'arbitrage',
      type: 'arb:expired',
      data: { source: 'lp_solver', clusterId },
    });
  } catch {
    // Event bus may not be running
  }
}

export async function publishGraphReloaded(stats: {
  clusters: number;
  questions: number;
  edges: number;
  trackedMarkets: number;
}): Promise<void> {
  try {
    await publish({
      channel: 'pipeline',
      type: 'solver:graph_reloaded',
      data: stats,
    });
  } catch {
    // Event bus may not be running
  }
}
