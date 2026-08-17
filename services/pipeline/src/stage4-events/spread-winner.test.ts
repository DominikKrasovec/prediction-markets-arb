import { test, expect } from 'bun:test';
import { FIXTURE_START_TOLERANCE_MS } from '../util/fixture-instant.js';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildSpreadWinnerEdgesSql,
  spreadTeamIdentity,
  isFavoriteSpreadLeg,
  SPREAD_WINNER_UNITS,
  SPREAD_WINNER_HALF_RX,
  SPREAD_WINNER_SERIES_RX,
} from './spread-winner.js';

const sql = buildSpreadWinnerEdgesSql();

// ── pure-TS reference: team identity (the ONLY two trusted forms) ─────────────

test('team identity: arity-1 participants[0] is the team (R5b convention)', () => {
  expect(spreadTeamIdentity(['CA Independiente'], 'CA Independiente -1.5 Spread')).toBe('CA Independiente');
  // threshold-embedded subject is irrelevant for arity-1 — participants win
  expect(spreadTeamIdentity(['FC Viktoria Plzeň'], 'Spread: FC Viktoria Plzeň (-1.5)')).toBe('FC Viktoria Plzeň');
});

test('team identity: arity-2 requires clean subject ∈ participants AND distinct participants', () => {
  expect(spreadTeamIdentity(['Anaheim Ducks', 'Vegas Golden Knights'], 'Vegas Golden Knights')).toBe('Vegas Golden Knights');
  // threshold-embedded subject (not a participant) → no team → no edge
  expect(spreadTeamIdentity(['Newcastle United', 'Nottingham Forest'], 'Newcastle wins by over 1.5 goals')).toBeNull();
  // handicap-fold label subject → no team
  expect(spreadTeamIdentity(['GLYPH', 'WinteR SquadronS'], 'Game Handicap: GLYPH (-1.5) vs WinteR SquadronS (+1.5)')).toBeNull();
  // dup-participant junk projections → no team even with a "clean" subject
  expect(spreadTeamIdentity(['Golden State Valkyries', 'Golden State Valkyries'], 'Golden State Valkyries')).toBeNull();
  // arity ≥3 / empty / null → no team
  expect(spreadTeamIdentity(['A', 'B', 'C'], 'A')).toBeNull();
  expect(spreadTeamIdentity([], 'A')).toBeNull();
  expect(spreadTeamIdentity(null, 'A')).toBeNull();
});

// ── pure-TS reference: the favorite-leg gate (the underdog COUNTEREXAMPLE) ───

test('favorite legs only: above + X>0 + no band; underdog below legs NEVER qualify', () => {
  expect(isFavoriteSpreadLeg('above', 1.5, null)).toBe(true);
  expect(isFavoriteSpreadLeg('above', 0.5, null)).toBe(true);
  // the commissioned counterexample: '+3.5' underdog → direction='below' (Template R)
  expect(isFavoriteSpreadLeg('below', 3.5, null)).toBe(false);
  // pick-em −0: margin ≥ 0 admits a draw → excluded by strict > 0
  expect(isFavoriteSpreadLeg('above', 0, null)).toBe(false);
  expect(isFavoriteSpreadLeg('above', null, null)).toBe(false);
  // interior band → excluded defensively
  expect(isFavoriteSpreadLeg('above', 2.5, 4.5)).toBe(false);
  expect(isFavoriteSpreadLeg('between', 1.5, 2.5)).toBe(false);
});

// ── SQL shape ─────────────────────────────────────────────────────────────────

