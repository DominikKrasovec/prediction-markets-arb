import { test, expect } from 'bun:test';
import { FIXTURE_START_TOLERANCE_MS } from '../util/fixture-instant.js';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildFixtureTotalsEdgesSql,
  bttsImpliesOverLine,
  dominatesLine,
  laddersOver,
  isMatchLevelTotal,
  isTeamTotal,
  unitKeysCompatible,
  FIXTURE_TOTALS_GOAL_UNITS,
  FIXTURE_TOTALS_SLICE_SCOPES,
} from './fixture-totals.js';

const sql = buildFixtureTotalsEdgesSql();

// pure-TS reference: BTTS line bound (BTTS proves exactly total ≥ 2)

test('S2: BTTS clears only goal lines < 2 (0.5 / 1.5); 2+ is NOT implied', () => {
  expect(bttsImpliesOverLine(0.5)).toBe(true);
  expect(bttsImpliesOverLine(1.5)).toBe(true);
  // NEGATIVE: 1-1 satisfies BTTS with total exactly 2 — "over 2.5" can be FALSE
  expect(bttsImpliesOverLine(2)).toBe(false);
  expect(bttsImpliesOverLine(2.5)).toBe(false);
  expect(bttsImpliesOverLine(3.5)).toBe(false);
});

// pure-TS reference: line dominance (most arms admit equality; the ladder arm is strict)

test('S3/S4/G5 dominance admits equality; reversed lines never pass', () => {
  expect(dominatesLine(5.5, 4.5)).toBe(true);
  expect(dominatesLine(4.5, 4.5)).toBe(true);   // team > 4.5 ⇒ game > 4.5
  // NEGATIVE: team over 4.5 does NOT clear a game line of 5.5
  expect(dominatesLine(4.5, 5.5)).toBe(false);
});

test('G1 ladder is STRICT: equal lines are equivalence, not implication', () => {
  expect(laddersOver(10.5, 4.5)).toBe(true);
  // NEGATIVE: equal lines and reversed lines never ladder
  expect(laddersOver(4.5, 4.5)).toBe(false);
  expect(laddersOver(1.5, 4.5)).toBe(false);
});

// pure-TS reference: match-level vs per-team identification

test('match-level total: subject must be known and NOT a participant', () => {
  expect(isMatchLevelTotal('Over/Under', ['Lens', 'Lyon'])).toBe(true);
  // NEGATIVE: per-team total (a team score is not the match total)
  expect(isMatchLevelTotal('Lyon', ['Lens', 'Lyon'])).toBe(false);
  // NEGATIVE: doubt → no edge (NULL subject / participants)
  expect(isMatchLevelTotal(null, ['Lens', 'Lyon'])).toBe(false);
  expect(isMatchLevelTotal('Over/Under', null)).toBe(false);
});

test('team total: scope=team OR subject ∈ participants at whole-game scope only', () => {
  expect(isTeamTotal('team', 'Los Angeles Dodgers Over 1.5 Runs', ['Giants', 'Dodgers'])).toBe(true);
  expect(isTeamTotal(null, 'Lyon', ['Lens', 'Lyon'])).toBe(true);
  expect(isTeamTotal('game', 'Lyon', ['Lens', 'Lyon'])).toBe(true);
  // NEGATIVE: a sub-game slice is NOT a whole-game team total
  expect(isTeamTotal('half_1', 'Lyon', ['Lens', 'Lyon'])).toBe(false);
  // NEGATIVE: match-level subject without the team scope is not a team total
  expect(isTeamTotal(null, 'Over/Under', ['Lens', 'Lyon'])).toBe(false);
  expect(isTeamTotal(null, null, ['Lens', 'Lyon'])).toBe(false);
});

// pure-TS reference: unit gates

