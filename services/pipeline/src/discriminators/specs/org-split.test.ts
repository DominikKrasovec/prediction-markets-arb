/**
 * The `org_split` gender-axis fold-key unit tests.
 * Soundness focus: KB-first per-subject arm, title fallback for team fields,
 * both-or-neither/conflict → null, word-boundary safety (women≠men, no
 * "tournament"/"Bremen" false men), and the anti-drift lint against
 * tour_gender (org_split is a SUPERSET that never DISAGREES on a shared row).
 */
import { describe, test, expect } from 'bun:test';
import type { ExtractCtx, WarmKbCache } from '../registry.js';
import { extractGenderFromTitle, extractOrgSplit, orgSplitSpec } from './org-split.js';
import { tourGenderDiscriminator } from '../../stage1-normalize/tennis-tour.js';

/** A warm KB stub: maps a few subjects to a tour_gender fact. */
const kbStub = (facts: Record<string, 'men' | 'women'>): WarmKbCache => ({
  lookupCanonical(name: string) {
    const g = facts[name];
    return g ? { type: 'person', sport_canonical: null, league_canonical: null, tour_gender: g } : null;
  },
});

const ctx = (over: Partial<ExtractCtx> & { gated?: Record<string, unknown> }): ExtractCtx => ({
  title: '', outcomeLabel: null, eventKind: 'championship_winner', matchSource: null,
  platform: '', raw: null, kb: null, gated: {}, ...over,
});

describe('extractGenderFromTitle (title arm)', () => {
  test.each([
    ['Will Aaron Rai win the PGA Championship?', 'men'],
    ['Will Nelly Korda win the LPGA Championship?', 'women'],
    ['Will the Spurs win the NBA Finals?', 'men'],
    ['Will the Aces win the WNBA Finals?', 'women'],
    ['Alcaraz vs Sinner (ATP)', 'men'],
    ['Sabalenka vs Gauff (WTA)', 'women'],
    ["Will the USA win the Women's World Cup?", 'women'],
    ["Men's 100m final winner", 'men'],
    ['Ladies singles champion', 'women'],
  ])('%s → %s', (title, g) => expect(extractGenderFromTitle(title)).toBe(g as 'men' | 'women'));

  test('lpga does not also fire the men pga token (distinct \\b tokens)', () => {
    expect(extractGenderFromTitle('LPGA Tour Championship winner')).toBe('women');
    expect(extractGenderFromTitle('WNBA playoffs winner')).toBe('women'); // not nba→men
  });

  test('word boundary: "women"/"tournament"/"Bremen" never trip the men token', () => {
    expect(extractGenderFromTitle("Women's downhill winner")).toBe('women');
    expect(extractGenderFromTitle('Who wins the tournament?')).toBeNull();
    expect(extractGenderFromTitle('Will Werder Bremen win the league?')).toBeNull();
  });

  test('two conflicting genders in one title → null (never guess)', () => {
    expect(extractGenderFromTitle("Men's and Women's combined champion")).toBeNull();
    expect(extractGenderFromTitle('NBA or WNBA MVP')).toBeNull();
  });

  test('no gendered token → null; null/empty tolerated', () => {
    expect(extractGenderFromTitle('Will Arsenal beat Chelsea?')).toBeNull();
    expect(extractGenderFromTitle(null)).toBeNull();
    expect(extractGenderFromTitle('')).toBeNull();
  });
});

describe('extractOrgSplit (KB-first, title fallback)', () => {
  test('KB arm wins: a player-name-only title stamps from the subject gender', () => {
    // "Will {golfer} win the PGA Championship?" sibling slots are titled by
    // player, but the KB gives every golfer 'men'.
    const c = ctx({
      title: 'Will Rory McIlroy win the championship?',
      gated: { canonical_subject: 'Rory McIlroy' },
      kb: kbStub({ 'Rory McIlroy': 'men' }),
    });
    expect(extractOrgSplit(c)).toBe('men');
  });

  test('KB miss → title fallback (team fields the KB does not stamp)', () => {
    const c = ctx({
      title: 'Will the Aces win the WNBA Finals?',
      gated: { canonical_subject: 'Las Vegas Aces' },
      kb: kbStub({}), // team not in KB gender map
    });
    expect(extractOrgSplit(c)).toBe('women');
  });

  test('cold KB (null handle) → title arm only', () => {
    expect(extractOrgSplit(ctx({ title: 'Will Aaron Rai win the PGA Championship?', kb: null }))).toBe('men');
  });

  test('no subject + no title token → null', () => {
    expect(extractOrgSplit(ctx({ title: 'Will Arsenal beat Chelsea?', gated: {}, kb: null }))).toBeNull();
  });
});

describe('spec metadata', () => {
  test('fold-key / block-when-sibling-known / builder / kb source / no gatedField / no setSplit', () => {
    expect(orgSplitSpec.assertion).toBe('fold-key');
    expect(orgSplitSpec.nullPolicy).toBe('block-when-sibling-known');
    expect(orgSplitSpec.foldSurface).toBe('builder');
    expect(orgSplitSpec.source).toBe('kb');
    expect(orgSplitSpec.gatedField).toBeUndefined();
    expect(orgSplitSpec.setSplit).toBeUndefined(); // single-gender categorical mutex must not split
    expect(orgSplitSpec.kinds).toEqual(['championship_winner', 'match_winner']);
  });
});

describe('F-B anti-drift lint — org_split never DISAGREES with tour_gender', () => {
  // The two specs stay separate (org_split is a strict superset). The invariant
  // that must hold forever: where BOTH stamp a non-null gender on the same row,
  // they agree. NULL-vs-value is allowed (the superset direction). Tennis rows
  // whose gender lives in the TITLE (the shared signal) exercise the overlap.
  const tennisTitles = [
    "Will Coco Gauff win the 2026 Women's French Open?",
    'Alcaraz vs Sinner (ATP)',
    'Sabalenka vs Swiatek (WTA)',
    "Men's Wimbledon final winner",
  ];
  test.each(tennisTitles)('%s: agree-or-null', (title) => {
    const tour = tourGenderDiscriminator(title, null);
    const split = extractGenderFromTitle(title);
    if (tour != null && split != null) expect(split).toBe(tour);
  });
});
