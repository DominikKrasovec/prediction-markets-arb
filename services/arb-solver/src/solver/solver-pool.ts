import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { buildLPString, parseHighsResult, type RawHighsResult } from './lp-string.js';
import type { LPProblem, LPResult } from './types.js';
import type { SolveRequest, SolveReply, WorkerReady } from './solve-worker-protocol.js';

/**
 * A pool of `worker_threads`, each owning its own HiGHS WASM instance, used to
 * move ONLY the synchronous blocking `highs.solve(string)` call off the main
 * event loop. The coordinator keeps ALL state and still runs buildLP +
 * extractPortfolio + grading + persistence; this class renders each LPProblem to
 * an LP string with the EXISTING `buildLPString` ON THE MAIN THREAD, ships the
 * strings to workers in CHUNKS (one message per worker per tick), and parses the
 * slimmed replies with the EXISTING `parseHighsResult`. Because the same string
 * is fed to the same WASM and parsed by the same code, a `solveBatch` result is
 * bit-for-bit identical to looping `solveLP` serially.
 *
 * Result routing is keyed on a process-monotonic `jobId` (NOT on worker/batch
 * identity), so a one-off `solve()` (the graded-residual path) can safely
 * interleave with a `solveBatch()` — each pending job resolves when its jobId
 * comes back from whichever worker held it.
 */
export class SolverPool {
  private readonly workers: Worker[];
  private readonly pending = new Map<number, { resolve: (r: LPResult) => void; numVars: number; numRows: number }>();
  private nextJobId = 1;
  private nextBatchId = 1;
  private readyPromise: Promise<void>;
  private terminated = false;

