/**
 * Pure unit tests for the keyset read driver (buildKeysetReadQuery /
 * advanceCursor). No live DB, no scraper. Plus a simulated-concurrency test
 * that proves the OFFSET driver skips rows under concurrent writes while the
 * keyset driver does not.
 */
import { test, expect } from 'bun:test';
import { buildKeysetReadQuery, advanceCursor, type KeysetCursor } from './sync.js';

const WM = new Date('2026-05-13T20:00:00Z');

test('watermark branch, first page: db_updated_at > $1, ordered (db_updated_at, pk::text), no cursor, no OFFSET', () => {
  const { sql, params } = buildKeysetReadQuery({ table: 'kalshi_markets', pkCol: 'ticker', coldFilter: "status='active'", watermark: WM, batchSize: 2000, cursor: null });
  expect(sql).toContain('db_updated_at > $1');
  expect(sql).toContain('ORDER BY db_updated_at, "ticker"::text');
  expect(sql).not.toContain('OFFSET');
  expect(sql).not.toContain('(db_updated_at, "ticker"::text) >'); // first page has NO cursor clause
  expect(params).toEqual([WM, 2000]);
});

test('watermark branch, page>0: keeps db_updated_at > $1 AND adds the keyset cursor tuple', () => {
  const cursor: KeysetCursor = { lastTs: new Date('2026-05-13T20:05:00Z'), lastPk: 'KXABC-99' };
  const { sql, params } = buildKeysetReadQuery({ table: 'kalshi_markets', pkCol: 'ticker', coldFilter: "status='active'", watermark: WM, batchSize: 2000, cursor });
  expect(sql).toContain('db_updated_at > $1');
  expect(sql).toContain('(db_updated_at, "ticker"::text) > ($2, $3)');
  expect(sql).not.toContain('OFFSET');
  expect(params).toEqual([WM, cursor.lastTs, cursor.lastPk, 2000]);
});

test('cold-start branch: coldFilter + ordered, NO db_updated_at>watermark, first page omits cursor', () => {
  const { sql, params } = buildKeysetReadQuery({ table: 'polymarket_markets', pkCol: 'condition_id', coldFilter: 'active = true AND closed = false', watermark: null, batchSize: 2000, cursor: null });
  expect(sql).toContain('active = true AND closed = false');
  expect(sql).not.toContain('db_updated_at > $');
  expect(sql).toContain('ORDER BY db_updated_at, "condition_id"::text');
  expect(sql).not.toContain('OFFSET');
  expect(params).toEqual([2000]);
});

test('cold-start branch, page>0: coldFilter + cursor tuple, no watermark', () => {
  const cursor: KeysetCursor = { lastTs: WM, lastPk: '0xabc' };
  const { sql, params } = buildKeysetReadQuery({ table: 'limitless_markets', pkCol: 'slug', coldFilter: 'expired = false', watermark: null, batchSize: 2000, cursor });
  expect(sql).toContain('(db_updated_at, "slug"::text) > ($1, $2)');
  expect(sql).not.toContain('db_updated_at > $');
  expect(params).toEqual([cursor.lastTs, cursor.lastPk, 2000]);
});

test('per-platform pkCol map covers all four platforms (driver receives the right pk)', () => {
  for (const pk of ['ticker', 'condition_id', 'slug', 'id'] as const) {
    const { sql } = buildKeysetReadQuery({ table: 't', pkCol: pk, coldFilter: 'true', watermark: WM, batchSize: 10, cursor: { lastTs: WM, lastPk: 'x' } });
    expect(sql).toContain('"' + pk + '"::text');
  }
});

test('advanceCursor returns last row tuple; null on empty', () => {
  const rows = [
    { db_updated_at: new Date('2026-05-13T20:01:00Z'), keyset_pk: 'a' },
    { db_updated_at: new Date('2026-05-13T20:02:00Z'), keyset_pk: 'b' },
  ];
  expect(advanceCursor(rows)).toEqual({ lastTs: new Date('2026-05-13T20:02:00Z'), lastPk: 'b' });
  expect(advanceCursor([])).toBeNull();
});

