/**
 * Registry entry — `bound_strictness`. Guard-only at the registry layer
 * (Stage-3 leg-coherence belt + telemetry; excluded from `foldKeySpecs()` so
 * the Stage-4 fold-SQL / set keys / certifier stay byte-identical). Its
 * load-bearing consumer is the cross-venue rate-decision bridge
 * (`stage4-events/rate-decision-bridge.ts`), which reads the per-market stamp
 * instead of a per-emitter strictness constant: strictness can never be a
 * plain fold-key, since the `>N ⇔ ≥N+tick` renormalization is arithmetic the
 * fold grammar cannot express — so the registry carries only this stamp + the
 * per-market extraction; interval math stays in `halfline-compare.ts` with
 * its per-instrument tick allow-list.
 *
 * What it discriminates: whether a threshold / cumulative bound is strict
 * ('>N', open, Δ>N) or closed ('N+' / '≥N', Δ≥N). For the Fed rate-decision
 * emitters this is the fact that makes naive gated-field alignment unsound: a
 * Kalshi cumulative rung is '>N bps' (strict) while the PM / Predict-AG /
 * Limitless rungs are 'N+ bps' (closed). On the 25 bp lattice `>N ⇔ ≥N+25`,
 * so a strict '>25' rung and a closed '25+' rung are different intervals —
 * equating them manufactures a fake equivalence. Lifting strictness to a
 * per-market stamp lets the bridge renormalize each leg's interval from the
 * market's own bound form, not a hard-coded emitter assumption.
 *
 * Extract (deterministic, native-metadata + title; total, never throws):
 *   1. Kalshi native `strike_type` (forward defense — the sanctioned strict/closed
 *      signal): `greater`|`less` ⇒ 'strict'; `greater_or_equal`|`less_or_equal` ⇒
 *      'closed'. The live Fed rungs carry `strike_type='custom'` (the magnitude
 *      rides `custom_strike`/title), so this arm does not fire on today's data
 *      — it arms for any future market that uses a proper inequality strike type.
 *   2. Title cumulative form (the live authority for the rate rungs): a '>' (or
 *      'greater than' / 'more than') before the magnitude ⇒ 'strict'; an 'N+'
 *      (or 'at least N' / 'or more') ⇒ 'closed'.
 * An exact rung ('Cut rates by 25bps', 'No change') has no directional bound — it
 * is an `at` point on the lattice where strictness is irrelevant — so it returns
 * null (absent key). Conflict (both forms present) or unrecognized ⇒ null. NULL is
 * an honest refusal: the bridge builds an `at` point regardless, but refuses a
 * cumulative (above/below) rung whose strictness it cannot read (soundness
 * direction — a mis-normalized half-line is a fake edge).
 *
 * Null-policy: 'tolerant'. A NULL bound-form must never drop a leg at a Stage-4
 * fold (an exact rung is a real, foldable market); only both-known-and-differ
 * fires the coherence belt. The bridge applies the stronger per-rung refusal
 * itself (cumulative rung + null strictness → refused), which is builder logic,
 * not a fold conjunct.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** The kind that carries a signed cumulative rate bound the bridge understands.
 *  Scoped tight: the title patterns below are rate-rung-shaped, so a broader
 *  kind set risks misfires on other thresholds. */
const BOUND_STRICTNESS_KINDS: readonly EventKind[] = ['policy_action'];

export type BoundStrictness = 'strict' | 'closed';

/** '>' / 'greater than' / 'more than' immediately before a magnitude ⇒ strict. */
const STRICT_TITLE_RX = /(?:>|greater than|more than)\s*\d/i;
/** 'N+' (open-ended) / 'at least N' / 'or more' ⇒ closed (Δ ≥ N). The bps anchor
 *  keeps 'N+' rate-specific (a bare 'N+' elsewhere is not a bound form here). */
const CLOSED_TITLE_RX = /\d\+\s*bps|\bat least\s+\d|\bor more\b/i;

/**
 * The per-market bound strictness from its native strike_type + title, or null
 * when the bound has no strictness (exact rung), is ambiguous, or is
 * unrecognized. Pure + total. Both the Stage-1 stamp (via {@link extractBoundStrictness})
 * and the rate-decision bridge consume THIS one function — single source, cannot drift.
 */
export function boundStrictnessFromSignals(
  title: string | null | undefined,
  strikeType: string | null | undefined,
): BoundStrictness | null {
  // 1. Native strike_type arm (forward defense; inert on today's 'custom' rungs).
  const st = strikeType?.trim().toLowerCase();
  if (st === 'greater' || st === 'less') return 'strict';
  if (st === 'greater_or_equal' || st === 'less_or_equal') return 'closed';

  // 2. Title cumulative-form arm (the live authority for the rate rungs).
  const t = title ?? '';
  const hasStrict = STRICT_TITLE_RX.test(t);
  const hasClosed = CLOSED_TITLE_RX.test(t);
  if (hasStrict && hasClosed) return null; // conflicting forms → refuse
  if (hasStrict) return 'strict';
  if (hasClosed) return 'closed';
  return null; // exact rung / unrecognized → strictness N/A
}

/** Spec-shaped extractor: reads ctx.title + ctx.raw.strike_type. */
export function extractBoundStrictness(ctx: ExtractCtx): string | null {
  const strikeType = ctx.raw != null ? (ctx.raw['strike_type'] as string | null | undefined) : null;
  return boundStrictnessFromSignals(ctx.title, strikeType);
}

export const boundStrictnessSpec: DiscriminatorSpec = {
  name: 'bound_strictness',
  kinds: BOUND_STRICTNESS_KINDS,
  source: 'native-metadata',
  extract: extractBoundStrictness,
  // JSONB-only — there is no typed strictness column; the bound form rides
  // strike_type / title / custom_strike upstream. Never dual-writes.
  assertion: 'guard-only',
  nullPolicy: 'tolerant',
};
