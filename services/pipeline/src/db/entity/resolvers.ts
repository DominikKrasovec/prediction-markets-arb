/**
 * Entity resolvers: Tier-1 cache lookup + tier-specific fallback.
 * Public entry point: `resolveSubjectViaKB` (single-flight + memo).
 */

import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { getProvider, singleFlight } from '@arb/llm';
import type { EntityType, DomainCategory, ResolvedEntity } from '@arb/types';
import type { KBLookupResult, ResolveOptions, KBScope, KBRow } from './types.js';
import {
  _ensureKBCache,
  _kbByCanonical,
  _kbCacheInsert,
  _kbNameRowsSync,
  _resolvedSubjectCache,
  _t1FromCache,
  registerKBCacheInvalidator,
} from './cache.js';
import { tokenize, looksLikeAcronymOf, foldAscii, T2_CONTEXT_TOKENS } from './tokens.js';
import { areSportsCompatible } from './sport-hierarchy.js';
import { areLeaguesCompatible } from './league-hierarchy.js';
import { enqueueEntityEnrichment } from '../queries/entity-enrichment-queue.js';
import { upsertKnownEntity } from './upsert.js';
// One-directional dependency: resolvers.ts imports register.ts, never the reverse.
import {
  findFoldVariantBridge,
  foldVariantSerializeKey,
  getIncomingScope,
  isPlaceholderCanonical,
  maybePromoteCanonical,
  mergeAliases,
  mergeAliasVariants,
  mergeEntityMetadata,
} from './register.js';
import { keyedSerialize } from '../../util/concurrency.js';

function fmtScope(scope: KBScope | null | undefined): string {
  if (!scope) return '';
  const parts: string[] = [];
  if (scope.sport)  parts.push(`sport=${scope.sport}`);
  if (scope.league) parts.push(`league=${scope.league}`);
  return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
}

const log = createLogger('entity-kb');

abstract class EntityResolver {
  protected readonly typeFilter: string[] | null;

  constructor(typeFilter: string[] | null = null) {
    this.typeFilter = typeFilter;
  }

  protected async tier1(
    textLower: string,
    originalText: string,
    domain: string,
    scope: KBScope | null = null,
  ): Promise<KBLookupResult | null> {
    const tf = this.typeFilter ?? null;
    return _t1FromCache(textLower, originalText, domain, tf, scope);
  }
}

class SubjectEntityResolver extends EntityResolver {
  constructor() {
    super(null); // any entity type
  }

  async resolveCanonical(subject: string, domain: string, scope: KBScope | null = null): Promise<string> {
    const textLower = subject.toLowerCase().trim();

    // Parlay synthetic subjects and raw platform tickers are never entities.
    if (/^parlay\[/i.test(subject) || /^kx[a-z0-9]+-/i.test(subject)) {
      return subject;
    }

    const t1 = await this.tier1(textLower, subject, domain, scope);
    if (t1) {
      if (t1.canonical.toLowerCase() !== textLower)
        log.info(`"${subject}" → "${t1.canonical}" (${domain}${fmtScope(scope)}) [T1]`);
      return t1.canonical;
    }

    // Market predicates / metric titles are not entity names.
    if (looksLikePredicate(subject)) {
      return subject;
    }

    if (isNonEntityLabel(subject)) {
      return subject;
    }

    // "<City> <single-letter>" subjects refuse rather than guess when the KB
    // holds >=2 same-city teams in a compatible sport.
    if (await isAmbiguousSameCityTeam(subject, scope?.sport ?? null)) {
      log.info(
        `"${subject}" REFUSED (${domain}${fmtScope(scope)}) [RC2 same-city single-letter ` +
        `collision — ≥2 same-prefix teams, no exact alias to disambiguate]`,
      );
      return subject;
    }

    return this.resolveViaEmbedding(subject, textLower, domain, scope);
  }

  private async resolveViaEmbedding(
    subject: string,
    subjectLower: string,
    domain: string,
    scope: KBScope | null = null,
  ): Promise<string> {
    const COSINE_MIN = parseFloat(process.env.SUBJECT_EMBED_COSINE_MIN ?? '0.88');

    const tableExists = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_subjects'
       ) AS exists`,
    );
    if (!tableExists[0]?.exists) return subject;

    const sportHint  = scope?.sport ?? null;
    const leagueHint = scope?.league ?? null;

    const rowForCanonical = (canonical: string) => {
      const rows = _kbByCanonical.get(canonical.toLowerCase());
      if (!rows || rows.length === 0) return undefined;
      if (sportHint !== null || leagueHint !== null) {
        const exact = rows.find(r =>
          (sportHint  === null || r.sport_canonical  === sportHint) &&
          (leagueHint === null || r.league_canonical === leagueHint));
        if (exact) return exact;
      }
      return rows.find(r => r.sport_canonical !== null || r.league_canonical !== null) ?? rows[0];
    };

    // A row absent from the warm cache is treated as compatible.
    const scopeCompatible = (canonical: string): boolean => {
      if (sportHint === null && leagueHint === null) return true;
      const r = rowForCanonical(canonical);
      if (r === undefined) return true;
      if (sportHint !== null && r.sport_canonical !== null
          && !areSportsCompatible(r.sport_canonical, sportHint)) return false;
      if (leagueHint !== null && r.league_canonical !== null
          && !areLeaguesCompatible(r.league_canonical, leagueHint)) return false;
      return true;
    };

    const candScopeDesc = (canonical: string): string => {
      const r = rowForCanonical(canonical);
      if (r === undefined) return 'unknown';
      const parts: string[] = [];
      if (r.sport_canonical)  parts.push(`sport=${r.sport_canonical}`);
      if (r.league_canonical) parts.push(`league=${r.league_canonical}`);
      return parts.length === 0 ? 'none' : parts.join(',');
    };

    const cached = await query<{ canonical_subject: string }>(
      `SELECT canonical_subject FROM entity_subjects
       WHERE subject_text = $1
         AND (domain_category = $2 OR domain_category = 'other' OR $2 = 'other')
       ORDER BY CASE WHEN domain_category = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [subjectLower, domain],
    );
    const cachedCanonical = cached.length > 0 ? cached[0].canonical_subject : null;
    const cacheDiscriminatorConflict =
      cachedCanonical !== null && discriminatorConflict(subjectLower, cachedCanonical);
    if (cacheDiscriminatorConflict) {
      log.info(
        `entity_subjects cache INVALIDATED (W1-3 discriminator conflict): "${subject}" ` +
        `had stale "${cachedCanonical}" — re-resolving`,
      );
    }
    if (cachedCanonical !== null && !cacheDiscriminatorConflict && scopeCompatible(cachedCanonical)) {
      // Re-run T1 in case an entity was added/enriched since this cache entry was written.
      const freshT1 = await this.tier1(subjectLower, subject, domain, scope);
      if (freshT1 && freshT1.canonical !== cachedCanonical) {
        log.info(
          `Stale entity_subjects cache healed: "${subject}" ` +
          `"${cachedCanonical}" → "${freshT1.canonical}" [T1 override]`,
        );
        await query(
          `UPDATE entity_subjects SET canonical_subject = $1
           WHERE subject_text = $2
             AND (domain_category = $3 OR domain_category = 'other' OR $3 = 'other')`,
          [freshT1.canonical, subjectLower, domain],
        );
        return freshT1.canonical;
      }
      return cachedCanonical;
    }

