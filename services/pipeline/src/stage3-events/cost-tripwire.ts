/**
 * Stage-3b LLM-spend guardrails.
 *
 * The daemon drains `stage3_event_candidates` through paid DeepSeek calls on
 * every triggered tick (`llm-event-match.ts`). Steady-state cost is
 * pair-lifetime bounded, but any event that mass re-arms candidates (an
 * embedding wipe, a migration that resets candidate status, an ANN-gate
 * change) turns the next tick into an unbounded paid drain. Two independent
 * ceilings close that hole:
 *
 *   1. Per-tick candidate CAP (STAGE3_TICK_CAP) — bounds how many candidates ONE
 *      tick claims. The remaining pending candidates simply carry over to the next
 *      tick, so the backlog still clears; this is a CAP, not a drop.
 *   2. A daily COST TRIPWIRE (STAGE3_DAILY_COST_LIMIT_USD) — a cheap indexed sum of
 *      today's (UTC) `llm_logs.cost_usd` taken before each drain batch. Once the
 *      day's spend crosses the limit the tripwire trips: the drain halts and the
 *      trip is surfaced (loudly logged) on every subsequent tick until the UTC day
 *      rolls over, at which point the running sum resets to 0 and it auto-clears.
 *      The tripwire halts LLM spend ONLY — deterministic stages keep running.
 *
 * Both are TUNABLES (raise the ceiling for a legitimate large drain), NOT
 * off-switches — there is no env that DISABLES either guard (the soundness/safety
 * flag-gating doctrine: a shipped safety default that can be turned off is never
 * called when it matters). The persistent-tripwire shape mirrors the Ω-liveness
 * permanent tripwires (`arb-solver/src/solver/omega-audit.ts`).
 */
import { query } from '@arb/db';

// ── Per-tick cap arithmetic (pure) ────────────────────────────────────────────

/**
 * How many candidates the next claim may take without exceeding the per-tick cap.
 * `0` ⟹ the cap is reached and the tick must stop (backlog carries to next tick).
 * `cap` is guaranteed ≥ 1 by config (a non-positive env is clamped up, so the cap
 * can never be turned into an off-switch).
 */
export function nextClaimSize(totalSeen: number, cap: number, batch: number): number {
  return Math.max(0, Math.min(batch, cap - totalSeen));
}

// ── Daily cost tripwire ───────────────────────────────────────────────────────

/**
 * The cheap query seam — sum of today's (UTC) `llm_logs.cost_usd`. Injectable so
 * the tripwire logic is unit-testable without a DB (see cost-tripwire.test.ts),
 * mirroring the SQL-string / pure-function seams the neighbouring Stage-3 tests use.
 */
export type CostSumQuery = () => Promise<number>;

/**
 * Sum of `cost_usd` over the CURRENT UTC day. `date_trunc('day', now() AT TIME
 * ZONE 'UTC')` yields UTC midnight as a wall-clock timestamp; the trailing
 * `AT TIME ZONE 'UTC'` re-anchors it to the correct instant regardless of the
 * server session timezone, so the range scan uses `idx_llm_logs_created`.
 */
export function utcDayCostSumSql(): string {
  return `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
            FROM llm_logs
           WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

const defaultCostSum: CostSumQuery = async () => {
  const rows = await query<{ usd: number }>(utcDayCostSumSql());
  return rows[0]?.usd ?? 0;
};

/** YYYY-MM-DD of the given instant in UTC (the tripwire's day key). */
export function currentUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Pure breach decision — strictly OVER the limit trips (== limit does not). */
export function isOverDailyLimit(spentUsd: number, limitUsd: number): boolean {
  return spentUsd > limitUsd;
}

export interface DailyCostTripwire {
  /** true ⟹ Stage-3b LLM drain must halt for the rest of `utcDay`. */
  tripped: boolean;
  /** today's summed `llm_logs.cost_usd` at the last reading. */
  spentUsd: number;
  /** the configured STAGE3_DAILY_COST_LIMIT_USD ceiling. */
  limitUsd: number;
  /** YYYY-MM-DD (UTC) the reading belongs to. */
  utcDay: string;
}

/**
 * Persistent (process-lifetime) tripwire state. Once tripped it LATCHES for the
 * rest of the UTC day — even if some cost rows are later removed — and is surfaced
 * on every tick. It auto-clears when the UTC day rolls over. `null` = never checked.
 */
let state: DailyCostTripwire | null = null;

/**
 * Evaluate the daily cost tripwire. Called before each drain batch: rolls the day
 * over (clears a stale latch), reads today's spend via the injectable seam, and
 * latches `tripped` once spend exceeds the limit. Returns the current state.
 */
export async function checkDailyCostTripwire(
  limitUsd: number,
  costSum: CostSumQuery = defaultCostSum,
  now: Date = new Date(),
): Promise<DailyCostTripwire> {
  const utcDay = currentUtcDay(now);
  // Auto-clear on UTC-day rollover: a new day's running sum starts at 0, so a
  // latch from yesterday must not carry into today.
  if (state && state.utcDay !== utcDay) state = null;

  const spentUsd = await costSum();
  const tripped = (state?.tripped ?? false) || isOverDailyLimit(spentUsd, limitUsd);
  state = { tripped, spentUsd, limitUsd, utcDay };
  return state;
}

/** Last-read tripwire state without touching the DB (for tick-end surfacing). */
export function peekDailyCostTripwire(): DailyCostTripwire | null {
  return state;
}

/** Test-only reset of the persistent latch. */
export function __resetCostTripwireForTest(): void {
  state = null;
}
