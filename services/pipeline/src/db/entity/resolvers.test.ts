/**
 * Pure unit tests for resolvers.ts guards that run without a DB.
 *
 * Only `isNonEntityLabel` is exercised here — a pure string predicate. The
 * resolver classes hit Postgres + OpenAI, so they are not unit-tested here.
 * The @arb/db pool is created lazily on first query(), so importing the
 * module to call a pure function does not open a connection.
 *
 * A soccer match-result's third leg lifts into canonical_subject='Draw'. Left
 * ungated, the entity resolver would create a junk 'Draw' KB entity and
 * cosine-merge every match's draw leg into one fake shared entity. The
 * bare-token rule makes 'draw'/'tie' a non-entity so it is never embedded nor
 * persisted, without touching real entities that merely contain the word.
 */
import { describe, test, expect } from 'bun:test';
import { isNonEntityLabel, discriminatorConflict } from './resolvers.js';

describe('isNonEntityLabel — bare draw/tie placeholder guard', () => {
  test('bare "draw"/"tie" are non-entities (case-insensitive)', () => {
    expect(isNonEntityLabel('draw')).toBe(true);
    expect(isNonEntityLabel('tie')).toBe(true);
    expect(isNonEntityLabel('Draw')).toBe(true);
    expect(isNonEntityLabel('TIE')).toBe(true);
    expect(isNonEntityLabel('Tie')).toBe(true);
    expect(isNonEntityLabel('  draw  ')).toBe(true);
  });

  test('real entities containing "draw"/"tie" stay entities (soundness boundary)', () => {
    expect(isNonEntityLabel('Draw No Bet')).toBe(false);
    expect(isNonEntityLabel('The Draw')).toBe(false);
    expect(isNonEntityLabel('Drawbridge')).toBe(false);
    expect(isNonEntityLabel('drawing')).toBe(false);
    expect(isNonEntityLabel('tied')).toBe(false);
    expect(isNonEntityLabel('tie-breaker')).toBe(false);
  });

  test('ordinary teams / people are NOT flagged', () => {
    expect(isNonEntityLabel('Real Madrid')).toBe(false);
    expect(isNonEntityLabel('Lionel Messi')).toBe(false);
    expect(isNonEntityLabel('Tottenham Hotspur')).toBe(false);
    expect(isNonEntityLabel('Boston Celtics')).toBe(false);
  });
});

// The k/m/b symbolic char-class is digit-adjacent-suffix-only. Names spelled
// from k/m/b + digits are real esports orgs; magnitude values ("171K",
// "$1.2B") must still be flagged. `[kKmMbB]?` allows one trailing unit.
describe('isNonEntityLabel — fix ⑤ k/m/b magnitude class', () => {
  test('real k/m/b-letter orgs are NOT values anymore', () => {
    expect(isNonEntityLabel('B8')).toBe(false);    // esports org
    expect(isNonEntityLabel('M80')).toBe(false);   // esports org
    expect(isNonEntityLabel('M8')).toBe(false);    // esports org
    expect(isNonEntityLabel('BB')).toBe(false);
    expect(isNonEntityLabel('MK')).toBe(false);    // person
    expect(isNonEntityLabel('KBM')).toBe(false);
    expect(isNonEntityLabel('K27')).toBe(false);
  });

  test('magnitude/threshold values are still flagged', () => {
    expect(isNonEntityLabel('171K')).toBe(true);
    expect(isNonEntityLabel('$1.2B')).toBe(true);
    expect(isNonEntityLabel('5M')).toBe(true);
    expect(isNonEntityLabel('2B')).toBe(true);
    expect(isNonEntityLabel('1.5k')).toBe(true);
    expect(isNonEntityLabel('27,200')).toBe(true);
    expect(isNonEntityLabel('+2.5')).toBe(true);
    expect(isNonEntityLabel('(1.5)')).toBe(true);
  });

  test('spec `[kKmMbB]?` form catches decimal "N+" value-leaks the interim missed', () => {
    // The interim `\d\s*[kKmMbB]{0,2}[\s.,)]*$` freed a decimal value with a
    // trailing "+" (the "+" fell outside its trailing class). The spec middle
    // class catches them — they are threshold VALUES, never entity names.
    expect(isNonEntityLabel('1600.00+')).toBe(true);
    expect(isNonEntityLabel('2000.00+')).toBe(true);
    expect(isNonEntityLabel('40.0+')).toBe(true);
  });

  test('digit-less pure-symbol strings are still flagged', () => {
    expect(isNonEntityLabel('–')).toBe(true);
    expect(isNonEntityLabel('+')).toBe(true);
    expect(isNonEntityLabel(':')).toBe(true);
  });

  test('bare single letters are still flagged (436 live "B" PM display-index rows)', () => {
    // Anchors all single letters, not just {b,k,m} (placeholder indices).
    expect(isNonEntityLabel('B')).toBe(true);
    expect(isNonEntityLabel('K')).toBe(true);
    expect(isNonEntityLabel('m')).toBe(true);
    expect(isNonEntityLabel('A')).toBe(true);
    expect(isNonEntityLabel('Z')).toBe(true);
  });

  test('bare-numeric strings still pattern-flag (freed only via KB bypass at call sites)', () => {
    // "33"/"2007" are real CS2 teams but only the kbHasRealEntity bypass at
    // the label-filter call sites frees them; the pattern itself must keep
    // catching bare numbers.
    expect(isNonEntityLabel('33')).toBe(true);
    expect(isNonEntityLabel('2007')).toBe(true);
    expect(isNonEntityLabel('538')).toBe(true);
    expect(isNonEntityLabel('450')).toBe(true);
  });
});

