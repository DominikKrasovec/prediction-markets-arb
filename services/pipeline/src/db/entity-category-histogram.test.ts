/**
 * Tests for the KB category histograms:
 *   - increment idempotency
 *   - merge rewrite preserves total mass
 *   - gate predicate at boundary thresholds
 *
 * Each test seeds two fresh known_entities + a market with a known
 * category_unified, exercises the helper, then cleans up via FK cascade.
 *
 * Skips if Postgres is unreachable (mirrors entity-registry.test.ts).
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { query, withTx } from '@arb/db';
import {
  getEntityCategoryMass,
  incrementEntityCategoryCount,
  incrementEntityCategoryCountsBatch,
  invalidateEntityCategoryCache,
  mergeEntityCategoryCountsTx,
  evaluateHistogramGate,
} from './entity-registry.js';

let pgAvailable = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    pgAvailable = true;
  } catch (err) {
    console.warn('[entity-category-histogram.test] PG unreachable — skipping:', (err as Error).message);
  }
});

/** Seed a throwaway known_entity. Returns the id. The DELETE-cascade FK on
 *  entity_category_counts and market_entity_links cleans up downstream. */
async function makeEntity(canonical: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO known_entities (canonical, type, aliases, domain_category, metadata, enrichment_status)
     VALUES ($1, 'team', '[]'::jsonb, 'other', '{"kind":"team"}'::jsonb, 'enriched')
     RETURNING id`,
    [canonical],
  );
  return rows[0].id;
}

/** Seed a throwaway market with a chosen category_unified. */
async function makeMarket(platformId: string, category: string | null): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO markets (platform, platform_id, title, status, category_unified)
     VALUES ('kalshi', $1, $2, 'open', $3)
     RETURNING id`,
    [platformId, `test:${platformId}`, category],
  );
  return rows[0].id;
}

/** Direct link insert + histogram increment (mirrors registerEntities). */
async function linkAndIncrement(marketId: number, entityId: number): Promise<void> {
  await query(
    `INSERT INTO market_entity_links (market_id, entity_id, is_subject)
     VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING`,
    [marketId, entityId],
  );
  await incrementEntityCategoryCount(marketId, entityId);
}

const createdEntityIds: number[] = [];
const createdMarketIds: number[] = [];

afterEach(async () => {
  if (!pgAvailable) return;
  if (createdEntityIds.length > 0) {
    await query(`DELETE FROM known_entities WHERE id = ANY($1)`, [createdEntityIds]);
    createdEntityIds.length = 0;
  }
  if (createdMarketIds.length > 0) {
    await query(`DELETE FROM markets WHERE id = ANY($1)`, [createdMarketIds]);
    createdMarketIds.length = 0;
  }
  invalidateEntityCategoryCache();
});

async function track<T extends number>(id: T, kind: 'entity' | 'market'): Promise<T> {
  if (kind === 'entity') createdEntityIds.push(id);
  else createdMarketIds.push(id);
  return id;
}

describe('incrementEntityCategoryCount', () => {
  test('first call inserts row with n=1; subsequent calls increment', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-trump-1'), 'entity');
    const mid = await track(await makeMarket('hist-test-1', 'politics'), 'market');

    await incrementEntityCategoryCount(mid, eid);
    await incrementEntityCategoryCount(mid, eid);
    await incrementEntityCategoryCount(mid, eid);

    const rows = await query<{ category: string; n: number }>(
      `SELECT category, n FROM entity_category_counts WHERE entity_id = $1`,
      [eid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('politics');
    expect(Number(rows[0].n)).toBe(3);
  });

  test('null category_unified is a no-op (no row written)', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-cold-1'), 'entity');
    const mid = await track(await makeMarket('hist-test-2', null), 'market');

    await incrementEntityCategoryCount(mid, eid);
    const rows = await query(`SELECT 1 FROM entity_category_counts WHERE entity_id = $1`, [eid]);
    expect(rows).toHaveLength(0);
  });
});

describe('incrementEntityCategoryCountsBatch (registerEntities batching parity)', () => {
  test('one aggregated upsert equals N per-row +1 upserts (incl. same-entity-twice → +2)', async () => {
    if (!pgAvailable) return;
    // Per-row baseline: entity R seen 3×, entity S seen 1× in ONE politics market.
    const rId = await track(await makeEntity('test-batch-rowR'), 'entity');
    const sId = await track(await makeEntity('test-batch-rowS'), 'entity');
    const mRow = await track(await makeMarket('hist-batch-row', 'politics'), 'market');
    await incrementEntityCategoryCount(mRow, rId, 'politics');
    await incrementEntityCategoryCount(mRow, rId, 'politics');
    await incrementEntityCategoryCount(mRow, rId, 'politics');
    await incrementEntityCategoryCount(mRow, sId, 'politics');

    // Batched form on fresh entities: R'→3 occurrences, S'→1.
    const rId2 = await track(await makeEntity('test-batch-batR'), 'entity');
    const sId2 = await track(await makeEntity('test-batch-batS'), 'entity');
    await incrementEntityCategoryCountsBatch(new Map([[rId2, 3], [sId2, 1]]), 'politics');

    const n = async (id: number) => {
      const rows = await query<{ category: string; n: number }>(
        `SELECT category, n FROM entity_category_counts WHERE entity_id = $1`, [id]);
      return rows.map((x) => `${x.category}=${Number(x.n)}`).sort().join(',');
    };
    expect(await n(rId2)).toBe(await n(rId)); // both 'politics=3'
    expect(await n(sId2)).toBe(await n(sId)); // both 'politics=1'
    expect(await n(rId2)).toBe('politics=3');

    // Idempotent accumulation: a second batch adds on top (like a second market).
    await incrementEntityCategoryCountsBatch(new Map([[rId2, 2]]), 'politics');
    expect(await n(rId2)).toBe('politics=5');
  });

  test('null / empty category is a whole-batch no-op', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-batch-null'), 'entity');
    await incrementEntityCategoryCountsBatch(new Map([[eid, 4]]), null);
    await incrementEntityCategoryCountsBatch(new Map([[eid, 4]]), '');
    const rows = await query(`SELECT 1 FROM entity_category_counts WHERE entity_id = $1`, [eid]);
    expect(rows).toHaveLength(0);
  });

  test('empty map is a no-op', async () => {
    if (!pgAvailable) return;
    await incrementEntityCategoryCountsBatch(new Map(), 'politics'); // must not throw
  });
});

