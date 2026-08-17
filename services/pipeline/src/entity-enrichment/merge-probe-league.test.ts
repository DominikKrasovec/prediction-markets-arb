/**
 * Step-2 league/competition merge-probe tests (PURE — no DB, no LLM).
 *
 * Two layers, both runnable while a pipeline rebuild owns the DB:
 *   1. `stripLeagueGenericStems` — the pure stem-token tightening that keys the
 *      probe on the DISTINCTIVE token (romania/romanian) instead of fanning on
 *      'league'/'liga'. Pins the never-empty guarantee + that multilingual dups
 *      surface while cross-sport collisions do not.
 *   2. Prompt-rule presence — the `entity_merge_verify` system prompt now
 *      carries the SAME / DIFFERENT league rules (tier-word, country, cup-vs-
 *      league). String-presence assertions on the loaded prompt, NOT an LLM call.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripLeagueGenericStems } from './merge-probe.js';

// Read the prompt directly from THIS package's source tree (relative to the
// test file) rather than via loadPromptTemplate('entity_merge_verify'): in a
// git-worktree checkout @arb/llm resolves through the shared root node_modules
// (the MAIN checkout's copy), so loadPromptTemplate would read the wrong file.
// The relative path always reads the system.md that ships in this checkout.
const SYSTEM_MD_PATH = resolve(
  import.meta.dir,
  '..', '..', '..', '..',
  'packages', 'llm', 'prompts', 'entity_merge_verify', 'system.md',
);

// 1. stripLeagueGenericStems — pure stem tightening for league sources
describe('stripLeagueGenericStems (league-source stem tightening)', () => {
  test('keeps the DISTINCTIVE token, drops generic competition stems', () => {
    // "romanian superliga" → distinctive token "romanian" survives so the probe
    // surfaces "Romania SuperLiga" via the shared "roman..." stem.
    expect(stripLeagueGenericStems(['romanian', 'superliga'])).toEqual(['romanian']);
    expect(stripLeagueGenericStems(['czechia', 'fortuna', 'liga'])).toEqual(['czechia', 'fortuna']);
    expect(stripLeagueGenericStems(['colombian', 'liga', 'dimayor'])).toEqual(['colombian', 'dimayor']);
  });

  test('does NOT key on generic stems alone — "premier"/"league" are stripped', () => {
    // The over-fan vector: 'Premier League' (soccer) ↔ 'european pro league'
    // (cs2) via shared generic tokens. After stripping, "premier"+"league" are
    // gone, so the stem probe no longer keys on them. (The SQL sport-prefilter
    // is the hard gate that also blocks the cross-sport row; this just
    // ensures the stem probe isn't the thing that surfaces it.)
    expect(stripLeagueGenericStems(['premier', 'league'])).toEqual(['premier', 'league']); // ALL generic → fallback
    // but a distinctive token alongside them is what survives:
    expect(stripLeagueGenericStems(['english', 'premier', 'league'])).toEqual(['english']);
  });

  test('NEVER returns empty: all-generic name falls back to the full token set', () => {
    // Guarantees a non-empty to_tsquery so a bare all-generic league still
    // surfaces siblings instead of matching nothing.
    expect(stripLeagueGenericStems(['league'])).toEqual(['league']);
    expect(stripLeagueGenericStems(['super', 'league'])).toEqual(['super', 'league']);
    expect(stripLeagueGenericStems([])).toEqual([]);
  });

  test('acronym sources are untouched (single distinctive token kept)', () => {
    // "ahl" is not in the generic set, so it survives — the acronym-direction
    // widening (step 4) then surfaces "American Hockey League".
    expect(stripLeagueGenericStems(['ahl'])).toEqual(['ahl']);
    expect(stripLeagueGenericStems(['dimayor'])).toEqual(['dimayor']);
  });
});

// 2. entity_merge_verify system prompt — league SAME/DIFFERENT rules present
describe('entity_merge_verify system prompt — league rules', () => {
  const sys = readFileSync(SYSTEM_MD_PATH, 'utf-8');

  test('has a dedicated league/competition rules section', () => {
    expect(sys).toContain('League / competition rules');
  });

  test('SAME rule: multilingual / abbrev dups (same sport + same country)', () => {
    expect(sys).toContain('Romania SuperLiga');
    expect(sys).toContain('romanian superliga');
    expect(sys).toContain('American Hockey League');
    expect(sys).toContain('colombian liga dimayor');
    expect(sys).toContain('j2 100 year vision league');
  });

  test('DIFFERENT rule: tier-word / digit marks a different division', () => {
    expect(sys).toContain('La Liga 2');
    expect(sys).toContain('Bundesliga 2');
    expect(sys).toContain('LCK Challengers League');
  });

  test('DIFFERENT rule: country differs ⟹ different competition', () => {
    expect(sys).toContain('Chile Primera');
    expect(sys).toContain('Argentina Primera');
    expect(sys.toLowerCase()).toContain('country differs');
  });

  test('DIFFERENT rule: cup/knockout is NOT a domestic league', () => {
    expect(sys).toContain('Copa do Brasil');
    expect(sys).toContain('competes_in');
  });

  test('cross-sport collision: EPL soccer↔cs2 and Ligat HaAl are caught', () => {
    expect(sys).toContain('EPL');
    expect(sys).toContain('european pro league');
    expect(sys).toContain("Ligat Ha'Al");
  });
});
