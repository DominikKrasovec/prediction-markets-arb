import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { solveLP } from './solver.js';
import { extractPortfolio } from './portfolio.js';
import { NO_EXECUTION_GATE, type ExecutionParams } from './types.js';

const FEES_ONLY: ExecutionParams = { enforceFees: true, enforceDepthCap: false };
const DEPTH_ONLY: ExecutionParams = { enforceFees: false, enforceDepthCap: true };

/** A categorical (exhaustive one-hot) cluster: one market per slot, exactly one
 *  resolves YES per world. Buy-all-YES guarantees $1 → arb iff Σ(ask) < 1. */
function categoricalCluster(
  markets: { marketId: number; platform: Platform; endDateMs?: number | null; negRiskEventId?: string | null }[],
): Cluster {
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  markets.forEach((m, i) => {
    const qid = i + 1;
    const ref: MarketRef = {
      marketId: m.marketId,
      platform: m.platform,
      platformId: `pid-${m.marketId}`,
      endDateMs: m.endDateMs ?? null,
      negRiskEventId: m.negRiskEventId ?? null,
    };
    questions.set(qid, {
      questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map([[m.marketId, ref]]),
    });
    marketIds.add(m.marketId);
  });
  const qids = [...questions.keys()];
  const validStates = qids.map((t) => new Map(qids.map((q) => [q, q === t])));
  return { id: 1, questions, outcomeSets: [], edges: [], marketIds, validStates, dirty: false };
}

const TS = 1000; // fixed quote timestamp used with an explicit `now` for determinism

