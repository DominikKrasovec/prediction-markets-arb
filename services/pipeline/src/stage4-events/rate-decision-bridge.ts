/**
 * Strictness-aware cross-venue rate-decision bridge.
 *
 * The rate-decision emitters (kalshi:central-bank-rate, pm:rate-decision,
 * text-deterministic-AG, limitless:econ-fed) stamp the same Fed meeting onto
 * kalshi-local vs trio-local subjects/canonical_events that never fold
 * together by design (the kalshi per-rung "<meeting> (<rung>)" subject
 * carries the intra-meeting mutex and must not be rewritten; see
 * kalshi-deterministic.ts tryCentralBankRateDecision). This builder bridges
 * them as a Stage-4 edge builder keyed on a meeting join key; existing folds
 * are untouched.
 *
 * Comparator (halfline-compare.ts): every leg becomes a closed interval over
 * signed Δbps on the 25 bp lattice, reading the gated fields
 * (condition_direction ∈ {at,above,below}, value_primary = the signed bps)
 * plus a per-market strictness stamp (kalshi cumulative rungs are strict
 * '>N'; the trio's 'N+' are Δ≥N). Comparing the renormalized intervals is
 * then exact — equal → equivalence, ⊂ → strict_implication (subset is the
 * stronger claim), disjoint → mutual_exclusion.
 *
 * Meeting key: (instrument, meeting-year, meeting-month). instrument =
 * fed_funds only (other central banks refuse until added to the lattice
 * table). meeting-month comes from the month name in canonical_event;
 * meeting-year from condition_date's year. Month and year must be derived
 * separately because the emitters do not agree on condition_date encoding
 * (kalshi stamps a year placeholder, predict a month-end, PM/limitless a
 * month-start), so raw condition_date equality does not group a meeting
 * across venues. The Fed meets at most once per calendar month, so
 * (fed, year, month) is a sound key.
 *
 * Edge contract: pattern='rate_decision_bridge'; edge_type ∈ {equivalence,
 * strict_implication, mutual_exclusion}; confidence=1.0, deterministic=TRUE,
 * source='algorithmic'. Written via insertEdgesWithCensus, which routes
 * through the EDGE_CONFLICT_SQL chokepoint so an incumbent deterministic edge
 * on the same slot is never displaced. Symmetric edges (equivalence,
 * mutual_exclusion) are oriented antecedent=min(qid) → consequent=max(qid),
 * matching the cross-ref / equivalence / mutex-xq convention.
 *
 * belt.rate_decision_unbridged counts intra-meeting cross-venue pairs refused
 * by the per-leg soundness guards (non-lattice magnitude / cumulative rung
 * with an unreadable per-market `bound_strictness` / missing direction).
 * Emitted as a grep-able `BELT_CENSUS` log line.
 */
import { createLogger } from '@arb/logger';
import { query } from '@arb/db';
import { insertEdgesWithCensus } from '../util/sql-fragments.js';
import {
  RATE_LATTICE_TICK,
  rungToInterval,
  compareIntervals,
  describeInterval,
  type RungDirection,
  type Interval,
} from './halfline-compare.js';
import {
  boundStrictnessFromSignals,
  type BoundStrictness,
} from '../discriminators/specs/bound-strictness.js';

const log = createLogger('stage4-rate-decision-bridge');

/** Pattern label — must stay registered in EDGE_PATTERNS. */
export const RATE_DECISION_BRIDGE_PATTERN = 'rate_decision_bridge';

/**
 * Strictness is a per-market `bound_strictness` discriminator stamp, not a
 * per-emitter constant. The stamp ('strict'|'closed'|null) reads the market's
 * own bound form (Kalshi '>N' → strict, the trio 'N+' → closed) via
 * `boundStrictnessFromSignals` — the same pure extractor the Stage-1 stamp
 * uses. A cumulative (above/below) rung whose strictness is null is refused
 * (belt); an exact `at` rung is a lattice point where strictness is
 * irrelevant, so it is built regardless.
 */

