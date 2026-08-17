/**
 * Tests for the Stage 3b deterministic match guards: arithmetic/structural
 * backstops that refuse to persist an unsound LLM match.
 */
import { describe, test, expect } from 'bun:test';
import {
  validateMatch, countDistinctSubjects, canonicalOutcomeKey, ONE_HOT_PARTITION_KINDS,
  isCountBucketToken, isSpelledCountBucketToken,
  classifyOutcomeAxisByKey, outcomeGrain,
  electionContainmentReject, isCandidateShapedName, looksLikePartyOrAggregateLabel,
  type EventMatchResult, type MatchContext,
} from './guards.js';
import { ONE_HOT_FIXTURE_KINDS } from '../stage4-events/finalize.js';
import { beltCensus, resetBeltCensus } from '../discriminators/telemetry.js';
// test-only stage4 import: pins the date-grain mirror against the
// member-cohesion source of truth.
import { memberPairConflict, type MemberFacts } from '../stage4-events/member-cohesion.js';

// A valid 2-platform categorical match: Trump + Vance, each on Poly + Kalshi.
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

const ctx = (scope?: Map<number, string | null>): MatchContext => ({
  minConfidence: 0.6,
  marketPlatform: new Map([
    [1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi'],
  ]),
  marketScope: scope ?? new Map(),
});

describe('countDistinctSubjects (drift-tolerant)', () => {
  test('alias prefix drift collapses to 1', () => {
    expect(countDistinctSubjects(['kraken', 'kraken ipo closing market cap'])).toBe(1);
    expect(countDistinctSubjects(['tori', 'tori finance'])).toBe(1);
    expect(countDistinctSubjects(['ledger', 'ledger ipo closing market cap'])).toBe(1);
    expect(countDistinctSubjects(['chicago', 'chicago midway international airport'])).toBe(1);
  });
  test('alias suffix drift collapses to 1', () => {
    // "new york city" is a trailing run of "central park, new york city".
    expect(countDistinctSubjects(['central park, new york city', 'new york city'])).toBe(1);
  });
  test('genuine distinct subjects stay ≥2', () => {
    expect(countDistinctSubjects(['o1', 'probable', 'variational'])).toBe(3);
    expect(countDistinctSubjects(['o1', 'oro', 'titan'])).toBe(3);
    // interior insertion is NOT a prefix/suffix run → stays distinct (CPI vs Core CPI).
    expect(countDistinctSubjects(['us cpi', 'us core cpi'])).toBe(2);
    expect(countDistinctSubjects(['us u-3 unemployment rate', 'canada unemployment rate'])).toBe(2);
    expect(countDistinctSubjects(['natural gas', 'us gasoline price'])).toBe(2);
  });
  test('single subject and empties → 1 / 0', () => {
    expect(countDistinctSubjects(['us cpi', 'US CPI', ' us cpi '])).toBe(1);
    expect(countDistinctSubjects([])).toBe(0);
  });
});

describe('validateMatch', () => {
  test('valid categorical → match', () => {
    expect(validateMatch(validCategorical(), ctx()).kind).toBe('match');
  });

  test('same_event=false → no_match (skipped, not failed)', () => {
    const r = { ...validCategorical(), same_event: false };
    expect(validateMatch(r, ctx()).kind).toBe('no_match');
  });

  test('confidence below threshold → no_match', () => {
    const r = { ...validCategorical(), confidence: 0.4 };
    expect(validateMatch(r, ctx()).kind).toBe('no_match');
  });

  // These pin the generic registry-driven leg-coherence belt actually
  // dropping a leg on a JSONB-fed discriminator conflict.
  test('disc coherence: both-known-and-differ stat_type drops the later leg (subtractive)', () => {
    const r = validCategorical();
    const v = validateMatch(r, {
      ...ctx(),
      marketDiscriminators: new Map<number, Record<string, string>>([
        [1, { stat_type: 'points' }],
        [2, { stat_type: 'rebounds' }], // conflicts with accepted leg 1 on outcome 'trump'
        [3, {}], [4, {}],
      ]),
    });
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('disc leg-coherence drop') && w.includes('stat_type'))).toBe(true);
    }
    expect(r.leg_mapping!.map((l) => l.market_id).sort()).toEqual([1, 3, 4]);
  });

  test('disc coherence: block-when-sibling-known (tour_gender) drops a NULL leg entering a known fold', () => {
    const r = validCategorical();
    const v = validateMatch(r, {
      ...ctx(),
      marketDiscriminators: new Map<number, Record<string, string>>([
        [1, { tour_gender: 'women' }],
        [2, {}], // NULL tour entering a fold where the sibling is known → F-C NULL-bridge drop
        [3, {}], [4, {}],
      ]),
    });
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('tour_gender') && w.includes('NULL leg'))).toBe(true);
    }
    expect(r.leg_mapping!.map((l) => l.market_id).sort()).toEqual([1, 3, 4]);
  });

  test('disc coherence: agreeing / empty stamps drop nothing (NULL-tolerant no-op)', () => {
    const r = validCategorical();
    const v = validateMatch(r, {
      ...ctx(),
      marketDiscriminators: new Map<number, Record<string, string>>([
        [1, { stat_type: 'points' }], [2, { stat_type: 'points' }], [3, {}], [4, {}],
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('missing grouping_kind → reject', () => {
    const r = { ...validCategorical(), grouping_kind: undefined };
    const v = validateMatch(r, ctx());
    expect(v.kind).toBe('reject');
  });

  test('phantom outcome with no leg → reject', () => {
    const r = validCategorical();
    r.outcome_set!.push({ outcome_id: 'field', label: 'Field' });
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('binary single-outcome (one child per platform) → match', () => {
    // BTC "Up or Down" candle: one market per platform, YES=Up. The complement
    // (Down) is implicit — a single shared outcome with one leg per platform.
    const r: EventMatchResult = {
      same_event: true,
      confidence: 0.99,
      reasoning: 'same BTC up/down candle window',
      canonical_event: 'Bitcoin Up or Down - May 11, 3:15AM ET',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [{ outcome_id: 'btc_up', label: 'Up' }],
      leg_mapping: [
        { outcome_id: 'btc_up', platform: 'polymarket', market_id: 10 },
        { outcome_id: 'btc_up', platform: 'predict', market_id: 11 },
      ],
    };
    const binaryCtx: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[10, 'polymarket'], [11, 'predict']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, binaryCtx).kind).toBe('match');
  });

  test('single outcome but a platform has 2 children → reject (collapsed partition)', () => {
    // A real N-way partition (e.g. an election) lazily collapsed to one outcome
    // would fuse unrelated markets into one equivalence class → fake arb.
    const r: EventMatchResult = {
      same_event: true,
      confidence: 0.99,
      reasoning: 'wrongly collapsed multi-candidate race',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [{ outcome_id: 'someone_wins', label: 'Someone wins' }],
      leg_mapping: [
        { outcome_id: 'someone_wins', platform: 'polymarket', market_id: 20 },
        { outcome_id: 'someone_wins', platform: 'polymarket', market_id: 21 },
      ],
    };
    const collapsedCtx: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[20, 'polymarket'], [21, 'polymarket']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, collapsedCtx).kind).toBe('reject');
  });

  test('leg referencing undeclared outcome → reject', () => {
    const r = validCategorical();
    r.leg_mapping!.push({ outcome_id: 'ghost', platform: 'kalshi', market_id: 2 });
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('two non-residual outcomes sharing outcome_subject → reject', () => {
    const r = validCategorical();
    r.outcome_set![1].outcome_subject = 'Donald Trump'; // collide vance onto trump
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('residual carrying a subject → reject', () => {
    const r = validCategorical();
    r.outcome_set!.push({ outcome_id: 'field', label: 'Field', is_residual: true, outcome_subject: 'someone' });
    r.leg_mapping!.push({ outcome_id: 'field', platform: 'kalshi', market_id: 2 });
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('hallucinated market_id not among children → reject', () => {
    const r = validCategorical();
    r.leg_mapping![0].market_id = 999;
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('market_id on a different platform than stated → reject', () => {
    const r = validCategorical();
    r.leg_mapping![0].platform = 'kalshi'; // market 1 is polymarket
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('threshold_series missing ordinal → reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'btc ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 't90', label: '>=90k', ordinal: 1 },
        { outcome_id: 't80', label: '>=80k' }, // missing ordinal
      ],
      leg_mapping: [
        { outcome_id: 't90', platform: 'kalshi', market_id: 2 },
        { outcome_id: 't80', platform: 'polymarket', market_id: 1 },
      ],
    };
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('threshold_series duplicate ordinal → reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'btc ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 't90', label: '>=90k', ordinal: 1 },
        { outcome_id: 't80', label: '>=80k', ordinal: 1 },
      ],
      leg_mapping: [
        { outcome_id: 't90', platform: 'kalshi', market_id: 2 },
        { outcome_id: 't80', platform: 'polymarket', market_id: 1 },
      ],
    };
    expect(validateMatch(r, ctx()).kind).toBe('reject');
  });

  test('merging differing resolution scopes into one outcome → reject', () => {
    // market 1 (Trump@poly) is regulation, market 2 (Trump@kalshi) is incl_overtime.
    const scope = new Map<number, string | null>([
      [1, 'regulation'], [2, 'incl_overtime'], [3, 'unspecified'], [4, null],
    ]);
    expect(validateMatch(validCategorical(), ctx(scope)).kind).toBe('reject');
  });

  test('same scope across legs → match (scope guard does not over-fire)', () => {
    const scope = new Map<number, string | null>([
      [1, 'incl_overtime'], [2, 'incl_overtime'], [3, 'unspecified'], [4, null],
    ]);
    expect(validateMatch(validCategorical(), ctx(scope)).kind).toBe('match');
  });

  // Cross-settlement-dimension merge refusal: an outcome must not fuse a leg
  // that pays on a driver taking P1 with a leg that pays on topping the
  // constructor points table — these can diverge (driver P1, other
  // constructor leads points).
  const P1_DIM = 'motorsport:race-p1';
  const PTS_DIM = 'motorsport:constructor-points';
  const withDims = (dims: Map<number, string | null>): MatchContext =>
    ({ ...ctx(), marketSettlementDimension: dims });

  test('an outcome fusing driver-P1 with constructor-points legs → reject', () => {
    const v = validateMatch(validCategorical(), withDims(new Map([
      [1, PTS_DIM], [2, P1_DIM], [3, PTS_DIM], [4, P1_DIM],
    ])));
    expect(v.kind).toBe('reject');
    expect(v.kind === 'reject' && v.reason).toContain('DIFFERENT measured quantities');
  });

  test('legs agreeing on the dimension → match (no over-fire)', () => {
    expect(validateMatch(validCategorical(), withDims(new Map([
      [1, P1_DIM], [2, P1_DIM], [3, P1_DIM], [4, P1_DIM],
    ]))).kind).toBe('match');
  });

  test('one-side-NULL → match — the sound KXF1RACE × PM race-winner merge survives', () => {
    // PM's "on the winner of the 2026 F1 Belgian Grand Prix" extracts nothing;
    // refusing on a single known side would cost that legitimate merge.
    expect(validateMatch(validCategorical(), withDims(new Map([
      [1, null], [2, P1_DIM], [3, null], [4, P1_DIM],
    ]))).kind).toBe('match');
  });

  test('two dimensions in DIFFERENT outcomes of one match → match (per-outcome guard)', () => {
    // The set-level mixed-basket case is the certifier's jurisdiction
    // (settlementDimensionConflictReason); this guard is per-outcome only, so it
    // must not reject a bundle that keeps the quantities in separate outcomes.
    expect(validateMatch(validCategorical(), withDims(new Map([
      [1, P1_DIM], [2, P1_DIM], [3, PTS_DIM], [4, PTS_DIM],
    ]))).kind).toBe('match');
  });

  test('an absent/empty map is inert (unconditional guard, NULL-tolerant)', () => {
    expect(validateMatch(validCategorical(), withDims(new Map())).kind).toBe('match');
    expect(validateMatch(validCategorical(), ctx()).kind).toBe('match');
  });

  // partition-grain guards
  test('categorical mixing placeholder candidates with named outcomes → reject', () => {
    // Anonymized "A"/"B" candidates fused with named "Republican/Democratic
    // Party" into one exclusive set is not a real partition.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'MA-05 over-merge',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'a', label: 'A', outcome_subject: 'A' },
        { outcome_id: 'b', label: 'B', outcome_subject: 'B' },
        { outcome_id: 'democratic', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'republican', label: 'Republican Party', outcome_subject: 'Republican Party' },
      ],
      leg_mapping: [
        { outcome_id: 'a', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'b', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'democratic', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'republican', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'kalshi'], [4, 'kalshi']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('"Team USA"/"Team Europe" are real national-team entities, not placeholders → match', () => {
    // The placeholder regex must not treat "Team <X>" as anonymized: Olympics /
    // Ryder Cup "Team USA"/"Team GB"/"Team Europe" are real entities.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'Ryder Cup winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'usa', label: 'Team USA', outcome_subject: 'Team USA' },
        { outcome_id: 'eu', label: 'Team Europe', outcome_subject: 'Team Europe' },
      ],
      leg_mapping: [
        { outcome_id: 'usa', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'usa', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'eu', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'eu', platform: 'kalshi', market_id: 4 },
      ],
    };
    expect(validateMatch(r, ctx()).kind).toBe('match');
  });

  test('categorical mixing a party/organization with ≥2 persons → reject (aggregate vs members)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'party + named candidates',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'smith', label: 'Smith', outcome_subject: 'John Smith' },
        { outcome_id: 'jones', label: 'Jones', outcome_subject: 'Mary Jones' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'smith', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'jones', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      subjectType: new Map([
        ['democratic party', 'organization'], ['john smith', 'person'], ['mary jones', 'person'],
      ]),
    };
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('categorical mixing a type=party subject with ≥2 persons → reject (party counts as aggregate)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'party (type=party) + named candidates',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'grn', label: 'Green Party', outcome_subject: 'Green Party' },
        { outcome_id: 'smith', label: 'Smith', outcome_subject: 'John Smith' },
        { outcome_id: 'jones', label: 'Jones', outcome_subject: 'Mary Jones' },
      ],
      leg_mapping: [
        { outcome_id: 'grn', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'smith', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'jones', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      // 'green party' typed with the distinct 'party' type (not 'organization') —
      // the gate must still count it as the aggregate grain.
      subjectType: new Map([
        ['green party', 'party'], ['john smith', 'person'], ['mary jones', 'person'],
      ]),
    };
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('party + single independent person → match (aggregate guard does not over-fire)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'party vs one independent — a real partition',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'indy', label: 'Independent', outcome_subject: 'Jane Indie' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'dem', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'indy', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'indy', platform: 'polymarket', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      subjectType: new Map([['democratic party', 'organization'], ['jane indie', 'person']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2b: generic Independent aggregate + KB-stamped independent candidate → reject (GW-R1)', () => {
    // {Democratic Party, Independent, Ken Block, Republican Party}: Block is
    // KB-stamped party='Independent' → "Block wins" ⟹ "Independent wins" —
    // not a mutex.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'RI governor winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'indy', label: 'Independent', outcome_subject: 'Independent' },
        { outcome_id: 'block', label: 'Ken Block', outcome_subject: 'Ken Block' },
        { outcome_id: 'rep', label: 'Republican Party', outcome_subject: 'Republican Party' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'indy', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'block', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'rep', platform: 'polymarket', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      subjectType: new Map([
        ['democratic party', 'organization'], ['republican party', 'organization'], ['ken block', 'person'],
      ]),
      subjectParty: new Map([['ken block', 'Independent']]),
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('independent-aggregate containment');
  });

  test('§C-2b abstains without a KB party stamp (untyped person + generic Independent → match)', () => {
    // Same shape, but the candidate has NO party metadata — the guard must not
    // guess (soundness direction: null = unknown). Check-2 also stays quiet
    // (persons=1 < 2).
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'governor winner, unstamped candidate',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'indy', label: 'Independent', outcome_subject: 'Independent' },
        { outcome_id: 'doe', label: 'Jane Doe', outcome_subject: 'Jane Doe' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'indy', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'doe', platform: 'kalshi', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'kalshi']]),
      marketScope: new Map(),
      subjectType: new Map([
        ['democratic party', 'organization'], ['jane doe', 'person'],
      ]),
      subjectParty: new Map([['jane doe', null]]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2b: independent candidate WITHOUT a generic aggregate sibling → match (Nebraska 3-way)', () => {
    // {Osborn, Democratic Party, Republican Party} is a legit partition — the
    // aggregates present do NOT cover Osborn's affiliation. The KB stamp alone
    // must not reject; only the generic-label + stamped-candidate PAIR does.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'NE senate 3-way',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'osborn', label: 'Dan Osborn', outcome_subject: 'Dan Osborn' },
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'rep', label: 'Republican Party', outcome_subject: 'Republican Party' },
      ],
      leg_mapping: [
        { outcome_id: 'osborn', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'dem', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'rep', platform: 'kalshi', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'kalshi'], [3, 'kalshi']]),
      marketScope: new Map(),
      subjectType: new Map([
        ['dan osborn', 'person'], ['democratic party', 'organization'], ['republican party', 'organization'],
      ]),
      subjectParty: new Map([['dan osborn', 'Independent']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  // party-aggregate CONTAINS candidate (election-winner scope)
  const IL04_KIND = new Map<number, string | null>([
    [1, 'election_outcome_winner'], [2, 'election_outcome_winner'],
    [3, 'election_outcome_winner'], [4, 'election_outcome_winner'],
    [5, 'election_outcome_winner'],
  ]);
  // Two party aggregates + three candidates, of whom only Mayra Macías
  // resolves to a KB `person` (Lupe/Patty are absent from the KB). check-2
  // starves (persons=1<2); this check catches it by counting the two
  // unresolved candidate-shaped siblings as members.
  function il04(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'IL-04 House winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'rep', label: 'Republican Party', outcome_subject: 'Republican Party' },
        { outcome_id: 'lupe', label: 'lupe_castillo', outcome_subject: 'Lupe Castillo' },
        { outcome_id: 'patty', label: 'patty_garcia', outcome_subject: 'Patty Garcia' },
        { outcome_id: 'mayra', label: 'mayra_macias', outcome_subject: 'Mayra Macías' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'rep', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'lupe', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'patty', platform: 'polymarket', market_id: 4 },
        { outcome_id: 'mayra', platform: 'polymarket', market_id: 5 },
      ],
    };
  }

  test('§C-2c: election winner — party aggregate + ≥2 candidates (1 unresolved) → reject', () => {
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'polymarket'], [4, 'polymarket'], [5, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: IL04_KIND,
      subjectType: new Map([
        ['democratic party', 'organization'], ['republican party', 'organization'], ['mayra macías', 'person'],
        // lupe castillo / patty garcia intentionally ABSENT (unresolved).
      ]),
    };
    const v = validateMatch(il04(), c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('aggregate-vs-members containment');
  });

  test('§C-2c: SAME set but NOT election scope (event_kind other) → match (POY-class protection)', () => {
    // Identical org+persons shape, but event_kind='other' (the Time Person of the
    // Year class: ChatGPT does not CONTAIN the person nominees). The scope gate
    // must make this check a no-op here.
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'polymarket'], [4, 'polymarket'], [5, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'other'], [2, 'other'], [3, 'other'], [4, 'other'], [5, 'other']]),
      subjectType: new Map([
        ['democratic party', 'organization'], ['republican party', 'organization'], ['mayra macías', 'person'],
      ]),
    };
    expect(validateMatch(il04(), c).kind).toBe('match');
  });

  test('§C-2c: Time Person of the Year {ChatGPT, nominees} (championship/other scope) → match', () => {
    // The real POY mutex: an org (ChatGPT) is a DISJOINT alternative to the person
    // nominees. event_kind=other ⇒ out of scope ⇒ untouched even though it is an
    // org + ≥2 persons shape that a naive check-2 would refuse.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'Time POY 2026',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'gpt', label: 'chatgpt', outcome_subject: 'ChatGPT' },
        { outcome_id: 'swift', label: 'taylor_swift', outcome_subject: 'Taylor Swift' },
        { outcome_id: 'musk', label: 'elon_musk', outcome_subject: 'Elon Musk' },
      ],
      leg_mapping: [
        { outcome_id: 'gpt', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'swift', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'musk', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'other'], [2, 'other'], [3, 'other']]),
      // Live POY nominees are absent from the KB (underscore label forms) — the
      // realistic typing. 2c is out of scope regardless; this confirms the class
      // is untouched.
      subjectType: new Map([['chatgpt', 'organization']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2c: all-party categorical (election scope, 0 candidate members) → match', () => {
    // "Which party wins?" — parties only, no candidate persons. In scope, but
    // members=0 → the ≥2 bound leaves it untouched. (The seat-range-outcome
    // variant of this all-party class is covered by the pure test below, which
    // exercises members=0 without tripping the count-bucket guard.)
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'House 2026 party',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'rep', label: 'Republican Party', outcome_subject: 'Republican Party' },
        { outcome_id: 'grn', label: 'Green Party', outcome_subject: 'Green Party' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'rep', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'grn', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'election_outcome_winner'], [2, 'election_outcome_winner'], [3, 'election_outcome_winner']]),
      subjectType: new Map([['democratic party', 'organization'], ['republican party', 'organization'], ['green party', 'organization']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2c: Kalshi Senate {Dem, Rep, Person A..C} — anonymized placeholders excluded → match', () => {
    // Person A..C are anonymized negRisk placeholders, not real candidates —
    // the Ω layer drops them, leaving a sound Dem-vs-Rep 2-party mutex. This
    // check must not refuse (member count < 2).
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'Senate winner (negRisk placeholders)',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'democratic_party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'rep', label: 'republican_party', outcome_subject: 'Republican Party' },
        { outcome_id: 'pa', label: 'person_a', outcome_subject: 'Person A' },
        { outcome_id: 'pb', label: 'person_b', outcome_subject: 'Person B' },
        { outcome_id: 'pc', label: 'person_c', outcome_subject: 'Person C' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'rep', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'pa', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'pb', platform: 'kalshi', market_id: 4 },
        { outcome_id: 'pc', platform: 'kalshi', market_id: 5 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'kalshi'], [3, 'kalshi'], [4, 'kalshi'], [5, 'kalshi']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'election_outcome_winner'], [2, 'election_outcome_winner'], [3, 'election_outcome_winner'], [4, 'election_outcome_winner'], [5, 'election_outcome_winner']]),
      subjectType: new Map([['democratic party', 'organization'], ['republican party', 'organization']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2c: election scope, party + single candidate (RI-Governor 3-way) → match (≥2 bound)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'RI governor winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'dem', label: 'Democratic Party', outcome_subject: 'Democratic Party' },
        { outcome_id: 'rep', label: 'Republican Party', outcome_subject: 'Republican Party' },
        { outcome_id: 'osborn', label: 'Dan Osborn', outcome_subject: 'Dan Osborn' },
      ],
      leg_mapping: [
        { outcome_id: 'dem', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'rep', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'osborn', platform: 'kalshi', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'kalshi'], [3, 'kalshi']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'election_outcome_winner'], [2, 'election_outcome_winner'], [3, 'election_outcome_winner']]),
      subjectType: new Map([['democratic party', 'organization'], ['republican party', 'organization'], ['dan osborn', 'person']]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('§C-2c: absent subjectType ⇒ never fires (no refusal on absence)', () => {
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'polymarket'], [4, 'polymarket'], [5, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: IL04_KIND,
      // no subjectType
    };
    expect(validateMatch(il04(), c).kind).toBe('match');
  });

  test('electionContainmentReject pure: unresolved candidate counted, party excluded', () => {
    expect(electionContainmentReject([
      { subject: 'Democratic Party', type: 'organization' },
      { subject: 'Republican Party', type: 'organization' },
      { subject: 'Mayra Macías', type: 'person' },
      { subject: 'Lupe Castillo', type: null },
      { subject: 'Patty Garcia', type: null },
    ])).toEqual({ aggregates: 2, members: 3, fire: true });
    // single member → no fire
    expect(electionContainmentReject([
      { subject: 'Democratic Party', type: 'organization' },
      { subject: 'Dan Osborn', type: 'person' },
    ]).fire).toBe(false);
    // all-party → 0 members
    expect(electionContainmentReject([
      { subject: 'Democratic Party', type: 'organization' },
      { subject: 'republican seats 225-229', type: null },
      { subject: 'republican seats 230+', type: null },
    ])).toEqual({ aggregates: 1, members: 0, fire: false });
    // anonymized Person A..C placeholders are NOT members (Ω exclusion) → no fire,
    // even in spaced ("Person A") and slug ("person_b") forms.
    expect(electionContainmentReject([
      { subject: 'Democratic Party', type: 'organization' },
      { subject: 'Republican Party', type: 'organization' },
      { subject: 'Person A', type: null },
      { subject: 'person_b', type: null },
      { subject: 'Person C', type: null },
    ])).toEqual({ aggregates: 2, members: 0, fire: false });
  });

  test('isCandidateShapedName / looksLikePartyOrAggregateLabel shape rules', () => {
    expect(isCandidateShapedName('Lupe Castillo')).toBe(true);
    expect(isCandidateShapedName('lupe_castillo')).toBe(true);
    expect(isCandidateShapedName('Mayra Macías')).toBe(true);
    expect(isCandidateShapedName('chatgpt')).toBe(false);       // single word
    expect(isCandidateShapedName('republican seats 225-229')).toBe(false); // digits
    expect(looksLikePartyOrAggregateLabel('Democratic Party')).toBe(true);
    expect(looksLikePartyOrAggregateLabel('Independent')).toBe(true);
    expect(looksLikePartyOrAggregateLabel('Lupe Castillo')).toBe(false);
  });

  test('valid threshold_series → match', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'btc ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 't90', label: '>=90k', ordinal: 1 },
        { outcome_id: 't80', label: '>=80k', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 't90', platform: 'kalshi', market_id: 2 },
        { outcome_id: 't80', platform: 'polymarket', market_id: 1 },
      ],
    };
    expect(validateMatch(r, ctx()).kind).toBe('match');
  });

  // Cross-subject over-merge backstop
  function ladder(): EventMatchResult {
    return {
      same_event: true, confidence: 0.9, reasoning: 'fdv ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'ge1b', label: '>=$1B', ordinal: 1 },
        { outcome_id: 'ge100m', label: '>=$100M', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'ge1b', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'ge100m', platform: 'kalshi', market_id: 2 },
      ],
    };
  }

  test('threshold_series spanning ≥2 distinct subjects → reject (cross-subject over-merge)', () => {
    // o1 vs Probable fused into one FDV ladder is a cross-subject over-merge.
    const c: MatchContext = { ...ctx(), marketSubject: new Map([[1, 'o1'], [2, 'Probable']]) };
    const v = validateMatch(ladder(), c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('cross-subject over-merge');
  });

  test('threshold_series single subject (cross-platform same project) → match', () => {
    const c: MatchContext = { ...ctx(), marketSubject: new Map([[1, 'o1'], [2, 'o1']]) };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  test('threshold_series with one unknown subject → match (NULL-tolerant, ≥2 KNOWN required)', () => {
    const c: MatchContext = { ...ctx(), marketSubject: new Map([[1, 'o1'], [2, null]]) };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  // Fixture-kind exemption: per-fixture sports kinds carry per-team subjects,
  // so one fixture legitimately spans ≥2 subjects — the backstop must not fire.
  test('threshold_series fixture-kind legs spanning 2 subjects → match (exempt)', () => {
    // "Ducks" + "Golden Knights" O/U-goals ladder = ONE fixture, two teams.
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'Anaheim Ducks'], [2, 'Vegas Golden Knights']]),
      marketEventKind: new Map([[1, 'match_total_metric'], [2, 'match_total_metric']]),
    };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  // Expansion-aware cross-subject backstop: an over-merge can accrete across
  // N-platform expansion merges (each pair adds one country's inflation
  // ladder to a growing US-CPI threshold_series); no single pair shows ≥2
  // known subjects, so the pair-local backstop needs priorLegSubjects to fold
  // the already-bound legs into the subject set.
  test('expansion: pair has 1 known subject but a prior leg adds a 2nd → reject', () => {
    // The SE already holds a "US CPI" leg; this expansion pair adds an "Argentina
    // inflation" ladder (the new market's subject) — together ≥2 subjects.
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'Argentina inflation'], [2, 'Argentina inflation']]),
      priorLegSubjects: ['US CPI', 'US CPI', null], // existing SE legs (incl. a NULL)
    };
    const v = validateMatch(ladder(), c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('cross-subject over-merge');
  });

  test('expansion: pair subject equals the prior subject → match (cross-platform same subject)', () => {
    // A legit cross-platform ladder expanding to a 3rd platform — all "US CPI".
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'US CPI'], [2, 'US CPI']]),
      priorLegSubjects: ['US CPI', null, 'US CPI'],
    };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  test('expansion: pair has a known subject, all prior legs NULL → match (no false reject)', () => {
    // The pair contributes exactly one known subject; the existing SE legs are
    // unnormalized (NULL) — must NOT fabricate a 2nd subject from NULLs.
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'US CPI'], [2, 'US CPI']]),
      priorLegSubjects: [null, null, null],
    };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  test('expansion: a prior leg carries a fixture kind → exempt (no reject even with 2 subjects)', () => {
    // A fixture (per-team subjects) accreted across expansion stays exempt: the
    // exemption must consider prior leg kinds, not just the current pair.
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'Anaheim Ducks'], [2, 'Anaheim Ducks']]),
      priorLegSubjects: ['Vegas Golden Knights'],
      priorLegEventKinds: ['match_total_metric'],
    };
    expect(validateMatch(ladder(), c).kind).toBe('match');
  });

  test('threshold_series FDV (non-fixture) spanning 2 subjects → reject even with event_kind set', () => {
    // crypto_launch_fdv ∉ FIXTURE_KINDS, so the genuine multi-project over-merge is still killed.
    const c: MatchContext = {
      ...ctx(),
      marketSubject: new Map([[1, 'o1'], [2, 'Probable']]),
      marketEventKind: new Map([[1, 'crypto_launch_fdv'], [2, 'crypto_launch_fdv']]),
    };
    const v = validateMatch(ladder(), c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('cross-subject over-merge');
  });

  // ── period-scope hardstop: an outcome must not merge a halftime-leader leg with
  //    a whole-match leg (different resolution period → co-occurrable). ──
  test('period-scope: an outcome merging halftime-leader + whole-match legs → reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'ht x full fuse',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'a_wins', label: 'A wins', outcome_subject: 'Team A' },
        { outcome_id: 'b_wins', label: 'B wins', outcome_subject: 'Team B' },
      ],
      leg_mapping: [
        { outcome_id: 'a_wins', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'a_wins', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'b_wins', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'b_wins', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      ...ctx(),
      marketEventKind: new Map([[1, 'halftime_leader'], [2, 'match_winner'], [3, 'match_winner'], [4, 'match_winner']]),
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('halftime');
  });

  test('period-scope: halftime + whole-match as SEPARATE outcomes (bundle) → not rejected by the hardstop', () => {
    // A legitimate fixture bundle: HT and full-match are DIFFERENT outcomes, not fused.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'fixture bundle',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [
        { outcome_id: 'ht_a', label: 'A leads at HT', outcome_subject: 'Team A' },
        { outcome_id: 'ft_a', label: 'A wins', outcome_subject: 'Team A FT' },
      ],
      leg_mapping: [
        { outcome_id: 'ht_a', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'ft_a', platform: 'kalshi', market_id: 2 },
      ],
    };
    const c: MatchContext = {
      ...ctx(),
      marketEventKind: new Map([[1, 'halftime_leader'], [2, 'match_winner']]),
    };
    // The per-outcome hardstop does not fire (each outcome is single-kind); the
    // bundle is allowed through to the normal checks.
    expect(validateMatch(r, c).kind).toBe('match');
  });

  // Set-level period-grain: a categorical partition mixing HT + whole-match
  // across different outcomes (the per-outcome hardstop misses this), or
  // accreted via N-platform expansion, is co-occurrable → not a valid mutex set.
  test('categorical period-grain: HT + whole-match as SEPARATE outcomes → reject (set-level)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'ht + full co-partition',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'a_ht', label: 'A leads at HT', outcome_subject: 'Team A HT' },
        { outcome_id: 'b_ft', label: 'B wins', outcome_subject: 'Team B' },
      ],
      leg_mapping: [
        { outcome_id: 'a_ht', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'a_ht', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'b_ft', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'b_ft', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      ...ctx(),
      marketEventKind: new Map([[1, 'halftime_leader'], [2, 'halftime_leader'], [3, 'match_winner'], [4, 'match_winner']]),
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('period');
  });

  test('categorical period-grain: HT current legs + whole-match PRIOR leg (expansion) → reject', () => {
    const c: MatchContext = {
      ...ctx(),
      marketEventKind: new Map([[1, 'halftime_leader'], [2, 'halftime_leader'], [3, 'halftime_leader'], [4, 'halftime_leader']]),
      priorLegEventKinds: ['match_winner'],
    };
    expect(validateMatch(validCategorical(), c).kind).toBe('reject');
  });

  test('categorical period-grain: pure-halftime partition (no whole-match) → match', () => {
    const c: MatchContext = {
      ...ctx(),
      marketEventKind: new Map([[1, 'halftime_leader'], [2, 'halftime_leader'], [3, 'halftime_leader'], [4, 'halftime_leader']]),
    };
    expect(validateMatch(validCategorical(), c).kind).toBe('match');
  });

  // Outcome-partition union reconciliation (N-platform expansion): a Kalshi
  // 3-way soccer winner split into subject-distinct outcome_ids across two
  // expansion pairs can double-bind one market to ≥2 slots. The per-pair guard
  // never sees the union; folding ctx.priorLegs in catches both the duplicate
  // subject and the re-binding.
  describe('M-EXPAND-1 union reconciliation', () => {
    test('SE-856 class, W2-R1 fold-reconcilable: teplice_win re-keys onto prior fk_teplice -> match, no double-map persisted', () => {
      // A double-map (market 6 under both fk_teplice and teplice_win = two Ω
      // slots) is resolved by proving the two ids are one outcome re-spelled
      // ('teplice' is a token run of the shared subject 'FK Teplice' + ' win'),
      // so the new outcome is re-keyed onto the prior id instead of persisting
      // the double-map.
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'soccer winner expansion',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'dukla_win', label: 'Dukla', outcome_subject: 'FK Dukla Praha' },
          { outcome_id: 'teplice_win', label: 'Teplice', outcome_subject: 'FK Teplice' },
        ],
        leg_mapping: [
          { outcome_id: 'dukla_win', platform: 'kalshi', market_id: 5 },
          { outcome_id: 'teplice_win', platform: 'polymarket', market_id: 6 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[5, 'kalshi'], [6, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'fk_teplice', outcome_subject: 'FK Teplice', market_id: 6 },
          { outcome_id: 'draw', outcome_subject: null, market_id: 7 },
        ],
      };
      const v = validateMatch(r, c);
      expect(v.kind).toBe('match');
      // re-keyed to the prior id → market 6 stays bound to ONE outcome_id.
      expect(r.leg_mapping!.find((l) => l.market_id === 6)!.outcome_id).toBe('fk_teplice');
    });

    test('SE-856 regression: NON-respelling duplicate subject across prior+new -> still reject', () => {
      // The prior id carries a token OUTSIDE the subject ('match_2_winner') → the
      // fold cannot prove identity → the union check still rejects the duplicate
      // winner (the genuine double-mapped Σ=1 slot class).
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'soccer winner expansion',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'dukla_win', label: 'Dukla', outcome_subject: 'FK Dukla Praha' },
          { outcome_id: 'teplice_win', label: 'Teplice', outcome_subject: 'FK Teplice' },
        ],
        leg_mapping: [
          { outcome_id: 'dukla_win', platform: 'kalshi', market_id: 5 },
          { outcome_id: 'teplice_win', platform: 'polymarket', market_id: 6 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[5, 'kalshi'], [6, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'match_2_winner', outcome_subject: 'FK Teplice', market_id: 8 },
          { outcome_id: 'draw', outcome_subject: null, market_id: 7 },
        ],
      };
      const v = validateMatch(r, c);
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') expect(v.reason).toContain('claimed by two outcomes');
    });

    test('market-binding-conflict: market re-bound to a DIFFERENT outcome_id -> reject', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'rebind',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'dukla_win', label: 'Dukla', outcome_subject: 'FK Dukla Praha' },
          { outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null },
        ],
        leg_mapping: [
          { outcome_id: 'dukla_win', platform: 'kalshi', market_id: 4626414 },
          { outcome_id: 'other', platform: 'polymarket', market_id: 99 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[4626414, 'kalshi'], [99, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'fk_teplice', outcome_subject: 'Some Other Subject', market_id: 4626414 },
        ],
      };
      const v = validateMatch(r, c);
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') expect(v.reason).toContain('double-mapped market');
    });

    test('negative/recall: legit 2-way, no shared subject/market across union -> match', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'clean',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'home', label: 'Home', outcome_subject: 'Team Home' },
          { outcome_id: 'away', label: 'Away', outcome_subject: 'Team Away' },
        ],
        leg_mapping: [
          { outcome_id: 'home', platform: 'kalshi', market_id: 10 },
          { outcome_id: 'away', platform: 'polymarket', market_id: 11 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[10, 'kalshi'], [11, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'draw', outcome_subject: null, market_id: 12 },
        ],
      };
      expect(validateMatch(r, c).kind).toBe('match');
    });

    test('residual exemption: prior residual leg (subject null) + new residual -> no reject', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'residual ok',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'home', label: 'Home', outcome_subject: 'Team Home' },
          { outcome_id: 'away', label: 'Away', outcome_subject: 'Team Away' },
          { outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null },
        ],
        leg_mapping: [
          { outcome_id: 'home', platform: 'kalshi', market_id: 20 },
          { outcome_id: 'away', platform: 'polymarket', market_id: 21 },
          { outcome_id: 'other', platform: 'polymarket', market_id: 22 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[20, 'kalshi'], [21, 'polymarket'], [22, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'other', outcome_subject: null, market_id: 23 },
        ],
      };
      expect(validateMatch(r, c).kind).toBe('match');
    });

    test('idempotent re-attach: same market re-bound to the SAME outcome_id -> match', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 're-attach',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'home', label: 'Home', outcome_subject: 'Team Home' },
          { outcome_id: 'away', label: 'Away', outcome_subject: 'Team Away' },
        ],
        leg_mapping: [
          { outcome_id: 'home', platform: 'kalshi', market_id: 30 },
          { outcome_id: 'away', platform: 'polymarket', market_id: 31 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[30, 'kalshi'], [31, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'home', outcome_subject: 'Team Home', market_id: 30 },
        ],
      };
      expect(validateMatch(r, c).kind).toBe('match');
    });

    test('threshold subject-null double-bind: prior market re-bound to a diff ladder slot -> reject', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'bnb threshold rebind',
        grouping_kind: 'threshold_series',
        outcome_set: [
          { outcome_id: 'ge_100', label: 'ge 100', outcome_subject: null, ordinal: 2 },
          { outcome_id: 'ge_200', label: 'ge 200', outcome_subject: null, ordinal: 1 },
        ],
        leg_mapping: [
          { outcome_id: 'ge_100', platform: 'polymarket', market_id: 40 },
          { outcome_id: 'ge_200', platform: 'polymarket', market_id: 41 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[40, 'polymarket'], [41, 'polymarket']]),
        marketScope: new Map(),
        priorLegs: [
          { outcome_id: 'ge_500', outcome_subject: null, market_id: 40 },
        ],
      };
      const v = validateMatch(r, c);
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') expect(v.reason).toContain('double-mapped market');
    });

    test('no prior legs (fresh create) -> behaves exactly as before (match)', () => {
      expect(validateMatch(validCategorical(), ctx()).kind).toBe('match');
    });
  });

  // Same-platform sibling-event identity guard. A platform never lists the
  // same question twice, so two distinct same-platform platform_events must
  // never feed one outcome node.
  describe('P0 same-platform sibling-event identity guard', () => {
    // Expanding a new kalshi event into an SE whose prior kalshi leg already
    // owns outcome "adam_schiff" — same platform, distinct pe, same outcome
    // node = identity collision.
    const se1322Expansion = (): EventMatchResult => ({
      same_event: true, confidence: 0.95, reasoning: 'both about Adam Schiff',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [{ outcome_id: 'adam_schiff', label: 'Adam Schiff', outcome_subject: 'Adam Schiff' }],
      // New pair is cross-platform (ANN invariant): a kalshi market + a PM
      // market. Both map to "adam_schiff".
      leg_mapping: [
        { outcome_id: 'adam_schiff', platform: 'kalshi', market_id: 5 },
        { outcome_id: 'adam_schiff', platform: 'polymarket', market_id: 6 },
      ],
    });
    const baseCtx = (): MatchContext => ({
      minConfidence: 0.6,
      marketPlatform: new Map([[5, 'kalshi'], [6, 'polymarket']]),
      marketScope: new Map(),
      marketPlatformEvent: new Map([[5, 23247], [6, 1637]]),
      priorLegs: [
        // KXARREST's Adam-Schiff market (pe 1840) already bound to "adam_schiff".
        { outcome_id: 'adam_schiff', outcome_subject: 'Adam Schiff', market_id: 4, platform: 'kalshi', platform_event_id: 1840 },
      ],
    });

    test('se-1322: two distinct kalshi platform_events on one outcome -> reject + belt', () => {
      resetBeltCensus();
      const v = validateMatch(se1322Expansion(), baseCtx());
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') {
        expect(v.reason).toContain('kalshi');
        expect(v.reason).toContain('same question twice');
      }
      expect(beltCensus()['belt.same_platform_sibling_refuse']).toBe(1);
    });

    test('idempotent re-attach: SAME kalshi pe on both prior+new -> match (no false refuse)', () => {
      const c = baseCtx();
      // prior leg is the SAME pe (23247) as the new kalshi leg → one event, not siblings.
      c.priorLegs = [{ outcome_id: 'adam_schiff', outcome_subject: 'Adam Schiff', market_id: 4, platform: 'kalshi', platform_event_id: 23247 }];
      expect(validateMatch(se1322Expansion(), c).kind).toBe('match');
    });

    test('benign fixture bundle: two kalshi pes feed DIFFERENT outcomes -> match', () => {
      // Winner event (pe 100) → "seattle"; a home-runs prop event (pe 200) → "over_8".
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'fixture bundle',
        grouping_kind: 'bundle_nonexclusive',
        outcome_set: [
          { outcome_id: 'over_8', label: 'Over 8 HR', outcome_subject: 'over 8 home runs' },
          { outcome_id: 'pm_dummy', label: 'x', outcome_subject: 'x' },
        ],
        leg_mapping: [
          { outcome_id: 'over_8', platform: 'kalshi', market_id: 5 },
          { outcome_id: 'pm_dummy', platform: 'polymarket', market_id: 6 },
        ],
      };
      const c = baseCtx();
      c.marketPlatformEvent = new Map([[5, 200], [6, 1637]]);
      c.priorLegs = [{ outcome_id: 'seattle', outcome_subject: 'Seattle', market_id: 4, platform: 'kalshi', platform_event_id: 100 }];
      expect(validateMatch(r, c).kind).toBe('match');
    });

    test('cross-platform on one outcome (kalshi + PM, each one event) -> match (not siblings)', () => {
      const c = baseCtx();
      // outcome "adam_schiff" fed by ONE kalshi event (23247) + ONE PM event (1637,
      // the prior leg AND the new PM market 6) → distinct platforms, one pe each,
      // no same-platform sibling collision.
      c.priorLegs = [{ outcome_id: 'adam_schiff', outcome_subject: 'Adam Schiff', market_id: 4, platform: 'polymarket', platform_event_id: 1637 }];
      // baseCtx marketPlatformEvent already maps market 6 → PM pe 1637.
      expect(validateMatch(se1322Expansion(), c).kind).toBe('match');
    });

    test('NULL-tolerant: prior leg missing platform_event_id -> no evidence -> match', () => {
      const c = baseCtx();
      c.priorLegs = [{ outcome_id: 'adam_schiff', outcome_subject: 'Adam Schiff', market_id: 4, platform: 'kalshi', platform_event_id: null }];
      expect(validateMatch(se1322Expansion(), c).kind).toBe('match');
    });

    test('residual outcome exempt: two kalshi pes feed residual -> match', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'residual',
        grouping_kind: 'categorical_exclusive',
        outcome_set: [
          { outcome_id: 'named', label: 'Named', outcome_subject: 'Someone' },
          { outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null },
        ],
        leg_mapping: [
          { outcome_id: 'named', platform: 'polymarket', market_id: 6 },
          { outcome_id: 'other', platform: 'kalshi', market_id: 5 },
        ],
      };
      const c = baseCtx();
      c.marketPlatformEvent = new Map([[5, 23247], [6, 1637]]);
      c.priorLegs = [{ outcome_id: 'other', outcome_subject: null, market_id: 4, platform: 'kalshi', platform_event_id: 1840 }];
      expect(validateMatch(r, c).kind).toBe('match');
    });
  });

  // M-MATCH-1: candle_direction merged with an absolute price-LEVEL kind is a fake
  // mutex/Sigma=1 over co-occurrable slots (close>open AND close>$X both true).
  // M-MATCH-2: NEVER_SAME_EVENT kind-pairs (champ x stage_advance, election margin x
  // winner) are two different events. Both keyed on the GATED event_kind, unordered,
  // grouping-agnostic, NULL-tolerant, and union-aware (current legs + prior legs).
  describe('M-MATCH-1 / M-MATCH-2 cross-kind guards', () => {
    test('T1 SE-297: candle x price categorical -> reject', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'candle_direction'], [3, 'price_threshold'], [4, 'price_threshold']]),
      };
      const v = validateMatch(validCategorical(), c);
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') expect(v.reason).toContain('candle');
    });

    test('T2 candle x price via EXPANSION (prior leg) -> reject', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'candle_direction'], [3, 'candle_direction'], [4, 'candle_direction']]),
        priorLegEventKinds: ['price_threshold'],
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('reject');
    });

    test('T3 candle x price as bundle_nonexclusive -> reject (unconditional on grouping)', () => {
      const r = { ...validCategorical(), grouping_kind: 'bundle_nonexclusive' as const };
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'candle_direction'], [3, 'price_threshold'], [4, 'price_threshold']]),
      };
      expect(validateMatch(r, c).kind).toBe('reject');
    });

    test('T3b candle x price_snapshot -> reject (validator-omitted price kind)', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'candle_direction'], [3, 'price_snapshot'], [4, 'price_snapshot']]),
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('reject');
    });

    test('T4 NEGATIVE pure candle partition -> match (no recall loss)', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'candle_direction'], [3, 'candle_direction'], [4, 'candle_direction']]),
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('match');
    });

    test('T5 NEGATIVE pure price_threshold ladder -> match', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.95, reasoning: 'eth above ladder',
        grouping_kind: 'threshold_series',
        outcome_set: [
          { outcome_id: 'ge_2300', label: 'ge 2300', outcome_subject: null, ordinal: 1 },
          { outcome_id: 'ge_2200', label: 'ge 2200', outcome_subject: null, ordinal: 2 },
        ],
        leg_mapping: [
          { outcome_id: 'ge_2300', platform: 'polymarket', market_id: 1 },
          { outcome_id: 'ge_2200', platform: 'kalshi', market_id: 2 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi']]),
        marketScope: new Map(),
        marketEventKind: new Map([[1, 'price_threshold'], [2, 'price_threshold']]),
      };
      expect(validateMatch(r, c).kind).toBe('match');
    });

    test('T6 monotonic_threshold (condition_shape, wrong field) alongside candle -> match', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'candle_direction'], [2, 'monotonic_threshold'], [3, 'candle_direction'], [4, 'candle_direction']]),
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('match');
    });

    test('M-MATCH-2 championship_winner x stage_advance -> reject', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'championship_winner'], [2, 'championship_winner'], [3, 'stage_advance'], [4, 'stage_advance']]),
      };
      const v = validateMatch(validCategorical(), c);
      expect(v.kind).toBe('reject');
      if (v.kind === 'reject') expect(v.reason).toContain('stage_advance');
    });

    test('M-MATCH-2 champ x stage via EXPANSION (prior leg) -> reject', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'championship_winner'], [2, 'championship_winner'], [3, 'championship_winner'], [4, 'championship_winner']]),
        priorLegEventKinds: ['stage_advance'],
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('reject');
    });

    test('M-MATCH-2 election_margin x election_outcome_winner -> reject', () => {
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'election_margin'], [2, 'election_margin'], [3, 'election_outcome_winner'], [4, 'election_outcome_winner']]),
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('reject');
    });

    test('M-MATCH-2 NEGATIVE pure championship_winner -> match; pure stage_advance -> match', () => {
      const champ: MatchContext = { ...ctx(), marketEventKind: new Map([[1, 'championship_winner'], [2, 'championship_winner'], [3, 'championship_winner'], [4, 'championship_winner']]) };
      const stage: MatchContext = { ...ctx(), marketEventKind: new Map([[1, 'stage_advance'], [2, 'stage_advance'], [3, 'stage_advance'], [4, 'stage_advance']]) };
      expect(validateMatch(validCategorical(), champ).kind).toBe('match');
      expect(validateMatch(validCategorical(), stage).kind).toBe('match');
    });

    test('M-MATCH-2 NEGATIVE pair NOT in the set (match_winner x championship_winner) -> match', () => {
      // Two DIFFERENT event_kinds, neither pair blocklisted, and BOTH winner-grain
      // (so the check-6 grain guard also passes).
      const c: MatchContext = {
        ...ctx(),
        marketEventKind: new Map([[1, 'match_winner'], [2, 'match_winner'], [3, 'championship_winner'], [4, 'championship_winner']]),
      };
      expect(validateMatch(validCategorical(), c).kind).toBe('match');
    });
  });

  // M-RECALL-4: an asymmetric bundle where ONE platform carries an extra prop
  // (NRFI/toss/exact-score) the other lacks is the SAME event — match the shared
  // match_winner outcomes, leave the extra prop as its own single-leg outcome_id.
  // The guard must not reject a one-platform-only bundle outcome (no recall loss).
  describe('M-RECALL-4 asymmetric bundle', () => {
    test('bundle with a one-platform-only extra prop outcome -> match', () => {
      const r: EventMatchResult = {
        same_event: true, confidence: 0.92, reasoning: 'shared match_winner + PM-only NRFI prop',
        grouping_kind: 'bundle_nonexclusive',
        outcome_set: [
          { outcome_id: 'reds_win', label: 'Reds win', outcome_subject: 'Cincinnati Reds' },
          { outcome_id: 'phillies_win', label: 'Phillies win', outcome_subject: 'Philadelphia Phillies' },
          { outcome_id: 'nrfi_yes', label: 'No run first inning', outcome_subject: 'NRFI' },
        ],
        leg_mapping: [
          { outcome_id: 'reds_win', platform: 'polymarket', market_id: 1 },
          { outcome_id: 'reds_win', platform: 'predict', market_id: 2 },
          { outcome_id: 'phillies_win', platform: 'polymarket', market_id: 3 },
          { outcome_id: 'phillies_win', platform: 'predict', market_id: 4 },
          { outcome_id: 'nrfi_yes', platform: 'polymarket', market_id: 5 },
        ],
      };
      const c: MatchContext = {
        minConfidence: 0.6,
        marketPlatform: new Map([
          [1, 'polymarket'], [2, 'predict'], [3, 'polymarket'], [4, 'predict'], [5, 'polymarket'],
        ]),
        marketScope: new Map(),
      };
      expect(validateMatch(r, c).kind).toBe('match');
    });
  });
});