test('writes a strict_implication / spread_winner edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'spread_winner'"); // exact pattern label (CHECK migration 077)
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('antecedent gates: match_spread favorite legs only (above, X>0, no band)', () => {
  expect(sql).toContain("event_kind = 'match_spread'");
  expect(sql).toContain("condition_direction = 'above'");
  expect(sql).toContain('value_primary::numeric > 0');
  expect(sql).toContain('value_secondary IS NULL');
  // no 'below' arm anywhere — the underdog exclusion is structural (the word
  // appears only inside the explanatory comment, never as a gate value)
  expect(sql).not.toContain("condition_direction = 'below'");
  expect(sql).not.toContain("IN ('above','below')");
});

test('margin-unit ALLOWLIST omits games (tennis games-margin counterexample) and NULL units', () => {
  for (const u of ['point', 'points', 'goal', 'goals', 'run', 'runs', 'map', 'maps', 'set', 'sets']) {
    expect(SPREAD_WINNER_UNITS).toContain(u);
  }
  expect(SPREAD_WINNER_UNITS).not.toContain('games');
  expect(SPREAD_WINNER_UNITS).not.toContain('game');
  expect(sql).toContain("lower(btrim(value_unit)) IN ('point','points','goal','goals','run','runs','map','maps','set','sets')");
});

test('whole-fixture scope gates on BOTH sides (series/F5/half slices excluded)', () => {
  // once in the spread CTE, once in the winner CTE
  const scopeGates = sql.split("(metric_scope IS NULL OR metric_scope = 'game')").length - 1;
  expect(scopeGates).toBe(2);
});

test('team identity SQL mirrors spreadTeamIdentity (arity-1 / arity-2-clean / dup-junk refusal)', () => {
  expect(sql).toContain('WHEN array_length(participants, 1) = 1 THEN participants[1]');
  expect(sql).toContain('participants[1] IS DISTINCT FROM participants[2]');
  expect(sql).toContain('AND canonical_subject = ANY(participants) THEN canonical_subject');
  expect(sql).toContain('WHERE a.ce_key IS NOT NULL AND a.team_key IS NOT NULL');
});

test('orientation: winner subject = the spread team AND a participant of its own fixture (AUD-04)', () => {
  expect(sql).toContain("event_kind = 'match_winner'");
  // pre-keyed plain-column equality (the margin-winner race_keys discipline)
  expect(sql).toContain('b.subj_key = a.team_key');
  expect(sql).toContain('lower(immutable_unaccent(btrim(canonical_subject))) AS subj_key');
  expect(sql).toContain('AND canonical_subject = ANY(participants)');
});

test('fixture pin: folded canonical_event key equality + precision-aware date gate + ordinal agreement', () => {
  expect(sql).toContain('b.ce_key = a.ce_key');
  expect(sql).toContain('lower(immutable_unaccent(btrim(canonical_event))) AS ce_key');
  // Ordinal agreement on the stamped discriminator (projected as `ord`), not
  // the retired game_ordinal(title) fn.
  expect(sql).toContain("(discriminators->>'game_ordinal')::int AS ord");
  expect(sql).toContain('b.ord IS NOT DISTINCT FROM a.ord');
  expect(sql).not.toContain('game_ordinal(a.title)');
  // the shared precision ladder on pe-grade dates
  expect(sql).toContain('a.condition_date IS NULL OR b.condition_date IS NULL');
  expect(sql).toContain("a.condition_date_precision IN ('year','month')");
  expect(sql).toContain('(a.condition_date::timestamptz)::date = (b.condition_date::timestamptz)::date');
});

test('SERIES belt is load-bearing on consequent title + canonical_event key + antecedent title', () => {
  expect(SPREAD_WINNER_SERIES_RX).toBe('\\mseries\\M');
  // both CTEs carry the title belt + the spread CTE refuses series-keyed events
  const titleBelts = sql.split(`lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_SERIES_RX}'`).length - 1;
  expect(titleBelts).toBe(2); // spread CTE + winner CTE
  expect(sql).toContain(`lower(immutable_unaccent(btrim(canonical_event))) !~ '${SPREAD_WINNER_SERIES_RX}'`);
});

test('bare-halftime mislabel belt on the consequent (mutual-exclusion HALF_RX verbatim)', () => {
  expect(SPREAD_WINNER_HALF_RX).toContain('half[- ]?time');
  expect(SPREAD_WINNER_HALF_RX).toContain('draw\\s+at\\s+(the\\s+)?half');
  expect(sql).toContain(`lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_HALF_RX}'`);
  expect(sql).toContain(`lower(immutable_unaccent(canonical_subject)) !~ '${SPREAD_WINNER_HALF_RX}'`);
});

test('G2 (§A2): the date gate carries the prone-sport LOCAL-DAY base arm (cross-game fix)', () => {
  // spread + winner CTEs now project sport, and the date ladder gets the prone
  // local-day base arm so a US-evening spread's Kalshi minute stamp (UTC date=local+1)
  // is not fused with the NEXT day's fixture winner.
  expect(sql).toContain('question_id, title, resolution_scope, sport,');
  // the prone base arm shifts the minute side to its local day (UTC date − 1)
  expect(sql).toContain('(a.condition_date::timestamptz)::date - 1) = (b.condition_date::timestamptz)::date');
  expect(sql).toContain('(b.condition_date::timestamptz)::date - 1) = (a.condition_date::timestamptz)::date');
  // gated on a prone (US) sport being involved
  expect(sql).toContain("lower(COALESCE(a.sport, '')) IN ('baseball','basketball','ice hockey','hockey')");
});

test('FT/ET resolution_scope: NULL-tolerant both-known-and-differ refusal (shared generator)', () => {
  expect(sql).toContain(
    'NOT (a.resolution_scope IS NOT NULL AND b.resolution_scope IS NOT NULL AND a.resolution_scope IS DISTINCT FROM b.resolution_scope)',
  );
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('START-INSTANT veto + ambiguous-evening refusal ride the fixture join (day-shift seam, 2026-07-30)', () => {
  // both CTEs pre-key the trusted start instant as a plain column
  expect(sql.split('AS start_at').length - 1).toBe(2);
  // divergence veto: both-known instants >= tolerance apart = two different
  // games (a US-evening spread must not imply the NEXT game's winner)
  expect(sql).toContain(`ABS(EXTRACT(EPOCH FROM (a.start_at - b.start_at))) * 1000`);
  expect(sql).toContain(`>= ${FIXTURE_START_TOLERANCE_MS}`);
  // conservative no-instant arm (prone sports, both orientations)
  expect(sql).toContain('b.start_at IS NULL');
  expect(sql).toContain('a.start_at IS NULL');
  // PM kickoff arm is self-consistency-gated; padded kalshi end_dates excluded
  expect(sql).toContain(`AT TIME ZONE 'America/New_York'`);
});
