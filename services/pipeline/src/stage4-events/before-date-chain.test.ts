import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildBeforeDateChainEdgesSql,
  beforeDateRungsCtesSql,
  parseBeforeDeadline,
  monthTokenToNumber,
  titleAfterPhrase,
} from './before-date-chain.js';

const sql = buildBeforeDateChainEdgesSql();
const ctes = beforeDateRungsCtesSql();

// edge contract (solver-facing)

test('writes a strict_implication edge with the REUSED date_implication pattern', () => {
  expect(sql).toContain("'strict_implication'");
  // pattern label reused from date-implication-xq (identical by-D1⟹by-D2 semantics)
  expect(sql).toContain("'date_implication'");
  expect(sql).toContain("'algorithmic'");
  // confidence=1.0 + deterministic TRUE so the solver hard-prunes the edge
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

// identity / soundness guards

test('raw-driven: reads yes_sub_title/custom_strike, never llm_market_normalizations', () => {
  expect(ctes).toContain(`raw->>'yes_sub_title'`);
  expect(ctes).toContain(`raw->'custom_strike'`);
  // NO dependence on normalization fields (the ladders are mostly unshaped)
  expect(ctes).not.toContain('llm_market_normalizations');
  expect(ctes).not.toContain('canonical_event');
});

test('same Kalshi event family only: pe-scoped join, kalshi platform gate', () => {
  expect(ctes).toContain(`m.platform = 'kalshi'`);
  expect(ctes).toContain('b.pe = a.pe');
});

test('CHAIN not closure: adjacent dense_rank pairs only (rk = rk + 1)', () => {
  expect(ctes).toContain('dense_rank() OVER (PARTITION BY pe, after_phrase, cs_residual ORDER BY deadline)');
  expect(ctes).toContain('b.rk = a.rk + 1');
});

test('windowed-latch guard: dated after-phrase must agree within a pair', () => {
  expect(ctes).toContain('b.after_phrase IS NOT DISTINCT FROM a.after_phrase');
  // extracted from the TITLE (the lower bound lives there, not in yes_sub_title)
  expect(ctes).toMatch(/after_phrase[\s\S]*FROM before_markets/);
  expect(ctes).toContain(`substring(m.title from '(?i)\\mafter`);
});

test('subject-discriminator guard: non-date custom_strike residual must agree', () => {
  expect(ctes).toContain(`(mr.raw->'custom_strike') - 'Date' - 'before'`);
  expect(ctes).toContain('b.cs_residual  IS NOT DISTINCT FROM a.cs_residual');
  // jsonb minus only on objects (scalar custom_strike must not crash)
  expect(ctes).toContain(`jsonb_typeof(mr.raw->'custom_strike') = 'object'`);
});

test('over-merged nodes disqualified; archived nodes excluded; no self-edges', () => {
  expect(ctes).toContain('HAVING count(DISTINCT deadline) > 1');
  expect(ctes).toContain('q.archived_at IS NULL');
  expect(ctes).toContain('b.question_id <> a.question_id');
});

test('calendar-validity guard precedes make_date (no Feb-30 crash path)', () => {
  // day validated against leap-aware month length BEFORE make_date is reachable
  expect(ctes).toMatch(/dd <= CASE[\s\S]*WHEN mm = 2 THEN CASE WHEN yy % 4 = 0 AND \(yy % 100 <> 0 OR yy % 400 = 0\) THEN 29 ELSE 28 END[\s\S]*make_date\(yy, mm, dd\)/);
});

// pure-helper: deadline parse (mirrors the SQL branch list)

test('parses the three anchored yes_sub_title forms', () => {
  expect(parseBeforeDeadline('Before May 30, 2026')).toEqual({ y: 2026, m: 5, d: 30 });
  expect(parseBeforeDeadline('before Sep 1, 2026')).toEqual({ y: 2026, m: 9, d: 1 });
  // month grain = exact first-of-month boundary; year = exact Jan 1 boundary
  expect(parseBeforeDeadline('Before January 2027')).toEqual({ y: 2027, m: 1, d: 1 });
  expect(parseBeforeDeadline('before April 2027')).toEqual({ y: 2027, m: 4, d: 1 });
  expect(parseBeforeDeadline('Before 2027')).toEqual({ y: 2027, m: 1, d: 1 });
});

test('whitespace-normalizes the rung label (live trailing-newline rows)', () => {
  expect(parseBeforeDeadline('Before Jan 31, 2028\n')).toEqual({ y: 2028, m: 1, d: 31 });
  expect(parseBeforeDeadline('  Before  Jun 1,  2026 ')).toEqual({ y: 2026, m: 6, d: 1 });
});

test('non-date residue labels do NOT parse (the byte-equal-residue gate, structurally)', () => {
  expect(parseBeforeDeadline('Before election day 2026')).toBeNull();
  expect(parseBeforeDeadline('Before Election Day')).toBeNull();
  expect(parseBeforeDeadline('Before the 2027 season')).toBeNull();
  expect(parseBeforeDeadline("Before Trump's term ends")).toBeNull();
  expect(parseBeforeDeadline('Before his term ends')).toBeNull();
  expect(parseBeforeDeadline('Before May 20')).toBeNull(); // no year → ambiguous
  expect(parseBeforeDeadline('Before October')).toBeNull(); // no year → ambiguous
});

test('custom_strike fallback fills no-year labels (priority: yes_sub_title first)', () => {
  // KXNEWDRUGAPP family: yst 'before September' + {"before": "Sep 1, 2026"}
  expect(parseBeforeDeadline('before September', 'Sep 1, 2026')).toEqual({ y: 2026, m: 9, d: 1 });
  // KXKASHOUT family: {"Date": "Before Jul 1, 2026"} (leading Before stripped)
  expect(parseBeforeDeadline('Before October', 'Before Jul 1, 2026')).toEqual({ y: 2026, m: 7, d: 1 });
  // KXZELENSKYYOUT family: ISO with time-of-day → truncated to the day
  expect(parseBeforeDeadline('Before His Exit', '2026-07-01T14:00:00.000Z')).toEqual({ y: 2026, m: 7, d: 1 });
  // yes_sub_title wins when both parse (it is the rung label)
  expect(parseBeforeDeadline('Before Jan 1, 2027', 'Jan 1, 2028')).toEqual({ y: 2027, m: 1, d: 1 });
});

test('calendar-validity: impossible dates yield null (never a make_date crash)', () => {
  expect(parseBeforeDeadline('Before Feb 29, 2027')).toBeNull();   // non-leap
  expect(parseBeforeDeadline('Before Feb 29, 2028')).toEqual({ y: 2028, m: 2, d: 29 }); // leap
  expect(parseBeforeDeadline('Before Sep 31, 2026')).toBeNull();   // 30-day month
  expect(parseBeforeDeadline('Before Whatever 2026')).toBeNull();  // not a month token
});

test('month token lookup (first 3 letters, case-insensitive)', () => {
  expect(monthTokenToNumber('September')).toBe(9);
  expect(monthTokenToNumber('Sept')).toBe(9);
  expect(monthTokenToNumber('jan')).toBe(1);
  expect(monthTokenToNumber('December')).toBe(12);
  expect(monthTokenToNumber('election')).toBeNull();
  expect(monthTokenToNumber('')).toBeNull();
});

// pure-helper: windowed-latch after-phrase

test('titleAfterPhrase extracts the dated lower bound (and only dated ones)', () => {
  expect(
    titleAfterPhrase('Will Tarik Skubal play in a game for the Tigers after May 8, 2026 and before July 13, 2026?'),
  ).toBe('after may 8, 2026');
  expect(
    titleAfterPhrase('Will OG Anunoby play in a game for the Knicks after May 7, 2026 and before May 11, 2026?'),
  ).toBe('after may 7, 2026');
  // undated 'after' is not a window lower bound
  expect(titleAfterPhrase('Will X resign after the midterms?')).toBeNull();
  expect(titleAfterPhrase('When will Freddie Mac officially announce an IPO?')).toBeNull();
  expect(titleAfterPhrase(null)).toBeNull();
});