  constructor(size: number = config.solver.workerCount) {
    const n = Math.max(1, size);
    // Runtime-detect how this module was loaded so the worker entry matches:
    //  • under tsx, import.meta.url ends in ".ts" and there is no compiled
    //    `solve-worker.js` — spawn `solve-worker.ts` and bootstrap the tsx ESM
    //    loader inside the worker via `execArgv:['--import','tsx']` (worker
    //    threads do not inherit the parent's --import hooks).
    //  • under a compiled build, import.meta.url ends in ".js" — spawn the
    //    sibling `solve-worker.js` with no loader.
    const isTs = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(isTs ? './solve-worker.ts' : './solve-worker.js', import.meta.url);
    const workerOpts: ConstructorParameters<typeof Worker>[1] = isTs
      ? { execArgv: ['--import', 'tsx'] }
      : {};

    let readyCount = 0;
    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    this.readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(workerUrl, workerOpts);
      w.on('message', (msg: WorkerReady | SolveReply) => {
        if ((msg as WorkerReady).ready === true) {
          if (++readyCount === n) resolveReady();
          return;
        }
        this.onReply(msg as SolveReply);
      });
      // A worker that dies (e.g. OOM) must not hang every awaiting solve. Fail the
      // readiness gate if it dies pre-ready; once ready, a late error/exit rejects
      // all still-pending jobs so the coordinator's awaits settle instead of leaking.
      w.on('error', (err) => {
        rejectReady(err);
        this.failAllPending(err);
      });
      w.on('exit', (code) => {
        if (!this.terminated && code !== 0) {
          const err = new Error(`solver worker exited with code ${code}`);
          rejectReady(err);
          this.failAllPending(err);
        }
      });
      this.workers.push(w);
    }
  }

  /** Resolves once EVERY worker has loaded its HiGHS instance and posted ready. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Number of worker threads in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /**
   * Solve a single LP (the rare graded-residual path). Renders on the main
   * thread, dispatches to the least-busy worker, resolves with the parsed
   * `LPResult`. `solveTimeMs` is the coordinator-side wall-clock for the dispatch
   * (build-string + round-trip + parse), analogous to solveLP's own timing.
   */
  solve(lp: LPProblem): Promise<LPResult> {
    return this.solveBatch([lp]).then((rs) => rs[0]);
  }

  /**
   * Solve a batch of LPs in parallel — the hot path. Renders each LPProblem to a
   * string on the main thread, assigns a monotonic jobId, LPT-chunks the batch
   * across workers (sorted by estimated cost so the heaviest LPs are spread
   * first), posts ONE chunk per worker, and resolves the returned array IN INPUT
   * ORDER once every job's reply has been parsed.
   */
  async solveBatch(lps: LPProblem[]): Promise<LPResult[]> {
    if (lps.length === 0) return [];
    const start = performance.now();

    // Assign a jobId per input LP and remember its slot so we can return results
    // in input order regardless of which worker/chunk finishes first.
    const jobIds: number[] = new Array(lps.length);
    const promises: Array<Promise<LPResult>> = new Array(lps.length);
    for (let i = 0; i < lps.length; i++) {
      const jobId = this.nextJobId++;
      jobIds[i] = jobId;
      promises[i] = new Promise<LPResult>((resolve) => {
        this.pending.set(jobId, { resolve, numVars: lps[i].numVars, numRows: lps[i].constraints.length });
      });
    }

    // ── LPT chunking ──────────────────────────────────────────────────────────
    // Estimated solve cost ≈ numVars · constraints.length (string size + simplex
    // work both scale with it). Longest-Processing-Time: sort jobs by est cost
    // DESC, greedily give each to the currently least-loaded worker. Balances the
    // heavy-tailed batch (a few thousand-var ladders + many tiny LPs) across cores.
    const order = lps.map((_, i) => i).sort((a, b) => estCost(lps[b]) - estCost(lps[a]));
    const k = this.workers.length;
    // DUAL-SKIP FILTER: ask workers to forward state-row duals only when on (off ⟹
    // the reply omits Rows entirely — byte-identical to today's minimal payload).
    const returnDuals = config.solver.returnDuals;
    const chunks: SolveRequest[] = this.workers.map(() => ({ batchId: this.nextBatchId, jobs: [], returnDuals }));
    const load = new Array<number>(k).fill(0);
    for (const i of order) {
      // least-loaded worker
      let w = 0;
      for (let j = 1; j < k; j++) if (load[j] < load[w]) w = j;
      chunks[w].jobs.push({ jobId: jobIds[i], lpString: buildLPString(lps[i]) });
      load[w] += estCost(lps[i]);
    }
    this.nextBatchId++;

    // One message per worker (skip empty chunks).
    for (let w = 0; w < k; w++) {
      if (chunks[w].jobs.length > 0) this.workers[w].postMessage(chunks[w]);
    }

    const results = await Promise.all(promises);
    // Stamp a coordinator-side wall-clock for the whole dispatch onto each result
    // (the worker drops per-solve timing in the slim payload). Same field the
    // serial path fills; used only for the latency histograms.
    const elapsed = Math.round(performance.now() - start);
    for (const r of results) if (r.solveTimeMs === 0) r.solveTimeMs = elapsed;
    return results;
  }

  /** Terminate all workers. Idempotent; safe to call in a shutdown handler. */
  async terminate(): Promise<void> {
    this.terminated = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }

  // ── internals ──

  private onReply(reply: SolveReply): void {
    // DUAL-SKIP FILTER: whether THIS process asked workers for duals (the request
    // carried the same flag). Gating on the config — not on `r.rows` being present —
    // means an Optimal solve whose duals are all zero still yields a correctly-sized
    // (zero-filled) rowDual, exactly like the in-process path, so buildCert behaves
    // identically on both paths. Off ⟹ no rowDual is ever produced (byte-identical).
    const returnDuals = config.solver.returnDuals;
    for (const r of reply.results) {
      const slot = this.pending.get(r.jobId);
      if (!slot) continue; // already settled / unknown (defensive)
      this.pending.delete(r.jobId);
      const raw: RawHighsResult = {
        Status: r.status,
        ObjectiveValue: r.objectiveValue,
        Columns: r.columns,
        // The worker forwarded only NON-ZERO duals as `{i,Dual}`; map them to the
        // `{Index,Dual}` shape parseHighsResult reads. Omitted rows stay 0 (the
        // parser pre-sizes rowDual to numRows). No `rows` ⟹ all duals were zero.
        ...(r.rows ? { Rows: r.rows.map((x) => ({ Index: x.i, Dual: x.Dual })) } : {}),
      };
      slot.resolve(parseHighsResult(raw, slot.numVars, returnDuals, slot.numRows));
    }
  }

  /** Settle every in-flight job with an Error result so awaits never hang. */
  private failAllPending(_err: unknown): void {
    for (const [jobId, slot] of this.pending) {
      this.pending.delete(jobId);
      slot.resolve({ status: 'Error', optimalCost: Infinity, values: [], solveTimeMs: 0 });
    }
  }
}

/** Estimated relative solve cost of an LP — drives the LPT chunk balancer. */
function estCost(lp: LPProblem): number {
  // +1 guards a degenerate 0-constraint problem from collapsing to weight 0.
  return lp.numVars * (lp.constraints.length + 1);
}
