/** Win-suffix slug twin predicate. Pure — the closed whitelist
 *  {win,wins,winner,towin,victory} + the ≥5-char stem floor. */
import { describe, it, expect } from 'bun:test';
import { winSuffixSlugDuplicateHit, foldOutcomeSlug } from './cell-key.js';

// canonical_key form: 'sem:1693:<slug>' — the predicate reads the tail after ':'.
const K = (slug: string) => `sem:99:${slug}`;

describe('winSuffixSlugDuplicateHit', () => {
  it('HITs rapid_vienna vs rapid_vienna_win', () => {
    expect(winSuffixSlugDuplicateHit(K('rapid_vienna'), K('rapid_vienna_win'))).toBe(true);
  });
  it('HITs rapid_vienna vs rapid_vienna_winner', () => {
    expect(winSuffixSlugDuplicateHit(K('rapid_vienna'), K('rapid_vienna_winner'))).toBe(true);
  });
  it('HITs baltimore_win vs baltimore_wins (both strip to baltimore)', () => {
    expect(winSuffixSlugDuplicateHit(K('baltimore_win'), K('baltimore_wins'))).toBe(true);
  });
  it('HITs a to_win drift (folds to towin)', () => {
    expect(winSuffixSlugDuplicateHit(K('rapid_vienna'), K('rapid_vienna_to_win'))).toBe(true);
  });
  it('no-HIT trump vs trumpjr (no win token)', () => {
    expect(winSuffixSlugDuplicateHit(K('trump'), K('trumpjr'))).toBe(false);
  });
  it('no-HIT over25 vs over35 (no win token)', () => {
    expect(winSuffixSlugDuplicateHit(K('over_2.5'), K('over_3.5'))).toBe(false);
  });
  it('no-HIT dc vs dc_win (stem <5)', () => {
    expect(winSuffixSlugDuplicateHit(K('dc'), K('dc_win'))).toBe(false);
  });
  it('no-HIT identical slugs', () => {
    expect(winSuffixSlugDuplicateHit(K('rapid_vienna'), K('rapid_vienna'))).toBe(false);
  });
  it('no-HIT either side empty', () => {
    expect(winSuffixSlugDuplicateHit(null, K('rapid_vienna_win'))).toBe(false);
    expect(winSuffixSlugDuplicateHit(K('rapid_vienna_win'), '')).toBe(false);
  });
  it('foldOutcomeSlug strips the sem:<id>: prefix and non-alnum', () => {
    expect(foldOutcomeSlug('sem:1693:Rapid_Vienna Win')).toBe('rapidviennawin');
  });
});
