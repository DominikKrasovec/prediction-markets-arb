/**
 * Pure tests for the same-fixture different-type rejecter. The DB-driven
 * confirm path is covered by a separate replay script; here we lock the
 * load-bearing pure invariants: GAME⇒NULL, the allowlist/blocklist gate,
 * foldAscii-first fixture identity, and same-fixture/same-type no-fire.
 */
import { describe, test, expect } from 'bun:test';
import {
  kalshiSeriesType, titleType, eventMarketType, fixtureTeams, sameFixture, u7RejectTag,
  typePairKey, U7_TYPE_PAIR_ALLOWLIST, U7_TYPE_PAIR_BLOCKLIST,
} from './kalshi-series-type-pairs.js';

describe('kalshiSeriesType', () => {
  test('typed suffixes → their type', () => {
    expect(kalshiSeriesType(['KXEPLCORNERS'])).toBe('corners');
    expect(kalshiSeriesType(['KXBUNDESLIGATOTAL'])).toBe('total');
    expect(kalshiSeriesType(['KXSERIEABTTS'])).toBe('btts');
    expect(kalshiSeriesType(['KXNBASPREAD'])).toBe('spread');
    expect(kalshiSeriesType(['KXEPL1H'])).toBe('first_half');
  });
  test('…GAME series ⇒ NULL (moneyline, never a specific type)', () => {
    expect(kalshiSeriesType(['KXEPLGAME'])).toBeNull();
    expect(kalshiSeriesType(['KXLALIGAGAME'])).toBeNull();
  });
  test('mixed / no-match / empty ⇒ NULL (ambiguous never keys a reject)', () => {
    expect(kalshiSeriesType(['KXEPLCORNERS', 'KXEPLTOTAL'])).toBeNull(); // two types
    expect(kalshiSeriesType(['KXSOMETHINGELSE'])).toBeNull();
    expect(kalshiSeriesType([])).toBeNull();
    expect(kalshiSeriesType([null, undefined])).toBeNull();
  });
});

describe('titleType', () => {
  test('trailing descriptor → type', () => {
    expect(titleType('AFC Ajax vs. FC Utrecht - Total Corners')).toBe('corners');
    expect(titleType('Team A vs. Team B: Both Teams to Score')).toBe('btts');
    expect(titleType('Team A vs. Team B - Exact Score')).toBe('exact_score');
    expect(titleType('Team A vs. Team B: Over/Under 2.5')).toBe('total');
  });
  test('"More Markets" wrapper and bare fixture ⇒ NULL', () => {
    expect(titleType('Team A vs. Team B - More Markets')).toBeNull();
    expect(titleType('Team A vs. Team B')).toBeNull();
    expect(titleType(null)).toBeNull();
  });
});

describe('eventMarketType routes by platform', () => {
  test('kalshi ⇒ series, else ⇒ title', () => {
    expect(eventMarketType('kalshi', 'ignored title', ['KXEPLCORNERS'])).toBe('corners');
    expect(eventMarketType('polymarket', 'A vs. B - Total Corners', [])).toBe('corners');
    expect(eventMarketType('kalshi', 'A vs. B - Total Corners', ['KXEPLGAME'])).toBeNull(); // GAME⇒null, series wins
  });
});

describe('fixtureTeams / sameFixture (foldAscii-first)', () => {
  test('parses "A vs B" and folds diacritics BEFORE compare', () => {
    const fa = fixtureTeams("Côte d'Ivoire vs. Germany");
    const fb = fixtureTeams("Cote d Ivoire vs Germany");
    expect(fa).not.toBeNull();
    expect(fb).not.toBeNull();
    expect(sameFixture(fa!, fb!)).toBe(true);
  });
  test('different fixture ⇒ not same', () => {
    const fa = fixtureTeams('Arsenal vs. Chelsea')!;
    const fb = fixtureTeams('Liverpool vs. Everton')!;
    expect(sameFixture(fa, fb)).toBe(false);
  });
  test('non-fixture title ⇒ null', () => {
    expect(fixtureTeams('2026 World Cup Winner')).toBeNull();
    expect(fixtureTeams(null)).toBeNull();
  });
});

describe('allowlist / blocklist membership', () => {
  test('allowlist contains the validated safe cells', () => {
    expect(U7_TYPE_PAIR_ALLOWLIST.has(typePairKey('corners', 'total'))).toBe(true);
    expect(U7_TYPE_PAIR_ALLOWLIST.has(typePairKey('btts', 'corners'))).toBe(true);
    expect(U7_TYPE_PAIR_ALLOWLIST.has(typePairKey('exact_score', 'total'))).toBe(true);
  });
  test('blocklist contains the real-merge cells', () => {
    expect(U7_TYPE_PAIR_BLOCKLIST.has(typePairKey('btts', 'exact_score'))).toBe(true);
    expect(U7_TYPE_PAIR_BLOCKLIST.has(typePairKey('exact_score', 'game'))).toBe(true);
  });
});

describe('u7RejectTag', () => {
  const A = 'AFC Ajax vs. FC Utrecht - Total Corners';
  const B = 'AFC Ajax vs. FC Utrecht - Total Goals';
  test('same fixture + allowlisted different types ⇒ reject tag', () => {
    expect(u7RejectTag(A, 'corners', B, 'total')).toContain('corners×total');
  });
  test('same type ⇒ no reject', () => {
    expect(u7RejectTag(A, 'corners', B, 'corners')).toBeNull();
  });
  test('a NULL type (e.g. GAME/moneyline side) ⇒ no reject', () => {
    expect(u7RejectTag(A, 'corners', B, null)).toBeNull();
  });
  test('blocklisted pair ⇒ no reject (defer to LLM)', () => {
    expect(u7RejectTag('A vs. B - BTTS', 'btts', 'A vs. B - Exact Score', 'exact_score')).toBeNull();
  });
  test('non-allowlisted (thin) pair ⇒ no reject', () => {
    expect(u7RejectTag(A, 'first_inning', B, 'overtime')).toBeNull();
  });
  test('DIFFERENT fixture ⇒ no reject (allowlist validated on same-fixture only)', () => {
    expect(u7RejectTag('Arsenal vs. Chelsea - Total Corners', 'corners', 'Liverpool vs. Everton - Total Goals', 'total')).toBeNull();
  });
  test('order-independent', () => {
    expect(u7RejectTag(B, 'total', A, 'corners')).toContain('corners×total');
  });
});
