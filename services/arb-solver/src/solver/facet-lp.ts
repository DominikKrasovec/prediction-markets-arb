/**
 * H-representation arb solver (facet / robust-counterpart LP): the production
 * counterpart of the V-rep path (`enumerateStates -> buildLP -> solveLP`),
 * emitting one dual row per cluster question plus a coverage row — O(n)
 * regardless of |Ω| — instead of one LP row per world. Matches V-rep exactly
 * on every integral polytope; conservatively sound off it (never a false arb).
 */
import { buildLegVariables } from './lp-builder.js';
import { interpretCluster, constraintsToFacets, marketToQuestion } from './omega-constraints.js';
import { unquotedQuestions } from './omega-audit.js';
import { bookLadderEnabled } from '../clob/token-map.js';
import { NO_EXECUTION_GATE } from './types.js';
import type { PriceCache } from '../clob/price-cache.js';
import type { Cluster } from '../graph/types.js';
import type {
  LPProblem,
  LPResult,
  ExecutionParams,
  FacetConstraint,
  FacetForm,
} from './types.js';

interface HighsInstance {
  solve(problem: string, options?: Record<string, unknown>): any;
}
let highsInstance: HighsInstance | null = null;
export async function getHiGHS(): Promise<HighsInstance> {
  if (!highsInstance) {
    const mod = await import('highs');
    const loader = (mod.default as any) as (opts?: any) => Promise<HighsInstance>;
    highsInstance = await loader();
  }
  return highsInstance!;
}
// Sync, never triggers the async import; omega-audit's relaxed-facet recheck runs inside a sync grade path and must fail toward refusal (null) rather than await.
export function tryGetLoadedHiGHS(): HighsInstance | null {
  return highsInstance;
}

// Mirrors the V-rep enumerator's soundness rules exactly (state-enumerator.ts) so both describe the same polytope. `isUnquoted` is the Ω-liveness predicate that demotes an exhaustive categorical with a dead slot to `sum z <= 1`.
export function clusterToFacets(
  cluster: Cluster,
  isUnquoted: (qid: number) => boolean,
): FacetConstraint[] {
  return constraintsToFacets(interpretCluster(cluster, { isUnquoted }));
}

// Leg variables/objective/G are identical to the V-rep (shared buildLegVariables); needs no enumerated cluster.validStates, so it solves clusters the enumerator drops. Returns null when no leg is usable.
export function buildFacetLP(
  cluster: Cluster,
  priceCache: PriceCache,
  exec: ExecutionParams = NO_EXECUTION_GATE,
  now: number = Date.now(),
  twoSidedBooks: boolean = true,
  bookLadder: boolean = bookLadderEnabled(),
): LPProblem | null {
  const legs = buildLegVariables(cluster, priceCache, exec, twoSidedBooks, bookLadder);
  if (!legs) return null;

  const unq = unquotedQuestions(cluster, priceCache, now);
  const facets = clusterToFacets(cluster, (qid) => unq.has(qid));
  const questionOrder = [...cluster.questions.keys()];

  const m2q = marketToQuestion(cluster);
  const legToQuestion: number[] = legs.variables.map((v) => (v.marketId === -1 ? -1 : m2q.get(v.marketId) ?? -1));

  const facetForm: FacetForm = { facets, questionOrder, legToQuestion };
  return {
    numVars: legs.numVars,
    objective: legs.objective,
    constraints: [], // H-rep encodes Ω in facetForm, not per-state rows here
    rhs: [],
    variables: legs.variables,
    clusterId: cluster.id,
    guaranteedPayoutVarIndex: legs.guaranteedPayoutVarIndex,
    facetForm,
  };
}