    let embedding: number[];
    try {
      const provider = getProvider('openai');
      const result = await provider.embed!([subjectLower]);
      embedding = result[0];
    } catch (err) {
      log.warn(`Embedding failed for "${subject}": ${err}. Falling back.`);
      return subject;
    }

    const pgEmbedding = `[${embedding.join(',')}]`;

    // Top 5, not 1, so the scope filter below has alternates.
    const nearest = await query<{ canonical_subject: string; distance: number }>(
      `SELECT canonical_subject, (embedding <=> $1::vector) AS distance
         FROM entity_subjects
        WHERE domain_category = $2 OR domain_category = 'other' OR $2 = 'other'
        ORDER BY embedding <=> $1::vector
        LIMIT 5`,
      [pgEmbedding, domain],
    );

    let resolved = subject;
    const queryNumericTokens = extractNumericTokens(subjectLower);
    for (const cand of nearest) {
      const cosine = 1 - cand.distance;
      if (cosine < COSINE_MIN) break; // cosine-ordered: no later candidate qualifies
      const newTokens = tokenize(subjectLower);
      const existTokens = new Set(tokenize(cand.canonical_subject.toLowerCase()));
      const sharedTokens = newTokens.filter(t => existTokens.has(t));
      const entitySharedTokens = sharedTokens.filter(t => !T2_CONTEXT_TOKENS.has(t));
      if (entitySharedTokens.length < 1) continue;
      // `tokenize` drops sub-3-char tokens, so numeric tokens disambiguate names differing by e.g. district number.
      const candNumericTokens = extractNumericTokens(cand.canonical_subject.toLowerCase());
      if (queryNumericTokens.size > 0 || candNumericTokens.size > 0) {
        const numericIntersects = [...queryNumericTokens].some((n) => candNumericTokens.has(n));
        if (!numericIntersects) {
          log.info(
            `Tier-2 numeric-rejected: "${subject}" vs "${cand.canonical_subject}" ` +
            `(cosine=${cosine.toFixed(3)}, query-nums=[${[...queryNumericTokens].join(',')}] ` +
            `vs cand-nums=[${[...candNumericTokens].join(',')}])`,
          );
          continue;
        }
      }
      if (discriminatorConflict(subjectLower, cand.canonical_subject)) {
        log.info(
          `Tier-2 discriminator-rejected: "${subject}" vs "${cand.canonical_subject}" ` +
          `(cosine=${cosine.toFixed(3)} — office/metric/party disagreement)`,
        );
        continue;
      }
      if (!scopeCompatible(cand.canonical_subject)) {
        log.debug(
          `Tier-2 scope-rejected: "${subject}" vs "${cand.canonical_subject}" ` +
          `(cosine=${cosine.toFixed(3)}, want${fmtScope(scope)}, cand-scope=${candScopeDesc(cand.canonical_subject)})`,
        );
        continue;
      }
      resolved = cand.canonical_subject;
      log.info(
        `Tier-2 embedding: "${subject}" → "${resolved}" ` +
        `(cosine=${cosine.toFixed(3)}, shared=[${sharedTokens.join(',')}]${fmtScope(scope)})`,
      );
      break;
    }

