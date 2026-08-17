// KB-driven platform-specific structural signal index: each league/competition
// known_entities row carries a metadata.platform_signals object (e.g. Kalshi
// ticker prefixes) so Stage 1 recognizes a new league without a code change.
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('structural-signals');

export interface PlatformSignals {
  kalshi_ticker_prefixes?: string[];
}

export interface StructuralSignalsIndex {
  // Sorted by descending prefix length so longest match wins.
  kalshiPrefixesSorted: ReadonlyArray<{
    prefix: string;
    league_canonical: string;
    sport_canonical: string | null;
    // Callers must not stamp league_canonical on team/person entities for these.
    cross_league: boolean;
  }>;
  crossLeagueCanonicals: ReadonlySet<string>;
}

const EMPTY_INDEX: StructuralSignalsIndex = {
  kalshiPrefixesSorted: [],
  crossLeagueCanonicals: new Set(),
};

let _index: StructuralSignalsIndex = EMPTY_INDEX;

// Idempotent — call at pipeline startup.
export async function loadStructuralSignalsIndex(): Promise<StructuralSignalsIndex> {
  const rows = await query<{
    id: number;
    canonical: string;
    sport_canonical: string | null;
    prefixes: string[] | null;
    cross_league: boolean | null;
  }>(
    `SELECT id, canonical, sport_canonical,
            (SELECT array_agg(value)
               FROM jsonb_array_elements_text(metadata->'platform_signals'->'kalshi_ticker_prefixes')) AS prefixes,
            (metadata->>'cross_league')::boolean                                     AS cross_league
       FROM known_entities
      WHERE type IN ('league', 'competition')
        AND (
              jsonb_typeof(metadata->'platform_signals'->'kalshi_ticker_prefixes') = 'array'
              OR (metadata->>'cross_league')::boolean = TRUE
            )`,
  );

  const entries: {
    prefix: string;
    league_canonical: string;
    sport_canonical: string | null;
    cross_league: boolean;
  }[] = [];
  const crossLeagueCanonicals = new Set<string>();
  let withoutSport = 0;
  const collisions = new Map<string, string[]>();

  for (const r of rows) {
    const crossLeague = r.cross_league === true;
    if (crossLeague) crossLeagueCanonicals.add(r.canonical);

    const prefixes = (r.prefixes ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (prefixes.length === 0) continue;
    if (r.sport_canonical == null) {
      withoutSport++;
    }
    for (const prefix of prefixes) {
      entries.push({
        prefix,
        league_canonical: r.canonical,
        sport_canonical: r.sport_canonical,
        cross_league: crossLeague,
      });
      const bucket = collisions.get(prefix);
      if (bucket) bucket.push(r.canonical);
      else collisions.set(prefix, [r.canonical]);
    }
  }

  for (const [prefix, leagues] of collisions) {
    if (leagues.length > 1) {
      log.warn(
        `Kalshi ticker prefix '${prefix}' claimed by ${leagues.length} leagues: ` +
        `${leagues.join(' | ')} — first match by longest-prefix-then-id will win`
      );
    }
  }

  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  _index = { kalshiPrefixesSorted: entries, crossLeagueCanonicals };
  log.info(
    `Loaded structural signals: ${entries.length} Kalshi prefix entries across ` +
    `${rows.length} league/competition rows ` +
    `(${crossLeagueCanonicals.size} cross-league)` +
    (withoutSport > 0 ? `, ${withoutSport} without sport_canonical` : '')
  );
  return _index;
}

export function getStructuralSignalsIndex(): StructuralSignalsIndex {
  return _index;
}

export function _resetStructuralSignalsIndexForTests(): void {
  _index = EMPTY_INDEX;
}