// PLX-02: outcome_id-drift RECONCILIATION (re-key instead of reject) — gated on
// metric_scope-equal AND canonical_event-equal so the SOUND Map-2-vs-overall
// block stays rejected, and a true market-double-map still rejects.
describe('PLX-02 outcome_id-drift reconciliation', () => {
  // The SE already has an `argentina` leg (market 9). This pair proposes the SAME
  // subject under a drifted id `argentina_win`. With metric_scope + canonical_event
  // equal, reconcile: re-key argentina_win -> argentina, persist as a match.
  function expansion(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'WC winner expansion',
      grouping_kind: 'categorical_exclusive',
      canonical_event: '2026 World Cup Winner',
      outcome_set: [
        { outcome_id: 'argentina_win', label: 'Argentina', outcome_subject: 'Argentina' },
        { outcome_id: 'brazil_win', label: 'Brazil', outcome_subject: 'Brazil' },
      ],
      leg_mapping: [
        { outcome_id: 'argentina_win', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'brazil_win', platform: 'polymarket', market_id: 3 },
      ],
    };
  }
  function reconcileCtx(over: Partial<MatchContext> = {}): MatchContext {
    return {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      reconcileMetricScope: new Map([[1, 'game'], [3, 'game']]),
      newCanonicalEvent: '2026 World Cup Winner',
      priorLegs: [
        { outcome_id: 'argentina', outcome_subject: 'Argentina', market_id: 9, metric_scope: 'game', canonical_event: '2026 World Cup Winner' },
      ],
      ...over,
    };
  }

  test('re-keys argentina_win -> argentina (gate satisfied) => match', () => {
    const r = expansion();
    const v = validateMatch(r, reconcileCtx());
    expect(v.kind).toBe('match');
    // the new outcome + its leg adopt the prior outcome_id.
    expect(r.outcome_set!.find((o) => o.label === 'Argentina')!.outcome_id).toBe('argentina');
    expect(r.leg_mapping!.find((l) => l.market_id === 1)!.outcome_id).toBe('argentina');
  });

  test('without reconciliation (flag off) the same pair REJECTS on the subject collision', () => {
    const r = expansion();
    const v = validateMatch(r, reconcileCtx({ reconcileEnabled: false }));
    expect(v.kind).toBe('reject');
  });

  test('gate blocks re-key when metric_scope differs (Map-2 vs overall) => reject', () => {
    const r = expansion();
    // the new leg is map_2 scope; the prior leg is the overall game => no reconcile.
    const v = validateMatch(r, reconcileCtx({ reconcileMetricScope: new Map([[1, 'map_2'], [3, 'map_2']]) }));
    expect(v.kind).toBe('reject');
  });

  test('gate blocks re-key when canonical_event differs => reject', () => {
    const r = expansion();
    const v = validateMatch(r, reconcileCtx({ newCanonicalEvent: 'Some Other Event' }));
    expect(v.kind).toBe('reject');
  });

  test('W2-R1: pure re-spelling id reconciles even with metric_scope unknown (fold path) => match', () => {
    // The label-fold path proves 'argentina_win' is a re-spelling of the
    // shared subject, so unknown metric_scope does not block the re-key.
    const r = expansion();
    const v = validateMatch(r, reconcileCtx({ reconcileMetricScope: undefined }));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.find((l) => l.market_id === 1)!.outcome_id).toBe('argentina');
  });

  test('strict gate still declines for NON-respelling drift when metric_scope unknown => reject', () => {
    // 'argentina_group_winner' carries tokens outside the subject → fold path
    // cannot prove identity → falls back to the strict PLX-02 gate, which
    // declines on unknown metric_scope (the safe direction) → union check rejects.
    const r = expansion();
    r.outcome_set![0].outcome_id = 'argentina_group_winner';
    r.leg_mapping![0].outcome_id = 'argentina_group_winner';
    const v = validateMatch(r, reconcileCtx({ reconcileMetricScope: undefined }));
    expect(v.kind).toBe('reject');
  });

  test('true market-double-map still REJECTS even with reconciliation on', () => {
    // market 1 is bound to argentina (prior) but the new pair binds the SAME market
    // to brazil_win => a genuine double-map, not id drift. Reconciliation must NOT
    // rescue it.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'true double-map',
      grouping_kind: 'categorical_exclusive',
      canonical_event: '2026 World Cup Winner',
      outcome_set: [
        { outcome_id: 'brazil_win', label: 'Brazil', outcome_subject: 'Brazil' },
        { outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null },
      ],
      leg_mapping: [
        { outcome_id: 'brazil_win', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'other', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [3, 'polymarket']]),
      marketScope: new Map(),
      reconcileMetricScope: new Map([[1, 'game'], [3, 'game']]),
      newCanonicalEvent: '2026 World Cup Winner',
      priorLegs: [
        { outcome_id: 'argentina', outcome_subject: 'Argentina', market_id: 1, metric_scope: 'game', canonical_event: '2026 World Cup Winner' },
      ],
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('double-mapped market');
  });

  test('a real partition (prior id already a DISTINCT new outcome) is NOT silently merged', () => {
    // Both `argentina` and `argentina_win` appear as new outcomes with the SAME
    // subject => a real subject collision, not drift; the union check must reject.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'dup subject across two new ids',
      grouping_kind: 'categorical_exclusive',
      canonical_event: '2026 World Cup Winner',
      outcome_set: [
        { outcome_id: 'argentina', label: 'Argentina', outcome_subject: 'Argentina' },
        { outcome_id: 'argentina_win', label: 'Argentina', outcome_subject: 'Argentina' },
      ],
      leg_mapping: [
        { outcome_id: 'argentina', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'argentina_win', platform: 'polymarket', market_id: 3 },
      ],
    };
    const v = validateMatch(r, reconcileCtx());
    expect(v.kind).toBe('reject');
  });
});

