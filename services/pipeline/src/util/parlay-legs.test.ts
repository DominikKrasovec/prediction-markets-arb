/**
 * Unit tests for the parlay-leg grammar.
 *
 * This grammar drives the parlay write-guard at sync (`db/sync.ts` →
 * `isParlayMarket`), which keeps combination-parlay markets out of the
 * pipeline. A regression here would let parlays leak in. Test coverage must include:
 *   - every leg kind (threshold / spread / total / binary)
 *   - the title-level "every leg must be recognized" rule
 *   - the dominance + contradiction matrix that drives downstream edge builders
 */
import { describe, test, expect } from 'bun:test';
import {
  parseLeg,
  parseParlayLegs,
  parseLegsFromConditionValue,
  legRelation,
  parlayDominance,
  parseMveLegSet,
  mveSetRelation,
  isParlayMarket,
  type Leg,
} from './parlay-legs.js';

describe('parseLeg', () => {
  test('threshold kind', () => {
    const leg = parseLeg('yes Cade Cunningham: 25+');
    expect(leg.kind).toBe('threshold');
    if (leg.kind !== 'threshold') return;
    expect(leg.polarity).toBe('yes');
    expect(leg.entity).toBe('cade cunningham');
    expect(leg.value).toBe(25);
  });

  test('threshold accepts decimal', () => {
    const leg = parseLeg('no Player X: 0.5+');
    expect(leg.kind).toBe('threshold');
    if (leg.kind !== 'threshold') return;
    expect(leg.value).toBe(0.5);
    expect(leg.polarity).toBe('no');
  });

  test('spread kind with points', () => {
    const leg = parseLeg('yes Lakers wins by over 7.5 points');
    expect(leg.kind).toBe('spread');
    if (leg.kind !== 'spread') return;
    expect(leg.entity).toBe('lakers');
    expect(leg.value).toBe(7.5);
    expect(leg.unit).toBe('points');
  });

  test('spread kind normalizes unit', () => {
    const goals = parseLeg('yes Liverpool wins by over 2 goals');
    expect(goals.kind).toBe('spread');
    if (goals.kind === 'spread') expect(goals.unit).toBe('goals');

    const runs = parseLeg('yes Yankees wins by over 4 runs');
    expect(runs.kind).toBe('spread');
    if (runs.kind === 'spread') expect(runs.unit).toBe('runs');
  });

  test('total kind', () => {
    const yesOver = parseLeg('yes Over 219.5 points scored');
    expect(yesOver.kind).toBe('total');
    if (yesOver.kind !== 'total') return;
    expect(yesOver.polarity).toBe('yes');
    expect(yesOver.value).toBe(219.5);
    expect(yesOver.unit).toBe('points');

    const noOver = parseLeg('no Over 219.5 points scored');
    expect(noOver.kind).toBe('total');
    if (noOver.kind === 'total') expect(noOver.polarity).toBe('no');
  });

  test('binary kind', () => {
    const leg = parseLeg('yes Manchester City');
    expect(leg.kind).toBe('binary');
    if (leg.kind !== 'binary') return;
    expect(leg.polarity).toBe('yes');
    expect(leg.entity).toBe('manchester city');
  });

  test('binary rejects threshold-shaped strings (no greedy fallthrough)', () => {
    // "Cade Cunningham: 25+" without the threshold regex matching would
    // otherwise become binary(entity="cade cunningham: 25+"). The hardening
    // rejects strings containing ':' or '+'.
    const leg = parseLeg('yes Cade Cunningham: 25');
    expect(leg.kind).toBe('unknown');
  });

  test('binary rejects spread-shaped strings', () => {
    const leg = parseLeg('yes Team wins by over 5 widgets');
    expect(leg.kind).toBe('unknown');
  });

  test('binary rejects total-shaped strings', () => {
    const leg = parseLeg('yes over 200 widgets scored');
    expect(leg.kind).toBe('unknown');
  });

  test('empty string is unknown', () => {
    expect(parseLeg('').kind).toBe('unknown');
    expect(parseLeg('   ').kind).toBe('unknown');
  });

  test('missing yes/no prefix is unknown', () => {
    expect(parseLeg('Cade Cunningham: 25+').kind).toBe('unknown');
  });
});

