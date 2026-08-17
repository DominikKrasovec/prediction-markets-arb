/**
 * Predict save-layer merge + status-predicate tests (audit-r3 #10 + #14).
 *
 * #14: fullScrape runs scrapeCategories() (payload enriched with
 * categoryId/categoryTitle/… by api-client's per-market spread) and THEN
 * scrapeMarkets() whose /v1/markets payload carries NO category keys (live
 * probe 2026-07-02: 0/25,000). The old blind `raw = JSON.stringify(m)` upsert
 * clobbered the enrichment. scrapeMarkets cannot simply be dropped — the same
 * probe found 468 live OPEN markets present ONLY in /v1/markets — so the fix
 * is the pure merge tested here: incoming payload wins per key, but the
 * PRESERVED enrichment keys survive when the incoming shape lacks them.
 *
 * #10: PREDICT_CURRENT_MARKET_PREDICATE replaces `status = 'OPEN'`, which
 * matched zero market objects (their vocabulary has no 'OPEN').
 */
import { describe, test, expect } from 'bun:test';
import { mergePreservedRawKeys, PREDICT_CURRENT_MARKET_PREDICATE } from './postgres.js';

// Shapes distilled from the live API (probe 2026-07-02):
const categoriesPassPayload = {
  id: 392,
  question: 'BTC/USD Up or Down on Dec 05?',
  status: 'REGISTERED',
  tradingStatus: 'OPEN',
  categorySlug: 'btc-usd-up-down-2025-12-05-00-00',
  // added by fetchCategories' per-market spread:
  categoryId: 77,
  categoryTitle: 'BTC/USD Up or Down',
  categoryImageUrl: 'https://img.example/x.png',
  categoryTags: [{ id: 1, name: 'Crypto' }],
};

const marketsPassPayload = {
  id: 392,
  question: 'BTC/USD Up or Down on Dec 05?',
  status: 'REGISTERED',
  tradingStatus: 'OPEN',
  categorySlug: 'btc-usd-up-down-2025-12-05-00-00',
  // NO categoryId/categoryTitle/categoryImageUrl/categoryTags in this shape
};

const statsEnrichment = {
  volumeTotalUsd: 1234.5,
  volume24hUsd: 12.3,
  totalLiquidityUsd: 456.7,
  statsUpdatedAt: '2026-07-02T00:00:00.000Z',
};

describe('mergePreservedRawKeys', () => {
  test('no existing raw → incoming returned unchanged', () => {
    expect(mergePreservedRawKeys(marketsPassPayload, null)).toEqual(marketsPassPayload);
    expect(mergePreservedRawKeys(marketsPassPayload, undefined)).toEqual(marketsPassPayload);
  });

  test('markets-pass payload over category-enriched raw preserves the category keys', () => {
    const merged = mergePreservedRawKeys(marketsPassPayload, categoriesPassPayload);
    expect(merged.categoryId).toBe(77);
    expect(merged.categoryTitle).toBe('BTC/USD Up or Down');
    expect(merged.categoryImageUrl).toBe('https://img.example/x.png');
    expect(merged.categoryTags).toEqual([{ id: 1, name: 'Crypto' }]);
    // incoming keys stay authoritative
    expect(merged.status).toBe('REGISTERED');
    expect(merged.categorySlug).toBe('btc-usd-up-down-2025-12-05-00-00');
  });

  test('stats-enrichment keys survive any later scrape save', () => {
    const enrichedRaw = { ...categoriesPassPayload, ...statsEnrichment };
    const merged = mergePreservedRawKeys(categoriesPassPayload, enrichedRaw);
    expect(merged.volumeTotalUsd).toBe(1234.5);
    expect(merged.volume24hUsd).toBe(12.3);
    expect(merged.totalLiquidityUsd).toBe(456.7);
    expect(merged.statsUpdatedAt).toBe('2026-07-02T00:00:00.000Z');
  });

  test('incoming wins when it DOES carry a preserved key (fresher category assignment)', () => {
    const recategorized = { ...categoriesPassPayload, categoryId: 99, categoryTitle: 'Moved' };
    const merged = mergePreservedRawKeys(recategorized, categoriesPassPayload);
    expect(merged.categoryId).toBe(99);
    expect(merged.categoryTitle).toBe('Moved');
  });

  test('non-preserved stale keys are NOT resurrected from the old raw', () => {
    const oldRaw = { ...categoriesPassPayload, deprecatedApiField: 'gone' };
    const merged = mergePreservedRawKeys(marketsPassPayload, oldRaw);
    expect('deprecatedApiField' in merged).toBe(false);
  });

  test('fullScrape ordering simulation: categories pass → stats enrichment → markets pass loses nothing', () => {
    // pass 1: scrapeCategories saves the enriched payload (no prior row)
    const afterCategories = mergePreservedRawKeys(categoriesPassPayload, null);
    // enrichMarketStats merges stats into the stored raw (raw = raw || stats)
    const afterStats = { ...afterCategories, ...statsEnrichment };
    // pass 2: scrapeMarkets re-saves the category-less /v1/markets shape
    const afterMarkets = mergePreservedRawKeys(marketsPassPayload, afterStats);
    expect(afterMarkets.categoryId).toBe(77);
    expect(afterMarkets.categoryTitle).toBe('BTC/USD Up or Down');
    expect(afterMarkets.categoryTags).toEqual([{ id: 1, name: 'Crypto' }]);
    expect(afterMarkets.volumeTotalUsd).toBe(1234.5);
    expect(afterMarkets.statsUpdatedAt).toBe('2026-07-02T00:00:00.000Z');
    // and the incoming payload's own fields are all present/authoritative
    expect(afterMarkets.question).toBe(marketsPassPayload.question);
    expect(afterMarkets.tradingStatus).toBe('OPEN');
  });

  test('idempotent: re-merging the same payload is a no-op (jsonb-equal → no watermark bump)', () => {
    const first = mergePreservedRawKeys(marketsPassPayload, categoriesPassPayload);
    const second = mergePreservedRawKeys(marketsPassPayload, first);
    expect(second).toEqual(first);
  });
});

describe('PREDICT_CURRENT_MARKET_PREDICATE (audit-r3 #10)', () => {
  test("does not use the query-param vocabulary ('OPEN' never appears on market objects)", () => {
    expect(PREDICT_CURRENT_MARKET_PREDICATE).not.toContain(`'OPEN'`);
  });

  test('excludes terminal states, keeps NULL (fail-open recall direction)', () => {
    expect(PREDICT_CURRENT_MARKET_PREDICATE).toContain('NOT IN');
    expect(PREDICT_CURRENT_MARKET_PREDICATE).toContain(`'RESOLVED'`);
    expect(PREDICT_CURRENT_MARKET_PREDICATE).toContain(`'REMOVED'`);
    expect(PREDICT_CURRENT_MARKET_PREDICATE).toContain('status IS NULL');
  });

  test('in-memory semantics over the live market-object vocabulary', () => {
    // Mirror of the SQL predicate for the vocabulary observed live 2026-07-02.
    const keep = (status: string | null) =>
      status === null || !['RESOLVED', 'REMOVED'].includes(status);
    expect(keep('REGISTERED')).toBe(true);
    expect(keep('PRICE_PROPOSED')).toBe(true);
    expect(keep('PRICE_DISPUTED')).toBe(true);
    expect(keep('PAUSED')).toBe(true);     // documented, unseen live — current
    expect(keep(null)).toBe(true);          // unknown → fail open
    expect(keep('RESOLVED')).toBe(false);
    expect(keep('REMOVED')).toBe(false);
  });
});
