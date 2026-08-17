/**
 * League scope-compatibility helpers — KB-driven analog of sport-hierarchy.ts.
 *
 * Sport hierarchy is fixed in code (esports umbrella ↔ specific games). League
 * hierarchy is data-driven: `"AHL"` and `"American Hockey League"` are the
 * same league because one is an alias of the other in `known_entities`. This
 * module reads the warm in-process KB cache to answer compatibility questions
 * without round-trips, and exports a surface that mirrors sport-hierarchy.ts
 * so call sites can stay symmetric.
 *
 * Every gate that consults `league_canonical` (subject resolver T2 scope
 * check, register-side `isScopeIncompatible`, merge-probe candidate SQL) must
 * treat KB-aliased league spellings as one league — e.g. "AHL" and "American
 * Hockey League" are aliases of a single `known_entities` row; a plain
 * string-equality compare would otherwise strand a team under two parallel
 * rows for the same real league. With this helper plugged into each gate,
 * such candidates flow through to the LLM merge-probe verifier.
 */

import { _kbByCanonical, _kbByAlias } from './cache.js';

function norm(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t.length === 0 ? null : t;
}

/**
 * Resolve `text` to its `type='league'` KB row, looking up by canonical first,
 * then by alias. Returns `null` when the cache has no league row matching the
 * text (either the text isn't a registered league, or the cache hasn't been
 * warmed yet — callers fall back to string equality in that case).
 */
function leagueRowFor(textLower: string): { id: number; canonical: string; aliases: string[] } | null {
  const canon = _kbByCanonical.get(textLower);
  if (canon) {
    const hit = canon.find((r) => r.type === 'league');
    if (hit) return { id: hit.id, canonical: hit.canonical, aliases: hit.aliases };
  }
  const alias = _kbByAlias.get(textLower);
  if (alias) {
    const hit = alias.find((r) => r.type === 'league');
    if (hit) return { id: hit.id, canonical: hit.canonical, aliases: hit.aliases };
  }
  return null;
}

/**
 * True when `a` and `b` name the same league for KB-identity purposes.
 *
 *   - Either null → true (scope-agnostic — permissive, matches sport-hierarchy)
 *   - Case-insensitive equal → true
 *   - Both resolve via KB to the same league row id (canonical or alias) → true
 *   - One side string-matches the OTHER side's canonical (when only that side
 *     is in the cache) → true
 *   - Otherwise → false
 *
 * Reads from the in-process KB cache. When neither side is in the cache
 * (e.g. unwarmed cache, or both strings refer to leagues not in the KB) the
 * function degrades to plain string equality.
 *
 * Cross-league competitions (Champions League, Europa League, Grand Slam,
 * etc. — flagged via `metadata.cross_league=true`) are NOT handled here;
 * `isScopeIncompatible` carves them out separately because the semantics are
 * different (a team co-exists in its home league AND the cup competition).
 */
export function areLeaguesCompatible(a: string | null, b: string | null): boolean {
  const aa = norm(a);
  const bb = norm(b);
  if (aa === null || bb === null) return true;
  if (aa === bb) return true;

  const rowA = leagueRowFor(aa);
  const rowB = leagueRowFor(bb);
  if (rowA && rowB && rowA.id === rowB.id) return true;

  // One side resolves; the other string-matches the resolved canonical OR
  // appears in its aliases. Catches the asymmetric case where only the
  // canonical-bearing row is in the cache (the dupe row was filtered out for
  // some reason, or one of the two is a bare text query that never made it
  // into known_entities).
  if (rowA) {
    if (rowA.canonical.toLowerCase() === bb) return true;
    if (rowA.aliases.some((al) => al.toLowerCase() === bb)) return true;
  }
  if (rowB) {
    if (rowB.canonical.toLowerCase() === aa) return true;
    if (rowB.aliases.some((al) => al.toLowerCase() === aa)) return true;
  }

  return false;
}

/**
 * Return the set of league canonicals (lowercased) that are scope-compatible
 * with `league`. Used to widen SQL filters like
 *
 *   `ke.league_canonical = ANY($1::text[])`
 *
 * so a merge-probe candidate query whose source is `"AHL"` sees candidates
 * carrying `"American Hockey League"` (and any other registered alias) too.
 *
 *   - `null` input → `null` (caller drops the filter entirely)
 *   - input has no KB row → `[input]` (only the literal)
 *   - input has a KB row → `[canonical, ...all aliases]` (lowercased)
 */
export function compatibleLeagueCanonicals(league: string | null): string[] | null {
  const ll = norm(league);
  if (ll === null) return null;
  const out = new Set<string>([ll]);
  const row = leagueRowFor(ll);
  if (row) {
    out.add(row.canonical.toLowerCase());
    for (const a of row.aliases) out.add(a.toLowerCase());
  }
  return [...out];
}
