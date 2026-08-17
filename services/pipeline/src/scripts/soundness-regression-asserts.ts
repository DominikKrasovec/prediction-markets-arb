/**
 * Read-only soundness regression asserts; each must return zero violations.
 * Safe to run while a pipeline run is live.
 */
import { query, endPool } from '@arb/db';
import { EDGE_PATTERNS } from '@arb/types';
import { ALIAS_DENY_LIST } from '../db/entity/alias-deny-list.js';
import { areSportsCompatible } from '../db/entity/sport-hierarchy.js';
import { buildStructureTierViolationsSql } from '../stage4-events/equivalence-edge.js';
import { INTEGER_GRAIN_UNITS, snapshotShapesSql, touchVsSnapshotConflictSql } from '../util/condition-shape.js';
import { strictlyEarlierAtCoarserGrainSql } from '../util/date-grain-sql.js';
import {
  FIXTURE_START_KINDS_SQL,
  FIXTURE_START_TOLERANCE_MS,
  fixtureStartInstantSql,
} from '../util/fixture-instant.js';
import { discriminatingOracleSql, oraclesKnownToDifferSql } from '../util/resolution-oracle-compare.js';
import { memberOutcomeGrainSql } from '../util/outcome-grain-sql.js';

const NODE_GRAIN_SQL = `
  SELECT qm.question_id, ${memberOutcomeGrainSql('m.title', 'n.event_kind', '         ')} AS grain
  FROM question_members qm
  JOIN markets m ON m.id = qm.market_id
  LEFT JOIN llm_market_normalizations n ON n.market_id = qm.market_id`;

