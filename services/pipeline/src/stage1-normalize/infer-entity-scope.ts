/**
 * Structural sport/league inference for Stage 1 entity registration — stamps
 * sport_canonical/league_canonical at INSERT time from platform-specific
 * structural signals (Polymarket/Limitless tags, Kalshi event_ticker prefix,
 * Predict category slug) resolved against the KB. Returns null rather than
 * guessing when no signal matches; `enrichEntityMetadata` tries again post-hoc.
 */
import type { KBScope, KBRow } from '../db/entity/types.js';
import { _kbByCanonical, _kbByAlias } from '../db/entity/cache.js';
import { getStructuralSignalsIndex } from '../db/entity/structural-signals.js';
import { ESPORTS_UMBRELLA } from '../db/entity/sport-hierarchy.js';
import { lookupSeriesSport } from './kalshi-series.js';

/** In-source fallback behind the KB-driven dynamic index (DB wins on equal prefix length).
 *  Walked longest-prefix-first so KXNBAPTS matches before KXNBA. */
const KALSHI_LEAGUE_FAMILIES: ReadonlyArray<{ prefix: string; aliasString: string }> = [
  { prefix: 'KXNBAPTS',          aliasString: 'NBA' },
  { prefix: 'KXNBAREB',          aliasString: 'NBA' },
  { prefix: 'KXNBAAST',          aliasString: 'NBA' },
  { prefix: 'KXNBASTL',          aliasString: 'NBA' },
  { prefix: 'KXNBABLK',          aliasString: 'NBA' },
  { prefix: 'KXNBA3PT',          aliasString: 'NBA' },
  { prefix: 'KXNBASPREAD',       aliasString: 'NBA' },
  { prefix: 'KXNBATOTAL',        aliasString: 'NBA' },
  { prefix: 'KXNBAGAME',         aliasString: 'NBA' },
  { prefix: 'KXNBA',             aliasString: 'NBA' },
  { prefix: 'KXWNBA',            aliasString: 'WNBA' },
  { prefix: 'KXNCAAMBKB',        aliasString: 'NCAAB' },
  { prefix: 'KXNCAAWBKB',        aliasString: 'NCAAB' },
  { prefix: 'KXMLBSPREAD',       aliasString: 'MLB' },
  { prefix: 'KXMLBTOTAL',        aliasString: 'MLB' },
  { prefix: 'KXMLBGAME',         aliasString: 'MLB' },
  { prefix: 'KXMLBHRR',          aliasString: 'MLB' },
  { prefix: 'KXMLBHR',           aliasString: 'MLB' },
  { prefix: 'KXMLBHIT',          aliasString: 'MLB' },
  { prefix: 'KXMLBKS',           aliasString: 'MLB' },
  { prefix: 'KXMLBSTAT',         aliasString: 'MLB' },
  { prefix: 'KXMLBPLAYOFFS',     aliasString: 'MLB' },
  { prefix: 'KXMLB',             aliasString: 'MLB' },
  { prefix: 'KXNHLGOAL',         aliasString: 'NHL' },
  { prefix: 'KXNHLFIRSTGOAL',    aliasString: 'NHL' },
  { prefix: 'KXNHLPTS',          aliasString: 'NHL' },
  { prefix: 'KXNHLAST',          aliasString: 'NHL' },
  { prefix: 'KXNHLSPREAD',       aliasString: 'NHL' },
  { prefix: 'KXNHLTOTAL',        aliasString: 'NHL' },
  { prefix: 'KXNHLGAME',         aliasString: 'NHL' },
  { prefix: 'KXNHL',             aliasString: 'NHL' },
  { prefix: 'KXNFLPLAYOFF',      aliasString: 'NFL' },
  { prefix: 'KXNFLSPREAD',       aliasString: 'NFL' },
  { prefix: 'KXNFLTOTAL',        aliasString: 'NFL' },
  { prefix: 'KXNFLRSHYDS',       aliasString: 'NFL' },
  { prefix: 'KXNFL',             aliasString: 'NFL' },
  { prefix: 'KXEPLGAME',         aliasString: 'Premier League' },
  { prefix: 'KXEPLTOTAL',        aliasString: 'Premier League' },
  { prefix: 'KXEPLBTTS',         aliasString: 'Premier League' },
  { prefix: 'KXEPLSPREAD',       aliasString: 'Premier League' },
  { prefix: 'KXEPLGOAL',         aliasString: 'Premier League' },
  { prefix: 'KXEPL',             aliasString: 'Premier League' },
  // Second-division carve-outs must be longer than the top-flight prefix so the length
  // sort ranks them first — otherwise second-division teams get stamped with the parent league.
  { prefix: 'KXLALIGA2',         aliasString: 'la liga 2' },
  { prefix: 'KXLALIGAGAME',      aliasString: 'La Liga' },
  { prefix: 'KXLALIGATOTAL',     aliasString: 'La Liga' },
  { prefix: 'KXLALIGABTTS',      aliasString: 'La Liga' },
  { prefix: 'KXLALIGASPREAD',    aliasString: 'La Liga' },
  { prefix: 'KXLALIGA',          aliasString: 'La Liga' },
  { prefix: 'KXSERIEAGAME',      aliasString: 'Serie A' },
  { prefix: 'KXSERIEATOTAL',     aliasString: 'Serie A' },
  { prefix: 'KXSERIEABTTS',      aliasString: 'Serie A' },
  { prefix: 'KXSERIEASPREAD',    aliasString: 'Serie A' },
  { prefix: 'KXSERIEA',          aliasString: 'Serie A' },
  { prefix: 'KXBUNDESLIGA2',     aliasString: '2. Bundesliga' },
  { prefix: 'KXBUNDESLIGAGAME',  aliasString: 'Bundesliga' },
  { prefix: 'KXBUNDESLIGATOTAL', aliasString: 'Bundesliga' },
  { prefix: 'KXBUNDESLIGA',      aliasString: 'Bundesliga' },
  { prefix: 'KXLIGUE1GAME',      aliasString: 'Ligue 1' },
  { prefix: 'KXLIGUE',           aliasString: 'Ligue 1' },
  { prefix: 'KXUCLGAME',         aliasString: 'Champions League' },
  { prefix: 'KXUCLBTTS',         aliasString: 'Champions League' },
  { prefix: 'KXUCLTOTAL',        aliasString: 'Champions League' },
  { prefix: 'KXUCLSPREAD',       aliasString: 'Champions League' },
  { prefix: 'KXUCLGOAL',         aliasString: 'Champions League' },
  { prefix: 'KXUCL',             aliasString: 'Champions League' },
  { prefix: 'KXMLS',             aliasString: 'MLS' },
  { prefix: 'KXSCOTTISHPREM',    aliasString: 'Scottish Premiership' },
  { prefix: 'KXKLEAGUE',         aliasString: 'K League' },
  { prefix: 'KXJLEAGUE',         aliasString: 'J League' },
  { prefix: 'KXALEAGUE',         aliasString: 'A-League' },
  { prefix: 'KXSWISSLEAGUE',     aliasString: 'Swiss Super League' },
  { prefix: 'KXIPLGAME',         aliasString: 'IPL' },
  { prefix: 'KXIPLPLAYOFF',      aliasString: 'IPL' },
  { prefix: 'KXIPLFINALS',       aliasString: 'IPL' },
  { prefix: 'KXIPLTEAMTOTAL',    aliasString: 'IPL' },
  { prefix: 'KXIPL',             aliasString: 'IPL' },
  { prefix: 'KXATPMATCH',        aliasString: 'ATP Tour' },
  { prefix: 'KXATPGRANDSLAMFIELD', aliasString: 'Grand Slam' },
  { prefix: 'KXATPGRANDSLAM',    aliasString: 'Grand Slam' },
  { prefix: 'KXATP1RANK',        aliasString: 'ATP Tour' },
  { prefix: 'KXATP',             aliasString: 'ATP Tour' },
  { prefix: 'KXWTAMATCH',        aliasString: 'WTA Tour' },
  { prefix: 'KXWTAGRANDSLAM',    aliasString: 'Grand Slam' },
  { prefix: 'KXWTASERENA',       aliasString: 'WTA Tour' },
  { prefix: 'KXWTA',             aliasString: 'WTA Tour' },
  // KXFOMEN/KXFOWOMEN (French Open) are single-tour by construction, so the tour IS
  // the league here, not the cross-league 'Grand Slam' umbrella.
  { prefix: 'KXFOMEN',           aliasString: 'ATP Tour' },
  { prefix: 'KXFOWOMEN',         aliasString: 'WTA Tour' },
  { prefix: 'KXGRANDSLAM',       aliasString: 'Grand Slam' },
  { prefix: 'KXCALCFO',          aliasString: 'ATP Tour' },
  { prefix: 'KXUFCFIGHT',        aliasString: 'UFC' },
  { prefix: 'KXUFCROUNDS',       aliasString: 'UFC' },
  { prefix: 'KXUFCMOF',          aliasString: 'UFC' },
  { prefix: 'KXUFC',             aliasString: 'UFC' },
  { prefix: 'KXPGAMAJORWIN',     aliasString: 'PGA Tour' },
  { prefix: 'KXPGAMAKECUT',      aliasString: 'PGA Tour' },
  { prefix: 'KXPGATOUR',         aliasString: 'PGA Tour' },
  { prefix: 'KXPGATOP',          aliasString: 'PGA Tour' },
  { prefix: 'KXPGAR',            aliasString: 'PGA Tour' },
  { prefix: 'KXPGA',             aliasString: 'PGA Tour' },
];

