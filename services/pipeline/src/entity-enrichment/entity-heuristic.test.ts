/**
 * Tests for classifyEntity — the heuristic NER that produces type_hint sent
 * to the entity-enrichment LLM.
 *
 * PERSON_LIKE matches any 2-4 Title-Case word sequence (Atlanta Braves, Real
 * Madrid, RB Leipzig, Eintracht Frankfurt, Los Angeles Dodgers, ...), so team
 * names must be excluded before that heuristic applies, or the LLM defers to
 * the wrong prior.
 *
 * Pinned behaviour:
 *   - European club prefixes (Real / FC / AC / RB / VfB / Olympique / ...)
 *     → team
 *   - US-style "City + Plural Noun" patterns (Tigers, Dodgers, Lakers, ...)
 *     → team
 *   - Irregular US singulars (Heat, Jazz, Magic, Thunder, ...) → team
 *   - Generic 2-word Title-Case form WITH sport_canonical set but no
 *     club-like pattern → unknown (NOT person), so the LLM has to actually
 *     look at sample_titles instead of inheriting a wrong prior
 *   - Player-prop template ("yes Anthony Edwards: 2+ threes") → person
 *   - Politics-domain multi-word title-case → person (unchanged)
 */
import { describe, test, expect } from 'bun:test';
import { classifyEntity, type EntityContext } from './entity-heuristic.js';

function ctx(overrides: Partial<EntityContext> & { canonical: string }): EntityContext {
  return {
    canonical: overrides.canonical,
    aliases: overrides.aliases ?? [],
    domain_category: overrides.domain_category ?? 'sports',
    current_type: overrides.current_type ?? 'unknown',
    sample_titles: overrides.sample_titles ?? [],
    tag_slugs: overrides.tag_slugs,
    limitless_sport: overrides.limitless_sport ?? null,
    limitless_league: overrides.limitless_league ?? null,
    kalshi_ticker_prefix: overrides.kalshi_ticker_prefix ?? null,
    predict_tag_names: overrides.predict_tag_names ?? null,
  };
}

describe('classifyEntity — European football clubs', () => {
  test('"Real Madrid" with sport=soccer context → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Real Madrid',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).toBe('team');
    expect(r.sport_canonical).toBe('soccer');
  });

  test('"RB Leipzig" → team (not person)', () => {
    const r = classifyEntity(ctx({
      canonical: 'RB Leipzig',
      kalshi_ticker_prefix: 'KXBUNDESLIGA',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"VfB Stuttgart" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'VfB Stuttgart',
      kalshi_ticker_prefix: 'KXBUNDESLIGA',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"AC Milan" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'AC Milan',
      kalshi_ticker_prefix: 'KXSERIEA',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"Olympique Lyonnais" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Olympique Lyonnais',
      kalshi_ticker_prefix: 'KXLIGUE1',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"Real Sociedad" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Real Sociedad',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).toBe('team');
  });
});

describe('classifyEntity — US-style "City + Plural Noun" team names', () => {
  test('"Atlanta Braves" with sport=baseball → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Atlanta Braves',
      kalshi_ticker_prefix: 'KXMLB',
    }));
    expect(r.entity_type).toBe('team');
    expect(r.sport_canonical).toBe('baseball');
  });

  test('"Los Angeles Dodgers" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Los Angeles Dodgers',
      kalshi_ticker_prefix: 'KXMLB',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"New York Yankees" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'New York Yankees',
      kalshi_ticker_prefix: 'KXMLB',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"Detroit Tigers" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Detroit Tigers',
      kalshi_ticker_prefix: 'KXMLB',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"Tampa Bay Rays" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Tampa Bay Rays',
      kalshi_ticker_prefix: 'KXMLB',
    }));
    expect(r.entity_type).toBe('team');
  });
});

describe('classifyEntity — irregular US-team singulars', () => {
  test('"Miami Heat" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Miami Heat',
      kalshi_ticker_prefix: 'KXNBA',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"Utah Jazz" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Utah Jazz',
      kalshi_ticker_prefix: 'KXNBA',
    }));
    expect(r.entity_type).toBe('team');
  });

  test('"OKC Thunder" → team', () => {
    const r = classifyEntity(ctx({
      canonical: 'OKC Thunder',
      kalshi_ticker_prefix: 'KXNBA',
    }));
    expect(r.entity_type).toBe('team');
  });
});

