/** KB taxonomy resolver: normalizes sport_canonical/league_canonical strings to their KB canonical form via canonical/alias match. */

import { createLogger } from '@arb/logger';
import { _kbByCanonical, _kbByAlias, _ensureKBCache } from './cache.js';
import { areSportsCompatible } from './sport-hierarchy.js';

const log = createLogger('entity-kb');

/** Strip a leading season/year token so a season-prefixed title resolves to its base league ('2025-26 la liga' -> 'la liga'); leaves ordinal tiers ('la liga 2') unchanged. */
export function stripSeasonPrefix(s: string): string {
  const m = /^(?:19|20)\d{2}(?:[\s\-–]\d{2})?\s+(\S.*)$/.exec(s.trim());
  return m ? m[1].trim() : s.trim();
}

/** The stage/umbrella token alternation; single source for the TS and SQL-twin regexes that strip/guard stage suffixes. */
export const STAGE_SUFFIX_TOKENS = 'playoffs?|play-?offs?|post-?season|finals|championship|tour';
const STAGE_SUFFIX_TOKEN = new RegExp(`(?:${STAGE_SUFFIX_TOKENS})`);
const TRAILING_STAGE_RX = new RegExp(`\\s+${STAGE_SUFFIX_TOKEN.source}\\s*$`, 'i');
const BARE_STAGE_RX = new RegExp(`^${STAGE_SUFFIX_TOKEN.source}$`, 'i');
// "<governing-body acronym> Championship" is a proper competition name, not a stage-suffixed league; mirrored in the SQL twins.
const ACRONYM_CHAMPIONSHIP_RX = /^[a-z0-9]{2,4}\s+championship$/i;
/** Strip one trailing stage/umbrella token ('nba playoffs' -> 'nba') so it resolves to the base league; guarded against acronym-championship names and bare-stage remainders. */
export function stripStageSuffix(s: string): string {
  const t = s.trim();
  if (ACRONYM_CHAMPIONSHIP_RX.test(t)) return t;
  const stripped = t.replace(TRAILING_STAGE_RX, '').trim();
  if (stripped.length === 0 || stripped === t || BARE_STAGE_RX.test(stripped)) return t;
  return stripped;
}

/** Unified league fold key (season-strip + stage-strip + lowercase/despace); must fold identically at every stage that gates on league, or merged pairs silently lose their edges. SQL twins mirror it. */
export function foldLeagueKey(s: string): string {
  return stripStageSuffix(stripSeasonPrefix(s)).toLowerCase().replace(/ /g, '');
}

/** Resolve a free-form taxonomy string to its KB canonical via canonical/alias match, restricted to `kind`; null means no existing level-1 entity matched. */
export async function resolveTaxonomyCanonical(
  candidate: string | null | undefined,
  kind: 'sport' | 'league',
): Promise<string | null> {
  if (!candidate) return null;
  const raw = candidate.trim().toLowerCase();
  if (raw.length === 0) return null;
  const normalized = raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const keys = normalized === raw ? [raw] : [raw, normalized];
  if (kind === 'league') {
    const stripped = stripSeasonPrefix(raw);
    if (stripped !== raw && stripped.length > 0 && !keys.includes(stripped)) {
      keys.push(stripped);
    }
    const strippedNorm = stripSeasonPrefix(normalized);
    if (strippedNorm !== normalized && strippedNorm.length > 0 && !keys.includes(strippedNorm)) {
      keys.push(strippedNorm);
    }
    for (const k of [...keys]) {
      const st = stripStageSuffix(k);
      if (st !== k && st.length > 0 && !keys.includes(st)) keys.push(st);
    }
  }
  await _ensureKBCache();

  for (const key of keys) {
    const canonicalBucket = _kbByCanonical.get(key);
    if (canonicalBucket) {
      const hits = canonicalBucket.filter((r) => r.type === kind);
      if (hits.length === 1) return hits[0].canonical;
      if (hits.length > 1) {
        log.warn(`resolveTaxonomyCanonical: ambiguous canonical "${candidate}" matches ${hits.length} ${kind} rows: ${hits.map(h => `id=${h.id}`).join(', ')} — returning null`);
        return null;
      }
    }
    const aliasBucket = _kbByAlias.get(key);
    if (aliasBucket) {
      const hits = aliasBucket.filter((r) => r.type === kind);
      if (hits.length === 1) return hits[0].canonical;
      if (hits.length > 1) {
        const canonicals = hits.map((h) => h.canonical).join(' | ');
        log.warn(`resolveTaxonomyCanonical: ambiguous alias "${candidate}" matches multiple ${kind} canonicals: ${canonicals} — returning null`);
        return null;
      }
    }
  }
  return null;
}