const KALSHI_LEAGUE_FAMILIES_SORTED = [...KALSHI_LEAGUE_FAMILIES]
  .sort((a, b) => b.prefix.length - a.prefix.length);

const KALSHI_SPORT_ONLY_FAMILIES: ReadonlyArray<{ prefix: string; sport: string }> = [
  { prefix: 'KXITTF', sport: 'table tennis' },
];
const KALSHI_SPORT_ONLY_FAMILIES_SORTED = [...KALSHI_SPORT_ONLY_FAMILIES]
  .sort((a, b) => b.prefix.length - a.prefix.length);

/** Bare "Football" is intentionally omitted — ambiguous between American football and soccer. */
const SPORT_ONLY_FALLBACK_PATTERNS: ReadonlyArray<{ pattern: RegExp; sport: string }> = [
  { pattern: /\bfootball matches\b/i, sport: 'soccer' },
  { pattern: /\bclub_dominance\b/i,   sport: 'soccer' },
  { pattern: /\boff the pitch\b/i,    sport: 'soccer' },
];

export interface ScopeSignals {
  platform: string;
  event_ticker: string | null;
  tags: string[] | null;
  parent_event_tags: string[] | null;
  market_category: string | null;
}

interface ScopeMatch {
  sport: string | null;
  league: string | null;
}