describe('parseParlayLegs', () => {
  test('returns null for non-comma title', () => {
    expect(parseParlayLegs('Will BTC reach $200k?')).toBeNull();
  });

  test('returns null for empty/null', () => {
    expect(parseParlayLegs(null)).toBeNull();
    expect(parseParlayLegs('')).toBeNull();
  });

  test('returns null when any leg is unparseable (CRITICAL — prevents non-parlay misclassification)', () => {
    // "Bitcoin price range on Apr 22, 2026?" contains a comma but is not a
    // parlay. The all-legs-known check rejects it. This is the property
    // that prevents downstream edge builders from misfiring on date-suffixed
    // crypto titles.
    expect(parseParlayLegs('Bitcoin price range on Apr 22, 2026?')).toBeNull();
    expect(parseParlayLegs('SOL Up or Down - April 21, 11:35AM-11:40AM ET')).toBeNull();
  });

  test('isParlayMarket — combination-parlay write-guard predicate', () => {
    // STRUCTURAL: any Kalshi KXMVE* ticker is a parlay regardless of title.
    expect(isParlayMarket({ platform: 'kalshi', platformId: 'KXMVESPORTS-X', title: 'anything' })).toBe(true);
    expect(isParlayMarket({ platform: 'kalshi', platformId: 'kxmvecross-y', title: null })).toBe(true);
    // Normal single-outcome Kalshi market is kept.
    expect(isParlayMarket({ platform: 'kalshi', platformId: 'KXNFLGAME-DET', title: 'Lions vs Bears' })).toBe(false);
    // TITLE-SHAPE: a strict ≥2-leg parlay title is blocked on any platform.
    expect(isParlayMarket({ platform: 'kalshi', platformId: 'KXNBA-1', title: 'yes Cade Cunningham: 25+,yes Franz Wagner: 10+' })).toBe(true);
    // The 9 Polymarket "combo-ish" titles must NOT be misclassified (no comma,
    // or a comma-part that isn't a yes/no leg → parseParlayLegs returns null).
    expect(isParlayMarket({ platform: 'polymarket', platformId: '0xabc', title: 'No change in Bank of England interest rates after July 2026 meeting?' })).toBe(false);
    expect(isParlayMarket({ platform: 'polymarket', platformId: '0xdef', title: 'No one announced as next James Bond?' })).toBe(false);
    expect(isParlayMarket({ platform: 'polymarket', platformId: '0xghi', title: 'No listed company closes Warner Bros acquisition by June 30, 2027' })).toBe(false);
  });

  test('parses a real 2-leg parlay', () => {
    const legs = parseParlayLegs('yes Cade Cunningham: 25+,yes Franz Wagner: 10+');
    expect(legs).not.toBeNull();
    expect(legs).toHaveLength(2);
    expect(legs![0].kind).toBe('threshold');
    expect(legs![1].kind).toBe('threshold');
  });

  test('parses a 3-leg parlay with mixed kinds', () => {
    const legs = parseParlayLegs(
      'yes Cade Cunningham: 25+,yes Franz Wagner: 10+,no Over 219.5 points scored',
    );
    expect(legs).not.toBeNull();
    expect(legs).toHaveLength(3);
    expect(legs!.map((l) => l.kind)).toEqual(['threshold', 'threshold', 'total']);
  });

  test('single-leg input returns null (parlay requires ≥2)', () => {
    expect(parseParlayLegs('yes Cade Cunningham: 25+')).toBeNull();
  });
});

describe('parseLegsFromConditionValue', () => {
  test('parses AND-joined fragments', () => {
    const legs = parseLegsFromConditionValue('yes Julius Randle: 20+ AND yes Denver Nuggets');
    expect(legs).not.toBeNull();
    expect(legs).toHaveLength(2);
  });

  test('accepts single-leg input (unlike parseParlayLegs)', () => {
    const legs = parseLegsFromConditionValue('yes Player: 10+');
    expect(legs).not.toBeNull();
    expect(legs).toHaveLength(1);
  });

  test('returns null on any unknown fragment', () => {
    expect(parseLegsFromConditionValue('yes Player: 10+ AND garbage stuff')).toBeNull();
  });

  test('returns null for null/empty', () => {
    expect(parseLegsFromConditionValue(null)).toBeNull();
    expect(parseLegsFromConditionValue('')).toBeNull();
  });
});

