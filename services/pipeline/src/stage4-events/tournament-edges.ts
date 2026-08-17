/**
 * Tier-A tournament edge derivation (static, no live state) from a
 * tournament's format_spec + role-classified outcome-nodes.
 *
 * Stage/team role is resolved only from gated fields (event_ticker +
 * yes_sub_title + participants), never platform_events.title. The only
 * sound elimination implication is eliminated-at-stage-S ⟹ reached-S.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { EDGE_CONFLICT_SQL, kalshiRawMembersJoinSql } from '../util/sql-fragments.js';

const log = createLogger('stage4-tournament-edges');

export type TournamentRole = string;

export interface TournamentFormatSpec {
  competition: { canonical: string; edition: string; sport: string };
  /** Deepest → shallowest; consecutive pairs get a strict_implication. */
  reachLadder: TournamentRole[];
  extraImplications: { from: TournamentRole; to: TournamentRole }[];
  supersets: { from: TournamentRole; aggregateRole: TournamentRole }[];
  nodeRoles?: { role: TournamentRole; titleMatch: string }[];
  competitionTitleAliases?: string[];
  kalshiEventTickerPrefix?: string;
  seriesResolvers?: SeriesResolverRule[];
  /** Emits final-winner(X) ⟹ champion(X); never the reverse direction. */
  finalFixture?: {
    kalshiGameSeries: string;
    dateUtc: string;
  };
  groupAggregate?: {
    kalshiSeries: string;
    memberSeries: string;
  };
  hostAggregate?: {
    kalshiSeries: string;
    hosts: string[];
    stageCells: Record<string, TournamentRole>;
    winningFinalCell?: string;
  };
}

export interface SeriesResolverRule {
  series: string;
  /** Per-rule, not per-spec: a series can carry different digits across rules. */
  editionDigits?: string;
  subtitleEliminationStages?: Record<string, TournamentRole>;
  championSubtitle?: string;
  suffixStages?: Record<string, TournamentRole>;
  fixedStage?: TournamentRole;
  fixedStageIsChampion?: boolean;
}

export interface RoleNode {
  questionId: number;
  role: TournamentRole;
  subject: string;
  group?: string | null;
  /** When both endpoints lack leagueId, edition-year tokens in titles must also agree. */
  leagueId?: number | null;
  /** Kept only for edition-year extraction, never for role assignment. */
  title?: string | null;
  isElimination?: boolean;
}

/** Titles matching this describe elimination/failure, never positive advancement
 *  (onboarding path only; the live node source uses gated fields instead). */
export const NEGATION_RX =
  /\b(?:eliminated|knocked\s*out|fail(?:s|ed|ing)?|miss(?:es|ed|ing)?|out\s+in|loser|relegat)/i;

export function editionYear(title: string | null | undefined): number | null {
  if (!title) return null;
  const m = /\b((?:19|20)\d{2})\b/.exec(title);
  return m ? parseInt(m[1]!, 10) : null;
}

export interface DerivedEdge {
  antecedentQuestionId: number;
  consequentQuestionId: number;
  pattern:
    | 'sequential_stage'
    | 'tournament_advancement'
    | 'participant_superset'
    | 'elimination_reach'
    | 'cross_set_tournament'
    | 'elimination_stage_mutex'
    | 'group_champion_superset'
    | 'host_stage_mutex';
  /** Defaults to 'strict_implication'; 'mutual_exclusion' only for the final-winner family. */
  edgeType?: 'strict_implication' | 'mutual_exclusion';
  reasoning: string;
}

/** group_winner is not a ladder rung; it's wired via extraImplications (⟹ r32). */
export type WcStage =
  | 'champion' | 'final' | 'sf' | 'qf' | 'r16' | 'r32' | 'group'
  | 'group_winner';

export interface WcStageClass {
  stage: WcStage;
  isElimination: boolean;
  isChampion: boolean;
}

export interface StageClass {
  stage: TournamentRole;
  isElimination: boolean;
  isChampion: boolean;
}

