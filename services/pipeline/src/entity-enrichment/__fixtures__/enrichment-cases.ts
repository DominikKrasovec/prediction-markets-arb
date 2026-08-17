/**
 * Baseline fixture corpus for entity enrichment: each case describes a single
 * (EntityRow, LLM response, expected prepareEnrichment output) tuple. A
 * behavioral change that flips a case's expected output requires an explicit
 * fixture update, never a silent drift.
 */
import type { EntityRow, LLMEnrichmentItem, PreparedEnrichment } from '../worker.js';

type CaseCategory = 'stable' | 'kb-write' | 'guard' | 'invariant';

export interface EnrichmentCase {
  id: string;
  description: string;
  category: CaseCategory;
  row: EntityRow;
  llmResult: LLMEnrichmentItem;
  expected: PreparedEnrichment | { kind: 'invalid'; reason: string };
  expectedKBWrite?: {
    type: 'sport' | 'league' | 'competition' | 'data_provider';
    canonical: string;
    parentSportCanonical?: string | null;
    domainCategory: 'sports' | 'politics' | 'crypto' | 'finance' | 'other';
  };
}

function row(overrides: Partial<EntityRow> & Pick<EntityRow, 'id' | 'canonical' | 'type'>): EntityRow {
  return {
    aliases: [],
    domain_category: 'sports',
    metadata: {},
    enrichment_status: 'pending',
    sample_titles: [],
    sample_descriptions: [],
    co_entities: [],
    parent_events: [],
    tag_slugs: [],
    limitless_sport: null,
    limitless_league: null,
    kalshi_ticker_prefix: null,
    predict_tag_names: null,
    ...overrides,
  };
}

function llm(overrides: Partial<LLMEnrichmentItem> & Pick<LLMEnrichmentItem, 'canonical_corrected' | 'type'>): LLMEnrichmentItem {
  return {
    aliases: [],
    metadata: {},
    confidence: 0.9,
    ...overrides,
  };
}