// Tier-2 discriminator-word disagreement veto. Cross-office / cross-metric /
// cross-party / trifecta pairs must veto; the one legit political accept
// ("Republicans Sweep" ↔ "Republican Sweep") and all sports/entity accepts
// must survive; 'house' in a bare office context must not false-veto a
// same-office pair.
describe('discriminatorConflict — office axis (governor/senate/house/mayor/president)', () => {
  test('governor ↔ senate vetoes (C2 headline)', () => {
    expect(discriminatorConflict(
      'ohio governor race margin (democratic)', 'Ohio senate race margin (democratic)')).toBe(true);
    expect(discriminatorConflict(
      'wyoming senate race margin', 'Wyoming governor race margin')).toBe(true);
    expect(discriminatorConflict(
      'florida senate race margin (republican)', 'Florida governor race margin (republican)')).toBe(true);
    expect(discriminatorConflict(
      'alaska governor race turnout', 'Alaska senate race turnout')).toBe(true);
  });
  test('senate ↔ house vetoes', () => {
    expect(discriminatorConflict(
      'south dakota senate race margin', 'South Dakota house race margin')).toBe(true);
  });
  test('governor ↔ senate with matching party still vetoes on office', () => {
    expect(discriminatorConflict(
      'florida governor race margin (democratic)', 'Florida senate race margin (democratic)')).toBe(true);
  });
});

describe('discriminatorConflict — metric axis (margin/turnout)', () => {
  test('margin ↔ turnout vetoes (same office, same district)', () => {
    expect(discriminatorConflict(
      'new mexico 03 house race margin', 'New Mexico 03 house race turnout')).toBe(true);
    expect(discriminatorConflict(
      'new mexico 02 house race margin', 'New Mexico 02 house race turnout')).toBe(true);
  });
});

describe('discriminatorConflict — party axis (democratic/republican) + party-drop', () => {
  test('party qualifier present-in-one vetoes (312 party-drops)', () => {
    expect(discriminatorConflict(
      'maryland 02 house race margin (democratic)', 'Maryland 02 house race margin')).toBe(true);
    expect(discriminatorConflict(
      'florida 18 house race margin (republican)', 'Florida 18 house race margin')).toBe(true);
    expect(discriminatorConflict(
      'maryland governor race margin (democratic)', 'Maryland governor race margin')).toBe(true);
  });
  test('democratic ↔ republican (conflicting party members) vetoes', () => {
    expect(discriminatorConflict(
      'texas 15 house race margin (democratic)', 'Texas 15 house race margin (republican)')).toBe(true);
  });
});

describe('discriminatorConflict — trifecta control tuples (C2b — 5 states collapsed)', () => {
  const TARGET = 'R-House, D-Senate, R-President';
  const OTHERS = [
    'D-House, R-Senate, D-President',
    'R-House, R-Senate, D-President',
    'R-House, D-Senate, D-President',
    'D-House, R-Senate, R-President',
    'D-House, D-Senate, R-President',
  ];
  test('each of the 5 collapsed states vetoes against the merge target', () => {
    for (const s of OTHERS) expect(discriminatorConflict(s, TARGET)).toBe(true);
  });
  test('all 5 stay pairwise distinct (no two control tuples merge)', () => {
    const all = [TARGET, ...OTHERS];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++)
        expect(discriminatorConflict(all[i], all[j])).toBe(true);
  });
  test('a control tuple against itself does NOT veto (stable, self-consistent)', () => {
    expect(discriminatorConflict(TARGET, TARGET)).toBe(false);
    expect(discriminatorConflict(
      'D-House, R-Senate, D-President', 'D-House, R-Senate, D-President')).toBe(false);
  });
});

