import { test, expect } from 'bun:test';
import { EVENT_KINDS } from '@arb/types';
import {
  sigma1Contradictions,
  foldBeltParticipant,
  ALLOWED_KIND_FAMILIES,
  SIGMA1_CONTRADICTION_DIMENSIONS,
  SIGMA1_NATIVE_SET_DIMENSIONS,
  type BeltSlotFacts,
} from './sigma-contradiction-belt.js';

const slot = (over: Partial<BeltSlotFacts> & { outcome_id: string }): BeltSlotFacts => ({
  canonical_events: [],
  condition_dates: [],
  event_kinds: [],
  ...over,
});

const dims = (findings: ReturnType<typeof sigma1Contradictions>) =>
  findings.map((f) => f.dimension);

// (a) fixture_participants

test('SE-860 fixture (outcome_set 45): Dundee vs Dundee United participant contradiction demotes', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'draw', canonical_events: ['Dundee United FC vs Kilmarnock FC'] }),
    slot({ outcome_id: 'dundee_united_fc', canonical_events: ['Dundee United FC vs Kilmarnock FC'] }),
    slot({
      outcome_id: 'kilmarnock_fc',
      canonical_events: ['Dundee vs Kilmarnock FC', 'Dundee United FC vs Kilmarnock FC'],
    }),
  ]);
  expect(dims(findings)).toEqual(['fixture_participants']);
});

test('participants: benign org-suffix / prefix drift of ONE fixture never demotes', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['Getafe CF vs RCD Mallorca'] }),
    slot({ outcome_id: 'b', canonical_events: ['Getafe vs RCD Mallorca'] }),
    slot({ outcome_id: 'c', canonical_events: ['RCD Mallorca vs Getafe CF'] }),
  ]);
  expect(findings).toEqual([]);
});

test('participants: founding-year + org-token + diacritic drift never demotes', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['1. FC Köln vs FC Bayern München'] }),
    slot({ outcome_id: 'b', canonical_events: ['1. Köln vs FC Bayern Munchen'] }),
  ])).toEqual([]);
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['Como 1907 vs Hellas Verona FC'] }),
    slot({ outcome_id: 'b', canonical_events: ['Como vs Hellas Verona FC'] }),
  ])).toEqual([]);
});

test('participants: two genuinely different fixtures demote', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['Arsenal vs Chelsea'] }),
    slot({ outcome_id: 'b', canonical_events: ['Liverpool vs Everton'] }),
  ]);
  expect(dims(findings)).toEqual(['fixture_participants']);
});

test('participants: halftime period qualifier is stripped before parsing (no demote)', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['Crystal Palace vs Manchester City first half'] }),
    slot({ outcome_id: 'b', canonical_events: ['Crystal Palace vs Manchester City'] }),
  ])).toEqual([]);
});

test('participants: unparseable / NULL canonical_events are never evidence', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', canonical_events: ['Arsenal vs Chelsea'] }),
    slot({ outcome_id: 'b', canonical_events: ['2026 london mayoral election'] }),
    slot({ outcome_id: 'c', canonical_events: [] }),
  ])).toEqual([]);
});

test('foldBeltParticipant: strips org tokens + numbers anywhere, keeps identity words', () => {
  expect(foldBeltParticipant('1. FC Heidenheim 1846')).toBe('heidenheim');
  expect(foldBeltParticipant('Dundee United FC')).toBe('dundeeunited');
  expect(foldBeltParticipant('Dundee')).toBe('dundee');
  expect(foldBeltParticipant('FC Bayern München')).toBe('bayernmunchen');
  // An all-org name falls back to its raw tokens rather than vanishing.
  expect(foldBeltParticipant('FC')).toBe('fc');
});

// (b) condition_date

