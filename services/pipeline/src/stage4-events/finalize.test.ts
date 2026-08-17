import { test, expect } from 'bun:test';
import {
  isFixturePlaceholderSubjectSql,
  isOmegaPlaceholderSlotSql,
} from '../util/placeholder-outcomes.js';
import {
  looksMultiYesPredicate,
  looksMultiWinnerSelection,
  looksOpenRace,
  OPEN_RACE_TITLE_PATTERN,
  hasNumericPartition,
  isSoundNumericTiling,
  isExhaustiveSet,
  isUnionDoubleMapped,
  projectNodesFromLegsSql,
  semanticOutcomeLegFactsSql,
  semanticSetOrphanProbeSql,
  foldSubjectKey,
  resolveDualMappedLegs,
  reconcileOutcomeSetExhaustivitySql,
  buildThresholdLadderEdgesSql,
  buildThresholdLadderRungsSql,
  thresholdLadderEdgesRef,
  partitionThresholdGroups,
  partitionByConditionDateGrain,
  partitionByGameOrdinalGrain,
  dropCollidedLadderRungs,
  type DualMapLegRow,
  type ThresholdLadderSlot,
  type MetricKeyed,
} from './finalize.js';
import { partitionCohesiveMembers, type MemberFacts } from './member-cohesion.js';


test('stage_advance event_kind is multi-YES regardless of title', () => {
  expect(looksMultiYesPredicate('Will Brazil qualify from World Cup Group C?', 'stage_advance')).toBe(true);
  expect(looksMultiYesPredicate('Brazil', 'stage_advance')).toBe(true);
});

test('flags "finish in the top 4" as multi-YES (title clause)', () => {
  expect(looksMultiYesPredicate('Will AC Milan finish in the top 4 in the 2025-26 Serie A season?', null)).toBe(true);
});

test('flags "Top 10" / "top-N" phrasing as multi-YES', () => {
  expect(looksMultiYesPredicate('Eurovision 2026: Top 10', null)).toBe(true);
  expect(looksMultiYesPredicate('finish top-3', null)).toBe(true);
});

test('flags "relegated" as multi-YES', () => {
  expect(looksMultiYesPredicate('Will Cagliari be Relegated from Serie A in 2025-26 Season?', null)).toBe(true);
});

test('multi-winner: destination-qualified advance/qualify fires', () => {
  expect(looksMultiWinnerSelection('Will Ben Rice advance to the finals of the 2026 MLB Home Run Derby?')).toBe(true);
  expect(looksMultiWinnerSelection('Will Sweden qualify for the Grand Final of Eurovision 2026?')).toBe(true);
  expect(looksMultiWinnerSelection('Will the Jets make the playoffs?')).toBe(true);
  expect(looksMultiWinnerSelection('Will Cagliari be relegated from Serie A?')).toBe(true);
  expect(looksMultiWinnerSelection('Will AC Milan finish in the top 4?')).toBe(true);
});

test('multi-winner: SINGLE-winner fields do NOT fire (no false positives)', () => {
  expect(looksMultiWinnerSelection('F1 Sprint Qualifying Pole Winner')).toBe(false);
  expect(looksMultiWinnerSelection('T20 EAP Qualifier Regional Final: A vs B')).toBe(false);
  expect(looksMultiWinnerSelection('Will Argentina be eliminated in the Final of the World Cup?')).toBe(false);
  expect(looksMultiWinnerSelection('Will Brazil win the World Cup?')).toBe(false);
  expect(looksMultiWinnerSelection('Will Taylor Swift be the #2 artist on Spotify?')).toBe(false);
  expect(looksMultiWinnerSelection('advance to the final', 'match_winner')).toBe(false);
});

test('flags "make the playoffs/postseason" as multi-YES', () => {
  expect(looksMultiYesPredicate('WNBA: Team To Make Postseason', null)).toBe(true);
  expect(looksMultiYesPredicate('Will the Jets make the playoffs?', null)).toBe(true);
});

test('does NOT flag a genuine one-hot winner title (no false demote)', () => {
  expect(looksMultiYesPredicate('Ajax vs Utrecht', 'match_winner')).toBe(false);
  expect(looksMultiYesPredicate('Will Brazil win Group C in the 2026 FIFA World Cup?', 'championship_winner')).toBe(false);
  expect(looksMultiYesPredicate('Will Bill Cassidy be the Republican nominee for Senate?', 'election_outcome_winner')).toBe(false);
  expect(looksMultiYesPredicate('Who will win the 2026 Fields Medal?', 'championship_winner')).toBe(false);
});

test('does NOT flag a one-hot fixture even when the title carries an incidental multi-YES word', () => {
  expect(looksMultiYesPredicate('LoL: G2 Esports vs Natus Vincere (BO3) - Esports World Cup EMEA Qualifier', 'match_winner')).toBe(false);
  expect(looksMultiYesPredicate('Canadian Grand Prix: Sprint Qualifying Pole Winner', 'candle_direction')).toBe(false);
  expect(looksMultiYesPredicate('Will Brazil qualify from World Cup Group C?', null)).toBe(false);
});

test('one-hot fixture kind blocks a multi-YES title clause too', () => {
  expect(looksMultiYesPredicate('Team to make the playoffs', 'match_winner')).toBe(false);
});

test('null/empty title is not multi-YES (when kind is not stage_advance)', () => {
  expect(looksMultiYesPredicate(null, null)).toBe(false);
  expect(looksMultiYesPredicate(undefined, undefined)).toBe(false);
  expect(looksMultiYesPredicate('', null)).toBe(false);
});


test('constant value (all = 1) is NOT a numeric partition', () => {
  expect(hasNumericPartition([1, 1, 1, 1, 1])).toBe(false);
  expect(hasNumericPartition(['1', '1', '1'])).toBe(false);
});

test('distinct value buckets ARE a numeric partition', () => {
  expect(hasNumericPartition([60, 65, 70, 75])).toBe(true);
  expect(hasNumericPartition([1, 2])).toBe(true);
});

test('value present on <60% of slots is not a tiling (coverage gate kept)', () => {
  expect(hasNumericPartition([1, 2, null, null, null])).toBe(false);
});

test('all-null (no values) is not a tiling', () => {
  expect(hasNumericPartition([null, null, null])).toBe(false);
  expect(hasNumericPartition([])).toBe(false);
});

test('≥60% coverage with ≥2 distinct values is a tiling', () => {
  expect(hasNumericPartition([10, 20, 30, 40, null])).toBe(true);
});

test('≥60% coverage but constant value is NOT a tiling', () => {
  expect(hasNumericPartition([1, 1, 1, 1, null])).toBe(false);
});


