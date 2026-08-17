/**
 * Registers resolved entities into the KB: finds or creates each
 * known_entity, links it to the market, and bumps its category histogram.
 */

import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { ResolvedEntity, DomainCategory } from '@arb/types';
import { FUZZY_MATCHABLE_ENTITY_TYPES, LEAGUE_SCOPED_ENTITY_TYPES } from '@arb/types';
import { enqueueEntityEnrichment } from '../queries/entity-enrichment-queue.js';
import { _kbCacheInsert, registerKBCacheInvalidator, _kbRowsByLowerCanonical, _kbCacheLoaded } from './cache.js';
import type { KBRow } from './types.js';
import { extractSignificantTokens, getGenerationalSuffix, aliasVariantsToAdd, foldAscii } from './tokens.js';
import { isBareAliasFor, isCodeLikeAlias, BARE_ALIAS_SCOPED_TYPES } from './bare-alias.js';
import { keyedSerialize } from '../../util/concurrency.js';
import { incrementEntityCategoryCountsBatch } from './histogram.js';
import { getStructuralSignalsIndex } from './structural-signals.js';
import { upsertRelation } from '../seed-entity-kb.js';
import { resolveTaxonomyCanonical, normalizeSportCanonical } from './taxonomy.js';
import {
  areEsportsOrgGamesCompatible,
  areSportsCompatible,
  moreSpecificSport,
  ESPORTS_GAMES,
  ESPORTS_UMBRELLA,
} from './sport-hierarchy.js';
import { areLeaguesCompatible } from './league-hierarchy.js';
import { upsertKnownEntity } from './upsert.js';
import { beltHit } from '../../discriminators/telemetry.js';

const log = createLogger('entity-kb');

const FUZZY_MATCH_TYPES: ReadonlySet<string> = new Set(FUZZY_MATCHABLE_ENTITY_TYPES);
const LEAGUE_SCOPED_TYPES: ReadonlySet<string> = new Set(LEAGUE_SCOPED_ENTITY_TYPES);


/** Tokens too weak alone to anchor a fuzzy match (pass 3 requires one match outside this set). */
const WEAK_DISCRIMINATOR_TOKENS: ReadonlySet<string> = new Set([
  'coin', 'token', 'fund', 'etf', 'stock', 'trust', 'dao',
  'fc', 'sc', 'club', 'city', 'united', 'team', 'athletic', 'academy',
  'league', 'cup', 'championship', 'open', 'tour', 'series',
  'party', 'council', 'committee',
  'inc', 'ltd', 'corp', 'co', 'group', 'holding', 'holdings',
  'global', 'international', 'national', 'intl',
]);

/** Matches a bare comparison/percent/currency threshold label, not a real entity name. */
const STRIKE_LABEL_RX =
  /^(?:(?:above|below|over|under|at\s*least|at\s*most|more\s*than|less\s*than|greater\s*than|fewer\s*than|no\s*more\s*than|no\s*less\s*than|up\s*to|≥|≤|>|<|=)\s*[$€£]?\s*\d[\d.,]*\s*(?:%|percent|k|m|bn|bps?|°f?|°c?|degrees?)?|[$€£]\s*\d[\d.,]*\s*(?:k|m|bn)?|\d[\d.,]*\s*(?:%|percent|°f?|°c?|degrees?)|\d[\d.,]*\s*or\s*(?:more|less|higher|lower|above|below|fewer|greater))(?:\s*or\s*(?:more|less|higher|lower|above|below|fewer|greater))?$/i;
export function isStrikeLabelSubject(s: string): boolean {
  return STRIKE_LABEL_RX.test(s.trim());
}

export function isPlaceholderCanonical(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^\d$/.test(t)) return true;
  if (isStrikeLabelSubject(t)) return true;
  if (/^(?:draw|tie)$/i.test(t)) return true;
  if (/^(?:tie\s*\/\s*)?co-?winners?$/i.test(t)) return true;
  if (/^(?:draw\s*\/\s*tie|tie\s*\/\s*draw)$/i.test(t)) return true;
  if (/^co-?champions?$/i.test(t)) return true;
  if (/^joint\s+winners?$/i.test(t)) return true;
  if (/^(?:others?|none(?:\s+of\s+the\s+above)?|neither)$/i.test(t)) return true;
  if (/^(?:party|team)\s+(?:[a-z]|\d{1,2})$/i.test(t)) return true;
  if (/^(?:artist|player|candidate|option|choice|contestant|driver|horse|fighter|entrant|golfer|chef|wrestler|nominee|pitcher|movie|song|film|show|manager|qb)\s+(?:[a-z]{1,2}\d{0,2}|\d{1,2})$/i.test(t)) return true;
  return false;
}

export async function registerEntities(
  marketId: number,
  subject: string,
  entities: ResolvedEntity[],
  domainCategory: DomainCategory = 'other',
  categoryUnified: string | null = null,
): Promise<void> {
  if (entities.length === 0) return;

  const subjectLower = subject.toLowerCase();
  const newlyCreated: number[] = [];
  // Keyed by entity_id: repeats within a market collapse to one link + one histogram bump.
  const linkSubjectById = new Map<number, boolean>();
  const histCountById = new Map<number, number>();

  for (const ent of entities) {
    await canonicalizeEntityTaxonomy(ent);

    // Must read before the metadata strip below: the competes_in edge needs the incoming league.
    const incomingLeague = (ent.metadata as { league_canonical?: string | null } | undefined)?.league_canonical ?? null;
    const incomingIsCrossLeague = isCrossLeague(incomingLeague);

    let metadataForFind = ent.metadata;
    if (incomingIsCrossLeague && metadataForFind) {
      const stripped = { ...(metadataForFind as Record<string, unknown>) };
      delete (stripped as { league_canonical?: unknown }).league_canonical;
      metadataForFind = stripped;
    }
    const entForFind = metadataForFind === ent.metadata ? ent : { ...ent, metadata: metadataForFind };

    const found = await findOrCreateEntity(entForFind, domainCategory);
    if (found === null) continue;
    const { id: entityId, newRow } = found;
    if (newRow) newlyCreated.push(entityId);
    const isSubject = ent.canonical.toLowerCase() === subjectLower;

    // Negative marketId is synthetic (no markets row) — skip the link to avoid an FK violation.
    if (marketId > 0) {
      linkSubjectById.set(entityId, (linkSubjectById.get(entityId) ?? false) || isSubject);
    }

    if (incomingLeague) {
      await linkTeamToLeague(entityId, ent.type, incomingLeague);
    }

    histCountById.set(entityId, (histCountById.get(entityId) ?? 0) + 1);
  }

  if (marketId > 0 && linkSubjectById.size > 0) {
    const entityIds: number[] = [];
    const subjects: boolean[] = [];
    for (const [id, sub] of linkSubjectById) { entityIds.push(id); subjects.push(sub); }
    await query(
      `INSERT INTO market_entity_links (market_id, entity_id, is_subject)
       SELECT $1, eid, sub
         FROM unnest($2::int[], $3::bool[]) AS t(eid, sub)
       ON CONFLICT (market_id, entity_id) DO UPDATE SET
         is_subject = market_entity_links.is_subject OR EXCLUDED.is_subject`,
      [marketId, entityIds, subjects],
    );
  }

  await incrementEntityCategoryCountsBatch(histCountById, categoryUnified);

  // Fire-and-forget: a queue failure must not block market processing.
  if (newlyCreated.length > 0) {
    enqueueEntityEnrichment(newlyCreated, 'created').catch((err) => {
      log.warn(`Failed to enqueue enrichment for entities [${newlyCreated.join(',')}]: ${err}`);
    });
  }
}