/** Splits event_ticker into {series, suffix}; null for a missing ticker. */
export function tickerParts(eventTicker: string | null | undefined): { series: string; suffix: string } | null {
  if (!eventTicker) return null;
  const dash = eventTicker.indexOf('-');
  if (dash < 0) return { series: eventTicker.toUpperCase(), suffix: '' };
  return { series: eventTicker.slice(0, dash).toUpperCase(), suffix: eventTicker.slice(dash + 1) };
}

/** Own-property lookup only — a yes_sub_title like 'constructor' must not resolve via the prototype. */
function lookupRole(map: Record<string, TournamentRole>, key: string): TournamentRole | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Resolves a node's stage from gated fields only (event_ticker + yes_sub_title),
 * driven by the spec's seriesResolvers data. Returns null for any unrecognised
 * series/cell so unmapped markets get no role and no edge.
 */
export function resolveStageClassFromSpec(
  spec: Pick<TournamentFormatSpec, 'seriesResolvers'>,
  eventTicker: string | null | undefined,
  yesSubTitle: string | null | undefined,
): StageClass | null {
  const parts = tickerParts(eventTicker);
  if (!parts || !spec.seriesResolvers?.length) return null;
  const rule = spec.seriesResolvers.find((r) => r.series.toUpperCase() === parts.series);
  if (!rule) return null;
  // A foreign edition's suffix digits get no role, so editions never cross-link.
  if (rule.editionDigits != null) {
    const digits = /^\d+/.exec(parts.suffix)?.[0] ?? '';
    if (digits !== rule.editionDigits) return null;
  }
  const sub = (yesSubTitle ?? '').trim().toLowerCase();

  if (rule.subtitleEliminationStages) {
    if (rule.championSubtitle != null && sub === rule.championSubtitle) {
      return { stage: 'champion', isElimination: false, isChampion: true };
    }
    const st = lookupRole(rule.subtitleEliminationStages, sub);
    if (st == null) return null;
    return { stage: st, isElimination: true, isChampion: false };
  }
  if (rule.suffixStages) {
    const suffix = parts.suffix.replace(/^\d+/, '').toLowerCase();
    const st = lookupRole(rule.suffixStages, suffix);
    if (st == null) return null;
    return { stage: st, isElimination: false, isChampion: false };
  }
  if (rule.fixedStage != null) {
    return { stage: rule.fixedStage, isElimination: false, isChampion: rule.fixedStageIsChampion ?? false };
  }
  return null;
}

/** FIFA WC 2026 instance of the generic resolver (data in WC_2026_FORMAT_SPEC.seriesResolvers). */
export function resolveWcStageClass(
  eventTicker: string | null | undefined,
  yesSubTitle: string | null | undefined,
): WcStageClass | null {
  return resolveStageClassFromSpec(WC_2026_FORMAT_SPEC, eventTicker, yesSubTitle) as WcStageClass | null;
}

/** Returns null when unknown, which skips the superset edge rather than guessing. */
export type ConfederationResolver = (teamCanonical: string) => string | null;

