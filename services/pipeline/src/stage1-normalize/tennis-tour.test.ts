/**
 * Tennis tour (ATP/WTA) discriminator tests. Covers the native idioms the
 * tour signal can hide in, plus the never-guess and merge-preservation
 * invariants.
 */
import { describe, test, expect } from 'bun:test';
import { deriveTennisTour, tennisTourLeague, qualifyTourCanonicalEvent } from './tennis-tour.js';

describe('deriveTennisTour — signal idioms', () => {
  test('Kalshi competition prefix "ATP French Open" → men', () => {
    expect(deriveTennisTour({
      title: 'Will Carlos Alcaraz win the French Open?',
      kalshiCompetition: 'ATP French Open',
    })).toBe('men');
  });

  test('Kalshi competition prefix "WTA French Open" → women', () => {
    expect(deriveTennisTour({
      title: 'Will Coco Gauff win the French Open?',
      kalshiCompetition: 'WTA French Open',
    })).toBe('women');
  });

  test('ATP / WTA token in the title ("Will X win the WTA Rome?")', () => {
    expect(deriveTennisTour({ title: 'Will Amanda Anisimova win the WTA Rome?' })).toBe('women');
    expect(deriveTennisTour({ title: 'Will Alejandro Davidovich Fokina win the ATP Rome?' })).toBe('men');
  });

  test("PM title gender token: “Will Madison Keys win the 2026 Women's French Open?” → women", () => {
    expect(deriveTennisTour({ title: 'Will Madison Keys win the 2026 Women’s French Open?' })).toBe('women');
    expect(deriveTennisTour({ title: "Will Jannik Sinner win the 2026 Men's French Open?" })).toBe('men');
  });

  test("Kalshi event title gender token (“Men's French Open Winner”), bare market title", () => {
    expect(deriveTennisTour({
      title: 'Will Cameron Norrie win the French Open?',
      eventTitle: "Men's French Open Winner",
    })).toBe('men');
    expect(deriveTennisTour({
      title: 'Will Iga Swiatek win the French Open?',
      eventTitle: "Women's French Open Winner",
    })).toBe('women');
  });

  test('series-ticker suffix (tennis-gated): KXFOWOMEN → women BEFORE the MEN suffix check', () => {
    // "KXFOWOMEN".endsWith("MEN") is true — ordering is load-bearing.
    expect(deriveTennisTour({
      title: 'Will Emma Navarro win the French Open?', // 'french open' = tennis context
      eventTicker: 'KXFOWOMEN-26',
    })).toBe('women');
    expect(deriveTennisTour({
      title: 'Will Casper Ruud win the French Open?',
      eventTicker: 'KXFOMEN-26',
    })).toBe('men');
  });

  test('rules_primary prose fallback ("…2026 Women\'s French Open professional tennis tournament…")', () => {
    expect(deriveTennisTour({
      title: 'Will Emma Navarro win the French Open?',
      rulesPrimary: "If Emma Navarro wins the 2026 Women's French Open professional tennis tournament, then the market resolves to Yes.",
    })).toBe('women');
  });

  test('NEVER GUESSES: no signal → null', () => {
    expect(deriveTennisTour({ title: 'Will Novak Djokovic win the French Open?' })).toBeNull();
  });

  test('non-tennis gendered event title does NOT fire (tennis gate on weak signals)', () => {
    // Injecting on one platform only would split an existing sound NCAA merge.
    expect(deriveTennisTour({
      title: 'Will Duke win the National Championship?',
      eventTitle: "Men's NCAA Basketball Champion",
    })).toBeNull();
  });

  test('mixed events → null (mixed doubles / United Cup: tours genuinely mix)', () => {
    expect(deriveTennisTour({
      title: 'Will Team USA win the US Open Mixed Doubles Championship?',
    })).toBeNull();
    expect(deriveTennisTour({
      title: 'Will Poland win the United Cup?',
      eventTitle: 'United Cup Winner',
      kalshiCompetition: 'ATP United Cup', // even an ATP-prefixed mixed comp stays null
    })).toBeNull();
  });
});

describe('tennisTourLeague — KB scope only from explicit ATP/WTA signals', () => {
  test('competition prefix → tour league', () => {
    expect(tennisTourLeague({ title: 'x', kalshiCompetition: 'ATP French Open' })).toBe('ATP Tour');
    expect(tennisTourLeague({ title: 'x', kalshiCompetition: 'WTA French Open' })).toBe('WTA Tour');
  });
  test("bare “Women's” proves gender but NOT the tour league → null", () => {
    expect(tennisTourLeague({ title: 'Will X win the French Open?', eventTitle: "Women's French Open Winner" })).toBeNull();
  });
});

describe('qualifyTourCanonicalEvent — one representation, merges preserved', () => {
  test('Kalshi bare core converges onto the existing PM string (byte-equal)', () => {
    // PM already produces '2026 men s france open' / '2026 women s france open'.
    expect(qualifyTourCanonicalEvent('2026 france open', 'men')).toBe('2026 men s france open');
    expect(qualifyTourCanonicalEvent('2026 france open', 'women')).toBe('2026 women s france open');
  });

  test('cross-tour cores now DIFFER (the 500-edge bridge key is split)', () => {
    expect(qualifyTourCanonicalEvent('2026 france open', 'men'))
      .not.toBe(qualifyTourCanonicalEvent('2026 france open', 'women'));
  });

  test('idempotent on already-gendered PM cores (same-tour merge preserved)', () => {
    expect(qualifyTourCanonicalEvent('2026 women s france open', 'women')).toBe('2026 women s france open');
    expect(qualifyTourCanonicalEvent('2026 men s wimbledon', 'men')).toBe('2026 men s wimbledon');
    expect(qualifyTourCanonicalEvent('2026 men s singles tournament at the madrid open', 'men'))
      .toBe('2026 men s singles tournament at the madrid open');
  });

  test('atp/wta-token cores untouched (token already discriminates; no key churn)', () => {
    expect(qualifyTourCanonicalEvent('2026 wta rome', 'women')).toBe('2026 wta rome');
    expect(qualifyTourCanonicalEvent('2026 atp rome', 'men')).toBe('2026 atp rome');
  });

  test('any-of-K families stay tour-folded (AUD-14-B merge preserved)', () => {
    expect(qualifyTourCanonicalEvent('2026 grand slam', 'men')).toBe('2026 grand slam');
    expect(qualifyTourCanonicalEvent('2026 grand slam', 'women')).toBe('2026 grand slam');
    expect(qualifyTourCanonicalEvent('2026 major', 'men')).toBe('2026 major');
  });

  test('no leading year → qualifier prefixes', () => {
    expect(qualifyTourCanonicalEvent('france open', 'women')).toBe('women s france open');
  });
});
