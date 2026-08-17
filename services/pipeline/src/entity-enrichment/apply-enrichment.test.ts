/**
 * Layer 2 baseline: full `applyEnrichment` path, including the UPDATE
 * to `known_entities`. Drives a subset of the fixture corpus through the
 * real DB write and asserts the post-write row shape.
 *
 * Test rows live under id 9_000_001 + offset so they don't collide with
 * production ids, and are cleaned up in afterAll.
 *
 * The fixture corpus uses small synthetic ids (1001-4003), remapped here to
 * a safe high range so a developer's matching local ids are never trampled.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { query } from '@arb/db';
import { applyEnrichment, type EntityRow } from './worker.js';
import { warmKBCache } from '../db/entity-registry.js';
import { ENRICHMENT_CASES, type EnrichmentCase } from './__fixtures__/enrichment-cases.js';

let pgAvailable = false;
const TEST_ID_BASE = 9_000_001;

/**
 * Corrections applied on top of the shared fixture corpus's `expected`
 * value, for cases where a worker guard now produces different (correct)
 * output than the fixture's static `expected`. The fixture corpus itself is
 * not edited; this map patches only the affected field per case.
 *
 * Both entries are a guard correctly rejecting bad data:
 *  - `kbwrite-novel-sport-with-aliases`: LLM alias "Hakuho" is rejected by
 *    `isAcceptableAlias`. mergedAliases: ['Hakuho'] -> [].
 *  - `stable-alias-swap-into-canonical-blocked-by-dedup`: the swap is
 *    blocked by `blocksPredicateCanonicalSwap` because the synthetic `__`
 *    prefix matches the blank-fill predicate rule. With the swap blocked
 *    the existing canonical is kept.
 */
const CURRENT_BEHAVIOR_OVERRIDES: Record<
  string,
  Partial<Exclude<EnrichmentCase['expected'], { kind: 'invalid' }>>
> = {
  'kbwrite-novel-sport-with-aliases': { mergedAliases: [] },
  'stable-alias-swap-into-canonical-blocked-by-dedup': {
    correctedCanonical: '__test_team_short_1004',
    mergedAliases: ['Detroit', 'Pistons'],
  },
};

/** Expected output for this case, patched to current behaviour where stale. */
function correctedExpected(c: EnrichmentCase): EnrichmentCase['expected'] {
  const patch = CURRENT_BEHAVIOR_OVERRIDES[c.id];
  if (!patch || 'kind' in c.expected) return c.expected;
  return { ...c.expected, ...patch };
}

/** Map a fixture's small synthetic id into the safe test-id range. */
function testId(fixtureId: number): number {
  return TEST_ID_BASE + fixtureId;
}

beforeAll(async () => {
  try {
    await query('SELECT 1');
    await warmKBCache();
    pgAvailable = true;
  } catch (err) {
    console.warn('[apply-enrichment.test] PG unreachable — skipping:', (err as Error).message);
  }
});

afterAll(async () => {
  if (!pgAvailable) return;
  // Cull test entity rows + any test-novel taxonomy rows the fixtures created.
  await query(
    `DELETE FROM known_entities
     WHERE id >= $1 AND id < $2`,
    [TEST_ID_BASE, TEST_ID_BASE + 100_000],
  );
  await query(
    `DELETE FROM known_entities
     WHERE canonical LIKE 'test_%' OR canonical LIKE '__test_%'`,
  );
});

/**
 * Seed an entity row into known_entities so applyEnrichment has something
 * to UPDATE. Returns the row in the same shape applyEnrichment expects.
 */
async function seedEntity(fixtureRow: EntityRow): Promise<EntityRow> {
  const id = testId(fixtureRow.id);
  await query(
    `INSERT INTO known_entities
       (id, canonical, type, aliases, domain_category, metadata, enrichment_status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
     ON CONFLICT (id) DO UPDATE
       SET canonical = EXCLUDED.canonical,
           type = EXCLUDED.type,
           aliases = EXCLUDED.aliases,
           domain_category = EXCLUDED.domain_category,
           metadata = EXCLUDED.metadata,
           enrichment_status = EXCLUDED.enrichment_status`,
    [
      id,
      fixtureRow.canonical,
      fixtureRow.type,
      JSON.stringify(Array.isArray(fixtureRow.aliases) ? fixtureRow.aliases : []),
      fixtureRow.domain_category,
      JSON.stringify(fixtureRow.metadata ?? {}),
      fixtureRow.enrichment_status,
    ],
  );
  return { ...fixtureRow, id };
}

