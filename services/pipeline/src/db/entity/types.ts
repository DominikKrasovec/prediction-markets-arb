/** Shared types for the entity KB modules — a leaf module so any entity-* module can import types without creating cycles. */

export interface KBLookupResult {
  id: number;
  canonical: string;
}

/** In-process cache row shape (mirrors the indexed columns of known_entities). */
export interface KBRow {
  id: number;
  canonical: string;
  domain_category: string;
  type: string;
  aliases: string[];
  /** Hoisted from metadata; disambiguates same-name subjects across sports/leagues. */
  sport_canonical: string | null;
  league_canonical: string | null;
  /** From metadata.tour_gender; null for open/mixed/absent bodies and every team-sport club. */
  tour_gender?: string | null;
}

/** A row is compatible with `scope` iff each set field matches or is scope-agnostic (null); wrong-scope rows are filtered out, not down-ranked. */
export interface KBScope {
  sport?: string | null;
  league?: string | null;
}

/** sport_canonical/league_canonical are GENERATED columns from metadata->>..., so this metadata patch is the only way to set them at INSERT time. */
export function scopeToEntityMetadata(
  scope: KBScope | null | undefined,
  entityType: string,
): Record<string, string> {
  if (!scope) return {};
  if (entityType !== 'team' && entityType !== 'person' && entityType !== 'unknown') return {};
  const patch: Record<string, string> = {};
  if (scope.sport && typeof scope.sport === 'string') {
    patch.sport_canonical = scope.sport;
  }
  // Never stamp league_canonical on person/unknown: individual-sport players cross many
  // tours, and the (canonical, sport_canonical, league_canonical) unique constraint would
  // otherwise split one player into per-tour KB rows.
  if (entityType === 'team' && scope.league && typeof scope.league === 'string') {
    patch.league_canonical = scope.league;
  }
  return patch;
}

export interface ResolveOptions {
  /** UNION-merged into the existing row via ON CONFLICT on a race-conflict. */
  aliases?: string[];
  lowercaseCanonical?: boolean;
  initialEnrichmentStatus?: 'pending' | 'enriched';
  forceSportsDomain?: boolean;
}

/** market_id → (entity_id → type-weight). Drives on-demand weighted Jaccard. */
export type EntityWeightMap = Map<number, Map<number, number>>;

/** market_id → sum of type-weights across the market's KB links. */
export type MarketTotalMap = Map<number, number>;

export interface EntityKB {
  entityWeights: EntityWeightMap;
  marketTotals: MarketTotalMap;
}