// numeric YES-region leg guard
describe('W1-E numeric YES-region leg guard', () => {
  /** Single shared-outcome xplat pair: 1 Kalshi + 1 PM market fused on one rung. */
  function singleRung(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'weather ladder rung',
      grouping_kind: 'threshold_series',
      outcome_set: [{ outcome_id: 'rung', label: 'rung', ordinal: 1 }],
      leg_mapping: [
        { outcome_id: 'rung', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'rung', platform: 'polymarket', market_id: 2 },
      ],
    };
  }
  function numCtx(
    a: { dir: string | null; vp: string | null; vs?: string | null; unit?: string | null; shape?: string | null; strike?: string | null },
    b: { dir: string | null; vp: string | null; vs?: string | null; unit?: string | null; shape?: string | null; strike?: string | null },
  ): MatchContext {
    return {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map([
        [1, { condition_direction: a.dir, condition_shape: a.shape ?? null, value_primary: a.vp, value_secondary: a.vs ?? null, value_unit: a.unit ?? 'fahrenheit', strike_type: a.strike ?? null }],
        [2, { condition_direction: b.dir, condition_shape: b.shape ?? null, value_primary: b.vp, value_secondary: b.vs ?? null, value_unit: b.unit ?? 'fahrenheit', strike_type: b.strike ?? null }],
      ]),
    };
  }

  test('q8912: Kalshi ">64°" (strict) fused with PM "74°F or higher" → reject (drops the only PM leg)', () => {
    const v = validateMatch(singleRung(), numCtx(
      { dir: 'above', vp: '64', strike: 'greater' },
      { dir: 'above', vp: '74' },
    ));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('numeric YES-region');
  });

  test('q9414: Kalshi "59-60°" fused with PM "58-59°F" (off-by-one bucket) → reject', () => {
    const v = validateMatch(singleRung(), numCtx(
      { dir: 'between', vp: '59', vs: '60', strike: 'between' },
      { dir: 'between', vp: '58', vs: '59' },
    ));
    expect(v.kind).toBe('reject');
  });

  test('q8721: Kalshi ">85°" fused with PM "86-87°F" (SUBSET, not equivalence) → reject', () => {
    const v = validateMatch(singleRung(), numCtx(
      { dir: 'above', vp: '85', strike: 'greater' },
      { dir: 'between', vp: '86', vs: '87' },
    ));
    expect(v.kind).toBe('reject');
  });

  test('representational tolerance: Kalshi "<74°" (strict) ≡ PM "73°F or below" → match, legs intact', () => {
    const r = singleRung();
    const v = validateMatch(r, numCtx(
      { dir: 'below', vp: '74', strike: 'less' },
      { dir: 'below', vp: '73' },
    ));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') expect(v.warnings.length).toBe(0);
    expect(r.leg_mapping!.length).toBe(2);
  });

  test('q27578: Kalshi "BTC between 79,500-79,750" fused with PM "reach $89,000" → reject', () => {
    const v = validateMatch(singleRung(), numCtx(
      { dir: 'between', vp: '79500', vs: '79750', unit: 'USD', shape: 'range_snapshot', strike: 'between' },
      { dir: 'above', vp: '89000', unit: 'USD', shape: 'monotonic_threshold' },
    ));
    expect(v.kind).toBe('reject');
  });

  test('touch vs snapshot: same bound, monotonic "reach 89k" vs point-in-time "above 89k at close" → reject', () => {
    const v = validateMatch(singleRung(), numCtx(
      { dir: 'above', vp: '89000', unit: 'USD', shape: 'point_in_time' },
      { dir: 'above', vp: '89000', unit: 'USD', shape: 'monotonic_threshold' },
    ));
    expect(v.kind).toBe('reject');
  });

  test('partial ladder: aligned rung survives, offset rung leg is DROPPED (match + warning + mutated mapping)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'two-rung ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'r50_51', label: '50-51', ordinal: 1 },
        { outcome_id: 'r52_53', label: '52-53', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'r50_51', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r50_51', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'r52_53', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'r52_53', platform: 'polymarket', market_id: 4 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map([
        [1, { condition_direction: 'between', condition_shape: 'range_snapshot', value_primary: '50', value_secondary: '51', value_unit: 'fahrenheit', strike_type: 'between' }],
        [2, { condition_direction: 'between', condition_shape: 'range_snapshot', value_primary: '50', value_secondary: '51', value_unit: 'fahrenheit', strike_type: null }],
        [3, { condition_direction: 'between', condition_shape: 'range_snapshot', value_primary: '52', value_secondary: '53', value_unit: 'fahrenheit', strike_type: 'between' }],
        // offset bucket — the LLM aligned by ordinal position:
        [4, { condition_direction: 'between', condition_shape: 'range_snapshot', value_primary: '53', value_secondary: '54', value_unit: 'fahrenheit', strike_type: null }],
      ]),
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('numeric YES-region leg drop'))).toBe(true);
    }
    // the offset PM leg (market 4) is gone; the aligned PM leg (market 2) survives.
    expect(r.leg_mapping!.length).toBe(3);
    expect(r.leg_mapping!.some((l) => l.market_id === 4)).toBe(false);
    expect(r.leg_mapping!.some((l) => l.market_id === 2)).toBe(true);
    expect(r.reasoning).toContain('numeric YES-region guard dropped 1');
  });

  test('NULL-tolerant: unshaped leg (no numeric facts) is never dropped', () => {
    const r = singleRung();
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map([
        [1, { condition_direction: 'above', condition_shape: null, value_primary: '64', value_secondary: null, value_unit: 'fahrenheit', strike_type: 'greater' }],
        // market 2 unshaped: all NULL.
        [2, { condition_direction: null, condition_shape: null, value_primary: null, value_secondary: null, value_unit: null, strike_type: null }],
      ]),
    };
    expect(validateMatch(r, c).kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(2);
  });

  test('guard absent (no marketNumeric) → prior behaviour, match', () => {
    const r = singleRung();
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });
});