    try {
      await query(
        `INSERT INTO entity_subjects (subject_text, canonical_subject, embedding, domain_category)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (subject_text, domain_category) DO UPDATE SET
           canonical_subject = EXCLUDED.canonical_subject`,
        [subjectLower, resolved, pgEmbedding, domain],
      );
    } catch (err) {
      log.warn(`Failed to persist entity_subjects for "${subject}": ${err}`);
    }

    return resolved;
  }
}

// Tier 1 (alias/canonical lookup, type-filtered) -> Tier 3 (auto-create). No embedding tier:
// a repeated name resolves via canonical/alias lookup on the second call.
class StructuralEntityResolver extends EntityResolver {
  private readonly label: string;
  private readonly primaryType: EntityType;
  private readonly _cache = new Map<string, KBLookupResult>();
  private readonly useEmbedding: boolean;
  private _embedByCanonical: Map<string, number[]> | null = null;
  private _embedLoadPromise: Promise<void> | null = null;

  constructor(types: EntityType[], label: string, options: { useEmbedding?: boolean } = {}) {
    super(types as string[]);
    this.label = label;
    this.primaryType = types[0];
    this.useEmbedding = options.useEmbedding === true;
    registerKBCacheInvalidator(() => this._cache.clear());
  }

  // extraMetadata is merged into the metadata JSONB on T3 creation only; no effect on an existing-row T1 hit.
  async resolve(
    text: string,
    domain = 'other',
    extraMetadata?: Record<string, unknown>,
    options: ResolveOptions = {},
  ): Promise<KBLookupResult | null> {
    if (!text?.trim()) return null;
    const trimmed = text.trim();
    const trimmedLower = trimmed.toLowerCase();
    // Must match the SQL's unaccent-based lookup so cache and SQL agree.
    const trimmedFolded = foldAscii(trimmedLower);
    const incomingSport = typeof extraMetadata?.sport_canonical === 'string'
      ? extraMetadata.sport_canonical : null;
    const tf = this.typeFilter as string[] | null;

    // Keyed by the folded form so "Atletico" and "Atlético" share an entry.
    const cacheKey = `${trimmedFolded}:${domain}:${incomingSport ?? ''}`;
    const hasOptions = Object.keys(options).length > 0;
    if ((!extraMetadata || Object.keys(extraMetadata).length === 0) && !hasOptions) {
      const hit = this._cache.get(cacheKey);
      if (hit) return hit;
    }

    const cachedRows = await query<KBLookupResult>(
      `SELECT id, canonical FROM known_entities
       WHERE (lower(immutable_unaccent(canonical)) = $1
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(aliases) a
                WHERE lower(immutable_unaccent(a)) = $1
              ))
         AND ($3::text[] IS NULL OR type = ANY($3::text[]))
         AND ($4::text IS NULL OR sport_canonical IS NULL OR sport_canonical = $4)
       ORDER BY
         CASE WHEN lower(immutable_unaccent(canonical)) = $1 THEN 0 ELSE 1 END,
         CASE WHEN $4::text IS NOT NULL AND sport_canonical = $4 THEN 0
              WHEN sport_canonical IS NULL THEN 1
              ELSE 2 END,
         CASE WHEN domain_category = $2 THEN 0
              WHEN domain_category = 'other' OR $2 = 'other' THEN 1
              ELSE 2 END,
         -- deterministic tie-break: folded canonical text, then id
         lower(immutable_unaccent(canonical)) ASC,
         id ASC
       LIMIT 1`,
      [trimmedFolded, domain, tf, incomingSport],
    );
    const cached = cachedRows.length > 0 ? cachedRows[0] : null;

    if (cached) {
      // Enrich unset fields only (first-write wins for structural metadata).
      if (extraMetadata && Object.keys(extraMetadata).length > 0) {
        await query(
          `UPDATE known_entities
           SET metadata   = ($1::jsonb || metadata),
               updated_at = NOW()
           WHERE id = $2
             AND (metadata IS NULL OR NOT (metadata @> $1::jsonb))`,
          [JSON.stringify(extraMetadata), cached.id],
        );
      }
      log.info(`[${this.label}] "${text.trim()}" → "${cached.canonical}" [T1]`);
      this._cache.set(cacheKey, cached);
      return cached;
    }

    if (this.useEmbedding) {
      const t2Hit = await this.tier2(trimmed, trimmedLower, domain, incomingSport);
      if (t2Hit) {
        log.info(`[${this.label}] "${text.trim()}" → "${t2Hit.canonical}" [T2]`);
        this._cache.set(cacheKey, t2Hit);
        return t2Hit;
      }
    }

    // Serialise same-fold creates so a concurrent caller finds the first caller's committed row
    // instead of racing a duplicate insert.
    return keyedSerialize<KBLookupResult | null>(foldVariantSerializeKey(trimmed, this.primaryType), async () => {
      const reCheckRows = await query<KBLookupResult>(
        `SELECT id, canonical FROM known_entities
         WHERE (lower(immutable_unaccent(canonical)) = $1
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(aliases) a
                  WHERE lower(immutable_unaccent(a)) = $1
                ))
           AND ($2::text[] IS NULL OR type = ANY($2::text[]))
           AND ($3::text IS NULL OR sport_canonical IS NULL OR sport_canonical = $3)
         ORDER BY CASE WHEN lower(immutable_unaccent(canonical)) = $1 THEN 0 ELSE 1 END
         LIMIT 1`,
        [trimmedFolded, tf, incomingSport],
      );
      if (reCheckRows.length > 0) return reCheckRows[0];

      const crossTypeRows = await query<{ type: string }>(
        `SELECT type FROM known_entities
         WHERE lower(immutable_unaccent(canonical)) = $1
           AND type IN ('sport','league','competition','data_provider')
           AND type <> ALL($2::text[])
         LIMIT 1`,
        [trimmedFolded, tf ?? []],
      );
      if (crossTypeRows.length > 0) {
        log.warn(`[${this.label}] refusing T3 create — canonical "${trimmedLower}" already exists as type=${crossTypeRows[0].type}`);
        return null;
      }

      const metadata = { kind: this.primaryType, ...(extraMetadata ?? {}) };

      const storedCanonical = options.lowercaseCanonical ? trimmedLower : trimmed;
      const effectiveDomain = options.forceSportsDomain ? 'sports' : domain;

      const aliasSet = new Map<string, string>();
      for (const a of options.aliases ?? []) {
        const aLower = a.trim().toLowerCase();
        if (aLower && aLower !== storedCanonical.toLowerCase()) {
          aliasSet.set(aLower, aLower);
        }
      }
      const finalAliases = Array.from(aliasSet.values());

      // T1 only folds diacritics, not despacing; route despace variants through the same
      // fold-variant bridge as findOrCreateEntity to avoid forking a duplicate row.
      const entLike: ResolvedEntity = {
        canonical: storedCanonical,
        type: this.primaryType,
        aliases: finalAliases,
        metadata: metadata as ResolvedEntity['metadata'],
      };
      const incomingScope = getIncomingScope(metadata);
      const bridgeHit = await findFoldVariantBridge(
        entLike,
        storedCanonical.toLowerCase(),
        effectiveDomain as DomainCategory,
        incomingScope,
      );
      if (bridgeHit) {
        // Not a new row: no insert, no enqueue enrichment.
        await maybePromoteCanonical(bridgeHit.row.id, bridgeHit.row.canonical, storedCanonical);
        await mergeAliases(bridgeHit.row.id, bridgeHit.row.aliases, finalAliases);
        await mergeAliasVariants(bridgeHit.row.id);
        await mergeEntityMetadata(bridgeHit.row.id, this.primaryType, metadata);
        log.info(
          `[${this.label}] "${text.trim()}" bridged to existing "${bridgeHit.row.canonical}" ` +
          `(id=${bridgeHit.row.id}, kind=${bridgeHit.kind})`,
        );
        const bridgedRow: KBLookupResult = { id: bridgeHit.row.id, canonical: bridgeHit.row.canonical };
        this._cache.set(cacheKey, bridgedRow);
        const mb = metadata as { sport_canonical?: string | null; league_canonical?: string | null } | undefined;
        _kbCacheInsert({
          id: bridgeHit.row.id,
          canonical: bridgeHit.row.canonical,
          domain_category: effectiveDomain,
          type: this.primaryType,
          aliases: finalAliases,
          sport_canonical:  mb?.sport_canonical  ?? null,
          league_canonical: mb?.league_canonical ?? null,
        });
        return bridgedRow;
      }

      const created = await upsertKnownEntity(
        {
          canonical: storedCanonical,
          type: this.primaryType,
          aliases: finalAliases,
          metadata,
          domain_category: effectiveDomain,
        },
        { initialEnrichmentStatus: options.initialEnrichmentStatus },
      );
      log.info(`[${this.label}] "${text.trim()}" → "${created.canonical}" [T3 created]`);
      const cachedRow: KBLookupResult = { id: created.id, canonical: created.canonical };
      this._cache.set(cacheKey, cachedRow);
      const m = metadata as { sport_canonical?: string | null; league_canonical?: string | null } | undefined;
      _kbCacheInsert({
        id: created.id,
        canonical: created.canonical,
        domain_category: effectiveDomain,
        type: this.primaryType,
        aliases: finalAliases,
        sport_canonical:  m?.sport_canonical  ?? null,
        league_canonical: m?.league_canonical ?? null,
      });
      if (created.newRow) {
        enqueueEntityEnrichment([created.id], `structural:${this.label}:created`).catch((err) => {
          log.warn(`Failed to enqueue enrichment for new ${this.label} ${created.id}: ${err}`);
        });
      }
      if (this.useEmbedding && this._embedByCanonical) {
        try {
          const provider = getProvider('openai');
          const [emb] = await provider.embed!([created.canonical.toLowerCase()]);
          this._embedByCanonical.set(created.canonical, emb);
        } catch {
          /* best-effort */
        }
      }
      return cachedRow;
    });
  }

