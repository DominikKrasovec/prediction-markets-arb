/**
 * Runtime JSON Schema definitions for LLM structured-output prompts.
 *
 * Schemas are built directly from the canonical TypeScript const arrays in
 * @arb/types so they can never drift from the source of truth — no separate
 * build:schemas step required.
 *
 * prompt-loader.ts prefers these over any schema.json file on disk.
 */
import {
  UNIFIED_CATEGORIES,
  ENTITY_TYPES,
  OUTCOME_SPACES,
  EVENT_KINDS,
  CONDITION_SHAPES,
  CONDITION_DIRECTIONS,
  CONDITION_METRICS,
  TEMPORAL_SEMANTICS,
  HIERARCHY_TYPES,
} from '@arb/types';

function nullableEnum(values: readonly string[]): Record<string, unknown> {
  return { anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] };
}

const extractionItem = {
  type: 'object',
  properties: {
    index: { type: 'integer' },

    canonical_entities: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    },
    entity_types: {
      type: 'object',
      additionalProperties: { type: 'string', enum: [...ENTITY_TYPES] },
    },
    entity_aliases: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 5,
      },
    },

    dates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          date: { type: 'string' },
          type: { type: 'string', enum: ['deadline', 'event', 'resolution'] },
        },
        required: ['label', 'date', 'type'],
      },
    },

    category_unified: {
      type: 'string',
      enum: [...UNIFIED_CATEGORIES],
      description:
        'Broad cross-platform category. Confirm or override the categoryHint input field based on market content.',
    },

    keywords: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 15,
    },

    outcome_space: { type: 'string', enum: [...OUTCOME_SPACES] },
    resolution_source: { type: 'string' },

    hierarchy_type: { ...nullableEnum([...HIERARCHY_TYPES]) },
    hierarchy_level: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    hierarchy_series: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    hierarchy_value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    hierarchy_direction: { ...nullableEnum(['ascending', 'descending']) },

    condition_shape: { ...nullableEnum([...CONDITION_SHAPES]) },
    condition_direction: { ...nullableEnum([...CONDITION_DIRECTIONS]) },
    condition_metric: { ...nullableEnum([...CONDITION_METRICS]) },
    temporal_semantics: { ...nullableEnum([...TEMPORAL_SEMANTICS]) },

    value_primary: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    value_secondary: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    value_unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },

    participants: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 8,
      description:
        'Sorted, deduped canonical names of the entities whose outcome/state determines resolution. ' +
        'For H2H games include BOTH teams (e.g., ["HOU","LAL"]). ' +
        'The primary canonical entity (first of canonical_entities) MUST appear here.',
    },

    canonical_event: {
      type: 'string',
      description:
        'Short lowercase phrase (3–8 words) describing the core predicate being predicted. ' +
        'Different thresholds of the same condition share the same value.',
    },

    league_text: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'Sports league/competition that frames the market (e.g. "NBA", "Premier League", "Champions League"). Null for non-sports.',
    },

    event_kind: {
      ...nullableEnum([...EVENT_KINDS]),
      description: 'Fine-grained event type classification.',
    },

    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Extraction quality: 0.9+ for unambiguous, 0.7–0.9 with minor interpretation, <0.6 for highly ambiguous.',
    },
  },
  required: [
    'index',
    'canonical_entities',
    'entity_types',
    'dates',
    'category_unified',
    'keywords',
    'outcome_space',
    'resolution_source',
    'hierarchy_type',
    'condition_shape',
    'condition_direction',
    'condition_metric',
    'temporal_semantics',
    'participants',
    'canonical_event',
    'event_kind',
    'confidence',
  ],
};

const relationshipEnum = [
  'equivalent',
  'strict_implication_AtoB',
  'strict_implication_BtoA',
  'conditional',
  'mutual_exclusion',
  'independent',
];

export const RUNTIME_SCHEMAS: Record<string, Record<string, unknown>> = {
  extraction: {
    type: 'object',
    properties: {
      markets: { type: 'array', items: extractionItem },
    },
    required: ['markets'],
  },

  implication: {
    type: 'object',
    properties: {
      relationship: { type: 'string', enum: relationshipEnum },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string' },
    },
    required: ['relationship', 'confidence', 'reasoning'],
  },

  'implication-cluster': {
    type: 'object',
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            q1_id: { type: 'integer' },
            q2_id: { type: 'integer' },
            relationship: { type: 'string', enum: relationshipEnum },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string' },
          },
          required: ['q1_id', 'q2_id', 'relationship', 'confidence', 'reasoning'],
        },
      },
    },
    required: ['pairs'],
  },

  entity_enrichment: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            canonical_corrected: { type: 'string' },
            type: { type: 'string', enum: [...ENTITY_TYPES] },
            aliases: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object' },
            new_sport_aliases: {
              type: 'array',
              items: { type: 'string' },
              description: "OPTIONAL. Emit ONLY when metadata.sport_canonical is a value not in known_sports. 2-5 alternate spellings the worker registers as aliases on a new level-1 'sport' entity. Sports have no parent in the hierarchy (their parent is the entity's domain_category, already known) so no extra context fields are needed.",
            },
            new_league_aliases: {
              type: 'array',
              items: { type: 'string' },
              description: "OPTIONAL. Emit ONLY when metadata.league_canonical is a value not in known_leagues. 2-5 alternate spellings registered as aliases on a new level-1 'league' entity. REQUIREMENT: metadata.sport_canonical MUST also be set when this is emitted — the new league row inherits sport_canonical so the KB hierarchy domain → sport → league stays connected. Tennis example (tour-SPLIT — never the fused 'ATP/WTA', the tours are separate non-mutex leagues): metadata={league_canonical:'ATP Tour', sport_canonical:'tennis'}, new_league_aliases=['ATP','atp tour']; WTA entities use the separate 'WTA Tour' league, and when the tour is unknown OMIT league_canonical.",
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            notes: { type: 'string' },
          },
          required: ['canonical_corrected', 'type', 'aliases', 'metadata', 'confidence'],
        },
      },
    },
    required: ['entities'],
  },
};
