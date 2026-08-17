/**
 * Unit tests for the shared half-line reader (util/half-line.ts) — the parser
 * behind the value-blind-fold root gate + re-verification sweep. The anchor
 * cases pin cross-platform half-line mismatches such as:
 *   above_57  — Kalshi ">57" (≥58) vs PM "57 or more" (≥57)
 *   below_45  — Kalshi "<45" (≤44) vs PM "47 or fewer" (≤47)
 *   12_plus   — Kalshi "exactly 20" (at 20) vs PM "12 or more" (≥12)
 *   3.5       — Kalshi "over 3.5" (≥4) vs Limitless "3 or more" (≥3)
 */
import { describe, test, expect } from 'bun:test';
import {
  parseKalshiHalfLine, parseTextHalfLine, parseNormHalfLine, parseSlugHalfLine,
  parseMemberHalfLine, halfLinesConflict, halfLineKey, makeHalfLine,
  chooseKeepHalfLine, halfLineFoldDropMarketIds,
  type HalfLineMemberRef, type HalfLine,
} from './half-line.js';

describe('parseKalshiHalfLine — strike metadata → inclusive-integer boundary', () => {
  test('greater (strict above) → floor+1', () => {
    expect(parseKalshiHalfLine({ strike_type: 'greater', floor_strike: '57', cap_strike: null }))
      .toMatchObject({ side: 'above', bound: 58, raw: 57 });
    expect(parseKalshiHalfLine({ strike_type: 'greater', floor_strike: '3.5', cap_strike: null }))
      .toMatchObject({ side: 'above', bound: 4, raw: 3.5 });
  });
  test('less (strict below) → ceil-1', () => {
    expect(parseKalshiHalfLine({ strike_type: 'less', floor_strike: null, cap_strike: '45' }))
      .toMatchObject({ side: 'below', bound: 44, raw: 45 });
  });
  test('greater_or_equal / less_or_equal are inclusive', () => {
    expect(parseKalshiHalfLine({ strike_type: 'greater_or_equal', floor_strike: '57', cap_strike: null }))
      .toMatchObject({ side: 'above', bound: 57, raw: 57 });
    expect(parseKalshiHalfLine({ strike_type: 'less_or_equal', floor_strike: null, cap_strike: '47' }))
      .toMatchObject({ side: 'below', bound: 47, raw: 47 });
  });
  test('degenerate between (floor==cap) → at; real range → null', () => {
    expect(parseKalshiHalfLine({ strike_type: 'between', floor_strike: '20', cap_strike: '20' }))
      .toMatchObject({ side: 'at', bound: 20, raw: 20 });
    expect(parseKalshiHalfLine({ strike_type: 'between', floor_strike: '20', cap_strike: '25' })).toBeNull();
  });
  test('nested custom_strike unwrap', () => {
    expect(parseKalshiHalfLine({ strike_type: 'custom', floor_strike: null, cap_strike: null,
      custom_strike: '{"strike_type":"greater","floor_strike":"0.000015","cap_strike":""}' }))
      .toMatchObject({ side: 'above' });
  });
  test('unusable strikes → null', () => {
    expect(parseKalshiHalfLine({ strike_type: 'structured', floor_strike: null, cap_strike: null })).toBeNull();
    expect(parseKalshiHalfLine({ strike_type: null, floor_strike: null, cap_strike: null })).toBeNull();
  });
});

