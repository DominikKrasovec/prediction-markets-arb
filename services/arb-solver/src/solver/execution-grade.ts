import type { Platform } from '@arb/types';
import {
  annualizedEdge,
  aswThreshold,
  DEFAULT_ASW_CURVE,
  type AswCurve,
} from './settlement-economics.js';

// Annotation, not a hard reject; `blocked` means the Ω is untrustworthy for this basket and is never persisted.
export type ExecutionGrade = 'clean' | 'caution' | 'risky' | 'blocked';

// Net edge above this forces `blocked` (adjudicate manually); blunt by design.
export const DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD = 10_000;

export const EDGE_MAGNITUDE_TRIPWIRE_REASON = 'edge-magnitude tripwire (adjudicate manually)';

// Env override is raise-only: can push the floor above default, never below.
export function resolveEdgeMagnitudeTripwireUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARB_EDGE_MAGNITUDE_TRIPWIRE_USD;
  const parsed = raw != null ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD
    ? parsed
    : DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD;
}

export const MOSTLY_UNQUOTED_RISKY_FRACTION = 0.5;

// Pre-solve skip floor (perf only); must stay below MOSTLY_UNQUOTED_RISKY_FRACTION.
export const DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR = 0.10;

export const QUOTED_FRACTION_SOLVE_FLOOR_MAX = 0.25;

// Env override is raise-only, clamped to QUOTED_FRACTION_SOLVE_FLOOR_MAX.
export function resolveQuotedFractionSolveFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARB_QUOTED_FRACTION_SOLVE_FLOOR;
  const parsed = raw != null ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR) {
    return DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR;
  }
  return Math.min(parsed, QUOTED_FRACTION_SOLVE_FLOOR_MAX);
}

// Bumped when the magnitude tripwire fires; never affects gradeExecution's return value.
let edgeMagnitudeTripwireCount = 0;
export function edgeMagnitudeTripwireCensus(): number {
  return edgeMagnitudeTripwireCount;
}
export function resetEdgeMagnitudeTripwireCensus(): void {
  edgeMagnitudeTripwireCount = 0;
}

export interface LegExecutionSignal {
  platform: Platform;
  /** USD available at the leg's quote (askSize·askPrice or bidSize·(1−bidPrice)). */
  liquidityUsd: number;
  quoteAgeMs: number;
  /** Relative spread (bestAsk − bestBid) / max(midprice, ε); 0 when unknown. */
  spread: number;
  daysToResolution?: number;
}

export interface SettlementFrontierConfig {
  enabled: boolean;
  curve: AswCurve;
  // Uses the disputed-p95 settlement lag instead of the undisputed one.
  disputedLag?: boolean;
}

export const DEFAULT_SETTLEMENT_FRONTIER: SettlementFrontierConfig = {
  enabled: true,
  curve: DEFAULT_ASW_CURVE,
  disputedLag: false,
};

export interface GradeThresholds {
  riskyLiquidityUsd: number;
  cautionLiquidityUsd: number;
  cautionAgeMs: number;
  cautionSpread: number;
  settlement?: SettlementFrontierConfig;
  // Demote-only, depth-aware ladder path only; absent means enabled.
  venueRounding?: { enabled: boolean };
  edgeMagnitudeTripwireUsd?: number;
}

export const DEFAULT_GRADE_THRESHOLDS: GradeThresholds = {
  riskyLiquidityUsd: 25,
  cautionLiquidityUsd: 100,
  cautionAgeMs: 30_000,
  cautionSpread: 0.10,
  settlement: { ...DEFAULT_SETTLEMENT_FRONTIER },
  venueRounding: { enabled: true },
  edgeMagnitudeTripwireUsd: resolveEdgeMagnitudeTripwireUsd(),
};

// capitalUsd should already be net of negRisk NO-basket recycling (effectiveLockedCapital).
export interface BasketEconomics {
  netEdgeUsd: number;
  capitalUsd: number;
  // Absent: the grade derives tau = max over legs' daysToResolution.
  daysToSettlement?: number | null;
}

const SEVERITY: Record<ExecutionGrade, number> = { clean: 0, caution: 1, risky: 2, blocked: 3 };

