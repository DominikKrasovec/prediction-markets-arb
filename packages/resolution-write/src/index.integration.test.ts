/**
 * Integration tests for writeResolution / writeAndPublishResolution.
 *
 * These tests exercise the real Postgres transaction logic: SELECT FOR UPDATE,
 * COALESCE idempotency, and the 4-way outcome enum. They require a running
 * Postgres instance configured via the standard env vars (PG_HOST, PG_PORT,
 * PG_DATABASE, PG_USER, PG_PASSWORD — or defaults to localhost:5432 /
 * prediction_arb / arb / arb_local_dev).
 *
 * When the DB is unreachable every test returns early (passes as a no-op)
 * rather than failing the suite. Run with:
 *
 *   bun test src --pattern integration
 *
 * or via the package-level shortcut:
 *
 *   bun run test:integration
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { getPool, endPool, query } from '@arb/db';
import { writeResolution } from './index.js';

// ── Test isolation ───────────────────────────────────────────────────────────

// Unique run-scoped prefix so rows don't collide with production data or
// parallel test runs. We use a short random suffix (not Date.now()) so
// fast consecutive runs don't reuse the same ids.
const RUN_ID = Math.random().toString(36).slice(2, 10);
const PREFIX = `test-rw-${RUN_ID}`;

let dbAvailable = false;

beforeAll(async () => {
  try {
    // Race against a 5-second timeout so the suite doesn't hang when the DB
    // isn't running (pg pool has no built-in connect timeout by default).
    await Promise.race([
      getPool().query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB connect timeout')), 5_000),
      ),
    ]);
    dbAvailable = true;
  } catch {
    console.warn('[integration] DB not reachable — skipping writeResolution tests');
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await query(`DELETE FROM markets WHERE platform_id LIKE $1`, [`${PREFIX}%`]);
  }
  await endPool();
});

/** Returns true (and the test becomes a no-op) when the DB is unavailable. */
function noDb(): boolean {
  return !dbAvailable;
}

/**
 * Insert a minimal `markets` row for testing. Returns the auto-assigned id.
 * All test rows use platform='kalshi' and platform_ids prefixed by PREFIX.
 */
async function seed(
  suffix: string,
  overrides: {
    resolvedAt?: Date | null;
    winningOutcome?: string | null;
    status?: string;
  } = {},
): Promise<{ id: number; platformId: string }> {
  const platformId = `${PREFIX}-${suffix}`;
  const rows = await query<{ id: number }>(
    `INSERT INTO markets (platform, platform_id, title, status, resolved_at, winning_outcome)
     VALUES ('kalshi', $1, $2, $3, $4, $5)
     RETURNING id`,
    [
      platformId,
      `[test] ${platformId}`,
      overrides.status ?? 'open',
      overrides.resolvedAt ?? null,
      overrides.winningOutcome ?? null,
    ],
  );
  return { id: rows[0].id, platformId };
}

/** Read back the columns we care about for a specific row. */
async function readMarket(id: number) {
  const rows = await query<{
    winning_outcome: string | null;
    resolved_at: Date | null;
    resolution_source: string | null;
    status: string | null;
  }>(
    `SELECT winning_outcome, resolved_at, resolution_source, status
       FROM markets WHERE id = $1`,
    [id],
  );
  return rows[0];
}

// ── writeResolution ──────────────────────────────────────────────────────────

describe('writeResolution — outcome enum', () => {
  test('not_found: no row → outcome=not_found, marketId=null', async () => {
    if (noDb()) return;
    const result = await writeResolution({
      platform: 'kalshi',
      platformId: `${PREFIX}-NONEXISTENT`,
      winning: 'Yes',
      resolvedAt: new Date(),
      source: 'test',
    });
    expect(result.outcome).toBe('not_found');
    expect(result.marketId).toBeNull();
  });

  test('created: unresolved row → outcome=created, marketId set, DB updated', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('created-1');
    const resolvedAt = new Date('2025-06-01T12:00:00Z');

    const result = await writeResolution({
      platform: 'kalshi',
      platformId,
      winning: 'Yes',
      resolvedAt,
      source: 'test/created',
    });

    expect(result.outcome).toBe('created');
    expect(result.marketId).toBe(id);

    const row = await readMarket(id);
    expect(row.winning_outcome).toBe('Yes');
    expect(row.resolved_at?.toISOString()).toBe(resolvedAt.toISOString());
    expect(row.resolution_source).toBe('test/created');
    expect(row.status).toBe('closed');
  });

  test('already_resolved: fully resolved row → outcome=already_resolved, DB unchanged', async () => {
    if (noDb()) return;
    const ts = new Date('2025-05-01T08:00:00Z');
    const { id, platformId } = await seed('already-resolved-1', {
      resolvedAt: ts,
      winningOutcome: 'No',
      status: 'closed',
    });

    const laterTs = new Date('2025-06-15T08:00:00Z');
    const result = await writeResolution({
      platform: 'kalshi',
      platformId,
      winning: 'Yes', // would overwrite if COALESCE weren't there
      resolvedAt: laterTs,
      source: 'test/should-not-apply',
    });

    expect(result.outcome).toBe('already_resolved');
    expect(result.marketId).toBe(id);

    // DB must be untouched
    const row = await readMarket(id);
    expect(row.winning_outcome).toBe('No');
    expect(row.resolved_at?.toISOString()).toBe(ts.toISOString());
  });

  test('amended: resolved but no winner → outcome=amended, winner backfilled, timestamp preserved', async () => {
    if (noDb()) return;
    const firstTs = new Date('2025-04-10T06:00:00Z');
    const { id, platformId } = await seed('amended-1', {
      resolvedAt: firstTs,
      winningOutcome: null, // resolved but winner unknown
      status: 'closed',
    });

    const laterTs = new Date('2025-06-20T10:00:00Z');
    const result = await writeResolution({
      platform: 'kalshi',
      platformId,
      winning: 'Yes',
      resolvedAt: laterTs,
      source: 'test/amend',
    });

    expect(result.outcome).toBe('amended');
    expect(result.marketId).toBe(id);

    const row = await readMarket(id);
    expect(row.winning_outcome).toBe('Yes');
    // COALESCE: original timestamp preserved, later one ignored
    expect(row.resolved_at?.toISOString()).toBe(firstTs.toISOString());
    // resolution_source preserved from first write (row already had resolved_at)
    expect(row.resolution_source).toBeNull();
  });
});