describe('parseTextHalfLine — tail-form title idioms', () => {
  test('N or more / N+ / at least → inclusive above', () => {
    expect(parseTextHalfLine('Will the Republican Party hold 57 or more Senate seats?'))
      .toMatchObject({ side: 'above', bound: 57, raw: 57 });
    expect(parseTextHalfLine('Rodri: 3+ shots')).toMatchObject({ side: 'above', bound: 3, raw: 3 });
    // side-flip regression (validator 1a): 'no more than N' is an inclusive BELOW —
    // without the lookbehind it parsed above:N+1 and both over- and under-refused
    expect(parseTextHalfLine('Will Arsenal score no more than 3 goals?')).toMatchObject({ side: 'below', raw: 3 });
    expect(parseTextHalfLine('Will Arsenal score more than 3 goals?')).toMatchObject({ side: 'above', raw: 3 });
    expect(parseTextHalfLine('Norway and England have 3 or more total goals?'))
      .toMatchObject({ side: 'above', bound: 3, raw: 3 });
    expect(parseTextHalfLine('at least 12 rate cuts')).toMatchObject({ side: 'above', bound: 12, raw: 12 });
  });
  test('N or fewer → inclusive below', () => {
    expect(parseTextHalfLine('Will the Republican Party hold 47 or fewer Senate seats?'))
      .toMatchObject({ side: 'below', bound: 47, raw: 47 });
  });
  test('more than / over → strict above', () => {
    expect(parseTextHalfLine('Will the Republican party hold more than 57 Senate seats?'))
      .toMatchObject({ side: 'above', bound: 58, raw: 57 });
    expect(parseTextHalfLine('Will over 3.5 goals be scored?')).toMatchObject({ side: 'above', bound: 4, raw: 3.5 });
  });
  test('fewer than / under → strict below', () => {
    expect(parseTextHalfLine('Will the Republican party hold fewer than 45 Senate seats?'))
      .toMatchObject({ side: 'below', bound: 44, raw: 45 });
  });
  test('12 or more Fed rate cuts → inclusive above', () => {
    expect(parseTextHalfLine('Will 12 or more Fed rate cuts happen in 2026?'))
      .toMatchObject({ side: 'above', bound: 12, raw: 12 });
  });
  test('no threshold idiom → null (bare exact count is never a threshold)', () => {
    expect(parseTextHalfLine('Real Madrid to win the match')).toBeNull();
    expect(parseTextHalfLine('Will the Fed cut rates 20 times?')).toBeNull();
  });
});

describe('parseSlugHalfLine — outcome-id reference line', () => {
  test('above_57 / below_45 / over_3.5 / ge_57 / le_45', () => {
    expect(parseSlugHalfLine('above_57')).toMatchObject({ side: 'above', raw: 57 });
    expect(parseSlugHalfLine('below_45')).toMatchObject({ side: 'below', raw: 45 });
    expect(parseSlugHalfLine('over_3.5')).toMatchObject({ side: 'above', bound: 4, raw: 3.5 });
    expect(parseSlugHalfLine('ge_57')).toMatchObject({ side: 'above', bound: 57, raw: 57 });
    expect(parseSlugHalfLine('le_45')).toMatchObject({ side: 'below', bound: 45, raw: 45 });
  });
  test('12_plus_cuts → inclusive above 12', () => {
    expect(parseSlugHalfLine('12_plus_cuts')).toMatchObject({ side: 'above', bound: 12, raw: 12 });
  });
  test('non-numeric slug → null', () => {
    expect(parseSlugHalfLine('real_madrid')).toBeNull();
  });
});

