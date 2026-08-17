import type { ConstraintGraph } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('graph:independent-bundle-belt');

/**
 * Solver-side runtime twin of the pipeline certifier's independent-bundle
 * refusal (services/pipeline/src/stage4-events/outcome-set-certifier.ts →
 * `refusesNativeIndependentBundle`). Drops a "buy-NO-across" fake one-hot on
 * the live solver before a Stage-4 re-mint would otherwise catch it.
 *
 * The failure mode this guards: a Stage-2/3 grouping stamps
 * `categorical_exclusive` over sibling markets the platform itself marks
 * non-mutually-exclusive (an acquisitions bundle, a token-launch/date bundle,
 * a primary-advance field, a BTC-ATH / Top-N field). Kalshi's on-chain
 * `mutually_exclusive='false'` and `grouping_type='bundle_nonexclusive'` both
 * prove the members settle independently, so ≥2 can co-resolve YES. A
 * persisted Σ≤1 outcome set makes Ω forbid those joint-YES worlds, and "buy
 * NO across the set" then reads as guaranteed profit. finalize's gate refuses
 * the set at mint time, but a DB built before that gate ran still carries it
 * — this belt refutes it at graph load.
 *
 * Predicate (kept in sync with the pipeline gate). A categorical set is
 * refused (dropped → its slot questions become free questions) iff:
 *   (1) ≥2 live slot questions. The pipeline gate requires ≥2 non-residual
 *       slots; the loader already drops residual/expired slots with no live
 *       markets before this belt runs, so a live-slot count ≥2 is the
 *       solver-side proxy. A persisted slot carries no is_residual marker, so
 *       a live residual slot can count toward ≥2 here where the pipeline gate
 *       counts only non-residual — this makes the twin fire in a narrow
 *       superset of cases, but the consequence is always a set-drop → free
 *       questions (Ω-enlarging, recall-loss only, never mints a fake).
 *   (2) Some slot is natively independent (markets.grouping_type=
 *       'bundle_nonexclusive' OR Kalshi mutually_exclusive='false') — the
 *       positive signal, identical to the gate. A set with no such slot is
 *       never refused.
 *   (3) No positive mutex authority anywhere in the set:
 *         · no on-chain negRisk leg (NATIVE_MUTEX: negRisk/isNegRisk/negRiskMarketId),
 *         · no one-hot fixture kind (match_winner / halftime_leader / exact_score /
 *           candle_direction — pinned to the pipeline's ONE_HOT_FIXTURE_KINDS), and
 *         · no slot carries a numeric value (has_value). The pipeline uses the
 *           exact `isSoundNumericTiling` on the ladder projection, which lives
 *           in the pipeline package and cannot be imported here, so the twin
 *           exempts on the strictly broader `has_value` (any numeric-axis
 *           slot) — a superset of the pipeline exemption, so the twin fires
 *           less, never more.
 *
 * Both divergences make the twin strictly more conservative than the gate: it
 * can only fire on fewer sets, so it can never drop a set the gate would
 * keep. The per-slot facts (native_independent / has_negrisk / has_fixture /
 * has_value) are computed by the loader's SQL — the same fragments as
 * finalize's feeds (NATIVE_MUTEX_SQL + the ke `mutually_exclusive` join + the
 * one-hot kind set).
 *
 * Soundness: dropping a set only removes a constraint → enlarges Ω → can only
 * kill a fake arb, never manufacture one. So even a false positive costs at
 * most one real mutex's recall. Idempotent (a re-run finds the set already
 * gone).
 */

/** Per-slot-question native facts, aggregated over the question's member markets. */
export interface IndepBundleFacts {
  /** ANY member: grouping_type='bundle_nonexclusive' OR Kalshi mutually_exclusive='false'. */
  nativeIndependent: boolean;
  /** ANY member carries an on-chain negRisk flag (NATIVE_MUTEX). */
  hasNegrisk: boolean;
  /** ANY member's event_kind ∈ ONE_HOT_FIXTURE_KINDS (curated fixture one-hot). */
  hasFixtureKind: boolean;
  /** ANY member carries a numeric value (value_primary) — the conservative
   *  isSoundNumericTiling proxy (Divergence B). */
  hasValue: boolean;
}

/**
 * Pure predicate — the twin of `refusesNativeIndependentBundle`. True iff this
 * categorical set's live slots trip the independent-bundle signature (see the
 * header). `factsOf` returns undefined for a question with no loaded facts
 * (treated as absent: contributes nothing to the ANY/NO tests, and does not
 * count toward the ≥2).
 */
export function refusesIndependentBundleSet(
  slotQuestionIds: readonly number[],
  factsOf: (qid: number) => IndepBundleFacts | undefined,
): boolean {
  const facts = slotQuestionIds
    .map((qid) => factsOf(qid))
    .filter((f): f is IndepBundleFacts => f != null);
  if (facts.length < 2) return false;                          // (1)
  if (!facts.some((f) => f.nativeIndependent)) return false;   // (2)
  if (facts.some((f) => f.hasNegrisk)) return false;           // (3a)
  if (facts.some((f) => f.hasFixtureKind)) return false;       // (3b)
  if (facts.some((f) => f.hasValue)) return false;             // (3c)
  return true;
}

export interface IndepBundleBeltResult {
  /** Categorical sets refuted by the independent-bundle tell. */
  hits: number;
  /** Categorical sets converted to free questions (== hits). */
  setsFreed: number;
  /** setIds of the categorical sets freed this run. */
  freedSetIds: number[];
}

/**
 * Apply the belt to `graph` in place. For each categorical outcome set, if its
 * live slots trip {@link refusesIndependentBundleSet}, drop the set (its slot
 * questions survive as free questions). Idempotent, strictly Ω-enlarging.
 * `factsOf` is built by the loader from a single per-slot-question SQL aggregate.
 */
export function applyIndependentBundleBelt(
  graph: ConstraintGraph,
  factsOf: (qid: number) => IndepBundleFacts | undefined,
): IndepBundleBeltResult {
  const setIdsToFree = new Set<number>();
  for (const os of graph.outcomeSets) {
    if (os.setType !== 'categorical') continue;
    if (refusesIndependentBundleSet(os.slotQuestionIds, factsOf)) {
      setIdsToFree.add(os.setId);
      log.info(
        `F7 independent-bundle belt: categorical set ${os.setId} "${os.setName}" — a slot is ` +
          `natively non-mutually-exclusive (bundle_nonexclusive / mutually_exclusive='false') with ` +
          `no mutex authority (no negRisk / fixture-kind / numeric tiling) over its ` +
          `${os.slotQuestionIds.length} slot(s) — freeing to free questions (removes a fake ` +
          `mutex, which can only enlarge Ω).`,
      );
    }
  }
  if (setIdsToFree.size > 0) {
    const before = graph.outcomeSets.length;
    graph.outcomeSets = graph.outcomeSets.filter((os) => !setIdsToFree.has(os.setId));
    const setsFreed = before - graph.outcomeSets.length;
    log.warn(
      `independent-bundle belt: freed ${setsFreed} categorical set(s) over natively-independent ` +
        `bundle members (buy-NO-across shape).`,
    );
    return { hits: setIdsToFree.size, setsFreed, freedSetIds: [...setIdsToFree] };
  }
  return { hits: 0, setsFreed: 0, freedSetIds: [] };
}

/** Expose the pure predicate for tests/harness. */
export const _internals = { refusesIndependentBundleSet };