describe('writeResolution — COALESCE idempotency', () => {
  test('second write on same row returns already_resolved, first timestamp wins', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('coalesce-ts-1');
    const firstTs  = new Date('2025-01-01T00:00:00Z');
    const secondTs = new Date('2025-06-01T00:00:00Z');

    await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: firstTs,  source: 'test/first'  });
    const r2 = await writeResolution({ platform: 'kalshi', platformId, winning: 'No',  resolvedAt: secondTs, source: 'test/second' });

    expect(r2.outcome).toBe('already_resolved');
    const row = await readMarket(id);
    expect(row.resolved_at?.toISOString()).toBe(firstTs.toISOString());
    expect(row.winning_outcome).toBe('Yes');
  });

  test('null winning on created write does not block a later amended write', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('coalesce-null-winner-1');
    const firstTs = new Date('2025-02-01T00:00:00Z');

    // First write: resolved but no winner (Kalshi WSS fires before result is populated)
    const r1 = await writeResolution({ platform: 'kalshi', platformId, winning: null, resolvedAt: firstTs, source: 'test/first' });
    expect(r1.outcome).toBe('created');

    // Second write: winner now available
    const r2 = await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: new Date(), source: 'test/second' });
    expect(r2.outcome).toBe('amended');

    const row = await readMarket(id);
    expect(row.winning_outcome).toBe('Yes');
    expect(row.resolved_at?.toISOString()).toBe(firstTs.toISOString()); // first ts preserved
  });

  test('resolution_source preserved when amended (original source not overwritten)', async () => {
    if (noDb()) return;
    const { platformId } = await seed('coalesce-source-1');
    const firstTs = new Date('2025-03-01T00:00:00Z');

    await writeResolution({ platform: 'kalshi', platformId, winning: null, resolvedAt: firstTs, source: 'original/source' });
    await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: new Date(), source: 'amender/source' });

    const rows = await query<{ resolution_source: string | null }>(
      `SELECT resolution_source FROM markets WHERE platform = 'kalshi' AND platform_id = $1`,
      [platformId],
    );
    expect(rows[0].resolution_source).toBe('original/source');
  });
});

describe('writeResolution — marketId return value', () => {
  test('marketId matches the inserted row id', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('marketid-check-1');
    const result = await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: new Date(), source: 'test' });
    expect(result.marketId).toBe(id);
  });

  test('marketId is non-null for already_resolved', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('marketid-check-2', { resolvedAt: new Date(), winningOutcome: 'No' });
    const result = await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: new Date(), source: 'test' });
    expect(result.outcome).toBe('already_resolved');
    expect(result.marketId).toBe(id);
  });

  test('marketId is non-null for amended', async () => {
    if (noDb()) return;
    const { id, platformId } = await seed('marketid-check-3', { resolvedAt: new Date('2025-01-01'), winningOutcome: null });
    const result = await writeResolution({ platform: 'kalshi', platformId, winning: 'Yes', resolvedAt: new Date(), source: 'test' });
    expect(result.outcome).toBe('amended');
    expect(result.marketId).toBe(id);
  });
});

// ── writeAndPublishResolution ────────────────────────────────────────────────
//
// writeAndPublishResolution = writeResolution + conditional publishResolved.
// The publish path (event-bus I/O) is not tested here: publishResolved is a
// trivial try/catch wrapper and the event bus is not required to be running
// for these integration tests. The DB semantics above cover everything that
// matters.
