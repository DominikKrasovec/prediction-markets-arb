/**
 * member-cohesion predicate tests. Pure / no DB.
 */
import { test, expect } from 'bun:test';
import {
  memberCohesion,
  memberPairConflict,
  partitionCohesiveMembers,
  type MemberFacts,
} from './member-cohesion.js';

/** Fixture helper: every field NULL unless overridden (NULL-tolerant baseline). */
function mf(over: Partial<MemberFacts> & { market_id: number; platform: string }): MemberFacts {
  return {
    title: null,
    platform_event_id: null,
    end_date: null,
    event_ticker: null,
    yes_sub_title: null,
    event_kind: null,
    condition_direction: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    condition_date: null,
    ...over,
  };
}

// value_primary disagreement

test('q13950: PM "O/U 0.5 goals" (vp 0.5) vs Kalshi "over 1.5 goals" (vp 1.5) → reject', () => {
  const pm = mf({
    market_id: 3705486, platform: 'polymarket', title: 'Elche CF vs. Getafe CF: O/U 0.5',
    platform_event_id: '454276', event_kind: 'match_total_metric',
    condition_direction: 'above', value_primary: '0.5', value_unit: 'goals', condition_date: '2026-05-17',
  });
  const kalshi = mf({
    market_id: 4008038, platform: 'kalshi', title: 'Will over 1.5 goals be scored?',
    platform_event_id: 'kalshi:event:KXLALIGATOTAL-26MAY17ELCGET',
    event_ticker: 'KXLALIGATOTAL-26MAY17ELCGET', yes_sub_title: 'Over 1.5 goals scored',
    event_kind: 'match_total_metric', condition_direction: 'above',
    value_primary: '1.5', value_unit: 'goals', condition_date: '2026-05-17',
  });
  const v = memberCohesion([pm], kalshi);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('value_primary');
});

test('q7150: Kalshi "Rory top 5" (vp 5) vs PM "Top 10" (vp 10) → reject', () => {
  const kalshi = mf({
    market_id: 4187092, platform: 'kalshi', title: 'PGA Championship: Will Rory McIlroy finish top 5?',
    event_ticker: 'KXPGATOP5-PGC26', yes_sub_title: 'Rory McIlroy',
    platform_event_id: 'kalshi:event:KXPGATOP5-PGC26',
    event_kind: 'player_prop_threshold', condition_direction: 'below',
    value_primary: '5', value_unit: 'rank', condition_date: '2026-01-01',
  });
  const pm = mf({
    market_id: 4237873, platform: 'polymarket', title: 'Will Rory McIlroy finish in the Top 10 at the 2026 PGA Championship?',
    platform_event_id: '474339', event_kind: 'player_prop_threshold', condition_direction: 'below',
    value_primary: '10', value_unit: 'rank', condition_date: '2026-01-01',
  });
  const v = memberCohesion([kalshi], pm);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('value_primary');
});

test('q5519: Limitless Fed "No change" (vp 0) vs Predict "25 bps increase" (vp 25, mutex) → reject', () => {
  const noChange = mf({
    market_id: 4756403, platform: 'limitless', title: 'Fed Decision in June?: No change',
    platform_event_id: 'limitless:event:0xeb35…', event_kind: 'policy_action',
    value_primary: '0', value_unit: 'bps', condition_date: '2026-06-01T00:00:00Z',
  });
  const hike = mf({
    market_id: 3645028, platform: 'predict', title: 'Fed Decision in June?: 25 bps increase',
    platform_event_id: '10607', event_kind: 'policy_action', condition_direction: 'at',
    value_primary: '25', value_unit: 'bps', condition_date: '2026-06-30',
  });
  // value_primary 0 vs 25 fires first; the day-grain date disagreement would too.
  const v = memberCohesion([noChange], hike);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('value_primary');
});

test('11-strike ladder collapse (q10408 class): strikes 2.5 vs 3.5 of one ladder → reject (both arms)', () => {
  const s1 = mf({
    market_id: 100, platform: 'kalshi', title: 'Will the total be over 2.5 runs?',
    event_ticker: 'KXMLBTOTAL-X', yes_sub_title: 'Over 2.5', platform_event_id: 'kalshi:event:KXMLBTOTAL-X',
    event_kind: 'match_total_metric', condition_direction: 'above', value_primary: '2.5', value_unit: 'runs',
  });
  const s2 = mf({
    market_id: 101, platform: 'kalshi', title: 'Will the total be over 3.5 runs?',
    event_ticker: 'KXMLBTOTAL-X', yes_sub_title: 'Over 3.5', platform_event_id: 'kalshi:event:KXMLBTOTAL-X',
    event_kind: 'match_total_metric', condition_direction: 'above', value_primary: '3.5', value_unit: 'runs',
  });
  const v = memberCohesion([s1], s2);
  expect(v.ok).toBe(false); // sibling structure AND value_primary both refuse
});