/**
 * Same-fold key for `findOrCreateEntity`'s serialization; `type` is omitted
 * since the bridge gate treats 'unknown' as a wildcard across types.
 */
export function foldVariantSerializeKey(canonical: string, type: string): string {
  // Strip a soccer-club suffix first so "Arsenal" and "Arsenal FC" share a chain.
  const base = type === 'team' || type === 'unknown' ? stripTeamSuffix(canonical) : canonical;
  const fold = foldAscii(base).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `kbreg\u001f${fold}`;
}

/**
 * Serializes `findOrCreateEntityInner` per fold-key so two fold-equivalent
 * spellings racing in the same burst can't both INSERT before either commits.
 */
async function findOrCreateEntity(
  ent: ResolvedEntity,
  domainCategory: DomainCategory = 'other',
): Promise<{ id: number; newRow: boolean } | null> {
  const sc = await tryWarmCacheShortCircuit(ent, domainCategory);
  if (sc !== null) return sc;

  const serializeKey = foldVariantSerializeKey(ent.canonical, ent.type);
  return keyedSerialize(
    serializeKey,
    () => findOrCreateEntityInner(ent, domainCategory),
    () => log.info(
      `Fold-variant serialize: "${ent.canonical}" (type=${ent.type}) queued behind an ` +
      `in-flight same-fold registration — will run after it commits so Pass 3a can bridge.`,
    ),
  );
}

/** Fast path: skip serializing/querying when a single cached row exactly matches; null on any uncertainty. */
/** Test-only: how many times the warm-cache short-circuit engaged. */
let _shortCircuitHits = 0;
export function _shortCircuitHitCountForTests(): number { return _shortCircuitHits; }

async function tryWarmCacheShortCircuit(
  ent: ResolvedEntity,
  domainCategory: DomainCategory,
): Promise<{ id: number; newRow: boolean } | null> {
  if (!_kbCacheLoaded()) return null;
  const canonicalLower = ent.canonical.toLowerCase();
  const rows = _kbRowsByLowerCanonical(canonicalLower);
  if (rows.length !== 1) return null;
  const R: KBRow = rows[0];

  const incomingScope = getIncomingScope(ent.metadata);
  if (incomingScope.sport !== null && R.sport_canonical !== incomingScope.sport) return null;
  if (incomingScope.league !== null && R.league_canonical !== incomingScope.league) return null;

  const present = new Set<string>([R.canonical.toLowerCase(), ...R.aliases.map((a) => a.toLowerCase())]);
  for (const form of [ent.canonical, ...ent.aliases]) {
    if (!present.has(form.toLowerCase())) return null;
  }

  if (aliasVariantsToAdd(R.canonical, R.aliases).length > 0) return null;

  await mergeEntityMetadata(R.id, ent.type, ent.metadata);
  _shortCircuitHits++;
  return { id: R.id, newRow: false };
}

/**
 * Three-pass match: exact canonical, exact alias, token-based fuzzy.
 * Must be called through `findOrCreateEntity`, not directly (reopens the race).
 */
