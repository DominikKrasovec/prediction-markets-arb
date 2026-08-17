/**
 * Wire protocol shared by the coordinator (solver-pool.ts) and the worker
 * (solve-worker.ts). TYPES ONLY — no runtime imports — so importing it on the
 * main thread can never transitively pull HiGHS WASM into the coordinator
 * process (the whole point of the pool is to keep `highs` off the event loop).
 *
 * Messages are structured-cloned across the worker boundary, so every field
 * here is a plain JSON-ish value. The reply deliberately carries only the
 * MINIMAL slice of a HiGHS solution that `parseHighsResult` reads
 * (`{Status, ObjectiveValue, Columns:{name:{Primal}}}`), so the cloned payload
 * stays tiny even for thousand-variable ladder LPs.
 */

/** One LP to solve: a pre-rendered LP-format string + an id to correlate the reply. */
export interface SolveJob {
  jobId: number;
  lpString: string;
}

/** Coordinator → worker: solve this chunk of jobs (one message per worker per tick). */
export interface SolveRequest {
  batchId: number;
  jobs: SolveJob[];
  /**
   * SOUND DUAL-SKIP FILTER (`SOLVE_RETURN_DUALS=1`) only. When true the worker
   * ALSO forwards each Optimal solve's per-state-row duals (`Rows[].Dual`) in the
   * slimmed reply, so the coordinator can build a dual certificate from a
   * pool-solved cluster. Absent/false ⟹ the worker drops `Rows` entirely (today's
   * minimal payload) — byte-identical reply shape.
   */
  returnDuals?: boolean;
}

/**
 * The slimmed per-job result. Field names mirror the HiGHS solution shape that
 * `parseHighsResult` consumes (`RawHighsResult`), so the coordinator can feed
 * `{ Status: status, ObjectiveValue: objectiveValue, Columns: columns }`
 * straight into it. `columns` carries only the non-zero primal values (zeros are
 * the default in `parseHighsResult`, so omitting them is equivalent and smaller).
 */
export interface SlimSolveResult {
  jobId: number;
  status: string;
  objectiveValue?: number;
  columns?: Record<string, { Primal: number }>;
  /**
   * SOUND DUAL-SKIP FILTER only. The non-zero per-state-row duals, each `{ i, Dual }`
   * where `i` is the row index `s` (0-based, `cluster.validStates` order). Only the
   * non-zero duals are forwarded — the coordinator pre-sizes `rowDual` to the row
   * count and leaves omitted entries at 0 (the correct dual), exactly as the column
   * slimming drops zero primals. Present ONLY when the request set `returnDuals`.
   */
  rows?: Array<{ i: number; Dual: number }>;
}

/** Worker → coordinator: results for one solved chunk. */
export interface SolveReply {
  batchId: number;
  results: SlimSolveResult[];
}

/** Worker → coordinator: emitted once the HiGHS WASM instance is ready. */
export interface WorkerReady {
  ready: true;
}