  private async tier2(
    rawText: string,
    rawLower: string,
    domain: string,
    incomingSport: string | null,
  ): Promise<KBLookupResult | null> {
    const COSINE_MIN = parseFloat(process.env.STRUCTURAL_EMBED_COSINE_MIN ?? '0.88');
    void domain; // not yet used for filtering

    await this.ensureEmbedCacheLoaded();
    if (!this._embedByCanonical || this._embedByCanonical.size === 0) return null;

    let queryEmbedding: number[];
    try {
      const provider = getProvider('openai');
      const [emb] = await provider.embed!([rawLower]);
      queryEmbedding = emb;
    } catch (err) {
      log.warn(`[${this.label}] T2 embedding failed for "${rawText}": ${err}`);
      return null;
    }

    let best: { canonical: string; cosine: number } | null = null;
    for (const [canonical, emb] of this._embedByCanonical) {
      const c = cosineSimilarity(queryEmbedding, emb);
      if (!best || c > best.cosine) best = { canonical, cosine: c };
    }
    if (!best || best.cosine < COSINE_MIN) return null;

    // Acronym carve-out: accept zero shared significant tokens when one side spells the other's initials.
    const queryTokens = new Set(tokenize(rawLower));
    const candTokens  = new Set(tokenize(best.canonical.toLowerCase()));
    let sharedSignificant = 0;
    for (const t of queryTokens) {
      if (candTokens.has(t) && !STRUCTURAL_T2_STOPWORDS.has(t)) sharedSignificant++;
    }
    const acronymBridge =
      sharedSignificant < 1 &&
      (looksLikeAcronymOf(rawText, best.canonical)
       || looksLikeAcronymOf(best.canonical, rawText));
    if (sharedSignificant < 1 && !acronymBridge) {
      log.info(
        `[${this.label}] T2 rejected "${rawText}" vs "${best.canonical}" — ` +
        `cosine=${best.cosine.toFixed(3)} but no shared significant token`,
      );
      return null;
    }

    // Numeric tokens tell apart names differing only by a number; reject if they don't intersect.
    const queryNums = extractNumericTokens(rawLower);
    const candNums  = extractNumericTokens(best.canonical.toLowerCase());
    if (queryNums.size > 0 || candNums.size > 0) {
      const intersects = [...queryNums].some((n) => candNums.has(n));
      if (!intersects) {
        log.info(
          `[${this.label}] T2 rejected "${rawText}" vs "${best.canonical}" — ` +
          `cosine=${best.cosine.toFixed(3)} but numeric tokens diverge ` +
          `(query=[${[...queryNums].join(',')}] vs cand=[${[...candNums].join(',')}])`,
        );
        return null;
      }
    }

    const rows = await query<KBLookupResult & { sport_canonical: string | null }>(
      `SELECT id, canonical, sport_canonical
         FROM known_entities
        WHERE lower(canonical) = $1
          AND type = ANY($2::text[])
        LIMIT 1`,
      [best.canonical.toLowerCase(), this.typeFilter as string[]],
    );
    if (rows.length === 0) return null;

    if (incomingSport && rows[0].sport_canonical
        && !areSportsCompatible(rows[0].sport_canonical, incomingSport)) {
      log.debug(
        `[${this.label}] T2 scope-rejected "${rawText}" → "${best.canonical}" ` +
        `(cosine=${best.cosine.toFixed(3)}, sport=${rows[0].sport_canonical} ≠ incoming=${incomingSport})`,
      );
      return null;
    }

    log.info(
      `[${this.label}] T2 match: "${rawText}" → "${best.canonical}" ` +
      `(cosine=${best.cosine.toFixed(3)}, shared=${sharedSignificant}${acronymBridge ? ', acronym-bridge' : ''})`,
    );
    return { id: rows[0].id, canonical: rows[0].canonical };
  }