/** Deterministic, dedup'd; emits an edge only when both endpoint nodes exist. */
export function deriveTournamentEdges(
  spec: TournamentFormatSpec,
  nodes: readonly RoleNode[],
  confederationOf: ConfederationResolver = () => null,
): DerivedEdge[] {
  // Positive reach/aggregate nodes only; elimination nodes are never ladder targets.
  const byRole = new Map<TournamentRole, Map<string, RoleNode>>();
  const elimsBySubject = new Map<string, RoleNode[]>();
  for (const n of nodes) {
    const subj = n.subject.toLowerCase().trim();
    if (n.isElimination) {
      const arr = elimsBySubject.get(subj);
      if (arr) arr.push(n);
      else elimsBySubject.set(subj, [n]);
      continue;
    }
    let m = byRole.get(n.role);
    if (!m) { m = new Map(); byRole.set(n.role, m); }
    m.set(subj, n);
  }

  const out: DerivedEdge[] = [];
  const seen = new Set<string>();
  const push = (ante: RoleNode, cons: RoleNode, pattern: DerivedEdge['pattern'], reasoning: string) => {
    if (ante.questionId === cons.questionId) return;
    // When neither node has a league_id, refuse the edge unless titles' edition years agree.
    if (ante.leagueId == null && cons.leagueId == null) {
      const ya = editionYear(ante.title);
      const yc = editionYear(cons.title);
      if (ya != null && yc != null && ya !== yc) return;
    }
    const key = `${ante.questionId}->${cons.questionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ antecedentQuestionId: ante.questionId, consequentQuestionId: cons.questionId, pattern, reasoning });
  };

  for (let i = 0; i < spec.reachLadder.length - 1; i++) {
    const deep = byRole.get(spec.reachLadder[i]!);
    const shallow = byRole.get(spec.reachLadder[i + 1]!);
    if (!deep || !shallow) continue;
    for (const [subj, deepNode] of deep) {
      const shallowNode = shallow.get(subj);
      if (shallowNode) {
        push(deepNode, shallowNode, 'sequential_stage',
          `${deepNode.subject}: reach ${deepNode.role} ⟹ reach ${shallowNode.role}`);
      }
    }
  }

  for (const { from, to } of spec.extraImplications) {
    const fromM = byRole.get(from);
    const toM = byRole.get(to);
    if (!fromM || !toM) continue;
    for (const [subj, fromNode] of fromM) {
      const toNode = toM.get(subj);
      if (toNode) {
        push(fromNode, toNode, 'tournament_advancement',
          `${fromNode.subject}: ${fromNode.role} ⟹ ${toNode.role}`);
      }
    }
  }

  for (const { from, aggregateRole } of spec.supersets) {
    const fromM = byRole.get(from);
    const aggM = byRole.get(aggregateRole);
    if (!fromM || !aggM) continue;
    for (const fromNode of fromM.values()) {
      const conf = confederationOf(fromNode.subject);
      if (!conf) continue;
      const aggNode = aggM.get(conf.toLowerCase().trim());
      if (aggNode) {
        push(fromNode, aggNode, 'participant_superset',
          `${fromNode.subject} ${fromNode.role} ⟹ ${aggNode.subject} (${aggregateRole})`);
      }
    }
  }

  // 4. Elimination channel: eliminated-at-S ⟹ reached-S only (same role/subject).
  for (const [subj, elims] of elimsBySubject) {
    for (const elim of elims) {
      const reachM = byRole.get(elim.role);
      if (!reachM) continue;
      const reachNode = reachM.get(subj);
      if (!reachNode) continue;
      push(elim, reachNode, 'elimination_reach',
        `${elim.subject}: eliminated at ${elim.role} ⟹ reached ${reachNode.role}`);
    }
  }

  return out;
}

// nodeRoles must stay ordered specific→general (group_winner before champion,
// confederation before champion) — matched top-to-bottom.
export const WC_2026_FORMAT_SPEC: TournamentFormatSpec = {
  competition: { canonical: 'FIFA World Cup', edition: '2026', sport: 'soccer' },
  reachLadder: ['champion', 'final', 'sf', 'qf', 'r16', 'r32'],
  extraImplications: [{ from: 'group_winner', to: 'r32' }],
  supersets: [{ from: 'champion', aggregateRole: 'confederation_champion' }],
  competitionTitleAliases: ['%fifa world cup%', '%2026%world cup%', "%men's world cup%"],
  kalshiEventTickerPrefix: 'KXWC',
  seriesResolvers: [
    {
      series: 'KXWCSTAGEOFELIM',
      editionDigits: '26',
      championSubtitle: 'outright winner',
      subtitleEliminationStages: {
        'group stage': 'group',
        'round of 32': 'r32',
        'round of 16': 'r16',
        quarterfinals: 'qf',
        semifinals: 'sf',
        'runner-up': 'final', // lost the Final → reached the Final
      },
    },
    { series: 'KXWCROUND', editionDigits: '26', suffixStages: { final: 'final', semi: 'sf', quar: 'qf', ro16: 'r16' } },
    { series: 'KXWCGROUPQUAL', editionDigits: '26', fixedStage: 'r32' },
    { series: 'KXWCGROUPWIN', editionDigits: '26', fixedStage: 'group_winner' },
  ],
  finalFixture: { kalshiGameSeries: 'KXWCGAME', dateUtc: '2026-07-19' },
  groupAggregate: { kalshiSeries: 'KXWCGROUPWINNER', memberSeries: 'KXWCGROUPQUAL' },
  hostAggregate: {
    kalshiSeries: 'KXWCSTAGE',
    hosts: ['USA', 'Mexico', 'Canada'],
    stageCells: {
      'group stage': 'group',
      'round of 32': 'r32',
      'round of 16': 'r16',
      quarterfinals: 'qf',
      semifinals: 'sf',
    },
    // Losing the final is deliberately unmapped (settlement-scope); only the win cell is wired.
    winningFinalCell: 'winning the final',
  },
  nodeRoles: [
    { role: 'group_winner',           titleMatch: 'group [a-l]\\b.*winner|winner.*group [a-l]\\b|finish first.*group [a-l]' },
    { role: 'confederation_champion', titleMatch: 'continent.*win|confederation.*win' },
    { role: 'final',                  titleMatch: 'reach.*final|nation to reach the final|to reach the final' },
    { role: 'sf',                     titleMatch: 'sem[i][- ]?final' },
    { role: 'qf',                     titleMatch: 'quarter[- ]?final' },
    { role: 'r16',                    titleMatch: 'round of 16|last 16' },
    { role: 'r32',                    titleMatch: 'qualify from .*group|advance to .*knockout|round of 32|knockout stage' },
    { role: 'champion',               titleMatch: "world cup winner|win(s)? the (men's )?(2026 )?world cup" },
    // Orthogonal props (top scorer, squad, etc.) match nothing here — intentional, not a gap.
  ],
};

/** Seeded on every Stage-4 pass so a stale DB row (rebuild wipes preserve tournament_states) stays in lockstep. */
export async function upsertTournamentState(
  spec: TournamentFormatSpec,
  source = 'study-case',
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO tournament_states (canonical, edition, sport, external_source, format_spec)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (canonical, edition) DO UPDATE
       SET format_spec = tournament_states.format_spec || EXCLUDED.format_spec,
           sport = EXCLUDED.sport,
           external_source = EXCLUDED.external_source, updated_at = NOW()
     RETURNING id`,
    [spec.competition.canonical, spec.competition.edition, spec.competition.sport, source, JSON.stringify(spec)],
  );
  return rows[0]!.id;
}

