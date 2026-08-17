import { withTx } from '@arb/db';
import type { Platform, BasisRisk } from '@arb/types';
import { createLogger } from '@arb/logger';
import { resolveFeeModel } from '../solver/fees.js';
import type { ConstraintGraph, QuestionNode, MarketRef, OutcomeSetRef, EdgeRef } from './types.js';
import { applyDuplicatePartitionGate } from './duplicate-gate.js';
import { applyIntraSetContainmentBelt } from './intra-set-containment-belt.js';
import { applyIndependentBundleBelt, type IndepBundleFacts } from './independent-bundle-belt.js';

const log = createLogger('graph:loader');

interface QuestionRow {
  id: number;
  canonical_subject: string;
  canonical_key: string | null;
  condition_shape: string | null;
  condition_value: string | null;
  condition_date: string | null;
  value_primary: string | null; // NUMERIC arrives as string
  value_secondary: string | null;
  condition_direction: string | null;
  participants: string[] | null;
  market_id: number;
  platform: Platform;
  platform_id: string;
  title: string | null;
  end_date: Date | string | null;
  neg_risk_event_id: string | null;
  category_unified: string | null;
  fee_rate_bps: string | null;
  event_ticker: string | null;
  event_kind: string | null;
}

interface EdgeRow {
  id: number;
  antecedent_question_id: number;
  consequent_question_id: number;
  edge_type: string;
  confidence: number;
  deterministic: boolean;
  basis_risk: string | null;
}

interface SlotRow {
  set_id: number;
  set_type: string;
  set_name: string;
  is_exhaustive: boolean | null;
  slot_ordinal: number;
  question_id: number;
}

type Runner = <T = any>(text: string, params?: any[]) => Promise<T[]>; // rides one MVCC snapshot

// Stage-4 finalize rewrites these tables as a long, non-atomic sequence of
// DELETE+INSERT with no surrounding transaction; reading them under separate
// autocommit queries could observe a half-rebuilt graph and manufacture a
// fake arb. One REPEATABLE READ / READ ONLY tx makes the loader see one epoch.
export async function loadConstraintGraph(minEdgeConfidence = 0.70): Promise<ConstraintGraph> {
  return withTx(
    (client) => {
      const run: Runner = <T>(text: string, params?: any[]) =>
        client.query(text, params).then((r) => r.rows as T[]);
      return loadConstraintGraphTx(run, minEdgeConfidence);
    },
    { isolationLevel: 'REPEATABLE READ', readOnly: true },
  );
}

