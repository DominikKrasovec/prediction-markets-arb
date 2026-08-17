import type { Platform } from '@arb/types';
import type { ExecutionGrade } from './execution-grade.js';
import type { OmegaAudit } from './omega-audit.js';

export interface ExecutionParams {
  // Folds the per-market fee model into the objective; falls back to defaultFeeModel when absent.
  enforceFees: boolean;
  enforceDepthCap: boolean;
}

// Default = OFF: the ungated LP (no fees folded in, no depth caps).
export const NO_EXECUTION_GATE: ExecutionParams = {
  enforceFees: false,
  enforceDepthCap: false,
};

export interface LPVariable {
  index: number;
  marketId: number;
  platform: Platform;
  side: 'YES' | 'NO';
  askPrice: number;
  feePerShare: number;
  // null = uncapped. For a depth-aware tranche this is always the real size at
  // that book level — uncapping it would assume infinite size at that price.
  maxShares: number | null;
  level?: number; // depth-ladder tranche index: 0 = top of book, absent = non-tranched
}

export interface FacetConstraint {
  coeff: Array<[number, number]>;
  rhs: number;
  kind: 'le' | 'eq';
}

export interface FacetForm {
  facets: FacetConstraint[];
  questionOrder: number[];
  legToQuestion: number[]; // -1 for the `G` variable
}

export interface LPProblem {
  numVars: number;
  objective: number[];
  constraints: number[][];
  rhs: number[];
  variables: LPVariable[];
  clusterId: number;
  // Profit-max ladder mode only; absent = the prior minimize-cost-for-$1 LP (byte-identical to today).
  guaranteedPayoutVarIndex?: number;
  // H-rep engine only; absent on a V-rep problem (constraints/rhs carry the state rows there).
  facetForm?: FacetForm;
}

export interface LPResult {
  status: 'Optimal' | 'Infeasible' | 'Unbounded' | 'Error';
  optimalCost: number;
  values: number[];
  solveTimeMs: number;
  // Populated only when SOLVE_RETURN_DUALS=1 and the solve was Optimal; otherwise absent.
  rowDual?: number[];
}

export interface PortfolioLeg {
  marketId: number;
  platform: Platform;
  platformId: string;
  side: 'YES' | 'NO';
  shares: number;
  askPrice: number;
  bidPrice: number;
  askSize: number;
  feeUsd: number;
  cost: number;
  label: string;
  levelsConsumed?: number;
  depthProfile?: Array<{ price: number; shares: number }>;
}

export interface ArbOpportunity {
  clusterId: number;
  legs: PortfolioLeg[];
  totalCost: number;
  guaranteedPayout: number;
  profit: number;
  profitPct: number;
  stateCount: number;
  marketCount: number;
  worstEnumeratedStatePayout: number;
  liquidityUsd: number;
  feesUsd: number; // already included in totalCost
  executionGrade: ExecutionGrade;
  executionReasons: string[];
  // TRUE iff grade is clean/caution; a `risky` arb must never auto-execute or push-alert.
  eligibleForAutoExecution: boolean;
  omegaAudit?: OmegaAudit;
  solveTimeMs: number;
  detectedAt: string;

  venues: string[];
  // TRUE ⟺ legs span ≥2 venues, which settle edge outcomes independently. Flag only, never filters.
  settlementVenueMismatch: boolean;

  daysToSettlement?: number | null;
  horizonCoverage?: number;
  recycledCapitalUsd?: number;
  effectiveCapitalUsd?: number;
  annualizedEdge?: number | null;
  aswThreshold?: number | null;
  belowSettlementFrontier?: boolean;
  settlementCurve?: string;

  venueRoundedProfit?: number; // ≤ profit, never above
  venueRoundingSharesRemoved?: number;
}