test('unit keys: plural fold only — never cross-quantity', () => {
  expect(unitKeysCompatible('goal', 'goals')).toBe(true);
  expect(unitKeysCompatible('goals', 'goal')).toBe(true);
  expect(unitKeysCompatible('runs', 'runs')).toBe(true);
  // NEGATIVE: cross-quantity co-keyed fixtures never match
  expect(unitKeysCompatible('goals', 'corners')).toBe(false);
  expect(unitKeysCompatible('goals', 'cards')).toBe(false);
  expect(unitKeysCompatible('runs', 'kills')).toBe(false);
});

test('S2 consequent unit allowlist is goals ONLY (cards/corners/kills excluded)', () => {
  expect(FIXTURE_TOTALS_GOAL_UNITS).toEqual(['goal', 'goals']);
  for (const bad of ['corner', 'corners', 'card', 'cards', 'kill', 'kills', 'point', 'points']) {
    expect(FIXTURE_TOTALS_GOAL_UNITS).not.toContain(bad);
  }
});

test('G5 slice scopes: temporal sub-periods only (no map/period/series/team)', () => {
  expect(FIXTURE_TOTALS_SLICE_SCOPES).toEqual(['first_5', 'half_1', 'half_2']);
  for (const bad of ['map', 'period', 'series', 'team', 'game']) {
    expect(FIXTURE_TOTALS_SLICE_SCOPES).not.toContain(bad);
  }
});

// SQL shape

test('emits all five arm-scoped pattern labels with the solver contract', () => {
  for (const pattern of [
    'btts_total_over', 'team_game_total_over', 'spread_total_over',
    'fixture_total_ladder', 'slice_game_total_over',
  ]) {
    expect(sql).toContain(`'${pattern}'`);
  }
  expect(sql).toContain("'strict_implication'");
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
  // five INSERT CTEs, one per arm
  expect(sql.split('INSERT INTO implication_edges').length - 1).toBe(5);
});

test('above-direction only: the below/under side is never an arm (reverse is unsound)', () => {
  expect(sql).toContain("condition_direction = 'above'");
  expect(sql).not.toContain("condition_direction = 'below'");
  expect(sql).not.toContain("IN ('above','below')");
  expect(sql).not.toContain('mutual_exclusion');
});

test('consequent is a match-LEVEL whole-game total (CLASS B per-team guard + scope)', () => {
  expect(sql).toContain('NOT (canonical_subject = ANY(participants))');
  expect(sql).toContain("(metric_scope IS NULL OR metric_scope = 'game')");
  // NULL-rejecting gates: unvalued/unitless/banded totals never pair
  expect(sql).toContain('value_primary IS NOT NULL');
  expect(sql).toContain('value_secondary IS NULL');
  expect(sql).toContain('value_unit IS NOT NULL');
});

test('S2: load-bearing goal-unit gate + the strict line<2 bound', () => {
  expect(sql).toContain("b.unit_key IN ('goal','goals')");
  expect(sql).toContain('b.line < 2');
});

test('G1 addendum: fixture_total_ladder arm refuses undated/coarse pairs (same-pairing-different-match)', () => {
  expect(sql).toContain('AND a.condition_date IS NOT NULL AND b.condition_date IS NOT NULL');
  expect(sql).toContain("a.condition_date_precision NOT IN ('year','month')");
  expect(sql).toContain("b.condition_date_precision NOT IN ('year','month')");
});

test('S3: team-total identification (scope=team OR subject ∈ participants) + >= dominance', () => {
  expect(sql).toContain("metric_scope = 'team'");
  expect(sql).toContain('canonical_subject = ANY(participants)');
  expect(sql).toContain('a.line >= b.line');
});

test('S4: spread-winner favorite-leg gates verbatim (above, X>0, no band, unit allowlist, series belts)', () => {
  expect(sql).toContain("event_kind = 'match_spread'");
  expect(sql).toContain('value_primary::numeric > 0');
  expect(sql).toContain(
    "lower(btrim(value_unit)) IN ('point','points','goal','goals','run','runs','map','maps','set','sets')",
  );
  // series belt on both the title and the canonical_event key
  expect(sql).toContain("lower(immutable_unaccent(title)) !~ '\\mseries\\M'");
  expect(sql).toContain("!~ '\\mseries\\M'");
  expect(sql).toContain('a.margin >= b.line');
});