async function findOrCreateEntityInner(
  ent: ResolvedEntity,
  domainCategory: DomainCategory = 'other',
): Promise<{ id: number; newRow: boolean } | null> {
  const canonicalLower = ent.canonical.toLowerCase();
  const incomingScope = getIncomingScope(ent.metadata);
  // A Pass-1 scope conflict skips the alias/fuzzy paths and goes straight to scoped INSERT.
  let skipFuzzyPaths = false;

  // Pass 1: exact canonical match, scope-aware (isScopeIncompatible has final say).
  const sportCompatList = sportCompatibilityCandidates(incomingScope.sport);
  const byCanonical = await query<{ id: number; canonical: string; aliases: string;
                                     league_canonical: string | null; sport_canonical: string | null }>(
    `SELECT id, canonical, aliases, league_canonical, sport_canonical
     FROM known_entities
     WHERE lower(canonical) = $1
       AND ($3::text IS NULL OR sport_canonical IS NULL OR sport_canonical = ANY($5::text[]))
       AND ($4::text IS NULL OR league_canonical IS NULL OR league_canonical = $4)
     ORDER BY
       -- rank by scope closeness to incoming
       (CASE WHEN $3::text IS NOT NULL AND sport_canonical = $3        THEN 0
             WHEN $3::text IS NULL     AND sport_canonical IS NULL      THEN 0
             WHEN $3::text IS NOT NULL AND sport_canonical IS NULL      THEN 1
             WHEN $3::text IS NULL     AND sport_canonical IS NOT NULL  THEN 1
             ELSE 2 END) +
       (CASE WHEN $4::text IS NOT NULL AND league_canonical = $4        THEN 0
             WHEN $4::text IS NULL     AND league_canonical IS NULL      THEN 0
             WHEN $4::text IS NOT NULL AND league_canonical IS NULL      THEN 1
             WHEN $4::text IS NULL     AND league_canonical IS NOT NULL  THEN 1
             ELSE 2 END),
       CASE WHEN domain_category = $2 THEN 0
            WHEN domain_category = 'other' OR $2 = 'other' THEN 1
            ELSE 2 END
     LIMIT 1`,
    [canonicalLower, domainCategory, incomingScope.sport, incomingScope.league, sportCompatList]
  );

  if (byCanonical.length > 0) {
    if (isScopeIncompatible(ent.type, byCanonical[0], incomingScope)) {
      log.warn(
        `Scope conflict on canonical "${ent.canonical}": ` +
        `existing (league=${byCanonical[0].league_canonical}, sport=${byCanonical[0].sport_canonical}) ` +
        `vs incoming (league=${incomingScope.league}, sport=${incomingScope.sport}). ` +
        `Creating scoped entity with original canonical.`
      );
      skipFuzzyPaths = true;
    } else {
      await maybePromoteCanonical(byCanonical[0].id, byCanonical[0].canonical, ent.canonical);
      await mergeAliases(byCanonical[0].id, byCanonical[0].aliases, ent.aliases);
      await mergeAliasVariants(byCanonical[0].id);
      await mergeEntityMetadata(byCanonical[0].id, ent.type, ent.metadata);
      return { id: byCanonical[0].id, newRow: false };
    }
  }

  if (!skipFuzzyPaths) {
  const allForms = [ent.canonical, ...ent.aliases];
  const newCanonicalTokens = new Set(
    extractSignificantTokens(allForms).map(t => t.toLowerCase())
  );
  for (const form of allForms) {
    const wordCount = form.trim().split(/\s+/).length;
    const isTicker = /^[A-Z0-9]{2,6}$/.test(form.trim());
    if (wordCount < 2 && !isTicker) continue;

    const byAlias = await query<{ id: number; canonical: string; aliases: string;
                                    league_canonical: string | null; sport_canonical: string | null }>(
      `SELECT id, canonical, aliases, league_canonical, sport_canonical
       FROM known_entities
       WHERE (aliases @> $1::jsonb OR lower(canonical) = $2)
         AND (domain_category = $3 OR domain_category = 'other' OR $3 = 'other')
       ORDER BY
         CASE WHEN domain_category = $3 THEN 0 ELSE 1 END
       LIMIT 1`,
      [JSON.stringify([form]), form.toLowerCase(), domainCategory]
    );

    if (byAlias.length > 0) {
      if (isScopeIncompatible(ent.type, byAlias[0], incomingScope)) {
        log.warn(
          `Scope conflict on alias merge "${form}" → ${byAlias[0].canonical}: ` +
          `existing (league=${byAlias[0].league_canonical}, sport=${byAlias[0].sport_canonical}) ` +
          `vs incoming (league=${incomingScope.league}, sport=${incomingScope.sport}) — skipping.`
        );
        continue;
      }
      // Bare form on an unscoped row proves nothing — league-scoped types need positive scope agreement.
      if (
        BARE_ALIAS_SCOPED_TYPES.has(ent.type) &&
        form.toLowerCase() !== byAlias[0].canonical.toLowerCase() &&
        isBareAliasFor(
          byAlias[0].canonical,
          Array.isArray(byAlias[0].aliases) ? byAlias[0].aliases : JSON.parse(byAlias[0].aliases || '[]'),
          form,
        ) &&
        !(byAlias[0].league_canonical && incomingScope.league &&
          areLeaguesCompatible(byAlias[0].league_canonical, incomingScope.league))
      ) {
        beltHit('bare_alias_scope_refuse');
        log.warn(
          `P9 bare-alias trigger refusal: "${form}" → ${byAlias[0].canonical} ` +
          `(existing league=${byAlias[0].league_canonical}, incoming league=${incomingScope.league}) — ` +
          `a bare form needs BOTH sides scoped and compatible to prove identity; skipping.`
        );
        continue;
      }
      const formIsCanonical = form.toLowerCase() === byAlias[0].canonical.toLowerCase();

      const incomingTickerBypass = isTicker
        && form.toLowerCase() === ent.canonical.toLowerCase();

      if (!formIsCanonical && !incomingTickerBypass) {
        const existingAliasesRaw: string[] = Array.isArray(byAlias[0].aliases)
          ? byAlias[0].aliases
          : JSON.parse(byAlias[0].aliases || '[]');
        const existingIsAbbrev = /^[A-Z0-9]{2,6}$/.test(byAlias[0].canonical);
        const existingTokenSources = existingIsAbbrev
          ? [byAlias[0].canonical, ...existingAliasesRaw]
          : [byAlias[0].canonical];
        const existingTokens = new Set(
          extractSignificantTokens(existingTokenSources).map(t => t.toLowerCase())
        );
        const newTokenArr = [...newCanonicalTokens];
        const isCompatible = ent.type === 'person'
          ? newTokenArr.every(t => existingTokens.has(t))
          : newTokenArr.some(t => existingTokens.has(t));
        if (!isCompatible) continue;
      }

      await maybePromoteCanonical(byAlias[0].id, byAlias[0].canonical, ent.canonical);
      const mergeNames = allForms.filter(
        (f) => f.toLowerCase() !== byAlias[0].canonical.toLowerCase()
      );
      await mergeAliases(byAlias[0].id, byAlias[0].aliases, mergeNames);
      await mergeAliasVariants(byAlias[0].id);
      await mergeEntityMetadata(byAlias[0].id, ent.type, ent.metadata);
      return { id: byAlias[0].id, newRow: false };
    }
  }

  // Pass 3: fuzzy match requires all new tokens in candidate's raw (unstemmed) set, an anchor form, and a matching generational suffix.
  if (FUZZY_MATCH_TYPES.has(ent.type)) {
    const hasAnchorForm = allForms.some((f) => {
      const t = f.trim();
      return t.split(/\s+/).length >= 2 || /^[A-Z0-9]{2,6}$/.test(t);
    });
    const newTokens = extractSignificantTokens(allForms);
    const newSuffix = getGenerationalSuffix(allForms);
    if (hasAnchorForm && newTokens.length >= 2) {
      const newRawLower = new Set(newTokens.map((t) => t.toLowerCase()));
      const stemQueryString = newTokens
        .map((t) => `'${t.toLowerCase().replace(/'/g, "''")}'`)
        .join(' | ');
      const candidateRows = await query<{ id: number; canonical: string; aliases: string;
                                           league_canonical: string | null; sport_canonical: string | null }>(
        `SELECT DISTINCT ke.id, ke.canonical, ke.aliases, ke.league_canonical, ke.sport_canonical
         FROM known_entities ke
         WHERE ke.type = $1
           AND (ke.domain_category = $3 OR ke.domain_category = 'other' OR $3 = 'other')
           AND (
             EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(ke.aliases) alias
               WHERE lower(alias) = ANY($2)
             )
             OR lower(ke.canonical) = ANY($2)
             OR ke.stems_tsv @@ to_tsquery('english', $4)
           )`,
        [ent.type, newTokens.map(t => t.toLowerCase()), domainCategory, stemQueryString]
      );

      for (const candidate of candidateRows) {
        if (isScopeIncompatible(ent.type, candidate, incomingScope)) {
          continue;
        }

        // League-scoped types need positive league/sport agreement, not merely non-conflict.
        if (LEAGUE_SCOPED_TYPES.has(ent.type)) {
          const sameLeague = candidate.league_canonical != null
            && incomingScope.league != null
            && candidate.league_canonical.toLowerCase() === incomingScope.league.toLowerCase();
          const sameSport = candidate.sport_canonical != null
            && incomingScope.sport != null
            && candidate.sport_canonical.toLowerCase() === incomingScope.sport.toLowerCase();
          if (!sameLeague && !sameSport) continue;
        }

        const existingAliases: string[] = Array.isArray(candidate.aliases)
          ? candidate.aliases
          : JSON.parse(candidate.aliases || '[]');
        const existingForms = [candidate.canonical, ...existingAliases];

        const candidateSuffix = getGenerationalSuffix(existingForms);
        if (newSuffix !== candidateSuffix) continue;

        const candidateTokens = extractSignificantTokens(existingForms);
        const candidateRawLower = new Set(candidateTokens.map((t) => t.toLowerCase()));

        const allMatch = [...newRawLower].every((t) => candidateRawLower.has(t));
        if (!allMatch) continue;

        const hasStrongToken = [...newRawLower].some((t) => !WEAK_DISCRIMINATOR_TOKENS.has(t));
        if (!hasStrongToken) continue;

        const fmtScope = (l: string | null, s: string | null): string =>
          (l || s) ? `${l ? `league=${l}` : ''}${l && s ? '|' : ''}${s ? `sport=${s}` : ''}` : '∅';
        log.info(
          `Fuzzy match: "${ent.canonical}" → "${candidate.canonical}" ` +
          `(raw [${[...newRawLower].join(', ')}] ⊆ [${[...candidateRawLower].join(', ')}]) ` +
          `scope: cand=${fmtScope(candidate.league_canonical, candidate.sport_canonical)} ` +
          `incoming=${fmtScope(incomingScope.league, incomingScope.sport)} ` +
          `[type=${ent.type}]`
        );
        await maybePromoteCanonical(candidate.id, candidate.canonical, ent.canonical);
        const mergeNames = allForms.filter(
          (f) => f.toLowerCase() !== candidate.canonical.toLowerCase()
        );
        await mergeAliases(candidate.id, candidate.aliases, mergeNames);
        await mergeAliasVariants(candidate.id);
        await mergeEntityMetadata(candidate.id, ent.type, ent.metadata);
        return { id: candidate.id, newRow: false };
      }
    }
  }
  } // end if (!skipFuzzyPaths) — paths 2 + 3

  // Fold-variant bridge: collapse a despace/diacritic variant onto the existing row before INSERT.
  if (!skipFuzzyPaths) {
    const bridgeHit = await findFoldVariantBridge(ent, canonicalLower, domainCategory, incomingScope);
    if (bridgeHit) {
      log.info(
        `Fold-variant bridge (${bridgeHit.kind}): incoming "${ent.canonical}" ` +
        `(type=${ent.type}, domain=${domainCategory}) folds to existing "${bridgeHit.row.canonical}" ` +
        `(id=${bridgeHit.row.id}) — bridging instead of creating duplicate row.`
      );
      await maybePromoteCanonical(bridgeHit.row.id, bridgeHit.row.canonical, ent.canonical);
      await mergeAliases(bridgeHit.row.id, bridgeHit.row.aliases, ent.aliases);
      await mergeAliasVariants(bridgeHit.row.id);
      await mergeEntityMetadata(bridgeHit.row.id, ent.type, ent.metadata);
      return { id: bridgeHit.row.id, newRow: false };
    }
  }

  const incomingIsTicker = /^[A-Z0-9]{2,6}$/.test(ent.canonical.trim());
  if (!skipFuzzyPaths) {
    const aliasCollision = await query<{ id: number; canonical: string; aliases: string;
                                          league_canonical: string | null; sport_canonical: string | null }>(
      `SELECT id, canonical, aliases, league_canonical, sport_canonical
       FROM known_entities
       WHERE type = $1
         AND ($4::bool OR domain_category = $2 OR domain_category = 'other' OR $2 = 'other')
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(aliases) a
           WHERE lower(a) = $3
         )
       ORDER BY CASE WHEN domain_category = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [ent.type, domainCategory, canonicalLower, incomingIsTicker],
    );
    if (aliasCollision.length > 0) {
      const hit = aliasCollision[0];
      if (!isScopeIncompatible(ent.type, hit, incomingScope)) {
        log.info(
          `Alias-collision merge: incoming "${ent.canonical}" (type=${ent.type}, domain=${domainCategory}) ` +
          `is already an alias of "${hit.canonical}" (id=${hit.id}) — merging instead of creating duplicate row.`
        );
        await mergeAliases(hit.id, hit.aliases, ent.aliases);
        await mergeAliasVariants(hit.id);
        await mergeEntityMetadata(hit.id, ent.type, ent.metadata);
        return { id: hit.id, newRow: false };
      }
    }
  }

  // Refuse CREATE (not linking) for a placeholder canonical, so refusal never orphans KB state.
  if (isPlaceholderCanonical(ent.canonical)) {
    log.warn(
      `Refusing to CREATE known_entity for placeholder canonical "${ent.canonical}" ` +
      `(type=${ent.type}, domain=${domainCategory}) — non-entity label, not a real-world entity ` +
      `(belt 2, KB write-path guard).`,
    );
    return null;
  }

  const metadata: Record<string, unknown> = { kind: ent.type, ...(ent.metadata ?? {}) };
  // type_basis: 'template-high' for a confident type, 'unknown' stays as-is, callers may supply 'rule:<name>'.
  if (metadata.type_basis == null) {
    metadata.type_basis = ent.type === 'unknown' ? 'unknown' : 'template-high';
  }
  const needsAsyncEnrichment = shouldEnqueueForEnrichment(ent, domainCategory);
  const result = await upsertKnownEntity(
    {
      canonical: ent.canonical,
      type: ent.type,
      aliases: ent.aliases,
      metadata,
      domain_category: domainCategory,
    },
    { initialEnrichmentStatus: needsAsyncEnrichment ? 'pending' : 'enriched' },
  );

  const persistedVariants = await mergeAliasVariants(result.id);

  if (result.newRow) {
    const m = metadata as { sport_canonical?: string | null; league_canonical?: string | null };
    _kbCacheInsert({
      id: result.id,
      canonical: ent.canonical,
      domain_category: domainCategory,
      type: ent.type,
      aliases: [...ent.aliases, ...persistedVariants],
      sport_canonical:  m.sport_canonical  ?? null,
      league_canonical: m.league_canonical ?? null,
    });
  }

  return { id: result.id, newRow: result.newRow };
}

/**
 * Normalizes metadata.sport_canonical/league_canonical to KB canonical form
 * in place; a genuinely novel value is left untouched.
 */
async function canonicalizeEntityTaxonomy(ent: ResolvedEntity): Promise<void> {
  const meta = ent.metadata as Record<string, unknown> | undefined;
  if (!meta) return;

  const sport = meta.sport_canonical;
  if (typeof sport === 'string' && sport.trim().length > 0) {
    // null result clears an ambiguous bare sport; undefined leaves it raw.
    const league = typeof meta.league_canonical === 'string' ? meta.league_canonical : null;
    const normalized = await normalizeSportCanonical(sport, { league });
    if (typeof normalized === 'string') {
      if (normalized !== sport) (meta as Record<string, unknown>).sport_canonical = normalized;
    } else if (normalized === null) {
      (meta as Record<string, unknown>).sport_canonical = null;
    }
  }

  const league = meta.league_canonical;
  if (typeof league === 'string' && league.trim().length > 0) {
    const canonical = await resolveTaxonomyCanonical(league, 'league');
    if (canonical && canonical !== league) {
      (meta as Record<string, unknown>).league_canonical = canonical;
    } else if (!canonical) {
      // A game name sometimes lands in league_canonical; clear it when it resolves as a sport instead.
      const asSport = await resolveTaxonomyCanonical(league, 'sport');
      if (asSport) {
        (meta as Record<string, unknown>).league_canonical = null;
      }
    }
  }
}

/** Sport values SQL-compatible with the incoming sport (incl. esports umbrella/child pair); isScopeIncompatible has final say. */
function sportCompatibilityCandidates(incomingSport: string | null): string[] {
  if (!incomingSport) return [];
  const s = incomingSport.toLowerCase();
  const out: string[] = [incomingSport];
  if (s === ESPORTS_UMBRELLA) {
    for (const g of ESPORTS_GAMES) out.push(g);
  } else if (ESPORTS_GAMES.has(s)) {
    out.push(ESPORTS_UMBRELLA);
  }
  return out;
}

/** Extract league/sport scope from entity metadata. */
export function getIncomingScope(metadata: Record<string, unknown> | undefined): {
  league: string | null;
  sport: string | null;
} {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const league = typeof m.league_canonical === 'string' ? m.league_canonical : null;
  const sport  = typeof m.sport_canonical  === 'string' ? m.sport_canonical  : null;
  return { league, sport };
}

/** Whether an entity needs the async enrichment LLM call (skipped when the caller already supplied type-specific metadata). */
export function shouldEnqueueForEnrichment(
  ent: { canonical: string; type: string; aliases: string[]; metadata?: Record<string, unknown> | undefined },
  domainCategory: string,
): boolean {
  const metadata = (ent.metadata ?? {}) as Record<string, unknown>;
  // `kind` and `type_basis` don't count as enrichment-completing metadata.
  const metadataKeys = Object.keys(metadata).filter((k) => k !== 'kind' && k !== 'type_basis');

  if (ent.type === 'unknown') return true;
  if (metadataKeys.length === 0) return true;

  const canonicalLooksLikeCode = /^[A-Z0-9]{2,5}$/.test(ent.canonical.trim());
  const hasFullNameAlias = ent.aliases.some((a) => /\s/.test(a.trim()) && a.trim().length > ent.canonical.trim().length);
  if (canonicalLooksLikeCode && hasFullNameAlias && domainCategory === 'sports') return true;

  if (domainCategory === 'sports') {
    if ((ent.type === 'team' || ent.type === 'league' || ent.type === 'competition') && !metadata.sport_canonical) return true;
    if (ent.type === 'person' && !metadata.role) return true;
  }

  if (ent.type === 'asset' && !metadata.asset_class) return true;
  if (ent.type === 'data_provider' && !metadata.domain) return true;

  return false;
}

/** True when incoming and candidate are same type (unknown=wildcard), domain-compatible, and scope-compatible. */
export function bridgeGateOk(
  incoming: { type: string; domainCategory: string },
  candidate: { type: string; domainCategory: string },
  scopeIncompatible: boolean,
): boolean {
  if (
    incoming.type !== candidate.type &&
    incoming.type !== 'unknown' &&
    candidate.type !== 'unknown'
  ) return false;
  const domainCompatible =
    incoming.domainCategory === candidate.domainCategory ||
    incoming.domainCategory === 'other' ||
    candidate.domainCategory === 'other';
  if (!domainCompatible) return false;
  if (scopeIncompatible) return false;
  return true;
}

/** True when a rule-typed incoming would bridge except for a concrete type mismatch — signals the rule table disagrees with the KB. */
export function isKeTypeConflict(
  incomingType: string,
  candidateType: string,
  incomingRuleTyped: boolean,
  domainCompatible: boolean,
  scopeIncompatible: boolean,
): boolean {
  return (
    incomingRuleTyped && domainCompatible && !scopeIncompatible &&
    incomingType !== 'unknown' && candidateType !== 'unknown' &&
    incomingType !== candidateType
  );
}

/** True when a completed bridge relied on the 'unknown' type wildcard (call only after bridgeGateOk passes). */
export function isKeUnknownWildcardMerge(incomingType: string, candidateType: string): boolean {
  return incomingType !== candidateType && (incomingType === 'unknown' || candidateType === 'unknown');
}

/** Soccer-club suffixes; deliberately narrow — stripping "United"/"City" etc. would over-merge distinct clubs. */
const SOCCER_CLUB_SUFFIXES: readonly string[] = [
  'football club', // longest match first
  'f.c.',
  'a.f.c.',
  's.c.',
  'c.f.',
  'afc',
  'fc',
  'sc',
  'cf',
  'club',
];

/** Strip one leading/trailing soccer-club suffix; a name that's all suffix is returned unchanged. */
export function stripTeamSuffix(name: string): string {
  const s = name.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const suf of SOCCER_CLUB_SUFFIXES) {
    if (s.endsWith(' ' + suf)) {
      const stripped = s.slice(0, s.length - suf.length - 1).trim();
      if (stripped.length > 0) return stripped;
    }
    if (s.startsWith(suf + ' ')) {
      const stripped = s.slice(suf.length + 1).trim();
      if (stripped.length > 0) return stripped;
    }
  }
  return s;
}

/** Must never fire outside type='team' + soccer; a null incoming sport is soccer-eligible only when the candidate row itself is soccer. */
function isSoccerTeamScope(entType: string, sport: string | null): boolean {
  if (entType !== 'team') return false;
  if (sport == null) return true;
  return sport.trim().toLowerCase() === 'soccer';
}

/** Club-suffix scope gate: unlike isScopeIncompatible, exactly one league populated is refused (two distinct clubs risk). */
export function clubSuffixScopeOk(
  existingLeague: string | null,
  incomingLeague: string | null,
  isCrossLeagueFn: (l: string | null) => boolean = isCrossLeague,
): boolean {
  if (isCrossLeagueFn(existingLeague) || isCrossLeagueFn(incomingLeague)) return true;
  const exNull = existingLeague == null || existingLeague.trim() === '';
  const inNull = incomingLeague == null || incomingLeague.trim() === '';
  if (exNull && inNull) return true;
  if (exNull !== inNull) return false;
  return areLeaguesCompatible(existingLeague, incomingLeague);
}

/** Whitespace token count; must mirror the SQL array_length(regexp_split_to_array(...)) computation. */
export function whitespaceTokenCount(name: string): number {
  const t = name.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/** Row shape returned by the fold-variant bridge candidate queries. */
interface BridgeCandidateRow {
  id: number;
  canonical: string;
  aliases: string;
  type: string;
  domain_category: string;
  league_canonical: string | null;
  sport_canonical: string | null;
}

/**
 * Fold-variant bridge candidates in order: diacritic fold (all types),
 * despace fold (non-person, then person with >=2 tokens), club-suffix fold
 * (soccer teams). All gated by `bridgeGateOk`; returns the lowest-id match.
 */
export async function findFoldVariantBridge(
  ent: ResolvedEntity,
  canonicalLower: string,
  domainCategory: DomainCategory,
  incomingScope: { league: string | null; sport: string | null },
): Promise<{ row: { id: number; canonical: string; aliases: string }; kind: 'diacritic' | 'despace' | 'club-suffix' } | null> {
  const diacriticRows = await query<BridgeCandidateRow>(
    `SELECT id, canonical, aliases, type, domain_category, league_canonical, sport_canonical
       FROM known_entities
      WHERE (type = $1 OR type = 'unknown' OR $1 = 'unknown')
        AND (domain_category = $2 OR domain_category = 'other' OR $2 = 'other')
        AND lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($3))
        AND lower(canonical) <> $4
      ORDER BY id`,
    [ent.type, domainCategory, ent.canonical, canonicalLower],
  );
  const diacriticHit = pickBridgeCandidate(ent, domainCategory, incomingScope, diacriticRows);
  if (diacriticHit) return { row: diacriticHit, kind: 'diacritic' };

  if (ent.type !== 'person') {
    const despaceRows = await query<BridgeCandidateRow>(
      `SELECT id, canonical, aliases, type, domain_category, league_canonical, sport_canonical
         FROM known_entities
        WHERE (type = $1 OR type = 'unknown' OR $1 = 'unknown')
          AND type <> 'person'
          AND (domain_category = $2 OR domain_category = 'other' OR $2 = 'other')
          AND lower(immutable_unaccent(replace(canonical,' ',''))) =
              lower(immutable_unaccent(replace($3,' ','')))
          AND lower(canonical) <> $4
        ORDER BY id`,
      [ent.type, domainCategory, ent.canonical, canonicalLower],
    );
    const despaceHit = pickBridgeCandidate(ent, domainCategory, incomingScope, despaceRows);
    if (despaceHit) return { row: despaceHit, kind: 'despace' };
  }

  if (ent.type === 'person' && whitespaceTokenCount(ent.canonical) >= 2) {
    const personDespaceRows = await query<BridgeCandidateRow>(
      `SELECT id, canonical, aliases, type, domain_category, league_canonical, sport_canonical
         FROM known_entities
        WHERE (type = 'person' OR type = 'unknown')
          AND (domain_category = $1 OR domain_category = 'other' OR $1 = 'other')
          AND lower(immutable_unaccent(replace(canonical,' ',''))) =
              lower(immutable_unaccent(replace($2,' ','')))
          AND lower(canonical) <> $3
          AND array_length(regexp_split_to_array(btrim(canonical), '\\s+'), 1) >= 2
        ORDER BY id`,
      [domainCategory, ent.canonical, canonicalLower],
    );
    const personDespaceHit = pickBridgeCandidate(ent, domainCategory, incomingScope, personDespaceRows);
    if (personDespaceHit) return { row: personDespaceHit, kind: 'despace' };
  }

  if (isSoccerTeamScope(ent.type, incomingScope.sport)) {
    const incomingBare = stripTeamSuffix(ent.canonical);
    const incomingBareFold = foldAscii(incomingBare).toLowerCase().replace(/\s+/g, '');
    if (incomingBareFold.length > 0) {
      const suffixRows = await query<BridgeCandidateRow>(
        `SELECT id, canonical, aliases, type, domain_category, league_canonical, sport_canonical
           FROM known_entities
          WHERE type = 'team'
            AND lower(sport_canonical) = 'soccer'
            AND (domain_category = $1 OR domain_category = 'other' OR $1 = 'other')
            AND lower(canonical) <> $2
            AND regexp_replace(
                  regexp_replace(
                    replace(lower(immutable_unaccent(canonical)), ' ', ''),
                    '^(footballclub|a\\.f\\.c\\.|f\\.c\\.|s\\.c\\.|c\\.f\\.|afc|fc|sc|cf|club)', ''),
                  '(footballclub|a\\.f\\.c\\.|f\\.c\\.|s\\.c\\.|c\\.f\\.|afc|fc|sc|cf|club)$', '')
                = $3
          ORDER BY id`,
        [domainCategory, canonicalLower, incomingBareFold],
      );
      const suffixCandidates = suffixRows.filter(
        (r) =>
          stripTeamSuffix(r.canonical) === incomingBare &&
          clubSuffixScopeOk(r.league_canonical, incomingScope.league),
      );
      const suffixHit = pickBridgeCandidate(ent, domainCategory, incomingScope, suffixCandidates);
      if (suffixHit) return { row: suffixHit, kind: 'club-suffix' };
    }
  }

  return null;
}

/** From a set of fold-collision candidate rows, return the first that passes `bridgeGateOk`, or null. */
function pickBridgeCandidate(
  ent: ResolvedEntity,
  domainCategory: DomainCategory,
  incomingScope: { league: string | null; sport: string | null },
  rows: BridgeCandidateRow[],
): { id: number; canonical: string; aliases: string } | null {
  const incomingRuleTyped =
    typeof (ent.metadata as Record<string, unknown> | undefined)?.type_basis === 'string' &&
    ((ent.metadata as Record<string, unknown>).type_basis as string).startsWith('rule:');
  for (const row of rows) {
    // Use the concrete type (not 'unknown') for scope checks, or 'team' as the strictest fallback.
    const scopeType = ent.type !== 'unknown' ? ent.type
      : row.type !== 'unknown' ? row.type : 'team';
    const scopeIncompatible = isScopeIncompatible(scopeType, row, incomingScope);
    const domainCompatible =
      domainCategory === row.domain_category ||
      domainCategory === 'other' ||
      row.domain_category === 'other';
    if (!bridgeGateOk(
      { type: ent.type, domainCategory },
      { type: row.type, domainCategory: row.domain_category },
      scopeIncompatible,
    )) {
      if (isKeTypeConflict(ent.type, row.type, incomingRuleTyped, domainCompatible, scopeIncompatible)) {
        beltHit('ke_type_conflict', { canonical: ent.canonical, incoming: ent.type, existing: row.type });
      }
      continue;
    }
    if (isKeUnknownWildcardMerge(ent.type, row.type)) {
      beltHit('ke_unknown_wildcard', { canonical: ent.canonical });
    }
    return { id: row.id, canonical: row.canonical, aliases: row.aliases };
  }
  return null;
}

/**
 * True when an existing KB row's league/sport scope conflicts with an
 * incoming entity's. Only one side populated is treated as compatible
 * (merge propagates scope); both populated and disagreeing is a conflict.
 */
function isScopeIncompatible(
  entityType: string,
  existing: { league_canonical: string | null; sport_canonical: string | null },
  incoming: { league: string | null; sport: string | null },
): boolean {
  if (!LEAGUE_SCOPED_TYPES.has(entityType) && entityType !== 'person') return false;
  if (existing.league_canonical && incoming.league &&
      !areLeaguesCompatible(existing.league_canonical, incoming.league)) {
    // A cross-league competition co-occurs with a domestic league by design, not a real conflict.
    if (isCrossLeague(existing.league_canonical) || isCrossLeague(incoming.league)) {
      return false;
    }
    return true;
  }
  if (existing.sport_canonical && incoming.sport &&
      existing.sport_canonical.toLowerCase() !== incoming.sport.toLowerCase()) {
    // `esports` is the umbrella; specific games are peer `type='sport'` rows and compatible with it.
    if (areSportsCompatible(existing.sport_canonical, incoming.sport)) return false;
    // Esports teams may share scope across games; persons don't (same-name collisions across games are real).
    if (entityType === 'team' &&
        areEsportsOrgGamesCompatible(existing.sport_canonical, incoming.sport)) {
      return false;
    }
    return true;
  }
  return false;
}

/** True when the given league canonical is a cup / cross-domestic competition. */
export function isCrossLeague(leagueCanonical: string | null): boolean {
  if (!leagueCanonical) return false;
  const idx = getStructuralSignalsIndex();
  for (const c of idx.crossLeagueCanonicals) {
    if (c.toLowerCase() === leagueCanonical.toLowerCase()) return true;
  }
  return false;
}

/** Idempotently link a team to its league/competition via a competes_in relation; no-ops if not a team or the league row doesn't exist yet. */
/** Memo of canonical -> league id; misses aren't cached, cleared on KB-cache invalidation to avoid a stale FK. */
const _leagueIdByCanonicalLower = new Map<string, number>();
registerKBCacheInvalidator(() => _leagueIdByCanonicalLower.clear());

async function linkTeamToLeague(entityId: number, entityType: string, leagueCanonical: string | null): Promise<void> {
  if (entityType !== 'team' || !leagueCanonical) return;
  const key = leagueCanonical.toLowerCase();
  let leagueId = _leagueIdByCanonicalLower.get(key);
  if (leagueId === undefined) {
    const leagueRows = await query<{ id: number }>(
      `SELECT id FROM known_entities
        WHERE lower(canonical) = $1 AND type IN ('league','competition')
        LIMIT 1`,
      [key],
    );
    if (leagueRows.length === 0) return;
    leagueId = leagueRows[0]!.id;
    _leagueIdByCanonicalLower.set(key, leagueId);
  }
  await upsertRelation(entityId, leagueId, 'competes_in');
}

/** Merge new aliases in, deduping case-insensitively and rejecting aliases owned by a different entity; also gates bare aliases via bareAliasWritable. */
export async function mergeAliases(
  entityId: number,
  existingAliases: string | string[],
  newAliases: string[]
): Promise<string[]> {
  // pg driver auto-parses JSONB — may already be an array
  const existing: string[] = Array.isArray(existingAliases)
    ? existingAliases
    : JSON.parse(existingAliases || '[]');
  const existingLower = new Set(existing.map((a) => a.toLowerCase()));

  const candidates = newAliases.filter((a) => !existingLower.has(a.toLowerCase()));
  if (candidates.length === 0) return [];

  const colliding = await query<{ alias_text: string }>(
    `SELECT DISTINCT a AS alias_text
     FROM known_entities,
          LATERAL jsonb_array_elements_text(aliases) AS a
     WHERE id <> $1
       AND lower(a) = ANY($2)
     UNION
     SELECT lower(canonical)
     FROM known_entities
     WHERE id <> $1 AND lower(canonical) = ANY($2)`,
    [entityId, candidates.map(a => a.toLowerCase())]
  );
  const collidingSet = new Set(colliding.map(r => r.alias_text.toLowerCase()));

  const collisionSurvivors = candidates.filter(a => !collidingSet.has(a.toLowerCase()));
  if (collisionSurvivors.length > 0 && collidingSet.size > 0) {
    const blocked = candidates.filter(a => collidingSet.has(a.toLowerCase()));
    log.debug(`Collision guard blocked aliases for entity ${entityId}: [${blocked.join(', ')}]`);
  }
  if (collisionSurvivors.length === 0) return [];

  const toAdd = await filterBareAliasesByScope(entityId, existing, collisionSurvivors);
  if (toAdd.length === 0) return [];

  const merged = [...existing, ...toAdd];
  await query(
    `UPDATE known_entities SET aliases = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(merged), entityId]
  );
  return toAdd;
}

