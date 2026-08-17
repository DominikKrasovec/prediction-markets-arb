import { test, expect, describe } from 'bun:test';
import {
  DAY_SHIFT_PRONE_SPORTS,
  FIXTURE_LOCAL_DATE_ZONE,
  FIXTURE_START_KINDS,
  FIXTURE_START_KINDS_SQL,
  FIXTURE_START_TOLERANCE_MS,
  ambiguousEveningConflict,
  ambiguousEveningRefusalSql,
  fixtureStartInstantMs,
  fixtureStartInstantSql,
  fixtureStartInstantsDiverge,
  fixtureStartVetoSql,
} from './fixture-instant.js';

// A representative episode: a kalshi market (July-20 Mets–Brewers, UTC
// instant 2026-07-21T02:40Z) vs a PM market for the NEXT game (local day
// 2026-07-21, kickoff end_date 2026-07-21T23:40Z) vs the CORRECT PM partner
// (local day 2026-07-20, kickoff 2026-07-20T23:40Z).
const KALSHI_JUL20 = {
  platform: 'kalshi', end_date: '2026-07-23 23:40:00+00',
  condition_date: '2026-07-21T02:40:00Z', condition_date_precision: 'minute',
};
const PM_JUL21 = {
  platform: 'polymarket', end_date: '2026-07-21 23:40:00+00',
  condition_date: '2026-07-21', condition_date_precision: 'day',
};
const PM_JUL20 = {
  platform: 'polymarket', end_date: '2026-07-20 23:40:00+00',
  condition_date: '2026-07-20', condition_date_precision: 'day',
};

describe('fixtureStartInstantMs — trusted sources only', () => {
  test('kalshi minute stamp IS the instant; its padded end_date is never trusted', () => {
    expect(fixtureStartInstantMs(KALSHI_JUL20)).toBe(Date.parse('2026-07-21T02:40:00Z'));
    // day-precision kalshi (no minute stamp) → NO instant, despite an end_date
    expect(fixtureStartInstantMs({ ...KALSHI_JUL20, condition_date: '2026-07-20', condition_date_precision: 'day' })).toBeNull();
  });

  test('PM kickoff end_date passes ONLY when self-consistent with the local-day stamp', () => {
    // 23:40Z = 19:40 US-Eastern on the SAME local day → trusted kickoff
    expect(fixtureStartInstantMs(PM_JUL21)).toBe(Date.parse('2026-07-21T23:40:00Z'));
    expect(fixtureStartInstantMs(PM_JUL20)).toBe(Date.parse('2026-07-20T23:40:00Z'));
    // the ITF-tennis +7d settlement pad: ET date != day stamp → refused
    expect(fixtureStartInstantMs({
      platform: 'polymarket', end_date: '2026-07-31 14:00:00+00',
      condition_date: '2026-07-24', condition_date_precision: 'day',
    })).toBeNull();
  });

  test('predict midnight-artifact end_date yields NO instant (day grain, wrong platform arm)', () => {
    expect(fixtureStartInstantMs({
      platform: 'predict', end_date: '2026-07-30 00:00:00+00',
      condition_date: '2026-07-30', condition_date_precision: 'day',
    })).toBeNull();
  });

  test('NULL-tolerant: unknown fields never manufacture an instant', () => {
    expect(fixtureStartInstantMs({ platform: 'kalshi', condition_date: null })).toBeNull();
    expect(fixtureStartInstantMs({ platform: 'polymarket', end_date: null, condition_date: '2026-07-21', condition_date_precision: 'day' })).toBeNull();
    expect(fixtureStartInstantMs({ platform: 'kalshi', condition_date: 'TBD', condition_date_precision: 'minute' })).toBeNull();
  });
});

describe('fixtureStartInstantsDiverge — refuse-only, valley-calibrated', () => {
  const k = fixtureStartInstantMs(KALSHI_JUL20);
  test('the episode pair (21h apart) diverges; the correct partner (3h) does not', () => {
    expect(fixtureStartInstantsDiverge(k, fixtureStartInstantMs(PM_JUL21))).toBe(true);
    expect(fixtureStartInstantsDiverge(k, fixtureStartInstantMs(PM_JUL20))).toBe(false);
  });
  test('one-side-null abstains (never a refusal without positive evidence)', () => {
    expect(fixtureStartInstantsDiverge(k, null)).toBe(false);
    expect(fixtureStartInstantsDiverge(null, null)).toBe(false);
  });
  test('the 10h boundary is inclusive (>= tolerance refuses)', () => {
    expect(fixtureStartInstantsDiverge(0, FIXTURE_START_TOLERANCE_MS)).toBe(true);
    expect(fixtureStartInstantsDiverge(0, FIXTURE_START_TOLERANCE_MS - 1)).toBe(false);
  });
});

