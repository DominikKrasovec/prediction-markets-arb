/**
 * Tier-B tournament edges: static-unconditional derivations only (elimination-
 * stage mutex, group-champion superset, host-stage mutex, cross-event champion
 * Σ≤1 sets). Outcome-conditional combinatorics (bracket distance, group
 * standings, live elimination propagation) are deliberately excluded — those
 * wait for a future resolution-recompiler. All edges are tagged
 * `tournament_state_id` (reversible: killing the state kills the edges).
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { foldTextKey } from '../util/sql-fragments.js';
import {
  marketRowToRoleNode,
  loadTournamentMarketNodeRows,
  tickerParts,
  upsertTournamentEdgeRows,
  type DerivedEdge,
  type MarketNodeRow,
  type RoleNode,
  type TournamentFormatSpec,
  type TournamentRole,
} from './tournament-edges.js';

const log = createLogger('stage4-tournament-edges-tierb');

// TS mirror of foldedTextSql (NFKD-deaccent + lowercase + trim); keep the two in sync.
function fold(s: string | null | undefined): string | null {
  return foldTextKey(s);
}

/** Index in reachLadder (0 = deepest); a role not in the ladder returns ladder.length. */
function ladderDepth(spec: Pick<TournamentFormatSpec, 'reachLadder'>, role: TournamentRole): number {
  const i = spec.reachLadder.indexOf(role);
  return i >= 0 ? i : spec.reachLadder.length;
}