// direction / numeric YES-region conflicts

test('weather Kalshi ">64°" vs PM "≥74°F": value differs → reject', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', condition_direction: 'above', value_primary: '64', value_unit: '°F' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_direction: 'above', value_primary: '74', value_unit: '°F' });
  expect(memberCohesion([a], b).ok).toBe(false);
});

test('BTC "between 79,500" vs "reach 89,000": direction between vs above → reject', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', condition_direction: 'between', value_primary: '79500', value_secondary: '81000', value_unit: 'usd' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_direction: 'above', value_primary: '89000', value_unit: 'usd' });
  const v = memberCohesion([a], b);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('condition_direction');
});

test('direction synonyms fold (greater_or_equal ≡ above): no false refusal', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', condition_direction: 'greater_or_equal', value_primary: '200' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_direction: 'above', value_primary: '200' });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('event_kind disagreement (both non-NULL) → reject', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', event_kind: 'weather_extreme' });
  const b = mf({ market_id: 2, platform: 'polymarket', event_kind: 'match_total_metric' });
  const v = memberCohesion([a], b);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('event_kind');
});

test('value_secondary disagreement (both non-NULL) → reject', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', condition_direction: 'between', value_primary: '100', value_secondary: '110' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_direction: 'between', value_primary: '100', value_secondary: '120' });
  expect(memberCohesion([a], b).ok).toBe(false);
});

test('value_unit disagreement (both non-NULL) → reject; case fold tolerated', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', value_unit: 'goals' });
  const b = mf({ market_id: 2, platform: 'polymarket', value_unit: 'corners' });
  expect(memberCohesion([a], b).ok).toBe(false);
  const c = mf({ market_id: 3, platform: 'polymarket', value_unit: 'Goals' });
  expect(memberCohesion([a], c).ok).toBe(true);
});

// shared comparator: representational tolerance reaches the mint belt