describe('the four anchor fakes — members provably conflict', () => {
  const K = (st: string, fl: string | null, cp: string | null, title: string) =>
    parseMemberHalfLine({ strike_type: st, floor_strike: fl, cap_strike: cp, custom_strike: null, condition_direction: null, value_primary: null, title });
  const T = (title: string) =>
    parseMemberHalfLine({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null, condition_direction: null, value_primary: null, title });

  test('q6786 above_57: Kalshi >57 (≥58) conflicts PM "57 or more" (≥57)', () => {
    const k = K('greater', '57', null, 'Will the Republican party hold more than 57 Senate seats in the 120th Congress?');
    const p = T('Will the Republican Party hold 57 or more Senate seats after the 2026 election?');
    expect(halfLineKey(k!)).toBe('above:58');
    expect(halfLineKey(p!)).toBe('above:57');
    expect(halfLinesConflict(k, p)).toBe(true);
  });
  test('q6787 below_45: Kalshi <45 (≤44) conflicts PM "47 or fewer" (≤47)', () => {
    const k = K('less', null, '45', 'Will the Republican party hold fewer than 45 Senate seats in the 120th Congress?');
    const p = T('Will the Republican Party hold 47 or fewer Senate seats after the 2026 election?');
    expect(halfLinesConflict(k, p)).toBe(true);
  });
  test('q7802 12_plus_cuts: Kalshi "exactly 20" (at 20) conflicts PM "12 or more" (≥12)', () => {
    const k = parseMemberHalfLine({ strike_type: 'between', floor_strike: '20', cap_strike: '20', custom_strike: null, condition_direction: 'at', value_primary: '20', title: 'Will the Fed cut rates 20 times?' });
    const p = T('Will 12 or more Fed rate cuts happen in 2026?');
    expect(halfLineKey(k!)).toBe('at:20');
    expect(halfLineKey(p!)).toBe('above:12');
    expect(halfLinesConflict(k, p)).toBe(true);
  });
  test('q31351350 over_3.5: Kalshi "over 3.5" (≥4) conflicts Limitless "3 or more" (≥3)', () => {
    const k = K('greater', '3.5', null, 'Will over 3.5 goals be scored?');
    const l = T('Vikingur Reykjavik and Hapoel Beer Sheva have 3 or more total goals?');
    expect(halfLineKey(k!)).toBe('above:4');
    expect(halfLineKey(l!)).toBe('above:3');
    expect(halfLinesConflict(k, l)).toBe(true);
  });
});

describe('legit merges do NOT conflict (no false refusal)', () => {
  test('Kalshi "over 2.5 goals" (≥3) agrees with "3+ goals" (≥3)', () => {
    const k = parseMemberHalfLine({ strike_type: 'greater', floor_strike: '2.5', cap_strike: null, custom_strike: null, condition_direction: null, value_primary: null, title: 'over 2.5 goals' });
    const t = parseTextHalfLine('3+ goals');
    expect(halfLineKey(k!)).toBe(halfLineKey(t!)); // above:3 both
    expect(halfLinesConflict(k, t)).toBe(false);
  });
  test('shaped ≥ vs shaped half-line agree; unreadable member = no evidence', () => {
    const a = parseNormHalfLine({ condition_direction: 'above', value_primary: '2.5' }); // 3+ goals stored as 2.5
    const b = makeHalfLine('above', 3, 'inclusive');
    expect(halfLinesConflict(a, b)).toBe(false);
    expect(halfLinesConflict(a, null)).toBe(false);
  });
});

