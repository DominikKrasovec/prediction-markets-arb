/** Person/entity-name subset twin predicate. Pure: bare-name shape guard +
 *  proper token-subset + >=4-char min-length. The distinct-KB-entity veto is
 *  applied by classifyPair, not here. */
import { describe, it, expect } from 'bun:test';
import { personNameSubsetDuplicateHit } from './cell-key.js';

describe('personNameSubsetDuplicateHit', () => {
  it('HITs a surname ⊂ full name (Antonelli ⊂ Andrea Kimi Antonelli)', () => {
    expect(personNameSubsetDuplicateHit('Antonelli', 'Andrea Kimi Antonelli')).toBe(true);
    expect(personNameSubsetDuplicateHit('Andrea Kimi Antonelli', 'Antonelli')).toBe(true); // order-invariant
  });
  it('HITs the GP grid twins (Ocon, Leclerc, Perez, Verstappen)', () => {
    expect(personNameSubsetDuplicateHit('Ocon', 'Esteban Ocon')).toBe(true);
    expect(personNameSubsetDuplicateHit('Charles Leclerc', 'Leclerc')).toBe(true);
    expect(personNameSubsetDuplicateHit('Perez', 'Sergio Perez')).toBe(true);
    expect(personNameSubsetDuplicateHit('Max Verstappen', 'Verstappen')).toBe(true);
    expect(personNameSubsetDuplicateHit('Carlos Sainz Jr', 'Sainz')).toBe(true);
  });
  it('HITs same-entity team variants (accent-folded)', () => {
    expect(personNameSubsetDuplicateHit('Tigres UANL', 'Tigres de la UANL')).toBe(true);
    expect(personNameSubsetDuplicateHit('Red Bull', 'Red Bull Racing')).toBe(true);
    expect(personNameSubsetDuplicateHit('Paris Saint-Germain', 'Paris Saint-Germain FC')).toBe(true);
  });
  it('conservatively skips variants whose extra token is a structural word (group/stage)', () => {
    // 'group' is a blacklisted non-name token, so 'Nebius' subset 'Nebius Group'
    // is left un-folded.
    expect(personNameSubsetDuplicateHit('Nebius', 'Nebius Group')).toBe(false);
  });
  it('no-HIT genuinely different drivers (Hamilton vs Russell)', () => {
    expect(personNameSubsetDuplicateHit('Hamilton', 'Russell')).toBe(false);
    expect(personNameSubsetDuplicateHit('Lewis Hamilton', 'George Russell')).toBe(false);
  });
  it('no-HIT single-token short names (min-length ≥4 guard)', () => {
    // shared token < 4 chars ⟹ guarded (bare initials / 2-3-char names never fold)
    expect(personNameSubsetDuplicateHit('Xi', 'Xi Jinping')).toBe(false);
    expect(personNameSubsetDuplicateHit('Max', 'Max Verstappen')).toBe(false); // 'max' is 3 chars
  });
  it('no-HIT identical subjects (handled by the equal-subject path, not a variant)', () => {
    expect(personNameSubsetDuplicateHit('Leclerc', 'Leclerc')).toBe(false);
  });
  it('no-HIT non-name (clause / digit / long) subjects', () => {
    // exact-score outcomes share team tokens but carry digits + relational words
    expect(personNameSubsetDuplicateHit('Exact score: Cusco FC 3 - 3', 'Exact score: Cusco FC 1 - 3')).toBe(false);
    // outperform / to-score-first / winner clauses
    expect(personNameSubsetDuplicateHit('will BTC outperform SOL', 'will SOL outperform BTC')).toBe(false);
    expect(personNameSubsetDuplicateHit('Seattle', 'will Seattle be eliminated in the 2026 season')).toBe(false);
    // >4 tokens ⟹ not a bare name
    expect(personNameSubsetDuplicateHit('Houston', 'Miami vs Houston first 7 innings winner')).toBe(false);
  });
  it('no-HIT either side empty / null', () => {
    expect(personNameSubsetDuplicateHit(null, 'Andrea Kimi Antonelli')).toBe(false);
    expect(personNameSubsetDuplicateHit('Antonelli', '')).toBe(false);
  });
});
