/**
 * Shared runner for the Stage-4 cross-question edge builders.
 *
 * Every cross-question edge builder is a self-join of the full `node_facts`
 * CTE keyed on an unindexed functional expression, so the planner
 * materializes both sides and hash-joins the O(n^2) product. At current
 * edge-graph scale these joins are correct but slow enough that the full
 * INSERTs can exceed the global `statement_timeout` GUC.
 *
 * The largest fan-outs stay in `work_mem` (no temp-file spill), so the join
 * does not approach the `temp_file_limit` disk guard. The remedy is to run
 * each builder with `statement_timeout` disabled so `temp_file_limit`
 * remains the real guard, without changing a single predicate.
 *
 * Runs the builder SQL on a dedicated client inside one explicit
 * `BEGIN ... COMMIT` transaction (via `@arb/db`.withTx) with
 * `SET LOCAL statement_timeout` applied — a bare `SET LOCAL` in autocommit
 * mode is a no-op. The extended timeout is scoped to this transaction only.
 *
 * Multi-statement builders (mux_nf temp-table pre-pass): the mutual-exclusion
 * builder is a multi-statement string — a temp-table + index + ANALYZE
 * pre-pass (so the planner's fold self-join is estimated correctly) followed
 * by the INSERT that reads the temp table. All of it must run on one
 * connection in one transaction so the `ON COMMIT DROP` temp table is
 * visible to the INSERT. node-pg's simple-query protocol returns an array of
 * results for a multi-statement string, so the edge count is the last
 * statement's `{ n }` row; single-statement builders return one Result
 * object — the `Array.isArray` branch handles both.
 */
import { withTx } from '@arb/db';

/**
 * Per-call knobs for {@link runEdgeBuilderSql}.
 *
 * `offlineRebuild` is deliberately caller-threaded rather than env-gated: an
 * ambient env variable would silently un-bound the live daemon, whereas an
 * argument can only be supplied by code that knows it is running an offline
 * rebuild.
 */
export interface EdgeBuilderOptions {
  /**
   * true iff this builder runs inside an offline rebuild, not the live
   * daemon loop. Offline runs start from truncated edges, so a timeout skip
   * there permanently drops the edge class from the rebuilt graph — the time
   * bound is raised and `temp_file_limit` is left as the real guard.
   */
  offlineRebuild?: boolean;
}

/** Live-daemon bound (see the note in {@link runEdgeBuilderSql}). */
const LIVE_STATEMENT_TIMEOUT = '20min';
/** Offline-rebuild bound (opt-in via {@link EdgeBuilderOptions.offlineRebuild}). */
const OFFLINE_STATEMENT_TIMEOUT = '180min';

/**
 * Dynamic-extent opt-in to {@link EdgeBuilderOptions.offlineRebuild} for
 * callers that cannot thread the option down. An offline entry point wraps
 * its whole edge-building call in this; every `runEdgeBuilderSql` executed
 * inside the callback that does not pass an explicit `opts` picks up the
 * offline bound.
 *
 * Not an ambient flag: nothing outside the process can set it, it is scoped
 * to one explicit `await` extent, always restored (finally), and an explicit
 * `opts.offlineRebuild` argument still wins.
 */
let offlineRebuildScope = false;
export async function withOfflineEdgeBuilderBound<T>(fn: () => Promise<T>): Promise<T> {
  const prev = offlineRebuildScope;
  offlineRebuildScope = true;
  try {
    return await fn();
  } finally {
    offlineRebuildScope = prev;
  }
}

/** True iff an offline entry point is currently inside {@link withOfflineEdgeBuilderBound}. */
export function inOfflineEdgeBuilderScope(): boolean {
  return offlineRebuildScope;
}

/**
 * Execute a cross-question edge-builder SQL string with a per-statement
 * `statement_timeout` chosen by the CALLER's context (live bound by default) and
 * return the `n` edge-count it projects. Edge SEMANTICS are unchanged — this only
 * sets the time bound; it does not touch the query.
 */
export async function runEdgeBuilderSql(sql: string, opts: EdgeBuilderOptions = {}): Promise<number> {
  // Bounded rather than unbounded: an unbounded statement_timeout lets a
  // pathological builder plan wedge the whole stage loop. A builder that
  // exceeds it errors out, the daemon catches it, this tick skips the
  // builder (existing edges persist, no re-mint window), and the loop
  // proceeds. Not env-tunable on purpose — a silent override could wedge the
  // pipeline again.
  const offline = opts.offlineRebuild ?? offlineRebuildScope;
  const timeout = offline ? OFFLINE_STATEMENT_TIMEOUT : LIVE_STATEMENT_TIMEOUT;
  return withTx(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
    // node-pg returns an ARRAY of results for a multi-statement string; the edge count
    // is the LAST statement's { n } row. A single-statement builder returns one Result.
    const result = (await client.query(sql)) as unknown as
      | { rows: Array<{ n: number }> }
      | Array<{ rows: Array<{ n: number }> }>;
    const last = Array.isArray(result) ? result[result.length - 1] : result;
    return Number(last?.rows?.[0]?.n ?? 0);
  });
}
