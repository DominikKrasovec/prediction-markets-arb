import { describe, test, expect, beforeEach } from 'bun:test';
import {
  gradeExecution,
  applyOmegaGrade,
  DEFAULT_GRADE_THRESHOLDS,
  DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD,
  EDGE_MAGNITUDE_TRIPWIRE_REASON,
  resolveEdgeMagnitudeTripwireUsd,
  edgeMagnitudeTripwireCensus,
  resetEdgeMagnitudeTripwireCensus,
  resolveQuotedFractionSolveFloor,
  DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR,
  QUOTED_FRACTION_SOLVE_FLOOR_MAX,
  MOSTLY_UNQUOTED_RISKY_FRACTION,
  type GradeThresholds,
  type LegExecutionSignal,
} from './execution-grade.js';
import type { Platform } from '@arb/types';

const sig = (o: Partial<LegExecutionSignal> = {}): LegExecutionSignal => ({
  platform: 'kalshi' as Platform,
  liquidityUsd: 1000,
  quoteAgeMs: 0,
  spread: 0,
  ...o,
});

describe('gradeExecution', () => {
  test('clean: single platform, deep, fresh, tight', () => {
    expect(gradeExecution([sig(), sig()]).grade).toBe('clean');
  });

  test('risky on a very thin book', () => {
    expect(gradeExecution([sig({ liquidityUsd: 10 })]).grade).toBe('risky');
  });

  test('caution on a moderately thin book', () => {
    expect(gradeExecution([sig({ liquidityUsd: 50 })]).grade).toBe('caution');
  });

  test('caution on a stale quote', () => {
    expect(gradeExecution([sig({ quoteAgeMs: 60_000 })]).grade).toBe('caution');
  });

  test('caution on a wide spread', () => {
    expect(gradeExecution([sig({ spread: 0.2 })]).grade).toBe('caution');
  });

  test('cross-platform (2) → at least caution', () => {
    expect(gradeExecution([sig({ platform: 'kalshi' }), sig({ platform: 'polymarket' })]).grade)
      .toBe('caution');
  });

  test('three platforms → risky', () => {
    expect(gradeExecution([
      sig({ platform: 'kalshi' }), sig({ platform: 'polymarket' }), sig({ platform: 'predict' }),
    ]).grade).toBe('risky');
  });

  test('worst single signal dominates (thin + cross-platform → risky)', () => {
    expect(gradeExecution([
      sig({ platform: 'kalshi', liquidityUsd: 5 }),
      sig({ platform: 'polymarket' }),
    ]).grade).toBe('risky');
  });

  test('empty basket → risky', () => {
    expect(gradeExecution([]).grade).toBe('risky');
  });

  test('reasons are populated', () => {
    const r = gradeExecution([sig({ liquidityUsd: 5 })]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe('U1 settlement-frontier grading (paper3 ASW)', () => {
  const withCurve = (preset: 'min' | 'p01' | 'conservative'): GradeThresholds => ({
    ...DEFAULT_GRADE_THRESHOLDS,
    settlement: { enabled: true, curve: { preset, shape: 'flat' } },
  });

  test('audit fixture: 1.5% edge locked 300d → at most caution, "below settlement frontier"', () => {
    const r = gradeExecution(
      [sig({ daysToResolution: 300 })],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.015, capitalUsd: 1.0 },
    );
    expect(r.grade).toBe('caution');
    expect(r.reasons.some((x) => x.includes('below settlement frontier'))).toBe(true);
  });

  test('fat edge over the same lock-up stays clean', () => {
    const r = gradeExecution(
      [sig({ daysToResolution: 300 })],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.10, capitalUsd: 1.0 }, // ≈ 12.3%/yr ≫ 3.06%
    );
    expect(r.grade).toBe('clean');
  });

  test('paper3 §1 Jesus fixture: ≈4.17%/yr clears the min frontier but not p01', () => {
    const legs = [sig({ daysToResolution: 365 })];
    const basket = { netEdgeUsd: 0.04, capitalUsd: 0.96 };
    expect(gradeExecution(legs, withCurve('min'), basket).grade).toBe('clean');
    const p01 = gradeExecution(legs, withCurve('p01'), basket);
    expect(p01.grade).toBe('caution');
    expect(p01.reasons.some((x) => x.includes('below settlement frontier'))).toBe(true);
  });

  test('never upgrades: a risky basket below the frontier stays risky', () => {
    const r = gradeExecution(
      [sig({ liquidityUsd: 5, daysToResolution: 300 })],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.015, capitalUsd: 1.0 },
    );
    expect(r.grade).toBe('risky');
    expect(r.reasons.some((x) => x.includes('below settlement frontier'))).toBe(true);
  });

  test('belt demotes are BLOCKED in-module (mutation audit 2026-07-21: kill coverage must not depend on neighbor files)', () => {
    const base = { closureQuestionCount: 1, closureBookCount: 1, deadBookCount: 0, unquotedClosureQuestionCount: 0, quotedFraction: 1, relaxedRecheck: 'pass' as const, duplicateSuspectHeld: false, pinnedQuestions: [] as number[], distance1UnquotedSibling: false, mutexPriceContradictionSigma: null as number | null, staleComplementSideHeld: false, implicationPriceContradictionGap: null as number | null, relaxedOmega: false };
    expect(applyOmegaGrade('clean', [], { ...base, mutexPriceContradictionSigma: 2.8 }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, staleComplementSideHeld: true }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, duplicateSuspectHeld: true }).grade).toBe('blocked');
    expect(applyOmegaGrade('clean', [], { ...base, implicationPriceContradictionGap: 0.2 }).grade).toBe('blocked');
  });

  test('RELAXED-FACET ROUTE (Wave D): relaxedOmega caps clean → caution (demote-only)', () => {
    const base = { closureQuestionCount: 1, closureBookCount: 1, deadBookCount: 0, unquotedClosureQuestionCount: 0, quotedFraction: 1, relaxedRecheck: 'pass' as const, duplicateSuspectHeld: false, pinnedQuestions: [] as number[], distance1UnquotedSibling: false, mutexPriceContradictionSigma: null as number | null, staleComplementSideHeld: false, implicationPriceContradictionGap: null as number | null, relaxedOmega: false };
    // clean → caution, with the over-cap reason.
    const capped = applyOmegaGrade('clean', [], { ...base, relaxedOmega: true });
    expect(capped.grade).toBe('caution');
    expect(capped.reasons.some((r) => r.includes('over-cap Ω'))).toBe(true);
    // A blocked arm stays blocked (demote-only, never upgrades).
    expect(applyOmegaGrade('clean', [], { ...base, relaxedOmega: true, duplicateSuspectHeld: true }).grade).toBe('blocked');
    // Absent relaxedOmega field ⟹ unchanged (no cap).
    expect(applyOmegaGrade('clean', [], base).grade).toBe('clean');
  });

  test('S6 (2026-07-16): unknown horizon + sub-1% edge demotes to caution', () => {
    // A sub-1% absolute edge cannot clear ANY frontier without a provably-short
    // τ, so unknown horizon demotes it (demote-only, caution).
    const r = gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: 0.001, capitalUsd: 1.0 });
    expect(r.grade).toBe('caution');
    expect(r.reasons.join(' ')).toContain('unknown settlement horizon');
  });

  test('S6: unknown horizon with a ≥1% edge still does NOT demote (τ unprovable)', () => {
    const r = gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: 0.05, capitalUsd: 1.0 });
    expect(r.grade).toBe('clean');
  });

  test('basket.daysToSettlement overrides per-leg horizons', () => {
    const r = gradeExecution(
      [sig()], // no leg horizon
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.015, capitalUsd: 1.0, daysToSettlement: 300 },
    );
    expect(r.grade).toBe('caution');
  });

  test('partial coverage uses max of the KNOWN horizons (optimistic τ, still demotes)', () => {
    const r = gradeExecution(
      [sig({ daysToResolution: 300 }), sig()],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.015, capitalUsd: 1.0 },
    );
    expect(r.grade).toBe('caution');
  });

  test('flag off (or absent) → no demotion', () => {
    const off: GradeThresholds = {
      ...DEFAULT_GRADE_THRESHOLDS,
      settlement: { enabled: false, curve: { preset: 'min', shape: 'flat' } },
    };
    expect(gradeExecution([sig({ daysToResolution: 300 })], off, { netEdgeUsd: 0.015, capitalUsd: 1.0 }).grade)
      .toBe('clean');
    const { settlement: _drop, ...rest } = DEFAULT_GRADE_THRESHOLDS;
    expect(gradeExecution([sig({ daysToResolution: 300 })], rest, { netEdgeUsd: 0.015, capitalUsd: 1.0 }).grade)
      .toBe('clean');
  });

  test('no basket economics provided → no demotion (pure legacy call)', () => {
    expect(gradeExecution([sig({ daysToResolution: 300 })]).grade).toBe('clean');
  });

  test('fully recycled capital (U3, capital 0) is never below the frontier', () => {
    const r = gradeExecution(
      [sig({ daysToResolution: 300 })],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 0.10, capitalUsd: 0 },
    );
    expect(r.grade).toBe('clean');
  });
});

