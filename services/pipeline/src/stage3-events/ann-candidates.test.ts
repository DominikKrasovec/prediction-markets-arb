/**
 * Stage 3a ANN candidacy — market-level fallback + league fold.
 *
 * Pure tests pin the two soundness-critical predicates:
 *   - foldLeagueKey       — the league-gate fold key (stage/season bridging
 *                           WITHOUT collapsing distinct leagues)
 *   - passesTitleSanity / sharesContentToken — the corrupted-embedding
 *                           defense for the market-level fallback
 * plus a DB-backed parity check that the SQL fold expression
 * (foldLeagueKeySqlExpr) and the TS mirror agree byte-for-byte (skips when PG
 * is unreachable, same pattern as taxonomy.test.ts).
 *
 * The corrupt/true example pairs below are live-measured: corrupt pairs are
 * real shifted-embedding hits surfaced by the fallback simulation; true pairs
 * are named recall misses plus market_cross_refs ground-truth edge cases.
 */
import { describe, test, expect } from 'bun:test';
import { query } from '@arb/db';
import {
  foldLeagueKey, foldLeagueKeySqlExpr, sharesContentToken, passesTitleSanity,
} from './ann-candidates.js';
import { anonMarketSql, isAnonymizedMarket } from '../stage1-normalize/text-deterministic.js';

describe('W2-R6a foldLeagueKey (league-gate fold with stage/season bridging)', () => {
  test('bridges the measured stage forks onto the base league', () => {
    expect(foldLeagueKey('NBA Playoffs')).toBe('nba');
    expect(foldLeagueKey('NBA')).toBe('nba');
    expect(foldLeagueKey('MLB Playoffs')).toBe('mlb');
    expect(foldLeagueKey('MLB')).toBe('mlb');
    expect(foldLeagueKey('NBA Finals')).toBe('nba');
  });

  test("SOUNDNESS (census 2026-07-02 §4b): 'PGA Championship' does NOT fold onto 'PGA Tour'", () => {
    // 'PGA Tour' → 'pga' is the intended tour-hierarchy bridge; but 'PGA
    // Championship' is a DISTINCT MAJOR, not the tour's stage. The
    // acronym-championship guard keeps '<2-4-char acronym> Championship'
    // whole while pure stage words (playoffs/finals) still strip.
    expect(foldLeagueKey('PGA Tour')).toBe('pga');
    expect(foldLeagueKey('PGA Championship')).toBe('pgachampionship');
    expect(foldLeagueKey('PGA Championship')).not.toBe(foldLeagueKey('PGA Tour'));
    expect(foldLeagueKey('LPGA Championship')).toBe('lpgachampionship');
    // season prefix + guard compose: the year strips, the name survives
    expect(foldLeagueKey('2026 PGA Championship')).toBe('pgachampionship');
  });

  test('SOUNDNESS: distinct divisions/leagues stay distinct', () => {
    expect(foldLeagueKey('La Liga')).toBe('laliga');
    expect(foldLeagueKey('La Liga 2')).toBe('laliga2');   // ordinal tier — never collapsed
    expect(foldLeagueKey('la liga 2')).not.toBe(foldLeagueKey('la liga'));
    expect(foldLeagueKey('Ligue 1')).toBe('ligue1');
    expect(foldLeagueKey('Ligue 2')).toBe('ligue2');
    expect(foldLeagueKey('Liga MX')).toBe('ligamx');
    expect(foldLeagueKey('Primeira Liga')).toBe('primeiraliga');
    expect(foldLeagueKey('WNBA')).toBe('wnba');           // never folds onto 'nba'
    expect(foldLeagueKey('LPGA Tour')).toBe('lpga');      // distinct from 'pga'
    expect(foldLeagueKey('ATP Tour')).toBe('atp');
    expect(foldLeagueKey('WTA Tour')).toBe('wta');
  });

  test('SOUNDNESS: bare/degenerate stage names survive whole (guards)', () => {
    // 'Championship' IS a league (EFL) — empty-remainder guard keeps it whole.
    expect(foldLeagueKey('Championship')).toBe('championship');
    // A remainder that is itself a bare stage token → keep the WHOLE name, so
    // 'Tour Championship' (the PGA event) can never collide with 'PGA Tour''s
    // fold, and 'Championship Tour' (WSL surfing) can never collide with the
    // EFL 'Championship'.
    expect(foldLeagueKey('Tour Championship')).toBe('tourchampionship');
    expect(foldLeagueKey('Championship Tour')).toBe('championshiptour');
  });

  test('DW-54 base behavior preserved: case/space folding', () => {
    expect(foldLeagueKey('LaLiga')).toBe('laliga');
    expect(foldLeagueKey('  Premier League ')).toBe('premierleague');
  });

  test('season prefixes strip (AUD-42 parity with stripSeasonPrefix)', () => {
    expect(foldLeagueKey('2025-26 La Liga')).toBe('laliga');
    expect(foldLeagueKey('2026 NBA Finals')).toBe('nba'); // season + stage compose
    expect(foldLeagueKey('2026')).toBe('2026');           // bare year unchanged
  });

  test('DB parity: SQL fold expression ≡ TS mirror (skips when PG is down)', async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    const samples = [
      'NBA Playoffs', 'NBA', 'MLB Playoffs', 'PGA Tour', 'PGA Championship',
      'La Liga', 'La Liga 2', 'Ligue 1', 'Championship', 'Tour Championship',
      'Championship Tour', 'NBA Finals', '2025-26 La Liga', 'LaLiga',
      'united rugby championship', 'ATP Tour', 'WNBA', 'Premier League',
      'LPGA Championship', '2026 PGA Championship', 'pga championship',
    ];
    const rows = await query<{ v: string; f: string }>(
      `SELECT v, ${foldLeagueKeySqlExpr('v')} AS f FROM unnest($1::text[]) AS t(v)`,
      [samples],
    );
    for (const r of rows) {
      expect(`${r.v} → ${r.f}`).toBe(`${r.v} → ${foldLeagueKey(r.v)}`);
    }
  });
});