/** May `alias` be written onto owner? Refused for a bare alias on a league-scoped type with no league_canonical. */
export function bareAliasWritable(
  owner: { type: string; canonical: string; league_canonical: string | null },
  otherAliases: readonly string[],
  alias: string,
): boolean {
  if (!BARE_ALIAS_SCOPED_TYPES.has(owner.type)) return true;
  if (owner.league_canonical != null && owner.league_canonical !== '') return true;
  return !isBareAliasFor(owner.canonical, otherAliases, alias);
}

/** Apply {@link bareAliasWritable} to a merge's surviving candidates. */
async function filterBareAliasesByScope(
  entityId: number,
  existing: string[],
  candidates: string[],
): Promise<string[]> {
  if (candidates.every((a) => isCodeLikeAlias(a))) return candidates;

  const rows = await query<{ type: string; canonical: string; league_canonical: string | null }>(
    `SELECT type, canonical, league_canonical FROM known_entities WHERE id = $1`,
    [entityId],
  );
  const owner = rows[0];
  if (!owner) return candidates; // row vanished (concurrent merge) — the UPDATE will no-op
  if (!BARE_ALIAS_SCOPED_TYPES.has(owner.type)) return candidates;
  if (owner.league_canonical != null && owner.league_canonical !== '') return candidates;

  const kept: string[] = [];
  for (const a of candidates) {
    if (bareAliasWritable(owner, [...existing, ...candidates.filter((c) => c !== a)], a)) {
      kept.push(a);
    } else {
      beltHit('bare_alias_scope_refuse');
      log.warn(
        `P9 bare-alias scope refusal: "${a}" not written onto entity ${entityId} ` +
        `("${owner.canonical}", type=${owner.type}, league_canonical IS NULL) — ` +
        `a bare name on an unscoped row is a cross-entity magnet.`,
      );
    }
  }
  return kept;
}

