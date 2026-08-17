/**
 * One-shot backfill — normalises every existing `metadata.sport_canonical` /
 * `metadata.league_canonical` string on `known_entities` through the KB
 * resolver. Rows whose raw string matches a level-1 alias or canonical
 * get rewritten to the canonical form; rows whose string has no KB match
 * are left untouched (surfacing them via H6/H7 for follow-up curation).
 *
 * Idempotent: the second run rewrites zero rows because the first run
 * already canonicalised every resolvable value.
 *
 * Run: bun run scripts/backfill-kb-taxonomy.ts
 *
 * Reports:
 *   - rows scanned
 *   - rows rewritten (sport / league)
 *   - rows still unresolved (dangling — log first 20 distinct values)
 */
import { query } from '@arb/db';
import {
  warmKBCache,
  resolveTaxonomyCanonical,
} from '../services/pipeline/src/db/entity-registry.js';

await warmKBCache();

interface Row {
  id: number;
  raw_sport: string | null;
  raw_league: string | null;
}

const rows = await query<Row>(`
  SELECT id,
         metadata->>'sport_canonical'  AS raw_sport,
         metadata->>'league_canonical' AS raw_league
  FROM known_entities
  WHERE metadata ? 'sport_canonical' OR metadata ? 'league_canonical'
`);

let scanned = 0;
let rewroteSport = 0;
let rewroteLeague = 0;
const unresolvedSport = new Map<string, number>();
const unresolvedLeague = new Map<string, number>();
const updates: { id: number; newSport: string | null; newLeague: string | null }[] = [];

for (const r of rows) {
  scanned++;
  let newSport: string | null = null;
  let newLeague: string | null = null;
  let changed = false;

  if (r.raw_sport) {
    const resolved = await resolveTaxonomyCanonical(r.raw_sport, 'sport');
    if (resolved && resolved !== r.raw_sport) {
      newSport = resolved;
      rewroteSport++;
      changed = true;
    } else if (!resolved) {
      unresolvedSport.set(r.raw_sport, (unresolvedSport.get(r.raw_sport) ?? 0) + 1);
    }
  }
  if (r.raw_league) {
    const resolved = await resolveTaxonomyCanonical(r.raw_league, 'league');
    if (resolved && resolved !== r.raw_league) {
      newLeague = resolved;
      rewroteLeague++;
      changed = true;
    } else if (!resolved) {
      unresolvedLeague.set(r.raw_league, (unresolvedLeague.get(r.raw_league) ?? 0) + 1);
    }
  }
  if (changed) updates.push({ id: r.id, newSport, newLeague });
}

// Apply updates row-by-row. Collisions on the
// (canonical, sport_canonical, league_canonical) unique constraint mean a
// duplicate entity already exists with the canonical-form metadata — the
// merge worker will reconcile those. Skip them here, count them for the
// report.
let applied = 0;
let collidedWithExisting = 0;
const collidedRows: { id: number; canonical: string; reason: string }[] = [];

for (const u of updates) {
  const patch: Record<string, string> = {};
  if (u.newSport)  patch.sport_canonical  = u.newSport;
  if (u.newLeague) patch.league_canonical = u.newLeague;
  try {
    await query(
      `UPDATE known_entities
         SET metadata = metadata || $2::jsonb,
             updated_at = NOW()
       WHERE id = $1`,
      [u.id, JSON.stringify(patch)],
    );
    applied++;
  } catch (err) {
    const e = err as { code?: string; detail?: string };
    if (e.code === '23505') {
      collidedWithExisting++;
      const lookup = await query<{ canonical: string }>(`SELECT canonical FROM known_entities WHERE id = $1`, [u.id]);
      collidedRows.push({ id: u.id, canonical: lookup[0]?.canonical ?? '?', reason: e.detail ?? 'unique violation' });
    } else {
      throw err;
    }
  }
}

console.log('── backfill-kb-taxonomy ──');
console.log(`scanned:                  ${scanned}`);
console.log(`rewroteSport:             ${rewroteSport}`);
console.log(`rewroteLeague:            ${rewroteLeague}`);
console.log(`updatedRows:              ${updates.length}`);
console.log(`applied:                  ${applied}`);
console.log(`collidedWithExisting:     ${collidedWithExisting}  (duplicate entities — merge worker will reconcile)`);
if (collidedRows.length > 0) {
  console.log(`first ${Math.min(10, collidedRows.length)} collisions:`);
  collidedRows.slice(0, 10).forEach((c) =>
    console.log(`  id=${c.id} canonical="${c.canonical}"  ${c.reason}`)
  );
}
console.log('');
console.log(`unresolved sport (${unresolvedSport.size} distinct):`);
[...unresolvedSport.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} × "${k}"`));
console.log('');
console.log(`unresolved league (${unresolvedLeague.size} distinct):`);
[...unresolvedLeague.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} × "${k}"`));

process.exit(0);
