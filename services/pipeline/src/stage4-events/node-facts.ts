/**
 * Shared "node-facts" CTE for the cross-question edge rules, so every rule and
 * sameEventFragment read an identical, correctly-sourced shape.
 * canonical_event/event_kind come from `questions` (platform_events.canonical_event
 * is always NULL); the TIMESTAMPTZ date/precision and sport/league come from
 * `platform_events` (questions.condition_date is TEXT, no sport/league there).
 * Keep the exposed columns in sync with what sameEventFragment(a,b) requires.
 */
export const NODE_FACTS_COLUMNS = [
  'question_id',
  'platform_event_id',
  'title',
  'sport',
  'league',
  'condition_date',
  'condition_date_precision',
  'fixture_end_date',
  'canonical_event',
  'canonical_subject',
  'event_kind',
  'condition_direction',
  'condition_metric',
  'condition_shape',
  'value_primary',
  'value_secondary',
  'value_unit',
  'participants',
  'resolution_scope',
  'metric_scope',
  'discriminators',
  'platform',
] as const;

/** Reference twice (one alias per side). Rep-member pick is the lowest market_id; joins platform_events on the TEXT natural key, not platform_events.id. */
export function nodeFactsCte(): string {
  return `node_facts AS (
    SELECT
      q.id                          AS question_id,
      rm.platform_event_id          AS platform_event_id,   -- markets (rep member); TEXT
      rm.title                      AS title,               -- markets (rep member)
      rm.end_date                   AS fixture_end_date,    -- markets (rep member; reliable per-leg fixture date)
      pe.sport_canonical            AS sport,               -- platform_events
      pe.league_canonical           AS league,              -- platform_events
      pe.condition_date             AS condition_date,      -- platform_events (TIMESTAMPTZ)
      pe.condition_date_precision   AS condition_date_precision, -- platform_events
      q.canonical_event             AS canonical_event,     -- questions (pe.canonical_event is 100% NULL)
      q.canonical_subject           AS canonical_subject,   -- questions
      q.event_kind                  AS event_kind,          -- questions
      q.condition_direction         AS condition_direction, -- questions
      q.condition_metric            AS condition_metric,    -- questions
      q.condition_shape             AS condition_shape,     -- questions
      q.value_primary               AS value_primary,       -- questions
      q.value_secondary             AS value_secondary,     -- questions
      q.value_unit                  AS value_unit,          -- questions
      q.participants                AS participants,        -- questions (sorted, deduped TEXT[])
      q.resolution_scope            AS resolution_scope,    -- questions (mixed→NULL)
      q.metric_scope                AS metric_scope,        -- questions (mixed→NULL)
      q.discriminators              AS discriminators,      -- questions (rep_disc consensus rollup)
      rm.platform                   AS platform             -- markets (rep member)
    FROM questions q
    JOIN LATERAL (
      -- deterministic representative member market (lowest market_id)
      SELECT m.platform, m.platform_event_id, m.title, m.end_date
      FROM question_members qm
      JOIN markets m ON m.id = qm.market_id
      WHERE qm.question_id = q.id
      ORDER BY m.id
      LIMIT 1
    ) rm ON TRUE
    LEFT JOIN platform_events pe
           ON pe.platform = rm.platform
          AND pe.platform_event_id = rm.platform_event_id   -- TEXT natural key, NOT pe.id
    WHERE q.archived_at IS NULL
  )`;
}
