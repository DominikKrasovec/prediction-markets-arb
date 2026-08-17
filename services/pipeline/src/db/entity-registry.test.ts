// Tests for the KB taxonomy resolver against the live KB seeded by seedEntityKB(); skips
// with a warning (not a failure) when Postgres is unreachable.
import { describe, test, expect, beforeAll } from 'bun:test';
import { query } from '@arb/db';
import { warmKBCache, resolveTaxonomyCanonical, getTaxonomyContext, sportResolver, leagueResolver } from './entity-registry.js';

// Drives the resolver with the same options the worker applies for taxonomy auto-creation
// (worker.ts prepareEnrichment), so a drift there shows up here.
async function workerStyleTaxonomyCreate(
  canonical: string,
  kind: 'sport' | 'league',
  aliases: string[],
  domain: 'sports' | 'politics' | 'crypto' | 'finance' | 'other',
  parentSport: string | null = null,
): Promise<string | null> {
  const resolver = kind === 'sport' ? sportResolver : leagueResolver;
  const extra: Record<string, unknown> = { _origin: 'llm_taxonomy_enrichment' };
  if (parentSport && parentSport.trim()) {
    extra.sport_canonical = parentSport.trim().toLowerCase();
  }
  const hit = await resolver.resolve(canonical, domain, extra, {
    aliases,
    lowercaseCanonical: true,
    initialEnrichmentStatus: 'enriched',
    forceSportsDomain: true,
  });
  return hit?.canonical ?? null;
}

let pgAvailable = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    await warmKBCache();
    pgAvailable = true;
  } catch (err) {
    console.warn('[entity-registry.test] PG unreachable — skipping resolver tests:', (err as Error).message);
  }
});

describe('resolveTaxonomyCanonical', () => {
  test('null / empty / whitespace candidates → null', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical(null, 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical(undefined, 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical('', 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical('   ', 'sport')).toBeNull();
  });

  test('exact canonical match returns canonical', async () => {
    if (!pgAvailable) return;
    const got = await resolveTaxonomyCanonical('league of legends', 'sport');
    expect(got).toBe('league of legends');
  });

  test('case-insensitive canonical match returns canonical', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('League of Legends', 'sport')).toBe('league of legends');
    expect(await resolveTaxonomyCanonical('LEAGUE OF LEGENDS', 'sport')).toBe('league of legends');
  });

  test('alias match returns canonical — the headline synonym case', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('lol', 'sport')).toBe('league of legends');
    expect(await resolveTaxonomyCanonical('LoL', 'sport')).toBe('league of legends');
    expect(await resolveTaxonomyCanonical('lol esports', 'sport')).toBe('league of legends');
  });

  test('alias resolution works for other seeded synonyms', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('csgo', 'sport')).toBe('cs2');
    expect(await resolveTaxonomyCanonical('cs:go', 'sport')).toBe('cs2');
    expect(await resolveTaxonomyCanonical('f1', 'sport')).toBe('formula 1');
    expect(await resolveTaxonomyCanonical('dota', 'sport')).toBe('dota 2');
  });

  test('unknown candidate returns null (does not auto-create)', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('this-is-not-a-sport-xyz', 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical('hyperloop-racing', 'sport')).toBeNull();
  });

  test('type scoping: asking for sport kind does not return a league row', async () => {
    if (!pgAvailable) return;
    const asLeague = await resolveTaxonomyCanonical('NBA', 'league');
    if (asLeague !== null) {
      // Pre/post-migration DBs may have 'NBA' or 'nba'; accept either case.
      expect(asLeague.toLowerCase()).toBe('nba');
    }
    const asSport = await resolveTaxonomyCanonical('NBA', 'sport');
    expect(asSport).toBeNull();
  });

  test('type scoping: asking for league kind does not return a sport row', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('league of legends', 'league')).toBeNull();
  });

  test('whitespace-trimmed input matches', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('  league of legends  ', 'sport')).toBe('league of legends');
    expect(await resolveTaxonomyCanonical('\tlol\n', 'sport')).toBe('league of legends');
  });

  test('hyphen / underscore normalization matches the spaced canonical form', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('american-football', 'sport')).toBe('american football');
    expect(await resolveTaxonomyCanonical('ice-hockey',       'sport')).toBe('ice hockey');
    expect(await resolveTaxonomyCanonical('league_of_legends','sport')).toBe('league of legends');
    expect(await resolveTaxonomyCanonical('rugby_league',     'sport')).toBe('rugby league');
    expect(await resolveTaxonomyCanonical('mixed-martial-arts','sport')).toBe('mma');
  });

  test('ambiguity guard: "football" matches both american football and soccer → returns null', async () => {
    if (!pgAvailable) return;
    // Silently picking one alias owner would bake a misclassification into the level-2 row.
    expect(await resolveTaxonomyCanonical('football', 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical('Football', 'sport')).toBeNull();
    expect(await resolveTaxonomyCanonical('FOOTBALL', 'sport')).toBeNull();
  });

  test('unambiguous canonicals on either side of the ambiguity still resolve cleanly', async () => {
    if (!pgAvailable) return;
    expect(await resolveTaxonomyCanonical('soccer',            'sport')).toBe('soccer');
    expect(await resolveTaxonomyCanonical('american football', 'sport')).toBe('american football');
    expect(await resolveTaxonomyCanonical('futbol',  'sport')).toBe('soccer');
    expect(await resolveTaxonomyCanonical('gridiron','sport')).toBe('american football');
  });
});

