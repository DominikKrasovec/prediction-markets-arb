/**
 * Esports sport-hierarchy helpers: 'esports' is the parent category and the
 * specific games are children, so this module lets the register paths treat
 * an umbrella-tagged row and a game-tagged row as the same scope instead of
 * duplicating the entity. Keep ESPORTS_GAMES in sync with seed-entity-kb.ts.
 */

export const ESPORTS_GAMES: ReadonlySet<string> = new Set([
  'dota 2',
  'cs2',
  'league of legends',
  'valorant',
  'rocket league',
  'starcraft 2',
  'call of duty',
  'rainbow six',
  'overwatch 2',
]);

export const ESPORTS_UMBRELLA = 'esports';

function norm(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t.length === 0 ? null : t;
}

// Strips the '(ncaa)' qualifier so a college market's sport string agrees with a team's bare KB sport; the college-vs-pro distinction is the league axis's job.
const NCAA_SPORT_QUALIFIER = /\s*\(ncaa[a-z]*\)\s*/i;

function baseSportFamily(sportLower: string): string {
  return sportLower.replace(NCAA_SPORT_QUALIFIER, ' ').replace(/\s+/g, ' ').trim();
}

export function areSportsCompatible(a: string | null, b: string | null): boolean {
  const aa = norm(a);
  const bb = norm(b);
  if (aa === null || bb === null) return true;
  if (aa === bb) return true;
  if (aa === ESPORTS_UMBRELLA && ESPORTS_GAMES.has(bb)) return true;
  if (bb === ESPORTS_UMBRELLA && ESPORTS_GAMES.has(aa)) return true;
  if (baseSportFamily(aa) === baseSportFamily(bb)) return true;
  return false;
}

// Deliberately narrower than areSportsCompatible (which must stay false for cs2-vs-valorant, the shared event-matching chokepoint). Only used by the team carve-out that folds a same-named multi-game org's rosters into one identity.
export function areEsportsOrgGamesCompatible(a: string | null, b: string | null): boolean {
  const aa = norm(a);
  const bb = norm(b);
  if (aa === null || bb === null) return true;
  const isEsports = (s: string): boolean => s === ESPORTS_UMBRELLA || ESPORTS_GAMES.has(s);
  return isEsports(aa) && isEsports(bb);
}

/** null input -> null (caller drops the filter); otherwise widens to the umbrella/game/NCAA-base set. */
export function compatibleSportCanonicals(sport: string | null): string[] | null {
  const ss = norm(sport);
  if (ss === null) return null;
  const out = new Set<string>([ss]);
  if (ss === ESPORTS_UMBRELLA) {
    for (const g of ESPORTS_GAMES) out.add(g);
  } else if (ESPORTS_GAMES.has(ss)) {
    out.add(ESPORTS_UMBRELLA);
  } else {
    const base = baseSportFamily(ss);
    if (base !== ss) out.add(base);
  }
  return [...out];
}

// Caller must have already checked areSportsCompatible(existing, incoming).
export function moreSpecificSport(
  existing: string | null,
  incoming: string | null,
): string | null {
  const e = norm(existing);
  const i = norm(incoming);
  if (e === null) return i;
  if (i === null) return e;
  if (e === ESPORTS_UMBRELLA && ESPORTS_GAMES.has(i)) return i;
  if (i === ESPORTS_UMBRELLA && ESPORTS_GAMES.has(e)) return e;
  return e;
}
