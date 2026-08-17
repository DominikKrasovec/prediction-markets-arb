/**
 * Snapshot test for the entity-enrichment LLM prompt rendering.
 *
 * Drives `buildEnrichmentPromptVars()` + Mustache through a fixed input
 * and asserts on the EXACT output string. The lock so that any change
 * to the prompt-rendering pipeline (added field, dropped field, changed
 * formatting, reordered output) becomes a deliberate, auditable diff
 * rather than a silent shift in what the LLM sees.
 *
 * When we extend the prompt with new context fields in Step 3a (route
 * platform signals through) and Step 3b (sample_descriptions,
 * co_entities), THIS test is the file that proves the changes landed
 * the way we intended.
 *
 * Inputs are crafted to be minimal but exercise every template branch:
 *   - empty sample_titles list (renders empty section, no orphan dashes)
 *   - non-empty sample_titles list (renders with bullet)
 *   - null sport_hint (renders literal `null`)
 *   - non-null sport_hint (renders as quoted string)
 *   - empty aliases list (renders as `[]` JSON)
 *   - multiple aliases (renders as JSON array with proper escaping)
 *
 * Pure unit test — no DB or LLM required, runs in any environment.
 */
import { describe, test, expect } from 'bun:test';
import { renderPrompt, loadPromptTemplate } from '@arb/llm';
import { buildEnrichmentPromptVars, type EntityRow } from './worker.js';
import type { EntityClassification } from './entity-heuristic.js';

/** Stub EntityRow factory — only the fields buildEnrichmentPromptVars reads. */
function row(over: Partial<EntityRow> & Pick<EntityRow, 'id' | 'canonical' | 'type'>): EntityRow {
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
    ...over,
  };
}

