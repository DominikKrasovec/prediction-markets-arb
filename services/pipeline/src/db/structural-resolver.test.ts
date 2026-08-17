/**
 * Baseline behaviour lock for the StructuralEntityResolver singletons
 * (sportResolver / leagueResolver / providerResolver) — the resolvers
 * that the unification refactor will reroute `ensureTaxonomyEntity`
 * traffic through.
 *
 * These tests pin the *current* contract:
 *   - T1 lookup is canonical + alias, case-insensitive, type-filtered
 *   - T1 hit returns the existing row even when extraMetadata is supplied
 *     (extraMetadata is merged into the row but does NOT change canonical)
 *   - T3 creation on miss writes a new row with type = primaryType, with
 *     `metadata.kind = primaryType` and any extraMetadata merged
 *   - leagueResolver treats both `league` and `competition` rows as hits
 *     on T1 (it was constructed with the union ['league','competition']),
 *     but T3-creates as `league` only
 *   - in-process cache prevents duplicate INSERTs in the same process
 *
 * When the refactor unifies ensureTaxonomyEntity into these resolvers,
 * the contract here MUST continue to hold — plus a few new guarantees
 * the resolvers don't currently provide (alias merge on T1 hit, parent
 * sport stamping on league creation). Those new guarantees get their
 * own test commit during the refactor; this file is the "before" line.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { query } from '@arb/db';
import {
  warmKBCache,
  sportResolver,
  leagueResolver,
  providerResolver,
} from './entity-registry.js';

let pgAvailable = false;
const NOVEL_PREFIX = '__test_resolver_';

beforeAll(async () => {
  try {
    await query('SELECT 1');
    await warmKBCache();
    pgAvailable = true;
  } catch (err) {
    console.warn('[structural-resolver.test] PG unreachable — skipping:', (err as Error).message);
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  await query(`DELETE FROM known_entities WHERE canonical LIKE $1`, [`${NOVEL_PREFIX}%`]);
});

/** Unique-per-test canonical so concurrent test runs don't collide. */
function novel(slug: string): string {
  return `${NOVEL_PREFIX}${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

describe('sportResolver — T1 hit on existing canonical/alias', () => {
  test('exact canonical match returns the seeded row', async () => {
    if (!pgAvailable) return;
    const hit = await sportResolver.resolve('basketball', 'sports');
    expect(hit).not.toBeNull();
    expect(hit?.canonical.toLowerCase()).toBe('basketball');
  });

  test('case-insensitive canonical match', async () => {
    if (!pgAvailable) return;
    const hit = await sportResolver.resolve('Basketball', 'sports');
    expect(hit?.canonical.toLowerCase()).toBe('basketball');
  });

  test('null / empty / whitespace returns null (no creation)', async () => {
    if (!pgAvailable) return;
    expect(await sportResolver.resolve('', 'sports')).toBeNull();
    expect(await sportResolver.resolve('   ', 'sports')).toBeNull();
  });
});

describe('sportResolver — T3 creation on miss', () => {
  test('novel canonical creates a new sport row with metadata.kind="sport"', async () => {
    if (!pgAvailable) return;
    const canonical = novel('sport_a');
    const hit = await sportResolver.resolve(canonical, 'sports');
    expect(hit).not.toBeNull();
    expect(hit?.canonical).toBe(canonical);

    const rows = await query<{ type: string; domain_category: string; metadata: Record<string, unknown> }>(
      `SELECT type, domain_category, metadata FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    expect(rows[0].type).toBe('sport');
    expect(rows[0].domain_category).toBe('sports');
    expect(rows[0].metadata.kind).toBe('sport');
  });

  test('T3 creation merges extraMetadata into the new row', async () => {
    if (!pgAvailable) return;
    const canonical = novel('sport_b');
    const hit = await sportResolver.resolve(canonical, 'sports', { _origin: 'test_marker' });
    expect(hit).not.toBeNull();

    const rows = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    expect(rows[0].metadata.kind).toBe('sport');
    expect(rows[0].metadata._origin).toBe('test_marker');
  });

  test('second resolve of the same canonical hits the in-process cache (no duplicate row)', async () => {
    if (!pgAvailable) return;
    const canonical = novel('sport_c');
    const hit1 = await sportResolver.resolve(canonical, 'sports');
    const hit2 = await sportResolver.resolve(canonical, 'sports');
    expect(hit1?.id).toBe(hit2!.id);
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM known_entities WHERE canonical = $1 AND type = 'sport'`,
      [canonical],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe('leagueResolver — accepts league AND competition rows on T1', () => {
  test('T1 match on a seeded league row', async () => {
    if (!pgAvailable) return;
    const hit = await leagueResolver.resolve('NBA', 'sports');
    expect(hit?.canonical.toLowerCase()).toBe('nba');
  });

  test('T3 creates as type=league (the resolver primaryType), NOT competition', async () => {
    if (!pgAvailable) return;
    const canonical = novel('league_a');
    const hit = await leagueResolver.resolve(canonical, 'sports');
    expect(hit).not.toBeNull();
    const rows = await query<{ type: string }>(
      `SELECT type FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    // The headline gap: the LLM-derived path can create *competition* rows
    // (via the entity-enrichment worker UPDATE-by-id), but this T3-create
    // path can only mint type=league. The refactor needs a way to opt
    // into 'competition' creation. Captured as baseline.
    expect(rows[0].type).toBe('league');
  });

  test('T1 hit merges extraMetadata into existing row', async () => {
    if (!pgAvailable) return;
    const canonical = novel('league_b');
    const hit1 = await leagueResolver.resolve(canonical, 'sports', {
      sport_canonical: 'tennis',
    });
    expect(hit1).not.toBeNull();
    // Second call with different extraMetadata — should re-merge.
    const hit2 = await leagueResolver.resolve(canonical, 'sports', {
      domain: 'doubles_only',
    });
    expect(hit2?.id).toBe(hit1!.id);
    const rows = await query<{ metadata: Record<string, unknown>; sport_canonical: string | null }>(
      `SELECT metadata, sport_canonical FROM known_entities WHERE id = $1`,
      [hit1!.id],
    );
    expect(rows[0].sport_canonical).toBe('tennis');
    expect(rows[0].metadata.domain).toBe('doubles_only');
  });
});