test('G1: STRICT ladder + explicit cross-set residue exclusion (never relies on ON CONFLICT)', () => {
  expect(sql).toContain('a.line > b.line');
  expect(sql).toContain('NOT EXISTS');
  expect(sql).toContain('outcome_set_slots s1');
  expect(sql).toContain('s1.set_id = s2.set_id');
});

test('G5: scope-identified slices, NULL-ordinal both sides, >= dominance', () => {
  expect(sql).toContain("metric_scope IN ('first_5','half_1','half_2')");
  expect(sql).toContain('a.ord IS NULL AND b.ord IS NULL');
});

test('fixture pin on EVERY arm: ce_key + participants + ordinal + precision-aware date gate', () => {
  // five arms → five fixture joins, each with the full conjunct set
  expect(sql.split('b.ce_key = a.ce_key').length - 1).toBe(5);
  expect(sql.split('b.parts = a.parts').length - 1).toBe(5);
  expect(sql.split('b.ord IS NOT DISTINCT FROM a.ord').length - 1).toBe(5);
  // the shared precision ladder on pe-grade dates guards against a home/away two-leg mismatch
  expect(sql.split('a.condition_date IS NULL OR b.condition_date IS NULL').length - 1).toBe(5);
  expect(sql).toContain("a.condition_date_precision IN ('year','month')");
  expect(sql).toContain('(a.condition_date::timestamptz)::date = (b.condition_date::timestamptz)::date');
  // pre-keyed plain columns (the spread-winner MATERIALIZED discipline)
  expect(sql).toContain('AS MATERIALIZED');
  expect(sql).toContain('lower(immutable_unaccent(btrim(canonical_event))) AS ce_key');
  // the per-arm `ord` is projected from the stamped discriminator (5 arms),
  // not from a title-parsed ordinal.
  expect(sql.split("(discriminators->>'game_ordinal')::int AS ord").length - 1).toBe(5);
  expect(sql).not.toContain('game_ordinal(title)');
});

test('FT/ET + metric belts: NULL-tolerant both-known-and-differ on every arm', () => {
  // resolution_scope conjunct rides in the shared fixture join (5 arms)
  expect(
    sql.split('NOT (a.resolution_scope IS NOT NULL AND b.resolution_scope IS NOT NULL AND a.resolution_scope IS DISTINCT FROM b.resolution_scope)').length - 1,
  ).toBe(5);
  // condition_metric belt on the same-kind arms
  expect(
    sql.split('NOT (a.condition_metric IS NOT NULL AND b.condition_metric IS NOT NULL AND a.condition_metric IS DISTINCT FROM b.condition_metric)').length - 1,
  ).toBe(3);
});

test('first-writer-wins idempotency on every arm', () => {
  expect(sql.split(EDGE_CONFLICT_SQL).length - 1).toBe(5);
});

test('START-INSTANT veto + ambiguous-evening refusal on EVERY arm (day-shift seam, 2026-07-30)', () => {
  // each of the 5 CTEs pre-keys the trusted start instant as a plain column,
  // and every arm's fixture join carries the divergence veto (both-known,
  // >= tolerance means two different games).
  expect(sql.split('AS start_at').length - 1).toBe(5);
  expect(sql.split(`ABS(EXTRACT(EPOCH FROM (a.start_at - b.start_at))) * 1000`).length - 1).toBe(5);
  expect(sql).toContain(`>= ${FIXTURE_START_TOLERANCE_MS}`);
  // The conservative no-instant arm (pre-dawn-UTC minute stamp x bare local
  // day on a back-to-back-prone sport) refuses in both orientations.
  expect(sql.split('b.start_at IS NULL').length - 1).toBe(5);
  expect(sql.split('a.start_at IS NULL').length - 1).toBe(5);
  expect(sql).toContain(`'baseball'`);
  expect(sql).toContain(`AT TIME ZONE 'America/New_York'`);
});