/**
 * Normalize line endings to `\n` before snapshot comparison.
 *
 * The prompt template (packages/llm/prompts/entity_enrichment/user-template.md)
 * is committed LF, but on a Windows checkout with autocrlf the working-tree
 * copy is CRLF, so the rendered string carries a trailing `\r` on every line.
 * EXPECTED below is built with `.join('\n')`. Comparing raw would fail on
 * Windows (CRLF render vs LF expected) while passing on Linux/CI (LF both) —
 * a platform-dependent snapshot. Normalizing both sides makes the snapshot
 * assert the same logical content everywhere; the per-line/section structure
 * is still locked exactly. (`\r` alone, if it ever appeared, also collapses to
 * `\n` — harmless here since the template has no bare-CR content.)
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function classification(over: Partial<EntityClassification> = {}): EntityClassification {
  return {
    entity_type: 'person',
    sport_canonical: null,
    league_canonical: null,
    notes: [],
    ...over,
  };
}

const FIXED_TAXONOMY = {
  sports: ['basketball', 'soccer', 'cs2'],
  leagues: ['NBA', 'Premier League', 'CS2 Major'],
};

describe('buildEnrichmentPromptVars — pure transform shape', () => {
  test('empty contexts → count=0, empty entities array, taxonomy still rendered', () => {
    const vars = buildEnrichmentPromptVars([], FIXED_TAXONOMY);
    expect(vars).toEqual({
      count: 0,
      known_sports: FIXED_TAXONOMY.sports,
      known_leagues: FIXED_TAXONOMY.leagues,
      entities: [],
    });
  });

  test('single context renders index=1, populated fields', () => {
    const vars = buildEnrichmentPromptVars([
      {
        row: row({ id: 1, canonical: 'Desmond Bane', type: 'person', aliases: ['DES'], sample_titles: ['Will DES record 2+ threes tonight?'] }),
        classification: classification({ entity_type: 'person', sport_canonical: 'basketball' }),
      },
    ], FIXED_TAXONOMY);
    expect((vars.entities as unknown[]).length).toBe(1);
    const e = (vars.entities as Record<string, unknown>[])[0];
    expect(e.index).toBe(1);
    expect(e.canonical_now).toBe('Desmond Bane');
    expect(e.aliases_json).toBe('["DES"]');
    expect(e.domain_category).toBe('sports');
    expect(e.type_hint).toBe('person');
    expect(e.sport_hint_or_null).toBe('"basketball"');
    expect(e.sample_titles).toEqual(['Will DES record 2+ threes tonight?']);
  });

  test('null sport_canonical renders literal `null` (not quoted)', () => {
    const vars = buildEnrichmentPromptVars([
      {
        row: row({ id: 1, canonical: 'Whatever', type: 'person' }),
        classification: classification({ sport_canonical: null }),
      },
    ], FIXED_TAXONOMY);
    expect((vars.entities as Record<string, unknown>[])[0].sport_hint_or_null).toBe('null');
  });

  test('aliases serialised as JSON — preserves order, escapes special chars', () => {
    const vars = buildEnrichmentPromptVars([
      {
        row: row({ id: 1, canonical: 'X', type: 'person', aliases: ['First', 'with "quotes"', 'with\\backslash'] }),
        classification: classification(),
      },
    ], FIXED_TAXONOMY);
    const aliases = (vars.entities as Record<string, unknown>[])[0].aliases_json as string;
    expect(JSON.parse(aliases)).toEqual(['First', 'with "quotes"', 'with\\backslash']);
  });

  test('multiple contexts get sequential indices starting at 1', () => {
    const vars = buildEnrichmentPromptVars([
      { row: row({ id: 1, canonical: 'A', type: 'person' }), classification: classification() },
      { row: row({ id: 2, canonical: 'B', type: 'team' }), classification: classification({ entity_type: 'team' }) },
      { row: row({ id: 3, canonical: 'C', type: 'asset' }), classification: classification({ entity_type: 'asset' }) },
    ], FIXED_TAXONOMY);
    const entities = vars.entities as Record<string, unknown>[];
    expect(entities.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(entities.map((e) => e.canonical_now)).toEqual(['A', 'B', 'C']);
  });
});

describe('rendered prompt — exact snapshot of current shape', () => {
  // Fixed input that exercises every template branch. Whenever this snapshot
  // changes, the diff IS the audit trail for what we changed in the prompt.
  const tpl = loadPromptTemplate('entity_enrichment');
  const fixedContexts = [
    {
      row: row({
        id: 10,
        canonical: 'Desmond Bane',
        type: 'person',
        aliases: ['DES', 'Bane'],
        sample_titles: [
          'Will DES record 2+ threes tonight?',
          'Desmond Bane points 15.5 over/under',
        ],
        // Platform signals — loaded by loadEntities() but NOT YET piped to the
        // prompt. Step 3a will route these through. Until then, they're inert.
        tag_slugs: ['nba', 'basketball'],
        limitless_sport: 'Basketball',
        limitless_league: 'NBA',
        kalshi_ticker_prefix: 'KXNBA',
        predict_tag_names: ['Basketball', 'NBA'],
      }),
      classification: classification({ entity_type: 'person', sport_canonical: 'basketball' }),
    },
    {
      row: row({
        id: 11,
        canonical: 'IEM Atlanta',
        type: 'competition',
        aliases: [],
        sample_titles: ['Will FaZe Clan win IEM Atlanta?'],
        tag_slugs: ['cs2', 'esports', 'iem'],
      }),
      classification: classification({ entity_type: 'event_name', sport_canonical: 'cs2' }),
    },
    {
      row: row({
        id: 12,
        canonical: 'Mystery Entity',
        type: 'unknown',
        aliases: ['mystery'],
        sample_titles: [],
      }),
      classification: classification({ entity_type: 'unknown', sport_canonical: null }),
    },
  ];

  const vars = buildEnrichmentPromptVars(fixedContexts, FIXED_TAXONOMY);
  const rendered = renderPrompt(tpl.userTemplate, vars);

  test('snapshot — exact rendered output (post platform-signals routing)', () => {
    // History of this snapshot across the unification refactor:
    //   v1 (baseline)     — HTML-escape bug captured (&quot;, &#x2F;)
    //   v2 (HTML fix)     — clean quotes/slashes via {{{var}}}
    //   v3 (this version) — platform_signals block added per entity
    //
    // platform_signals routing semantics per-entity:
    //   - polymarket_tags        — emitted iff tag_slugs is non-empty
    //   - limitless_sport        — emitted iff non-null
    //   - limitless_league       — emitted iff non-null
    //   - kalshi_ticker_prefix   — emitted iff non-null
    //   - predict_tags           — emitted iff non-empty
    // The "platform_signals:" heading is rendered iff at least one signal
    // for that entity is present — so a single-platform entity doesn't
    // see a misleading empty section, and entity 3 (no platform data
    // anywhere) gets no heading at all.
    const EXPECTED = [
      '## KB taxonomy (use these exact strings when applicable)',
      '',
      'known_sports:',
      '  - "basketball"',
      '  - "soccer"',
      '  - "cs2"',
      '',
      'known_leagues:',
      '  - "NBA"',
      '  - "Premier League"',
      '  - "CS2 Major"',
      '',
      '---',
      '',
      'Enrich the following entities. Return one JSON object per entity in the SAME ORDER, wrapped in `{ "entities": [ ... ] }`.',
      '',
      '---',
      'ENTITY 1:',
      '- canonical_now: "Desmond Bane"',
      '- aliases_now: ["DES","Bane"]',
      '- domain_category: "sports"',
      '- type_hint: "person"',
      '- sport_hint: "basketball"',
      '- sample_titles:',
      '  - "Will DES record 2+ threes tonight?"',
      '  - "Desmond Bane points 15.5 over/under"',
      '- platform_signals:',
      '  - polymarket_tags: ["nba","basketball"]',
      '  - limitless_sport: Basketball',
      '  - limitless_league: NBA',
      '  - kalshi_ticker_prefix: KXNBA',
      '  - predict_tags: ["Basketball","NBA"]',
      '',
      '---',
      'ENTITY 2:',
      '- canonical_now: "IEM Atlanta"',
      '- aliases_now: []',
      '- domain_category: "sports"',
      '- type_hint: "event_name"',
      '- sport_hint: "cs2"',
      '- sample_titles:',
      '  - "Will FaZe Clan win IEM Atlanta?"',
      '- platform_signals:',
      '  - polymarket_tags: ["cs2","esports","iem"]',
      '',
      '---',
      'ENTITY 3:',
      '- canonical_now: "Mystery Entity"',
      '- aliases_now: ["mystery"]',
      '- domain_category: "sports"',
      '- type_hint: "unknown"',
      '- sport_hint: null',
      '- sample_titles:',
      '',
      '',
    ].join('\n');
    // Newline-robust: normalize CRLF/LF on both sides so the snapshot holds on
    // a Windows (autocrlf → CRLF working tree) checkout AND on Linux/CI (LF).
    expect(normalizeNewlines(rendered)).toBe(normalizeNewlines(EXPECTED));
  });

  test('platform-signals section is omitted for entities with no platform data', () => {
    // Regression guard: an entity with all signals null/empty must not
    // render an orphan "- platform_signals:" heading. Entity 3 in the
    // main snapshot already exercises this; this is an isolated check.
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({ id: 99, canonical: 'Solo', type: 'person' }),  // all platform fields default null/empty
          classification: classification(),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).not.toContain('- platform_signals:');
    expect(out).not.toContain('polymarket_tags');
    expect(out).not.toContain('limitless');
    expect(out).not.toContain('kalshi');
    expect(out).not.toContain('predict_tags');
  });

  test('platform-signals: each signal type rendered independently when present', () => {
    // Each signal source can be present independently — verify the
    // template doesn't accidentally couple them (e.g. only render
    // polymarket_tags if limitless_sport is also set).
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({
            id: 1, canonical: 'Limitless-only', type: 'team',
            limitless_sport: 'Counter-Strike 2', limitless_league: 'CS2 Major',
            // tag_slugs, kalshi_ticker_prefix, predict_tag_names all default null/empty
          }),
          classification: classification({ entity_type: 'team' }),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).toContain('- platform_signals:');
    expect(out).toContain('  - limitless_sport: Counter-Strike 2');
    expect(out).toContain('  - limitless_league: CS2 Major');
    expect(out).not.toContain('polymarket_tags');
    expect(out).not.toContain('kalshi_ticker_prefix');
    expect(out).not.toContain('predict_tags');
  });

  test('special chars in canonical / sample titles render verbatim (not HTML-escaped)', () => {
    // Regression guard for the HTML-escape class of bug. If any future
    // template change swaps {{{var}}} back to {{var}}, an entity with
    // "/" or "&" in its canonical would surface it here, well before
    // hitting a real LLM call.
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({
            id: 1, canonical: 'ATP/WTA Tour', type: 'league',
            sample_titles: ['Tom & Jerry: who "wins" the chase?'],
          }),
          classification: classification({ entity_type: 'league', sport_canonical: 'tennis' }),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).toContain('- canonical_now: "ATP/WTA Tour"');
    expect(out).toContain('Tom & Jerry: who "wins" the chase?');
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&quot;');
    expect(out).not.toContain('&#x2F;');
  });

  test('rendered prompt — sample_descriptions section appears when descriptions are present', () => {
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({
            id: 1, canonical: 'DES', type: 'person',
            sample_titles: ['Will DES record 2+ threes tonight?'],
            sample_descriptions: [
              'If Desmond Bane records 2+ three-pointers in the Memphis Grizzlies vs Lakers game scheduled for May 14',
            ],
          }),
          classification: classification({ entity_type: 'person', sport_canonical: 'basketball' }),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).toContain('- sample_descriptions:');
    expect(out).toContain('  - "If Desmond Bane records 2+ three-pointers in the Memphis Grizzlies vs Lakers game scheduled for May 14"');
  });

  test('rendered prompt — sample_descriptions section omitted when empty', () => {
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({ id: 1, canonical: 'X', type: 'person' /* no sample_descriptions */ }),
          classification: classification(),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).not.toContain('sample_descriptions');
  });

  test('rendered prompt — co_entities section appears with canonical + type pairs', () => {
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({
            id: 1, canonical: 'DES', type: 'person',
            co_entities: [
              { canonical: 'Memphis Grizzlies', type: 'team' },
              { canonical: 'NBA', type: 'league' },
              { canonical: 'Dallas Mavericks', type: 'team' },
            ],
          }),
          classification: classification({ entity_type: 'person' }),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).toContain('- co_entities (most-frequent enriched neighbours):');
    expect(out).toContain('  - "Memphis Grizzlies" (team)');
    expect(out).toContain('  - "NBA" (league)');
    expect(out).toContain('  - "Dallas Mavericks" (team)');
  });

  test('rendered prompt — co_entities section omitted when empty', () => {
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({ id: 1, canonical: 'X', type: 'person' /* no co_entities */ }),
          classification: classification(),
        },
      ],
      FIXED_TAXONOMY,
    ));
    expect(out).not.toContain('co_entities');
  });

  test('rendered prompt — sections appear in stable order: titles, descriptions, signals, co_entities', () => {
    // Entity with all four optional blocks populated — verify order is
    // stable so the LLM sees signals in the same arrangement every time.
    const out = renderPrompt(tpl.userTemplate, buildEnrichmentPromptVars(
      [
        {
          row: row({
            id: 1, canonical: 'IEM Atlanta', type: 'competition',
            sample_titles: ['Will FaZe Clan win IEM Atlanta?'],
            sample_descriptions: ['Intel Extreme Masters Atlanta is a CS2 tournament featuring 16 teams.'],
            tag_slugs: ['cs2', 'iem'],
            co_entities: [
              { canonical: 'FaZe Clan', type: 'team' },
              { canonical: 'G2 Esports', type: 'team' },
            ],
          }),
          classification: classification({ entity_type: 'event_name', sport_canonical: 'cs2' }),
        },
      ],
      FIXED_TAXONOMY,
    ));
    const titlesIdx = out.indexOf('sample_titles:');
    const descsIdx = out.indexOf('sample_descriptions:');
    const signalsIdx = out.indexOf('platform_signals:');
    const coIdx = out.indexOf('co_entities');
    expect(titlesIdx).toBeGreaterThan(0);
    expect(descsIdx).toBeGreaterThan(titlesIdx);
    expect(signalsIdx).toBeGreaterThan(descsIdx);
    expect(coIdx).toBeGreaterThan(signalsIdx);
  });

  test('rendered prompt now surfaces platform-signal labels — Step 3a marker', () => {
    // The inverse of the previous baseline guard. Once platform signals
    // are routed through, these labels should be present whenever the
    // entity has the corresponding data. The main snapshot already
    // covers shape exhaustively; this is a minimal presence check that
    // would catch a regression where someone reverted the routing.
    expect(rendered).toContain('platform_signals');
    expect(rendered).toContain('polymarket_tags');
    expect(rendered).toContain('limitless_sport');
    expect(rendered).toContain('limitless_league');
    expect(rendered).toContain('kalshi_ticker_prefix');
    expect(rendered).toContain('predict_tags');
  });
});