function lookupTagInKB(rawTag: string): ScopeMatch | null {
  const trimmed = rawTag.trim().toLowerCase();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  if (/[-_\s]/.test(trimmed)) {
    const tokens = trimmed.split(/[-_\s]+/).filter(Boolean);
    for (const t of tokens) candidates.push(t);
    for (let i = 0; i < tokens.length - 1; i++) {
      candidates.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }

  // League/competition first; multiple distinct matches on the same alias skip rather than guess.
  for (const c of candidates) {
    const rows = collectKBRows(c);
    const leagueRows = rows.filter((r) => r.type === 'league' || r.type === 'competition');
    if (leagueRows.length === 0) continue;
    const distinctCanonicals = new Set(leagueRows.map((r) => r.canonical));
    if (distinctCanonicals.size > 1) continue;
    const r = leagueRows[0];
    return { sport: r.sport_canonical, league: r.canonical };
  }
  for (const c of candidates) {
    const rows = collectKBRows(c);
    const sportRows = rows.filter((r) => r.type === 'sport');
    if (sportRows.length === 0) continue;
    const distinctCanonicals = new Set(sportRows.map((r) => r.canonical));
    if (distinctCanonicals.size > 1) continue;
    return { sport: sportRows[0].canonical, league: null };
  }
  return null;
}

/** Unlike lookupTagInKB, does not token-split: a tier-qualified name not yet in the KB
 *  ('la liga 2') would otherwise decompose into a bigram ('la liga') and resolve wrong. */
function lookupLeagueExactInKB(name: string): ScopeMatch | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const rows = collectKBRows(key).filter((r) => r.type === 'league' || r.type === 'competition');
  if (rows.length === 0) return null;
  const distinctCanonicals = new Set(rows.map((r) => r.canonical));
  if (distinctCanonicals.size > 1) return null;
  return { sport: rows[0].sport_canonical, league: rows[0].canonical };
}

/** Collect all KB rows matching `keyLower` across both canonical + alias indices, deduped by id. */
function collectKBRows(keyLower: string): KBRow[] {
  const out: KBRow[] = [];
  const seen = new Set<number>();
  for (const r of _kbByCanonical.get(keyLower) ?? []) {
    if (!seen.has(r.id)) { out.push(r); seen.add(r.id); }
  }
  for (const r of _kbByAlias.get(keyLower) ?? []) {
    if (!seen.has(r.id)) { out.push(r); seen.add(r.id); }
  }
  return out;
}