// Renders the robust-counterpart (dualized) LP to HiGHS LP-format text: leg vars x{i} + optional profit-max G, plus internal duals lam_f (>=0, one per <= facet), nu_f (free, one per = facet), mu_q (>=0, one per question).
export function buildFacetLPString(problem: LPProblem): string {
  const form = problem.facetForm;
  if (!form) throw new Error('buildFacetLPString: LPProblem has no facetForm (not an H-rep problem)');
  const { facets, questionOrder, legToQuestion } = form;
  const gIndex = problem.guaranteedPayoutVarIndex;
  const profitMax = gIndex !== undefined;

  const qPos = new Map<number, number>();
  questionOrder.forEach((q, i) => qPos.set(q, i));

  const objTerms: string[] = [];
  for (let i = 0; i < problem.numVars; i++) {
    const c = problem.objective[i];
    if (c !== 0) objTerms.push(`${c} x${i}`);
  }

  // Per-question dual-feasibility rows: mu_q + sum sign*x_leg + sum coeff_f(q)*(lam_f|nu_f) >= 0.
  const rowTerms: string[][] = questionOrder.map(() => []);
  questionOrder.forEach((_, qi) => rowTerms[qi].push(`+1 mu_${qi}`));
  for (let i = 0; i < problem.variables.length; i++) {
    const q = legToQuestion[i];
    if (q < 0) continue; // G var
    const qi = qPos.get(q);
    if (qi === undefined) continue;
    const sign = problem.variables[i].side === 'YES' ? 1 : -1;
    rowTerms[qi].push(`${sign > 0 ? '+' : '-'}1 x${i}`);
  }
  facets.forEach((f, fi) => {
    const vname = f.kind === 'le' ? `lam_${fi}` : `nu_${fi}`;
    for (const [qid, c0] of f.coeff) {
      const qi = qPos.get(qid);
      if (qi === undefined) continue;
      const c = f.kind === 'le' ? c0 : -c0;
      if (c === 0) continue;
      rowTerms[qi].push(`${c >= 0 ? '+' : ''}${c} ${vname}`);
    }
  });

  // Coverage row: dual objective >= target payoff.
  const cov: string[] = [];
  facets.forEach((f, fi) => {
    if (f.rhs === 0) return;
    if (f.kind === 'le') cov.push(`${-f.rhs >= 0 ? '+' : ''}${-f.rhs} lam_${fi}`);
    else cov.push(`${f.rhs >= 0 ? '+' : ''}${f.rhs} nu_${fi}`);
  });
  questionOrder.forEach((_, qi) => cov.push(`-1 mu_${qi}`));
  for (let i = 0; i < problem.variables.length; i++) {
    if (legToQuestion[i] < 0) continue;
    if (problem.variables[i].side === 'NO') cov.push(`+1 x${i}`);
  }
  if (profitMax) cov.push(`-1 x${gIndex}`);

  const lines: string[] = ['Minimize', `  obj: ${objTerms.join(' + ') || '0'}`, 'Subject To'];
  rowTerms.forEach((terms, qi) => lines.push(`  rq_${qi}: ${terms.join(' ')} >= 0`));
  lines.push(`  cover: ${cov.join(' ')} >= ${profitMax ? 0 : 1}`);

  lines.push('Bounds');
  for (let i = 0; i < problem.numVars; i++) {
    const cap = problem.variables[i]?.maxShares;
    if (cap != null && Number.isFinite(cap)) lines.push(`  0 <= x${i} <= ${cap}`);
    else lines.push(`  x${i} >= 0`);
  }
  facets.forEach((f, fi) => {
    if (f.kind === 'eq') lines.push(`  nu_${fi} free`);
  });
  lines.push('End');
  return lines.join('\n');
}

// Extracts the leg primals x{i} into values[i] (index-aligned with problem.variables, so extractPortfolio reads it like a V-rep result); internal dual columns are ignored.
export async function solveFacetLP(problem: LPProblem): Promise<LPResult> {
  const start = performance.now();
  try {
    const highs = await getHiGHS();
    const lpString = buildFacetLPString(problem);
    const raw = highs.solve(lpString);
    if (raw?.Status !== 'Optimal') {
      return {
        status: raw?.Status === 'Infeasible' ? 'Infeasible' : 'Error',
        optimalCost: Infinity,
        values: [],
        solveTimeMs: Math.round(performance.now() - start),
      };
    }
    const values = new Array<number>(problem.numVars).fill(0);
    const cols = raw.Columns as Record<string, { Primal?: number }> | undefined;
    if (cols) {
      for (const [name, col] of Object.entries(cols)) {
        const m = /^x(\d+)$/.exec(name); // leg/G columns only
        if (!m) continue;
        const idx = Number(m[1]);
        if (idx >= 0 && idx < problem.numVars) values[idx] = col.Primal ?? 0;
      }
    }
    return {
      status: 'Optimal',
      optimalCost: raw.ObjectiveValue ?? Infinity,
      values,
      solveTimeMs: Math.round(performance.now() - start),
    };
  } catch {
    return {
      status: 'Error',
      optimalCost: Infinity,
      values: [],
      solveTimeMs: Math.round(performance.now() - start),
    };
  }
}
