/**
 * Tests for tournament edge derivation on the WC 2026 format_spec. Pure
 * logic — no DB.
 */
import { describe, test, expect } from 'bun:test';
import {
  deriveTournamentEdges,
  deriveFinalWinnerEdges,
  finalWinnerNodesSql,
  WC_2026_FORMAT_SPEC,
  MARCH_MADNESS_2027_FORMAT_SPEC,
  CFB_PLAYOFF_2027_FORMAT_SPEC,
  PIPELINE_FORMAT_SPECS,
  NEGATION_RX,
  editionYear,
  resolveWcStageClass,
  resolveStageClassFromSpec,
  marketRowToRoleNode,
  type RoleNode,
  type DerivedEdge,
  type FinalFixtureWinnerNode,
} from './tournament-edges.js';

const CONF: Record<string, string> = {
  argentina: 'South America', brazil: 'South America', france: 'Europe',
};
const confederationOf = (t: string) => CONF[t.toLowerCase()] ?? null;

// Helper: find an edge between two question ids.
function edge(edges: DerivedEdge[], ante: number, cons: number): DerivedEdge | undefined {
  return edges.find((e) => e.antecedentQuestionId === ante && e.consequentQuestionId === cons);
}

// Argentina nodes across the full ladder (qid 1=champion … 6=r32), group winner 7.
function argentinaLadder(): RoleNode[] {
  return [
    { questionId: 1, role: 'champion', subject: 'Argentina' },
    { questionId: 2, role: 'final',    subject: 'Argentina' },
    { questionId: 3, role: 'sf',       subject: 'Argentina' },
    { questionId: 4, role: 'qf',       subject: 'Argentina' },
    { questionId: 5, role: 'r16',      subject: 'Argentina' },
    { questionId: 6, role: 'r32',      subject: 'Argentina' },
    { questionId: 7, role: 'group_winner', subject: 'Argentina', group: 'A' },
  ];
}

