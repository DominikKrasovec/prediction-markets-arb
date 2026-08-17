import { test, expect, describe } from 'bun:test';
import {
  hasNestedDeadlineRungs,
  isNestedLadder,
  isPairwiseMutexPartition,
  hasNestedCumulativeRungs,
  mixesConfederationAndCountry,
  mixesAggregateOrgWithPolitician,
  classifySet,
  partitionHeteroCategoricalByKind,
  foldDriftLabel,
  labelDriftDuplicateOutcomeIds,
  residualCoversForeignPlatformSlot,
  computeAxisInterval,
  hasValueAxisOverlap,
  hasKalshiCustomExactScore,
  refusesNativeIndependentBundle,
  heteroDimensionViolation,
  settlementDimensionConflictReason,
  CONFEDERATION_SUBJECTS,
  type CertifierSlot,
  type CertifierSignals,
} from './outcome-set-certifier.js';

// isNestedLadder
// A threshold_series may stay nested ONLY if it is a genuine monotone half-line ladder
// (one direction class, all values present, single unit, >=2 distinct values).

test('isNestedLadder: pure-above value-present ladder -> TRUE', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 105, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 110, value_secondary: null, value_unit: 'usd' },
  ])).toBe(true);
});

test('isNestedLadder: pure-below ladder (incl gated aliases less/less_or_equal) -> TRUE', () => {
  expect(isNestedLadder([
    { direction: 'below', value_primary: 5, value_secondary: null, value_unit: 'usd' },
    { direction: 'less', value_primary: 7, value_secondary: null, value_unit: 'usd' },
    { direction: 'less_or_equal', value_primary: 9, value_secondary: null, value_unit: 'usd' },
  ])).toBe(true);
});

test('isNestedLadder: mixed direction (above + below) -> FALSE', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'below', value_primary: 50, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

test('isNestedLadder: any NULL value -> FALSE', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: null, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

test('isNestedLadder: between/at slots are not a half-line ladder -> FALSE', () => {
  expect(isNestedLadder([
    { direction: 'between', value_primary: 0, value_secondary: 10, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
  ])).toBe(false);
  expect(isNestedLadder([
    { direction: 'at', value_primary: 1, value_secondary: null, value_unit: null },
    { direction: 'at', value_primary: 2, value_secondary: null, value_unit: null },
  ])).toBe(false);
});

test('isNestedLadder: single-unit violation (usd vs percent) -> FALSE', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 105, value_secondary: null, value_unit: 'percent' },
  ])).toBe(false);
});

test('isNestedLadder: constant value (<2 distinct) -> FALSE', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

test('isNestedLadder: <2 slots -> FALSE', () => {
  expect(isNestedLadder([{ direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' }])).toBe(false);
});

// ladder rung collision belt
// The solver reads the order ideal z_i <= z_{i+1} off slot_ordinal, and
// sortLadderByValue is a stable sort, so two rungs quantized onto one stamped
// value get a chain link asserted by insertion order alone, deleting the
// band between their two real strikes. Rungs must be pairwise distinct.

test('isNestedLadder: two rungs collided onto ONE stamped value -> FALSE (belt)', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 4.005, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 4, value_secondary: null, value_unit: 'usd' },     // really >3.990
    { direction: 'above', value_primary: 4, value_secondary: null, value_unit: 'usd' },     // really >4.000
    { direction: 'above', value_primary: 3.995, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

test('isNestedLadder: a GAPPED but pairwise-distinct ladder still certifies (attainable domain)', () => {
  // A missing rung is no gap in the chain's sense — x > 20 => x > 19 needs no rung at
  // 19.5, and the order ideal ADMITS the in-between world instead of deleting it.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 40, value_secondary: null, value_unit: 'tweets' },
    { direction: 'above', value_primary: 20, value_secondary: null, value_unit: 'tweets' },
    { direction: 'above', value_primary: 19, value_secondary: null, value_unit: 'tweets' },
    { direction: 'above', value_primary: 5, value_secondary: null, value_unit: 'tweets' },
  ])).toBe(true);
});

// touch-vs-snapshot shape homogeneity in the nested ladder

test('isNestedLadder: TOUCH rung mixed with SNAPSHOT rung -> FALSE (no unsound nesting)', () => {
  // A "reach X by date" (touch) rung and an "above X at time" (snapshot) rung
  // can share direction/unit and have ordered values, but touch(X) does not
  // imply snapshot(Y), so certifying threshold_series would hand the solver
  // an unsound cumulative implication.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 2350, value_secondary: null, value_unit: 'usd', condition_shape: 'monotonic_threshold' },
    { direction: 'above', value_primary: 2300, value_secondary: null, value_unit: 'usd', condition_shape: 'point_in_time' },
  ])).toBe(false);
});

test('isNestedLadder: shape-homogeneous ladders still certify (touch-touch, snap-snap, NULL-tolerant)', () => {
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd', condition_shape: 'monotonic_threshold' },
    { direction: 'above', value_primary: 200, value_secondary: null, value_unit: 'usd', condition_shape: 'monotonic_threshold' },
  ])).toBe(true);
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd', condition_shape: 'point_in_time' },
    { direction: 'above', value_primary: 200, value_secondary: null, value_unit: 'usd', condition_shape: 'point_in_time' },
  ])).toBe(true);
  // unknown shape on one rung never refuses (NULL-tolerant doctrine)
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd', condition_shape: 'point_in_time' },
    { direction: 'above', value_primary: 200, value_secondary: null, value_unit: 'usd', condition_shape: null },
  ])).toBe(true);
});

// isNestedLadder participant-homogeneity gate
//
// A threshold_series set that folds two per-subject stat ladders under one
// event (same kind/scope/unit, different participants) must not certify as
// one nested chain — fusing the two participants' joint states into a single
// chain asserts a false implication. Both-known-and-differ refusal;
// NULL-tolerant.

test('isNestedLadder: two KNOWN differing folded participants (fused Belgium⊕Spain corners) -> FALSE', () => {
  // folded keys 'belgium' vs 'spain', same dir/unit, 6 distinct values
  expect(isNestedLadder([
    { direction: 'above', value_primary: 3.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 5.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 7.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 5.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
    { direction: 'above', value_primary: 7.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
    { direction: 'above', value_primary: 9.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
  ])).toBe(false);
});

test('isNestedLadder: each single-team 3-rung split IS a sound ladder (post-partition, no recall loss)', () => {
  // Belgium 4+/6+/8+ on its own → the certified 3-rung ladder.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 3.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 5.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 7.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
  ])).toBe(true);
  // Spain 6+/8+/10+ likewise.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 5.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
    { direction: 'above', value_primary: 7.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
    { direction: 'above', value_primary: 9.5, value_secondary: null, value_unit: 'corners', folded_participants: 'spain' },
  ])).toBe(true);
});

test('isNestedLadder: NULL / one-sided participants never refuse (NULL-tolerant, price ladders unchanged)', () => {
  // (a) all-NULL participants (a price-in-text ETH ladder) — untouched.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 2500, value_secondary: null, value_unit: 'usd', folded_participants: null },
    { direction: 'above', value_primary: 3000, value_secondary: null, value_unit: 'usd', folded_participants: null },
    { direction: 'above', value_primary: 3500, value_secondary: null, value_unit: 'usd', folded_participants: null },
  ])).toBe(true);
  // (b) one known + one NULL (a partially-stamped single-subject ladder) — NULL side
  // never manufactures a second key, so ≤1 known key → still a ladder.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd', folded_participants: 'ethereum' },
    { direction: 'above', value_primary: 200, value_secondary: null, value_unit: 'usd', folded_participants: null },
  ])).toBe(true);
  // (c) two slots, SAME known key → one team's ladder, still TRUE.
  expect(isNestedLadder([
    { direction: 'above', value_primary: 3.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
    { direction: 'above', value_primary: 5.5, value_secondary: null, value_unit: 'corners', folded_participants: 'belgium' },
  ])).toBe(true);
});

// isPairwiseMutexPartition

test('isPairwiseMutexPartition: below+between+above price grid -> TRUE (disjoint)', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'below', value_primary: 10, value_secondary: null, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
    { direction: 'above', value_primary: 20, value_secondary: null, value_unit: 'usd' },
  ])).toBe(true);
});

test('isPairwiseMutexPartition: pure-above ladder -> FALSE (nested, overlapping)', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'above', value_primary: 100, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: 110, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

test('isPairwiseMutexPartition: overlapping between buckets -> FALSE', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'between', value_primary: 0, value_secondary: 12, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
  ])).toBe(false);
});

test('isPairwiseMutexPartition: adjacent buckets sharing only a boundary -> TRUE', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'between', value_primary: 0, value_secondary: 10, value_unit: 'usd' },
    { direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' },
  ])).toBe(true);
});

test('isPairwiseMutexPartition: any NULL value -> FALSE', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'below', value_primary: 10, value_secondary: null, value_unit: 'usd' },
    { direction: 'above', value_primary: null, value_secondary: null, value_unit: 'usd' },
  ])).toBe(false);
});

// isPairwiseMutexPartition unit-awareness

test('isPairwiseMutexPartition: {above 400 billion, below 1 trillion} -> FALSE (normalized overlap)', () => {
  // raw 400 > 1 falsely certifies disjoint; folded 4e11 < 1e12 → they OVERLAP.
  expect(isPairwiseMutexPartition([
    { direction: 'above', value_primary: 400, value_secondary: null, value_unit: 'billion' },
    { direction: 'below', value_primary: 1, value_secondary: null, value_unit: 'trillion' },
  ])).toBe(false);
});

test('isPairwiseMutexPartition: {between 250-280 billion, above 1 trillion} -> TRUE (disjoint after fold)', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'between', value_primary: 250, value_secondary: 280, value_unit: 'billion' },
    { direction: 'above', value_primary: 1, value_secondary: null, value_unit: 'trillion' },
  ])).toBe(true);
});

test('isPairwiseMutexPartition: {above 5 billion, below 3 seats} -> FALSE (dimension mismatch refuses)', () => {
  expect(isPairwiseMutexPartition([
    { direction: 'above', value_primary: 5, value_secondary: null, value_unit: 'billion' },
    { direction: 'below', value_primary: 3, value_secondary: null, value_unit: 'seats' },
  ])).toBe(false);
});

// value-axis pairwise disjointness

/** Build an unshaped band slot (all gated fields NULL) whose axis_interval is
 *  parsed from its real outcome_id key. */
const bandSlot = (outcome_id: string, is_residual = false): CertifierSlot =>
  slot({
    outcome_id,
    display_label: outcome_id,
    canonical_subject: null,
    is_residual,
    axis_interval: computeAxisInterval({ is_residual, axis_key: outcome_id }),
  });

