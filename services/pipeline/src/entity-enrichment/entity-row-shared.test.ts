/**
 * Unit tests for the pure helpers exported by `entity-row-shared.ts`.
 *
 * These functions don't touch the DB — they're shape-transforms over
 * fields the loader has already fetched. Snapshot-style tests here pin
 * the per-platform extraction policy so any future tuning becomes an
 * explicit diff against the recorded examples.
 *
 * Per-platform shape: most Kalshi descriptions are platform-metadata
 * brackets with no prose; Polymarket/Predict first paragraphs carry league
 * + teams + date but later paragraphs are pure resolution boilerplate;
 * Limitless is usually a single structured sentence.
 */
import { describe, test, expect } from 'bun:test';
import { extractUsefulDescription } from './entity-row-shared.js';

describe('extractUsefulDescription — null / empty input', () => {
  test('null / undefined input returns null', () => {
    expect(extractUsefulDescription(null, 'kalshi')).toBeNull();
    expect(extractUsefulDescription(undefined, 'polymarket')).toBeNull();
  });

  test('empty / whitespace-only string returns null', () => {
    expect(extractUsefulDescription('', 'kalshi')).toBeNull();
    expect(extractUsefulDescription('   ', 'polymarket')).toBeNull();
    expect(extractUsefulDescription('\n\n\t', 'predict')).toBeNull();
  });
});

describe('extractUsefulDescription — kalshi platform', () => {
  test('bracket-only description (the 93% case) returns null', () => {
    const desc = '[kalshi:custom yes="yes Donovan Mitchell: 3+,yes Cleveland" no="yes Donovan Mitchell: 3+,yes Cleveland"]';
    expect(extractUsefulDescription(desc, 'kalshi')).toBeNull();
  });

  test('bracket variants (greater/structured/between) all strip cleanly when no prose follows', () => {
    expect(extractUsefulDescription('[kalshi:greater floor=3.5 yes="X" no="X"]', 'kalshi')).toBeNull();
    expect(extractUsefulDescription('[kalshi:structured floor=4.5 yes="Y" no="Y"]', 'kalshi')).toBeNull();
    expect(extractUsefulDescription('[kalshi:between floor=86000 cap=86249.99 yes="$86k range"]', 'kalshi')).toBeNull();
  });

  test('bracket + prose: strips bracket, returns first paragraph', () => {
    const desc = `[kalshi:greater floor=3.5 yes="Jose Quintana: 4+" no="Jose Quintana: 4+"]
If Jose Quintana records 4+ strikeouts in the Colorado vs Pittsburgh professional baseball game originally scheduled for May 13, 2026 at 6:40 PM EDT, then the market resolves to Yes.

Player Participation & Settlement Criteria
If Jose Quintana is scratched or is not a starting pitcher, the market will resolve to the fair market price.`;
    const out = extractUsefulDescription(desc, 'kalshi');
    expect(out).not.toBeNull();
    expect(out).toContain('Jose Quintana');
    expect(out).toContain('Colorado vs Pittsburgh');
    expect(out).toContain('professional baseball');
    // First paragraph only — the "Player Participation" boilerplate is dropped.
    expect(out).not.toContain('Player Participation');
    expect(out).not.toContain('scratched');
  });

  test('truncates at 200 chars with ellipsis', () => {
    const longProse = 'If Carlos correa records ' + 'extremely long content '.repeat(20);
    const desc = `[kalshi:greater floor=1.5 yes="X" no="X"]\n${longProse}`;
    const out = extractUsefulDescription(desc, 'kalshi');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(201); // 200 + 1 for ellipsis char
    expect(out).toMatch(/…$/);
  });

  test('handles missing trailing newline after bracket', () => {
    // Kalshi sometimes emits bracket + prose on the same line.
    const desc = '[kalshi:custom yes="A,B"]\nIf A wins the game vs B in MLB on May 1, market resolves Yes.';
    const out = extractUsefulDescription(desc, 'kalshi');
    expect(out).toContain('If A wins the game vs B in MLB');
  });
});

describe('extractUsefulDescription — polymarket / predict platforms', () => {
  test('polymarket first paragraph carries league + date — kept', () => {
    const desc = `In the upcoming Russian Premier League game, scheduled for May 10 at 8:00 AM ET:

This market will resolve to "FK Zenit" if FK Zenit win the game by 2 or more goals.

Otherwise, this market will resolve to "FK Sochi".`;
    const out = extractUsefulDescription(desc, 'polymarket');
    expect(out).toContain('Russian Premier League');
    expect(out).toContain('May 10');
    // Boilerplate paragraphs dropped.
    expect(out).not.toContain('FK Zenit win the game');
    expect(out).not.toContain('Otherwise');
  });

  test('predict same first-paragraph pattern', () => {
    const desc = `In the upcoming MLB game between the Philadelphia Phillies and Pittsburgh Pirates, scheduled for May 17 at 1:35PM ET:

This market will resolve based on the final score.`;
    const out = extractUsefulDescription(desc, 'predict');
    expect(out).toContain('MLB');
    expect(out).toContain('Philadelphia Phillies');
    expect(out).toContain('Pittsburgh Pirates');
    expect(out).not.toContain('resolve based on');
  });

  test('polymarket boilerplate-only first paragraph returns null', () => {
    // Some Polymarket descriptions skip the league header and jump
    // straight into resolution criteria. For entity classification
    // these add no signal — the title is the best available source.
    const desc = `This market will resolve to "Yes" if the price of X is above 100 on Dec 31.

If the price source is unavailable, this market will resolve based on a consensus of credible reporters.`;
    expect(extractUsefulDescription(desc, 'polymarket')).toBeNull();
    expect(extractUsefulDescription(desc, 'predict')).toBeNull();
  });

  test('case-insensitive boilerplate detection', () => {
    expect(extractUsefulDescription('this market will resolve to YES if ...', 'polymarket')).toBeNull();
    expect(extractUsefulDescription('THIS MARKET WILL RESOLVE to maybe', 'predict')).toBeNull();
  });
});

describe('extractUsefulDescription — limitless platform', () => {
  test('takes a generous slice (single-paragraph format)', () => {
    const desc = 'This market will resolve to "YES" if the combined total number of corners taken by Getafe and Osasuna is 11 or higher during regular time (90 minutes plus stoppage time only) in the La Liga match scheduled for May 24, 2026, 16:00 UTC.';
    const out = extractUsefulDescription(desc, 'limitless');
    expect(out).toContain('Getafe and Osasuna');
    expect(out).toContain('La Liga');
    expect(out!.length).toBeLessThanOrEqual(251);
  });

  test('does NOT apply the polymarket/predict boilerplate-skip rule (limitless ALL start with "This market...")', () => {
    // The "skip if starts with 'This market will resolve to'" rule is
    // specific to polymarket/predict where it indicates *no* league
    // context. Limitless descriptions ALWAYS start that way and pack
    // league + teams into the same sentence — so the rule must NOT
    // apply here.
    const desc = 'This market will resolve to YES if Real Madrid wins the El Clasico match scheduled for May 24, 2026.';
    const out = extractUsefulDescription(desc, 'limitless');
    expect(out).not.toBeNull();
    expect(out).toContain('Real Madrid');
    expect(out).toContain('El Clasico');
  });
});

describe('extractUsefulDescription — unknown platforms', () => {
  test('conservative 150-char slice of first paragraph', () => {
    const desc = 'Some other platform with a long description that goes on and on and never stops talking about all the things'.repeat(3);
    const out = extractUsefulDescription(desc, 'someother');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(201);
  });
});
