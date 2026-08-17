/**
 * Tests for the tier-B tournament derivations. Pure logic — no DB.
 */
import { describe, test, expect } from 'bun:test';
import { WC_2026_FORMAT_SPEC, type RoleNode, type DerivedEdge, type MarketNodeRow } from './tournament-edges.js';
import {
  deriveEliminationStageMutexes,
  deriveGroupChampionSupersets,
  deriveHostStageMutexes,
  classifyTierBRows,
  drawGroupsToFoldMap,
  type GroupAggregateCell,
} from './tournament-edges-tierb.js';

function edge(edges: DerivedEdge[], ante: number, cons: number): DerivedEdge | undefined {
  return edges.find((e) => e.antecedentQuestionId === ante && e.consequentQuestionId === cons);
}

// Argentina's full WC node universe: positive reach (1-6), group_winner (7),
// eliminations (12-17 — role = stage REACHED before going out).
function argentinaNodes(): RoleNode[] {
  return [
    { questionId: 1, role: 'champion', subject: 'Argentina' },
    { questionId: 2, role: 'final',    subject: 'Argentina' },
    { questionId: 3, role: 'sf',       subject: 'Argentina' },
    { questionId: 4, role: 'qf',       subject: 'Argentina' },
    { questionId: 5, role: 'r16',      subject: 'Argentina' },
    { questionId: 6, role: 'r32',      subject: 'Argentina' },
    { questionId: 7, role: 'group_winner', subject: 'Argentina' },
    { questionId: 12, role: 'final', subject: 'Argentina', isElimination: true }, // Runner-Up
    { questionId: 13, role: 'sf',    subject: 'Argentina', isElimination: true },
    { questionId: 14, role: 'qf',    subject: 'Argentina', isElimination: true },
    { questionId: 15, role: 'r16',   subject: 'Argentina', isElimination: true },
    { questionId: 16, role: 'r32',   subject: 'Argentina', isElimination: true },
    { questionId: 17, role: 'group', subject: 'Argentina', isElimination: true },
  ];
}