/** Sport tokens aliased to more than one canonical (currently only 'football'); resolveTaxonomyCanonical returns null on these, normalizeSportCanonical disambiguates by league context. */
export const AMBIGUOUS_BARE_SPORTS: ReadonlySet<string> = new Set(['football']);

/** Read a league/competition's sport_canonical from the warm KB cache by canonical or alias; null when unknown. */
function leagueSportFromCache(leagueLower: string): string | null {
  const pick = (bucket: { type: string; sport_canonical: string | null }[] | undefined): string | null => {
    if (!bucket) return null;
    const hit = bucket.find(
      (r) => (r.type === 'league' || r.type === 'competition') && r.sport_canonical,
    );
    return hit?.sport_canonical ?? null;
  };
  return pick(_kbByCanonical.get(leagueLower)) ?? pick(_kbByAlias.get(leagueLower));
}

/** Like leagueSportFromCache, but returns a sport only when every matching row agrees on exactly one — a bare league string that collides across sports returns null rather than guessing. */
function leagueSingleSportFromCache(leagueLower: string): string | null {
  const sports = new Set<string>();
  const collect = (bucket: { type: string; sport_canonical: string | null }[] | undefined): void => {
    if (!bucket) return;
    for (const r of bucket) {
      if ((r.type === 'league' || r.type === 'competition') && r.sport_canonical) {
        sports.add(r.sport_canonical.trim().toLowerCase());
      }
    }
  };
  collect(_kbByCanonical.get(leagueLower));
  collect(_kbByAlias.get(leagueLower));
  return sports.size === 1 ? [...sports][0] : null;
}

/** Pure league-authoritative sport override: keeps `resolvedSport` unless `leagueSport` is known and incompatible, in which case it wins. */
export function decideLeagueSportOverride(
  resolvedSport: string,
  leagueSport: string | null,
): string {
  if (!leagueSport) return resolvedSport;
  if (areSportsCompatible(resolvedSport, leagueSport)) return resolvedSport;
  return leagueSport;
}

/**
 * Resolve a sport string to its KB canonical, disambiguating known-ambiguous bare tokens by
 * league context. Tri-state: string = resolved; null = ambiguous with no decisive league
 * context (caller must clear the field); undefined = novel/unresolvable, leave raw.
 */
export async function normalizeSportCanonical(
  sport: string | null | undefined,
  ctx: { league?: string | null } = {},
): Promise<string | null | undefined> {
  if (!sport) return undefined;
  const raw = sport.trim().toLowerCase();
  if (raw.length === 0) return undefined;

  if (AMBIGUOUS_BARE_SPORTS.has(raw)) {
    await _ensureKBCache();
    const league = ctx.league?.trim().toLowerCase();
    if (league) {
      const leagueSport = leagueSportFromCache(league);
      if (leagueSport) return leagueSport;
    }
    return null;
  }

  const resolved = await resolveTaxonomyCanonical(raw, 'sport');
  if (resolved == null) return undefined;

  const league = ctx.league?.trim().toLowerCase();
  if (league) {
    await _ensureKBCache();
    const leagueSport = leagueSingleSportFromCache(league);
    const decided = decideLeagueSportOverride(resolved, leagueSport);
    if (decided !== resolved) {
      log.info(
        `normalizeSportCanonical: league "${league}" overrides incompatible sport ` +
        `"${resolved}" → "${decided}" (authoritative single-sport league)`,
      );
      return decided;
    }
  }
  return resolved;
}

/** Sorted snapshot of the KB's sport/league canonicals, for in-prompt LLM enrichment context. */
export async function getTaxonomyContext(): Promise<{ sports: string[]; leagues: string[] }> {
  await _ensureKBCache();
  const sports: string[] = [];
  const leagues: string[] = [];
  for (const rows of _kbByCanonical.values()) {
    for (const r of rows) {
      if (r.type === 'sport')  sports.push(r.canonical);
      if (r.type === 'league') leagues.push(r.canonical);
    }
  }
  sports.sort((a, b) => a.localeCompare(b));
  leagues.sort((a, b) => a.localeCompare(b));
  return { sports, leagues };
}