describe('W2-R2 title sanity (W1-F corrupted-embedding defense)', () => {
  // Live-measured corrupted pairs (shifted vectors): tiny embedding distance,
  // unrelated titles. trgm values are the live similarity() results.
  const CORRUPT: Array<[string, string, number]> = [
    ['Who will win a PGA Tour Major in 2026?', 'Will Trump recognize Somaliland before 2027?', 0.130],
    ['Who will win a PGA Tour Major in 2026?', 'Will Elon Musk win his case against Sam Altman?', 0.130],
    ['Who will win a PGA Tour Major in 2026?', 'Will Sarah Knafo be on the ballot for the 2027 French presidential election?', 0.120],
    ['Will Benson Boone be a Headliner at Coachella 2027?', 'Will the Republican Party win the CA-26 House special election?', 0.095],
    ['Will Florence Pugh go on Call Her Daddy?', 'Will the Republican Party win the NY-26 House special election?', 0.091],
    ['Will Arizona win at least 65 games this season?', 'US recognizes Reza Pahlavi as leader of Iran before 2027?', 0.054],
  ];

  // The audit's named recall misses + ground-truth low-overlap true pairs.
  const TRUE_PAIRS: Array<[string, string, number]> = [
    ['Obama arrested before 2027?', 'Will Barack Obama be arrested before Jan 2027?', 0.628],
    ['Tim Cook out as Apple CEO before 2027?', 'Tim Cook leaves Apple in 2026?', 0.375],
    ['WHOOP IPO before 2027?', 'When will WHOOP, Inc. officially announce an IPO?', 0.189],
    ['Next Chelsea manager?: Andoni Iraola', 'Chelsea: Next Manager', 0.600],
    // Predict terse-label ↔ full-question (cross-ref ground truth, lowest trgm
    // of ANY true pair = 0.036): survives via the shared '5.5%' number token.
    ['↑ 5.5%', 'Will the Fed’s upper bound reach 5.5% or higher before 2027?', 0.036],
    ['>$4M', 'Over $4M committed to the Printr public sale?', 0.071],
    // diacritic drift — shared token after NFKD fold
    ['Real Sociedad B vs Mirandes', 'Real Sociedad de Fútbol B vs. CD Mirandés', 0.5],
  ];

  test('rejects every live-measured corrupted pair', () => {
    for (const [a, b, trgm] of CORRUPT) {
      expect({ a, b, pass: passesTitleSanity(a, b, trgm) }).toEqual({ a, b, pass: false });
    }
  });

  test('passes every true pair (audit misses + ground-truth edge cases)', () => {
    for (const [a, b, trgm] of TRUE_PAIRS) {
      expect({ a, b, pass: passesTitleSanity(a, b, trgm) }).toEqual({ a, b, pass: true });
    }
  });

  test('sharesContentToken ignores boilerplate/yearly tokens', () => {
    // Only question boilerplate + bare years in common → NOT a content match.
    expect(sharesContentToken('Will X occur in 2026?', 'Will Y resolve in 2026?')).toBe(false);
    expect(sharesContentToken('Who will win the race?', 'Who will win the cup?')).toBe(false);
    // A real shared subject token IS a content match.
    expect(sharesContentToken('Will Chelsea sack the manager?', 'Chelsea: Next Manager')).toBe(true);
    expect(sharesContentToken('Bitcoin above $100k?', 'Will Bitcoin close above $100k?')).toBe(true);
  });

  test('trgm escape hatch covers abbreviation-style pairs with no shared whole token', () => {
    // 'mayor' vs 'mayoral' / 'NYC' vs 'New York City': no shared whole token,
    // but high raw trigram similarity → pass via the escape hatch.
    expect(sharesContentToken('NYC mayor odds', 'New York City mayoral race')).toBe(false);
    expect(passesTitleSanity('NYC mayor odds', 'New York City mayoral race', 0.45)).toBe(true);
    // No shared token AND low trigram → reject (corruption shape).
    expect(passesTitleSanity('completely unrelated thing', 'different другое topic', 0.02)).toBe(false);
  });
});