test('W1-E: Kalshi strict "<74°" (strike_type less) vs PM "73°F or below" → ALLOW (same integer YES-region)', () => {
  const a = mf({
    market_id: 1, platform: 'kalshi', condition_direction: 'below',
    value_primary: '74', value_unit: 'fahrenheit', strike_type: 'less',
  });
  const b = mf({
    market_id: 2, platform: 'polymarket', condition_direction: 'below',
    value_primary: '73', value_unit: 'fahrenheit',
  });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('W1-E: singular/plural unit drift ("goal" vs "goals") no longer refuses', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', value_unit: 'goal', value_primary: '2.5', condition_direction: 'above' });
  const b = mf({ market_id: 2, platform: 'polymarket', value_unit: 'goals', value_primary: '2.5', condition_direction: 'above' });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('W1-E: touch-vs-snapshot shape conflict refuses at mint when shapes are supplied', () => {
  const a = mf({
    market_id: 1, platform: 'polymarket', condition_direction: 'above',
    value_primary: '89000', value_unit: 'USD', condition_shape: 'monotonic_threshold',
  });
  const b = mf({
    market_id: 2, platform: 'kalshi', condition_direction: 'above',
    value_primary: '89000', value_unit: 'USD', condition_shape: 'point_in_time',
  });
  const v = memberCohesion([a], b);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('touch vs snapshot');
});

// NULL tolerance

test('NULL-tolerant: shaped + unshaped pair passes every field gate', () => {
  // An unshaped PM member (no normalization row) vs a shaped Kalshi one:
  // every field check is one-side-NULL → no refusal on fields (the PM pair's
  // split happens structurally, see the same-pe test below).
  const unshapedPm = mf({
    market_id: 3730632, platform: 'polymarket',
    title: 'Will fewer than 200 tornadoes occur in the United States in May?',
    platform_event_id: '424754',
  });
  const shapedKalshi = mf({
    market_id: 4202991, platform: 'kalshi', title: 'Will there be more than 200 tornadoes in May?',
    event_ticker: 'KXTORNADO-26MAY', yes_sub_title: 'Above 200',
    platform_event_id: 'kalshi:event:KXTORNADO-26MAY',
    event_kind: 'weather_extreme', condition_direction: 'above',
    value_primary: '200', value_unit: 'tornadoes', condition_date: '2026-05-01',
  });
  expect(memberCohesion([unshapedPm], shapedKalshi).ok).toBe(true);
});

test('identical shaped members pass (true cross-platform equivalence)', () => {
  const a = mf({
    market_id: 1, platform: 'kalshi', title: 'Will over 2.5 goals be scored?',
    event_kind: 'match_total_metric', condition_direction: 'above',
    value_primary: '2.5', value_unit: 'goals', condition_date: '2026-05-17',
  });
  const b = mf({
    market_id: 2, platform: 'polymarket', title: 'Real Madrid vs Barcelona: O/U 2.5',
    event_kind: 'match_total_metric', condition_direction: 'above',
    value_primary: '2.50', value_unit: 'goals', condition_date: '2026-05-17T19:00:00Z',
  });
  // numeric equality tolerates '2.5' vs '2.50'; day-grain tolerates date vs timestamp.
  expect(memberCohesion([a], b).ok).toBe(true);
});

// structural sibling refusal

test('q9763: two Kalshi siblings, same event_ticker, yst Seattle vs Houston → reject', () => {
  const seattle = mf({
    market_id: 4710818, platform: 'kalshi', title: 'Seattle vs Houston Winner?',
    event_ticker: 'KXMLBGAME-26MAY132010SEAHOU', yes_sub_title: 'Seattle',
    platform_event_id: 'kalshi:event:KXMLBGAME-26MAY132010SEAHOU',
    event_kind: 'match_winner', condition_date: '2026-05-13T20:10:00',
  });
  const houston = mf({
    market_id: 4710819, platform: 'kalshi', title: 'Seattle vs Houston Winner?',
    event_ticker: 'KXMLBGAME-26MAY132010SEAHOU', yes_sub_title: 'Houston',
    platform_event_id: 'kalshi:event:KXMLBGAME-26MAY132010SEAHOU',
    event_kind: 'match_winner', condition_date: '2026-05-13T20:10:00',
  });
  const v = memberCohesion([seattle], houston);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('yes_sub_title');
  // NOTE: identical titles — the same-pe folded-title test alone would pass them
  // vacuously; the yst discriminator is load-bearing.
});

test('q11556: two unshaped PM markets, same platform_event, differing titles → reject', () => {
  const fewer = mf({
    market_id: 3730632, platform: 'polymarket',
    title: 'Will fewer than 200 tornadoes occur in the United States in May?',
    platform_event_id: '424754',
  });
  const bucket = mf({
    market_id: 3730633, platform: 'polymarket',
    title: 'Will 200 to 229 tornadoes occur in the United States in May?',
    platform_event_id: '424754',
  });
  const v = memberCohesion([fewer], bucket);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('same-platform_event');
});

test('duplicate listing: same platform_event + IDENTICAL folded title → allow', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Atlético Madrid vs Sevilla: Draw', platform_event_id: '999' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'atletico madrid vs sevilla: draw  ', platform_event_id: '999' });
  expect(memberCohesion([a], b).ok).toBe(true); // accent+case+trim fold = identical
});

test('same Kalshi event_ticker + IDENTICAL yst → falls through to title test (dup allow)', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', title: 'Arsenal vs Everton Winner?', event_ticker: 'KXEPL-X', yes_sub_title: 'Arsenal', platform_event_id: 'kalshi:event:KXEPL-X' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'Arsenal vs Everton Winner?', event_ticker: 'KXEPL-X', yes_sub_title: 'Arsenal', platform_event_id: 'kalshi:event:KXEPL-X' });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('cross-platform pair never trips the structural tier', () => {
  // predict + kalshi members of one fixture node — different platforms, the
  // event_ticker/pe tests are platform-scoped.
  const predict = mf({ market_id: 3647343, platform: 'predict', title: 'Seattle Mariners vs. Houston Astros', platform_event_id: '71973', event_kind: 'match_winner', condition_date: '2026-05-13' });
  const kalshi = mf({ market_id: 4710818, platform: 'kalshi', title: 'Seattle vs Houston Winner?', event_ticker: 'KXMLBGAME-26MAY132010SEAHOU', yes_sub_title: 'Seattle', platform_event_id: 'kalshi:event:KXMLBGAME-26MAY132010SEAHOU', event_kind: 'match_winner', condition_date: '2026-05-13T20:10:00' });
  expect(memberCohesion([predict], kalshi).ok).toBe(true);
});

// temporal: day grain for non-candle kinds, exact + duration for candles

test('day grain: date-only vs same-day timestamp agree (q9763 regression guard)', () => {
  const a = mf({ market_id: 1, platform: 'predict', event_kind: 'match_winner', condition_date: '2026-05-13' });
  const b = mf({ market_id: 2, platform: 'kalshi', event_kind: 'match_winner', condition_date: '2026-05-13T20:10:00' });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('day grain: different days → reject (DeepSeek "by Dec 31" vs "by June 30" class)', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', condition_date: '2026-12-31' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_date: '2026-06-30' });
  const v = memberCohesion([a], b);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('condition_date');
});

test('candle: same open, EXPLICIT 5m vs 15m ranges → reject (q200)', () => {
  // condition_date identical, all value fields NULL — the duration lives only
  // in the title range. The parser is the only discriminator.
  const m15 = mf({
    market_id: 3657884, platform: 'polymarket', title: 'BNB Up or Down - May 10, 12:00PM-12:15PM ET',
    event_kind: 'candle_direction', condition_direction: 'above', condition_date: '2026-05-10T16:00:00Z',
  });
  const m5 = mf({
    market_id: 3657887, platform: 'polymarket', title: 'BNB Up or Down - May 10, 12:00PM-12:05PM ET',
    event_kind: 'candle_direction', condition_direction: 'above', condition_date: '2026-05-10T16:00:00Z',
  });
  const v = memberCohesion([m15], m5);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('candle duration');
});

test('candle: identical explicit windows on both platforms → allow', () => {
  const a = mf({ market_id: 1, platform: 'predict', title: 'Bitcoin Up or Down - May 13, 5PM-5:15PM ET', event_kind: 'candle_direction', condition_date: '2026-05-13T21:00:00Z' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Bitcoin Up or Down - May 13, 5:00PM-5:15PM ET', event_kind: 'candle_direction', condition_date: '2026-05-13T21:00:00Z' });
  expect(memberCohesion([a], b).ok).toBe(true);
});

test('candle: ambiguous single-hour title defers (no refusal on a guess)', () => {
  // "12PM ET" could be the hourly candle or a top-of-hour 5m — matcher doctrine
  // (candle-window.ts) is to defer; the belt must not refuse on ambiguity.
  const hourish = mf({ market_id: 1, platform: 'predict', title: 'BNB Up or Down - May 10, 12PM ET', event_kind: 'candle_direction', condition_date: '2026-05-10T16:00:00Z' });
  const m15 = mf({ market_id: 2, platform: 'polymarket', title: 'BNB Up or Down - May 10, 12:00PM-12:15PM ET', event_kind: 'candle_direction', condition_date: '2026-05-10T16:00:00Z' });
  expect(memberCohesion([hourish], m15).ok).toBe(true);
});

test('candle: M-MATCH-4 window snap disambiguates the single-hour title → reject 60m vs 15m', () => {
  // end_date − condition_date = exactly 60 min ⇒ the single-hour title SNAPS to a
  // 60m candle (ambiguous=false) and now provably disagrees with the 15m range.
  const hourly = mf({
    market_id: 1, platform: 'polymarket', title: 'BNB Up or Down - May 10, 12PM ET',
    event_kind: 'candle_direction', condition_date: '2026-05-10T16:00:00Z',
    end_date: '2026-05-10 17:00:00+00',
  });
  const m15 = mf({ market_id: 2, platform: 'polymarket', title: 'BNB Up or Down - May 10, 12:00PM-12:15PM ET', event_kind: 'candle_direction', condition_date: '2026-05-10T16:00:00Z' });
  const v = memberCohesion([hourly], m15);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('candle duration');
});

test('candle: EXACT open timestamp required — same day, different hour → reject', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Bitcoin Up or Down - May 14, 3:00AM-3:15AM ET', event_kind: 'candle_direction', condition_date: '2026-05-14T07:00:00Z' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Bitcoin Up or Down - May 14, 4:00AM-4:15AM ET', event_kind: 'candle_direction', condition_date: '2026-05-14T08:00:00Z' });
  const v = memberCohesion([a], b);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain('candle open');
});

// ── fold semantics over a whole node (partitionCohesiveMembers) ────────────────

test('partition: anchor accepted, conflicting later members refused, singles untouched', () => {
  const rows = [
    // node A: PM 0.5 anchor, Kalshi 1.5 refused.
    { node_key: 'sem:1:total', ...mf({ market_id: 3705486, platform: 'polymarket', event_kind: 'match_total_metric', condition_direction: 'above', value_primary: '0.5', value_unit: 'goals', condition_date: '2026-05-17' }) },
    { node_key: 'sem:1:total', ...mf({ market_id: 4008038, platform: 'kalshi', event_kind: 'match_total_metric', condition_direction: 'above', value_primary: '1.5', value_unit: 'goals', condition_date: '2026-05-17' }) },
    // singleton node: never evaluated.
    { node_key: 'sem:2:x', ...mf({ market_id: 50, platform: 'kalshi', value_primary: '999' }) },
  ];
  const { refused } = partitionCohesiveMembers(rows);
  expect(refused.length).toBe(1);
  expect(refused[0].market_id).toBe(4008038);
  expect(refused[0].node_key).toBe('sem:1:total');
  expect(refused[0].reason).toContain('value_primary');
});

test('partition: NULL-field anchor cannot mask a later shaped-vs-shaped conflict', () => {
  // anchor unshaped (passes everything); members 2 and 3 are shaped and disagree —
  // member 3 must be checked against ALL accepted (incl. member 2) and refused.
  const rows = [
    { node_key: 'sem:9:o', ...mf({ market_id: 10, platform: 'predict' }) },
    { node_key: 'sem:9:o', ...mf({ market_id: 11, platform: 'kalshi', value_primary: '5', value_unit: 'rank', condition_direction: 'below' }) },
    { node_key: 'sem:9:o', ...mf({ market_id: 12, platform: 'polymarket', value_primary: '10', value_unit: 'rank', condition_direction: 'below' }) },
  ];
  const { refused } = partitionCohesiveMembers(rows);
  expect(refused.map((r) => r.market_id)).toEqual([12]);
});

test('partition: ladder collapse splits to anchor + (n-1) refusals (q10408 class)', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    node_key: 'sem:7:runs',
    ...mf({
      market_id: 1000 + i, platform: 'kalshi', title: `Will the total be over ${2.5 + i} runs?`,
      event_ticker: 'KXTOTAL-Y', yes_sub_title: `Over ${2.5 + i}`, platform_event_id: 'kalshi:event:KXTOTAL-Y',
      event_kind: 'match_total_metric', condition_direction: 'above', value_primary: String(2.5 + i), value_unit: 'runs',
    }),
  }));
  const { refused } = partitionCohesiveMembers(rows);
  expect(refused.length).toBe(10); // anchor 2.5 stays; 3.5..12.5 re-home as singletons
});

