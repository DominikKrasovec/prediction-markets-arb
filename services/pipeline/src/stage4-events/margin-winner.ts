/**
 * margin-winner — Kalshi KXMIDTERMMOV election-margin ⟹ seat-winner edges (Stage 4).
 * "Party P wins race R by ≥X" (X>0) strictly implies "Party P wins race R", for any positive X.
 * Party is read from the title regex cross-checked against the ticker suffix letter — NEVER
 * from canonical_subject (partially corrupted); a disagreement or absence yields no edge.
 * A same-cycle special-election question makes a house seat's general-keyed winner ambiguous,
 * so that seat is excluded entirely (doubt → no edge).
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-margin-winner');

// Pure-TS reference implementations (mirror the SQL 1:1 for unit tests)

export const US_STATES: ReadonlyArray<readonly [string, string]> = [
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
  ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
  ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'], ['idaho', 'id'],
  ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'], ['kansas', 'ks'],
  ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'], ['maryland', 'md'],
  ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'], ['mississippi', 'ms'],
  ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'], ['nevada', 'nv'],
  ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'], ['new york', 'ny'],
  ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'],
  ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'], ['south carolina', 'sc'],
  ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'], ['utah', 'ut'],
  ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'], ['west virginia', 'wv'],
  ['wisconsin', 'wi'], ['wyoming', 'wy'], ['district of columbia', 'dc'],
] as const;

export type Party = 'Democratic Party' | 'Republican Party';

export function partyFromTitle(title: string | null | undefined): Party | null {
  if (!title) return null;
  const rep = /\bfor (the )?republicans?\b/i.test(title);
  const dem = /\bfor (the )?democrats?\b/i.test(title);
  if (rep && !dem) return 'Republican Party';
  if (dem && !rep) return 'Democratic Party';
  return null;
}

export function partyFromTicker(ticker: string | null | undefined): Party | null {
  if (!ticker) return null;
  const last = ticker.trim().toUpperCase().slice(-1);
  if (last === 'R') return 'Republican Party';
  if (last === 'D') return 'Democratic Party';
  return null;
}

export interface MarginRaceKey {
  year: string;
  office: 'house' | 'senate' | 'governor';
  stateName: string;
  /** house only: zero-padded district ('09') or 'al' (at-large). */
  seat?: string;
}

// Mirrors the SQL `mfacts` CTE exactly — keep in sync.
export function parseMarginRaceKey(canonicalEvent: string | null | undefined): MarginRaceKey | null {
  if (!canonicalEvent) return null;
  const ce = canonicalEvent.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^([0-9]{4}) ([a-z ]+) ([0-9]{2}) house race margin$/.exec(ce))) {
    return { year: m[1], office: 'house', stateName: m[2], seat: m[3] };
  }
  if ((m = /^([0-9]{4}) ([a-z ]+) house race margin$/.exec(ce))) {
    return { year: m[1], office: 'house', stateName: m[2], seat: 'al' };
  }
  if ((m = /^([0-9]{4}) ([a-z ]+) senate race margin$/.exec(ce))) {
    return { year: m[1], office: 'senate', stateName: m[2] };
  }
  if ((m = /^([0-9]{4}) ([a-z ]+) governor race margin$/.exec(ce))) {
    return { year: m[1], office: 'governor', stateName: m[2] };
  }
  return null;
}

// SQL side

const US_STATES_VALUES_SQL = US_STATES.map(([name, ab]) => `('${name}','${ab}')`).join(', ');

export interface MarginWinnerSqlOptions {
  /** DRY-RUN ONLY: override the margin-side cycle year. Production never sets this. */
  simulateCycleYear?: string;
}

function cycleYearExprSql(opts?: MarginWinnerSqlOptions): string {
  const y = opts?.simulateCycleYear;
  if (y === undefined) return `left(ce, 4)`;
  if (!/^[0-9]{4}$/.test(y)) throw new Error(`simulateCycleYear must be a 4-digit year, got: ${y}`);
  return `'${y}'`;
}