describe('BELT V — hasValueAxisOverlap + classifySet (set 1152897 CXMT IPO market cap)', () => {
  test('computeAxisInterval reads the unshaped key band (¥ magnitude axis)', () => {
    expect(computeAxisInterval({ is_residual: false, axis_key: '400b_plus' }))
      .toEqual({ lo: 4e11, hi: Number.POSITIVE_INFINITY, dim: 'mag' });
    expect(computeAxisInterval({ is_residual: false, axis_key: 'lt_1t' }))
      .toEqual({ lo: Number.NEGATIVE_INFINITY, hi: 1e12, dim: 'mag' });
    // residual / rank-encoding / rank-unit slots are ineligible → null.
    expect(computeAxisInterval({ is_residual: true, axis_key: '400b_plus' })).toBeNull();
    expect(computeAxisInterval({ is_residual: false, axis_key: 'chelsea', event_kind: 'championship_winner' })).toBeNull();
    expect(computeAxisInterval({ is_residual: false, axis_key: '1t_1.5t', value_unit: 'rank' })).toBeNull();
  });

  test('hasValueAxisOverlap: ≥400B ∩ <1T is a co-YES region → TRUE', () => {
    expect(hasValueAxisOverlap([bandSlot('400b_plus'), bandSlot('lt_1t')])).toBe(true);
    // subject-INcompatible slots (distinct known subjects) are not compared.
    expect(hasValueAxisOverlap([
      slot({ outcome_id: 'a', canonical_subject: 'Alpha Corp', axis_interval: computeAxisInterval({ is_residual: false, axis_key: '400b_plus' }) }),
      slot({ outcome_id: 'b', canonical_subject: 'Beta Corp', axis_interval: computeAxisInterval({ is_residual: false, axis_key: 'lt_1t' }) }),
    ])).toBe(false);
  });

  test('classifySet: 16 unshaped overlapping band slots → NULL (no set, Belt V fires)', () => {
    const slots = [
      bandSlot('lt_1t'), bandSlot('1t_1.5t'), bandSlot('1.5t_2t'), bandSlot('2t_2.5t'),
      bandSlot('2.5t_3t'), bandSlot('3t_3.5t'), bandSlot('3.5t_4t'), bandSlot('ge_4t'),
      bandSlot('250_280b'), bandSlot('280_310b'), bandSlot('310_340b'), bandSlot('340_370b'),
      bandSlot('370_400b'), bandSlot('400b_plus'), bandSlot('lt_250b'),
      bandSlot('no_ipo', true), // residual rides into the freed pool
    ];
    expect(classifySet(slots, sig({ groupedAs: 'categorical' }))).toBeNull();
  });

  test('classifySet: PM billion bins ONLY (pairwise disjoint) → keeps the Σ≤1 mutex', () => {
    // the same set with the overlapping trillion groups removed — disjoint bands
    // (adjacent boundaries touch, never overlap) keep their categorical mutex.
    const slots = [
      bandSlot('lt_250b'), bandSlot('250_280b'), bandSlot('280_310b'),
      bandSlot('310_340b'), bandSlot('340_370b'), bandSlot('370_400b'), bandSlot('400b_plus'),
    ];
    expect(classifySet(slots, sig({ groupedAs: 'categorical' }))).toEqual({ setType: 'categorical', isExhaustive: false });
  });
});

// open-race residual gate

describe('F3 — open-race residual gate (set 1097 "first AI to hit 1550")', () => {
  // 8 unshaped Kalshi slots (Qwen/Other/Kimi/Grok/Gemini/Ernie/Claude/ChatGPT); no
  // negRisk (Kalshi), no values (no tiling), kinds NULL (vacuously homogeneous). The
  // ONLY Σ=1 signal is the present 'Other' residual.
  const raceSlots = (): CertifierSlot[] => [
    ...['qwen', 'kimi', 'grok', 'gemini', 'ernie', 'claude', 'chatgpt'].map((n) =>
      slot({ outcome_id: n, display_label: n })),
    slot({ outcome_id: 'other', display_label: 'Other', is_residual: true }),
  ];

  test('openRaceFold=true → residual Σ=1 arm suppressed → Σ≤1 (mutex retained)', () => {
    const v = classifySet(raceSlots(), sig({ groupedAs: 'categorical', kindHomogeneous: true, openRaceFold: true }));
    expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
  });

  test('openRaceFold=false → identical input keeps Σ=1 (pins the gate as the sole delta)', () => {
    const v = classifySet(raceSlots(), sig({ groupedAs: 'categorical', kindHomogeneous: true, openRaceFold: false }));
    expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
  });

  test('a NEGRISK fixture set is unaffected by openRaceFold (race kinds are never fixtures)', () => {
    // the gate only touches the residual arm; a 1X2 negRisk fixture stays Σ=1.
    const v = classifySet([
      slot({ display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ display_label: 'Draw', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ display_label: 'Away', has_negrisk: true, event_kind: 'match_winner' }),
    ], sig({ groupedAs: 'categorical', kindHomogeneous: true, openRaceFold: true }));
    expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
  });
});

describe('BELT V — exemptions (weather tiling + rank encoding)', () => {
  test('weather union-of-grids with overlapping gated intervals is EXEMPT → Σ=1 kept', () => {
    // between-dominated contiguous grid + an above closer that OVERLAPS the top bucket:
    // hasValueAxisOverlap would flag it, but isSoundNumericTiling exempts it.
    const cs = { canonical_subject: 'Ankara highest temperature' };
    const g = (over: Partial<CertifierSlot>): CertifierSlot =>
      slot({ ...over, axis_interval: computeAxisInterval({ is_residual: false, direction: over.direction, value_primary: over.value_primary, value_secondary: over.value_secondary }) });
    const slots = [
      g({ ...cs, direction: 'below', value_primary: 78 }),
      g({ ...cs, direction: 'between', value_primary: 78, value_secondary: 80 }),
      g({ ...cs, direction: 'between', value_primary: 79, value_secondary: 81 }),
      g({ ...cs, direction: 'between', value_primary: 80, value_secondary: 82 }),
      g({ ...cs, direction: 'between', value_primary: 81, value_secondary: 83 }),
      g({ ...cs, direction: 'above', value_primary: 82 }),
    ];
    // proves the overlap really exists (above-82 ∩ [81,83]) yet the set survives.
    expect(hasValueAxisOverlap(slots)).toBe(true);
    expect(classifySet(slots, sig({ groupedAs: 'categorical' }))).toEqual({ setType: 'categorical', isExhaustive: true });
  });

  test('rank-encoding winner set (below/1/rank distinct subjects) → Belt V inert', () => {
    // MLS-Cup-champion shape: winner markets stamped below/1/rank per candidate; the
    // event_kind + value_unit gates leave every axis_interval null → Belt V never fires.
    const mk = (label: string): CertifierSlot =>
      slot({ outcome_id: label.toLowerCase(), display_label: label, canonical_subject: label, has_negrisk: true, event_kind: 'championship_winner',
        axis_interval: computeAxisInterval({ is_residual: false, event_kind: 'championship_winner', value_unit: 'rank', direction: 'below', value_primary: 1, axis_key: label.toLowerCase() }) });
    const slots = [mk('Inter Miami'), mk('LA Galaxy'), mk('Seattle'), slot({ display_label: 'Other', is_residual: true, has_negrisk: true, event_kind: 'championship_winner' })];
    // every interval is null (ineligible), so the belt is inert; the set is unchanged.
    expect(hasValueAxisOverlap(slots)).toBe(false);
    const v = classifySet(slots, sig({ groupedAs: 'categorical', kindHomogeneous: true }));
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });
});

// mixesConfederationAndCountry

test('CONFEDERATION_SUBJECTS contains continents + acronyms', () => {
  for (const t of ['africa', 'south america', 'europe', 'uefa', 'conmebol', 'concacaf', 'caf', 'afc']) {
    expect(CONFEDERATION_SUBJECTS.has(t)).toBe(true);
  }
});

test('mixesConfederationAndCountry: confederation + country mix -> TRUE', () => {
  expect(mixesConfederationAndCountry([
    { display_label: 'South America', is_residual: false },
    { display_label: 'Brazil', is_residual: false },
    { display_label: 'Argentina', is_residual: false },
  ])).toBe(true);
});

test('mixesConfederationAndCountry: all-country (no confederation) -> FALSE', () => {
  expect(mixesConfederationAndCountry([
    { display_label: 'Brazil', is_residual: false },
    { display_label: 'France', is_residual: false },
  ])).toBe(false);
});

test('mixesConfederationAndCountry: confederation-only (continent set) -> FALSE', () => {
  expect(mixesConfederationAndCountry([
    { display_label: 'Africa', is_residual: false },
    { display_label: 'Europe', is_residual: false },
    { display_label: 'Asia', is_residual: false },
  ])).toBe(false);
});

test('mixesConfederationAndCountry: residual slot does not count as a country', () => {
  expect(mixesConfederationAndCountry([
    { display_label: 'Africa', is_residual: false },
    { display_label: 'Other', is_residual: true },
  ])).toBe(false);
});

test('mixesConfederationAndCountry: colon-leak title-subject still trips it', () => {
  expect(mixesConfederationAndCountry([
    { display_label: 'Which continent will win the 2026 World Cup?: Africa', is_residual: false },
    { display_label: 'Brazil', is_residual: false },
  ])).toBe(true);
});

// classifySet: the unified 4-class decision

const slot = (o: Partial<CertifierSlot>): CertifierSlot => ({
  outcome_id: o.outcome_id ?? Math.random().toString(36).slice(2),
  display_label: o.display_label ?? null,
  canonical_subject: o.canonical_subject ?? null,
  is_residual: o.is_residual ?? false,
  market_ids: o.market_ids ?? [Math.floor(Math.random() * 1e6)],
  direction: o.direction ?? null,
  value_primary: o.value_primary ?? null,
  value_secondary: o.value_secondary ?? null,
  value_unit: o.value_unit ?? null,
  condition_metric: o.condition_metric,
  event_kind: o.event_kind ?? null,
  is_multiyes: o.is_multiyes ?? false,
  has_negrisk: o.has_negrisk ?? false,
  native_independent: o.native_independent,
  platforms: o.platforms,
  mutex_cardinality: o.mutex_cardinality,
  subject_type: o.subject_type,
  axis_interval: o.axis_interval,
  is_kalshi_custom_score: o.is_kalshi_custom_score,
  settlement_dimensions: o.settlement_dimensions,
  disc: o.disc,
});
const sig = (o: Partial<CertifierSignals>): CertifierSignals => ({
  groupedAs: o.groupedAs ?? 'categorical',
  kindHomogeneous: o.kindHomogeneous ?? true,
  allBoundChildrenMapped: o.allBoundChildrenMapped ?? true,
  openRaceFold: o.openRaceFold ?? false,
});

test('classifySet: clean homogeneous above-ladder -> threshold_series exhaustive', () => {
  const v = classifySet([
    slot({ direction: 'above', value_primary: 100, value_unit: 'usd', event_kind: 'price_threshold' }),
    slot({ direction: 'above', value_primary: 110, value_unit: 'usd', event_kind: 'price_threshold' }),
    slot({ direction: 'above', value_primary: 120, value_unit: 'usd', event_kind: 'price_threshold' }),
  ], sig({ groupedAs: 'threshold_series' }));
  expect(v).toEqual({ setType: 'threshold_series', isExhaustive: true });
});