/**
 * Backfills space-invariant (fold+lower+despace) alias variants for an
 * entity, routed through `mergeAliases` so the collision guard still
 * applies. Idempotent.
 */
export async function mergeAliasVariants(entityId: number): Promise<string[]> {
  const rows = await query<{ canonical: string; aliases: string | string[] }>(
    `SELECT canonical, aliases FROM known_entities WHERE id = $1`,
    [entityId],
  );
  if (rows.length === 0) return [];
  const { canonical } = rows[0];
  const aliases: string[] = Array.isArray(rows[0].aliases)
    ? rows[0].aliases
    : JSON.parse(rows[0].aliases || '[]');
  const variants = aliasVariantsToAdd(canonical, aliases);
  if (variants.length === 0) return [];
  return mergeAliases(entityId, aliases, variants);
}

/** Shallow-merges metadata into an entity; first-write-wins so existing keys survive. */
export async function mergeEntityMetadata(
  entityId: number,
  entityType: string,
  metadata: Record<string, unknown> | undefined,
): Promise<void> {
  if (!metadata || Object.keys(metadata).length === 0) return;
  const incoming = { kind: entityType, ...metadata };
  // Exception: upgrade sport_canonical from the esports umbrella to a specific game before the first-write-wins merge.
  const incomingSport = typeof (incoming as Record<string, unknown>).sport_canonical === 'string'
    ? ((incoming as Record<string, unknown>).sport_canonical as string)
    : null;
  if (incomingSport && ESPORTS_GAMES.has(incomingSport.toLowerCase())) {
    const rows = await query<{ sport_canonical: string | null }>(
      `SELECT sport_canonical FROM known_entities WHERE id = $1`,
      [entityId],
    );
    const existingSport = rows[0]?.sport_canonical ?? null;
    if (existingSport && existingSport.toLowerCase() === ESPORTS_UMBRELLA) {
      const upgraded = moreSpecificSport(existingSport, incomingSport);
      if (upgraded && upgraded !== existingSport) {
        await query(
          `UPDATE known_entities
             SET metadata   = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('sport_canonical', $2::text),
                 updated_at = NOW()
           WHERE id = $1`,
          [entityId, upgraded],
        );
        log.info(
          `Sport upgraded on entity ${entityId}: "${existingSport}" → "${upgraded}" (specific game wins over esports umbrella)`,
        );
      }
    }
  }
  try {
    await query(
      `UPDATE known_entities
         SET metadata = $2::jsonb || COALESCE(metadata, '{}'::jsonb),
             updated_at = NOW()
       WHERE id = $1`,
      [entityId, JSON.stringify(incoming)]
    );
  } catch (err) {
    // A unique-constraint collision here should skip, not crash, the market.
    const e = err as { code?: string; constraint?: string; detail?: string };
    if (e?.code === '23505' && e?.constraint === 'known_entities_canonical_sport_league_key') {
      log.warn(
        `mergeEntityMetadata: skipping patch on entity id=${entityId} — would collide on ` +
        `(canonical, sport, league). Detail: ${e.detail ?? ''}. ` +
        `Merge probe will resolve on next enrichment pass.`
      );
      return;
    }
    throw err;
  }
}