const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_RX = new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\b`, 'i');

/** Resolve the lattice instrument from the identity fields. Fed-only today. */
function resolveInstrument(canonicalSubject: string | null, canonicalEvent: string | null): keyof typeof RATE_LATTICE_TICK | null {
  const s = `${(canonicalSubject ?? '').toLowerCase()} ${(canonicalEvent ?? '').toLowerCase()}`;
  if (/federal (reserve|funds)/.test(s) || /\bfed\b/.test(s)) return 'fed_funds';
  return null;
}

function meetingMonth(canonicalEvent: string | null): number | null {
  if (!canonicalEvent) return null;
  const m = canonicalEvent.match(MONTH_RX);
  return m ? MONTHS[m[1]!.toLowerCase()]! : null;
}
function meetingYear(conditionDate: string | null): number | null {
  if (!conditionDate) return null;
  const m = conditionDate.match(/(\d{4})-\d{2}-\d{2}/);
  return m ? parseInt(m[1]!, 10) : null;
}

// Pure planning core (DB-free, unit-testable)

export interface RateLegInput {
  questionId: number;
  platform: string;
  matchSource: string;
  dir: string | null; // gated condition_direction
  signedBps: number | null; // gated value_primary (signed)
  canonicalEvent: string | null;
  canonicalSubject: string | null;
  conditionDate: string | null;
  outcomeLabel: string | null;
  /** 'strict' ('>N'), 'closed' ('N+'/'≥N'), or null (exact rung / unreadable).
   *  Consumed only for cumulative (above/below) rungs — an `at` point ignores it. */
  boundStrictness: BoundStrictness | null;
}

export interface RateBridgeEdgeRow {
  a: number; // antecedent_question_id
  c: number; // consequent_question_id
  edge_type: 'equivalence' | 'strict_implication' | 'mutual_exclusion';
  pattern: string;
  reasoning: string;
}

export interface RateBridgePlan {
  rows: RateBridgeEdgeRow[];
  /** belt.rate_decision_unbridged: intra-meeting cross-venue pairs refused by guards. */
  unbridgedPairs: number;
  /** distinct legs refused by a per-leg guard (enumerable belt evidence). */
  invalidLegIds: number[];
  /** legs dropped BEFORE grouping (no derivable instrument / meeting key). */
  skippedLegs: number;
  /** distinct meeting groups with ≥2 cross-venue legs. */
  bridgedMeetings: number;
  counts: { equivalence: number; strict_implication: number; mutual_exclusion: number; none: number };
}

interface ProcessedLeg extends RateLegInput {
  meetingKey: string;
  interval: Interval | null; // null ⇒ guard-refused
}

/** Plan the bridge edges for a set of Fed rate-decision legs (pure). */
export function planRateDecisionBridge(legs: RateLegInput[]): RateBridgePlan {
  const groups = new Map<string, ProcessedLeg[]>();
  let skippedLegs = 0;

  for (const leg of legs) {
    const instrument = resolveInstrument(leg.canonicalSubject, leg.canonicalEvent);
    const year = meetingYear(leg.conditionDate);
    const month = meetingMonth(leg.canonicalEvent);
    if (!instrument || year == null || month == null) {
      skippedLegs++;
      continue;
    }
    const tick = RATE_LATTICE_TICK[instrument]!;
    let interval: Interval | null = null;
    if (leg.signedBps != null && (leg.dir === 'at' || leg.dir === 'above' || leg.dir === 'below')) {
      if (leg.dir === 'at') {
        // Exact rung → lattice POINT; strictness is irrelevant (rungToInterval's
        // 'at' arm ignores the flag). Always build.
        interval = rungToInterval('at', leg.signedBps, tick, false);
      } else if (leg.boundStrictness === 'strict' || leg.boundStrictness === 'closed') {
        // Cumulative rung → need the per-market bound form; null ⇒ refuse (belt).
        interval = rungToInterval(
          leg.dir as RungDirection,
          leg.signedBps,
          tick,
          leg.boundStrictness === 'strict',
        );
      }
    }
    const key = `${instrument}|${year}|${month}`;
    const arr = groups.get(key) ?? [];
    arr.push({ ...leg, meetingKey: key, interval });
    groups.set(key, arr);
  }

  const rows: RateBridgeEdgeRow[] = [];
  const invalid = new Set<number>();
  let unbridgedPairs = 0;
  let bridgedMeetings = 0;
  const counts = { equivalence: 0, strict_implication: 0, mutual_exclusion: 0, none: 0 };
  const seen = new Set<string>(); // dedup guard on ordered (a,c)

  for (const [, legsInMeeting] of groups) {
    let hadCrossVenue = false;
    for (let i = 0; i < legsInMeeting.length; i++) {
      for (let j = i + 1; j < legsInMeeting.length; j++) {
        const A = legsInMeeting[i]!;
        const B = legsInMeeting[j]!;
        if (A.platform === B.platform) continue; // same-venue → handled by outcome_sets
        hadCrossVenue = true;
        if (!A.interval || !B.interval) {
          unbridgedPairs++;
          if (!A.interval) invalid.add(A.questionId);
          if (!B.interval) invalid.add(B.questionId);
          continue;
        }
        const rel = compareIntervals(A.interval, B.interval);
        let a: number, c: number, type: RateBridgeEdgeRow['edge_type'];
        if (rel === 'none') {
          counts.none++;
          continue;
        } else if (rel === 'equivalence') {
          a = Math.min(A.questionId, B.questionId);
          c = Math.max(A.questionId, B.questionId);
          type = 'equivalence';
          counts.equivalence++;
        } else if (rel === 'mutual_exclusion') {
          a = Math.min(A.questionId, B.questionId);
          c = Math.max(A.questionId, B.questionId);
          type = 'mutual_exclusion';
          counts.mutual_exclusion++;
        } else {
          // a_implies_b: A ⊂ B (A is the stronger claim, antecedent); b_implies_a reverses.
          const [ante, cons] = rel === 'a_implies_b' ? [A, B] : [B, A];
          a = ante.questionId;
          c = cons.questionId;
          type = 'strict_implication';
          counts.strict_implication++;
        }
        const okey = `${a}->${c}`;
        if (seen.has(okey)) continue; // defensive; distinct question pairs ⇒ shouldn't fire
        seen.add(okey);
        rows.push({ a, c, edge_type: type, pattern: RATE_DECISION_BRIDGE_PATTERN, reasoning: reason(A, B, rel) });
      }
    }
    if (hadCrossVenue) bridgedMeetings++;
  }

  return { rows, unbridgedPairs, invalidLegIds: [...invalid], skippedLegs, bridgedMeetings, counts };
}

function legDesc(l: ProcessedLeg): string {
  const iv = l.interval ? describeInterval(l.interval) : '∅';
  return `${l.platform} "${l.outcomeLabel ?? l.dir + '/' + l.signedBps}" ${iv}`;
}
function reason(A: ProcessedLeg, B: ProcessedLeg, rel: string): string {
  const relSym = rel === 'equivalence' ? '≡' : rel === 'mutual_exclusion' ? '⊥' : '⟹';
  return `rate-decision bridge (${A.meetingKey}): ${legDesc(A)} ${relSym} ${legDesc(B)} — strictness-aware 25bp-lattice comparison`;
}

// DB driver

interface RawLegRow {
  question_id: number;
  platform: string;
  match_source: string;
  dir: string | null;
  signed_bps: number | null;
  canonical_event: string | null;
  canonical_subject: string | null;
  condition_date: string | null;
  outcome_label: string | null;
  market_title: string | null;
  strike_type: string | null;
  /** stamped `discriminators->>'bound_strictness'`; NULL falls back to the pure extractor. */
  stamped_strictness: string | null;
}

/** Fed policy_action bps legs (gated fields + strictness signals), one row per
 *  question. `bound_strictness` is read stamped-first with a fallback to the
 *  pure extractor over title/strike_type in the mapper below; the strictness
 *  title parse itself lives in `boundStrictnessFromSignals`, not here. */
const LEG_SELECT_SQL = `
  SELECT qm.question_id::int              AS question_id,
         m.platform                       AS platform,
         n.match_source                   AS match_source,
         n.condition_direction            AS dir,
         n.value_primary::float8          AS signed_bps,
         n.canonical_event                AS canonical_event,
         n.canonical_subject              AS canonical_subject,
         n.condition_date::text           AS condition_date,
         n.outcome_label                  AS outcome_label,
         m.title                          AS market_title,
         mr.raw->>'strike_type'           AS strike_type,
         n.discriminators->>'bound_strictness' AS stamped_strictness
  FROM llm_market_normalizations n
  JOIN markets m           ON m.id = n.market_id
  LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
  JOIN question_members qm ON qm.market_id = m.id
  JOIN questions q         ON q.id = qm.question_id AND q.archived_at IS NULL
  WHERE n.event_kind = 'policy_action'
    AND n.value_unit = 'bps'
    AND ( lower(n.canonical_subject) ~ 'federal (reserve|funds)'
       OR lower(n.canonical_event)   ~ 'federal (reserve|funds)'
       OR lower(n.canonical_subject) ~ '\\mfed\\M'
       OR lower(n.canonical_event)   ~ '\\mfed\\M' )`;

/** Candidate SELECT; the census helper wraps it in the CTE. */
const CANDIDATE_SELECT_SQL = `
  SELECT (x.a)::int             AS antecedent_question_id,
         (x.c)::int             AS consequent_question_id,
         x.edge_type::varchar   AS edge_type,
         x.pattern::varchar     AS pattern,
         1.0::numeric           AS confidence,
         TRUE                   AS deterministic,
         'algorithmic'::varchar AS source,
         x.reasoning::text      AS reasoning
  FROM json_to_recordset($1::json)
       AS x(a int, c int, edge_type text, pattern text, reasoning text)`;

export async function buildRateDecisionBridgeEdges(): Promise<number> {
  const raw = await query<RawLegRow>(LEG_SELECT_SQL);
  const legs: RateLegInput[] = raw.map((r) => ({
    questionId: r.question_id,
    platform: r.platform,
    matchSource: r.match_source,
    dir: r.dir,
    signedBps: r.signed_bps == null ? null : Number(r.signed_bps),
    canonicalEvent: r.canonical_event,
    canonicalSubject: r.canonical_subject,
    conditionDate: r.condition_date,
    outcomeLabel: r.outcome_label,
    // Stamped-first, else derive from the market's own bound form via the
    // same pure extractor the Stage-1 stamp uses.
    boundStrictness:
      r.stamped_strictness === 'strict' || r.stamped_strictness === 'closed'
        ? r.stamped_strictness
        : boundStrictnessFromSignals(r.market_title, r.strike_type),
  }));

  const plan = planRateDecisionBridge(legs);

  // Belt census — grep-able, no DB writes.
  log.info(
    `BELT_CENSUS {belt.rate_decision_unbridged: ${plan.unbridgedPairs}}` +
      (plan.invalidLegIds.length ? ` invalid_legs=${plan.invalidLegIds.slice(0, 20).join(',')}` : ''),
  );

  if (plan.rows.length === 0) {
    log.info(
      `rate-decision-bridge: 0 candidate edges (` +
        `${plan.bridgedMeetings} bridged meeting(s), ${plan.skippedLegs} skipped leg(s))`,
    );
    return 0;
  }

  const census = await insertEdgesWithCensus({
    builder: 'rate-decision-bridge',
    candidateSelectSql: CANDIDATE_SELECT_SQL,
    params: [JSON.stringify(plan.rows)],
  });

  log.info(
    `rate-decision-bridge: ${census.inserted} inserted (${census.displaced} displaced, ` +
      `${census.blocked} blocked, ${census.contradictions} contradiction(s)) over ` +
      `${plan.bridgedMeetings} meeting(s) — candidates: equiv=${plan.counts.equivalence} ` +
      `impl=${plan.counts.strict_implication} mutex=${plan.counts.mutual_exclusion} ` +
      `none=${plan.counts.none}`,
  );
  return census.inserted;
}
