/**
 * Intra-set containment + price-contradiction belt tests.
 *
 * Shapes covered:
 *   - exact-score fusion: match-winner + per-team goal ladders + spreads
 *     fused into one categorical mutex -> containment + winner+rung.
 *   - a monotone margin ladder inside a categorical mutex -> containment.
 *   - single-winner award questions joined by pairwise mutex edges, sum of
 *     best YES bids exceeding 1+slack -> price contradiction.
 *   - a genuinely sound partition -> untouched.
 */
import { describe, test, expect } from 'bun:test';
import {
  applyIntraSetContainmentBelt,
  applyContainmentLatch,
  latchBeltResult,
  newContainmentLatch,
  _internals,
} from './intra-set-containment-belt.js';
import type { ConstraintGraph, OutcomeSetRef, EdgeRef, QuestionNode, MarketRef } from './types.js';

function qn(id: number, key: string, marketIds: number[] = [id]): QuestionNode {
  const markets = new Map<number, MarketRef>();
  for (const mid of marketIds) markets.set(mid, { marketId: mid, platform: 'kalshi', platformId: `p${mid}` });
  return {
    questionId: id,
    canonicalSubject: key,
    canonicalKey: key,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    markets,
  };
}

function mutexEdge(a: number, b: number, edgeId = a * 100000 + b): EdgeRef {
  return { edgeId, antecedentQuestionId: a, consequentQuestionId: b, edgeType: 'mutual_exclusion', confidence: 1, deterministic: true, basisRisk: null };
}

function catSet(setId: number, name: string, slotQuestionIds: number[]): OutcomeSetRef {
  return { setId, setType: 'categorical', setName: name, slotQuestionIds, isExhaustive: false };
}

function graphOf(questions: QuestionNode[], outcomeSets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): ConstraintGraph {
  const m = new Map<number, QuestionNode>();
  for (const q of questions) m.set(q.questionId, q);
  return { questions: m, outcomeSets, edges };
}