describe('legRelation', () => {
  const t = (entity: string, value: number, polarity: 'yes' | 'no' = 'yes'): Leg =>
    ({ kind: 'threshold', polarity, entity, value, raw: '' });

  test('same threshold yes-yes: stricter dominates looser', () => {
    expect(legRelation(t('p', 30), t('p', 25))).toBe('dominates');
    expect(legRelation(t('p', 25), t('p', 30))).toBe('neither');
  });

  test('same threshold no-no: lower cap dominates higher cap', () => {
    expect(legRelation(t('p', 5, 'no'), t('p', 10, 'no'))).toBe('dominates');
    expect(legRelation(t('p', 10, 'no'), t('p', 5, 'no'))).toBe('neither');
  });

  test('threshold yes vs no contradicts when ranges impossible', () => {
    // "yes p:25+" AND "no p:20+" both true ⟺ p ≥ 25 AND p < 20 → impossible
    expect(legRelation(t('p', 25, 'yes'), t('p', 20, 'no'))).toBe('contradicts');
    // "yes p:20+" AND "no p:25+" both true ⟺ p ≥ 20 AND p < 25 → satisfiable
    expect(legRelation(t('p', 20, 'yes'), t('p', 25, 'no'))).toBe('neither');
  });

  test('different entities are neither', () => {
    expect(legRelation(t('a', 25), t('b', 25))).toBe('neither');
  });

  test('binary same entity same polarity dominates', () => {
    const ba: Leg = { kind: 'binary', polarity: 'yes', entity: 'lakers', raw: '' };
    const bb: Leg = { kind: 'binary', polarity: 'yes', entity: 'lakers', raw: '' };
    expect(legRelation(ba, bb)).toBe('dominates');
  });

  test('binary opposite polarity contradicts', () => {
    const yes: Leg = { kind: 'binary', polarity: 'yes', entity: 'lakers', raw: '' };
    const no: Leg = { kind: 'binary', polarity: 'no', entity: 'lakers', raw: '' };
    expect(legRelation(yes, no)).toBe('contradicts');
  });

  test('any unknown leg is neither', () => {
    const u: Leg = { kind: 'unknown', raw: '' };
    expect(legRelation(u, t('p', 25))).toBe('neither');
    expect(legRelation(t('p', 25), u)).toBe('neither');
  });
});

describe('parlayDominance', () => {
  const thr = (entity: string, value: number, polarity: 'yes' | 'no' = 'yes'): Leg =>
    ({ kind: 'threshold', polarity, entity, value, raw: '' });
  const total = (value: number, polarity: 'yes' | 'no' = 'yes'): Leg =>
    ({ kind: 'total', polarity, value, unit: 'points', raw: '' });

  test('strict superset dominates: A=(p:30, q:15) implies B=(p:25, q:10)', () => {
    const a = [thr('p', 30), thr('q', 15)];
    const b = [thr('p', 25), thr('q', 10)];
    expect(parlayDominance(a, b)).toBe('implies');
  });

  test('contradiction wins over implication', () => {
    const a = [thr('p', 30, 'yes')];
    const b = [thr('p', 35, 'no')]; // p≥30 AND p<35 ⟹ satisfiable, no contradiction
    expect(parlayDominance(a, b)).toBe(null);

    const c = [thr('p', 30, 'yes')];
    const d = [thr('p', 25, 'no')]; // p≥30 AND p<25 ⟹ contradicts
    expect(parlayDominance(c, d)).toBe('excludes');
  });

  test('multi-game totals (≥2 total legs same unit) disables rule', () => {
    const a = [total(220), total(210)]; // two games, same unit
    const b = [total(220)];
    expect(parlayDominance(a, b)).toBe(null);
  });

  test('self-contradictory parlay returns null (does not produce spurious excludes)', () => {
    const a = [thr('p', 30, 'yes'), thr('p', 25, 'no')]; // impossible by itself
    const b = [thr('q', 10)];
    expect(parlayDominance(a, b)).toBe(null);
  });

  test('unknown leg in either side returns null', () => {
    const u: Leg = { kind: 'unknown', raw: '' };
    expect(parlayDominance([u], [thr('p', 25)])).toBe(null);
    expect(parlayDominance([thr('p', 25)], [u])).toBe(null);
  });

  test('B not fully covered by A returns null', () => {
    const a = [thr('p', 30)];
    const b = [thr('p', 25), thr('q', 10)]; // A says nothing about q
    expect(parlayDominance(a, b)).toBe(null);
  });
});

// MVE (Kalshi structured parlay) helpers
//
// These cover the fast path that bypasses title regex for Kalshi parlays by
// reading the structured (side, market_ticker) tuples persisted to
// condition_value during Stage 1 normalization.
// Format: "<side>|<ticker> AND <side>|<ticker> AND ..."