describe('ambiguousEveningConflict — conservative no-instant arm, prone-gated', () => {
  const kalshiEvening = { ...KALSHI_JUL20 };
  const bareDay = { platform: 'predict', end_date: '2026-07-21 00:00:00+00', condition_date: '2026-07-21', condition_date_precision: 'day' };
  test('pre-dawn-UTC minute × bare local day refuses on a prone sport (either side)', () => {
    expect(ambiguousEveningConflict(kalshiEvening, bareDay, 10, 'baseball', null)).toBe(true);
    expect(ambiguousEveningConflict(bareDay, kalshiEvening, 10, null, 'Baseball')).toBe(true);
  });
  test('non-prone sports keep the validated Asia-morning merges (no refusal)', () => {
    expect(ambiguousEveningConflict(kalshiEvening, bareDay, 10, 'esports', 'soccer')).toBe(false);
    expect(ambiguousEveningConflict(kalshiEvening, bareDay, 10, null, null)).toBe(false);
  });
  test('a day side WITH a trusted instant defers to the divergence veto instead', () => {
    expect(ambiguousEveningConflict(kalshiEvening, PM_JUL21, 10, 'baseball', 'baseball')).toBe(false);
  });
  test('a post-cutoff UTC hour is unambiguous — no refusal', () => {
    const noon = { ...KALSHI_JUL20, condition_date: '2026-07-20T17:10:00Z' };
    expect(ambiguousEveningConflict(noon, bareDay, 10, 'baseball', null)).toBe(false);
  });
});

describe('SQL generators — shape parity with the TS mirrors', () => {
  test('instant extraction: PM self-consistency gate + minute arm + zone pin', () => {
    const sql = fixtureStartInstantSql('a', '::timestamptz');
    expect(sql).toContain(`a.platform = 'polymarket'`);
    expect(sql).toContain(`AT TIME ZONE '${FIXTURE_LOCAL_DATE_ZONE}'`);
    expect(sql).toContain(`a.condition_date_precision = 'day'`);
    expect(sql).toContain(`a.condition_date_precision = 'minute'`);
    expect(sql).toContain('a.condition_date::timestamptz');
    // kalshi/predict end_dates must never appear as an instant source arm
    expect(sql).not.toContain(`'kalshi'`);
    expect(sql).not.toContain(`'predict'`);
  });
  test('veto: refuse-only NOT(...) with the shared tolerance, NULL-abstaining', () => {
    const sql = fixtureStartVetoSql('a.start_at', 'b.start_at');
    expect(sql).toMatch(/^NOT \(/);
    expect(sql).toContain(`>= ${FIXTURE_START_TOLERANCE_MS}`);
    expect(sql).toContain('a.start_at IS NOT NULL AND b.start_at IS NOT NULL');
  });
  test('ambiguous-evening: both orientations, prone tuple, no-instant + pre-cutoff-hour conjuncts', () => {
    const sql = ambiguousEveningRefusalSql('a', 'b', 'a.start_at', 'b.start_at', 10, '::timestamptz');
    expect(sql).toMatch(/^NOT \(/);
    expect(sql).toContain(`'baseball'`);
    expect(sql).toContain('b.start_at IS NULL');
    expect(sql).toContain('a.start_at IS NULL');
    expect(sql).toContain('< 10');
    expect(sql.split(`condition_date_precision = 'minute'`).length - 1).toBe(2);
  });
  test('kind scope: SQL tuple emitted from the TS set (cannot drift)', () => {
    for (const k of FIXTURE_START_KINDS) expect(FIXTURE_START_KINDS_SQL).toContain(`'${k}'`);
    expect(FIXTURE_START_KINDS).toContain('player_prop_threshold');
    expect(DAY_SHIFT_PRONE_SPORTS).toContain('baseball');
  });
});