async function loadConstraintGraphTx(
  run: Runner,
  minEdgeConfidence: number,
): Promise<ConstraintGraph> {
  const questionRows = await run<QuestionRow>(
    `SELECT q.id, q.canonical_subject, q.canonical_key, q.condition_shape, q.condition_value,
            q.condition_date, q.value_primary, q.value_secondary, q.condition_direction,
            q.participants, qm.market_id, m.platform, m.platform_id,
            m.title, m.end_date, m.category_unified,
            mr.raw->>'feeRateBps' AS fee_rate_bps,
            mr.raw->>'event_ticker' AS event_ticker,
            n.event_kind,
            CASE WHEN m.platform = 'polymarket' AND mr.raw->>'negRisk' = 'true'
                 THEN COALESCE(mr.raw->>'negRiskMarketID', m.platform_event_id)
            END AS neg_risk_event_id
     FROM questions q
     JOIN question_members qm ON qm.question_id = q.id
     JOIN markets m ON m.id = qm.market_id
     LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
     LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE q.archived_at IS NULL
       AND m.resolved_at IS NULL
       -- resolved_at can be stale (the resolution-monitor writer isn't always
       -- running); end_date is the fallback so settled fixtures can't enter Ω.
       AND (m.end_date IS NULL OR m.end_date > now())`
  );

  const questions = new Map<number, QuestionNode>();
  for (const row of questionRows) {
    let node = questions.get(row.id);
    if (!node) {
      node = {
        questionId: row.id,
        canonicalSubject: row.canonical_subject,
        canonicalKey: row.canonical_key,
        conditionShape: row.condition_shape as import('@arb/types').ConditionShape | null,
        conditionValue: row.condition_value,
        conditionDate: row.condition_date,
        valuePrimary: row.value_primary,
        valueSecondary: row.value_secondary,
        conditionDirection: row.condition_direction,
        subjectEntities: Array.isArray(row.participants) ? row.participants : [],
        markets: new Map(),
      };
      questions.set(row.id, node);
    }
    const endDateMs = row.end_date != null ? new Date(row.end_date).getTime() : null;
    const ref: MarketRef = {
      marketId: row.market_id,
      platform: row.platform,
      platformId: row.platform_id,
      title: row.title,
      eventTicker: row.event_ticker ?? null,
      eventKind: row.event_kind ?? null,
      endDateMs: endDateMs != null && Number.isFinite(endDateMs) ? endDateMs : null,
      negRiskEventId: row.neg_risk_event_id ?? null,
      feeModel: resolveFeeModel(row.platform, {
        categoryUnified: row.category_unified,
        feeRateBps: row.fee_rate_bps,
        eventTicker: row.event_ticker,
      }),
    };
    node.markets.set(row.market_id, ref);
  }

  // Filtering to live endpoints in SQL (not just in JS after the fetch) avoids
  // materializing edges whose endpoints are long-expired, which can OOM the
  // loader on boot; the JS filter below is kept as defense-in-depth.
  const edgeRows = await run<EdgeRow>(
    `WITH live_q AS (
       SELECT q.id
       FROM questions q
       WHERE q.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM question_members qm
           JOIN markets m ON m.id = qm.market_id
           WHERE qm.question_id = q.id
             AND m.resolved_at IS NULL
             AND (m.end_date IS NULL OR m.end_date > now())
         )
     )
     SELECT e.id, e.antecedent_question_id, e.consequent_question_id,
            e.edge_type, e.confidence, e.deterministic, e.basis_risk
     FROM implication_edges e
     JOIN live_q la ON la.id = e.antecedent_question_id
     JOIN live_q lc ON lc.id = e.consequent_question_id
     WHERE e.confidence >= $1
       AND e.archived_at IS NULL`,
    [minEdgeConfidence]
  );

  const allEdges: EdgeRef[] = edgeRows.map(r => ({
    edgeId: r.id,
    antecedentQuestionId: r.antecedent_question_id,
    consequentQuestionId: r.consequent_question_id,
    edgeType: r.edge_type,
    confidence: r.confidence,
    deterministic: r.deterministic,
    basisRisk: (r.basis_risk ?? null) as BasisRisk | null,
  }));

  const edges = filterEdgesToLiveEndpoints(allEdges, questions);
  if (edges.length < allEdges.length) {
    log.info(
      `Edge liveness filter: dropped ${allEdges.length - edges.length} edge(s) with ` +
      `archived/expired/memberless endpoint(s) (${edges.length} live-live kept)`
    );
  }

  // Fail-safe boot check: if outcome_sets.is_exhaustive is absent, force Σ≤1
  // for every categorical set — treating an unproven set as Σ=1 (exhaustive)
  // is the direction that manufactures a fake buy-all-YES arb.
  const hasExhaustiveCol = await columnExists(run, 'outcome_sets', 'is_exhaustive');
  if (!hasExhaustiveCol) {
    log.warn(
      'outcome_sets.is_exhaustive absent — forcing strict Σ≤1 (non-exhaustive) for ' +
        'ALL categorical sets until the column is populated.',
    );
  }
  const exhaustiveSelect = hasExhaustiveCol ? 'os.is_exhaustive' : 'FALSE AS is_exhaustive';
  const slotRows = await run<SlotRow>(
    `SELECT os.id AS set_id, os.set_type, os.set_name, ${exhaustiveSelect},
            oss.slot_ordinal, oss.question_id
     FROM outcome_sets os
     JOIN outcome_set_slots oss ON os.id = oss.set_id
     ORDER BY os.id, oss.slot_ordinal`
  );

  const setMap = new Map<number, OutcomeSetRef>();
  for (const row of slotRows) {
    let ref = setMap.get(row.set_id);
    if (!ref) {
      ref = {
        setId: row.set_id,
        setType: row.set_type as OutcomeSetRef['setType'],
        setName: row.set_name,
        isExhaustive: row.is_exhaustive ?? false, // NULL must fail safe to Σ≤1, never Σ=1
        slotQuestionIds: [],
      };
      setMap.set(row.set_id, ref);
    }
    ref.slotQuestionIds.push(row.question_id);
  }

  // Drops slots referencing a dead question and demotes a Σ=1 set that lost a
  // member to Σ≤1 (a partition minus a member is no longer provably exhaustive).
  const outcomeSets = filterOutcomeSetSlotsToLive([...setMap.values()], questions);

  const graph: ConstraintGraph = { questions, outcomeSets, edges };

  // Durable duplicate-suspect pairs from the Stage-4 finalize gate; table may
  // be absent on an older DB, so probe first.
  if (await tableExists(run, 'outcome_set_duplicate_suspects')) {
    const suspectRows = await run<{ a: number; b: number }>(
      `SELECT question_a_id AS a, question_b_id AS b FROM outcome_set_duplicate_suspects`,
    );
    const durablePairs = suspectRows
      .filter((r) => questions.has(r.a) && questions.has(r.b))
      .map((r) => [r.a, r.b] as [number, number]);
    if (durablePairs.length > 0) {
      graph.duplicateSuspectPairs = durablePairs;
      log.info(
        `Ω-liveness: loaded ${durablePairs.length} durable duplicate-suspect pair(s) ` +
          `from outcome_set_duplicate_suspects (of ${suspectRows.length} table row(s))`,
      );
    }
  }

  // Post-load belts, all strictly wall-removing (can only enlarge Ω, never manufacture an arb).
  applyDuplicatePartitionGate(graph);
  applyIntraSetContainmentBelt(graph);

  const slotQids = new Set<number>();
  for (const os of graph.outcomeSets) {
    if (os.setType === 'categorical') for (const qid of os.slotQuestionIds) slotQids.add(qid);
  }
  if (slotQids.size > 0) {
    const factsRows = await run<{
      question_id: number;
      native_independent: boolean;
      has_negrisk: boolean;
      has_fixture_kind: boolean;
      has_value: boolean;
    }>(
      `SELECT q.id AS question_id,
              bool_or(m.grouping_type = 'bundle_nonexclusive'
                      OR ke.raw->>'mutually_exclusive' = 'false')          AS native_independent,
              bool_or(mr.raw->>'negRisk' = 'true'
                      OR mr.raw->>'isNegRisk' = 'true'
                      OR mr.raw->>'negRiskMarketId' IS NOT NULL)           AS has_negrisk,
              bool_or(n.event_kind IN ('match_winner','halftime_leader','exact_score','candle_direction'))
                                                                           AS has_fixture_kind,
              bool_or(n.value_primary IS NOT NULL)                         AS has_value
       FROM questions q
       JOIN question_members qm ON qm.question_id = q.id
       JOIN markets m ON m.id = qm.market_id
       LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
       LEFT JOIN kalshi_events ke ON m.platform = 'kalshi' AND ke.event_ticker = mr.raw->>'event_ticker'
       LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
       WHERE q.id = ANY($1::int[])
       GROUP BY q.id`,
      [[...slotQids]],
    );
    const factsByQid = new Map<number, IndepBundleFacts>();
    for (const r of factsRows) {
      factsByQid.set(r.question_id, {
        nativeIndependent: r.native_independent === true,
        hasNegrisk: r.has_negrisk === true,
        hasFixtureKind: r.has_fixture_kind === true,
        hasValue: r.has_value === true,
      });
    }
    applyIndependentBundleBelt(graph, (qid) => factsByQid.get(qid));
  }

  log.info(
    `Loaded ${graph.questions.size} questions, ${graph.edges.length} edges, ${graph.outcomeSets.length} outcome sets`
  );

  return graph;
}

