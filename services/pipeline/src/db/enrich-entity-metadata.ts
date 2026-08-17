/** Scraper-data → entity KB metadata seeder: infers sport/league/asset_class/role
 *  per linked entity from platform labels and merges via JSONB || (existing keys win). */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { EntityType, UnifiedCategory } from '@arb/types';
import { POLITICAL_CATEGORIES } from './category-taxonomy.js';
import { resolveTaxonomyCanonical } from './entity/taxonomy.js';

const log = createLogger('entity-metadata');

/** Tennis tour from a label bag; undefined when ambiguous (both tokens) or mixed. */
export function tennisTourFromLabels(labelText: string): 'ATP Tour' | 'WTA Tour' | undefined {
  if (/\bmixed\b|\bunited\s+cup\b/i.test(labelText)) return undefined;
  const wta = /\bwta\b/i.test(labelText);
  const atp = /\batp\b/i.test(labelText);
  if (wta && !atp) return 'WTA Tour';
  if (atp && !wta) return 'ATP Tour';
  return undefined;
}

/** Known league/sport keywords → canonical metadata pairs; specific leagues first. */
const LEAGUE_KEYWORDS: Array<{
  pattern: RegExp;
  league?: string;
  /** Signal-dependent league (e.g. ATP vs WTA); undefined demotes the match to sport-only. */
  deriveLeague?: (labelText: string) => string | undefined;
  sport: string;
}> = [
  { pattern: /\b(?:nba|national basketball)\b/i,                league: 'NBA',             sport: 'basketball' },
  { pattern: /\b(?:wnba)\b/i,                                   league: 'WNBA',            sport: 'basketball' },
  { pattern: /\b(?:ncaa(?:m|w|\s*basketball)?|march madness)\b/i, league: 'NCAA Basketball', sport: 'basketball' },
  { pattern: /\b(?:nfl|national football league|super bowl)\b/i, league: 'NFL',            sport: 'american football' },
  { pattern: /\b(?:cfb|college football)\b/i,                   league: 'NCAA Football',   sport: 'american football' },
  { pattern: /\b(?:mlb|world series|baseball)\b/i,              league: 'MLB',             sport: 'baseball' },
  { pattern: /\b(?:nhl|stanley cup)\b/i,                        league: 'NHL',             sport: 'ice hockey' },
  { pattern: /\b(?:premier league|epl)\b/i,                     league: 'Premier League',  sport: 'soccer' },
  { pattern: /\b(?:la\s*liga|laliga)\b/i,                       league: 'La Liga',         sport: 'soccer' },
  { pattern: /\b(?:bundesliga)\b/i,                             league: 'Bundesliga',      sport: 'soccer' },
  { pattern: /\b(?:serie a)\b/i,                                league: 'Serie A',         sport: 'soccer' },
  { pattern: /\b(?:ligue 1|fl1)\b/i,                            league: 'Ligue 1',         sport: 'soccer' },
  { pattern: /\b(?:uefa champions league|champions league|ucl)\b/i, league: 'UEFA Champions League', sport: 'soccer' },
  { pattern: /\b(?:uefa europa league|europa league)\b/i,       league: 'UEFA Europa League', sport: 'soccer' },
  { pattern: /\b(?:uefa conference league|conference league)\b/i, league: 'UEFA Conference League', sport: 'soccer' },
  { pattern: /\b(?:fa cup)\b/i,                                 league: 'FA Cup',          sport: 'soccer' },
  { pattern: /\b(?:coppa italia)\b/i,                           league: 'Coppa Italia',    sport: 'soccer' },
  { pattern: /\b(?:mls)\b/i,                                    league: 'MLS',             sport: 'soccer' },
  { pattern: /\b(?:fifa world cup|world cup)\b/i,               league: 'FIFA World Cup',  sport: 'soccer' },
  // never stamp the fused 'ATP/WTA' label; derive the tour, or stamp sport='tennis' only when ambiguous
  { pattern: /\b(?:atp|wta|grand slam|us open|wimbledon|australian open|french open|roland garros|tennis)\b/i, deriveLeague: tennisTourFromLabels, sport: 'tennis' },
  { pattern: /\b(?:ufc|mma)\b/i,                                league: 'UFC',             sport: 'mma' },
  { pattern: /\b(?:nascar)\b/i,                                 league: 'NASCAR',          sport: 'nascar' },
  { pattern: /\b(?:pga|golf)\b/i,                               league: 'PGA',             sport: 'golf' },
  // sport-only: no KB league row for these tokens; stamping the sport as `league` would mint junk
  { pattern: /\b(?:boxing)\b/i,                                                    sport: 'boxing' },
  { pattern: /\b(?:cricket|ipl)\b/i,                                              sport: 'cricket' },
  { pattern: /\b(?:rugby)\b/i,                                                    sport: 'rugby union' },
  { pattern: /\b(?:formula\s*1|f1|grand prix)\b/i,                               sport: 'formula 1' },
  { pattern: /\b(?:cs2|cs:?go|counter[- ]strike)\b/i,                            sport: 'cs2' },
  { pattern: /\b(?:dota2?)\b/i,                                                   sport: 'dota 2' },
  { pattern: /\b(?:lol|league of legends)\b/i,                                    sport: 'league of legends' },
  { pattern: /\b(?:valorant)\b/i,                                                 sport: 'valorant' },

  { pattern: /\bfootball matches\b/i,                           sport: 'soccer' },
  { pattern: /\bclub_dominance\b/i,                             sport: 'soccer' },
  { pattern: /\boff the pitch\b/i,                              sport: 'soccer' },
  { pattern: /\b(?:esports?|e-sports?|competitive gaming)\b/i,                    sport: 'esports' },
];