describe('deriveTournamentEdges — WC 2026', () => {
  test('monotonic ladder: consecutive deep ⟹ shallow per team', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaLadder(), confederationOf);
    // champion⟹final, final⟹sf, sf⟹qf, qf⟹r16, r16⟹r32
    expect(edge(edges, 1, 2)?.pattern).toBe('sequential_stage');
    expect(edge(edges, 2, 3)).toBeDefined();
    expect(edge(edges, 3, 4)).toBeDefined();
    expect(edge(edges, 4, 5)).toBeDefined();
    expect(edge(edges, 5, 6)).toBeDefined();
  });

  test('group_winner ⟹ r32 (advance) via extraImplications', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaLadder(), confederationOf);
    const e = edge(edges, 7, 6);
    expect(e).toBeDefined();
    expect(e?.pattern).toBe('tournament_advancement');
  });

  test('ladder is only between ADJACENT levels (no champion⟹r32 direct skip-edge)', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaLadder(), confederationOf);
    // champion(1) directly to r32(6) is NOT emitted (transitivity is the LP's job).
    expect(edge(edges, 1, 6)).toBeUndefined();
  });

  test('KB superset: champion(team) ⟹ confederation wins', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina' },
      { questionId: 10, role: 'confederation_champion', subject: 'South America' },
      { questionId: 11, role: 'confederation_champion', subject: 'Europe' },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    const e = edge(edges, 1, 10);
    expect(e?.pattern).toBe('participant_superset');
    // Argentina must NOT imply Europe.
    expect(edge(edges, 1, 11)).toBeUndefined();
  });

  test('missing endpoint ⇒ no edge (never invent a node for an uncovered stage)', () => {
    // Only champion + r32 exist (no final/sf/qf/r16 markets).
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina' },
      { questionId: 6, role: 'r32', subject: 'Argentina' },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    // champion's only adjacent ladder neighbour (final) is absent ⇒ no champion edge.
    expect(edges.filter((e) => e.antecedentQuestionId === 1)).toHaveLength(0);
  });

  test('different teams are never linked across the ladder', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina' },
      { questionId: 2, role: 'final', subject: 'France' },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    expect(edges).toHaveLength(0);
  });

  test('no superset edge when confederation is unknown', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Narnia' },
      { questionId: 10, role: 'confederation_champion', subject: 'South America' },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    expect(edges).toHaveLength(0);
  });

  test('edges are dedup\'d and never self-referential', () => {
    const dupe = [...argentinaLadder(), ...argentinaLadder()];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, dupe, confederationOf);
    const keys = edges.map((e) => `${e.antecedentQuestionId}->${e.consequentQuestionId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(edges.every((e) => e.antecedentQuestionId !== e.consequentQuestionId)).toBe(true);
  });
});

// Replicates buildTournamentEdges' role-classification step (negation guard +
// first-matching reach regex) on (title, subject) pairs — the only part of the
// DB pass that is pure. Proves the verified "eliminated" leak is plugged.
function classify(
  inputs: readonly { questionId: number; title: string; subject: string }[],
): RoleNode[] {
  const roleRx = WC_2026_FORMAT_SPEC.nodeRoles!.map((r) => ({ role: r.role, rx: new RegExp(r.titleMatch, 'i') }));
  const nodes: RoleNode[] = [];
  for (const r of inputs) {
    if (NEGATION_RX.test(r.title)) continue; // guard #1
    const hit = roleRx.find((rr) => rr.rx.test(r.title));
    if (hit) nodes.push({ questionId: r.questionId, role: hit.role, subject: r.subject, title: r.title });
  }
  return nodes;
}

describe('soundness guards', () => {
  // Guard #1 — negative-phrasing exclusion (verified leak).
  test('"eliminated in Conference Finals" never gets a positive reach role → no champion⟹eliminated edge', () => {
    // Without the guard, "...reach the final"-style regex would tag the
    // eliminated node as role=final, and a real champion node would imply it.
    const inputs = [
      { questionId: 1, title: 'Will Boston Celtics win the 2026 NBA Finals?', subject: 'Boston Celtics' },
      { questionId: 2, title: 'Celtics eliminated in Conference Finals', subject: 'Boston Celtics' },
    ];
    const nodes = classify(inputs);
    // The eliminated node must NOT be classified into any positive role.
    expect(nodes.find((n) => n.questionId === 2)).toBeUndefined();
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    // No edge may point at the eliminated node (qid 2).
    expect(edges.some((e) => e.consequentQuestionId === 2 || e.antecedentQuestionId === 2)).toBe(false);
  });

  test('a clean "reach the final" title still classifies (guard does not over-fire)', () => {
    const inputs = [
      { questionId: 3, title: 'Will France reach the final of the 2026 World Cup?', subject: 'France' },
    ];
    const nodes = classify(inputs);
    expect(nodes.find((n) => n.questionId === 3)?.role).toBe('final');
  });

  test('NEGATION_RX matches the full token set', () => {
    for (const t of ['eliminated', 'knocked out', 'fail to reach', 'fails', 'misses out',
                      'out in the quarters', 'loser bracket', 'relegated']) {
      expect(NEGATION_RX.test(t)).toBe(true);
    }
    expect(NEGATION_RX.test('reach the final')).toBe(false);
  });

  // Guard #3 — edition-token agreement when both league_id are NULL.
  test('two unpinned same-named events with DIFFERENT editions do not cross-link', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina', leagueId: null, title: 'Win the 2026 World Cup' },
      { questionId: 2, role: 'final',    subject: 'Argentina', leagueId: null, title: 'Reach the final of the 2030 World Cup' },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    expect(edge(edges, 1, 2)).toBeUndefined();
  });

  test('same edition (or absent year) still links when both league_id are NULL', () => {
    const same: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina', leagueId: null, title: 'Win the 2026 World Cup' },
      { questionId: 2, role: 'final',    subject: 'Argentina', leagueId: null, title: 'Reach the 2026 World Cup final' },
    ];
    expect(edge(deriveTournamentEdges(WC_2026_FORMAT_SPEC, same, confederationOf), 1, 2)).toBeDefined();
    const noYear: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina', leagueId: null, title: 'Win the World Cup' },
      { questionId: 2, role: 'final',    subject: 'Argentina', leagueId: null, title: 'Reach the World Cup final' },
    ];
    expect(edge(deriveTournamentEdges(WC_2026_FORMAT_SPEC, noYear, confederationOf), 1, 2)).toBeDefined();
  });

  test('edition mismatch is IGNORED when a league_id pins the competition', () => {
    // A shared/known league_id means the events are pinned to one instance; the
    // year-token heuristic must not override it (guard only fires when both NULL).
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Argentina', leagueId: 77, title: 'Win the 2026 World Cup' },
      { questionId: 2, role: 'final',    subject: 'Argentina', leagueId: 77, title: 'Reach the 2030 final' },
    ];
    expect(edge(deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf), 1, 2)).toBeDefined();
  });

  test('editionYear extracts the first 19xx/20xx token, else null', () => {
    expect(editionYear('Win the 2026 World Cup')).toBe(2026);
    expect(editionYear('UEFA Euro 1996 winner')).toBe(1996);
    expect(editionYear('Win the World Cup')).toBeNull();
    expect(editionYear('Over 2.5 goals')).toBeNull(); // 2.5 is not a 4-digit year
    expect(editionYear(null)).toBeNull();
  });
});

// ── Blocker B: gated stage/team resolver (event_ticker + yes_sub_title only) ──
describe('resolveWcStageClass — gated stage resolver', () => {
  test('KXWCSTAGEOFELIM stages map to reach stage + isElimination', () => {
    const cases: [string, string, string, boolean, boolean][] = [
      // ticker, yes_sub_title, expected stage, isElimination, isChampion
      ['KXWCSTAGEOFELIM-26ARG', 'Group Stage',     'group',  true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Round of 32',     'r32',    true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Round of 16',     'r16',    true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Quarterfinals',   'qf',     true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Semifinals',      'sf',     true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Runner-Up',       'final',  true,  false],
      ['KXWCSTAGEOFELIM-26ARG', 'Outright Winner', 'champion', false, true],
    ];
    for (const [et, yst, stage, isElim, isChamp] of cases) {
      const cls = resolveWcStageClass(et, yst);
      expect(cls).not.toBeNull();
      expect(cls!.stage).toBe(stage as never);
      expect(cls!.isElimination).toBe(isElim);
      expect(cls!.isChampion).toBe(isChamp);
    }
  });

  test('KXWCROUND suffix maps to a positive reach stage (not elimination)', () => {
    expect(resolveWcStageClass('KXWCROUND-26FINAL', 'Argentina')).toEqual(
      { stage: 'final', isElimination: false, isChampion: false } as never);
    expect(resolveWcStageClass('KXWCROUND-26SEMI', 'France')?.stage).toBe('sf' as never);
    expect(resolveWcStageClass('KXWCROUND-26QUAR', 'Brazil')?.stage).toBe('qf' as never);
    expect(resolveWcStageClass('KXWCROUND-26RO16', 'Spain')?.stage).toBe('r16' as never);
  });

  test('KXWCGROUPQUAL is reach-r32 (qualify from group), positive', () => {
    const cls = resolveWcStageClass('KXWCGROUPQUAL-26A', 'Mexico');
    expect(cls).toEqual({ stage: 'r32', isElimination: false, isChampion: false } as never);
  });

  test('non-stage series + unknown cells get NO role (props/awards/trivia/game)', () => {
    expect(resolveWcStageClass('KXWCSQUAD-26ARG', 'Messi')).toBeNull();
    expect(resolveWcStageClass('KXWCAWARD-26', 'Golden Boot')).toBeNull();
    expect(resolveWcStageClass('KXWCGAME-26ARGALG', 'Argentina')).toBeNull();
    expect(resolveWcStageClass('KXWCGROUPWINNER-26', 'Group L')).toBeNull();
    // host-aggregate "furthest stage by any host" must NOT become a per-team node.
    expect(resolveWcStageClass('KXWCSTAGE-26HOST', 'Semifinals')).toBeNull();
    // an unknown yes_sub_title cell on the elimination series → no guess.
    expect(resolveWcStageClass('KXWCSTAGEOFELIM-26ARG', 'Third Place')).toBeNull();
    expect(resolveWcStageClass(null, 'Round of 16')).toBeNull();
    expect(resolveWcStageClass('', '')).toBeNull();
  });

  test('case / whitespace tolerant on the yes_sub_title cell', () => {
    expect(resolveWcStageClass('KXWCSTAGEOFELIM-26ARG', '  ROUND OF 16 ')?.stage).toBe('r16' as never);
    expect(resolveWcStageClass('kxwcstageofelim-26arg', 'outright winner')?.isChampion).toBe(true);
  });

  test('KXWCGROUPWIN is the per-team group_winner role (positive, never elimination/champion)', () => {
    expect(resolveWcStageClass('KXWCGROUPWIN-26A', 'Czechia')).toEqual(
      { stage: 'group_winner', isElimination: false, isChampion: false } as never);
    expect(resolveWcStageClass('kxwcgroupwin-26l', 'Mexico')?.stage).toBe('group_winner' as never);
  });

  test('KXWCGROUPWIN does not bleed into the similarly named aggregate KXWCGROUPWINNER series', () => {
    // "Will a team from Group L win the World Cup?" — an aggregate partition
    // market over groups, NOT a per-team group winner. Exact-series match only.
    expect(resolveWcStageClass('KXWCGROUPWINNER-26', 'Group L')).toBeNull();
  });
});

describe('pipeline format-spec seed', () => {
  test('WC_2026_FORMAT_SPEC carries kalshiEventTickerPrefix', () => {
    // Without this field buildTournamentEdges skips the spec
    // (`if (!spec.kalshiEventTickerPrefix) continue`) and the layer emits 0
    // edges. Never ship a spec without it.
    expect(WC_2026_FORMAT_SPEC.kalshiEventTickerPrefix).toBe('KXWC');
  });

  test('every pipeline-seeded spec carries the gated Kalshi prefix + a (canonical, edition) key', () => {
    expect(PIPELINE_FORMAT_SPECS.length).toBeGreaterThanOrEqual(1);
    expect(PIPELINE_FORMAT_SPECS).toContain(WC_2026_FORMAT_SPEC);
    for (const spec of PIPELINE_FORMAT_SPECS) {
      expect(spec.kalshiEventTickerPrefix ?? '').not.toBe('');
      // the upsert's conflict key — both must be non-empty for idempotency
      expect(spec.competition.canonical).toBeTruthy();
      expect(spec.competition.edition).toBeTruthy();
    }
  });

  test('group_winner ⟹ r32 extraImplication present; group_winner is NOT a ladder rung', () => {
    expect(WC_2026_FORMAT_SPEC.extraImplications).toContainEqual({ from: 'group_winner', to: 'r32' });
    expect(WC_2026_FORMAT_SPEC.reachLadder).not.toContain('group_winner');
  });
});

// ── group_winner end-to-end (resolver → RoleNode → derived edge) ──
describe('group_winner channel', () => {
  test('a KXWCGROUPWIN market row maps to a group_winner RoleNode (team from participants[0])', () => {
    const node = marketRowToRoleNode({
      question_id: 859,
      event_ticker: 'KXWCGROUPWIN-26A',
      yes_sub_title: 'Mexico',
      participants: ['Mexico'],
      canonical_subject: 'Will Mexico finish first in World Cup Group A?', // leak-poisoned — must NOT win
      event_title: 'World Cup Group A Winner',
      league_id: null,
    });
    expect(node).not.toBeNull();
    expect(node!.role).toBe('group_winner');
    expect(node!.subject).toBe('Mexico');
    expect(node!.isElimination).toBe(false);
  });

  test('group_winner(T) ⟹ r32(T) fires via resolver-built nodes; never cross-team', () => {
    const rows = [
      { question_id: 1, event_ticker: 'KXWCGROUPWIN-26A',  yes_sub_title: 'Mexico',  participants: ['Mexico'],  canonical_subject: null, event_title: null, league_id: null },
      { question_id: 2, event_ticker: 'KXWCGROUPQUAL-26A', yes_sub_title: 'Mexico',  participants: ['Mexico'],  canonical_subject: null, event_title: null, league_id: null },
      { question_id: 3, event_ticker: 'KXWCGROUPQUAL-26A', yes_sub_title: 'Czechia', participants: ['Czechia'], canonical_subject: null, event_title: null, league_id: null },
    ];
    const nodes = rows.map((r) => marketRowToRoleNode(r as never)!).filter(Boolean);
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    const e = edge(edges, 1, 2);
    expect(e?.pattern).toBe('tournament_advancement');
    expect(edge(edges, 1, 3)).toBeUndefined(); // Mexico group win must not imply Czechia advancing
    expect(edges).toHaveLength(1);
  });

  test('group_winner never participates in the sequential reach ladder', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion',     subject: 'Argentina' },
      { questionId: 7, role: 'group_winner', subject: 'Argentina', group: 'J' },
    ];
    // no r32 node → the extraImplication has no target; the ladder must not
    // treat group_winner as a rung adjacent to anything.
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    expect(edges).toHaveLength(0);
  });
});

// ── Blocker B: team identity from participants[0] (canonical_subject is poisoned) ──
describe('marketRowToRoleNode — team from participants[0]', () => {
  test('uses participants[0] as the team subject, not canonical_subject', () => {
    const node = marketRowToRoleNode({
      question_id: 42,
      event_ticker: 'KXWCSTAGEOFELIM-26ARG',
      yes_sub_title: 'Outright Winner',
      participants: ['Argentina'],
      canonical_subject: 'Argentina: Stage of Elimination', // leak-poisoned — must NOT win
      event_title: 'Argentina: Stage of Elimination',
      league_id: null,
    });
    expect(node).not.toBeNull();
    expect(node!.subject).toBe('Argentina');
    expect(node!.role).toBe('champion');
    expect(node!.isElimination).toBe(false);
  });

  test('falls back to canonical_subject only when participants is empty', () => {
    const node = marketRowToRoleNode({
      question_id: 43,
      event_ticker: 'KXWCROUND-26FINAL',
      yes_sub_title: 'France',
      participants: [],
      canonical_subject: 'France',
      event_title: null,
      league_id: null,
    });
    expect(node!.subject).toBe('France');
    expect(node!.role).toBe('final');
  });

  test('a non-stage market yields no node', () => {
    expect(marketRowToRoleNode({
      question_id: 44, event_ticker: 'KXWCSQUAD-26ARG', yes_sub_title: 'Messi',
      participants: ['Lionel Messi'], canonical_subject: 'Messi', event_title: null, league_id: null,
    })).toBeNull();
  });
});

// ── Blocker C: elimination-implication DIRECTION (eliminated-at-S ⟹ reached-S only) ──
describe('elimination channel — direction soundness', () => {
  // One team's realistic WC node set: 5 eliminations (R32..Final) + champion + the
  // matching positive reach nodes (KXWCROUND final/sf/qf/r16 + KXWCGROUPQUAL r32).
  function argentinaWcNodes(): RoleNode[] {
    return [
      // positive reach nodes (KXWCROUND + GROUPQUAL + champion via Outright Winner)
      { questionId: 1, role: 'champion', subject: 'Argentina' },
      { questionId: 2, role: 'final',    subject: 'Argentina' },
      { questionId: 3, role: 'sf',       subject: 'Argentina' },
      { questionId: 4, role: 'qf',       subject: 'Argentina' },
      { questionId: 5, role: 'r16',      subject: 'Argentina' },
      { questionId: 6, role: 'r32',      subject: 'Argentina' },
      // elimination nodes (antecedents): role = the stage REACHED before being out
      { questionId: 12, role: 'final', subject: 'Argentina', isElimination: true }, // Runner-Up
      { questionId: 13, role: 'sf',    subject: 'Argentina', isElimination: true },
      { questionId: 14, role: 'qf',    subject: 'Argentina', isElimination: true },
      { questionId: 15, role: 'r16',   subject: 'Argentina', isElimination: true },
      { questionId: 16, role: 'r32',   subject: 'Argentina', isElimination: true },
      { questionId: 17, role: 'group', subject: 'Argentina', isElimination: true }, // no reach target
    ];
  }

  test('eliminated-at-S ⟹ reached-S edges are emitted with the right direction', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaWcNodes(), confederationOf);
    const elim = edges.filter((e) => e.pattern === 'elimination_reach');
    // 5 elimination nodes have a positive reach target (final/sf/qf/r16/r32);
    // the "group" elimination (17) has none.
    expect(elim).toHaveLength(5);
    // each points eliminated(antecedent) → reach(consequent), same stage role.
    expect(edge(edges, 12, 2)?.pattern).toBe('elimination_reach'); // elim-final ⟹ reach-final
    expect(edge(edges, 13, 3)?.pattern).toBe('elimination_reach'); // elim-sf ⟹ reach-sf
    expect(edge(edges, 14, 4)?.pattern).toBe('elimination_reach');
    expect(edge(edges, 15, 5)?.pattern).toBe('elimination_reach');
    expect(edge(edges, 16, 6)?.pattern).toBe('elimination_reach');
  });

  test('the "group" elimination has NO reach target → no edge', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaWcNodes(), confederationOf);
    expect(edges.some((e) => e.antecedentQuestionId === 17)).toBe(false);
  });

  test('NEVER eliminated ⟹ a deeper stage', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaWcNodes(), confederationOf);
    // elim-at-qf (14) must not imply reach-sf (3) / reach-final (2) / champion (1).
    expect(edge(edges, 14, 3)).toBeUndefined();
    expect(edge(edges, 14, 2)).toBeUndefined();
    expect(edge(edges, 14, 1)).toBeUndefined();
    // elim-at-r16 (15) must not imply reach-qf (4).
    expect(edge(edges, 15, 4)).toBeUndefined();
  });

  test('NEVER eliminated ⟹ champion, and NEVER champion ⟹ eliminated', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaWcNodes(), confederationOf);
    // no edge has the champion node (1) as the consequent of an elimination antecedent.
    const elimAntes = new Set([12, 13, 14, 15, 16, 17]);
    expect(edges.some((e) => elimAntes.has(e.antecedentQuestionId) && e.consequentQuestionId === 1)).toBe(false);
    // no edge points FROM champion (1) TO any elimination node.
    const elimNodes = new Set([12, 13, 14, 15, 16, 17]);
    expect(edges.some((e) => e.antecedentQuestionId === 1 && elimNodes.has(e.consequentQuestionId))).toBe(false);
    // and no edge points TO an elimination node at all (eliminations are antecedents only).
    expect(edges.some((e) => elimNodes.has(e.consequentQuestionId))).toBe(false);
  });

  test('an elimination node is never a positive reach ladder/superset endpoint', () => {
    // Only elimination nodes present (no positive reach) → zero edges (no targets).
    const nodes: RoleNode[] = [
      { questionId: 14, role: 'qf', subject: 'Argentina', isElimination: true },
      { questionId: 13, role: 'sf', subject: 'Argentina', isElimination: true },
    ];
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, nodes, confederationOf);
    // No reach nodes → the ladder/elimination channels find no consequent → 0 edges.
    // Critically, elim-sf must NOT ladder to elim-qf (eliminations aren't reach nodes).
    expect(edges).toHaveLength(0);
  });

  test('positive reach ladder still fires alongside the elimination channel', () => {
    const edges = deriveTournamentEdges(WC_2026_FORMAT_SPEC, argentinaWcNodes(), confederationOf);
    // the monotone reach ladder champion⟹final⟹sf⟹qf⟹r16⟹r32 (sequential_stage)
    expect(edge(edges, 1, 2)?.pattern).toBe('sequential_stage');
    expect(edge(edges, 5, 6)?.pattern).toBe('sequential_stage');
    const seq = edges.filter((e) => e.pattern === 'sequential_stage');
    expect(seq).toHaveLength(5); // 5 adjacent pairs over the 6-rung ladder
  });
});

// ── generic spec-data resolver (resolveStageClassFromSpec) ───────────────────
describe('resolveStageClassFromSpec — March Madness 2027', () => {
  const MM = MARCH_MADNESS_2027_FORMAT_SPEC;

  test('KXMARMADROUND suffixes map to the 5-stage reach ladder (probed 2026-06-10)', () => {
    const cases: [string, string][] = [
      ['KXMARMADROUND-27T2',  'final'], // "qualify for the Championship Game"
      ['KXMARMADROUND-27F4',  'sf'],    // "qualify for the Semifinals"
      ['KXMARMADROUND-27R8',  'qf'],    // "qualify for the Round of 8" (Elite Eight)
      ['KXMARMADROUND-27R16', 'r16'],   // Sweet 16
      ['KXMARMADROUND-27R32', 'r32'],
    ];
    for (const [et, stage] of cases) {
      const cls = resolveStageClassFromSpec(MM, et, 'Duke');
      expect(cls).toEqual({ stage, isElimination: false, isChampion: false });
    }
  });

  test('KXMARMAD is the champion futures series (positive, champion-flagged)', () => {
    expect(resolveStageClassFromSpec(MM, 'KXMARMAD-27', 'Alabama')).toEqual(
      { stage: 'champion', isElimination: false, isChampion: true });
  });

  test('KXMARMAD1SEED (#1-seed prop) and unknown suffixes get NO role', () => {
    expect(resolveStageClassFromSpec(MM, 'KXMARMAD1SEED-27', 'Alabama')).toBeNull();
    expect(resolveStageClassFromSpec(MM, 'KXMARMADROUND-27XX', 'Alabama')).toBeNull();
    expect(resolveStageClassFromSpec(MM, null, 'Alabama')).toBeNull();
  });

  test('full per-team MM ladder derives 5 adjacent sequential_stage edges', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Duke' },
      { questionId: 2, role: 'final',    subject: 'Duke' },
      { questionId: 3, role: 'sf',       subject: 'Duke' },
      { questionId: 4, role: 'qf',       subject: 'Duke' },
      { questionId: 5, role: 'r16',      subject: 'Duke' },
      { questionId: 6, role: 'r32',      subject: 'Duke' },
    ];
    const edges = deriveTournamentEdges(MM, nodes, () => null);
    expect(edges.filter((e) => e.pattern === 'sequential_stage')).toHaveLength(5);
    expect(edge(edges, 1, 2)).toBeDefined();
    expect(edge(edges, 5, 6)).toBeDefined();
    expect(edge(edges, 1, 6)).toBeUndefined(); // no skip-edge
  });
});

describe('resolveStageClassFromSpec — CFB playoff 2026-27', () => {
  const CFB = CFB_PLAYOFF_2027_FORMAT_SPEC;

  test('the 3 playoff series map to champion / final / playoff', () => {
    // champion/finalist edition '27', playoff berth '26' — one season.
    expect(resolveStageClassFromSpec(CFB, 'KXNCAAF-27', 'Alabama')).toEqual(
      { stage: 'champion', isElimination: false, isChampion: true });
    expect(resolveStageClassFromSpec(CFB, 'KXNCAAFFINALIST-27', 'Georgia')).toEqual(
      { stage: 'final', isElimination: false, isChampion: false });
    expect(resolveStageClassFromSpec(CFB, 'KXNCAAFPLAYOFF-26', 'Texas')).toEqual(
      { stage: 'playoff', isElimination: false, isChampion: false });
  });

  test('props + conference championships get NO role (conf title ⇏ playoff berth)', () => {
    for (const et of ['KXNCAAFWINS-27ALA', 'KXNCAAFSEC-27', 'KXNCAAFB10-27',
                      'KXNCAAFAPRANK-27', 'KXNCAAFUNDEFEATED-27ALA', 'KXNCAAFCOTY-27']) {
      expect(resolveStageClassFromSpec(CFB, et, 'Alabama')).toBeNull();
    }
  });

  test('3-rung CFB ladder derives champion⟹final⟹playoff per team', () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: 'champion', subject: 'Georgia' },
      { questionId: 2, role: 'final',    subject: 'Georgia' },
      { questionId: 3, role: 'playoff',  subject: 'Georgia' },
    ];
    const edges = deriveTournamentEdges(CFB, nodes, () => null);
    expect(edges).toHaveLength(2);
    expect(edge(edges, 1, 2)?.pattern).toBe('sequential_stage');
    expect(edge(edges, 2, 3)?.pattern).toBe('sequential_stage');
  });

  test('marketRowToRoleNode honors the per-spec resolver (MM row)', () => {
    const nodeMm = marketRowToRoleNode({
      question_id: 7, event_ticker: 'KXMARMADROUND-27T2', yes_sub_title: 'Duke',
      participants: ['Duke Blue Devils'], canonical_subject: null, event_title: null, league_id: 42,
    }, MARCH_MADNESS_2027_FORMAT_SPEC);
    expect(nodeMm).not.toBeNull();
    expect(nodeMm!.role).toBe('final');
    expect(nodeMm!.subject).toBe('Duke Blue Devils');
    // the same row classifies to NOTHING under the WC spec (gated per-spec series)
    expect(marketRowToRoleNode({
      question_id: 7, event_ticker: 'KXMARMADROUND-27T2', yes_sub_title: 'Duke',
      participants: ['Duke Blue Devils'], canonical_subject: null, event_title: null, league_id: 42,
    }, WC_2026_FORMAT_SPEC)).toBeNull();
  });

  test('every pipeline spec resolves through the SAME generic resolver (no fork)', () => {
    // the WC wrapper is the spec-data path, not a parallel switch-case
    expect(resolveWcStageClass('KXWCGROUPWIN-26A', 'Czechia')).toEqual(
      resolveStageClassFromSpec(WC_2026_FORMAT_SPEC, 'KXWCGROUPWIN-26A', 'Czechia') as never);
  });
});

// ── final-fixture winner ⟹ champion (one direction only) ─────────────────────
describe('deriveFinalWinnerEdges — direction soundness', () => {
  const champs: RoleNode[] = [
    { questionId: 1, role: 'champion', subject: 'Argentina' },
    { questionId: 2, role: 'champion', subject: 'France' },
    { questionId: 3, role: 'champion', subject: 'Brazil' },
    // an ELIMINATION champion-stage node must never be an endpoint
    { questionId: 4, role: 'champion', subject: 'Spain', isElimination: true },
    // a non-champion role node is ignored entirely
    { questionId: 5, role: 'final', subject: 'Argentina' },
  ];
  const finals: FinalFixtureWinnerNode[] = [
    { questionId: 10, subject: 'Argentina', participants: ['Argentina', 'France'] },
    { questionId: 11, subject: 'France',    participants: ['Argentina', 'France'] },
  ];

  test('final-winner(X) ⟹ champion(X): strict_implication, cross_set_tournament', () => {
    const edges = deriveFinalWinnerEdges(champs, finals);
    const impl = edges.filter((e) => (e.edgeType ?? 'strict_implication') === 'strict_implication');
    expect(impl).toHaveLength(2);
    const argEdge = impl.find((e) => e.antecedentQuestionId === 10);
    expect(argEdge?.consequentQuestionId).toBe(1);
    expect(argEdge?.pattern).toBe('cross_set_tournament');
    const fraEdge = impl.find((e) => e.antecedentQuestionId === 11);
    expect(fraEdge?.consequentQuestionId).toBe(2);
  });

  test('NEVER the reverse: no strict_implication has a champion node as antecedent', () => {
    // champion(X) ⟹ final-winner(X) is UNSOUND (penalties / awarded outcomes:
    // a regulation final-winner market resolves NO on a pens win, yet X IS
    // champion — a real (YES, NO) world). Only the f ⟹ c direction may exist.
    const edges = deriveFinalWinnerEdges(champs, finals);
    const championIds = new Set([1, 2, 3, 4]);
    expect(edges.some(
      (e) => (e.edgeType ?? 'strict_implication') === 'strict_implication'
        && championIds.has(e.antecedentQuestionId),
    )).toBe(false);
  });

  test('mutex(champion(X), final-winner(Y)) for every X≠Y; never for X=Y', () => {
    const edges = deriveFinalWinnerEdges(champs, finals);
    const mux = edges.filter((e) => e.edgeType === 'mutual_exclusion');
    // X ∈ {Argentina, France, Brazil} minus the final-winner's own team, ×2 finals
    expect(mux).toHaveLength(4);
    // France/Brazil champion ⊥ Argentina-wins-final
    expect(edge(edges, 2, 10)?.edgeType).toBe('mutual_exclusion');
    expect(edge(edges, 3, 10)?.edgeType).toBe('mutual_exclusion');
    // Argentina/Brazil champion ⊥ France-wins-final
    expect(edge(edges, 1, 11)?.edgeType).toBe('mutual_exclusion');
    expect(edge(edges, 3, 11)?.edgeType).toBe('mutual_exclusion');
    // NEVER mutex champion(X) with final-winner(X) — they CO-occur
    expect(edge(edges, 1, 10)).toBeUndefined();
    expect(edge(edges, 2, 11)).toBeUndefined();
  });

  test('elimination nodes and non-champion roles are never endpoints', () => {
    const edges = deriveFinalWinnerEdges(champs, finals);
    for (const e of edges) {
      expect([4, 5]).not.toContain(e.antecedentQuestionId);
      expect([4, 5]).not.toContain(e.consequentQuestionId);
    }
  });

  test('missing champion endpoint ⇒ no implication (mutex to OTHER champions still fires)', () => {
    const onlyBrazil: RoleNode[] = [{ questionId: 3, role: 'champion', subject: 'Brazil' }];
    const edges = deriveFinalWinnerEdges(onlyBrazil, finals);
    expect(edges.filter((e) => (e.edgeType ?? 'strict_implication') === 'strict_implication')).toHaveLength(0);
    expect(edges.filter((e) => e.edgeType === 'mutual_exclusion')).toHaveLength(2);
  });

  test('edges are dedup’d and never self-referential', () => {
    const edges = deriveFinalWinnerEdges([...champs, ...champs], [...finals, ...finals]);
    const keys = edges.map((e) => `${e.antecedentQuestionId}->${e.consequentQuestionId}:${e.edgeType}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(edges.every((e) => e.antecedentQuestionId !== e.consequentQuestionId)).toBe(true);
  });

  test('finalWinnerNodesSql carries every gate (series, kind, finalists, date, 3rd-place guard)', () => {
    const sql = finalWinnerNodesSql();
    expect(sql).toContain("split_part(mr.raw->>'event_ticker', '-', 1) = $1");
    expect(sql).toContain("q.event_kind = 'match_winner'");
    expect(sql).toContain('array_length(q.participants, 1), 0) = 2');
    expect(sql).toContain('q.canonical_subject = ANY (q.participants)'); // excludes the Draw leg
    expect(sql).toContain('pe.condition_date::date = $2::date');         // the OFFICIAL final date
    expect(sql).toContain("(third|3rd)[ -]place");                        // 3rd-place playoff guard
    expect(sql).not.toContain('INSERT');                                  // SELECT-only loader
  });

  test('WC 2026 spec arms the standing rule (KXWCGAME, Jul 19 2026 — study-case §6)', () => {
    expect(WC_2026_FORMAT_SPEC.finalFixture).toEqual(
      { kalshiGameSeries: 'KXWCGAME', dateUtc: '2026-07-19' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// College onboarding: CWS spec + the edition-digits belt
// ═══════════════════════════════════════════════════════════════════════════
import { CWS_2026_FORMAT_SPEC } from "./tournament-edges.js";

describe("G4 — College Baseball World Series 2026 spec", () => {
  test("champion + cws roles resolve from the gated series, edition-gated", () => {
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXNCAABASEBALL-26NEB", "Nebraska"))
      .toEqual({ stage: "champion", isElimination: false, isChampion: true });
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXNCAABBPLAYOFFS-26NEB", "Nebraska"))
      .toEqual({ stage: "cws", isElimination: false, isChampion: false });
  });

  test("NEGATIVE: award + per-game series get NO role (props/fixtures)", () => {
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXNCAABBGS-26", "Golden Spikes")).toBeNull();
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXNCAABBGAME-26BRADCAMP", "Bradley")).toBeNull();
  });

  test("ladder: champion(T) ⟹ cws(T), never cross-team, never reversed", () => {
    const nodes: RoleNode[] = [
      { questionId: 1, role: "champion", subject: "Nebraska" },
      { questionId: 2, role: "cws",      subject: "Nebraska" },
      { questionId: 3, role: "cws",      subject: "Georgia" },
    ];
    const edges = deriveTournamentEdges(CWS_2026_FORMAT_SPEC, nodes, () => null);
    expect(edges).toHaveLength(1);
    expect(edge(edges, 1, 2)?.pattern).toBe("sequential_stage");
    expect(edge(edges, 1, 3)).toBeUndefined(); // Nebraska title must not imply Georgia reaching Omaha
    expect(edge(edges, 2, 1)).toBeUndefined(); // reaching the CWS does NOT imply winning it
  });

  test("seeded: CWS spec rides PIPELINE_FORMAT_SPECS with prefix + (canonical, edition)", () => {
    expect(PIPELINE_FORMAT_SPECS).toContain(CWS_2026_FORMAT_SPEC);
    expect(CWS_2026_FORMAT_SPEC.kalshiEventTickerPrefix).toBe("KXNCAAB");
  });
});

describe("G4 — edition-digits scoping belt", () => {
  test("a foreign-edition row of an OWNED series classifies to NO role (cross-season belt)", () => {
    // March Madness 2027 owns suffix digits 27 — a hypothetical 2028 listing
    // of the SAME series must never fuse into the 2027 ladder.
    expect(resolveStageClassFromSpec(MARCH_MADNESS_2027_FORMAT_SPEC, "KXMARMADROUND-27R32", "Alabama"))
      .toEqual({ stage: "r32", isElimination: false, isChampion: false });
    expect(resolveStageClassFromSpec(MARCH_MADNESS_2027_FORMAT_SPEC, "KXMARMADROUND-28R32", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(MARCH_MADNESS_2027_FORMAT_SPEC, "KXMARMAD-28ALAB", "Alabama")).toBeNull();
  });

  test("CFP: per-RULE digits — champion/finalist '27', playoff berth '26' (one season)", () => {
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXNCAAF-27ALAB", "Alabama")?.stage).toBe("champion");
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXNCAAFFINALIST-27ALAB", "Alabama")?.stage).toBe("final");
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXNCAAFPLAYOFF-26ALAB", "Alabama")?.stage).toBe("playoff");
    // the same series under the OTHER digit refuses — never cross-season
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXNCAAF-26ALAB", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXNCAAFPLAYOFF-27ALAB", "Alabama")).toBeNull();
  });

  test("WC spec keeps resolving its own 26 edition (belt is a live no-op)", () => {
    expect(resolveWcStageClass("KXWCSTAGEOFELIM-26ARG", "Outright Winner")?.isChampion).toBe(true);
    expect(resolveWcStageClass("KXWCSTAGEOFELIM-30ARG", "Outright Winner")).toBeNull();
  });

  test("COMPETITION SCOPING: one team token across three competitions never cross-links", () => {
    // 'Alabama' has nodes under KXMARMAD* (basketball), KXNCAAF* (football)
    // and KXNCAAB* (baseball). Each spec resolves only its own gated series;
    // the foreign tickers classify to null under every other spec.
    expect(resolveStageClassFromSpec(MARCH_MADNESS_2027_FORMAT_SPEC, "KXNCAAF-27ALAB", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(MARCH_MADNESS_2027_FORMAT_SPEC, "KXNCAABASEBALL-26ALAB", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(CFB_PLAYOFF_2027_FORMAT_SPEC, "KXMARMADROUND-27R32", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXMARMAD-27ALAB", "Alabama")).toBeNull();
    expect(resolveStageClassFromSpec(CWS_2026_FORMAT_SPEC, "KXNCAAFPLAYOFF-26ALAB", "Alabama")).toBeNull();
  });

  test("March Madness ladder end-to-end: champion ⟹ T2 ⟹ F4 ⟹ R8 ⟹ R16 ⟹ R32 per team", () => {
    const rows = [
      { question_id: 10, event_ticker: "KXMARMAD-27ALAB",       yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      { question_id: 11, event_ticker: "KXMARMADROUND-27T2",    yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      { question_id: 12, event_ticker: "KXMARMADROUND-27F4",    yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      { question_id: 13, event_ticker: "KXMARMADROUND-27R8",    yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      { question_id: 14, event_ticker: "KXMARMADROUND-27R16",   yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      { question_id: 15, event_ticker: "KXMARMADROUND-27R32",   yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
      // a 1-seed prop must acquire NO role
      { question_id: 16, event_ticker: "KXMARMAD1SEED-27ALAB",  yes_sub_title: "Alabama", participants: ["Alabama Crimson Tide"], canonical_subject: null, event_title: null, league_id: 14015 },
    ];
    const nodes = rows
      .map((r) => marketRowToRoleNode(r as never, MARCH_MADNESS_2027_FORMAT_SPEC))
      .filter((n): n is RoleNode => n != null);
    expect(nodes).toHaveLength(6); // the seed prop dropped
    const edges = deriveTournamentEdges(MARCH_MADNESS_2027_FORMAT_SPEC, nodes, () => null);
    expect(edges).toHaveLength(5);
    expect(edge(edges, 10, 11)?.pattern).toBe("sequential_stage");
    expect(edge(edges, 11, 12)).toBeDefined();
    expect(edge(edges, 12, 13)).toBeDefined();
    expect(edge(edges, 13, 14)).toBeDefined();
    expect(edge(edges, 14, 15)).toBeDefined();
    // NEGATIVE: no skip edges (champion ⟹ R32 directly is transitivity, not emission)
    expect(edge(edges, 10, 15)).toBeUndefined();
  });
});
