import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode, OutcomeSetRef, WorldState } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { solveGradedResidual } from './graded-residual.js';
import { NO_EXECUTION_GATE } from './types.js';

/**
 * A NON-exhaustive categorical cluster (Σ≤1): k slots, exactly one TRUE per
 * listed-winner world PLUS an all-FALSE world (an unlisted entity wins).
 */
function openFieldCluster(markets: { marketId: number; platform: Platform }[]): Cluster {
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const slotQids: number[] = [];
  markets.forEach((m, i) => {
    const qid = i + 1;
    slotQids.push(qid);
    const ref: MarketRef = { marketId: m.marketId, platform: m.platform, platformId: `pid-${m.marketId}` };
    questions.set(qid, {
      questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map([[m.marketId, ref]]),
    });
    marketIds.add(m.marketId);
  });
  const set: OutcomeSetRef = {
    setId: 7, setType: 'categorical', setName: 'open field', slotQuestionIds: slotQids, isExhaustive: false,
  };
  // Σ≤1 states: one-hot per slot + the all-FALSE world.
  const states: WorldState[] = slotQids.map((t) => new Map(slotQids.map((q) => [q, q === t])));
  states.push(new Map(slotQids.map((q) => [q, false]))); // all-FALSE (residual)
  return { id: 1, questions, outcomeSets: [set], edges: [], marketIds, validStates: states, dirty: false };
}

const TS = 1000;

describe('solveGradedResidual', () => {
  test('recovers a residual-tail near-arb the strict floor rejects; honest worst=0, NOT certified', async () => {
    const c = openFieldCluster([
      { marketId: 10, platform: 'polymarket' },
      { marketId: 11, platform: 'polymarket' },
    ]);
    const pc = new PriceCache();
    // Σ(askYes) = 0.90 < 1 → looks like an arb, but the all-FALSE world pays $0.
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });

    const graded = await solveGradedResidual(c, pc, NO_EXECUTION_GATE, 0.01, undefined, TS);
    expect(graded).not.toBeNull();
    expect(graded!.edge).toBeCloseTo(0.10, 3);
    expect(graded!.worstStrictStatePayout).toBe(0);          // pays $0 in the residual world
    expect(graded!.residualSetIds).toEqual([7]);
    expect(graded!.legs.length).toBe(2);
  });

  test('returns null when the set is exhaustive (no residual world to drop)', async () => {
    const c = openFieldCluster([
      { marketId: 10, platform: 'polymarket' },
      { marketId: 11, platform: 'polymarket' },
    ]);
    // Make it exhaustive + remove the all-FALSE state.
    c.outcomeSets[0].isExhaustive = true;
    c.validStates = c.validStates.filter((s) => [...s.values()].some((v) => v));
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 1000, askSize: 1000, timestamp: TS });

    expect(await solveGradedResidual(c, pc, NO_EXECUTION_GATE, 0.01, undefined, TS)).toBeNull();
  });

  test('returns null when even the relaxed solve has no edge', async () => {
    const c = openFieldCluster([
      { marketId: 10, platform: 'polymarket' },
      { marketId: 11, platform: 'polymarket' },
    ]);
    const pc = new PriceCache();
    // No edge either way: Σ(askYes)=1.10 AND Σ(askNo)=1.10 (bid1+bid2=0.90 ≤ 1),
    // so neither buy-all-YES nor the NO-NO hedge clears $1 in the relaxed states.
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.45, bestAsk: 0.55, bidSize: 1000, askSize: 1000, timestamp: TS });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.45, bestAsk: 0.55, bidSize: 1000, askSize: 1000, timestamp: TS });

    expect(await solveGradedResidual(c, pc, NO_EXECUTION_GATE, 0.01, undefined, TS)).toBeNull();
  });
});