describe('CONTINUOUS units — no ±1 fake-conflict (the false-positive guard)', () => {
  const M = (f: Parameters<typeof parseMemberHalfLine>[0]) => parseMemberHalfLine(f);
  test('CPI percent: Kalshi shaped ">3%" (above/3/percent) does NOT conflict PM "more than 3%"', () => {
    // percent is continuous → compare raw, not the integer collapse.
    const k = M({ strike_type: 'greater', floor_strike: '3', cap_strike: null, custom_strike: null,
      condition_direction: 'above', value_primary: '3', value_unit: 'percent', title: 'How high will CPI get this year?' });
    const p = M({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Will inflation reach more than 3% in 2026?' });
    expect(k!.integral).toBe(false);
    expect(p!.integral).toBe(false);
    expect(halfLinesConflict(k, p)).toBe(false);
  });
  test('USD price: Kalshi ">$100" does NOT conflict PM "$100+"', () => {
    // USD is continuous → raw compare.
    const k = M({ strike_type: 'greater', floor_strike: '100', cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'What will the price of GTA VI be?' });
    const p = M({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Will GTA 6 cost $100+?' });
    expect(halfLinesConflict(k, p)).toBe(false);
  });
  test('but a REAL percent gap still conflicts (>3% vs >4%)', () => {
    const a = M({ strike_type: 'greater', floor_strike: '3', cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, value_unit: 'percent', title: 'CPI above 3%' });
    const b = M({ strike_type: 'greater', floor_strike: '4', cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, value_unit: 'percent', title: 'CPI above 4%' });
    expect(halfLinesConflict(a, b)).toBe(true);
  });
});

describe('shared fold-refusal keep/drop decision (Feed-A link gate = sweep = persist gate)', () => {
  const mk = (market_id: number, hl: HalfLine | null): HalfLineMemberRef => ({ market_id, half_line: hl });
  const above = (raw: number, integral = true) => makeHalfLine('above', raw, 'inclusive', integral);

  test('conflicting member is dropped; the slug-line member is kept', () => {
    const slug = parseSlugHalfLine('above_57'); // reference line
    // m1 agrees with the slug (≥57); m2 is the off-by-one ≥58 (a strict ">57" fold).
    const members = [mk(1, above(57)), mk(2, makeHalfLine('above', 57.5, 'strict', true))];
    expect(halfLineKey(members[1].half_line!)).toBe('above:58');
    const keep = chooseKeepHalfLine(slug, members);
    expect(halfLineKey(keep!)).toBe('above:57');
    expect(halfLineFoldDropMarketIds(slug, members)).toEqual([2]); // drop the ≥58 member
  });
  test('same-line members are all kept (no conflict → empty drop set)', () => {
    const slug = parseSlugHalfLine('above_57');
    const members = [mk(1, above(57)), mk(2, above(57)), mk(3, above(57))];
    expect(halfLineFoldDropMarketIds(slug, members)).toEqual([]);
  });
  test('NULL / unreadable members pass — never dropped, never a keep pick', () => {
    const slug = parseSlugHalfLine('above_57');
    // one readable ≥57, one unreadable (no half-line): no conflict → nothing dropped.
    expect(halfLineFoldDropMarketIds(slug, [mk(1, above(57)), mk(2, null)])).toEqual([]);
    // even alongside a conflicting pair, the NULL member itself is never in the drop set.
    const drops = halfLineFoldDropMarketIds(slug, [mk(1, above(57)), mk(2, makeHalfLine('above', 57.5, 'strict', true)), mk(3, null)]);
    expect(drops).not.toContain(3);
    expect(drops).toEqual([2]);
  });
  test('no slug line → plurality group kept, minority conflicting members dropped', () => {
    // 2 members ≥3, 1 member ≥4 (real off-by-one); no parseable slug.
    const members = [mk(10, above(3)), mk(11, above(3)), mk(12, above(4))];
    const keep = chooseKeepHalfLine(null, members);
    expect(halfLineKey(keep!)).toBe('above:3'); // plurality
    expect(halfLineFoldDropMarketIds(null, members)).toEqual([12]);
  });
  test('mixed-grain agreement is NOT dropped (uses halfLinesConflict, not raw keys)', () => {
    const slug = parseSlugHalfLine('above_3');
    // integral "over 2.5" (≥3) + unknown-grain "3+" (raw 3) → same region, keep both.
    const members = [mk(1, makeHalfLine('above', 2.5, 'strict', true)), mk(2, makeHalfLine('above', 3, 'inclusive', false))];
    expect(halfLineFoldDropMarketIds(slug, members)).toEqual([]);
  });
});

describe('COMPOUND-UNIT title hints — multi-word count units read as integer-grain', () => {
  const T = (title: string) =>
    parseMemberHalfLine({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title });

  test('"executive orders" off-by-one now conflicts (>10 ≥11 vs "10 or more" ≥10)', () => {
    const a = T('Will Trump sign more than 10 executive orders this month?');   // strict above → 11
    const b = T('Will Trump sign 10 or more executive orders this month?');     // inclusive above → 10
    expect(a!.integral).toBe(true);
    expect(b!.integral).toBe(true);
    expect(halfLineKey(a!)).toBe('above:11');
    expect(halfLineKey(b!)).toBe('above:10');
    expect(halfLinesConflict(a, b)).toBe(true);
  });
  test('"total bases" same-line pair does NOT conflict ("over 2.5" ≥3 vs "3+" ≥3)', () => {
    const a = T('Aaron Judge: over 2.5 total bases?');   // ≥3
    const b = T('Aaron Judge: 3+ total bases?');          // ≥3
    expect(a!.integral).toBe(true);
    expect(b!.integral).toBe(true);
    expect(halfLinesConflict(a, b)).toBe(false);
  });
  test('"total bases" real off-by-one conflicts ("over 3.5" ≥4 vs "3+" ≥3)', () => {
    const a = T('Aaron Judge: over 3.5 total bases?');   // ≥4
    const b = T('Aaron Judge: 3+ total bases?');          // ≥3
    expect(halfLinesConflict(a, b)).toBe(true);
  });
  test('other mined compound families classify integral', () => {
    expect(T('Jones: over 1.5 stolen bases?')!.integral).toBe(true);
    expect(T('Pitcher: more than 17 outs recorded?')!.integral).toBe(true);
    expect(T('RB: 100 or more rushing yards?')!.integral).toBe(true);
    expect(T('WR: 2+ receiving touchdowns?')!.integral).toBe(true);
    expect(T('How many teams remaining: more than 4?')!.integral).toBe(true);
    expect(T('Trump: 3 or more primary losses?')!.integral).toBe(true);
  });
  test('conservative default holds — a continuous compound stays continuous', () => {
    // "percentage points" must NOT be captured (CONTINUOUS_TITLE_RX wins first),
    // and an unlisted phrase stays unknown → continuous → gate passes.
    const pct = T('Will the spread move more than 2 percentage points?');
    expect(pct!.integral).toBe(false);
    const unlisted = T('Will approval move more than 3 clicks?');
    expect(unlisted!.integral).toBe(false);
  });
});

describe('MIXED GRAIN — known-integral vs unknown-grain (over-refusal fix)', () => {
  test('"over 2.5 goals" (integral ≥3) does NOT conflict an unlabelled "3+" (unknown, raw 3)', () => {
    const integral = makeHalfLine('above', 2.5, 'strict', true);          // bound 3, integral
    const unknown = makeHalfLine('above', 3, 'inclusive', false);         // bound 3, continuous-default
    expect(integral!.integral).toBe(true);
    expect(unknown!.integral).toBe(false);
    // both directions — the relation is symmetric
    expect(halfLinesConflict(integral, unknown)).toBe(false);
    expect(halfLinesConflict(unknown, integral)).toBe(false);
  });
  test('via the parser: "over 2.5 goals" vs a bare "Arsenal to score 3+" (no unit hint)', () => {
    const k = parseMemberHalfLine({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Will over 2.5 goals be scored?' });     // goals → integral
    const p = parseMemberHalfLine({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Arsenal to score 3+' });                // no count noun → unknown
    expect(k!.integral).toBe(true);
    expect(p!.integral).toBe(false);
    expect(halfLinesConflict(k, p)).toBe(false);   // was a false refusal before the fix
  });
  test('the Senate off-by-one STILL conflicts when only ONE side carries the unit', () => {
    // Kalshi ">57 seats" is integral (title carries 'seats'); an unlabelled PM
    // "57 or more" is unknown-grain. Adopting the integer grain must preserve the
    // off-by-one: above:58 vs above:57.
    const k = parseMemberHalfLine({ strike_type: 'greater', floor_strike: '57', cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Will the GOP hold more than 57 Senate seats?' });
    const p = parseMemberHalfLine({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null,
      condition_direction: null, value_primary: null, title: 'Will the GOP get 57 or more?' });
    expect(k!.integral).toBe(true);
    expect(p!.integral).toBe(false);
    expect(halfLineKey(k!)).toBe('above:58');
    expect(halfLinesConflict(k, p)).toBe(true);
  });
  test('a real off-by-one in the mixed case conflicts ("over 3.5 goals" ≥4 vs unknown "3+")', () => {
    const k = makeHalfLine('above', 3.5, 'strict', true);   // bound 4, integral
    const p = makeHalfLine('above', 3, 'inclusive', false); // bound 3, unknown
    expect(halfLinesConflict(k, p)).toBe(true);
  });
  test('a FRACTIONAL unknown raw stays continuous → conservative pass (no ±1 fabrication)', () => {
    const integral = makeHalfLine('above', 3, 'inclusive', true);   // bound 3
    const unknown = makeHalfLine('above', 3.2, 'strict', false);    // raw 3.2 — not integer-grain-compatible
    expect(halfLinesConflict(integral, unknown)).toBe(false);
  });
});