const INTEGER_GRAIN_UNITS_SQL = `(${[...INTEGER_GRAIN_UNITS]
  .map((u) => `'${u.replace(/'/g, "''")}'`)
  .join(',')})`;

interface AssertResult {
  name: string;
  violations: number;
  detail?: string;
}

/** Each entry: a single scalar-count SQL that must be 0. */
const COUNT_ASSERTS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: 'question-members: kalshi sibling legs in one node',
    sql: `
      SELECT count(DISTINCT qm1.question_id)::int AS n
      FROM question_members qm1
      JOIN markets m1             ON m1.id = qm1.market_id AND m1.platform = 'kalshi'
      JOIN market_metadata_raw r1 ON r1.market_id = m1.id
      JOIN question_members qm2   ON qm2.question_id = qm1.question_id AND qm2.market_id > qm1.market_id
      JOIN markets m2             ON m2.id = qm2.market_id AND m2.platform = 'kalshi'
      JOIN market_metadata_raw r2 ON r2.market_id = m2.id
      WHERE r1.raw->>'event_ticker' IS NOT NULL
        AND r1.raw->>'event_ticker' = r2.raw->>'event_ticker'
        AND (r1.raw->>'yes_sub_title') IS DISTINCT FROM (r2.raw->>'yes_sub_title')
    `,
  },
  {
    name: 'question-members: same-platform sibling platform_events fused into one node',
    sql: `
      SELECT count(DISTINCT qm1.question_id)::int AS n
      FROM question_members qm1
      JOIN markets m1        ON m1.id = qm1.market_id
      JOIN platform_events pe1 ON pe1.platform = m1.platform AND pe1.platform_event_id = m1.platform_event_id
      JOIN question_members qm2 ON qm2.question_id = qm1.question_id AND qm2.market_id > qm1.market_id
      JOIN markets m2        ON m2.id = qm2.market_id AND m2.platform = m1.platform
      JOIN platform_events pe2 ON pe2.platform = m2.platform AND pe2.platform_event_id = m2.platform_event_id
      JOIN questions q       ON q.id = qm1.question_id AND q.canonical_key LIKE 'sem:%'
      WHERE pe1.id <> pe2.id
    `,
  },
  {
    name: 'question-members: shaped members disagree on value/direction/unit/kind',
    sql: `
      SELECT count(DISTINCT qm1.question_id)::int AS n
      FROM question_members qm1
      JOIN llm_market_normalizations n1 ON n1.market_id = qm1.market_id
      JOIN question_members qm2 ON qm2.question_id = qm1.question_id AND qm2.market_id > qm1.market_id
      JOIN llm_market_normalizations n2 ON n2.market_id = qm2.market_id
      WHERE n1.condition_shape IS NOT NULL AND n2.condition_shape IS NOT NULL
        AND (
             (n1.value_primary IS NOT NULL AND n2.value_primary IS NOT NULL
              AND n1.value_primary IS DISTINCT FROM n2.value_primary)
          OR (n1.value_secondary IS NOT NULL AND n2.value_secondary IS NOT NULL
              AND n1.value_secondary IS DISTINCT FROM n2.value_secondary)
          OR (n1.condition_direction IS NOT NULL AND n2.condition_direction IS NOT NULL
              AND n1.condition_direction IS DISTINCT FROM n2.condition_direction)
          OR (n1.value_unit IS NOT NULL AND n2.value_unit IS NOT NULL
              AND lower(n1.value_unit) IS DISTINCT FROM lower(n2.value_unit))
          OR (n1.event_kind IS NOT NULL AND n2.event_kind IS NOT NULL
              AND n1.event_kind IS DISTINCT FROM n2.event_kind)
          -- date compares at the coarser of the two precisions: a padded
          -- year date cohering with a real month/day date is not a violation.
          OR (n1.condition_date IS NOT NULL AND n2.condition_date IS NOT NULL
              AND CASE
                    WHEN n1.condition_date_precision = 'year' OR n2.condition_date_precision = 'year'
                      THEN left(n1.condition_date, 4) IS DISTINCT FROM left(n2.condition_date, 4)
                    WHEN n1.condition_date_precision = 'month' OR n2.condition_date_precision = 'month'
                      THEN left(n1.condition_date, 7) IS DISTINCT FROM left(n2.condition_date, 7)
                    ELSE left(n1.condition_date, 10) IS DISTINCT FROM left(n2.condition_date, 10)
                  END)
        )
    `,
  },
  {
    name: 'question-members: node spans >1 proven outcome grain',
    sql: `
      WITH mg AS (${NODE_GRAIN_SQL})
      SELECT count(*)::int AS n
      FROM (
        SELECT mg.question_id
        FROM mg
        JOIN questions q ON q.id = mg.question_id AND q.archived_at IS NULL
        WHERE mg.grain IS NOT NULL
        GROUP BY mg.question_id
        HAVING count(DISTINCT mg.grain) > 1
      ) x
    `,
  },
  {
    name: 'outcome-sets: heterogeneous Σ=1 (multi-kind exhaustive categorical)',
    sql: `
      SELECT count(*)::int AS n FROM (
        SELECT s.set_id
        FROM outcome_set_slots s
        JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'categorical' AND os.is_exhaustive
        JOIN questions q ON q.id = s.question_id
        WHERE q.event_kind IS NOT NULL
        GROUP BY s.set_id
        HAVING count(DISTINCT q.event_kind) >= 2
      ) x
    `,
  },
  {
    name: 'outcome-sets: categorical set mixing ≥2 fixture kinds (co-occurrable fold)',
    sql: `
      SELECT count(*)::int AS n FROM (
        SELECT s.set_id
        FROM outcome_set_slots s
        JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'categorical'
        JOIN questions q ON q.id = s.question_id
        WHERE q.event_kind IN ('match_winner','exact_score','both_teams_score',
                               'match_total_metric','match_spread','halftime_leader',
                               'player_prop_threshold')
        GROUP BY s.set_id
        HAVING count(DISTINCT q.event_kind) >= 2
      ) x
    `,
  },
  {
    name: 'outcome-sets: exact-score Σ=1 without in-set residual slot',
    sql: `
      SELECT count(*)::int AS n FROM (
        SELECT s.set_id
        FROM outcome_set_slots s
        JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'categorical' AND os.is_exhaustive
        JOIN questions q ON q.id = s.question_id
        GROUP BY s.set_id
        HAVING count(*) FILTER (WHERE q.event_kind = 'exact_score') > 0
           AND count(*) FILTER (
                 WHERE lower(coalesce(q.canonical_subject, '')) ~ '\\m(any other|other score)\\M'
                    OR q.canonical_key LIKE '%other%'
                    OR EXISTS (
                         SELECT 1 FROM question_members qm
                         JOIN markets m ON m.id = qm.market_id
                         WHERE qm.question_id = q.id
                           AND lower(m.title) ~ '\\m(any other|other score)\\M'
                       )
               ) = 0
      ) x
    `,
  },
  {
    name: 'embeddings: offset-1000 page-shift pairs',
    sql: `
      SELECT count(*)::int AS n
      FROM platform_events a
      JOIN platform_events b ON a.id = b.id + 1000
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND (a.embedding <=> b.embedding) < 0.0005
        AND lower(btrim(a.title)) IS DISTINCT FROM lower(btrim(b.title))
    `,
  },
  {
    name: 'edges: deterministic with sub-contract confidence',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges
      WHERE deterministic AND confidence < 1.0 AND archived_at IS NULL
    `,
  },
  {
    name: 'edges: deterministic from llm source',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges
      WHERE deterministic AND source = 'llm' AND archived_at IS NULL
    `,
  },
  {
    name: 'embeddings: markets-grain offset-2000 page-shift pairs',
    sql: `
      WITH ranked AS (
        SELECT id, embedding, lower(btrim(title)) AS folded_title,
               row_number() OVER (ORDER BY id) AS rn
        FROM markets WHERE embedding IS NOT NULL
      )
      SELECT count(*)::int AS n
      FROM ranked a JOIN ranked b ON a.rn = b.rn + 2000
      WHERE md5(a.embedding::text) = md5(b.embedding::text)
        AND a.folded_title IS DISTINCT FROM b.folded_title
    `,
  },
  {
    name: 'edges: mis-oriented exact_score_winner (subject ∉ participants)',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      WHERE e.pattern = 'exact_score_winner' AND e.archived_at IS NULL
        AND NOT (qa.canonical_subject = ANY(qa.participants))
    `,
  },
  {
    name: 'edges: equivalence + mutual_exclusion on the same question pair',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e1
      JOIN implication_edges e2
        ON LEAST(e1.antecedent_question_id, e1.consequent_question_id)
             = LEAST(e2.antecedent_question_id, e2.consequent_question_id)
       AND GREATEST(e1.antecedent_question_id, e1.consequent_question_id)
             = GREATEST(e2.antecedent_question_id, e2.consequent_question_id)
       AND e1.id < e2.id
      WHERE e1.archived_at IS NULL AND e2.archived_at IS NULL
        AND e1.edge_type = 'equivalence' AND e2.edge_type = 'mutual_exclusion'
    `,
  },
  {
    name: 'edges: implication vs exclusion on the same unordered pair',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e1
      JOIN implication_edges e2
        ON LEAST(e1.antecedent_question_id, e1.consequent_question_id)
             = LEAST(e2.antecedent_question_id, e2.consequent_question_id)
       AND GREATEST(e1.antecedent_question_id, e1.consequent_question_id)
             = GREATEST(e2.antecedent_question_id, e2.consequent_question_id)
       AND e1.id <> e2.id
      WHERE e1.archived_at IS NULL AND e2.archived_at IS NULL
        AND e1.edge_type = 'strict_implication' AND e2.edge_type = 'mutual_exclusion'
    `,
  },
  {
    name: 'edges: active edge with archived/memberless endpoint (all patterns)',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      WHERE e.archived_at IS NULL
        AND (
          NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.question_id = e.antecedent_question_id)
          OR NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.question_id = e.consequent_question_id)
          OR EXISTS (SELECT 1 FROM questions q WHERE q.id = e.antecedent_question_id AND q.archived_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM questions q WHERE q.id = e.consequent_question_id AND q.archived_at IS NOT NULL)
        )
    `,
  },
  {
    name: 'edges: numeric_ladder_xq monotonicity violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'numeric_ladder_xq' AND e.archived_at IS NULL
        AND (
             (qa.condition_direction = 'above' AND qa.value_primary::numeric <  qb.value_primary::numeric)
          OR (qa.condition_direction = 'below' AND qa.value_primary::numeric >  qb.value_primary::numeric)
          OR qa.condition_direction IS DISTINCT FROM qb.condition_direction
          OR qa.value_unit IS DISTINCT FROM qb.value_unit
        )
    `,
  },
  {
    name: 'questions: sem: stamped shape contradicts uniform member shape',
    sql: `
      SELECT count(*)::int AS n FROM (
        SELECT qm.question_id, min(n.condition_shape) AS member_shape
        FROM question_members qm
        JOIN llm_market_normalizations n ON n.market_id = qm.market_id
        JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
        WHERE q.canonical_key LIKE 'sem:%' AND n.condition_shape IS NOT NULL
        GROUP BY qm.question_id
        HAVING count(DISTINCT n.condition_shape) = 1
      ) ms
      JOIN questions q ON q.id = ms.question_id
      WHERE q.condition_shape IS DISTINCT FROM ms.member_shape
    `,
  },
  {
    name: 'cross-refs: touch-vs-snapshot condition_shape drift',
    sql: `
      SELECT count(*)::int AS n
      FROM market_cross_refs xr
      JOIN llm_market_normalizations na ON na.market_id = xr.source_market_id
      JOIN llm_market_normalizations nb ON nb.market_id = xr.target_market_id
      WHERE NOT ${touchVsSnapshotConflictSql('na.condition_shape', 'nb.condition_shape')}
    `,
  },
  {
    name: 'normalizations: match_spread stamped monotonic_threshold',
    sql: `
      SELECT count(*)::int AS n
      FROM llm_market_normalizations
      WHERE event_kind = 'match_spread' AND condition_shape = 'monotonic_threshold'
    `,
  },
  {
    name: 'normalizations: crypto_launch_fdv with a stamped condition_date',
    sql: `
      SELECT count(*)::int AS n
      FROM llm_market_normalizations
      WHERE event_kind = 'crypto_launch_fdv' AND condition_date IS NOT NULL
    `,
  },
  {
    name: 'edges: numeric_ladder_xq with mixed condition_shape legs',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'numeric_ladder_xq' AND e.archived_at IS NULL
        AND qa.condition_shape IS DISTINCT FROM qb.condition_shape
    `,
  },
  {
    name: 'edges: equivalence between touch and snapshot questions',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND NOT ${touchVsSnapshotConflictSql('qa.condition_shape', 'qb.condition_shape')}
    `,
  },
  {
    name: 'outcome-sets: threshold_series mixing touch and snapshot slots',
    sql: `
      SELECT count(*)::int AS n FROM (
        SELECT s.set_id
        FROM outcome_set_slots s
        JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'threshold_series'
        JOIN questions q ON q.id = s.question_id
        WHERE q.condition_shape IS NOT NULL
        GROUP BY s.set_id
        HAVING count(*) FILTER (WHERE q.condition_shape = 'monotonic_threshold') > 0
           AND count(*) FILTER (WHERE q.condition_shape IN ${snapshotShapesSql()}) > 0
      ) x
    `,
  },
  {
    name: 'edges: date_implication (xq) not strictly ordered at coarser grain',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'date_implication' AND e.archived_at IS NULL
        AND e.reasoning LIKE 'date implication: by D1%'
        AND NOT (
          qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
          AND ${strictlyEarlierAtCoarserGrainSql('qa.condition_date', 'qa.condition_date_precision', 'qb.condition_date', 'qb.condition_date_precision')}
        )
    `,
  },
  {
    name: 'edges: margin_winner orientation/contract violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'margin_winner' AND e.archived_at IS NULL
        AND (
          qa.event_kind IS DISTINCT FROM 'election_margin'
          OR qa.condition_direction IS DISTINCT FROM 'above'
          OR qa.value_primary IS NULL OR qa.value_primary::numeric <= 0
          OR qb.event_kind IS DISTINCT FROM 'election_outcome_winner'
          OR qb.canonical_subject NOT IN ('Democratic Party','Republican Party')
        )
    `,
  },
  {
    name: 'edges: shape_bridge orientation/shape violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'shape_bridge' AND e.archived_at IS NULL
        AND (
          qa.condition_shape IS NULL OR qa.condition_shape NOT IN ${snapshotShapesSql()}
          OR qb.condition_shape IS DISTINCT FROM 'monotonic_threshold'
          OR qb.condition_direction IS NULL OR qb.condition_direction NOT IN ('above','below')
          OR qa.event_kind IS DISTINCT FROM 'price_threshold'
          OR qb.event_kind IS DISTINCT FROM 'price_threshold'
        )
    `,
  },
  {
    name: 'edges: shape_bridge cross-platform settlement-instrument gate violation',
    sql: `
      WITH qi AS (
        SELECT qm.question_id,
               CASE WHEN count(DISTINCT nz.settlement_instrument) = 1
                    THEN min(nz.settlement_instrument) END AS si
        FROM question_members qm
        JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id
        WHERE nz.settlement_instrument IS NOT NULL
        GROUP BY qm.question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN LATERAL (
        SELECT m.platform FROM question_members qm JOIN markets m ON m.id = qm.market_id
        WHERE qm.question_id = e.antecedent_question_id ORDER BY m.id LIMIT 1
      ) pa ON TRUE
      JOIN LATERAL (
        SELECT m.platform FROM question_members qm JOIN markets m ON m.id = qm.market_id
        WHERE qm.question_id = e.consequent_question_id ORDER BY m.id LIMIT 1
      ) pb ON TRUE
      LEFT JOIN qi ia ON ia.question_id = e.antecedent_question_id
      LEFT JOIN qi ib ON ib.question_id = e.consequent_question_id
      WHERE e.pattern = 'shape_bridge' AND e.archived_at IS NULL
        AND pa.platform IS DISTINCT FROM pb.platform
        AND NOT (
          ia.si IS NOT NULL AND ib.si IS NOT NULL
          AND ia.si <> 'futures:unpinned' AND ib.si <> 'futures:unpinned'
          AND (ia.si = ib.si
               OR (ia.si, ib.si) IN (('cf-benchmarks','binance'),('binance','cf-benchmarks')))
        )
    `,
  },
  {
    name: 'edges: window_containment orientation/containment/monotone-shape violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'window_containment' AND e.archived_at IS NULL
        AND NOT (
          qa.condition_shape = 'monotonic_threshold'
          AND qb.condition_shape = 'monotonic_threshold'
          AND qa.condition_direction = 'above'
          AND qb.condition_direction = 'above'
          AND qa.temporal_semantics = 'during_period'
          AND qb.temporal_semantics = 'during_period'
          AND qa.value_primary IS NOT NULL AND qb.value_primary IS NOT NULL
          AND qa.value_primary::numeric >= qb.value_primary::numeric
          AND qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
          AND qa.condition_date_precision IN ('month','year')
          AND qb.condition_date_precision IN ('month','year')
          AND (CASE qa.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END)
            < (CASE qb.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END)
          AND left(qa.condition_date, CASE qb.condition_date_precision WHEN 'year' THEN 4 ELSE 7 END)
            = left(qb.condition_date, CASE qb.condition_date_precision WHEN 'year' THEN 4 ELSE 7 END)
        )
    `,
  },
  {
    name: 'edges: spread_winner orientation/favorite-leg/fixture-scope violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'spread_winner' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'match_spread'
          AND qa.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_primary::numeric > 0
          AND qa.value_secondary IS NULL
          AND (qa.metric_scope IS NULL OR qa.metric_scope = 'game')
          AND lower(btrim(qa.value_unit)) IN
              ('point','points','goal','goals','run','runs','map','maps','set','sets')
          AND qb.event_kind = 'match_winner'
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qb.canonical_subject IS NOT NULL
          AND qb.canonical_subject = ANY(qb.participants)
          -- team identity: arity-1 participants[1]; arity-2 clean subject; else violation
          AND lower(immutable_unaccent(btrim(qb.canonical_subject))) =
              lower(immutable_unaccent(btrim(
                CASE
                  WHEN array_length(qa.participants, 1) = 1 THEN qa.participants[1]
                  WHEN array_length(qa.participants, 1) = 2
                   AND qa.participants[1] IS DISTINCT FROM qa.participants[2]
                   AND qa.canonical_subject = ANY(qa.participants) THEN qa.canonical_subject
                END)))
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event, '')))) !~ '\\mseries\\M'
        )
    `,
  },
  {
    name: 'edges: btts_total_over unit/line/per-team/scope violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'btts_total_over' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'both_teams_score'
          AND (qa.metric_scope IS NULL OR qa.metric_scope = 'game')
          AND qb.event_kind = 'match_total_metric'
          AND qb.condition_direction = 'above'
          AND qb.value_primary IS NOT NULL AND qb.value_primary::numeric < 2
          AND qb.value_secondary IS NULL
          AND lower(btrim(qb.value_unit)) IN ('goal','goals')
          AND qb.canonical_subject IS NOT NULL AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qa.participants IS NOT NULL
          AND qa.participants = qb.participants
        )
    `,
  },
  {
    name: 'edges: team_game_total_over identification/unit/dominance violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'team_game_total_over' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'match_total_metric'
          AND qa.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NULL
          AND qa.value_unit IS NOT NULL AND qa.participants IS NOT NULL
          AND (qa.metric_scope = 'team'
               OR (qa.canonical_subject IS NOT NULL
                   AND qa.canonical_subject = ANY(qa.participants)
                   AND (qa.metric_scope IS NULL OR qa.metric_scope = 'game')))
          AND qb.event_kind = 'match_total_metric'
          AND qb.condition_direction = 'above'
          AND qb.value_primary IS NOT NULL AND qb.value_secondary IS NULL
          AND qb.value_unit IS NOT NULL
          AND qb.canonical_subject IS NOT NULL AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qa.value_primary::numeric >= qb.value_primary::numeric
          AND (lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND qa.participants = qb.participants
        )
    `,
  },
  {
    name: 'edges: spread_total_over favorite-leg/unit/dominance violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'spread_total_over' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'match_spread'
          AND qa.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_primary::numeric > 0
          AND qa.value_secondary IS NULL
          AND (qa.metric_scope IS NULL OR qa.metric_scope = 'game')
          AND lower(btrim(qa.value_unit)) IN
              ('point','points','goal','goals','run','runs','map','maps','set','sets')
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event, '')))) !~ '\\mseries\\M'
          AND qb.event_kind = 'match_total_metric'
          AND qb.condition_direction = 'above'
          AND qb.value_primary IS NOT NULL AND qb.value_secondary IS NULL
          AND qb.value_unit IS NOT NULL
          AND qb.canonical_subject IS NOT NULL AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qa.value_primary::numeric >= qb.value_primary::numeric
          AND (lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND qa.participants IS NOT NULL
          AND qa.participants = qb.participants
        )
    `,
  },
  {
    name: 'edges: fixture_total_ladder orientation/unit/per-team/scope violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'fixture_total_ladder' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'match_total_metric'
          AND qb.event_kind = 'match_total_metric'
          AND qa.condition_direction = 'above'
          AND qb.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NULL
          AND qb.value_primary IS NOT NULL AND qb.value_secondary IS NULL
          AND qa.value_unit IS NOT NULL AND qb.value_unit IS NOT NULL
          AND qa.canonical_subject IS NOT NULL AND qa.participants IS NOT NULL
          AND NOT (qa.canonical_subject = ANY(qa.participants))
          AND qb.canonical_subject IS NOT NULL AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qa.metric_scope IS NULL OR qa.metric_scope = 'game')
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qa.value_primary::numeric > qb.value_primary::numeric
          AND (lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND qa.participants = qb.participants
        )
    `,
  },
  {
    name: 'edges: slice_game_total_over slice-scope/unit/dominance violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'slice_game_total_over' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'match_total_metric'
          AND qb.event_kind = 'match_total_metric'
          AND qa.condition_direction = 'above'
          AND qb.condition_direction = 'above'
          AND qa.metric_scope IN ('first_5','half_1','half_2')
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NULL
          AND qb.value_primary IS NOT NULL AND qb.value_secondary IS NULL
          AND qa.value_unit IS NOT NULL AND qb.value_unit IS NOT NULL
          AND qa.canonical_subject IS NOT NULL AND qa.participants IS NOT NULL
          AND NOT (qa.canonical_subject = ANY(qa.participants))
          AND qb.canonical_subject IS NOT NULL AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qb.metric_scope IS NULL OR qb.metric_scope = 'game')
          AND qa.value_primary::numeric >= qb.value_primary::numeric
          AND (lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND qa.participants = qb.participants
        )
    `,
  },
  {
    name: 'edges: kalshi_strike_ladder family-key/orientation violation',
    sql: `
      WITH pl AS (
        SELECT qm.question_id,
               CASE WHEN count(DISTINCT lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))) = 1
                    THEN min(lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))) END AS ev,
               CASE WHEN count(DISTINCT lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, ''))))) = 1
                    THEN min(lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, ''))))) END AS subj,
               CASE WHEN count(DISTINCT coalesce(n.condition_date, '')) = 1
                    THEN min(coalesce(n.condition_date, '')) END AS d,
               CASE WHEN count(DISTINCT n.condition_direction) = 1
                    THEN min(n.condition_direction) END AS dir,
               CASE WHEN count(DISTINCT coalesce(lower(btrim(n.value_unit)), '')) = 1
                    THEN min(coalesce(lower(btrim(n.value_unit)), '')) END AS unit,
               CASE WHEN count(DISTINCT coalesce(lower(btrim(n.condition_metric)), '')) = 1
                    THEN min(coalesce(lower(btrim(n.condition_metric)), '')) END AS metric,
               CASE WHEN count(DISTINCT n.value_primary) = 1
                    THEN min(n.value_primary::numeric) END AS strike
        FROM question_members qm
        JOIN llm_market_normalizations n ON n.market_id = qm.market_id
        WHERE n.match_source = 'kalshi:price-ladder'
        GROUP BY qm.question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      LEFT JOIN pl a ON a.question_id = e.antecedent_question_id
      LEFT JOIN pl b ON b.question_id = e.consequent_question_id
      WHERE e.pattern = 'kalshi_strike_ladder' AND e.archived_at IS NULL
        AND NOT (
          a.ev IS NOT NULL AND b.ev IS NOT NULL AND a.ev = b.ev
          AND a.subj IS NOT NULL AND a.subj = b.subj
          AND a.d IS NOT NULL AND a.d = b.d
          AND a.dir IS NOT NULL AND a.dir = b.dir
          AND a.unit IS NOT NULL AND a.unit = b.unit
          AND a.metric IS NOT NULL AND a.metric = b.metric
          AND a.strike IS NOT NULL AND b.strike IS NOT NULL
          AND (
               (a.dir = 'above' AND a.strike > b.strike)
            OR (a.dir = 'below' AND a.strike < b.strike)
          )
        )
    `,
  },
  {
    name: 'edges: media_release_ladder class-belt/family-key/orientation violation',
    sql: `
      WITH mr AS (
        SELECT qm.question_id,
               CASE WHEN count(DISTINCT lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))) = 1
                    THEN min(lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))) END AS ev,
               CASE WHEN count(DISTINCT lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, ''))))) = 1
                    THEN min(lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, ''))))) END AS subj,
               CASE WHEN count(DISTINCT coalesce(n.condition_date, '')) = 1
                    THEN min(coalesce(n.condition_date, '')) END AS d,
               CASE WHEN count(DISTINCT n.condition_direction) = 1
                    THEN min(n.condition_direction) END AS dir,
               CASE WHEN count(DISTINCT coalesce(lower(btrim(n.value_unit)), '')) = 1
                    THEN min(coalesce(lower(btrim(n.value_unit)), '')) END AS unit,
               CASE WHEN count(DISTINCT coalesce(lower(btrim(n.condition_metric)), '')) = 1
                    THEN min(coalesce(lower(btrim(n.condition_metric)), '')) END AS metric,
               CASE WHEN count(DISTINCT n.value_primary) = 1
                    THEN min(n.value_primary::numeric) END AS line,
               -- title class per member (exactly-one-match or 'unclassified'); unanimous or NULL
               CASE WHEN count(DISTINCT (CASE
                      WHEN ((lower(m.title) ~ 'pure album sales')::int
                          + (lower(m.title) ~ 'album equivalent')::int
                          + (lower(m.title) ~ 'streams')::int
                          + (lower(m.title) ~ 'rotten tomatoes')::int) <> 1 THEN 'unclassified'
                      WHEN lower(m.title) ~ 'pure album sales' THEN 'pure'
                      WHEN lower(m.title) ~ 'album equivalent' THEN 'equivalent'
                      WHEN lower(m.title) ~ 'streams' THEN 'streams'
                      WHEN lower(m.title) ~ 'rotten tomatoes' THEN 'rt_score'
                    END)) = 1
                    THEN min(CASE
                      WHEN ((lower(m.title) ~ 'pure album sales')::int
                          + (lower(m.title) ~ 'album equivalent')::int
                          + (lower(m.title) ~ 'streams')::int
                          + (lower(m.title) ~ 'rotten tomatoes')::int) <> 1 THEN 'unclassified'
                      WHEN lower(m.title) ~ 'pure album sales' THEN 'pure'
                      WHEN lower(m.title) ~ 'album equivalent' THEN 'equivalent'
                      WHEN lower(m.title) ~ 'streams' THEN 'streams'
                      WHEN lower(m.title) ~ 'rotten tomatoes' THEN 'rt_score'
                    END) END AS cls
        FROM question_members qm
        JOIN llm_market_normalizations n ON n.market_id = qm.market_id
        JOIN markets m ON m.id = n.market_id
        WHERE n.event_kind = 'media_release'
        GROUP BY qm.question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      LEFT JOIN mr a ON a.question_id = e.antecedent_question_id
      LEFT JOIN mr b ON b.question_id = e.consequent_question_id
      WHERE e.pattern = 'media_release_ladder' AND e.archived_at IS NULL
        AND NOT (
          a.ev IS NOT NULL AND b.ev IS NOT NULL AND a.ev = b.ev
          AND a.subj IS NOT NULL AND a.subj = b.subj
          AND a.d IS NOT NULL AND a.d = b.d
          AND a.dir IS NOT NULL AND a.dir = b.dir
          AND a.unit IS NOT NULL AND a.unit = b.unit
          AND a.metric IS NOT NULL AND a.metric = b.metric
          AND a.cls IS NOT NULL AND a.cls = b.cls
          AND a.cls IN ('pure','equivalent','streams','rt_score')
          AND a.line IS NOT NULL AND b.line IS NOT NULL
          AND (
               (a.dir = 'above' AND a.line > b.line)
            OR (a.dir = 'below' AND a.line < b.line)
          )
        )
    `,
  },
  {
    name: 'edges: first_anytime_scorer player/stamp/fixture violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'first_anytime_scorer' AND e.archived_at IS NULL
        AND NOT (
          qa.event_kind = 'player_prop_threshold'
          AND qb.event_kind = 'player_prop_threshold'
          AND qa.condition_metric = 'rank'
          AND qb.condition_metric = 'count'
          AND qa.condition_shape = 'binary_event'
          AND qb.condition_shape = 'binary_event'
          AND qa.condition_direction IS NULL AND qb.condition_direction IS NULL
          AND qa.value_primary IS NULL AND qa.value_secondary IS NULL
          AND qb.value_primary IS NULL AND qb.value_secondary IS NULL
          AND qa.canonical_subject IS NOT NULL AND qb.canonical_subject IS NOT NULL
          AND lower(immutable_unaccent(btrim(qa.canonical_subject)))
              = lower(immutable_unaccent(btrim(qb.canonical_subject)))
          AND lower(immutable_unaccent(btrim(qa.canonical_event)))
              = lower(immutable_unaccent(btrim(qa.canonical_subject))) || ' first goalscorer'
          AND lower(immutable_unaccent(btrim(qb.canonical_event)))
              = lower(immutable_unaccent(btrim(qb.canonical_subject))) || ' goals'
          AND (qb.value_unit IS NULL OR lower(btrim(qb.value_unit)) IN ('goal','goals'))
        )
    `,
  },
  {
    name: 'edges: exact_score_total_over arithmetic/fixture/unit violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'exact_score_total_over' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'strict_implication'
          AND qa.event_kind = 'exact_score'
          AND qb.event_kind = 'match_total_metric'
          AND qb.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NOT NULL
          AND qb.value_primary IS NOT NULL
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event,'')))) = lower(immutable_unaccent(btrim(coalesce(qb.canonical_event,''))))
          AND qa.participants = qb.participants
          AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qa.value_unit IS NULL OR qb.value_unit IS NULL
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND (qa.value_primary::numeric + qa.value_secondary::numeric) > qb.value_primary::numeric
        )
    `,
  },
  {
    name: 'edges: exact_score_total_under arithmetic/edge-type/fixture violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'exact_score_total_under' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'mutual_exclusion'
          AND qa.event_kind = 'exact_score'
          AND qb.event_kind = 'match_total_metric'
          AND qb.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NOT NULL
          AND qb.value_primary IS NOT NULL
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event,'')))) = lower(immutable_unaccent(btrim(coalesce(qb.canonical_event,''))))
          AND qa.participants = qb.participants
          AND qb.participants IS NOT NULL
          AND NOT (qb.canonical_subject = ANY(qb.participants))
          AND (qa.value_unit IS NULL OR qb.value_unit IS NULL
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          AND (qa.value_primary::numeric + qa.value_secondary::numeric) < qb.value_primary::numeric
        )
    `,
  },
  {
    name: 'edges: exact_score_btts zero-side/fixture violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'exact_score_btts' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'strict_implication'
          AND qa.event_kind = 'exact_score'
          AND qb.event_kind = 'both_teams_score'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NOT NULL
          AND qa.value_primary::numeric >= 1 AND qa.value_secondary::numeric >= 1
          AND qa.participants = qb.participants
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event,'')))) = lower(immutable_unaccent(btrim(coalesce(qb.canonical_event,''))))
        )
    `,
  },
  {
    name: 'edges: exact_score_draw pair-equality/draw-node/fixture violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'exact_score_draw' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'strict_implication'
          AND qa.event_kind = 'exact_score'
          AND qb.event_kind = 'match_winner'
          AND qa.value_primary IS NOT NULL AND qa.value_secondary IS NOT NULL
          AND qa.value_primary::numeric = qa.value_secondary::numeric
          AND lower(immutable_unaccent(btrim(qb.canonical_subject))) = 'draw'
          AND qa.participants = qb.participants
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event,'')))) = lower(immutable_unaccent(btrim(coalesce(qb.canonical_event,''))))
        )
    `,
  },
  {
    name: 'edges: numeric_threshold set-ladder monotonicity violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'numeric_threshold' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'strict_implication'
          AND qa.condition_direction = qb.condition_direction
          AND qa.condition_direction IN ('above','below')
          AND qa.value_primary IS NOT NULL AND qb.value_primary IS NOT NULL
          AND qa.value_unit IS NOT DISTINCT FROM qb.value_unit
          AND (
               (qa.condition_direction = 'above' AND qa.value_primary::numeric >= qb.value_primary::numeric)
            OR (qa.condition_direction = 'below' AND qa.value_primary::numeric <= qb.value_primary::numeric)
          )
          AND EXISTS (
            SELECT 1
            FROM outcome_set_slots s1
            JOIN outcome_set_slots s2 ON s2.set_id = s1.set_id
            JOIN outcome_sets os ON os.id = s1.set_id AND os.set_type = 'threshold_series'
            WHERE s1.question_id = e.antecedent_question_id
              AND s2.question_id = e.consequent_question_id
          )
        )
    `,
  },
  {
    name: 'edges: cross_question_mutex kind/subject-distinctness violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'mutual_exclusion'
          AND qa.event_kind = qb.event_kind
          AND qa.event_kind IN ('match_winner','championship_winner')
          AND lower(immutable_unaccent(btrim(qa.canonical_subject)))
              IS DISTINCT FROM lower(immutable_unaccent(btrim(qb.canonical_subject)))
        )
    `,
  },
  {
    name: 'edges: cross_question_mutex_spread team/favorite-convention violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex_spread' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'mutual_exclusion'
          AND qa.event_kind = 'match_spread' AND qb.event_kind = 'match_spread'
          AND array_length(qa.participants, 1) = 1 AND array_length(qb.participants, 1) = 1
          AND lower(immutable_unaccent(btrim(qa.participants[1])))
              IS DISTINCT FROM lower(immutable_unaccent(btrim(qb.participants[1])))
          AND lower(immutable_unaccent(btrim(coalesce(qa.canonical_event,'')))) = lower(immutable_unaccent(btrim(coalesce(qb.canonical_event,''))))
          AND qa.condition_direction = 'above' AND qb.condition_direction = 'above'
          AND qa.value_primary IS NOT NULL AND qa.value_primary::numeric > 0
          AND qb.value_primary IS NOT NULL AND qb.value_primary::numeric > 0
        )
    `,
  },
  {
    name: 'edges: cross_question_equiv field-contract violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_equiv' AND e.archived_at IS NULL
        AND (
             (qa.value_primary IS NOT NULL AND qb.value_primary IS NOT NULL
              AND qa.value_primary::numeric IS DISTINCT FROM qb.value_primary::numeric)
          OR (qa.value_secondary IS NOT NULL AND qb.value_secondary IS NOT NULL
              AND qa.value_secondary::numeric IS DISTINCT FROM qb.value_secondary::numeric)
          OR (qa.condition_direction IS NOT NULL AND qb.condition_direction IS NOT NULL
              AND qa.condition_direction IS DISTINCT FROM qb.condition_direction)
          OR (qa.condition_metric IS NOT NULL AND qb.condition_metric IS NOT NULL
              AND qa.condition_metric IS DISTINCT FROM qb.condition_metric)
          OR NOT (qa.value_unit IS NULL OR qb.value_unit IS NULL
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) || 's' = lower(btrim(qb.value_unit))
               OR lower(btrim(qa.value_unit)) = lower(btrim(qb.value_unit)) || 's')
          OR (qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
              AND CASE
                    WHEN qa.condition_date_precision = 'year' OR qb.condition_date_precision = 'year'
                      THEN left(qa.condition_date, 4) IS DISTINCT FROM left(qb.condition_date, 4)
                    WHEN qa.condition_date_precision = 'month' OR qb.condition_date_precision = 'month'
                      THEN left(qa.condition_date, 7) IS DISTINCT FROM left(qb.condition_date, 7)
                    ELSE left(qa.condition_date, 10) IS DISTINCT FROM left(qb.condition_date, 10)
                  END)
        )
    `,
  },
  {
    name: 'edges: cross_question_equiv between nodes of DIFFERENT outcome grain',
    sql: `
      WITH mg AS (${NODE_GRAIN_SQL}),
      node_grain AS (
        SELECT question_id, array_agg(DISTINCT grain ORDER BY grain) AS grains
        FROM mg
        WHERE grain IS NOT NULL
        GROUP BY question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN node_grain ga ON ga.question_id = e.antecedent_question_id
      JOIN node_grain gb ON gb.question_id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_equiv' AND e.archived_at IS NULL
        AND ga.grains IS DISTINCT FROM gb.grains
    `,
  },
  {
    name: 'edges: exact_score-derived between fixtures with reliable-date gap >= 3d (RC1 two-leg; known-red 5,568 pre-rebuild)',
    sql: `
      WITH nf AS (
        SELECT q.id AS qid, rm.end_date
        FROM questions q
        JOIN LATERAL (
          SELECT m.end_date FROM question_members qm JOIN markets m ON m.id = qm.market_id
          WHERE qm.question_id = q.id ORDER BY m.id LIMIT 1
        ) rm ON TRUE
        WHERE q.archived_at IS NULL
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN nf a ON a.qid = e.antecedent_question_id
      JOIN nf b ON b.qid = e.consequent_question_id
      WHERE e.pattern LIKE 'exact_score%' AND e.archived_at IS NULL
        AND a.end_date IS NOT NULL AND b.end_date IS NOT NULL
        AND abs(extract(epoch FROM (a.end_date - b.end_date))) * 1000 >= ${3 * 24 * 60 * 60 * 1000}
    `,
  },
  {
    name: `edges/outcome-sets/members: fixture pair with start instants >= ${FIXTURE_START_TOLERANCE_MS / 3_600_000}h apart (day-shift seam; known-red pre-rebuild)`,
    sql: `
      WITH nf AS (
        SELECT q.id AS qid, q.event_kind,
               ${fixtureStartInstantSql('x', '', {
                 platform: 'rm.platform',
                 conditionDate: 'pe.condition_date',
                 conditionDatePrecision: 'pe.condition_date_precision',
                 fixtureEndDate: 'rm.end_date',
               })} AS start_at
        FROM questions q
        JOIN LATERAL (
          SELECT m.platform, m.platform_event_id, m.end_date
          FROM question_members qm JOIN markets m ON m.id = qm.market_id
          WHERE qm.question_id = q.id ORDER BY m.id LIMIT 1
        ) rm ON TRUE
        LEFT JOIN platform_events pe
               ON pe.platform = rm.platform
              AND pe.platform_event_id = rm.platform_event_id
        WHERE q.archived_at IS NULL
          AND q.event_kind IN ${FIXTURE_START_KINDS_SQL}
      ),
      mem AS (
        -- member grain: normalization-stamp instants (ISO-prefix guarded so
        -- the cast can never throw on a drifted stamp)
        SELECT qm.question_id, qm.market_id,
               ${fixtureStartInstantSql('x', '::timestamptz', {
                 platform: 'm.platform',
                 conditionDate: 'n.condition_date',
                 conditionDatePrecision: 'n.condition_date_precision',
                 fixtureEndDate: 'm.end_date',
               })} AS start_at
        FROM question_members qm
        JOIN markets m ON m.id = qm.market_id
        JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
        JOIN llm_market_normalizations n ON n.market_id = m.id
        WHERE n.event_kind IN ${FIXTURE_START_KINDS_SQL}
          AND n.condition_date ~ '^\\d{4}-\\d{2}-\\d{2}'
      )
      SELECT (
        -- (i) cross-question edges, ANY pattern
        (SELECT count(*)::int
         FROM implication_edges e
         JOIN nf a ON a.qid = e.antecedent_question_id
         JOIN nf b ON b.qid = e.consequent_question_id
         WHERE e.archived_at IS NULL
           AND a.start_at IS NOT NULL AND b.start_at IS NOT NULL
           AND abs(extract(epoch FROM (a.start_at - b.start_at))) * 1000 >= ${FIXTURE_START_TOLERANCE_MS})
        -- (ii) two slots of one outcome set
        + (SELECT count(DISTINCT s1.set_id)::int
           FROM outcome_set_slots s1
           JOIN outcome_set_slots s2 ON s2.set_id = s1.set_id AND s2.question_id > s1.question_id
           JOIN nf a ON a.qid = s1.question_id
           JOIN nf b ON b.qid = s2.question_id
           WHERE a.start_at IS NOT NULL AND b.start_at IS NOT NULL
             AND abs(extract(epoch FROM (a.start_at - b.start_at))) * 1000 >= ${FIXTURE_START_TOLERANCE_MS})
        -- (iii) two member markets fused into one question
        + (SELECT count(DISTINCT m1.question_id)::int
           FROM mem m1
           JOIN mem m2 ON m2.question_id = m1.question_id AND m2.market_id > m1.market_id
           WHERE m1.start_at IS NOT NULL AND m2.start_at IS NOT NULL
             AND abs(extract(epoch FROM (m1.start_at - m2.start_at))) * 1000 >= ${FIXTURE_START_TOLERANCE_MS})
      ) AS n
    `,
  },
  {
    name: 'edges: cross-platform equivalence touching a wrong-subject kalshi merge (RC3 rotation; known-red 19 pre-rebuild)',
    sql: `
      WITH bad_q AS (
        SELECT DISTINCT q.id
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mmr ON mmr.market_id = m.id
        JOIN llm_market_normalizations n ON n.market_id = m.id
        WHERE q.archived_at IS NULL
          AND mmr.raw->>'yes_sub_title' IS NOT NULL
          AND q.canonical_subject IS NOT NULL AND n.canonical_subject IS NOT NULL
          AND lower(immutable_unaccent(btrim(n.canonical_subject)))
              IS DISTINCT FROM lower(immutable_unaccent(btrim(q.canonical_subject)))
          -- alias-tolerant: neither folded subject contains the other (token-run / abbrev)
          AND lower(immutable_unaccent(btrim(q.canonical_subject))) NOT LIKE
              '%' || lower(immutable_unaccent(btrim(n.canonical_subject))) || '%'
          AND lower(immutable_unaccent(btrim(n.canonical_subject))) NOT LIKE
              '%' || lower(immutable_unaccent(btrim(q.canonical_subject))) || '%'
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND (e.antecedent_question_id IN (SELECT id FROM bad_q)
          OR e.consequent_question_id IN (SELECT id FROM bad_q))
    `,
  },
  {
    name: 'questions: winner-node subject initial mismatches its <City> <letter> subtitle (RC2 same-city; known-red 21 pre-rebuild)',
    sql: `
      SELECT count(DISTINCT q.id)::int AS n
      FROM questions q
      JOIN question_members qm ON qm.question_id = q.id
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw mmr ON mmr.market_id = m.id
      WHERE q.archived_at IS NULL
        AND q.event_kind IN ('championship_winner','match_winner','election_outcome_winner')
        -- "<City...> <single capital letter>" subtitle (the truncated same-city form)
        AND mmr.raw->>'yes_sub_title' ~ '^[A-Z][a-z]+( [A-Z][a-z]+)* [A-Z]$'
        AND q.canonical_subject IS NOT NULL
        -- trailing subtitle letter vs the resolved subject's last-word initial
        AND upper(right(mmr.raw->>'yes_sub_title', 1))
            IS DISTINCT FROM upper(left(split_part(btrim(q.canonical_subject), ' ',
                array_length(string_to_array(btrim(q.canonical_subject), ' '), 1)), 1))
    `,
  },
  {
    name: 'edges: cross_ref_equiv fusing two kalshi siblings of one event_ticker (differing yes_sub_title)',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      WHERE e.pattern = 'cross_ref_equiv' AND e.archived_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM question_members qma JOIN markets ma ON ma.id = qma.market_id AND ma.platform = 'kalshi'
          JOIN market_metadata_raw ra ON ra.market_id = ma.id
          JOIN question_members qmb ON qmb.question_id = e.consequent_question_id
          JOIN markets mb ON mb.id = qmb.market_id AND mb.platform = 'kalshi'
          JOIN market_metadata_raw rb ON rb.market_id = mb.id
          WHERE qma.question_id = e.antecedent_question_id
            AND ra.raw->>'event_ticker' IS NOT NULL
            AND ra.raw->>'event_ticker' = rb.raw->>'event_ticker'
            AND (ra.raw->>'yes_sub_title') IS DISTINCT FROM (rb.raw->>'yes_sub_title')
        )
    `,
  },
  {
    name: 'edges: tier-A tournament cross-competition/team scoping violation',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN tournament_states ts ON ts.id = e.tournament_state_id
      JOIN questions qa ON qa.id = e.antecedent_question_id
      JOIN questions qb ON qb.id = e.consequent_question_id
      WHERE e.pattern IN ('sequential_stage','tournament_advancement','elimination_reach')
        AND e.archived_at IS NULL
        AND ts.format_spec->>'kalshiEventTickerPrefix' IS NOT NULL
        AND NOT (
          EXISTS (
            SELECT 1 FROM question_members qm
            JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
            JOIN market_metadata_raw mr ON mr.market_id = m.id
            WHERE qm.question_id = qa.id
              AND mr.raw->>'event_ticker' ILIKE (ts.format_spec->>'kalshiEventTickerPrefix') || '%'
          )
          AND EXISTS (
            SELECT 1 FROM question_members qm
            JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
            JOIN market_metadata_raw mr ON mr.market_id = m.id
            WHERE qm.question_id = qb.id
              AND mr.raw->>'event_ticker' ILIKE (ts.format_spec->>'kalshiEventTickerPrefix') || '%'
          )
          AND lower(immutable_unaccent(btrim(coalesce(qa.participants[1], qa.canonical_subject))))
              = lower(immutable_unaccent(btrim(coalesce(qb.participants[1], qb.canonical_subject))))
        )
    `,
  },
  {
    name: 'edges: elimination_stage_mutex direction/team/stage-order violation',
    sql: `
      WITH elim AS (
        SELECT q.id,
               min(lower(immutable_unaccent(btrim(q.participants[1])))) AS team,
               min(CASE lower(btrim(mr.raw->>'yes_sub_title'))
                     WHEN 'runner-up' THEN 1 WHEN 'semifinals' THEN 2
                     WHEN 'quarterfinals' THEN 3 WHEN 'round of 16' THEN 4
                     WHEN 'round of 32' THEN 5 WHEN 'group stage' THEN 6 END) AS rank
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCSTAGEOFELIM'
        GROUP BY q.id
        HAVING count(DISTINCT (lower(btrim(mr.raw->>'yes_sub_title')), q.participants[1])) = 1
      ),
      reach AS (
        SELECT q.id,
               min(lower(immutable_unaccent(btrim(q.participants[1])))) AS team,
               min(CASE
                     WHEN split_part(mr.raw->>'event_ticker', '-', 1) IN ('KXWCGROUPQUAL','KXWCGROUPWIN') THEN 5
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%FINAL' THEN 1
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%SEMI' THEN 2
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%QUAR' THEN 3
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%RO16' THEN 4 END) AS rank
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) IN ('KXWCGROUPQUAL','KXWCGROUPWIN','KXWCROUND')
        GROUP BY q.id
        HAVING count(DISTINCT (mr.raw->>'event_ticker', q.participants[1])) = 1
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      LEFT JOIN elim a ON a.id = e.antecedent_question_id
      LEFT JOIN reach c ON c.id = e.consequent_question_id
      WHERE e.pattern = 'elimination_stage_mutex' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'mutual_exclusion'
          AND e.tournament_state_id IS NOT NULL
          AND a.rank IS NOT NULL AND c.rank IS NOT NULL
          AND a.team IS NOT NULL AND a.team = c.team
          AND c.rank > 0 AND c.rank < a.rank
        )
    `,
  },
  {
    name: 'edges: group_champion_superset wrong-group/direction violation',
    sql: `
      WITH champ AS (
        SELECT DISTINCT q.id, lower(immutable_unaccent(btrim(q.participants[1]))) AS team
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCSTAGEOFELIM'
          AND lower(btrim(mr.raw->>'yes_sub_title')) = 'outright winner'
      ),
      member AS (
        SELECT lower(immutable_unaccent(btrim(q.participants[1]))) AS team,
               min(lower(regexp_replace(split_part(mr.raw->>'event_ticker', '-', 2), '^[0-9]+', ''))) AS grp
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCGROUPQUAL'
        GROUP BY 1
        HAVING count(DISTINCT lower(regexp_replace(split_part(mr.raw->>'event_ticker', '-', 2), '^[0-9]+', ''))) = 1
      ),
      agg AS (
        SELECT DISTINCT q.id,
               regexp_replace(lower(btrim(mr.raw->>'yes_sub_title')), '^group ', '') AS grp
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCGROUPWINNER'
          AND lower(btrim(mr.raw->>'yes_sub_title')) ~ '^group [a-z]$'
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      LEFT JOIN champ a ON a.id = e.antecedent_question_id
      LEFT JOIN agg c ON c.id = e.consequent_question_id
      LEFT JOIN member mb ON mb.team = a.team
      WHERE e.pattern = 'group_champion_superset' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'strict_implication'
          AND e.tournament_state_id IS NOT NULL
          AND a.id IS NOT NULL AND c.id IS NOT NULL
          AND mb.grp IS NOT NULL AND mb.grp = c.grp
        )
    `,
  },
  {
    name: 'edges: host_stage_mutex host/stage-order/settlement-scope violation',
    sql: `
      WITH reach AS (
        SELECT q.id,
               min(lower(immutable_unaccent(btrim(q.participants[1])))) AS team,
               min(CASE
                     WHEN split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCGROUPQUAL' THEN 5
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%FINAL' THEN 1
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%SEMI' THEN 2
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%QUAR' THEN 3
                     WHEN mr.raw->>'event_ticker' ILIKE 'KXWCROUND-%RO16' THEN 4 END) AS rank
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) IN ('KXWCGROUPQUAL','KXWCROUND')
        GROUP BY q.id
        HAVING count(DISTINCT (mr.raw->>'event_ticker', q.participants[1])) = 1
      ),
      cells AS (
        SELECT DISTINCT q.id,
               CASE lower(btrim(mr.raw->>'yes_sub_title'))
                 WHEN 'group stage' THEN 6 WHEN 'round of 32' THEN 5
                 WHEN 'round of 16' THEN 4 WHEN 'quarterfinals' THEN 3
                 WHEN 'semifinals' THEN 2 END AS rank,
               lower(btrim(mr.raw->>'yes_sub_title')) = 'winning the final' AS is_wf
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCSTAGE'
      ),
      champ AS (
        SELECT DISTINCT q.id, lower(immutable_unaccent(btrim(q.participants[1]))) AS team
        FROM questions q
        JOIN question_members qm ON qm.question_id = q.id
        JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
        JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCSTAGEOFELIM'
          AND lower(btrim(mr.raw->>'yes_sub_title')) = 'outright winner'
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      LEFT JOIN reach r ON r.id = e.antecedent_question_id
      LEFT JOIN champ a ON a.id = e.antecedent_question_id
      LEFT JOIN cells c ON c.id = e.consequent_question_id
      WHERE e.pattern = 'host_stage_mutex' AND e.archived_at IS NULL
        AND NOT (
          e.edge_type = 'mutual_exclusion'
          AND e.tournament_state_id IS NOT NULL
          AND (
            (r.rank IS NOT NULL AND r.team IN ('usa','mexico','canada')
             AND c.rank IS NOT NULL AND c.rank > r.rank
             AND NOT (r.rank = 1 AND c.rank = 2))
            OR
            (a.id IS NOT NULL AND a.team NOT IN ('usa','mexico','canada')
             AND c.is_wf)
          )
        )
    `,
  },
  {
    name: 'outcome-sets: tournament_champion exhaustive or non-champion slot',
    sql: `
      SELECT (
        (SELECT count(*) FROM outcome_sets os
          WHERE os.source = 'tournament_champion' AND os.is_exhaustive)
        +
        (SELECT count(*)
           FROM outcome_sets os
           JOIN outcome_set_slots oss ON oss.set_id = os.id
          WHERE os.source = 'tournament_champion'
            AND os.event_identity IN (
              SELECT 'tournament-champion:' || ts.id FROM tournament_states ts
              WHERE ts.canonical = 'FIFA World Cup')
            AND NOT EXISTS (
              SELECT 1
              FROM question_members qm
              JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
              JOIN market_metadata_raw mr ON mr.market_id = m.id
              WHERE qm.question_id = oss.question_id
                AND split_part(mr.raw->>'event_ticker', '-', 1) = 'KXWCSTAGEOFELIM'
                AND lower(btrim(mr.raw->>'yes_sub_title')) = 'outright winner'))
      )::int AS n
    `,
  },
  {
    name: 'normalizations: integer-grain threshold drift OR strict/inclusive fake-merge (threshold-canon; ARM1 documented-red-until-reflush)',
    sql: `
      SELECT (
        -- arm 1: members of one question split half-vs-integer (0.5 gap) on
        -- the same integer-grain unit + 'above'
        (
          SELECT count(DISTINCT qm1.question_id)
          FROM question_members qm1
          JOIN llm_market_normalizations n1 ON n1.market_id = qm1.market_id
          JOIN question_members qm2 ON qm2.question_id = qm1.question_id AND qm2.market_id > qm1.market_id
          JOIN llm_market_normalizations n2 ON n2.market_id = qm2.market_id
          WHERE n1.condition_direction = 'above' AND n2.condition_direction = 'above'
            AND n1.value_primary IS NOT NULL AND n2.value_primary IS NOT NULL
            AND lower(btrim(n1.value_unit)) = lower(btrim(n2.value_unit))
            AND lower(btrim(n1.value_unit)) IN ${INTEGER_GRAIN_UNITS_SQL}
            AND abs(n1.value_primary::numeric - n2.value_primary::numeric) = 0.5
        )
        +
        -- arm 2: members folding a strict >N integer-floor onto an inclusive >=N
        -- integer-floor of the same integer — different real half-lines.
        (
          WITH mem AS (
            SELECT qm.question_id AS qid, lower(btrim(n.value_unit)) AS unit,
                   (mmr.raw->>'floor_strike')::numeric AS floor,
                   mmr.raw->>'strike_type' AS st
            FROM question_members qm
            JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
            JOIN market_metadata_raw mmr ON mmr.market_id = m.id
            JOIN llm_market_normalizations n ON n.market_id = m.id
            WHERE n.condition_direction = 'above'
              AND lower(btrim(n.value_unit)) IN ${INTEGER_GRAIN_UNITS_SQL}
              AND mmr.raw->>'floor_strike' ~ '^[0-9]+$'
          )
          SELECT count(DISTINCT m1.qid)
          FROM mem m1
          JOIN mem m2 ON m2.qid = m1.qid AND m2.unit = m1.unit AND m2.floor = m1.floor
            AND m1.st = 'greater' AND m2.st = 'greater_or_equal'
        )
      )::int AS n
    `,
  },
  {
    name: 'edges+sets: slice-vs-slice fusion (two KNOWN-differing metric_scope markets)',
    sql: `
      SELECT (
        -- ARM 1: live edges across two known-differing slices (containment exempt)
        (
          SELECT count(*)
          FROM implication_edges e
          JOIN questions qa ON qa.id = e.antecedent_question_id
          JOIN questions qb ON qb.id = e.consequent_question_id
          WHERE e.archived_at IS NULL
            AND e.pattern NOT IN ('team_game_total_over', 'slice_game_total_over')
            AND qa.metric_scope IS NOT NULL
            AND qb.metric_scope IS NOT NULL
            AND qa.metric_scope <> qb.metric_scope
        )
        +
        -- ARM 2: outcome_sets whose slots span >=2 distinct known slices
        (
          SELECT count(*)
          FROM (
            SELECT s.set_id
            FROM outcome_set_slots s
            JOIN questions q ON q.id = s.question_id
            WHERE q.metric_scope IS NOT NULL
            GROUP BY s.set_id
            HAVING count(DISTINCT q.metric_scope) > 1
          ) mixed_sets
        )
      )::int AS n
    `,
  },
  {
    name: 'edges/sets: equivalence or shared Σ=1 outcome set across KNOWN-DIFFERING resolution oracles (G_O; ARM1 documented-red-until-mig-095)',
    sql: `
      WITH qrs AS (
        -- question-grain UNANIMOUS-KNOWN aggregation (the
        -- questionResolutionSourceCte convention): exactly one DISTINCT non-NULL
        -- member authority → that value; zero or conflicting members → NULL.
        SELECT qm.question_id,
               CASE WHEN count(DISTINCT nz.resolution_source) = 1
                    THEN min(nz.resolution_source) END AS rs
        FROM question_members qm
        JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id
        WHERE nz.resolution_source IS NOT NULL
        GROUP BY qm.question_id
      )
      SELECT (
        -- arm 1: cross-oracle equivalence edges.
        (
          SELECT count(*)
          FROM implication_edges e
          JOIN qrs ra ON ra.question_id = e.antecedent_question_id
          JOIN qrs rb ON rb.question_id = e.consequent_question_id
          WHERE e.edge_type = 'equivalence'
            AND e.archived_at IS NULL
            AND ${oraclesKnownToDifferSql('ra.rs', 'rb.rs')}
        )
        +
        -- arm 2: exhaustive (Σ=1) outcome sets spanning >=2 known authorities
        (
          SELECT count(*)
          FROM (
            SELECT s.set_id
            FROM outcome_set_slots s
            JOIN outcome_sets os ON os.id = s.set_id AND os.is_exhaustive
            JOIN qrs r ON r.question_id = s.question_id
            WHERE ${discriminatingOracleSql('r.rs')} IS NOT NULL
            GROUP BY s.set_id
            HAVING count(DISTINCT ${discriminatingOracleSql('r.rs')}) > 1
          ) cross_oracle_sets
        )
      )::int AS n
    `,
  },
  {
    name: 'outcome-sets: threshold_series ladder rungs collide / chain not strictly nested (documented-red 292 until mig 099)',
    sql: `
      SELECT (
        -- arm 1: >=2 live valued rungs of one ladder on one stamped value.
        (
          SELECT count(*)
          FROM (
            SELECT s.set_id
            FROM outcome_set_slots s
            JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'threshold_series'
            JOIN questions q ON q.id = s.question_id
                            AND q.archived_at IS NULL AND q.member_count > 0
            WHERE q.value_primary IS NOT NULL
            GROUP BY s.set_id
            HAVING count(*) > count(DISTINCT q.value_primary::numeric)
          ) collided_ladders
        )
        +
        -- arm 2: a consecutive-ordinal pair that is not strictly nested.
        (
          SELECT count(DISTINCT t.set_id)
          FROM (
            SELECT s.set_id,
                   q.condition_direction AS dir,
                   q.value_primary::numeric AS v,
                   lead(q.condition_direction)
                     OVER (PARTITION BY s.set_id ORDER BY s.slot_ordinal) AS ndir,
                   lead(q.value_primary::numeric)
                     OVER (PARTITION BY s.set_id ORDER BY s.slot_ordinal) AS nv
            FROM outcome_set_slots s
            JOIN outcome_sets os ON os.id = s.set_id AND os.set_type = 'threshold_series'
            JOIN questions q ON q.id = s.question_id
                            AND q.archived_at IS NULL AND q.member_count > 0
            WHERE q.value_primary IS NOT NULL
          ) t
          WHERE t.nv IS NOT NULL
            AND NOT (
              t.ndir = t.dir
              AND (
                (t.dir = 'above' AND t.v > t.nv)
                OR (t.dir = 'below' AND t.v < t.nv)
              )
            )
        )
      )::int AS n
    `,
  },
  {
    name: 'edges/members: equivalence or shared question node across KNOWN-DIFFERING resolution_scope (FT/ET)',
    sql: `
      WITH node_scope AS (
        -- member-grain unanimous-known aggregation. Deliberately not
        -- questions.resolution_scope: that column is mixed→NULL, so a node fusing
        -- a narrow and a wide market reads "unknown" there.
        SELECT qm.question_id,
               count(DISTINCT m.resolution_scope) FILTER (
                 WHERE m.resolution_scope IS NOT NULL
                   AND m.resolution_scope <> 'unspecified') AS n_known,
               min(m.resolution_scope) FILTER (
                 WHERE m.resolution_scope IS NOT NULL
                   AND m.resolution_scope <> 'unspecified') AS scope
        FROM question_members qm
        JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
        JOIN markets m   ON m.id = qm.market_id
        GROUP BY qm.question_id
      )
      SELECT (
        -- arm 1: one node, two known-differing settlement bases.
        (SELECT count(*) FROM node_scope WHERE n_known > 1)
        +
        -- arm 2: an equivalence across two unanimously-scoped, differing nodes.
        (
          SELECT count(*)
          FROM implication_edges e
          JOIN node_scope a ON a.question_id = e.antecedent_question_id AND a.n_known = 1
          JOIN node_scope b ON b.question_id = e.consequent_question_id AND b.n_known = 1
          WHERE e.edge_type = 'equivalence'
            AND e.archived_at IS NULL
            AND a.scope <> b.scope
        )
      )::int AS n
    `,
  },
  {
    name: 'edges: strict_implication oriented WIDE ⇒ NARROW on resolution_scope (FT/ET orientation)',
    sql: `
      WITH node_scope AS (
        SELECT qm.question_id,
               count(DISTINCT m.resolution_scope) FILTER (
                 WHERE m.resolution_scope IN ('regulation', 'incl_overtime')) AS n_known,
               min(m.resolution_scope) FILTER (
                 WHERE m.resolution_scope IN ('regulation', 'incl_overtime')) AS scope
        FROM question_members qm
        JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
        JOIN markets m   ON m.id = qm.market_id
        GROUP BY qm.question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN node_scope a ON a.question_id = e.antecedent_question_id AND a.n_known = 1
      JOIN node_scope b ON b.question_id = e.consequent_question_id AND b.n_known = 1
      WHERE e.edge_type = 'strict_implication'
        AND e.archived_at IS NULL
        -- the wrong half of the containment order: wide antecedent, narrow consequent
        AND a.scope = 'incl_overtime'
        AND b.scope = 'regulation'
    `,
  },
];

/** REPORT rows: informational counts printed alongside the asserts; never counted as violations. */
const REPORT_COUNTS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: 'REPORT advisory rows holding slots (informational)',
    sql: `
      SELECT count(*)::int AS n
      FROM implication_edges
      WHERE deterministic = FALSE AND archived_at IS NULL
    `,
  },
  {
    name: 'REPORT equivalence edges with known differing resolution_source (informational)',
    sql: `
      WITH qrs AS (
        SELECT qm.question_id,
               CASE WHEN count(DISTINCT nz.resolution_source) = 1
                    THEN min(nz.resolution_source) END AS rs
        FROM question_members qm
        JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id
        WHERE nz.resolution_source IS NOT NULL
        GROUP BY qm.question_id
      )
      SELECT count(*)::int AS n
      FROM implication_edges e
      JOIN qrs ra ON ra.question_id = e.antecedent_question_id
      JOIN qrs rb ON rb.question_id = e.consequent_question_id
      WHERE e.edge_type = 'equivalence' AND e.archived_at IS NULL
        AND ra.rs IS DISTINCT FROM rb.rs
    `,
  },
];

/** Diffs the two DB pattern CHECKs against the imported `EDGE_PATTERNS`, in both directions. */
async function edgePatternsParity(): Promise<AssertResult> {
  const name = 'edges: EDGE_PATTERNS ↔ pattern CHECK parity (both directions, both constraints)';
  try {
    const rows = await query<{ conname: string; def: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'implication_edges'::regclass
        AND conname IN ('chk_edges_pattern','implication_edges_pattern_check')`);
    if (rows.length !== 2) {
      return { name, violations: -1, detail: `expected 2 pattern CHECKs, found ${rows.length}` };
    }
    const parse = (def: string): Set<string> => {
      const out = new Set<string>();
      for (const m of def.matchAll(/'(\{[a-z0-9_,]+\})'/g)) {
        for (const tok of m[1]!.slice(1, -1).split(',')) if (tok) out.add(tok);
      }
      for (const m of def.matchAll(/'([a-z0-9_]+)'/g)) out.add(m[1]!);
      return out;
    };
    const sets = rows.map((r) => ({ conname: r.conname, labels: parse(r.def) }));
    const types = new Set<string>(EDGE_PATTERNS);
    const drift: string[] = [];
    for (const s of sets) {
      for (const lbl of s.labels) if (!types.has(lbl)) drift.push(`${s.conname} has '${lbl}' missing from EDGE_PATTERNS`);
    }
    for (const lbl of types) {
      for (const s of sets) if (!s.labels.has(lbl)) drift.push(`EDGE_PATTERNS '${lbl}' missing from ${s.conname}`);
    }
    for (const lbl of sets[0].labels) if (!sets[1].labels.has(lbl)) drift.push(`lock-step drift: '${lbl}' only in ${sets[0].conname}`);
    for (const lbl of sets[1].labels) if (!sets[0].labels.has(lbl)) drift.push(`lock-step drift: '${lbl}' only in ${sets[1].conname}`);
    return { name, violations: drift.length, ...(drift.length ? { detail: drift.slice(0, 5).join('; ') } : {}) };
  } catch (e) {
    return { name, violations: -1, detail: (e as Error).message.slice(0, 200) };
  }
}

/**
 * KB alias-collision lints against the deny-list (db/entity/alias-deny-list.ts); KB state stays untouched.
 */
async function kbAliasLints(): Promise<{ hard: AssertResult[]; reports: AssertResult[] }> {
  const hard: AssertResult[] = [];
  const reports: AssertResult[] = [];
  try {
    const rows = await query<{ alias_fold: string; id: number; canonical: string; canonical_fold: string; type: string; sport: string | null }>(`
      SELECT lower(immutable_unaccent(a.alias)) AS alias_fold,
             ke.id, ke.canonical,
             lower(immutable_unaccent(ke.canonical)) AS canonical_fold,
             ke.type, ke.sport_canonical AS sport
      FROM known_entities ke
      CROSS JOIN LATERAL jsonb_array_elements_text(ke.aliases) AS a(alias)`);

    const liveKeys = new Set(rows.map((r) => `${r.type}␟${r.canonical_fold}`));
    const stale = ALIAS_DENY_LIST.filter((e) => !liveKeys.has(`${e.type}␟${e.canonicalFold}`));
    hard.push({
      name: 'kb: deny-list entry stale (no live (type, canonical) target row)',
      violations: stale.length,
      ...(stale.length ? { detail: stale.map((e) => `${e.type}/${e.canonicalFold}`).join('; ') } : {}),
    });

    const selfContradictions: string[] = [];
    for (const e of ALIAS_DENY_LIST) {
      for (const alias of e.denyAliasFolds) {
        if (alias === e.canonicalFold) selfContradictions.push(`${e.type}/${e.canonicalFold} denies its own canonical '${alias}'`);
      }
      for (const r of rows) {
        if (r.type === e.type && e.denyAliasFolds.includes(r.canonical_fold) && e.canonicalFold !== r.canonical_fold) {
          selfContradictions.push(`row #${r.id} canonical '${r.canonical}' equals denied alias (entry ${e.type}/${e.canonicalFold})`);
          break;
        }
      }
    }
    hard.push({
      name: 'kb: deny-list contradicts a canonical (denied alias became a canonical)',
      violations: selfContradictions.length,
      ...(selfContradictions.length ? { detail: selfContradictions.slice(0, 3).join('; ') } : {}),
    });

    const byAlias = new Map<string, Map<number, { canonical: string; sport: string | null }>>();
    for (const r of rows) {
      const m = byAlias.get(r.alias_fold) ?? new Map();
      m.set(r.id, { canonical: r.canonical, sport: r.sport });
      byAlias.set(r.alias_fold, m);
    }
    let collidingFolds = 0;
    let slots = 0;
    let incompatibleGroups = 0;
    for (const [, m] of byAlias) {
      if (m.size < 2) continue;
      collidingFolds++;
      slots += m.size;
      const ents = [...m.values()];
      let bad = false;
      outer: for (let i = 0; i < ents.length; i++) {
        for (let j = i + 1; j < ents.length; j++) {
          const a = ents[i], b = ents[j];
          if (a.canonical.toLowerCase() === b.canonical.toLowerCase()) continue;
          if (a.sport == null || b.sport == null) continue;
          if (!areSportsCompatible(a.sport, b.sport)) { bad = true; break outer; }
        }
      }
      if (bad) incompatibleGroups++;
    }
    reports.push({
      name: 'REPORT kb alias collisions: colliding folds (baseline 471 @2026-06-12, informational)',
      violations: collidingFolds,
    });
    reports.push({
      name: 'REPORT kb alias collisions: occupied slots (baseline 1,067 @2026-06-12, informational)',
      violations: slots,
    });
    reports.push({
      name: 'REPORT kb alias collisions across incompatible sports (baseline 103 @2026-06-12, informational)',
      violations: incompatibleGroups,
    });
  } catch (e) {
    hard.push({ name: 'kb: alias deny-list lints', violations: -1, detail: (e as Error).message.slice(0, 200) });
  }
  return { hard, reports };
}

async function seededLeagueDupCollisions(): Promise<AssertResult> {
  const name = 'kb leagues: proven-same dup of a SEEDED league/competition still unfolded (dedup-leagues guard)';
  try {
    const { LEAGUES, COMPETITIONS } = await import('../db/seed-entity-kb.js');
    const fold = (s: string): string =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const COUNTRY_FOLD: Record<string, string> = {
      gb: 'gb', england: 'gb', 'united kingdom': 'gb', uk: 'gb', wales: 'gb', scotland: 'scotland',
      in: 'in', india: 'in', ru: 'ru', russia: 'ru', es: 'es', spain: 'es', de: 'de', germany: 'de',
      it: 'it', italy: 'it', fr: 'fr', france: 'fr', us: 'us', usa: 'us', 'united states': 'us',
      br: 'br', brazil: 'br', cz: 'cz', 'czech republic': 'cz', czechia: 'cz', kr: 'kr', 'south korea': 'kr',
      sa: 'sa', 'saudi arabia': 'sa', ar: 'ar', argentina: 'ar', eg: 'eg', egypt: 'eg', jp: 'jp', japan: 'jp',
      nl: 'nl', netherlands: 'nl', pt: 'pt', portugal: 'pt', at: 'at', austria: 'at', be: 'be', belgium: 'be',
      tr: 'tr', turkey: 'tr', hr: 'hr', croatia: 'hr', ca: 'ca', canada: 'ca', au: 'au', australia: 'au',
    };
    const foldCountry = (c: string | null | undefined): string | null => {
      if (c == null) return null;
      const k = c.trim().toLowerCase();
      return k ? (COUNTRY_FOLD[k] ?? k) : null;
    };
    const countriesCompatible = (a: string | null, b: string | null): boolean => {
      const fa = foldCountry(a), fb = foldCountry(b);
      return fa == null || fb == null || fa === fb;
    };

    const rows = await query<{
      id: number; canonical: string; sport_canonical: string | null; country: string | null;
      cross_league: boolean | null; aliases: unknown;
    }>(
      `SELECT id, canonical, sport_canonical, metadata->>'country' AS country,
              (metadata->>'cross_league')::bool AS cross_league, aliases
         FROM known_entities WHERE type IN ('league','competition')`,
    );
    const live = rows.map((r) => {
      const a: string[] = Array.isArray(r.aliases) ? (r.aliases as string[]) : JSON.parse((r.aliases as string) || '[]');
      return {
        id: r.id, canonical: r.canonical, sport: r.sport_canonical, country: r.country,
        cross_league: r.cross_league == null ? null : r.cross_league === true,
        folds: new Set<string>([fold(r.canonical), ...a.map(fold)]),
      };
    });

    const seeds = [...LEAGUES, ...COMPETITIONS];
    const seedCanonFolds = new Set(seeds.map((s) => fold(s.canonical)));
    const violators = new Set<number>();
    const detail: string[] = [];

    for (const s of seeds) {
      const sCanonFold = fold(s.canonical);
      const sFolds = new Set<string>([sCanonFold, ...s.aliases.map(fold)]);
      const sSport = (s.metadata.sport_canonical as string | undefined) ?? null;
      const sCountry = (s.metadata.country as string | undefined) ?? null;
      const sCross = s.metadata.cross_league === true;
      const anchor = live.find((r) =>
        fold(r.canonical) === sCanonFold &&
        areSportsCompatible(sSport, r.sport) &&
        countriesCompatible(sCountry, r.country));
      if (!anchor) continue;
      for (const cand of live) {
        if (cand.id === anchor.id) continue;
        let shares = false;
        for (const f of cand.folds) if (sFolds.has(f)) { shares = true; break; }
        if (!shares) continue;
        const candCanonFold = fold(cand.canonical);
        if (candCanonFold !== sCanonFold && seedCanonFolds.has(candCanonFold)) continue; // other seed's anchor
        if (!areSportsCompatible(sSport, cand.sport)) continue;
        if (!countriesCompatible(sCountry, cand.country)) continue;
        if (cand.cross_league != null && sCross !== cand.cross_league) continue;
        if (!violators.has(cand.id)) {
          violators.add(cand.id);
          if (detail.length < 5) detail.push(`id=${cand.id} "${cand.canonical}" ~ seed "${s.canonical}"`);
        }
      }
    }
    return { name, violations: violators.size, ...(violators.size ? { detail: detail.join('; ') } : {}) };
  } catch (e) {
    return { name, violations: -1, detail: (e as Error).message.slice(0, 200) };
  }
}

async function main(): Promise<void> {
  const results: AssertResult[] = [];

  results.push(await edgePatternsParity());

  try {
    const tier = await query<Record<string, number>>(buildStructureTierViolationsSql());
    for (const [k, v] of Object.entries(tier[0] ?? {})) {
      results.push({ name: `equiv structure tier: ${k}`, violations: Number(v) });
    }
  } catch (e) {
    results.push({ name: 'equiv structure tier', violations: -1, detail: (e as Error).message.slice(0, 200) });
  }

  for (const a of COUNT_ASSERTS) {
    try {
      const r = await query<{ n: number }>(a.sql);
      results.push({ name: a.name, violations: Number(r[0]?.n ?? 0) });
    } catch (e) {
      results.push({ name: a.name, violations: -1, detail: (e as Error).message.slice(0, 200) });
    }
  }

  const aliasLints = await kbAliasLints();
  results.push(...aliasLints.hard);

  results.push(await seededLeagueDupCollisions());

  const reports: AssertResult[] = [...aliasLints.reports];
  for (const r of REPORT_COUNTS) {
    try {
      const rows = await query<{ n: number }>(r.sql);
      reports.push({ name: r.name, violations: Number(rows[0]?.n ?? 0) });
    } catch (e) {
      reports.push({ name: r.name, violations: -1, detail: (e as Error).message.slice(0, 200) });
    }
  }

  const bad = results.filter((r) => r.violations !== 0);
  console.table(results.map((r) => ({ assert: r.name, violations: r.violations, ...(r.detail ? { detail: r.detail } : {}) })));
  if (reports.length > 0) {
    console.log('\nREPORT rows (informational — never violations):');
    console.table(reports.map((r) => ({ report: r.name, count: r.violations, ...(r.detail ? { detail: r.detail } : {}) })));
  }
  if (bad.length > 0) {
    console.error(`\nFAIL: ${bad.length} assert(s) violated (or errored). A soundness class has regressed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK: all ${results.length} soundness asserts green.`);
  }
}

try {
  await main();
} finally {
  await endPool();
}
