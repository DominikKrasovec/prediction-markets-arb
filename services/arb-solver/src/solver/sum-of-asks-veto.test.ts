/**
 * Cross-venue sum-of-asks veto, and the stateCount=0 case which must not emit
 * clean/caution.
 *
 * Sum-of-asks: a complement group is a set of positions that pays exactly $1 in
 * every world of Ω (a question and its own NO; an equivalence-merged pair's YES
 * and NO; the slots of an exhaustive one-hot). Buying one costs Σ(asks). A Σ
 * under the floor surviving to fire time is never a real risk-free return: it
 * is two venues quoting different events under one merged question (oracle /
 * tie-rule divergence). On a `candle_direction` member that divergence is
 * proven ⟹ block; otherwise ⟹ risky.
 *
 * `relaxedOmega` splits by `stateCount`. >0 exact worlds keeps the historical
 * `caution` cap; 0 worlds means nothing exact backs the facet objective ⟹ `risky`
 * with the "unverified" reason, and a tripwire force-refuses if it ever
 * reaches clean/caution anyway.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, OutcomeSetRef, EdgeRef, QuestionNode } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { enumerateStates } from './state-enumerator.js';
import { computeOmegaAudit, sumOfAsksDivergence, SUM_OF_ASKS_FLOOR, type AuditPosition } from './omega-audit.js';
import { applyOmegaGrade, type OmegaGradeInput } from './execution-grade.js';

const OPTS = { maxStates: 10_000, clusterSizeCap: 200 };

interface MarketSpec {
  id: number;
  platform: Platform;
  /** YES book (bid/ask) */ yes: [number, number];
  /** NO book (bid/ask); omitted ⟹ synthetic NO from the YES bid */ no?: [number, number];
  candle?: boolean;
}

function question(id: number, markets: MarketSpec[]): QuestionNode {
  const m = new Map<number, QuestionNode['markets'] extends Map<number, infer M> ? M : never>();
  for (const s of markets) {
    m.set(s.id, {
      marketId: s.id, platform: s.platform, platformId: `p${s.id}`,
      eventKind: s.candle ? 'candle_direction' : 'match_winner',
    });
  }
  return { questionId: id, canonicalSubject: `q${id}`, conditionShape: null, conditionValue: null, conditionDate: null, markets: m };
}

function priceCacheFor(specs: MarketSpec[]): PriceCache {
  const cache = new PriceCache();
  for (const s of specs) {
    cache.track(s.id);
    cache.update({ marketId: s.id, platform: s.platform, bestBid: s.yes[0], bestAsk: s.yes[1], bidSize: 500, askSize: 500, timestamp: 1000 });
    if (s.no) {
      cache.update({ marketId: s.id, platform: s.platform, outcome: 'no', bestBid: s.no[0], bestAsk: s.no[1], bidSize: 500, askSize: 500, timestamp: 1000 });
    }
  }
  return cache;
}

function clusterOf(questions: QuestionNode[], sets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): Cluster {
  const c: Cluster = {
    id: 1, questions: new Map(questions.map((x) => [x.questionId, x])),
    outcomeSets: sets, edges, marketIds: new Set(), validStates: [], dirty: false,
  };
  c.validStates = enumerateStates(c, OPTS);
  return c;
}

const hardEdge = (a: number, b: number, edgeType: string): EdgeRef => ({
  edgeId: a * 100 + b, antecedentQuestionId: a, consequentQuestionId: b, edgeType, confidence: 1, deterministic: true, basisRisk: null,
});

describe('P12b — sumOfAsksDivergence', () => {
  test('cross-venue MERGED question whose YES+NO asks sum to 0.55 ⟹ flagged', () => {
    // ONE question, two venues. YES liftable on Kalshi @0.30, NO liftable on PM @0.25:
    // a guaranteed $1 for $0.55. Not an arb — the two venues are pricing different events.
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.28, 0.30], no: [0.60, 0.62] },
      { id: 11, platform: 'polymarket', yes: [0.70, 0.72], no: [0.23, 0.25] },
    ];
    const c = clusterOf([question(1, specs)]);
    const hit = sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000);
    expect(hit).not.toBeNull();
    expect(hit!.sigma).toBeCloseTo(0.55, 6);
    expect(hit!.candleMember).toBe(false);
  });

  test('a coherent cross-venue book (Σ ≈ 0.98) is NOT flagged', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.60, 0.62], no: [0.36, 0.38] },
      { id: 11, platform: 'polymarket', yes: [0.61, 0.63], no: [0.35, 0.37] },
    ];
    const c = clusterOf([question(1, specs)]);
    expect(sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000)).toBeNull();
  });

  test('SAME-VENUE cheap box is NOT this arm (the stale-complement arm owns it)', () => {
    const specs: MarketSpec[] = [{ id: 10, platform: 'polymarket', yes: [0.28, 0.30], no: [0.23, 0.25] }];
    const c = clusterOf([question(1, specs)]);
    expect(sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000)).toBeNull();
  });

  test('EQUIVALENCE-merged pair across venues: YES(a) + NO(b) under the floor ⟹ flagged', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.28, 0.30], no: [0.68, 0.70] },
      { id: 20, platform: 'polymarket', yes: [0.70, 0.72], no: [0.18, 0.20] },
    ];
    const c = clusterOf(
      [question(1, [specs[0]!]), question(2, [specs[1]!])],
      [],
      [hardEdge(1, 2, 'equivalence')],
    );
    const hit = sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000);
    expect(hit).not.toBeNull();
    expect(hit!.sigma).toBeCloseTo(0.50, 6); // YES(a) 0.30 + NO(b) 0.20
  });

  test('EXHAUSTIVE one-hot spanning two venues with Σ(YES asks) = 0.50 ⟹ flagged', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.23, 0.25] },
      { id: 20, platform: 'polymarket', yes: [0.23, 0.25] },
    ];
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 's', slotQuestionIds: [1, 2], isExhaustive: true };
    const c = clusterOf([question(1, [specs[0]!]), question(2, [specs[1]!])], [set]);
    const hit = sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000);
    expect(hit).not.toBeNull();
    expect(hit!.sigma).toBeCloseTo(0.50, 6);
  });

  test('a slot with NO usable quote never convicts (a partial sum is not a guaranteed $1)', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.23, 0.25] },
      { id: 20, platform: 'polymarket', yes: [0, 0] }, // no usable ask
    ];
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 's', slotQuestionIds: [1, 2], isExhaustive: true };
    const c = clusterOf([question(1, [specs[0]!]), question(2, [specs[1]!])], [set]);
    expect(sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000)).toBeNull();
  });

  test('a group with NO traded question is not audited (fire-time tripwire, mirrors the mutex arm)', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.28, 0.30], no: [0.60, 0.62] },
      { id: 11, platform: 'polymarket', yes: [0.70, 0.72], no: [0.23, 0.25] },
    ];
    const c = clusterOf([question(1, specs)]);
    // A position on a market this cluster does not own ⟹ no traded questions.
    expect(sumOfAsksDivergence(c, [{ marketId: 999, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000)).toBeNull();
  });

  test('the floor is 0.60 — Σ = 0.60 exactly does NOT convict', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.28, 0.30], no: [0.60, 0.62] },
      { id: 11, platform: 'polymarket', yes: [0.68, 0.70], no: [0.28, 0.30] },
    ];
    const c = clusterOf([question(1, specs)]);
    expect(SUM_OF_ASKS_FLOOR).toBe(0.60);
    expect(sumOfAsksDivergence(c, [{ marketId: 10, side: 'YES', shares: 100 }], priceCacheFor(specs), 2000)).toBeNull();
  });
});