export const MARCH_MADNESS_2027_FORMAT_SPEC: TournamentFormatSpec = {
  competition: { canonical: "NCAA Men's Basketball Tournament", edition: '2027', sport: 'basketball' },
  reachLadder: ['champion', 'final', 'sf', 'qf', 'r16', 'r32'],
  extraImplications: [],
  supersets: [],
  kalshiEventTickerPrefix: 'KXMARMAD',
  seriesResolvers: [
    { series: 'KXMARMAD', editionDigits: '27', fixedStage: 'champion', fixedStageIsChampion: true },
    { series: 'KXMARMADROUND', editionDigits: '27', suffixStages: { t2: 'final', f4: 'sf', r8: 'qf', r16: 'r16', r32: 'r32' } },
  ],
};

// Conference championships deliberately get no rule: a title doesn't guarantee a playoff berth.
export const CFB_PLAYOFF_2027_FORMAT_SPEC: TournamentFormatSpec = {
  competition: { canonical: 'College Football Playoff', edition: '2027', sport: 'american football' },
  reachLadder: ['champion', 'final', 'playoff'],
  extraImplications: [],
  supersets: [],
  kalshiEventTickerPrefix: 'KXNCAAF',
  // editionDigits are intentionally mixed: champion/finalist carry '27', playoff-berth carries '26'.
  seriesResolvers: [
    { series: 'KXNCAAF', editionDigits: '27', fixedStage: 'champion', fixedStageIsChampion: true },
    { series: 'KXNCAAFFINALIST', editionDigits: '27', fixedStage: 'final' },
    { series: 'KXNCAAFPLAYOFF', editionDigits: '26', fixedStage: 'playoff' },
  ],
};

