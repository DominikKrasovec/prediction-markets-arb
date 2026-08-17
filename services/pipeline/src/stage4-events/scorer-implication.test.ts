import { test, expect } from 'bun:test';
import { FIXTURE_START_TOLERANCE_MS } from '../util/fixture-instant.js';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildScorerImplicationEdgesSql,
  isFirstScorerEvent,
  isAnytimeScorerEvent,
  scorerPairAdmissible,
} from './scorer-implication.js';

const sql = buildScorerImplicationEdgesSql();

// pure-TS reference: anchors

test('antecedent anchor: <subject> first goalscorer, exact folded suffix', () => {
  expect(isFirstScorerEvent('brock nelson first goalscorer', 'Brock Nelson')).toBe(true);
  // NEGATIVE: the player-prop goals key is NOT a first-scorer event
  expect(isFirstScorerEvent('brock nelson goals', 'Brock Nelson')).toBe(false);
  // NEGATIVE: another player's event never anchors
  expect(isFirstScorerEvent('cale makar first goalscorer', 'Brock Nelson')).toBe(false);
});

test('consequent anchor: <subject> goals (the Template-S / player-prop key)', () => {
  expect(isAnytimeScorerEvent('gorka guruzeta goals', 'Gorka Guruzeta')).toBe(true);
  // NEGATIVE: first-scorer events are not anytime consequents
  expect(isAnytimeScorerEvent('gorka guruzeta first goalscorer', 'Gorka Guruzeta')).toBe(false);
});

// pure-TS reference: pair admissibility (the discriminator stamps)

test('admissible: rank-binary first ⟹ count-binary anytime, same player', () => {
  expect(scorerPairAdmissible({
    aMetric: 'rank', bMetric: 'count',
    aValuePrimary: null, bValuePrimary: null,
    aSubject: 'Brock Nelson', bSubject: 'brock nelson',
  })).toBe(true);
});

test('NEGATIVE: a threshold consequent ("2+ goals") is never implied', () => {
  expect(scorerPairAdmissible({
    aMetric: 'rank', bMetric: 'count',
    aValuePrimary: null, bValuePrimary: 2,
    aSubject: 'Brock Nelson', bSubject: 'Brock Nelson',
  })).toBe(false);
});

test('NEGATIVE: the REVERSE direction (anytime ⟹ first) is inadmissible', () => {
  // metric roles swapped = the reverse orientation — another player can score first
  expect(scorerPairAdmissible({
    aMetric: 'count', bMetric: 'rank',
    aValuePrimary: null, bValuePrimary: null,
    aSubject: 'Brock Nelson', bSubject: 'Brock Nelson',
  })).toBe(false);
});

test('NEGATIVE: cross-player pairs never relate', () => {
  expect(scorerPairAdmissible({
    aMetric: 'rank', bMetric: 'count',
    aValuePrimary: null, bValuePrimary: null,
    aSubject: 'Brock Nelson', bSubject: 'Cale Makar',
  })).toBe(false);
});

test('NEGATIVE: count-vs-count (two anytime binaries) never relate here', () => {
  expect(scorerPairAdmissible({
    aMetric: 'count', bMetric: 'count',
    aValuePrimary: null, bValuePrimary: null,
    aSubject: 'Brock Nelson', bSubject: 'Brock Nelson',
  })).toBe(false);
});

// SQL shape

test('writes a strict_implication / first_anytime_scorer edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'first_anytime_scorer'");
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('antecedent gates: rank-metric binary first-scorer with the folded event anchor', () => {
  expect(sql).toContain("event_kind = 'player_prop_threshold'");
  expect(sql).toContain("condition_metric = 'rank'");
  expect(sql).toContain("|| ' first goalscorer'");
  expect(sql).toContain("condition_shape = 'binary_event'");
});

test('consequent gates: count-metric binary anytime with the goals anchor + unit belt', () => {
  expect(sql).toContain("condition_metric = 'count'");
  expect(sql).toContain("|| ' goals'");
  expect(sql).toContain("(value_unit IS NULL OR lower(btrim(value_unit)) IN ('goal','goals'))");
});

test('NEGATIVE pins: threshold arms excluded (null values BOTH sides)', () => {
  const nullValueGates = sql.match(/value_primary IS NULL/g) ?? [];
  expect(nullValueGates.length).toBeGreaterThanOrEqual(2);
  const nullSecondaryGates = sql.match(/value_secondary IS NULL/g) ?? [];
  expect(nullSecondaryGates.length).toBeGreaterThanOrEqual(2);
});

test('fixture identity: same player + NON-NULL day-or-finer date + precision ladder', () => {
  expect(sql).toContain('b.subj_key = a.subj_key');
  const dateGates = sql.match(/condition_date IS NOT NULL/g) ?? [];
  expect(dateGates.length).toBeGreaterThanOrEqual(2);
  expect(sql).toContain("NOT IN ('year','month')");
  expect(sql).toContain('EXTRACT(EPOCH FROM');
});

test('FT/ET window belt: both-known-and-differ resolution_scope conjunct', () => {
  expect(sql).toContain('a.resolution_scope');
  expect(sql).toContain('b.resolution_scope');
  expect(sql).toContain('IS DISTINCT FROM');
});

test('one-directional: antecedent CTE is first_scorer, consequent CTE is anytime_scorer', () => {
  expect(sql).toContain('FROM first_scorer a');
  expect(sql).toContain('JOIN anytime_scorer b');
  expect(sql).toContain('b.question_id <> a.question_id');
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('START-INSTANT veto + ambiguous-evening refusal ride the date gate (day-shift seam, 2026-07-30)', () => {
  // The date gate is this rule's ONLY fixture pin; both CTEs pre-key the instant.
  expect(sql.split('AS start_at').length - 1).toBe(2);
  expect(sql).toContain(`ABS(EXTRACT(EPOCH FROM (a.start_at - b.start_at))) * 1000`);
  expect(sql).toContain(`>= ${FIXTURE_START_TOLERANCE_MS}`);
  expect(sql).toContain('b.start_at IS NULL');
  expect(sql).toContain('a.start_at IS NULL');
  expect(sql).toContain(`AT TIME ZONE 'America/New_York'`);
});
