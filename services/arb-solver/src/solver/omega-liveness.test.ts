/**
 * Ω-liveness acceptance fixtures.
 *
 * The canonical contradiction (7-slot Σ≤1 + implication ⟹ pin) and
 * duplication (co-slot duplicate cells) topologies, plus the DEAD-book /
 * side-usability predicates and the grade lattice, as unit fixtures.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import { parseCellKey as sharedParseCellKey } from '@arb/types';
import type { Cluster, ConstraintGraph, OutcomeSetRef, EdgeRef, QuestionNode } from '../graph/types.js';
import type { PriceSnapshot } from '../clob/price-cache.js';
import { isDeadSnapshot, sideUsability, PriceCache } from '../clob/price-cache.js';
import { computePinnedQuestions, enumerateStates } from './state-enumerator.js';
import { applyDuplicatePartitionGate, parseCellKey, fold, _signatureOf } from '../graph/duplicate-gate.js';
import { relaxedRecheck, duplicateSuspectHeld, computeOmegaAudit, checkFiredPortfolioTripwires, type AuditPosition } from './omega-audit.js';
import { applyOmegaGrade, type OmegaGradeInput } from './execution-grade.js';

// helpers
function snap(over: Partial<PriceSnapshot>): PriceSnapshot {
  return {
    marketId: 1, bestBid: 0.4, bestAsk: 0.42, bidSize: 100, askSize: 100,
    lastUpdate: 1000, staleSince: null, lastTobChangeMs: 1000, ...over,
  };
}
const SENTINEL = snap({ bestBid: 0, bestAsk: 2.0, bidSize: 0, askSize: 0, lastUpdate: 0, lastTobChangeMs: 0 });

function q(id: number, subject: string, markets: Array<{ id: number; platform: Platform; title?: string; endMs?: number }>): QuestionNode {
  const m = new Map<number, QuestionNode['markets'] extends Map<number, infer M> ? M : never>();
  for (const mk of markets) m.set(mk.id, { marketId: mk.id, platform: mk.platform, platformId: `p${mk.id}`, title: mk.title ?? null, endDateMs: mk.endMs ?? null });
  return { questionId: id, canonicalSubject: subject, conditionShape: null, conditionValue: null, conditionDate: null, markets: m };
}
function catSet(setId: number, slots: number[], exhaustive = false): OutcomeSetRef {
  return { setId, setType: 'categorical', setName: `s${setId}`, slotQuestionIds: [...slots], isExhaustive: exhaustive };
}
function edge(a: number, b: number, edgeType = 'strict_implication'): EdgeRef {
  return { edgeId: a * 1000 + b, antecedentQuestionId: a, consequentQuestionId: b, edgeType, confidence: 1, deterministic: true, basisRisk: null };
}
function cluster(questions: QuestionNode[], sets: OutcomeSetRef[], edges: EdgeRef[]): Cluster {
  const qm = new Map(questions.map((x) => [x.questionId, x]));
  const c: Cluster = { id: 1, questions: qm, outcomeSets: sets, edges, marketIds: new Set(), validStates: [], dirty: false };
  c.validStates = enumerateStates(c, { maxStates: 10000, clusterSizeCap: 200 });
  return c;
}

// DEAD / side-usability
describe('DEAD-book + side-usability (§1.1–1.2)', () => {
  test('sentinel book is DEAD; live book is not', () => {
    expect(isDeadSnapshot(SENTINEL)).toBe(true);
    expect(isDeadSnapshot(undefined)).toBe(true);
    expect(isDeadSnapshot(snap({ staleSince: 5 }))).toBe(true);
    expect(isDeadSnapshot(snap({}))).toBe(false);
  });
  test('DEAD YES book emits no usable YES side and no synthetic NO', () => {
    const u = sideUsability(SENTINEL, undefined);
    expect(u.yes).toBe(false);
    expect(u.no).toBe(false); // never fabricates 1 − bestBid(0) = 1.00
  });
  test('live YES book yields usable YES + synthetic NO', () => {
    const u = sideUsability(snap({}), undefined);
    expect(u.yes).toBe(true);
    expect(u.no).toBe(true);
    expect(u.noFromBook).toBe(false);
  });
});

// L0 pin topology
describe('c1520 pin fixture — 7-slot Σ≤1 + implication ⟹ pin (§1.6/L0)', () => {
  const slots = [10589, 10590, 10591, 10592, 10593, 10594, 10595];
  test('mutex(Σ≤1) + (10590 ⟹ 10589) pins 10590 FALSE', () => {
    const qs = slots.map((id) => q(id, `slot${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [catSet(1032, slots, /*exhaustive*/ false)], [edge(10590, 10589)]);
    // 8 one-hot+none states, edge removes the 10590-one-hot ⟹ 7 states.
    expect(c.validStates.length).toBe(7);
    const pinned = computePinnedQuestions(c);
    expect(pinned).toEqual([10590]);
  });
  test('without the implication edge, nothing pins (sound Σ≤1)', () => {
    const qs = slots.map((id) => q(id, `slot${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [catSet(1032, slots, false)], []);
    expect(computePinnedQuestions(c)).toEqual([]);
  });
});

// cellKey
describe('cellKey settlement signature (§4.2)', () => {
  test('order-invariant over chamber×party conjuncts', () => {
    expect(parseCellKey('D House, R Senate')).toBe(parseCellKey('R Senate, D House'));
    expect(parseCellKey('D Senate, R House')).toBe(parseCellKey('R House, D Senate'));
    expect(parseCellKey('D House, R Senate')).not.toBe(parseCellKey('D Senate, R House'));
  });
  test('unparseable subject ⟹ ⊥ (null)', () => {
    // "<party> sweep" parses to BOTH chambers (Democratic sweep ≡ D House, D
    // Senate) — mirror of the pipeline duplicate-partition-gate.test.ts
    // assertion. Bare 'sweep' with no party stays ⊥.
    expect(parseCellKey('Democrats Sweep')).toBe(parseCellKey('D House, D Senate'));
    expect(parseCellKey('sweep')).toBeNull();
    expect(parseCellKey('Anthropic')).toBeNull();
    expect(parseCellKey(null)).toBeNull();
  });
  test('fold despaces + lowercases', () => {
    expect(fold('Anthropic')).toBe('anthropic');
    expect(fold('Anthropic acquired before 2027')).toBe('anthropicacquiredbefore2027');
  });

  // ── R2-1: FULL-CONSUMPTION — any residue outside the chamber×party+filler
  //    vocabulary ⟹ ⊥ (null); keeps the genuine zero-residue control-combo
  //    twins. ──
  describe('R2-1 full-consumption (⊥ on unconsumed residue)', () => {
    test('exactly-N / at-least-N seat-count ladders ⟹ ⊥', () => {
      expect(parseCellKey('Will Democrats win exactly 9 seats in 2026 U.S. House of Representatives elections in Texas?')).toBeNull();
      expect(parseCellKey('Will Democrats win at least 14 seats in 2026 U.S. House of Representatives elections in Texas?')).toBeNull();
      expect(parseCellKey('Will Democrats win below 8 seats in 2026 U.S. House of Representatives elections in Texas?')).toBeNull();
      expect(parseCellKey('Will the Democratic party hold exactly 55 Senate seats in the 120th Congress?')).toBeNull();
    });
    test('per-state / per-district cells ⟹ ⊥', () => {
      expect(parseCellKey('Will D win the OH-14 House seat?')).toBeNull();
      expect(parseCellKey('Rhode Island Republican Senate Primary Winner')).toBeNull();
      expect(parseCellKey('Will a Democrat win the House race for NJ-5?')).toBeNull();
      expect(parseCellKey('New Hampshire Republican Senate nominee?')).toBeNull();
    });
    test('per-person loss/primary cells ⟹ ⊥', () => {
      expect(parseCellKey('Will exactly 3 the Senate Republicans lose re-election in 2026?')).toBeNull();
      expect(parseCellKey('Will exactly 2 House Democratic members lose their primary in 2026?')).toBeNull();
      expect(parseCellKey('Will Buddy Carter finish 2nd in the first round of the Georgia Republican Senate primary?')).toBeNull();
      expect(parseCellKey('Will the margin of victory for Janet Mills in the 2026 Maine Democratic Senate primary be above 0%?')).toBeNull();
    });
    test('genuine zero-residue control-combo twins STILL parse + equate (c70)', () => {
      // 4322 ≡ 4327 and 4326 ≡ 4323 must keep HITting.
      expect(parseCellKey('D House, R Senate')).toBe(parseCellKey('R Senate, D House'));
      expect(parseCellKey('R House, D Senate')).toBe(parseCellKey('D Senate, R House'));
      expect(parseCellKey('D House, R Senate')).not.toBeNull();
      // control-verb / article filler is allowed (still one cell).
      expect(parseCellKey('Democrats control the House')).toBe(parseCellKey('D House'));
      expect(parseCellKey('Republicans win the Senate')).toBe(parseCellKey('R Senate'));
    });
    test('mirror parity: the belt re-export IS the @arb/types shared parser', () => {
      // Structural no-drift guarantee: one function, two import sites.
      expect(parseCellKey).toBe(sharedParseCellKey);
    });
  });
});

// duplicate-partition gate
describe('duplicate-partition gate (§4)', () => {
  test('c70 cell duplicate: Arm D drops a slot + records a suspect pair', () => {
    const qs = [
      q(4321, 'Democrats Sweep', [{ id: 1, platform: 'polymarket', endMs: Date.parse('2026-11-03') }]),
      q(4322, 'D House, R Senate', [{ id: 2, platform: 'kalshi', endMs: Date.parse('2027-02-01') }]),
      q(4323, 'D Senate, R House', [{ id: 3, platform: 'polymarket', endMs: Date.parse('2026-11-03') }]),
      q(4325, 'Republican Sweep', [{ id: 5, platform: 'polymarket', endMs: Date.parse('2026-11-03') }]),
      q(4327, 'R Senate, D House', [{ id: 7, platform: 'polymarket', endMs: Date.parse('2026-11-03') }]),
    ];
    const graph: ConstraintGraph = { questions: new Map(qs.map((x) => [x.questionId, x])), outcomeSets: [catSet(489, [4321, 4322, 4323, 4325, 4327])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    // 4322 ≡ 4327 (same cell, different date/authority) → Arm D.
    expect(res.duplicateSuspectPairs).toContainEqual([4322, 4327]);
    // the duplicate slot (higher ordinal, 4327) dropped from the set.
    expect(graph.outcomeSets[0].slotQuestionIds).not.toContain(4327);
    expect(graph.outcomeSets[0].slotQuestionIds).toContain(4322);
  });

  test('c1520 nested ladder: shared title + strict_implication ⟹ NO fold HIT', () => {
    const title = 'Will Trump invoke the Insurrection Act during his Presidency?';
    const qs = [
      q(10589, 'Before Jan 20, 2029', [{ id: 1, platform: 'kalshi', title, endMs: Date.parse('2029-01-20') }]),
      q(10590, 'Before 2027', [{ id: 2, platform: 'kalshi', title, endMs: Date.parse('2027-01-01') }]),
      q(10591, 'April 30', [{ id: 3, platform: 'polymarket', title: 'Insurrection Act invoked by April 30?' }]),
    ];
    const graph: ConstraintGraph = { questions: new Map(qs.map((x) => [x.questionId, x])), outcomeSets: [catSet(1032, [10589, 10590, 10591])], edges: [edge(10590, 10589)] };
    const res = applyDuplicatePartitionGate(graph);
    // The nested pair must NOT be deduped (it is the pinned/degenerate Ω L0 must catch).
    expect(res.duplicateSuspectPairs).toHaveLength(0);
    expect(graph.outcomeSets[0].slotQuestionIds).toEqual([10589, 10590, 10591]);
  });

  test('c360 intra-venue twin: fold-⊑ subject ⟹ Arm D', () => {
    const qs = [
      q(4411, 'Anthropic', [{ id: 1, platform: 'polymarket', title: 'Will Anthropic be acquired before 2027?', endMs: Date.parse('2026-12-31') }]),
      q(4412, 'Anthropic acquired before 2027', [{ id: 2, platform: 'polymarket', title: 'Anthropic acquired before 2027?', endMs: Date.parse('2026-12-31') }]),
      q(4413, 'BP', [{ id: 3, platform: 'polymarket', title: 'Will BP be acquired before 2027?', endMs: Date.parse('2026-12-31') }]),
    ];
    const graph: ConstraintGraph = { questions: new Map(qs.map((x) => [x.questionId, x])), outcomeSets: [catSet(506, [4411, 4412, 4413])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toContainEqual([4411, 4412]);
    expect(graph.outcomeSets[0].slotQuestionIds).not.toContain(4412);
  });

  // ── C2: win-suffix slug twin (drifting LLM outcome slug) ⟹ Arm D ──
  test('C2 win-suffix slug twin (rapid_vienna vs rapid_vienna_win) ⟹ Arm D', () => {
    // cellKey ⊥ (subjects nulled) + DISTINCT titles so neither the fold-title nor
    // the ⊑ arm pre-empts — ISOLATES the win-suffix slug arm on the canonicalKey slugs.
    // opaque subjects 'x'/'y'/'z' → parseCellKey ⊥ on both sides (not chamber×party).
    const a: QuestionNode = { ...q(71, 'x', [{ id: 1, platform: 'polymarket', title: 'Will Rapid Vienna win the UECL?' }]), canonicalKey: 'sem:5:rapid_vienna' };
    const b: QuestionNode = { ...q(72, 'y', [{ id: 2, platform: 'kalshi', title: 'Rapid Vienna to lift the trophy?' }]), canonicalKey: 'sem:5:rapid_vienna_win' };
    const c3: QuestionNode = { ...q(73, 'z', [{ id: 3, platform: 'kalshi', title: 'Will Santa Coloma advance?' }]), canonicalKey: 'sem:5:santa_coloma' };
    const graph: ConstraintGraph = { questions: new Map([[71, a], [72, b], [73, c3]]), outcomeSets: [catSet(7, [71, 72, 73])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toContainEqual([71, 72]);
    expect(graph.outcomeSets[0].slotQuestionIds).not.toContain(72);
  });

  // Exact-subject value-undiscriminated cross-platform duplicate (solver twin
  // of the pipeline durable gate)
  test('F10 exact-subject + both-NULL value + exact slug (Trump cross-venue) ⟹ Arm D', () => {
    // subjects EXACT-equal (⊑ arm skips fa===fb), distinct titles, cellKey ⊥.
    const a: QuestionNode = { ...q(6747, '2028 Republican VP nominee', [{ id: 1, platform: 'kalshi', title: 'Trump VP (Kalshi)?' }]), canonicalKey: 'sem:1:donald_trump' };
    const b: QuestionNode = { ...q(6748, '2028 Republican VP nominee', [{ id: 2, platform: 'polymarket', title: 'Will Trump be 2028 VP nominee?' }]), canonicalKey: 'sem:2:donald_trump' };
    const c3: QuestionNode = { ...q(6749, 'someone else entirely', [{ id: 3, platform: 'kalshi', title: 'Vance VP?' }]), canonicalKey: 'sem:3:jd_vance' };
    const graph: ConstraintGraph = { questions: new Map([[6747, a], [6748, b], [6749, c3]]), outcomeSets: [catSet(654, [6747, 6748, 6749])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toContainEqual([6747, 6748]);
    expect(graph.outcomeSets[0].slotQuestionIds).not.toContain(6748);
  });
  test('F10 LOAD-BEARING value gate: differing scoreline ⟹ NO HIT (set 857 Mallorca)', () => {
    const a: QuestionNode = { ...q(171259, 'RCD Mallorca', [{ id: 1, platform: 'kalshi', title: '0-0?' }]), canonicalKey: 'sem:1:m_0_0', valuePrimary: '0', valueSecondary: '0' };
    const b: QuestionNode = { ...q(171230, 'RCD Mallorca', [{ id: 2, platform: 'kalshi', title: '1-1?' }]), canonicalKey: 'sem:2:m_1_1', valuePrimary: '1', valueSecondary: '1' };
    const graph: ConstraintGraph = { questions: new Map([[171259, a], [171230, b]]), outcomeSets: [catSet(857, [171259, 171230])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toHaveLength(0);
    expect(graph.outcomeSets[0].slotQuestionIds).toEqual([171259, 171230]);
  });
});

// L4 relaxed recheck
describe('L4 liveness-relaxed recheck (§3)', () => {
  test('all-NO basket leaning on a dead-slot mutex FAILS', () => {
    // set of 3 mutex slots, one dead; buy NO on the 2 live ones.
    const qs = [q(1, 'a', [{ id: 10, platform: 'kalshi' }]), q(2, 'b', [{ id: 20, platform: 'kalshi' }]), q(3, 'c', [{ id: 30, platform: 'kalshi' }])];
    const c = cluster(qs, [catSet(1, [1, 2, 3], /*exhaustive*/ true)], []);
    const positions: AuditPosition[] = [{ marketId: 10, side: 'NO', shares: 100 }, { marketId: 20, side: 'NO', shares: 100 }];
    const unquoted = new Set([3]); // slot 3 dead
    // cost 190 (< worst under full Σ=1 which is ≥100), relaxed frees slot3 & drops
    // exhaustivity → state (1=YES,2=YES) enumerable → both NO pay 0 → worst 0 < cost.
    const r = relaxedRecheck(c, positions, 190, 0.01, unquoted, { maxStates: 10000, clusterSizeCap: 200 });
    expect(r.verdict).toBe('fail');
  });
  test('intra-question box is invariant to a dropped sibling set (survives)', () => {
    // one question with YES+NO box; it is also a slot of a set with a dead sibling.
    const qs = [q(1, 'box', [{ id: 10, platform: 'kalshi' }, { id: 11, platform: 'polymarket' }]), q(2, 'dead', [{ id: 20, platform: 'kalshi' }])];
    const c = cluster(qs, [catSet(1, [1, 2], true)], []);
    const positions: AuditPosition[] = [{ marketId: 10, side: 'YES', shares: 100 }, { marketId: 11, side: 'NO', shares: 100 }];
    const unquoted = new Set([2]);
    // box pays 100 in every world; cost 95 < 100 ⟹ pass.
    const r = relaxedRecheck(c, positions, 95, 0.01, unquoted, { maxStates: 10000, clusterSizeCap: 200 });
    expect(r.verdict).toBe('pass');
  });
});

// duplicate-gate belt + grade lattice
describe('grade lattice + belt (§5)', () => {
  test('duplicateSuspectHeld fires on EITHER twin', () => {
    const c = cluster([q(1, 'a', [{ id: 10, platform: 'kalshi' }]), q(2, 'b', [{ id: 20, platform: 'kalshi' }])], [], []);
    c.duplicateSuspectPairs = [[1, 2]];
    expect(duplicateSuspectHeld(c, [{ marketId: 10, side: 'NO', shares: 1 }])).toBe(true);
    expect(duplicateSuspectHeld(c, [{ marketId: 99, side: 'NO', shares: 1 }])).toBe(false);
  });
  test('applyOmegaGrade demote-only lattice', () => {
    const base: OmegaGradeInput = {
      relaxedRecheck: 'pass', duplicateSuspectHeld: false, pinnedQuestions: [],
      unquotedClosureQuestionCount: 0, distance1UnquotedSibling: false, quotedFraction: 1,
    };
    expect(applyOmegaGrade('clean', [], base).grade).toBe('clean');
    expect(applyOmegaGrade('clean', [], { ...base, relaxedRecheck: 'fail' }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, relaxedRecheck: 'overflow' }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, duplicateSuspectHeld: true }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, pinnedQuestions: [5] }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, unquotedClosureQuestionCount: 1 }).grade).toBe('caution');
    expect(applyOmegaGrade('clean', [], { ...base, distance1UnquotedSibling: true }).grade).toBe('risky');
    expect(applyOmegaGrade('clean', [], { ...base, quotedFraction: 0.3 }).grade).toBe('risky');
    // demote-only: a worse base is never upgraded.
    expect(applyOmegaGrade('risky', [], base).grade).toBe('risky');
  });
});

// one-sided live-bid book is not dead; aged version is
describe('§1.1 F-6 DEAD marker table (agedOut, no bestAsk≥2 proxy)', () => {
  // A one-sided book: real live bid (.45, size>0), adapter-synthesized ask 2.0,
  // fresh lastUpdate, no staleSince, not agedOut. LIVE ⟹ its synthetic NO
  // (1−bid) is buyable.
  const oneSidedLive = snap({ bestBid: 0.45, bidSize: 500, bestAsk: 2.0, askSize: 0, lastUpdate: 1000 });
  test('one-sided live-bid book is NOT dead; yes:false, no:true (synthetic)', () => {
    expect(isDeadSnapshot(oneSidedLive)).toBe(false);
    const u = sideUsability(oneSidedLive, undefined);
    expect(u.yes).toBe(false); // ask 2.0 > 1 ⟹ YES unusable
    expect(u.no).toBe(true); // synthetic NO off the live bid
    expect(u.noFromBook).toBe(false);
  });
  test('the SAME book aged out (agedOut stamped) is DEAD both sides', () => {
    const aged = { ...oneSidedLive, bestAsk: 2.0, bestBid: 0, agedOut: true };
    expect(isDeadSnapshot(aged)).toBe(true);
    const u = sideUsability(aged, undefined);
    expect(u.yes).toBe(false);
    expect(u.no).toBe(false);
  });
  test('a genuinely empty book (bid 0) is still unusable (no fabricated NO)', () => {
    const empty = snap({ bestBid: 0, bidSize: 0, bestAsk: 2.0, askSize: 0, lastUpdate: 1000 });
    const u = sideUsability(empty, undefined);
    expect(u.yes).toBe(false);
    expect(u.no).toBe(false); // never 1 − 0 = 1.00
  });
});

// authorityKey rules-family + dateKey member agreement
describe('§4.2 F-9 signature corrections', () => {
  function qn(id: number, subject: string, markets: Array<{ id: number; platform: Platform; ticker?: string | null; endMs?: number | null; date?: string | null }>): QuestionNode {
    const m = new Map();
    for (const mk of markets) m.set(mk.id, { marketId: mk.id, platform: mk.platform, platformId: `p${mk.id}`, title: null, eventTicker: mk.ticker ?? null, endDateMs: mk.endMs ?? null });
    return { questionId: id, canonicalSubject: subject, conditionShape: null, conditionValue: null, conditionDate: markets[0]?.date ?? null, markets: m };
  }
  test('authorityKey folds Kalshi series prefix (rules family)', () => {
    const a = qn(1, 'D House, R Senate', [{ id: 1, platform: 'kalshi', ticker: 'KXBALANCEOFPOWER-27' }]);
    const b = qn(2, 'R Senate, D House', [{ id: 2, platform: 'kalshi', ticker: 'KXHOUSECONTROL-27' }]);
    // same cellKey, but DIFFERENT Kalshi series ⟹ authorityKey differs ⟹ not full proof.
    expect(_signatureOf(a).cellKey).toBe(_signatureOf(b).cellKey);
    expect(_signatureOf(a).authorityKey).not.toBe(_signatureOf(b).authorityKey);
    expect(_signatureOf(a).authorityKey).toBe('kalshi:KXBALANCEOFPOWER');
  });
  test('dateKey is null when a question\'s members disagree on end-date bucket', () => {
    const disagree = qn(1, 'x', [
      { id: 1, platform: 'polymarket', endMs: Date.parse('2026-11-03') },
      { id: 2, platform: 'polymarket', endMs: Date.parse('2027-02-01') },
    ]);
    expect(_signatureOf(disagree).dateKey).toBeNull();
    const agree = qn(2, 'x', [
      { id: 3, platform: 'polymarket', endMs: Date.parse('2026-11-03') },
      { id: 4, platform: 'polymarket', endMs: Date.parse('2026-11-20') },
    ]);
    expect(_signatureOf(agree).dateKey).toBe('2026-11');
  });
});

// distinct-KB-id veto on the prefix-match arm
describe('§4.3 F-8 distinct-KB-id veto', () => {
  function qe(id: number, subject: string, entities: string[], title: string): QuestionNode {
    const m = new Map([[id, { marketId: id, platform: 'polymarket' as Platform, platformId: `p${id}`, title, eventTicker: null, endDateMs: Date.parse('2026-12-31') }]]);
    return { questionId: id, canonicalSubject: subject, conditionShape: null, conditionValue: null, conditionDate: null, subjectEntities: entities, markets: m };
  }
  test('distinct-entity ⊑ pair (trump ⊑ trumpjr) is VETOED — no HIT', () => {
    const qs = [
      qe(1, 'Trump', ['Donald Trump'], 'Will Trump win?'),
      qe(2, 'Trump Jr wins the primary', ['Donald Trump Jr'], 'Trump Jr wins?'),
      qe(3, 'Vance', ['JD Vance'], 'Vance wins?'),
    ];
    const graph: ConstraintGraph = { questions: new Map(qs.map((x) => [x.questionId, x])), outcomeSets: [catSet(1, [1, 2, 3])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toHaveLength(0);
  });
  test('same-entity (or empty-participant) ⊑ pair still HITs (c360 preserved)', () => {
    const qs = [
      qe(1, 'Anthropic', ['Anthropic'], 'Anthropic acquired before 2027?'),
      qe(2, 'Anthropic acquired before 2027', [], 'Anthropic acquired before 2027?'), // unshaped twin, no participants
      qe(3, 'BP', ['BP'], 'BP acquired?'),
    ];
    const graph: ConstraintGraph = { questions: new Map(qs.map((x) => [x.questionId, x])), outcomeSets: [catSet(1, [1, 2, 3])], edges: [] };
    const res = applyDuplicatePartitionGate(graph);
    expect(res.duplicateSuspectPairs).toContainEqual([1, 2]);
  });
});

// fresh fire-time pin recompute (defense-in-depth)
describe('§10.2 fresh pin recompute in computeOmegaAudit', () => {
  const OPTS = { maxStates: 10000, clusterSizeCap: 200 };
  test('L0-blind cluster tightened post-load to a pinned set ⟹ audit reports the pin', () => {
    // Same topology (Σ≤1 over 3 + implication ⟹ 10590 pinned FALSE), but with
    // the load-time L0 result unstamped (pinnedQuestions undefined). The fresh
    // recompute over the CURRENT validStates must still find it.
    const slots = [10589, 10590, 10592];
    const qs = slots.map((id) => q(id, `slot${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [catSet(1032, slots, false)], [edge(10590, 10589)]);
    c.pinnedQuestions = undefined; // L0 blind
    const cache = new PriceCache();
    for (const s of slots) { cache.track(s * 10); cache.update({ marketId: s * 10, platform: 'kalshi', bestBid: 0.1, bestAsk: 0.9, bidSize: 100, askSize: 100, timestamp: 1000 }); }
    const positions: AuditPosition[] = [{ marketId: 105920, side: 'NO', shares: 100 }];
    const audit = computeOmegaAudit(c, positions, 50, 0.01, cache, 2000, OPTS);
    expect(audit.pinnedQuestions).toContain(10590);
  });
});