export function marginFactsCtesSql(opts?: MarginWinnerSqlOptions): string {
  return `us_states(state_name, st) AS (
      VALUES ${US_STATES_VALUES_SQL}
    ),
    margin AS (
      SELECT DISTINCT ON (q.id)
        q.id AS question_id,
        lower(btrim(q.canonical_event)) AS ce,
        q.value_primary,
        q.value_unit,
        q.condition_shape,
        m.title,
        upper(btrim(mr.raw->>'event_ticker')) AS ticker
      FROM questions q
      JOIN question_members qm ON qm.question_id = q.id
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw mr ON mr.market_id = m.id
      WHERE q.archived_at IS NULL
        AND q.event_kind = 'election_margin'
        AND q.condition_direction = 'above'
        AND q.value_primary IS NOT NULL
        AND q.value_primary > 0
        AND q.value_secondary IS NULL
      ORDER BY q.id, m.id
    ),
    -- MATERIALIZED: the regex race-key parse must run once per margin row, not once per join row.
    mfacts AS MATERIALIZED (
      SELECT question_id, ce, value_primary, value_unit, condition_shape,
        ${cycleYearExprSql(opts)} AS yr,
        CASE
          WHEN title ~* '\\mfor (the )?republicans?\\M' AND title !~* '\\mfor (the )?democrats?\\M' THEN 'Republican Party'
          WHEN title ~* '\\mfor (the )?democrats?\\M' AND title !~* '\\mfor (the )?republicans?\\M' THEN 'Democratic Party'
        END AS party_title,
        CASE right(ticker, 1) WHEN 'R' THEN 'Republican Party' WHEN 'D' THEN 'Democratic Party' END AS party_ticker,
        substring(ce from '^[0-9]{4} ([a-z ]+) [0-9]{2} house race margin$')   AS house_state,
        substring(ce from '^[0-9]{4} [a-z ]+ ([0-9]{2}) house race margin$')   AS house_seat,
        substring(ce from '^[0-9]{4} ([a-z ]+) house race margin$')            AS al_state,
        substring(ce from '^[0-9]{4} ([a-z ]+) senate race margin$')           AS sen_state,
        substring(ce from '^[0-9]{4} ([a-z ]+) governor race margin$')         AS gov_state
      FROM margin
    )`;
}

// Exported separately so the read-only dry-run probe (data/exports) can count pairs without executing the INSERT.
export function marginWinnerPairsCtesSql(opts?: MarginWinnerSqlOptions): string {
  return `${marginFactsCtesSql(opts)},
    race AS MATERIALIZED (
      SELECT f.question_id, f.yr, f.party_title AS party,
        CASE
          WHEN f.house_state IS NOT NULL OR f.al_state IS NOT NULL THEN 'house'
          WHEN f.sen_state IS NOT NULL THEN 'senate'
          WHEN f.gov_state IS NOT NULL THEN 'governor'
        END AS office,
        us.st AS house_st,
        coalesce(f.house_seat, CASE WHEN f.al_state IS NOT NULL THEN 'al' END) AS seat,
        coalesce(f.sen_state, f.gov_state) AS sg_state
      FROM mfacts f
      LEFT JOIN us_states us ON us.state_name = coalesce(f.house_state, f.al_state)
      WHERE f.party_title IS NOT NULL
        AND f.party_title = f.party_ticker
    ),
    winner AS (
      SELECT id AS question_id, lower(btrim(canonical_event)) AS ce, canonical_subject AS party
      FROM questions
      WHERE archived_at IS NULL
        AND event_kind = 'election_outcome_winner'
        AND canonical_subject IN ('Democratic Party', 'Republican Party')
    ),
    special_seats AS (
      SELECT DISTINCT substring(lower(btrim(canonical_event)) from '^([0-9]{4} [a-z]{2} (?:[0-9]{2}|al)) special election') AS seat_key
      FROM questions
      WHERE archived_at IS NULL
        AND lower(btrim(canonical_event)) ~ '^[0-9]{4} [a-z]{2} ([0-9]{2}|al) special election'
    ),
    race_clean AS MATERIALIZED (
      SELECT * FROM race a
      WHERE NOT (
        a.office = 'house' AND a.house_st IS NOT NULL
        AND (a.yr || ' ' || a.house_st || ' ' || a.seat)
            IN (SELECT seat_key FROM special_seats WHERE seat_key IS NOT NULL)
      )
    ),
    race_keys AS MATERIALIZED (
      SELECT question_id, party, office,
             yr || ' ' || house_st || ' ' || seat || ' house seat' AS winner_key
      FROM race_clean WHERE office = 'house' AND house_st IS NOT NULL
      UNION ALL
      SELECT question_id, party, office,
             yr || ' house race for ' || house_st || ' ' || seat
      FROM race_clean WHERE office = 'house' AND house_st IS NOT NULL
      UNION ALL
      SELECT question_id, party, office,
             yr || ' house race for ' || house_st || ' ' || ltrim(seat, '0')
      FROM race_clean WHERE office = 'house' AND house_st IS NOT NULL
      UNION ALL
      SELECT question_id, party, office, yr || ' ' || sg_state || ' senate race'
      FROM race_clean WHERE office = 'senate'
      UNION ALL
      SELECT question_id, party, office, yr || ' senate race in ' || sg_state
      FROM race_clean WHERE office = 'senate'
      UNION ALL
      SELECT question_id, party, office, yr || ' ' || sg_state || ' governor race'
      FROM race_clean WHERE office = 'governor'
    ),
    margin_winner_pairs AS (
      SELECT DISTINCT
             rk.question_id AS antecedent_question_id,
             b.question_id  AS consequent_question_id,
             rk.office, rk.party, b.ce AS winner_ce
      FROM race_keys rk
      JOIN winner b
        ON b.ce = rk.winner_key
       AND b.party = rk.party
    )`;
}

