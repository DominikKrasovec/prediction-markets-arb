/**
 * Pure tests for the confederation/party seeds + the per-key-pin
 * authoritative upsert (no DB).
 *
 * The seed's continent vocabulary is pinned against BOTH live consumers'
 * vocabularies:
 *   · tournament-edges WC_2026_FORMAT_SPEC (aggregate role
 *     'confederation_champion'; aggregate-node subjects are the 6 continent
 *     canonicals);
 *   · outcome-set-certifier CONFEDERATION_SUBJECTS (its own static token
 *     list — unaffected by the seed, but the vocabularies must agree).
 */
import { describe, test, expect } from 'bun:test';
import {
  CONTINENT_BY_CONFEDERATION,
  NATIONAL_TEAM_CONFEDERATIONS,
  CONFEDERATION_ORGS,
  POLITICS_OVERRIDES,
  AUTHORITATIVE_UPSERT_SQL,
  SAME_CITY_TEAM_CODES,
  LEAGUES,
  COMPETITIONS,
  longCodeOf,
  cityKeyOf,
  NAMESAKE_CLUB_GROUPS,
  namesakeSiblingTitleRx,
} from './seed-entity-kb.js';
import { WC_2026_FORMAT_SPEC } from '../stage4-events/tournament-edges.js';
import { CONFEDERATION_SUBJECTS } from '../stage4-events/outcome-set-certifier.js';

