/**
 * Consumer 1 — the Stage-1 discriminator stamping writer.
 *
 * ONE hook, called once per emitted row at the emission door (the shared
 * candidate → hit path in text-deterministic.ts, which BOTH the daemon worker
 * and the batch scan funnel through — kalshi-deterministic hits included). This
 * is the ONLY place raw payloads feed `source:'native-metadata'` extractors.
 *
 * Dual-write contract — the two-writes-one-truth rule that makes the
 * JSONB and the typed column impossible to disagree:
 *   1. `v = spec.extract(ctx)`.
 *   2. gatedField spec: dual-write the typed column ONLY if the handler left it
 *      NULL (handler-stamped wins), then mirror the FINAL typed value into the
 *      JSONB (so `discriminators->>'name'` === the typed column, always).
 *   3. non-gated spec: write the extract result into the JSONB directly.
 *   4. absent key = NULL = unknown; never store ''.
 * Extract functions are pure + total (never throw) — a thrown extractor must
 * never corrupt an emission, so each call is defensively guarded.
 */
import type { LLMMarketNormalization } from '@arb/types';
import { specsForKind, type ExtractCtx, type WarmKbCache } from './registry.js';
import { discCount } from './telemetry.js';

/** The subset of the candidate row the stamp reads (title/platform/raw/kb). Kept
 *  structural so this module never imports text-deterministic.ts (no cycle). */
export interface StampRowCtx {
  title: string;
  platform: string;
  /** market_metadata_raw payload if the door threads it; else null (the
   *  emission door threads the FULL mr.raw payload). */
  raw?: Record<string, unknown> | null;
  /** Warm-cache-only KB facts handle (`kbFactsHandle()`); cold cache ⇒
   *  every lookup null. Absent ⇒ `ExtractCtx.kb` is null. */
  kb?: WarmKbCache | null;
}

/** Build the pure {@link ExtractCtx} for a row + its in-flight normalization. */
export function buildExtractCtx(row: StampRowCtx, norm: LLMMarketNormalization): ExtractCtx {
  return {
    title: row.title,
    outcomeLabel: norm.outcome_label ?? null,
    eventKind: norm.event_kind ?? null,
    matchSource: norm.match_source ?? null,
    platform: row.platform,
    raw: row.raw ?? null,
    // The lmn row itself is the gated-field surface (condition_direction,
    // value_primary, metric_scope, outcome_label, resolution_scope, league_id).
    gated: norm as unknown as Record<string, unknown>,
    kb: row.kb ?? null,
  };
}

/**
 * Stamp `norm.discriminators` (and dual-write gated columns) for one emitted
 * row. Mutates `norm` in place; safe to call on every hit. See the dual-write
 * contract above.
 */
export function stampDiscriminators(row: StampRowCtx, norm: LLMMarketNormalization): void {
  const ctx = buildExtractCtx(row, norm);
  const disc: Record<string, string> = norm.discriminators ?? (norm.discriminators = {});
  const mutable = norm as unknown as Record<string, unknown>;

  for (const spec of specsForKind(norm.event_kind ?? null)) {
    let v: string | null = null;
    try {
      v = spec.extract(ctx);
    } catch {
      // Extract functions must be total; a throw is treated as "unknown".
      v = null;
    }

    if (spec.gatedField) {
      // Dual-write the typed column only if the handler left it NULL.
      if (v != null && mutable[spec.gatedField] == null) mutable[spec.gatedField] = v;
      // Mirror the FINAL typed value into the JSONB (never disagree).
      const finalV = mutable[spec.gatedField];
      if (finalV != null) disc[spec.name] = String(finalV).toLowerCase();
      discCount(spec.name, finalV != null);
    } else {
      if (v != null) disc[spec.name] = v.toLowerCase();
      discCount(spec.name, v != null);
    }
  }
}
