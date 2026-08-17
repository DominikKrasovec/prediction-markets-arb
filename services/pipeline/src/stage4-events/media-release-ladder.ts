/**
 * media-release-ladder — same-class media_release threshold chain edges (Stage 4).
 * Within one ladder family (same canonical_event + subject + metric + unit + condition_date +
 * direction + title class), the stricter threshold implies the looser. The title-class belt is
 * load-bearing: Stage 1 stamps the same metric/unit for "Pure Album Sales" and "Album
 * Equivalent Units", which are different real quantities, so a metric-blind ladder would fuse
 * them into fake arbitrage. A separate builder (not a numeric-ladder-xq entry) because the
 * discriminator lives in member market titles, not node_facts' single representative title —
 * this builder classifies every member and disqualifies any question whose members disagree.
 */
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-media-release-ladder');

export type MediaTitleClass = 'pure' | 'equivalent' | 'streams' | 'rt_score';

export const MEDIA_TITLE_CLASS_PATTERNS: ReadonlyArray<{ cls: MediaTitleClass; rx: RegExp }> = [
  { cls: 'pure', rx: /pure album sales/i },
  { cls: 'equivalent', rx: /album equivalent/i },
  { cls: 'streams', rx: /streams/i },
  { cls: 'rt_score', rx: /rotten tomatoes/i },
];

// Refuses (null) when the title matches zero OR more than one class pattern.
export function classifyMediaReleaseTitle(title: string | null | undefined): MediaTitleClass | null {
  if (!title) return null;
  const hits = MEDIA_TITLE_CLASS_PATTERNS.filter((p) => p.rx.test(title));
  return hits.length === 1 ? hits[0]!.cls : null;
}

export function mediaLadderImplies(
  direction: 'above' | 'below' | string | null | undefined,
  antecedentClass: MediaTitleClass | null,
  consequentClass: MediaTitleClass | null,
  antecedentValue: number | null | undefined,
  consequentValue: number | null | undefined,
): boolean {
  if (antecedentClass == null || consequentClass == null) return false;
  if (antecedentClass !== consequentClass) return false;
  if (antecedentValue == null || consequentValue == null) return false;
  if (direction === 'above') return antecedentValue > consequentValue;
  if (direction === 'below') return antecedentValue < consequentValue;
  return false;
}

export const MEDIA_LADDER_SHAPES_SQL = `('monotonic_threshold','point_in_time')`;

export function mediaTitleClassSql(titleCol: string): string {
  return `CASE
        WHEN ((lower(${titleCol}) ~ 'pure album sales')::int
            + (lower(${titleCol}) ~ 'album equivalent')::int
            + (lower(${titleCol}) ~ 'streams')::int
            + (lower(${titleCol}) ~ 'rotten tomatoes')::int) <> 1 THEN NULL
        WHEN lower(${titleCol}) ~ 'pure album sales' THEN 'pure'
        WHEN lower(${titleCol}) ~ 'album equivalent' THEN 'equivalent'
        WHEN lower(${titleCol}) ~ 'streams' THEN 'streams'
        WHEN lower(${titleCol}) ~ 'rotten tomatoes' THEN 'rt_score'
      END`;
}

// Exported separately so the read-only dry-run probe can count pairs without executing the INSERT.
export function mediaReleaseRungsCtesSql(): string {
  return `mr_rows AS (
      SELECT
        qm.question_id,
        lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))   AS ev_key,
        lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, '')))) AS subj_key,
        coalesce(n.condition_date, '')                                      AS d,
        n.condition_direction                                               AS dir,
        coalesce(lower(btrim(n.value_unit)), '')                            AS unit_key,
        coalesce(lower(btrim(n.condition_metric)), '')                      AS metric_key,
        n.value_primary::numeric                                            AS line,
        ${mediaTitleClassSql('m.title')}                                    AS cls
      FROM llm_market_normalizations n
      JOIN markets m ON m.id = n.market_id
      JOIN question_members qm ON qm.market_id = n.market_id
      JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
      WHERE n.event_kind = 'media_release'
        AND n.condition_shape IN ${MEDIA_LADDER_SHAPES_SQL}
        AND n.value_secondary IS NULL
        AND n.condition_direction IN ('above','below')
        AND n.value_primary IS NOT NULL
    ),
    -- A question whose media_release members disagree on any reading field or the title class
    -- (or carry an unclassifiable member) is fused upstream, so no edges at all.
    bad_questions AS (
      SELECT question_id FROM mr_rows
      GROUP BY question_id
      HAVING count(DISTINCT (ev_key, subj_key, d, dir, unit_key, metric_key, line, cls)) > 1
          OR bool_or(cls IS NULL)
    ),
    node_rungs AS (
      SELECT ev_key, subj_key, d, dir, unit_key, metric_key, cls, question_id,
             min(line) AS line
      FROM mr_rows
      WHERE question_id NOT IN (SELECT question_id FROM bad_questions)
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    ),
    ranked AS (
      SELECT *,
        dense_rank() OVER (
          PARTITION BY ev_key, subj_key, d, dir, unit_key, metric_key, cls
          ORDER BY CASE WHEN dir = 'above' THEN -line ELSE line END
        ) AS rk
      FROM node_rungs
    ),
    chain_pairs AS (
      SELECT a.question_id AS antecedent_question_id,
             b.question_id AS consequent_question_id,
             a.dir, a.cls, a.line AS l_strict, b.line AS l_loose
      FROM ranked a
      JOIN ranked b
        ON b.ev_key     = a.ev_key
       AND b.subj_key   = a.subj_key
       AND b.d          = a.d
       AND b.dir        = a.dir
       AND b.unit_key   = a.unit_key
       AND b.metric_key = a.metric_key
       AND b.cls        = a.cls
       AND b.rk = a.rk + 1
       AND b.question_id <> a.question_id
       AND b.line <> a.line
       -- Cross-set residue only: co-set pairs belong to the within-set threshold_series ladder.
       AND NOT EXISTS (
         SELECT 1
         FROM outcome_set_slots s1
         JOIN outcome_set_slots s2 ON s1.set_id = s2.set_id
         WHERE s1.question_id = a.question_id
           AND s2.question_id = b.question_id
       )
    )`;
}

export function buildMediaReleaseLadderEdgesSql(): string {
  return `
    WITH ${mediaReleaseRungsCtesSql()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'media_release_ladder')},
             'media_release ladder: same title class (pure sales / equivalent units / streams / RT score) resolves on one published quantity, so the stricter adjacent threshold implies the looser; cross-class pairs refused (pure vs equivalent are different quantities)'
      FROM chain_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildMediaReleaseLadderEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildMediaReleaseLadderEdgesSql());
  log.info('media-release-ladder: ' + n + ' edges');
  return n;
}
