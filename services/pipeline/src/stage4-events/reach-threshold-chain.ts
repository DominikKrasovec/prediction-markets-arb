/**
 * Polymarket "reach/hit $X" numeric-threshold ladder chain edges, derived
 * from raw titles (these markets are unshaped). Within one platform_event,
 * for the same (subject, deadline, unit, direction): reach Xhi ⟹ reach Xlo
 * for Xhi > Xlo (mirrored for "or lower"). Emits adjacent-rung pairs only.
 */
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { beltHit } from '../discriminators/telemetry.js';

const log = createLogger('stage4-reach-threshold-chain');

// Pure-TS reference implementations (mirror the SQL 1:1 for unit tests).
const VERB_SRC = '(?:reach(?:es)?|hit(?:s)?|exceed(?:s)?|surpass(?:es)?|cross(?:es)?|go(?:es)? above|be above|above)';

// Letter must be immediately adjacent to the number, or it's not a magnitude (avoids the "$150,000 by December" 'b' mis-parse).
export function magnitudeMultiplier(mag: string | null | undefined): number {
  switch ((mag ?? '').toLowerCase()) {
    case 'k': return 1e3;
    case 'm': return 1e6;
    case 'b': return 1e9;
    case 't': return 1e12;
    default: return 1;
  }
}

