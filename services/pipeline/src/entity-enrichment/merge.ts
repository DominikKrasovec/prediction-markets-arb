// Entity merge: collapse two `known_entities` rows into one. Runs in a single
// transaction so we never leave dangling references on partial failure.

import { withTx } from '@arb/db';
import { createLogger } from '@arb/logger';
import {
  invalidateKBCache,
  rehydrateKBCacheRow,
  purgeSubjectCacheByCanonicals,
  mergeEntityCategoryCountsTx,
  invalidateEntityCategoryCache,
} from '../db/entity-registry.js';
import { parseJsonbArray } from '@arb/db';
import { isStationScopedName } from '../db/entity/tokens.js';

const log = createLogger('entity-merge');

export interface MergeUpdates {
  canonical?: string;
  type?: string;
  metadataMerge?: Record<string, unknown>;
}

// `alreadyMerged=true`: dropId row was gone at lock time — treat as success.
// `refused=true`: the station-scope gate blocked the merge; nothing written.
export async function mergeKnownEntities(
  keepId: number,
  dropId: number,
  updates: MergeUpdates = {},
): Promise<{ marketLinksMoved: number; aliasesAdded: number; alreadyMerged?: boolean; refused?: boolean }> {
  if (keepId === dropId) {
    throw new Error(`mergeKnownEntities: keepId === dropId (${keepId})`);
  }

  let _dropCanonical = '';
  let _originalKeepCanonical = '';

  return withTx(async (client) => {
    // Stable lock order avoids deadlocks with concurrent merges.
    const [lockA, lockB] = keepId < dropId ? [keepId, dropId] : [dropId, keepId];
    const lockRes = await client.query<{ id: number }>(
      `SELECT id FROM known_entities WHERE id IN ($1, $2) FOR UPDATE`,
      [lockA, lockB],
    );
    const lockedIds = new Set(lockRes.rows.map((r) => r.id));
    if (!lockedIds.has(dropId)) {
      return { marketLinksMoved: 0, aliasesAdded: 0, alreadyMerged: true };
    }
    if (!lockedIds.has(keepId)) {
      throw new Error(`mergeKnownEntities: keepId ${keepId} disappeared while dropId ${dropId} still exists`);
    }

    // A station/venue-scoped entity must never merge with a bare
    // city/location entity in either direction (weather instrument discriminator).
    const gateRows = await client.query<{ id: number; canonical: string }>(
      `SELECT id, canonical FROM known_entities WHERE id IN ($1, $2)`,
      [keepId, dropId],
    );
    const gateKeep = gateRows.rows.find((r) => r.id === keepId);
    const gateDrop = gateRows.rows.find((r) => r.id === dropId);
    if (gateKeep && gateDrop &&
        isStationScopedName(gateKeep.canonical) !== isStationScopedName(gateDrop.canonical)) {
      log.warn(
        `station-scope gate: refusing merge id=${dropId} ("${gateDrop.canonical}") → ` +
        `id=${keepId} ("${gateKeep.canonical}") — station-scoped and bare-location ` +
        `entities are distinct by policy (W1-E instrument discriminator).`,
      );
      return { marketLinksMoved: 0, aliasesAdded: 0, refused: true };
    }

    const linkResult = await client.query(
      `WITH moved AS (
         INSERT INTO market_entity_links (market_id, entity_id, is_subject)
         SELECT market_id, $1, is_subject FROM market_entity_links WHERE entity_id = $2
         ON CONFLICT (market_id, entity_id) DO UPDATE
           SET is_subject = market_entity_links.is_subject OR EXCLUDED.is_subject
         RETURNING market_id
       )
       SELECT count(*)::int AS n FROM moved`,
      [keepId, dropId],
    );
    const marketLinksMoved = (linkResult.rows[0] as { n: number }).n;
    await client.query(`DELETE FROM market_entity_links WHERE entity_id = $1`, [dropId]);

    await mergeEntityCategoryCountsTx(client, keepId, dropId);

    // PK is (parent_id, child_id, relation); pre-delete dropId's colliding
    // edges before the repoint UPDATE or it throws a duplicate-key error.
    await client.query(
      `DELETE FROM entity_relations d
        WHERE d.parent_id = $2
          AND EXISTS (SELECT 1 FROM entity_relations k
                       WHERE k.parent_id = $1 AND k.child_id = d.child_id AND k.relation = d.relation)`,
      [keepId, dropId],
    );
    await client.query(
      `DELETE FROM entity_relations d
        WHERE d.child_id = $2
          AND EXISTS (SELECT 1 FROM entity_relations k
                       WHERE k.child_id = $1 AND k.parent_id = d.parent_id AND k.relation = d.relation)`,
      [keepId, dropId],
    );
    await client.query(`UPDATE entity_relations SET parent_id = $1 WHERE parent_id = $2`, [keepId, dropId]);
    await client.query(`UPDATE entity_relations SET child_id  = $1 WHERE child_id  = $2`, [keepId, dropId]);
    await client.query(
      `DELETE FROM entity_relations a USING entity_relations b
       WHERE a.parent_id = b.parent_id AND a.child_id = b.child_id AND a.relation = b.relation
         AND a.ctid > b.ctid`,
    );
    await client.query(`DELETE FROM entity_relations WHERE parent_id = child_id`);

    await client.query(`UPDATE llm_market_normalizations SET resolution_provider_id = $1 WHERE resolution_provider_id = $2`, [keepId, dropId]);
    await client.query(`UPDATE llm_market_normalizations SET league_id              = $1 WHERE league_id              = $2`, [keepId, dropId]);
    await client.query(`UPDATE llm_market_normalizations SET competition_id         = $1 WHERE competition_id         = $2`, [keepId, dropId]);

    const rowsRes = await client.query<{ id: number; canonical: string; aliases: unknown; metadata: unknown; type: string }>(
      `SELECT id, canonical, aliases, metadata, type FROM known_entities WHERE id IN ($1, $2)`,
      [keepId, dropId],
    );
    const keepRow = rowsRes.rows.find((r) => r.id === keepId);
    const dropRow = rowsRes.rows.find((r) => r.id === dropId);
    if (!keepRow || !dropRow) throw new Error(`mergeKnownEntities: missing rows after lock (${keepId}, ${dropId})`);

    _dropCanonical = dropRow.canonical;
    _originalKeepCanonical = keepRow.canonical;

    const keepAliases = parseJsonbArray(keepRow.aliases);
    const dropAliases = parseJsonbArray(dropRow.aliases);
    let newKeepCanonical = updates.canonical?.trim() || keepRow.canonical;

    // A 3rd row already holding (canonical, sport, league) would fail the
    // unique constraint on rename; skip the promotion in that case (the
    // merge still happens) or the whole transaction rolls back.
    if (
      updates.canonical &&
      newKeepCanonical.toLowerCase() !== keepRow.canonical.toLowerCase()
    ) {
      const conflictRows = await client.query<{ id: number; canonical: string }>(
        `SELECT id, canonical FROM known_entities
         WHERE id NOT IN ($1, $2)
           AND lower(canonical) = lower($3)
           AND sport_canonical IS NOT DISTINCT FROM
                 (SELECT sport_canonical  FROM known_entities WHERE id = $1)
           AND league_canonical IS NOT DISTINCT FROM
                 (SELECT league_canonical FROM known_entities WHERE id = $1)
         LIMIT 1`,
        [keepId, dropId, newKeepCanonical],
      );
      if (conflictRows.rows.length > 0) {
        const collider = conflictRows.rows[0] as { id: number; canonical: string };
        log.warn(
          `3-way collision: cannot promote keep id=${keepId} ` +
          `canonical "${keepRow.canonical}" → "${newKeepCanonical}" because ` +
          `id=${collider.id} already holds that (canonical, sport, league). ` +
          `Skipping rename; will re-attempt promotion on next enrichment cycle.`,
        );
        newKeepCanonical = keepRow.canonical;
      }
    }

    const aliasMap = new Map<string, string>();
    for (const a of keepAliases) aliasMap.set(a.toLowerCase(), a);
    for (const a of dropAliases) aliasMap.set(a.toLowerCase(), a);
    aliasMap.set(dropRow.canonical.toLowerCase(), dropRow.canonical);
    if (newKeepCanonical.toLowerCase() !== keepRow.canonical.toLowerCase()) {
      aliasMap.set(keepRow.canonical.toLowerCase(), keepRow.canonical);
    }
    if (
      updates.canonical &&
      updates.canonical.trim().toLowerCase() !== newKeepCanonical.toLowerCase()
    ) {
      aliasMap.set(updates.canonical.trim().toLowerCase(), updates.canonical.trim());
    }
    aliasMap.delete(newKeepCanonical.toLowerCase());

    const mergedAliases = Array.from(aliasMap.values());
    const aliasesAdded = mergedAliases.length - keepAliases.length;

    const keepMeta = (keepRow.metadata && typeof keepRow.metadata === 'object' && !Array.isArray(keepRow.metadata)
      ? keepRow.metadata
      : {}) as Record<string, unknown>;
    const incomingMeta = updates.metadataMerge ?? {};
    const mergedMeta: Record<string, unknown> = { ...incomingMeta, ...keepMeta };
    const newType = updates.type ?? keepRow.type;
    mergedMeta.kind = newType;

    await client.query(
      `UPDATE known_entities
         SET canonical = $2,
             type      = $3,
             aliases   = $4::jsonb,
             metadata  = $5::jsonb,
             enrichment_status = 'enriched',
             updated_at = NOW()
       WHERE id = $1`,
      [keepId, newKeepCanonical, newType, JSON.stringify(mergedAliases), JSON.stringify(mergedMeta)],
    );

    // Subject entities store league_canonical/sport_canonical as a text
    // value in metadata, not a foreign key, so a merged league/sport/
    // competition name must be propagated or scope-aware lookups go stale.
    if (newType === 'sport' || newType === 'league' || newType === 'competition') {
      const metaKey = newType === 'sport' ? 'sport_canonical' : 'league_canonical';
      const renamesToPropagate: string[] = [];
      if (_dropCanonical && _dropCanonical !== newKeepCanonical) {
        renamesToPropagate.push(_dropCanonical);
      }
      if (
        _originalKeepCanonical &&
        _originalKeepCanonical !== newKeepCanonical &&
        _originalKeepCanonical !== _dropCanonical
      ) {
        renamesToPropagate.push(_originalKeepCanonical);
      }
      for (const oldName of renamesToPropagate) {
        await client.query(
          `UPDATE known_entities
             SET metadata   = jsonb_set(metadata, ARRAY[$1::text], to_jsonb($2::text)),
                 updated_at = NOW()
           WHERE metadata->>$1 = $3`,
          [metaKey, newKeepCanonical, oldName],
        );
      }
    }

    await client.query(`DELETE FROM known_entities WHERE id = $1`, [dropId]);

    return { marketLinksMoved, aliasesAdded };
  }).then(async (result) => {
    // A refusal wrote nothing — cache maintenance must not run.
    if (result.refused) return result;
    // rehydrateKBCacheRow (not invalidateKBCache) avoids a cache gap that
    // could let the next T1 miss mint a duplicate entity.
    await rehydrateKBCacheRow(keepId);
    invalidateKBCache(dropId);
    purgeSubjectCacheByCanonicals([_dropCanonical, _originalKeepCanonical]);
    invalidateEntityCategoryCache(keepId);
    invalidateEntityCategoryCache(dropId);
    return result;
  });
}

// Prefer enriched, then more market links, then longer canonical, then lower id.
export function pickKeeper<T extends { id: number; canonical: string; enrichment_status: string; market_link_count: number }>(
  a: T,
  b: T,
): { keep: T; drop: T } {
  if (a.enrichment_status === 'enriched' && b.enrichment_status !== 'enriched') return { keep: a, drop: b };
  if (b.enrichment_status === 'enriched' && a.enrichment_status !== 'enriched') return { keep: b, drop: a };
  if (a.market_link_count !== b.market_link_count) {
    return a.market_link_count > b.market_link_count ? { keep: a, drop: b } : { keep: b, drop: a };
  }
  if (a.canonical.length !== b.canonical.length) {
    return a.canonical.length > b.canonical.length ? { keep: a, drop: b } : { keep: b, drop: a };
  }
  return a.id < b.id ? { keep: a, drop: b } : { keep: b, drop: a };
}
