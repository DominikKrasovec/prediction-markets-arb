/**
 * One-off backfill: add the SPACE-INVARIANT (fold+lower+despace) variant of
 * every canonical name and every existing alias to each `known_entities` row,
 * so platform spelling drift like "La Liga" / "LaLiga" / "laliga" resolves to
 * ONE entity via the existing fold+lower lookup paths (cache `_kbKey`, SQL T1).
 *
 * This is the EXISTING-DATA counterpart to the live wire-in: from now on,
 * register/seed write paths stamp the variant automatically (entity/register.ts
 * `mergeAliasVariants`). This script fills the gap for rows that were created
 * BEFORE the feature shipped.
 *
 * SOUNDNESS LAW (paramount — the KB has a history of merge/collision bugs):
 *   - Each candidate variant is routed through the SAME collision guard the
 *     live path uses (`mergeAliasVariants` → `mergeAliases`), which rejects any
 *     variant equal (case-insensitively) to a DIFFERENT entity's canonical or
 *     alias. A blocked variant is SKIPPED + logged ("Collision guard blocked
 *     aliases ...") — NEVER written as a shared alias, never causing a
 *     cross-entity merge. Two entities that are really the same real-world
 *     thing under two spellings ("La Liga" vs "LaLiga") are NOT reconciled
 *     here — that is the merge-probe's job, not this backfill's.
 *   - SAME-ENTITY DEDUP + IDEMPOTENT: `aliasVariantsToAdd` skips variants the
 *     entity already has (under fold+lower), and `mergeAliases` dedups, so a
 *     second run adds nothing.
 *
 * DRY-RUN BY DEFAULT. It only mutates the DB when invoked with `--apply`
 * (or APPLY=1). The lead runs it in an idle window — DO NOT run it
 * automatically (never mutate the DB while a pipeline run is live).
 *
 * Usage:
 *   npx tsx services/pipeline/src/scripts/backfill-space-invariant-aliases.ts            # dry-run (default)
 *   npx tsx services/pipeline/src/scripts/backfill-space-invariant-aliases.ts --apply    # actually write
 *   APPLY=1 npx tsx services/pipeline/src/scripts/backfill-space-invariant-aliases.ts     # actually write
 *   BACKFILL_LIMIT=500 npx tsx services/pipeline/src/scripts/backfill-space-invariant-aliases.ts   # cap rows (dry-run sample; legacy bare LIMIT honored)
 *
 * Side effects (ONLY with --apply):
 *   - UPDATE known_entities.aliases (append space-invariant variants), per row,
 *     collision-guarded. No INSERT/DELETE/DDL. No other column touched besides
 *     updated_at (set by mergeAliases).
 */
import { query, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';
import { aliasVariantsToAdd } from '../db/entity/tokens.js';
import { mergeAliasVariants } from '../db/entity/register.js';

const log = createLogger('backfill-space-invariant-aliases');

const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
// Scoped env name; legacy bare LIMIT honored via alias.
const LIMIT_RAW = readEnv('BACKFILL_LIMIT', { alias: 'LIMIT' });
const LIMIT = LIMIT_RAW ? parseInt(LIMIT_RAW, 10) : null;

interface EntityRow {
  id: number;
  canonical: string;
  aliases: string[] | string;
}

function parseAliases(a: string[] | string): string[] {
  return Array.isArray(a) ? a : JSON.parse(a || '[]');
}

async function main(): Promise<void> {
  const rows = await query<EntityRow>(
    `SELECT id, canonical, aliases
       FROM known_entities
      ORDER BY id
      ${LIMIT != null ? 'LIMIT ' + LIMIT : ''}`,
  );

  log.info(
    `Loaded ${rows.length} known_entities row(s). Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}.`,
  );

  let entitiesWithCandidates = 0;
  let candidateVariants = 0;
  let appliedVariants = 0;
  let entitiesApplied = 0;
  let blockedVariants = 0;

  for (const row of rows) {
    const aliases = parseAliases(row.aliases);
    // PURE candidate set (entity-local, deduped, idempotent). This is what
    // WOULD be offered to the collision guard.
    const candidates = aliasVariantsToAdd(row.canonical, aliases);
    if (candidates.length === 0) continue;

    entitiesWithCandidates++;
    candidateVariants += candidates.length;

    if (!APPLY) {
      log.info(
        `[dry-run] entity ${row.id} "${row.canonical}" → would offer [${candidates.join(', ')}] ` +
        `(collision guard runs on --apply)`,
      );
      continue;
    }

    // APPLY: route through the SAME collision-guarded path the live writes use.
    // Returns ONLY the variants actually persisted (collisions filtered + logged
    // inside mergeAliases). The difference candidates − persisted == blocked.
    const persisted = await mergeAliasVariants(row.id);
    if (persisted.length > 0) {
      entitiesApplied++;
      appliedVariants += persisted.length;
    }
    const blocked = candidates.length - persisted.length;
    if (blocked > 0) blockedVariants += blocked;
  }

  log.info('──────────────────────────────────────────────────────────────');
  log.info(`Entities scanned:              ${rows.length}`);
  log.info(`Entities with new variant(s):  ${entitiesWithCandidates}`);
  log.info(`Candidate variants total:      ${candidateVariants}`);
  if (APPLY) {
    log.info(`Entities updated:              ${entitiesApplied}`);
    log.info(`Variants persisted:           ${appliedVariants}`);
    log.info(`Variants blocked (collision): ${blockedVariants}`);
  } else {
    log.info('DRY-RUN — nothing written. Re-run with --apply to persist.');
  }
  log.info('──────────────────────────────────────────────────────────────');
}

main()
  .catch((err) => {
    log.error(`backfill-space-invariant-aliases failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endPool();
  });