test('memberPairConflict is the symmetric core: a-vs-b matches b-vs-a verdict class', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', value_primary: '5' });
  const b = mf({ market_id: 2, platform: 'polymarket', value_primary: '10' });
  expect(memberPairConflict(a, b)).toContain('value_primary');
  expect(memberPairConflict(b, a)).toContain('value_primary');
});

// precision-aware condition_date compare. Same-market pairs commonly
// "disagree" on dates due to padded-precision artifacts. The compare runs at
// the coarser of the two stamped precisions.

test('S5: year-padded date (2026-01-01, precision year) coheres with a real June date (Fed-June class)', () => {
  const monthSide = mf({
    market_id: 1, platform: 'predict', value_primary: '25', value_unit: 'bps',
    condition_date: '2026-06-30', condition_date_precision: 'month',
  });
  const yearSide = mf({
    market_id: 2, platform: 'polymarket', value_primary: '25', value_unit: 'bps',
    condition_date: '2026-01-01', condition_date_precision: 'year',
  });
  expect(memberPairConflict(monthSide, yearSide)).toBeNull();
});

test('S5: year-grain compare still refuses DIFFERENT years (fdv 2026 vs 2028 stays split)', () => {
  const a = mf({
    market_id: 1, platform: 'predict', value_primary: '1000000000', value_unit: 'USD',
    condition_date: '2026-01-01', condition_date_precision: 'year',
  });
  const b = mf({
    market_id: 2, platform: 'polymarket', value_primary: '1000000000', value_unit: 'USD',
    condition_date: '2028-01-01', condition_date_precision: 'year',
  });
  expect(memberPairConflict(a, b)).toContain('condition_date');
});

