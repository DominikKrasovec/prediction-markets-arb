/**
 * Centralized queries for `platform_events` table.
 *
 * Platform events are the "parent" grouping of related markets on a single
 * platform.  The LLM extracts semantic fields ONCE per event; child markets
 * inherit canonical_subject / canonical_event / participants from here.
 */
import { query } from '@arb/db';
import type { GroupingType } from '../market-normalizer.js';

interface PlatformEvent {
  id: number;
  platform: string;
  platform_event_id: string;
  grouping_type: GroupingType;
  title: string;
  resolution_source: string | null;
  deadline: string | null;
  unit: string | null;
  canonical_subject: string | null;
  canonical_event: string | null;
  participants: string[];
  child_count: number;
  llm_normalized: boolean;
}

// Upsert (called by sync after all children are written)

/**
 * Refresh the platform_events row for a single event group.
 *
 * Call this immediately after upsertMarket() for any market that has a
 * non-null platform_event_id — this is the incremental equivalent of the
 * bulk populatePlatformEvents() that runSync() calls.  It ensures Stage 1's
 * getUnnormalizedEvents() sees the event before per-market Stage 1 runs.
 *
 * Safe to call multiple times (idempotent).  llm_normalized is NOT reset on
 * conflict so re-triggering for an already-processed event is harmless.
 */
export async function refreshPlatformEventGroup(
  platform: string,
  platformEventId: string,
): Promise<void> {
  await query(
    `INSERT INTO platform_events
       (platform, platform_event_id, grouping_type, title, child_count)
     SELECT
       m.platform,
       m.platform_event_id,
       COALESCE(m.grouping_type, 'unknown') AS grouping_type,
       COALESCE(
         MAX(ke.raw->>'title'),
         MAX(pe_raw.raw->>'title'),
         MIN(m.title)
       ) AS title,
       COUNT(*) AS child_count
     FROM markets m
     LEFT JOIN kalshi_events ke
       ON m.platform = 'kalshi'
      AND m.platform_event_id = 'kalshi:event:' || ke.event_ticker
     LEFT JOIN polymarket_events pe_raw
       ON m.platform = 'polymarket'
      AND m.platform_event_id = pe_raw.id
     WHERE m.platform = $1
       AND m.platform_event_id = $2
     GROUP BY m.platform, m.platform_event_id, m.grouping_type
     ON CONFLICT (platform, platform_event_id) DO UPDATE SET
       child_count   = EXCLUDED.child_count,
       grouping_type = EXCLUDED.grouping_type,
       title         = COALESCE(EXCLUDED.title, platform_events.title),
       updated_at    = NOW()`,
    [platform, platformEventId]
  );
}

// LLM normalization reads

/**
 * Returns events that need LLM normalization. An event is considered to need
 * normalization in any of these three cases:
 *
 *   1. `llm_normalized = FALSE`           — never processed
 *   2. `last_normalized_child_count IS NULL` — legacy row pre-migration
 *   3. `child_count > last_normalized_child_count` — late-arriving siblings
 *      have joined the event since the last normalization run, so the
 *      cached canonical_subject / participants need to be re-derived from
 *      the now-larger child set.
 *
 * `bundle_nonexclusive` events are processed too: many sibling Yes/No legs
 * of the same event still share a canonical subject (e.g. Polymarket binary
 * bundles created via WSS), and Stage 1b's prompt is robust to "no shared
 * structure" (it simply produces a generic event with no participants).
 */
export async function getUnnormalizedEvents(limit: number): Promise<
  (PlatformEvent & { market_titles: string[] })[]
> {
  return query<PlatformEvent & { market_titles: string[] }>(
    `SELECT pe.*,
            ARRAY_AGG(m.title ORDER BY m.id) AS market_titles
     FROM platform_events pe
     JOIN markets m ON m.platform = pe.platform
                   AND m.platform_event_id = pe.platform_event_id
     WHERE (pe.llm_normalized = FALSE
            OR pe.last_normalized_child_count IS NULL
            OR pe.child_count > pe.last_normalized_child_count)
     GROUP BY pe.id
     ORDER BY pe.id
     LIMIT $1`,
    [limit]
  );
}

/**
 * Write the semantic fields extracted from the LLM back to the event row.
 *
 * Records the current `child_count` into `last_normalized_child_count` so
 * `getUnnormalizedEvents` can detect when late-arriving children push the
 * count higher and re-queue the event. This is what closes the loop on the
 * WSS-created-market path: a brand-new market joins the event, the
 * post-write `refreshPlatformEventGroup` bumps `child_count`, and the next
 * Stage 1b cycle picks the event back up automatically.
 */