  private async ensureEmbedCacheLoaded(): Promise<void> {
    if (this._embedByCanonical) return;
    if (this._embedLoadPromise) return this._embedLoadPromise;
    this._embedLoadPromise = (async () => {
      const rows = await query<{ canonical: string }>(
        `SELECT canonical FROM known_entities WHERE type = ANY($1::text[])`,
        [this.typeFilter as string[]],
      );
      if (rows.length === 0) {
        this._embedByCanonical = new Map();
        return;
      }
      const canonicals = rows.map((r) => r.canonical);
      try {
        const provider = getProvider('openai');
        const embeddings = await provider.embed!(canonicals.map((c) => c.toLowerCase()));
        this._embedByCanonical = new Map(canonicals.map((c, i) => [c, embeddings[i]!]));
        log.info(`[${this.label}] T2 cache loaded: ${this._embedByCanonical.size} embeddings`);
      } catch (err) {
        log.warn(`[${this.label}] T2 cache load failed: ${err}. T2 disabled this session.`);
        this._embedByCanonical = new Map(); // poisoned-empty to skip further attempts
      }
    })();
    return this._embedLoadPromise;
  }
}

/** Leading zeros are stripped so "04" matches "4" but not "8". */
function extractNumericTokens(text: string): Set<number> {
  const matches = text.match(/\d+/g) ?? [];
  const out = new Set<number>();
  for (const m of matches) {
    const n = parseInt(m, 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

// Two phrases differing only in one axis word (office/metric/party) are different real-world
// subjects even at high cosine similarity. Trifecta control tuples ("D-House") are parsed
// separately since `tokenize` drops the single-letter discriminator.
const DISCRIMINATOR_TOKEN_TO_AXIS_VALUE: ReadonlyMap<string, string> = new Map([
  ['governor', 'office:governor'], ['governors', 'office:governor'], ['gubernatorial', 'office:governor'],
  ['senate', 'office:senate'], ['senator', 'office:senate'], ['senators', 'office:senate'], ['senatorial', 'office:senate'],
  ['house', 'office:house'],
  ['mayor', 'office:mayor'], ['mayoral', 'office:mayor'],
  ['president', 'office:president'], ['presidential', 'office:president'],
  ['margin', 'metric:margin'], ['margins', 'metric:margin'],
  ['turnout', 'metric:turnout'],
  ['democratic', 'party:dem'], ['democrat', 'party:dem'], ['democrats', 'party:dem'],
  ['republican', 'party:rep'], ['republicans', 'party:rep'], ['gop', 'party:rep'],
]);

const CONTROL_TUPLE_RE = /\b([dr])-(house|senate|president)\b/g;

// Only the state side is stamped; a bare "X Senate" defaults to the federal seat.
const STATE_LEVEL_RX =
  /\b(?:state\s+(?:senate|house|assembly|legislature|legislative|senators?|representatives?|reps?)|statehouse|state\s+leg|general\s+assembly|legislature|legislative)\b/i;

const _EMPTY_STR_SET: ReadonlySet<string> = new Set();

function discriminatorAxisValues(text: string): Map<string, Set<string>> {
  const lower = text.toLowerCase();
  const out = new Map<string, Set<string>>();
  const add = (axis: string, val: string) => {
    let s = out.get(axis);
    if (!s) { s = new Set(); out.set(axis, s); }
    s.add(val);
  };
  const toks = tokenize(lower);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok === 'house' && i > 0 && toks[i - 1] === 'white') {
      add('office', 'president'); // "White House" -> executive, not chamber
      continue;
    }
    const av = DISCRIMINATOR_TOKEN_TO_AXIS_VALUE.get(tok);
    if (av === undefined) continue;
    const idx = av.indexOf(':');
    add(av.slice(0, idx), av.slice(idx + 1));
  }
  for (const m of lower.matchAll(CONTROL_TUPLE_RE)) {
    add('control', `${m[1]}-${m[2]}`);
  }
  if (STATE_LEVEL_RX.test(lower)) add('level', 'state');
  return out;
}

export function discriminatorConflict(a: string, b: string): boolean {
  const av = discriminatorAxisValues(a);
  const bv = discriminatorAxisValues(b);
  const axes = new Set<string>([...av.keys(), ...bv.keys()]);
  for (const axis of axes) {
    const as = av.get(axis) ?? _EMPTY_STR_SET;
    const bs = bv.get(axis) ?? _EMPTY_STR_SET;
    if (as.size !== bs.size) return true;
    for (const v of as) if (!bs.has(v)) return true;
  }
  return false;
}

const _MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const _MONTH_RX = new RegExp(`\\b(?:${_MONTHS})\\b`, 'i');
// Significant-word threshold is strictly > 5: >= 5 would wrongly demote real 5-word
// entities ("UEFA Champions League Top Scorer").
export function looksLikePredicate(s: string): boolean {
  const textLower = s.toLowerCase().trim();
  if (!textLower) return false;
  const significantWordCount = textLower
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3)
    .length;
  if (significantWordCount > 5) return true;
  if (/\b(score[sd]?|win[s]?|beat[s]?|los[et][s]?|end[s]?\s+in|permits?\s+for|starts?\s+for|inning\s+run|touchdown|first\s+\w+\s+(in|of)\b)\b/.test(textLower)) return true;
  if (/^(?:will|who|how many|what)\b/.test(textLower)) return true;
  if (/\b(?:highest|lowest|high|low)\s+temperature\b/.test(textLower)) return true;
  if (/\bprice\s+on\b/.test(textLower)) return true;
  if (/\betf\s+flows?\b/.test(textLower)) return true;
  if (/\bcloses\s+week\s+of\b/.test(textLower)) return true;
  if (/\bvoter\s+turnout\b/.test(textLower)) return true;
  if (/\bmargin of victory\b/.test(textLower)) return true;
  if (/\bapproval\s+rating\b/.test(textLower)) return true;
  if (/\b(?:gdp|unemployment\s+rate|inflation\s+rate)\b/.test(textLower)) return true;
  if (/_{2,}/.test(textLower)) return true;
  return false;
}

