import { parseJsonbArray, parseJsonbObject } from '@arb/db';

// Shared types + SQL fragments for the three near-duplicate entity-row loaders
// in the enrichment subsystem (worker.ts loadEntities/loadEntitySnapshots,
// merge-probe.ts findMergeCandidates) — edit a base column here, not per-query.

export interface BaseEntityRow {
  id: number;
  canonical: string;
  type: string;
  aliases: string[];
  domain_category: string;
  metadata: Record<string, unknown>;
  enrichment_status: string;
  sample_titles: string[];
}

export const BASE_ENTITY_COLUMNS = `ke.id, ke.canonical, ke.type, ke.aliases,
            ke.domain_category, ke.metadata, ke.enrichment_status`;

export const SAMPLE_TITLES_COLUMN = `COALESCE(samples.titles, ARRAY[]::text[]) AS sample_titles`;
export const SAMPLE_DESCRIPTIONS_COLUMN = `COALESCE(samples.descriptions, ARRAY[]::text[]) AS sample_descriptions`;
export const SAMPLE_PLATFORMS_COLUMN = `COALESCE(samples.platforms, ARRAY[]::text[]) AS sample_platforms`;

// Pair with at least SAMPLE_TITLES_COLUMN in the SELECT list; requires the outer query to alias known_entities as `ke`.
export const SAMPLE_TITLES_LATERAL = `LEFT JOIN LATERAL (
       SELECT array_agg(m.title       ORDER BY m.synced_at DESC) FILTER (WHERE m.title IS NOT NULL) AS titles,
              array_agg(m.description ORDER BY m.synced_at DESC) FILTER (WHERE m.title IS NOT NULL) AS descriptions,
              array_agg(m.platform    ORDER BY m.synced_at DESC) FILTER (WHERE m.title IS NOT NULL) AS platforms
       FROM (
         SELECT m.title, m.description, m.platform, m.synced_at FROM market_entity_links mel
         JOIN markets m ON m.id = mel.market_id
         WHERE mel.entity_id = ke.id
         ORDER BY m.synced_at DESC LIMIT 3
       ) m
     ) samples ON TRUE`;

export const CO_ENTITIES_CANONICALS_COLUMN = `COALESCE(co_ents.canonicals, ARRAY[]::text[]) AS co_entity_canonicals`;
export const CO_ENTITIES_TYPES_COLUMN = `COALESCE(co_ents.types, ARRAY[]::text[]) AS co_entity_types`;

// Pair with CO_ENTITIES_CANONICALS_COLUMN + CO_ENTITIES_TYPES_COLUMN; requires `ke` as the outer alias. Only enriched neighbours, to avoid propagating sparse-stub hints.
export const CO_ENTITIES_LATERAL = `LEFT JOIN LATERAL (
       SELECT array_agg(canonical ORDER BY co_count DESC) AS canonicals,
              array_agg(type      ORDER BY co_count DESC) AS types
       FROM (
         SELECT ke2.canonical, ke2.type, count(*) AS co_count
         FROM market_entity_links mel1
         JOIN market_entity_links mel2
           ON mel2.market_id = mel1.market_id AND mel2.entity_id <> ke.id
         JOIN known_entities ke2 ON ke2.id = mel2.entity_id
         WHERE mel1.entity_id = ke.id
           AND ke2.enrichment_status = 'enriched'
         GROUP BY ke2.canonical, ke2.type
         ORDER BY co_count DESC
         LIMIT 3
       ) top_co
     ) co_ents ON TRUE`;

export const PARENT_EVENT_TITLES_COLUMN = `COALESCE(parent_events.platforms, ARRAY[]::text[]) AS parent_event_platforms`;
export const PARENT_EVENT_TITLE_VALUES_COLUMN = `COALESCE(parent_events.titles, ARRAY[]::text[]) AS parent_event_titles`;

// Pair with both PARENT_EVENT_*_COLUMN constants; requires `ke` as the outer alias. DISTINCT ON (m.platform) collapses to one row per platform.
export const PARENT_EVENT_TITLES_LATERAL = `LEFT JOIN LATERAL (
       SELECT array_agg(platform ORDER BY platform) AS platforms,
              array_agg(title    ORDER BY platform) AS titles
       FROM (
         SELECT DISTINCT ON (m.platform) m.platform,
                LEFT(pe.title, 160) AS title
         FROM market_entity_links mel
         JOIN markets m ON m.id = mel.market_id
         JOIN platform_events pe ON pe.platform = m.platform
                                AND pe.platform_event_id = m.platform_event_id
         WHERE mel.entity_id = ke.id
           AND pe.title IS NOT NULL
           AND pe.title <> ''
         ORDER BY m.platform, m.synced_at DESC
       ) per_platform
     ) parent_events ON TRUE`;

export interface EntitySnapshot extends BaseEntityRow {
  sport_canonical: string | null;
  league_canonical: string | null;
  market_link_count: number;
}

export const SNAPSHOT_SELECT_COLUMNS = `${BASE_ENTITY_COLUMNS},
            ke.sport_canonical, ke.league_canonical,
            COALESCE(lc.cnt, 0)::int AS market_link_count,
            ${SAMPLE_TITLES_COLUMN}`;

// Pair with SNAPSHOT_SELECT_COLUMNS; requires `ke` as the outer alias.
export const MARKET_LINK_COUNT_LATERAL = `LEFT JOIN LATERAL (
       SELECT count(*)::int AS cnt FROM market_entity_links WHERE entity_id = ke.id
     ) lc ON TRUE`;

// aliases + metadata are raw JSONB at this stage.
export interface RawEntitySnapshotRow {
  id: number;
  canonical: string;
  type: string;
  aliases: unknown;
  metadata: unknown;
  domain_category: string;
  enrichment_status: string;
  sample_titles: string[] | null;
  sport_canonical: string | null;
  league_canonical: string | null;
  market_link_count: number;
}

export function rowToEntitySnapshot(r: RawEntitySnapshotRow): EntitySnapshot {
  return {
    id: r.id,
    canonical: r.canonical,
    type: r.type,
    aliases: parseJsonbArray(r.aliases),
    domain_category: r.domain_category,
    metadata: parseJsonbObject(r.metadata),
    sport_canonical: r.sport_canonical,
    league_canonical: r.league_canonical,
    enrichment_status: r.enrichment_status,
    market_link_count: r.market_link_count,
    sample_titles: r.sample_titles ?? [],
  };
}

// Strips platform-specific boilerplate down to the entity-classification signal (e.g. kalshi's leading [kalshi:STRUCTURE] header, PM/Predict's resolution-boilerplate paragraphs); caps length so a long description can't blow the prompt budget.
export function extractUsefulDescription(
  description: string | null | undefined,
  platform: string,
): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  if (!trimmed) return null;

  let body = trimmed;
  if (platform === 'kalshi') {
    body = body.replace(/^\[kalshi:[^\]]+\]\s*/, '').trim();
    if (!body) return null;
  }

  const firstPara = body.split(/\n\s*\n/)[0]?.trim() ?? '';
  if (!firstPara) return null;

  if ((platform === 'polymarket' || platform === 'predict')
      && /^This market will resolve to/i.test(firstPara)) {
    return null;
  }

  const MAX_CHARS = platform === 'limitless' ? 250 : 200;
  if (firstPara.length <= MAX_CHARS) return firstPara;
  return firstPara.slice(0, MAX_CHARS).trimEnd() + '…';
}