describe('classifyEntity — actual people are still typed as person', () => {
  test('"LeBron James" (no sport_canonical resolved by hint) → person', () => {
    // No kalshi_ticker_prefix / tag_slugs / etc. so sport_canonical is null.
    // Falls into the "no sport context" person-fallback branch.
    const r = classifyEntity(ctx({
      canonical: 'LeBron James',
      domain_category: 'sports',
    }));
    expect(r.entity_type).toBe('person');
  });

  test('"Anthony Edwards" + player-prop title → person (template match)', () => {
    const r = classifyEntity(ctx({
      canonical: 'Anthony Edwards',
      sample_titles: ['yes Anthony Edwards: 3+ threes'],
      kalshi_ticker_prefix: 'KXNBA3PT',
    }));
    expect(r.entity_type).toBe('person');
    expect(r.notes).toContain('matched_player_prop_template');
  });

  test('politics domain "Joe Biden" → person', () => {
    const r = classifyEntity(ctx({
      canonical: 'Joe Biden',
      domain_category: 'politics',
    }));
    expect(r.entity_type).toBe('person');
  });
});

describe('classifyEntity — Latin-surname players are NOT typed as team', () => {
  // A bare "ends in lowercase 's', length >= 4" heuristic also matches
  // surnames like Williams, Vinas, Torres, Palacios, Hernandez, incorrectly
  // typing soccer/tennis players as team. The explicit US_TEAM_PLURAL_TOKENS
  // whitelist avoids this.

  test('"Nico Williams" (soccer player) is NOT team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Nico Williams',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).not.toBe('team');
  });

  test('"Ferran Torres" (soccer player) is NOT team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Ferran Torres',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).not.toBe('team');
  });

  test('"Federico Viñas" (soccer player, accented surname) is NOT team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Federico Viñas',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).not.toBe('team');
  });

  test('"Cesar Palacios" (soccer player) is NOT team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Cesar Palacios',
      kalshi_ticker_prefix: 'KXLALIGA',
    }));
    expect(r.entity_type).not.toBe('team');
  });

  test('"Karen Khachanov" (tennis player) is NOT team', () => {
    const r = classifyEntity(ctx({
      canonical: 'Karen Khachanov',
      kalshi_ticker_prefix: 'KXATPMATCH',
    }));
    expect(r.entity_type).not.toBe('team');
  });
});

describe('classifyEntity — ambiguous cases return unknown (not person)', () => {
  test('multi-word form in sports context that is NOT a club pattern → unknown', () => {
    // "Mediocre Player" looks like a person, but with sport_canonical set we
    // can't tell from the heuristic alone. Returning 'unknown' lets the LLM
    // disambiguate from sample titles instead of inheriting a wrong prior.
    // A club-name pattern like "Atlanta Braves" is caught by the club-pattern
    // check above; a truly ambiguous name still returns unknown.
    const r = classifyEntity(ctx({
      canonical: 'Ronaldo Team',  // "Ronaldo" is a name but "Team" is generic
      kalshi_ticker_prefix: 'KXLOL',
    }));
    expect(['unknown', 'team']).toContain(r.entity_type);
    // Specifically should NOT be person now.
    expect(r.entity_type).not.toBe('person');
  });

  test('"Senate Democrats" in sports context (hypothetical) does NOT match team', () => {
    // Without sport_canonical resolved this stays in the no-sport-context
    // path. Even with sports_canonical hypothetically set, "Senate" is not
    // a known club prefix and "Democrats" passes US-team-plural but the
    // first token isn't a recognizable city — depends on cityness heuristic.
    // This test pins the fact that we don't over-call team for arbitrary
    // 2-word plural-ending phrases without a club-prefix + sport context.
    const r = classifyEntity(ctx({
      canonical: 'Senate Democrats',
      domain_category: 'politics',
    }));
    expect(r.entity_type).toBe('person'); // politics path → personForm fires
  });
});

describe('classifyEntity — crypto / asset tickers unchanged', () => {
  test('"BTC" in crypto domain → asset', () => {
    const r = classifyEntity(ctx({
      canonical: 'BTC',
      domain_category: 'crypto',
    }));
    expect(r.entity_type).toBe('asset');
  });

  test('"AAPL" in finance domain → asset', () => {
    const r = classifyEntity(ctx({
      canonical: 'AAPL',
      domain_category: 'finance',
    }));
    expect(r.entity_type).toBe('asset');
  });
});