// Mirrors the SQL `val` expression exactly — keep in sync.
export function parseReachValue(title: string | null | undefined): number | null {
  if (!title) return null;
  const num = new RegExp(`(?:reach|reaches|hit|hits|exceed|exceeds|surpass|surpasses|cross|crosses|above)\\s+\\$?([0-9][0-9,.]*)`, 'i').exec(title);
  if (!num) return null;
  const base = parseFloat(num[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const magM = new RegExp(`(?:reach|reaches|hit|hits|exceed|exceeds|surpass|surpasses|cross|crosses|above)\\s+\\$?[0-9][0-9,.]*([kmbt])`, 'i').exec(title);
  return base * magnitudeMultiplier(magM ? magM[1] : null);
}

// A "(LOW)" watermark also means below-direction: a touch-LOW market pays when the period minimum reaches <=X, so lower X is stricter.
export function reachDirection(title: string | null | undefined): 'above' | 'below' {
  if (title && /or lower|or below|or less/i.test(title)) return 'below';
  if (title && /[(]low[)]/i.test(title)) return 'below';
  return 'above';
}

// True iff antecedent is strictly stricter than consequent (above: bigger; below: smaller). Equal values and mixed directions never relate.
export function reachImplies(
  direction: 'above' | 'below' | string | null | undefined,
  antecedentValue: number | null | undefined,
  consequentValue: number | null | undefined,
): boolean {
  if (antecedentValue == null || consequentValue == null) return false;
  if (direction === 'above') return antecedentValue > consequentValue;
  if (direction === 'below') return antecedentValue < consequentValue;
  return false;
}

// Excludes rank / set-count / negRisk-first-to-X titles — not monotone per-subject half-lines.
export function isExcludedReachFamily(title: string | null | undefined): boolean {
  if (!title) return false;
  return /\btop +[0-9]|end the year in the top|over +[0-9]+ +coins|first (company|to)/i.test(title);
}

// True iff the title carries the literal '___' unfilled-strike placeholder — its parsed value is unpinned and must never chain.
export function hasUnfilledStrikePlaceholder(title: string | null | undefined): boolean {
  if (!title) return false;
  return title.includes('___');
}

const VERB = `(?i)${VERB_SRC}`; // kept identical to VERB_SRC

export function reachThresholdRungsCtesSql(): string {
  return `reach_markets AS (
      SELECT
        qm.question_id,
        m.id                  AS market_id,
        m.platform_event_id   AS pe,
        lower(immutable_unaccent(btrim(regexp_replace(m.title, '${VERB}.*$', '')))) AS subj,
        n.condition_direction AS cond_dir,
        CASE WHEN m.title ~* 'or lower|or below|or less' OR m.title ~* '[(]low[)]' THEN 'below' ELSE 'above' END AS ttl_dir,
        CASE
          WHEN n.condition_direction IN ('above', 'below') THEN n.condition_direction
          WHEN m.title ~* 'or lower|or below|or less' OR m.title ~* '[(]low[)]' THEN 'below'
          ELSE 'above'
        END AS dir,
        (m.title ~* '${VERB}\\s+\\$') AS dollar,
        lower(coalesce(substring(m.title from '${VERB}\\s+\\$?[0-9][0-9,.]*\\s*(%|eth|gwei|btc|sol|barrels|points|bps)'), '')) AS unit,
        -- (High)/(Low)/(Close)/(Open) are independent settlement extrema, not a nested ladder
        lower(coalesce(substring(m.title from '(?i)[(](high|low|close|open)[)]'), '')) AS extremum,
        -- deadline as normalized text, never parsed to a date -- only token equality within a chain is required
        lower(btrim(coalesce(substring(m.title from '(?i)\\m(?:by|before|in|end of)\\M\\s+(.+?)\\s*\\??$'), ''))) AS deadline,
        -- magnitude-normalized value; letter must be immediately adjacent to the number so 'by' never mis-reads as a magnitude
        replace(substring(m.title from '${VERB}\\s+\\$?([0-9][0-9,.]*)'), ',', '')::numeric
          * CASE lower(substring(m.title from '${VERB}\\s+\\$?[0-9][0-9,.]*([kmbt])'))
              WHEN 'k' THEN 1e3 WHEN 'm' THEN 1e6 WHEN 'b' THEN 1e9 WHEN 't' THEN 1e12 ELSE 1 END AS val
      FROM markets m
      JOIN question_members qm ON qm.market_id = m.id
      JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
      LEFT JOIN llm_market_normalizations n ON n.market_id = m.id -- un-normalized rungs still chain, via title-parse fallback
      WHERE m.platform = 'polymarket'
        AND m.title ~* '${VERB}\\s+\\$?[0-9]'
        AND m.title !~* '\\btop +[0-9]|end the year in the top|over +[0-9]+ +coins|first (company|to)' -- exclude non-ladder families
        AND position('___' in m.title) = 0 -- refuse an unfilled-strike placeholder
    ),
    dir_titlecheck AS ( -- title-vs-field direction disagreement tripwire (belt.reach_dir_titlecheck); the field wins
      SELECT DISTINCT r.market_id
      FROM reach_markets r
      WHERE r.cond_dir IN ('above', 'below')
        AND r.cond_dir <> r.ttl_dir
    ),
    valued AS ( -- drop rows whose numeric did not parse
      SELECT * FROM reach_markets
      WHERE val IS NOT NULL
    ),
    node_rungs AS ( -- one rung per (family, question)
      SELECT pe, subj, dir, dollar, unit, extremum, deadline, question_id, min(val) AS val
      FROM valued
      GROUP BY pe, subj, dir, dollar, unit, extremum, deadline, question_id
    ),
    bad_questions AS ( -- a question whose rungs disagree on parsed value gets no edges
      SELECT question_id FROM valued
      GROUP BY question_id
      HAVING count(DISTINCT val) > 1
    ),
    ranked AS ( -- rank 1 = strictest rung; chain emits rk -> rk+1 only, not the full closure
      SELECT *,
        dense_rank() OVER (
          PARTITION BY pe, subj, dir, dollar, unit, extremum, deadline
          ORDER BY CASE WHEN dir = 'above' THEN -val ELSE val END
        ) AS rk
      FROM node_rungs
      WHERE question_id NOT IN (SELECT question_id FROM bad_questions)
    ),
    chain_pairs AS (
      SELECT a.question_id AS antecedent_question_id,
             b.question_id AS consequent_question_id,
             a.dir, a.val AS v_strict, b.val AS v_loose
      FROM ranked a
      JOIN ranked b
        ON b.pe       = a.pe
       AND b.subj     = a.subj
       AND b.dir      = a.dir
       AND b.dollar   = a.dollar
       AND b.unit     = a.unit
       AND b.extremum = a.extremum
       AND b.deadline = a.deadline
       AND b.rk = a.rk + 1
       AND b.question_id <> a.question_id
       AND b.val <> a.val
    )`;
}

export function buildReachThresholdChainEdgesSql(): string {
  return `
    WITH ${reachThresholdRungsCtesSql()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'numeric_threshold_raw')},
             'reach-threshold chain (raw): one PM subject ladders a single half-line per deadline, so the stricter adjacent threshold implies the looser (reach Xhi ⟹ reach Xlo for Xhi>Xlo; or-lower mirrored)'
      FROM chain_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export function countReachDirTitlecheckSql(): string {
  return `WITH ${reachThresholdRungsCtesSql()}
    SELECT COUNT(*)::int AS n FROM dir_titlecheck`;
}

export async function buildReachThresholdChainEdges(): Promise<number> {
  const conflicts = await runEdgeBuilderSql(countReachDirTitlecheckSql());
  for (let i = 0; i < conflicts; i++) beltHit('reach_dir_titlecheck');
  if (conflicts > 0) {
    log.warn(`reach-threshold-chain: ${conflicts} rung(s) title-vs-field direction disagreement (belt.reach_dir_titlecheck) — the stamped condition_direction is trusted; a new (LOW)-style watermark idiom the title parse misses? (A-D8)`);
  }
  const n = await runEdgeBuilderSql(buildReachThresholdChainEdgesSql());
  log.info('reach-threshold-chain: ' + n + ' edges');
  return n;
}