describe('WS1 anonMarketSql ≡ isAnonymizedMarket (SQL/TS parity, skips when PG down)', () => {
  // The label expr mirrors anonMarketSql's caller-side derivation exactly:
  // PM→groupItemTitle, kalshi→yes_sub_title, else colon-suffix idiom.
  const LABEL_SQL = `
    CASE m.platform
      WHEN 'polymarket' THEN mr.raw->>'groupItemTitle'
      WHEN 'kalshi'     THEN mr.raw->>'yes_sub_title'
      ELSE NULLIF(split_part(m.title, ': ', -1), m.title)
    END`;

  test('byte-for-byte agreement over a live market sample', async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    // Sample across platforms; LEFT JOIN so NULL-raw rows are included (their
    // label is NULL → both sides must agree on "not anon"). Mix random rows with
    // a guaranteed-anon slice so the assertion exercises both verdicts even on a
    // small sample.
    const rows = await query<{ lbl: string | null; sql_anon: boolean }>(
      `WITH s AS (
         SELECT m.platform, m.title, mr.raw,
                (${LABEL_SQL}) AS lbl,
                ${anonMarketSql('m', 'mr')} AS sql_anon
         FROM markets m
         LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
         WHERE m.end_date > NOW()
       )
       (SELECT lbl, sql_anon FROM s WHERE sql_anon ORDER BY random() LIMIT 300)
       UNION ALL
       (SELECT lbl, sql_anon FROM s ORDER BY random() LIMIT 1200)`,
    );
    expect(rows.length).toBeGreaterThan(0);

    let mismatches = 0;
    for (const r of rows) {
      if (isAnonymizedMarket(r.lbl) !== r.sql_anon) {
        mismatches++;
        if (mismatches <= 10) {
          // eslint-disable-next-line no-console
          console.error('PARITY MISMATCH', JSON.stringify({ lbl: r.lbl, sql: r.sql_anon, ts: isAnonymizedMarket(r.lbl) }));
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  test('explicit fixture parity (anchors the contract independent of live data)', async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    // (platform, groupItemTitle, yes_sub_title, title) fixtures → derived label.
    const fixtures: Array<{ platform: string; git: string | null; yst: string | null; title: string }> = [
      { platform: 'polymarket', git: 'Candidate A', yst: null, title: 'who wins?' },
      { platform: 'polymarket', git: 'Other', yst: null, title: 'who wins?' },
      { platform: 'polymarket', git: 'Will Smith', yst: null, title: 'who wins?' }, // real name
      { platform: 'polymarket', git: 'Boston Celtics', yst: null, title: 'who wins?' },
      { platform: 'polymarket', git: null, yst: null, title: 'no group title' },     // NULL label
      { platform: 'kalshi', git: null, yst: 'Player AH', title: 'x' },
      { platform: 'kalshi', git: null, yst: 'CDU', title: 'x' },                     // real party code
      { platform: 'limitless', git: null, yst: null, title: 'Match Winner: A' },     // colon-suffix bare upper
      { platform: 'limitless', git: null, yst: null, title: 'Match Winner: Real Madrid' },
      { platform: 'predict', git: null, yst: null, title: 'no colon here' },         // NULL label
    ];

    const rows = await query<{ idx: number; sql_anon: boolean }>(
      `SELECT t.idx,
              ${anonMarketSql('m', 'mr')} AS sql_anon
         FROM unnest($1::int[], $2::text[], $3::jsonb[], $4::text[])
              AS t(idx, platform, raw, title)
         CROSS JOIN LATERAL (SELECT t.platform AS platform, t.title AS title) m
         CROSS JOIN LATERAL (SELECT t.raw AS raw) mr
         ORDER BY t.idx`,
      [
        fixtures.map((_, i) => i),
        fixtures.map((f) => f.platform),
        fixtures.map((f) => JSON.stringify({
          ...(f.git != null ? { groupItemTitle: f.git } : {}),
          ...(f.yst != null ? { yes_sub_title: f.yst } : {}),
        })),
        fixtures.map((f) => f.title),
      ],
    );

    for (const r of rows) {
      const f = fixtures[r.idx];
      const label =
        f.platform === 'polymarket' ? f.git
        : f.platform === 'kalshi' ? f.yst
        : (f.title.includes(': ') ? f.title.split(': ').pop()! : null);
      expect({ idx: r.idx, sql: r.sql_anon }).toEqual({ idx: r.idx, sql: isAnonymizedMarket(label) });
    }
  });

  test('fix ① kbBypass variant: KB-present real labels survive, redactions still anon', async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    // notAnonMarketSql carries a KB-presence bypass: a label fold-matching a
    // real known_entities canonical is not anon even when it pattern-matches.
    // Assert against the live KB so the test tracks DB state rather than
    // assuming it.
    const kbHasTeamWE =
      (await query(
        `SELECT 1 FROM known_entities
          WHERE lower(immutable_unaccent(canonical)) = 'team we' LIMIT 1`,
      )).length > 0;

    const fixtures: Array<{ git: string; expectAnon: boolean }> = [
      { git: 'Team WE', expectAnon: !kbHasTeamWE },   // real LPL org — bypassed iff registered
      { git: 'Player AH', expectAnon: true },         // genuine redaction — never in KB
      { git: 'Person AA', expectAnon: true },
      { git: 'Boston Celtics', expectAnon: false },   // never pattern-matched
    ];
    const rows = await query<{ idx: number; sql_anon: boolean }>(
      `SELECT t.idx,
              ${anonMarketSql('m', 'mr', { kbBypass: true })} AS sql_anon
         FROM unnest($1::int[], $2::text[]) AS t(idx, git)
         CROSS JOIN LATERAL (SELECT 'polymarket'::text AS platform, 'x'::text AS title) m
         CROSS JOIN LATERAL (SELECT jsonb_build_object('groupItemTitle', t.git) AS raw) mr
         ORDER BY t.idx`,
      [fixtures.map((_, i) => i), fixtures.map((f) => f.git)],
    );
    for (const r of rows) {
      expect({ idx: r.idx, anon: r.sql_anon }).toEqual({ idx: r.idx, anon: fixtures[r.idx].expectAnon });
    }
    // Pollution self-legitimization guard: a placeholder-shaped canonical must
    // NOT rescue its own label even if such a row exists in known_entities.
    // (SQL mirror of isPlaceholderCanonical — pattern check only, data-free.)
    const guard = await query<{ sql_anon: boolean }>(
      `SELECT ${anonMarketSql('m', 'mr', { kbBypass: true })} AS sql_anon
         FROM (SELECT 'polymarket'::text AS platform, 'x'::text AS title) m
         CROSS JOIN LATERAL (SELECT jsonb_build_object('groupItemTitle', 'Team A') AS raw) mr`,
    );
    expect(guard[0].sql_anon).toBe(true); // even a KB 'Team A' pollution row can't bypass
  });
});

// ── DW-20: NULL-date participant-set gate helpers (TS mirrors of the SQL) ─────
import { foldParticipantKey, participantSetsProvablyDiffer } from './ann-candidates.js';

describe('DW-20 foldParticipantKey', () => {
  test('case/spacing/punctuation fold', () => {
    expect(foldParticipantKey('Bay FC')).toBe('bayfc');
    expect(foldParticipantKey('crystal-palace f.c.')).toBe('crystalpalacefc');
  });
});

describe('DW-20 participantSetsProvablyDiffer', () => {
  test('NULL/empty on either side → never differ (NULL-tolerant)', () => {
    expect(participantSetsProvablyDiffer(null, ['Arsenal'])).toBe(false);
    expect(participantSetsProvablyDiffer(['Arsenal'], [])).toBe(false);
    expect(participantSetsProvablyDiffer(undefined, undefined)).toBe(false);
  });
  test('equal sets up to fold/order/dupes → not different', () => {
    expect(participantSetsProvablyDiffer(['Arsenal FC', 'Chelsea FC'], ['chelsea fc', 'ARSENAL fc', 'Arsenal FC'])).toBe(false);
  });
  test('single-team bridge vs 2-team fixture → provably different (the gate blocks)', () => {
    expect(participantSetsProvablyDiffer(['Arsenal'], ['Arsenal', 'Chelsea'])).toBe(true);
  });
  test('disjoint sets → provably different', () => {
    expect(participantSetsProvablyDiffer(['Arsenal', 'Chelsea'], ['Bay FC', 'Boston Legacy FC'])).toBe(true);
  });
});

// ── W-XPLAT-C1: single-occurrence-categorical placeholder-date bypass ─────────
import { categoricalRosterDateBypass } from './ann-candidates.js';

describe('W-XPLAT-C1 categoricalRosterDateBypass', () => {
  const roster = ['James Peck', 'Hannah Flora', 'Dwight Hudgins', 'Cate Meade'];
  test('same-roster non-fixture categoricals → bypass (Top Chef / Chopped class)', () => {
    // ≥2 shared folded members, both categorical_exclusive, NULL/other kind
    expect(categoricalRosterDateBypass(
      'categorical_exclusive', 'categorical_exclusive', null, 'other',
      roster, ['hannah  flora', 'DWIGHT HUDGINS', 'Someone Else'],
    )).toBe(true);
  });
  test('fixture kind on EITHER side → no bypass (date is the discriminator)', () => {
    expect(categoricalRosterDateBypass(
      'categorical_exclusive', 'categorical_exclusive', 'match_winner', null,
      ['Zenit', 'Unics'], ['Zenit', 'Unics'],
    )).toBe(false);
    expect(categoricalRosterDateBypass(
      'categorical_exclusive', 'categorical_exclusive', null, 'exact_score',
      ['Zenit', 'Unics'], ['Zenit', 'Unics'],
    )).toBe(false);
  });
  test('grouping not categorical on either side → no bypass', () => {
    expect(categoricalRosterDateBypass('threshold_series', 'categorical_exclusive', null, null, roster, roster)).toBe(false);
    expect(categoricalRosterDateBypass('unknown', 'categorical_exclusive', null, null, roster, roster)).toBe(false);
  });
  test('<2 shared roster members → no bypass (cost valve + cross-season guard)', () => {
    expect(categoricalRosterDateBypass('categorical_exclusive', 'categorical_exclusive', null, null,
      ['A', 'B', 'C'], ['A', 'X', 'Y'])).toBe(false); // only 1 shared
    expect(categoricalRosterDateBypass('categorical_exclusive', 'categorical_exclusive', null, null,
      roster, null)).toBe(false); // roster unknown on one side
  });
  test('diacritic fold is self-consistent (same accent-strip both sides)', () => {
    // The shared fold (foldParticipantKey / foldedParticipantSetSqlExpr) drops
    // non-ASCII letters entirely: "Curaçao"→"curaao". Applied identically to
    // BOTH sides ⇒ same-spelling accented rosters still overlap. Cross-platform
    // accented-vs-deaccented drift ("Curaçao" vs "Curacao") folds to
    // curaao≠curacao → no overlap, so the pair is conservatively not bypassed
    // (a recall miss, never a false merge).
    expect(categoricalRosterDateBypass('categorical_exclusive', 'categorical_exclusive', null, 'other',
      ['Curaçao', 'Alavés', 'X'], ['Curaçao', 'Alavés', 'Y'])).toBe(true);
    expect(categoricalRosterDateBypass('categorical_exclusive', 'categorical_exclusive', null, 'other',
      ['Curaçao', 'Alavés'], ['Curacao', 'Alaves'])).toBe(false); // accent drift → conservative miss
  });
});