const dedupPush = () => {
  const seen = new Set<string>();
  return (out: DerivedEdge[], e: DerivedEdge) => {
    if (e.antecedentQuestionId === e.consequentQuestionId) return;
    const key = `${e.antecedentQuestionId}->${e.consequentQuestionId}:${e.edgeType}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
};

// ── Rule 1: elimination-stage ⊥ strictly-deeper reach ────────────────────────

/** eliminated-at-S(T) ⊥ reach-D(T) for D strictly deeper than S, per team. Champion consequents and same-stage pairs are excluded (covered elsewhere). */
export function deriveEliminationStageMutexes(
  spec: Pick<TournamentFormatSpec, 'reachLadder' | 'extraImplications'>,
  nodes: readonly RoleNode[],
): DerivedEdge[] {
  const reachBySubj = new Map<string, RoleNode[]>();
  const extraBySubj = new Map<string, RoleNode[]>();
  const extraFromRoles = new Map<TournamentRole, TournamentRole>();
  for (const { from, to } of spec.extraImplications) extraFromRoles.set(from, to);
  const elims: RoleNode[] = [];
  for (const n of nodes) {
    const subj = fold(n.subject);
    if (!subj) continue;
    if (n.isElimination) { elims.push(n); continue; }
    if (n.role !== spec.reachLadder[0] && spec.reachLadder.includes(n.role)) {
      const arr = reachBySubj.get(subj);
      if (arr) arr.push(n); else reachBySubj.set(subj, [n]);
    } else if (extraFromRoles.has(n.role)) {
      const arr = extraBySubj.get(subj);
      if (arr) arr.push(n); else extraBySubj.set(subj, [n]);
    }
  }

  const out: DerivedEdge[] = [];
  const push = dedupPush();
  for (const elim of elims) {
    const subj = fold(elim.subject);
    if (!subj) continue;
    const elimDepth = ladderDepth(spec, elim.role);
    for (const reach of reachBySubj.get(subj) ?? []) {
      if (ladderDepth(spec, reach.role) < elimDepth) {
        push(out, {
          antecedentQuestionId: elim.questionId,
          consequentQuestionId: reach.questionId,
          pattern: 'elimination_stage_mutex',
          edgeType: 'mutual_exclusion',
          reasoning: `${elim.subject}: eliminated at ${elim.role} ⊥ reach ${reach.role} (strictly deeper)`,
        });
      }
    }
    // extraImplication antecedents mutex only when their consequent stage is strictly deeper than the elimination.
    for (const extra of extraBySubj.get(subj) ?? []) {
      const to = extraFromRoles.get(extra.role);
      if (to != null && ladderDepth(spec, to) < elimDepth) {
        push(out, {
          antecedentQuestionId: elim.questionId,
          consequentQuestionId: extra.questionId,
          pattern: 'elimination_stage_mutex',
          edgeType: 'mutual_exclusion',
          reasoning: `${elim.subject}: eliminated at ${elim.role} ⊥ ${extra.role} (implies reaching ${to})`,
        });
      }
    }
  }
  return out;
}

// ── Rule 2: champion ⟹ group-of-champion aggregate ──────────────────────────

/** One aggregate partition cell: "a team from Group <letter> wins". */
export interface GroupAggregateCell { groupLetter: string; questionId: number }

/** champion(T) ⟹ aggregate(group(T)). Refuses on a multi-group team or a draw-vs-ticker group disagreement (a miss passes, a conflicting hit refuses). */
export function deriveGroupChampionSupersets(args: {
  champions: readonly RoleNode[];
  membership: ReadonlyMap<string, string>;
  multiGroupTeams: ReadonlySet<string>;
  aggCells: readonly GroupAggregateCell[];
  drawGroups?: ReadonlyMap<string, string>;
}): DerivedEdge[] {
  const aggByLetter = new Map<string, number>();
  const dupLetters = new Set<string>();
  for (const c of args.aggCells) {
    const letter = c.groupLetter.toLowerCase();
    if (aggByLetter.has(letter) && aggByLetter.get(letter) !== c.questionId) dupLetters.add(letter);
    aggByLetter.set(letter, c.questionId);
  }
  const out: DerivedEdge[] = [];
  const push = dedupPush();
  for (const champ of args.champions) {
    if (champ.isElimination) continue;
    const subj = fold(champ.subject);
    if (!subj || args.multiGroupTeams.has(subj)) continue;
    const grp = args.membership.get(subj);
    if (!grp) continue;
    const drawGrp = args.drawGroups?.get(subj);
    if (drawGrp != null && drawGrp.toLowerCase() !== grp.toLowerCase()) continue;
    if (dupLetters.has(grp.toLowerCase())) continue;
    const aggQid = aggByLetter.get(grp.toLowerCase());
    if (aggQid == null) continue;
    push(out, {
      antecedentQuestionId: champ.questionId,
      consequentQuestionId: aggQid,
      pattern: 'group_champion_superset',
      edgeType: 'strict_implication',
      reasoning: `${champ.subject} champion ⟹ a team from Group ${grp.toUpperCase()} wins (draw-fixed membership)`,
    });
  }
  return out;
}

// ── Rule 3: host-aggregate stage mutexes ─────────────────────────────────────

export interface HostStageCells {
  byStage: ReadonlyMap<TournamentRole, number>;
  winningFinalQuestionId?: number;
}

/** reach-S(host) ⊥ cell(S' strictly shallower), plus cell(winning the final) ⊥ champion(non-host). No champion(host)×cell edges, and no reach-final×semifinal-cell pair (ambiguous unplayed-final boundary). */
export function deriveHostStageMutexes(
  spec: Pick<TournamentFormatSpec, 'reachLadder' | 'hostAggregate'>,
  nodes: readonly RoleNode[],
  cells: HostStageCells,
): DerivedEdge[] {
  const host = spec.hostAggregate;
  if (!host) return [];
  const hostFolds = new Set(host.hosts.map((h) => fold(h)).filter((h): h is string => h != null));
  const championRole = spec.reachLadder[0];
  const out: DerivedEdge[] = [];
  const push = dedupPush();

  for (const n of nodes) {
    if (n.isElimination) continue;
    const subj = fold(n.subject);
    if (!subj) continue;

    if (n.role === championRole) {
      if (!hostFolds.has(subj) && cells.winningFinalQuestionId != null) {
        push(out, {
          antecedentQuestionId: n.questionId,
          consequentQuestionId: cells.winningFinalQuestionId,
          pattern: 'host_stage_mutex',
          edgeType: 'mutual_exclusion',
          reasoning: `${n.subject} champion ⊥ a host wins the final (only the final's winner lifts the trophy)`,
        });
      }
      continue;
    }

    if (!hostFolds.has(subj) || !spec.reachLadder.includes(n.role)) continue;
    const reachDepth = ladderDepth(spec, n.role);
    for (const [cellStage, cellQid] of cells.byStage) {
      const cellDepth = ladderDepth(spec, cellStage);
      if (reachDepth >= cellDepth) continue;
      if (n.role === spec.reachLadder[1] && cellStage === spec.reachLadder[2]) continue;
      push(out, {
        antecedentQuestionId: n.questionId,
        consequentQuestionId: cellQid,
        pattern: 'host_stage_mutex',
        edgeType: 'mutual_exclusion',
        reasoning: `${n.subject} (host) reach ${n.role} ⊥ furthest host stage = ${cellStage} (strictly shallower)`,
      });
    }
  }
  return out;
}