describe('mechanism 6: edge-magnitude tripwire', () => {
  beforeEach(() => resetEdgeMagnitudeTripwireCensus());

  test('net edge over the $10k floor forces blocked + adjudicate-manually reason + census bump', () => {
    const r = gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: 667_000, capitalUsd: 7_070_000 });
    expect(r.grade).toBe('blocked');
    expect(r.reasons.some((x) => x.includes(EDGE_MAGNITUDE_TRIPWIRE_REASON))).toBe(true);
    expect(edgeMagnitudeTripwireCensus()).toBe(1);
  });

  test('net edge at/under the floor does NOT trip (boundary is strict >)', () => {
    const at = gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD, capitalUsd: 1 });
    expect(at.grade).toBe('clean');
    expect(edgeMagnitudeTripwireCensus()).toBe(0);
  });

  test('missing / non-finite / non-positive net edge never trips (no fabricated refusal)', () => {
    expect(gradeExecution([sig()]).grade).toBe('clean'); // no basket
    expect(gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: Number.NaN, capitalUsd: 1 }).grade).toBe('clean');
    expect(gradeExecution([sig()], DEFAULT_GRADE_THRESHOLDS, { netEdgeUsd: -50_000, capitalUsd: 1 }).grade).toBe('clean');
    expect(edgeMagnitudeTripwireCensus()).toBe(0);
  });

  test('demote-only: a clean basket becomes blocked, a blocked stays blocked, never upgrades', () => {
    // A huge edge on a thin cross-3-platform basket is already risky → still blocked.
    const r = gradeExecution(
      [sig({ platform: 'kalshi', liquidityUsd: 5 }), sig({ platform: 'polymarket' }), sig({ platform: 'predict' })],
      DEFAULT_GRADE_THRESHOLDS,
      { netEdgeUsd: 1_400_000, capitalUsd: 1 },
    );
    expect(r.grade).toBe('blocked');
  });

  test('raise-only env clamp: sub-floor values ignored, super-floor values honored', () => {
    expect(resolveEdgeMagnitudeTripwireUsd({ ARB_EDGE_MAGNITUDE_TRIPWIRE_USD: '5000' } as NodeJS.ProcessEnv)).toBe(DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD);
    expect(resolveEdgeMagnitudeTripwireUsd({ ARB_EDGE_MAGNITUDE_TRIPWIRE_USD: '50000' } as NodeJS.ProcessEnv)).toBe(50_000);
    expect(resolveEdgeMagnitudeTripwireUsd({ ARB_EDGE_MAGNITUDE_TRIPWIRE_USD: 'garbage' } as NodeJS.ProcessEnv)).toBe(DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD);
    expect(resolveEdgeMagnitudeTripwireUsd({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EDGE_MAGNITUDE_TRIPWIRE_USD);
  });

  test('a higher configured floor lets a $20k edge through as non-blocked', () => {
    const th: GradeThresholds = { ...DEFAULT_GRADE_THRESHOLDS, edgeMagnitudeTripwireUsd: 50_000 };
    const r = gradeExecution([sig()], th, { netEdgeUsd: 20_000, capitalUsd: 1 });
    expect(r.grade).toBe('clean');
  });
});