/** Asset-class keywords. Order matters: more specific first. */
const ASSET_KEYWORDS: Array<{ pattern: RegExp; asset_class: 'crypto' | 'stock' | 'fx' | 'commodity' | 'index' }> = [
  { pattern: /\b(?:bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|crypto|altcoin|stablecoin|defi)\b/i, asset_class: 'crypto' },
  { pattern: /\b(?:s&p|nasdaq|dow|russell|index)\b/i,                                              asset_class: 'index' },
  { pattern: /\b(?:oil|wti|brent|gold|silver|gas|commodity)\b/i,                                   asset_class: 'commodity' },
  { pattern: /\b(?:fx|forex|usd|eur|jpy|gbp|currenc)\b/i,                                          asset_class: 'fx' },
  { pattern: /\b(?:stock|equity|company|earnings|nyse)\b/i,                                        asset_class: 'stock' },
];

export function detectLeagueAndSport(labels: string[]): { league?: string; sport?: string } {
  const text = labels.filter(Boolean).join(' | ');
  if (!text) return {};
  // first league-bearing match wins; a sport-only match still captures the sport
  let sportOnly: string | undefined;
  for (const k of LEAGUE_KEYWORDS) {
    if (!k.pattern.test(text)) continue;
    if (k.deriveLeague) {
      const derived = k.deriveLeague(text);
      if (derived) return { league: derived, sport: k.sport };
      if (!sportOnly) sportOnly = k.sport;
      continue;
    }
    if (k.league) return { league: k.league, sport: k.sport };
    if (!sportOnly) sportOnly = k.sport;
  }
  if (sportOnly) return { sport: sportOnly };
  return {};
}

function detectAssetClass(labels: string[]): 'crypto' | 'stock' | 'fx' | 'commodity' | 'index' | undefined {
  const text = labels.filter(Boolean).join(' | ');
  if (!text) return undefined;
  for (const k of ASSET_KEYWORDS) {
    if (k.pattern.test(text)) return k.asset_class;
  }
  return undefined;
}

