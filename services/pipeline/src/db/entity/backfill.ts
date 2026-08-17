/**
 * Late KB rewriting — Stage 1f. Re-resolves every distinct canonical_subject
 * and participant phrase across `llm_market_normalizations` and
 * `platform_events` (the two tables that store entity NAMES as text, not FK)
 * and writes the corrected canonical back across every field that carries
 * them, so a KB merge/enrichment during this run propagates everywhere.
 * platform_events don't carry league_id, so an event's scope is derived from
 * its modal child market's league. Runs between Stage 1e and Stage 2; Stage 4
 * re-projects questions from the updated rows, so no questions UPDATE is needed.
 */

import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { unifiedToDomain } from '../category-taxonomy.js';
import { validNormalizationSql } from '../queries/normalization-predicates.js';
import { warmKBCache } from './cache.js';
import { resolveSubjectViaKB } from './resolvers.js';
import { deriveCanonicalEventCore } from '../../stage1-normalize/event-name-normalizer.js';

const log = createLogger('subject-backfill');

/** Scope is part of the key: a phrase can collide across sports ("Houston" basketball vs soccer). */
function scopeKey(phrase: string, domain: string, sport: string | null, league: string | null): string {
  return `${phrase}␟${domain}␟${sport ?? ''}␟${league ?? ''}`;
}