test('condition_date: two day-grain dates differing → demote (Khamenei mis-stamp shape)', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'a', condition_dates: [{ date: '2026-05-22', precision: 'day' }] }),
    slot({ outcome_id: 'b', condition_dates: [{ date: '2026-10-14', precision: 'day' }] }),
    slot({ outcome_id: 'c', condition_dates: [{ date: '2026-05-22', precision: 'day' }] }),
  ]);
  expect(dims(findings)).toEqual(['condition_date']);
  expect(findings[0].values).toEqual(['2026-05-22', '2026-10-14']);
});

test('condition_date: dates equal at the COARSER stamped precision never demote', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', condition_dates: [{ date: '2026-05-01', precision: 'month' }] }),
    slot({ outcome_id: 'b', condition_dates: [{ date: '2026-05-22', precision: 'day' }] }),
  ])).toEqual([]);
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', condition_dates: [{ date: '2026-01-01', precision: 'year' }] }),
    slot({ outcome_id: 'b', condition_dates: [{ date: '2026-06-15', precision: 'day' }] }),
  ])).toEqual([]);
});

test('condition_date: month-precision dates in different months demote', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'a', condition_dates: [{ date: '2026-05-01', precision: 'month' }] }),
    slot({ outcome_id: 'b', condition_dates: [{ date: '2026-06-01', precision: 'month' }] }),
  ]);
  expect(dims(findings)).toEqual(['condition_date']);
});

// (c) event_kind

test('event_kind: slots spanning unrelated kinds demote', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: 'a', event_kinds: ['match_winner'] }),
    slot({ outcome_id: 'b', event_kinds: ['championship_winner'] }),
  ]);
  expect(dims(findings)).toEqual(['event_kind']);
  expect(findings[0].values).toEqual(['championship_winner', 'match_winner']);
});

test('event_kind: SET_INERT kinds contribute no kind-span — a Σ=1 set gaining an inert leg never demotes (TASK C / DW-41)', () => {
  // A SET_INERT kind (econ_indicator_threshold / count_threshold) is treated like
  // a NULL/unknown leg and never flips a single-kind Σ=1 family to demoted.
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', event_kinds: ['exact_score'] }),
    slot({ outcome_id: 'b', event_kinds: ['econ_indicator_threshold'] }),
  ])).toEqual([]);
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', event_kinds: ['econ_indicator_threshold'] }),
    slot({ outcome_id: 'b', event_kinds: ['count_threshold'] }),
  ])).toEqual([]);
});

test('event_kind: PM exact-score grid + "Any Other Score" residual never demotes (one kind — no allowlist needed)', () => {
  // The residual legs are stamped event_kind='exact_score' like the grid, so the
  // Σ=1 family is single-kind and passes the size<=1 short-circuit.
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', event_kinds: ['exact_score'] }),
    slot({ outcome_id: 'any_other', event_kinds: ['exact_score'] }),
  ])).toEqual([]);
});

test('ALLOWED_KIND_FAMILIES: every member is a real emitted EventKind (pin against invented names)', () => {
  const known = new Set<string>(EVENT_KINDS);
  for (const fam of ALLOWED_KIND_FAMILIES) {
    expect(fam.size).toBeGreaterThanOrEqual(2); // a 1-kind family is a no-op
    for (const kind of fam) expect(known.has(kind)).toBe(true);
  }
});

// NULL / unknown tolerance (the framework contract)

test('NULL/unknown facts NEVER demote (all dimensions)', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a' }),
    slot({ outcome_id: 'b' }),
    slot({ outcome_id: 'c' }),
  ])).toEqual([]);
  expect(sigma1Contradictions([
    slot({
      outcome_id: 'a',
      canonical_events: ['Arsenal vs Chelsea'],
      condition_dates: [{ date: '2026-05-22', precision: 'day' }],
      event_kinds: ['match_winner'],
    }),
    slot({ outcome_id: 'b' }),
  ])).toEqual([]);
});