export function filterEdgesToLiveEndpoints(
  edges: readonly EdgeRef[],
  questions: ReadonlyMap<number, QuestionNode>,
): EdgeRef[] {
  return edges.filter(
    (e) => questions.has(e.antecedentQuestionId) && questions.has(e.consequentQuestionId),
  );
}

// Drops dangling slots per set; a Σ=1 set that loses a slot demotes to Σ≤1
// (never the reverse); a set left with zero live slots is dropped entirely.
export function filterOutcomeSetSlotsToLive(
  sets: readonly OutcomeSetRef[],
  questions: ReadonlyMap<number, QuestionNode>,
): OutcomeSetRef[] {
  const out: OutcomeSetRef[] = [];
  let droppedSlots = 0;
  let droppedSets = 0;
  const demotedSetIds: number[] = [];
  for (const os of sets) {
    const live = os.slotQuestionIds.filter((qid) => questions.has(qid));
    if (live.length === os.slotQuestionIds.length) {
      out.push(os);
      continue;
    }
    droppedSlots += os.slotQuestionIds.length - live.length;
    if (live.length === 0) {
      droppedSets += 1;
      continue;
    }
    const demote = os.isExhaustive === true;
    if (demote) demotedSetIds.push(os.setId);
    out.push({
      ...os,
      slotQuestionIds: live,
      isExhaustive: demote ? false : os.isExhaustive,
    });
  }
  if (droppedSlots > 0) {
    log.warn(
      `Outcome-set slot liveness filter: dropped ${droppedSlots} dangling slot(s) ` +
        `referencing archived/expired/memberless questions; removed ${droppedSets} fully-dangling ` +
        `set(s); DEMOTED ${demotedSetIds.length} Σ=1 set(s) to Σ≤1 (a set missing a live member ` +
        `is no longer provably exhaustive — keeping Σ=1 over the survivors would remove a world ` +
        `and could manufacture a fake buy-all-YES arb)` +
        (demotedSetIds.length > 0
          ? `; demoted setId sample: ${demotedSetIds.slice(0, 10).join(', ')}`
          : ''),
    );
  }
  return out;
}

async function columnExists(run: Runner, table: string, column: string): Promise<boolean> {
  const rows = await run<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return rows[0]?.present === true;
}

async function tableExists(run: Runner, table: string): Promise<boolean> {
  const rows = await run<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_name = $1
     ) AS present`,
    [table],
  );
  return rows[0]?.present === true;
}