// Mechanism-2 price-contradiction arm
describe('mutexPriceContradictionSigma — multi-winner false-mutex tell', () => {
  const mkCache = (bids: Record<number, number>) => {
    const cache = new PriceCache();
    for (const [mid, bid] of Object.entries(bids)) {
      cache.track(Number(mid));
      cache.update({ marketId: Number(mid), platform: 'kalshi', bestBid: bid, bestAsk: Math.min(0.99, bid + 0.02), bidSize: 100, askSize: 100, timestamp: 1000 });
    }
    return cache;
  };
  const mutexClique = (qids: number[]): EdgeRef[] => {
    const out: EdgeRef[] = [];
    for (let i = 0; i < qids.length; i++) {
      for (let j = i + 1; j < qids.length; j++) out.push(edge(qids[i], qids[j], 'mutual_exclusion'));
    }
    return out;
  };

  test('c441 shape: 4-clique with Σ(YES bids)=2.80 ⟹ sigma reported; grade ⟹ blocked', () => {
    const qids = [1, 2, 3, 4];
    const qs = qids.map((id) => q(id, `laureate${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [], mutexClique(qids));
    const cache = mkCache({ 10: 0.82, 20: 0.75, 30: 0.7, 40: 0.53 });
    const positions: AuditPosition[] = [{ marketId: 10, side: 'NO', shares: 100 }];
    const audit = computeOmegaAudit(c, positions, 50, 0.01, cache, 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(audit.mutexPriceContradictionSigma).not.toBeNull();
    expect(audit.mutexPriceContradictionSigma!).toBeCloseTo(2.8, 1);
    const graded = applyOmegaGrade('clean', [], audit);
    expect(graded.grade).toBe('blocked');
    expect(graded.reasons.join(' ')).toContain('mutex price contradiction');
  });

  test('sound 3-way (Σ=0.95) and a marginal box (Σ=1.10 ≤ 1+slack) do NOT trip', () => {
    const qids = [1, 2, 3];
    const qs = qids.map((id) => q(id, `cand${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [], mutexClique(qids));
    const sound = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 1 }], 1, 0.01, mkCache({ 10: 0.5, 20: 0.3, 30: 0.15 }), 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(sound.mutexPriceContradictionSigma).toBeNull();
    const marginal = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 1 }], 1, 0.01, mkCache({ 10: 0.5, 20: 0.4, 30: 0.2 }), 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(marginal.mutexPriceContradictionSigma).toBeNull(); // 1.10 ≤ 1.25
  });

  test('2-cycle box (Σ=1.4 but only 2 members) abstains — pair boxes are LP business, not clique evidence', () => {
    const qs = [1, 2].map((id) => q(id, `pair${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [], mutexClique([1, 2]));
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 1 }], 1, 0.01, mkCache({ 10: 0.7, 20: 0.7 }), 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(audit.mutexPriceContradictionSigma).toBeNull();
  });

  test('dead/unusable books contribute 0 — a clique alive only via one book abstains', () => {
    const qids = [1, 2, 3];
    const qs = qids.map((id) => q(id, `x${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const c = cluster(qs, [], mutexClique(qids));
    const cache = mkCache({ 10: 0.9 }); // 20/30 never quoted ⇒ unusable
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 1 }], 1, 0.01, cache, 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(audit.mutexPriceContradictionSigma).toBeNull();
  });

  test('soft (non-deterministic) mutex edges are ignored', () => {
    const qids = [1, 2, 3];
    const qs = qids.map((id) => q(id, `s${id}`, [{ id: id * 10, platform: 'kalshi' }]));
    const soft = mutexClique(qids).map((e) => ({ ...e, deterministic: false }));
    const c = cluster(qs, [], soft);
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 1 }], 1, 0.01, mkCache({ 10: 0.9, 20: 0.9, 30: 0.9 }), 2000, { maxStates: 10000, clusterSizeCap: 200 });
    expect(audit.mutexPriceContradictionSigma).toBeNull();
  });
});

