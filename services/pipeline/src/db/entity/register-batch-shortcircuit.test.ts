/**
 * Parity tests for registerEntities:
 *   Item 1 — batched market_entity_links + histogram (same rows as the per-row loop).
 *   Item 2 — warm-cache short-circuit in findOrCreateEntity (skips serialise + 3-pass
 *            match when the entity already exists and no new alias is added; still
 *            merges genuinely-new aliases; concurrent same-fold CREATES still serialise).
 *
 * Live-DB tests (skip if Postgres is unreachable). Each seeds throwaway entities +
 * markets under a unique prefix and cleans up via FK cascade.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { query } from '@arb/db';
import { registerEntities, _shortCircuitHitCountForTests } from './register.js';
import { warmKBCache, invalidateKBCache } from './cache.js';
import type { ResolvedEntity } from '@arb/types';

let pgAvailable = false;
beforeAll(async () => {
  try { await query('SELECT 1'); pgAvailable = true; }
  catch (err) { console.warn('[register-batch-shortcircuit.test] PG unreachable — skipping:', (err as Error).message); }
});

const PREFIX = 'zzbatchsc';
const createdMarketIds: number[] = [];

afterEach(async () => {
  if (!pgAvailable) return;
  if (createdMarketIds.length > 0) {
    await query(`DELETE FROM markets WHERE id = ANY($1)`, [createdMarketIds]);
    createdMarketIds.length = 0;
  }
  // Entities minted by these tests (and their links / histogram rows via cascade).
  await query(`DELETE FROM known_entities WHERE canonical ILIKE $1`, [`${PREFIX}%`]);
  invalidateKBCache();
});

async function makeMarket(tag: string, category: string | null): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO markets (platform, platform_id, title, status, category_unified)
     VALUES ('kalshi', $1, $2, 'open', $3) RETURNING id`,
    [`${PREFIX}:${tag}`, `test ${tag}`, category],
  );
  createdMarketIds.push(rows[0].id);
  return rows[0].id;
}

const ent = (canonical: string, aliases: string[] = []): ResolvedEntity =>
  ({ canonical, type: 'team', aliases });

async function links(marketId: number): Promise<Array<{ canonical: string; is_subject: boolean }>> {
  return query<{ canonical: string; is_subject: boolean }>(
    `SELECT k.canonical, l.is_subject
       FROM market_entity_links l JOIN known_entities k ON k.id = l.entity_id
      WHERE l.market_id = $1 ORDER BY k.canonical`,
    [marketId],
  );
}
async function histOf(canonical: string): Promise<string> {
  const rows = await query<{ category: string; n: number }>(
    `SELECT c.category, c.n FROM entity_category_counts c
       JOIN known_entities k ON k.id = c.entity_id WHERE k.canonical = $1`,
    [canonical],
  );
  return rows.map((r) => `${r.category}=${Number(r.n)}`).sort().join(',');
}
async function countEntities(canonical: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int n FROM known_entities WHERE canonical = $1`, [canonical]);
  return r[0].n;
}
async function aliasesOf(canonical: string): Promise<string[]> {
  const r = await query<{ aliases: string[] }>(
    `SELECT aliases FROM known_entities WHERE canonical = $1`, [canonical]);
  return (r[0]?.aliases ?? []).map((a) => a.toLowerCase());
}

describe('registerEntities — item 1: batched links + histogram', () => {
  test('one junction row per distinct entity; subject flagged; histogram counts each occurrence', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    const mid = await makeMarket('links1', 'sports');
    const subj = `${PREFIX} Subject FC`;
    // Two distinct entities + the SAME entity listed TWICE (dedupe → one link, OR
    // is_subject; histogram +2 for the duplicate).
    const dup = `${PREFIX} Dup United`;
    await registerEntities(mid, subj, [
      ent(subj),
      ent(`${PREFIX} Other City`),
      ent(dup),
      ent(dup),
    ], 'sports', 'sports');

    const l = await links(mid);
    // exactly 3 distinct junction rows (subject, other, dup) — the duplicate collapsed
    expect(l.length).toBe(3);
    const subjRow = l.find((r) => r.canonical === subj);
    expect(subjRow?.is_subject).toBe(true);
    expect(l.find((r) => r.canonical === `${PREFIX} Other City`)?.is_subject).toBe(false);
    // histogram: subject seen 1×, other 1×, dup 2×
    expect(await histOf(subj)).toBe('sports=1');
    expect(await histOf(`${PREFIX} Other City`)).toBe('sports=1');
    expect(await histOf(dup)).toBe('sports=2');
  });

  test('is_subject OR-accumulates across occurrences (dup appears as subject AND non-subject)', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    const mid = await makeMarket('links2', 'sports');
    const subj = `${PREFIX} Twin Rovers`;
    // same entity appears once as the subject and once as a plain participant → is_subject=true
    await registerEntities(mid, subj, [ent(subj), ent(subj)], 'sports', 'sports');
    const l = await links(mid);
    expect(l.length).toBe(1);
    expect(l[0].is_subject).toBe(true);
    expect(await histOf(subj)).toBe('sports=2');
  });

  test('null category → links written, histogram is a no-op', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    const mid = await makeMarket('links3', null);
    const subj = `${PREFIX} NoCat Athletic`;
    await registerEntities(mid, subj, [ent(subj)], 'sports', null);
    expect((await links(mid)).length).toBe(1);
    expect(await histOf(subj)).toBe('');
  });
});

describe('registerEntities — item 2: warm-cache short-circuit', () => {
  test('repeat registration of a committed entity resolves to the SAME row (no dup), links the new market', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    const canonical = `${PREFIX} Repeat City`;
    const m1 = await makeMarket('sc1a', 'sports');
    await registerEntities(m1, canonical, [ent(canonical)], 'sports', 'sports');
    expect(await countEntities(canonical)).toBe(1);

    // Second market, identical entity — the short-circuit path (no new alias) must
    // ENGAGE (counter bumps) and still produce the SAME id, a link on m2, no dup.
    const before = _shortCircuitHitCountForTests();
    const m2 = await makeMarket('sc1b', 'sports');
    await registerEntities(m2, canonical, [ent(canonical)], 'sports', 'sports');
    expect(_shortCircuitHitCountForTests()).toBe(before + 1); // fast path fired
    expect(await countEntities(canonical)).toBe(1);
    expect((await links(m2)).length).toBe(1);
    expect(await histOf(canonical)).toBe('sports=2'); // one per market
  });

  test('a genuinely-NEW alias still merges (falls through to the slow path)', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    const canonical = `${PREFIX} Alias Rangers`;
    const m1 = await makeMarket('sc2a', 'sports');
    await registerEntities(m1, canonical, [ent(canonical)], 'sports', 'sports');
    expect(await aliasesOf(canonical)).not.toContain(`${PREFIX} ar`.toLowerCase());

    // Re-register with a NEW alias — must NOT short-circuit past mergeAliases
    // (counter unchanged), and the alias must land on the same row.
    const before = _shortCircuitHitCountForTests();
    const m2 = await makeMarket('sc2b', 'sports');
    await registerEntities(m2, canonical, [ent(canonical, [`${PREFIX} AR`])], 'sports', 'sports');
    expect(_shortCircuitHitCountForTests()).toBe(before); // fell through to slow path
    expect(await countEntities(canonical)).toBe(1);
    expect(await aliasesOf(canonical)).toContain(`${PREFIX} ar`.toLowerCase());
  });

  test('concurrent same-fold CREATES still serialise into ONE row (short-circuit never fires for new folds)', async () => {
    if (!pgAvailable) return;
    await warmKBCache();
    // Two diacritic-fold-equivalent NEW canonicals registered concurrently. Neither
    // is in the warm cache (both new), so the short-circuit is bypassed and the
    // keyedSerialize + Pass-3a bridge must fold them into ONE entity (no fork).
    const m = await makeMarket('sc3', 'sports');
    const plain = `${PREFIX} Alvaro Zzt`;
    const accented = `${PREFIX} Álvaro Zzt`;
    await Promise.all([
      registerEntities(m, plain, [ent(plain)], 'sports', 'sports'),
      registerEntities(m, accented, [ent(accented)], 'sports', 'sports'),
    ]);
    // Both spellings collapse onto ONE known_entities row (canonical is whichever
    // committed first; the other becomes an alias) — never two forked rows.
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM known_entities WHERE canonical ILIKE $1`,
      [`${PREFIX} %lvaro Zzt`],
    );
    expect(rows[0].n).toBe(1);
  });
});
