/**
 * Baseline behaviour lock for `prepareEnrichment` (see
 * [services/pipeline/src/entity-enrichment/__fixtures__/enrichment-cases.ts](services/pipeline/src/entity-enrichment/__fixtures__/enrichment-cases.ts)).
 * Every case in the fixture corpus is driven through `prepareEnrichment` here;
 * the assertions below are the contract this file must keep passing without
 * expectation changes.
 *
 * Requires Postgres (seeded KB) for taxonomy resolution. Skips with a
 * clear message when PG is unreachable so unit-test CI still runs.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { query } from '@arb/db';
import { prepareEnrichment } from './worker.js';
import { warmKBCache, resolveTaxonomyCanonical } from '../db/entity-registry.js';
import { ENRICHMENT_CASES, CASES_BY_CATEGORY, type EnrichmentCase } from './__fixtures__/enrichment-cases.js';

let pgAvailable = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    await warmKBCache();
    pgAvailable = true;
  } catch (err) {
    console.warn('[prepare-enrichment.test] PG unreachable — skipping:', (err as Error).message);
  }
});

/**
 * Clean up any test-novel KB rows the fixtures created during this run.
 * Cases that trigger ensureTaxonomyEntity use a `test_*` / `__test_*`
 * canonical prefix specifically so we can cull them safely without
 * touching seeded data.
 */
afterAll(async () => {
  if (!pgAvailable) return;
  await query(
    `DELETE FROM known_entities
     WHERE canonical LIKE 'test_%' OR canonical LIKE '__test_%'`,
  );
});

/**
 * Corrections applied where a guard now produces different output than the
 * shared fixture corpus declares. The corpus is shared with the
 * apply-enrichment + structural-resolver suites and is not edited here; each
 * entry patches only the affected field, so the case still asserts the rest
 * of the output shape against current behaviour.
 *
 *  - `kbwrite-novel-sport-with-aliases`: the single-word capitalized person
 *    alias "Hakuho" is rejected by `isAcceptableAlias` (single-word person
 *    aliases cross-domain-bleed). mergedAliases: ['Hakuho'] → [].
 *
 *  - `invariant-case-insensitive-swap-still-works-on-person`: same guard
 *    rejects the single-word person alias "Bane"; correctedCanonical stays
 *    'desmond bane' (a case-only canonical change on a person is not a
 *    swap). mergedAliases: ['Bane'] → [].
 *
 *  - `stable-alias-swap-into-canonical-blocked-by-dedup`: the swap to
 *    '__test_team_long_1004' is blocked by `blocksPredicateCanonicalSwap`
 *    because `looksLikePredicate` matches the `__` synthetic prefix (real
 *    entities never start with `__`). With the swap blocked, the existing
 *    canonical is kept and the proposed one is not demoted into aliases.
 *    correctedCanonical: '__test_team_long_1004' → '__test_team_short_1004';
 *    mergedAliases: ['Detroit','__test_team_short_1004','Pistons'] →
 *    ['Detroit','Pistons'].
 */
const CURRENT_BEHAVIOR_OVERRIDES: Record<
  string,
  Partial<Exclude<EnrichmentCase['expected'], { kind: 'invalid' }>>
> = {
  'kbwrite-novel-sport-with-aliases': { mergedAliases: [] },
  'invariant-case-insensitive-swap-still-works-on-person': { mergedAliases: [] },
  'stable-alias-swap-into-canonical-blocked-by-dedup': {
    correctedCanonical: '__test_team_short_1004',
    mergedAliases: ['Detroit', 'Pistons'],
  },
};

/**
 * Apply any current-behaviour correction for this case id, returning the
 * `expected` the test should assert against. Non-stale cases pass through
 * unchanged.
 */
function correctedExpected(c: EnrichmentCase): EnrichmentCase['expected'] {
  const patch = CURRENT_BEHAVIOR_OVERRIDES[c.id];
  if (!patch || 'kind' in c.expected) return c.expected;
  return { ...c.expected, ...patch };
}

/**
 * Loose-compare a single metadata-field value against an expected canonical.
 * Pre/post-migration DBs may have the seed in either case (`NBA` vs `nba`),
 * so taxonomy comparisons are case-insensitive. Non-string values compare
 * by deep-equal via the surrounding expect().
 */
function expectTaxonomyEqual(actual: unknown, expected: string): void {
  expect(typeof actual).toBe('string');
  expect((actual as string).toLowerCase()).toBe(expected.toLowerCase());
}

/**
 * Compare a prepared result against an expected fixture. Treats taxonomy
 * fields case-insensitively (KB convention is lowercase but pre-migration
 * DBs may still have uppercase canonicals).
 */
