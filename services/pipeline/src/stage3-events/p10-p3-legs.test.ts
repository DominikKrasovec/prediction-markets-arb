/**
 * Leg-level guard classes covered here:
 *
 * P10: a moneyline leg mapped onto its opponent's outcome. Nothing compares the
 *      market's own native outcome vector to its assigned subject without this
 *      guard, so both legs of a cross-venue "arb" could price the same team — a
 *      guaranteed loss dressed as a clean fill. Plus the within-candidate
 *      double-map (one market bound to two outcome nodes), which the union
 *      reconciliation only ever checked on an N-platform expansion.
 * P3:  two legs of one fixture co-homing on a node whose only shared identity is
 *      the "A vs B" fixture string occupying the subject slot. A fixture name says
 *      the legs belong to the same match, never that they are the same claim.
 * P4:  the exact_score × match_winner pair is deliberately absent from
 *      NEVER_SAME_EVENT: this cell holds real event-level merges; the fake is
 *      fixed at outcome grain (outcome-grain partition + exact-score leg-drop),
 *      not by refusing the event merge. Locked by a negative test below.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateMatch, NEVER_SAME_EVENT,
  type EventMatchResult, type MatchContext, type LegMappingItem,
} from './guards.js';

// A valid 2-platform categorical match (mirrors guards.test.ts's fixture).
function validCategorical(): EventMatchResult {
  return {
    same_event: true,
    confidence: 0.95,
    reasoning: 'same 2028 race',
    canonical_event: '2028 US Presidential Winner',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      { outcome_id: 'trump', label: 'Trump', outcome_subject: 'Donald Trump' },
      { outcome_id: 'vance', label: 'Vance', outcome_subject: 'JD Vance' },
    ],
    leg_mapping: [
      { outcome_id: 'trump', platform: 'polymarket', market_id: 1 },
      { outcome_id: 'trump', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'vance', platform: 'polymarket', market_id: 3 },
      { outcome_id: 'vance', platform: 'kalshi', market_id: 4 },
    ],
  };
}

/** Narrowing helper: the refusal reason of a non-match verdict ('' when matched). */
function reasonOf(v: ReturnType<typeof validateMatch>): string {
  return 'reason' in v ? v.reason : '';
}
/** leg_mapping is optional on the type; validateMatch mutates it in place. */
function legs(r: EventMatchResult): LegMappingItem[] {
  return (r.leg_mapping ?? []) as LegMappingItem[];
}

const ctx = (): MatchContext => ({
  minConfidence: 0.6,
  marketPlatform: new Map([
    [1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi'],
  ]),
  marketScope: new Map(),
});

describe('P10 — native-outcome-vector leg coherence (mis-legged moneyline)', () => {
  const moneyline = (): EventMatchResult => ({
    same_event: true,
    confidence: 0.95,
    reasoning: 'same fixture',
    canonical_event: 'Arsenal vs Chelsea',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      { outcome_id: 'arsenal', label: 'Arsenal', outcome_subject: 'Arsenal' },
      { outcome_id: 'chelsea', label: 'Chelsea', outcome_subject: 'Chelsea' },
    ],
    leg_mapping: [
      { outcome_id: 'arsenal', platform: 'polymarket', market_id: 1 },
      { outcome_id: 'arsenal', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'chelsea', platform: 'polymarket', market_id: 3 },
      { outcome_id: 'chelsea', platform: 'kalshi', market_id: 4 },
    ],
  });
  const withVectors = (vectors: Map<number, string[] | null>): MatchContext => ({
    ...ctx(),
    marketNativeOutcomes: vectors,
  });

  test('a leg whose outcome vector CONTAINS its assigned subject is kept', () => {
    const v = validateMatch(moneyline(), withVectors(new Map([
      [1, ['Arsenal', 'Chelsea']], [2, ['Arsenal', 'Chelsea']],
      [3, ['Chelsea', 'Arsenal']], [4, ['Chelsea', 'Arsenal']],
    ])));
    expect(v.kind).toBe('match');
  });

  test('a leg whose vector prices NEITHER side of its assigned subject is dropped', () => {
    // market 2 prices a DIFFERENT fixture — it cannot be the Arsenal leg.
    // validateMatch mutates the proposal in place (leg_mapping := survivors).
    const r = moneyline();
    const v = validateMatch(r, withVectors(new Map([
      [1, ['Arsenal', 'Chelsea']], [2, ['Everton', 'Spurs']],
      [3, ['Chelsea', 'Arsenal']], [4, ['Chelsea', 'Arsenal']],
    ])));
    expect(v.kind).toBe('match');
    expect(legs(r).some((l) => l.market_id === 2)).toBe(false);
    expect(legs(r)).toHaveLength(3);
  });

  test('gutting a whole platform escalates to reject', () => {
    const v = validateMatch(moneyline(), withVectors(new Map([
      [1, ['Arsenal', 'Chelsea']], [2, ['Everton', 'Spurs']],
      [3, ['Chelsea', 'Arsenal']], [4, ['Everton', 'Spurs']],
    ])));
    expect(v.kind).toBe('reject');
    expect(reasonOf(v)).toContain('native-outcome conflict');
  });

  test('NULL-tolerant / inert: no vector, a {Yes,No} vector, or a non-2 vector never judges', () => {
    for (const vec of [null, ['Yes', 'No'], ['A', 'B', 'C']] as (string[] | null)[]) {
      const r = moneyline();
      const v = validateMatch(r, withVectors(new Map([
        [1, ['Arsenal', 'Chelsea']], [2, vec],
        [3, ['Chelsea', 'Arsenal']], [4, ['Chelsea', 'Arsenal']],
      ])));
      expect(v.kind).toBe('match');
      expect(legs(r)).toHaveLength(4);
    }
  });

  test('absent ctx.marketNativeOutcomes ⇒ the guard is skipped entirely', () => {
    expect(validateMatch(moneyline(), ctx()).kind).toBe('match');
  });
});