describe('deriveEliminationStageMutexes', () => {
  const edges = deriveEliminationStageMutexes(WC_2026_FORMAT_SPEC, argentinaNodes());

  test('every edge is a mutual_exclusion with the elimination node as antecedent', () => {
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.edgeType).toBe('mutual_exclusion');
      expect(e.pattern).toBe('elimination_stage_mutex');
      expect([12, 13, 14, 15, 16, 17]).toContain(e.antecedentQuestionId);
    }
  });

  test('elim-at-S ⊥ STRICTLY deeper reach only (full ladder counts: 15 + group_winner)', () => {
    // elim-group(17) ⊥ {final,sf,qf,r16,r32} = 5 + group_winner = 6
    expect(edges.filter((e) => e.antecedentQuestionId === 17)).toHaveLength(6);
    // elim-r32(16) ⊥ {final,sf,qf,r16} = 4
    expect(edges.filter((e) => e.antecedentQuestionId === 16)).toHaveLength(4);
    // elim-r16(15) ⊥ {final,sf,qf} = 3
    expect(edges.filter((e) => e.antecedentQuestionId === 15)).toHaveLength(3);
    // elim-qf(14) ⊥ {final,sf} = 2
    expect(edges.filter((e) => e.antecedentQuestionId === 14)).toHaveLength(2);
    // elim-sf(13) ⊥ {final} = 1
    expect(edges.filter((e) => e.antecedentQuestionId === 13)).toHaveLength(1);
    expect(edge(edges, 13, 2)).toBeDefined();
    // elim-final/runner-up(12): deeper = champion only → excluded → 0
    expect(edges.filter((e) => e.antecedentQuestionId === 12)).toHaveLength(0);
    expect(edges).toHaveLength(16);
  });

  test('NEVER a same-stage mutex (that pair is the tier-A IMPLICATION elim⟹reach)', () => {
    expect(edge(edges, 16, 6)).toBeUndefined(); // elim-r32 vs reach-r32
    expect(edge(edges, 14, 4)).toBeUndefined(); // elim-qf vs reach-qf
    expect(edge(edges, 12, 2)).toBeUndefined(); // runner-up vs reach-final
  });

  test('NEVER a champion consequent (same-set Σ≤1 already covers champion ⊥ elim)', () => {
    expect(edges.some((e) => e.consequentQuestionId === 1)).toBe(false);
  });

  test('group_winner is mutexed ONLY by the trivial-entry (group) elimination', () => {
    expect(edge(edges, 17, 7)).toBeDefined();   // elim-group ⊥ group_winner
    expect(edge(edges, 16, 7)).toBeUndefined(); // an R32 elim may have WON the group
    expect(edge(edges, 15, 7)).toBeUndefined();
  });

  test('never cross-team', () => {
    const nodes: RoleNode[] = [
      { questionId: 14, role: 'qf', subject: 'Argentina', isElimination: true },
      { questionId: 23, role: 'sf', subject: 'France' },
    ];
    expect(deriveEliminationStageMutexes(WC_2026_FORMAT_SPEC, nodes)).toHaveLength(0);
  });

  test('dedup + never self-referential', () => {
    const doubled = [...argentinaNodes(), ...argentinaNodes()];
    const e2 = deriveEliminationStageMutexes(WC_2026_FORMAT_SPEC, doubled);
    const keys = e2.map((e) => `${e.antecedentQuestionId}->${e.consequentQuestionId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(e2.every((e) => e.antecedentQuestionId !== e.consequentQuestionId)).toBe(true);
  });
});

describe('deriveGroupChampionSupersets', () => {
  const aggCells: GroupAggregateCell[] = [
    { groupLetter: 'a', questionId: 100 },
    { groupLetter: 'j', questionId: 109 },
  ];
  const membership = new Map([['argentina', 'j'], ['mexico', 'a'], ['france', 'i']]);

  test('champion(T) ⟹ aggregate(group(T)); strict_implication', () => {
    const edges = deriveGroupChampionSupersets({
      champions: [
        { questionId: 1, role: 'champion', subject: 'Argentina' },
        { questionId: 2, role: 'champion', subject: 'Mexico' },
      ],
      membership, multiGroupTeams: new Set(), aggCells,
    });
    expect(edges).toHaveLength(2);
    expect(edge(edges, 1, 109)?.edgeType).toBe('strict_implication');
    expect(edge(edges, 1, 109)?.pattern).toBe('group_champion_superset');
    expect(edge(edges, 2, 100)).toBeDefined();
    // Argentina must NOT imply Group A.
    expect(edge(edges, 1, 100)).toBeUndefined();
  });

  test('no membership / no aggregate cell / multi-group team ⇒ refuse', () => {
    const edges = deriveGroupChampionSupersets({
      champions: [
        { questionId: 3, role: 'champion', subject: 'France' },   // group i has no agg cell
        { questionId: 4, role: 'champion', subject: 'Narnia' },   // no membership
        { questionId: 5, role: 'champion', subject: 'Mexico' },   // multi-group → refuse
      ],
      membership, multiGroupTeams: new Set(['mexico']), aggCells,
    });
    expect(edges).toHaveLength(0);
  });

  test('draw cross-check: MISS passes, DISAGREEMENT refuses', () => {
    const drawGroups = new Map([['argentina', 'j'], ['mexico', 'b']]); // mexico draw says B, ticker says A
    const edges = deriveGroupChampionSupersets({
      champions: [
        { questionId: 1, role: 'champion', subject: 'Argentina' }, // agree → edge
        { questionId: 2, role: 'champion', subject: 'Mexico' },    // disagree → refuse
      ],
      membership, multiGroupTeams: new Set(), aggCells, drawGroups,
    });
    expect(edges).toHaveLength(1);
    expect(edge(edges, 1, 109)).toBeDefined();
  });

  test('accent/case-insensitive team identity (Curaçao ↔ curacao)', () => {
    const edges = deriveGroupChampionSupersets({
      champions: [{ questionId: 9, role: 'champion', subject: 'Curaçao' }],
      membership: new Map([['curacao', 'a']]),
      multiGroupTeams: new Set(), aggCells,
    });
    expect(edge(edges, 9, 100)).toBeDefined();
  });

  test('an ambiguous aggregate cell (two questions for one letter) refuses', () => {
    const edges = deriveGroupChampionSupersets({
      champions: [{ questionId: 1, role: 'champion', subject: 'Argentina' }],
      membership,
      multiGroupTeams: new Set(),
      aggCells: [...aggCells, { groupLetter: 'j', questionId: 999 }],
    });
    expect(edges.filter((e) => e.antecedentQuestionId === 1)).toHaveLength(0);
  });

  test('elimination champion nodes are never antecedents', () => {
    const edges = deriveGroupChampionSupersets({
      champions: [{ questionId: 1, role: 'champion', subject: 'Argentina', isElimination: true }],
      membership, multiGroupTeams: new Set(), aggCells,
    });
    expect(edges).toHaveLength(0);
  });
});

describe('deriveHostStageMutexes', () => {
  // Host cells: GS=200, R32=201, R16=202, QF=203, SF=204; WF cell = 210.
  const cells = {
    byStage: new Map<string, number>([
      ['group', 200], ['r32', 201], ['r16', 202], ['qf', 203], ['sf', 204],
    ]),
    winningFinalQuestionId: 210,
  };
  const nodes: RoleNode[] = [
    // Mexico (host) full positive ladder
    { questionId: 31, role: 'champion', subject: 'Mexico' },
    { questionId: 32, role: 'final',    subject: 'Mexico' },
    { questionId: 33, role: 'sf',       subject: 'Mexico' },
    { questionId: 34, role: 'qf',       subject: 'Mexico' },
    { questionId: 35, role: 'r16',      subject: 'Mexico' },
    { questionId: 36, role: 'r32',      subject: 'Mexico' },
    // Argentina (non-host)
    { questionId: 41, role: 'champion', subject: 'Argentina' },
    { questionId: 42, role: 'final',    subject: 'Argentina' },
    // an elimination node must never participate
    { questionId: 51, role: 'sf', subject: 'Mexico', isElimination: true },
  ];
  const edges = deriveHostStageMutexes(WC_2026_FORMAT_SPEC, nodes, cells);

  test('reach-S(host) ⊥ strictly shallower cells (counts per rung)', () => {
    // r32(36) ⊥ {GS} = 1
    expect(edges.filter((e) => e.antecedentQuestionId === 36)).toHaveLength(1);
    expect(edge(edges, 36, 200)?.edgeType).toBe('mutual_exclusion');
    // r16(35) ⊥ {GS,R32} = 2
    expect(edges.filter((e) => e.antecedentQuestionId === 35)).toHaveLength(2);
    // qf(34) ⊥ {GS,R32,R16} = 3
    expect(edges.filter((e) => e.antecedentQuestionId === 34)).toHaveLength(3);
    // sf(33) ⊥ {GS,R32,R16,QF} = 4
    expect(edges.filter((e) => e.antecedentQuestionId === 33)).toHaveLength(4);
    // final(32) ⊥ {GS,R32,R16,QF} = 4 (SF-cell pair settlement-scope-excluded)
    expect(edges.filter((e) => e.antecedentQuestionId === 32)).toHaveLength(4);
    for (const e of edges) expect(e.pattern).toBe('host_stage_mutex');
  });

  test('the reach-final × SF-cell pair is NOT emitted (settlement-scope cut)', () => {
    expect(edge(edges, 32, 204)).toBeUndefined();
  });

  test('same-stage cell is never mutexed (reach-sf vs SF cell co-occur)', () => {
    expect(edge(edges, 33, 204)).toBeUndefined();
  });

  test('champion(host) gets NO direct cell edge (transitivity via reach-final)', () => {
    expect(edges.filter((e) => e.antecedentQuestionId === 31)).toHaveLength(0);
  });

  test('champion(non-host) ⊥ winning-final cell; non-host reach gets nothing', () => {
    const wf = edge(edges, 41, 210);
    expect(wf?.edgeType).toBe('mutual_exclusion');
    // Argentina reach-final (42) is not a host → no cell mutexes.
    expect(edges.filter((e) => e.antecedentQuestionId === 42)).toHaveLength(0);
  });

  test('elimination nodes never participate', () => {
    expect(edges.some((e) => e.antecedentQuestionId === 51 || e.consequentQuestionId === 51)).toBe(false);
  });

  test('no hostAggregate spec ⇒ no edges; no WF cell ⇒ no champion mutexes', () => {
    expect(deriveHostStageMutexes({ reachLadder: WC_2026_FORMAT_SPEC.reachLadder }, nodes, cells)).toHaveLength(0);
    const noWf = deriveHostStageMutexes(WC_2026_FORMAT_SPEC, nodes, { byStage: cells.byStage });
    expect(noWf.some((e) => e.consequentQuestionId === 210)).toBe(false);
  });
});

describe('classifyTierBRows — gated row classification', () => {
  const row = (over: Partial<MarketNodeRow>): MarketNodeRow => ({
    question_id: 0, event_ticker: null, yes_sub_title: null,
    participants: null, canonical_subject: null, event_title: null, league_id: null,
    ...over,
  });

  test('membership from the memberSeries ticker letter; aggregate + host cells from spec series', () => {
    const inputs = classifyTierBRows(WC_2026_FORMAT_SPEC, [
      row({ question_id: 6, event_ticker: 'KXWCGROUPQUAL-26J', yes_sub_title: 'Argentina', participants: ['Argentina'] }),
      row({ question_id: 100, event_ticker: 'KXWCGROUPWINNER-26', yes_sub_title: 'Group J', canonical_subject: 'a team from Group J' }),
      row({ question_id: 200, event_ticker: 'KXWCSTAGE-26HOST', yes_sub_title: 'Group Stage' }),
      row({ question_id: 210, event_ticker: 'KXWCSTAGE-26HOST', yes_sub_title: 'Winning the Final' }),
      row({ question_id: 1, event_ticker: 'KXWCSTAGEOFELIM-26ARG', yes_sub_title: 'Outright Winner', participants: ['Argentina'] }),
    ]);
    expect(inputs.membership.get('argentina')).toBe('j');
    expect(inputs.aggCells).toEqual([{ groupLetter: 'j', questionId: 100 }]);
    expect(inputs.hostCells.byStage.get('group')).toBe(200);
    expect(inputs.hostCells.winningFinalQuestionId).toBe(210);
    // the GROUPQUAL row is ALSO an r32 RoleNode; ELIM row is the champion node
    expect(inputs.nodes.find((n) => n.questionId === 6)?.role).toBe('r32');
    expect(inputs.nodes.find((n) => n.questionId === 1)?.role).toBe('champion');
  });

  test('a team claimed by two groups is flagged; ambiguous host cells are dropped', () => {
    const inputs = classifyTierBRows(WC_2026_FORMAT_SPEC, [
      row({ question_id: 6, event_ticker: 'KXWCGROUPQUAL-26J', yes_sub_title: 'Argentina', participants: ['Argentina'] }),
      row({ question_id: 7, event_ticker: 'KXWCGROUPQUAL-26K', yes_sub_title: 'Argentina', participants: ['Argentina'] }),
      row({ question_id: 200, event_ticker: 'KXWCSTAGE-26HOST', yes_sub_title: 'Group Stage' }),
      row({ question_id: 201, event_ticker: 'KXWCSTAGE-26HOST', yes_sub_title: 'Group Stage' }),
    ]);
    expect(inputs.multiGroupTeams.has('argentina')).toBe(true);
    expect(inputs.hostCells.byStage.has('group')).toBe(false);
  });

  test('conflict belt: a question with CONFLICTING gated classifications gets no node; identical dupes dedup', () => {
    const inputs = classifyTierBRows(WC_2026_FORMAT_SPEC, [
      // qid 50 classified as elim-qf AND elim-sf (sibling-leg defect) → poisoned
      row({ question_id: 50, event_ticker: 'KXWCSTAGEOFELIM-26ARG', yes_sub_title: 'Quarterfinals', participants: ['Argentina'] }),
      row({ question_id: 50, event_ticker: 'KXWCSTAGEOFELIM-26ARG', yes_sub_title: 'Semifinals', participants: ['Argentina'] }),
      // qid 51: two identical rows → one node
      row({ question_id: 51, event_ticker: 'KXWCROUND-26FINAL', yes_sub_title: 'France', participants: ['France'] }),
      row({ question_id: 51, event_ticker: 'KXWCROUND-26FINAL', yes_sub_title: 'France', participants: ['France'] }),
    ]);
    expect(inputs.nodes.find((n) => n.questionId === 50)).toBeUndefined();
    expect(inputs.nodes.filter((n) => n.questionId === 51)).toHaveLength(1);
  });

  test('non-matching cells/series classify to nothing (Losing the Final stays unmapped)', () => {
    const inputs = classifyTierBRows(WC_2026_FORMAT_SPEC, [
      row({ question_id: 209, event_ticker: 'KXWCSTAGE-26HOST', yes_sub_title: 'Losing the Final' }),
      row({ question_id: 300, event_ticker: 'KXWCSQUAD-26ARG', yes_sub_title: 'Messi', participants: ['Messi'] }),
      row({ question_id: 301, event_ticker: 'KXWCGROUPWINNER-26', yes_sub_title: 'Not A Group' }),
    ]);
    expect(inputs.hostCells.byStage.size).toBe(0);
    expect(inputs.hostCells.winningFinalQuestionId).toBeUndefined();
    expect(inputs.aggCells).toHaveLength(0);
    expect(inputs.nodes).toHaveLength(0);
  });
});

describe('drawGroupsToFoldMap', () => {
  test('folds team spellings to letters; tolerates absent/malformed draw', () => {
    const m = drawGroupsToFoldMap({ groups: { A: ['Mexico', 'Czechia'], J: ['Argentina'] } });
    expect(m.get('mexico')).toBe('a');
    expect(m.get('argentina')).toBe('j');
    expect(drawGroupsToFoldMap(undefined).size).toBe(0);
    expect(drawGroupsToFoldMap({}).size).toBe(0);
    expect(drawGroupsToFoldMap({ groups: { A: 'oops' } }).size).toBe(0);
  });

  test('accents fold (Curaçao → curacao)', () => {
    const m = drawGroupsToFoldMap({ groups: { E: ['Curaçao'] } });
    expect(m.get('curacao')).toBe('e');
  });
});

describe('WC spec tier-B wiring', () => {
  test('groupAggregate + hostAggregate are pinned on the WC 2026 spec', () => {
    expect(WC_2026_FORMAT_SPEC.groupAggregate).toEqual(
      { kalshiSeries: 'KXWCGROUPWINNER', memberSeries: 'KXWCGROUPQUAL' });
    expect(WC_2026_FORMAT_SPEC.hostAggregate?.hosts).toEqual(['USA', 'Mexico', 'Canada']);
    expect(WC_2026_FORMAT_SPEC.hostAggregate?.winningFinalCell).toBe('winning the final');
    // 'losing the final' must stay UNMAPPED (settlement-scope)
    expect(Object.keys(WC_2026_FORMAT_SPEC.hostAggregate!.stageCells)).not.toContain('losing the final');
  });
});