// Single-market complementarity-coherence arm (stale one-sided book)
describe('staleComplementSideHeld — single-market box phantom (c7674)', () => {
  const OPTS = { maxStates: 10000, clusterSizeCap: 200 };
  // One PM binary market M10; separate YES + NO token books via update/updateNo.
  const oneMarket = () => cluster([q(1, 'eth 5m candle', [{ id: 10, platform: 'polymarket' }])], [], []);
  const cacheWith = (yes: Partial<PriceSnapshot>, no: Partial<PriceSnapshot>) => {
    const cache = new PriceCache();
    cache.track(10);
    cache.update({ marketId: 10, platform: 'polymarket', bestBid: yes.bestBid ?? 0.74, bestAsk: yes.bestAsk ?? 0.75, bidSize: yes.bidSize ?? 500, askSize: yes.askSize ?? 500, timestamp: 1000 });
    cache.update({ marketId: 10, platform: 'polymarket', outcome: 'no', bestBid: no.bestBid ?? 0, bestAsk: no.bestAsk ?? 0.01, bidSize: no.bidSize ?? 0, askSize: no.askSize ?? 10358, timestamp: 1000 });
    return cache;
  };

  test('c7674 shape: held NO @ $0.01 vs live YES bid $0.74 ⟹ flagged + blocked', () => {
    const c = oneMarket();
    const cache = cacheWith({ bestBid: 0.74, bestAsk: 0.75 }, { bestBid: 0, bestAsk: 0.01, askSize: 10358 });
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 100 }], 76, 0.01, cache, 2000, OPTS);
    expect(audit.staleComplementSideHeld).toBe(true);
    const graded = applyOmegaGrade('clean', [], audit);
    expect(graded.grade).toBe('blocked');
    expect(graded.reasons.join(' ')).toContain('stale complement side');
  });

  test('genuine tight box (YES bid 0.74, NO ask 0.24 → 2¢ box) does NOT flag', () => {
    const c = oneMarket();
    const cache = cacheWith({ bestBid: 0.74, bestAsk: 0.75 }, { bestBid: 0.23, bestAsk: 0.24, bidSize: 500, askSize: 500 });
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 100 }], 99, 0.01, cache, 2000, OPTS);
    expect(audit.staleComplementSideHeld).toBe(false);
  });

  test('holding the LIVE side (YES) of the incoherent market does NOT flag (only the phantom side is refused)', () => {
    const c = oneMarket();
    const cache = cacheWith({ bestBid: 0.74, bestAsk: 0.75 }, { bestBid: 0, bestAsk: 0.01, askSize: 10358 });
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'YES', shares: 100 }], 75, 0.01, cache, 2000, OPTS);
    expect(audit.staleComplementSideHeld).toBe(false);
  });

  test('synthetic NO (no real NO book) is coherent by construction — not flagged', () => {
    const c = oneMarket();
    const cache = new PriceCache();
    cache.track(10);
    cache.update({ marketId: 10, platform: 'polymarket', bestBid: 0.74, bestAsk: 0.75, bidSize: 500, askSize: 500, timestamp: 1000 });
    // no updateNo ⇒ NO is synthetic from the YES bid
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'NO', shares: 100 }], 30, 0.01, cache, 2000, OPTS);
    expect(audit.staleComplementSideHeld).toBe(false);
  });

  test('held YES stale-cheap vs a live NO bid ⟹ flagged (symmetric)', () => {
    const c = oneMarket();
    // YES ask $0.02 while NO bids $0.80 ⇒ 1−0.80−0.10 = 0.10 > 0.02 ⇒ stale YES.
    const cache = cacheWith({ bestBid: 0, bestAsk: 0.02, bidSize: 0, askSize: 9000 }, { bestBid: 0.80, bestAsk: 0.81, bidSize: 500, askSize: 500 });
    const audit = computeOmegaAudit(c, [{ marketId: 10, side: 'YES', shares: 100 }], 30, 0.01, cache, 2000, OPTS);
    expect(audit.staleComplementSideHeld).toBe(true);
  });
});

