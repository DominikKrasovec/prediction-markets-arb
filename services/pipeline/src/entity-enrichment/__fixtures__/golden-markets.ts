/**
 * Layer 4: end-to-end golden markets.
 *
 * Each entry describes a real-world market shape where the full pipeline
 * (Stage 1 extraction -> entity registration -> entity enrichment worker)
 * must produce a specific user-visible outcome: cross-platform alias
 * matching, league vs competition vs sport disambiguation, abbreviation
 * handling.
 *
 * Records the contract: the inputs and the expected post-pipeline state of
 * `known_entities` + market entity links. Test wiring against a live DB +
 * LLM is deferred; this is the regression gate for arb-pairing correctness
 * once wired.
 */

interface GoldenMarket {
  /** Stable identifier. */
  id: string;
  /** Why this case is in the golden set (which bug class / matching axis). */
  rationale: string;
  /** Original market title as it would arrive from the platform. */
  title: string;
  /** Optional context: market description, used by Stage-1 + later by enrichment. */
  description?: string;
  /** Origin platform (affects the structured-metadata path in the enrichment worker). */
  platform: 'kalshi' | 'polymarket' | 'limitless' | 'predict' | 'opinion' | 'probable';
  /** Platform-supplied tags / metadata fields when relevant. */
  platformMetadata?: {
    /** Polymarket tag slugs */
    tag_slugs?: string[];
    /** Limitless esportTitle / leagueName */
    limitless_sport?: string;
    limitless_league?: string;
    /** Kalshi event_ticker prefix (e.g. "KXNBA") */
    kalshi_ticker_prefix?: string;
    /** Predict tag names */
    predict_tag_names?: string[];
  };
  /** Expected post-pipeline state assertions. */
  expected: {
    /** canonical_subject on the market after Stage 1. */
    canonical_subject: string;
    /**
     * For each KB entity that should exist after enrichment, the expected
     * shape. Compared case-insensitively for taxonomy fields.
     */
    entities: Array<{
      canonical: string;
      type: 'person' | 'team' | 'league' | 'competition' | 'sport' | 'asset' | 'data_provider' | 'organization' | 'location' | 'event_name';
      sport_canonical?: string;
      league_canonical?: string;
      /** A non-canonical name that MUST resolve to this entity (alias check). */
      mustResolveAlias?: string;
    }>;
  };
}