// strict rung-line binding gate (threshold_series numeric rungs)
describe('A3 rung-line binding gate', () => {
  // Two numeric rungs 'over_3.5' + 'over_2.5' on a threshold ladder; each rung a
  // Kalshi + PM leg. A leg's line comes from marketNumeric (value_primary+direction
  // or native Kalshi strike). Slug line = parseRungLine(outcome_id).
  function ladder(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'goals ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'over_2.5', label: 'over 2.5', ordinal: 1 },
        { outcome_id: 'over_3.5', label: 'over 3.5', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'over_2.5', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'over_2.5', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'over_3.5', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'over_3.5', platform: 'polymarket', market_id: 4 },
      ],
    };
  }
  const num = (dir: string | null, vp: string | null, extra: Record<string, unknown> = {}) =>
    ({ condition_direction: dir, condition_shape: null, value_primary: vp, value_secondary: null, value_unit: 'goals', ...extra });

  test('(i) known 2.5 leg mis-bound onto over_3.5 is dropped; anchor kept', () => {
    const r = ladder();
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        [1, num('above', '2.5')],
        [2, num('above', '2.5')],
        [3, num('above', '3.5')],
        [4, num('above', '2.5')], // WRONG rung — a 2.5 leg bound to over_3.5
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.some((l) => l.market_id === 4)).toBe(false); // dropped
    expect(r.leg_mapping!.length).toBe(3);
  });

  test('(ii) unknown-line leg with a known-line sibling on the rung is dropped', () => {
    const r = ladder();
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        [1, num('above', '2.5')],
        [2, num('above', '2.5')],
        [3, num('above', '3.5')],           // known sibling of over_3.5
        [4, num(null, null)],               // unshaped PM leg on over_3.5, cross-platform
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.some((l) => l.market_id === 4)).toBe(false); // blind bind dropped
  });

  test('unknown-line leg with NO known sibling is kept (recall-safe)', () => {
    const r = ladder();
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        [1, num('above', '2.5')],
        [2, num('above', '2.5')],
        [3, num(null, null)],  // both legs of over_3.5 unshaped → no known sibling
        [4, num(null, null)],
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // nothing dropped
  });

  test('native Kalshi strike synthesizes the line when lmn is NULL', () => {
    const r = ladder();
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        // Kalshi rung on over_3.5, unshaped lmn but native strike greater floor=3.5 ≡ 3.5
        [3, { condition_direction: null, value_primary: null, value_unit: 'goals', strike_type: 'greater', floor_strike: '3.5' }],
        [4, num('above', '3.5')],
        // over_2.5 Kalshi native strike says 2.5 but bound to… correct here
        [1, { condition_direction: null, value_primary: null, value_unit: 'goals', strike_type: 'greater', floor_strike: '2.5' }],
        [2, num('above', '2.5')],
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // all correctly bound → nothing dropped
  });

  test('beltHit stage3_rung_line_gate fires on a drop', () => {
    resetBeltCensus();
    const r = ladder();
    validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        [1, num('above', '2.5')], [2, num('above', '2.5')],
        [3, num('above', '3.5')], [4, num('above', '2.5')],
      ]),
    });
    expect(beltCensus()['belt.stage3_rung_line_gate']).toBe(1);
  });

  test('non-numeric outcome slugs are untouched (opaque ids)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'opaque rungs',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'r_a', label: 'A', ordinal: 1 },
        { outcome_id: 'r_b', label: 'B', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'r_a', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r_a', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'r_b', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'r_b', platform: 'polymarket', market_id: 4 },
      ],
    };
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket']]),
      marketScope: new Map(),
      marketNumeric: new Map<number, any>([
        [1, num('above', '2.5')], [2, num(null, null)], // would (ii)-drop IF the slug were numeric
        [3, num('above', '3.5')], [4, num(null, null)],
      ]),
    });
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // opaque slug ⇒ A3 never fires
  });
});

// title-fallback for title-regex discriminators (predicate_grain)
describe('B1 title-fallback leg-coherence (enactment adopt≠use)', () => {
  // one 'utah' outcome fused across PM (use) + Kalshi (redistrict=adopt), both
  // UNSHAPED (no discriminators JSONB) — the fact lives only in the title.
  const PM_USE = 'Will Utah use a new congressional map for the 2026 elections?';
  const KALSHI_ADOPT = 'What states will redistrict before 2027?';

  function twoState(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'redistricting bundle',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [
        { outcome_id: 'utah', label: 'Utah' },
        { outcome_id: 'texas', label: 'Texas' },
      ],
      leg_mapping: [
        { outcome_id: 'utah', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'utah', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'texas', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'texas', platform: 'kalshi', market_id: 4 },
      ],
    };
  }
  const base = (titles: Map<number, string | null>, disc?: Map<number, Record<string, string>>): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketTitle: titles,
    marketEventKind: new Map(),
    marketDiscriminators: disc,
  });

  test('title-extracted use≠redistrict drops the Kalshi leg', () => {
    const r = twoState();
    const v = validateMatch(r, base(new Map([
      [1, PM_USE], [2, KALSHI_ADOPT],
      // texas pair is SAME-grain (both adopt) so only the utah cross-grain leg drops
      // (post-F13 redistrict is its own grain; a "Texas redistrict?" 4th leg would also
      // drop and gut the kalshi platform — not what this belt test is exercising).
      [3, 'Will Texas adopt a new map?'], [4, 'Will Texas adopt a new congressional map?'],
    ])));
    expect(v.kind).toBe('match');
    // utah's kalshi leg (market 2, redistrict) conflicts with the pm anchor (use) → dropped.
    expect(r.leg_mapping!.some((l) => l.market_id === 2)).toBe(false);
  });

  test('JSONB stamp wins over the title extraction', () => {
    const r = twoState();
    // market 2 title says redistrict(adopt) but the JSONB stamps use → agrees with
    // the pm anchor → NO drop (precedence proof).
    const v = validateMatch(r, base(
      new Map([[1, PM_USE], [2, KALSHI_ADOPT], [3, PM_USE], [4, KALSHI_ADOPT]]),
      new Map([[2, { predicate_grain: 'enactment:use' }]]),
    ));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.some((l) => l.market_id === 2)).toBe(true); // kept
  });

  test('verb-less titles → null grain → no refusal', () => {
    const r = twoState();
    const v = validateMatch(r, base(new Map([
      [1, 'Utah question'], [2, 'Utah other question'],
      [3, 'Texas question'], [4, 'Texas other question'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // no drops
  });

  test('Utah PAIR shape (2 legs only) → platform-gut REFUSE', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'utah pair',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [{ outcome_id: 'utah', label: 'Utah' }, { outcome_id: 'x', label: 'X' }],
      leg_mapping: [
        { outcome_id: 'utah', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'utah', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'x', platform: 'polymarket', market_id: 3 },
      ],
    };
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket']]),
      marketScope: new Map(),
      marketTitle: new Map([[1, PM_USE], [2, KALSHI_ADOPT], [3, 'X?']]),
      marketEventKind: new Map(),
    });
    // dropping the sole kalshi leg guts the kalshi platform → reject.
    expect(v.kind).toBe('reject');
  });

  test('same-grain adopt pair still merges (recall pin)', () => {
    // Post-F13 recall pin: two genuine ADOPT titles per outcome share enactment:adopt
    // → nothing dropped. (Pre-F13 this paired adopt with redistrict; F13 split
    // redistrict into its own grain, so the same-grain pin now uses two adopt titles.)
    const r = twoState();
    const v = validateMatch(r, base(new Map([
      [1, 'Will Alabama adopt a new congressional map?'], [2, 'Will Alabama adopt a new district map before 2027?'],
      [3, 'Will Texas adopt a new map?'], [4, 'Will Texas adopt a new congressional map?'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // both adopt → nothing dropped
  });
});

// subject-free outcome-id win-suffix fold
describe('C1 subject-free outcome-id fold', () => {
  test('{rapid_vienna (subject set), rapid_vienna_win (subject NULL)} merge', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'UECL fixture',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'rapid_vienna', label: 'Rapid Vienna', outcome_subject: 'Rapid Vienna' },
        { outcome_id: 'rapid_vienna_win', label: 'Rapid Vienna', outcome_subject: null },
        { outcome_id: 'santa_coloma', label: 'Santa Coloma', outcome_subject: 'FC Santa Coloma' },
      ],
      leg_mapping: [
        { outcome_id: 'rapid_vienna', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'rapid_vienna_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'santa_coloma', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'santa_coloma', platform: 'kalshi', market_id: 4 },
      ],
    };
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
      marketScope: new Map(),
    });
    expect(v.kind).toBe('match');
    // the drifting id folded away → one 'rapid_vienna' outcome carrying both legs.
    expect(r.outcome_set!.some((o) => o.outcome_id === 'rapid_vienna_win')).toBe(false);
    const rv = r.leg_mapping!.filter((l) => l.outcome_id === 'rapid_vienna');
    expect(rv.length).toBe(2);
  });

  test('market double-bound to both ids collapses to one binding', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'double-bound market',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'geng', label: 'Gen.G', outcome_subject: 'Gen.G' },
        { outcome_id: 'geng_win', label: 'Gen.G', outcome_subject: null },
        { outcome_id: 't1', label: 'T1', outcome_subject: 'T1' },
      ],
      leg_mapping: [
        { outcome_id: 'geng', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'geng_win', platform: 'polymarket', market_id: 1 }, // same market, both ids
        { outcome_id: 't1', platform: 'polymarket', market_id: 2 },
        { outcome_id: 't1', platform: 'kalshi', market_id: 3 },
      ],
    };
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'kalshi']]),
      marketScope: new Map(),
    });
    expect(v.kind).toBe('match');
    const geng = r.leg_mapping!.filter((l) => l.outcome_id === 'geng' && l.market_id === 1);
    expect(geng.length).toBe(1); // de-duped to one binding
  });
});

// weather station / oracle veto
describe('W1-E weather station veto', () => {
  const KALSHI_NYC_GENERIC =
    'If the minimum temperature recorded at New York City for May 13, 2026, is between 47-48° fahrenheit according to the National Weather Service’s Climatological Report (Daily), then the market resolves to Yes.';
  const PM_LAGUARDIA =
    'This market will resolve to the temperature range that contains the lowest temperature recorded at the LaGuardia Airport Station in degrees Fahrenheit on 13 May.\n\nThe resolution source for this market will be information from Wunderground, specifically the lowest temperature recorded for all times on this day by the Forecast for the LaGuardia Airport Station once information is finalized.';
  const KALSHI_CENTRAL_PARK =
    'If the minimum temperature recorded at Central Park, NY for May 13, 2026, is between 47-48° fahrenheit according to the National Weather Service’s Climatological Report (Daily), then the market resolves to Yes.';
  const PM_CENTRAL_PARK =
    'This market will resolve to the temperature range that contains the lowest temperature recorded at the Central Park Station in degrees Fahrenheit on 13 May. The resolution source for this market will be information from Wunderground.';

  function weatherPair(
    a: { text: string | null; subject: string | null },
    b: { text: string | null; subject: string | null },
  ): [EventMatchResult, MatchContext] {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'lowest temperature NYC',
      grouping_kind: 'threshold_series',
      outcome_set: [{ outcome_id: 'r47_48', label: '47-48', ordinal: 1 }],
      leg_mapping: [
        { outcome_id: 'r47_48', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r47_48', platform: 'polymarket', market_id: 2 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'weather_extreme'], [2, 'weather_extreme']]),
      marketWeather: new Map([[1, a], [2, b]]),
    };
    return [r, c];
  }

  test('NYC trap: Kalshi city-generic (NWS daily = Central Park) vs PM LaGuardia → reject', () => {
    const [r, c] = weatherPair(
      { text: KALSHI_NYC_GENERIC, subject: 'New York City' },
      { text: PM_LAGUARDIA, subject: 'New York City' },
    );
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('station');
  });

  test('two DIFFERENT named stations (Central Park vs LaGuardia) → reject', () => {
    const [r, c] = weatherPair(
      { text: KALSHI_CENTRAL_PARK, subject: 'Central Park, New York City' },
      { text: PM_LAGUARDIA, subject: 'New York City' },
    );
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('station');
  });

  test('SAME station (Central Park both sides) → match, with an inter-oracle basis-risk warning', () => {
    const [r, c] = weatherPair(
      { text: KALSHI_CENTRAL_PARK, subject: 'Central Park, New York City' },
      { text: PM_CENTRAL_PARK, subject: 'New York City' },
    );
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('oracle divergence'))).toBe(true);
    }
  });

  test('verbosity tolerance: "Austin-Bergstrom International Airport" vs "Austin Bergstrom Airport" → match', () => {
    const [r, c] = weatherPair(
      { text: 'If the maximum temperature recorded at Austin-Bergstrom International Airport, TX for May 13, 2026, is greater than 85° fahrenheit according to the National Weather Service, then the market resolves to Yes.', subject: 'Austin Bergstrom International Airport, Austin' },
      { text: 'This market will resolve to the temperature recorded at the Austin Bergstrom Airport Station in degrees Fahrenheit. The resolution source will be Wunderground.', subject: 'Austin' },
    );
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
  });

  test('"<City> International Airport" does NOT fold to the bare city: Denver Intl vs generic Denver → reject', () => {
    const [r, c] = weatherPair(
      { text: 'If the maximum temperature recorded at Denver, CO for May 13, 2026, is greater than 85° fahrenheit, then the market resolves to Yes.', subject: 'Denver' },
      { text: 'This market will resolve to the temperature recorded at the Denver International Airport Station in degrees Fahrenheit. The resolution source will be Wunderground.', subject: 'Denver' },
    );
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('both city-generic (no station named anywhere) → match (no discriminator)', () => {
    const [r, c] = weatherPair(
      { text: KALSHI_NYC_GENERIC, subject: 'New York City' },
      { text: 'If the minimum temperature recorded at New York City for May 14, 2026, is greater than 54° fahrenheit according to the National Weather Service’s Climatological Report (Daily), then the market resolves to Yes.', subject: 'New York City' },
    );
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('missing weather text on a side → unknown, never vetoes alone', () => {
    const [r, c] = weatherPair(
      { text: KALSHI_NYC_GENERIC, subject: 'New York City' },
      { text: null, subject: 'New York City' },
    );
    expect(validateMatch(r, c).kind).toBe('match');
  });
});

// outcome-label canonicalization fold
describe('W2-R1 canonicalOutcomeKey', () => {
  test('synonym family: btts variants fold to the canonical', () => {
    expect(canonicalOutcomeKey('btts', 'both teams to score')).toBe('both teams to score');
    expect(canonicalOutcomeKey('btts_yes', 'both teams to score')).toBe('both teams to score');
    expect(canonicalOutcomeKey('both_teams_to_score', 'both teams to score')).toBe('both teams to score');
    expect(canonicalOutcomeKey('Both Teams to Score', 'both teams to score')).toBe('both teams to score');
  });
  test('win-suffix folds onto the subject (exact + contiguous token run)', () => {
    expect(canonicalOutcomeKey('belgium_win', 'belgium')).toBe('belgium');
    expect(canonicalOutcomeKey('belgium wins', 'belgium')).toBe('belgium');
    expect(canonicalOutcomeKey('monaco_win', 'as monaco fc')).toBe('as monaco fc');
    expect(canonicalOutcomeKey('getafe_win', 'getafe cf')).toBe('getafe cf');
    expect(canonicalOutcomeKey('heidenheim_win', '1 fc heidenheim 1846')).toBe('1 fc heidenheim 1846');
  });
  test('a discriminator token outside the subject never folds away', () => {
    // 'map2'/'ht'/'group' are NOT subject tokens → key stays distinct.
    expect(canonicalOutcomeKey('geng_map2_win', 'gen g')).not.toBe('gen g');
    expect(canonicalOutcomeKey('belgium_ht_win', 'belgium')).not.toBe('belgium');
    expect(canonicalOutcomeKey('argentina_group_winner', 'argentina')).not.toBe('argentina');
    // 'winner' is deliberately NOT stripped (can be a different question).
    expect(canonicalOutcomeKey('belgium_winner', 'belgium')).not.toBe('belgium');
  });
  test('abbreviation drift is NOT folded (conservative)', () => {
    expect(canonicalOutcomeKey('us_win', 'united states')).toBe('us win');
    expect(canonicalOutcomeKey('usa_win', 'united states')).toBe('usa win');
  });
  test('null/empty tolerant', () => {
    expect(canonicalOutcomeKey(null, 'x')).toBeNull();
    expect(canonicalOutcomeKey('  ', 'x')).toBeNull();
    expect(canonicalOutcomeKey('a', null)).toBe('a');
  });
});

test('W2-R1: ONE_HOT_PARTITION_KINDS mirrors stage4 ONE_HOT_FIXTURE_KINDS exactly', () => {
  // guards.ts must stay import-light (no stage4 back-edge), so the set is
  // mirrored; this pin fails loudly if the stage4 source of truth drifts.
  expect([...ONE_HOT_PARTITION_KINDS].sort()).toEqual([...ONE_HOT_FIXTURE_KINDS].sort());
});

describe('W2-R1 §1 pair-local label-fold merge', () => {
  /** btts + both_teams_to_score declared as two outcomes of one fixture
   *  event, same subject. */
  function bttsMatch(): EventMatchResult {
    return {
      same_event: true, confidence: 0.93, reasoning: 'same fixture, btts + winner',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [
        { outcome_id: 'btts', label: 'BTTS', outcome_subject: 'both teams to score' },
        { outcome_id: 'both_teams_to_score', label: 'Both Teams to Score', outcome_subject: 'both teams to score' },
        { outcome_id: 'villa_win', label: 'Aston Villa', outcome_subject: 'Aston Villa' },
      ],
      leg_mapping: [
        { outcome_id: 'btts', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'both_teams_to_score', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'villa_win', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'villa_win', platform: 'kalshi', market_id: 4 },
      ],
    };
  }
  const mergeCtx = (over: Partial<MatchContext> = {}): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    ...over,
  });

  test('btts ≡ both_teams_to_score (live row class) → merged, match', () => {
    const r = bttsMatch();
    const v = validateMatch(r, mergeCtx());
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('label-fold merge'))).toBe(true);
    }
    expect(r.outcome_set!.length).toBe(2); // btts + villa_win
    // the kalshi leg re-keyed onto the first-declared outcome.
    expect(r.leg_mapping!.find((l) => l.market_id === 2)!.outcome_id).toBe('btts');
  });

  test('belgium ≡ belgium_win (subject-anchored win-suffix) → merged, match', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'WC winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'belgium', label: 'Belgium', outcome_subject: 'Belgium' },
        { outcome_id: 'belgium_win', label: 'Belgium wins', outcome_subject: 'Belgium' },
        { outcome_id: 'brazil', label: 'Brazil', outcome_subject: 'Brazil' },
      ],
      leg_mapping: [
        { outcome_id: 'belgium', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'belgium_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'brazil', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'brazil', platform: 'kalshi', market_id: 4 },
      ],
    };
    const v = validateMatch(r, mergeCtx());
    expect(v.kind).toBe('match');
    expect(r.outcome_set!.length).toBe(2);
    expect(r.leg_mapping!.find((l) => l.market_id === 2)!.outcome_id).toBe('belgium');
  });

  test('as_monaco_fc ≡ monaco_win (token-run anchor) → merged, match', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'ligue1 winner',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'as_monaco_fc', label: 'AS Monaco FC', outcome_subject: 'AS Monaco FC' },
        { outcome_id: 'monaco_win', label: 'Monaco', outcome_subject: 'AS Monaco FC' },
        { outcome_id: 'psg', label: 'PSG', outcome_subject: 'Paris Saint-Germain' },
      ],
      leg_mapping: [
        { outcome_id: 'as_monaco_fc', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'monaco_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'psg', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'psg', platform: 'kalshi', market_id: 4 },
      ],
    };
    const v = validateMatch(r, mergeCtx());
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.find((l) => l.market_id === 2)!.outcome_id).toBe('as_monaco_fc');
  });

  test('TRUE collision: non-foldable ids sharing one subject → still reject', () => {
    // value-label leak class: two genuinely different buckets stamped one subject.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'margin set',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'margin_1_5', label: '1-5', outcome_subject: 'margin of victory' },
        { outcome_id: 'margin_6_10', label: '6-10', outcome_subject: 'margin of victory' },
        { outcome_id: 'other', label: 'Other', is_residual: true },
      ],
      leg_mapping: [
        { outcome_id: 'margin_1_5', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'margin_6_10', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'other', platform: 'polymarket', market_id: 3 },
      ],
    };
    const v = validateMatch(r, mergeCtx());
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('shared by outcomes');
  });

  test('fold-equal but KNOWN-different ordinals → no merge, still reject (true collision)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'ordinal conflict',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'belgium', label: 'Belgium', outcome_subject: 'Belgium', ordinal: 1 },
        { outcome_id: 'belgium_win', label: 'Belgium', outcome_subject: 'Belgium', ordinal: 2 },
        { outcome_id: 'brazil', label: 'Brazil', outcome_subject: 'Brazil', ordinal: 3 },
      ],
      leg_mapping: [
        { outcome_id: 'belgium', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'belgium_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'brazil', platform: 'kalshi', market_id: 4 },
      ],
    };
    expect(validateMatch(r, mergeCtx()).kind).toBe('reject');
  });

  test('fold-equal but provably different metric_scope (Map-2 vs overall) → no merge, reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'map2 vs overall',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'geng', label: 'Gen.G', outcome_subject: 'Gen.G' },
        { outcome_id: 'geng_win', label: 'Gen.G wins', outcome_subject: 'Gen.G' },
        { outcome_id: 't1', label: 'T1', outcome_subject: 'T1' },
      ],
      leg_mapping: [
        { outcome_id: 'geng', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'geng_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 't1', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c = mergeCtx({ reconcileMetricScope: new Map([[1, 'game'], [2, 'map_2'], [4, 'game']]) });
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('abbreviation drift us_win vs usa_win → no merge, still reject (conservative)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'usa drift',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'us_win', label: 'US', outcome_subject: 'United States' },
        { outcome_id: 'usa_win', label: 'USA', outcome_subject: 'United States' },
        { outcome_id: 'canada', label: 'Canada', outcome_subject: 'Canada' },
      ],
      leg_mapping: [
        { outcome_id: 'us_win', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'usa_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'canada', platform: 'kalshi', market_id: 4 },
      ],
    };
    expect(validateMatch(r, mergeCtx()).kind).toBe('reject');
  });
});