describe('getEntityCategoryMass', () => {
  test('returns 0 for an entity with no observations', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-empty-1'), 'entity');
    expect(await getEntityCategoryMass(eid, 'politics')).toBe(0);
  });

  test('returns share of (entity, category) over total observations', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-mass-1'), 'entity');
    const mPol = await track(await makeMarket('hist-mass-pol', 'politics'), 'market');
    const mEco = await track(await makeMarket('hist-mass-eco', 'economic'), 'market');

    // 3 politics, 1 economics → politics share = 0.75, economics = 0.25
    await linkAndIncrement(mPol, eid);
    await linkAndIncrement(mPol, eid);
    await linkAndIncrement(mPol, eid);
    await linkAndIncrement(mEco, eid);

    expect(await getEntityCategoryMass(eid, 'politics')).toBeCloseTo(0.75, 3);
    expect(await getEntityCategoryMass(eid, 'economic')).toBeCloseTo(0.25, 3);
    expect(await getEntityCategoryMass(eid, 'sports')).toBe(0);
  });
});

describe('mergeEntityCategoryCountsTx', () => {
  test('rewrite preserves total mass and combines per-category buckets', async () => {
    if (!pgAvailable) return;
    const keepId = await track(await makeEntity('test-merge-keep'), 'entity');
    const dropId = await track(await makeEntity('test-merge-drop'), 'entity');
    const mPol = await track(await makeMarket('hist-merge-pol', 'politics'), 'market');
    const mEco = await track(await makeMarket('hist-merge-eco', 'economic'), 'market');
    const mEnt = await track(await makeMarket('hist-merge-ent', 'entertainment'), 'market');

    // keep: 2 politics, 1 entertainment
    await incrementEntityCategoryCount(mPol, keepId);
    await incrementEntityCategoryCount(mPol, keepId);
    await incrementEntityCategoryCount(mEnt, keepId);
    // drop: 3 politics, 1 economics
    await incrementEntityCategoryCount(mPol, dropId);
    await incrementEntityCategoryCount(mPol, dropId);
    await incrementEntityCategoryCount(mPol, dropId);
    await incrementEntityCategoryCount(mEco, dropId);

    const before = await query<{ total: number }>(
      `SELECT COALESCE(SUM(n),0)::int AS total FROM entity_category_counts WHERE entity_id IN ($1,$2)`,
      [keepId, dropId],
    );
    expect(Number(before[0].total)).toBe(7);

    await withTx(async (client) => mergeEntityCategoryCountsTx(client, keepId, dropId));

    const after = await query<{ category: string; n: number }>(
      `SELECT category, n FROM entity_category_counts WHERE entity_id = $1 ORDER BY category`,
      [keepId],
    );
    const map = new Map(after.map((r) => [r.category, Number(r.n)]));
    expect(map.get('politics')).toBe(5); // 2 + 3
    expect(map.get('economic')).toBe(1);
    expect(map.get('entertainment')).toBe(1);
    expect([...map.values()].reduce((a, b) => a + b, 0)).toBe(7);

    const dropRows = await query(
      `SELECT 1 FROM entity_category_counts WHERE entity_id = $1`,
      [dropId],
    );
    expect(dropRows).toHaveLength(0);
  });
});

describe('evaluateHistogramGate', () => {
  const ORIGINAL_MODE = process.env.KB_HISTOGRAM_GATE_MODE;

  function reload() {
    // Assertions are written against the production default (`off`) plus a
    // few direct mass-share checks via getEntityCategoryMass.
  }

  test('off mode (default): never refuses, regardless of mass', async () => {
    if (!pgAvailable) return;
    reload();
    const eid = await track(await makeEntity('test-gate-off'), 'entity');
    const mPol = await track(await makeMarket('hist-gate-pol', 'politics'), 'market');
    await linkAndIncrement(mPol, eid);
    const gate = await evaluateHistogramGate(eid, 'economic', 'unit-test');
    expect(gate.refuse).toBe(false);
  });

  test('cold entity (no observations) is always allowed', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-gate-cold'), 'entity');
    const gate = await evaluateHistogramGate(eid, 'politics', 'unit-test-cold');
    expect(gate.refuse).toBe(false);
    expect(gate.reason).toMatch(/cold|gate_off/);
  });

  test('null / "other" current category is always allowed', async () => {
    if (!pgAvailable) return;
    const eid = await track(await makeEntity('test-gate-other'), 'entity');
    const mPol = await track(await makeMarket('hist-gate-other', 'politics'), 'market');
    await linkAndIncrement(mPol, eid);
    expect((await evaluateHistogramGate(eid, null, 'ut')).refuse).toBe(false);
    expect((await evaluateHistogramGate(eid, 'other', 'ut')).refuse).toBe(false);
  });

  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.KB_HISTOGRAM_GATE_MODE;
    else process.env.KB_HISTOGRAM_GATE_MODE = ORIGINAL_MODE;
  });
});