export function buildMarginWinnerEdgesSql(opts?: MarginWinnerSqlOptions): string {
  return `
    WITH ${marginWinnerPairsCtesSql(opts)},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'margin_winner')},
             'margin ⟹ winner: party wins race by ≥X (X>0) implies party wins the race (same cycle/state/seat/party)'
      FROM margin_winner_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildMarginWinnerEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildMarginWinnerEdgesSql());
  log.info('margin-winner: ' + n + ' edges');
  // `party` is also a registry fold-key spec (discriminators/specs/party.ts) stamped at Stage 1;
  // this counts title↔ticker disagreements the belt drops.
  const disagreements = await countMarginPartyTitlecheck();
  log.info(`BELT_CENSUS {belt.margin_party_titlecheck: ${disagreements}}`);
  return n;
}

// Diagnostic count for belt.margin_party_titlecheck: replays the mfacts party double-belt and
// counts rows where both title and ticker are known and DIFFER.
async function countMarginPartyTitlecheck(): Promise<number> {
  const sql = `
    WITH m AS (
      SELECT DISTINCT ON (q.id) q.id,
        CASE
          WHEN mk.title ~* '\\mfor (the )?republicans?\\M' AND mk.title !~* '\\mfor (the )?democrats?\\M' THEN 'R'
          WHEN mk.title ~* '\\mfor (the )?democrats?\\M' AND mk.title !~* '\\mfor (the )?republicans?\\M' THEN 'D'
        END AS party_title,
        CASE right(upper(btrim(mr.raw->>'event_ticker')), 1) WHEN 'R' THEN 'R' WHEN 'D' THEN 'D' END AS party_ticker
      FROM questions q
      JOIN question_members qm ON qm.question_id = q.id
      JOIN markets mk ON mk.id = qm.market_id AND mk.platform = 'kalshi'
      JOIN market_metadata_raw mr ON mr.market_id = mk.id
      WHERE q.archived_at IS NULL AND q.event_kind = 'election_margin'
      ORDER BY q.id, mk.id
    )
    SELECT count(*)::int AS n
    FROM m
    WHERE party_title IS NOT NULL AND party_ticker IS NOT NULL AND party_title <> party_ticker`;
  const r = await query<{ n: number }>(sql);
  return Number(r[0]?.n ?? 0);
}

// Same-(race, party) margin ladder: "wins by >=10" implies "wins by >=5" — nested half-lines,
// so these edges reuse pattern='numeric_ladder_xq'. A separate builder (not the generic
// numeric-ladder-xq rule) because the party that orients a margin lives in the title/ticker,
// not a gated field; this reuses margin-winner's party double-belt and partitions by
// (canonical_event, party). Chain, not closure: adjacent rungs only.

export function buildMarginLadderEdgesSql(opts?: MarginWinnerSqlOptions): string {
  return `
    WITH ${marginFactsCtesSql(opts)},
    belted AS (
      SELECT question_id, ce, value_primary::numeric AS v, party_title AS party,
             value_unit, condition_shape
      FROM mfacts
      WHERE party_title IS NOT NULL
        AND party_title = party_ticker
    ),
    ranked AS (
      SELECT *, dense_rank() OVER (PARTITION BY ce, party, value_unit, condition_shape ORDER BY v) AS rk
      FROM belted
    ),
    margin_ladder_pairs AS (
      SELECT a.question_id AS antecedent_question_id,
             b.question_id AS consequent_question_id
      FROM ranked a
      JOIN ranked b
        ON b.ce = a.ce
       AND b.party = a.party
       AND b.value_unit IS NOT DISTINCT FROM a.value_unit
       AND b.condition_shape IS NOT DISTINCT FROM a.condition_shape
       AND a.rk = b.rk + 1
       AND a.question_id <> b.question_id
    ),
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'numeric_ladder_xq')},
             'margin ladder: wins by >=X implies wins by >=Y (X>Y, same race+party; party from title+ticker belt)'
      FROM margin_ladder_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildMarginLadderEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildMarginLadderEdgesSql());
  log.info('margin-ladder: ' + n + ' edges');
  return n;
}
