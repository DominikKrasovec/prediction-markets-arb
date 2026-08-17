/**
 * Registry entry — `candle_window`. Guard-only: feeds the Stage-3 leg-coherence
 * belt + telemetry only; it is not a fold key and touches no Stage-4 fold
 * conjunct, set key, or certifier demote (those consume `foldKeySpecs()` only).
 *
 * What it discriminates: crypto "Up or Down" candle markets are identified by
 * (asset, open, duration). The asset rides `canonical_event` (bare, no
 * duration) and the open rides `condition_date` at minute precision; the
 * duration (5-min/15-min/hourly/daily/weekly) is carried only in the title and
 * has no gated column. A `canonical_event`-blind fold would collide
 * different-window candles of one asset. Today those never fuse because the
 * deterministic candle matcher (`stage3-events/match-candles.ts`) keys on
 * asset+open+duration and the date gate holds. This entry lifts the duration to
 * a stamped discriminator so the generic Stage-3 belt refuses a cross-window
 * fusion even when a new builder forgets the candle key.
 *
 * Extract: reuses the same `parseCandleWindow` parser the Stage-3b matcher uses
 * (one source, cannot drift). The value is the candle length in minutes. A
 * non-crypto "Up or Down" title fails the asset gate and returns null. The
 * ambiguous single-hour form (no explicit range) also returns null (never
 * manufacture a false window; matches the matcher, which defers the ambiguous
 * case to the LLM). The `windowMin` gate (end_date − condition_date) that would
 * resolve the ambiguity is not threaded to the Stage-1 stamp door, so the stamp
 * uses the title alone.
 *
 * Null-policy: 'tolerant'. Different windows are genuinely independent
 * questions, but a NULL (unrecognized/ambiguous) window must never drop a leg.
 * Only both-known-and-differ conflicts fire.
 *
 * candle_window is a legitimate identity axis, so it could in principle become
 * a fold-key/set-key that partitions candle fusions. Promotion is blocked on
 * threading the `windowMin` gate to the stamp door (so ambiguous single-hour
 * rows resolve to a real duration instead of NULL) and on setSplit doctrine,
 * which forbids a blind all-fold-keys set key. Guard-only stays until both land.
 */
import type { EventKind } from '@arb/types';
import { parseCandleWindow } from '../../stage3-events/candle-window.js';
import type { DiscriminatorSpec } from '../registry.js';

/** The only kind that carries a candle window. */
const CANDLE_WINDOW_KINDS: readonly EventKind[] = ['candle_direction'];

/** The candle length in minutes as a string, or null when the title is not a
 *  recognized crypto candle OR the window is ambiguous (soundness direction). */
export function extractCandleWindow(title: string | null | undefined): string | null {
  if (!title) return null;
  const w = parseCandleWindow(title);
  if (!w || w.ambiguous) return null;
  return String(w.durationMin);
}

export const candleWindowSpec: DiscriminatorSpec = {
  name: 'candle_window',
  kinds: CANDLE_WINDOW_KINDS,
  source: 'title-regex',
  extract: (ctx) => extractCandleWindow(ctx.title),
  // JSONB-only: there is no typed duration column (it rides date+tolerance
  // config). Never dual-writes.
  assertion: 'guard-only',
  nullPolicy: 'tolerant',
};