export const CWS_2026_FORMAT_SPEC: TournamentFormatSpec = {
  competition: { canonical: 'College Baseball World Series', edition: '2026', sport: 'baseball' },
  reachLadder: ['champion', 'cws'],
  extraImplications: [],
  supersets: [],
  kalshiEventTickerPrefix: 'KXNCAAB',
  seriesResolvers: [
    { series: 'KXNCAABASEBALL', editionDigits: '26', fixedStage: 'champion', fixedStageIsChampion: true },
    { series: 'KXNCAABBPLAYOFFS', editionDigits: '26', fixedStage: 'cws' },
  ],
};

/** Seeded on every Stage-4 pass so a stale DB row (rebuild wipes preserve tournament_states) stays in lockstep. */
export const PIPELINE_FORMAT_SPECS: readonly TournamentFormatSpec[] = [
  WC_2026_FORMAT_SPEC,
  MARCH_MADNESS_2027_FORMAT_SPEC,
  CFB_PLAYOFF_2027_FORMAT_SPEC,
  CWS_2026_FORMAT_SPEC,
];

/** Idempotent upsert of every code-authored spec. */
export async function seedTournamentStates(source = 'pipeline-seed'): Promise<void> {
  for (const spec of PIPELINE_FORMAT_SPECS) {
    await upsertTournamentState(spec, source);
  }
}

/** Empty map when the KB hasn't classified confederations — supersets simply don't fire. */
async function loadConfederationMap(): Promise<Map<string, string>> {
  const rows = await query<{ canonical: string; conf: string }>(
    `SELECT lower(canonical) AS canonical, metadata->>'confederation' AS conf
       FROM known_entities
      WHERE metadata->>'confederation' IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.canonical, r.conf]));
}

export interface MarketNodeRow {
  question_id: number;
  event_ticker: string | null;
  yes_sub_title: string | null;
  participants: string[] | null;
  canonical_subject: string | null;
  event_title: string | null;
  league_id: number | null;
}

/** Loads a competition's node rows by gated event_ticker prefix; shared by tier-A and tier-B so both read one node universe. */
export async function loadTournamentMarketNodeRows(prefix: string): Promise<MarketNodeRow[]> {
  return query<MarketNodeRow>(
    `SELECT q.id AS question_id,
            mr.raw->>'event_ticker'  AS event_ticker,
            mr.raw->>'yes_sub_title' AS yes_sub_title,
            q.participants           AS participants,
            q.canonical_subject      AS canonical_subject,
            COALESCE(pe.canonical_event, pe.title) AS event_title,
            q.league_id              AS league_id
       FROM questions q
       ${kalshiRawMembersJoinSql('q')}
       LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
      WHERE mr.raw->>'event_ticker' ILIKE $1
        AND q.archived_at IS NULL`,
    [`${prefix}%`],
  );
}

/** Team identity = participants[0]; canonical_subject is a last-resort fallback only. */
export function marketRowToRoleNode(
  row: MarketNodeRow,
  spec: TournamentFormatSpec = WC_2026_FORMAT_SPEC,
): RoleNode | null {
  const cls = resolveStageClassFromSpec(spec, row.event_ticker, row.yes_sub_title);
  if (!cls) return null;
  const team = (row.participants && row.participants.length > 0)
    ? row.participants[0]
    : row.canonical_subject;
  if (!team || !team.trim()) return null;
  return {
    questionId: row.question_id,
    role: cls.stage,
    subject: team.trim(),
    leagueId: row.league_id,
    title: row.event_title,
    isElimination: cls.isElimination,
  };
}

export interface FinalFixtureWinnerNode {
  questionId: number;
  subject: string;
  participants: readonly string[];
}

/**
 * final-winner(X) ⟹ champion(X), plus mutex(champion(X), final-winner(Y≠X)).
 * Never emit the reverse: a regulation-scoped final can resolve NO even when
 * X wins on penalties, so champion(X) does not imply final-winner(X)=YES.
 */
export function deriveFinalWinnerEdges(
  nodes: readonly RoleNode[],
  finalWinners: readonly FinalFixtureWinnerNode[],
): DerivedEdge[] {
  const champs = new Map<string, RoleNode>();
  for (const n of nodes) {
    if (n.isElimination || n.role !== 'champion') continue;
    champs.set(n.subject.toLowerCase().trim(), n);
  }
  const out: DerivedEdge[] = [];
  const seen = new Set<string>();
  const push = (e: DerivedEdge) => {
    if (e.antecedentQuestionId === e.consequentQuestionId) return;
    const key = `${e.antecedentQuestionId}->${e.consequentQuestionId}:${e.edgeType}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const f of finalWinners) {
    const subj = f.subject.toLowerCase().trim();
    if (!subj) continue;
    const c = champs.get(subj);
    if (c) {
      push({
        antecedentQuestionId: f.questionId,
        consequentQuestionId: c.questionId,
        pattern: 'cross_set_tournament',
        edgeType: 'strict_implication',
        reasoning: `${f.subject}: wins the final (fixture) ⟹ champion`,
      });
    }
    for (const [s, cx] of champs) {
      if (s === subj) continue;
      push({
        antecedentQuestionId: cx.questionId,
        consequentQuestionId: f.questionId,
        pattern: 'cross_set_tournament',
        edgeType: 'mutual_exclusion',
        reasoning: `${cx.subject} champion ⊥ ${f.subject} wins the final (only the final's winner lifts the trophy)`,
      });
    }
  }
  return out;
}