export const GOLDEN_MARKETS: GoldenMarket[] = [
  // Historical bugs
  {
    id: 'iem-atlanta-competition-classification',
    rationale: 'The reference case from this refactor discussion. IEM Atlanta is a CS2 tournament, not a league. Earlier behaviour: worker mis-classified as league. Refactored prompt + unified write path must produce type=competition + sport_canonical=cs2.',
    title: 'Will FaZe Clan win IEM Atlanta?',
    description: 'Intel Extreme Masters Atlanta 2026 is a Counter-Strike 2 tournament featuring 16 teams in a double-elimination bracket.',
    platform: 'polymarket',
    platformMetadata: {
      tag_slugs: ['cs2', 'esports', 'iem'],
    },
    expected: {
      canonical_subject: 'FaZe Clan',
      entities: [
        { canonical: 'FaZe Clan', type: 'team', sport_canonical: 'cs2' },
        { canonical: 'IEM Atlanta', type: 'competition', sport_canonical: 'cs2' },
      ],
    },
  },
  {
    id: 'cs2-canonical-case-stability',
    rationale: 'The "cs2" → "CS2" rename bug that orphaned 357 esports teams. After refactor, an entity-enrichment run on a level-1 sport row with proposed case-only swap must NOT rewrite the canonical. Validates the TAXONOMY guardrail (and any new tighter guard the refactor introduces).',
    title: 'Will G2 Esports advance from the CS2 Major Stage 2?',
    platform: 'limitless',
    platformMetadata: {
      limitless_sport: 'Counter-Strike 2',
      limitless_league: 'CS2 Major',
    },
    expected: {
      canonical_subject: 'G2 Esports',
      entities: [
        { canonical: 'G2 Esports', type: 'team', sport_canonical: 'cs2' },
        // Verify the seeded 'cs2' row was NOT renamed to 'CS2' by a stray enrichment.
        { canonical: 'cs2', type: 'sport', mustResolveAlias: 'CS2' },
      ],
    },
  },
  {
    id: 'lal-lakers-abbreviation-resolution',
    rationale: 'Tests the abbreviation-as-canonical fixup: Stage 1 extraction emits LAL, enrichment swaps in the full team name. Validates the canonical-swap-with-alias-preservation path.',
    title: 'Will LAL beat BOS tonight?',
    platform: 'kalshi',
    platformMetadata: {
      kalshi_ticker_prefix: 'KXNBA',
    },
    expected: {
      canonical_subject: 'Los Angeles Lakers',
      entities: [
        { canonical: 'Los Angeles Lakers', type: 'team', league_canonical: 'NBA', sport_canonical: 'basketball', mustResolveAlias: 'LAL' },
        { canonical: 'Boston Celtics', type: 'team', league_canonical: 'NBA', sport_canonical: 'basketball', mustResolveAlias: 'BOS' },
      ],
    },
  },

  // Cross-platform alias matching
  {
    id: 'bitcoin-cross-platform-alias',
    rationale: 'Kalshi calls it BTC; Polymarket says "Bitcoin"; Limitless might say "BTC/USD". All must resolve to the same canonical entity so the arb-solver pairs them.',
    title: 'Will BTC close above $100,000 on Dec 31?',
    platform: 'kalshi',
    expected: {
      canonical_subject: 'BTC',
      entities: [
        { canonical: 'BTC', type: 'asset', mustResolveAlias: 'Bitcoin' },
      ],
    },
  },
  {
    id: 'donald-trump-cross-platform-alias',
    rationale: 'A person entity with many alias forms across platforms: "Donald Trump", "Trump", "DJT". All must collapse to one canonical so political markets pair correctly.',
    title: 'Will Donald Trump pardon Hunter Biden by year end?',
    platform: 'polymarket',
    platformMetadata: {
      tag_slugs: ['politics', '2026-presidential'],
    },
    expected: {
      canonical_subject: 'Donald Trump',
      entities: [
        { canonical: 'Donald Trump', type: 'person', mustResolveAlias: 'Trump' },
      ],
    },
  },
  {
    id: 'premier-league-vs-mls-league-disambiguation',
    rationale: '"Premier" and "League" are common words. The League vs Competition vs Sport hierarchy must resolve "Premier League" to soccer/league, not confuse with any "Premier" competition.',
    title: 'Will Arsenal win the Premier League?',
    platform: 'predict',
    platformMetadata: {
      predict_tag_names: ['Soccer', 'Premier League'],
    },
    expected: {
      canonical_subject: 'Arsenal',
      entities: [
        { canonical: 'Arsenal', type: 'team', league_canonical: 'Premier League', sport_canonical: 'soccer', mustResolveAlias: 'ARS' },
        { canonical: 'Premier League', type: 'league', sport_canonical: 'soccer' },
      ],
    },
  },

  // League / competition / sport disambiguation
  {
    id: 'football-disambiguation-us-context',
    rationale: '"football" in US context means american football. Sport-hint comes from sample titles ("Super Bowl") and platform metadata. The unified extraction prompt must pick the right canonical.',
    title: 'Will the Chiefs win the Super Bowl?',
    platform: 'kalshi',
    platformMetadata: {
      kalshi_ticker_prefix: 'KXNFL',
    },
    expected: {
      canonical_subject: 'Kansas City Chiefs',
      entities: [
        { canonical: 'Kansas City Chiefs', type: 'team', league_canonical: 'NFL', sport_canonical: 'american football' },
        { canonical: 'Super Bowl', type: 'competition', sport_canonical: 'american football' },
      ],
    },
  },
  {
    id: 'football-disambiguation-european-context',
    rationale: 'Same word, different sport. European context → soccer. Disambiguator must use sample titles + tags.',
    title: 'Will Real Madrid win the Champions League?',
    platform: 'polymarket',
    platformMetadata: {
      tag_slugs: ['soccer', 'champions-league'],
    },
    expected: {
      canonical_subject: 'Real Madrid',
      entities: [
        { canonical: 'Real Madrid', type: 'team', sport_canonical: 'soccer' },
        { canonical: 'UEFA Champions League', type: 'competition', sport_canonical: 'soccer', mustResolveAlias: 'Champions League' },
      ],
    },
  },
  {
    id: 'fifa-world-cup-as-competition-not-league',
    rationale: 'A frequent LLM mis-classification: FIFA World Cup is a *competition*, not a league. The system prompt explicitly teaches this, and the test guards the prompt-or-data path that produces the correct classification.',
    title: 'Will Brazil win the FIFA World Cup 2026?',
    platform: 'polymarket',
    expected: {
      canonical_subject: 'Brazil national football team',
      entities: [
        { canonical: 'Brazil national football team', type: 'team', sport_canonical: 'soccer' },
        { canonical: 'FIFA World Cup', type: 'competition', sport_canonical: 'soccer' },
      ],
    },
  },

  // Abbreviation handling: Stage 1 extracts ticker/abbr; enrichment swaps to the full name
  {
    id: 'mem-grizzlies-abbreviation-swap',
    rationale: 'Stage 1 extracts MEM as canonical (per extraction prompt rule). Enrichment swaps to Memphis Grizzlies as canonical, demoting MEM to alias.',
    title: 'Will MEM cover the spread vs DAL?',
    platform: 'kalshi',
    platformMetadata: {
      kalshi_ticker_prefix: 'KXNBA',
    },
    expected: {
      canonical_subject: 'Memphis Grizzlies',
      entities: [
        { canonical: 'Memphis Grizzlies', type: 'team', league_canonical: 'NBA', sport_canonical: 'basketball', mustResolveAlias: 'MEM' },
        { canonical: 'Dallas Mavericks', type: 'team', league_canonical: 'NBA', sport_canonical: 'basketball', mustResolveAlias: 'DAL' },
      ],
    },
  },
  {
    id: 'des-bane-jersey-ticker-resolution',
    rationale: 'Player-prop markets use jersey tickers ("DES"). The enrichment LLM must recognise these as person/athlete entities and supply the full name.',
    title: 'Will DES record 2+ threes tonight?',
    platform: 'limitless',
    platformMetadata: {
      limitless_sport: 'Basketball',
      limitless_league: 'NBA',
    },
    expected: {
      canonical_subject: 'Desmond Bane',
      entities: [
        { canonical: 'Desmond Bane', type: 'person', league_canonical: 'NBA', sport_canonical: 'basketball', mustResolveAlias: 'DES' },
      ],
    },
  },

  // Edge cases: pathological inputs that can corrupt the KB
  {
    id: 'compound-sport-rejected-end-to-end',
    rationale: 'A market whose subject plays multiple sports. LLM might propose sport_canonical="basketball/football". The looksLikePlausibleTaxonomyName gate must REJECT, leaving sport_canonical unset rather than creating a junk level-1 row.',
    title: 'Is Bo Jackson the GOAT cross-sport athlete?',
    description: 'Bo Jackson played both MLB and NFL professionally.',
    platform: 'opinion',
    expected: {
      canonical_subject: 'Bo Jackson',
      entities: [
        // Must NOT create a level-1 sport entity "basketball/football" or "MLB/NFL".
        { canonical: 'Bo Jackson', type: 'person' /* no sport_canonical asserted — should be absent or one specific sport */ },
      ],
    },
  },
  {
    id: 'politics-domain-no-sport-leak',
    rationale: 'A politics-domain market must NOT spawn level-1 sport entities even if a stray classifier emits one. domain_category isolation must hold across the unified write path.',
    title: 'Will the Senate confirm the FOMC chair nominee by April?',
    platform: 'polymarket',
    platformMetadata: {
      tag_slugs: ['politics', 'fed'],
    },
    expected: {
      canonical_subject: 'FOMC',
      entities: [
        { canonical: 'FOMC', type: 'organization' },
      ],
    },
  },
];

/**
 * Sanity: every golden case has at least one entity assertion.
 * (Cheap import-time check — pulled into the test file.)
 */
export function validateGoldenCorpus(): void {
  const ids = new Set<string>();
  for (const m of GOLDEN_MARKETS) {
    if (ids.has(m.id)) throw new Error(`Duplicate golden market id: ${m.id}`);
    ids.add(m.id);
    if (m.expected.entities.length === 0) {
      throw new Error(`Golden market ${m.id} has no entity assertions`);
    }
  }
}