describe('execution gate', () => {
  test('baseline: profitable categorical arb, no gate → ~$0.10 profit, no fees, clean', async () => {
    const c = categoricalCluster([{ marketId: 10, platform: 'polymarket' }, { marketId: 11, platform: 'polymarket' }]);
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const arb = extractPortfolio(res, lp, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.profit).toBeCloseTo(0.10, 3);
    expect(arb!.feesUsd).toBe(0);
    expect(arb!.legs.length).toBe(2);          // buy YES on both slots
    expect(arb!.executionGrade).toBe('clean'); // single platform, deep, fresh, tight
  });

  test('fees erase a sub-cent edge (Kalshi)', async () => {
    const c = categoricalCluster([{ marketId: 10, platform: 'kalshi' }, { marketId: 11, platform: 'kalshi' }]);
    const pc = new PriceCache();
    // Σ(askYes) = 0.98 → 2¢ gross edge. Kalshi fee ≈ $0.0175/contract/leg erases it.
    pc.update({ marketId: 10, platform: 'kalshi', bestBid: 0.47, bestAsk: 0.49, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'kalshi', bestBid: 0.47, bestAsk: 0.49, bidSize: 1000, askSize: 1000, timestamp: TS });

    const off = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const resOff = await solveLP(off);
    expect(1 - resOff.optimalCost).toBeCloseTo(0.02, 3); // gross arb exists

    const on = buildLP(c, pc, FEES_ONLY)!;
    const resOn = await solveLP(on);
    expect(resOn.optimalCost).toBeGreaterThan(1.0);       // net-of-fee: gone
    expect(extractPortfolio(resOn, on, c, pc, 0.01, undefined, TS)).toBeNull();
  });

  test('depth cap removes an arb whose book is too shallow', async () => {
    const c = categoricalCluster([{ marketId: 10, platform: 'polymarket' }, { marketId: 11, platform: 'polymarket' }]);
    const pc = new PriceCache();
    // Great price (Σask 0.90) but only 0.5 shares at top of book on every side.
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 0.5, askSize: 0.5, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 0.5, askSize: 0.5, timestamp: TS });

    const off = buildLP(c, pc, NO_EXECUTION_GATE)!;
    expect(1 - (await solveLP(off)).optimalCost).toBeCloseTo(0.10, 3); // uncapped arb

    const on = buildLP(c, pc, DEPTH_ONLY)!;
    const resOn = await solveLP(on);
    // Capped at 0.5/leg the cheap buy-all-YES can't reach $1; the feasible mix is ≥$1.
    expect(resOn.optimalCost).toBeGreaterThanOrEqual(1.0);
    expect(extractPortfolio(resOn, on, c, pc, 0.01, undefined, TS)).toBeNull();
  });

  test('cross-platform basket grades caution', async () => {
    const c = categoricalCluster([{ marketId: 10, platform: 'kalshi' }, { marketId: 11, platform: 'polymarket' }]);
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'kalshi', bestBid: 0.44, bestAsk: 0.45, bidSize: 5000, askSize: 5000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 5000, askSize: 5000, timestamp: TS });

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const arb = extractPortfolio(await solveLP(lp), lp, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.executionGrade).toBe('caution'); // two platforms = leg risk
  });

  test('U1/U4: settlement-economics annotation on a fat arb (above frontier)', async () => {
    const DAY = 86_400_000;
    const end = TS + 300 * DAY;
    const c = categoricalCluster([
      { marketId: 10, platform: 'polymarket', endDateMs: end, negRiskEventId: 'ev-yes' },
      { marketId: 11, platform: 'polymarket', endDateMs: end, negRiskEventId: 'ev-yes' },
    ]);
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const arb = extractPortfolio(await solveLP(lp), lp, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    // τ = 300d to end + 1d PM undisputed settlement lag.
    expect(arb!.daysToSettlement).toBeCloseTo(301, 6);
    expect(arb!.horizonCoverage).toBe(1);
    // YES legs in a negRisk event recycle nothing.
    expect(arb!.recycledCapitalUsd).toBeCloseTo(0, 9);
    expect(arb!.effectiveCapitalUsd).toBeCloseTo(arb!.totalCost, 9);
    // $0.10 on $0.90 over 301d ≈ 13.6%/yr ≫ 3.06% min frontier → not demoted.
    expect(arb!.annualizedEdge!).toBeGreaterThan(0.10);
    expect(arb!.aswThreshold).toBeCloseTo(0.0306, 10);
    expect(arb!.belowSettlementFrontier).toBe(false);
    expect(arb!.settlementCurve).toBe('min/flat');
    expect(arb!.executionGrade).toBe('clean');
  });

  test('U1: thin edge over a long lock-up demotes to caution (below settlement frontier)', async () => {
    const DAY = 86_400_000;
    const end = TS + 300 * DAY;
    const c = categoricalCluster([
      { marketId: 10, platform: 'polymarket', endDateMs: end },
      { marketId: 11, platform: 'polymarket', endDateMs: end },
    ]);
    const pc = new PriceCache();
    // Σ(ask) = 0.98 → $0.02 on $0.98 locked ~301d ≈ 2.5%/yr < 3.06% min ASW.
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.48, bestAsk: 0.49, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.48, bestAsk: 0.49, bidSize: 1000, askSize: 1000, timestamp: TS });

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const arb = extractPortfolio(await solveLP(lp), lp, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.profit).toBeCloseTo(0.02, 3);
    expect(arb!.annualizedEdge!).toBeLessThan(0.0306);
    expect(arb!.belowSettlementFrontier).toBe(true);
    expect(arb!.executionGrade).toBe('caution');
    expect(arb!.executionReasons.some((r) => r.includes('below settlement frontier'))).toBe(true);
  });

  test('U3: a negRisk NO-basket recycles (m−1)·units — fully recycled capital is never below frontier', async () => {
    const DAY = 86_400_000;
    const end = TS + 300 * DAY;
    const c = categoricalCluster([
      { marketId: 10, platform: 'polymarket', endDateMs: end, negRiskEventId: 'ev1' },
      { marketId: 11, platform: 'polymarket', endDateMs: end, negRiskEventId: 'ev1' },
      { marketId: 12, platform: 'polymarket', endDateMs: end, negRiskEventId: 'ev1' },
    ]);
    const pc = new PriceCache();
    // NO ask = 1 − bid = 0.60/leg. Buy 0.5 NO of each slot: every one-hot world
    // pays 2·0.5 = $1 for $0.90 → certified $0.10 arb. (Buy-all-YES costs 1.26.)
    for (const id of [10, 11, 12]) {
      pc.update({ marketId: id, platform: 'polymarket', bestBid: 0.40, bestAsk: 0.42, bidSize: 1000, askSize: 1000, timestamp: TS });
    }

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!;
    const arb = extractPortfolio(await solveLP(lp), lp, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.legs.every((l) => l.side === 'NO')).toBe(true);
    expect(arb!.totalCost).toBeCloseTo(0.90, 3);
    // m=3 NO legs × 0.5 shares in one negRisk event → (3−1)·0.5 = $1 recycled,
    // which exceeds the $0.90 outlay → effective locked capital floors at 0.
    expect(arb!.recycledCapitalUsd).toBeCloseTo(1.0, 3);
    expect(arb!.effectiveCapitalUsd).toBeCloseTo(0, 3);
    // Zero locked capital + positive edge ⟹ infinite annualized edge: the 300d
    // horizon costs nothing, so the frontier can never demote it.
    expect(arb!.annualizedEdge).toBe(Infinity);
    expect(arb!.belowSettlementFrontier).toBe(false);
    expect(arb!.executionGrade).toBe('clean');
  });

  test('quote-age TTL excludes a stale leg → no arb', async () => {
    const c = categoricalCluster([{ marketId: 10, platform: 'polymarket' }, { marketId: 11, platform: 'polymarket' }]);
    const pc = new PriceCache();
    pc.setTtl(60_000); // 60s TTL; the TS=1000 quotes are ancient vs Date.now() inside buildLP
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });

    const lp = buildLP(c, pc, NO_EXECUTION_GATE)!; // get() → both aged out → sentinel ask=$2
    const res = await solveLP(lp);
    expect(res.optimalCost).toBeGreaterThanOrEqual(1.0); // sentinel-priced → no arb

    // Same quotes, TTL disabled → arb returns.
    pc.setTtl(0);
    const lp2 = buildLP(c, pc, NO_EXECUTION_GATE)!;
    expect(1 - (await solveLP(lp2)).optimalCost).toBeCloseTo(0.10, 3);
  });
});
