/**
 * The generic registry-driven Stage-3 leg-coherence pass.
 *
 * Per-fused-outcome, subtractive-only: within one fused outcome, drop a leg
 * whose discriminator value provably differs from an already-accepted leg.
 * Registry-driven, so a new discriminator activates the belt with zero
 * guards.ts edits — the "one spec file, zero new guards" contract.
 *
 * This is a belt: with correct Stage-1 stamping + Stage-4 fold keys it should
 * approach 0 drops for any given spec whose conflicts are already removed
 * upstream by another active belt.
 */
import { coherenceSpecs, type DiscriminatorSpec } from './registry.js';

/** Minimal leg shape (guards.ts passes LegMappingItem — market_id + outcome_id). */
export interface CoherenceLeg {
  market_id: number;
  outcome_id: string;
}

export interface CoherenceDrop {
  market_id: number;
  outcome_id: string;
  spec: string;
  detail: string;
}

export interface CoherenceResult {
  /** market_ids to drop (subtractive). */
  drop: Set<number>;
  /** per-drop rationale (for warnings). */
  drops: CoherenceDrop[];
  /** per-spec drop count (belt telemetry). */
  perSpec: Record<string, number>;
}

/** Value accessor: the leg's value for a spec, or null if unknown. */
export type LegValue = (spec: DiscriminatorSpec, marketId: number) => string | null;

/**
 * Compute the leg-coherence drops for a fused outcome set. `legs` is the current
 * leg mapping; `getValue` resolves each leg's per-spec discriminator value.
 *
 * Per spec (fold-key OR guard-only), per outcome_id (ordered by market_id, the
 * anchor lowest-id leg is always kept so no outcome can go phantom):
 *   · both-known-and-differ vs any accepted leg → drop the later leg.
 *   · nullPolicy 'block-when-sibling-known': a NULL-valued leg is ALSO dropped
 *     when ≥1 accepted leg is known.
 * Pure — the caller applies the drop + the platform-gut rejection + telemetry.
 */
export function discriminatorCoherenceDrops(
  legs: readonly CoherenceLeg[],
  getValue: LegValue,
): CoherenceResult {
  const drop = new Set<number>();
  const drops: CoherenceDrop[] = [];
  const perSpec: Record<string, number> = {};

  const byOutcome = new Map<string, CoherenceLeg[]>();
  for (const l of legs) {
    let g = byOutcome.get(l.outcome_id);
    if (!g) { g = []; byOutcome.set(l.outcome_id, g); }
    g.push(l);
  }

  for (const spec of coherenceSpecs()) {
    const blockNull = spec.nullPolicy === 'block-when-sibling-known';
    for (const [oid, group] of byOutcome) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((x, y) => x.market_id - y.market_id);
      const accepted: { mid: number; v: string | null }[] = [];
      for (const l of ordered) {
        if (drop.has(l.market_id)) continue; // already dropped by another spec
        const v = getValue(spec, l.market_id);
        // Conflict vs an accepted leg?
        let conflict: string | null = null;
        for (const acc of accepted) {
          if (v != null && acc.v != null && v !== acc.v) {
            conflict = `${spec.name} '${v}' vs '${acc.v}'`;
            break;
          }
          if (blockNull && v == null && acc.v != null) {
            // block-when-sibling-known: a NULL leg entering a fold where an
            // accepted sibling is known is dropped.
            // Only the LATER leg is dropped — the anchor (first accepted) is
            // always kept, so a known leg never displaces it.
            conflict = `${spec.name} NULL leg entering a fold where sibling is '${acc.v}'`;
            break;
          }
        }
        if (accepted.length === 0) {
          accepted.push({ mid: l.market_id, v });
          continue;
        }
        if (conflict) {
          drop.add(l.market_id);
          drops.push({ market_id: l.market_id, outcome_id: oid, spec: spec.name, detail: conflict });
          perSpec[spec.name] = (perSpec[spec.name] ?? 0) + 1;
        } else {
          accepted.push({ mid: l.market_id, v });
        }
      }
    }
  }

  return { drop, drops, perSpec };
}