describe('providerResolver — data_provider creation path', () => {
  test('T3 creates a data_provider row with type=data_provider', async () => {
    if (!pgAvailable) return;
    const canonical = novel('provider_a');
    const hit = await providerResolver.resolve(canonical, 'sports');
    expect(hit).not.toBeNull();
    const rows = await query<{ type: string; metadata: Record<string, unknown> }>(
      `SELECT type, metadata FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    expect(rows[0].type).toBe('data_provider');
    expect(rows[0].metadata.kind).toBe('data_provider');
  });

  test('extraMetadata.domain stamped on creation (e.g. "candle_aggregator")', async () => {
    if (!pgAvailable) return;
    const canonical = novel('provider_b');
    const hit = await providerResolver.resolve(canonical, 'crypto', {
      domain: 'candle_aggregator',
    });
    expect(hit).not.toBeNull();
    const rows = await query<{ metadata: Record<string, unknown>; domain_category: string }>(
      `SELECT metadata, domain_category FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    expect(rows[0].metadata.domain).toBe('candle_aggregator');
    expect(rows[0].domain_category).toBe('crypto');
  });
});

describe('current GAP — the refactor needs to close these', () => {
  test('GAP: sportResolver does NOT take an aliases list (ensureTaxonomyEntity does)', async () => {
    if (!pgAvailable) return;
    // The refactor: sportResolver.resolve should accept an `aliases` field
    // (in extraMetadata or as a separate param) and write them into the
    // known_entities.aliases column. Today it cannot.
    const canonical = novel('gap_sport_aliases');
    // No way to pass ['sumō', 'ozumo'] through this API today.
    const hit = await sportResolver.resolve(canonical, 'sports');
    const rows = await query<{ aliases: string }>(
      `SELECT aliases::text AS aliases FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    // Baseline: aliases is always '[]' on T3 creation.
    expect(JSON.parse(rows[0].aliases)).toEqual([]);
  });

  test('GAP: leagueResolver does NOT take a parent_sport_canonical (ensureTaxonomyEntity does)', async () => {
    if (!pgAvailable) return;
    // ensureTaxonomyEntity stamps `metadata.sport_canonical = parent` so
    // the generated `sport_canonical` column gets populated. With the
    // resolver, this would have to come through extraMetadata — and the
    // refactor needs to keep that working *without* changing T3 INSERT
    // semantics for non-sport extraMetadata. This baseline shows that
    // extraMetadata.sport_canonical IS plumbed through today.
    const canonical = novel('gap_league_parent');
    const hit = await leagueResolver.resolve(canonical, 'sports', {
      sport_canonical: 'tennis',
    });
    const rows = await query<{ sport_canonical: string | null }>(
      `SELECT sport_canonical FROM known_entities WHERE id = $1`,
      [hit!.id],
    );
    expect(rows[0].sport_canonical).toBe('tennis');
  });
});