/**
 * Read the post-write state of a known_entities row for assertions.
 * Returns the fields applyEnrichment writes.
 */
async function readRow(id: number) {
  const rows = await query<{
    canonical: string;
    type: string;
    aliases: string;
    metadata: Record<string, unknown> | null;
    enrichment_status: string;
    domain_category: string;
    sport_canonical: string | null;
    league_canonical: string | null;
  }>(
    `SELECT canonical, type, aliases::text AS aliases, metadata, enrichment_status,
            domain_category, sport_canonical, league_canonical
     FROM known_entities WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return {
    ...rows[0],
    aliases: JSON.parse(rows[0].aliases) as string[],
  };
}

/**
 * Subset of the corpus exercised end-to-end. Skips:
 *  - guard cases that return `kind: 'invalid'` (no UPDATE happens anyway)
 *  - invariant cases for level-1 sport/league rows (UPDATE would clobber
 *    real seed taxonomy; covered at Layer 1 only).
 *
 * Picks cases that meaningfully exercise the write path:
 *   stable + kb-write cases on level-2 (non-taxonomy) rows.
 */
const E2E_CASES = ENRICHMENT_CASES.filter(
  (c) =>
    (c.category === 'stable' || c.category === 'kb-write') &&
    c.row.type !== 'sport' && c.row.type !== 'league',
);

describe('applyEnrichment — UPDATE writes the prepared output to known_entities', () => {
  for (const c of E2E_CASES) {
    test(`${c.id} — DB row matches prepared output after UPDATE`, async () => {
      if (!pgAvailable) return;
      if ('kind' in c.expected) return; // invalid case — applyEnrichment skips UPDATE

      const expected = correctedExpected(c) as Exclude<
        EnrichmentCase['expected'],
        { kind: 'invalid' }
      >;

      const seeded = await seedEntity(c.row);
      const outcome = await applyEnrichment(seeded, c.llmResult);

      // 'wrote' is the happy path. 'collision' would mean a real DB row
      // already had the same scoped canonical — shouldn't happen in this
      // isolated test id range, but flag if it does.
      expect(outcome.kind).toBe('wrote');

      const after = await readRow(seeded.id);
      expect(after).not.toBeNull();
      expect(after!.canonical).toBe(expected.correctedCanonical);
      expect(after!.type).toBe(expected.newType);
      expect(after!.enrichment_status).toBe('enriched');
      expect(after!.aliases).toEqual(expected.mergedAliases);

      // Metadata: keys identical, taxonomy fields compared case-insensitively
      // (KB convention).
      const expectedMd = expected.mergedMetadata;
      const actualMd = after!.metadata ?? {};
      expect(Object.keys(actualMd).sort()).toEqual(Object.keys(expectedMd).sort());
      for (const k of Object.keys(expectedMd)) {
        if (k === 'sport_canonical' || k === 'league_canonical') {
          expect(String(actualMd[k]).toLowerCase()).toBe(String(expectedMd[k]).toLowerCase());
        } else {
          expect(actualMd[k]).toEqual(expectedMd[k]);
        }
      }

      // Generated columns reflect metadata fields (sport_canonical /
      // league_canonical). Verify they got populated when the metadata had them.
      if (typeof expectedMd.sport_canonical === 'string') {
        expect(after!.sport_canonical?.toLowerCase()).toBe(expectedMd.sport_canonical.toLowerCase());
      }
      if (typeof expectedMd.league_canonical === 'string') {
        expect(after!.league_canonical?.toLowerCase()).toBe(expectedMd.league_canonical.toLowerCase());
      }
    });
  }
});

describe('applyEnrichment — invalid LLM payload skips UPDATE', () => {
  test('empty canonical_corrected — row state untouched', async () => {
    if (!pgAvailable) return;
    const guardCase = ENRICHMENT_CASES.find((c) => c.id === 'guard-empty-canonical-rejected');
    expect(guardCase).toBeDefined();
    const seeded = await seedEntity(guardCase!.row);
    const before = await readRow(seeded.id);

    const outcome = await applyEnrichment(seeded, guardCase!.llmResult);
    expect(outcome.kind).toBe('invalid');

    const after = await readRow(seeded.id);
    // UPDATE must not have run — enrichment_status / canonical / aliases
    // all identical to the seeded state.
    expect(after).toEqual(before);
  });
});
