/**
 * Entity Knowledge Base — persistent cross-market entity graph.
 *
 * Every entity the LLM discovers is registered here with canonical name,
 * type, and aliases. When the same entity appears on a different market
 * (possibly under a different alias), it resolves to the same known_entity
 * row — so "BTC" on Polymarket and "Bitcoin" on Kalshi share one ID.
 *
 * Scoring uses entity IDs: two markets sharing entity IDs are related.
 * This is O(1) set intersection per pair instead of string comparison.
 *
 * Resolver hierarchy. Tiers are tried in order: T1 = exact alias/canonical
 * lookup, T2 = embedding cosine match against existing canonicals, T3 = create
 * a new entity row.
 *
 *   EntityResolver (abstract, Tier-1 alias/canonical lookup)
 *     ├── SubjectEntityResolver   — T1 → T2 embedding → T3 create
 *     └── StructuralEntityResolver — T1 → T3 create (no embedding tier)
 *           leagueResolver   (league, competition)
 *           providerResolver (data_provider)
 *           sportResolver    (sport)
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  This file is a BARREL — the implementation lives under `./entity/*.ts`.
 *  Modules:
 *    types.ts     — shared interfaces (KBLookupResult, KBRow, EntityKB, ...)
 *    cache.ts     — in-process KB cache + warm/invalidate/rehydrate
 *    tokens.ts    — foldAscii + tokenisation helpers
 *    taxonomy.ts  — resolveTaxonomyCanonical + getTaxonomyContext
 *    resolvers.ts — Subject/Structural resolvers + resolveSubjectViaKB
 *    register.ts  — registerEntities + findOrCreateEntity + merge helpers
 *    histogram.ts — entity_category_counts gate
 *    backfill.ts  — Stage-1f canonical_subject backfill
 *    load.ts      — loadEntityKB + pair overlap precompute
 *
 *  Public consumers should import from this barrel (not from `./entity/*.ts`
 *  directly) — keeps the public surface in one place and lets the modules
 *  use underscore-prefixed exports to share private state with each other
 *  without leaking it to the rest of the codebase.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type { KBLookupResult, EntityKB, KBScope } from './entity/types.js';
export { scopeToEntityMetadata } from './entity/types.js';

export {
  consumeNewEntityCount,
  invalidateKBCache,
  rehydrateKBCacheRow,
  purgeSubjectCacheByCanonicals,
  warmKBCache,
  registerKBCacheInvalidator,
  kbFactsHandle,
} from './entity/cache.js';

export { foldAscii, spaceInvariantVariant, aliasVariantsToAdd } from './entity/tokens.js';

export { areLeaguesCompatible, compatibleLeagueCanonicals } from './entity/league-hierarchy.js';

export { resolveTaxonomyCanonical, getTaxonomyContext, normalizeSportCanonical } from './entity/taxonomy.js';

export {
  leagueResolver,
  providerResolver,
  sportResolver,
  resolveSubjectViaKB,
  resolveSubjectAndParticipants,
} from './entity/resolvers.js';

export { registerEntities } from './entity/register.js';

export {
  invalidateEntityCategoryCache,
  getEntityCategoryMass,
  incrementEntityCategoryCount,
  incrementEntityCategoryCountsBatch,
  mergeEntityCategoryCountsTx,
  evaluateHistogramGate,
} from './entity/histogram.js';

export { backfillSubjectsViaKB } from './entity/backfill.js';

export {
  loadStructuralSignalsIndex,
  getStructuralSignalsIndex,
  type StructuralSignalsIndex,
  type PlatformSignals,
} from './entity/structural-signals.js';

export { overlapKey, loadEntityKB } from './entity/load.js';
