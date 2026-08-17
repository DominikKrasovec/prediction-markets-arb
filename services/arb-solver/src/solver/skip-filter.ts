import type { LPProblem, LPResult } from './types.js';

// Sound skip filter (SOLVE_SKIP_FILTER=1): SKIP only when a stored dual certificate proves
// optimalCost ≥ theta+eps without re-solving (see decideSkip). A column needing a bound-dual
// (w>0) that is uncapped invalidates the certificate — full-solve. Never skip the profit-max
// ladder form.

const EPS = 1e-7;

// Dual certificate from a cluster's last full solve; valid only while a fresh tick's
// structKey matches.
export interface ClusterDualCert {
  structKey: string;
  optimalCost: number;
  sumRowDual: number;
  rowDual: number[];
  colStates: number[][];
  profitMax: boolean;
}

export function lpIsProfitMax(lp: LPProblem): boolean {
  return lp.guaranteedPayoutVarIndex !== undefined;
}

export function colStatesOf(lp: LPProblem): number[][] {
  const cs: number[][] = Array.from({ length: lp.numVars }, () => []);
  for (let s = 0; s < lp.constraints.length; s++) {
    const row = lp.constraints[s];
    for (let i = 0; i < lp.numVars; i++) {
      if (row[i] > 0) cs[i].push(s);
    }
  }
  return cs;
}

// Structural fingerprint (shape only — not prices/caps); a mismatch against a stored
// cert's structKey means the cert is for a different LP and must not be reused.
export function structKey(lp: LPProblem): string {
  const parts: string[] = [];
  parts.push(`n${lp.numVars}`);
  parts.push(`s${lp.constraints.length}`);
  parts.push(`g${lp.guaranteedPayoutVarIndex ?? -1}`);
  const vsig: string[] = [];
  for (const v of lp.variables) {
    vsig.push(`${v.marketId}:${v.side === 'YES' ? 'Y' : 'N'}:${v.level ?? -1}`);
  }
  parts.push('v=' + vsig.join(','));
  const cs = colStatesOf(lp);
  parts.push('A=' + cs.map((states) => states.join('.')).join('|'));
  return parts.join('#');
}

// null when the solve can't be trusted as a certificate (non-Optimal, no duals, or the
// profit-max ladder form). A facet (H-rep) LP has no state rows, so it never gets a cert.
export function buildCert(lp: LPProblem, result: LPResult): ClusterDualCert | null {
  if (lp.facetForm) return null;
  if (result.status !== 'Optimal') return null;
  if (lpIsProfitMax(lp)) return null; // ladder form is never skipped
  const rowDual = result.rowDual;
  if (!rowDual || rowDual.length !== lp.constraints.length) return null; // duals absent/mismatched
  let sum = 0;
  for (const y of rowDual) sum += y;
  return {
    structKey: structKey(lp),
    optimalCost: result.optimalCost,
    sumRowDual: sum,
    rowDual: rowDual.slice(),
    colStates: colStatesOf(lp),
    profitMax: false,
  };
}

// L = Σy* − Σ(u₂·w), w = max(0, cover − c₂); the new LP's dual lower bound from a stored cert.
export function dualLowerBound(cert: ClusterDualCert, lpNew: LPProblem): { L: number; valid: boolean } {
  let penalty = 0;
  const y = cert.rowDual;
  for (let i = 0; i < lpNew.numVars; i++) {
    const states = cert.colStates[i];
    if (!states || states.length === 0) continue; // G column / covers nothing
    let cover = 0;
    for (const s of states) cover += y[s];
    const c2 = lpNew.objective[i];
    const w = cover - c2; // > 0 ⟹ needs a bound dual
    if (w > EPS) {
      const u2 = lpNew.variables[i]?.maxShares;
      if (u2 == null || !Number.isFinite(u2)) return { L: -Infinity, valid: false };
      penalty += u2 * w;
    }
  }
  return { L: cert.sumRowDual - penalty, valid: true };
}

export type SkipReason =
  | 'skip'
  | 'no-cert'
  | 'profit-max'
  | 'struct-changed'
  | 'cert-invalid'
  | 'below-theta'
  | 'facet-form';

export interface SkipDecision {
  skip: boolean;
  reason: SkipReason;
  L?: number;
}

// Fails safe to a full solve whenever the certificate can't prove optimalCost ≥ theta+eps
// (no cert, ladder form, structural change, invalid cert, or L < theta+eps).
export function decideSkip(
  cert: ClusterDualCert | undefined,
  lpNew: LPProblem,
  theta: number,
  eps: number = EPS,
): SkipDecision {
  if (lpNew.facetForm) return { skip: false, reason: 'facet-form' };
  if (!cert) return { skip: false, reason: 'no-cert' };
  if (cert.profitMax || lpIsProfitMax(lpNew)) return { skip: false, reason: 'profit-max' };
  if (structKey(lpNew) !== cert.structKey) return { skip: false, reason: 'struct-changed' };
  const { L, valid } = dualLowerBound(cert, lpNew);
  if (!valid) return { skip: false, reason: 'cert-invalid', L };
  if (L >= theta + eps) return { skip: true, reason: 'skip', L };
  return { skip: false, reason: 'below-theta', L };
}