/** Builds per-entity metadata patches from scraper-side labels of linked markets. */
async function buildPatches(entityIds: number[] | null): Promise<Map<number, { type: EntityType; patch: Record<string, unknown>; existingLeague: string | null }>> {
  const filterClause = entityIds ? `AND mel.entity_id = ANY($1::int[])` : '';
  const params: unknown[] = [];
  if (entityIds) params.push(entityIds);

  // predict/polymarket tag bags pre-aggregated once per distinct key, not per link row
  const rows = await query<{
    entity_id: number;
    type: EntityType;
    existing_role: string | null;
    existing_league: string | null;
    market_id: number;
    category: string | null;
    tags: string[] | null;
    category_unified: UnifiedCategory | null;
    predict_tag_names: string[] | null;
    poly_event_tags: string[] | null;
  }>(
    `WITH lnk AS (
       SELECT mel.entity_id, mel.market_id
       FROM market_entity_links mel
       WHERE TRUE ${filterClause}
     ),
     mkt AS (
       SELECT DISTINCT m.id, m.category, m.tags, m.category_unified, m.platform, m.platform_event_id
       FROM markets m
       JOIN lnk ON lnk.market_id = m.id
     ),
     predict_bag AS (
       SELECT c.category, ARRAY(
                SELECT (t->>'name')
                FROM predict_categories pc
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
                WHERE pc.slug = c.category AND t->>'name' IS NOT NULL
              ) AS names
       FROM (SELECT DISTINCT category FROM mkt WHERE platform = 'predict' AND category IS NOT NULL) c
     ),
     poly_bag AS (
       SELECT e.pe_id, ARRAY(
                SELECT (t->>'label')
                FROM polymarket_events pe
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pe.raw->'tags', '[]'::jsonb)) t
                WHERE pe.id = e.pe_id AND t->>'label' IS NOT NULL
              ) AS labels
       FROM (SELECT DISTINCT platform_event_id AS pe_id FROM mkt WHERE platform = 'polymarket' AND platform_event_id IS NOT NULL) e
     )
     SELECT lnk.entity_id, ke.type, ke.metadata->>'role' AS existing_role,
            ke.metadata->>'league_canonical' AS existing_league, mkt.id AS market_id,
            mkt.category, mkt.tags, mkt.category_unified,
            CASE WHEN mkt.platform = 'predict'    THEN pb.names  ELSE NULL END AS predict_tag_names,
            CASE WHEN mkt.platform = 'polymarket' THEN qb.labels ELSE NULL END AS poly_event_tags
       FROM lnk
       JOIN known_entities ke ON ke.id = lnk.entity_id
       JOIN mkt               ON mkt.id = lnk.market_id
       LEFT JOIN predict_bag pb ON mkt.platform = 'predict'    AND pb.category = mkt.category
       LEFT JOIN poly_bag    qb ON mkt.platform = 'polymarket' AND qb.pe_id   = mkt.platform_event_id`,
    params
  );

  const labelsByEntity = new Map<number, { type: EntityType; existingRole: string | null; existingLeague: string | null; labels: string[]; categoriesUnified: Set<UnifiedCategory> }>();
  for (const r of rows) {
    let bucket = labelsByEntity.get(r.entity_id);
    if (!bucket) {
      bucket = { type: r.type, existingRole: r.existing_role, existingLeague: r.existing_league, labels: [], categoriesUnified: new Set() };
      labelsByEntity.set(r.entity_id, bucket);
    }
    if (r.category) bucket.labels.push(r.category);
    if (r.tags) bucket.labels.push(...r.tags);
    if (r.predict_tag_names) bucket.labels.push(...r.predict_tag_names);
    if (r.poly_event_tags) bucket.labels.push(...r.poly_event_tags);
    if (r.category_unified) bucket.categoriesUnified.add(r.category_unified);
  }

  const out = new Map<number, { type: EntityType; patch: Record<string, unknown>; existingLeague: string | null }>();
  for (const [entityId, bucket] of labelsByEntity) {
    const patch = inferPatch(bucket.type, bucket.labels, bucket.categoriesUnified, bucket.existingRole);
    // also include a row with an existing league (may need the sport-as-league heal)
    if (Object.keys(patch).length > 0 || bucket.existingLeague) {
      out.set(entityId, { type: bucket.type, patch, existingLeague: bucket.existingLeague });
    }
  }
  return out;
}

/** Roles that corroborate a person's sport_canonical stamp; any other role withholds it. */
const ATHLETIC_ROLES: ReadonlySet<string> = new Set(['athlete', 'coach']);

/** Maps (entity type, labels, unified categories, existing role) → a metadata patch.
 *  `existingRole` gates the person sport stamp — see {@link ATHLETIC_ROLES}. */
export function inferPatch(
  type: EntityType,
  labels: string[],
  unified: Set<UnifiedCategory>,
  existingRole: string | null = null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const isSports = unified.has('sports');
  const isCrypto = unified.has('crypto');
  const isElections = [...POLITICAL_CATEGORIES].some((c) => unified.has(c));
  const isEntertainment = unified.has('entertainment');

  switch (type) {
    case 'team': {
      const ls = detectLeagueAndSport(labels);
      if (ls.league)   patch.league_canonical = ls.league;
      if (ls.sport)    patch.sport_canonical  = ls.sport;
      break;
    }
    case 'league': {
      const ls = detectLeagueAndSport(labels);
      if (ls.sport)    patch.sport_canonical  = ls.sport;
      break;
    }
    case 'competition': {
      const ls = detectLeagueAndSport(labels);
      if (ls.league)   patch.league_canonical = ls.league;
      if (ls.sport)    patch.sport_canonical  = ls.sport;
      break;
    }
    case 'person': {
      if (isSports) {
        patch.role = 'athlete';
      } else if (isElections) {
        patch.role = 'politician';
      } else if (isEntertainment) {
        patch.role = 'celebrity';
      }
      if (existingRole != null && ATHLETIC_ROLES.has(existingRole)) {
        const ls = detectLeagueAndSport(labels);
        if (ls.sport) patch.sport_canonical = ls.sport;
      }
      break;
    }
    case 'asset': {
      const cls = detectAssetClass(labels) ?? (isCrypto ? 'crypto' : undefined);
      if (cls) patch.asset_class = cls;
      break;
    }
    default:
      break;
  }

  return patch;
}