describe('discriminatorConflict — state-vs-federal LEVEL axis (FIX 4b, c2050/c1936/c1540)', () => {
  test("'state senate' blocks vs a federal senate race (both directions)", () => {
    // Kalshi "Ohio State Senate" (state legislature) vs PM "Ohio Senate race"
    // (US Senate seat). Office axis agrees (senate == senate); the level axis
    // is the only discriminator.
    expect(discriminatorConflict('Ohio State Senate', 'Ohio Senate race')).toBe(true);
    expect(discriminatorConflict('Ohio Senate race', 'Ohio State Senate')).toBe(true);
    // explicit federal wording on the other side
    expect(discriminatorConflict('Ohio State Senate', 'Ohio US Senate')).toBe(true);
  });
  test('state house / legislature / general assembly block vs federal congress', () => {
    expect(discriminatorConflict('Michigan State House', 'Michigan House race')).toBe(true);
    expect(discriminatorConflict('North Carolina State Senate', 'North Carolina Senate race')).toBe(true);
    expect(discriminatorConflict('Maine State Senate', 'Maine Senate race')).toBe(true);
    expect(discriminatorConflict('Virginia General Assembly', 'Virginia Senate race')).toBe(true);
    expect(discriminatorConflict('Ohio legislature control', 'Ohio Senate race')).toBe(true);
  });
  test("'White House' vs 'US House' CONFLICTS (NC-2 — presidency ≠ House chamber)", () => {
    // "White House" is the executive (office:president), "US House" is the
    // chamber (office:house) — a merge of the two is the fake the
    // discriminator veto must catch. Word-adjacency maps "white house" →
    // office:president so the office axis now disagrees. Both directions.
    expect(discriminatorConflict('White House', 'US House')).toBe(true);
    expect(discriminatorConflict('US House', 'White House')).toBe(true);
    expect(discriminatorConflict('Republicans win the White House', 'Republicans win the US House')).toBe(true);
    // "White House" also disagrees with a bare chamber / senate phrase…
    expect(discriminatorConflict('White House', 'House race')).toBe(true);
    expect(discriminatorConflict('White House', 'US Senate')).toBe(true);
    // …and AGREES with an explicit presidency phrase (same office).
    expect(discriminatorConflict('White House', 'presidential race')).toBe(false);
    // Same-phrase / same-office pairs never veto.
    expect(discriminatorConflict('White House', 'White House')).toBe(false);
    expect(discriminatorConflict('White House Press Secretary', 'White House Chief of Staff')).toBe(false);
    expect(discriminatorConflict('US House race', 'US House race')).toBe(false);
    // "House of Representatives" (no 'white' adjacency) stays the US chamber →
    // matches "US House" (both office:house), conflicts with "White House".
    expect(discriminatorConflict('House of Representatives', 'US House')).toBe(false);
    expect(discriminatorConflict('House of Representatives', 'White House')).toBe(true);
  });
  test('two state-legislature phrases (both carry the marker) do NOT veto on level', () => {
    // same-body pair must survive the level axis (office/party still apply).
    expect(discriminatorConflict('Ohio State Senate', 'Ohio State Senate')).toBe(false);
    expect(discriminatorConflict('Ohio State House majority', 'Ohio State House control')).toBe(false);
  });
});

describe('discriminatorConflict — legit accepts survive (no false veto)', () => {
  test('"Republicans Sweep" ↔ "Republican Sweep" (plural/singular, same party)', () => {
    // A flat token stoplist would wrongly veto this because 'republicans' ≠ 'republican'.
    expect(discriminatorConflict('Republicans Sweep', 'Republican Sweep')).toBe(false);
    expect(discriminatorConflict('Democrats Sweep', 'Democratic Sweep')).toBe(false);
  });
  test("'house' in a same-office context does not false-veto", () => {
    expect(discriminatorConflict('White House Press Secretary', 'White House Chief of Staff')).toBe(false);
    expect(discriminatorConflict('Ohio 03 house race margin', 'Ohio 03 house race margin')).toBe(false);
  });
  test('sports / entity accepts (no discriminator token) never veto', () => {
    expect(discriminatorConflict('Crystal Palace FC', 'Crystal Palace')).toBe(false);
    expect(discriminatorConflict('Manchester United FC', 'Manchester United')).toBe(false);
    expect(discriminatorConflict('Rafael Leao', 'Rafael Leão')).toBe(false);
    expect(discriminatorConflict('Barcelona', 'Barcelona')).toBe(false);
    expect(discriminatorConflict('claude-opus-4-7', 'claude-opus-4-6')).toBe(false);
  });
  test('same office + same metric + same party does not veto', () => {
    expect(discriminatorConflict(
      'texas 15 house race margin (republican)', 'texas 15 house race margin (republican)')).toBe(false);
  });
});