test('S5: both day-precision (or unstamped) keeps the strict day-grain refusal', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', condition_date: '2026-05-13', condition_date_precision: 'day' });
  const b = mf({ market_id: 2, platform: 'polymarket', condition_date: '2026-05-14' });
  expect(memberPairConflict(a, b)).toContain('condition_date');
  const c = mf({ market_id: 3, platform: 'polymarket', condition_date: '2026-05-13T20:00:00Z' });
  expect(memberPairConflict(a, c)).toBeNull(); // same day, time-of-day ignored
});

// title-parsed rung line (unshaped members)

test('A3 mirror: two UNSHAPED members with differing title rung lines → refuse', () => {
  // both value_primary NULL (numericRegionConflict cannot fire); the line lives
  // only in the title.
  const a = mf({ market_id: 1, platform: 'kalshi', title: 'Will over 2.5 goals be scored?' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Over 3.5 goals?' });
  expect(memberPairConflict(a, b)).toContain('rung line');
});

test('A3 mirror: identical title rung lines cohere', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', title: 'Will over 2.5 goals be scored?' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Over 2.5 goals?' });
  expect(memberPairConflict(a, b)).toBeNull();
});

test('A3 mirror: no rung line in a title → NULL-tolerant (no refusal)', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', title: 'Will Arsenal win?' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Over 3.5 goals?' });
  expect(memberPairConflict(a, b)).toBeNull();
});

