/**
 * Cross-platform tennis (and other-sport) scope inference tests.
 *
 * Verifies that `inferEntityScope` correctly returns sport/league for the
 * shapes seen across all four platforms:
 *
 *   Kalshi      — event_ticker prefix (KXATPMATCH, KXFOMEN, KXEPLGAME, …)
 *   Polymarket  — markets.tags[] (Tennis, ATP, Premier League, …)
 *   Predict     — markets.category slug (atp-grand-slam-champions-2026)
 *   Limitless   — markets.tags[] (Football Matches, English Premier League, …)
 *
 * Requires live PG (warm KB cache).  Skips when DB unreachable so the
 * unit-test suite still runs in CI without docker.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { query } from '@arb/db';
import { warmKBCache } from '../db/entity-registry.js';
import { inferEntityScope, __TEST__, type ScopeSignals } from './infer-entity-scope.js';

let pgAvailable = false;

beforeAll(async () => {
  try {
    await query(`SELECT 1`);
    await warmKBCache();
    pgAvailable = true;
  } catch (err) {
    console.warn('[infer-entity-scope.test] PG unreachable — skipping:', (err as Error).message);
  }
});

function makeSignals(overrides: Partial<ScopeSignals>): ScopeSignals {
  return {
    platform: 'polymarket',
    event_ticker: null,
    tags: null,
    parent_event_tags: null,
    market_category: null,
    ...overrides,
  };
}

describe('inferEntityScope — Kalshi ticker prefix path', () => {
  test('KXEPLGAME → soccer / Premier League', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXEPLGAME-26MAY24CRYARS',
    }));
    expect(scope).toEqual({ sport: 'soccer', league: 'Premier League' });
  });

  test('KXATPMATCH → tennis / ATP Tour', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXATPMATCH-26MAY04BONSVR-BON',
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'ATP Tour' });
  });

  test('KXWTAMATCH → tennis / WTA Tour', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXWTAMATCH-26MAY10ANIKAR',
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'WTA Tour' });
  });

  test('KXFOMEN → tennis / ATP Tour (French Open men, tour lift b048e11)', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXFOMEN-26',
    }));
    // KXFOMEN maps to the single-tour ATP Tour, not the cross_league 'Grand
    // Slam' entity (which stamps league_canonical=NULL and would bridge
    // ATP x WTA French-Open fake mutexes).
    expect(scope).toEqual({ sport: 'tennis', league: 'ATP Tour' });
  });

  test('KXFOWOMEN → tennis / WTA Tour (French Open women, tour lift b048e11)', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXFOWOMEN-26',
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'WTA Tour' });
  });

  test('KXGRANDSLAM → tennis / Grand Slam', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXGRANDSLAM-CALC26',
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'Grand Slam' });
  });

  test('KXATPGRANDSLAM matches longer prefix before KXATP', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXATPGRANDSLAM-26',
    }));
    // Longer prefix wins — should route to Grand Slam, not ATP Tour.
    expect(scope).toEqual({ sport: 'tennis', league: 'Grand Slam' });
  });

  test('KXITTF → table tennis (sport-only override; no league in KB)', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXITTFMEN-26',
    }));
    expect(scope).toEqual({ sport: 'table tennis', league: null });
  });

  test('KXNBAPTS → basketball / NBA (longest-prefix-first against KXNBA)', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXNBAPTS-26MAY13CLEDET',
    }));
    expect(scope).toEqual({ sport: 'basketball', league: 'NBA' });
  });

  test('KXMVE* (parlay collection) → no match, returns null', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXMVESPORTSMULTIGAMEEXTENDED-26',
    }));
    expect(scope).toBeNull();
  });
});

describe('inferEntityScope — second-division ticker carve-outs (Segunda mislabel fix)', () => {
  // Kalshi runs Segunda División fixtures under KXLALIGA2GAME, and 2.
  // Bundesliga under KXBUNDESLIGA2GAME. Without the carve-out these fall
  // through to the bare KXLALIGA / KXBUNDESLIGA prefix and stamp the first
  // division on second-division clubs.

  test('KXLALIGA2GAME → la liga 2 (Segunda División), NOT La Liga', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXLALIGA2GAME-26MAY16GCFBUR',
    }));
    expect(scope).not.toBeNull();
    expect(scope!.league?.toLowerCase()).toBe('la liga 2');
  });

  test('KXBUNDESLIGA2GAME → 2. Bundesliga, NOT Bundesliga', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXBUNDESLIGA2GAME-26MAY10BSCSGF',
    }));
    expect(scope).not.toBeNull();
    expect(scope!.league?.toLowerCase()).toBe('2. bundesliga');
  });

  test('top-flight series are untouched: KXLALIGAGAME → La Liga, KXLALIGA outright → La Liga', () => {
    if (!pgAvailable) return;
    const game = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXLALIGAGAME-26MAY17SEVRMA',
    }));
    expect(game).toEqual({ sport: 'soccer', league: 'La Liga' });
    const outright = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXLALIGA-26',
    }));
    expect(outright).toEqual({ sport: 'soccer', league: 'La Liga' });
  });

  test('CROSS-SOURCE precedence: a longer in-source prefix beats a shorter DYNAMIC-index prefix', async () => {
    if (!pgAvailable) return;
    // The seed stores 'KXLALIGA' in the La Liga row's
    // metadata.platform_signals.kalshi_ticker_prefixes. Precedence ranks by
    // prefix LENGTH across both the in-source map and the dynamic index,
    // so a dynamic hit never pre-empts a longer in-source prefix.
    const { loadStructuralSignalsIndex } = await import('../db/entity-registry.js');
    await loadStructuralSignalsIndex();

    const segunda = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXLALIGA2GAME-26MAY10CORGCF',
    }));
    expect(segunda).not.toBeNull();
    expect(segunda!.league?.toLowerCase()).toBe('la liga 2');

    // ...while an exact-length dynamic hit still wins for the top flight.
    const primera = inferEntityScope(makeSignals({
      platform: 'kalshi',
      event_ticker: 'KXLALIGAGAME-26MAY17ATMGIR',
    }));
    expect(primera?.league).toBe('La Liga');
  });
});

describe('inferEntityScope — Polymarket tag path', () => {
  test('exact_score market tags → soccer / Premier League', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'polymarket',
      tags: ['Sports', 'EPL', 'Soccer', 'Games', 'Premier League'],
      parent_event_tags: ['Sports', 'Games', 'Soccer', 'Premier League', 'EPL'],
      market_category: 'Sports',
    }));
    expect(scope).toEqual({ sport: 'soccer', league: 'Premier League' });
  });

  test('tennis market tags → tennis / ATP Tour', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'polymarket',
      tags: ['Sports', 'Tennis', 'ATP', 'Roland Garros'],
      market_category: 'Sports',
    }));
    // ATP resolves to ATP Tour league (tennis), preferred over the bare
    // "Tennis" sport entity since league > sport in priority.
    expect(scope).toEqual({ sport: 'tennis', league: 'ATP Tour' });
  });

  test('WTA tagged → tennis / WTA Tour', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'polymarket',
      tags: ['Sports', 'Tennis', 'WTA'],
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'WTA Tour' });
  });

  test('only Tennis tag (no league) → tennis sport, league null', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'polymarket',
      tags: ['Sports', 'Tennis'],
    }));
    expect(scope).toEqual({ sport: 'tennis', league: null });
  });
});

describe('inferEntityScope — Predict slug path', () => {
  test('atp-grand-slam-champions-2026 → tennis / ATP Tour', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'predict',
      market_category: 'atp-grand-slam-champions-2026',
    }));
    expect(scope).toEqual({ sport: 'tennis', league: 'ATP Tour' });
  });

  test('nhl-eastern-conference-champion-198 → ice hockey / NHL', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'predict',
      market_category: 'nhl-eastern-conference-champion-198',
    }));
    expect(scope).toEqual({ sport: 'ice hockey', league: 'NHL' });
  });

  test('mlb-world-series-champion-2026 → baseball / MLB', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'predict',
      market_category: 'mlb-world-series-champion-2026',
    }));
    expect(scope).toEqual({ sport: 'baseball', league: 'MLB' });
  });

  test('cs2-sin2-ast10-2026-05-13 → cs2 sport (no league seeded)', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'predict',
      market_category: 'cs2-sin2-ast10-2026-05-13',
    }));
    // "cs2" is a sport canonical in the KB; no league for it.
    expect(scope?.sport).toBe('cs2');
  });
});

describe('inferEntityScope — Limitless tag path', () => {
  test('Football Matches category with EPL tag → soccer / Premier League', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'limitless',
      tags: ['Football Matches', 'Football', 'Lumy', 'English Premier League', 'club_dominance'],
      market_category: 'Football Matches',
    }));
    // "English Premier League" is an alias of "Premier League" in the KB.
    expect(scope).toEqual({ sport: 'soccer', league: 'Premier League' });
  });

  test('Props category with only club_dominance → soccer sport-only fallback', () => {
    if (!pgAvailable) return;
    const scope = inferEntityScope(makeSignals({
      platform: 'limitless',
      tags: ['Props', 'Football', 'Lumy', 'club_dominance', 'control_game'],
      market_category: 'Props',
    }));
    // No league-resolving tag, no sport KB match (bare "Football" not in KB
    // unambiguously) — the platform-specific terminology fallback for
    // 'club_dominance' returns soccer-only.
    expect(scope).toEqual({ sport: 'soccer', league: null });
  });
});

describe('inferEntityScope — cross-league competitions drop league_canonical', () => {
  // These tests require the Champions League / Grand Slam KB rows to carry
  // `metadata.cross_league: true`. When the row doesn't yet carry it, the
  // tests temporarily UPDATE it and restore on teardown.

  test('Kalshi UCL ticker returns sport-only (no Champions League league)', async () => {
    if (!pgAvailable) return;
    const { loadStructuralSignalsIndex } = await import('../db/entity-registry.js');

    const before = await query<{ metadata: any }>(
      `SELECT metadata FROM known_entities WHERE canonical = 'Champions League' LIMIT 1`
    );
    if (before.length === 0) return; // seed missing — skip
    const beforeMeta = before[0].metadata;

    await query(
      `UPDATE known_entities
         SET metadata = metadata || '{"cross_league": true}'::jsonb
       WHERE canonical = 'Champions League'`
    );

    try {
      await loadStructuralSignalsIndex();

      const scope = inferEntityScope(makeSignals({
        platform: 'kalshi',
        event_ticker: 'KXUCLGAME-26MAY09BMUPSG',
      }));

      // sport stays, league is null — so when this scope feeds
      // scopeToEntityMetadata for a team, only sport_canonical gets stamped,
      // and Pass 1 in register.ts can merge with the team's home-league entity.
      expect(scope).toEqual({ sport: 'soccer', league: null });
    } finally {
      await query(
        `UPDATE known_entities SET metadata = $1::jsonb WHERE canonical = 'Champions League'`,
        [JSON.stringify(beforeMeta)],
      );
      await loadStructuralSignalsIndex();
    }
  });

  test('Polymarket Champions League tag also returns sport-only', async () => {
    if (!pgAvailable) return;
    const { loadStructuralSignalsIndex } = await import('../db/entity-registry.js');

    const before = await query<{ metadata: any }>(
      `SELECT metadata FROM known_entities WHERE canonical = 'Champions League' LIMIT 1`
    );
    if (before.length === 0) return;
    const beforeMeta = before[0].metadata;
    await query(
      `UPDATE known_entities
         SET metadata = metadata || '{"cross_league": true}'::jsonb
       WHERE canonical = 'Champions League'`
    );

    try {
      await loadStructuralSignalsIndex();
      const scope = inferEntityScope(makeSignals({
        platform: 'polymarket',
        tags: ['Sports', 'UCL', 'Champions League', 'Soccer'],
      }));
      expect(scope).toEqual({ sport: 'soccer', league: null });
    } finally {
      await query(
        `UPDATE known_entities SET metadata = $1::jsonb WHERE canonical = 'Champions League'`,
        [JSON.stringify(beforeMeta)],
      );
      await loadStructuralSignalsIndex();
    }
  });

  test('scopeToEntityMetadata never stamps league_canonical on person', () => {
    // Direct test of the helper — independent of KB state.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { scopeToEntityMetadata } = require('../db/entity/types.js');

    const teamPatch = scopeToEntityMetadata(
      { sport: 'soccer', league: 'Premier League' },
      'team',
    );
    expect(teamPatch).toEqual({
      sport_canonical: 'soccer',
      league_canonical: 'Premier League',
    });

    const personPatch = scopeToEntityMetadata(
      { sport: 'tennis', league: 'ATP Tour' },
      'person',
    );
    // Sport stamped, league deliberately omitted.
    expect(personPatch).toEqual({ sport_canonical: 'tennis' });
  });
});

describe('inferEntityScope — KB-driven dynamic index (runtime update workflow)', () => {
  test('adding kalshi_ticker_prefixes via SQL UPDATE is picked up after loadStructuralSignalsIndex', async () => {
    if (!pgAvailable) return;
    const { loadStructuralSignalsIndex } = await import('../db/entity-registry.js');

    const before = await query<{ metadata: any }>(
      `SELECT metadata FROM known_entities WHERE canonical = 'Premier League' LIMIT 1`
    );
    const beforeMeta = before[0]?.metadata ?? {};

    // jsonb_build_object + || merge, since jsonb_set would no-op when the
    // platform_signals key doesn't yet exist.
    await query(
      `UPDATE known_entities
         SET metadata = metadata || jsonb_build_object(
           'platform_signals',
           COALESCE(metadata->'platform_signals', '{}'::jsonb) || jsonb_build_object(
             'kalshi_ticker_prefixes',
             COALESCE(metadata->'platform_signals'->'kalshi_ticker_prefixes', '[]'::jsonb)
               || '["KXTESTRUNTIMEEPL"]'::jsonb
           )
         )
       WHERE canonical = 'Premier League'`
    );

    try {
      // Reload index — this is what happens at the start of the next pipeline run.
      await loadStructuralSignalsIndex();

      const scope = inferEntityScope(makeSignals({
        platform: 'kalshi',
        event_ticker: 'KXTESTRUNTIMEEPL-26MAY09FOO',
      }));

      expect(scope).toEqual({ sport: 'soccer', league: 'Premier League' });
    } finally {
      // Restore exactly the row the snapshot saw.
      await query(
        `UPDATE known_entities SET metadata = $1::jsonb WHERE canonical = 'Premier League'`,
        [JSON.stringify(beforeMeta)],
      );
      await loadStructuralSignalsIndex();
    }
  });
});

describe('lookupLeagueExactInKB — exact-only resolution for ticker aliasStrings', () => {
  test('exact KB names resolve; token-splitting is OFF (the Segunda trap)', () => {
    if (!pgAvailable) return;
    const { lookupLeagueExactInKB, lookupTagInKB } = __TEST__;
    // Exact canonical resolves.
    expect(lookupLeagueExactInKB('Premier League')?.league).toBe('Premier League');
    // The trap this kills: a tier-qualified name that is NOT in the KB must
    // return NULL (→ caller falls back to {league: aliasString} + T3-create),
    // NOT decompose into the PARENT league via token bigrams. lookupTagInKB
    // (the slug path) WOULD resolve this to La Liga via the 'la liga' bigram —
    // which is exactly why the ticker path must not use it.
    expect(lookupLeagueExactInKB('la liga 9999')).toBeNull();
    expect(lookupTagInKB('la liga 9999')?.league).toBe('La Liga');
  });
});

describe('inferEntityScope — no signal cases', () => {
  test('empty signals → null', () => {
    if (!pgAvailable) return;
    expect(inferEntityScope(makeSignals({}))).toBeNull();
  });

  test('non-sport tag bag → null', () => {
    if (!pgAvailable) return;
    expect(inferEntityScope(makeSignals({
      platform: 'polymarket',
      tags: ['Politics', 'Election', '2026'],
    }))).toBeNull();
  });
});

// Additive kalshi series-ticker -> sport fallback.
describe('inferEntityScope — P-SPORT series→sport fallback', () => {
  const k = (ticker: string) => inferEntityScope(makeSignals({ platform: 'kalshi', event_ticker: ticker }));

  test('fills sport for KB-uncovered families (was NULL before P-SPORT)', () => {
    if (!pgAvailable) return;
    // base returns null; wrapper stamps sport-only.
    expect(__TEST__.inferEntityScopeBase(makeSignals({ platform: 'kalshi', event_ticker: 'KXITFMATCH-25X' }))).toBeNull();
    expect(k('KXITFMATCH-25X')).toEqual({ sport: 'tennis', league: null });
    expect(k('KXLOLMAP-25X')).toEqual({ sport: 'league of legends', league: null });
    expect(k('KXSQUASHMATCH-25X')).toEqual({ sport: 'squash', league: null });
    expect(k('KXBRASILEIROGAME-25X')).toEqual({ sport: 'soccer', league: null });
  });

  test('ADDITIVE: never overrides an existing non-NULL sport', () => {
    if (!pgAvailable) return;
    // KXEPLGAME already resolves via KALSHI_LEAGUE_FAMILIES → unchanged.
    const eplBase = __TEST__.inferEntityScopeBase(makeSignals({ platform: 'kalshi', event_ticker: 'KXEPLGAME-25X' }));
    expect(k('KXEPLGAME-25X')).toEqual(eplBase!);
    expect(eplBase!.sport).toBe('soccer');
  });

  test('fills sport but PRESERVES a league-only KB hit (e.g. K League)', () => {
    if (!pgAvailable) return;
    // Whatever league the base resolves, the wrapper keeps it and only adds sport.
    const base = __TEST__.inferEntityScopeBase(makeSignals({ platform: 'kalshi', event_ticker: 'KXKLEAGUEGAME-25X' }));
    const neu = k('KXKLEAGUEGAME-25X');
    expect(neu?.league).toBe(base?.league ?? null); // league unchanged
    expect(neu?.sport).toBe('soccer');              // sport filled
  });

  test('does NOT stamp a non-esports collision series (KXCODINGMODEL)', () => {
    if (!pgAvailable) return;
    // economic AI-coding-model series must remain sport-agnostic.
    expect(k('KXCODINGMODEL-26DEC')).toBeNull();
  });

  test('only fires for kalshi (non-kalshi platforms unaffected)', () => {
    if (!pgAvailable) return;
    expect(inferEntityScope(makeSignals({ platform: 'polymarket', event_ticker: 'KXITFMATCH-25X' }))).toBeNull();
  });
});