// permanent tripwire assertions
describe('§7.5 F-4 fired-portfolio tripwires', () => {
  test('(b) a pinned audit trips; (a) a DEAD-book variable trips; clean audit passes', () => {
    const c = cluster([q(1, 'a', [{ id: 10, platform: 'kalshi' }])], [], []);
    const cache = new PriceCache();
    cache.track(10);
    cache.update({ marketId: 10, platform: 'kalshi', bestBid: 0.4, bestAsk: 0.42, bidSize: 100, askSize: 100, timestamp: 1000 });
    const cleanAudit = { closureQuestionCount: 1, closureBookCount: 1, deadBookCount: 0, unquotedClosureQuestionCount: 0, quotedFraction: 1, relaxedRecheck: 'pass' as const, duplicateSuspectHeld: false, pinnedQuestions: [], distance1UnquotedSibling: false, mutexPriceContradictionSigma: null, staleComplementSideHeld: false, implicationPriceContradictionGap: null, relaxedOmega: false, stateCount: 1, sumOfAsksBelowFloor: null, sumOfAsksCandleMember: false };
    // clean: no trips.
    expect(checkFiredPortfolioTripwires(c, [{ marketId: 10, side: 'YES' }], cleanAudit, cache, 2000)).toHaveLength(0);
    // (b) pinned ⟹ trip.
    expect(checkFiredPortfolioTripwires(c, [{ marketId: 10, side: 'YES' }], { ...cleanAudit, pinnedQuestions: [1] }, cache, 2000).length).toBeGreaterThan(0);
    // (a) a variable on a DEAD (never-quoted) market ⟹ trip.
    cache.track(99); // sentinel, never quoted
    expect(checkFiredPortfolioTripwires(c, [{ marketId: 99, side: 'YES' }], cleanAudit, cache, 2000).length).toBeGreaterThan(0);
    // (c) missing audit ⟹ trip.
    expect(checkFiredPortfolioTripwires(c, [{ marketId: 10, side: 'YES' }], undefined, cache, 2000).length).toBeGreaterThan(0);
  });
});