// SIMULATED-CONCURRENCY: keyset eliminates the skip that OFFSET suffers under a concurrent
// insert at the boundary timestamp. Pure in-memory table; many rows share one ts.
interface Row { ts: number; pk: string }

function keysetPages(table: () => Row[], batch: number): Set<string> {
  const seen = new Set<string>();
  let cursor: { ts: number; pk: string } | null = null;
  while (true) {
    const all: Row[] = [...table()].sort((a, b) => (a.ts - b.ts) || (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));
    const c = cursor; // capture to break the self-referential type inference in the closure
    const filtered: Row[] = c == null ? all : all.filter((r) => r.ts > c.ts || (r.ts === c.ts && r.pk > c.pk));
    const page: Row[] = filtered.slice(0, batch);
    if (page.length === 0) break;
    for (const r of page) seen.add(r.pk);
    const last = page[page.length - 1];
    cursor = { ts: last.ts, pk: last.pk };
    if (page.length < batch) break;
  }
  return seen;
}

function offsetPages(table: () => Row[], batch: number): Set<string> {
  const seen = new Set<string>();
  let offset = 0;
  while (true) {
    const all = [...table()].sort((a, b) => a.ts - b.ts); // ORDER BY ts only (non-unique, unstable)
    const page = all.slice(offset, offset + batch);
    if (page.length === 0) break;
    for (const r of page) seen.add(r.pk);
    offset += page.length;
    if (page.length < batch) break;
  }
  return seen;
}

test('keyset yields every original pk under a non-monotonic ts bump; OFFSET skips at least one', () => {
  // Live shape: db_updated_at is non-monotonic (an upsert can BUMP a row's ts forward) and
  // ORDER BY db_updated_at is unstable across same-ts rows. After page 1 ([a,b,c]) an
  // already-read row is bumped to the END of the unstable order; under OFFSET this shifts
  // an UNREAD row to before the offset window → permanent skip. Keyset (ts,pk)>cursor is
  // immune (a row whose new tuple is behind the cursor never reappears; one ahead is a
  // harmless dup).
  const base: Row[] = [
    { ts: 100, pk: 'a' }, { ts: 100, pk: 'b' }, { ts: 100, pk: 'c' },
    { ts: 100, pk: 'd' }, { ts: 100, pk: 'e' }, { ts: 100, pk: 'f' },
  ];
  let reads = 0;
  const live: Row[] = [...base];
  const table = () => {
    reads++;
    if (reads === 2) {
      // bump already-read 'a' to the end (forward ts bump under unstable same-ts order).
      const i = live.findIndex((r) => r.pk === 'a');
      if (i >= 0) { const [moved] = live.splice(i, 1); live.push(moved); }
    }
    return live;
  };

  reads = 0; live.length = 0; live.push(...base);
  const keysetSeen = keysetPages(table, 3);
  for (const pk of ['a', 'b', 'c', 'd', 'e', 'f']) expect(keysetSeen.has(pk)).toBe(true);

  reads = 0; live.length = 0; live.push(...base);
  const offsetSeen = offsetPages(table, 3);
  const droppedOriginals = ['a', 'b', 'c', 'd', 'e', 'f'].filter((pk) => !offsetSeen.has(pk));
  expect(droppedOriginals.length).toBeGreaterThanOrEqual(1);
});

test('keyset is behaviour-preserving on a STATIC table (full coverage, no dup loss)', () => {
  const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({ ts: 100 + (i % 5), pk: 'pk' + String(i).padStart(2, '0') }));
  const seen = keysetPages(() => rows, 4);
  expect(seen.size).toBe(25);
  for (const r of rows) expect(seen.has(r.pk)).toBe(true);
});
