/**
 * Canonical UPSERT path for `known_entities` rows created at RUNTIME. Conflict
 * policy is "existing wins": canonical/type/enrichment_status are never
 * overwritten, aliases union, metadata keeps existing keys and adds new ones.
 * Seeds use different, stronger (force-replace) semantics and bypass this helper.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { entitySpecificTokens } from './tokens.js';

const log = createLogger('entity-kb');

/** A canonical with zero non-context tokens can never cosine-merge via T2; T1 exact alias is its only merge path. */
let _mergeBlindRegistrations = 0;
export function mergeBlindRegistrationCount(): number {
  return _mergeBlindRegistrations;
}
function warnIfMergeBlind(canonical: string): void {
  try {
    if (entitySpecificTokens(canonical).length > 0) return;
  } catch {
    return;
  }
  _mergeBlindRegistrations++;
  log.warn(
    `merge-blind KB canonical registered: "${canonical}" — no entity-specific ` +
    `tokens (T2 cosine merge impossible; T1 exact alias is the only merge path)`,
  );
}

export interface UpsertKnownEntityInput {
  canonical: string;
  type: string;
  aliases: readonly string[];
  metadata: Record<string, unknown>;
  domain_category: string;
}

export interface UpsertKnownEntityOptions {
  initialEnrichmentStatus?: 'pending' | 'enriched';
}

export interface UpsertKnownEntityResult {
  id: number;
  canonical: string;
  /** Drives downstream side effects: enqueueEntityEnrichment/_kbCacheInsert only fire on true. */
  newRow: boolean;
}

/** Does NOT fold diacritic/case/despace variants; a caller wanting dedup MUST run `findFoldVariantBridge` first. */
export async function upsertKnownEntity(
  ent: UpsertKnownEntityInput,
  options: UpsertKnownEntityOptions = {},
): Promise<UpsertKnownEntityResult> {
  try {
    const rows = await query<{ id: number; canonical: string; new_row: boolean }>(
      `INSERT INTO known_entities (canonical, type, aliases, domain_category, metadata, enrichment_status)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, COALESCE($6, 'pending'))
       ON CONFLICT ON CONSTRAINT known_entities_canonical_sport_league_key DO UPDATE SET
         aliases = COALESCE((
           SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
           FROM (
             SELECT jsonb_array_elements_text(known_entities.aliases) AS alias
             UNION
             SELECT jsonb_array_elements_text(EXCLUDED.aliases)
           ) sub
         ), '[]'::jsonb),
         domain_category = CASE WHEN known_entities.domain_category = 'other'
                                THEN EXCLUDED.domain_category
                                ELSE known_entities.domain_category END,
         metadata = EXCLUDED.metadata || COALESCE(known_entities.metadata, '{}'::jsonb),
         updated_at = NOW()
       RETURNING id, canonical, (xmax = 0) AS new_row`,
      [
        ent.canonical,
        ent.type,
        JSON.stringify(ent.aliases),
        ent.domain_category,
        JSON.stringify(ent.metadata),
        options.initialEnrichmentStatus ?? null,
      ],
    );
    if (rows[0].new_row) warnIfMergeBlind(rows[0].canonical);
    return {
      id: rows[0].id,
      canonical: rows[0].canonical,
      newRow: rows[0].new_row,
    };
  } catch (err) {
    // The metadata merge can itself trigger the unique constraint; recover by SELECTing the winner row.
    const e = err as { code?: string; constraint?: string; detail?: string };
    if (e?.code !== '23505') throw err;
    if (e?.constraint !== 'known_entities_canonical_sport_league_key') throw err;

    const meta = ent.metadata as { sport_canonical?: string | null; league_canonical?: string | null };
    const targetSport  = typeof meta.sport_canonical  === 'string' ? meta.sport_canonical  : null;
    const targetLeague = typeof meta.league_canonical === 'string' ? meta.league_canonical : null;
    const existing = await query<{ id: number; canonical: string }>(
      `SELECT id, canonical FROM known_entities
        WHERE lower(canonical) = lower($1)
          AND sport_canonical  IS NOT DISTINCT FROM $2::text
          AND league_canonical IS NOT DISTINCT FROM $3::text
        LIMIT 1`,
      [ent.canonical, targetSport, targetLeague],
    );
    if (existing.length === 0) {
      throw err;
    }
    log.warn(
      `upsertKnownEntity: 23505 on "${ent.canonical}" (sport=${targetSport ?? '∅'}, league=${targetLeague ?? '∅'}) — ` +
      `using existing id=${existing[0].id}. Detail: ${e.detail ?? ''}`,
    );
    return {
      id: existing[0].id,
      canonical: existing[0].canonical,
      newRow: false,
    };
  }
}