// A real name that happens to contain a number ("Schalke 04", "Team USA") is not flagged.
export function isNonEntityLabel(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (isPlaceholderCanonical(t)) return true;
  if (/\bup or down\b/i.test(t)) return true;
  if (/\b(?:up|down)\s+in\s+(?:the\s+)?next\b/i.test(t)) return true;
  if (/[↑↓▲▼]/.test(t)) return true;
  if (/\$\s?[\d,]/.test(t)) return true;
  if (/\d\s*%/.test(t)) return true;
  if (/°/.test(t)) return true;
  if (/\([+-]\d/.test(t)) return true;
  if (/\bhandicap\b/i.test(t)) return true;
  if (/[<>]\s*\d/.test(t)) return true;
  if (/\b(?:over\s*\/\s*under|o\s*\/\s*u|total\s+(?:goals?|cards?|points?|kills?|corners?|rounds?|maps?|sets?|runs?|hits?|assists?|rebounds?))\b/i.test(t)) return true;
  if (/\b\d{1,3}(?:,\d{3})+\b/.test(t)) return true;
  if (/\b(?:at least|at most|or above|or below|or higher|or lower|or more|or fewer|or less|above|below|over|under|exactly|precisely|(?:fewer|less|more|greater|no more)\s+than)\b/i.test(t) && /\d/.test(t)) return true;
  if (/^\D*\d+\s*\+\s*(?:pts?|points?|wins?|games?|times|seats?|runs?|goals?|votes?|home\s+runs?|yards?|strokes?|medals?|innings?|bps?|%)?\s*$/i.test(t)) return true;
  if (/,\s*\d+\s*\+/.test(t)) return true;
  if (/\b\d+\s*bps?\b/i.test(t)) return true;
  if (/\bbetween\s+\d+\s+and\s+\d/i.test(t)) return true;
  if (/\b\d+\s*[-–—]\s*\d+\s*(?:games?|min(?:ute)?s?|pts?|points?|seats?|runs?|goals?|innings?)\b/i.test(t)) return true;
  if (/:\s*(?:hits|runs|strikeouts|home\s+runs?|points|rebounds|assists|steals|blocks|saves|goals|yards|touchdowns)\s*$/i.test(t)) return true;
  // k/m/b are magnitude suffixes only; a real org spelled from k/m/b + digits ("B8", "M80")
  // is rescued at call sites via the kbHasRealEntity bypass.
  if (/^[\s\d.,:$%°+\-–↑↓()]*\d[\s\d.,:$%°+\-–↑↓()]*[kKmMbB]?$/.test(t)) return true;
  if (/^[\s.,:$%°+\-–↑↓()]+$/.test(t)) return true;
  // A bare single letter is a display-index placeholder; a real one is rescued via kbHasRealEntity.
  if (/^[A-Za-z]$/.test(t)) return true;
  if (_MONTH_RX.test(t) && /\b(?:19|20)\d{2}\b/.test(t)) return true;
  if (/\b(?:on|by|before|after)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(t)) return true;
  if (/\b(?:before|after|by)\b.*\d/i.test(t)) return true;
  if (/^\s*(?:19|20)\d{2}\s*$/.test(t)) return true;
  // "group" is intentionally not a placeholder noun ("Group A"/"Group I" are real entities).
  return false;
}

function _canonicalLegitimizes(canonical: string): boolean {
  const c = canonical.trim();
  if (!c) return false;
  if (isPlaceholderCanonical(c)) return false;
  if (isNonEntityLabel(c) && !/^\d{2,4}$/.test(c)) return false;
  return true;
}

export function kbHasRealEntitySync(name: string | null | undefined): boolean {
  const t = name?.trim();
  if (!t) return false;
  const legit = _kbNameRowsSync(t).filter((r) => _canonicalLegitimizes(r.canonical));
  if (legit.length === 0) return false;
  if (t.length > 2) return true;
  // ≤2-char strings: require a case-exact hit (fold-matching is too weak here).
  return legit.some((r) => r.canonical === t || r.aliases.includes(t));
}

export async function kbHasRealEntity(name: string | null | undefined): Promise<boolean> {
  if (!name?.trim()) return false;
  await _ensureKBCache();
  return kbHasRealEntitySync(name);
}

// Some platforms truncate same-city team labels to "<City> <single-letter>"; this is the
// catch-all for collisions not already seeded as exact aliases.
export function parseCitySingleLetter(subject: string): { cityPrefix: string; letter: string } | null {
  const t = subject.trim();
  const m = /^(.+?)\s+([A-Za-z])$/.exec(t);
  if (!m) return null;
  const cityPrefix = m[1].trim();
  if (!cityPrefix) return null;
  // Last prefix token must be alphabetic so a numeric/symbol fragment ("X 5 A") doesn't qualify.
  const prefixTokens = cityPrefix.split(/\s+/);
  const lastPrefixTok = prefixTokens[prefixTokens.length - 1];
  if (!/^[A-Za-z][A-Za-z.'-]*$/.test(lastPrefixTok)) return null;
  return { cityPrefix, letter: m[2].toUpperCase() };
}

export function countSameCityTeams(
  cityPrefix: string,
  rows: Iterable<KBRow>,
  sportHint: string | null,
): number {
  const prefFold = foldAscii(cityPrefix).toLowerCase();
  let n = 0;
  for (const r of rows) {
    if (r.type !== 'team') continue;
    const cFold = foldAscii(r.canonical).toLowerCase();
    // Must be a strict prefix of a longer name so the city/country row itself
    // is not counted as one of the colliding teams.
    if (!(cFold.length > prefFold.length + 1 && cFold.startsWith(prefFold + ' '))) continue;
    if (sportHint !== null && r.sport_canonical !== null
        && !areSportsCompatible(r.sport_canonical, sportHint)) continue;
    n++;
  }
  return n;
}

async function isAmbiguousSameCityTeam(subject: string, sportHint: string | null): Promise<boolean> {
  const parsed = parseCitySingleLetter(subject);
  if (!parsed) return false;
  await _ensureKBCache();
  const all: KBRow[] = [];
  for (const bucket of _kbByCanonical.values()) for (const r of bucket) all.push(r);
  return countSameCityTeams(parsed.cityPrefix, all, sportHint) >= 2;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    aMag += ai * ai;
    bMag += bi * bi;
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}

// T2 requires at least one shared token outside this set.
const STRUCTURAL_T2_STOPWORDS = new Set([
  'league', 'cup', 'series', 'championship', 'champions', 'tour', 'open',
  'tournament', 'finals', 'final', 'first', 'second', 'top', 'pro',
  'professional', 'national', 'international', 'the', 'of', 'and', 'club',
  'football', 'soccer', 'basketball', 'baseball', 'hockey', 'tennis',
  'golf', 'racing', 'sports', 'sport',
]);

const _subjectResolver = new SubjectEntityResolver();

export const leagueResolver = new StructuralEntityResolver(
  ['league', 'competition'],
  'league',
  { useEmbedding: true },
);

export const providerResolver = new StructuralEntityResolver(
  ['data_provider'],
  'provider',
);

export const sportResolver = new StructuralEntityResolver(
  ['sport'],
  'sport',
);

// Concurrent calls for the same (subject, domain, scope) tuple share one Promise; completed
// results are cached in `_resolvedSubjectCache` for the process lifetime.
export async function resolveSubjectViaKB(
  subject: string,
  domainCategory: DomainCategory = 'other',
  scope: KBScope | null = null,
): Promise<string> {
  if (!subject || subject.trim().length === 0) return subject;
  const sportKey  = scope?.sport  ?? '';
  const leagueKey = scope?.league ?? '';
  const key = `subject:${subject.toLowerCase().trim()}:${domainCategory}:${sportKey}:${leagueKey}`;
  const cached = _resolvedSubjectCache.get(key);
  if (cached !== undefined) return cached;
  const result = await singleFlight(key, () =>
    _subjectResolver.resolveCanonical(subject, domainCategory, scope),
  );
  _resolvedSubjectCache.set(key, result);
  return result;
}

// `participants` includes the resolved subject (Stage 2's hash-key bucketing relies on this)
// unless the subject is a non-entity label (e.g. draw legs stamp 'Draw', which stays literal).
export async function resolveSubjectAndParticipants(
  subject: string,
  participants: readonly string[] | null | undefined,
  domain: DomainCategory,
  scope: KBScope | null = null,
): Promise<{ subject: string; participants: string[] }> {
  const resolvedSubject = await resolveSubjectViaKB(subject, domain, scope);
  const subjectIsNonEntity = isNonEntityLabel(resolvedSubject);
  if (!participants || participants.length === 0) {
    return { subject: resolvedSubject, participants: subjectIsNonEntity ? [] : [resolvedSubject] };
  }
  const resolved = await Promise.all(
    participants.map((p) => resolveSubjectViaKB(p, domain, scope)),
  );
  const set = new Set<string>(resolved);
  if (!subjectIsNonEntity) set.add(resolvedSubject);
  return { subject: resolvedSubject, participants: [...set].sort() };
}