export async function backfillSubjectsViaKB(opts?: {
  /** Restrict to a specific set of market IDs (incremental mode). */
  marketIds?: number[];
}): Promise<{
  checked: number;
  updated: number;
  eventsUpdated: number;
  /** Rewritten normalization rows plus child markets of rewritten platform_events rows. */
  updatedMarketIds: number[];
}> {
  // Rewarms the in-process KB cache so it sees post-enrichment state, and clears
  // _resolvedSubjectCache so this run's earlier Stage-1b resolutions don't shadow corrections.
  await warmKBCache();

  const marketIdFilter = opts?.marketIds?.length;
  const marketWhereExtra = marketIdFilter ? 'AND n.market_id = ANY($1::int[])' : '';
  const marketParams: unknown[] = marketIdFilter ? [opts!.marketIds] : [];

  // The participants UNNEST surfaces opponent-position entities too (e.g. "Heidenheim"
  // in a Mainz market's participants[]), so a rename propagates everywhere it's stored.
  const marketPhraseRows = await query<{
    phrase: string;
    category_unified: string | null;
    sport_canonical: string | null;
    league_canonical: string | null;
  }>(
    `SELECT DISTINCT
       phrase,
       m.category_unified AS category_unified,
       le.sport_canonical AS sport_canonical,
       le.canonical       AS league_canonical
     FROM llm_market_normalizations n
     JOIN markets m              ON m.id = n.market_id
     LEFT JOIN known_entities le ON le.id = n.league_id
     CROSS JOIN LATERAL (
       SELECT n.canonical_subject AS phrase
       UNION ALL
       SELECT unnest(n.participants)
     ) AS phrases
     WHERE ${validNormalizationSql('n')}
       AND phrase IS NOT NULL
       AND length(phrase) > 0
       ${marketWhereExtra}`,
    marketParams
  );

  const eventWhereExtra = marketIdFilter
    ? `WHERE (pe.platform, pe.platform_event_id) IN (
         SELECT DISTINCT m.platform, m.platform_event_id
         FROM markets m
         WHERE m.id = ANY($1::int[])
           AND m.platform_event_id IS NOT NULL
       )
       AND pe.canonical_subject IS NOT NULL`
    : `WHERE pe.canonical_subject IS NOT NULL`;

  const eventPhraseRows = await query<{
    phrase: string;
    category_unified: string | null;
    sport_canonical: string | null;
    league_canonical: string | null;
  }>(
    `SELECT DISTINCT
       phrase,
       ce.category_unified AS category_unified,
       ce.sport_canonical  AS sport_canonical,
       ce.league_canonical AS league_canonical
     FROM platform_events pe
     CROSS JOIN LATERAL (
       SELECT pe.canonical_subject AS phrase
       UNION ALL
       SELECT unnest(pe.participants)
     ) AS phrases
     LEFT JOIN LATERAL (
       SELECT m.category_unified,
              le.sport_canonical,
              le.canonical AS league_canonical
       FROM markets m
       JOIN llm_market_normalizations n ON n.market_id = m.id
       LEFT JOIN known_entities le      ON le.id = n.league_id
       WHERE m.platform = pe.platform
         AND m.platform_event_id = pe.platform_event_id
       GROUP BY m.category_unified, le.sport_canonical, le.canonical
       ORDER BY COUNT(*) DESC
       LIMIT 1
     ) ce ON TRUE
     ${eventWhereExtra}
       AND phrase IS NOT NULL
       AND length(phrase) > 0`,
    marketParams
  );

  const renames = new Map<string, string>();       // scopeKey → resolved canonical
  const renameOldByKey = new Map<string, string>(); // scopeKey → old phrase
  const seenKeys = new Set<string>();
  let renameCount = 0;
  for (const row of [...marketPhraseRows, ...eventPhraseRows]) {
    const domain = unifiedToDomain(row.category_unified);
    const key = scopeKey(row.phrase, domain, row.sport_canonical, row.league_canonical);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const resolved = await resolveSubjectViaKB(
      row.phrase,
      domain,
      { sport: row.sport_canonical, league: row.league_canonical },
    );
    if (resolved === row.phrase) continue;
    renames.set(key, resolved);
    renameOldByKey.set(key, row.phrase);
    renameCount++;
  }

  const totalPhrasesChecked = seenKeys.size;
  if (renameCount === 0) {
    return { checked: totalPhrasesChecked, updated: 0, eventsUpdated: 0, updatedMarketIds: [] };
  }

  const oldPhrases = Array.from(new Set(renameOldByKey.values()));

  // Per-row rewrite, not bulk SQL: canonical_event for sports H2H needs the
  // alphabetized "<a> vs <b>" of the new KB canonicals (subject and opponent
  // come from different rows), and resolved_entities needs per-element JSONB rewrite.
  const candidateMarketRows = await query<{
    market_id: number;
    canonical_subject: string;
    participants: string[];
    canonical_event: string | null;
    resolved_entities: unknown;
    condition_shape: string | null;
    condition_metric: string | null;
    value_unit: string | null;
    event_kind: string | null;
    condition_date: string | null;
    category_unified: string | null;
    sport_canonical: string | null;
    league_canonical: string | null;
  }>(
    `SELECT
       n.market_id,
       n.canonical_subject,
       n.participants,
       n.canonical_event,
       n.resolved_entities,
       n.condition_shape,
       n.condition_metric,
       n.value_unit,
       n.event_kind,
       n.condition_date,
       m.category_unified AS category_unified,
       le.sport_canonical AS sport_canonical,
       le.canonical       AS league_canonical
     FROM llm_market_normalizations n
     JOIN markets m              ON m.id = n.market_id
     LEFT JOIN known_entities le ON le.id = n.league_id
     WHERE ${validNormalizationSql('n')}
       ${marketWhereExtra}
       AND (
         n.canonical_subject = ANY($${marketParams.length + 1}::text[])
         OR n.participants && $${marketParams.length + 1}::text[]
       )`,
    [...marketParams, oldPhrases]
  );

  let updated = 0;
  const updatedMarketIdSet = new Set<number>();
  for (const row of candidateMarketRows) {
    const domain = unifiedToDomain(row.category_unified);
    const scope = { sport: row.sport_canonical, league: row.league_canonical };

    const renameFor = (phrase: string): string => {
      const k = scopeKey(phrase, domain, scope.sport, scope.league);
      return renames.get(k) ?? phrase;
    };

    const newSubject = renameFor(row.canonical_subject);
    const newParticipants = row.participants.map(renameFor);
    const subjectChanged = newSubject !== row.canonical_subject;
    const participantsChanged = newParticipants.some((p, i) => p !== row.participants[i]);

    if (!subjectChanged && !participantsChanged) continue;

    const newCanonicalEvent = deriveCanonicalEventCore({
      eventKind: row.event_kind,
      conditionShape: row.condition_shape,
      conditionMetric: row.condition_metric,
      valueUnit: row.value_unit,
      rawCanonicalEvent: row.canonical_event ?? '',
      canonicalSubject: newSubject,
      canonicalParticipants: newParticipants,
      categoryUnified: row.category_unified,
      eventDateIso: row.condition_date,
    }).slice(0, 500);

    // Preserves the rest of each entity object; only the canonical string is updated.
    const newResolvedEntities = (() => {
      const parsed = Array.isArray(row.resolved_entities)
        ? row.resolved_entities
        : (typeof row.resolved_entities === 'string'
            ? (JSON.parse(row.resolved_entities) as unknown[])
            : []);
      if (!Array.isArray(parsed)) return null;
      let changed = false;
      const out = parsed.map((e) => {
        if (!e || typeof e !== 'object') return e;
        const ent = e as Record<string, unknown>;
        const cur = typeof ent.canonical === 'string' ? ent.canonical : null;
        if (!cur) return ent;
        const renamed = renameFor(cur);
        if (renamed === cur) return ent;
        changed = true;
        return { ...ent, canonical: renamed };
      });
      return changed ? out : null;
    })();

    await query(
      `UPDATE llm_market_normalizations
       SET canonical_subject = $1,
           participants      = $2,
           canonical_event   = $3,
           resolved_entities = COALESCE($4::jsonb, resolved_entities)
       WHERE market_id = $5`,
      [
        newSubject,
        newParticipants,
        newCanonicalEvent || row.canonical_event,
        newResolvedEntities ? JSON.stringify(newResolvedEntities) : null,
        row.market_id,
      ]
    );
    updated++;
    updatedMarketIdSet.add(row.market_id);
  }

  const candidateEventRows = await query<{
    id: number;
    platform: string;
    platform_event_id: string;
    canonical_subject: string;
    participants: string[];
    canonical_event: string | null;
    category_unified: string | null;
    sport_canonical: string | null;
    league_canonical: string | null;
  }>(
    `SELECT
       pe.id,
       pe.platform,
       pe.platform_event_id,
       pe.canonical_subject,
       pe.participants,
       pe.canonical_event,
       ce.category_unified AS category_unified,
       ce.sport_canonical  AS sport_canonical,
       ce.league_canonical AS league_canonical
     FROM platform_events pe
     LEFT JOIN LATERAL (
       SELECT m.category_unified,
              le.sport_canonical,
              le.canonical AS league_canonical
       FROM markets m
       JOIN llm_market_normalizations n ON n.market_id = m.id
       LEFT JOIN known_entities le      ON le.id = n.league_id
       WHERE m.platform = pe.platform
         AND m.platform_event_id = pe.platform_event_id
       GROUP BY m.category_unified, le.sport_canonical, le.canonical
       ORDER BY COUNT(*) DESC
       LIMIT 1
     ) ce ON TRUE
     ${eventWhereExtra}
       AND (
         pe.canonical_subject = ANY($${marketParams.length + 1}::text[])
         OR pe.participants && $${marketParams.length + 1}::text[]
       )`,
    [...marketParams, oldPhrases]
  );

  let eventsUpdated = 0;
  const updatedEventKeys: Array<{ platform: string; platform_event_id: string }> = [];
  for (const row of candidateEventRows) {
    const domain = unifiedToDomain(row.category_unified);
    const scope = { sport: row.sport_canonical, league: row.league_canonical };

    const renameFor = (phrase: string): string => {
      const k = scopeKey(phrase, domain, scope.sport, scope.league);
      return renames.get(k) ?? phrase;
    };

    const newSubject = renameFor(row.canonical_subject);
    const newParticipants = row.participants.map(renameFor);
    const subjectChanged = newSubject !== row.canonical_subject;
    const participantsChanged = newParticipants.some((p, i) => p !== row.participants[i]);

    if (!subjectChanged && !participantsChanged) continue;

    let newCanonicalEvent = row.canonical_event ?? '';
    const opponents = newParticipants.filter((p) => p && p !== newSubject);
    if (row.category_unified === 'sports' && opponents.length === 1) {
      const a = newSubject;
      const b = opponents[0]!;
      newCanonicalEvent = a.toLowerCase() < b.toLowerCase() ? `${a} vs ${b}` : `${b} vs ${a}`;
    } else if (newCanonicalEvent) {
      const scopePrefix = `␟${domain}␟${scope.sport ?? ''}␟${scope.league ?? ''}`;
      for (const [key, newPhrase] of renames) {
        if (!key.endsWith(scopePrefix)) continue;
        const oldPhrase = key.slice(0, key.length - scopePrefix.length);
        if (oldPhrase && newCanonicalEvent.includes(oldPhrase)) {
          newCanonicalEvent = newCanonicalEvent.split(oldPhrase).join(newPhrase);
        }
      }
    }

    await query(
      `UPDATE platform_events
       SET canonical_subject = $1,
           participants      = $2,
           canonical_event   = $3,
           updated_at        = NOW()
       WHERE id = $4`,
      [
        newSubject,
        newParticipants,
        newCanonicalEvent || row.canonical_event,
        row.id,
      ]
    );
    eventsUpdated++;
    updatedEventKeys.push({ platform: row.platform, platform_event_id: row.platform_event_id });
  }

  if (updatedEventKeys.length > 0) {
    const childRows = await query<{ id: number }>(
      `SELECT m.id
       FROM markets m
       JOIN unnest($1::text[], $2::text[]) AS t(platform, platform_event_id)
         ON m.platform = t.platform AND m.platform_event_id = t.platform_event_id`,
      [updatedEventKeys.map((k) => k.platform), updatedEventKeys.map((k) => k.platform_event_id)],
    );
    for (const r of childRows) updatedMarketIdSet.add(r.id);
  }

  log.info(
    `Stage 1f backfill: ${totalPhrasesChecked} distinct (phrase, scope) tuples checked, ` +
    `${renameCount} renames discovered, ${updated} normalization rows + ${eventsUpdated} platform_events rows updated`
  );

  return { checked: totalPhrasesChecked, updated, eventsUpdated, updatedMarketIds: [...updatedMarketIdSet] };
}