export const ENRICHMENT_CASES: EnrichmentCase[] = [
  {
    id: 'stable-person-athlete',
    description: 'person/athlete entity with existing seeded sport/league — metadata flows through verbatim',
    category: 'stable',
    row: row({ id: 1001, canonical: '__test_player_athlete_1001', type: 'person', aliases: ['DES', 'Bane'] }),
    llmResult: llm({
      canonical_corrected: '__test_player_athlete_1001',
      type: 'person',
      aliases: ['DES', 'Bane', 'D. Bane'],
      metadata: {
        role: 'athlete',
        primary_team_canonical: 'Memphis Grizzlies',
        league_canonical: 'NBA',
        sport_canonical: 'basketball',
        country: 'USA',
      },
      confidence: 0.95,
    }),
    expected: {
      correctedCanonical: '__test_player_athlete_1001',
      newType: 'person',
      mergedAliases: ['DES', 'Bane', 'D. Bane'],
      mergedMetadata: {
        role: 'athlete',
        primary_team_canonical: 'Memphis Grizzlies',
        league_canonical: 'nba',          // resolved to seeded lowercase canonical
        sport_canonical: 'basketball',    // already seeded
        country: 'USA',
        kind: 'person',
      },
    },
  },
  {
    id: 'stable-team-with-scope',
    description: 'team with sport+league already in KB — both metadata values resolve to canonical form',
    category: 'stable',
    row: row({ id: 1002, canonical: '__test_team_scoped_1002', type: 'team', aliases: ['MEM'] }),
    llmResult: llm({
      canonical_corrected: '__test_team_scoped_1002',
      type: 'team',
      aliases: ['MEM', 'Grizzlies'],
      metadata: {
        league_canonical: 'NBA',
        sport_canonical: 'basketball',
        country: 'USA',
      },
    }),
    expected: {
      correctedCanonical: '__test_team_scoped_1002',
      newType: 'team',
      mergedAliases: ['MEM', 'Grizzlies'],
      mergedMetadata: {
        league_canonical: 'nba',
        sport_canonical: 'basketball',
        country: 'USA',
        kind: 'team',
      },
    },
  },
  {
    id: 'stable-alias-merge-case-insensitive',
    description: 'existing alias "des" + LLM alias "DES" dedupes case-insensitively — LLM form wins (overwrites in Map.set on same lowercase key)',
    category: 'stable',
    row: row({ id: 1003, canonical: '__test_player_alias_merge_1003', type: 'person', aliases: ['des', 'Bane'] }),
    llmResult: llm({
      canonical_corrected: '__test_player_alias_merge_1003',
      type: 'person',
      aliases: ['DES', 'D. Bane'],
      metadata: { role: 'athlete' },
    }),
    expected: {
      correctedCanonical: '__test_player_alias_merge_1003',
      newType: 'person',
      mergedAliases: ['DES', 'Bane', 'D. Bane'],
      mergedMetadata: { role: 'athlete', kind: 'person' },
    },
  },
  {
    id: 'stable-alias-swap-into-canonical-blocked-by-dedup',
    description: 'LLM emits new canonical with old canonical as an alias — old becomes alias, dedup removes new from alias list',
    category: 'stable',
    row: row({ id: 1004, canonical: '__test_team_short_1004', type: 'team', aliases: ['Detroit'] }),
    llmResult: llm({
      canonical_corrected: '__test_team_long_1004',
      type: 'team',
      aliases: ['__test_team_short_1004', 'Pistons'],
      metadata: { league_canonical: 'NBA', sport_canonical: 'basketball' },
    }),
    expected: {
      correctedCanonical: '__test_team_long_1004',
      newType: 'team',
      mergedAliases: ['Detroit', '__test_team_short_1004', 'Pistons'],
      mergedMetadata: {
        league_canonical: 'nba',
        sport_canonical: 'basketball',
        kind: 'team',
      },
    },
  },

  {
    id: 'kbwrite-novel-sport-with-aliases',
    description: 'LLM proposes a sport not in KB (e.g. "sumo") with aliases — level-1 sport row gets created, metadata.sport_canonical = the new canonical',
    category: 'kb-write',
    row: row({ id: 2001, canonical: 'Hakuho Sho', type: 'person', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'Hakuho Sho',
      type: 'person',
      aliases: ['Hakuho'],
      metadata: { role: 'athlete', sport_canonical: 'sumo', country: 'Japan' },
      new_sport_aliases: ['sumō', 'sumo wrestling', 'ozumo'],
    }),
    expected: {
      correctedCanonical: 'Hakuho Sho',
      newType: 'person',
      mergedAliases: ['Hakuho'],
      mergedMetadata: {
        role: 'athlete',
        sport_canonical: 'sumo',
        country: 'Japan',
        kind: 'person',
      },
    },
    expectedKBWrite: {
      type: 'sport',
      canonical: 'sumo',
      domainCategory: 'sports',
    },
  },
  {
    id: 'kbwrite-novel-league-with-parent-sport',
    description: 'LLM proposes a new league + parent sport already in KB — league row inherits sport_canonical via metadata; the headline ATP/WTA-style case from the prompt',
    category: 'kb-write',
    row: row({ id: 2002, canonical: 'Some Tennis Tour Event', type: 'competition', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'Some Tennis Tour Event',
      type: 'competition',
      metadata: { league_canonical: 'Test ATP Tour 2026', sport_canonical: 'tennis' },
      new_league_aliases: ['Test ATP', 'Test ATP/WTA'],
    }),
    expected: {
      correctedCanonical: 'Some Tennis Tour Event',
      newType: 'competition',
      mergedAliases: [],
      mergedMetadata: {
        league_canonical: 'test atp tour 2026',
        sport_canonical: 'tennis',
        kind: 'competition',
      },
    },
    expectedKBWrite: {
      type: 'league',
      canonical: 'test atp tour 2026',
      parentSportCanonical: 'tennis',
      domainCategory: 'sports',
    },
  },
  {
    id: 'kbwrite-novel-sport-no-aliases',
    description: 'LLM emits a sport not in KB without aliases (famous name case) — level-1 row still created with empty alias list',
    category: 'kb-write',
    row: row({ id: 2003, canonical: 'Some Esports Player', type: 'person', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'Some Esports Player',
      type: 'person',
      metadata: { role: 'athlete', sport_canonical: 'test_novel_esport_xyz' },
    }),
    expected: {
      correctedCanonical: 'Some Esports Player',
      newType: 'person',
      mergedAliases: [],
      mergedMetadata: {
        role: 'athlete',
        sport_canonical: 'test_novel_esport_xyz',
        kind: 'person',
      },
    },
    expectedKBWrite: {
      type: 'sport',
      canonical: 'test_novel_esport_xyz',
      domainCategory: 'sports',
    },
  },
  {
    id: 'kbwrite-sport-domain-override-on-politics-row',
    description: 'Politics-domain entity emits a sport_canonical → level-1 sport row written with domain_category=sports (NOT politics). This is the bug-fix invariant that prompted this refactor.',
    category: 'kb-write',
    row: row({
      id: 2004,
      canonical: 'IEM Testlanta 2004',
      type: 'competition',
      domain_category: 'politics',  // wrong domain on input — common during early ingestion
    }),
    llmResult: llm({
      canonical_corrected: 'IEM Testlanta 2004',
      type: 'competition',
      metadata: { sport_canonical: 'test_iem_sport_xyz' },
    }),
    expected: {
      correctedCanonical: 'IEM Testlanta 2004',
      newType: 'competition',
      mergedAliases: [],
      mergedMetadata: {
        sport_canonical: 'test_iem_sport_xyz',
        kind: 'competition',
      },
    },
    expectedKBWrite: {
      type: 'sport',
      canonical: 'test_iem_sport_xyz',
      domainCategory: 'sports',
    },
  },

  {
    id: 'guard-compound-sport-rejected',
    description: 'LLM munged multiple sports into one string ("baseball/basketball") — gate rejects, field dropped (NOT written to KB)',
    category: 'guard',
    row: row({ id: 3001, canonical: 'Multi-sport Athlete', type: 'person', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'Multi-sport Athlete',
      type: 'person',
      metadata: { role: 'athlete', sport_canonical: 'baseball/basketball' },
    }),
    expected: {
      correctedCanonical: 'Multi-sport Athlete',
      newType: 'person',
      mergedAliases: [],
      mergedMetadata: {
        role: 'athlete',
        kind: 'person',
      },
    },
  },
  {
    id: 'guard-compound-league-rejected',
    description: 'LLM emits comma-separated leagues ("MLB, NFL") — gate rejects, league_canonical dropped',
    category: 'guard',
    row: row({ id: 3002, canonical: 'Some Cross-Sport Person', type: 'person', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'Some Cross-Sport Person',
      type: 'person',
      metadata: {
        role: 'executive',
        league_canonical: 'MLB, NFL',
      },
    }),
    expected: {
      correctedCanonical: 'Some Cross-Sport Person',
      newType: 'person',
      mergedAliases: [],
      mergedMetadata: {
        role: 'executive',
        kind: 'person',
      },
    },
  },
  {
    id: 'guard-empty-canonical-rejected',
    description: 'LLM returns empty canonical_corrected after trim — invalid, worker skips',
    category: 'guard',
    row: row({ id: 3003, canonical: 'Real Entity', type: 'person' }),
    llmResult: llm({
      canonical_corrected: '   ',
      type: 'person',
    }),
    expected: { kind: 'invalid', reason: 'empty_canonical_corrected' },
  },
  {
    id: 'guard-unknown-type-falls-back-to-existing',
    description: 'LLM returns type not in ENTITY_TYPES — sanitised to "unknown", which then falls back to the existing row.type',
    category: 'guard',
    row: row({ id: 3004, canonical: 'Some Entity', type: 'organization' }),
    llmResult: llm({
      canonical_corrected: 'Some Entity',
      type: 'nonsense-type-not-in-enum',
      metadata: {},
    }),
    expected: {
      correctedCanonical: 'Some Entity',
      newType: 'organization',  // fell back to existing row.type
      mergedAliases: [],
      mergedMetadata: { kind: 'organization' },
    },
  },

  {
    id: 'invariant-blocks-semantic-rename-on-sport',
    description: 'Level-1 sport rows: semantic rename (e.g. "cs2" → "Counter-Strike 2") is blocked — TAXONOMY_TYPES guardrail keeps existing canonical, places new name into aliases. NOTE: case-only swaps (cs2 → CS2) are NOT blocked because wantsSwap is computed case-insensitively; that leak is a separate latent bug, captured in the next case.',
    category: 'invariant',
    row: row({ id: 4001, canonical: 'cs2', type: 'sport', domain_category: 'sports', aliases: ['csgo', 'cs:go'] }),
    llmResult: llm({
      canonical_corrected: 'Counter-Strike 2',  // semantic rename — must be blocked
      type: 'sport',
      aliases: ['CSGO', 'CS:GO'],
    }),
    expected: {
      correctedCanonical: 'cs2',  // unchanged — guardrail fires for semantic rename
      newType: 'sport',
      mergedAliases: ['CSGO', 'CS:GO'],
      mergedMetadata: { kind: 'sport' },
    },
  },
  {
    id: 'invariant-blocks-case-only-swap-on-sport',
    description: 'Case-only swap "cs2" → "CS2" on a level-1 sport row is BLOCKED by the taxonomy guardrail. Strict-equality swap detection on taxonomy rows means even a case-only change triggers the guard — preventing the historical bug where the canonical case wobbled and every level-2 row with metadata.sport_canonical="cs2" became inconsistent with the row\'s new uppercase canonical.',
    category: 'invariant',
    row: row({ id: 4002, canonical: 'cs2', type: 'sport', domain_category: 'sports', aliases: ['csgo', 'cs:go'] }),
    llmResult: llm({
      canonical_corrected: 'CS2',  // case-only — must be blocked
      type: 'sport',
      aliases: ['Counter-Strike 2', 'CSGO'],
    }),
    expected: {
      correctedCanonical: 'cs2',  // unchanged — guardrail fired
      newType: 'sport',
      mergedAliases: ['CSGO', 'cs:go', 'Counter-Strike 2'],
      mergedMetadata: { kind: 'sport' },
    },
  },
  {
    id: 'invariant-blocks-case-only-swap-on-league',
    description: 'Same blocked-swap invariant on league rows: "nba" → "NBA" is blocked, existing canonical preserved.',
    category: 'invariant',
    row: row({ id: 4003, canonical: 'nba', type: 'league', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'NBA',
      type: 'league',
      aliases: ['National Basketball Association'],
    }),
    expected: {
      correctedCanonical: 'nba',  // unchanged
      newType: 'league',
      mergedAliases: ['National Basketball Association'],
      mergedMetadata: { kind: 'league' },
    },
  },
  {
    id: 'invariant-case-insensitive-swap-still-works-on-person',
    description: 'Level-2 rows (person/team/etc.) keep their case-insensitive swap detection: an LLM-emitted "desmond bane" against existing canonical "Desmond Bane" does NOT count as a swap. Only taxonomy rows use strict equality.',
    category: 'invariant',
    row: row({ id: 4004, canonical: 'Desmond Bane', type: 'person', domain_category: 'sports' }),
    llmResult: llm({
      canonical_corrected: 'desmond bane',  // case-only — must NOT trigger swap on a person
      type: 'person',
      aliases: ['Bane'],
    }),
    expected: {
      correctedCanonical: 'desmond bane',  // taken verbatim, but wantsSwap=false
      newType: 'person',
      mergedAliases: ['Bane'],
      mergedMetadata: { kind: 'person' },
    },
  },
  {
    id: 'invariant-metadata-existing-keys-win',
    description: 'When existing row.metadata and LLM both set the same key, existing wins (first-write-wins for stable structural metadata).',
    category: 'invariant',
    row: row({
      id: 4003,
      canonical: 'Some Player',
      type: 'person',
      metadata: { sport_canonical: 'basketball', primary_team_canonical: 'Memphis Grizzlies' },
    }),
    llmResult: llm({
      canonical_corrected: 'Some Player',
      type: 'person',
      metadata: {
        sport_canonical: 'soccer',           // LLM disagrees with existing
        primary_team_canonical: 'Lakers',     // LLM disagrees with existing
        role: 'athlete',                       // new field — should land
      },
    }),
    expected: {
      correctedCanonical: 'Some Player',
      newType: 'person',
      mergedAliases: [],
      mergedMetadata: {
        sport_canonical: 'basketball',
        primary_team_canonical: 'Memphis Grizzlies',
        role: 'athlete',
        kind: 'person',
      },
    },
  },
];

/** Cases organised by category -- convenience for `describe` blocks. */
export const CASES_BY_CATEGORY: Record<CaseCategory, EnrichmentCase[]> = {
  stable:    ENRICHMENT_CASES.filter((c) => c.category === 'stable'),
  'kb-write': ENRICHMENT_CASES.filter((c) => c.category === 'kb-write'),
  guard:     ENRICHMENT_CASES.filter((c) => c.category === 'guard'),
  invariant: ENRICHMENT_CASES.filter((c) => c.category === 'invariant'),
};
