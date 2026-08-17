/** Entity category histograms: read as a deterministic gate before LLM-driven merges so a surface form ("Trump") can't collapse across unrelated categories. */

import { query } from '@arb/db';
import { config } from '../../config.js';

/** entityId → (category → mass-share in [0,1]). Cold entities map to an empty Map. */
const _categoryMassCache = new Map<number, Map<string, number>>();

export function invalidateEntityCategoryCache(entityId?: number): void {
  if (entityId === undefined) _categoryMassCache.clear();
  else _categoryMassCache.delete(entityId);
}

/** Fraction of `entityId`'s observed market links that landed in `category`; 0 for cold entities. Memoised until invalidateEntityCategoryCache(id). */
export async function getEntityCategoryMass(
  entityId: number,
  category: string,
): Promise<number> {
  const cached = _categoryMassCache.get(entityId);
  if (cached !== undefined) return cached.get(category) ?? 0;
  const rows = await query<{ category: string; n: number }>(
    `SELECT category, n FROM entity_category_counts WHERE entity_id = $1`,
    [entityId],
  );
  const massMap = new Map<string, number>();
  if (rows.length > 0) {
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    if (total > 0) {
      for (const r of rows) massMap.set(r.category, Number(r.n) / total);
    }
  }
  _categoryMassCache.set(entityId, massMap);
  return massMap.get(category) ?? 0;
}

/** Increment the (entity, market.category_unified) bucket; looks up category from `markets` when not passed. */
export async function incrementEntityCategoryCount(
  marketId: number,
  entityId: number,
  category?: string | null,
): Promise<void> {
  let resolvedCategory: string | null | undefined = category;
  if (resolvedCategory === undefined) {
    const rows = await query<{ category: string | null }>(
      `SELECT category_unified AS category FROM markets WHERE id = $1`,
      [marketId],
    );
    resolvedCategory = rows[0]?.category ?? null;
  }
  if (!resolvedCategory) return; // null / empty / 'other'-not-stored → no-op
  await query(
    `INSERT INTO entity_category_counts (entity_id, category, n, last_updated)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (entity_id, category) DO UPDATE
       SET n = entity_category_counts.n + 1,
           last_updated = NOW()`,
    [entityId, resolvedCategory],
  );
  _categoryMassCache.delete(entityId);
}

/** Batched incrementEntityCategoryCount; callers must pre-aggregate `counts` so each entity_id appears once, or ON CONFLICT DO UPDATE hits Postgres error 21000. */
export async function incrementEntityCategoryCountsBatch(
  counts: Map<number, number>,
  category: string | null,
): Promise<void> {
  if (!category || counts.size === 0) return;
  const entityIds: number[] = [];
  const ns: number[] = [];
  for (const [entityId, n] of counts) {
    if (n <= 0) continue;
    entityIds.push(entityId);
    ns.push(n);
  }
  if (entityIds.length === 0) return;
  await query(
    `INSERT INTO entity_category_counts (entity_id, category, n, last_updated)
     SELECT eid, $2, cnt, NOW()
       FROM unnest($1::int[], $3::int[]) AS t(eid, cnt)
     ON CONFLICT (entity_id, category) DO UPDATE
       SET n = entity_category_counts.n + EXCLUDED.n,
           last_updated = NOW()`,
    [entityIds, category, ns],
  );
  for (const entityId of entityIds) _categoryMassCache.delete(entityId);
}

/** Folds dropId's per-category counts into keepId's, then deletes dropId's rows; must run inside the same transaction as the rest of the entity merge. */
export async function mergeEntityCategoryCountsTx(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  keepId: number,
  dropId: number,
): Promise<void> {
  if (keepId === dropId) return;
  await client.query(
    `INSERT INTO entity_category_counts (entity_id, category, n, last_updated)
     SELECT $1, category, n, NOW() FROM entity_category_counts WHERE entity_id = $2
     ON CONFLICT (entity_id, category) DO UPDATE
       SET n = entity_category_counts.n + EXCLUDED.n,
           last_updated = NOW()`,
    [keepId, dropId],
  );
  await client.query(
    `DELETE FROM entity_category_counts WHERE entity_id = $1`,
    [dropId],
  );
}

/** Refuses cross-category merge collisions; modes (config.stage1, shared with merge-probe.ts): off=never, warn=log only, enforce=refuse below mass threshold. Always allows null/'other'/cold. */
export async function evaluateHistogramGate(
  entityId: number,
  currentCategory: string | null,
  calleeTag: string,
): Promise<{ refuse: boolean; reason: string }> {
  const mode = config.stage1.kbHistogramGateMode;
  if (mode === 'off') {
    return { refuse: false, reason: `gate_off:tag=${calleeTag}` };
  }
  if (currentCategory === null || currentCategory === 'other') {
    return { refuse: false, reason: `category_open:tag=${calleeTag}` };
  }
  const totalRows = await query<{ total: number }>(
    `SELECT COALESCE(SUM(n), 0)::int AS total FROM entity_category_counts WHERE entity_id = $1`,
    [entityId],
  );
  if (Number(totalRows[0]?.total ?? 0) === 0) {
    return { refuse: false, reason: `cold:tag=${calleeTag}` };
  }
  const threshold = config.stage1.kbHistogramGateMinMass;
  const mass = await getEntityCategoryMass(entityId, currentCategory);
  if (mass < threshold) {
    return {
      refuse: mode === 'enforce',
      reason: `low_mass:${mass.toFixed(3)}<${threshold}:tag=${calleeTag}`,
    };
  }
  return { refuse: false, reason: `mass:${mass.toFixed(3)}:tag=${calleeTag}` };
}