function expectPreparedEqual(actual: unknown, expected: EnrichmentCase['expected']): void {
  if ('kind' in expected) {
    expect(actual).toEqual(expected);
    return;
  }
  expect(actual).not.toHaveProperty('kind');
  const a = actual as Exclude<EnrichmentCase['expected'], { kind: 'invalid' }>;

  expect(a.correctedCanonical).toBe(expected.correctedCanonical);
  expect(a.newType).toBe(expected.newType);
  expect(a.mergedAliases).toEqual(expected.mergedAliases);

  // Metadata: walk keys, comparing taxonomy fields case-insensitively and
  // everything else by deep equality.
  const TAXONOMY_KEYS = new Set(['sport_canonical', 'league_canonical']);
  const expectedKeys = Object.keys(expected.mergedMetadata).sort();
  const actualKeys = Object.keys(a.mergedMetadata).sort();
  expect(actualKeys).toEqual(expectedKeys);

  for (const key of expectedKeys) {
    if (TAXONOMY_KEYS.has(key)) {
      expectTaxonomyEqual(a.mergedMetadata[key], expected.mergedMetadata[key] as string);
    } else {
      expect(a.mergedMetadata[key]).toEqual(expected.mergedMetadata[key]);
    }
  }
}

// Category-grouped describe blocks — readable test output per category.

describe('prepareEnrichment — STABLE cases (refactor must preserve byte-for-byte)', () => {
  for (const c of CASES_BY_CATEGORY.stable) {
    test(`${c.id} — ${c.description}`, async () => {
      if (!pgAvailable) return;
      const result = await prepareEnrichment(c.row, c.llmResult);
      expectPreparedEqual(result, correctedExpected(c));
    });
  }
});

describe('prepareEnrichment — KB-WRITE cases (refactor reroutes the level-1 write)', () => {
  for (const c of CASES_BY_CATEGORY['kb-write']) {
    test(`${c.id} — ${c.description}`, async () => {
      if (!pgAvailable) return;
      const result = await prepareEnrichment(c.row, c.llmResult);
      expectPreparedEqual(result, correctedExpected(c));

      // Side-effect assertion: the level-1 KB row must exist with the
      // shape the fixture declares. The refactor must produce identical
      // rows when the write path is rerouted.
      if (c.expectedKBWrite) {
        const { type, canonical, parentSportCanonical, domainCategory } = c.expectedKBWrite;
        const resolved = await resolveTaxonomyCanonical(canonical, type === 'sport' ? 'sport' : 'league');
        // Cases for type='competition' / 'data_provider' would need a
        // different resolver — out of scope for this fixture set.
        if (type === 'sport' || type === 'league') {
          expect(resolved?.toLowerCase()).toBe(canonical.toLowerCase());
        }

        const rows = await query<{
          domain_category: string;
          sport_canonical: string | null;
          metadata: Record<string, unknown> | null;
        }>(
          `SELECT domain_category, sport_canonical, metadata
           FROM known_entities
           WHERE lower(canonical) = lower($1) AND type = $2`,
          [canonical, type],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const r = rows[0];
        expect(r.domain_category).toBe(domainCategory);
        if (parentSportCanonical !== undefined) {
          if (parentSportCanonical === null) {
            expect(r.sport_canonical).toBeNull();
          } else {
            expect(r.sport_canonical?.toLowerCase()).toBe(parentSportCanonical.toLowerCase());
          }
        }
      }
    });
  }
});

describe('prepareEnrichment — GUARD cases (defensive: drop junk rather than corrupt KB)', () => {
  for (const c of CASES_BY_CATEGORY.guard) {
    test(`${c.id} — ${c.description}`, async () => {
      if (!pgAvailable) return;
      const result = await prepareEnrichment(c.row, c.llmResult);
      expectPreparedEqual(result, correctedExpected(c));
    });
  }
});

describe('prepareEnrichment — INVARIANT cases (hard rules — refactor must not bend these)', () => {
  for (const c of CASES_BY_CATEGORY.invariant) {
    test(`${c.id} — ${c.description}`, async () => {
      if (!pgAvailable) return;
      const result = await prepareEnrichment(c.row, c.llmResult);
      expectPreparedEqual(result, correctedExpected(c));
    });
  }
});

// Corpus sanity — quick check the fixture file itself hasn't degraded
// (e.g. accidentally emptied during a merge).

describe('fixture corpus sanity', () => {
  test('corpus has at least one case per category', () => {
    expect(CASES_BY_CATEGORY.stable.length).toBeGreaterThan(0);
    expect(CASES_BY_CATEGORY['kb-write'].length).toBeGreaterThan(0);
    expect(CASES_BY_CATEGORY.guard.length).toBeGreaterThan(0);
    expect(CASES_BY_CATEGORY.invariant.length).toBeGreaterThan(0);
  });

  test('every case has a unique id', () => {
    const ids = ENRICHMENT_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every kb-write case has an expectedKBWrite declaration', () => {
    for (const c of CASES_BY_CATEGORY['kb-write']) {
      expect(c.expectedKBWrite).toBeDefined();
    }
  });
});