// predicate grain from titles (adopt≠use)

test('B1 mirror: use≠adopt (redistrict) titles refuse the fusion', () => {
  const pm = mf({ market_id: 1, platform: 'polymarket', title: 'Will Utah use a new congressional map for the 2026 elections?' });
  const kalshi = mf({ market_id: 2, platform: 'kalshi', title: 'What states will redistrict before 2027?' });
  expect(memberPairConflict(pm, kalshi)).toContain('predicate grain');
});

test('B1 mirror: both-adopt titles cohere (recall pin)', () => {
  // Same grain (enactment:adopt on both) → cohere.
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Will Alabama adopt a new congressional map?' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'Will Alabama adopt a new district map before 2027?' });
  expect(memberPairConflict(a, b)).toBeNull();
});

test('F13 mirror: adopt-new-map ≠ redistrict titles refuse the fusion (settlement-non-identical)', () => {
  // "adopt a new map" (enactment:adopt) vs "redistrict" (enactment:redistrict)
  // settle differently — a court can redistrict a state that never adopted a
  // map. The grains are split so the member-fold refuses.
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Will Utah adopt a new congressional map?' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'Will Utah redistrict before 2027?' });
  expect(memberPairConflict(a, b)).toContain('predicate grain');
});

// HT≢FT half-scope mismatch. A half-time market and a full-time market of
// the same fixture must never fuse. Reuses the isHalfScope helper so
// member-fold and the equivalence edge-fold share one half-scope rule.

test('HT≢FT: FT×FT (both non-half titles, NULL scope) → cohere', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Borac Banja Luka vs Lugano: Will the match end in a draw?' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'Borac vs Lugano Winner?: Draw' });
  expect(memberPairConflict(a, b)).toBeNull();
});

test('HT≢FT: HT×HT (both half_1) → cohere (critical legit case, no over-split)', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', title: '1st Half winner', metric_scope: 'half_1' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Who is leading at halftime?', metric_scope: 'half_1' });
  expect(memberPairConflict(a, b)).toBeNull();
});

test('HT≢FT: HT×HT (both via half/period TITLE, NULL scope) → cohere', () => {
  const a = mf({ market_id: 1, platform: 'kalshi', title: '1st Half winner' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Team leading at the half?' });
  expect(memberPairConflict(a, b)).toBeNull();
});

test('HT≢FT: FT "end in a draw" × HT "Second half draw?" → refuse (structured half scope)', () => {
  const ft = mf({ market_id: 1, platform: 'polymarket', title: 'Borac vs Lugano: Will the match end in a draw?' });
  const ht = mf({ market_id: 2, platform: 'polymarket', title: 'Borac vs Lugano: Second half draw?', metric_scope: 'half_2' });
  const v = memberPairConflict(ft, ht);
  expect(v).toContain('half/full-time scope mismatch');
  expect(memberPairConflict(ht, ft)).toContain('half/full-time scope mismatch'); // symmetric
});

test('HT≢FT: title-only HT (metric_scope NULL, "Second half draw?") × FT → refuse', () => {
  // The HT side is unshaped (metric_scope NULL), scope lives only in the
  // title — the field gates all pass NULL-tolerant, so the title regex in
  // isHalfScope is the sole discriminator.
  const ht = mf({ market_id: 1, platform: 'polymarket', title: 'Borac vs Lugano: Second half draw?' });
  const ft = mf({ market_id: 2, platform: 'kalshi', title: 'Borac vs Lugano Winner?: Draw' });
  expect(memberPairConflict(ht, ft)).toContain('half/full-time scope mismatch');
});

// game_ordinal grain gate (both-known-and-differ)
test('F8: two members with DIFFERENT known game ordinals ("Map 1" vs "Map 2") → refuse', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'T1 vs GEN: Map 1 winner' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'T1 vs GEN: Map 2 winner' });
  expect(memberPairConflict(a, b)).toContain('game_ordinal 1 vs 2');
  expect(memberPairConflict(b, a)).toContain('game_ordinal 2 vs 1'); // symmetric refusal
});

