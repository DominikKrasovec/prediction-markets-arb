import pg from 'pg';
// Loads .env (cwd-relative) plus the worktree bootstrap that walks up to the
// main checkout's .env when run inside a fresh `.claude/worktrees/` checkout.
import './load-env.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      database: process.env.PG_DATABASE || 'prediction_arb',
      user: process.env.PG_USER || 'arb',
      password: process.env.PG_PASSWORD || 'arb_local_dev',
      max: 20,
      // PERMANENT (2026-07-25, promoted from a soak-debug patch). Docker Desktop's
      // Windows port proxy (and most NAT/stateful firewalls in front of a remote
      // Postgres) silently RESETS a TCP connection that stays traffic-silent for
      // long stretches. A Stage-4 edge builder holds ONE connection open for
      // minutes with zero bytes on the wire while the server plans/executes, so the
      // proxy tears the socket down mid-query and node-pg surfaces it as a
      // connection-terminated error that aborts the whole stage. OS-level TCP
      // keepalives keep the flow alive without touching the query. Applies to every
      // pooled client (cost: one empty segment per idle connection per 30 s).
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
  }
  return pool;
}

export async function endPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/** Postgres transaction characteristics for {@link withTx}. */
export interface TxOptions {
  /**
   * Transaction isolation level. Default `READ COMMITTED` (Postgres default —
   * a bare `BEGIN`). Use `REPEATABLE READ` when a multi-statement READER must
   * see ONE consistent MVCC snapshot across all its queries (e.g. the
   * arb-solver constraint-graph loader, which reads questions/edges/outcome_sets
   * that Stage-4 finalize rewrites non-atomically).
   */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /** Open the transaction `READ ONLY` (rejects any write). Default writable. */
  readOnly?: boolean;
}

/**
 * Build the `BEGIN` command for the requested transaction characteristics.
 * Exported for unit tests. A bare `BEGIN` (no options) preserves the historical
 * READ COMMITTED / read-write default for every existing caller.
 */
export function buildBeginCommand(opts: TxOptions = {}): string {
  const modes: string[] = [];
  if (opts.isolationLevel) modes.push(`ISOLATION LEVEL ${opts.isolationLevel}`);
  if (opts.readOnly) modes.push('READ ONLY');
  return modes.length > 0 ? `BEGIN ${modes.join(' ')}` : 'BEGIN';
}

/**
 * Run `fn` inside a Postgres transaction on a dedicated client. The client
 * is released back to the pool after the callback returns. Used by queue
 * claim queries that need `FOR UPDATE SKIP LOCKED` semantics, which are
 * only meaningful inside an explicit transaction — and by multi-statement
 * readers that need a single MVCC snapshot (pass `isolationLevel`).
 */
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(buildBeginCommand(opts));
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `sql` on a dedicated client with the given session-level GUC hints
 * applied via `SET LOCAL` (scoped to the explicit transaction wrapping the
 * query). The client is released back to the pool after the query completes.
 *
 * Use this for queries that need a non-default planner setting — primarily
 * pgvector HNSW scans, which require `enable_seqscan = off` so the planner
 * picks the HNSW index instead of falling back to a full sequential scan.
 *
 * IMPORTANT: `SET LOCAL` only works within an explicit `BEGIN` … `COMMIT`
 * block. In autocommit mode (the pg library default), a bare `SET LOCAL`
 * runs in its own implicit single-statement transaction and resets before the
 * next query executes, making it a no-op. This function explicitly opens a
 * transaction so the hint persists for the duration of the data query.
 *
 * @param hints - Map of GUC name → value, e.g. `{ enable_seqscan: 'off' }`.
 */
export async function queryWithHints<T = any>(
  text: string,
  params: any[] | undefined,
  hints: Record<string, string>,
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(hints)) {
      // Use SET LOCAL so the hint is automatically rolled back when the
      // transaction ends; never leaks to other queries on the same connection.
      await client.query(`SET LOCAL ${name} = ${value}`);
    }
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw err;
  } finally {
    client.release();
  }
}