export async function markEventNormalized(
  id: number,
  canonical_subject: string,
  canonical_event: string,
  participants: string[],
): Promise<void> {
  await query(
    `UPDATE platform_events
     SET canonical_subject = $2,
         canonical_event   = $3,
         participants      = $4,
         llm_normalized    = TRUE,
         last_normalized_child_count = child_count,
         updated_at        = NOW()
     WHERE id = $1`,
    [id, canonical_subject, canonical_event, participants]
  );
}

// Child market helpers

/**
 * Returns all market IDs that belong to a given event, ordered by their
 * platform-provided numeric threshold ascending (nulls last) so the zipper
 * can walk them in order.
 */
export async function getEventChildMarkets(
  platform: string,
  platform_event_id: string,
): Promise<{ market_id: number; value_primary: number | null; condition_date: string | null }[]> {
  return query<{ market_id: number; value_primary: number | null; condition_date: string | null }>(
    `SELECT m.id AS market_id,
            n.value_primary,
            n.condition_date
     FROM markets m
     LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE m.platform = $1
       AND m.platform_event_id = $2
     ORDER BY n.value_primary ASC NULLS LAST, m.id`,
    [platform, platform_event_id]
  );
}

// Cross-platform zipper queries

/**
 * Returns pairs of platform_events from DIFFERENT platforms that share:
 *   - identical KB-resolved canonical_subject
 *   - identical grouping_type (threshold_series ↔ threshold_series, etc.)
 *   - both llm_normalized = TRUE
 *   - deadlines within 7 days of each other (prevents pairing different time-periods)
 *
 * Consumers use these pairs to generate deterministic cross-platform edges
 * without going through the LLM.
 *
 * Pairs are returned in canonical order (platform_a < platform_b alphabetically)
 * to avoid duplicate (a,b) and (b,a) rows.
 */
interface MatchedEventPair {
  event_a_id: number;
  event_b_id: number;
  platform_a: string;
  platform_b: string;
  event_a_ext_id: string;
  event_b_ext_id: string;
  grouping_type: GroupingType;
  canonical_subject: string;
  unit_a: string | null;
  unit_b: string | null;
  child_count_a: number;
  child_count_b: number;
}

export async function getMatchedEventPairs(): Promise<MatchedEventPair[]> {
  return query<MatchedEventPair>(
    `SELECT
       a.id                  AS event_a_id,
       b.id                  AS event_b_id,
       a.platform            AS platform_a,
       b.platform            AS platform_b,
       a.platform_event_id   AS event_a_ext_id,
       b.platform_event_id   AS event_b_ext_id,
       a.grouping_type,
       a.canonical_subject,
       a.unit                AS unit_a,
       b.unit                AS unit_b,
       a.child_count         AS child_count_a,
       b.child_count         AS child_count_b
     FROM platform_events a
     JOIN platform_events b
       ON  b.canonical_subject = a.canonical_subject
       AND b.platform          > a.platform
       AND b.grouping_type     = a.grouping_type
       AND b.llm_normalized    = TRUE
       AND (
             a.deadline IS NULL
          OR b.deadline IS NULL
          OR ABS(a.deadline - b.deadline) <= 7
       )
     WHERE a.llm_normalized = TRUE
       AND a.grouping_type IN ('threshold_series', 'categorical_exclusive')
       AND a.canonical_subject IS NOT NULL`,
    []
  );
}

/**
 * Returns question-level data for every child market of a given event.
 *
 * The zipper uses this to walk children sorted by value_primary (threshold
 * series) or aligned by canonical_subject (categorical).  One row per
 * distinct question — when multiple member markets share a question the row
 * with the most-populated normalization is returned (same ordering as
 * loadConditionCards).
 */
export interface EventChildQuestion {
  question_id: number;
  value_primary: number | null;
  condition_direction: string | null;
  condition_metric: string | null;
  value_unit: string | null;
  condition_date: string | null;
  canonical_subject: string;
}

export async function getEventChildQuestions(
  platform: string,
  platform_event_id: string,
): Promise<EventChildQuestion[]> {
  return query<EventChildQuestion>(
    `SELECT DISTINCT ON (q.id)
       q.id                    AS question_id,
       n.value_primary::float8 AS value_primary,
       n.condition_direction   AS condition_direction,
       n.condition_metric      AS condition_metric,
       n.value_unit            AS value_unit,
       n.condition_date        AS condition_date,
       q.canonical_subject
     FROM markets m
     JOIN question_members qm ON qm.market_id = m.id
     JOIN questions        q  ON q.id = qm.question_id
     LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE m.platform          = $1
       AND m.platform_event_id = $2
     ORDER BY q.id,
       (
         (n.value_primary  IS NOT NULL)::int +
         (n.condition_direction IS NOT NULL)::int +
         (n.value_unit     IS NOT NULL)::int
       ) DESC,
       m.id`,
    [platform, platform_event_id]
  );
}