// ── Node-universe classification (gated rows → rule inputs) ──────────────────

export interface TierBInputs {
  nodes: RoleNode[];
  membership: Map<string, string>;
  multiGroupTeams: Set<string>;
  aggCells: GroupAggregateCell[];
  hostCells: HostStageCells;
}

/** Classifies tier A's gated rows into tier-B rule inputs. Pure — exported for unit tests. */
export function classifyTierBRows(spec: TournamentFormatSpec, rows: readonly MarketNodeRow[]): TierBInputs {
  // A question whose member rows disagree on role/elimination/team gets no node (refusal, never an unsound edge).
  const nodeByQid = new Map<number, RoleNode>();
  const poisonedQids = new Set<number>();
  const membership = new Map<string, string>();
  const multiGroupTeams = new Set<string>();
  const aggCells: GroupAggregateCell[] = [];
  const hostByStage = new Map<TournamentRole, number>();
  const hostStageDupes = new Set<TournamentRole>();
  let winningFinalQuestionId: number | undefined;

  for (const row of rows) {
    const node = marketRowToRoleNode(row, spec);
    if (node) {
      const prev = nodeByQid.get(node.questionId);
      if (prev && (prev.role !== node.role
        || (prev.isElimination ?? false) !== (node.isElimination ?? false)
        || fold(prev.subject) !== fold(node.subject))) {
        poisonedQids.add(node.questionId);
      } else {
        nodeByQid.set(node.questionId, node);
      }
    }

    const parts = tickerParts(row.event_ticker);
    if (!parts) continue;
    const cell = (row.yes_sub_title ?? '').trim().toLowerCase();

    if (spec.groupAggregate && parts.series === spec.groupAggregate.memberSeries.toUpperCase()) {
      const letter = parts.suffix.replace(/^\d+/, '').toLowerCase();
      const team = (row.participants && row.participants.length > 0)
        ? row.participants[0] : row.canonical_subject;
      const teamFold = fold(team);
      if (letter && teamFold) {
        const prev = membership.get(teamFold);
        if (prev != null && prev !== letter) multiGroupTeams.add(teamFold);
        membership.set(teamFold, letter);
      }
    }

    if (spec.groupAggregate && parts.series === spec.groupAggregate.kalshiSeries.toUpperCase()) {
      const m = /^group ([a-z])$/.exec(cell);
      if (m) aggCells.push({ groupLetter: m[1]!, questionId: row.question_id });
    }

    if (spec.hostAggregate && parts.series === spec.hostAggregate.kalshiSeries.toUpperCase()) {
      const stage = Object.prototype.hasOwnProperty.call(spec.hostAggregate.stageCells, cell)
        ? spec.hostAggregate.stageCells[cell] : undefined;
      if (stage != null) {
        const prev = hostByStage.get(stage);
        if (prev != null && prev !== row.question_id) hostStageDupes.add(stage);
        hostByStage.set(stage, row.question_id);
      } else if (spec.hostAggregate.winningFinalCell != null && cell === spec.hostAggregate.winningFinalCell) {
        if (winningFinalQuestionId != null && winningFinalQuestionId !== row.question_id) {
          winningFinalQuestionId = -1; // sentinel: ambiguous, dropped below
        } else if (winningFinalQuestionId !== -1) {
          winningFinalQuestionId = row.question_id;
        }
      }
    }
  }
  for (const s of hostStageDupes) hostByStage.delete(s);
  const nodes: RoleNode[] = [];
  for (const [qid, node] of nodeByQid) {
    if (!poisonedQids.has(qid)) nodes.push(node);
  }
  return {
    nodes,
    membership,
    multiGroupTeams,
    aggCells,
    hostCells: {
      byStage: hostByStage,
      winningFinalQuestionId: winningFinalQuestionId === -1 ? undefined : winningFinalQuestionId,
    },
  };
}

