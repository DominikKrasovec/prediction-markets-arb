/**
 * Cold-start filter vocabulary regression tests. Predict market objects never
 * carry status='OPEN' — that value exists only in the API's query-param
 * enum; the object vocabulary is REGISTERED / PRICE_PROPOSED /
 * PRICE_DISPUTED / RESOLVED / REMOVED.
 *
 * Pure string assertions pin the predicate shape; the live-DB section
 * (skipped when PG is unreachable) proves the predicate matches real rows
 * and excludes exactly the terminal states.
 */
import { test, expect, beforeAll } from 'bun:test';
import { query } from '@arb/db';
import { COLD_FILTER_MAP } from './sync.js';

let pgAvailable = false;
let predictRows = 0;

beforeAll(async () => {
  try {
    const r = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM predict_markets`);
    predictRows = parseInt(r[0].n, 10);
    pgAvailable = true;
  } catch (err) {
    console.warn('[sync.cold-filter.test] PG unreachable — skipping live checks:', (err as Error).message);
  }
});

test("predict cold filter no longer uses the query-param vocabulary (status = 'OPEN')", () => {
  // Regression pin: 'OPEN' is not a market-object status value on Predict.
  expect(COLD_FILTER_MAP.predict).not.toContain(`'OPEN'`);
});

test('predict cold filter excludes the terminal market-object states and keeps NULL (fail-open)', () => {
  expect(COLD_FILTER_MAP.predict).toContain(`NOT IN`);
  expect(COLD_FILTER_MAP.predict).toContain(`'RESOLVED'`);
  expect(COLD_FILTER_MAP.predict).toContain(`'REMOVED'`);
  expect(COLD_FILTER_MAP.predict).toContain(`status IS NULL`);
});

test('every platform has a non-empty cold filter', () => {
  for (const p of ['kalshi', 'polymarket', 'limitless', 'predict'] as const) {
    expect(typeof COLD_FILTER_MAP[p]).toBe('string');
    expect(COLD_FILTER_MAP[p].length).toBeGreaterThan(0);
  }
});

test('LIVE: predict cold filter matches >0 rows (the old predicate matched 0)', async () => {
  if (!pgAvailable || predictRows === 0) return;
  const r = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM predict_markets WHERE ${COLD_FILTER_MAP.predict}`,
  );
  expect(parseInt(r[0].n, 10)).toBeGreaterThan(0);
});

test('LIVE: predict cold filter keeps no RESOLVED/REMOVED row and drops nothing else', async () => {
  if (!pgAvailable || predictRows === 0) return;
  const r = await query<{ kept_terminal: string; dropped_current: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE (${COLD_FILTER_MAP.predict}) AND status IN ('RESOLVED','REMOVED')) AS kept_terminal,
       COUNT(*) FILTER (WHERE NOT (${COLD_FILTER_MAP.predict}) AND (status IS NULL OR status NOT IN ('RESOLVED','REMOVED'))) AS dropped_current
     FROM predict_markets`,
  );
  expect(parseInt(r[0].kept_terminal, 10)).toBe(0);
  expect(parseInt(r[0].dropped_current, 10)).toBe(0);
});

test("LIVE: vocabulary sentinel — market-object status is never 'OPEN'", async () => {
  if (!pgAvailable || predictRows === 0) return;
  // If this ever fails, Predict changed its market-object vocabulary and the
  // predicate choice should be revisited (see COLD_FILTER_MAP comment).
  const r = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM predict_markets WHERE status = 'OPEN'`,
  );
  expect(parseInt(r[0].n, 10)).toBe(0);
});
