/**
 * T1-before-gate tests for the event-alias call site.
 *
 * `gatedEventAlias` runs `isNonEntityLabel` / `looksLikePredicate` and must let a
 * KB-known name through (bypass) while still refusing unregistered predicate /
 * value titles. Uses the synthetic KB cache prime so no DB is touched, and
 * asserts the belt counters fire only on a bypass.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { gatedEventAlias } from './event-alias.js';
import { _primeKBCacheForTests } from '../db/entity/cache.js';
// discriminators/telemetry.ts is the counter registry; keys are 'belt.'-prefixed.
import { beltCensus, resetBeltCensus } from '../discriminators/telemetry.js';
import type { KBRow } from '../db/entity/types.js';

const row = (id: number, canonical: string, aliases: string[] = []): KBRow => ({
  id, canonical, aliases, domain_category: 'other', type: 'team',
  sport_canonical: null, league_canonical: null,
});

describe('gatedEventAlias — T1-before-gate KB bypass + belt telemetry', () => {
  beforeEach(() => {
    // "For The Win FC" trips looksLikePredicate's "win" verb; "2007" trips
    // isNonEntityLabel's bare-year rule (freed only by the KB numeric bypass);
    // "B8" needs no bypass. All three are real KB entities here.
    _primeKBCacheForTests([
      row(1, 'For The Win FC'),
      row(2, '2007'),
      row(3, 'B8'),
      row(4, 'Real Madrid'),
    ]);
    resetBeltCensus();
  });

  test('KB-known looksLikePredicate name is kept AND bumps looks_predicate_kbhit', () => {
    expect(gatedEventAlias('For The Win FC')).toEqual(['For The Win FC']);
    expect(beltCensus()['belt.looks_predicate_kbhit']).toBe(1);
  });

  test('KB-known bare-numeric (still isNonEntityLabel) is kept AND bumps non_entity_label_kbhit', () => {
    expect(gatedEventAlias('2007')).toEqual(['2007']);
    expect(beltCensus()['belt.non_entity_label_kbhit']).toBe(1);
  });

  test('a fix-⑤-freed org token passes with NO belt (char-class de-loaded the bypass)', () => {
    // isNonEntityLabel('B8') is false, so no gate fires and the KB-bypass belt
    // does not count.
    expect(gatedEventAlias('B8')).toEqual(['B8']);
    expect(beltCensus()).toEqual({});
  });

  test('an UNREGISTERED predicate title is still refused (no bypass, no belt)', () => {
    expect(gatedEventAlias('Will the Lakers win the 2027 title?')).toEqual([]);
    expect(beltCensus()).toEqual({});
  });

  test('a clean real entity passes with NO belt hit (gates never fired)', () => {
    expect(gatedEventAlias('Real Madrid')).toEqual(['Real Madrid']);
    expect(beltCensus()).toEqual({});
  });
});