describe('mechanism 5 (ii): quotedFraction pre-solve skip floor', () => {
  test('default floor is 0.10 and sits WELL BELOW the risky-demotion threshold (0.5)', () => {
    expect(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR).toBe(0.10);
    expect(MOSTLY_UNQUOTED_RISKY_FRACTION).toBe(0.5);
    // The whole point: the skip floor must never collide with the risky rung.
    expect(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR).toBeLessThan(MOSTLY_UNQUOTED_RISKY_FRACTION);
    // And even a maximally-raised floor stays clear of the risky threshold …
    expect(QUOTED_FRACTION_SOLVE_FLOOR_MAX).toBeLessThan(MOSTLY_UNQUOTED_RISKY_FRACTION);
    // … and below the lowest SOUND quotedFraction observed, so no sound arb
    // is skipped even at max raise.
    expect(QUOTED_FRACTION_SOLVE_FLOOR_MAX).toBeLessThan(0.27);
  });

  test('raise-only env clamp: sub-default ignored, super-default honored, above-max clamped', () => {
    // absent / non-numeric ⟹ default
    expect(resolveQuotedFractionSolveFloor({} as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR);
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: 'garbage' } as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR);
    // sub-default (lowering = off-switch direction) ⟹ ignored, stays at default
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '0.02' } as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR);
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR);
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '-1' } as NodeJS.ProcessEnv)).toBe(DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR);
    // super-default within range ⟹ honored
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '0.20' } as NodeJS.ProcessEnv)).toBe(0.20);
    // above the max ⟹ clamped (never collides with the risky threshold)
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '0.9' } as NodeJS.ProcessEnv)).toBe(QUOTED_FRACTION_SOLVE_FLOOR_MAX);
    expect(resolveQuotedFractionSolveFloor({ ARB_QUOTED_FRACTION_SOLVE_FLOOR: '0.49' } as NodeJS.ProcessEnv)).toBe(QUOTED_FRACTION_SOLVE_FLOOR_MAX);
  });
});