/** Fires only when the KB/tag paths leave sport still NULL; never overrides an existing
 *  sport or changes league_canonical. */
export function inferEntityScope(signals: ScopeSignals): KBScope | null {
  const base = inferEntityScopeBase(signals);
  if (
    signals.platform === 'kalshi' &&
    signals.event_ticker &&
    (base === null || base.sport == null)
  ) {
    const hit = lookupSeriesSport(signals.event_ticker);
    if (hit) return { sport: hit.spec.sport, league: base?.league ?? null };
  }
  return base;
}

function inferEntityScopeBase(signals: ScopeSignals): KBScope | null {
  // Cross-league competitions (UCL, Grand Slam, World Cup, …) return sport only —
  // stamping the competition as league_canonical would split a team's per-league identity.
  if (signals.platform === 'kalshi' && signals.event_ticker) {
    const prefix = signals.event_ticker.split('-')[0];
    if (prefix) {
      // Specificity outranks source: the longer prefix wins regardless of list, DB
      // wins only on equal length (else a shorter dynamic hit could pre-empt a longer carve-out).
      const dynamicHit = getStructuralSignalsIndex().kalshiPrefixesSorted
        .find((e) => prefix.startsWith(e.prefix)) ?? null;
      const sourceHit = KALSHI_LEAGUE_FAMILIES_SORTED
        .find((e) => prefix.startsWith(e.prefix)) ?? null;

      if (dynamicHit && (!sourceHit || dynamicHit.prefix.length >= sourceHit.prefix.length)) {
        return {
          sport: dynamicHit.sport_canonical,
          league: dynamicHit.cross_league ? null : dynamicHit.league_canonical,
        };
      }
      if (sourceHit) {
        const crossLeagueSet = getStructuralSignalsIndex().crossLeagueCanonicals;
        const hit = lookupLeagueExactInKB(sourceHit.aliasString);
        if (hit && (hit.sport || hit.league)) {
          if (hit.league !== null && crossLeagueSet.has(hit.league)) {
            return { sport: hit.sport, league: null };
          }
          return hit;
        }
        // Unknown-to-KB league: the caller's leagueResolver T3-creates it on first use.
        return { sport: null, league: sourceHit.aliasString };
      }
      for (const entry of KALSHI_SPORT_ONLY_FAMILIES_SORTED) {
        if (prefix.startsWith(entry.prefix)) {
          return { sport: entry.sport, league: null };
        }
      }
    }
  }

  const tags = [
    ...(signals.tags ?? []),
    ...(signals.parent_event_tags ?? []),
    signals.market_category ? [signals.market_category] : [],
  ].flat();

  const crossLeagueSet = getStructuralSignalsIndex().crossLeagueCanonicals;

  for (const tag of tags) {
    const hit = lookupTagInKB(tag);
    if (hit && hit.league !== null) {
      if (crossLeagueSet.has(hit.league)) {
        return { sport: hit.sport, league: null };
      }
      return hit;
    }
  }
  // When tags yield both the 'esports' umbrella and a specific game, the specific game wins.
  let umbrellaFallback: { sport: string; league: null } | null = null;
  for (const tag of tags) {
    const hit = lookupTagInKB(tag);
    if (!hit || hit.sport === null) continue;
    const sport = hit.sport.toLowerCase();
    if (sport === ESPORTS_UMBRELLA) {
      if (!umbrellaFallback) umbrellaFallback = { sport: hit.sport, league: null };
      continue;
    }
    return { sport: hit.sport, league: null };
  }
  if (umbrellaFallback) return umbrellaFallback;

  const tagBag = tags.join(' | ');
  if (tagBag) {
    for (const entry of SPORT_ONLY_FALLBACK_PATTERNS) {
      if (entry.pattern.test(tagBag)) {
        return { sport: entry.sport, league: null };
      }
    }
  }

  return null;
}

export const __TEST__ = {
  KALSHI_LEAGUE_FAMILIES,
  KALSHI_SPORT_ONLY_FAMILIES,
  SPORT_ONLY_FALLBACK_PATTERNS,
  lookupTagInKB,
  lookupLeagueExactInKB,
  inferEntityScopeBase,
};