describe('intra-set containment belt — categorical sets', () => {
  // Exact-score fusion shape (subset of the real slots).
  const s67209 = () =>
    graphOf(
      [
        qn(1, 'sem:2669:argentina_over_0.5'),
        qn(2, 'sem:2669:argentina_over_1.5'),
        qn(3, 'sem:2669:argentina_over_2.5'),
        qn(4, 'sem:2669:argentina_wins'),
        qn(5, 'sem:2669:switzerland_wins'),
        qn(6, 'sem:2669:draw'),
        qn(7, 'sem:2669:switzerland_over_2.5'),
      ],
      [catSet(67209, 'Argentina vs. Switzerland - Exact Score', [1, 2, 3, 4, 5, 6, 7])],
    );

  test('c30731: containment + winner+rung fire → the whole set is freed to free questions', () => {
    const g = s67209();
    const r = applyIntraSetContainmentBelt(g);
    expect(g.outcomeSets.length).toBe(0); // set 67209 dropped → free questions
    expect(r.setsFreed).toBe(1);
    expect(r.containmentHits).toBeGreaterThanOrEqual(1);
    expect(r.winnerRungHits).toBeGreaterThanOrEqual(1);
    // The questions survive (only the mutex constraint is removed).
    expect(g.questions.size).toBe(7);
  });

  test('c30731: flagged pairs recorded as duplicate-suspect pairs (trigger-gate refusal)', () => {
    const g = s67209();
    const r = applyIntraSetContainmentBelt(g);
    expect(r.suspectPairs.length).toBeGreaterThan(0);
    expect(g.duplicateSuspectPairs?.length).toBe(r.suspectPairs.length);
    // argentina_over_0.5 (q1) contains argentina_over_1.5 (q2) — must be a recorded pair.
    const has = (a: number, b: number) => r.suspectPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    expect(has(1, 2)).toBe(true);
  });

  test('set 914 (KBO run-line ladder) → containment fires, set freed', () => {
    const g = graphOf(
      [qn(10, 'sem:1833:hanwha_by_over_1.5'), qn(11, 'sem:1833:hanwha_by_over_2.5'), qn(12, 'sem:1833:kt_wiz')],
      [catSet(914, 'KBO: Hanwha Eagles vs. KT Wiz', [10, 11, 12])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(1);
    expect(r.containmentHits).toBe(1);
    expect(g.outcomeSets.length).toBe(0);
  });

  test('set 119603 (CFL margin ladder, 5 rungs) → containment fires, set freed', () => {
    const g = graphOf(
      [
        qn(20, 'sem:4097:calgary_by_over_3.5'),
        qn(21, 'sem:4097:calgary_by_over_6.5'),
        qn(22, 'sem:4097:calgary_by_over_7.5'),
        qn(23, 'sem:4097:calgary_by_over_13.5'),
        qn(24, 'sem:4097:calgary_by_over_20.5'),
        qn(25, 'sem:4097:montreal_alouettes'),
      ],
      [catSet(119603, 'Calgary Stampeders vs Montreal Alouettes', [20, 21, 22, 23, 24, 25])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(1);
    expect(g.outcomeSets.length).toBe(0);
  });

  test('SOUND control set 67255 (first-team-to-score) → UNTOUCHED', () => {
    const g = graphOf(
      [qn(30, 'sem:2737:argentina_first_goal'), qn(31, 'sem:2737:no_goal'), qn(32, 'sem:2737:switzerland_first_goal')],
      [catSet(67255, 'ARG-SUI First Team to Score', [30, 31, 32])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(0);
    expect(r.containmentHits).toBe(0);
    expect(r.winnerRungHits).toBe(0);
    expect(g.outcomeSets.length).toBe(1); // set preserved
  });

  test('SOUND pure match-winner mutex {arg_wins, swi_wins, draw} → UNTOUCHED (no ladder rung)', () => {
    const g = graphOf(
      [qn(40, 'sem:9:argentina_wins'), qn(41, 'sem:9:switzerland_wins'), qn(42, 'sem:9:draw')],
      [catSet(500, 'Match Winner', [40, 41, 42])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(0);
    expect(g.outcomeSets.length).toBe(1);
  });

  test('different-participant thresholds are NOT containment (arg over 0.5 vs swi over 0.5)', () => {
    const g = graphOf(
      [qn(50, 'sem:9:argentina_over_0.5'), qn(51, 'sem:9:switzerland_over_0.5'), qn(52, 'sem:9:draw')],
      [catSet(501, 'mixed teams', [50, 51, 52])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(0);
    expect(g.outcomeSets.length).toBe(1);
  });
});

describe('intra-set containment belt — mutex-edge cliques + price contradiction', () => {
  // 10 single-winner award questions, fully-connected mutex clique.
  function fieldsMedal(): { g: ConstraintGraph; bids: Map<number, number> } {
    const names = ['hong_wang', 'tsimerman', 'yu_deng', 'pardon', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'];
    const qs = names.map((n, i) => qn(100 + i, `sem:cw:${n}_wins`));
    const edges: EdgeRef[] = [];
    let eid = 1;
    for (let i = 0; i < qs.length; i++) {
      for (let j = i + 1; j < qs.length; j++) edges.push(mutexEdge(100 + i, 100 + j, eid++));
    }
    const g = graphOf(qs, [], edges);
    // Sum of bids exceeds 1 (four favorites), rest zero/unquoted.
    const bids = new Map<number, number>([
      [100, 0.821],
      [101, 0.752],
      [102, 0.70],
      [103, 0.548],
    ]);
    return { g, bids };
  }

  test('c24280: Σ best-YES-bids 2.8 > 1+slack → mutex edges dropped, price hit counted', () => {
    const { g, bids } = fieldsMedal();
    const edgeCountBefore = g.edges.length; // 45 pairwise mutex edges
    const r = applyIntraSetContainmentBelt(g, { yesBidOf: (m) => bids.get(m) ?? null });
    expect(r.priceContradictionHits).toBe(1);
    expect(r.edgesDropped).toBe(edgeCountBefore); // the whole refuted clique's edges
    expect(g.edges.length).toBe(0);
    // Straddling refusal: pairs among the favorites recorded.
    expect(r.suspectPairs.length).toBeGreaterThan(0);
  });

  test('price arm DORMANT without a bid accessor → structural-only, edges untouched', () => {
    const { g } = fieldsMedal();
    const before = g.edges.length;
    const r = applyIntraSetContainmentBelt(g); // no yesBidOf
    expect(r.priceContradictionHits).toBe(0);
    expect(g.edges.length).toBe(before);
  });

  test('SOUND mutex clique with Σ bids < 1 → UNTOUCHED', () => {
    const { g } = fieldsMedal();
    const before = g.edges.length;
    // Realistic single-winner book: Σ ≈ 0.95 < 1.15.
    const bids = new Map<number, number>([
      [100, 0.4],
      [101, 0.3],
      [102, 0.15],
      [103, 0.1],
    ]);
    const r = applyIntraSetContainmentBelt(g, { yesBidOf: (m) => bids.get(m) ?? null });
    expect(r.priceContradictionHits).toBe(0);
    expect(g.edges.length).toBe(before);
  });

  test('slack is raise-only: a caller cannot lower it below the 0.15 floor', () => {
    const { g, bids } = fieldsMedal();
    // Try to force fires at Σ>1.0 by passing slack 0 — the belt clamps to ≥0.15.
    // Σ = 2.8 still exceeds 1.15 so this clique still fires; assert the CLAMP by
    // checking a sub-floor slack does not fire a clique whose Σ sits between the
    // floors (1.0 < Σ ≤ 1.15).
    const g2 = graphOf(
      [qn(200, 'sem:x:a_wins'), qn(201, 'sem:x:b_wins')],
      [],
      [mutexEdge(200, 201, 9001)],
    );
    const bids2 = new Map<number, number>([[200, 0.6], [201, 0.5]]); // Σ = 1.1
    const r = applyIntraSetContainmentBelt(g2, { yesBidOf: (m) => bids2.get(m) ?? null, priceContradictionSlack: 0 });
    expect(r.priceContradictionHits).toBe(0); // clamped to 0.15 floor, 1.1 ≤ 1.15
    expect(g2.edges.length).toBe(1);
    // sanity: the real Fields clique still fires under the same clamp
    const r2 = applyIntraSetContainmentBelt(g, { yesBidOf: (m) => bids.get(m) ?? null, priceContradictionSlack: 0 });
    expect(r2.priceContradictionHits).toBe(1);
  });
});

// A question on a chosen platform (default kalshi), for the zero-overlap test.
function qnP(id: number, key: string, platform: 'kalshi' | 'polymarket' | 'predict' | 'limitless', marketIds: number[] = [id]): QuestionNode {
  const q = qn(id, key, marketIds);
  for (const m of q.markets.values()) (m as { platform: string }).platform = platform;
  return q;
}

describe('MUST-FIX 1(b): spread / signed-margin slugs trip containment', () => {
  test('pure spread fragment {spread_<x>_-1.5, spread_<x>_-2.5} (set 67209 spread group) → freed', () => {
    const g = graphOf(
      [
        qn(1, 'sem:2669:spread_jordan_-1.5'),
        qn(2, 'sem:2669:spread_jordan_-2.5'),
        qn(3, 'sem:2669:spread_switzerland_-1.5'),
        qn(4, 'sem:2669:spread_switzerland_-2.5'),
      ],
      [catSet(9100, 'ARG-SUI spread fragment', [1, 2, 3, 4])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.setsFreed).toBe(1);
    expect(r.containmentHits).toBeGreaterThanOrEqual(1);
    expect(g.outcomeSets.length).toBe(0);
    // jordan −1.5 ⊃ jordan −2.5 recorded as a suspect pair.
    const has = (a: number, b: number) => r.suspectPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    expect(has(1, 2)).toBe(true);
  });

  test('factsOf parses spread_<name>_-<v> (participant = name, not "spread_name")', () => {
    const sp = _internals.factsOf(qn(1, 'sem:2669:spread_jordan_-1.5'));
    expect(sp.participant).toBe('jordan');
    expect(sp.value).toBe(-1.5);
    expect(sp.isWinner).toBe(false);
    expect(sp.direction).toBe('down');
    // bare signed margin `<name>_-<v>`.
    const sg = _internals.factsOf(qn(2, 'sem:2669:switzerland_-2.5'));
    expect(sg.participant).toBe('switzerland');
    expect(sg.value).toBe(-2.5);
  });
});

describe('MUST-FIX 3: cross-platform zero-overlap two-partition tell (set 67283)', () => {
  test('Kalshi teams ⊕ Polymarket regions, zero overlap → zeroOverlapHit, set freed', () => {
    const g = graphOf(
      [
        qnP(1, 'sem:2777:t1', 'kalshi'),
        qnP(2, 'sem:2777:g2_esports', 'kalshi'),
        qnP(3, 'sem:2777:hanwha_life_esports', 'kalshi'),
        qnP(4, 'sem:2777:top_esports', 'kalshi'),
        qnP(5, 'sem:2777:lck', 'polymarket'),
        qnP(6, 'sem:2777:lpl', 'polymarket'),
        qnP(7, 'sem:2777:lec', 'polymarket'),
        qnP(8, 'sem:2777:other_region', 'polymarket'),
      ],
      [catSet(67283, 'MSI 2026 Winning Region', [1, 2, 3, 4, 5, 6, 7, 8])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.zeroOverlapHits).toBe(1);
    expect(r.setsFreed).toBe(1);
    expect(g.outcomeSets.length).toBe(0);
  });

  test('a correctly-merged xplat partition (a cross-platform outcome) is NOT flagged', () => {
    const g = graphOf(
      [
        qnP(1, 'sem:9:argentina_wins', 'kalshi', [101, 102]), // one outcome, two platforms below
        qnP(2, 'sem:9:switzerland_wins', 'polymarket'),
        qnP(3, 'sem:9:draw', 'polymarket'),
      ],
      [catSet(600, 'Match Winner xplat', [1, 2, 3])],
    );
    // Make outcome 1 genuinely cross-platform (kalshi + polymarket markets).
    g.questions.get(1)!.markets.set(102, { marketId: 102, platform: 'polymarket', platformId: 'p102' });
    const r = applyIntraSetContainmentBelt(g);
    expect(r.zeroOverlapHits).toBe(0);
    expect(g.outcomeSets.length).toBe(1);
  });

  test('single-platform categorical (all Kalshi) is NOT flagged by zero-overlap', () => {
    const g = graphOf(
      [qnP(1, 'sem:9:alpha', 'kalshi'), qnP(2, 'sem:9:beta', 'kalshi'), qnP(3, 'sem:9:gamma', 'kalshi')],
      [catSet(601, 'all-kalshi winner', [1, 2, 3])],
    );
    const r = applyIntraSetContainmentBelt(g);
    expect(r.zeroOverlapHits).toBe(0);
    expect(g.outcomeSets.length).toBe(1);
  });
});

describe('MUST-FIX 2: price-refutation latch persists across reloads (no flap-back)', () => {
  // A 2-question mutex-edge clique the book refutes now (Σ=1.1... < 1.15? use Σ=1.4).
  const clique = () => graphOf(
    [qn(300, 'sem:z:a_wins'), qn(301, 'sem:z:b_wins')],
    [],
    [mutexEdge(300, 301, 7001)],
  );

  test('a set/edge price-refuted with live bids stays dropped on a quiet-book reload', () => {
    const latch = newContainmentLatch();
    // Tick 1: books live, Σ=1.4 > 1.15 → the mutex edge is dropped, and latched.
    const g1 = clique();
    const bids = new Map<number, number>([[300, 0.8], [301, 0.6]]);
    const r1 = applyIntraSetContainmentBelt(g1, { yesBidOf: (m) => bids.get(m) ?? null });
    latchBeltResult(latch, r1);
    expect(r1.priceContradictionHits).toBe(1);
    expect(g1.edges.length).toBe(0);
    expect(latch.refutedPairs.size).toBeGreaterThan(0);

    // Tick 2: a FRESH graph (reload) with QUIET books (no bids). The price arm alone
    // would NOT re-fire — but the latch must re-assert the drop.
    const g2 = clique();
    applyContainmentLatch(g2, latch);
    const r2 = applyIntraSetContainmentBelt(g2, { yesBidOf: () => null });
    expect(r2.priceContradictionHits).toBe(0); // quiet books, arm dormant
    expect(g2.edges.length).toBe(0); // but the edge stays dropped via the latch
  });

  test('a freed categorical set is re-freed by the latch on reload', () => {
    const latch = newContainmentLatch();
    const g1 = graphOf(
      [qn(400, 'sem:z:x_over_0.5'), qn(401, 'sem:z:x_over_1.5'), qn(402, 'sem:z:y')],
      [catSet(8000, 'ladder-in-mutex', [400, 401, 402])],
    );
    const r1 = applyIntraSetContainmentBelt(g1);
    latchBeltResult(latch, r1);
    expect(latch.refutedSetIds.has(8000)).toBe(true);

    const g2 = graphOf(
      [qn(400, 'sem:z:x_over_0.5'), qn(401, 'sem:z:x_over_1.5'), qn(402, 'sem:z:y')],
      [catSet(8000, 'ladder-in-mutex', [400, 401, 402])],
    );
    const latched = applyContainmentLatch(g2, latch);
    expect(latched.setsFreed).toBe(1);
    expect(g2.outcomeSets.length).toBe(0);
  });
});

describe('intra-set containment belt — parser internals', () => {
  test('slugOf takes the tail after the last colon', () => {
    expect(_internals.slugOf('sem:2669:argentina_over_1.5')).toBe('argentina_over_1.5');
  });

  test('factsOf parses monotone thresholds and winner slugs', () => {
    const t = _internals.factsOf(qn(1, 'sem:1:argentina_over_1.5'));
    expect(t.participant).toBe('argentina');
    expect(t.direction).toBe('up');
    expect(t.value).toBe(1.5);
    expect(t.isWinner).toBe(false);

    const w = _internals.factsOf(qn(2, 'sem:1:switzerland_wins'));
    expect(w.isWinner).toBe(true);
    expect(w.participant).toBe('switzerland');

    const by = _internals.factsOf(qn(3, 'sem:1:hanwha_by_over_2.5'));
    expect(by.participant).toBe('hanwhaby'); // the _by connective stays in the participant
    expect(by.value).toBe(2.5);
  });

  test('cliqueBidSum returns null when no member is quoted (no flag on missing quotes)', () => {
    const g = graphOf([qn(1, 'a_wins'), qn(2, 'b_wins')]);
    expect(_internals.cliqueBidSum([1, 2], g, () => null)).toBeNull();
  });
});