// Demote-only join on the grade lattice (clean < caution < risky < blocked).
export function worstGrade(a: ExecutionGrade, b: ExecutionGrade): ExecutionGrade {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

const worst = worstGrade;

export interface GradeResult {
  grade: ExecutionGrade;
  reasons: string[];
}

// Pure, deterministic: grade is the worst single leg signal; bumps the tripwire census counter as its only side effect.
export function gradeExecution(
  legs: LegExecutionSignal[],
  thresholds: GradeThresholds = DEFAULT_GRADE_THRESHOLDS,
  basket?: BasketEconomics,
): GradeResult {
  if (legs.length === 0) return { grade: 'risky', reasons: ['no legs'] };

  let grade: ExecutionGrade = 'clean';
  const reasons: string[] = [];

  const minLiq = Math.min(...legs.map((l) => l.liquidityUsd));
  if (minLiq <= thresholds.riskyLiquidityUsd) {
    grade = worst(grade, 'risky');
    reasons.push(`thin book: min leg liquidity $${minLiq.toFixed(2)} ≤ $${thresholds.riskyLiquidityUsd}`);
  } else if (minLiq <= thresholds.cautionLiquidityUsd) {
    grade = worst(grade, 'caution');
    reasons.push(`moderate book: min leg liquidity $${minLiq.toFixed(2)} ≤ $${thresholds.cautionLiquidityUsd}`);
  }

  const maxAge = Math.max(...legs.map((l) => l.quoteAgeMs));
  if (maxAge > thresholds.cautionAgeMs) {
    grade = worst(grade, 'caution');
    reasons.push(`stale quote: oldest leg ${(maxAge / 1000).toFixed(1)}s > ${(thresholds.cautionAgeMs / 1000).toFixed(0)}s`);
  }

  const maxSpread = Math.max(...legs.map((l) => l.spread));
  if (maxSpread > thresholds.cautionSpread) {
    grade = worst(grade, 'caution');
    reasons.push(`wide spread: ${(maxSpread * 100).toFixed(1)}% > ${(thresholds.cautionSpread * 100).toFixed(0)}%`);
  }

  // Legs fill independently; one can move/lift while another rests. 2 platforms -> caution, ≥3 -> risky.
  const platforms = new Set(legs.map((l) => l.platform));
  if (platforms.size >= 3) {
    grade = worst(grade, 'risky');
    reasons.push(`${platforms.size} platforms (high leg risk)`);
  } else if (platforms.size === 2) {
    grade = worst(grade, 'caution');
    reasons.push('cross-platform basket (leg risk)');
  }

  // Demote-only: below the market's ASW frontier at its lock-up horizon is negative-carry
  // despite LP certification. Unknown horizon can't be annualized, but a sub-1% edge alone
  // still demotes below since it can't clear any frontier fast.
  const settlement = thresholds.settlement;
  if (settlement?.enabled && basket) {
    const horizons = legs
      .map((l) => l.daysToResolution)
      .filter((d): d is number => d != null && Number.isFinite(d));
    const tau = basket.daysToSettlement ?? (horizons.length > 0 ? Math.max(...horizons) : null);
    if (tau == null && basket.capitalUsd > 0 && Number.isFinite(basket.netEdgeUsd) && basket.netEdgeUsd > 0) {
      const absEdgePct = (basket.netEdgeUsd / basket.capitalUsd) * 100;
      if (absEdgePct < 1) {
        grade = worst(grade, 'caution');
        reasons.push(
          `unknown settlement horizon with sub-1% edge (${absEdgePct.toFixed(2)}%): ` +
          `cannot prove above-frontier without τ (S6 — NULL end_date leg)`,
        );
      }
    }
    if (tau != null && Number.isFinite(tau)) {
      const edge = annualizedEdge(basket.netEdgeUsd, basket.capitalUsd, tau);
      const frontier = aswThreshold(tau, settlement.curve);
      if (Number.isFinite(edge) && edge < frontier) {
        grade = worst(grade, 'caution');
        reasons.push(
          `below settlement frontier: annualized edge ${(edge * 100).toFixed(2)}% < ` +
          `ASW(${Math.round(tau)}d) ${(frontier * 100).toFixed(2)}% ` +
          `[${settlement.curve.preset}/${settlement.curve.shape}]`,
        );
      }
    }
  }

  const tripwireUsd = thresholds.edgeMagnitudeTripwireUsd ?? DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD;
  if (basket && Number.isFinite(basket.netEdgeUsd) && basket.netEdgeUsd > tripwireUsd) {
    grade = worst(grade, 'blocked');
    edgeMagnitudeTripwireCount++;
    reasons.push(`${EDGE_MAGNITUDE_TRIPWIRE_REASON}: net edge $${basket.netEdgeUsd.toFixed(0)} > $${tripwireUsd.toFixed(0)}`);
  }

  if (reasons.length === 0) reasons.push('single platform, deep, fresh, tight');
  return { grade, reasons };
}

export interface OmegaGradeInput {
  relaxedRecheck: 'pass' | 'fail' | 'overflow' | 'skipped-no-dropped-constraints';
  duplicateSuspectHeld: boolean;
  pinnedQuestions: number[];
  unquotedClosureQuestionCount: number;
  distance1UnquotedSibling: boolean;
  quotedFraction: number;
  // null means no contradicting clique; absent behaves as null (never demotes on its own).
  mutexPriceContradictionSigma?: number | null;
  staleComplementSideHeld?: boolean;
  implicationPriceContradictionGap?: number | null;
  // Certified against the facet relaxation R ⊇ Ω; caps at caution. Absent = no cap.
  relaxedOmega?: boolean;
  // 0 with relaxedOmega means risky, not caution; absent behaves as unknown (never demotes).
  stateCount?: number;
  sumOfAsksBelowFloor?: number | null;
  sumOfAsksCandleMember?: boolean;
}

// Demote-only, applied after the execution rules; `blocked` is an outright block, never persisted.
export function applyOmegaGrade(
  base: ExecutionGrade,
  reasons: string[],
  audit: OmegaGradeInput,
): GradeResult {
  let grade = base;
  const out = [...reasons];

  if (audit.relaxedRecheck === 'fail' || audit.relaxedRecheck === 'overflow') {
    grade = worst(grade, 'blocked');
    out.push(`Ω recheck ${audit.relaxedRecheck}: basket guarantee does not survive dropping unquoted-question walls`);
  }
  if (audit.duplicateSuspectHeld) {
    grade = worst(grade, 'blocked');
    out.push('duplicate-suspect basket: holds a position on a duplicate-partition twin (§4 Arm D belt)');
  }
  if (audit.mutexPriceContradictionSigma != null) {
    grade = worst(grade, 'blocked');
    out.push(
      `mutex price contradiction: Σ(YES bids)=${audit.mutexPriceContradictionSigma.toFixed(2)} over a hard-mutex clique — ` +
      `market prices multiple "exclusive" outcomes as likely-YES (multi-winner/false-mutex class, c441 Fields Medal)`,
    );
  }
  if (audit.staleComplementSideHeld) {
    grade = worst(grade, 'blocked');
    out.push(
      'stale complement side: basket holds a market side priced incoherently cheap vs the live opposite-side bid ' +
      '(abandoned one-sided book, not fillable — single-market box phantom, c7674)',
    );
  }
  if (audit.implicationPriceContradictionGap != null) {
    grade = worst(grade, 'blocked');
    out.push(
      `implication price contradiction: best-YES-bid(antecedent) exceeds best-YES-ask(consequent) by ` +
      `$${audit.implicationPriceContradictionGap.toFixed(2)} on a hard strict_implication — the market refutes ` +
      `the edge (mis-inferred direction / false merge class, S4 audit 2026-07-16)`,
    );
  }
  if (audit.pinnedQuestions.length > 0) {
    grade = worst(grade, 'blocked');
    out.push(`pinned/degenerate Ω: question(s) [${audit.pinnedQuestions.join(',')}] constant across all states`);
  }
  // Facet LP is a conservative outer polytope (may miss a tight arb, never invents one);
  // a relaxed-certified basket is never fully clean. A complement group whose asks sum
  // below the $1 floor blocks on a candle_direction member (provable oracle/tie-rule split),
  // else demotes to risky.
  if (audit.sumOfAsksBelowFloor != null) {
    const sigma = audit.sumOfAsksBelowFloor.toFixed(2);
    if (audit.sumOfAsksCandleMember) {
      grade = worst(grade, 'blocked');
      out.push(
        `oracle-divergence-shaped book (sum-of-asks ${sigma} < 0.60) on a candle_direction ` +
        `member — cross-venue candle merges settle on different oracles/tie rules`,
      );
    } else {
      grade = worst(grade, 'risky');
      out.push(`oracle-divergence-shaped book (sum-of-asks ${sigma} < 0.60)`);
    }
  }
  if (audit.relaxedOmega) {
    // stateCount 0 (nothing enumerated) -> risky; stateCount > 0 (enumeration-backed) -> caution.
    if (audit.stateCount === 0) {
      grade = worst(grade, 'risky');
      out.push(
        'unverified: relaxed-LP objective, no state enumeration backs this profit',
      );
    } else {
      grade = worst(grade, 'caution');
      out.push(
        'over-cap Ω: certified on the facet relaxation R ⊇ Ω (no exact enumeration) — never clean',
      );
    }
  }
  if (audit.unquotedClosureQuestionCount >= 1) {
    grade = worst(grade, 'caution');
    out.push(`${audit.unquotedClosureQuestionCount} dead Ω-defining sibling book(s) in the certified closure`);
  }
  if (audit.distance1UnquotedSibling) {
    grade = worst(grade, 'risky');
    out.push('dead sibling shares an outcome set or hard edge with a traded question (distance-1)');
  }
  if (audit.quotedFraction < MOSTLY_UNQUOTED_RISKY_FRACTION) {
    grade = worst(grade, 'risky');
    out.push(`cluster mostly unquoted: ${(audit.quotedFraction * 100).toFixed(0)}% of closure questions live`);
  }

  return { grade, reasons: out };
}
