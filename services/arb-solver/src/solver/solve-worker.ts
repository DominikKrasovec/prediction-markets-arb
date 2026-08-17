/**
 * Solver worker thread. Owns ONE HiGHS WASM instance and does nothing but run
 * the synchronous, blocking `highs.solve(lpString)` for the chunk of LP strings
 * the coordinator ships it — moving that CPU-bound WASM call off the main JS
 * event loop. It holds NO solver state: the coordinator renders every LPProblem
 * to a string (with the shared buildLPString) and parses every reply (with the
 * shared parseHighsResult), so the worker only sees opaque strings in and a
 * SLIMMED `{Status,ObjectiveValue,Columns}` slice out.
 *
 * Cross-runtime: this module must load under BOTH the tsx runtime (dev +
 * run-monitor/daemon, launched via node_modules/.bin/tsx — solver-pool.ts then
 * spawns THIS `.ts` file with `execArgv:['--import','tsx']` so the worker thread
 * gets the tsx ESM loader, which it does NOT inherit from the parent) and a
 * compiled `tsc --build` (`node dist/index.js` → the emitted `solve-worker.js`,
 * spawned with no loader). solver-pool.ts picks the entry + execArgv by detecting
 * whether its own import.meta.url ends in ".ts" vs ".js". The dynamic
 * `import('highs')` + top-level await is the same loader the in-process path uses,
 * and works in both.
 */
import { parentPort } from 'node:worker_threads';
import type { SolveRequest, SlimSolveResult, SolveReply, WorkerReady } from './solve-worker-protocol.js';

interface HighsInstance {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string;
    ObjectiveValue?: number;
    Columns?: Record<string, { Primal?: number }>;
    // DUAL-SKIP FILTER: HiGHS always returns per-constraint rows with a Dual; the
    // worker only forwards them when the request asks for duals.
    Rows?: Array<{ Index?: number; Name?: string; Dual?: number }>;
  };
}

if (!parentPort) {
  throw new Error('solve-worker must be run as a worker_thread (no parentPort)');
}
const port = parentPort;

// Load the HiGHS WASM module once. `import('highs')` resolves to the CJS loader
// function (interop default); calling it returns the instance. Identical to
// solver.ts's getHiGHS, just per-worker. Top-level await is fine in an ESM worker.
const loadHighs = (await import('highs')).default as unknown as (opts?: unknown) => Promise<HighsInstance>;
const highs: HighsInstance = await loadHighs();

/**
 * Slim a full HiGHS solution to the minimal payload the coordinator's
 * parseHighsResult reads. Only non-zero primals are forwarded — zeros are the
 * default in parseHighsResult, so dropping them yields a byte-identical parse
 * with a far smaller structured-clone payload (matters for 1000-var ladders).
 */
function slim(jobId: number, raw: ReturnType<HighsInstance['solve']>, returnDuals: boolean): SlimSolveResult {
  if (raw.Status !== 'Optimal') {
    return { jobId, status: raw.Status };
  }
  const columns: Record<string, { Primal: number }> = {};
  const cols = raw.Columns;
  if (cols) {
    for (const name in cols) {
      const p = cols[name]?.Primal;
      if (p != null && p !== 0) columns[name] = { Primal: p };
    }
  }
  const out: SlimSolveResult = { jobId, status: 'Optimal', objectiveValue: raw.ObjectiveValue, columns };
  // DUAL-SKIP FILTER: forward only the NON-ZERO state-row duals (mirrors the
  // non-zero-primal column slimming). The row index is taken from the digits in the
  // `s{idx}` Name (falling back to `Index`); the coordinator pre-sizes rowDual to
  // the row count, so omitted (zero) rows stay 0 — the correct dual.
  if (returnDuals && Array.isArray(raw.Rows)) {
    const rows: Array<{ i: number; Dual: number }> = [];
    for (const r of raw.Rows) {
      const d = r.Dual;
      if (d == null || d === 0) continue;
      const i = r.Name != null ? parseInt(String(r.Name).replace(/[^0-9]/g, ''), 10) : (r.Index ?? NaN);
      if (Number.isFinite(i) && i >= 0) rows.push({ i, Dual: d });
    }
    if (rows.length > 0) out.rows = rows;
  }
  return out;
}

port.on('message', (msg: SolveRequest) => {
  const results: SlimSolveResult[] = [];
  const returnDuals = msg.returnDuals === true;
  for (const job of msg.jobs) {
    try {
      const raw = highs.solve(job.lpString);
      results.push(slim(job.jobId, raw, returnDuals));
    } catch {
      // One malformed LP must never take down the worker — report it as an Error
      // result (the coordinator treats it exactly like the in-process catch path)
      // and keep solving the rest of the chunk.
      results.push({ jobId: job.jobId, status: 'Error' });
    }
  }
  const reply: SolveReply = { batchId: msg.batchId, results };
  port.postMessage(reply);
});

// Signal readiness only AFTER the WASM instance is live, so the coordinator's
// ready() gate guarantees the first batch never races an un-inited worker.
const ready: WorkerReady = { ready: true };
port.postMessage(ready);