test('classifySet: between tiling -> categorical exhaustive Sigma=1', () => {
  const v = classifySet([
    slot({ direction: 'between', value_primary: 0, value_secondary: 10 }),
    slot({ direction: 'between', value_primary: 10, value_secondary: 20 }),
    slot({ direction: 'between', value_primary: 20, value_secondary: 30 }),
  ], sig({ groupedAs: 'threshold_series' }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

test('classifySet: gapped disjoint half-line grid -> categorical mutex Sigma<=1', () => {
  // below-10 + above-30 are pairwise-disjoint (mutex) but leave a GAP on (10,30], so the
  // tiling certifier (nBetween===0) refuses Sigma=1 and the mutex branch fires Sigma<=1.
  const v = classifySet([
    slot({ direction: 'below', value_primary: 10, value_unit: 'usd' }),
    slot({ direction: 'above', value_primary: 30, value_unit: 'usd' }),
  ], sig({ groupedAs: 'threshold_series' }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: contiguous below/between/above grid tiles the line -> Sigma=1 (exhaustive)', () => {
  // below-10 + [10,20] + above-20 covers (-Inf,Inf) with no gap -> a real exactly-one
  // partition (Sigma=1), certified by isSoundNumericTiling, not the mutex branch.
  const v = classifySet([
    slot({ direction: 'below', value_primary: 10, value_unit: 'usd' }),
    slot({ direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd' }),
    slot({ direction: 'above', value_primary: 20, value_unit: 'usd' }),
  ], sig({ groupedAs: 'threshold_series' }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

// independent-bundle refusal
describe('F7 — refusesNativeIndependentBundle + classifySet independent-bundle refusal', () => {
  const ladder = (slots: readonly CertifierSlot[]) =>
    slots.map((s) => ({
      direction: s.direction, value_primary: s.value_primary,
      value_secondary: s.value_secondary, value_unit: s.value_unit,
      event_kind: s.event_kind, condition_shape: s.condition_shape, folded_participants: s.folded_participants,
    }));

  // An acquisitions bundle ({X acquired, Y acquired, Z acquired}), each market
  // natively non-mutually-exclusive (Kalshi mutually_exclusive='false'),
  // no negRisk, no fixture kind, no numeric value.
  const acqBundle = (over: Partial<CertifierSlot> = {}): CertifierSlot[] => [
    slot({ outcome_id: 'x_acquired', display_label: 'X acquired', native_independent: true, ...over }),
    slot({ outcome_id: 'y_acquired', display_label: 'Y acquired', native_independent: true, ...over }),
    slot({ outcome_id: 'z_acquired', display_label: 'Z acquired', native_independent: true, ...over }),
  ];

  test('predicate: ≥2 real slots + a native-independent slot + no mutex authority → TRUE', () => {
    const s = acqBundle();
    expect(refusesNativeIndependentBundle(s, ladder(s))).toBe(true);
  });

  test('classifySet: independent bundle → NO set (slots fall back to free questions)', () => {
    expect(classifySet(acqBundle(), sig({ groupedAs: 'categorical', kindHomogeneous: true }))).toBeNull();
  });

  test('REGRESSION: a fixture one-hot (event_kind ∈ ONE_HOT) is NEVER refused even if a leg is flagged', () => {
    // A 1X2 whose child somehow carries a stray native_independent flag still mints —
    // the ONE_HOT fixture kind is positive mutex authority (condition 3b).
    const oneX2 = [
      slot({ outcome_id: 'home', display_label: 'Home', event_kind: 'match_winner', has_negrisk: true, native_independent: true }),
      slot({ outcome_id: 'draw', display_label: 'Draw', event_kind: 'match_winner', has_negrisk: true, native_independent: true }),
      slot({ outcome_id: 'away', display_label: 'Away', event_kind: 'match_winner', has_negrisk: true, native_independent: true }),
    ];
    expect(refusesNativeIndependentBundle(oneX2, ladder(oneX2))).toBe(false);
    expect(classifySet(oneX2, sig({ groupedAs: 'categorical', kindHomogeneous: true })))
      .toEqual({ setType: 'categorical', isExhaustive: true });
  });

  test('REGRESSION: an on-chain negRisk field is NEVER refused (positive mutex authority)', () => {
    // A contested-target set the platform proves mutex (mutually_exclusive='true' → the
    // native_independent flag is FALSE) OR that carries negRisk mints identically. Here a
    // negRisk championship set with NO independence flag is untouched.
    const champ = [
      slot({ outcome_id: 'a', display_label: 'A', event_kind: 'championship_winner', has_negrisk: true }),
      slot({ outcome_id: 'b', display_label: 'B', event_kind: 'championship_winner', has_negrisk: true }),
      slot({ outcome_id: 'other', display_label: 'Other', is_residual: true, has_negrisk: true, event_kind: 'championship_winner' }),
    ];
    expect(refusesNativeIndependentBundle(champ, ladder(champ))).toBe(false);
    // (also: even WITH a stray flag, has_negrisk keeps it sound)
    const champFlagged = champ.map((s) => ({ ...s, native_independent: true }));
    expect(refusesNativeIndependentBundle(champFlagged, ladder(champFlagged))).toBe(false);
  });

  test('REGRESSION: a sound numeric tiling with a flagged leg is INERT (tiling = authority)', () => {
    // A contiguous below/between/above tiling (Σ=1) with a stray flag still certifies —
    // isSoundNumericTiling is positive authority (condition 3c).
    const tiling = [
      slot({ direction: 'below', value_primary: 10, value_unit: 'usd', native_independent: true }),
      slot({ direction: 'between', value_primary: 10, value_secondary: 20, value_unit: 'usd', native_independent: true }),
      slot({ direction: 'above', value_primary: 20, value_unit: 'usd', native_independent: true }),
    ];
    expect(refusesNativeIndependentBundle(tiling, ladder(tiling))).toBe(false);
    expect(classifySet(tiling, sig({ groupedAs: 'threshold_series' })))
      .toEqual({ setType: 'categorical', isExhaustive: true });
  });

  test('REGRESSION: no independence signal → NEVER refused (subtractive-safe on cap-unknown)', () => {
    // A plain 2-way categorical with no native flag and no authority: untouched by F7
    // (it may still be Σ≤1 via the mutex branch, but F7 does not fire).
    const plain = [
      slot({ outcome_id: 'a', display_label: 'A' }),
      slot({ outcome_id: 'b', display_label: 'B' }),
    ];
    expect(refusesNativeIndependentBundle(plain, ladder(plain))).toBe(false);
  });

  test('predicate: <2 non-residual slots → never refused (one real + residual)', () => {
    const s = [
      slot({ outcome_id: 'x', display_label: 'X acquired', native_independent: true }),
      slot({ outcome_id: 'other', display_label: 'Other', is_residual: true, native_independent: true }),
    ];
    expect(refusesNativeIndependentBundle(s, ladder(s))).toBe(false);
  });
});

// custom-strike KX%SCORE Σ=1 demote
describe('exact-score root fix — hasKalshiCustomExactScore + classifySet demote', () => {
  // A genuine fixture 1X2 (home/draw/away, on-chain negRisk mutex) — the SOUND
  // survivor: it must STAY exhaustive Σ=1 when no member is a custom exact score.
  const oneX2 = (over: Partial<CertifierSlot> = {}): CertifierSlot[] => [
    slot({ outcome_id: 'home_win', display_label: 'Home', event_kind: 'match_winner', has_negrisk: true, ...over }),
    slot({ outcome_id: 'draw', display_label: 'Draw', event_kind: 'match_winner', has_negrisk: true, ...over }),
    slot({ outcome_id: 'away_win', display_label: 'Away', event_kind: 'match_winner', has_negrisk: true, ...over }),
  ];

  test('hasKalshiCustomExactScore: TRUE only when a NON-residual slot carries the raw flag', () => {
    expect(hasKalshiCustomExactScore(oneX2())).toBe(false);
    expect(hasKalshiCustomExactScore(oneX2({ is_kalshi_custom_score: true }))).toBe(true);
    // a residual-only carrier never trips it (a residual asserts no identity)
    expect(hasKalshiCustomExactScore([
      slot({ display_label: 'Home', event_kind: 'match_winner', has_negrisk: true }),
      slot({ display_label: 'Other', is_residual: true, is_kalshi_custom_score: true }),
    ])).toBe(false);
  });

  test('SOUND SURVIVOR: a genuine 1X2 winner set stays exhaustive Σ=1', () => {
    expect(classifySet(oneX2(), sig({ groupedAs: 'categorical', kindHomogeneous: true })))
      .toEqual({ setType: 'categorical', isExhaustive: true });
  });

  test('REFUSAL: the SAME 1X2 with custom-score members → demoted to Σ≤1 (SE 16224 masquerade)', () => {
    // Correct-score children winner-projected onto the win/draw nodes carry the raw
    // strike_type=custom KX%SCORE signal → the set is a correct-score grid, never Σ=1.
    expect(classifySet(oneX2({ is_kalshi_custom_score: true }), sig({ groupedAs: 'categorical', kindHomogeneous: true })))
      .toEqual({ setType: 'categorical', isExhaustive: false });
  });

  test('REFUSAL survives a real between-tiling Σ=1 too (demote applies to every exhaustive verdict)', () => {
    const tiling = [
      slot({ direction: 'between', value_primary: 0, value_secondary: 10, is_kalshi_custom_score: true }),
      slot({ direction: 'between', value_primary: 10, value_secondary: 20, is_kalshi_custom_score: true }),
      slot({ direction: 'between', value_primary: 20, value_secondary: 30, is_kalshi_custom_score: true }),
    ];
    expect(classifySet(tiling, sig({ groupedAs: 'threshold_series' })))
      .toEqual({ setType: 'categorical', isExhaustive: false });
  });
});

test('classifySet: threshold fold with all-NULL values -> null (free questions)', () => {
  const v = classifySet([
    slot({ direction: null, value_primary: null }),
    slot({ direction: null, value_primary: null }),
  ], sig({ groupedAs: 'threshold_series' }));
  expect(v).toBeNull();
});

test('classifySet: <2 slots -> null', () => {
  expect(classifySet([slot({})], sig({}))).toBeNull();
});

test('classifySet: heterogeneous (>=2 event_kind) negRisk fixture fold -> NOT exhaustive (AUD-01)', () => {
  const v = classifySet([
    slot({ display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
    slot({ display_label: 'Away', has_negrisk: true, event_kind: 'exact_score' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: false }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: sound negRisk FIXTURE set (kind-homogeneous) stays Sigma=1', () => {
  const v = classifySet([
    slot({ display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
    slot({ display_label: 'Draw', has_negrisk: true, event_kind: 'match_winner' }),
    slot({ display_label: 'Away', has_negrisk: true, event_kind: 'match_winner' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

test('classifySet: negRisk OPEN field (no fixture kind) -> Sigma<=1 (M-SOUND-1 held)', () => {
  const v = classifySet([
    slot({ display_label: 'Cunningham', has_negrisk: true, event_kind: 'championship_winner' }),
    slot({ display_label: 'Edwards', has_negrisk: true, event_kind: 'championship_winner' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: confederation+country mix -> Sigma<=1 (PL-PREDICT-01)', () => {
  const v = classifySet([
    slot({ display_label: 'South America', has_negrisk: true, event_kind: 'championship_winner' }),
    slot({ display_label: 'Brazil', has_negrisk: true, event_kind: 'championship_winner' }),
    slot({ display_label: 'Other', is_residual: true, has_negrisk: true, event_kind: 'championship_winner' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: orphan bound child (allBoundChildrenMapped=false) -> Sigma<=1', () => {
  const v = classifySet([
    slot({ display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
    slot({ display_label: 'Away', has_negrisk: true, event_kind: 'match_winner' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true, allBoundChildrenMapped: false }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: multi-YES fold overrides everything -> Sigma<=1', () => {
  const v = classifySet([
    slot({ display_label: 'A', has_negrisk: true, event_kind: 'match_winner', is_multiyes: true }),
    slot({ display_label: 'B', has_negrisk: true, event_kind: 'match_winner' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet: weather union-of-grids tiling under categorical -> Sigma=1 (KEEP)', () => {
  const slots = [
    slot({ direction: 'below', value_primary: 43 }),
    slot({ direction: 'below', value_primary: 47 }),
    slot({ direction: 'between', value_primary: 43, value_secondary: 45 }),
    slot({ direction: 'between', value_primary: 44, value_secondary: 46 }),
    slot({ direction: 'between', value_primary: 45, value_secondary: 47 }),
    slot({ direction: 'between', value_primary: 46, value_secondary: 48 }),
    slot({ direction: 'above', value_primary: 47 }),
  ];
  const v = classifySet(slots, sig({ groupedAs: 'categorical' }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

test('classifySet: union double-map (two slots share a subject) -> Sigma<=1', () => {
  const v = classifySet([
    slot({ outcome_id: 'a', display_label: 'FK Teplice', has_negrisk: true, event_kind: 'match_winner', market_ids: [1] }),
    slot({ outcome_id: 'b', display_label: 'fk teplice', has_negrisk: true, event_kind: 'match_winner', market_ids: [2] }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

// kind-homogeneity gates all three Sigma=1 arms

/** 16 exact-score slots 0-0..3-3 (direction NULL, value_primary/secondary =
 * home/away goals, PM negRisk). */
const exactGrid = (over: Partial<CertifierSlot> = {}): CertifierSlot[] => {
  const out: CertifierSlot[] = [];
  for (let h = 0; h <= 3; h++) {
    for (let a = 0; a <= 3; a++) {
      out.push(slot({
        outcome_id: `exact_${h}_${a}`,
        display_label: `Exact Score: ${h}-${a}`,
        direction: null,
        value_primary: h,
        value_secondary: a,
        event_kind: 'exact_score',
        has_negrisk: true,
        ...over,
      }));
    }
  }
  return out;
};

test('classifySet F7 (live set 924): hetero 1X2 + exact-score fold → NO SET (R-mech3 grain backstop refuses the cross-grain mutex)', () => {
  // 3 match_winner negRisk slots + 16 NULL-direction exact slots: 'home wins'
  // (winner) and 'exact 2-0' (exact_score) co-occur, so even a Σ≤1 mutex over
  // them is a false assertion. The grain backstop refuses the whole fold
  // outright → null (free questions).
  const slots = [
    slot({ outcome_id: 'home', display_label: 'Silkeborg IF', event_kind: 'match_winner', has_negrisk: true }),
    slot({ outcome_id: 'draw', display_label: 'Draw', event_kind: 'match_winner', has_negrisk: true }),
    slot({ outcome_id: 'away', display_label: 'FC København', event_kind: 'match_winner', has_negrisk: true }),
    ...exactGrid(),
  ];
  const v = classifySet(slots, sig({ groupedAs: 'categorical', kindHomogeneous: false }));
  expect(v).toBeNull();
});

test('classifySet F7: the residual Sigma=1 arm is gated on kind-homogeneity too', () => {
  // An 'exact_other' residual proves exhaustivity ONLY for its own kind partition —
  // a hetero fold with a residual slot must stay Sigma<=1.
  const v = classifySet([
    slot({ display_label: 'Team A wins by 2+', event_kind: 'match_spread', value_primary: 2.5 }),
    slot({ display_label: 'Over 2.5 goals', event_kind: 'match_total_metric', value_primary: 2.5 }),
    slot({ display_label: null, is_residual: true, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact 1-0', event_kind: 'exact_score', value_primary: 1, value_secondary: 0 }),
    slot({ display_label: 'Exact 2-0', event_kind: 'exact_score', value_primary: 2, value_secondary: 0 }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: false }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

// categorical grain-homogeneity backstop
// KEY-ONLY (reads outcome_id, not subject/label): correct on feed-A semantic keys,
// inert on feed-B numeric ids. The finalize feed-A partition splits before this runs,
// so this is defense-in-depth (the categorical analog of isNestedLadder's participant
// gate) — a multi-grain categorical is not a mutex at all, so NO set is emitted.
describe('R-mech3 grain backstop', () => {
  test('cross-grain categorical (winner + over_under keys) → null (no cross-grain mutex)', () => {
    const v = classifySet([
      slot({ outcome_id: 'argentina_wins', display_label: 'Argentina', has_negrisk: true }),
      slot({ outcome_id: 'switzerland_wins', display_label: 'Switzerland', has_negrisk: true }),
      slot({ outcome_id: 'argentina_over_0.5', display_label: 'Argentina over 0.5' }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).toBeNull();
  });

  test('exhaustivity cannot survive: a Σ=1-shaped fold that spans grains is refused, not stamped Σ=1', () => {
    // negRisk 1X2 + residual would be Σ=1 on its own; adding an over/under-keyed leg makes
    // it cross-grain → the backstop refuses it outright (Σ=1 provably cannot survive).
    const v = classifySet([
      slot({ outcome_id: 'home_wins', display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ outcome_id: 'away_wins', display_label: 'Away', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ outcome_id: 'draw', display_label: 'Draw', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ outcome_id: 'home_over_1.5', display_label: 'Home over 1.5', has_negrisk: true }),
      slot({ outcome_id: 'the_field', display_label: 'Any other', is_residual: true }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).toBeNull();
  });

  test('single-grain election categorical (all winner keys) UNCHANGED — backstop inert', () => {
    const v = classifySet([
      slot({ outcome_id: 'democrat', display_label: 'Democrat' }),
      slot({ outcome_id: 'republican', display_label: 'Republican' }),
      slot({ outcome_id: 'other', display_label: 'Someone else', is_residual: true }),
    ], sig({ groupedAs: 'categorical' }));
    // still a valid mutex (non-null); the backstop did NOT fire on a single-grain set
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });

  test('feed-B numeric outcome_ids stay INERT even when subjects look score-like', () => {
    // native platform sets carry bare market_ids as outcome_id; the score/date text
    // lives only in the (ignored) subject → key-only classification = all winner →
    // the belt never fires (protects the 951 sound weather/1X2 native Σ=1 sets).
    const v = classifySet([
      slot({ outcome_id: '16713', display_label: 'Will Team A win on 2026-05-17?', event_kind: 'match_winner', has_negrisk: true }),
      slot({ outcome_id: '16714', display_label: 'Will Team B win on 2026-05-17?', event_kind: 'match_winner', has_negrisk: true }),
      slot({ outcome_id: '16715', display_label: 'Will the match end in a draw?', event_kind: 'match_winner', has_negrisk: true }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).not.toBeNull(); // NOT refused — the native mutex survives
  });
});

test('classifySet F7 (branch A, live set 869): threshold-grouped exact-score grid -> NO set (the bogus tiling is dead)', () => {
  // The metric partition can isolate exact slots in a threshold sub-group; a
  // NULL-direction fallback must not certify them a Sigma=1 "tiling" while the
  // 'Any Other Score' residual sits in another sub-group.
  // Not a ladder (NULL dir), not a tiling (fixture slots excluded), not a
  // pairwise interval mutex (NULL dir unmappable) -> null (free questions).
  const v = classifySet(exactGrid(), sig({ groupedAs: 'threshold_series', kindHomogeneous: true }));
  expect(v).toBeNull();
});

test('classifySet F7: genuine between tiling is UNAFFECTED by the new gates (kind-homogeneous)', () => {
  const v = classifySet([
    slot({ direction: 'between', value_primary: 0, value_secondary: 10, event_kind: 'weather_threshold' }),
    slot({ direction: 'between', value_primary: 10, value_secondary: 20, event_kind: 'weather_threshold' }),
    slot({ direction: 'between', value_primary: 20, value_secondary: 30, event_kind: 'weather_threshold' }),
  ], sig({ groupedAs: 'threshold_series', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

// exact-score grids need an in-set residual for Sigma=1

test('classifySet F7b: pure exact-score negRisk grid WITHOUT residual -> Sigma<=1 (belt)', () => {
  // Listed scorelines can leave higher-goal worlds uncovered: negRisk proves
  // mutex among the listed outcomes, never coverage.
  const v = classifySet(exactGrid(), sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet F7b: pure exact-score negRisk grid WITH in-set residual -> Sigma=1 stays (the ~820 feed-B PM sets)', () => {
  const v = classifySet([
    ...exactGrid(),
    slot({ outcome_id: 'exact_other', display_label: null, is_residual: true, event_kind: 'exact_score', has_negrisk: true }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

// Nested-cumulative belt

/** The live set 3880 shape: 5 PM negRisk 'at least N' Tomatometer rungs. */
const rtRung = (v: number): CertifierSlot =>
  slot({
    outcome_id: `rt_${v}`,
    display_label: String(v), // groupItemTitle bucket label — distinct per slot
    canonical_subject: 'How to Make a Killing',
    direction: 'above',
    value_primary: v,
    event_kind: 'media_release',
    has_negrisk: true,
  });

test('hasNestedCumulativeRungs: same-subject above rungs with distinct values -> TRUE', () => {
  expect(hasNestedCumulativeRungs([56, 57, 58, 59, 60].map(rtRung))).toBe(true);
});

test('hasNestedCumulativeRungs: direction at (exactly-N buckets) never triggers', () => {
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: 'Bank of Canada', direction: 'at', value_primary: 25 }),
    slot({ canonical_subject: 'Bank of Canada', direction: 'at', value_primary: 50 }),
  ])).toBe(false);
});

test('hasNestedCumulativeRungs: NULL subject / NULL value / distinct subjects / distinct units never trigger', () => {
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: null, direction: 'above', value_primary: 56 }),
    slot({ canonical_subject: null, direction: 'above', value_primary: 57 }),
  ])).toBe(false);
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: 'X', direction: 'above', value_primary: null }),
    slot({ canonical_subject: 'X', direction: 'above', value_primary: 57 }),
  ])).toBe(false);
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: 'Team A', direction: 'above', value_primary: 20 }),
    slot({ canonical_subject: 'Team B', direction: 'above', value_primary: 30 }),
  ])).toBe(false);
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: 'X', direction: 'above', value_primary: 56, value_unit: 'usd' }),
    slot({ canonical_subject: 'X', direction: 'above', value_primary: 57, value_unit: 'percent' }),
  ])).toBe(false);
});

test('hasNestedCumulativeRungs: opposite half-lines (above vs below) do not trigger', () => {
  expect(hasNestedCumulativeRungs([
    slot({ canonical_subject: 'X', direction: 'below', value_primary: 10 }),
    slot({ canonical_subject: 'X', direction: 'above', value_primary: 30 }),
  ])).toBe(false);
});

test('classifySet belt (live set 3880): categorical negRisk cumulative rungs -> RE-TYPE to threshold_series', () => {
  const v = classifySet([56, 57, 58, 59, 60].map(rtRung), sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'threshold_series', isExhaustive: true });
});

test('classifySet belt: cumulative pair inside a broader categorical fold -> NO set (demote to bundle)', () => {
  // Not a clean whole-set ladder (a third subject rides along) — never assert
  // mutex over the co-true rungs; free ALL slots.
  const v = classifySet([
    rtRung(56),
    rtRung(57),
    slot({ canonical_subject: 'Something Else', direction: 'at', value_primary: 1, event_kind: 'media_release' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toBeNull();
});

test('classifySet belt: cumulative rungs + residual slot -> NO set (residual cannot ride a ladder)', () => {
  const v = classifySet([
    rtRung(56),
    rtRung(57),
    slot({ canonical_subject: null, is_residual: true, event_kind: 'media_release', has_negrisk: true }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toBeNull();
});

test('classifySet belt: exactly-N "at" race stays a categorical (no false catch)', () => {
  const v = classifySet([
    slot({ canonical_subject: 'Bank of Canada', direction: 'at', value_primary: 25, event_kind: 'policy_action' }),
    slot({ canonical_subject: 'Bank of Canada', direction: 'at', value_primary: 50, event_kind: 'policy_action' }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet belt: weather union-of-grids (between-dominated tiling, 2 below closers) is EXEMPT -> Sigma=1 kept', () => {
  // isSoundNumericTiling tolerates a union of two strike grids (below + above
  // closers with overlapping betweens).
  const cs = { canonical_subject: 'NYC lowest temperature' };
  const slots = [
    slot({ ...cs, direction: 'below', value_primary: 43 }),
    slot({ ...cs, direction: 'below', value_primary: 47 }),
    slot({ ...cs, direction: 'between', value_primary: 43, value_secondary: 45 }),
    slot({ ...cs, direction: 'between', value_primary: 44, value_secondary: 46 }),
    slot({ ...cs, direction: 'between', value_primary: 45, value_secondary: 47 }),
    slot({ ...cs, direction: 'between', value_primary: 46, value_secondary: 48 }),
    slot({ ...cs, direction: 'above', value_primary: 47 }),
  ];
  const v = classifySet(slots, sig({ groupedAs: 'categorical' }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

// partitionHeteroCategoricalByKind

test('partitionHetero: kind-homogeneous fold -> null (unpartitioned path)', () => {
  expect(partitionHeteroCategoricalByKind([
    slot({ display_label: 'Home', event_kind: 'match_winner' }),
    slot({ display_label: 'Away', event_kind: 'match_winner' }),
  ])).toBeNull();
  // all-NULL kinds are homogeneous too (open candidate fields stay one set)
  expect(partitionHeteroCategoricalByKind([
    slot({ display_label: 'Alice', event_kind: null }),
    slot({ display_label: 'Bob', event_kind: null }),
  ])).toBeNull();
  // one non-null kind + NULL riders is still homogeneous (current semantics kept)
  expect(partitionHeteroCategoricalByKind([
    slot({ display_label: 'Home', event_kind: 'match_winner' }),
    slot({ display_label: 'Away', event_kind: 'match_winner' }),
    slot({ display_label: 'Mystery', event_kind: null }),
  ])).toBeNull();
});

test('partitionHetero: SET_INERT kinds count as NULL — zero-flip fill of a mixed set (TASK C / DW-41)', () => {
  // policy_action count buckets folded with Kalshi "cut >=N times" rungs.
  // Filling the rungs with the INERT econ_indicator_threshold must not flip
  // the fold to the hetero-split path — the certifier must see it exactly as
  // it did when the rungs were NULL.
  const withNull = [
    slot({ display_label: '0 (0 bps)', event_kind: 'policy_action' }),
    slot({ display_label: '1 (25 bps)', event_kind: 'policy_action' }),
    slot({ display_label: 'Cut 12 times', event_kind: null }),
    slot({ display_label: 'Cut 13 times', event_kind: null }),
  ];
  const withInert = [
    slot({ display_label: '0 (0 bps)', event_kind: 'policy_action' }),
    slot({ display_label: '1 (25 bps)', event_kind: 'policy_action' }),
    slot({ display_label: 'Cut 12 times', event_kind: 'econ_indicator_threshold' }),
    slot({ display_label: 'Cut 13 times', event_kind: 'econ_indicator_threshold' }),
  ];
  expect(partitionHeteroCategoricalByKind(withNull)).toBeNull();
  expect(partitionHeteroCategoricalByKind(withInert)).toBeNull(); // ← same verdict = zero-flip
  // an all-inert fold is homogeneous too (behaves like all-NULL)
  expect(partitionHeteroCategoricalByKind([
    slot({ display_label: 'A', event_kind: 'econ_indicator_threshold' }),
    slot({ display_label: 'B', event_kind: 'count_threshold' }),
  ])).toBeNull();
});

test('partitionHetero (live set 924 shape): winner trio + clean exact grid -> 2 mutex partitions, residual rides with exact', () => {
  const winner = [
    slot({ outcome_id: 'home', display_label: 'Silkeborg IF', event_kind: 'match_winner' }),
    slot({ outcome_id: 'draw', display_label: 'Draw', event_kind: 'match_winner' }),
    slot({ outcome_id: 'away', display_label: 'FC København', event_kind: 'match_winner' }),
  ];
  const exact = exactGrid();
  const residual = slot({ outcome_id: 'exact_other', display_label: null, is_residual: true, event_kind: 'exact_score' });
  const r = partitionHeteroCategoricalByKind([...winner, ...exact, residual]);
  expect(r).not.toBeNull();
  expect(r!.mutexGroups.length).toBe(2);
  expect(r!.freedSlots.length).toBe(0);
  expect(r!.mutexGroups[0].map((s) => s.outcome_id)).toEqual(['home', 'draw', 'away']);
  // the exact partition keeps its own residual (exact_other belongs to the grid)
  expect(r!.mutexGroups[1].map((s) => s.outcome_id)).toContain('exact_other');
  expect(r!.mutexGroups[1].length).toBe(17);
});

test('partitionHetero (live set 58 shape): label-drift winner group + fused-twice exact grid + co-occurrable kinds -> everything freed', () => {
  const slots = [
    // 7-slot winner group with cross-platform label drift (dups of the same outcome)
    slot({ display_label: 'Aston Villa', event_kind: 'match_winner' }),
    slot({ display_label: 'Aston Villa FC wins', event_kind: 'match_winner' }),
    slot({ display_label: 'Burnley', event_kind: 'match_winner' }),
    slot({ display_label: 'Burnley FC wins', event_kind: 'match_winner' }),
    slot({ display_label: 'Draw', event_kind: 'match_winner' }),
    slot({ display_label: 'Burnley vs Aston Villa Winner', event_kind: 'match_winner' }),
    slot({ display_label: null, event_kind: 'match_winner' }),
    // fused-twice exact grid: the same (0,0) scoreline under two outcomes
    slot({ display_label: 'Exact Score: 0-0', value_primary: 0, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact Score 0:0', value_primary: 0, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact Score: 0-1', value_primary: 0, value_secondary: 1, event_kind: 'exact_score' }),
    // co-occurrable kinds: spreads / totals / props / BTTS
    slot({ display_label: 'Aston Villa FC -1.5', value_primary: 1.5, event_kind: 'match_spread' }),
    slot({ display_label: 'Aston Villa FC -2.5', value_primary: 2.5, event_kind: 'match_spread' }),
    slot({ display_label: 'Over 2.5 goals', value_primary: 2.5, event_kind: 'match_total_metric' }),
    slot({ display_label: 'Over 3.5 goals', value_primary: 3.5, event_kind: 'match_total_metric' }),
    slot({ display_label: 'Ollie Watkins: Anytime Goalscorer', event_kind: 'player_prop_threshold' }),
    slot({ display_label: 'Morgan Rogers: Anytime Goalscorer', event_kind: 'player_prop_threshold' }),
    slot({ display_label: 'Both Teams to Score', event_kind: 'both_teams_score' }),
    slot({ display_label: 'Both Teams to Score - Yes', event_kind: 'both_teams_score' }),
    slot({ display_label: 'Over/Under 10.5', event_kind: null }),
  ];
  const r = partitionHeteroCategoricalByKind(slots);
  expect(r).not.toBeNull();
  expect(r!.mutexGroups.length).toBe(0); // NO mutex partition stands — all assertions dropped
  expect(r!.freedSlots.length).toBe(slots.length);
});

test('partitionHetero (live set 500 shape): clean winner trio emits, valueless exact slot refuses the grid', () => {
  const slots = [
    slot({ outcome_id: 'psg', display_label: 'Paris Saint-Germain FC win', event_kind: 'match_winner' }),
    slot({ outcome_id: 'draw', display_label: 'Draw', event_kind: 'match_winner' }),
    slot({ outcome_id: 'lens', display_label: 'Racing Club de Lens win', event_kind: 'match_winner' }),
    ...exactGrid(),
    // the 17th exact slot with NO scoreline values and NOT residual-flagged -> unprovable
    slot({ outcome_id: 'exact_mystery', display_label: 'Will PSG win on 2026-05-13?', event_kind: 'exact_score' }),
    slot({ display_label: 'Over 2.5', value_primary: 2.5, event_kind: 'match_total_metric' }),
  ];
  const r = partitionHeteroCategoricalByKind(slots);
  expect(r).not.toBeNull();
  expect(r!.mutexGroups.length).toBe(1);
  expect(r!.mutexGroups[0].map((s) => s.outcome_id)).toEqual(['psg', 'draw', 'lens']);
  expect(r!.freedSlots.length).toBe(18); // 17 exact + 1 total
});

test('partitionHetero: winner partition tolerates ONE subject-less slot (draw leg), refuses two', () => {
  const base = [
    slot({ display_label: 'Exact 1-0', value_primary: 1, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact 2-0', value_primary: 2, value_secondary: 0, event_kind: 'exact_score' }),
  ];
  const one = partitionHeteroCategoricalByKind([
    slot({ display_label: 'Home FC', event_kind: 'match_winner' }),
    slot({ display_label: null, event_kind: 'match_winner' }),
    ...base,
  ]);
  expect(one!.mutexGroups.length).toBe(2);
  const two = partitionHeteroCategoricalByKind([
    slot({ display_label: null, event_kind: 'match_winner' }),
    slot({ display_label: '', event_kind: 'match_winner' }),
    ...base,
  ]);
  expect(two!.mutexGroups.length).toBe(1); // only the exact grid stands
});

test('partitionHetero: subject substring drift refuses the winner partition (3-slot trap)', () => {
  // 3 slots pass the count cap, but 'aston villa' ⊂ 'aston villa fc wins' is the SAME
  // outcome under label drift — mutex between them would be fake.
  const r = partitionHeteroCategoricalByKind([
    slot({ display_label: 'Aston Villa', event_kind: 'match_winner' }),
    slot({ display_label: 'Aston Villa FC wins', event_kind: 'match_winner' }),
    slot({ display_label: 'Burnley', event_kind: 'match_winner' }),
    slot({ display_label: 'Exact 1-0', value_primary: 1, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact 2-0', value_primary: 2, value_secondary: 0, event_kind: 'exact_score' }),
  ]);
  expect(r!.mutexGroups.length).toBe(1); // exact only
  expect(r!.mutexGroups[0].every((s) => s.event_kind === 'exact_score')).toBe(true);
});

test('partitionHetero: market double-mapped across two kept outcomes refuses the group (union belt)', () => {
  const r = partitionHeteroCategoricalByKind([
    slot({ outcome_id: 'h', display_label: 'Home FC', event_kind: 'match_winner', market_ids: [7] }),
    slot({ outcome_id: 'a', display_label: 'Away FC', event_kind: 'match_winner', market_ids: [7, 8] }),
    slot({ display_label: 'Exact 1-0', value_primary: 1, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ display_label: 'Exact 2-0', value_primary: 2, value_secondary: 0, event_kind: 'exact_score' }),
  ]);
  expect(r!.mutexGroups.length).toBe(1); // exact only — the winner pair shares market 7
});

test('partitionHetero: championship/election drift fold (live set 5702) -> all freed', () => {
  // One Nobel-Prize field split across two kinds by Stage-1 drift: a per-kind mutex
  // would split one real one-hot in half, so both groups free.
  const r = partitionHeteroCategoricalByKind([
    slot({ display_label: 'Sam Altman', event_kind: 'championship_winner' }),
    slot({ display_label: 'Dario Amodei', event_kind: 'championship_winner' }),
    slot({ display_label: 'UNRWA', event_kind: 'election_outcome_winner' }),
    slot({ display_label: 'Yulia Navalnaya', event_kind: 'election_outcome_winner' }),
  ]);
  expect(r).not.toBeNull();
  expect(r!.mutexGroups.length).toBe(0);
  expect(r!.freedSlots.length).toBe(4);
});

// kind-homogeneous label-drift duplicate guard
//
// A single-kind categorical set holding the same outcome twice via label drift
// (e.g. a 1X2 fused twice, or per-platform club-name copies of one finisher)
// asserts a self-mutex — a guaranteed fake arb once priced.
// labelDriftDuplicateOutcomeIds folds despace + deaccent + one club org
// suffix, preserves comparator symbols, and is NULL-tolerant on
// value/direction (collide unless provably different).

test('foldDriftLabel: club org suffix strips at either end; despace + deaccent', () => {
  expect(foldDriftLabel('AFC Bournemouth')).toBe('bournemouth');
  expect(foldDriftLabel('Arsenal FC')).toBe('arsenal');
  expect(foldDriftLabel('Arsenal Football Club')).toBe('arsenal');
  expect(foldDriftLabel('Inter  Miami CF')).toBe('intermiami');
  expect(foldDriftLabel('Iván Cepeda')).toBe('ivancepeda');
  // an all-suffix name never folds to empty (no mass-merge)
  expect(foldDriftLabel('FC')).toBe('fc');
  expect(foldDriftLabel(null)).toBeNull();
  expect(foldDriftLabel('   ')).toBeNull();
});

test('foldDriftLabel: comparator symbols are PRESERVED (the v1-probe false-collision lesson)', () => {
  // an alphanumeric-only fold manufactured 'Cut 25bps' ≡ 'Cut >25bps', '9' ≡ '>9',
  // '1°C' ≡ '-1°C' — all DISTINCT outcomes whose only discriminator is the symbol.
  expect(foldDriftLabel('Cut 25bps')).not.toBe(foldDriftLabel('Cut >25bps'));
  expect(foldDriftLabel('9')).not.toBe(foldDriftLabel('>9'));
  expect(foldDriftLabel('1°C')).not.toBe(foldDriftLabel('-1°C'));
});

test('labelDrift: exact duplicate subjects collide (live SE 951 — 1X2 fused twice)', () => {
  const dup = labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'g1', display_label: 'Girona', event_kind: 'match_winner' }),
    slot({ outcome_id: 'g2', display_label: 'Girona', event_kind: 'match_winner' }),
    slot({ outcome_id: 'rv', display_label: 'Rayo Vallecano', event_kind: 'match_winner' }),
  ]);
  expect(dup).toEqual(new Set(['g1', 'g2']));
});

test('labelDrift: club-suffix drift collides (the isUnionDoubleMapped exact-fold miss)', () => {
  const dup = labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'a', display_label: 'Aston Villa' }),
    slot({ outcome_id: 'b', display_label: 'Aston Villa FC' }),
    slot({ outcome_id: 'c', display_label: 'Burnley' }),
  ]);
  expect(dup).toEqual(new Set(['a', 'b']));
});

test('labelDrift: NULL-tolerant values — a NULL-valued drift copy of a valued slot collides (live SE 775 shape)', () => {
  const dup = labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'k', display_label: 'AFC Bournemouth', value_primary: 2 }),
    slot({ outcome_id: 'p', display_label: 'Bournemouth', value_primary: null }),
  ]);
  expect(dup).toEqual(new Set(['k', 'p']));
});

test('labelDrift: value-discriminated same-subject slots do NOT collide (score grids / margin ladders)', () => {
  expect(labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 's20', display_label: 'Aston Villa', value_primary: 2, value_secondary: 0, event_kind: 'exact_score' }),
    slot({ outcome_id: 's30', display_label: 'Aston Villa', value_primary: 3, value_secondary: 0, event_kind: 'exact_score' }),
  ]).size).toBe(0);
  // direction discriminates too
  expect(labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'up', display_label: 'BTC', value_primary: 100, direction: 'above' }),
    slot({ outcome_id: 'dn', display_label: 'BTC', value_primary: 100, direction: 'below' }),
  ]).size).toBe(0);
});

test('labelDrift: substring-only similarity does NOT collide (measured false-positive class)', () => {
  // 'Paris FC' suffix-folds to 'paris' which is a substring of 'parissaintgermain' —
  // distinct clubs; the hetero guard may substring-refuse its ≤3-slot trios, but the
  // homogeneous guard must not (a substring match alone is mostly false positives
  // at larger set sizes).
  expect(labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'pfc', display_label: 'Paris FC' }),
    slot({ outcome_id: 'psg', display_label: 'Paris Saint Germain' }),
  ]).size).toBe(0);
});

test('labelDrift: residual and NULL-subject slots never collide', () => {
  expect(labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'r1', display_label: 'Other', is_residual: true }),
    slot({ outcome_id: 'r2', display_label: 'Other', is_residual: true }),
    slot({ outcome_id: 'n1', display_label: null }),
    slot({ outcome_id: 'n2', display_label: null }),
  ]).size).toBe(0);
});

test('labelDrift: clean distinct field → empty set', () => {
  expect(labelDriftDuplicateOutcomeIds([
    slot({ outcome_id: 'a', display_label: 'Arsenal' }),
    slot({ outcome_id: 'b', display_label: 'Manchester City' }),
    slot({ outcome_id: 'c', display_label: 'Liverpool' }),
  ]).size).toBe(0);
});

// cross-platform residual double-cover guard
//
// A present-residual Σ=1 categorical set is unsound when the residual's platform
// does NOT enumerate a named competitor that only the OTHER platform lists — the
// orphan fires its own named slot AND the foreign residual (two slots TRUE under
// a Σ=1 partition). residualCoversForeignPlatformSlot demotes it; all-shared
// cross-platform sets and within-platform sets stay Σ=1.

test('residualCoversForeignPlatformSlot: Kalshi-only named under PM residual -> TRUE (live set 900 UFC HW)', () => {
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'Jon Jones', platforms: ['kalshi'] }),
    slot({ display_label: 'Alex Pereira', platforms: ['kalshi'] }),
    slot({ display_label: 'another fighter', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(true);
});

test('residualCoversForeignPlatformSlot: Kalshi "Tie" orphan under PM residual -> TRUE (B2 class)', () => {
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'Nominee A', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Nominee B', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Tie', platforms: ['kalshi'] }),
    slot({ display_label: 'another nominee', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(true);
});

test('residualCoversForeignPlatformSlot: all named shared across the residual platform -> FALSE (sets 170/494/532)', () => {
  // Every named slot is listed on the residual's platform (superset), so the PM
  // residual double-covers nobody even though it is single-platform.
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'Ravens', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Bengals', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Steelers', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Other', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(false);
});

test('residualCoversForeignPlatformSlot: within-platform (feed-B) set -> FALSE', () => {
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'A', platforms: ['polymarket'] }),
    slot({ display_label: 'B', platforms: ['polymarket'] }),
    slot({ display_label: 'Other', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(false);
});

test('residualCoversForeignPlatformSlot: no residual slot -> FALSE (inert)', () => {
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'A', platforms: ['kalshi'] }),
    slot({ display_label: 'B', platforms: ['polymarket'] }),
  ])).toBe(false);
});

test('residualCoversForeignPlatformSlot: NULL/unknown platforms never demote (NULL-tolerant)', () => {
  // residual has no known platform → inert
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'A', platforms: ['kalshi'] }),
    slot({ display_label: 'Other', is_residual: true, platforms: null }),
  ])).toBe(false);
  // named slot has no known platform → skipped (unknown never demotes)
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'A', platforms: undefined }),
    slot({ display_label: 'Other', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(false);
});

test('residualCoversForeignPlatformSlot: named slot on the residual platform (PM-listed) is NOT double-covered', () => {
  // PM residual + a PM-named slot: PM enumerates it, so the residual excludes it.
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'PM Fighter', platforms: ['polymarket'] }),
    slot({ display_label: 'Shared Fighter', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'another fighter', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(false);
});

test('residualCoversForeignPlatformSlot: residuals on BOTH platforms, a Kalshi-only named -> TRUE', () => {
  // PM residual double-covers the Kalshi-only competitor (PM omits it).
  expect(residualCoversForeignPlatformSlot([
    slot({ display_label: 'Kalshi-only', platforms: ['kalshi'] }),
    slot({ display_label: 'Shared', platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'K Other', is_residual: true, platforms: ['kalshi'] }),
    slot({ display_label: 'PM Other', is_residual: true, platforms: ['polymarket'] }),
  ])).toBe(true);
});

test('classifySet B1: cross-platform residual set with a Kalshi-only named slot -> demoted to Σ<=1', () => {
  const v = classifySet([
    slot({ display_label: 'Jon Jones', event_kind: 'championship_winner', has_negrisk: true, platforms: ['kalshi'] }),
    slot({ display_label: 'Alex Pereira', event_kind: 'championship_winner', has_negrisk: true, platforms: ['kalshi'] }),
    slot({ display_label: 'Tom Aspinall', event_kind: 'championship_winner', has_negrisk: true, platforms: ['polymarket'] }),
    slot({ display_label: 'another fighter', is_residual: true, event_kind: 'championship_winner', platforms: ['polymarket'] }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
});

test('classifySet B1: all-shared cross-platform residual set stays Σ=1 (regression surface, sets 170/494/532)', () => {
  const v = classifySet([
    slot({ display_label: 'Ravens', event_kind: 'championship_winner', has_negrisk: true, platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Bengals', event_kind: 'championship_winner', has_negrisk: true, platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Steelers', event_kind: 'championship_winner', has_negrisk: true, platforms: ['kalshi', 'polymarket'] }),
    slot({ display_label: 'Other', is_residual: true, event_kind: 'championship_winner', platforms: ['polymarket'] }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

test('classifySet B1: within-platform residual set is unaffected (platforms all equal) -> Σ=1 kept', () => {
  const v = classifySet([
    slot({ display_label: 'A', event_kind: 'championship_winner', has_negrisk: true, platforms: ['polymarket'] }),
    slot({ display_label: 'B', event_kind: 'championship_winner', has_negrisk: true, platforms: ['polymarket'] }),
    slot({ display_label: 'Other', is_residual: true, event_kind: 'championship_winner', platforms: ['polymarket'] }),
  ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
  expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
});

// multi-winner award cardinality refusal
import { hasMultiWinnerCardinality } from './outcome-set-certifier.js';

describe('FIX 4c — multi-winner award refuses ALL mutex/one-hot', () => {
  test('a >1-cardinality field emits NO set (would otherwise be a Σ≤1 mutex)', () => {
    // An award with ≤4 winners modelled as per-person "rank ≤ 1" single-winner
    // slots is not a single-winner mutex.
    const fields = [
      slot({ display_label: 'Aleksandr Logunov', event_kind: 'championship_winner', mutex_cardinality: 4 }),
      slot({ display_label: 'Will Sawin', event_kind: 'championship_winner', mutex_cardinality: 4 }),
      slot({ display_label: 'Yu Deng', event_kind: 'championship_winner', mutex_cardinality: 4 }),
    ];
    expect(classifySet(fields, sig({ groupedAs: 'categorical' }))).toBeNull();
  });

  test('cardinality>1 also overrides an otherwise-exhaustive Σ=1 verdict', () => {
    const negFixture = [
      slot({ display_label: 'a', event_kind: 'championship_winner', has_negrisk: true, mutex_cardinality: 2 }),
      slot({ display_label: 'b', event_kind: 'championship_winner', has_negrisk: true, mutex_cardinality: 2 }),
      slot({ display_label: 'c', event_kind: 'championship_winner', has_negrisk: true, mutex_cardinality: 2 }),
    ];
    expect(classifySet(negFixture, sig({ groupedAs: 'categorical' }))).toBeNull();
  });

  test('single-winner (null / 1 cardinality) is UNAFFECTED — normal mutex stands', () => {
    const single = [
      slot({ display_label: 'a', event_kind: 'championship_winner', has_negrisk: true }),
      slot({ display_label: 'b', event_kind: 'championship_winner', has_negrisk: true, mutex_cardinality: 1 }),
      slot({ display_label: 'c', event_kind: 'championship_winner', has_negrisk: true }),
    ];
    expect(classifySet(single, sig({ groupedAs: 'categorical' }))).not.toBeNull();
  });

  test('a residual slot with cardinality>1 does NOT trip the refusal (residuals excluded)', () => {
    expect(hasMultiWinnerCardinality([
      { is_residual: true, mutex_cardinality: 4 },
      { is_residual: false, mutex_cardinality: null },
    ])).toBe(false);
    expect(hasMultiWinnerCardinality([
      { is_residual: false, mutex_cardinality: 4 },
    ])).toBe(true);
  });
});

// Two different slices of one fixture are neither mutex nor ladder
// (KXMLBF3 / KXMLBF5 / KXMLBF7: three INDEPENDENT innings cut-points on one game).
import { mixesKnownMetricScopes } from './outcome-set-certifier.js';

describe('slice mix — a set spanning two KNOWN metric_scopes emits NO set', () => {
  test('categorical: an F3 tie slot folded with an F7 tie slot is refused (Σ≤1 is a fake mutex)', () => {
    const mixed = [
      slot({ display_label: 'Draw', event_kind: 'match_winner', disc: { metric_scope: 'first_3' } }),
      slot({ display_label: 'Draw', event_kind: 'match_winner', disc: { metric_scope: 'first_7' } }),
    ];
    expect(classifySet(mixed, sig({ groupedAs: 'categorical' }))).toBeNull();
  });

  test('threshold_series: a clean ladder split across two slices is refused (order ideal is the fake nesting)', () => {
    const mixed = [
      slot({ direction: 'above', value_primary: 100, value_unit: 'usd', event_kind: 'price_threshold', disc: { metric_scope: 'first_3' } }),
      slot({ direction: 'above', value_primary: 110, value_unit: 'usd', event_kind: 'price_threshold', disc: { metric_scope: 'first_7' } }),
      slot({ direction: 'above', value_primary: 120, value_unit: 'usd', event_kind: 'price_threshold', disc: { metric_scope: 'first_7' } }),
    ];
    expect(classifySet(mixed, sig({ groupedAs: 'threshold_series' }))).toBeNull();
  });

  test('ONE known scope across all slots is UNAFFECTED (the normal period partition stands)', () => {
    const same = [
      slot({ display_label: 'a', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: 'first_3' } }),
      slot({ display_label: 'b', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: 'first_3' } }),
      slot({ display_label: 'Draw', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: 'first_3' } }),
    ];
    expect(classifySet(same, sig({ groupedAs: 'categorical' }))).not.toBeNull();
  });

  test('NULL POLICY: a known+NULL slot mix does NOT refuse (577 live half-result partitions)', () => {
    // "… - Second Half Result": the team legs carry half_2, the Draw leg does not.
    const knownNullMix = [
      slot({ display_label: 'a', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: 'half_2' } }),
      slot({ display_label: 'b', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: 'half_2' } }),
      slot({ display_label: 'Draw', event_kind: 'match_winner', has_negrisk: true, disc: { metric_scope: null } }),
    ];
    expect(mixesKnownMetricScopes(knownNullMix)).toBe(false);
    expect(classifySet(knownNullMix, sig({ groupedAs: 'categorical' }))).not.toBeNull();
  });

  test('a RESIDUAL slot never contributes a scope (residuals excluded)', () => {
    expect(mixesKnownMetricScopes([
      { is_residual: true, disc: { metric_scope: 'first_3' } },
      { is_residual: false, disc: { metric_scope: 'first_7' } },
    ])).toBe(false);
    expect(mixesKnownMetricScopes([
      { is_residual: false, disc: { metric_scope: 'first_3' } },
      { is_residual: false, disc: { metric_scope: 'first_7' } },
    ])).toBe(true);
  });
});

import { awardMaxWinners, AWARD_MAX_WINNERS } from '../stage1-normalize/kalshi-series.js';
describe('FIX 4c — awardMaxWinners map (award handler owns the cardinality)', () => {
  test('KXFIELDS = 4 (Fields Medal, ≤4 winners); series/off-Kalshi unknown = null', () => {
    expect(awardMaxWinners('KXFIELDS-26')).toBe(4);
    expect(awardMaxWinners('KXFIELDS')).toBe(4);
    expect(AWARD_MAX_WINNERS.KXFIELDS).toBe(4);
    expect(awardMaxWinners('KXBALLONDOR-26')).toBeNull(); // single-winner award
    expect(awardMaxWinners(null)).toBeNull();
    expect(awardMaxWinners('')).toBeNull();
  });
  test('KXGRAMMYNOM* nominee slates are multi-YES (caveat 3 — latent c99 topology)', () => {
    // A Grammy "nominees for <category>?" market is a multi-YES slate (8
    // nominees announced at once), not a single-winner mutex.
    for (const s of ['KXGRAMMYNOMNAOTY', 'KXGRAMMYNOMAOTY', 'KXGRAMMYNOMROTY', 'KXGRAMMYNOMSOTY']) {
      expect(awardMaxWinners(`${s}-69`)).toBe(8);
      expect(AWARD_MAX_WINNERS[s]).toBe(8);
    }
    // A single non-residual slot with the Grammy cardinality refuses ANY set.
    expect(hasMultiWinnerCardinality([
      { is_residual: false, mutex_cardinality: awardMaxWinners('KXGRAMMYNOMNAOTY-69') },
    ])).toBe(true);
    // The plain single-winner Grammy WINNER series (no NOM infix) is unaffected.
    expect(awardMaxWinners('KXGRAMMYAOTY-69')).toBeNull();
  });
});

// winner-grain org-vs-politician aggregate refusal
// A categorical (winner-grain) fold mixing an org/party aggregate with a
// politician member is a fused party+candidate election partition — a party
// co-resolves YES with its own candidate, so the mutex is false.
describe('G-1 org-vs-politician aggregate refusal', () => {
  test('mixesAggregateOrgWithPolitician: org + politician -> TRUE', () => {
    expect(mixesAggregateOrgWithPolitician([
      { subject_type: 'org' }, { subject_type: 'politician' },
    ])).toBe(true);
  });
  test('mixesAggregateOrgWithPolitician: org + non-politician person (band vs artists) -> FALSE', () => {
    expect(mixesAggregateOrgWithPolitician([
      { subject_type: 'org' }, { subject_type: 'person' }, { subject_type: 'person' },
    ])).toBe(false);
  });
  test('mixesAggregateOrgWithPolitician: org-only / politician-only / null-tolerant', () => {
    expect(mixesAggregateOrgWithPolitician([{ subject_type: 'org' }, { subject_type: 'org' }])).toBe(false);
    expect(mixesAggregateOrgWithPolitician([{ subject_type: 'politician' }, { subject_type: 'politician' }])).toBe(false);
    expect(mixesAggregateOrgWithPolitician([{ subject_type: 'org' }, { subject_type: 'other' }])).toBe(false);
    // undefined subject_type (feed B / untyped) never contributes.
    expect(mixesAggregateOrgWithPolitician([{ subject_type: undefined }, { subject_type: 'politician' }])).toBe(false);
  });

  // FIXTURE: a winner fragment after the grain split.
  test('classifySet: 1094 winner fragment {democrat, republican, graham_platner_wins, janet_mills_wins} -> NULL (no mutex)', () => {
    const v = classifySet([
      slot({ outcome_id: 'democrat', display_label: 'Democratic Party', subject_type: 'org' }),
      slot({ outcome_id: 'republican', display_label: 'Republican Party', subject_type: 'org' }),
      slot({ outcome_id: 'graham_platner_wins', subject_type: 'politician' }),
      slot({ outcome_id: 'janet_mills_wins', subject_type: 'politician' }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).toBeNull();
  });

  // all-person Democratic-nominee list (politicians, no org slot) — the gate is
  // inert (no aggregate to contain a member) → mints a categorical Σ≤1.
  test('classifySet: all-person set (all politicians, no org) -> categorical, unchanged', () => {
    const v = classifySet([
      slot({ outcome_id: 'gavin_newsom', display_label: 'Gavin Newsom', subject_type: 'politician' }),
      slot({ outcome_id: 'kamala_harris', display_label: 'Kamala Harris', subject_type: 'politician' }),
      slot({ outcome_id: 'pete_buttigieg', display_label: 'Pete Buttigieg', subject_type: 'politician' }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });

  // all-org set: a pure party race (no candidate slot) — the gate is inert → mints.
  test('classifySet: all-org party set -> categorical, unchanged', () => {
    const v = classifySet([
      slot({ outcome_id: 'democrat', display_label: 'Democratic Party', subject_type: 'org' }),
      slot({ outcome_id: 'republican', display_label: 'Republican Party', subject_type: 'org' }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });

  // legit non-political mix (a "Top Artist" band-vs-solo set) — the role scope
  // keeps it sound (a band does not contain a solo artist → real mutex).
  test('classifySet: org + non-politician persons (band vs solo artists) -> mints (not refused by G-1)', () => {
    const v = classifySet([
      slot({ outcome_id: 'bts', display_label: 'BTS', subject_type: 'org' }),
      slot({ outcome_id: 'bad_bunny', display_label: 'Bad Bunny', subject_type: 'person' }),
      slot({ outcome_id: 'drake', display_label: 'Drake', subject_type: 'person' }),
    ], sig({ groupedAs: 'categorical' }));
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });
});

// date-axis nested-deadline refusal
describe('hasNestedDeadlineRungs', () => {
  const slot = (date: string | null, kind = 'token_launch', value: number | null = null, residual = false) =>
    ({ event_kind: kind, condition_date: date, value_primary: value, is_residual: residual });

  test('Squid-shaped family (token_launch, 4 distinct deadlines, no values) → TRUE', () => {
    expect(hasNestedDeadlineRungs([
      slot('2026-07-31'), slot('2026-08-31'), slot('2026-10-31'), slot('2027-03-31'),
    ])).toBe(true);
  });

  test('BOUNDARY: exactly 2 distinct deadlines → TRUE (mutation audit 2026-07-21 — a ≥3 narrowing must fail here)', () => {
    expect(hasNestedDeadlineRungs([slot('2026-08-31'), slot('2026-10-31')])).toBe(true);
  });

  test('same deadline on every slot (acquisitions-style "by 2027" field) → FALSE', () => {
    expect(hasNestedDeadlineRungs([slot('2027-01-01'), slot('2027-01-01')])).toBe(false);
  });

  test('non-latch kind never triggers (price_threshold by_date contamination)', () => {
    expect(hasNestedDeadlineRungs([
      slot('2026-07-31', 'price_threshold'), slot('2026-08-31', 'price_threshold'),
    ])).toBe(false);
  });

  test('value-carrying rungs are the VALUE belt business → FALSE here', () => {
    expect(hasNestedDeadlineRungs([
      slot('2026-07-31', 'token_launch', 400), slot('2026-08-31', 'token_launch', 500),
    ])).toBe(false);
  });

  test('residual slots do not count toward the ≥2 real rungs', () => {
    expect(hasNestedDeadlineRungs([
      slot('2026-07-31'), slot('2026-08-31', 'token_launch', null, true),
    ])).toBe(false);
  });

  test('timestamp-precision dates still dedupe on the DATE grain', () => {
    expect(hasNestedDeadlineRungs([
      slot('2026-07-31T00:00:00Z'), slot('2026-07-31T23:59:00Z'),
    ])).toBe(false); // same day → 1 distinct date
  });
});

// hetero-dimension Σ=1 demote
// A Σ=1 set asserts totality over ONE resolution dimension. Fusing a
// season-series tie with a season win-totals comparison, or a driver-P1
// settlement with a constructor-points settlement, are different dimensions
// under one mutex. Both-known-and-differ only — a NULL dimension never demotes.

describe('heteroDimensionViolation (P6)', () => {
  test('two different KNOWN condition_metrics ⇒ violation', () => {
    expect(heteroDimensionViolation([
      slot({ condition_metric: 'points' }),
      slot({ condition_metric: 'wins' }),
    ])).toBe('condition_metric');
  });

  test('two different KNOWN value_units ⇒ violation', () => {
    expect(heteroDimensionViolation([
      slot({ value_unit: 'points' }),
      slot({ value_unit: 'wins' }),
    ])).toBe('value_unit');
  });

  test('NULL-tolerant: unknown never demotes (one-side-NULL, all-NULL)', () => {
    expect(heteroDimensionViolation([slot({ condition_metric: 'points' }), slot({})])).toBeNull();
    expect(heteroDimensionViolation([slot({}), slot({})])).toBeNull();
    expect(heteroDimensionViolation([slot({ value_unit: 'goals' }), slot({})])).toBeNull();
  });

  test("'rank' is an ENCODING, not a dimension (the live WC group-winner shape)", () => {
    // Stage 1 stamps value_unit='rank' on some legs of a winner field and not
    // others; such sets look "hetero" that way but must not demote.
    expect(heteroDimensionViolation([
      slot({ value_unit: 'rank', event_kind: 'championship_winner' }),
      slot({ value_unit: null, event_kind: 'championship_winner' }),
      slot({ value_unit: 'rank' }),
    ])).toBeNull();
  });

  test('plural drift is not a dimension difference (goal ≡ goals)', () => {
    expect(heteroDimensionViolation([slot({ value_unit: 'goal' }), slot({ value_unit: 'goals' })])).toBeNull();
  });

  test('residual slots carry no dimension (excluded)', () => {
    expect(heteroDimensionViolation([
      slot({ value_unit: 'wins' }),
      slot({ value_unit: 'points', is_residual: true }),
    ])).toBeNull();
  });

  test('classifySet DEMOTES a would-be Σ=1 fold that mixes dimensions (Lions/Packers shape)', () => {
    const v = classifySet([
      slot({ display_label: 'Detroit more wins', has_negrisk: true, event_kind: 'match_winner', value_unit: 'wins' }),
      slot({ display_label: 'Green Bay more wins', has_negrisk: true, event_kind: 'match_winner', value_unit: 'wins' }),
      slot({ display_label: 'Series tied', has_negrisk: true, event_kind: 'match_winner', value_unit: 'games' }),
    ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
    expect(v).toEqual({ setType: 'categorical', isExhaustive: false });
  });

  test('REGRESSION: the sound one-dimension negRisk 1X2 still certifies Σ=1', () => {
    const v = classifySet([
      slot({ display_label: 'Home', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ display_label: 'Draw', has_negrisk: true, event_kind: 'match_winner' }),
      slot({ display_label: 'Away', has_negrisk: true, event_kind: 'match_winner' }),
    ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
    expect(v).toEqual({ setType: 'categorical', isExhaustive: true });
  });
});

// a NULL-kind scoreline slot joins its own exact_score group

describe('partitionHeteroCategoricalByKind — NULL-kind scoreline re-home (P4)', () => {
  test('a NULL-kind slot with a scoreline pair rides with the exact_score group', () => {
    const r = partitionHeteroCategoricalByKind([
      slot({ display_label: 'Home', event_kind: 'match_winner' }),
      slot({ display_label: 'Away', event_kind: 'match_winner' }),
      slot({ display_label: '2-1', event_kind: 'exact_score', value_primary: 2, value_secondary: 1 }),
      slot({ display_label: '0-0', event_kind: null, value_primary: 0, value_secondary: 0 }),
    ]);
    expect(r).not.toBeNull();
    const exact = r!.mutexGroups.find((g) => g.some((s) => s.display_label === '2-1'));
    expect(exact?.map((s) => s.display_label).sort()).toEqual(['0-0', '2-1']);
    expect(r!.freedSlots.length).toBe(0);
  });

  test('a NULL-kind slot with NO scoreline is still freed (unchanged; a LONE exact slot frees too)', () => {
    const r = partitionHeteroCategoricalByKind([
      slot({ display_label: 'Home', event_kind: 'match_winner' }),
      slot({ display_label: 'Away', event_kind: 'match_winner' }),
      slot({ display_label: '2-1', event_kind: 'exact_score', value_primary: 2, value_secondary: 1 }),
      slot({ display_label: 'O/U 2.5', event_kind: null }),
    ]);
    // '2-1' frees as well — a 1-slot exact group is not a mutex (real.length<2).
    expect(r!.freedSlots.map((s) => s.display_label).sort()).toEqual(['2-1', 'O/U 2.5']);
  });

  test('no exact_score group in the fold ⇒ a scoreline-valued NULL-kind slot is NOT re-homed', () => {
    const r = partitionHeteroCategoricalByKind([
      slot({ display_label: 'Home', event_kind: 'match_winner' }),
      slot({ display_label: 'Away', event_kind: 'match_winner' }),
      slot({ display_label: 'seats 0-3', event_kind: 'match_spread', value_primary: 0, value_secondary: 3 }),
      slot({ display_label: 'unknown', event_kind: null, value_primary: 1, value_secondary: 2 }),
    ]);
    expect(r!.freedSlots.map((s) => s.display_label)).toContain('unknown');
  });
});

// cross-settlement-dimension set refusal

describe('P6b — settlementDimensionConflictReason / classifySet refusal', () => {
  const P1 = 'motorsport:race-p1';
  const PTS = 'motorsport:constructor-points';

  /** 11 fused (kalshi race-p1 + PM constructor-points) slots plus the PM
   *  negRisk residual that makes the fold look exhaustive. */
  const audiSet = (): CertifierSlot[] => [
    ...['alpine', 'aston_martin', 'audi', 'cadillac', 'ferrari', 'haas', 'mclaren',
        'mercedes', 'racing_bulls', 'red_bull', 'williams'].map((n) =>
      slot({ outcome_id: n, display_label: n, has_negrisk: true, settlement_dimensions: [P1, PTS] })),
    slot({ outcome_id: 'other', display_label: 'Other', is_residual: true, has_negrisk: true,
           settlement_dimensions: [PTS] }),
  ];

  test('the live fused set is REFUSED entirely — not demoted to Σ≤1', () => {
    // Demoting would leave a Σ≤1 mutex standing across two settlement
    // dimensions, where two slots can be true at once. Only NO SET is sound.
    expect(classifySet(audiSet(), sig({ groupedAs: 'categorical', kindHomogeneous: true }))).toBeNull();
  });

  test('conflict reason names the two dimensions, sorted', () => {
    expect(settlementDimensionConflictReason(audiSet())).toBe(`${PTS} vs ${P1}`);
  });

  test('the conflict may be SPREAD ACROSS slots, not just within one', () => {
    // The Kalshi-only and PM-only halves as separate slots — still one basket.
    expect(classifySet([
      slot({ outcome_id: 'a', has_negrisk: true, settlement_dimensions: [P1] }),
      slot({ outcome_id: 'b', has_negrisk: true, settlement_dimensions: [PTS] }),
    ], sig({ groupedAs: 'categorical' }))).toBeNull();
  });

  test('a DIMENSION-HOMOGENEOUS set is untouched (the Kalshi-only family survives)', () => {
    const v = classifySet([
      slot({ outcome_id: 'a', display_label: 'Alpine', has_negrisk: true, event_kind: 'championship_winner', settlement_dimensions: [P1] }),
      slot({ outcome_id: 'b', display_label: 'Ferrari', has_negrisk: true, event_kind: 'championship_winner', settlement_dimensions: [P1] }),
      slot({ outcome_id: 'other', display_label: 'Other', is_residual: true, has_negrisk: true, event_kind: 'championship_winner', settlement_dimensions: [P1] }),
    ], sig({ groupedAs: 'categorical', kindHomogeneous: true }));
    expect(v).not.toBeNull();
    expect(v!.setType).toBe('categorical');
  });

  test('UNKNOWN dimensions never refuse — every set in the graph today is unaffected', () => {
    expect(settlementDimensionConflictReason([
      slot({ settlement_dimensions: null }),
      slot({ settlement_dimensions: [] }),
      slot({}),
    ])).toBe(null);
    // one-side-known is the sound KXF1RACE x PM race-winner shape
    expect(settlementDimensionConflictReason([
      slot({ settlement_dimensions: [P1] }),
      slot({ settlement_dimensions: null }),
    ])).toBe(null);
  });

  test('the refusal outranks a negRisk Σ=1: on-chain mutex does not license a mixed basket', () => {
    // PM's negRisk proves exactly-one among the PM POINTS legs — it says nothing
    // about the foreign P1 legs fused into the same slots.
    expect(classifySet(audiSet(), sig({ groupedAs: 'categorical', kindHomogeneous: true, allBoundChildrenMapped: true }))).toBeNull();
  });
});
