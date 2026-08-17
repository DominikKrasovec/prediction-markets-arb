// before-date-chain — Kalshi "Before <date>" deadline-ladder chain edges (Stage 4).
// Within one Kalshi platform_event, "before D1" implies "before D2" for D1 < D2
// (rung label = yes_sub_title). Raw-driven: derives the deadline from
// market_metadata_raw, scoped to one platform_event. Emits adjacent-rung pairs
// only (dense_rank r -> r+1); the solver composes transitivity.
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-before-date-chain');

// Pure-TS reference implementation, mirrors the SQL 1:1 for unit tests.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function monthTokenToNumber(tok: string | null | undefined): number | null {
  if (!tok) return null;
  return MONTHS[tok.slice(0, 3).toLowerCase()] ?? null;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function validDate(y: number | null, m: number | null, d: number | null): { y: number; m: number; d: number } | null {
  if (y == null || m == null || d == null) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

// Anchored rung-label forms — fully anchored so the post-strip residue is '' by construction.
const YST_FULL_RX = /^before ([a-z]{3,9})\.? ([0-9]{1,2}),? ([0-9]{4})$/i;
const YST_MONTH_RX = /^before ([a-z]{3,9})\.? ([0-9]{4})$/i;
const YST_YEAR_RX = /^before ([0-9]{4})$/i;
const CS_FULL_RX = /^(?:before )?([a-z]{3,9})\.? ([0-9]{1,2}),? ([0-9]{4})$/i;
const CS_ISO_RX = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/;

// Priority: yes_sub_title first, then custom_strike. Mirrors the SQL `extracted`/`parsed` CTEs — keep in sync.
export function parseBeforeDeadline(
  yesSubTitle: string | null | undefined,
  csDate?: string | null,
): { y: number; m: number; d: number } | null {
  const yst = (yesSubTitle ?? '').replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  if ((m = YST_FULL_RX.exec(yst))) {
    return validDate(parseInt(m[3], 10), monthTokenToNumber(m[1]), parseInt(m[2], 10));
  }
  if ((m = YST_MONTH_RX.exec(yst))) {
    return validDate(parseInt(m[2], 10), monthTokenToNumber(m[1]), 1);
  }
  if ((m = YST_YEAR_RX.exec(yst))) {
    return validDate(parseInt(m[1], 10), 1, 1);
  }
  const cs = (csDate ?? '').trim();
  if ((m = CS_FULL_RX.exec(cs))) {
    return validDate(parseInt(m[3], 10), monthTokenToNumber(m[1]), parseInt(m[2], 10));
  }
  if ((m = CS_ISO_RX.exec(cs))) {
    return validDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }
  return null;
}

export function titleAfterPhrase(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = /\bafter +[a-z]{3,9}\.? +[0-9]{1,2},? +[0-9]{4}/i.exec(title);
  return m ? m[0].toLowerCase() : null;
}

function monthNoSql(tokExpr: string): string {
  return `(CASE lower(left(${tokExpr}, 3))
      WHEN 'jan' THEN 1 WHEN 'feb' THEN 2 WHEN 'mar' THEN 3 WHEN 'apr' THEN 4
      WHEN 'may' THEN 5 WHEN 'jun' THEN 6 WHEN 'jul' THEN 7 WHEN 'aug' THEN 8
      WHEN 'sep' THEN 9 WHEN 'oct' THEN 10 WHEN 'nov' THEN 11 WHEN 'dec' THEN 12
      ELSE NULL END)`;
}

const YST_FULL = `yst ~* '^before [a-z]{3,9}\\.? [0-9]{1,2},? [0-9]{4}$'`;
const YST_MONTH = `yst ~* '^before [a-z]{3,9}\\.? [0-9]{4}$'`;
const YST_YEAR = `yst ~* '^before [0-9]{4}$'`;
const CS_FULL = `cs_date ~* '^(before )?[a-z]{3,9}\\.? [0-9]{1,2},? [0-9]{4}$'`;
const CS_ISO = `cs_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;

// Exported separately so the read-only dry-run probe can count pairs without
// executing the INSERT. Ends with the `chain_pairs` CTE.
export function beforeDateRungsCtesSql(): string {
  return `before_markets AS (
      SELECT
        qm.question_id,
        m.id                 AS market_id,
        m.platform_event_id  AS pe,
        -- rung label, whitespace-normalized
        lower(btrim(regexp_replace(mr.raw->>'yes_sub_title', '[[:space:]]+', ' ', 'g'))) AS yst,
        -- custom_strike date fallback
        btrim(coalesce(mr.raw->'custom_strike'->>'before', mr.raw->'custom_strike'->>'Date', '')) AS cs_date,
        -- non-date custom_strike payload = subject discriminator
        CASE WHEN jsonb_typeof(mr.raw->'custom_strike') = 'object'
             THEN (mr.raw->'custom_strike') - 'Date' - 'before'
             ELSE NULL END AS cs_residual,
        -- dated lower-bound phrase (windowed-latch discriminator)
        lower(substring(m.title from '(?i)\\mafter +[a-z]{3,9}\\.? +[0-9]{1,2},? +[0-9]{4}')) AS after_phrase
      FROM markets m
      JOIN market_metadata_raw mr ON mr.market_id = m.id
      JOIN question_members qm ON qm.market_id = m.id
      JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
      WHERE m.platform = 'kalshi'
        AND mr.raw->>'yes_sub_title' ~* '^[[:space:]]*before '
    ),
    -- (yy,mm,dd) extraction, yes_sub_title first then custom_strike; unparseable → NULLs.
    extracted AS (
      SELECT *,
        CASE
          WHEN ${YST_FULL}  THEN (substring(yst from '([0-9]{4})$'))::int
          WHEN ${YST_MONTH} THEN (substring(yst from '([0-9]{4})$'))::int
          WHEN ${YST_YEAR}  THEN (substring(yst from '([0-9]{4})$'))::int
          WHEN ${CS_FULL}   THEN (substring(cs_date from '([0-9]{4})$'))::int
          WHEN ${CS_ISO}    THEN left(cs_date, 4)::int
        END AS yy,
        CASE
          WHEN ${YST_FULL}  THEN ${monthNoSql(`substring(yst from '^before ([a-z]{3,9})')`)}
          WHEN ${YST_MONTH} THEN ${monthNoSql(`substring(yst from '^before ([a-z]{3,9})')`)}
          WHEN ${YST_YEAR}  THEN 1
          WHEN ${CS_FULL}   THEN ${monthNoSql(`substring(cs_date from '(?i)^(?:before )?([a-z]{3,9})')`)}
          WHEN ${CS_ISO}    THEN (substring(cs_date from '^[0-9]{4}-([0-9]{2})'))::int
        END AS mm,
        CASE
          WHEN ${YST_FULL}  THEN (substring(yst from '^before [a-z]{3,9}\\.? ([0-9]{1,2})'))::int
          WHEN ${YST_MONTH} THEN 1
          WHEN ${YST_YEAR}  THEN 1
          WHEN ${CS_FULL}   THEN (substring(cs_date from '(?i)^(?:before )?[a-z]{3,9}\\.? ([0-9]{1,2})'))::int
          WHEN ${CS_ISO}    THEN (substring(cs_date from '^[0-9]{4}-[0-9]{2}-([0-9]{2})'))::int
        END AS dd
      FROM before_markets
    ),
    -- calendar-validity guard before make_date (which raises on Feb 30 etc.)
    parsed AS (
      SELECT *,
        CASE WHEN yy BETWEEN 1900 AND 2200 AND mm BETWEEN 1 AND 12
              AND dd >= 1
              AND dd <= CASE
                          WHEN mm = 2 THEN CASE WHEN yy % 4 = 0 AND (yy % 100 <> 0 OR yy % 400 = 0) THEN 29 ELSE 28 END
                          WHEN mm IN (4, 6, 9, 11) THEN 30
                          ELSE 31
                        END
             THEN make_date(yy, mm, dd)
        END AS deadline
      FROM extracted
    ),
    -- over-merge disqualifier: disagreeing member deadlines = two rungs fused upstream, no edges
    bad_questions AS (
      SELECT question_id FROM parsed
      WHERE deadline IS NOT NULL
      GROUP BY question_id
      HAVING count(DISTINCT deadline) > 1
    ),
    node_rungs AS (
      SELECT pe, after_phrase, cs_residual, question_id, min(deadline) AS deadline
      FROM parsed
      WHERE deadline IS NOT NULL
        AND question_id NOT IN (SELECT question_id FROM bad_questions)
      GROUP BY pe, after_phrase, cs_residual, question_id
    ),
    -- dense_rank: equal deadlines share a rank (equivalence's job, not implication)
    ranked AS (
      SELECT *,
        dense_rank() OVER (PARTITION BY pe, after_phrase, cs_residual ORDER BY deadline) AS rk
      FROM node_rungs
    ),
    chain_pairs AS (
      SELECT a.question_id AS antecedent_question_id,
             b.question_id AS consequent_question_id,
             a.pe, a.deadline AS d1, b.deadline AS d2
      FROM ranked a
      JOIN ranked b
        ON b.pe = a.pe
       AND b.after_phrase IS NOT DISTINCT FROM a.after_phrase
       AND b.cs_residual  IS NOT DISTINCT FROM a.cs_residual
       AND b.rk = a.rk + 1
       AND b.question_id <> a.question_id
    )`;
}

export function buildBeforeDateChainEdgesSql(): string {
  return `
    WITH ${beforeDateRungsCtesSql()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'date_implication')},
             'before-date chain: before D1 ⟹ before D2 (adjacent deadlines, same Kalshi event latch)'
      FROM chain_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildBeforeDateChainEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildBeforeDateChainEdgesSql());
  log.info('before-date-chain: ' + n + ' edges');
  return n;
}