/** Verdict for a `league_canonical` candidate: `keep` (KB league), `drop` (resolves as
 *  a KB sport instead — never a league), or `novel` (neither; leave the raw string). */
type LeagueVerdict = { action: 'keep'; value: string } | { action: 'drop' } | { action: 'novel' };
async function leagueVerdict(candidate: string): Promise<LeagueVerdict> {
  const asLeague = await resolveTaxonomyCanonical(candidate, 'league');
  if (asLeague) return { action: 'keep', value: asLeague };
  const asSport = await resolveTaxonomyCanonical(candidate, 'sport');
  if (asSport) return { action: 'drop' };
  return { action: 'novel' };
}

/** Applies the sport-as-league guard to a patch + existing league; returns keys to clear. */
async function guardLeaguePatch(
  patch: Record<string, unknown>,
  existingLeague: string | null,
): Promise<{ clearKeys: string[] }> {
  const clearKeys: string[] = [];
  if (typeof patch.league_canonical === 'string' && patch.league_canonical.trim()) {
    const v = await leagueVerdict(patch.league_canonical);
    if (v.action === 'keep') patch.league_canonical = v.value;
    else if (v.action === 'drop') delete patch.league_canonical;
  }
  if (!('league_canonical' in patch) && existingLeague && existingLeague.trim()) {
    const v = await leagueVerdict(existingLeague);
    if (v.action === 'drop') clearKeys.push('league_canonical');
  }
  return { clearKeys };
}

/** Applies a metadata patch to known_entities (existing keys win); soft-fails on a
 *  unique-constraint collision by logging and skipping. */
async function applyPatch(
  entityId: number, type: EntityType, patch: Record<string, unknown>, clearKeys: string[] = [],
): Promise<boolean> {
  const incoming = { kind: type, ...patch };
  if (Object.keys(patch).length === 0 && clearKeys.length === 0) return false;
  try {
    await query(
      `UPDATE known_entities
         SET metadata = ($2::jsonb || COALESCE(metadata, '{}'::jsonb)) - $3::text[],
             updated_at = NOW()
       WHERE id = $1`,
      [entityId, JSON.stringify(incoming), clearKeys]
    );
    return true;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; detail?: string };
    if (e?.code === '23505' && e?.constraint === 'known_entities_canonical_sport_league_key') {
      log.warn(
        `Skipping metadata patch on entity id=${entityId}: would collide on (canonical, sport, league). ` +
        `Detail: ${e.detail ?? ''}. Merge probe will resolve on next enrichment pass.`
      );
      return false;
    }
    throw err;
  }
}

/** Chunk size for the full-KB enrichment pass, so no single statement spans the whole set. */
const ENRICH_CHUNK_SIZE = 5000;

/** Batch version of {@link applyPatch}; falls back to per-row on a 23505 collision
 *  since the batch statement aborts entirely otherwise. */
async function applyPatchBatch(
  items: Array<{ entityId: number; type: EntityType; patch: Record<string, unknown>; clearKeys: string[] }>,
): Promise<number> {
  const writes = items.filter(
    (it) => Object.keys(it.patch).length > 0 || it.clearKeys.length > 0,
  );
  if (writes.length === 0) return 0;

  const payload = writes.map((it) => ({
    id: it.entityId,
    incoming: { kind: it.type, ...it.patch },
    clearkeys: it.clearKeys,
  }));

  try {
    const r = await query<{ id: number }>(
      `UPDATE known_entities ke
          SET metadata   = (u.incoming || COALESCE(ke.metadata, '{}'::jsonb)) - u.clearkeys,
              updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS u(id int, incoming jsonb, clearkeys text[])
        WHERE ke.id = u.id
       RETURNING ke.id`,
      [JSON.stringify(payload)],
    );
    return r.length;
  } catch (err) {
    const e = err as { code?: string };
    if (e?.code !== '23505') throw err;
    let n = 0;
    for (const it of writes) {
      if (await applyPatch(it.entityId, it.type, it.patch, it.clearKeys)) n++;
    }
    return n;
  }
}

