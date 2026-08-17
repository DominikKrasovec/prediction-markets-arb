/**
 * DB-backed, read-only integration test: generating a space-invariant variant
 * must never silently merge or ambiguate two different entities.
 *
 * Pins two invariants drift-robustly against the live KB:
 *   (a) Bridge invariant — the "laliga" despace-fold has a single league
 *       owner (a second row would mean the fold-variant bridge regressed and
 *       a fork class re-opened). The despace-fold neighbour "la liga 2" /
 *       Segunda División folds to "laliga2", a different key, and must stay
 *       a separate entity.
 *   (b) Guard mechanics — the exact mergeAliases collision-guard query
 *       (entity/register.ts) still detects "laliga" as taken when asked on
 *       behalf of a different entity (it must be skipped and logged), and
 *       does not flag it for the owner itself (an entity's own variant is
 *       never a self-collision).
 *
 * This test is read-only (SELECT only — no INSERT/UPDATE/DDL).
 * If PG is unreachable the whole suite no-ops.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { query } from '@arb/db';

let pgAvailable = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    pgAvailable = true;
  } catch (err) {
    console.warn('[space-invariant-variant.soundness.test] PG unreachable — skipping:', (err as Error).message);
  }
});

/** The EXACT collision-guard query from mergeAliases (entity/register.ts):
 *  does `candidate` already belong to an entity OTHER than `entityId` (as
 *  alias OR canonical, case-insensitive)? Non-empty result ⇒ mergeAliases
 *  REJECTS the alias instead of writing it. */
async function collisionGuard(entityId: number, candidate: string): Promise<string[]> {
  const rows = await query<{ alias_text: string }>(
    `SELECT DISTINCT a AS alias_text
       FROM known_entities,
            LATERAL jsonb_array_elements_text(aliases) AS a
      WHERE id <> $1
        AND lower(a) = ANY($2)
      UNION
     SELECT lower(canonical)
       FROM known_entities
      WHERE id <> $1 AND lower(canonical) = ANY($2)`,
    [entityId, [candidate]],
  );
  return rows.map((r) => r.alias_text.toLowerCase());
}

describe('soundness — "laliga" fold ownership + collision guard (READ-ONLY)', () => {
  test('bridge invariant: exactly ONE league row owns the "laliga" despace-fold, and it stores the variant', async () => {
    if (!pgAvailable) return;
    const rows = await query<{ id: number; canonical: string; aliases: unknown }>(
      `SELECT id, canonical, aliases
         FROM known_entities
        WHERE lower(replace(immutable_unaccent(canonical), ' ', '')) = 'laliga'
          AND type = 'league'
        ORDER BY id`,
    );
    if (rows.length === 0) {
      // Data drifted (e.g. mid-wipe DB). The pure tests still pin the law;
      // skip rather than assert on absent fixtures.
      console.warn('[soundness] no league row folding to "laliga" — fixture absent; skipping');
      return;
    }
    // POST-BRIDGE INVARIANT: the fold-variant bridge + registration
    // serializer guarantee at most one league row per despace-fold. A second
    // row here means the "LaLiga"-fork class re-opened — a regression.
    expect(rows.length).toBe(1);
    const owner = rows[0];
    // The space-invariant feature stores the despaced variant on the owner:
    // either the canonical IS the bare fold, or "laliga" is among its aliases.
    const aliases: string[] = Array.isArray(owner.aliases)
      ? (owner.aliases as string[])
      : JSON.parse((owner.aliases as string) || '[]');
    const forms = [owner.canonical, ...aliases].map((s) => s.toLowerCase());
    expect(forms).toContain('laliga');
  });

  test('la liga 2 (Segunda División) folds to a DIFFERENT key and stays a separate entity', async () => {
    if (!pgAvailable) return;
    const rows = await query<{ id: number; canonical: string }>(
      `SELECT id, canonical
         FROM known_entities
        WHERE lower(replace(immutable_unaccent(canonical), ' ', '')) = 'laliga2'
          AND type = 'league'`,
    );
    if (rows.length === 0) {
      console.warn('[soundness] no "la liga 2" league row — fixture absent; skipping');
      return;
    }
    // Tier-2 league must never share the "laliga" fold owner's id set — i.e.
    // the digit is identity-bearing and despacing preserved it.
    const primera = await query<{ id: number }>(
      `SELECT id FROM known_entities
        WHERE lower(replace(immutable_unaccent(canonical), ' ', '')) = 'laliga'
          AND type = 'league'`,
    );
    const primeraIds = new Set(primera.map((r) => r.id));
    for (const r of rows) expect(primeraIds.has(r.id)).toBe(false);
  });

  test('mergeAliases collision guard: "laliga" flagged for a DIFFERENT entity, NOT for its owner', async () => {
    if (!pgAvailable) return;
    // The owner of the fold (the "La Liga" row).
    const owner = await query<{ id: number }>(
      `SELECT id FROM known_entities
        WHERE lower(replace(immutable_unaccent(canonical), ' ', '')) = 'laliga'
          AND type = 'league'
        ORDER BY id
        LIMIT 1`,
    );
    if (owner.length === 0) {
      console.warn('[soundness] fold owner not found — fixture absent; skipping guard probe');
      return;
    }
    const ownerId = owner[0].id;

    // (b1) Asked on behalf of the OWNER itself: "laliga" is its own stored
    // variant — the guard must NOT flag it (id <> $1 excludes self).
    const selfCollisions = await collisionGuard(ownerId, 'laliga');
    expect(selfCollisions).not.toContain('laliga');

    // (b2) Asked on behalf of ANY OTHER entity (use the Segunda row when
    // present, else any other league row): the guard MUST surface "laliga"
    // as belonging to a different entity, which is exactly what makes
    // mergeAliases skip the variant + log "Collision guard blocked aliases".
    const other = await query<{ id: number }>(
      `SELECT id FROM known_entities
        WHERE id <> $1 AND type = 'league'
        ORDER BY (lower(replace(immutable_unaccent(canonical), ' ', '')) = 'laliga2') DESC, id
        LIMIT 1`,
      [ownerId],
    );
    if (other.length === 0) {
      console.warn('[soundness] no second league row in KB — skipping cross-entity guard probe');
      return;
    }
    const crossCollisions = await collisionGuard(other[0].id, 'laliga');
    expect(crossCollisions.length).toBeGreaterThan(0);
    expect(crossCollisions).toContain('laliga');
  });
});