test('F8: distinct period ordinals ("1st period" vs "2nd period") → refuse', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'Leafs vs Bruins: 1st period leader' });
  const b = mf({ market_id: 2, platform: 'polymarket', title: 'Leafs vs Bruins: 2nd period leader' });
  expect(memberPairConflict(a, b)).toContain('game_ordinal 1 vs 2');
});

test('F8: NULL-tolerant — a whole-match (no ordinal) leg + an ordinal leg cohere (NOT XOR)', () => {
  // Preserves NULL(whole-match)+period sound duplicates: both-known-differ,
  // never XOR. Titles chosen non-half so the isHalfScope XOR above does not fire first.
  const wholeMatch = mf({ market_id: 1, platform: 'kalshi', title: 'T1 vs GEN: series winner' });
  const map1 = mf({ market_id: 2, platform: 'polymarket', title: 'T1 vs GEN: Map 1 winner' });
  expect(memberPairConflict(wholeMatch, map1)).toBeNull();
  expect(memberPairConflict(map1, wholeMatch)).toBeNull();
});

test('F8: identical known game ordinals cohere (no false refusal)', () => {
  const a = mf({ market_id: 1, platform: 'polymarket', title: 'T1 vs GEN: Map 3 winner' });
  const b = mf({ market_id: 2, platform: 'kalshi', title: 'T1 vs GEN: Map 3 winner' });
  expect(memberPairConflict(a, b)).toBeNull();
});

// outcome grain tier. First-scorer legs are typically unshaped (NULL
// condition_shape and NULL event_kind), so the field gates alone are inert;
// a match-winner leg of the same fixture and same team must still be
// refused rather than fused into the first-scorer outcome.

test('q13109 sem:2548:fc_sion_first — the match-winner leg is refused, both first-scorer legs stay', () => {
  const pmFirst = mf({ market_id: 15378192, platform: 'polymarket', title: 'FC Sion to score first vs. FK BATE Barysaŭ?' });
  const kalshiFirst = mf({ market_id: 22569944, platform: 'kalshi', title: 'Will FC Sion record the first goal of the game?' });
  const limitlessWinner = mf({
    market_id: 26037677, platform: 'limitless', title: 'UECL, FC Sion vs Bate Borisov: FC Sion',
    event_kind: 'match_winner', condition_shape: 'binary_event',
  });
  expect(memberPairConflict(pmFirst, kalshiFirst)).toBeNull(); // genuinely the same question
  const v = memberCohesion([pmFirst, kalshiFirst], limitlessWinner);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toContain("outcome grain 'first_scorer' vs 'winner'");
});

test('q39762 sem:4853:fc_drita — an UNSHAPED winner leg still declares its grain in the title', () => {
  const pmFirst = mf({ market_id: 6433453, platform: 'polymarket', title: 'FC Drita to score first vs. FK Kauno Žalgiris?' });
  const kalshiWinner = mf({ market_id: 7262150, platform: 'kalshi', title: 'KF Drita vs Kauno Winner?' });
  expect(memberPairConflict(pmFirst, kalshiWinner)).toContain('outcome grain');
});

test('the CORRECTLY modelled first-scorer set is untouched (complement + same-grain legs)', () => {
  // A 3-slot non-exhaustive partition: team A first / team B first / neither.
  const kalshiNoGoal = mf({ market_id: 11412907, platform: 'kalshi', title: 'Will no goal be scored?' });
  const pmNeither = mf({ market_id: 26660088, platform: 'polymarket', title: 'Tigres FC vs. Itagui Leones FC: Neither team to score first?' });
  expect(memberPairConflict(kalshiNoGoal, pmNeither)).toBeNull();
  const kalshiTeamFirst = mf({ market_id: 11412908, platform: 'kalshi', title: 'Will Tigres UANL record the first goal of the game?' });
  const pmTeamFirst = mf({ market_id: 26660087, platform: 'polymarket', title: 'Tigres FC to score first vs. Itagui Leones FC?' });
  expect(memberPairConflict(kalshiTeamFirst, pmTeamFirst)).toBeNull();
});