test('a set contradicting on several dimensions reports one finding per dimension', () => {
  const findings = sigma1Contradictions([
    slot({
      outcome_id: 'a',
      canonical_events: ['Arsenal vs Chelsea'],
      condition_dates: [{ date: '2026-05-22', precision: 'day' }],
      event_kinds: ['match_winner'],
    }),
    slot({
      outcome_id: 'b',
      canonical_events: ['Liverpool vs Everton'],
      condition_dates: [{ date: '2026-05-23', precision: 'day' }],
      event_kinds: ['championship_winner'],
    }),
  ]);
  expect(dims(findings)).toEqual(['fixture_participants', 'condition_date', 'event_kind']);
});

// per-feed dimension lists

test('feed-B native list excludes participants (label-noise drift never demotes a native set)', () => {
  const slots = [
    slot({ outcome_id: 'a', canonical_events: ['Newcastle United FC vs West Ham United FC'] }),
    slot({ outcome_id: 'b', canonical_events: ['Newcastle FC vs West Ham'] }),
  ];
  // The full list flags it (feed A would demote); the native (feed B) list does not.
  expect(dims(sigma1Contradictions(slots, SIGMA1_CONTRADICTION_DIMENSIONS))).toEqual(['fixture_participants']);
  expect(sigma1Contradictions(slots, SIGMA1_NATIVE_SET_DIMENSIONS)).toEqual([]);
});

// (d) resolution_oracle

test('THE 941715898d CLASS: a Σ=1 tiling read off Weather Underground AND NWS demotes', () => {
  const findings = sigma1Contradictions([
    slot({ outcome_id: '92-93', resolution_sources: ['Weather Underground'] }),
    slot({ outcome_id: '94-95', resolution_sources: ['NWS'] }),
  ]);
  expect(dims(findings)).toEqual(['resolution_oracle']);
  expect(findings[0].values).toEqual(['NWS', 'Weather Underground']);
});

test('resolution_oracle: one slot straddling two authorities demotes (why the full DISTINCT set is plumbed, not a representative)', () => {
  expect(dims(sigma1Contradictions([
    slot({ outcome_id: 'a', resolution_sources: ['Weather Underground', 'NWS'] }),
    slot({ outcome_id: 'b', resolution_sources: [] }),
  ]))).toEqual(['resolution_oracle']);
});

test('resolution_oracle: one authority across every slot never demotes', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', resolution_sources: ['NWS'] }),
    slot({ outcome_id: 'b', resolution_sources: ['NWS'] }),
    slot({ outcome_id: 'c', resolution_sources: [] }),
  ])).toEqual([]);
});

test('resolution_oracle: the UMA grain artifact never demotes (all 22 live multi-oracle sets)', () => {
  // 'UMA' is Polymarket's settlement layer, emitted only as the last fallback,
  // so a specific-oracle leg and a 'UMA' leg for the same market are not a conflict.
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', resolution_sources: ['MLB'] }),
    slot({ outcome_id: 'b', resolution_sources: ['UMA'] }),
  ])).toEqual([]);
});

test('resolution_oracle: unknown never contributes evidence (the belt NULL doctrine)', () => {
  expect(sigma1Contradictions([
    slot({ outcome_id: 'a', resolution_sources: ['NWS'] }),
    slot({ outcome_id: 'b' }),
  ])).toEqual([]);
  expect(sigma1Contradictions([slot({ outcome_id: 'a' }), slot({ outcome_id: 'b' })])).toEqual([]);
});

test('resolution_oracle runs on BOTH feed lists (a cross-authority Σ=1 is unsound wherever minted)', () => {
  const slots = [
    slot({ outcome_id: 'a', resolution_sources: ['Weather Underground'] }),
    slot({ outcome_id: 'b', resolution_sources: ['NWS'] }),
  ];
  expect(dims(sigma1Contradictions(slots, SIGMA1_CONTRADICTION_DIMENSIONS))).toEqual(['resolution_oracle']);
  expect(dims(sigma1Contradictions(slots, SIGMA1_NATIVE_SET_DIMENSIONS))).toEqual(['resolution_oracle']);
});
