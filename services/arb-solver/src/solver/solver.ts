import type { LPProblem, LPResult } from './types.js';
import { buildLPString, parseHighsResult } from './lp-string.js';
import { config } from '../config.js';

interface HighsInstance {
  solve(problem: string, options?: Record<string, unknown>): any;
}

let highsInstance: HighsInstance | null = null;

/**
 * Accumulates per-phase solve time (render / wasm / parse) so the per-solve
 * cost split can be inspected. Only written when `config.solver.costSplit`
 * is on (default off, zero overhead). Read + reset via
 * {@link getSolveCostSplit}.
 */
interface CostSplitTally {
  render: { n: number; ms: number };
  wasm: { n: number; ms: number };
  parse: { n: number; ms: number };
}
const costSplit: CostSplitTally = {
  render: { n: 0, ms: 0 },
  wasm: { n: 0, ms: 0 },
  parse: { n: 0, ms: 0 },
};

/**
 * Returns the accumulated cost-split tally (counts + sum-ms per phase). When
 * `reset` is true, the tally is zeroed after the snapshot so the next call
 * reports only its own interval.
 */
export function getSolveCostSplit(reset = false): CostSplitTally {
  const snap: CostSplitTally = {
    render: { ...costSplit.render },
    wasm: { ...costSplit.wasm },
    parse: { ...costSplit.parse },
  };
  if (reset) {
    costSplit.render = { n: 0, ms: 0 };
    costSplit.wasm = { n: 0, ms: 0 };
    costSplit.parse = { n: 0, ms: 0 };
  }
  return snap;
}

async function getHiGHS(): Promise<HighsInstance> {
  if (!highsInstance) {
    // highs exports a WASM loader function; TS types don't perfectly reflect the runtime API
    const mod = await import('highs');
    const loader = (mod.default as any) as (opts?: any) => Promise<HighsInstance>;
    highsInstance = await loader();
  }
  return highsInstance!;
}

/**
 * Solve an LP using HiGHS WASM.
 * Builds LP format string and calls the solver.
 */
export async function solveLP(problem: LPProblem): Promise<LPResult> {
  const start = performance.now();

  try {
    const highs = await getHiGHS();

    // Render + solve + parse via the shared pure helpers (lp-string.ts), so
    // this in-process path and the worker-pool path are byte-for-byte
    // identical; only the wall-clock `solveTimeMs` is local. When
    // `config.solver.costSplit` is on, render/wasm/parse are timed
    // separately.
    const returnDuals = config.solver.returnDuals;
    if (config.solver.costSplit) {
      const t0 = performance.now();
      const lpString = buildLPString(problem);
      const t1 = performance.now();
      const result = highs.solve(lpString);
      const t2 = performance.now();
      const parsed = parseHighsResult(result, problem.numVars, returnDuals, problem.constraints.length);
      const t3 = performance.now();
      costSplit.render.n++; costSplit.render.ms += t1 - t0;
      costSplit.wasm.n++; costSplit.wasm.ms += t2 - t1;
      costSplit.parse.n++; costSplit.parse.ms += t3 - t2;
      parsed.solveTimeMs = Math.round(t3 - start);
      return parsed;
    }
    const lpString = buildLPString(problem);
    const result = highs.solve(lpString);
    const parsed = parseHighsResult(result, problem.numVars, returnDuals, problem.constraints.length);
    parsed.solveTimeMs = Math.round(performance.now() - start);
    return parsed;
  } catch (err) {
    return {
      status: 'Error',
      optimalCost: Infinity,
      values: [],
      solveTimeMs: Math.round(performance.now() - start),
    };
  }
}