describe('getTaxonomyContext', () => {
  test('returns non-empty sorted sport + league lists from the seeded KB', async () => {
    if (!pgAvailable) return;
    const ctx = await getTaxonomyContext();
    expect(ctx.sports.length).toBeGreaterThan(10);
    expect(ctx.leagues.length).toBeGreaterThan(10);
    expect(ctx.sports).toContain('league of legends');
    expect(ctx.sports).toContain('basketball');
    expect(ctx.leagues.map((s) => s.toLowerCase())).toContain('nba');
    const sportsCopy = [...ctx.sports];
    sportsCopy.sort((a, b) => a.localeCompare(b));
    expect(ctx.sports).toEqual(sportsCopy);
    const leaguesCopy = [...ctx.leagues];
    leaguesCopy.sort((a, b) => a.localeCompare(b));
    expect(ctx.leagues).toEqual(leaguesCopy);
  });

  test('type scoping is enforced — no team / person leaks into sport list', async () => {
    if (!pgAvailable) return;
    const ctx = await getTaxonomyContext();
    for (const s of ctx.sports) {
      expect(s).not.toMatch(/,/);
      expect(s).not.toMatch(/\bFC\b|\bF\.C\.\b/);
    }
  });
});

describe('sportResolver/leagueResolver — LLM-driven level-1 KB expansion (formerly ensureTaxonomyEntity)', () => {
  test('returns existing canonical when the candidate or alias already exists', async () => {
    if (!pgAvailable) return;
    const result = await workerStyleTaxonomyCreate('lol', 'sport', ['LoL'], 'sports');
    expect(result).toBe('league of legends');
  });

  test('idempotent — calling twice with the same candidate is a no-op for KB', async () => {
    if (!pgAvailable) return;
    const novel = '__test_sport_novel_' + Date.now();
    try {
      const first  = await workerStyleTaxonomyCreate(novel, 'sport', ['alias1', 'alias2'], 'sports');
      const second = await workerStyleTaxonomyCreate(novel, 'sport', ['alias1', 'alias2', 'alias3'], 'sports');
      expect(first).toBe(novel);
      expect(second).toBe(novel);
      expect(await resolveTaxonomyCanonical(novel,      'sport')).toBe(novel);
      expect(await resolveTaxonomyCanonical('alias1',   'sport')).toBe(novel);
      expect(await resolveTaxonomyCanonical('alias2',   'sport')).toBe(novel);
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'sport'`, [novel]);
    }
  });

  test('new sport: NO parent_sport_canonical written (sports are level 1)', async () => {
    if (!pgAvailable) return;
    const novel = '__test_sport_orphan_check_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(novel, 'sport', ['ts'], 'sports');
      expect(created).toBe(novel);
      const rows = await query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM known_entities WHERE canonical = $1 AND type = 'sport'`,
        [novel],
      );
      expect(rows[0].metadata.kind).toBe('sport');
      expect(rows[0].metadata.sport_canonical).toBeUndefined();
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'sport'`, [novel]);
    }
  });

  test('new league inherits parent sport — the ATP/WTA-style hierarchy case', async () => {
    if (!pgAvailable) return;
    const novelLeague = '__test_league_atp_wta_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(
        novelLeague,
        'league',
        ['Test ATP', 'Test WTA', 'Test ATP/WTA Tour'],
        'sports',
        'tennis',
      );
      expect(created).toBe(novelLeague);

      const rows = await query<{ metadata: Record<string, unknown>; sport_canonical: string | null }>(
        `SELECT metadata, sport_canonical FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].metadata.sport_canonical).toBe('tennis');
      expect(rows[0].sport_canonical).toBe('tennis');

      expect(await resolveTaxonomyCanonical('Test ATP', 'league')).toBe(novelLeague);
      expect(await resolveTaxonomyCanonical(novelLeague, 'league')).toBe(novelLeague);

      expect(await resolveTaxonomyCanonical(novelLeague, 'sport')).toBeNull();
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });

  test('new league WITHOUT parent sport stays orphan (sport_canonical null)', async () => {
    if (!pgAvailable) return;
    const novelLeague = '__test_league_orphan_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(novelLeague, 'league', ['orph'], 'sports' /* no parent */);
      expect(created).toBe(novelLeague);
      const rows = await query<{ sport_canonical: string | null }>(
        `SELECT sport_canonical FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(rows[0].sport_canonical).toBeNull();
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });

  test('league inheritance: empty/whitespace parent treated as no parent', async () => {
    if (!pgAvailable) return;
    const novelLeague = '__test_league_blank_parent_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(novelLeague, 'league', ['bl'], 'sports', '   ');
      expect(created).toBe(novelLeague);
      const rows = await query<{ sport_canonical: string | null }>(
        `SELECT sport_canonical FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(rows[0].sport_canonical).toBeNull();
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });

  test('parent sport reference is trimmed before storage', async () => {
    if (!pgAvailable) return;
    const novelLeague = '__test_league_trimmed_parent_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(novelLeague, 'league', ['tr'], 'sports', '  tennis  ');
      expect(created).toBe(novelLeague);
      const rows = await query<{ sport_canonical: string | null }>(
        `SELECT sport_canonical FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(rows[0].sport_canonical).toBe('tennis');
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });

  test('auto-extending KB: zero aliases is fine — level-1 row still created', async () => {
    if (!pgAvailable) return;
    const novelLeague = '__test_league_no_aliases_' + Date.now();
    try {
      const created = await workerStyleTaxonomyCreate(novelLeague, 'league', [], 'sports', 'soccer');
      expect(created).toBe(novelLeague);
      expect(await resolveTaxonomyCanonical(novelLeague, 'league')).toBe(novelLeague);
      const rows = await query<{ sport_canonical: string | null; aliases: string }>(
        `SELECT sport_canonical, aliases::text FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(rows[0].sport_canonical).toBe('soccer');
      expect(JSON.parse(rows[0].aliases)).toEqual([]);
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });

  test('auto-extending KB: second call returns existing canonical (idempotent, no duplicates)', async () => {
    if (!pgAvailable) return;
    // Alias-accretion across separate enrichment batches is a deliberate non-feature.
    const novelLeague = '__test_league_idempotent_' + Date.now();
    try {
      const a = await workerStyleTaxonomyCreate(novelLeague, 'league', ['SLN'], 'sports', 'soccer');
      const b = await workerStyleTaxonomyCreate(novelLeague, 'league', ['Super League N'], 'sports', 'soccer');
      expect(a).toBe(novelLeague);
      expect(b).toBe(novelLeague);
      const rows = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM known_entities WHERE canonical = $1 AND type = 'league'`,
        [novelLeague],
      );
      expect(Number(rows[0].n)).toBe(1);
    } finally {
      await query(`DELETE FROM known_entities WHERE canonical = $1 AND type = 'league'`, [novelLeague]);
    }
  });
});

describe('prompt template — taxonomy context is rendered as expected', () => {
  test('user-template.md contains the known_sports / known_leagues blocks', async () => {
    const { loadPromptTemplate } = await import('@arb/llm');
    const tpl = loadPromptTemplate('entity_enrichment');
    expect(tpl.userTemplate).toContain('known_sports');
    expect(tpl.userTemplate).toContain('known_leagues');
    expect(tpl.userTemplate).toContain('use these exact strings');
  });

  test('system.md mandates parent sport when proposing a new league', async () => {
    const { loadPromptTemplate } = await import('@arb/llm');
    const tpl = loadPromptTemplate('entity_enrichment');
    expect(tpl.systemPrompt).toContain('new_league_aliases');
    expect(tpl.systemPrompt).toContain('CRITICAL');
    expect(tpl.systemPrompt).toContain('sport_canonical');
    expect(tpl.systemPrompt).toMatch(/domain_category\s*→\s*sport\s*→\s*league\s*→\s*team/);
  });

  test('system.md teaches re-classification: Rugby/Cricket/Sumo are sports, not leagues', async () => {
    const { loadPromptTemplate } = await import('@arb/llm');
    const tpl = loadPromptTemplate('entity_enrichment');
    expect(tpl.systemPrompt).toMatch(/Rugby\b.*sport/i);
    expect(tpl.systemPrompt).toMatch(/Cricket\b.*sport/i);
    expect(tpl.systemPrompt).toMatch(/Sumo\b.*sport/i);
    expect(tpl.systemPrompt).toMatch(/FIFA World Cup.*competition/i);
  });

  test('system.md flags the football/american-football ambiguity', async () => {
    const { loadPromptTemplate } = await import('@arb/llm');
    const tpl = loadPromptTemplate('entity_enrichment');
    expect(tpl.systemPrompt).toMatch(/football.*ambiguous/i);
    expect(tpl.systemPrompt).toMatch(/american football/i);
    expect(tpl.systemPrompt).toContain('soccer');
    expect(tpl.systemPrompt).toMatch(/sport_hint|sample_titles/i);
  });

  test('runtime schema includes new_sport_aliases and new_league_aliases (the canonical source the LLM sees)', async () => {
    // Asserts on RUNTIME_SCHEMAS (not schema.json on disk) so it catches drift even when
    // the on-disk JSON is stale.
    const { RUNTIME_SCHEMAS } = await import('@arb/llm');
    type SchemaShape = {
      properties: {
        entities: {
          items: {
            properties: Record<string, { description?: string }>;
          };
        };
      };
    };
    const schema = RUNTIME_SCHEMAS.entity_enrichment as unknown as SchemaShape;
    const schemaProps = schema.properties.entities.items.properties;
    expect(schemaProps.new_sport_aliases).toBeDefined();
    expect(schemaProps.new_league_aliases).toBeDefined();
    expect(schemaProps.new_league_aliases.description).toMatch(/sport_canonical MUST also be set/i);
  });
});