describe('confederation seed ↔ consumer parity (the drift-killer)', () => {
  test('exactly the 6 FIFA confederations, continents = the live aggregate-node subjects', () => {
    expect(Object.keys(CONTINENT_BY_CONFEDERATION).sort()).toEqual(
      ['AFC', 'CAF', 'CONCACAF', 'CONMEBOL', 'OFC', 'UEFA'],
    );
    expect(Object.values(CONTINENT_BY_CONFEDERATION).sort()).toEqual(
      ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'],
    );
  });

  test('WC spec superset arm targets the confederation_champion aggregate role', () => {
    expect(WC_2026_FORMAT_SPEC.supersets).toEqual(
      [{ from: 'champion', aggregateRole: 'confederation_champion' }],
    );
  });

  test('every continent + code is in the certifier vocabulary (folded)', () => {
    for (const [code, continent] of Object.entries(CONTINENT_BY_CONFEDERATION)) {
      expect(CONFEDERATION_SUBJECTS.has(code.toLowerCase())).toBe(true);
      expect(CONFEDERATION_SUBJECTS.has(continent.toLowerCase())).toBe(true);
    }
  });

  test('team table: valid codes, no duplicate teams', () => {
    const seen = new Set<string>();
    for (const { team, confederation } of NATIONAL_TEAM_CONFEDERATIONS) {
      expect(CONTINENT_BY_CONFEDERATION[confederation]).toBeDefined();
      const key = team.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(NATIONAL_TEAM_CONFEDERATIONS.length).toBeGreaterThanOrEqual(50);
  });

  test('org seeds: organization-typed, kind=confederation, continent stamped, no intra-seed alias collisions', () => {
    expect(CONFEDERATION_ORGS).toHaveLength(6);
    const buckets = new Set<string>();
    for (const org of CONFEDERATION_ORGS) {
      expect(org.type).toBe('organization');
      expect(org.metadata.kind).toBe('confederation');
      expect(org.metadata.continent).toBe(CONTINENT_BY_CONFEDERATION[org.canonical]);
      for (const a of [org.canonical, ...org.aliases]) {
        const fold = a.toLowerCase();
        expect(buckets.has(fold)).toBe(false);
        buckets.add(fold);
      }
    }
  });
});

describe('A1 per-key-pin authoritative upsert', () => {
  test('metadata merge keeps existing map on the LEFT (seed wins ONLY on named keys)', () => {
    expect(AUTHORITATIVE_UPSERT_SQL).toContain(
      `metadata        = COALESCE(known_entities.metadata, '{}'::jsonb) || EXCLUDED.metadata`,
    );
    // the old full-replacement form must never come back
    expect(AUTHORITATIVE_UPSERT_SQL).not.toContain('metadata        = EXCLUDED.metadata');
  });

  test('type/domain/enrichment_status stay authoritative (named by every override)', () => {
    expect(AUTHORITATIVE_UPSERT_SQL).toContain('type            = EXCLUDED.type');
    expect(AUTHORITATIVE_UPSERT_SQL).toContain('domain_category = EXCLUDED.domain_category');
    expect(AUTHORITATIVE_UPSERT_SQL).toContain(`enrichment_status = 'enriched'`);
  });

  test('aliases still UNION (strictly additive)', () => {
    expect(AUTHORITATIVE_UPSERT_SQL).toContain('jsonb_array_elements_text(known_entities.aliases)');
    expect(AUTHORITATIVE_UPSERT_SQL).toContain('UNION');
  });
});

describe('party metadata (curated two-party US set only; R3 stays refused)', () => {
  test('Trump carries party + party_as_of; the named keys still pin role/kind', () => {
    const trump = POLITICS_OVERRIDES.find((s) => s.canonical === 'Donald Trump')!;
    expect(trump.metadata.party).toBe('Republican Party');
    expect(trump.metadata.party_as_of).toBe('2026-06');
    expect(trump.metadata.role).toBe('politician');
  });

  test('the party org rows carry political_party kind (no candidate⟹party consumer exists)', () => {
    for (const c of ['Democratic Party', 'Republican Party']) {
      const row = POLITICS_OVERRIDES.find((s) => s.canonical === c)!;
      expect(row.type).toBe('organization');
      expect(row.metadata.kind).toBe('political_party');
    }
  });

  test('both parties carry their bare singular surface form (§C-2 alias-typing lookup)', () => {
    // The §C-2 aggregate-vs-member guard types outcome subjects via alias; the
    // bare singular ('Democrat'/'Republican') is a leg label the LLM emits.
    // Both must be present so getSubjectTypes can type them.
    const dem = POLITICS_OVERRIDES.find((s) => s.canonical === 'Democratic Party')!;
    const rep = POLITICS_OVERRIDES.find((s) => s.canonical === 'Republican Party')!;
    expect(dem.aliases.map((a) => a.toLowerCase())).toContain('democrat');
    expect(rep.aliases.map((a) => a.toLowerCase())).toContain('republican');
  });

  test("GW-R1: the three independent candidates carry party='Independent' (§C-2b evidence)", () => {
    // Osborn/Block/Duggan — the §C-2b independent-aggregate containment guard
    // fires ONLY on this stamp; without these rows it abstains and the class is
    // covered solely by the solver Σ-price belt.
    for (const c of ['Dan Osborn', 'Ken Block', 'Mike Duggan']) {
      const row = POLITICS_OVERRIDES.find((s) => s.canonical === c)!;
      expect(row).toBeDefined();
      expect(row.type).toBe('person');
      expect(row.metadata.party).toBe('Independent');
      expect(row.metadata.role).toBe('politician');
      // Bare 'Independent' must never be an alias (ambiguous label by seed policy).
      expect(row.aliases.map((a) => a.toLowerCase())).not.toContain('independent');
    }
  });
});

describe('SAME_CITY_TEAM_CODES (RC2 layer-a seed) — letter→team mapping + uniqueness', () => {
  test('the letter→team mapping is the team initial / known abbreviation, verified vs market rules', () => {
    // The trailing single letter of each "<City> <letter>" code must equal the
    // first letter of the team-distinguishing token (Kalshi pid-suffix verified:
    // F=Football Club/LAFC, G=Galaxy, A=Angels, D=Dodgers, M=Mets, Y=Yankees).
    const byCanonical: Record<string, string> = {
      'Los Angeles FC': 'F',       // F = Football Club (LAFC)
      'Los Angeles Galaxy': 'G',   // G = Galaxy
      'Los Angeles Angels': 'A',   // A = Angels
      'Los Angeles Dodgers': 'D',  // D = Dodgers
      'New York Mets': 'M',        // M = Mets
      'New York Yankees': 'Y',     // Y = Yankees
    };
    for (const entry of SAME_CITY_TEAM_CODES) {
      const expectedLetter = byCanonical[entry.canonical];
      expect(expectedLetter).toBeDefined();
      for (const code of entry.codes) {
        const letter = code.trim().slice(-1).toUpperCase();
        expect(letter).toBe(expectedLetter);
      }
    }
  });

  test('the confirmed CFA-1/CFA-2 collision pairs are all seeded', () => {
    const canonicals = new Set(SAME_CITY_TEAM_CODES.map((e) => e.canonical));
    for (const c of [
      'Los Angeles FC', 'Los Angeles Galaxy',     // CFA-1 (MLS, the swap)
      'Los Angeles Angels', 'Los Angeles Dodgers', // CFA-2 (MLB)
      'New York Mets', 'New York Yankees',          // CFA-2 (MLB)
    ]) {
      expect(canonicals.has(c)).toBe(true);
    }
  });

  test('every code is unique across the whole seed (no code on two teams)', () => {
    // The poison-removal invariant at the data level: a code can belong to only
    // ONE team, else the seed itself would create the ambiguity it exists to kill.
    const seen = new Map<string, string>();
    for (const entry of SAME_CITY_TEAM_CODES) {
      for (const code of entry.codes) {
        const fold = code.toLowerCase();
        expect(seen.has(fold)).toBe(false);
        seen.set(fold, entry.canonical);
      }
    }
  });

  test('each entry carries a long + short variant, both ending in the same letter', () => {
    for (const entry of SAME_CITY_TEAM_CODES) {
      expect(entry.codes.length).toBeGreaterThanOrEqual(2);
      const letters = new Set(entry.codes.map((c) => c.trim().slice(-1).toUpperCase()));
      expect(letters.size).toBe(1); // all codes for one team share the letter
      expect(entry.sport).toMatch(/^(soccer|baseball)$/);
      expect(entry.league).toMatch(/^(MLS|MLB)$/);
    }
  });
});

describe('tour_gender seeds (WP-R7) — factual single-gender leagues/competitions', () => {
  const all = [...LEAGUES, ...COMPETITIONS];
  const tgOf = (canonical: string) =>
    all.find((s) => s.canonical === canonical)?.metadata.tour_gender as string | undefined;

  test("women's tours carry tour_gender='women'", () => {
    for (const c of ['WNBA', 'WTA Tour', 'LPGA Tour']) expect(tgOf(c)).toBe('women');
  });

  test("men's tours/leagues carry tour_gender='men'", () => {
    for (const c of ['NBA', 'NFL', 'MLB', 'NHL', 'ATP Tour', 'PGA Tour', 'European Tour', 'LIV Golf', 'Korn Ferry Tour']) {
      expect(tgOf(c)).toBe('men');
    }
  });

  test('the men↔women counterpart pairs actually DIFFER (the discriminative axis)', () => {
    expect(tgOf('NBA')).not.toBe(tgOf('WNBA'));
    expect(tgOf('ATP Tour')).not.toBe(tgOf('WTA Tour'));
    expect(tgOf('PGA Tour')).not.toBe(tgOf('LPGA Tour'));
  });

  test('genuinely mixed/open bodies stay NULL (honest refusal, never guessed)', () => {
    // UFC runs both men's AND women's divisions; open motorsport carries both.
    for (const c of ['UFC', 'Bellator', 'PFL', 'NASCAR Cup Series', 'Formula 1 Championship']) {
      expect(tgOf(c)).toBeUndefined();
    }
  });

  test('team-sport club leagues stay NULL (shared club names ⇒ per-person gender unsound)', () => {
    for (const c of ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'MLS']) {
      expect(tgOf(c)).toBeUndefined();
    }
  });

  test('shared-name competitions stay NULL (both-gender editions under one name)', () => {
    // March Madness = men's AND women's NCAA tournament; a stamp would falsely gender it.
    expect(tgOf('March Madness')).toBeUndefined();
    // Tennis Grand Slams run both draws under one competition name.
    for (const c of ['Wimbledon', 'US Open Tennis', 'French Open', 'Australian Open']) {
      expect(tgOf(c)).toBeUndefined();
    }
  });

  test('every stamped tour_gender is a valid enum value (men|women|mixed|open)', () => {
    for (const s of all) {
      const tg = s.metadata.tour_gender as string | undefined;
      if (tg !== undefined) expect(['men', 'women', 'mixed', 'open']).toContain(tg);
    }
  });

  test('new golf-tour seeds bind the dynamic rows: lowercase aliases + golf part_of', () => {
    // Seeded EARLY so the case-folded KB index absorbs the LLM's lowercase
    // emission ('korn ferry tour' / 'lpga tour') into ONE canonical row.
    const kft = LEAGUES.find((s) => s.canonical === 'Korn Ferry Tour')!;
    const lpga = LEAGUES.find((s) => s.canonical === 'LPGA Tour')!;
    expect(kft.aliases).toContain('korn ferry tour');
    expect(lpga.aliases).toContain('lpga tour');
    expect(kft.metadata.sport_canonical).toBe('golf');
    expect(lpga.metadata.sport_canonical).toBe('golf');
  });
});