// phantom-outcome demotion
describe('W2-R1 §2 phantom-outcome demotion', () => {
  /** 3 declared performers, one with no leg. */
  function halftime(): EventMatchResult {
    return {
      same_event: true, confidence: 0.92, reasoning: 'same 2026 WC halftime show',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'kendrick_lamar', label: 'Kendrick Lamar', outcome_subject: 'Kendrick Lamar' },
        { outcome_id: 'taylor_swift', label: 'Taylor Swift', outcome_subject: 'Taylor Swift' },
        { outcome_id: 'the_weeknd', label: 'The Weeknd', outcome_subject: 'The Weeknd' },
      ],
      leg_mapping: [
        // kendrick_lamar: declared, NO leg (the phantom).
        { outcome_id: 'taylor_swift', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'taylor_swift', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'the_weeknd', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'the_weeknd', platform: 'kalshi', market_id: 4 },
      ],
    };
  }
  /** ctx with the demotion-required guard meta present (award kinds, no values). */
  const demoteCtx = (over: Partial<MatchContext> = {}): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi'], [5, 'polymarket']]),
    marketScope: new Map(),
    marketEventKind: new Map([[1, 'award'], [2, 'award'], [3, 'award'], [4, 'award'], [5, 'award']]),
    marketNumeric: new Map(),
    ...over,
  });

  test('3-outcome WC-halftime fixture → 2-outcome NON-exhaustive match (phantom dropped)', () => {
    const r = halftime();
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.demotedNonExhaustive).toBe(true);
      expect(v.warnings.some((w) => w.includes('phantom-outcome drop') && w.includes('kendrick_lamar'))).toBe(true);
    }
    expect(r.outcome_set!.map((o) => o.outcome_id).sort()).toEqual(['taylor_swift', 'the_weeknd']);
    expect(r.reasoning).toContain('phantom-demoted');
    expect(r.reasoning).toContain('Σ≤1');
  });

  test('residual outcome is dropped WITH its legs (flagged) — the hasResidual arm must see nothing', () => {
    const r = halftime();
    r.outcome_set!.push({ outcome_id: 'other', label: 'Other', is_residual: true });
    r.leg_mapping!.push({ outcome_id: 'other', platform: 'polymarket', market_id: 5 });
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.demotedNonExhaustive).toBe(true);
      expect(v.warnings.some((w) => w.includes('residual drop') && w.includes('"other"'))).toBe(true);
    }
    // residual outcome + its leg gone: feed-A can neither see is_residual=true
    // nor re-detect the 'Other' label from a persisted leg.
    expect(r.outcome_set!.some((o) => o.outcome_id === 'other')).toBe(false);
    expect(r.leg_mapping!.some((l) => l.market_id === 5)).toBe(false);
  });

  test('label-detected residual (flag NOT set) is dropped too — mirrors feed-A re-detection', () => {
    const r = halftime();
    // is_residual=false but the label is what feed-A's detector classifies residual.
    r.outcome_set!.push({ outcome_id: 'any_other_artist', label: 'any other artist', outcome_subject: null });
    r.leg_mapping!.push({ outcome_id: 'any_other_artist', platform: 'polymarket', market_id: 5 });
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('match');
    expect(r.outcome_set!.some((o) => o.outcome_id === 'any_other_artist')).toBe(false);
    expect(r.leg_mapping!.some((l) => l.market_id === 5)).toBe(false);
  });

  test('phantom in a ≤2-outcome set → degenerate, reject as before', () => {
    const r = halftime();
    r.outcome_set = r.outcome_set!.slice(0, 2); // kendrick (phantom) + taylor
    r.leg_mapping = r.leg_mapping!.filter((l) => l.outcome_id === 'taylor_swift');
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') {
      expect(v.reason).toContain('phantom outcome');
      expect(v.reason).toContain('degenerate');
    }
  });

  test('one-hot fixture kind (phantom draw in a 1X2) → reject (negRisk Σ=1 arm not demotable)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'same fixture',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'sharks_win', label: 'Sharks', outcome_subject: 'Shanghai Sharks' },
        { outcome_id: 'ducks_win', label: 'Ducks', outcome_subject: 'Beijing Ducks' }, // phantom
        { outcome_id: 'draw', label: 'Draw' },
      ],
      leg_mapping: [
        { outcome_id: 'sharks_win', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'sharks_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'draw', platform: 'polymarket', market_id: 3 },
      ],
    };
    const c = demoteCtx({
      marketEventKind: new Map([[1, 'match_winner'], [2, 'match_winner'], [3, 'match_winner']]),
    });
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    // The phantom draw makes this a non-demotable one-hot fixture. Whether the
    // fixture-kind guard fires first or the survivor-containment guard (fewer than
    // 2 real outcomes would survive the phantom demotion) is an ordering detail —
    // both are CORRECT refusals of this set. Assert rejection + a correct guard
    // reason, not a pinned first-firing string.
    if (v.kind === 'reject') {
      expect(v.reason).toMatch(/one-hot fixture|fewer than 2 real outcomes|phantom outcome/);
    }
  });

  test('surviving legs carry numeric values → reject (tiling Σ=1 arm not demotable)', () => {
    const r = halftime();
    const c = demoteCtx({
      marketNumeric: new Map([
        [1, { condition_direction: 'between', condition_shape: null, value_primary: '5', value_secondary: '10', value_unit: 'points', strike_type: null }],
      ]),
    });
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('numeric values');
  });

  test('guard meta absent (flags off) → reject as before, no silent demotion', () => {
    const r = halftime();
    const c = demoteCtx({ marketEventKind: undefined, marketNumeric: undefined });
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('phantom outcome');
  });

  test('residual drop that would gut a platform → reject', () => {
    // the residual leg is kalshi's ONLY participation — dropping it guts kalshi.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.92, reasoning: 'halftime show',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'kendrick_lamar', label: 'Kendrick Lamar', outcome_subject: 'Kendrick Lamar' }, // phantom
        { outcome_id: 'taylor_swift', label: 'Taylor Swift', outcome_subject: 'Taylor Swift' },
        { outcome_id: 'the_weeknd', label: 'The Weeknd', outcome_subject: 'The Weeknd' },
        { outcome_id: 'other', label: 'Other', is_residual: true },
      ],
      leg_mapping: [
        { outcome_id: 'taylor_swift', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'the_weeknd', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'other', platform: 'kalshi', market_id: 2 },
      ],
    };
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('gut');
  });

  test('threshold_series phantom rung → reject as before', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.9, reasoning: 'ladder',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 't90', label: '>=90k', ordinal: 1 },
        { outcome_id: 't80', label: '>=80k', ordinal: 2 },
        { outcome_id: 't70', label: '>=70k', ordinal: 3 }, // phantom
      ],
      leg_mapping: [
        { outcome_id: 't90', platform: 'kalshi', market_id: 2 },
        { outcome_id: 't80', platform: 'polymarket', market_id: 1 },
      ],
    };
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('threshold_series not demotable');
  });

  test('bundle grouping: phantom dropped, no Σ demotion needed → match', () => {
    const r = halftime();
    r.grouping_kind = 'bundle_nonexclusive';
    // bundles need no guard meta (no outcome_set is built downstream).
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
      marketScope: new Map(),
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
    if (v.kind === 'match') expect(v.demotedNonExhaustive ?? false).toBe(false);
    expect(r.outcome_set!.some((o) => o.outcome_id === 'kendrick_lamar')).toBe(false);
  });

  test('no phantom → no demotion, behavior unchanged', () => {
    const r = halftime();
    r.leg_mapping!.push({ outcome_id: 'kendrick_lamar', platform: 'polymarket', market_id: 5 });
    const v = validateMatch(r, demoteCtx());
    expect(v.kind).toBe('match');
    if (v.kind === 'match') expect(v.demotedNonExhaustive ?? false).toBe(false);
    expect(r.outcome_set!.length).toBe(3);
  });
});

// Per-fused-outcome condition_date coherence
describe('P3 §1 per-leg condition_date coherence', () => {
  /** Single shared-rung xplat pair (the multi-day temperature-series shape). */
  function singleRung(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'NYC lowest temperature rung',
      grouping_kind: 'threshold_series',
      outcome_set: [{ outcome_id: 'r47_48', label: '47-48', ordinal: 1 }],
      leg_mapping: [
        { outcome_id: 'r47_48', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r47_48', platform: 'polymarket', market_id: 2 },
      ],
    };
  }
  function dateCtx(
    dates: Record<number, string | null>,
    kinds?: Record<number, string | null>,
  ): MatchContext {
    // marketPlatform derived from the dated markets (odd = kalshi, even = PM) so
    // the single-rung fixture stays one-child-per-platform (the single-outcome
    // collapse check counts ALL children, not just mapped legs).
    const ids = Object.keys(dates).map(Number);
    return {
      minConfidence: 0.6,
      marketPlatform: new Map(ids.map((id) => [id, id % 2 === 1 ? 'kalshi' : 'polymarket'])),
      marketScope: new Map(),
      marketDates: new Map(Object.entries(dates).map(([k, v]) => [Number(k), { condition_date: v, end_date: null }])),
      ...(kinds ? { marketEventKind: new Map(Object.entries(kinds).map(([k, v]) => [Number(k), v])) } : {}),
    };
  }

  test('day-13 fused with day-14 on one rung (multi-day series) → reject (drops the only PM leg)', () => {
    const v = validateMatch(singleRung(), dateCtx({ 1: '2026-05-13', 2: '2026-05-14' }));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('condition_date');
  });

  test('two-rung series: aligned rung survives, off-by-a-day leg is DROPPED (match + warning + mutated mapping)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'two-rung series',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'r1', label: 'rung 1', ordinal: 1 },
        { outcome_id: 'r2', label: 'rung 2', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'r1', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r1', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'r2', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'r2', platform: 'polymarket', market_id: 4 },
      ],
    };
    const v = validateMatch(r, dateCtx({ 1: '2026-05-13', 2: '2026-05-13', 3: '2026-05-13', 4: '2026-05-14' }));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('leg-coherence drop') && w.includes('condition_date'))).toBe(true);
    }
    expect(r.leg_mapping!.length).toBe(3);
    expect(r.leg_mapping!.some((l) => l.market_id === 4)).toBe(false);
    expect(r.leg_mapping!.some((l) => l.market_id === 2)).toBe(true);
    expect(r.reasoning).toContain('leg-coherence guard dropped 1');
  });

  test('same day, different time-of-day (non-candle) → match (day grain, mirrors member-cohesion)', () => {
    const r = singleRung();
    expect(validateMatch(r, dateCtx({ 1: '2026-05-13', 2: '2026-05-13T20:10:00Z' })).kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(2);
  });

  test('candle kinds: same day, different open hour → reject (exact-timestamp grain)', () => {
    const v = validateMatch(singleRung(), dateCtx(
      { 1: '2026-05-10T16:00:00Z', 2: '2026-05-10T17:00:00Z' },
      { 1: 'candle_direction', 2: 'candle_direction' },
    ));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('date');
  });

  // Fixture start-instant conflicts: a kalshi US-evening fixture's minute
  // stamp can be a UTC instant of the next local day, so its day key can equal
  // the next game's day key. Day equality must not be treated as agreement
  // when trusted instants diverge.
  function instantCtx(over: {
    dates: Record<number, { d: string; p: string; end?: string }>;
    kinds: Record<number, string>;
    sports?: Record<number, string>;
  }): MatchContext {
    return {
      minConfidence: 0.6,
      marketPlatform: new Map(Object.keys(over.dates).map((k) => [Number(k), Number(k) % 2 === 1 ? 'kalshi' : 'polymarket'])),
      marketScope: new Map(),
      marketDates: new Map(Object.entries(over.dates).map(([k, v]) =>
        [Number(k), { condition_date: v.d, condition_date_precision: v.p, end_date: v.end ?? null }])),
      marketEventKind: new Map(Object.entries(over.kinds).map(([k, v]) => [Number(k), v])),
      ...(over.sports ? { marketSport: new Map(Object.entries(over.sports).map(([k, v]) => [Number(k), v])) } : {}),
    };
  }

  test('kalshi UTC-evening minute stamp vs PM NEXT-day kickoff: day keys collide, instants reject', () => {
    // single shared rung, one leg per platform → the drop guts the PM side → reject
    const v = validateMatch(singleRung(), instantCtx({
      dates: {
        1: { d: '2026-07-21T02:40:00Z', p: 'minute' },                               // July-20 game + pad
        2: { d: '2026-07-21', p: 'day', end: '2026-07-21 23:40:00+00' },             // PM's July-21 game
      },
      kinds: { 1: 'match_total_metric', 2: 'match_total_metric' },
    }));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('per-leg date/metric_scope conflict');
    // two-rung shape: only the divergent leg drops, and the warning names the arm
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'two-rung totals',
      grouping_kind: 'threshold_series',
      outcome_set: [
        { outcome_id: 'r1', label: 'rung 1', ordinal: 1 },
        { outcome_id: 'r2', label: 'rung 2', ordinal: 2 },
      ],
      leg_mapping: [
        { outcome_id: 'r1', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'r1', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'r2', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'r2', platform: 'polymarket', market_id: 4 },
      ],
    };
    const v2 = validateMatch(r, instantCtx({
      dates: {
        1: { d: '2026-07-21T23:40:00Z', p: 'minute' },
        2: { d: '2026-07-21', p: 'day', end: '2026-07-21 23:40:00+00' },
        3: { d: '2026-07-21T02:40:00Z', p: 'minute' },                               // July-20 game + pad
        4: { d: '2026-07-21', p: 'day', end: '2026-07-21 23:40:00+00' },             // NEXT game
      },
      kinds: { 1: 'match_total_metric', 2: 'match_total_metric', 3: 'match_total_metric', 4: 'match_total_metric' },
    }));
    expect(v2.kind).toBe('match');
    if (v2.kind === 'match') {
      expect(v2.warnings.some((w) => w.includes('leg-coherence drop') && w.includes('fixture start instants diverge'))).toBe(true);
    }
    expect(r.leg_mapping!.length).toBe(3);
    expect(r.leg_mapping!.some((l) => l.market_id === 4)).toBe(false);
  });

  test('same game, instants within tolerance (no UTC rollover) → match', () => {
    const r = singleRung();
    const v = validateMatch(r, instantCtx({
      dates: {
        1: { d: '2026-07-21T23:40:00Z', p: 'minute' },
        2: { d: '2026-07-21', p: 'day', end: '2026-07-21 23:40:00+00' },
      },
      kinds: { 1: 'match_total_metric', 2: 'match_total_metric' },
    }));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(2);
  });

  test('ambiguous evening vs a NO-instant local day: prone sport rejects, non-prone abstains', () => {
    const shape = (sport: string) => instantCtx({
      dates: {
        1: { d: '2026-07-21T02:40:00Z', p: 'minute' },
        2: { d: '2026-07-21', p: 'day' },                       // no kickoff end_date
      },
      kinds: { 1: 'match_total_metric', 2: 'match_total_metric' },
      sports: { 1: sport, 2: sport },
    });
    const prone = validateMatch(singleRung(), shape('baseball'));
    expect(prone.kind).toBe('reject');
    if (prone.kind === 'reject') expect(prone.reason).toContain('per-leg date/metric_scope conflict');
    // esports/soccer keep their validated Asia-morning merges
    expect(validateMatch(singleRung(), shape('esports')).kind).toBe('match');
  });

  test('candle kinds: naive vs zoned SAME instant → match (naive anchored UTC)', () => {
    const v = validateMatch(singleRung(), dateCtx(
      { 1: '2026-05-10T16:00:00', 2: '2026-05-10T16:00:00Z' },
      { 1: 'candle_direction', 2: 'candle_direction' },
    ));
    expect(v.kind).toBe('match');
  });

  test('NULL-tolerant: one leg without condition_date is never dropped', () => {
    const r = singleRung();
    expect(validateMatch(r, dateCtx({ 1: '2026-05-13', 2: null })).kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(2);
  });

  test('guard absent (no marketDates) → prior behaviour, match', () => {
    const r = singleRung();
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('sync-pin: verdicts agree with member-cohesion memberPairConflict on the same date pairs', () => {
    // The day-grain / exact-timestamp helpers are MIRRORED from member-cohesion
    // (stage3→stage4 import is backwards) — pin the behaviour so drift fails loudly.
    const facts = (market_id: number, condition_date: string, event_kind: string | null): MemberFacts => ({
      market_id, platform: market_id % 2 === 1 ? 'kalshi' : 'polymarket',
      title: null, platform_event_id: null, event_kind,
      condition_direction: null, value_primary: null, value_secondary: null, value_unit: null,
      condition_date,
    });
    const cases: { a: string; b: string; kind: string | null; agree: boolean }[] = [
      { a: '2026-05-13', b: '2026-05-13T20:10:00Z', kind: null, agree: true },
      { a: '2026-05-13', b: '2026-05-14', kind: null, agree: false },
      { a: '2026-05-10T16:00:00', b: '2026-05-10T16:00:00Z', kind: 'candle_direction', agree: true },
      { a: '2026-05-10T16:00:00Z', b: '2026-05-10T17:00:00Z', kind: 'candle_direction', agree: false },
    ];
    for (const tc of cases) {
      const cohesion = memberPairConflict(facts(1, tc.a, tc.kind), facts(2, tc.b, tc.kind));
      expect(cohesion === null).toBe(tc.agree);
      const guard = validateMatch(singleRung(), dateCtx(
        { 1: tc.a, 2: tc.b },
        tc.kind ? { 1: tc.kind, 2: tc.kind } : undefined,
      ));
      expect(guard.kind === 'match').toBe(tc.agree);
    }
  });
});

// Fresh-pair per-fused-outcome metric_scope refusal
describe('P3 §2 fresh-pair metric_scope leg guard', () => {
  /** A fresh pair (no priorLegs) fusing a map-2 winner leg with an
   *  overall-match winner leg on one outcome, same event_kind. */
  function esportsPair(): EventMatchResult {
    return {
      same_event: true, confidence: 0.95, reasoning: 'Gen.G vs T1',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'geng', label: 'Gen.G', outcome_subject: 'Gen.G' },
        { outcome_id: 't1', label: 'T1', outcome_subject: 'T1' },
      ],
      leg_mapping: [
        { outcome_id: 'geng', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'geng', platform: 'polymarket', market_id: 2 },
        { outcome_id: 't1', platform: 'kalshi', market_id: 3 },
        { outcome_id: 't1', platform: 'polymarket', market_id: 4 },
      ],
    };
  }
  const scopeCtx = (scopes: Record<number, string | null>, over: Partial<MatchContext> = {}): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'kalshi'], [2, 'polymarket'], [3, 'kalshi'], [4, 'polymarket'], [5, 'polymarket']]),
    marketScope: new Map(),
    reconcileMetricScope: new Map(Object.entries(scopes).map(([k, v]) => [Number(k), v])),
    ...over,
  });

  test('fresh pair fusing map_2 + game legs on one outcome → reject (drop guts the PM side)', () => {
    const v = validateMatch(esportsPair(), scopeCtx({ 1: 'game', 2: 'map_2', 3: 'game', 4: 'map_2' }));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('metric_scope');
  });

  test('map_2 leg dropped, platform survives via another leg → match + warning + mutated mapping', () => {
    const r = esportsPair();
    // extra PM leg on the SAME outcome with the matching overall scope — the
    // map_2 PM leg drops but polymarket keeps participating.
    r.leg_mapping!.push({ outcome_id: 'geng', platform: 'polymarket', market_id: 5 });
    const v = validateMatch(r, scopeCtx({ 1: 'game', 2: 'map_2', 3: 'game', 4: 'game', 5: 'game' }));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('leg-coherence drop') && w.includes('metric_scope'))).toBe(true);
    }
    expect(r.leg_mapping!.some((l) => l.market_id === 2)).toBe(false);
    expect(r.leg_mapping!.some((l) => l.market_id === 5)).toBe(true);
    expect(r.reasoning).toContain('leg-coherence guard dropped 1');
  });

  test('NULL-tolerant: unknown scope on one side never drops', () => {
    const r = esportsPair();
    expect(validateMatch(r, scopeCtx({ 1: 'game', 2: null, 3: 'game', 4: null })).kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('equal known scopes → match, no warnings', () => {
    const v = validateMatch(esportsPair(), scopeCtx({ 1: 'game', 2: 'game', 3: 'game', 4: 'game' }));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') expect(v.warnings.length).toBe(0);
  });
});

// deadline_window_iso deterministic verification
describe('P3 §3 deadline_window verification', () => {
  function windowed(win: [string, string]): EventMatchResult {
    const r = validCategorical();
    r.deadline_window_iso = win;
    return r;
  }
  /** marketDates ctx over the validCategorical legs (1,2 = trump; 3,4 = vance). */
  const winCtx = (
    dates: Record<number, { condition_date: string | null; end_date?: string | null }>,
  ): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketDates: new Map(Object.entries(dates).map(([k, v]) => [Number(k), { end_date: null, ...v }])),
  });
  const sameDay = (d: string) => ({
    1: { condition_date: d }, 2: { condition_date: d }, 3: { condition_date: d }, 4: { condition_date: d },
  });

  test('window contains member dates → kept as claimed', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const v = validateMatch(r, winCtx(sameDay('2026-06-13')));
    expect(v.kind).toBe('match');
    expect(r.deadline_window_iso).toEqual(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    if (v.kind === 'match') expect(v.warnings.length).toBe(0);
  });

  test('member date beyond window end +2d → window NULLed, match kept, warning logged', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const v = validateMatch(r, winCtx(sameDay('2026-06-20')));
    expect(v.kind).toBe('match');
    expect(r.deadline_window_iso).toBeUndefined();
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('deadline-window verification failed'))).toBe(true);
    }
  });

  test('member date before window start −2d → window NULLed', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    validateMatch(r, winCtx(sameDay('2026-06-01')));
    expect(r.deadline_window_iso).toBeUndefined();
  });

  test('±2 day tolerance: member 1.5 days past the end → kept', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const v = validateMatch(r, winCtx(sameDay('2026-06-16T12:00:00Z')));
    expect(v.kind).toBe('match');
    expect(r.deadline_window_iso).toBeDefined();
  });

  test('inverted window (lo > hi) → NULLed', () => {
    const r = windowed(['2026-06-15T00:00:00Z', '2026-06-12T00:00:00Z']);
    validateMatch(r, winCtx(sameDay('2026-06-13')));
    expect(r.deadline_window_iso).toBeUndefined();
  });

  test('unparseable window bounds → NULLed', () => {
    const r = windowed(['next Tuesday-ish', '2026-06-15T00:00:00Z']);
    validateMatch(r, winCtx(sameDay('2026-06-13')));
    expect(r.deadline_window_iso).toBeUndefined();
  });

  test('no member date known → vacuously kept (nothing to verify)', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const v = validateMatch(r, winCtx({
      1: { condition_date: null }, 2: { condition_date: null },
      3: { condition_date: null }, 4: { condition_date: null },
    }));
    expect(v.kind).toBe('match');
    expect(r.deadline_window_iso).toBeDefined();
  });

  test('end_date is the LAST-RESORT member date: used when condition_date is NULL', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    validateMatch(r, winCtx({
      1: { condition_date: null, end_date: '2026-07-30T00:00:00Z' },
      2: { condition_date: null, end_date: '2026-07-30T00:00:00Z' },
      3: { condition_date: null, end_date: '2026-07-30T00:00:00Z' },
      4: { condition_date: null, end_date: '2026-07-30T00:00:00Z' },
    }));
    expect(r.deadline_window_iso).toBeUndefined();
  });

  test('a known condition_date SHADOWS a padded end_date (no false NULLing)', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const v = validateMatch(r, winCtx({
      1: { condition_date: '2026-06-13', end_date: '2026-07-30T00:00:00Z' },
      2: { condition_date: '2026-06-13', end_date: '2026-07-30T00:00:00Z' },
      3: { condition_date: '2026-06-13', end_date: '2026-07-30T00:00:00Z' },
      4: { condition_date: '2026-06-13', end_date: '2026-07-30T00:00:00Z' },
    }));
    expect(v.kind).toBe('match');
    expect(r.deadline_window_iso).toBeDefined();
  });

  test('marketDates absent → window untouched (cannot verify, keep as claimed)', () => {
    const r = windowed(['2026-06-12T00:00:00Z', '2026-06-15T00:00:00Z']);
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
      marketScope: new Map(),
    };
    expect(validateMatch(r, c).kind).toBe('match');
    expect(r.deadline_window_iso).toBeDefined();
  });
});