describe('P12b — grade rung', () => {
  const base = (over: Partial<OmegaGradeInput>): OmegaGradeInput => ({
    relaxedRecheck: 'pass', duplicateSuspectHeld: false, pinnedQuestions: [],
    unquotedClosureQuestionCount: 0, distance1UnquotedSibling: false, quotedFraction: 1,
    stateCount: 4, ...over,
  });

  test('non-candle divergence ⟹ risky with the oracle-divergence reason', () => {
    const g = applyOmegaGrade('clean', [], base({ sumOfAsksBelowFloor: 0.55, sumOfAsksCandleMember: false }));
    expect(g.grade).toBe('risky');
    expect(g.reasons.join(' ')).toContain('oracle-divergence-shaped book (sum-of-asks 0.55 < 0.60)');
  });

  test('candle_direction member ⟹ blocked', () => {
    const g = applyOmegaGrade('clean', [], base({ sumOfAsksBelowFloor: 0.55, sumOfAsksCandleMember: true }));
    expect(g.grade).toBe('blocked');
    expect(g.reasons.join(' ')).toContain('candle_direction');
  });

  test('no divergence ⟹ untouched', () => {
    expect(applyOmegaGrade('clean', [], base({ sumOfAsksBelowFloor: null })).grade).toBe('clean');
  });

  test('the arm is computed into the audit and demotes end-to-end', () => {
    const specs: MarketSpec[] = [
      { id: 10, platform: 'kalshi', yes: [0.28, 0.30], no: [0.60, 0.62], candle: true },
      { id: 11, platform: 'polymarket', yes: [0.70, 0.72], no: [0.23, 0.25], candle: true },
    ];
    const c = clusterOf([question(1, specs)]);
    const positions: AuditPosition[] = [{ marketId: 10, side: 'YES', shares: 100 }];
    const audit = computeOmegaAudit(c, positions, 55, 0.01, priceCacheFor(specs), 2000, OPTS);
    expect(audit.sumOfAsksBelowFloor).toBeCloseTo(0.55, 6);
    expect(audit.sumOfAsksCandleMember).toBe(true);
    expect(applyOmegaGrade('clean', [], audit).grade).toBe('blocked');
  });
});

describe('P8 — stateCount splits the relaxed-Ω rung', () => {
  const base = (over: Partial<OmegaGradeInput>): OmegaGradeInput => ({
    relaxedRecheck: 'pass', duplicateSuspectHeld: false, pinnedQuestions: [],
    unquotedClosureQuestionCount: 0, distance1UnquotedSibling: false, quotedFraction: 1,
    ...over,
  });

  test('relaxed Ω with 0 states ⟹ risky + the "unverified" reason (never caution)', () => {
    const g = applyOmegaGrade('clean', [], base({ relaxedOmega: true, stateCount: 0 }));
    expect(g.grade).toBe('risky');
    expect(g.reasons.join(' ')).toContain('unverified: relaxed-LP objective, no state enumeration backs this profit');
    expect(g.reasons.join(' ')).not.toContain('over-cap Ω');
  });

  test('relaxed Ω with >0 states keeps the historical caution cap', () => {
    const g = applyOmegaGrade('clean', [], base({ relaxedOmega: true, stateCount: 12 }));
    expect(g.grade).toBe('caution');
    expect(g.reasons.join(' ')).toContain('over-cap Ω');
  });

  test('a NON-relaxed basket with 0 states is not demoted by this rung (unreachable shape)', () => {
    expect(applyOmegaGrade('clean', [], base({ relaxedOmega: false, stateCount: 0 })).grade).toBe('clean');
  });

  test('demote-only: an already-blocked grade stays blocked', () => {
    const g = applyOmegaGrade('blocked', [], base({ relaxedOmega: true, stateCount: 0 }));
    expect(g.grade).toBe('blocked');
  });
});
