/**
 * Unit tests for the cross-venue settlement tag.
 *
 * Pure, no DB. Pins the dual TS/SQL spec: the pure predicate (cross-platform +
 * divergence-kind gives a tag; same-platform / NULL / non-divergence-kind gives
 * NULL) and the SQL generator that must emit the same kind list + tag literal.
 */
import { describe, test, expect } from 'bun:test';
import {
  SETTLEMENT_DIVERGENCE_KINDS,
  CROSS_VENUE_SETTLEMENT,
  isCrossVenueSettlement,
  isCrossVenueSettlementMembers,
  crossVenueSettlementTagSql,
} from './basis-risk.js';

describe('isCrossVenueSettlement (pure predicate)', () => {
  test('cross-platform fixture mutex gets the tag', () => {
    expect(isCrossVenueSettlement('kalshi', 'polymarket', 'match_winner')).toBe(true);
    expect(isCrossVenueSettlement('limitless', 'polymarket', 'match_spread')).toBe(true);
    expect(isCrossVenueSettlement('polymarket', 'kalshi', 'halftime_leader')).toBe(true);
  });

  test('cross-platform WC2026 championship_winner (the "stat-leader" family) gets the tag', () => {
    expect(isCrossVenueSettlement('limitless', 'polymarket', 'championship_winner')).toBe(true);
  });

  test('same-platform pair never tagged (one venue → no divergence)', () => {
    expect(isCrossVenueSettlement('kalshi', 'kalshi', 'match_winner')).toBe(false);
    expect(isCrossVenueSettlement('polymarket', 'polymarket', 'championship_winner')).toBe(false);
  });

  test('non-divergence kinds stay NULL (crypto / election / media / weather / null-kind)', () => {
    expect(isCrossVenueSettlement('kalshi', 'polymarket', 'price_threshold')).toBe(false);
    expect(isCrossVenueSettlement('limitless', 'polymarket', 'crypto_launch_fdv')).toBe(false);
    expect(isCrossVenueSettlement('kalshi', 'polymarket', 'election_outcome_winner')).toBe(false);
    expect(isCrossVenueSettlement('polymarket', 'kalshi', 'media_release')).toBe(false);
    expect(isCrossVenueSettlement('polymarket', 'limitless', 'personnel_move')).toBe(false);
    // player_prop_threshold is deliberately NOT in the divergence set (documented)
    expect(isCrossVenueSettlement('kalshi', 'polymarket', 'player_prop_threshold')).toBe(false);
    expect(isCrossVenueSettlement('kalshi', 'polymarket', null)).toBe(false);
  });

  test('NULL platform on either side → false (no cross-venue proof)', () => {
    expect(isCrossVenueSettlement(null, 'polymarket', 'match_winner')).toBe(false);
    expect(isCrossVenueSettlement('kalshi', null, 'match_winner')).toBe(false);
    expect(isCrossVenueSettlement(null, null, 'match_winner')).toBe(false);
  });

  test('every fixture kind + championship_winner is divergence-capable', () => {
    for (const k of [
      'match_winner', 'match_total_metric', 'match_spread', 'both_teams_score',
      'exact_score', 'halftime_leader', 'match_event_prop', 'championship_winner',
    ]) {
      expect(SETTLEMENT_DIVERGENCE_KINDS.has(k)).toBe(true);
      expect(isCrossVenueSettlement('kalshi', 'polymarket', k)).toBe(true);
    }
  });
});

describe('isCrossVenueSettlementMembers (member-platform-union spec)', () => {
  test('single shared venue across both nodes → false (no divergence)', () => {
    expect(isCrossVenueSettlementMembers(['kalshi'], ['kalshi'], 'match_winner')).toBe(false);
    expect(isCrossVenueSettlementMembers(['kalshi', 'kalshi'], ['kalshi'], 'championship_winner')).toBe(false);
  });

  test('two distinct single-platform legs → true (base cross-venue case)', () => {
    expect(isCrossVenueSettlementMembers(['kalshi'], ['polymarket'], 'match_winner')).toBe(true);
  });

  test('multi-platform merged node whose rep coincides with the other leg → true', () => {
    // Node A folds {kalshi, polymarket}; node B is {kalshi}. Rep-vs-rep (kalshi vs
    // kalshi) alone would miss this; the member union {kalshi, polymarket} catches it.
    expect(isCrossVenueSettlementMembers(['kalshi', 'polymarket'], ['kalshi'], 'championship_winner')).toBe(true);
    expect(isCrossVenueSettlementMembers(['kalshi', 'polymarket'], ['kalshi', 'polymarket'], 'match_winner')).toBe(true);
  });

  test('NULL / undefined members contribute nothing (no cross-venue proof)', () => {
    expect(isCrossVenueSettlementMembers([null], ['polymarket'], 'match_winner')).toBe(false);
    expect(isCrossVenueSettlementMembers(['kalshi', null], ['kalshi', undefined], 'match_winner')).toBe(false);
  });

  test('non-divergence kind / null kind → false regardless of platform span', () => {
    expect(isCrossVenueSettlementMembers(['kalshi'], ['polymarket'], 'price_threshold')).toBe(false);
    expect(isCrossVenueSettlementMembers(['kalshi'], ['polymarket'], null)).toBe(false);
  });

  test('is a strict superset of the rep-pair predicate (never drops a rep-based tag)', () => {
    // rep(a) ≠ rep(b) ⇒ the union holds ≥2 platforms ⇒ still tagged.
    expect(isCrossVenueSettlement('kalshi', 'polymarket', 'match_winner')).toBe(true);
    expect(isCrossVenueSettlementMembers(['kalshi'], ['polymarket'], 'match_winner')).toBe(true);
  });
});

describe('crossVenueSettlementTagSql (SQL twin)', () => {
  const sql = crossVenueSettlementTagSql('a.question_id', 'b.question_id', 'a.event_kind');

  test('emits a CASE that yields the exact 22-char tag literal', () => {
    expect(sql).toContain(`THEN '${CROSS_VENUE_SETTLEMENT}'`);
    expect(CROSS_VENUE_SETTLEMENT).toBe('cross_venue_settlement');
    expect(CROSS_VENUE_SETTLEMENT.length).toBe(22);
    expect(sql).toContain('ELSE NULL');
  });

  test('member-platform-union guard: distinct platforms across both questions > 1', () => {
    expect(sql).toContain('count(DISTINCT m.platform)');
    expect(sql).toContain('FROM question_members qm');
    expect(sql).toContain('JOIN markets m ON m.id = qm.market_id');
    expect(sql).toContain('WHERE qm.question_id IN (a.question_id, b.question_id)');
    expect(sql).toContain('> 1');
  });

  test('kind membership list is derived from SETTLEMENT_DIVERGENCE_KINDS (no drift)', () => {
    for (const k of SETTLEMENT_DIVERGENCE_KINDS) {
      expect(sql).toContain(`'${k}'`);
    }
    expect(sql).toContain('a.event_kind IN (');
  });

  test('takes its expressions as parameters (usable with the equiv cand CTE c.aq/c.bq)', () => {
    const sql2 = crossVenueSettlementTagSql('c.aq', 'c.bq', 'c.a_kind');
    expect(sql2).toContain('WHERE qm.question_id IN (c.aq, c.bq)');
    expect(sql2).toContain('c.a_kind IN (');
  });
});
