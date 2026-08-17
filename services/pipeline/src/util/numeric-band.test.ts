import { test, expect, describe } from 'bun:test';
import {
  foldUnitMultiplier,
  gatedInterval,
  parseBandInterval,
  intervalsOverlap,
} from './numeric-band.js';

const NEG = Number.NEGATIVE_INFINITY;
const POS = Number.POSITIVE_INFINITY;

describe('foldUnitMultiplier', () => {
  test('magnitude units fold to a multiplier + dim mag', () => {
    expect(foldUnitMultiplier('billion')).toEqual({ mult: 1e9, dim: 'mag' });
    expect(foldUnitMultiplier('b')).toEqual({ mult: 1e9, dim: 'mag' });
    expect(foldUnitMultiplier('bn')).toEqual({ mult: 1e9, dim: 'mag' });
    expect(foldUnitMultiplier('t')).toEqual({ mult: 1e12, dim: 'mag' });
    expect(foldUnitMultiplier('trillion')).toEqual({ mult: 1e12, dim: 'mag' });
    expect(foldUnitMultiplier('k')).toEqual({ mult: 1e3, dim: 'mag' });
    expect(foldUnitMultiplier('million')).toEqual({ mult: 1e6, dim: 'mag' });
  });
  test('percent → dim pct; unknown unit → its own dim; null → ?', () => {
    expect(foldUnitMultiplier('%')).toEqual({ mult: 1, dim: 'pct' });
    expect(foldUnitMultiplier('percentage_point')).toEqual({ mult: 1, dim: 'pct' });
    expect(foldUnitMultiplier('seats')).toEqual({ mult: 1, dim: 'seats' });
    expect(foldUnitMultiplier(null)).toEqual({ mult: 1, dim: '?' });
    expect(foldUnitMultiplier('')).toEqual({ mult: 1, dim: '?' });
  });
});

describe('gatedInterval', () => {
  test('the billion-vs-trillion trap normalizes through the unit fold', () => {
    // ≥400 billion vs <1 trillion: raw 400 > 1 but 4e11 < 1e12 → they OVERLAP.
    const above = gatedInterval('above', 400, null, 'billion');
    const below = gatedInterval('below', 1, null, 'trillion');
    expect(above).toEqual({ lo: 4e11, hi: POS, dim: 'mag' });
    expect(below).toEqual({ lo: NEG, hi: 1e12, dim: 'mag' });
    expect(intervalsOverlap(above!, below!)).toBe(true);
  });
  test('between needs vs; at is a point; null value/dir → null', () => {
    expect(gatedInterval('between', 250, 280, 'billion')).toEqual({ lo: 2.5e11, hi: 2.8e11, dim: 'mag' });
    expect(gatedInterval('between', 250, null, 'billion')).toBeNull();
    expect(gatedInterval('at', 25, null, null)).toEqual({ lo: 25, hi: 25, dim: '?' });
    expect(gatedInterval('above', null, null, 'usd')).toBeNull();
    expect(gatedInterval(null, 5, null, 'usd')).toBeNull();
  });
});

describe('parseBandInterval accepts', () => {
  test('two-sided key bands (unit inheritance, decimals, 3-digit seats)', () => {
    expect(parseBandInterval('250_280b')).toEqual({ lo: 2.5e11, hi: 2.8e11, dim: 'mag' });
    expect(parseBandInterval('1t_1.5t')).toEqual({ lo: 1e12, hi: 1.5e12, dim: 'mag' });
    expect(parseBandInterval('seats_190_194')).toEqual({ lo: 190, hi: 194, dim: '?' });
  });
  test('one-sided key bands', () => {
    expect(parseBandInterval('lt_1t')).toEqual({ lo: NEG, hi: 1e12, dim: 'mag' });
    expect(parseBandInterval('ge_4t')).toEqual({ lo: 4e12, hi: POS, dim: 'mag' });
    expect(parseBandInterval('400b_plus')).toEqual({ lo: 4e11, hi: POS, dim: 'mag' });
    expect(parseBandInterval('seats_below_190')).toEqual({ lo: NEG, hi: 190, dim: '?' });
    expect(parseBandInterval('seats_230+')).toEqual({ lo: 230, hi: POS, dim: '?' });
  });
  test('label forms (currency / degree symbols stripped, word units)', () => {
    expect(parseBandInterval('¥1T-¥1.5T')).toEqual({ lo: 1e12, hi: 1.5e12, dim: 'mag' });
    expect(parseBandInterval('400 billion yuan or greater')).toEqual({ lo: 4e11, hi: POS, dim: 'mag' });
    expect(parseBandInterval('less than 250 billion')).toEqual({ lo: NEG, hi: 2.5e11, dim: 'mag' });
    expect(parseBandInterval('between 250 billion and 280 billion')).toEqual({ lo: 2.5e11, hi: 2.8e11, dim: 'mag' });
    expect(parseBandInterval('81-82°')).toEqual({ lo: 81, hi: 82, dim: '?' });
  });
});

describe('parseBandInterval refuses', () => {
  test('bare small pairs (exact-score shape) — with or without a prefix', () => {
    expect(parseBandInterval('2_1')).toBeNull();
    expect(parseBandInterval('0_0')).toBeNull();
    expect(parseBandInterval('rep_by_0_49')).toBeNull(); // margin/spread bare pair
  });
  test('single values / non-band tokens', () => {
    expect(parseBandInterval('cut_25bps')).toBeNull();
    expect(parseBandInterval('4193971')).toBeNull(); // bare market_id
    expect(parseBandInterval('top_10')).toBeNull();
    expect(parseBandInterval(null)).toBeNull();
    expect(parseBandInterval('')).toBeNull();
  });
});

describe('intervalsOverlap', () => {
  test('adjacency and boundary-touch are NOT overlap (measure-zero tolerance)', () => {
    expect(intervalsOverlap({ lo: 190, hi: 194, dim: '?' }, { lo: 195, hi: 199, dim: '?' })).toBe(false);
    expect(intervalsOverlap({ lo: 370, hi: 400, dim: 'mag' }, { lo: 400, hi: POS, dim: 'mag' })).toBe(false);
  });
  test('interior overlap within a dimension is TRUE; cross-dimension never overlaps', () => {
    expect(intervalsOverlap({ lo: 4e11, hi: POS, dim: 'mag' }, { lo: NEG, hi: 1e12, dim: 'mag' })).toBe(true);
    expect(intervalsOverlap({ lo: 4e11, hi: POS, dim: 'mag' }, { lo: NEG, hi: 1e12, dim: 'seats' })).toBe(false);
  });
});
