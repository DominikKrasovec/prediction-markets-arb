/**
 * lifecycle-bench — market-type classification.
 *
 * Two axes per discovery:
 *   - UNIFIED category (primary): the SAME 10-label cross-platform taxonomy the
 *     pipeline stamps onto markets.category_unified — via the shared
 *     `classifyCategoryLabels` in @arb/types (the single source of truth; do not
 *     fork). This is what makes the by-type breakdown comparable across
 *     platforms. We feed it the same kind of labels the pipeline does
 *     ([category, ...tags, title]); for Kalshi/Polymarket the WSS frame carries
 *     no category (the pipeline enriches that later from the event tables), so
 *     classification is title/slug-driven here — matching how the pipeline's
 *     initial pass classifies before event-enrichment.
 *   - NATIVE label (secondary): the platform's own granular bucket (Kalshi
 *     event-ticker series prefix e.g. KXBTC15M, Predict marketVariant, Limitless
 *     venue type, PM category/negRisk) — kept for drill-down since it's finer
 *     than the 10 unified buckets.
 */

import { type UnifiedCategory } from '@arb/types';
import { classifyCategoryLabels } from './unified-category.js';
import type { BenchPlatform } from './metrics.js';

export interface TypeLabel {
  type: string;
  field: string | null;
}

const UNKNOWN: TypeLabel = { type: 'unknown', field: null };

/** Unified cross-platform category (markets.category_unified vocabulary). */
export function unifiedCategory(platform: BenchPlatform, payload: unknown): UnifiedCategory {
  if (!payload || typeof payload !== 'object') return 'other';
  return classifyCategoryLabels(gatherLabels(platform, payload as Record<string, unknown>));
}

/** Granular platform-native bucket (kept alongside the unified one for detail). */
export function nativeType(platform: BenchPlatform, payload: unknown): TypeLabel {
  if (!payload || typeof payload !== 'object') return UNKNOWN;
  const o = payload as Record<string, unknown>;
  switch (platform) {
    case 'kalshi': return classifyKalshiNative(o);
    case 'polymarket': return classifyPolymarketNative(o);
    case 'limitless': return classifyLimitlessNative(o);
    case 'predict': return classifyPredictNative(o);
    default: return firstString(o, ['category', 'categoryTitle', 'marketType', 'type']) ?? UNKNOWN;
  }
}

// ─── label gathering for the unified classifier ────────────────────────────────
// Mirrors the pipeline recipe (category + tags + title) plus extra title-like
// fields each WSS frame actually carries (verified via raw-samples.jsonl).

function gatherLabels(platform: BenchPlatform, o: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { for (const s of toStrings(v)) out.push(s); };
  switch (platform) {
    case 'kalshi': {
      // Kalshi WSS 'created' frames nest the descriptive fields under
      // additional_metadata (top level carries only market_ticker / open_ts /
      // close_ts / event_type / price_level_structure). Descend so titles feed
      // the classifier — WITHOUT this only market_ticker is seen and every
      // Kalshi market reads 'other' (verified: bare ticker has no keyword match).
      const am = (o.additional_metadata && typeof o.additional_metadata === 'object')
        ? (o.additional_metadata as Record<string, unknown>) : {};
      add(o.category); add(am.category);
      add(o.series_ticker); add(am.series_ticker);
      add(o.title); add(am.title); add(am.name);
      add(o.subtitle); add(am.subtitle);
      add(o.yes_sub_title); add(am.yes_sub_title);
      add(o.event_ticker); add(am.event_ticker); add(o.market_ticker);
      break;
    }
    case 'polymarket':
      add(o.category); add(o.tags); add(o.question); add(o.title);
      add(o.slug); add(o.groupItemTitle);
      break;
    case 'limitless':
      // slug is the ONLY descriptive field on the sparse 'resolved' frame
      // (slug/winningOutcome/resolutionDate) — without it, limitless resolutions
      // misbucket to 'other' (e.g. xrp-up-or-down-5-min → crypto). It's also a
      // good kebab-case signal on created frames.
      add(o.categories); add(o.tags); add(o.title); add(o.marketType); add(o.slug);
      break;
    case 'predict':
      add(o.categoryTitle); add(o.categorySlug); add(o.categoryTags);
      add(o.title); add(o.question); add(o.marketVariant);
      break;
  }
  return out;
}

// ─── native classifiers ────────────────────────────────────────────────────────

function classifyKalshiNative(o: Record<string, unknown>): TypeLabel {
  const am = (o.additional_metadata && typeof o.additional_metadata === 'object')
    ? (o.additional_metadata as Record<string, unknown>) : {};
  // event_ticker lives in additional_metadata on WSS frames; market_ticker
  // (top level) shares the same series prefix and is the reliable fallback.
  const et = str(o.event_ticker) ?? str(am.event_ticker) ?? str(o.market_ticker);
  if (et) {
    const prefix = et.split('-')[0];
    if (prefix) return { type: prefix, field: 'event_ticker:prefix' };
  }
  return firstString(o, ['category', 'series_ticker']) ?? UNKNOWN;
}

function classifyPolymarketNative(o: Record<string, unknown>): TypeLabel {
  const cat = firstString(o, ['category']);
  if (cat) return cat;
  const tag = firstTag(o.tags);
  if (tag) return { type: tag, field: 'tags[0]' };
  if (typeof o.negRisk === 'boolean') return { type: o.negRisk ? 'multi-outcome(negRisk)' : 'binary', field: 'negRisk' };
  return UNKNOWN;
}

function classifyLimitlessNative(o: Record<string, unknown>): TypeLabel {
  const cat = firstCsvOrArray(o.categories);
  if (cat) return { type: cat, field: 'categories' };
  return firstString(o, ['tradeType', 'type', 'marketType']) ?? UNKNOWN;
}

function classifyPredictNative(o: Record<string, unknown>): TypeLabel {
  return firstString(o, ['marketVariant', 'marketType', 'categoryTitle', 'categorySlug']) ?? UNKNOWN;
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function firstString(o: Record<string, unknown>, fields: string[]): TypeLabel | null {
  for (const f of fields) {
    const s = str(o[f]);
    if (s) return { type: s, field: f };
  }
  return null;
}

function firstCsvOrArray(v: unknown): string | null {
  if (typeof v === 'string') return str(v.split(',')[0]);
  if (Array.isArray(v) && v.length) return str(v[0]);
  return null;
}

function firstTag(v: unknown): string | null {
  if (Array.isArray(v) && v.length) {
    const first = v[0];
    if (typeof first === 'string') return str(first);
    if (first && typeof first === 'object') return str((first as any).label ?? (first as any).slug ?? (first as any).name);
  }
  return null;
}

/** Flatten a value (string / csv string / array of strings or {label|name|slug}) → strings. */
function toStrings(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === 'string') return v.includes(',') ? v.split(',').map((s) => s.trim()).filter(Boolean) : (str(v) ? [v.trim()] : []);
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === 'string') { const s = str(item); if (s) out.push(s); }
      else if (item && typeof item === 'object') {
        const s = str((item as any).label ?? (item as any).name ?? (item as any).slug);
        if (s) out.push(s);
      }
    }
    return out;
  }
  return [];
}
