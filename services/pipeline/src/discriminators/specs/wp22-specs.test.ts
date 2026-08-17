/**
 * Unit tests for the party / tour_gender / rank_grain extract logic.
 * Soundness focus: both-or-neither/conflict → null (party), tennis-context gating
 * (tour_gender), the value_unit='rank' gate (rank_grain).
 */
import { describe, test, expect } from 'bun:test';
import type { ExtractCtx } from '../registry.js';
import { extractParty, extractPartyToken, partySpec } from './party.js';
import { extractRankGrain, rankGrainSpec } from './rank-grain.js';
import { tourGenderSpec } from './tour-gender.js';
import { tourGenderDiscriminator } from '../../stage1-normalize/tennis-tour.js';

const ctx = (over: Partial<ExtractCtx> & { gated?: Record<string, unknown> }): ExtractCtx => ({
  title: '', outcomeLabel: null, eventKind: null, matchSource: null, platform: '',
  raw: null, kb: null, gated: {}, ...over,
});

describe('party.extractPartyToken', () => {
  test('single US major party → canonical token', () => {
    expect(extractPartyToken('Will Republicans win the House?')).toBe('republican');
    expect(extractPartyToken('Democratic margin of victory')).toBe('democratic');
    expect(extractPartyToken('GOP holds the seat')).toBe('republican');
  });
  test('both majors OR neither → null (party-agnostic)', () => {
    expect(extractPartyToken('Republicans vs Democrats margin')).toBeNull();
    expect(extractPartyToken('Race decided by 5+ points')).toBeNull();
    expect(extractPartyToken(null)).toBeNull();
  });
  test('does NOT match inside unrelated words (no bare dem/rep)', () => {
    expect(extractPartyToken('The representative demanded a recount')).toBeNull();
  });
  test('intl parties map to their own token; two distinct → null', () => {
    expect(extractPartyToken('Will Labour win?')).toBe('labour');
    expect(extractPartyToken('Tories to hold Uxbridge')).toBe('conservative');
    expect(extractPartyToken('Labour vs Conservatives')).toBeNull();
  });
});

describe('party.extractParty (cross-field, conflict-aware)', () => {
  test('winner kind: party in canonical_subject', () => {
    expect(extractParty(ctx({ eventKind: 'election_outcome_winner', gated: { canonical_subject: 'Democratic Party' } }))).toBe('democratic');
  });
  test('margin kind: party in title', () => {
    expect(extractParty(ctx({ title: 'Margin of victory for Republicans in GA-09', eventKind: 'election_margin' }))).toBe('republican');
  });
  test('cross-field conflict → null', () => {
    expect(extractParty(ctx({ title: 'Republicans favored', gated: { canonical_subject: 'Democratic Party' } }))).toBeNull();
  });
  test('spec metadata: fold-key / tolerant / builder / JSONB-only', () => {
    expect(partySpec.assertion).toBe('fold-key');
    expect(partySpec.nullPolicy).toBe('tolerant');
    expect(partySpec.foldSurface).toBe('builder');
    expect(partySpec.gatedField).toBeUndefined();
  });
});

describe('tour_gender.tourGenderDiscriminator', () => {
  test('PM title carries the token directly', () => {
    expect(tourGenderDiscriminator("Will Coco Gauff win the 2026 Women's French Open?", null)).toBe('women');
    expect(tourGenderDiscriminator('Alcaraz vs Sinner (ATP)', null)).toBe('men');
  });
  test('Kalshi championship: token absent from title but present in lifted canonical_event', () => {
    // title supplies the tennis CONTEXT ("French Open"), canonical_event the gender.
    expect(tourGenderDiscriminator('Will Cameron Norrie win the French Open?', '2026 men s france open')).toBe('men');
  });
  test('non-tennis "women" is NOT stamped (no tennis context) — the soccer WWC trap', () => {
    expect(tourGenderDiscriminator("Will the USA win the Women's World Cup?", '2026 women s world cup')).toBeNull();
  });
  test('unknown / no signal → null', () => {
    expect(tourGenderDiscriminator('Arsenal vs Burnley: winner', '2026 arsenal vs burnley')).toBeNull();
  });
  // The native-metadata arm activates via ctx.raw — series ticker +
  // rules_primary feed deriveTennisTour's weak tiers.
  test('native arm: series-ticker suffix decides when title/ce are token-free (tennis context from title)', () => {
    expect(tourGenderSpec.extract(ctx({
      title: 'Will Cameron Norrie win the French Open?',
      raw: { event_ticker: 'KXFOMEN-26' },
    }))).toBe('men');
    expect(tourGenderSpec.extract(ctx({
      title: 'Will Iga Swiatek win the French Open?',
      raw: { event_ticker: 'KXFOWOMEN-26' },
    }))).toBe('women');
  });
  test('native arm: rules_primary gender prose decides (tennis-context-gated)', () => {
    expect(tourGenderSpec.extract(ctx({
      title: 'Will Cameron Norrie win the French Open?',
      raw: { rules_primary: "…the 2026 Men's French Open professional tennis tournament…" },
    }))).toBe('men');
    // no tennis context anywhere → weak signals stay dark (the WWC trap holds)
    expect(tourGenderSpec.extract(ctx({
      title: 'Will the USA win the World Cup?',
      raw: { rules_primary: "…the Women's World Cup final…" },
    }))).toBeNull();
  });
  test('native arm: raw absent (pre-WP-R2 shape) → unchanged null-on-doubt', () => {
    expect(tourGenderSpec.extract(ctx({ title: 'Will Cameron Norrie win the French Open?' }))).toBeNull();
  });
  test('spec metadata: fold-key / block-when-sibling-known / builder / JSONB-only', () => {
    expect(tourGenderSpec.assertion).toBe('fold-key');
    expect(tourGenderSpec.nullPolicy).toBe('block-when-sibling-known');
    expect(tourGenderSpec.foldSurface).toBe('builder');
    expect(tourGenderSpec.gatedField).toBeUndefined();
  });
});

describe('rank_grain.extractRankGrain', () => {
  test('fires ONLY on value_unit=rank; returns the rank number', () => {
    expect(extractRankGrain(ctx({ gated: { value_unit: 'rank', value_primary: 1 } }))).toBe('1');
    expect(extractRankGrain(ctx({ gated: { value_unit: 'rank', value_primary: 2 } }))).toBe('2');
  });
  test('does NOT fire on a non-rank valued market (the over-stamp trap the gatedField mirror would hit)', () => {
    expect(extractRankGrain(ctx({ gated: { value_unit: 'usd', value_primary: 200000 } }))).toBeNull();
    expect(extractRankGrain(ctx({ gated: { value_unit: 'rank', value_primary: null } }))).toBeNull();
  });
  test('spec metadata: guard-only / block-when-sibling-known / JSONB-only', () => {
    expect(rankGrainSpec.assertion).toBe('guard-only');
    expect(rankGrainSpec.nullPolicy).toBe('block-when-sibling-known');
    expect(rankGrainSpec.gatedField).toBeUndefined();
  });
  test('kind scope includes award_winner (validator caveat #1 / W2-2) alongside championship_winner', () => {
    // Without award_winner in scope, the value_unit=rank convention stays
    // inert and the block-when-sibling-known belt severs award legs.
    expect(rankGrainSpec.kinds).toContain('award_winner');
    expect(rankGrainSpec.kinds).toContain('championship_winner');
    // Non-winner kinds stay out of scope (no over-stamp).
    expect(rankGrainSpec.kinds).not.toContain('match_winner');
    expect(rankGrainSpec.kinds).not.toContain('halftime_leader');
  });
});