/** Enriches entity metadata for entities linked to `marketIds` (or the whole KB when null). */
export async function enrichEntityMetadata(marketIds: number[] | null = null): Promise<{ entitiesUpdated: number }> {
  let entityIds: number[];
  if (marketIds && marketIds.length > 0) {
    const linked = await query<{ entity_id: number }>(
      `SELECT DISTINCT entity_id FROM market_entity_links WHERE market_id = ANY($1::int[])`,
      [marketIds]
    );
    entityIds = linked.map(r => r.entity_id);
    if (entityIds.length === 0) return { entitiesUpdated: 0 };
  } else {
    const all = await query<{ id: number }>(`SELECT id FROM known_entities ORDER BY id`);
    entityIds = all.map(r => r.id);
  }

  let updated = 0;
  for (let i = 0; i < entityIds.length; i += ENRICH_CHUNK_SIZE) {
    const chunk = entityIds.slice(i, i + ENRICH_CHUNK_SIZE);
    const patches = await buildPatches(chunk);
    const items: Array<{ entityId: number; type: EntityType; patch: Record<string, unknown>; clearKeys: string[] }> = [];
    for (const [entityId, { type, patch, existingLeague }] of patches) {
      const { clearKeys } = await guardLeaguePatch(patch, existingLeague);
      items.push({ entityId, type, patch, clearKeys });
    }
    updated += await applyPatchBatch(items);
  }
  return { entitiesUpdated: updated };
}

// tour_gender inheritance: a person athlete (role='athlete' only) inherits `tour_gender`
// from their league when it maps uniquely to {men,women}; never overwrites an existing value.

/** The tour_gender values a person may inherit from a league; `open`/`mixed`/null ⇒ no inheritance. */
export const INHERITABLE_TOUR_GENDERS: ReadonlySet<string> = new Set(['men', 'women']);

/** Pure decision helper: the tour_gender an athlete inherits from a league, or null. */
export function inheritedTourGender(
  personRole: string | null | undefined,
  leagueTourGender: string | null | undefined,
): 'men' | 'women' | null {
  if (personRole !== 'athlete') return null;
  if (leagueTourGender && INHERITABLE_TOUR_GENDERS.has(leagueTourGender)) {
    return leagueTourGender as 'men' | 'women';
  }
  return null;
}

/** Counts person-athletes who would inherit a tour_gender but don't carry one yet. */
export async function countPersonsNeedingTourGender(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM known_entities p
       JOIN (
         SELECT lower(le.canonical) AS lc, min(le.metadata->>'tour_gender') AS tg
         FROM known_entities le
         WHERE le.type = 'league'
           AND le.metadata->>'tour_gender' IN ('men','women')
         GROUP BY lower(le.canonical)
         HAVING count(DISTINCT le.metadata->>'tour_gender') = 1
       ) g ON g.lc = lower(p.metadata->>'league_canonical')
      WHERE p.type = 'person'
        AND p.metadata->>'role' = 'athlete'
        AND NOT (p.metadata ? 'tour_gender')`,
  );
  return r[0]?.n ?? 0;
}

/** Stamps `tour_gender` on person-athletes by inheriting it from their league. Idempotent. */
export async function inheritTourGenderFromLeague(): Promise<{ stamped: number }> {
  const r = await query<{ id: number }>(
    `UPDATE known_entities p
        SET metadata   = p.metadata || jsonb_build_object('tour_gender', g.tg),
            updated_at = NOW()
       FROM (
         SELECT lower(le.canonical) AS lc, min(le.metadata->>'tour_gender') AS tg
         FROM known_entities le
         WHERE le.type = 'league'
           AND le.metadata->>'tour_gender' IN ('men','women')
         GROUP BY lower(le.canonical)
         HAVING count(DISTINCT le.metadata->>'tour_gender') = 1
       ) g
      WHERE p.type = 'person'
        AND p.metadata->>'role' = 'athlete'
        AND lower(p.metadata->>'league_canonical') = g.lc
        AND NOT (p.metadata ? 'tour_gender')
      RETURNING p.id`,
  );
  return { stamped: r.length };
}