describe('P10 — WITHIN-candidate double-map detector', () => {
  test('one market bound to TWO outcomes inside a single proposal is rejected', () => {
    const r = validCategorical();
    legs(r).push({ outcome_id: 'vance', platform: 'polymarket', market_id: 1 });
    const v = validateMatch(r, ctx());
    expect(v.kind).toBe('reject');
    expect(reasonOf(v)).toContain('double-map');
  });

  test('the idempotent case (same market, SAME outcome twice) is allowed', () => {
    const r = validCategorical();
    legs(r).push({ outcome_id: 'trump', platform: 'polymarket', market_id: 1 });
    expect(validateMatch(r, ctx()).kind).toBe('match');
  });
});

describe('P3 — fixture-placeholder subject co-homing refusal', () => {
  const fixtureNode = (): EventMatchResult => ({
    same_event: true,
    confidence: 0.95,
    reasoning: 'same fixture',
    canonical_event: 'Arsenal vs Everton',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      // the EVENT name leaked into the SUBJECT slot
      { outcome_id: 'fixture', label: 'Arsenal vs Everton', outcome_subject: 'Arsenal vs Everton' },
      { outcome_id: 'draw', label: 'Draw', outcome_subject: 'Draw' },
    ],
    leg_mapping: [
      { outcome_id: 'fixture', platform: 'polymarket', market_id: 1 },
      { outcome_id: 'fixture', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'draw', platform: 'polymarket', market_id: 3 },
      { outcome_id: 'draw', platform: 'kalshi', market_id: 4 },
    ],
  });

  test('≥2 legs sharing ONLY a fixture-shaped subject are refused', () => {
    const v = validateMatch(fixtureNode(), ctx());
    expect(v.kind).toBe('reject');
    expect(reasonOf(v)).toContain('fixture-placeholder subject');
  });

  test('a REAL subject on any leg discriminates and the merge survives', () => {
    const v = validateMatch(fixtureNode(), {
      ...ctx(),
      marketSubject: new Map([[1, 'Arsenal'], [2, 'Arsenal']]),
    });
    expect(v.kind).toBe('match');
  });

  test('a SINGLE leg on the node is untouched (a fixture name IS whole-fixture identity)', () => {
    const r = fixtureNode();
    r.leg_mapping = legs(r).filter((l) => l.market_id !== 2);
    expect(validateMatch(r, ctx()).kind).toBe('match');
  });

  test('an ordinary subject is never mistaken for a fixture shape', () => {
    const r = fixtureNode();
    r.outcome_set![0]!.outcome_subject = 'Arsenal';
    expect(validateMatch(r, ctx()).kind).toBe('match');
  });
});

describe('P4 — exact_score × match_winner is NOT a NEVER_SAME_EVENT pair', () => {
  // The event merge in this cell is validated real; the fake is outcome-level
  // and fixed by the grain partition + the exact-score→winner leg-drop.
  // Re-adding the pair here would kill real recall.
  test('the pair is deliberately absent from guards.ts NEVER_SAME_EVENT', () => {
    const has = NEVER_SAME_EVENT.some(
      ([a, b]) =>
        (a === 'exact_score' && b === 'match_winner') ||
        (a === 'match_winner' && b === 'exact_score'),
    );
    expect(has).toBe(false);
  });
});
