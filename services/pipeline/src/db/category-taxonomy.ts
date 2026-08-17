/**
 * Unified category taxonomy.
 *
 * Platform APIs expose category labels that don't agree:
 *   - kalshi:     Sports, Crypto, Elections, Entertainment, Economics, ...
 *   - polymarket: (first tag label) Sports, Bitcoin, Up or Down, Esports, ...
 *   - limitless:  Props, Football Matches, Sports, Off the Pitch, Economy, ...
 *   - predict:    market-slug (e.g. "2026-nba-champion") — not a category at all
 *
 * Raw values remain on `markets.category` for provenance, but Stage 2 and
 * Stage 3 filtering must operate on a unified vocabulary: `markets.category_unified`.
 * All 10 labels below are coarse enough that cross-platform pairs are only
 * allowed when both sides map to the same unified label.
 *
 * Mapping rules (applied in order, first match wins):
 *   - exact-label hits from kalshi's controlled vocabulary drive the taxonomy.
 *   - polymarket fine labels (Bitcoin, Ethereum, NBA, NFL) collapse to their
 *     parent category via keyword map.
 *   - limitless "Football Matches", "Off the Pitch" collapse to sports.
 *   - predict — tags-driven via `predict_categories.tags[].name`.
 */

import { type UnifiedCategory, UNIFIED_CATEGORIES, type DataProviderMetadata, type ResolutionKind, type DomainCategory, classifyCategoryLabels } from '@arb/types';

export type { UnifiedCategory };
export { UNIFIED_CATEGORIES };
// The KEYWORDS regex map + classifyCategoryLabels live in @arb/types (the
// ingestion bench vendors an identical fork). Re-exported here so the
// pipeline's many importers stay unchanged.
export { classifyCategoryLabels };

// Semantic subset predicates
//
// Use these instead of inline string comparisons like
//   row.category_unified === 'election' || row.category_unified === 'politics'
//
// Renaming a UnifiedCategory value then touches the const array and the
// subset definition below — call sites stay clean.

/** Politics-flavored: election outcomes, policy/legislation, geopolitics. */
export const POLITICAL_CATEGORIES: ReadonlySet<UnifiedCategory> =
  new Set(['election', 'politics', 'geopolitical']);

/** Asset/price-flavored: crypto and broader economic/finance markets. */
export const FINANCIAL_CATEGORIES: ReadonlySet<UnifiedCategory> =
  new Set(['crypto', 'economic']);

export const isPoliticalCategory = (c: UnifiedCategory | null): boolean =>
  c !== null && POLITICAL_CATEGORIES.has(c);

export const isFinancialCategory = (c: UnifiedCategory | null): boolean =>
  c !== null && FINANCIAL_CATEGORIES.has(c);


// Domain-category helpers
//
// These functions map between the various category/domain representations used
// across the pipeline:
//   - `category_unified`  (10-label cross-platform taxonomy on markets)
//   - entity KB `domain_category`  (coarser isolation axis)
//   - data_provider entity `domain` (DataProviderMetadata.domain)
//   - `ResolutionKind`  (stored on llm_market_normalizations)
//
// They are exported from this shared module so all normalization paths
// (text-deterministic.ts, kalshi-deterministic.ts, backfills, diagnostic
// scripts) use the same mappings without duplicating the logic.

/**
 * Map UnifiedCategory → entity KB domain_category. Coarser than
 * category_unified by design — entity KB domains are cross-platform
 * isolation axes, not fine taxonomy. Prevents cross-domain entity
 * merging (e.g., "BULL" as a crypto token vs. a sports team).
 *
 * Return type pins the result to `DomainCategory` — a union of the seven
 * values in the `known_entities.domain_category` CHECK constraint.
 * Compile-time enforcement: future contributors cannot add a switch arm that
 * returns 'legal' or 'economic' without TS errors.
 */
export function unifiedToDomain(cat: string | null | undefined): DomainCategory {
  switch (cat) {
    case 'sports':        return 'sports';
    case 'crypto':        return 'crypto';
    case 'election':
    case 'politics':
    case 'geopolitical':  return 'politics';
    case 'economic':
    case 'technology':    return 'finance';
    case 'entertainment': return 'entertainment';
    case 'weather':       return 'weather';
    default:              return 'other';
  }
}

/**
 * Map a data_provider entity's `domain` field to the coarse provider domain
 * passed as extra-meta when auto-creating T3 (novel) provider rows.
 * Seeded providers always have an accurate domain set explicitly.
 */
export function domainCategoryToProviderDomain(domainCategory: DomainCategory): DataProviderMetadata['domain'] {
  switch (domainCategory) {
    case 'crypto':      return 'candle_aggregator';
    case 'sports':      return 'league_official';
    case 'politics':    return 'election_authority';
    // 'finance' spans both stocks/commodities (candle sources) and
    // election/economic indicators.
    case 'finance':     return 'candle_aggregator';
    // Weather markets (Kalshi KXTEMP family etc.) resolve from public weather
    // services — fits the 'media' bucket better than the candle/league/election
    // ones until there is a dedicated weather_service provider domain.
    case 'weather':     return 'media';
    case 'entertainment':
    case 'other':
    default:            return 'media';
  }
}

/**
 * Derive `ResolutionKind` from a data_provider entity's `domain` field.
 * Stored on `llm_market_normalizations.resolution_kind`.
 */
export function domainToResolutionKind(domain: DataProviderMetadata['domain']): ResolutionKind {
  switch (domain) {
    case 'exchange':          return 'exchange_oracle';
    case 'oracle':            return 'exchange_oracle';
    case 'candle_aggregator': return 'candle_data';
    case 'esports_stats':     return 'esports_stats';
    case 'league_official':   return 'league_official';
    case 'media':             return 'media_consensus';
    case 'election_authority':return 'election_authority';
    case 'court':             return 'court_ruling';
    default:                  return 'other';
  }
}