test('grain tier is NULL-TOLERANT: an abstaining member conflicts with nothing', () => {
  const abstain = mf({ market_id: 1, platform: 'limitless', title: 'UECL, Ballkani vs Bohemians: Ballkani' });
  const first = mf({ market_id: 2, platform: 'polymarket', title: 'FC Ballkani to score first vs. Bohemian FC?' });
  expect(memberPairConflict(abstain, first)).toBeNull(); // no event_kind → no grain → no verdict
  // …but once Stage 1 shapes it as a match-winner, the same pair refuses.
  const shaped = { ...abstain, event_kind: 'match_winner' };
  expect(memberPairConflict(shaped, first)).toContain('outcome grain');
});

test('grain tier does not split the cross-platform spellings of ONE market', () => {
  // The MLB run line (Kalshi prose vs Polymarket slug) and the UFC
  // method-of-victory pair must both cohere.
  const kalshiRunLine = mf({ market_id: 1, platform: 'kalshi', title: 'Tampa Bay wins first 5 innings by over 1.5 runs?' });
  const pmRunLine = mf({ market_id: 2, platform: 'polymarket', title: '1st 5 Innings Spread: Tampa Bay Rays (-1.5)' });
  expect(memberPairConflict(kalshiRunLine, pmRunLine)).toBeNull();
  const kalshiKo = mf({ market_id: 3, platform: 'kalshi', title: 'Will Valter Walker win the Valter Walker vs. Thomas Petersen UFC Fight Night fight by KO/TKO/DQ?' });
  const pmKo = mf({ market_id: 4, platform: 'polymarket', title: 'Will Valter Walker win by KO or TKO?' });
  expect(memberPairConflict(kalshiKo, pmKo)).toBeNull();
});

// fixture start-instant divergence. A late-evening ET game can carry a
// UTC-instant stamp that rolls into the next UTC day, making its UTC day key
// equal a different game's day key (the next game of a back-to-back
// series). Day-key equality alone is not enough: the instant tier must
// still refuse when the instants are far enough apart.

test('kalshi US-evening minute stamp vs PM NEXT-day fixture: day keys collide, instants refuse', () => {
  const kalshi = mf({
    market_id: 17340692, platform: 'kalshi', title: 'New York M vs Milwaukee Total Runs?',
    event_kind: 'match_total_metric', condition_direction: 'above',
    value_primary: '8.5', value_unit: 'runs',
    condition_date: '2026-07-21T02:40:00Z', condition_date_precision: 'minute',
    end_date: '2026-07-23 23:40:00+00',   // kalshi pad — must NOT be read as an instant
  });
  const pmNextGame = mf({
    market_id: 19700431, platform: 'polymarket', title: 'New York Mets vs. Milwaukee Brewers: O/U 8.5',
    event_kind: 'match_total_metric', condition_direction: 'above',
    value_primary: '8.5', value_unit: 'runs',
    condition_date: '2026-07-21', condition_date_precision: 'day',
    end_date: '2026-07-21 23:40:00+00',   // PM kickoff instant (self-consistent with the day)
  });
  const v = memberPairConflict(kalshi, pmNextGame);
  expect(v).not.toBeNull();
  expect(v).toContain('fixture start instants diverge');
  // the correct partner (kickoff hours before the kalshi stamp) never reaches
  // the instant tier — its day key already differs (conservative: the
  // calendar refusal stands; instants never force a merge)
  const pmSameGame = mf({
    ...pmNextGame, market_id: 20169979,
    condition_date: '2026-07-20', end_date: '2026-07-20 23:40:00+00',
  });
  expect(memberPairConflict(kalshi, pmSameGame)).toContain('condition_date day');
});

test('no-instant sides abstain: a predict local-day member never trips the instant tier', () => {
  const kalshi = mf({
    market_id: 5, platform: 'kalshi', title: 'Total runs?',
    event_kind: 'match_total_metric',
    condition_date: '2026-07-21T02:40:00Z', condition_date_precision: 'minute',
  });
  const predict = mf({
    market_id: 6, platform: 'predict', title: 'New York Mets vs. Milwaukee Brewers',
    event_kind: 'match_total_metric',
    condition_date: '2026-07-21', condition_date_precision: 'day',
    end_date: '2026-07-21 00:00:00+00',   // midnight artifact, not a kickoff
  });
  // day keys agree and predict exposes NO trusted instant → no refusal here
  // (the sport-gated ambiguous-evening arm lives in the stage-3 leg guard)
  expect(memberPairConflict(kalshi, predict)).toBeNull();
});