describe('parseMveLegSet', () => {
  test('parses a clean two-leg mve condition_value', () => {
    const got = parseMveLegSet(
      'yes|KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20 AND no|KXNBATOTAL-26MAY10NYKPHI-224',
    );
    expect(got).not.toBeNull();
    expect(got!.size).toBe(2);
    expect(got!.has('yes|KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20')).toBe(true);
    expect(got!.has('no|KXNBATOTAL-26MAY10NYKPHI-224')).toBe(true);
  });

  test('deduplicates identical legs (Set semantics)', () => {
    // Pathological: shouldn't happen in production but the Set ensures we
    // don't double-count if Kalshi ever emits a duplicate leg entry.
    const got = parseMveLegSet('yes|KXA-1 AND yes|KXA-1 AND no|KXB-2');
    expect(got!.size).toBe(2);
  });

  test('returns null for empty / null input', () => {
    expect(parseMveLegSet(null)).toBeNull();
    expect(parseMveLegSet(undefined)).toBeNull();
    expect(parseMveLegSet('')).toBeNull();
  });

  test('returns null for single-fragment input (parlay requires ≥2 legs)', () => {
    expect(parseMveLegSet('yes|KXA-1')).toBeNull();
  });

  test('returns null for non-mve format (rejects regex-parlay condition_value)', () => {
    // This is the old regex-path format — must NOT be parsed as mve, or
    // Stage 3's fast path would compare apples and oranges.
    expect(parseMveLegSet('yes Cade Cunningham: 20+ AND yes Franz Wagner: 10+')).toBeNull();
  });

  test('returns null when ANY fragment is malformed (all-or-nothing)', () => {
    expect(parseMveLegSet('yes|KXA-1 AND something else')).toBeNull();
    expect(parseMveLegSet('yes|KXA-1 AND maybe|KXB-2')).toBeNull(); // side must be yes/no
    expect(parseMveLegSet('yes|notATicker AND yes|KXB-2')).toBeNull(); // ticker must start with K
  });

  test('side must be lowercase exactly (matches Stage 1 emit format)', () => {
    expect(parseMveLegSet('YES|KXA-1 AND NO|KXB-2')).toBeNull();
    expect(parseMveLegSet('Yes|KXA-1 AND no|KXB-2')).toBeNull();
  });
});

describe('mveSetRelation', () => {
  const set = (...members: string[]) => new Set(members);

  test('equivalence — identical leg sets', () => {
    const a = set('yes|KXA-1', 'no|KXB-2');
    const b = set('yes|KXA-1', 'no|KXB-2');
    expect(mveSetRelation(a, b)).toBe('equivalence');
  });

  test('equivalence is order-independent (Set semantics)', () => {
    const a = set('yes|KXA-1', 'no|KXB-2', 'yes|KXC-3');
    const b = set('yes|KXC-3', 'yes|KXA-1', 'no|KXB-2');
    expect(mveSetRelation(a, b)).toBe('equivalence');
  });

  test('a_implies_b — A is strict superset of B', () => {
    // A requires 3 legs, B requires only 2 of those — A YES guarantees B YES
    const a = set('yes|KXA-1', 'no|KXB-2', 'yes|KXC-3');
    const b = set('yes|KXA-1', 'no|KXB-2');
    expect(mveSetRelation(a, b)).toBe('a_implies_b');
  });

  test('b_implies_a — B is strict superset of A (symmetric case)', () => {
    const a = set('yes|KXA-1');
    const b = set('yes|KXA-1', 'no|KXB-2');
    expect(mveSetRelation(a, b)).toBe('b_implies_a');
  });

  test('mutual_exclusion — same ticker with opposite sides', () => {
    const a = set('yes|KXA-1', 'yes|KXB-2');
    const b = set('no|KXA-1', 'yes|KXC-3');
    expect(mveSetRelation(a, b)).toBe('mutual_exclusion');
  });

  test('mutual_exclusion trumps would-be implication', () => {
    // A is strict superset of B by raw set size, but they collide on KXB
    // with opposite sides → exclusion wins (logically can't both be YES).
    const a = set('yes|KXA-1', 'yes|KXB-2', 'yes|KXC-3');
    const b = set('yes|KXA-1', 'no|KXB-2');
    expect(mveSetRelation(a, b)).toBe('mutual_exclusion');
  });

  test('null — incomparable leg sets (same size, different members)', () => {
    const a = set('yes|KXA-1', 'yes|KXB-2');
    const b = set('yes|KXC-3', 'yes|KXD-4');
    expect(mveSetRelation(a, b)).toBeNull();
  });

  test('null — overlap but each has unique legs (neither subset)', () => {
    const a = set('yes|KXA-1', 'yes|KXB-2');
    const b = set('yes|KXA-1', 'yes|KXC-3');
    expect(mveSetRelation(a, b)).toBeNull();
  });

  test('null — disjoint sets (no shared tickers at all)', () => {
    const a = set('yes|KXA-1', 'yes|KXB-2');
    const b = set('yes|KXC-3', 'no|KXD-4');
    expect(mveSetRelation(a, b)).toBeNull();
  });

  test('side disagreement on a SHARED ticker is exclusion; side agreement on a shared ticker plus other unique legs is still incomparable', () => {
    // Subtle: just because two parlays share a leg with the same side does
    // not mean one implies the other — each can have other independent legs.
    const a = set('yes|KXA-1', 'yes|KXB-2');
    const b = set('yes|KXA-1', 'no|KXC-3');
    expect(mveSetRelation(a, b)).toBeNull();
  });
});
