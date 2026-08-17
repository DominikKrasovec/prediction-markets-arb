/** The fold-title HIT must not equate Kalshi categorical siblings (one shared
 *  title, outcomes in yes_sub_title / distinct subjects) while preserving
 *  shaped/unshaped-prefix pairs and true twins. */
import { describe, it, expect } from 'bun:test';
import { foldTitleDuplicateHit, fold } from './index.js';

const T = (s: string) => new Set([fold(s)!]);

describe('foldTitleDuplicateHit (§4.3 REVISED-c)', () => {
  it('releases Kalshi categorical siblings (same title, distinct subjects)', () => {
    expect(foldTitleDuplicateHit(T('Rio Ave vs Sporting CP Winner?'), T('Rio Ave vs Sporting CP Winner?'),
      fold('Rio Ave')!, fold('Sporting CP')!)).toBe(false);
    expect(foldTitleDuplicateHit(T('Rio Ave vs Sporting CP Winner?'), T('Rio Ave vs Sporting CP Winner?'),
      fold('Sporting CP')!, fold('Tie')!)).toBe(false);
  });
  it('keeps true twins (same title, same subject)', () => {
    expect(foldTitleDuplicateHit(T('Will Anthropic be acquired before 2027?'), T('Will Anthropic be acquired before 2027?'),
      fold('Anthropic')!, fold('Anthropic')!)).toBe(true);
  });
  it('keeps the c360 shaped/unshaped prefix class', () => {
    expect(foldTitleDuplicateHit(T('Will Anthropic be acquired before 2027?'), T('Will Anthropic be acquired before 2027?'),
      fold('Anthropic')!, fold('Anthropic acquired before 2027')!)).toBe(true);
  });
  it('keeps unshaped-both (empty subjects) conservative HIT', () => {
    expect(foldTitleDuplicateHit(T('Some market'), T('Some market'), '', '')).toBe(true);
  });
  it('no title overlap ⟹ never a HIT regardless of subjects', () => {
    expect(foldTitleDuplicateHit(T('A?'), T('B?'), fold('X')!, fold('X')!)).toBe(false);
  });
  it('short prefix (<5) does not bridge distinct subjects', () => {
    expect(foldTitleDuplicateHit(T('T?'), T('T?'), fold('ab')!, fold('abcdef')!)).toBe(false);
  });
});

describe('foldTitleDuplicateHit outcome-slug arm (REVISED-c2)', () => {
  const T = (s: string) => new Set([fold(s)!]);
  it('releases election candidate co-slots (same subject, distinct outcome slugs)', () => {
    expect(foldTitleDuplicateHit(T('CA-14 special election?'), T('CA-14 special election?'),
      fold('CA-14 special election winner')!, fold('CA-14 special election winner')!,
      fold('aisha wahab')!, fold('carin elam')!)).toBe(false);
  });
  it('keeps twins with identical outcome slugs', () => {
    expect(foldTitleDuplicateHit(T('T?'), T('T?'), fold('X race')!, fold('X race')!,
      fold('anthropic')!, fold('anthropic')!)).toBe(true);
  });
  it('keeps c360 prefix outcome slugs', () => {
    expect(foldTitleDuplicateHit(T('T?'), T('T?'), fold('anthropic')!, fold('anthropic')!,
      fold('anthropic')!, fold('anthropic acquired before 2027')!)).toBe(true);
  });
  it('empty outcome slugs stay conservative', () => {
    expect(foldTitleDuplicateHit(T('T?'), T('T?'), fold('same')!, fold('same')!, '', '')).toBe(true);
  });
});
