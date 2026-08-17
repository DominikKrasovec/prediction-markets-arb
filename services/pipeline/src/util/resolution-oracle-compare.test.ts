/**
 * resolution-oracle-compare — unit tests over the REAL live oracle pairs.
 * Every fixture cites the population it stands for, so a future relaxation of
 * the relation has to argue with a measured class rather than an invented one.
 */
import { describe, test, expect } from 'bun:test';
import {
  NON_DISCRIMINATING_ORACLES,
  discriminatingOracle,
  oraclesKnownToDiffer,
  conflictingOracles,
  discriminatingOracleSql,
  oraclesCompatibleSql,
  oraclesKnownToDifferSql,
} from './resolution-oracle-compare.js';
import { RESOLUTION_ORACLES } from '../stage1-normalize/resolution-oracle.js';

describe('NON_DISCRIMINATING_ORACLES vocabulary parity', () => {
  test('every member is a member of the Stage-1h controlled enum (never an inert typo)', () => {
    for (const v of NON_DISCRIMINATING_ORACLES) {
      expect(RESOLUTION_ORACLES.has(v)).toBe(true);
    }
  });

  test('the weather authorities are NOT exempted — the 941715898d class must stay refusable', () => {
    expect(NON_DISCRIMINATING_ORACLES.has('NWS')).toBe(false);
    expect(NON_DISCRIMINATING_ORACLES.has('NOAA')).toBe(false);
    expect(NON_DISCRIMINATING_ORACLES.has('Weather Underground')).toBe(false);
  });
});

describe('discriminatingOracle', () => {
  test('a named data authority folds to itself', () => {
    expect(discriminatingOracle('NWS')).toBe('NWS');
    expect(discriminatingOracle('Weather Underground')).toBe('Weather Underground');
  });

  test('UMA (a settlement LAYER, not a reading) folds to unknown', () => {
    expect(discriminatingOracle('UMA')).toBeNull();
  });

  test('NULL / blank / whitespace fold to unknown', () => {
    expect(discriminatingOracle(null)).toBeNull();
    expect(discriminatingOracle(undefined)).toBeNull();
    expect(discriminatingOracle('')).toBeNull();
    expect(discriminatingOracle('   ')).toBeNull();
  });

  test('surrounding whitespace is trimmed before comparison', () => {
    expect(discriminatingOracle('  NWS  ')).toBe('NWS');
    expect(discriminatingOracle('  UMA  ')).toBeNull();
  });
});

describe('oraclesKnownToDiffer — the refusal relation', () => {
  test('THE DEFECT: Weather Underground (PM/KMIA) vs NWS (Kalshi Climatological Report) differ', () => {
    // A PM 96-97°F Miami Jul 17 reading and a Kalshi 96-97° Miami Jul 17
    // reading on the same fixture — the WU/NWS population.
    expect(oraclesKnownToDiffer('Weather Underground', 'NWS')).toBe(true);
    expect(oraclesKnownToDiffer('NWS', 'Weather Underground')).toBe(true);
  });

  test('same authority never differs', () => {
    expect(oraclesKnownToDiffer('NWS', 'NWS')).toBe(false);
    expect(oraclesKnownToDiffer('CF Benchmarks', 'CF Benchmarks')).toBe(false);
  });

  test('the UMA grain artifact is NOT a conflict (all 121 live cross_ref_equiv pairs)', () => {
    // A PM leg whose clause links mlb.com stamps 'MLB'; its Predict twin, settling
    // off the SAME UMA conditionId, stamps the fallback 'UMA'. Authority grain =
    // "MLB vs unknown", never "MLB vs a rival reading".
    expect(oraclesKnownToDiffer('MLB', 'UMA')).toBe(false);
    expect(oraclesKnownToDiffer('UMA', 'HLTV')).toBe(false);
    expect(oraclesKnownToDiffer('UMA', 'CF Benchmarks')).toBe(false);
  });

  test('one-side-unknown PASSES (the both-known-and-differ NULL policy)', () => {
    expect(oraclesKnownToDiffer(null, 'NWS')).toBe(false);
    expect(oraclesKnownToDiffer('NWS', null)).toBe(false);
    expect(oraclesKnownToDiffer(null, null)).toBe(false);
  });

  test('NWS and NOAA are NOT one class (NWS daily preliminary ≠ NCEI final)', () => {
    expect(oraclesKnownToDiffer('NWS', 'NOAA')).toBe(true);
  });
});

describe('conflictingOracles — the N-slot (outcome-set) surface', () => {
  test('a set spanning two real authorities reports them sorted', () => {
    expect(conflictingOracles(['NWS', 'Weather Underground'])).toEqual([
      'NWS',
      'Weather Underground',
    ]);
  });

  test('a set with one authority + unknowns + UMA has no conflict', () => {
    expect(conflictingOracles(['MLB', null, 'UMA', '  ', 'MLB'])).toBeNull();
  });

  test('an all-unknown / empty set never contributes evidence', () => {
    expect(conflictingOracles([])).toBeNull();
    expect(conflictingOracles([null, undefined, 'UMA'])).toBeNull();
  });

  test('three-way conflicts report every authority', () => {
    expect(conflictingOracles(['NWS', 'Weather Underground', 'NOAA', 'UMA'])).toEqual([
      'NOAA',
      'NWS',
      'Weather Underground',
    ]);
  });
});

describe('SQL mirrors', () => {
  test('discriminatingOracleSql folds the non-discriminating vocabulary to NULL', () => {
    const sql = discriminatingOracleSql('n.resolution_source');
    expect(sql).toContain("'UMA'");
    expect(sql).toContain('btrim(n.resolution_source)');
    expect(sql).toContain('NULLIF');
  });

  test('oraclesCompatibleSql is a NOT(both-known-and-differ) conjunct', () => {
    const sql = oraclesCompatibleSql('ra.resolution_source', 'rb.resolution_source');
    expect(sql.startsWith('NOT (')).toBe(true);
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).toContain('ra.resolution_source');
    expect(sql).toContain('rb.resolution_source');
  });

  test('the audit predicate is the exact negation of the builder conjunct', () => {
    const keep = oraclesCompatibleSql('a.rs', 'b.rs');
    expect(oraclesKnownToDifferSql('a.rs', 'b.rs')).toBe(`NOT (${keep})`);
  });
});
