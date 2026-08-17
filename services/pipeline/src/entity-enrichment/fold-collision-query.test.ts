/**
 * PURE unit tests for `buildFoldCollisionQuery` — the fold-aware scoped
 * collision predicate used by the entity-enrichment worker's canonical-SWAP
 * path (applyEnrichment H1 pre-flight + H2 23505 race re-query).
 *
 * These are DB-FREE: they assert the SQL TEXT + PARAM shape, not a live result.
 * (DB-backed entity tests are banned here — entity-registry.test.ts deletes
 * rows; the live read-only repro lives in the standalone tsx probe instead.)
 *
 * An exact `lower(canonical)=lower($1)` collision gate is blind to the
 * diacritic/despace fold siblings the register bridge already dedups at
 * registration, so a swap to a clean canonical can mint a fork. This gate is
 * fold-aware, mirroring findFoldVariantBridge's algebra:
 *   - DIACRITIC fold (all types)   = lower(immutable_unaccent(x))
 *   - DESPACE fold  (non-person)   = lower(immutable_unaccent(replace(x,' ','')))
 */
import { describe, test, expect } from 'bun:test';
import { buildFoldCollisionQuery } from './worker.js';

/** Collapse runs of whitespace so we can assert on the SQL substrings without
 *  being brittle about indentation / line breaks. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('buildFoldCollisionQuery — fold-aware scoped collision predicate', () => {
  test('TEAM (non-person): emits BOTH the diacritic arm AND the despace arm', () => {
    const q = buildFoldCollisionQuery('Curacao', 4321, 'soccer', null, /* isNonPerson */ true);
    const sql = flat(q.text);

    // Diacritic arm — always present, on the bare canonical.
    expect(sql).toContain('lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))');
    // Despace arm — gated on the $5 non-person bool, on replace(...,' ','').
    expect(sql).toContain("$5::bool");
    expect(sql).toContain("lower(immutable_unaccent(replace(canonical,' ','')))");
    expect(sql).toContain("lower(immutable_unaccent(replace($1,' ','')))");

    // It must NOT keep the old fold-blind exact clause.
    expect(sql).not.toContain('lower(canonical) = lower($1)');

    // Scope gate preserved verbatim (self-exclude + sport/league IS NOT DISTINCT).
    expect(sql).toContain('id <> $2');
    expect(sql).toContain('sport_canonical IS NOT DISTINCT FROM ($3::text)');
    expect(sql).toContain('league_canonical IS NOT DISTINCT FROM ($4::text)');
  });

  test('PERSON: despace arm is GATED OFF ($5=false) so it never fires', () => {
    // 'Jose Altuve'/'José Altuve' must merge by DIACRITIC, but 'Alex Sandro'
    // vs 'Alexsandro' (two real people) must NOT merge by despace — hence the
    // person carve-out. We assert the bool param is false; the SQL arm itself
    // is short-circuited by `$5::bool AND ...`.
    const q = buildFoldCollisionQuery('Jose Altuve', 16059, null, 'mlb', /* isNonPerson */ false);
    expect(q.params[4]).toBe(false);

    // Diacritic arm is still emitted (it applies to ALL types incl. person).
    const sql = flat(q.text);
    expect(sql).toContain('lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))');
    // The despace arm is present in TEXT but $5=false makes it inert at runtime.
    expect(sql).toContain('$5::bool');
  });

  test('params are positional and in the documented order', () => {
    const q = buildFoldCollisionQuery('North East United FC', 2231, 'soccer', 'indian super league', true);
    expect(q.params).toEqual(['North East United FC', 2231, 'soccer', 'indian super league', true]);
    // $1 canonical, $2 id, $3 sport, $4 league, $5 isNonPerson.
    expect(q.params[0]).toBe('North East United FC');
    expect(q.params[1]).toBe(2231);
    expect(q.params[2]).toBe('soccer');
    expect(q.params[3]).toBe('indian super league');
    expect(q.params[4]).toBe(true);
  });

  test('null sport / null league are passed through (IS NOT DISTINCT FROM handles NULL)', () => {
    const q = buildFoldCollisionQuery('Türkiye', 702, 'soccer', null, true);
    expect(q.params[3]).toBeNull();
    // sport non-null here; the NULL-league scope still matches a NULL-league sibling.
    expect(flat(q.text)).toContain('league_canonical IS NOT DISTINCT FROM ($4::text)');
  });

  test('the predicate is a single SELECT ... LIMIT 1 (one colliding id, not a force-merge)', () => {
    const q = buildFoldCollisionQuery('Curacao', 4321, 'soccer', null, true);
    const sql = flat(q.text);
    expect(sql.startsWith('SELECT id FROM known_entities')).toBe(true);
    expect(sql.endsWith('LIMIT 1')).toBe(true);
  });
});