test('between-dominated contiguous w/ multiple closers (weather set 877) → TRUE (KEEP)', () => {
  const slots = [
    { direction: 'below', value_primary: 43, value_secondary: null },
    { direction: 'below', value_primary: 47, value_secondary: null },
    { direction: 'between', value_primary: 43, value_secondary: 45 },
    { direction: 'between', value_primary: 44, value_secondary: 46 }, // overlaps prev (benign)
    { direction: 'between', value_primary: 45, value_secondary: 47 },
    { direction: 'between', value_primary: 46, value_secondary: 48 },
    { direction: 'between', value_primary: 47, value_secondary: 49 },
    { direction: 'between', value_primary: 48, value_secondary: 50 },
    { direction: 'between', value_primary: 49, value_secondary: 51 },
    { direction: 'between', value_primary: 50, value_secondary: 52 },
    { direction: 'between', value_primary: 51, value_secondary: 53 },
    { direction: 'between', value_primary: 52, value_secondary: 54 },
    { direction: 'between', value_primary: 53, value_secondary: 55 },
    { direction: 'between', value_primary: 54, value_secondary: 56 },
    { direction: 'between', value_primary: 55, value_secondary: 57 },
    { direction: 'above', value_primary: 54, value_secondary: null },
    { direction: 'above', value_primary: 62, value_secondary: null },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('pure "at" point race (Billboard ranks 1..10) → FALSE (REFUSE)', () => {
  const slots = Array.from({ length: 10 }, (_, i) => ({
    direction: 'at', value_primary: i + 1, value_secondary: null,
  }));
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('pure-monotone "above" ladder (set 1940, 21 rungs all above) → FALSE (REFUSE)', () => {
  const slots = Array.from({ length: 21 }, (_, i) => ({
    direction: 'above', value_primary: 100 + i * 5, value_secondary: null,
  }));
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('same-direction overlapping "above" thresholds (candle set 6) → FALSE (REFUSE)', () => {
  const slots = [
    { direction: 'above', value_primary: 745, value_secondary: null },
    { direction: 'above', value_primary: 740, value_secondary: null },
    { direction: 'above', value_primary: 745, value_secondary: null }, // dup
    { direction: 'above', value_primary: 750, value_secondary: null },
    { direction: 'above', value_primary: 745, value_secondary: null },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('constant value (all = 1, legacy "qualify" flag) → FALSE (REFUSE)', () => {
  const slots = [
    { direction: 'between', value_primary: 1, value_secondary: 1 },
    { direction: 'between', value_primary: 1, value_secondary: 1 },
    { direction: 'between', value_primary: 1, value_secondary: 1 },
    { direction: 'between', value_primary: 1, value_secondary: 1 },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('clean contiguous "between" tiling → TRUE (KEEP)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10 },
    { direction: 'between', value_primary: 10, value_secondary: 20 },
    { direction: 'between', value_primary: 20, value_secondary: 30 },
    { direction: 'between', value_primary: 30, value_secondary: 40 },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('between tiling with a GAP on the line → FALSE (not a partition)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10 },
    { direction: 'between', value_primary: 10, value_secondary: 20 },
    { direction: 'between', value_primary: 50, value_secondary: 60 }, // gap 20..50
    { direction: 'between', value_primary: 60, value_secondary: 70 },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('all-direction-NULL + value_secondary present ≥60% (exact-score-like) → between fallback', () => {
  const slots = [
    { direction: null, value_primary: 0, value_secondary: 10 },
    { direction: null, value_primary: 10, value_secondary: 20 },
    { direction: null, value_primary: 20, value_secondary: 30 },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('all-direction-NULL with NO value_secondary → FALSE (not between-eligible)', () => {
  const slots = [
    { direction: null, value_primary: 1, value_secondary: null },
    { direction: null, value_primary: 2, value_secondary: null },
    { direction: null, value_primary: 3, value_secondary: null },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('value present on <60% of slots → FALSE (coverage gate kept)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10 },
    { direction: 'between', value_primary: 10, value_secondary: 20 },
    { direction: null, value_primary: null, value_secondary: null },
    { direction: null, value_primary: null, value_secondary: null },
    { direction: null, value_primary: null, value_secondary: null },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('empty slot list → FALSE', () => {
  expect(isSoundNumericTiling([])).toBe(false);
});

test('Kalshi gated strike_type aliases (greater/less) treated as above/below', () => {
  const slots = [
    { direction: 'greater', value_primary: 2.5, value_secondary: null },
    { direction: 'greater', value_primary: 2.6, value_secondary: null },
    { direction: 'greater', value_primary: 2.7, value_secondary: null },
    { direction: 'greater', value_primary: 2.8, value_secondary: null },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});


const tweetFamily = (over: Partial<{ topArm: boolean; bottomLo: number }> = {}) => {
  const { topArm = true, bottomLo = 0 } = over;
  const buckets = Array.from({ length: 5 }, (_, i) => ({
    direction: null,
    value_primary: bottomLo + i * 20,
    value_secondary: bottomLo + i * 20 + 19,
    value_unit: 'tweet',
    condition_shape: 'range_snapshot',
  }));
  return topArm
    ? [...buckets, {
        direction: 'above', value_primary: bottomLo + 100, value_secondary: null,
        value_unit: 'tweet', condition_shape: 'monotonic_threshold',
      }]
    : buckets;
};

test('integer-grain count tiling (tweet buckets step 1 + "N+" top arm, lo=0) → TRUE (A2 fix)', () => {
  expect(isSoundNumericTiling(tweetFamily())).toBe(true);
});

test('integer count tiling WITHOUT a top arm → FALSE (counts are unbounded above)', () => {
  expect(isSoundNumericTiling(tweetFamily({ topArm: false }))).toBe(false);
});

test('integer count tiling whose lowest bucket starts at 20 (no below arm) → FALSE (bottom open)', () => {
  expect(isSoundNumericTiling(tweetFamily({ bottomLo: 20 }))).toBe(false);
});

test('the monotonic "N+" top arm is tolerated ONLY in the integer count domain (touch ≡ terminal)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10, value_unit: 'usd', condition_shape: 'range_snapshot' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd', condition_shape: 'range_snapshot' },
    { direction: 'above', value_primary: 20, value_secondary: null, value_unit: 'usd', condition_shape: 'monotonic_threshold' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('integer temperature buckets (step 1) with BOTH arms → TRUE; missing below-arm → FALSE', () => {
  const buckets = [
    { direction: 'between', value_primary: 59, value_secondary: 60, value_unit: 'fahrenheit' },
    { direction: 'between', value_primary: 61, value_secondary: 62, value_unit: 'fahrenheit' },
    { direction: 'between', value_primary: 63, value_secondary: 64, value_unit: 'fahrenheit' },
  ];
  const above = { direction: 'above', value_primary: 64, value_secondary: null, value_unit: 'fahrenheit' };
  const below = { direction: 'below', value_primary: 59, value_secondary: null, value_unit: 'fahrenheit' };
  expect(isSoundNumericTiling([...buckets, above, below])).toBe(true);
  expect(isSoundNumericTiling([...buckets, above])).toBe(false);
});

test('continuous (usd) buckets with an integer-style gap STILL refuse — no lattice tolerance', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 19, value_unit: 'usd' },
    { direction: 'between', value_primary: 20, value_secondary: 39, value_unit: 'usd' }, // (19,20) is a real gap in usd
    { direction: 'above', value_primary: 39, value_secondary: null, value_unit: 'usd' },
    { direction: 'below', value_primary: 0, value_secondary: null, value_unit: 'usd' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('integer tiling with a REAL missing bucket (step 2) → FALSE', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 19, value_unit: 'tweet' },
    { direction: 'between', value_primary: 21, value_secondary: 39, value_unit: 'tweet' }, // count 20 uncovered
    { direction: 'above', value_primary: 39, value_secondary: null, value_unit: 'tweet' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});


// ── the open-extreme requirement is unit-domain-wide, not integer-grain-only ──
// Defect shape A: the guard used to sit inside `if (intGrain)`, so a CONTINUOUS
// unit was never asked for its extremes. Live set 11746 (Kalshi BNB) is the proof.

const bnbLadder = (over: Partial<{ belowLeg: boolean }> = {}) => {
  const { belowLeg = false } = over;
  const buckets = [
    { direction: 'between', value_primary: 760, value_secondary: 765, value_unit: 'USD', condition_shape: 'range_snapshot' },
    { direction: 'between', value_primary: 765, value_secondary: 770, value_unit: 'USD', condition_shape: 'range_snapshot' },
    { direction: 'between', value_primary: 770, value_secondary: 775, value_unit: 'USD', condition_shape: 'range_snapshot' },
    { direction: 'above', value_primary: 775, value_secondary: null, value_unit: 'USD', condition_shape: 'point_in_time' },
  ];
  return belowLeg
    ? [...buckets, { direction: 'below', value_primary: 760, value_secondary: null, value_unit: 'USD', condition_shape: 'point_in_time' }]
    : buckets;
};

test('continuous (usd) tiling with an ABOVE arm but NO below leg → FALSE (live set 11746, the buy-all-YES fake)', () => {
  // "BNB 760-765 / 765-770 / 770-775 / above 775" says nothing about BNB < $760,
  // so Σ=1 here deletes that world from Ω.
  expect(isSoundNumericTiling(bnbLadder())).toBe(false);
});

test('the SAME continuous tiling WITH a below leg → TRUE (the arm is the discriminator, not the unit)', () => {
  expect(isSoundNumericTiling(bnbLadder({ belowLeg: true }))).toBe(true);
});

test('continuous (usd) tiling with a BELOW arm but no above leg → FALSE (top tail open)', () => {
  const slots = [
    { direction: 'below', value_primary: 760, value_secondary: null, value_unit: 'usd' },
    { direction: 'between', value_primary: 760, value_secondary: 765, value_unit: 'usd' },
    { direction: 'between', value_primary: 765, value_secondary: 770, value_unit: 'usd' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

// The floor allowance is now explicit + unit-aware, and covers the non-negative
// CONTINUOUS magnitudes too (live: 16 margin-of-victory + 5 vote-share sets).
test('percentage-point margin tiling from 0 with an above arm and no below leg → TRUE (0 is the floor)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 5, value_unit: 'percentage points' },
    { direction: 'between', value_primary: 5, value_secondary: 15, value_unit: 'percentage points' },
    { direction: 'above', value_primary: 15, value_secondary: null, value_unit: 'percentage points' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('the SAME percent tiling starting ABOVE the floor → FALSE (0..5 is uncovered)', () => {
  const slots = [
    { direction: 'between', value_primary: 5, value_secondary: 10, value_unit: 'percent' },
    { direction: 'between', value_primary: 10, value_secondary: 15, value_unit: 'percent' },
    { direction: 'above', value_primary: 15, value_secondary: null, value_unit: 'percent' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('a NULL/unknown unit stays exempt from the extremes check (a closed domain cannot be told apart)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10 },
    { direction: 'between', value_primary: 10, value_secondary: 20 },
    { direction: 'between', value_primary: 20, value_secondary: 30 },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});


// ── defect shape B: the bare `buckets.length < 2 → true` grant ────────────────

test('ONE bucket + an above leg, lowest bucket off the floor → FALSE (live set 12789, Musk tweets 400-499 / 500+)', () => {
  // The old `if (buckets.length < 2) return true` short-circuited before any
  // coverage or extreme test: "<400 tweets" was silently deleted from Ω.
  const slots = [
    { direction: 'between', value_primary: 400, value_secondary: 499, value_unit: 'tweets', condition_shape: 'range_snapshot' },
    { direction: 'above', value_primary: 500, value_secondary: null, value_unit: 'tweets', condition_shape: 'range_snapshot' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('ONE bucket that the two half-lines CLOSE still certifies (below-10 / [10,20] / above-20)', () => {
  // The legitimate shape the bare grant used to serve — it must survive the fix.
  const slots = [
    { direction: 'below', value_primary: 10, value_secondary: null, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
    { direction: 'above', value_primary: 20, value_secondary: null, value_unit: 'usd' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('ONE bucket from the floor + an above leg on a count axis still certifies (0-99 / 100+)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 99, value_unit: 'tweets' },
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'tweets' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('a below leg that does NOT reach the lowest bucket → FALSE (live set 1092: 16-or-below under an 18..26 grid leaves 17 uncovered)', () => {
  const grid = [
    { direction: 'between', value_primary: 18, value_secondary: 19, value_unit: 'celsius' },
    { direction: 'between', value_primary: 19, value_secondary: 20, value_unit: 'celsius' },
    { direction: 'between', value_primary: 20, value_secondary: 21, value_unit: 'celsius' },
    { direction: 'above', value_primary: 20.5, value_secondary: null, value_unit: 'celsius' },
  ];
  expect(isSoundNumericTiling([...grid, { direction: 'below', value_primary: 16.5, value_secondary: null, value_unit: 'celsius' }])).toBe(false);
  // the same grid whose below leg meets the bottom bucket is a real partition
  expect(isSoundNumericTiling([...grid, { direction: 'below', value_primary: 17.5, value_secondary: null, value_unit: 'celsius' }])).toBe(true);
});

test('an above leg that does NOT reach the top of the covered span → FALSE (the band above coverHi is uncovered)', () => {
  const slots = [
    { direction: 'below', value_primary: 10, value_secondary: null, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
    { direction: 'between', value_primary: 20, value_secondary: 30, value_unit: 'usd' },
    { direction: 'above', value_primary: 45, value_secondary: null, value_unit: 'usd' }, // (30,45] uncovered
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});

test('`between` slots with NO parsable interval → FALSE (zero buckets is no partition)', () => {
  const slots = [
    { direction: 'between', value_primary: 10, value_secondary: null, value_unit: 'usd' },
    { direction: 'between', value_primary: 20, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 30, value_secondary: null, value_unit: 'usd' },
    { direction: 'below', value_primary: 10, value_secondary: null, value_unit: 'usd' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(false);
});


const liveExactGrid = (kind: string | null) => {
  const out: { direction: null; value_primary: number; value_secondary: number; event_kind: string | null }[] = [];
  for (let h = 0; h <= 3; h++) for (let a = 0; a <= 3; a++) {
    out.push({ direction: null, value_primary: h, value_secondary: a, event_kind: kind });
  }
  return out;
};

test('exact_score grid (live set 869/924 shape) → FALSE (fixture slots excluded from the NULL→between fallback)', () => {
  expect(isSoundNumericTiling(liveExactGrid('exact_score'))).toBe(false);
});

test('the SAME value shape WITHOUT event_kind still promotes (the discriminator is the kind, not the values)', () => {
  expect(isSoundNumericTiling(liveExactGrid(null))).toBe(true);
});

test('a non-fixture event_kind on a genuine between tiling is untouched (no collateral)', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10, event_kind: 'weather_threshold' },
    { direction: 'between', value_primary: 10, value_secondary: 20, event_kind: 'weather_threshold' },
    { direction: 'between', value_primary: 20, value_secondary: 30, event_kind: 'weather_threshold' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
});

test('a minority of fixture slots cannot ride a real tiling into covering them (excluded from buckets), majority tiling still stands', () => {
  const slots = [
    { direction: 'between', value_primary: 0, value_secondary: 10, event_kind: null },
    { direction: 'between', value_primary: 10, value_secondary: 20, event_kind: null },
    { direction: 'between', value_primary: 20, value_secondary: 30, event_kind: null },
    { direction: null, value_primary: 1, value_secondary: 1, event_kind: 'exact_score' },
  ];
  expect(isSoundNumericTiling(slots)).toBe(true);
  const dominated = [
    { direction: 'between', value_primary: 0, value_secondary: 10, event_kind: null },
    ...liveExactGrid('exact_score'),
  ];
  expect(isSoundNumericTiling(dominated)).toBe(false);
});


test('isExhaustiveSet: negRisk FIXTURE 3-way (1X2), no residual → EXHAUSTIVE (1X2/halftime recall)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: true, hasResidual: false, numericTiling: false, realSlotCount: 3 })).toBe(true);
});

test('isExhaustiveSet ⑤: negRisk FIXTURE 2-way drawless, no residual → NOT exhaustive (void → Σ≤1)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: true, hasResidual: false, numericTiling: false, realSlotCount: 2 })).toBe(false);
});
test('isExhaustiveSet ⑤: negRisk FIXTURE 3-way → EXHAUSTIVE (real 1X2 partition)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: true, hasResidual: false, numericTiling: false, realSlotCount: 3 })).toBe(true);
});
test('isExhaustiveSet ⑤: negRisk FIXTURE 2-way WITH residual → EXHAUSTIVE (explicit residual completes it)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: true, hasResidual: true, numericTiling: false, realSlotCount: 2 })).toBe(true);
});

test('isExhaustiveSet: negRisk OPEN field, no residual → NOT exhaustive (the M-SOUND-1 fix)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: false, hasResidual: false, numericTiling: false, realSlotCount: 5 })).toBe(false);
});

test('isExhaustiveSet: negRisk OPEN field WITH residual → EXHAUSTIVE (complete open negRisk)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: true, isFixtureKind: false, hasResidual: true, numericTiling: false, realSlotCount: 5 })).toBe(true);
});

test('isExhaustiveSet: numericTiling → EXHAUSTIVE regardless of fixture kind', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: false, isFixtureKind: false, hasResidual: false, numericTiling: true, realSlotCount: 4 })).toBe(true);
});

test('isExhaustiveSet: multiYesFold overrides everything → NOT exhaustive', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: true, isNeg: true, isFixtureKind: true, hasResidual: true, numericTiling: true, realSlotCount: 5 })).toBe(false);
});

test('isExhaustiveSet: threshold_series (non-categorical) → always EXHAUSTIVE', () => {
  expect(isExhaustiveSet({ isCategorical: false, isMultiYesFold: false, isNeg: false, isFixtureKind: false, hasResidual: false, numericTiling: false, realSlotCount: 0 })).toBe(true);
  expect(isExhaustiveSet({ isCategorical: false, isMultiYesFold: true, isNeg: false, isFixtureKind: false, hasResidual: false, numericTiling: false, realSlotCount: 0 })).toBe(true);
});

test('isExhaustiveSet: categorical with NO exhaustivity signal → NOT exhaustive (Σ≤1)', () => {
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: false, isFixtureKind: false, hasResidual: false, numericTiling: false, realSlotCount: 4 })).toBe(false);
  expect(isExhaustiveSet({ isCategorical: true, isMultiYesFold: false, isNeg: false, isFixtureKind: true, hasResidual: false, numericTiling: false, realSlotCount: 4 })).toBe(false);
});

test('isUnionDoubleMapped: two non-residual slots share a folded subject -> true', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'teplice_win', subject: 'FK Teplice', is_residual: false, market_ids: [1] },
    { outcome_id: 'fk_teplice', subject: 'fk teplice', is_residual: false, market_ids: [2] },
    { outcome_id: 'dukla_win', subject: 'FK Dukla Praha', is_residual: false, market_ids: [3] },
  ])).toBe(true);
});

test('isUnionDoubleMapped: one market bound under >=2 outcome_ids -> true (subjects distinct)', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'bnb_up', subject: null, is_residual: false, market_ids: [50] },
    { outcome_id: 'bnb_ge_100', subject: null, is_residual: false, market_ids: [50, 51] },
  ])).toBe(true);
});

test('isUnionDoubleMapped: clean negRisk 3-way (distinct subjects, distinct markets) -> false', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'home', subject: 'Team Home', is_residual: false, market_ids: [1] },
    { outcome_id: 'away', subject: 'Team Away', is_residual: false, market_ids: [2] },
    { outcome_id: 'draw', subject: null, is_residual: false, market_ids: [3] },
  ])).toBe(false);
});

test('isUnionDoubleMapped: residual slots are subject-less by contract, never collide -> false', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'home', subject: 'Team Home', is_residual: false, market_ids: [1] },
    { outcome_id: 'away', subject: 'Team Away', is_residual: false, market_ids: [2] },
    { outcome_id: 'other', subject: null, is_residual: true, market_ids: [3] },
    { outcome_id: 'field', subject: null, is_residual: true, market_ids: [4] },
  ])).toBe(false);
});

test('isUnionDoubleMapped: same market under the SAME outcome_id (one slot, multi-leg) -> false', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'home', subject: 'Team Home', is_residual: false, market_ids: [1, 1] },
    { outcome_id: 'away', subject: 'Team Away', is_residual: false, market_ids: [2] },
  ])).toBe(false);
});

test('isUnionDoubleMapped: null/empty subjects do not collide with each other -> false', () => {
  expect(isUnionDoubleMapped([
    { outcome_id: 'a', subject: null, is_residual: false, market_ids: [1] },
    { outcome_id: 'b', subject: '', is_residual: false, market_ids: [2] },
    { outcome_id: 'c', subject: '   ', is_residual: false, market_ids: [3] },
  ])).toBe(false);
});


function mfx(over: Partial<MemberFacts> & { market_id: number; platform: string }): MemberFacts {
  return {
    title: null, platform_event_id: null, end_date: null, event_ticker: null,
    yes_sub_title: null, event_kind: null, condition_direction: null,
    value_primary: null, value_secondary: null, value_unit: null, condition_date: null,
    ...over,
  };
}

function repValPick<T extends { market_id: number; value_primary: number | string | null }>(
  members: ReadonlyArray<T>,
): T {
  return members.slice().sort(
    (a, b) =>
      Number(a.value_primary == null) - Number(b.value_primary == null) ||
      a.market_id - b.market_id,
  )[0];
}

test('W1-C2 q10408 shape: refused mid-ladder legs cannot donate vp — projection comes from accepted 2.5 members', () => {
  const nodeKey = 'sem:10408:total';
  const rows = [
    { node_key: nodeKey, ...mfx({
      market_id: 999, platform: 'polymarket', title: 'Mariners vs Astros: O/U 2.5',
      platform_event_id: '454321', event_kind: 'match_total_metric',
      condition_direction: 'above', value_primary: '2.5', value_unit: 'runs',
    }) },
    ...Array.from({ length: 11 }, (_, i) => ({
      node_key: nodeKey,
      ...mfx({
        market_id: 1000 + i, platform: 'kalshi',
        title: `Will the total be over ${2.5 + i} runs?`,
        event_ticker: 'KXTOTAL-Q10408', yes_sub_title: `Over ${2.5 + i}`,
        platform_event_id: 'kalshi:event:KXTOTAL-Q10408',
        event_kind: 'match_total_metric', condition_direction: 'above',
        value_primary: String(2.5 + i), value_unit: 'runs',
      }),
    })),
  ];

  const { refused } = partitionCohesiveMembers(rows);
  const refusedIds = new Set(refused.map((r) => r.market_id));

  expect(refusedIds.has(1006)).toBe(true);
  expect(rows.find((r) => r.market_id === 1006)!.value_primary).toBe('8.5');
  expect(refused.length).toBe(10);

  const accepted = rows.filter((r) => !refusedIds.has(r.market_id));
  expect(accepted.map((r) => r.market_id)).toEqual([999, 1000]);
  expect(accepted.every((r) => r.value_primary === '2.5')).toBe(true);

  expect(repValPick(accepted).value_primary).toBe('2.5');
  expect(rows.some((r) => r.value_primary === '8.5')).toBe(true);
});

test('W1-C2 SQL: every projection CTE reads accepted_leg, never raw legs', () => {
  const sql = projectNodesFromLegsSql();
  expect(sql).toContain('accepted_leg AS');
  expect(sql.split('FROM semantic_event_legs sel').length - 1).toBe(1);
  expect(sql.split('FROM accepted_leg sel').length - 1).toBe(11);
});

test('W1-C2 SQL: accepted_leg = NOT-refused ($1) AND attach-winning leg; NULL-market legs pass', () => {
  const sql = projectNodesFromLegsSql();
  expect(sql).toContain('NOT IN (SELECT unnest($1::int[]))');
  expect(sql).toContain('PARTITION BY sel.market_id');
  expect(sql).toContain(`ORDER BY 'sem:' || sel.semantic_event_id || ':' || sel.outcome_id`);
  expect(sql).toContain('t.win_rank = 1');
  expect(sql).toContain('t.market_id IS NULL');
  expect(sql).toContain('se.archived_at IS NULL');
});

test('W1-C2 SQL: representative ordering rules unchanged (determinism regression)', () => {
  const sql = projectNodesFromLegsSql();
  expect(sql).toContain('(n.value_primary IS NULL), sel.market_id');
  expect(sql).toContain('(n.participants IS NULL OR cardinality(n.participants) = 0), sel.market_id');
  expect(sql).toContain("(array_remove(array_agg(n.canonical_event    ORDER BY sel.market_id), NULL))[1]");
});

test('W1-C2 SQL: slot facts exclude refused legs INSIDE the per-outcome aggregate; no win-rank (double-map belt preserved)', () => {
  const sql = semanticOutcomeLegFactsSql();
  const filterAt = sql.indexOf('sel.market_id NOT IN (SELECT unnest($1::int[]))');
  const groupAt = sql.indexOf('GROUP BY sel.semantic_event_id, sel.outcome_id');
  expect(filterAt).toBeGreaterThan(-1);
  expect(groupAt).toBeGreaterThan(filterAt);
  expect(sql).toContain('sel.market_id IS NULL');
  expect(sql).not.toContain('win_rank');
});

test('W1-C2 SQL: orphan probe counts a refused child as un-legged (Σ=1 demote arm)', () => {
  const sql = semanticSetOrphanProbeSql();
  expect(sql).toContain('AND sel.market_id NOT IN (SELECT unnest($1::int[]))');
  expect(sql).toContain('bool_or(legged.market_id IS NULL) AS orphan');
  expect(sql).toContain('JOIN semantic_event_platforms sep');
  expect(sql).toContain("cn.condition_shape IS NOT NULL");
});


const dleg = (
  market_id: number, se: number, outcome_id: string,
  outcome_subject: string | null, canonical_subject: string | null,
): DualMapLegRow => ({
  market_id,
  node_key: `sem:${se}:${outcome_id}`,
  outcome_id,
  outcome_subject,
  canonical_subject,
});

test('foldSubjectKey: space/case/punctuation/diacritic-insensitive; null/empty → null', () => {
  expect(foldSubjectKey('Aston Villa')).toBe('astonvilla');
  expect(foldSubjectKey('aston_villa')).toBe('astonvilla');
  expect(foldSubjectKey('  ASTON-VILLA. ')).toBe('astonvilla');
  expect(foldSubjectKey('Iván Cepeda')).toBe('ivancepeda');
  expect(foldSubjectKey(null)).toBeNull();
  expect(foldSubjectKey('—')).toBeNull();
});

test('dual-map: subject proves a DIFFERENT node → RE-ROUTE, rival legs become losers (live m3645769 shape)', () => {
  const r = resolveDualMappedLegs([
    dleg(3645769, 2357, 'nigma_galaxy_win', 'Nigma Galaxy', 'REKONIX'),
    dleg(3645769, 2357, 'rekonix_win', 'REKONIX', 'REKONIX'),
  ]);
  expect(r.rerouted).toBe(1);
  expect(r.kept).toBe(0);
  expect(r.refusedMarketIds).toEqual([]);
  expect(r.loserLegKeys).toEqual(['sem:2357:nigma_galaxy_win#3645769']);
});

test('dual-map: subject proves the current lowest-key winner → KEEP (losers still excluded)', () => {
  const r = resolveDualMappedLegs([
    dleg(10, 100, 'burnley_win', 'Burnley', 'Burnley'),
    dleg(10, 999, 'burnley_win_dup', 'Burnley FC wins on 2026-05-10', 'Burnley'),
  ]);
  expect(r.kept).toBe(1);
  expect(r.rerouted).toBe(0);
  expect(r.loserLegKeys).toEqual(['sem:999:burnley_win_dup#10']);
});

test('dual-map: folded outcome_id is a match fallback when outcome_subject is unusable', () => {
  const r = resolveDualMappedLegs([
    dleg(11, 5, 'aston_villa', null, 'Aston Villa'),
    dleg(11, 5, 'match_winner', 'Match Winner', 'Aston Villa'),
  ]);
  expect(r.rerouted + r.kept).toBe(1);
  expect(r.loserLegKeys).toEqual(['sem:5:match_winner#11']);
  const r2 = resolveDualMappedLegs([
    dleg(12, 6, 't1_win', null, 'T1'),
    dleg(12, 6, 'match_winner', 'Match Winner', 'T1'),
  ]);
  expect(r2.refusedMarketIds).toEqual([12]);
});

test('dual-map: ZERO matches → REFUSE (fixture-subject market, predicate outcomes)', () => {
  const r = resolveDualMappedLegs([
    dleg(3644926, 2826, 'over_2.5_goals', 'Over 2.5 Goals', 'Mallorca vs Villarreal'),
    dleg(3644926, 2826, 'over_3_goals', 'Over 3 goals', 'Mallorca vs Villarreal'),
  ]);
  expect(r.refusedMarketIds).toEqual([3644926]);
  expect(r.loserLegKeys).toEqual([]);
});

test('dual-map: MULTI-match (duplicate SEs) → REFUSE (live m3645301 EPL-Winner shape)', () => {
  const r = resolveDualMappedLegs([
    dleg(3645301, 1146, 'arsenal', 'Arsenal', 'Arsenal'),
    dleg(3645301, 1437, 'arsenal', 'Arsenal', 'Arsenal'),
  ]);
  expect(r.refusedMarketIds).toEqual([3645301]);
  expect(r.loserLegKeys).toEqual([]);
});

test('dual-map: NULL canonical_subject = no evidence → REFUSE', () => {
  const r = resolveDualMappedLegs([
    dleg(20, 1, 'a', 'Alpha', null),
    dleg(20, 2, 'b', 'Beta', null),
  ]);
  expect(r.refusedMarketIds).toEqual([20]);
});

test('dual-map: a single-node market (even with multiple legs on that node) is untouched', () => {
  const r = resolveDualMappedLegs([
    dleg(30, 7, 'x', 'X', 'Wrong Subject'),
    dleg(30, 7, 'x', 'X variant', 'Wrong Subject'),
    dleg(31, 8, 'solo', 'Solo', 'Solo'),
  ]);
  expect(r.refusedMarketIds).toEqual([]);
  expect(r.loserLegKeys).toEqual([]);
  expect(r.kept + r.rerouted).toBe(0);
});

test('dual-map SQL: loser-leg exclusion sits INSIDE the projection window (winner = rank 1)', () => {
  const sql = projectNodesFromLegsSql();
  const exclAt = sql.indexOf("|| '#' || sel.market_id NOT IN (SELECT unnest($2::text[]))");
  const windowCloseAt = sql.indexOf(') t');
  expect(exclAt).toBeGreaterThan(-1);
  expect(exclAt).toBeLessThan(windowCloseAt);
  expect(sql).toContain('WHERE sel.market_id IS NULL');
});

test('dual-map SQL: slot facts + orphan probe exclude proven-loser legs ($2)', () => {
  const facts = semanticOutcomeLegFactsSql();
  const factsExcl = facts.indexOf("NOT IN (SELECT unnest($2::text[]))");
  const factsGroup = facts.indexOf('GROUP BY sel.semantic_event_id, sel.outcome_id');
  expect(factsExcl).toBeGreaterThan(-1);
  expect(factsGroup).toBeGreaterThan(factsExcl); // inside the per-outcome aggregate
  const probe = semanticSetOrphanProbeSql();
  expect(probe).toContain("NOT IN (SELECT unnest($2::text[]))");
  expect(probe).toContain('bool_or(legged.market_id IS NULL) AS orphan');
});


test('reconcile SQL: scoped to categorical Σ=1 sets only (threshold encoding exempt)', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain("os.set_type = 'categorical'");
  expect(sql).toContain('AND os.is_exhaustive');
  expect(sql).toContain('SET is_exhaustive = FALSE');
});

test('reconcile SQL: BOTH demote arms present (count mismatch + archived/memberless slot)', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain('os.slot_count <> (SELECT COUNT(*)::int FROM outcome_set_slots s WHERE s.set_id = os.id)');
  expect(sql).toContain('q.archived_at IS NOT NULL OR q.member_count = 0');
});


test('buildThresholdLadderEdgesSql: carries the F-E2E-1 same-subject participant gate (via precomputed pfold)', () => {
  const rungs = buildThresholdLadderRungsSql();
  expect(rungs).toContain('array_agg(lower(immutable_unaccent(x))');
  expect(rungs).toContain('FROM unnest(q.participants)');
  expect(rungs).toContain('AS pfold');
  const sql = buildThresholdLadderEdgesSql();
  expect(sql).toMatch(/NOT \(a\.pfold IS NOT NULL AND b\.pfold IS NOT NULL AND a\.pfold IS DISTINCT FROM b\.pfold\)/);
  expect(sql).toMatch(/a\.event_kind = 'match_spread' AND b\.event_kind = 'match_spread'[\s\S]*?a\.pfold IS DISTINCT FROM b\.pfold/);
});

test('buildThresholdLadderEdgesSql: carries the SAME-TEAM margin-ladder gate (cross-14 KXUECLSPREAD fake-arb class)', () => {
  expect(buildThresholdLadderRungsSql()).toContain('q.canonical_subject');
  const sql = buildThresholdLadderEdgesSql();
  expect(sql).toMatch(/a\.canonical_subject ~\* ' wins\( \.\+\)\? by' AND b\.canonical_subject ~\* ' wins\( \.\+\)\? by'/);
  expect(sql).toMatch(/regexp_replace\(lower\(immutable_unaccent\(a\.canonical_subject\)\), ' wins \.\*\$', ''\)\s*IS DISTINCT FROM/);
});

test('thresholdLadderEdgesRef: co-grouped both-teams margin ladder emits SAME-team rungs, NOT cross-team (cross-14)', () => {
  const A = 'FK Žalgiris Vilnius', B = 'SK Dinamo Tbilisi';
  const parts = [A, B];
  const s = (id: number, team: string, v: number): ThresholdLadderSlot => ({
    questionId: id, direction: 'above', value: v, unit: 'goals', participants: parts,
    eventKind: 'match_spread', canonicalSubject: `${team} wins by more than ${v} goals`,
  });
  const slots: ThresholdLadderSlot[] = [s(1, A, 2.5), s(2, B, 2.5), s(3, A, 1.5), s(4, B, 1.5)];
  const edges = thresholdLadderEdgesRef(slots);
  const has = (a: number, b: number) => edges.some(([x, y]) => x === a && y === b);
  expect(has(1, 3)).toBe(true);  // A wins by >2.5 ⟹ A wins by >1.5
  expect(has(2, 4)).toBe(true);  // B wins by >2.5 ⟹ B wins by >1.5
  expect(has(1, 4)).toBe(false); // A wins by >2.5 ⇏ B wins by >1.5
  expect(has(2, 3)).toBe(false); // B wins by >2.5 ⇏ A wins by >1.5
  expect(edges.length).toBe(2);  // exactly the two same-team adjacent rungs
});

test('thresholdLadderEdgesRef: PERIOD-scoped basketball spread blocks cross-team but keeps same-team period ladder (bg-reports)', () => {
  const parts = ['Atlanta', 'Seattle']; // match_spread nodes carry both-team arity-2
  const s = (id: number, team: string, v: number): ThresholdLadderSlot => ({
    questionId: id, direction: 'above', value: v, unit: 'points', participants: parts,
    eventKind: 'match_spread', metricScope: 'quarter',
    canonicalSubject: `${team} wins 1st Quarter by over ${v} points`,
  });
  const slots: ThresholdLadderSlot[] = [s(1, 'Atlanta', 10.5), s(2, 'Seattle', 10.5), s(3, 'Atlanta', 1.5), s(4, 'Seattle', 1.5)];
  const edges = thresholdLadderEdgesRef(slots);
  const has = (a: number, b: number) => edges.some(([x, y]) => x === a && y === b);
  expect(has(1, 3)).toBe(true);  // Atlanta >10.5 ⟹ Atlanta >1.5 (same team) — kept
  expect(has(2, 4)).toBe(true);  // Seattle >10.5 ⟹ Seattle >1.5 (same team) — kept
  expect(has(1, 4)).toBe(false); // Atlanta >10.5 ⇏ Seattle >1.5 (cross-team) — blocked
  expect(has(2, 3)).toBe(false); // Seattle >10.5 ⇏ Atlanta >1.5 (cross-team) — blocked
  expect(edges.length).toBe(2);  // exactly the two same-team adjacent rungs
});

test('thresholdLadderEdgesRef: same-team spread whose subject omits "wins by" is NOT over-blocked (PSG vs PSG FC / paren line)', () => {
  const parts = ['Paris Saint-Germain', 'Marseille'];
  const slots: ThresholdLadderSlot[] = [
    { questionId: 1, direction: 'above', value: 2.5, unit: 'goals', participants: parts, eventKind: 'match_spread', canonicalSubject: 'Paris Saint-Germain' },
    { questionId: 2, direction: 'above', value: 1.5, unit: 'goals', participants: parts, eventKind: 'match_spread', canonicalSubject: 'Paris Saint-Germain FC' },
  ];
  const edges = thresholdLadderEdgesRef(slots);
  expect(edges).toEqual([[1, 2]]); // 2.5 ⟹ 1.5 preserved
});

test('buildThresholdLadderEdgesSql: emits the TRANSITIVE REDUCTION (adjacent rungs only), not the full closure', () => {
  const sql = buildThresholdLadderEdgesSql();
  expect(sql).toContain('NOT EXISTS');
  expect(sql).toContain('FROM thr_rungs c');
  expect(sql).toContain('LEAST(a.value_primary, b.value_primary)');
  expect(sql).toContain('GREATEST(a.value_primary, b.value_primary)');
  expect(sql).toContain('FROM thr_rungs a');
});

test('buildThresholdLadderEdgesSql: reaps stale pairs that no longer share a threshold_series set (F-E2E-1 materialization gap)', () => {
  const sql = buildThresholdLadderEdgesSql();
  expect(sql).toContain('DELETE FROM implication_edges');
  expect(sql).toContain(`e.pattern = 'numeric_threshold'`);
  expect(sql.indexOf('DELETE FROM implication_edges')).toBeLessThan(sql.indexOf('INSERT INTO implication_edges'));
  const reap = sql.slice(sql.indexOf('WITH reap'), sql.indexOf('), ins AS'));
  expect(reap).toContain('sb.set_id = sa.set_id');
  expect(reap).toContain(`os2.set_type = 'threshold_series'`);
  expect(reap).toContain('NOT EXISTS');
});

test('thresholdLadderEdgesRef: interleaved per-team corner ladders emit NO cross-subject edges, keep both within-team chains', () => {
  const slots: ThresholdLadderSlot[] = [
    { questionId: 1, direction: 'above', value: 3.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
    { questionId: 2, direction: 'above', value: 5.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
    { questionId: 3, direction: 'above', value: 7.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
    { questionId: 4, direction: 'above', value: 5.5, unit: 'corners', participants: ['Spain'], eventKind: 'player_prop_threshold' },
    { questionId: 5, direction: 'above', value: 7.5, unit: 'corners', participants: ['Spain'], eventKind: 'player_prop_threshold' },
    { questionId: 6, direction: 'above', value: 9.5, unit: 'corners', participants: ['Spain'], eventKind: 'player_prop_threshold' },
  ];
  const edges = thresholdLadderEdgesRef(slots);
  const belgium = new Set([1, 2, 3]);
  const spain = new Set([4, 5, 6]);
  for (const [a, b] of edges) {
    const sameTeam = (belgium.has(a) && belgium.has(b)) || (spain.has(a) && spain.has(b));
    expect(sameTeam).toBe(true);
  }
  const key = (a: number, b: number) => edges.some(([x, y]) => x === a && y === b);
  expect(key(3, 2)).toBe(true);
  expect(key(2, 1)).toBe(true);
  expect(key(3, 1)).toBe(false);
  expect(key(6, 5)).toBe(true);
  expect(key(5, 4)).toBe(true);
  expect(key(6, 4)).toBe(false);
  expect(edges.length).toBe(4);
});

test('thresholdLadderEdgesRef: single-subject ladder keeps its FULL ORDER as an adjacent chain (transitive reduction, no order loss)', () => {
  const team: ThresholdLadderSlot[] = [
    { questionId: 10, direction: 'above', value: 3.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
    { questionId: 11, direction: 'above', value: 5.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
    { questionId: 12, direction: 'above', value: 7.5, unit: 'corners', participants: ['Belgium'], eventKind: 'player_prop_threshold' },
  ];
  const teamEdges = thresholdLadderEdgesRef(team);
  expect(teamEdges.length).toBe(2);
  const teamHas = (a: number, b: number) => teamEdges.some(([x, y]) => x === a && y === b);
  expect(teamHas(12, 11)).toBe(true);  // 8+⟹6+
  expect(teamHas(11, 10)).toBe(true);  // 6+⟹4+
  expect(teamHas(12, 10)).toBe(false); // 8+⟹4+ dropped (11 is the intermediate)

  const price: ThresholdLadderSlot[] = [
    { questionId: 20, direction: 'above', value: 2500, unit: 'usd', participants: null, eventKind: 'price_threshold' },
    { questionId: 21, direction: 'above', value: 3000, unit: 'usd', participants: null, eventKind: 'price_threshold' },
    { questionId: 22, direction: 'above', value: 3500, unit: 'usd', participants: null, eventKind: 'price_threshold' },
  ];
  const priceEdges = thresholdLadderEdgesRef(price);
  expect(priceEdges.length).toBe(2); // 3500⟹3000, 3000⟹2500
  const has = (a: number, b: number) => priceEdges.some(([x, y]) => x === a && y === b);
  expect(has(22, 21)).toBe(true);
  expect(has(21, 20)).toBe(true);
  expect(has(22, 20)).toBe(false); // non-adjacent closure edge dropped
});

test('thresholdLadderEdgesRef: chain of 4 rungs → 3 adjacent edges, not 6 (transitive reduction)', () => {
  const four: ThresholdLadderSlot[] = [10, 20, 30, 40].map((v, i) => ({
    questionId: i + 1, direction: 'above', value: v, unit: 'usd', participants: null, eventKind: 'price_threshold',
  }));
  const edges = thresholdLadderEdgesRef(four);
  expect(edges.length).toBe(3); // 40⟹30, 30⟹20, 20⟹10 — NOT the 6 closure pairs
  const has = (a: number, b: number) => edges.some(([x, y]) => x === a && y === b);
  expect(has(4, 3)).toBe(true);
  expect(has(3, 2)).toBe(true);
  expect(has(2, 1)).toBe(true);
  expect(has(4, 2)).toBe(false);
  expect(has(4, 1)).toBe(false);
  expect(has(3, 1)).toBe(false);
});


const cornerSlot = (
  vp: number, fp: string | null,
): MetricKeyed => ({
  event_kind: 'player_prop_threshold',
  metric_scope: 'team',
  value_unit: 'corners',
  condition_direction: 'above',
  value_primary: vp,
  value_secondary: null,
  folded_participants: fp,
});

test('partitionThresholdGroups: fused Belgium⊕Spain corners (set 67273) → TWO groups of 3 by folded participants', () => {
  const slots = [
    cornerSlot(9.5, 'spain'),   // Spain 10+
    cornerSlot(7.5, 'belgium'), // Belgium 8+
    cornerSlot(7.5, 'spain'),   // Spain 8+
    cornerSlot(5.5, 'belgium'), // Belgium 6+
    cornerSlot(5.5, 'spain'),   // Spain 6+
    cornerSlot(3.5, 'belgium'), // Belgium 4+
  ];
  const groups = partitionThresholdGroups(slots, () => false);
  expect(groups.length).toBe(2);
  const keys = groups.map((g) => new Set(g.map((s) => s.folded_participants)));
  for (const k of keys) expect(k.size).toBe(1);
  expect(groups.reduce((n, g) => n + g.length, 0)).toBe(6);
  expect(groups.every((g) => g.length === 3)).toBe(true);
  const flat = groups.map((g) => g[0].folded_participants).sort();
  expect(flat).toEqual(['belgium', 'spain']);

  const toEdgeSlots = (g: MetricKeyed[], base: number): ThresholdLadderSlot[] =>
    g.map((s, i) => ({
      questionId: base + i, direction: 'above', value: Number(s.value_primary),
      unit: 'corners', participants: [String(s.folded_participants)],
      eventKind: 'player_prop_threshold',
    }));
  let cross = 0;
  for (const [gi, g] of groups.entries()) {
    const edges = thresholdLadderEdgesRef(toEdgeSlots(g, 100 + gi * 10));
    expect(edges.length).toBe(2); // transitive reduction of a 3-rung within-team chain
    for (const [a, b] of edges) {
      const sameGroup = Math.floor(a / 10) === Math.floor(b / 10);
      if (!sameGroup) cross++;
    }
  }
  expect(cross).toBe(0);
});

test('partitionThresholdGroups: single-subject ladder → ONE group unchanged (no recall loss)', () => {
  const slots = [
    cornerSlot(3.5, 'belgium'),
    cornerSlot(5.5, 'belgium'),
    cornerSlot(7.5, 'belgium'),
  ];
  const groups = partitionThresholdGroups(slots, () => false);
  expect(groups.length).toBe(1);
  expect(groups[0].length).toBe(3);
});

test('partitionThresholdGroups: NULL-participant price ladder → ONE group (all-NULL share one bucket)', () => {
  const price: MetricKeyed[] = [2500, 3000, 3500].map((vp) => ({
    event_kind: 'price_threshold', metric_scope: null, value_unit: 'usd',
    condition_direction: 'above', value_primary: vp, value_secondary: null,
    folded_participants: null,
  }));
  const groups = partitionThresholdGroups(price, () => false);
  expect(groups.length).toBe(1);
  expect(groups[0].length).toBe(3);
});


const gasRung = (vp: number): MetricKeyed => ({
  event_kind: 'price_threshold',
  metric_scope: null,
  value_unit: 'usd',
  condition_direction: 'above',
  value_primary: vp,
  value_secondary: null,
  folded_participants: null,
});

test('dropCollidedLadderRungs: KXAAAGASD 3.990⊕4.000 quantized onto one value → BOTH rungs dropped', () => {
  const slots = [4.005, 4, 4, 3.995, 3.985].map(gasRung);
  const { kept, dropped } = dropCollidedLadderRungs(slots);
  expect(dropped.length).toBe(2);
  expect(dropped.every((s) => Number(s.value_primary) === 4)).toBe(true);
  expect(kept.map((s) => Number(s.value_primary))).toEqual([4.005, 3.995, 3.985]);
});

test('dropCollidedLadderRungs: a CLEAN ladder is returned untouched (no recall loss)', () => {
  const slots = [4.005, 4, 3.995, 3.99, 3.985].map(gasRung);
  const { kept, dropped } = dropCollidedLadderRungs(slots);
  expect(dropped.length).toBe(0);
  expect(kept.length).toBe(5);
});

test('dropCollidedLadderRungs: a GAPPED ladder is NOT refused (attainable-domain rule)', () => {
  const counts: MetricKeyed[] = [40, 20, 19, 5].map((vp) => ({
    event_kind: 'count_threshold', metric_scope: null, value_unit: 'tweets',
    condition_direction: 'above', value_primary: vp, value_secondary: null,
    folded_participants: null,
  }));
  const { kept, dropped } = dropCollidedLadderRungs(counts);
  expect(dropped.length).toBe(0);
  expect(kept.length).toBe(4);
});

test('dropCollidedLadderRungs: fully interleaved per-team ladder collapses to nothing', () => {
  const teamGoals = (vp: number, team: string): MetricKeyed => ({
    event_kind: 'player_prop_threshold', metric_scope: 'team', value_unit: 'goals',
    condition_direction: 'above', value_primary: vp, value_secondary: null,
    folded_participants: team,
  });
  const slots = [
    teamGoals(2.5, 'paide'), teamGoals(2.5, 'zira'),
    teamGoals(1.5, 'paide'), teamGoals(1.5, 'zira'),
    teamGoals(0.5, 'paide'), teamGoals(0.5, 'zira'),
  ];
  const { kept, dropped } = dropCollidedLadderRungs(slots);
  expect(dropped.length).toBe(6);
  expect(kept.length).toBe(0);
});

test('dropCollidedLadderRungs: NULL-valued rungs never collide with each other', () => {
  const slots: MetricKeyed[] = [
    gasRung(4.005),
    { ...gasRung(0), value_primary: null },
    { ...gasRung(0), value_primary: null },
  ];
  const { kept, dropped } = dropCollidedLadderRungs(slots);
  expect(dropped.length).toBe(0);
  expect(kept.length).toBe(3);
});

test('semanticOutcomeLegFactsSql: carries the F-E2E-1 round-2 folded-participants partition key', () => {
  const sql = semanticOutcomeLegFactsSql();
  expect(sql).toContain('AS folded_participants');
  expect(sql).toContain('array_to_string');
  expect(sql).toContain('array_agg(lower(immutable_unaccent(x))');
  expect(sql).toContain('FROM unnest(n.participants) x');
});


const spreadSlot = (
  vp: number, cover: string | null,
): MetricKeyed => ({
  event_kind: 'match_spread',
  metric_scope: null,
  value_unit: 'goals',
  condition_direction: 'above',
  value_primary: vp,
  value_secondary: null,
  folded_participants: 'athletic bilbaorcd espanyol', // MATCH pair, identical on both rungs
  cover_subject: cover,
});

test('partitionThresholdGroups: F5 splits a co-grouped two-team spread set into two per-team sets by cover_subject', () => {
  const slots = [
    spreadSlot(2.5, 'Athletic Bilbao'),
    spreadSlot(2.5, 'RCD Espanyol'),
    spreadSlot(1.5, 'Athletic Bilbao'),
    spreadSlot(1.5, 'RCD Espanyol'),
  ];
  const groups = partitionThresholdGroups(slots, () => false);
  expect(groups.length).toBe(2);
  for (const g of groups) expect(new Set(g.map((s) => s.cover_subject)).size).toBe(1);
  expect(groups.reduce((n, g) => n + g.length, 0)).toBe(4);
  expect(groups.every((g) => g.length === 2)).toBe(true);
  const flat = groups.map((g) => g[0].cover_subject).sort();
  expect(flat).toEqual(['Athletic Bilbao', 'RCD Espanyol']);
});

test('partitionThresholdGroups: F5 keeps a same-team spread ladder as ONE set (no over-split)', () => {
  const slots = [spreadSlot(2.5, 'Athletic Bilbao'), spreadSlot(1.5, 'Athletic Bilbao')];
  const groups = partitionThresholdGroups(slots, () => false);
  expect(groups.length).toBe(1);
  expect(groups[0].length).toBe(2);
});

test('partitionThresholdGroups: F5 leaves a NULL-cover text ladder in ONE bucket (~1,800 legit ladders untouched)', () => {
  const price: MetricKeyed[] = [2500, 3000, 3500].map((vp) => ({
    event_kind: 'price_threshold', metric_scope: null, value_unit: 'usd',
    condition_direction: 'above', value_primary: vp, value_secondary: null,
    folded_participants: null, cover_subject: null,
  }));
  const groups = partitionThresholdGroups(price, () => false);
  expect(groups.length).toBe(1);
  expect(groups[0].length).toBe(3);
});

test('thresholdLadderEdgesRef: F6 cover_subject belt denies the cross-team spread edge, keeps same-team + NULL-cover', () => {
  const parts = ['Athletic Bilbao', 'RCD Espanyol'];
  const s = (id: number, cover: string, v: number): ThresholdLadderSlot => ({
    questionId: id, direction: 'above', value: v, unit: 'goals', participants: parts,
    eventKind: 'match_spread', canonicalSubject: cover, coverSubject: cover,
  });
  const slots: ThresholdLadderSlot[] = [
    s(1, 'Athletic Bilbao', 2.5), s(2, 'RCD Espanyol', 2.5),
    s(3, 'Athletic Bilbao', 1.5), s(4, 'RCD Espanyol', 1.5),
  ];
  const edges = thresholdLadderEdgesRef(slots);
  const has = (a: number, b: number) => edges.some(([x, y]) => x === a && y === b);
  expect(has(1, 3)).toBe(true);  // Bilbao >2.5 ⟹ Bilbao >1.5 (same team) — kept
  expect(has(2, 4)).toBe(true);  // Espanyol >2.5 ⟹ Espanyol >1.5 (same team) — kept
  expect(has(1, 4)).toBe(false); // Bilbao >2.5 ⇏ Espanyol >1.5 (cross-team) — DENIED
  expect(has(2, 3)).toBe(false); // Espanyol >2.5 ⇏ Bilbao >1.5 (cross-team) — DENIED
  expect(edges.length).toBe(2);  // exactly the two same-team adjacent rungs
});

test('thresholdLadderEdgesRef: F6 belt is NULL-tolerant — a NULL-cover text ladder still emits its full chain', () => {
  const price: ThresholdLadderSlot[] = [2500, 3000, 3500].map((v, i) => ({
    questionId: i + 1, direction: 'above', value: v, unit: 'usd', participants: null,
    eventKind: 'price_threshold', coverSubject: null,
  }));
  const edges = thresholdLadderEdgesRef(price);
  expect(edges.length).toBe(2); // 3500⟹3000, 3000⟹2500 (transitive reduction)
});

test('buildThresholdLadderRungsSql: projects cover_subject from questions.discriminators (F6 belt input)', () => {
  const sql = buildThresholdLadderRungsSql();
  expect(sql).toContain(`q.discriminators->>'cover_subject' AS cover_subject`);
});

test('buildThresholdLadderEdgesSql: F6 both-known-differ cover_subject conjunct is in the gate', () => {
  const sql = buildThresholdLadderEdgesSql();
  expect(sql).toContain('a.cover_subject IS NOT NULL AND b.cover_subject IS NOT NULL');
  expect(sql).toContain('a.cover_subject IS DISTINCT FROM b.cover_subject');
});

test('semanticOutcomeLegFactsSql + feed-B carry the cover_subject partition key (F5 plumbing)', () => {
  const feedA = semanticOutcomeLegFactsSql();
  expect(feedA).toContain(`array_agg(n.discriminators->>'cover_subject'`);
  expect(feedA).toContain('AS cover_subject');
});


test('looksOpenRace: fires on the live race titles, not on fixture "first" titles', () => {
  expect(looksOpenRace('Which AI will be the first to hit 1550 on Text Arena?')).toBe(true);
  expect(looksOpenRace("Which company's AI will first hit 1550 on Chatbot Arena in 2026?")).toBe(true);
  expect(looksOpenRace('Race to 270 electoral votes')).toBe(true);
  expect(looksOpenRace('First Half Winner')).toBe(false);
  expect(looksOpenRace('First 5 Innings')).toBe(false);
  expect(looksOpenRace('First Team to Score')).toBe(false);
  expect(looksOpenRace('F1 Sprint Qualifying')).toBe(false);
  expect(looksOpenRace(null)).toBe(false);
});


type DSlot = { id: string; dates: { date: string; precision: string | null }[]; kind: string | null; residual?: boolean };
const dslot = (id: string, dates: string[], kind: string | null = null, precision: string | null = 'year', residual = false): DSlot =>
  ({ id, dates: dates.map((date) => ({ date, precision })), kind, residual });
const dDatesOf = (s: DSlot) => s.dates;
const dKindOf = (s: DSlot) => s.kind;
const dIsRes = (s: DSlot) => !!s.residual;
const dpart = (slots: DSlot[]) => partitionByConditionDateGrain(slots, dDatesOf, dKindOf, dIsRes);
const idsOf = (g: DSlot[]) => g.map((s) => s.id).sort();

test('F4 set 535 (next PM of Israel): 2026 PM legs ⊕ 2045 Kalshi legs → split (gap 19)', () => {
  const slots: DSlot[] = [
    ...Array.from({ length: 20 }, (_, i) => dslot(`pm${i}`, ['2026-01-01'], null)),
    dslot('bezalel_smotrich', ['2045-01-01'], null),
    dslot('yoav_gallant', ['2045-01-01'], null),
    dslot('kalshi_nulldate_1', [], null),
    dslot('kalshi_nulldate_2', [], null),
    dslot('other', [], null, 'year', true), // residual
  ];
  const parts = dpart(slots);
  expect(parts.length).toBe(2);
  const g2045 = parts.find((g) => g.some((s) => s.id === 'yoav_gallant'))!;
  expect(idsOf(g2045)).toEqual(['bezalel_smotrich', 'yoav_gallant']);
  const g2026 = parts.find((g) => g.some((s) => s.id === 'pm0'))!;
  expect(g2026).toContain(slots.find((s) => s.id === 'kalshi_nulldate_1')!);
  expect(g2026).toContain(slots.find((s) => s.id === 'other')!);
  expect(parts.reduce((n, g) => n + g.length, 0)).toBe(slots.length); // subtractive re-partition
});

test('F4 election-kind tier (set 409-class): 2026 vs 2027 (gap 1) splits ONLY for election_outcome_winner', () => {
  const mk = (kind: string): DSlot[] => [
    dslot('a2026', ['2026-01-01'], kind), dslot('b2026', ['2026-01-01'], kind),
    dslot('c2027', ['2027-01-01'], kind),
  ];
  expect(dpart(mk('election_outcome_winner')).length).toBe(2);
  expect(dpart(mk('championship_winner')).length).toBe(1);
});

test('F4 latch skip: token_launch multi-deadline fold is NOT date-split (must reach S2 intact)', () => {
  const slots = [
    dslot('jul', ['2026-07-01'], 'token_launch'),
    dslot('aug', ['2026-08-01'], 'token_launch'),
    dslot('oct', ['2026-10-01'], 'token_launch'),
    dslot('mar', ['2027-03-01'], 'token_launch'),
  ];
  expect(dpart(slots).length).toBe(1);
});

test('F4 precision semantics: 2026-01-01/year vs 2026-06-15/day → same year grain, no split', () => {
  const slots = [
    { id: 'a', dates: [{ date: '2026-01-01', precision: 'year' }], kind: null },
    { id: 'b', dates: [{ date: '2026-06-15', precision: 'day' }], kind: null },
    { id: 'c', dates: [{ date: '2026-03-03', precision: 'day' }], kind: null },
  ];
  expect(partitionByConditionDateGrain(slots, dDatesOf, dKindOf, dIsRes).length).toBe(1);
});

test('F4: no trigger when all dates share the coarse grain / when only one is dated', () => {
  expect(dpart([dslot('a', ['2026-01-01']), dslot('b', ['2026-01-01'])]).length).toBe(1);
  expect(dpart([dslot('a', ['2026-01-01']), dslot('b', [])]).length).toBe(1);
});


type OSlot = { id: string; ords: number[]; residual?: boolean };
const oslot = (id: string, ords: number[] = [], residual = false): OSlot => ({ id, ords, residual });
const oOrdsOf = (s: OSlot) => s.ords;
const oIsRes = (s: OSlot) => !!s.residual;
const opart = (slots: OSlot[]) => partitionByGameOrdinalGrain(slots, oOrdsOf, oIsRes);
const oIdsOf = (g: OSlot[]) => g.map((s) => s.id).sort();

test('F9 two-period split: Map-1 winners ⊕ Map-2 winners → 2 ordinal groups', () => {
  const slots: OSlot[] = [
    oslot('a_map1', [1]), oslot('b_map1', [1]),
    oslot('a_map2', [2]), oslot('b_map2', [2]),
    oslot('nullord', []),                 // whole-match rider
    oslot('residual', [], true),          // residual rider
  ];
  const parts = opart(slots);
  expect(parts.length).toBe(2);
  const g1 = parts.find((g) => g.some((s) => s.id === 'a_map1'))!;
  const g2 = parts.find((g) => g.some((s) => s.id === 'a_map2'))!;
  expect(oIdsOf(g1)).toContain('b_map1');
  expect(oIdsOf(g2)).toContain('b_map2');
  expect(parts.reduce((n, g) => n + g.length, 0)).toBe(slots.length); // subtractive re-partition
});

test('F9 no split: single distinct ordinal OR all-NULL → no-op (Σ=1 never demoted)', () => {
  expect(opart([oslot('a', [1]), oslot('b', [1]), oslot('c', [])]).length).toBe(1);
  expect(opart([oslot('a', []), oslot('b', []), oslot('c', [])]).length).toBe(1);
  expect(opart([oslot('a', [1, 2]), oslot('b', [1])]).length).toBe(1);
});

test('F9 SQL-invariant: feed-A projects game_ordinals; game_ordinal stamp read from discriminators', () => {
  const sql = semanticOutcomeLegFactsSql();
  expect(sql).toContain("array_remove(array_agg(DISTINCT n.discriminators->>'game_ordinal'), NULL) AS game_ordinals");
});

test('SQL-invariant: is_open_race aggregate present in feed A + regex mirrored SQL↔TS', () => {
  const sql = semanticOutcomeLegFactsSql();
  // projected in the inner subquery and echoed in the outer select, or it reads undefined at runtime
  expect(sql).toContain('AS is_open_race');
  expect(sql).toContain('oc.is_open_race');
  // POSIX pattern mirrored in looksOpenRace (JS \y == SQL \b) -- keep both in sync
  const at = sql.indexOf(OPEN_RACE_TITLE_PATTERN);
  expect(at).toBeGreaterThan(-1);
  expect(sql.slice(at, at + 200)).toContain("NOT IN ('match_winner'");
});


test('P11: the reconcile SQL carries the negRisk completeness arm + its two CTEs', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain('negrisk_group_live AS (');
  expect(sql).toContain('set_negrisk_group AS (');
  expect(sql).toContain('WHERE sg.set_id = os.id AND g.n > os.slot_count');
  expect(sql.indexOf('negrisk_group_live AS (')).toBeLessThan(sql.indexOf('UPDATE outcome_sets os'));
  expect(sql).toContain('os.slot_count <> (SELECT COUNT(*)::int FROM outcome_set_slots s WHERE s.set_id = os.id)');
  expect(sql).toContain('q.archived_at IS NOT NULL OR q.member_count = 0');
});

test('P11: group identity mirrors NATIVE_MUTEX_SQL (PM gated on negRisk=true; Limitless lowercase-d)', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain("raw->>'negRisk' = 'true' AND NULLIF(mr.raw->>'negRiskMarketID', '') IS NOT NULL");
  expect(sql).toContain("'polymarket:negRisk:'");
  expect(sql).toContain("NULLIF(mr.raw->>'negRiskMarketId', '') IS NOT NULL");
  expect(sql).toContain("'limitless:negRisk:'");
});

test('P11: the count source mirrors the feed-B slot source (live + placeholder-net)', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain('m.resolved_at IS NULL');
  expect(sql).toContain("COALESCE(mr.raw->>'groupItemTitle', mr.raw->>'yes_sub_title', mr.raw#>>'{custom_strike,Team}', m.title)");
  expect(sql).toContain(isOmegaPlaceholderSlotSql(
    "COALESCE(mr.raw->>'groupItemTitle', mr.raw->>'yes_sub_title', mr.raw#>>'{custom_strike,Team}', m.title)",
  ));
});

test('P11: a set tracing to zero or ≥2 negRisk groups is INERT (never demoted on this arm)', () => {
  const sql = reconcileOutcomeSetExhaustivitySql();
  expect(sql).toContain('CASE WHEN count(DISTINCT');
  expect(sql).toContain('= 1');
  expect(sql).toContain('JOIN negrisk_group_live g ON g.gk = sg.gk');
});


test('P3: the last-resort canonical_event fallback is refused for fixture-shaped SE names', () => {
  const sql = projectNodesFromLegsSql();
  expect(sql).toContain(`CASE WHEN NOT ${isFixturePlaceholderSubjectSql('se.canonical_event')}`);
  expect(sql).toContain('THEN se.canonical_event END');
  expect(sql).toContain("CASE WHEN ds.semantic_event_id IS NOT NULL THEN 'Draw' END");
  expect(sql).toContain("NULLIF(initcap(replace(sel.outcome_id, '_', ' ')), '')");
});


test('P6: both feeds project condition_metric per slot (the hetero-dimension input)', () => {
  expect(semanticOutcomeLegFactsSql()).toContain(
    '(array_remove(array_agg(n.condition_metric ORDER BY sel.market_id), NULL))[1] AS condition_metric',
  );
});