/** Promotes canonical to a longer/more complete incoming form; a short standardized code (2-5 uppercase) stays canonical. */
/** True for a year-prefixed competition title (e.g. "2024 La Liga"); such a title must not overwrite the base league canonical. */
export function isSeasonPrefixedCanonical(s: string): boolean {
  return /^(?:19|20)\d{2}(?:[\s\-–]\d{2})?\s+\S/.test(s.trim());
}

export async function maybePromoteCanonical(
  entityId: number,
  existingCanonical: string,
  newCanonical: string
): Promise<void> {
  if (newCanonical.toLowerCase() === existingCanonical.toLowerCase()) return;

  if (/^[A-Z]{2,5}$/.test(existingCanonical)) {
    await mergeAliases(entityId, '[]', [newCanonical]);
    return;
  }

  const existingLower = existingCanonical.toLowerCase();
  const newLower = newCanonical.toLowerCase();
  if (newLower.startsWith(existingLower + ' ')) {
    await mergeAliases(entityId, '[]', [newCanonical]);
    return;
  }

  if (/^the\s+/i.test(newCanonical) && !/^the\s+/i.test(existingCanonical)) {
    await mergeAliases(entityId, '[]', [newCanonical]);
    return;
  }

  if (isSeasonPrefixedCanonical(newCanonical) && !isSeasonPrefixedCanonical(existingCanonical)) {
    await mergeAliases(entityId, '[]', [newCanonical]);
    return;
  }

  const existingWords = existingCanonical.split(/\s+/).length;
  const newWords = newCanonical.split(/\s+/).length;
  if (newWords < existingWords) return;
  if (newWords === existingWords && newCanonical.length <= existingCanonical.length) return;

  const rows = await query<{ aliases: string | string[] }>(
    `SELECT aliases FROM known_entities WHERE id = $1`, [entityId]
  );
  if (rows.length === 0) return;

  const aliases: string[] = Array.isArray(rows[0].aliases)
    ? rows[0].aliases
    : JSON.parse(rows[0].aliases || '[]');
  const aliasLower = new Set(aliases.map((a) => a.toLowerCase()));
  if (!aliasLower.has(existingCanonical.toLowerCase())) {
    aliases.push(existingCanonical);
  }
  const cleaned = aliases.filter((a) => a.toLowerCase() !== newCanonical.toLowerCase());

  await query(
    `UPDATE known_entities SET canonical = $1, aliases = $2, updated_at = NOW() WHERE id = $3`,
    [newCanonical, JSON.stringify(cleaned), entityId]
  );
  log.info(`Promoted canonical: "${existingCanonical}" → "${newCanonical}"`);
}
