/**
 * Stage-1d enrichment prep path — tennis tour convention.
 *
 * Contract under test: the deterministic keyword table must NEVER stamp the
 * fused 'ATP/WTA' league. The KB convention (tennis tour-lift,
 * stage1-normalize/tennis-tour.ts) splits the tours into 'ATP Tour' /
 * 'WTA Tour' — ATP×WTA championship pairs are NOT mutex, so a fused label
 * poisons the Stage-4 tour-disjoint mutex belt and false-blocks merge-probe
 * dedups. When the tour is unknown or ambiguous the table stamps
 * sport='tennis' ONLY (never guess).
 *
 * Pure-function tests — no DB. The three convention loci (this table, the
 * entity_enrichment prompt, the JSON-schema example) flip in one commit; a
 * source-level guard below pins the prompt/schema copies too.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectLeagueAndSport, inferPatch, tennisTourFromLabels, inheritedTourGender, INHERITABLE_TOUR_GENDERS } from './enrich-entity-metadata.js';
import type { UnifiedCategory } from '@arb/types';

const sports = new Set<UnifiedCategory>(['sports']);

describe('tennisTourFromLabels — tour derivation over label bags', () => {
  test("explicit ATP signal → 'ATP Tour'", () => {
    expect(tennisTourFromLabels('Tennis | ATP | French Open')).toBe('ATP Tour');
  });
  test("explicit WTA signal → 'WTA Tour'", () => {
    expect(tennisTourFromLabels('Tennis | WTA | Wimbledon')).toBe('WTA Tour');
  });
  test('BOTH tour tokens (e.g. fused "ATP/WTA Rome" platform tag) → undefined, never a guess', () => {
    expect(tennisTourFromLabels('ATP/WTA Rome | Tennis')).toBeUndefined();
  });
  test('no tour token (grand slam / bare tennis) → undefined', () => {
    expect(tennisTourFromLabels('Tennis | Grand Slam | Wimbledon')).toBeUndefined();
  });
  test('mixed events (mixed doubles / United Cup) → undefined even with a tour token', () => {
    expect(tennisTourFromLabels('ATP | United Cup | Tennis')).toBeUndefined();
    expect(tennisTourFromLabels('WTA | Mixed Doubles | Tennis')).toBeUndefined();
  });
});

describe('Stage-1d prep path — tennis league stamps (team/person branches)', () => {
  test("men's-tour player (ATP-tagged, type=team row): league 'ATP Tour', sport tennis", () => {
    // Fused stamps sit on type='team' rows (players mistyped as teams) — the
    // team branch is the one that stamps league_canonical.
    const patch = inferPatch('team', ['Tennis', 'ATP', 'French Open'], sports);
    expect(patch.league_canonical).toBe('ATP Tour');
    expect(patch.sport_canonical).toBe('tennis');
  });

  test("women's-tour player (WTA-tagged): league 'WTA Tour', sport tennis", () => {
    const patch = inferPatch('team', ['Tennis', 'WTA', 'Wimbledon'], sports);
    expect(patch.league_canonical).toBe('WTA Tour');
    expect(patch.sport_canonical).toBe('tennis');
  });

  test('unknown tour (grand-slam / bare tennis tags): NO league stamp, sport only', () => {
    const patch = inferPatch('team', ['Tennis', 'Grand Slam', 'US Open'], sports);
    expect(patch.league_canonical).toBeUndefined();
    expect(patch.sport_canonical).toBe('tennis');
  });

  test('ambiguous bag spanning both tours: NO league stamp, sport only', () => {
    const patch = inferPatch('team', ['ATP/WTA Rome', 'Tennis'], sports);
    expect(patch.league_canonical).toBeUndefined();
    expect(patch.sport_canonical).toBe('tennis');
  });

  test("the fused label 'ATP/WTA' is never emitted by any tennis-signal bag", () => {
    const bags = [
      ['Tennis'], ['ATP'], ['WTA'], ['Grand Slam'], ['ATP/WTA Madrid'],
      ['Tennis', 'ATP', 'WTA'], ['Roland Garros', 'Tennis'],
    ];
    for (const bag of bags) {
      expect(detectLeagueAndSport(bag).league).not.toBe('ATP/WTA');
    }
  });

  test('person branch stays league-free; sport stamps only with an athletic role', () => {
    // athlete role corroborates → sport stamped, still no league on person rows.
    const patch = inferPatch('person', ['Tennis', 'ATP'], sports, 'athlete');
    expect(patch.role).toBe('athlete');
    expect(patch.sport_canonical).toBe('tennis');
    expect(patch.league_canonical).toBeUndefined();
  });

  test('C3 gate: non-athletic role → provisional role hint but NO sport stamp (context-bleed)', () => {
    // "Will Tim Cook buy the Seattle Seahawks?" tags the buyer's market sports;
    // the NFL/Seahawks labels must NOT bleed a sport onto an executive.
    const exec = inferPatch('person', ['NFL', 'Seahawks'], sports, 'executive');
    expect(exec.sport_canonical).toBeUndefined();
    // musician bled soccer from the WC-Final halftime-show market
    const musician = inferPatch('person', ['Soccer', 'FIFA World Cup'], sports, 'other');
    expect(musician.sport_canonical).toBeUndefined();
    // coach IS an athletic role → sport stamped
    const coach = inferPatch('person', ['NFL'], sports, 'coach');
    expect(coach.sport_canonical).toBe('american football');
  });

  test('C3 gate: null role (pre-Stage-1e) withholds sport — stamped on the next pass', () => {
    // Stage-1d runs before Stage-1e sets role; the additive merge never retracts,
    // so we withhold until an athletic role is confirmed rather than stamp-then-keep.
    const first = inferPatch('person', ['Tennis', 'ATP'], sports); // role default null
    expect(first.role).toBe('athlete'); // provisional hint still emitted
    expect(first.sport_canonical).toBeUndefined(); // sport withheld this pass
  });

  test('non-tennis rows are untouched by the tour hook (NBA still stamps NBA)', () => {
    const patch = inferPatch('team', ['NBA', 'Basketball'], sports);
    expect(patch.league_canonical).toBe('NBA');
    expect(patch.sport_canonical).toBe('basketball');
  });
});

describe('B-32 — sport-as-league families stamp sport ONLY (never a league)', () => {
  // The Stage-1d keyword table stamps a sport name, never a league, for the
  // game/sport families (CS2/Valorant/Dota 2/Esports/Cricket/Boxing/Rugby) —
  // this keeps same-org esports entities from forking under sport-as-league
  // rows, exactly like the deriveLeague-undefined tennis path. Real leagues
  // (IPL/LEC/…) are recovered by the KB register/enrichment path, never
  // guessed here.
  const cases: Array<[string[], string]> = [
    [['counter strike 2'], 'cs2'],
    [['cs2'], 'cs2'],
    [['csgo'], 'cs2'],
    [['cs:go'], 'cs2'],
    [['Valorant'], 'valorant'],
    [['Dota 2'], 'dota 2'],
    [['dota2'], 'dota 2'],
    [['League of Legends'], 'league of legends'],
    [['LoL'], 'league of legends'],
    [['Cricket'], 'cricket'],
    [['IPL'], 'cricket'],
    [['Boxing'], 'boxing'],
    [['Rugby'], 'rugby union'],
    [['Esports'], 'esports'],
    [['competitive gaming'], 'esports'],
    // F1 has no type='league' KB row — the register-path guard already drops
    // F1-as-league, so Stage-1d degrades it to sport-only for consistency.
    [['F1'], 'formula 1'],
    [['Formula 1'], 'formula 1'],
  ];
  for (const [labels, sport] of cases) {
    test(`${labels[0]} → sport='${sport}', NO league`, () => {
      const patch = inferPatch('team', labels, sports);
      expect(patch.sport_canonical).toBe(sport);
      expect(patch.league_canonical).toBeUndefined();
      // ...and the competition branch (also a league stamper) stays league-free.
      const comp = inferPatch('competition', labels, sports);
      expect(comp.league_canonical).toBeUndefined();
    });
  }

  test('bare "cs" token no longer misfires the CS2 sport stamp', () => {
    // Bare "cs" alone does not match — the regex requires 2/go or
    // counter-strike so a stray "cs" (e.g. a ticker fragment) does not stamp cs2.
    const patch = inferPatch('team', ['ncs relay', 'physics'], sports);
    expect(patch.sport_canonical).toBeUndefined();
  });

  test('real orgs WITH a KB league row are NOT demoted — UFC/PGA/NASCAR keep their league', () => {
    expect(inferPatch('team', ['UFC'], sports).league_canonical).toBe('UFC');
    expect(inferPatch('team', ['PGA', 'Golf'], sports).league_canonical).toBe('PGA');
    expect(inferPatch('team', ['NASCAR'], sports).league_canonical).toBe('NASCAR');
  });

  test('source table no longer contains a sport-as-league entry for the bad classes', () => {
    const src = readFileSync(
      join(import.meta.dir, 'enrich-entity-metadata.ts'), 'utf8',
    );
    // No `league: '<SportName>'` for any of the demoted families.
    for (const bad of ['CS2', 'Valorant', 'Dota 2', 'League of Legends', 'Esports', 'Cricket', 'Boxing', 'Rugby', 'F1']) {
      expect(src).not.toMatch(new RegExp(String.raw`league:\s*['"]${bad}['"]`));
    }
  });
});

describe("convention parity: no live surface teaches the fused 'ATP/WTA' league", () => {
  // Source-level guard over the other two loci so a future prompt/schema edit
  // can't silently re-teach the fused convention.
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
  const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

  const teaches = (s: string) =>
    /league_canonical['"]?\s*[:=]\s*['"]ATP\/WTA['"]/.test(s);

  test('entity_enrichment prompt does not instruct the fused league', () => {
    expect(teaches(read('packages/llm/prompts/entity_enrichment/system.md'))).toBe(false);
  });
  test('generated schema.json + schema sources do not instruct the fused league', () => {
    expect(teaches(read('packages/llm/prompts/entity_enrichment/schema.json'))).toBe(false);
    expect(teaches(read('packages/llm/scripts/build-schemas.ts'))).toBe(false);
    expect(teaches(read('packages/llm/src/schemas.ts'))).toBe(false);
  });
  test('the Stage-1d keyword table does not stamp the fused league', () => {
    expect(teaches(read('services/pipeline/src/db/enrich-entity-metadata.ts'))).toBe(false);
    expect(read('services/pipeline/src/db/enrich-entity-metadata.ts')).not.toMatch(
      /league:\s*['"]ATP\/WTA['"]/,
    );
  });
});

describe('inheritedTourGender — WP-R7 athlete tour_gender inheritance gate', () => {
  test("athlete in a men's league inherits 'men'", () => {
    expect(inheritedTourGender('athlete', 'men')).toBe('men');
  });
  test("athlete in a women's league inherits 'women'", () => {
    expect(inheritedTourGender('athlete', 'women')).toBe('women');
  });
  test('COACH does NOT inherit — a WNBA coach can be a man, an NBA coach a woman', () => {
    expect(inheritedTourGender('coach', 'women')).toBeNull();
    expect(inheritedTourGender('coach', 'men')).toBeNull();
  });
  test("non-athlete roles never inherit (politician/celebrity/null/other)", () => {
    for (const role of ['politician', 'celebrity', 'other', null, undefined]) {
      expect(inheritedTourGender(role, 'men')).toBeNull();
    }
  });
  test("open/mixed/absent league tour_gender never propagates a person gender", () => {
    for (const lg of ['open', 'mixed', null, undefined, '']) {
      expect(inheritedTourGender('athlete', lg)).toBeNull();
    }
  });
  test('the inheritable set is exactly men|women (open/mixed are league-only)', () => {
    expect(INHERITABLE_TOUR_GENDERS.has('men')).toBe(true);
    expect(INHERITABLE_TOUR_GENDERS.has('women')).toBe(true);
    expect(INHERITABLE_TOUR_GENDERS.has('open')).toBe(false);
    expect(INHERITABLE_TOUR_GENDERS.has('mixed')).toBe(false);
  });
});
