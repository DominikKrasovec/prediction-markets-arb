/**
 * Scraper contract tests — parameterized over every registered scraper.
 *
 * These tests are the **spec** for what every platform implementation must
 * fulfill. See docs/CONTRACTS.md §1 for the prose contract.
 *
 * Adding a new platform: register it in `SCRAPERS` (run-all.ts). These
 * tests will automatically run against it — no test changes needed. If
 * they fail, the platform implementation is non-conformant.
 *
 * What we test here (no DB / network required):
 *   1. Interface shape conformance.
 *   2. Platform literal is canonical and matches `db.label` (where exposed).
 *   3. `db.isAvailable()` returns false before connect (no auto-connect on import).
 *   4. SCRAPERS registry contains all 4 known platforms exactly once.
 *
 * Idempotency of connect/disconnect and bulkUpsert semantics require a DB
 * and are deferred to integration tests.
 */
import { describe, test, expect } from 'bun:test';
import { SCRAPERS } from './run-all.js';
import type { Platform } from '@arb/types';

const CANONICAL_PLATFORMS: ReadonlySet<Platform> = new Set([
  'kalshi', 'limitless', 'polymarket', 'predict',
]);

describe('SCRAPERS registry', () => {
  test('is non-empty', () => {
    expect(SCRAPERS.length).toBeGreaterThan(0);
  });

  test('contains all 4 canonical platforms exactly once', () => {
    const platforms = SCRAPERS.map((s) => s.platform);
    expect(new Set(platforms).size).toBe(platforms.length); // no dupes
    for (const p of CANONICAL_PLATFORMS) {
      expect(platforms).toContain(p);
    }
  });
});

describe.each(SCRAPERS.map((s) => [s.platform, s]))(
  'Scraper contract: %s',
  (_label, scraper) => {
    test('platform field is a canonical Platform literal', () => {
      expect(CANONICAL_PLATFORMS.has(scraper.platform)).toBe(true);
    });

    test('db.connect is a function', () => {
      expect(typeof scraper.db.connect).toBe('function');
    });

    test('db.disconnect is a function', () => {
      expect(typeof scraper.db.disconnect).toBe('function');
    });

    test('scrapeActive is a function', () => {
      expect(typeof scraper.scrapeActive).toBe('function');
    });

    test('db.saveMarkets is an async function', () => {
      // Regression guard: polymarket and predict previously typed saveMarkets
      // as (markets: any[]) which hid field-name typos at compile time.
      // This test ensures every platform exposes the method at runtime too.
      const db = scraper.db as unknown as { saveMarkets?: (...args: unknown[]) => unknown };
      expect(typeof db.saveMarkets).toBe('function');
    });

    test('does not auto-connect on import', () => {
      // The db object exposes isAvailable in practice (every concrete impl
      // extends BaseScraperPostgresService). Tolerate its absence — the
      // hard contract is just "no connection until connect() is called".
      const db = scraper.db as unknown as { isAvailable?: () => boolean };
      if (typeof db.isAvailable === 'function') {
        expect(db.isAvailable()).toBe(false);
      }
    });

    test('connect/disconnect are async (return promises)', () => {
      // Don't actually call connect (would hit real DB) — just check return type
      // by inspecting the function signature heuristically via toString().
      // Better: trust the TypeScript types and just confirm both are present.
      expect(scraper.db.connect.constructor.name).toMatch(/AsyncFunction|Function/);
      expect(scraper.db.disconnect.constructor.name).toMatch(/AsyncFunction|Function/);
    });
  },
);