export function drawGroupsToFoldMap(draw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const groups = (draw as { groups?: Record<string, unknown> } | null | undefined)?.groups;
  if (!groups || typeof groups !== 'object') return out;
  for (const [letter, teams] of Object.entries(groups)) {
    if (!Array.isArray(teams)) continue;
    for (const t of teams) {
      const f = typeof t === 'string' ? fold(t) : null;
      if (f) out.set(f, letter.toLowerCase());
    }
  }
  return out;
}

// ── Rule 4: cross-team champion Σ≤1 set ──────────────────────────────────────

// Edition gate: two coexisting editions of one champion series must never share a Σ≤1 set. Pass '' to skip.
function editionGateSql(paramIdx: number): string {
  return `AND ($${paramIdx} = ''
       OR coalesce(substring(split_part(mr.raw->>'event_ticker', '-', 2) FROM '^[0-9]+'), '') = $${paramIdx})`;
}

/** Per active tournament_state: champion-cell questions as one Σ≤1 categorical, from elimination-ladder championSubtitle cells and fixedStageIsChampion series, both edition-gated. SELECT-only. */
export async function loadTournamentChampionSets(): Promise<
  { stateId: number; setName: string; questionIds: number[] }[]
> {
  const states = await query<{ id: number; format_spec: TournamentFormatSpec }>(
    `SELECT id, format_spec FROM tournament_states WHERE active`,
  );
  const out: { stateId: number; setName: string; questionIds: number[] }[] = [];
  for (const st of states) {
    const spec = st.format_spec;
    const qids = new Set<number>();

    const elimRule = spec.seriesResolvers?.find(
      (r) => r.subtitleEliminationStages != null && r.championSubtitle != null,
    );
    if (elimRule) {
      const rows = await query<{ question_id: number }>(
        `SELECT DISTINCT q.id AS question_id
           FROM questions q
           JOIN question_members qm ON qm.question_id = q.id
           JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
           JOIN market_metadata_raw mr ON mr.market_id = m.id
          WHERE split_part(mr.raw->>'event_ticker', '-', 1) = $1
            AND lower(btrim(mr.raw->>'yes_sub_title')) = $2
            AND q.archived_at IS NULL
            ${editionGateSql(3)}
          ORDER BY q.id`,
        [elimRule.series.toUpperCase(), elimRule.championSubtitle, elimRule.editionDigits ?? ''],
      );
      for (const r of rows) qids.add(r.question_id);
    }

    for (const rule of spec.seriesResolvers ?? []) {
      if (!rule.fixedStageIsChampion) continue;
      const rows = await query<{ question_id: number }>(
        `SELECT DISTINCT q.id AS question_id
           FROM questions q
           JOIN question_members qm ON qm.question_id = q.id
           JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
           JOIN market_metadata_raw mr ON mr.market_id = m.id
          WHERE split_part(mr.raw->>'event_ticker', '-', 1) = $1
            AND q.archived_at IS NULL
            ${editionGateSql(2)}
          ORDER BY q.id`,
        [rule.series.toUpperCase(), rule.editionDigits ?? ''],
      );
      for (const r of rows) qids.add(r.question_id);
    }

    if (qids.size === 0) continue;
    out.push({
      stateId: st.id,
      setName: `${spec.competition.canonical} ${spec.competition.edition} champion`,
      questionIds: [...qids].sort((a, b) => a - b),
    });
  }
  return out;
}

