import type { LPProblem, LPResult } from './types.js';

/**
 * Pure rendering + result-extraction helpers shared by the single-threaded
 * `solveLP` (solver.ts) and the worker-pool path (solver-pool.ts /
 * solve-worker.ts), so both paths render and parse identically regardless of
 * whether the raw HiGHS result came from an in-process `highs.solve` or a
 * worker (which slims the result to `{ Status, ObjectiveValue,
 * Columns:{name:{Primal}} }`).
 */

/**
 * Renders an `LPProblem` to HiGHS LP-format text: objective, per-state `>=`
 * rows, and per-leg `0 <= x_i <= maxShares` / `x_i >= 0` bounds. The
 * lp-string test pins this output byte-for-byte.
 */
export function buildLPString(problem: LPProblem): string {
  const lines: string[] = ['Minimize'];

  // Objective
  const objTerms: string[] = [];
  for (let i = 0; i < problem.numVars; i++) {
    const coeff = problem.objective[i];
    if (coeff !== 0) {
      objTerms.push(`${coeff} x${i}`);
    }
  }
  lines.push(`  obj: ${objTerms.join(' + ') || '0'}`);

  // Constraints
  lines.push('Subject To');
  for (let s = 0; s < problem.constraints.length; s++) {
    const row = problem.constraints[s];
    const terms: string[] = [];
    for (let i = 0; i < problem.numVars; i++) {
      if (row[i] !== 0) {
        terms.push(`${row[i]} x${i}`);
      }
    }
    if (terms.length > 0) {
      lines.push(`  s${s}: ${terms.join(' + ')} >= ${problem.rhs[s]}`);
    }
  }

  // A variable with a finite `maxShares` (top-of-book size) is bounded
  // 0 <= x_i <= maxShares so the LP cannot assume more fill than exists at
  // the quote; `null`/undefined is uncapped (lower bound 0 still implied).
  lines.push('Bounds');
  for (let i = 0; i < problem.numVars; i++) {
    const cap = problem.variables[i]?.maxShares;
    if (cap != null && Number.isFinite(cap)) {
      lines.push(`  0 <= x${i} <= ${cap}`);
    } else {
      lines.push(`  x${i} >= 0`);
    }
  }

  lines.push('End');
  return lines.join('\n');
}

/**
 * The minimal slice of a HiGHS solution this module reads. The worker path
 * slims its reply to exactly this shape, so `parseHighsResult` is agnostic
 * to which path produced it. `Columns` keys are variable names like `x0` /
 * `x12`; only `Primal` is read.
 */
export interface RawHighsResult {
  Status: string;
  ObjectiveValue?: number;
  Columns?: Record<string, { Primal?: number }>;
  /**
   * Per-constraint (state-row) duals, present only when `parseHighsResult`
   * is asked for duals (`returnDuals=true`). Each entry carries the row
   * `Name` (`"s0"`, `"s1"`, … in `cluster.validStates` order), an `Index`,
   * and the dual value `Dual`.
   */
  Rows?: Array<{ Index?: number; Name?: string; Dual?: number }>;
}

/**
 * Extracts an `LPResult` from a raw HiGHS solution: the Status→status
 * mapping, optimalCost from `ObjectiveValue`, and the `Columns`→`values[]`
 * loop keyed by the digits in the column name (`x12` → index 12). The
 * caller fills in `solveTimeMs` from its own wall-clock; this returns it
 * as 0.
 *
 * When `returnDuals` is true and the solve was Optimal, also extracts the
 * per-state-row duals (`Rows[s].Dual`) into `result.rowDual`, indexed by
 * row `s` (`numRows` long) so `rowDual[s]` lines up with the state index.
 * Rows missing from a slimmed payload stay 0. When `returnDuals` is
 * false/omitted the field is never set.
 */
export function parseHighsResult(
  raw: RawHighsResult,
  numVars: number,
  returnDuals = false,
  numRows = 0,
): LPResult {
  if (raw.Status === 'Optimal') {
    const values = new Array(numVars).fill(0);
    const columns = raw.Columns;
    if (columns) {
      for (const [name, col] of Object.entries(columns)) {
        const idx = parseInt(name.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(idx) && idx < numVars) {
          values[idx] = col.Primal ?? 0;
        }
      }
    }

    const result: LPResult = {
      status: 'Optimal',
      optimalCost: raw.ObjectiveValue ?? Infinity,
      values,
      solveTimeMs: 0,
    };

    // Indexed by the digits in the row Name (`s12` -> 12), falling back to
    // `Index`. An absent `Rows` yields an all-zero vector of the right
    // length rather than an undefined one.
    if (returnDuals && numRows > 0) {
      const rowDual = new Array<number>(numRows).fill(0);
      if (raw.Rows) {
        for (const r of raw.Rows) {
          const idx =
            r.Name != null
              ? parseInt(String(r.Name).replace(/[^0-9]/g, ''), 10)
              : (r.Index ?? NaN);
          if (Number.isFinite(idx) && idx >= 0 && idx < numRows) {
            rowDual[idx] = r.Dual ?? 0;
          }
        }
      }
      result.rowDual = rowDual;
    }

    return result;
  }

  return {
    status: raw.Status === 'Infeasible' ? 'Infeasible' : 'Error',
    optimalCost: Infinity,
    values: [],
    solveTimeMs: 0,
  };
}
