/**
 * Pure unit tests for the verdict-mapping core of check-resolved-consistency.ts.
 * No DB — the DB scan is exercised by running the script itself (read-only).
 *
 * Label fixtures mirror REAL resolved payloads (probe data/exports/
 * w3c-resolution-probe*.ts): PM label-vocabulary winners ('GAM Esports', 'Up'),
 * Kalshi/Predict/Limitless 'Yes'/'No', and the platform-faithful void sentinels.
 */
import { test, expect } from 'bun:test';
import {
  marketVerdict,
  aggregateQuestionVerdict,
  evaluateSet,
} from './check-resolved-consistency.js';

// ─── marketVerdict ────────────────────────────────────────────────────────────

test('Yes/No vocabulary (kalshi, predict, limitless) maps case-insensitively', () => {
  expect(marketVerdict('Yes', ['Yes', 'No'])).toBe('YES');
  expect(marketVerdict('No', ['Yes', 'No'])).toBe('NO');
  expect(marketVerdict('YES', null)).toBe('YES'); // vocabulary not required for yes/no
  expect(marketVerdict('no', null)).toBe('NO');
});

test('void sentinels map to VOID (excluded from implication checks)', () => {
  expect(marketVerdict('VOID_5050', ['Up', 'Down'])).toBe('VOID'); // PM 50/50
  expect(marketVerdict('VOID', ['Yes', 'No'])).toBe('VOID');       // Kalshi void
});

test('PM label winner maps through outcomes order: index 0 = YES side, 1 = NO side', () => {
  // real payload: "First Blood in Game 2?" outcomes [GAM Esports, Ground Zero Gaming], GAM won
  expect(marketVerdict('GAM Esports', ['GAM Esports', 'Ground Zero Gaming'])).toBe('YES');
  // real payload: "Map Handicap Z7 vs VP.Future", VP.Future (index 1) won → market NO side
  expect(marketVerdict('VP.Future', ['Z7 Esports', 'VP.Future'])).toBe('NO');
  expect(marketVerdict('Up', ['Up', 'Down'])).toBe('YES');
  expect(marketVerdict('Down', ['Up', 'Down'])).toBe('NO');
});

test('outcomes may arrive as a JSON string (jsonb column round-trip)', () => {
  expect(marketVerdict('GAM Esports', '["GAM Esports", "Ground Zero Gaming"]')).toBe('YES');
});

test('never guess: null winner / unknown label / non-binary vocabulary → UNKNOWN', () => {
  expect(marketVerdict(null, ['Yes', 'No'])).toBe('UNKNOWN');
  expect(marketVerdict('', ['Yes', 'No'])).toBe('UNKNOWN');
  expect(marketVerdict('Maybe', ['Yes', 'No'])).toBe('UNKNOWN');           // label not in vocab
  expect(marketVerdict('B', ['A', 'B', 'C'])).toBe('UNKNOWN');             // 3-way: no binary side
  expect(marketVerdict('GAM Esports', null)).toBe('UNKNOWN');              // label without vocab
});

// ─── aggregateQuestionVerdict ─────────────────────────────────────────────────

test('question verdict aggregation', () => {
  expect(aggregateQuestionVerdict(['YES'])).toBe('YES');
  expect(aggregateQuestionVerdict(['NO', 'NO'])).toBe('NO');
  expect(aggregateQuestionVerdict(['YES', 'NO'])).toBe('MIXED');           // intra-question violation
  expect(aggregateQuestionVerdict(['VOID'])).toBe('VOID');
  expect(aggregateQuestionVerdict(['UNKNOWN'])).toBe('UNRESOLVED');
  expect(aggregateQuestionVerdict([])).toBe('UNRESOLVED');
  // UNKNOWN members don't poison a decisive sibling; VOID doesn't either
  expect(aggregateQuestionVerdict(['YES', 'UNKNOWN', 'VOID'])).toBe('YES');
});

// ─── evaluateSet ──────────────────────────────────────────────────────────────

test('sigma=1 (exhaustive): exactly one YES among fully-resolved slots is clean', () => {
  expect(evaluateSet(['YES', 'NO', 'NO'], true, 'categorical')).toBeNull();
});

test('>=2 YES violates both exhaustive and mutex CATEGORICAL sets, even partially resolved', () => {
  expect(evaluateSet(['YES', 'YES', null], true, 'categorical')).toBe('multi_yes');
  expect(evaluateSet(['YES', 'YES', 'NO'], false, 'categorical')).toBe('multi_yes');
});

test('sigma=1 categorical: fully resolved with 0 YES → zero_yes violation', () => {
  expect(evaluateSet(['NO', 'NO', 'NO'], true, 'categorical')).toBe('zero_yes');
});

test('sigma<=1 (mutex, non-exhaustive): all-NO is the legal all-false world', () => {
  expect(evaluateSet(['NO', 'NO', 'NO'], false, 'categorical')).toBeNull();
});

test('zero_yes cannot fire while any slot is unresolved / void / mixed', () => {
  expect(evaluateSet(['NO', 'NO', null], true, 'categorical')).toBeNull();      // open slot
  expect(evaluateSet(['NO', 'NO', 'VOID'], true, 'categorical')).toBeNull();    // voided slot — Ω not covered
  expect(evaluateSet(['NO', 'NO', 'MIXED'], true, 'categorical')).toBeNull();   // broken question excluded
  expect(evaluateSet([], true, 'categorical')).toBeNull();                      // degenerate empty set
});

test('single YES with open siblings is clean (partial resolution)', () => {
  expect(evaluateSet(['YES', null, null], true, 'categorical')).toBeNull();
});

// ─── threshold_series: monotone order-ideal ladder, NOT one-hot ────────────────

test('threshold_series: multiple-YES cumulative ladder is SOUND (not multi_yes)', () => {
  // e.g. total games > 17.5 / > 22.5 / > 27.5 all YES → value above all thresholds
  expect(evaluateSet(['YES', 'YES', 'YES'], true, 'threshold_series')).toBeNull();
  expect(evaluateSet(['NO', 'YES', 'YES'], true, 'threshold_series')).toBeNull();   // YES suffix
  expect(evaluateSet(['YES', 'YES', 'NO'], true, 'threshold_series')).toBeNull();   // YES prefix
});

test('threshold_series: zero-YES ladder is SOUND (value below all thresholds)', () => {
  expect(evaluateSet(['NO', 'NO', 'NO'], true, 'threshold_series')).toBeNull();
});

test('threshold_series: non-monotone (YES sandwiched by NO) is a ladder_break', () => {
  expect(evaluateSet(['NO', 'YES', 'NO'], true, 'threshold_series')).toBe('ladder_break');
  expect(evaluateSet(['YES', 'NO', 'YES'], true, 'threshold_series')).toBe('ladder_break');
});

test('threshold_series: void/unknown gaps do not break a monotone ladder', () => {
  expect(evaluateSet(['NO', null, 'YES', 'VOID', 'YES'], true, 'threshold_series')).toBeNull();
  // but a real interleave across a gap still breaks:
  expect(evaluateSet(['YES', null, 'NO', 'YES'], true, 'threshold_series')).toBe('ladder_break');
});