/** Materializes the champion Σ≤1 sets (is_exhaustive=FALSE: cancellation is an all-NO world). Churn-safe delete+upsert, mirrors wc_elimination. */
export async function buildTournamentChampionMutexSets(): Promise<number> {
  const sets = await loadTournamentChampionSets();

  await query(`
    DELETE FROM outcome_set_slots
    WHERE set_id IN (SELECT id FROM outcome_sets WHERE source = 'tournament_champion')
  `);
  await query(
    `DELETE FROM outcome_sets
     WHERE source = 'tournament_champion'
       AND event_identity <> ALL($1::text[])`,
    [sets.map((s) => `tournament-champion:${s.stateId}`)],
  );

  // A singleton set is a free binary, not a mutex.
  const survivors = sets.filter((s) => s.questionIds.length >= 2);
  if (survivors.length === 0) return 0;

  await query(
    `INSERT INTO outcome_sets (event_identity, set_type, set_name, slot_count, confidence, source, is_exhaustive)
     SELECT 'tournament-champion:' || t.state_id, 'categorical', t.set_name, t.slot_count, 0.95, 'tournament_champion', FALSE
     FROM unnest($1::int[], $2::text[], $3::int[]) AS t(state_id, set_name, slot_count)
     ON CONFLICT (event_identity) DO UPDATE SET
       set_type      = EXCLUDED.set_type,
       set_name      = EXCLUDED.set_name,
       slot_count    = EXCLUDED.slot_count,
       is_exhaustive = EXCLUDED.is_exhaustive,
       updated_at    = NOW()`,
    [
      survivors.map((s) => s.stateId),
      survivors.map((s) => s.setName),
      survivors.map((s) => s.questionIds.length),
    ],
  );

  const slotEvent: string[] = [];
  const slotOrdinal: number[] = [];
  const slotQuestionId: number[] = [];
  for (const s of survivors) {
    s.questionIds.forEach((qid, i) => {
      slotEvent.push(`tournament-champion:${s.stateId}`);
      slotOrdinal.push(i + 1);
      slotQuestionId.push(qid);
    });
  }
  await query(
    `INSERT INTO outcome_set_slots (set_id, slot_ordinal, question_id)
     SELECT os.id, t.ord, t.qid
     FROM unnest($1::text[], $2::int[], $3::int[]) AS t(event_identity, ord, qid)
     JOIN outcome_sets os ON os.event_identity = t.event_identity
     ON CONFLICT (set_id, slot_ordinal) DO NOTHING`,
    [slotEvent, slotOrdinal, slotQuestionId],
  );

  log.info(`tournament champion mutex: ${survivors.length} Σ≤1 set(s) (is_exhaustive=FALSE)`);
  return survivors.length;
}

// ── DB-facing pass ────────────────────────────────────────────────────────────

/** Runs after tier A's buildTournamentEdges, which seeds the specs. */
export async function buildTournamentTierB(): Promise<{ edges: number; championSets: number }> {
  const championSets = await buildTournamentChampionMutexSets();

  const states = await query<{ id: number; format_spec: TournamentFormatSpec }>(
    `SELECT id, format_spec FROM tournament_states WHERE active`,
  );
  let edgesTotal = 0;
  for (const st of states) {
    const spec = st.format_spec;
    const prefix = spec.kalshiEventTickerPrefix;
    if (!prefix) continue;

    const rows = await loadTournamentMarketNodeRows(prefix);
    const inputs = classifyTierBRows(spec, rows);

    const edges: DerivedEdge[] = [
      ...deriveEliminationStageMutexes(spec, inputs.nodes),
      ...deriveGroupChampionSupersets({
        champions: inputs.nodes.filter((n) => !n.isElimination && n.role === spec.reachLadder[0]),
        membership: inputs.membership,
        multiGroupTeams: inputs.multiGroupTeams,
        aggCells: inputs.aggCells,
        drawGroups: drawGroupsToFoldMap((spec as { draw?: unknown }).draw),
      }),
      ...deriveHostStageMutexes(spec, inputs.nodes, inputs.hostCells),
    ];

    edgesTotal += await upsertTournamentEdgeRows(edges, st.id);
    log.info(
      `tier B ${spec.competition.canonical} ${spec.competition.edition}: ` +
      `${inputs.nodes.length} role-nodes → ${edges.length} edges`,
    );
  }
  return { edges: edgesTotal, championSets };
}
