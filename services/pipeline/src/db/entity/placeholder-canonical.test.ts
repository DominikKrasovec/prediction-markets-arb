/**
 * Unit tests for `isPlaceholderCanonical` (register.ts) — the KB write-path
 * belt + the placeholder classes that `isNonEntityLabel`/`_canonicalLegitimizes`
 * (resolvers.ts) delegate to.
 *
 * Pure function, no DB. Covers:
 *   - Tie/Co-Winners: award-residual no-single-winner slot shapes that would
 *     otherwise slip past `^(draw|tie)$`;
 *   - generic residual words ('other', 'none', 'neither') that would
 *     otherwise make `_canonicalLegitimizes('other')` return true;
 * while guarding the deliberate non-flags — bare numerics ('2007'/'33' are real
 * CS2 teams) and real names that merely contain a residual word must survive,
 * so the belt never falsely blocks a legitimate registration.
 */
import { describe, test, expect } from 'bun:test';
import { isPlaceholderCanonical, isStrikeLabelSubject } from './register.js';

describe('isPlaceholderCanonical — pre-existing classes still hold', () => {
  test('bare draw/tie + anonymized index placeholders are placeholders', () => {
    for (const s of ['Draw', 'draw', 'Tie', 'TIE', 'Party A', 'Team H', 'Player 10', 'Artist D', 'Chef K']) {
      expect(isPlaceholderCanonical(s)).toBe(true);
    }
  });
  test('real names that merely contain a placeholder token still register', () => {
    for (const s of ['Draw No Bet', 'The Draw', 'Drawbridge', 'Team USA', 'Team GB', 'Reform UK', 'Coach K']) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
});

describe('Tie/Co-Winners award-residual slot (BACKLOG C:Draw/Tie, re-mint id 17597)', () => {
  test('the exact live re-minted label and its variants are placeholders', () => {
    for (const s of [
      'Tie/Co-Winners', 'Tie / Co-Winners', 'tie/co-winners',
      'Co-Winners', 'Co-Winner', 'cowinners', 'Co-winner',
      'Draw/Tie', 'Tie/Draw', 'draw / tie',
      'Co-Champions', 'Co-Champion', 'cochampion',
      'Joint Winners', 'Joint Winner',
    ]) {
      expect(isPlaceholderCanonical(s)).toBe(true);
    }
  });
  test('real names containing "co-"/"joint"/"winner" survive (anchored whole-string)', () => {
    for (const s of [
      'Cowboys', 'Coventry City', 'Cochrane', 'Joint Base Andrews',
      'Winner (band)', 'The Co-op', 'Cochampion City FC',
    ]) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
});

describe('W2-7 generic residual words (anon-door other, junk sport KE id 15354)', () => {
  test('bare "other"/"none"/"neither" are placeholders', () => {
    for (const s of ['other', 'Other', 'OTHER', 'others', 'Others',
                     'none', 'None', 'none of the above', 'None Of The Above',
                     'neither', 'Neither']) {
      expect(isPlaceholderCanonical(s)).toBe(true);
    }
  });
  test('real names containing these words survive (anchored whole-string)', () => {
    for (const s of ['Other Half Brewing', 'None So Vile', 'Nonesuch Records',
                     'Neither Here Nor There', 'The Others (film)', 'Nonentity FC']) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
});

describe('W1-2 count-bucket single digits are placeholders; multi-digit real teams survive', () => {
  // "33"/"180"/"2007" are real numerics (CS2 teams / darts scores) and must
  // survive registration; a bare single digit ('0'..'9') is a "how many <X>"
  // count-bucket value and is flagged here. The exemption is narrowed to
  // 2-4 digits — the '2007'-survives invariant holds.
  test('the documented real multi-digit numeric names survive', () => {
    for (const s of ['2007', '33', '180', '538', 'BET-M 33']) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
  test('bare single-digit count buckets ARE placeholders (W1-2 fix)', () => {
    for (const s of ['0', '1', '2', '3', '4', '5', '9', ' 3 ']) {
      expect(isPlaceholderCanonical(s)).toBe(true);
    }
  });
  test('two-or-more-digit numerics are NOT flagged (only single digits are buckets here)', () => {
    for (const s of ['10', '12', '99', '00']) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
});

describe('A2 numeric strike/threshold labels are placeholders; number-bearing entities survive', () => {
  // A strike/threshold label like "Above 4.4%" / "≥ $100" / "4.2%" is a
  // resolution value, never an entity — flagged on the KB write/resolve path.
  // Narrow: a real entity that merely contains a number must survive.
  test('isStrikeLabelSubject: strike/threshold labels → true', () => {
    for (const s of [
      '4.2%', '4.6%', '≤3.9%', 'More than $100', '≥4.7%', 'At least $700',
      'Above 91', 'Below 0.5%', '<0%', 'Above 2.5%', '≥ $200', '≤ $60',
      '6.1% or above', '0.0% or below', '≥ $100', '4 or more', '$100', '100%',
    ]) {
      expect(isStrikeLabelSubject(s)).toBe(true);
      expect(isPlaceholderCanonical(s)).toBe(true);
    }
  });
  test('isStrikeLabelSubject: real number-bearing entity names → false', () => {
    for (const s of [
      '2007', '33', '180', '538', '500', 'Formula 1', 'Big 12', 'S&P 500',
      '49ers', '76ers', 'Fortune 500', 'Nasdaq 100', 'Area 51', '100 Thieves',
      '3M', '2K', 'Super Bowl LX', 'PGA Tour 2026', 'Route 66', '24/7',
    ]) {
      expect(isStrikeLabelSubject(s)).toBe(false);
    }
    // …and none of them flip isPlaceholderCanonical via the strike arm (multi-digit
    // integers stay non-placeholder, the 2007-survives invariant holds).
    for (const s of ['2007', '33', '180', '538', '500', '100 Thieves', '3M', 'S&P 500']) {
      expect(isPlaceholderCanonical(s)).toBe(false);
    }
  });
});

describe('empty / whitespace guard', () => {
  test('empty and whitespace-only are placeholders', () => {
    expect(isPlaceholderCanonical('')).toBe(true);
    expect(isPlaceholderCanonical('   ')).toBe(true);
  });
});