// Same-city stale-resolution repoint helpers.
// The repoint pass groups SAME_CITY_TEAM_CODES entries into collision cohorts
// by cityKeyOf; siblings in one cohort are the pair whose stale
// cross-resolutions get repaired. These pure helpers pin the grouping the
// SQL relies on.
describe('FIX 4a — same-city repoint grouping (longCodeOf / cityKeyOf)', () => {
  test('longCodeOf picks the multi-word "<City> <letter>" form, not the short code', () => {
    for (const e of SAME_CITY_TEAM_CODES) {
      const long = longCodeOf(e);
      expect(e.codes).toContain(long);
      // the long form has ≥2 whitespace-separated tokens before the trailing letter
      expect(long.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3 - (long.startsWith('LA') || long.startsWith('NY') ? 1 : 0));
    }
  });

  test('same-city siblings share a cityKey; different cities/sports do not', () => {
    const byKey = new Map<string, string[]>();
    for (const e of SAME_CITY_TEAM_CODES) {
      const k = cityKeyOf(e);
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e.canonical);
    }
    // MLB LA Angels+Dodgers collide; MLS LA FC+Galaxy collide (different sport key);
    // MLB NY Mets+Yankees collide.
    expect(byKey.get('baseball|los angeles')?.sort()).toEqual(['Los Angeles Angels', 'Los Angeles Dodgers']);
    expect(byKey.get('soccer|los angeles')?.sort()).toEqual(['Los Angeles FC', 'Los Angeles Galaxy']);
    expect(byKey.get('baseball|new york')?.sort()).toEqual(['New York Mets', 'New York Yankees']);
    // LA-MLB and LA-MLS must NOT share a cohort (sport axis separates them).
    expect(cityKeyOf(SAME_CITY_TEAM_CODES.find((e) => e.canonical === 'Los Angeles Angels')!))
      .not.toBe(cityKeyOf(SAME_CITY_TEAM_CODES.find((e) => e.canonical === 'Los Angeles FC')!));
  });

  test('every cohort has exactly its two same-city siblings (no singletons repoint)', () => {
    const counts = new Map<string, number>();
    for (const e of SAME_CITY_TEAM_CODES) counts.set(cityKeyOf(e), (counts.get(cityKeyOf(e)) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(2);
  });
});

// Namesake-club disambiguation (Botafogo FR vs Botafogo FC-SP).
// The sibling-namesake analogue of the same-city codes: distinct clubs sharing a
// bare stem told apart only by a suffix tokenization drops. These pure
// checks pin the seed-data invariants the repoint SQL relies on. Postgres \m/\M
// word anchors are translated to JS \b for the matching assertions.
describe('OM-6 — NAMESAKE_CLUB_GROUPS seed-data invariants', () => {
  const toJs = (rx: string) => new RegExp(rx.replace(/\\m/g, '\\b').replace(/\\M/g, '\\b'), 'i');

  test('every group has ≥2 distinct clubs with distinct scope-matched canonicals', () => {
    expect(NAMESAKE_CLUB_GROUPS.length).toBeGreaterThanOrEqual(1);
    for (const g of NAMESAKE_CLUB_GROUPS) {
      expect(g.clubs.length).toBeGreaterThanOrEqual(2);
      const canon = new Set(g.clubs.map((c) => c.canonical.toLowerCase()));
      expect(canon.size).toBe(g.clubs.length);
      for (const c of g.clubs) {
        expect(c.titleRx.length).toBeGreaterThanOrEqual(1);
        expect(c.sport).toBeTruthy();
        expect(c.league).toBeTruthy();
      }
    }
  });

  test('every titleRx compiles and is word-anchored (no bare-substring over-match)', () => {
    for (const g of NAMESAKE_CLUB_GROUPS) {
      for (const c of g.clubs) {
        for (const rx of c.titleRx) {
          expect(() => toJs(rx)).not.toThrow();
          // the stem "botafogo" alone (no suffix) must NOT satisfy an FC/FR/SP rx —
          // otherwise the two clubs would collide again.
          if (/f[cr]|sp/i.test(rx)) expect(toJs(rx).test('botafogo')).toBe(false);
        }
      }
    }
  });

  test('namesakeSiblingTitleRx excludes the club’s own rx, returns the others', () => {
    const g = NAMESAKE_CLUB_GROUPS.find((x) => x.stem === 'Botafogo')!;
    const fr = g.clubs.find((c) => c.canonical === 'Botafogo FR')!;
    const sib = namesakeSiblingTitleRx(g, 'Botafogo FR');
    for (const rx of fr.titleRx) expect(sib).not.toContain(rx);
    const sp = g.clubs.find((c) => c.canonical === 'Botafogo-SP')!;
    for (const rx of sp.titleRx) expect(sib).toContain(rx);
  });

  test('Botafogo: FC/SP titles name the Série-B club, FR titles name the Rio club (disjoint)', () => {
    const g = NAMESAKE_CLUB_GROUPS.find((x) => x.stem === 'Botafogo')!;
    const sp = g.clubs.find((c) => c.canonical === 'Botafogo-SP')!;
    const fr = g.clubs.find((c) => c.canonical === 'Botafogo FR')!;
    const spMatch = (t: string) => sp.titleRx.some((rx) => toJs(rx).test(t));
    const frMatch = (t: string) => fr.titleRx.some((rx) => toJs(rx).test(t));
    // titles naming the Série-B club → SP, never FR
    for (const t of [
      'Goiás EC vs. Botafogo FC: O/U 2.5',
      'Grêmio Novorizontino vs. Botafogo FC: Both Teams to Score',
      'Will Botafogo-SP win Brazil Série B?',
      'Exact Score: AA Ponte Preta 0 - 1 Botafogo FC?',
    ]) {
      expect(spMatch(t)).toBe(true);
      expect(frMatch(t)).toBe(false);
    }
    // a genuine Rio (FR) title → FR, never SP (the recall-guard direction)
    expect(frMatch('Botafogo FR vs Flamengo')).toBe(true);
    expect(spMatch('Botafogo FR vs Flamengo')).toBe(false);
  });

  test('pinned distinctive alias forms are unique across the whole seed (poison-removal invariant)', () => {
    const seen = new Map<string, string>();
    for (const g of NAMESAKE_CLUB_GROUPS) {
      for (const c of g.clubs) {
        for (const form of c.aliasForms) {
          const fold = form.toLowerCase();
          expect(seen.has(fold)).toBe(false); // a form belongs to exactly one club
          seen.set(fold, c.canonical);
        }
      }
    }
  });
});