// subject-coherence leg guard (off-by-one rotation merge)
describe('RC3 subject-coherence leg guard', () => {
  // An NBA-MVP-style merge: the "Cade Cunningham" outcome carries a predict leg
  // (correct, NULL marketSubject) AND a Kalshi sibling whose yes_sub_title resolved
  // to a DIFFERENT person (Victor Wembanyama) — the rotation mis-pair.
  function rotated(): EventMatchResult {
    return {
      same_event: true,
      confidence: 0.95,
      reasoning: 'predict per-candidate ↔ Kalshi MVP siblings',
      canonical_event: '2026 NBA MVP',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'cade', label: 'Cade Cunningham', outcome_subject: 'Cade Cunningham' },
        { outcome_id: 'jokic', label: 'Nikola Jokic', outcome_subject: 'Nikola Jokic' },
      ],
      leg_mapping: [
        { outcome_id: 'cade', platform: 'predict', market_id: 1 },  // correct candidate
        { outcome_id: 'cade', platform: 'kalshi', market_id: 2 },   // WRONG sibling (Wembanyama)
        { outcome_id: 'jokic', platform: 'predict', market_id: 3 },
        { outcome_id: 'jokic', platform: 'kalshi', market_id: 4 },  // WRONG sibling (SGA)
      ],
    };
  }
  const rotCtx = (subj: Map<number, string | null>): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'predict'], [2, 'kalshi'], [3, 'predict'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketSubject: subj,
  });

  test('drops a single mis-paired Kalshi leg (partial contamination; kalshi survives)', () => {
    // 'cade' outcome carries a WRONG Kalshi sibling (Wembanyama); 'jokic' outcome
    // carries the CORRECT Kalshi sibling (Jokic). The wrong leg (mkt 2) is dropped;
    // the correct one (mkt 4) keeps kalshi present → match, not a gut-reject.
    const r = rotated();
    const v = validateMatch(r, rotCtx(new Map([
      [1, null], [2, 'Victor Wembanyama'], [3, null], [4, 'Nikola Jokic'],
    ])));
    expect(v.kind).toBe('match');
    const kept = new Set(r.leg_mapping!.map((l) => l.market_id));
    expect(kept.has(1)).toBe(true);  // predict Cade kept
    expect(kept.has(3)).toBe(true);  // predict Jokic kept
    expect(kept.has(4)).toBe(true);  // correct Kalshi Jokic kept
    expect(kept.has(2)).toBe(false); // wrong Kalshi (Wembanyama) dropped
  });

  test('subtractive: a CORRECTLY-paired Kalshi sibling survives (no false drop)', () => {
    const r = rotated();
    const v = validateMatch(r, rotCtx(new Map([
      [1, null], [2, 'Cade Cunningham'], [3, null], [4, 'Nikola Jokic'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4); // nothing dropped
  });

  test('alias-tolerant: FaZe ≡ FaZe Clan does NOT drop', () => {
    const r = rotated();
    r.outcome_set![0].outcome_subject = 'FaZe';
    r.outcome_set![1].outcome_subject = 'Natus Vincere';
    const v = validateMatch(r, rotCtx(new Map([
      [1, null], [2, 'FaZe Clan'], [3, null], [4, 'Natus Vincere'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('NULL-tolerant: unknown subjects on both legs never conflict', () => {
    const r = rotated();
    const v = validateMatch(r, rotCtx(new Map([[1, null], [2, null], [3, null], [4, null]])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('rejects the pair when the subject-drop would gut every leg of a platform', () => {
    // both Kalshi siblings are mis-paired → dropping them removes the ENTIRE kalshi
    // side across the whole match → no cross-platform pairing remains → reject
    // (mirrors the W1-E numeric guard's gut-reject; a zero-leg side must not bind).
    const r = rotated();
    const v = validateMatch(r, rotCtx(new Map([
      [1, null], [2, 'Victor Wembanyama'], [3, null], [4, 'Shai Gilgeous-Alexander'],
    ])));
    expect(v.kind).toBe('reject');
  });
});

// native-label leg-coherence guard: catches a positional mis-map over
// identical sibling titles. Distinct from RC3 above: it keys on the
// platform-native label (groupItemTitle/yes_sub_title/condition_value),
// which is the only discriminator when the offending leg has no Stage-1 subject.
describe('FIX ④ native-label leg-coherence guard', () => {
  // A Kalshi market whose native label is "Washington" is assigned to the
  // "Las Vegas Raiders" outcome (mapped by position). The PM Raiders leg is
  // correct.
  function nextTeam(): EventMatchResult {
    return {
      same_event: true,
      confidence: 0.95,
      reasoning: 'Maxx Crosby next team',
      canonical_event: 'Maxx Crosby next team',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'raiders', label: 'Raiders', outcome_subject: 'Las Vegas Raiders' },
        { outcome_id: 'commanders', label: 'Commanders', outcome_subject: 'Washington Commanders' },
      ],
      leg_mapping: [
        { outcome_id: 'raiders', platform: 'polymarket', market_id: 1 },   // correct
        { outcome_id: 'raiders', platform: 'kalshi', market_id: 2 },        // WRONG: native "Washington"
        { outcome_id: 'commanders', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'commanders', platform: 'kalshi', market_id: 4 },     // correct: native "Washington"
      ],
    };
  }
  const ncCtx = (native: Map<number, string | null>): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketNativeLabel: native,
  });

  test('drops the leg whose native label ≠ its assigned outcome subject (1128)', () => {
    const r = nextTeam();
    const v = validateMatch(r, ncCtx(new Map([
      [1, null], [2, 'Washington'], [3, null], [4, 'Washington'],
    ])));
    expect(v.kind).toBe('match');
    const kept = new Set(r.leg_mapping!.map((l) => l.market_id));
    expect(kept.has(2)).toBe(false); // Kalshi "Washington" wrongly on Raiders → dropped
    expect(kept.has(4)).toBe(true);  // Kalshi "Washington" correctly on Commanders → kept
    expect(kept.has(1)).toBe(true);
    expect(kept.has(3)).toBe(true);
  });

  test('subtractive: a native label that AGREES with its outcome never drops', () => {
    const r = nextTeam();
    const v = validateMatch(r, ncCtx(new Map([
      [1, null], [2, 'Las Vegas Raiders'], [3, null], [4, 'Washington'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('alias-tolerant: token-run containment does NOT drop (Raiders ≡ Las Vegas Raiders)', () => {
    const r = nextTeam();
    const v = validateMatch(r, ncCtx(new Map([
      [1, null], [2, 'Raiders'], [3, null], [4, 'Commanders'],
    ])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('NULL-tolerant: unknown native label never conflicts', () => {
    const r = nextTeam();
    const v = validateMatch(r, ncCtx(new Map([[1, null], [2, null], [3, null], [4, null]])));
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('flag-off parity: absent marketNativeLabel → guard skipped (no drop)', () => {
    const r = nextTeam();
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
      marketScope: new Map(),
      // marketNativeLabel omitted (flag OFF)
    };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('rejects the pair when native-label drops gut a whole platform', () => {
    // both Kalshi legs carry a native label that disagrees with their outcome → the
    // entire kalshi side is dropped → no cross-platform pairing remains → reject.
    const r = nextTeam();
    const v = validateMatch(r, ncCtx(new Map([
      [1, null], [2, 'Washington'], [3, null], [4, 'Las Vegas Raiders'],
    ])));
    expect(v.kind).toBe('reject');
  });
});

// settlement-equivalence idiom bridge (native-label + RC3 folds)
// The leg-coherence guards drop a leg whose native label / subject folds to a
// different string than its outcome's subject. The idiom bridge re-arms the leg
// when the two spellings are the same settlement outcome (tie<->draw, nrfi<->no-run,
// o/u<->total over/under). These tests prove the leg is kept end-to-end through
// validateMatch, and that the soundness gates (cricket / scope / cross-bucket /
// direction) still drop.
describe('S3B P2b idiom bridge — native-label draw/tie', () => {
  // A soccer 1X2 categorical where the Draw outcome carries a PM leg (native "draw")
  // and a Kalshi sibling (native "tie") — the same drawn-match outcome spelled two
  // ways. Without the bridge the "tie" leg drops; with it, kept.
  function drawFixture(): EventMatchResult {
    return {
      same_event: true,
      confidence: 0.95,
      reasoning: 'Arsenal vs Chelsea 1X2',
      canonical_event: 'Arsenal vs Chelsea',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'draw', label: 'Draw', outcome_subject: 'Draw' },
        { outcome_id: 'arsenal', label: 'Arsenal', outcome_subject: 'Arsenal' },
        { outcome_id: 'chelsea', label: 'Chelsea', outcome_subject: 'Chelsea' },
      ],
      leg_mapping: [
        { outcome_id: 'draw', platform: 'polymarket', market_id: 1 },  // native "draw"
        { outcome_id: 'draw', platform: 'kalshi', market_id: 2 },       // native "tie" — bridge target
        { outcome_id: 'arsenal', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'chelsea', platform: 'kalshi', market_id: 4 },
      ],
    };
  }
  const idiomCtx = (sport: string | null, scope?: Map<number, string | null>): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: scope ?? new Map(),
    marketSport: new Map([[1, sport], [2, sport], [3, sport], [4, sport]]),
    marketEventKind: new Map([[1, 'match_winner'], [2, 'match_winner'], [3, 'match_winner'], [4, 'match_winner']]),
    marketNativeLabel: new Map([[1, 'draw'], [2, 'tie'], [3, 'Arsenal'], [4, 'Chelsea']]),
  });

  test('KEEPS the "tie" leg on the Draw outcome in a soccer fixture (bridge)', () => {
    const r = drawFixture();
    const v = validateMatch(r, idiomCtx('soccer'));
    expect(v.kind).toBe('match');
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(true); // NOT dropped
    expect(r.leg_mapping!.length).toBe(4);
  });

  test('CRICKET: "tie" leg still drops (tie ≠ draw in test cricket)', () => {
    const r = drawFixture();
    const v = validateMatch(r, idiomCtx('cricket'));
    expect(v.kind).toBe('match'); // kalshi survives via m4 (Chelsea) → drop, not gut-reject
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(false); // dropped
  });

  test('SCOPE: at incl_overtime there is no tie slot → leg still drops', () => {
    const r = drawFixture();
    const v = validateMatch(r, idiomCtx('soccer', new Map([[2, 'incl_overtime']])));
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(false);
  });

  test('KIND: non-draw-axis kind (award_winner) → leg still drops', () => {
    const r = drawFixture();
    const c = idiomCtx('soccer');
    c.marketEventKind = new Map([[1, 'award_winner'], [2, 'award_winner'], [3, 'award_winner'], [4, 'award_winner']]);
    const v = validateMatch(r, c);
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(false);
  });
});

describe('S3B P2b idiom bridge — native-label NRFI + O/U', () => {
  function twoOutcome(nativeA: string, nativeB: string, subjA: string, subjB: string): EventMatchResult {
    return {
      same_event: true,
      confidence: 0.95,
      reasoning: 'nrfi / ou cross-platform',
      canonical_event: 'Yankees vs Red Sox',
      grouping_kind: 'bundle_nonexclusive',
      outcome_set: [
        { outcome_id: 'a', label: subjA, outcome_subject: subjA },
        { outcome_id: 'b', label: subjB, outcome_subject: subjB },
      ],
      leg_mapping: [
        { outcome_id: 'a', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'a', platform: 'kalshi', market_id: 2 },   // native to compare vs subjA
        { outcome_id: 'b', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'b', platform: 'kalshi', market_id: 4 },
      ],
    };
  }
  const c = (n1: string, n2: string): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketNativeLabel: new Map([[1, null], [2, n1], [3, null], [4, n2]]),
  });

  test('NRFI same-bucket: "nrfi" leg kept on a "no run first inning" outcome', () => {
    const r = twoOutcome('nrfi', 'yes', 'no run first inning', 'yes');
    const v = validateMatch(r, c('nrfi', 'yes'));
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(true);
  });

  test('NRFI cross-bucket BLOCK: "nrfi" leg dropped from a YRFI outcome (polarity)', () => {
    const r = twoOutcome('nrfi', 'yes', 'will there be a run scored in the first inning', 'yes');
    const v = validateMatch(r, c('nrfi', 'yes'));
    expect(v.kind).toBe('match'); // kalshi m4 keeps the platform present
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(false); // dropped
  });

  test('O/U two-sided descriptor: "o u 2 5" leg kept on "total goals over under 2 5"', () => {
    const r = twoOutcome('o u 2 5', 'o u 3 5', 'total goals over under 2 5', 'total goals over under 3 5');
    const v = validateMatch(r, c('o u 2 5', 'o u 3 5'));
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(true);
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(4)).toBe(true);
  });

  test('O/U direction BLOCK: two-sided "o u 2 5" dropped from a one-sided "over 2 5" outcome', () => {
    const r = twoOutcome('o u 2 5', 'yes', 'total goals over 2 5', 'yes');
    const v = validateMatch(r, c('o u 2 5', 'yes'));
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(false);
  });
});

describe('S3B P2b idiom bridge — RC3 subject-coherence draw/tie', () => {
  // The RC3 guard keys on per-market Stage-1 canonical_subject. A Kalshi leg whose
  // subject is "tie" assigned to the "draw" outcome must be KEPT (settlement-equiv).
  test('keeps a "tie"-subject leg on the "draw" outcome (soccer)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'x',
      canonical_event: 'Arsenal vs Chelsea', grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'draw', label: 'Draw', outcome_subject: 'Draw' },
        { outcome_id: 'arsenal', label: 'Arsenal', outcome_subject: 'Arsenal' },
      ],
      leg_mapping: [
        { outcome_id: 'draw', platform: 'predict', market_id: 1 },   // subject NULL
        { outcome_id: 'draw', platform: 'kalshi', market_id: 2 },    // subject "tie"
        { outcome_id: 'arsenal', platform: 'predict', market_id: 3 },
        { outcome_id: 'arsenal', platform: 'kalshi', market_id: 4 },
      ],
    };
    const v = validateMatch(r, {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'predict'], [2, 'kalshi'], [3, 'predict'], [4, 'kalshi']]),
      marketScope: new Map(),
      marketSport: new Map([[1, 'soccer'], [2, 'soccer'], [3, 'soccer'], [4, 'soccer']]),
      marketEventKind: new Map([[1, 'match_winner'], [2, 'match_winner'], [3, 'match_winner'], [4, 'match_winner']]),
      marketSubject: new Map([[1, null], [2, 'tie'], [3, null], [4, 'Arsenal']]),
    });
    expect(v.kind).toBe('match');
    expect(new Set(r.leg_mapping!.map((l) => l.market_id)).has(2)).toBe(true);
  });
});

// Cross-fixture NULL-date categorical bridge guard: a NULL-date single-team
// bridge platform-event can accrete ≥2 different fixtures into one
// categorical_exclusive set, asserting the draws of different matches
// mutually exclusive. The guard rejects only on positive two-sided evidence
// (differing known dates at the coarser precision, or ≥2 provably distinct
// parsed fixtures); NULLs never reject.
import { parseFixtureParticipants, countDistinctFixtures } from './guards.js';

describe('DW-20 parseFixtureParticipants', () => {
  test('parses "A vs B" / "A v B" / "A vs. B" into normalized participants', () => {
    expect(parseFixtureParticipants('Arsenal vs Chelsea')).toEqual(['arsenal', 'chelsea']);
    expect(parseFixtureParticipants('Arsenal v Chelsea')).toEqual(['arsenal', 'chelsea']);
    expect(parseFixtureParticipants('Manchester City FC vs. Crystal Palace FC')).toEqual([
      'manchester city fc', 'crystal palace fc',
    ]);
  });
  test('non-fixture / ambiguous shapes return null (never evidence)', () => {
    expect(parseFixtureParticipants(null)).toBeNull();
    expect(parseFixtureParticipants('US CPI in May')).toBeNull();
    expect(parseFixtureParticipants('A vs B vs C')).toBeNull();
  });
});

describe('DW-20 countDistinctFixtures', () => {
  const f = (a: string, b: string, raw?: string) =>
    ({ participants: [a, b] as [string, string], raw: raw ?? `${a} vs ${b}` });
  test('alias drift + order-insensitivity collapse to ONE fixture (live SE-890/848/860 class)', () => {
    expect(countDistinctFixtures([
      f('bay fc', 'boston legacy'),
      f('boston legacy fc', 'bay'),
      f('bay fc', 'boston legacy fc'),
    ]).count).toBe(1);
    expect(countDistinctFixtures([
      f('crystal palace', 'manchester city'),
      f('crystal palace', 'manchester city first half'),
    ]).count).toBe(1);
  });
  test('shared team, different opponent → TWO fixtures', () => {
    const r = countDistinctFixtures([
      f('arsenal', 'chelsea'),
      f('arsenal', 'tottenham hotspur'),
    ]);
    expect(r.count).toBe(2);
    expect(r.samples.length).toBe(2);
  });
});

describe('DW-20 cross-fixture categorical bridge guard (validateMatch)', () => {
  // A soccer 1X2 categorical (home/away/draw), all legs fixture-kind.
  function fixture1x2(ce: string | null, date: string | null, prec: string | null = null): {
    r: EventMatchResult; c: MatchContext;
  } {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'soccer 1X2',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'arsenal', label: 'Arsenal', outcome_subject: 'Arsenal FC' },
        { outcome_id: 'chelsea', label: 'Chelsea', outcome_subject: 'Chelsea FC' },
        { outcome_id: 'draw', label: 'Draw', outcome_subject: null },
      ],
      leg_mapping: [
        { outcome_id: 'arsenal', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'chelsea', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'draw', platform: 'kalshi', market_id: 3 },
      ],
    };
    const c: MatchContext = {
      minConfidence: 0.6,
      marketPlatform: new Map([[1, 'polymarket'], [2, 'polymarket'], [3, 'kalshi']]),
      marketScope: new Map(),
      marketEventKind: new Map([[1, 'match_winner'], [2, 'match_winner'], [3, 'match_winner']]),
      marketCanonicalEvent: new Map([[1, ce], [2, ce], [3, ce]]),
      marketDates: new Map([1, 2, 3].map((id) => [id, { condition_date: date, condition_date_precision: prec }])),
    };
    return { r, c };
  }
  // A prior draw leg already bound to the SE (subject-null → no M-EXPAND-1 interplay).
  const priorDrawLeg = (ce: string | null, date: string | null, prec: string | null = null) => [{
    outcome_id: 'draw', outcome_subject: null, market_id: 20,
    event_kind: 'match_winner', market_canonical_event: ce,
    condition_date: date, condition_date_precision: prec,
  }];

  test('two fixtures bridged across expansion (dates differ) → reject', () => {
    const { r, c } = fixture1x2('Arsenal vs Tottenham Hotspur', '2026-05-17');
    c.priorLegs = priorDrawLeg('Arsenal vs Chelsea', '2026-05-10');
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('cross-fixture bridge');
  });

  test('two SAME-DAY fixtures bridged (participants differ, dates equal) → reject', () => {
    const { r, c } = fixture1x2('Arsenal vs Tottenham Hotspur', '2026-05-10');
    c.priorLegs = priorDrawLeg('Arsenal vs Chelsea', '2026-05-10');
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('distinct fixtures');
  });

  test('pair-local two fixtures (no priorLegs, per-leg canonical_events differ) → reject', () => {
    const { r, c } = fixture1x2(null, null);
    c.marketCanonicalEvent = new Map([
      [1, 'Arsenal vs Chelsea'], [2, 'Arsenal vs Tottenham Hotspur'], [3, 'Arsenal vs Chelsea'],
    ]);
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('same fixture, spelling drift + reversed order + mixed precision → match (live SE-848/890 class)', () => {
    const { r, c } = fixture1x2('Manchester City FC vs. Crystal Palace FC', '2026-05-13', 'day');
    c.priorLegs = priorDrawLeg('Crystal Palace vs Manchester City first half', '2026-05-13T22:00:00Z', 'minute');
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('NULL-date/NULL-event bridge legs attaching to a dated fixture → match (NULL-tolerant)', () => {
    const { r, c } = fixture1x2(null, null);
    c.priorLegs = priorDrawLeg('Arsenal vs Chelsea', '2026-05-10');
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('everything NULL on both sides → match (no positive evidence)', () => {
    const { r, c } = fixture1x2(null, null);
    c.priorLegs = priorDrawLeg(null, null);
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('non-fixture kinds with differing dates are NOT this guard\'s business → match', () => {
    const { r, c } = fixture1x2('Arsenal vs Chelsea', '2026-05-10');
    c.marketEventKind = new Map([[1, 'election_outcome_winner'], [2, 'election_outcome_winner'], [3, 'election_outcome_winner']]);
    c.priorLegs = priorDrawLeg('Arsenal vs Tottenham Hotspur', '2026-06-01');
    c.priorLegs[0].event_kind = 'election_outcome_winner';
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('padded coarse precision never refuses (year-precision prior vs day new, same year) → match', () => {
    const { r, c } = fixture1x2('Arsenal vs Chelsea', '2026-05-10', 'day');
    c.priorLegs = priorDrawLeg('Arsenal vs Chelsea', '2026-01-01', 'year');
    expect(validateMatch(r, c).kind).toBe('match');
  });
});

// election rank-grain leg-coherence guard
// Top-two primaries: "advance" = rank ≤ 2, "place first"/"win" = rank 1 — fusing
// them onto one outcome is a fake equivalence. Election-kind-scoped: sports
// "advance to the final" (stage_advance / fixture kinds)
// must never trip it.
describe('advance × place-first rank-grain guard (election-scoped)', () => {
  const advCategorical = (): EventMatchResult => ({
    same_event: true,
    confidence: 0.95,
    reasoning: 'same CA-45 primary',
    canonical_event: '2026 CA-45 primary',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      { outcome_id: 'amy', label: 'Amy Phan West', outcome_subject: 'Amy Phan West' },
      { outcome_id: 'derek', label: 'Derek Tran', outcome_subject: 'Derek Tran' },
    ],
    leg_mapping: [
      { outcome_id: 'amy', platform: 'polymarket', market_id: 1 },
      { outcome_id: 'amy', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'derek', platform: 'polymarket', market_id: 3 },
      { outcome_id: 'derek', platform: 'kalshi', market_id: 4 },
    ],
  });
  const advCtx = (
    titles: Record<number, string | null>,
    kinds: Record<number, string | null>,
    priorLegs?: MatchContext['priorLegs'],
  ): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[1, 'polymarket'], [2, 'kalshi'], [3, 'polymarket'], [4, 'kalshi']]),
    marketScope: new Map(),
    marketEventKind: new Map(Object.entries(kinds).map(([k, v]) => [Number(k), v])),
    marketTitle: new Map(Object.entries(titles).map(([k, v]) => [Number(k), v])),
    priorLegs,
  });

  test('the live CA-45 shape: every PM "advance" leg fused with a Kalshi place-first leg → reject', () => {
    const v = validateMatch(advCategorical(), advCtx(
      {
        1: 'Will Amy Phan West advance from the CA-45 primary election?',
        2: 'Will Amy Phan West place first in the 2026 CA-45 primary?',
        3: 'Will Derek Tran advance from the CA-45 primary election?',
        4: 'Will Derek Tran place first in the 2026 CA-45 primary?',
      },
      { 1: null, 2: 'election_outcome_winner', 3: null, 4: 'election_outcome_winner' },
    ));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('advance/place-first');
  });

  test('advance × advance fusion (both top-two, SE-847 shape) stays a match', () => {
    const v = validateMatch(advCategorical(), advCtx(
      {
        1: 'Will Amy Phan West advance from the CA-45 primary election?',
        2: 'Will Amy Phan West advance in the 2026 CA-45 primary?',
        3: 'Will Derek Tran advance from the CA-45 primary election?',
        4: 'Will Derek Tran advance in the 2026 CA-45 primary?',
      },
      // the Kalshi advance markets are live-stamped primary_winner — the guard
      // must classify them by TITLE grain, not fire on the kind alone.
      { 1: null, 2: 'primary_winner', 3: null, 4: 'primary_winner' },
    ));
    expect(v.kind).toBe('match');
  });

  test('sports "advance" markets are untouched (no election kind in the outcome)', () => {
    const v = validateMatch(advCategorical(), advCtx(
      {
        1: 'Will Australia advance through the second Eurovision Semi-Final?',
        2: 'Australia to reach the Eurovision Grand Final?',
        3: 'Will Croatia advance through the second Eurovision Semi-Final?',
        4: 'Croatia to reach the Eurovision Grand Final?',
      },
      { 1: 'stage_advance', 2: 'stage_advance', 3: 'stage_advance', 4: 'stage_advance' },
    ));
    expect(v.kind).toBe('match');
  });

  test('NULL tolerance: unknown title / unknown kind never trips the guard', () => {
    // election kind present but the place-first leg title is unknown → no evidence
    const v1 = validateMatch(advCategorical(), advCtx(
      { 1: 'Will Amy Phan West advance from the CA-45 primary election?', 2: null, 3: null, 4: null },
      { 1: null, 2: 'election_outcome_winner', 3: null, 4: 'election_outcome_winner' },
    ));
    expect(v1.kind).toBe('match');
    // no titles at all → guard skipped entirely
    const c = advCtx({}, { 2: 'election_outcome_winner', 4: 'election_outcome_winner' });
    expect(validateMatch(advCategorical(), c).kind).toBe('match');
  });

  test('partial conflict drops only the offending advance leg (platform survives)', () => {
    const r = advCategorical();
    const v = validateMatch(r, advCtx(
      {
        1: 'Will Amy Phan West advance from the CA-45 primary election?',
        2: 'Will Amy Phan West place first in the 2026 CA-45 primary?',
        3: 'Will Derek Tran win the CA-45 primary?',
        4: 'Will Derek Tran place first in the 2026 CA-45 primary?',
      },
      { 1: null, 2: 'election_outcome_winner', 3: 'election_outcome_winner', 4: 'election_outcome_winner' },
    ));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('advance/place-first'))).toBe(true);
    }
    // the PM advance leg for amy is gone; PM survives via derek's leg
    expect(r.leg_mapping!.map((l) => l.market_id).sort()).toEqual([2, 3, 4]);
  });

  test('expansion: a PRIOR advance leg blocks fusing a NEW place-first leg onto its outcome', () => {
    const r = advCategorical();
    // PM legs are place-first-shaped but UNNORMALIZED (kind NULL) → they are
    // neither advance nor provably place-first; the Kalshi legs are gated
    // election kind. Outcome "amy" already holds a persisted advance leg.
    const v = validateMatch(r, advCtx(
      {
        1: 'Will Amy Phan West place first in the 2026 CA-45 primary?',
        2: 'Will Amy Phan West place first in the 2026 CA-45 primary?',
        3: 'Will Derek Tran place first in the 2026 CA-45 primary?',
        4: 'Will Derek Tran place first in the 2026 CA-45 primary?',
      },
      { 1: null, 2: 'election_outcome_winner', 3: null, 4: 'election_outcome_winner' },
      [{
        outcome_id: 'amy',
        outcome_subject: 'Amy Phan West',
        market_id: 99,
        event_kind: null,
        title: 'Will Amy Phan West advance from the CA-45 primary election?',
      }],
    ));
    expect(v.kind).toBe('match');
    if (v.kind === 'match') {
      expect(v.warnings.some((w) => w.includes('advance/place-first'))).toBe(true);
    }
    // the NEW kalshi place-first leg for amy is dropped (prior leg persisted);
    // kalshi survives via derek's leg.
    expect(r.leg_mapping!.map((l) => l.market_id).sort()).toEqual([1, 3, 4]);
  });

  // PM 'advance from' rows carry event_kind='primary_winner' just like the
  // kalshi advance rows. The guard keys advance legs by title, so that
  // normalization must not blind it.
  test('DW-58 re-stamp does not blind the guard: PM advance legs normalized to primary_winner still reject against place-first', () => {
    const v = validateMatch(advCategorical(), advCtx(
      {
        1: 'Will Amy Phan West advance from the CA-45 primary election?',
        2: 'Will Amy Phan West place first in the 2026 CA-45 primary?',
        3: 'Will Derek Tran advance from the CA-45 primary election?',
        4: 'Will Derek Tran place first in the 2026 CA-45 primary?',
      },
      { 1: 'primary_winner', 2: 'election_outcome_winner', 3: 'primary_winner', 4: 'election_outcome_winner' },
    ));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('advance/place-first');
  });

  test('DW-58: advance × advance with BOTH sides normalized primary_winner stays a match', () => {
    const v = validateMatch(advCategorical(), advCtx(
      {
        1: 'Will Amy Phan West advance from the CA-45 primary election?',
        2: 'Will Amy Phan West advance in the 2026 CA-45 primary?',
        3: 'Will Derek Tran advance from the CA-45 primary election?',
        4: 'Will Derek Tran advance in the 2026 CA-45 primary?',
      },
      { 1: 'primary_winner', 2: 'primary_winner', 3: 'primary_winner', 4: 'primary_winner' },
    ));
    expect(v.kind).toBe('match');
  });
});

// Diacritic fold: comparison keys must fold accents to their ASCII base, not
// strip them to a space — stripping "Curaçao"→"cura ao" while the
// platform-native ASCII "Curacao"→"curacao" would disagree and drop a correct
// cross-platform leg. foldLabelKey (via canonicalOutcomeKey) and normSubject
// (via countDistinctSubjects) foldAscii first.
describe('canonicalOutcomeKey — diacritic fold (foldAscii before strip)', () => {
  test('Curaçao folds to "curacao", NOT "cura ao"', () => {
    expect(canonicalOutcomeKey('Curaçao', null)).toBe('curacao');
  });
  test('accented spelling agrees with its ASCII sibling (the live bug)', () => {
    // Both sides pass through the same fold; the guard compares these two keys.
    expect(canonicalOutcomeKey('Curaçao', null)).toBe(canonicalOutcomeKey('Curacao', null));
  });
  test('European diacritics fold to ASCII base', () => {
    expect(canonicalOutcomeKey('São Paulo', null)).toBe('sao paulo');
    expect(canonicalOutcomeKey('Beşiktaş', null)).toBe('besiktas');
    expect(canonicalOutcomeKey('Türkiye', null)).toBe('turkiye');
    expect(canonicalOutcomeKey('Münster', null)).toBe('munster');
    expect(canonicalOutcomeKey('García', null)).toBe('garcia');
    expect(canonicalOutcomeKey('Borussia Mönchengladbach', null)).toBe('borussia monchengladbach');
  });
  test('extended-Latin Đ folds via the transliteration table (Đoković → djokovic)', () => {
    expect(canonicalOutcomeKey('Đoković', null)).toBe('djokovic');
  });
  test('GUARD PRESERVED: a non-Latin (Korean) label still folds to null (no ASCII residue)', () => {
    // Korean has no combining marks in U+0300–036F, so foldAscii is a no-op and
    // the [^a-z0-9] strip empties it → null → "unknown label, never a conflict".
    expect(canonicalOutcomeKey('손흥민', null)).toBeNull();
  });
});

describe('countDistinctSubjects — accented/unaccented spellings are one subject', () => {
  test('"Alavés" and "Alaves" collapse to 1 (were 2 under the strip-to-space bug)', () => {
    expect(countDistinctSubjects(['Alavés', 'Alaves'])).toBe(1);
  });
  test('genuinely distinct accented subjects stay distinct', () => {
    expect(countDistinctSubjects(['Köln', 'München'])).toBe(2);
  });
});

// count-distribution predicate-coherence guard
describe('isCountBucketToken', () => {
  test('bare integers + N_or_more + N+ are count tokens', () => {
    for (const s of ['0', '1', '4', '10', '4_or_more', '5 or more', '5+', 'at least 5', 'exactly 3', 'more than 4'])
      expect(isCountBucketToken(s)).toBe(true);
  });
  test('named subjects / mixed tokens are NOT count tokens', () => {
    for (const s of ['Trump', 'Donald Trump', 'Above 4.4%', 'DRAW', '', null, undefined, '3 seats', 'Top 5'])
      expect(isCountBucketToken(s)).toBe(false);
  });
});

describe('isSpelledCountBucketToken (A1 escape-hatch)', () => {
  test('leading cardinal number words are spelled count tokens (bare + noun + or_more)', () => {
    for (const s of ['zero', 'one', 'two', 'twenty', 'zero senators', 'zero_senators', 'one_senator',
      'two senators', 'five or more', 'five_or_more'])
      expect(isSpelledCountBucketToken(s)).toBe(true);
  });
  test('named subjects that do not lead with a number word are NOT spelled count tokens', () => {
    for (const s of ['Trump', 'Donald Trump', 'DRAW', 'Top 5', 'Republicans Sweep', '', null, undefined,
      'no', 'none', 'yes'])  // no/none/yes excluded (yes/NO collision); digit-only left to isCountBucketToken
      expect(isSpelledCountBucketToken(s)).toBe(false);
  });
});

describe('validateMatch — count-distribution predicate coherence (A1)', () => {
  // Two Kalshi count series ("lose primary" vs "lose re-election") bridged via
  // a shared PM event into one integer-bucket categorical set.
  const countSet = (): EventMatchResult => ({
    same_event: true,
    confidence: 0.9,
    reasoning: 'how many …',
    canonical_event: 'How many Senate Republicans will lose their primary in 2026?',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      { outcome_id: '0', label: '0' },
      { outcome_id: '1', label: '1' },
      { outcome_id: '2', label: '2' },
    ],
    leg_mapping: [
      { outcome_id: '0', platform: 'kalshi', market_id: 10 },
      { outcome_id: '1', platform: 'kalshi', market_id: 11 },
      { outcome_id: '2', platform: 'kalshi', market_id: 12 },
    ],
  });
  const baseCtx = (): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[10, 'kalshi'], [11, 'kalshi'], [12, 'kalshi'], [20, 'polymarket']]),
    marketScope: new Map(),
  });

  test('REJECT: two distinct Kalshi count series in ONE count-bucket set (direct pair)', () => {
    const r = countSet();
    // new-pair legs span BOTH series (KXLOSEPRIMARY on m10/m11, KXLOSEREELECTION on m12)
    const v = validateMatch(r, {
      ...baseCtx(),
      marketKalshiSeries: new Map([
        [10, 'KXLOSEPRIMARYSENATER'], [11, 'KXLOSEPRIMARYSENATER'], [12, 'KXLOSEREELECTIONRSEN'],
      ]),
    });
    expect(v.kind).toBe('reject');
    expect((v as { reason: string }).reason).toContain('count-predicate coherence');
  });

  test('REJECT: 2nd series bridges in through a shared PM event (expansion path)', () => {
    // New pair = KXLOSEREELECTION (m12) + PM (m20); the SE already holds a
    // KXLOSEPRIMARY prior leg — the union of new + prior legs spans 2 series.
    const r = countSet();
    r.outcome_set = [{ outcome_id: '0', label: '0' }, { outcome_id: '1', label: '1' }];
    r.leg_mapping = [
      { outcome_id: '0', platform: 'kalshi', market_id: 12 },
      { outcome_id: '0', platform: 'polymarket', market_id: 20 },
      { outcome_id: '1', platform: 'kalshi', market_id: 13 },
      { outcome_id: '1', platform: 'polymarket', market_id: 21 },
    ];
    const v = validateMatch(r, {
      ...baseCtx(),
      marketPlatform: new Map([[12, 'kalshi'], [13, 'kalshi'], [20, 'polymarket'], [21, 'polymarket']]),
      marketKalshiSeries: new Map([[12, 'KXLOSEREELECTIONRSEN'], [13, 'KXLOSEREELECTIONRSEN'], [20, null], [21, null]]),
      priorLegs: [{ outcome_id: '0', outcome_subject: null, market_id: 10, kalshi_series: 'KXLOSEPRIMARYSENATER' }],
    });
    expect(v.kind).toBe('reject');
    expect((v as { reason: string }).reason).toContain('count-predicate coherence');
  });

  test('ALLOW: a SINGLE Kalshi count series + PM (sound se2387-style count set)', () => {
    const r = countSet();
    r.leg_mapping = [...(r.leg_mapping ?? []), { outcome_id: '0', platform: 'polymarket', market_id: 20 }];
    const v = validateMatch(r, {
      ...baseCtx(),
      marketKalshiSeries: new Map([
        [10, 'KXTOPBBSPOTSDRA'], [11, 'KXTOPBBSPOTSDRA'], [12, 'KXTOPBBSPOTSDRA'], [20, null],
      ]),
    });
    expect(v.kind).toBe('match');
  });

  test('ALLOW: a NAMED-subject categorical spanning 2 Kalshi series (guard is count-scoped)', () => {
    // The subject is the discriminator here — the count-set guard must NOT fire.
    const r = validCategorical();
    const v = validateMatch(r, {
      ...ctx(),
      marketKalshiSeries: new Map([[2, 'KXPRESWINNER'], [4, 'KXSOMEOTHERSERIES']]),
    });
    expect(v.kind).toBe('match');
  });

  // The LLM can emit spelled count buckets (non-numeric ids and labels) — the
  // guard must still fire on those.
  const spelledCountSet = (): EventMatchResult => ({
    same_event: true,
    confidence: 0.9,
    reasoning: 'how many senators …',
    canonical_event: 'How many Senate Republicans will lose their primary in 2026?',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [
      { outcome_id: 'zero_senators', label: 'zero senators' },
      { outcome_id: 'one_senator', label: 'one senator' },
      { outcome_id: 'two_senators', label: 'two senators' },
    ],
    leg_mapping: [
      { outcome_id: 'zero_senators', platform: 'kalshi', market_id: 10 },
      { outcome_id: 'one_senator', platform: 'kalshi', market_id: 11 },
      { outcome_id: 'two_senators', platform: 'kalshi', market_id: 12 },
    ],
  });

  test("REJECT: SPELLED 'zero_senators' count set fusing 2 Kalshi series NOW gets the guard", () => {
    const r = spelledCountSet();
    const v = validateMatch(r, {
      ...baseCtx(),
      marketKalshiSeries: new Map([
        [10, 'KXLOSEPRIMARYSENATER'], [11, 'KXLOSEPRIMARYSENATER'], [12, 'KXLOSEREELECTIONRSEN'],
      ]),
    });
    expect(v.kind).toBe('reject');
    expect((v as { reason: string }).reason).toContain('count-predicate coherence');
  });

  test('ALLOW: SPELLED count set on a SINGLE Kalshi series (sound)', () => {
    const r = spelledCountSet();
    const v = validateMatch(r, {
      ...baseCtx(),
      marketKalshiSeries: new Map([
        [10, 'KXLOSEPRIMARYSENATER'], [11, 'KXLOSEPRIMARYSENATER'], [12, 'KXLOSEPRIMARYSENATER'],
      ]),
    });
    expect(v.kind).toBe('match');
  });
});

// NULL-subject pairing ban
import { isDeadlineOnlySubject } from './guards.js';

describe('FIX 3 — NULL-subject pairing ban', () => {
  // A cross-platform binary merge keyed on the shared deadline "before_2027":
  // two unrelated topics, both unshaped (NULL Stage-1 canonical_subject), must
  // not merge on the deadline alone.
  const c2223 = (outcomeSubject: string | null): EventMatchResult => ({
    same_event: true, confidence: 0.9, reasoning: 'both before 2027',
    canonical_event: null as unknown as string, canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    outcome_set: [{ outcome_id: 'before_2027', label: 'before_2027', outcome_subject: outcomeSubject }],
    leg_mapping: [
      { outcome_id: 'before_2027', platform: 'kalshi', market_id: 100 },
      { outcome_id: 'before_2027', platform: 'polymarket', market_id: 101 },
    ],
  });
  const c2223Ctx = (subjects: Map<number, string | null>): MatchContext => ({
    minConfidence: 0.6,
    marketPlatform: new Map([[100, 'kalshi'], [101, 'polymarket']]),
    marketScope: new Map(),
    marketSubject: subjects,
  });
  const bothNull = new Map<number, string | null>([[100, null], [101, null]]);

  test('c2223: both legs NULL subject + deadline-only outcome → REJECT', () => {
    const v = validateMatch(c2223('Before 2027'), c2223Ctx(bothNull));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toMatch(/NULL-subject pairing ban/);
  });

  test('explicit deadline-only labels in various forms → REJECT', () => {
    for (const s of ['Before 2027', 'December 31', 'by end of 2026', '2027', 'by July 2026']) {
      expect(validateMatch(c2223(s), c2223Ctx(bothNull)).kind).toBe('reject');
    }
  });

  test('named honest merge SURVIVES — "Neymar plays in 2026 FIFA World Cup" is not deadline-only', () => {
    // se1270/se1271/se1273 class: real entity in the label → merge allowed.
    expect(validateMatch(c2223('Neymar plays in 2026 FIFA World Cup'), c2223Ctx(bothNull)).kind).toBe('match');
    expect(validateMatch(c2223('China invades Taiwan by end of 2026'), c2223Ctx(bothNull)).kind).toBe('match');
  });

  test('a single KNOWN leg subject anchors the merge → NULL-subject ban does NOT fire', () => {
    // (a downstream subject-coherence guard may still act on the synthetic mismatch;
    //  the point is the NULL-subject ban is inert once any leg has a known subject.)
    const oneKnown = new Map<number, string | null>([[100, 'Iran nuclear deal'], [101, null]]);
    const v = validateMatch(c2223('Before 2027'), c2223Ctx(oneKnown));
    if (v.kind === 'reject') expect(v.reason).not.toMatch(/NULL-subject pairing ban/);
  });

  test('bundle_nonexclusive per-outcome fusion is STILL banned (c2223 IS a bundle)', () => {
    // se2358 (the real c2223) is grouping_kind=bundle_nonexclusive, yet its
    // "before_2027" outcome fuses the two Iran markets into a complement-bearing
    // binary QUESTION — so the ban must fire regardless of parent grouping.
    const r = { ...c2223('Before 2027'), grouping_kind: 'bundle_nonexclusive' as const };
    const v = validateMatch(r, c2223Ctx(bothNull));
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toMatch(/NULL-subject pairing ban/);
  });

  test('NULL / empty outcome_subject is PRESERVED (se1680 Petal class — no deadline signal)', () => {
    // A null-label cross-platform fusion carries no deadline-keying signal and may
    // be a sound merge the KB just has not shaped — the ban must not fire.
    for (const s of [null, '', '  ']) {
      const v = validateMatch(c2223(s), c2223Ctx(bothNull));
      if (v.kind === 'reject') expect(v.reason).not.toMatch(/NULL-subject pairing ban/);
    }
  });

  test('NULL-tolerant: no marketSubject map → ban skipped (unknown never asserts)', () => {
    const noSubj: MatchContext = { minConfidence: 0.6, marketPlatform: new Map([[100, 'kalshi'], [101, 'polymarket']]), marketScope: new Map() };
    expect(validateMatch(c2223('Before 2027'), noSubj).kind).toBe('match');
  });

  test('within-platform outcome (single platform legs) is not banned', () => {
    // both legs same platform → not a cross-platform equivalence → ban inert.
    const r = c2223('Before 2027');
    r.leg_mapping = [
      { outcome_id: 'before_2027', platform: 'kalshi', market_id: 100 },
      { outcome_id: 'before_2027', platform: 'kalshi', market_id: 101 },
    ];
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: new Map([[100, 'kalshi'], [101, 'kalshi']]), marketScope: new Map(), marketSubject: bothNull };
    // (single-outcome collapse guard fires instead — a real partition collapsed;
    //  the point here is the NULL-subject ban did NOT fire on a within-platform pair.)
    const v = validateMatch(r, c);
    if (v.kind === 'reject') expect(v.reason).not.toMatch(/NULL-subject pairing ban/);
  });

  test('isDeadlineOnlySubject: temporal-only vs named', () => {
    expect(isDeadlineOnlySubject('Before 2027')).toBe(true);
    expect(isDeadlineOnlySubject('December 31')).toBe(true);
    expect(isDeadlineOnlySubject('by end of 2026')).toBe(true);
    expect(isDeadlineOnlySubject(null)).toBe(true);
    expect(isDeadlineOnlySubject('2027')).toBe(true);
    expect(isDeadlineOnlySubject('Neymar plays in 2026 FIFA World Cup')).toBe(false);
    expect(isDeadlineOnlySubject('Anthropic acquired before 2027')).toBe(false);
    expect(isDeadlineOnlySubject('Donald Trump')).toBe(false);
  });
});

// check-6 grain homogeneity
describe('classifyOutcomeAxisByKey (deterministic grain from outcome key)', () => {
  test('winner — bare named subjects (team / candidate / party / region)', () => {
    expect(classifyOutcomeAxisByKey('argentina_wins', 'Argentina wins', null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('t1', 'T1', null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('lck', 'LCK (South Korea)', null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('democrat', 'Democratic Party', null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('graham_platner_wins', '', null)).toBe('winner');
  });
  test('exact_score — two small integers (arg_2_1 / exact_0-0 / "Argentina 0 - 0 Switzerland")', () => {
    expect(classifyOutcomeAxisByKey('arg_2_1_che', '', null)).toBe('exact_score');
    expect(classifyOutcomeAxisByKey('exact_0-0', 'Exact Score: 0-0', null)).toBe('exact_score');
    expect(classifyOutcomeAxisByKey('argentina_0_0_switzerland', 'Argentina 0 - 0 Switzerland', null)).toBe('exact_score');
    expect(classifyOutcomeAxisByKey('argentina_2_1', 'Argentina wins 2-1', null)).toBe('exact_score');
  });
  test('spread — margin, tested BEFORE exact_score (minus_2_5 is NOT the score 2-5)', () => {
    expect(classifyOutcomeAxisByKey('spread_switzerland_minus_2_5', 'Spread: Switzerland (-2.5)', null)).toBe('spread');
    expect(classifyOutcomeAxisByKey('switzerland_-1.5', 'Switzerland (-1.5)', null)).toBe('spread');
    expect(classifyOutcomeAxisByKey('argentina_win_by_more_than_1.5', 'Argentina wins by more than 1.5 goals', null)).toBe('spread');
    expect(classifyOutcomeAxisByKey('argentina_-1.5', 'Argentina wins by 2 or more goals', null)).toBe('spread');
    expect(classifyOutcomeAxisByKey('sd_wins_by_over_1.5', '', null)).toBe('spread');
  });
  test('over_under — total / team-total threshold rung', () => {
    expect(classifyOutcomeAxisByKey('over_2.5', 'Total goals over 2.5', null)).toBe('over_under');
    expect(classifyOutcomeAxisByKey('ou_2_5', 'O/U 2.5', null)).toBe('over_under');
    expect(classifyOutcomeAxisByKey('argentina_over_0.5', 'Argentina over 0.5 goals', null)).toBe('over_under');
    expect(classifyOutcomeAxisByKey('total_corners_ou_10.5', 'Total Corners O/U 10.5', null)).toBe('over_under');
  });
  test('conditional_matchup / both_teams_score / first_scorer', () => {
    expect(classifyOutcomeAxisByKey('republican_defeats_janet_mills', '', null)).toBe('conditional_matchup');
    expect(classifyOutcomeAxisByKey('both_teams_to_score', 'Both Teams to Score', null)).toBe('both_teams_score');
    expect(classifyOutcomeAxisByKey('btts_yes', 'Both Teams To Score', null)).toBe('both_teams_score');
    expect(classifyOutcomeAxisByKey('argentina_first_goal', 'Argentina', null)).toBe('first_scorer');
    expect(classifyOutcomeAxisByKey('first_team_to_score_che', 'Switzerland', null)).toBe('first_scorer');
  });
  test('neutral — the complement/null outcome is NOT its own grain', () => {
    expect(classifyOutcomeAxisByKey('draw', '', null)).toBe('neutral');
    expect(classifyOutcomeAxisByKey('tie', 'Tie', null)).toBe('neutral');
    expect(classifyOutcomeAxisByKey('no_goal', 'No Goal', null)).toBe('neutral');
    // "draw_0_0" carries a real score → NOT swallowed by neutral.
    expect(classifyOutcomeAxisByKey('draw_0_0', 'Draw 0-0', null)).toBe('exact_score');
  });
  test('outcomeGrain — event_kind upgrades an ambiguous key (secondary, upgrade-only)', () => {
    // key alone is a bare team name → winner; the leg's exact_score kind upgrades it.
    expect(outcomeGrain('argentina', 'Argentina', null, ['exact_score'])).toBe('exact_score');
    // a structured key is NEVER downgraded by a winner-family kind.
    expect(outcomeGrain('over_2.5', 'O/U 2.5', null, ['match_winner'])).toBe('over_under');
    // NULL kinds leave the key default in place (conservative arm).
    expect(outcomeGrain('argentina', 'Argentina', null, [null, undefined])).toBe('winner');
  });
});

describe('validateMatch — §C check-6 grain homogeneity (mechanism 1)', () => {
  const platMap = (legs: { market_id: number; platform: string }[]) =>
    new Map(legs.map((l) => [l.market_id, l.platform] as const));

  test('c30731 shape: match-winner + exact-score + over/under + spread fused → reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'ARG-SUI all-markets fusion',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'argentina_wins', label: 'Argentina wins', outcome_subject: 'Argentina wins' },
        { outcome_id: 'draw', label: 'Draw', outcome_subject: '' },
        { outcome_id: 'switzerland_wins', label: 'Switzerland wins', outcome_subject: 'Switzerland wins' },
        { outcome_id: 'argentina_2_1', label: 'Argentina wins 2-1', outcome_subject: 'Argentina wins 2-1' },
        { outcome_id: 'argentina_over_1.5', label: 'Argentina over 1.5 goals', outcome_subject: 'Argentina over 1.5 goals' },
        { outcome_id: 'argentina_win_by_more_than_1.5', label: 'Argentina wins by more than 1.5 goals', outcome_subject: 'Argentina wins by more than 1.5 goals' },
      ],
      leg_mapping: [
        { outcome_id: 'argentina_wins', platform: 'predict', market_id: 1 },
        { outcome_id: 'draw', platform: 'predict', market_id: 2 },
        { outcome_id: 'switzerland_wins', platform: 'predict', market_id: 3 },
        { outcome_id: 'argentina_2_1', platform: 'kalshi', market_id: 4 },
        { outcome_id: 'argentina_over_1.5', platform: 'kalshi', market_id: 5 },
        { outcome_id: 'argentina_win_by_more_than_1.5', platform: 'kalshi', market_id: 6 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('grain homogeneity');
  });

  test('c32580 shape (SE 2069 Maine): candidate winner + `defeats` conditional-matchup → reject', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'Maine Senate over-merge',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'graham_platner_wins', label: 'Graham Platner wins', outcome_subject: '' },
        { outcome_id: 'janet_mills_wins', label: 'Janet Mills wins', outcome_subject: '' },
        { outcome_id: 'republican_defeats_graham_platner', label: 'Republican defeats Graham Platner', outcome_subject: '' },
        { outcome_id: 'republican_defeats_janet_mills', label: 'Republican defeats Janet Mills', outcome_subject: '' },
      ],
      leg_mapping: [
        { outcome_id: 'graham_platner_wins', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'janet_mills_wins', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'republican_defeats_graham_platner', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'republican_defeats_janet_mills', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('grain homogeneity');
  });

  test('NULL-field legs follow the conservative arm — key classifies, no event_kind needed', () => {
    // No marketEventKind map at all; grain must come purely from the outcome keys,
    // and the winner+exact_score mix still refuses.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'null stage-1 fields',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'ajax_win', label: 'AFC Ajax', outcome_subject: 'AFC Ajax' },
        { outcome_id: 'utrecht_win', label: 'FC Utrecht', outcome_subject: 'FC Utrecht' },
        { outcome_id: 'exact_1_0', label: 'Exact Score: 1-0', outcome_subject: 'Exact Score: 1-0' },
        { outcome_id: 'exact_2_1', label: 'Exact Score: 2-1', outcome_subject: 'Exact Score: 2-1' },
      ],
      leg_mapping: [
        { outcome_id: 'ajax_win', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'utrecht_win', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'exact_1_0', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'exact_2_1', platform: 'polymarket', market_id: 4 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    expect(validateMatch(r, c).kind).toBe('reject');
  });

  test('legit single-grain candidate set (election candidates across venues) → match', () => {
    // Named candidates + party + a residual, all WINNER grain (one partition). The
    // grain guard must NOT fire. (This is the recall-preserving control.)
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'MD-05 nominee — one winner partition',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'alsobrooks', label: 'Angela Alsobrooks', outcome_subject: 'Angela Alsobrooks' },
        { outcome_id: 'trone', label: 'David Trone', outcome_subject: 'David Trone' },
      ],
      leg_mapping: [
        { outcome_id: 'alsobrooks', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'alsobrooks', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'trone', platform: 'polymarket', market_id: 3 },
        { outcome_id: 'trone', platform: 'kalshi', market_id: 4 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('pure exact-score set → match (single grain)', () => {
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'exact-score partition',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'exact_0_0', label: '0-0', outcome_subject: 'Argentina 0 - 0 Switzerland' },
        { outcome_id: 'exact_1_0', label: '1-0', outcome_subject: 'Argentina 1 - 0 Switzerland' },
        { outcome_id: 'draw_2_2', label: 'Draw 2-2', outcome_subject: 'Draw 2-2' },
      ],
      leg_mapping: [
        { outcome_id: 'exact_0_0', platform: 'polymarket', market_id: 1 },
        { outcome_id: 'exact_1_0', platform: 'polymarket', market_id: 2 },
        { outcome_id: 'draw_2_2', platform: 'kalshi', market_id: 3 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    expect(validateMatch(r, c).kind).toBe('match');
  });

  test('sound control: pure first-team-to-score {arg, sui, no_goal} → match (neutral excluded)', () => {
    // first_scorer + first_scorer + neutral complement = one grain.
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'first team to score',
      grouping_kind: 'categorical_exclusive',
      outcome_set: [
        { outcome_id: 'argentina_first_goal', label: 'Argentina', outcome_subject: 'Argentina' },
        { outcome_id: 'switzerland_first_goal', label: 'Switzerland', outcome_subject: 'Switzerland' },
        { outcome_id: 'no_goal', label: 'No Goal', outcome_subject: '' },
      ],
      leg_mapping: [
        { outcome_id: 'argentina_first_goal', platform: 'kalshi', market_id: 1 },
        { outcome_id: 'argentina_first_goal', platform: 'predict', market_id: 2 },
        { outcome_id: 'switzerland_first_goal', platform: 'kalshi', market_id: 3 },
        { outcome_id: 'no_goal', platform: 'predict', market_id: 4 },
      ],
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(r.leg_mapping!), marketScope: new Map() };
    expect(validateMatch(r, c).kind).toBe('match');
  });
});

describe('validateMatch — §C check-7 cross-platform zero-overlap veto (mechanism 4, log-first)', () => {
  const platMap = (legs: { market_id: number; platform: string }[]) =>
    new Map(legs.map((l) => [l.market_id, l.platform] as const));

  test('c30785 shape (SE 2777 MSI): all-Kalshi teams + all-PM regions, zero overlap → match + LOG', () => {
    resetBeltCensus();
    // single-GRAIN (all winner) so check-6 passes; ≥3 exclusive outcomes per side,
    // zero cross-platform overlap ⇒ mechanism-4 log (belt + warning), NOT a reject.
    const mkTeam = (id: string, mid: number) => ({ outcome_id: id, label: id, outcome_subject: id });
    const outcome_set = [
      mkTeam('t1', 1), mkTeam('bilibili_gaming', 2), mkTeam('g2_esports', 3), mkTeam('hanwha_life_esports', 4),
      { outcome_id: 'lck', label: 'LCK (South Korea)', outcome_subject: 'LCK (South Korea)' },
      { outcome_id: 'lpl', label: 'LPL (China)', outcome_subject: 'LPL (China)' },
      { outcome_id: 'lec', label: 'LEC (Europe / EMEA)', outcome_subject: 'LEC (Europe / EMEA)' },
      { outcome_id: 'other_region', label: 'Other', outcome_subject: '', is_residual: true },
    ];
    const leg_mapping = [
      { outcome_id: 't1', platform: 'kalshi', market_id: 1 },
      { outcome_id: 'bilibili_gaming', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'g2_esports', platform: 'kalshi', market_id: 3 },
      { outcome_id: 'hanwha_life_esports', platform: 'kalshi', market_id: 4 },
      { outcome_id: 'lck', platform: 'polymarket', market_id: 5 },
      { outcome_id: 'lpl', platform: 'polymarket', market_id: 6 },
      { outcome_id: 'lec', platform: 'polymarket', market_id: 7 },
      { outcome_id: 'other_region', platform: 'polymarket', market_id: 8 },
    ];
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'MSI winning region', grouping_kind: 'categorical_exclusive',
      outcome_set, leg_mapping,
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(leg_mapping), marketScope: new Map() };
    const v = validateMatch(r, c);
    expect(v.kind).toBe('match');
    expect(beltCensus()['belt.stage3_categorical_xplat_zero_overlap']).toBe(1);
    if (v.kind === 'match') expect(v.warnings.some((w) => w.includes('aggregate-vs-member'))).toBe(true);
  });

  test('cross-platform overlap present (candidates on BOTH venues) → no veto', () => {
    resetBeltCensus();
    // Same winner grain, but each outcome has legs on ≥2 platforms → genuine
    // cross-platform partition, mechanism-4 stays silent.
    const outcome_set = [
      { outcome_id: 'a', label: 'Cand A', outcome_subject: 'Cand A' },
      { outcome_id: 'b', label: 'Cand B', outcome_subject: 'Cand B' },
      { outcome_id: 'c', label: 'Cand C', outcome_subject: 'Cand C' },
    ];
    const leg_mapping = [
      { outcome_id: 'a', platform: 'kalshi', market_id: 1 }, { outcome_id: 'a', platform: 'polymarket', market_id: 2 },
      { outcome_id: 'b', platform: 'kalshi', market_id: 3 }, { outcome_id: 'b', platform: 'polymarket', market_id: 4 },
      { outcome_id: 'c', platform: 'kalshi', market_id: 5 }, { outcome_id: 'c', platform: 'polymarket', market_id: 6 },
    ];
    const r: EventMatchResult = {
      same_event: true, confidence: 0.95, reasoning: 'overlapping candidate partition', grouping_kind: 'categorical_exclusive',
      outcome_set, leg_mapping,
    };
    const c: MatchContext = { minConfidence: 0.6, marketPlatform: platMap(leg_mapping), marketScope: new Map() };
    expect(validateMatch(r, c).kind).toBe('match');
    expect(beltCensus()['belt.stage3_categorical_xplat_zero_overlap']).toBeUndefined();
  });
});

// Winner-projection leg-drop belt
describe('exact-score winner-projection leg-coherence guard (SE 16224)', () => {
  // Predict 1X2 moneyline (win/draw/win) with KXMLSSCORE correct-score children
  // fused onto the win/draw nodes: the custom-score legs must drop; here they
  // are the only kalshi legs, so the pair is rejected.
  const outcome_set = [
    { outcome_id: 'san_diego_fc_win', label: 'San Diego FC win', outcome_subject: 'San Diego FC win' },
    { outcome_id: 'draw', label: 'Draw', outcome_subject: 'Draw' },
    { outcome_id: 'colorado_rapids_win', label: 'Colorado Rapids win', outcome_subject: 'Colorado Rapids win' },
  ];
  const leg_mapping = [
    { outcome_id: 'san_diego_fc_win', platform: 'predict', market_id: 1 },
    { outcome_id: 'draw', platform: 'predict', market_id: 2 },
    { outcome_id: 'colorado_rapids_win', platform: 'predict', market_id: 3 },
    { outcome_id: 'san_diego_fc_win', platform: 'kalshi', market_id: 4 },  // "San Diego FC wins 4-0"
    { outcome_id: 'draw', platform: 'kalshi', market_id: 5 },              // "Draw 0-0"
  ];
  const r: EventMatchResult = {
    same_event: true, confidence: 0.95, reasoning: 'same MLS match', grouping_kind: 'categorical_exclusive',
    outcome_set, leg_mapping,
  };
  const plat = new Map<number, string>(leg_mapping.map((l) => [l.market_id, l.platform]));
  const nativeLabels = new Map<number, string | null>([[4, 'San Diego FC wins 4-0'], [5, 'Draw 0-0']]);
  const scoreSeries = new Map<number, string | null>([[4, 'KXMLSSCORE'], [5, 'KXMLSSCORE']]);

  test('KXMLSSCORE scoreline legs on a 1X2 → dropped → kalshi gutted → reject', () => {
    const v = validateMatch(r, {
      minConfidence: 0.6, marketPlatform: plat, marketScope: new Map(),
      marketNativeLabel: nativeLabels, marketKalshiSeries: scoreSeries,
    });
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toMatch(/exact-score winner-project/i);
  });

  test('SCOPED: same fusion WITHOUT a KX%SCORE series → belt inert (a bare "wins 2-1" winner market is never touched)', () => {
    const v = validateMatch(r, {
      minConfidence: 0.6, marketPlatform: plat, marketScope: new Map(),
      marketNativeLabel: nativeLabels, // scoreline labels but NO series/kind evidence
    });
    expect(v.kind).toBe('match');
  });
});
