/**
 * Pure test for run-edge-builder.ts — asserts the timeout-lifting runner passes the
 * builder SQL through unmodified, lifts statement_timeout via SET LOCAL inside one
 * transaction, and reads the LAST result's `n` (so a multi-statement pre-pass string
 * returns the INSERT's count). No DB: `@arb/db`.withTx and its client are mocked.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const dataQueries: string[] = [];
const setLocals: string[] = [];
// Swapped per test to exercise both the single-Result and multi-statement ARRAY branches.
let nextResult: unknown = { rows: [{ n: 42 }] };

mock.module('@arb/db', () => ({
  withTx: async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string) => {
        if (/^\s*SET LOCAL\b/i.test(sql)) {
          setLocals.push(sql);
          return { rows: [] };
        }
        dataQueries.push(sql);
        return nextResult;
      },
    };
    // withTx wraps BEGIN/COMMIT/ROLLBACK/release around the callback; the mock just runs it.
    return fn(client);
  },
}));

// Import AFTER the mock is registered.
const { runEdgeBuilderSql, withOfflineEdgeBuilderBound, inOfflineEdgeBuilderScope } =
  await import('./run-edge-builder.js');

describe('runEdgeBuilderSql', () => {
  beforeEach(() => {
    dataQueries.length = 0;
    setLocals.length = 0;
    nextResult = { rows: [{ n: 42 }] };
  });

  test('passes the builder SQL through BYTE-FOR-BYTE (no semantic change)', async () => {
    const sql = 'WITH node_facts AS (SELECT 1) SELECT COUNT(*)::int AS n FROM node_facts';
    await runEdgeBuilderSql(sql);
    expect(dataQueries).toHaveLength(1);
    // The SQL must be IDENTICAL — the runner only changes HOW it executes, not WHAT.
    expect(dataQueries[0]).toBe(sql);
  });

  test('bounds statement_timeout at 20min via SET LOCAL (containment vs the mutex-builder wedge)', async () => {
    await runEdgeBuilderSql('SELECT 1 AS n');
    // A builder exceeding 20min errors 57014; the daemon skips it (recall-only)
    // and the loop proceeds. SET LOCAL scopes the timeout to the transaction.
    expect(setLocals).toHaveLength(1);
    expect(setLocals[0]).toBe(`SET LOCAL statement_timeout = '20min'`);
  });

  test('returns the projected edge count as a number (single-statement Result)', async () => {
    const n = await runEdgeBuilderSql('SELECT 1 AS n');
    expect(n).toBe(42);
    expect(typeof n).toBe('number');
  });

  test('reads the LAST result for a multi-statement string (mux_nf pre-pass)', async () => {
    // node-pg returns an ARRAY of results for a multi-statement simple query; the
    // CREATE TEMP TABLE / CREATE INDEX / ANALYZE steps carry no `n` row — the INSERT's
    // count is the LAST element.
    nextResult = [
      { rows: [], command: 'SELECT' }, // CREATE TEMP TABLE … AS
      { rows: [], command: 'CREATE' }, // CREATE INDEX
      { rows: [], command: 'ANALYZE' }, // ANALYZE
      { rows: [{ n: 137 }], command: 'SELECT' }, // WITH ins… SELECT n
    ];
    const n = await runEdgeBuilderSql('CREATE TEMP TABLE mux_nf …; SELECT 137 AS n');
    expect(n).toBe(137);
  });

  test('missing/empty last result → 0 (defensive)', async () => {
    nextResult = [{ rows: [] }];
    expect(await runEdgeBuilderSql('SELECT')).toBe(0);
  });
});

/**
 * The 180min raise is caller-threaded (an explicit argument, or the dynamic scope
 * an offline entry point opens), never an env variable — an ambient override would
 * silently un-bound the live daemon.
 */
describe('runEdgeBuilderSql — offline-rebuild bound', () => {
  beforeEach(() => {
    dataQueries.length = 0;
    setLocals.length = 0;
    nextResult = { rows: [{ n: 42 }] };
  });

  test('explicit opts.offlineRebuild raises the bound to 180min', async () => {
    await runEdgeBuilderSql('SELECT 1 AS n', { offlineRebuild: true });
    expect(setLocals[0]).toBe(`SET LOCAL statement_timeout = '180min'`);
  });

  test('opts.offlineRebuild:false and an omitted opts both keep the live 20min bound', async () => {
    await runEdgeBuilderSql('SELECT 1 AS n', { offlineRebuild: false });
    await runEdgeBuilderSql('SELECT 1 AS n');
    expect(setLocals).toEqual([
      `SET LOCAL statement_timeout = '20min'`,
      `SET LOCAL statement_timeout = '20min'`,
    ]);
  });

  test('withOfflineEdgeBuilderBound scopes the raise to its dynamic extent and restores after', async () => {
    expect(inOfflineEdgeBuilderScope()).toBe(false);
    await withOfflineEdgeBuilderBound(async () => {
      expect(inOfflineEdgeBuilderScope()).toBe(true);
      await runEdgeBuilderSql('SELECT 1 AS n'); // no opts → inherits the scope
    });
    // Restored: a later live call is bounded again.
    expect(inOfflineEdgeBuilderScope()).toBe(false);
    await runEdgeBuilderSql('SELECT 1 AS n');
    expect(setLocals).toEqual([
      `SET LOCAL statement_timeout = '180min'`,
      `SET LOCAL statement_timeout = '20min'`,
    ]);
  });

  test('the scope is restored even when the wrapped work THROWS', async () => {
    await expect(
      withOfflineEdgeBuilderBound(async () => {
        throw new Error('builder blew up');
      }),
    ).rejects.toThrow('builder blew up');
    expect(inOfflineEdgeBuilderScope()).toBe(false);
  });
});