/** Gates: exact game-series ticker, 2-participant match_winner, official final date; excludes third-place fixtures. */
export function finalWinnerNodesSql(): string {
  return `
    SELECT q.id AS question_id,
           q.canonical_subject AS subject,
           q.participants AS participants
      FROM questions q
      ${kalshiRawMembersJoinSql('q')}
      LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
     WHERE split_part(mr.raw->>'event_ticker', '-', 1) = $1
       AND q.archived_at IS NULL
       AND q.event_kind = 'match_winner'
       AND COALESCE(array_length(q.participants, 1), 0) = 2
       AND q.canonical_subject = ANY (q.participants)
       AND pe.condition_date::date = $2::date
     GROUP BY q.id
    HAVING bool_and(m.title !~* '\\m(third|3rd)[ -]place\\M|\\mbronze\\M')`;
}

/** Per-team elimination mutex sets (Σ≤1, is_exhaustive=false — a withdrawn team is all-NO). */
export async function loadWcEliminationMutexSets(): Promise<
  { peId: number; setName: string; questionIds: number[] }[]
> {
  const rows = await query<{
    pe_id: number; set_name: string | null; question_id: number; event_ticker: string | null;
  }>(`
    SELECT pe.id AS pe_id,
           COALESCE(pe.canonical_event, pe.title) AS set_name,
           q.id AS question_id,
           mr.raw->>'event_ticker' AS event_ticker
      FROM platform_events pe
      JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
      JOIN market_metadata_raw mr ON mr.market_id = m.id
      JOIN question_members qm ON qm.market_id = m.id
      JOIN questions q ON q.id = qm.question_id
     WHERE pe.platform = 'kalshi'
       AND mr.raw->>'event_ticker' ILIKE 'KXWCSTAGEOFELIM-%'
       AND q.archived_at IS NULL
     ORDER BY pe.id, q.id
  `);
  const byPe = new Map<number, { setName: string; questionIds: number[] }>();
  for (const r of rows) {
    let g = byPe.get(r.pe_id);
    if (!g) { g = { setName: r.set_name ?? `WC elimination ${r.event_ticker ?? r.pe_id}`, questionIds: [] }; byPe.set(r.pe_id, g); }
    g.questionIds.push(r.question_id);
  }
  return [...byPe.entries()].map(([peId, g]) => ({ peId, setName: g.setName, questionIds: g.questionIds }));
}

/** Tier-A edge build for every active tournament_state; no states/nodes ⇒ 0 edges (safe pre-onboarding). */
export async function buildTournamentEdges(): Promise<number> {
  await seedTournamentStates();

  const states = await query<{ id: number; format_spec: TournamentFormatSpec }>(
    `SELECT id, format_spec FROM tournament_states WHERE active`,
  );
  if (states.length === 0) return 0;

  const conf = await loadConfederationMap();
  let total = 0;

  for (const st of states) {
    const spec = st.format_spec;
    const prefix = spec.kalshiEventTickerPrefix;
    if (!prefix) continue; // only the gated Kalshi-native path is wired

    // event title rides along only for the year-agreement guard, never role assignment.
    const rows = await loadTournamentMarketNodeRows(prefix);

    const nodes: RoleNode[] = [];
    for (const r of rows) {
      const node = marketRowToRoleNode(r, spec);
      if (node) nodes.push(node);
    }

    const edges = deriveTournamentEdges(spec, nodes, (t) => conf.get(t.toLowerCase().trim()) ?? null);

    // Armed only when the spec pins the final fixture (series + official date).
    if (spec.finalFixture?.kalshiGameSeries && spec.finalFixture.dateUtc) {
      const fwRows = await query<{ question_id: number; subject: string | null; participants: string[] | null }>(
        finalWinnerNodesSql(),
        [spec.finalFixture.kalshiGameSeries, spec.finalFixture.dateUtc],
      );
      const finalWinners: FinalFixtureWinnerNode[] = [];
      for (const r of fwRows) {
        if (!r.subject || !r.participants || r.participants.length !== 2) continue;
        finalWinners.push({ questionId: r.question_id, subject: r.subject, participants: r.participants });
      }
      edges.push(...deriveFinalWinnerEdges(nodes, finalWinners));
    }

    total += await upsertTournamentEdgeRows(edges, st.id);
    log.info(`tournament ${spec.competition.canonical} ${spec.competition.edition}: ${nodes.length} role-nodes → ${edges.length} edges`);
  }
  return total;
}

/** Tagged with tournament_state_id for reversibility; shared with the tier-B pass. */
export async function upsertTournamentEdgeRows(edges: readonly DerivedEdge[], stateId: number): Promise<number> {
  if (edges.length === 0) return 0;
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < edges.length; i += BATCH) {
    const slice = edges.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((e, j) => {
      const b = j * 5;
      values.push(`($${b + 1}::int, $${b + 2}::int, $${b + 3}::text, $${b + 4}::text, $${b + 5}::text)`);
      params.push(
        e.antecedentQuestionId,
        e.consequentQuestionId,
        e.edgeType ?? 'strict_implication',
        e.pattern,
        e.reasoning,
      );
    });
    params.push(stateId);
    const sp = `$${slice.length * 5 + 1}::int`;
    const res = await query<{ n: number }>(
      `WITH ins AS (
         INSERT INTO implication_edges
           (antecedent_question_id, consequent_question_id, edge_type, pattern,
            confidence, deterministic, source, reasoning, tournament_state_id)
         SELECT v.a, v.c, v.t, v.p, 1.0, TRUE, 'algorithmic', v.r, ${sp}
         FROM (VALUES ${values.join(',')}) AS v(a, c, t, p, r)
         ${EDGE_CONFLICT_SQL}
         RETURNING 1
       )
       SELECT COUNT(*)::int AS n FROM ins`,
      params,
    );
    inserted += res[0]?.n ?? 0;
  }
  return inserted;
}
