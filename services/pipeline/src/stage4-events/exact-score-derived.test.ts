/**
 * Tests for exact-score-derived.ts.
 *   1. Pure-TS logic tests for the four derivation classes (orientation / over-under /
 *      BTTS / spread mutex) — these pin the SOUNDNESS rules directly.
 *   2. Shape tests asserting the load-bearing guards are present in the generated SQL
 *      (no DB; the dry-run probe validates against the live schema separately).
 */
import { describe, test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildExactScoreDerivedEdgesSql,
  impliedWinnerSubject,
  totalOverUnderSide,
  impliesBtts,
  spreadOppositeTeamMutex,
  subjectIsParticipant,
} from './exact-score-derived.js';

describe('AUD-04 winner-orientation gate (subject must be a participating team)', () => {
  const PARTS = ['Aston Villa', 'Liverpool'] as const;
  test('team subject IS a participant → orientable (edge may fire)', () => {
    expect(subjectIsParticipant('Liverpool', PARTS)).toBe(true);
  });
  test("'Draw' subject is NOT a participant → no winner edge (PM Template-J class)", () => {
    expect(subjectIsParticipant('Draw', PARTS)).toBe(false);
  });
  test('score-label subject is NOT a participant → no winner edge', () => {
    expect(subjectIsParticipant('Exact Score: 0-1', PARTS)).toBe(false);
  });
  test('SQL: ins_winner carries the ANY(participants) orientation guard exactly ONCE (not over/under/btts)', () => {
    const sql = buildExactScoreDerivedEdgesSql();
    expect(sql).toContain('a.canonical_subject = ANY(a.participants)');
    expect((sql.match(/a\.canonical_subject = ANY\(a\.participants\)/g) ?? []).length).toBe(1);
  });
  test('SQL: antecedent-purity gate — materialized mixed-grain CTE anti-joined on ALL 5 arms', () => {
    const sql = buildExactScoreDerivedEdgesSql();
    // the mixed-grain question CTE (a Kalshi correct-score fused with a PM moneyline)
    expect(sql).toContain('mixed_exact_score_q AS MATERIALIZED');
    expect(sql).toContain("n.event_kind IS DISTINCT FROM 'exact_score'");
    // anti-joined on every arm's exact_score antecedent — the cluster-5820 fake fix
    expect((sql.match(/NOT EXISTS \(SELECT 1 FROM mixed_exact_score_q mg WHERE mg\.question_id = a\.question_id\)/g) ?? []).length).toBe(5);
  });
});

// participants[] is ALWAYS alphabetized, so order is NOT a winner signal.
const PARTS = ['Aston Villa', 'Liverpool'] as const;

describe('CLASS A — winner orientation via canonical_subject + argmax (both directions)', () => {
  test('subject is higher scorer (vp > vs) → subject wins', () => {
    // exact_score node: subject=Liverpool, Liverpool 2 – Aston Villa 1
    expect(impliedWinnerSubject('Liverpool', 2, 1, PARTS)).toBe('Liverpool');
  });

  test('subject is lower scorer (vp < vs) → the OTHER participant wins', () => {
    // exact_score node: subject=Liverpool, Liverpool 0 – Aston Villa 2 → Aston Villa wins
    expect(impliedWinnerSubject('Liverpool', 0, 2, PARTS)).toBe('Aston Villa');
  });

  test('orientation is independent of alphabetized participant order', () => {
    // subject = the alphabetically-FIRST participant, but it scored fewer → other wins
    expect(impliedWinnerSubject('Aston Villa', 1, 3, PARTS)).toBe('Liverpool');
    // subject = the alphabetically-LAST participant, scored more → it wins
    expect(impliedWinnerSubject('Liverpool', 3, 1, PARTS)).toBe('Liverpool');
  });

  test('draw (vp == vs) → null (routed to CLASS A2, no single winner)', () => {
    expect(impliedWinnerSubject('Liverpool', 1, 1, PARTS)).toBeNull();
    expect(impliedWinnerSubject('Liverpool', 0, 0, PARTS)).toBeNull();
  });
});

describe('CLASS B — O/U total side vs line (incl. boundary exclusion)', () => {
  test('total > line → over (strict_implication TRUE)', () => {
    expect(totalOverUnderSide(2, 1, 2.5)).toBe('over'); // total 3 > 2.5
    expect(totalOverUnderSide(3, 0, 1.5)).toBe('over'); // total 3 > 1.5
  });

  test('total < line → under (mutual_exclusion, NOT implication)', () => {
    expect(totalOverUnderSide(1, 0, 2.5)).toBe('under'); // total 1 < 2.5
    expect(totalOverUnderSide(0, 0, 0.5)).toBe('under'); // total 0 < 0.5
  });

  test('total == line → boundary (EXCLUDED, no edge emitted)', () => {
    expect(totalOverUnderSide(2, 1, 3)).toBe('boundary');   // integer line 3
    expect(totalOverUnderSide(0, 0, 0)).toBe('boundary');
  });
});

describe('CLASS C — BTTS only when both teams score >= 1', () => {
  test('both >= 1 → implies BTTS YES', () => {
    expect(impliesBtts(1, 1)).toBe(true);
    expect(impliesBtts(2, 3)).toBe(true);
  });

  test('one side zero → does NOT imply BTTS', () => {
    expect(impliesBtts(0, 2)).toBe(false);
    expect(impliesBtts(3, 0)).toBe(false);
    expect(impliesBtts(0, 0)).toBe(false);
  });
});

describe('R5 — opposite-team spread mutex (single-team only)', () => {
  test('distinct single-team spreads → mutex', () => {
    expect(spreadOppositeTeamMutex(['Liverpool'], ['Aston Villa'])).toBe(true);
  });

  test('same-team spreads (a threshold ladder) → NOT a mutex', () => {
    expect(spreadOppositeTeamMutex(['Liverpool'], ['Liverpool'])).toBe(false);
  });

  test('two-participant handicap folds → NOT a mutex (excluded by single-team gate)', () => {
    expect(spreadOppositeTeamMutex(['Aston Villa', 'Liverpool'], ['Liverpool'])).toBe(false);
    expect(spreadOppositeTeamMutex(['Liverpool'], ['Aston Villa', 'Liverpool'])).toBe(false);
  });
});

describe('buildExactScoreDerivedEdgesSql — load-bearing guards (all four classes)', () => {
  const sql = buildExactScoreDerivedEdgesSql();

  test('antecedent is always exact_score with both scores present', () => {
    expect(sql).toContain(`a.event_kind = 'exact_score'`);
    expect(sql).toContain('a.value_primary IS NOT NULL');
    expect(sql).toContain('a.value_secondary IS NOT NULL');
  });

  test('all classes are deterministic algorithmic edges at confidence 1.0', () => {
    expect(sql).toContain('1.0, TRUE');
    expect(sql).toContain(`'algorithmic'`);
  });

  test('CLASS A winner: argmax orientation + categorical complement + draw split', () => {
    expect(sql).toContain(`'exact_score_winner'`);
    expect(sql).toContain(`b.event_kind = 'match_winner'`);
    expect(sql).toContain('a.value_primary <> a.value_secondary');     // draws excluded here
    expect(sql).toContain('a.value_primary > a.value_secondary');       // argmax
    expect(sql).toContain('unnest(a.participants)');
    expect(sql).toContain('p <> a.canonical_subject');                  // the OTHER participant
    expect(sql).toContain(`os.set_type = 'categorical'`);              // complement coverage
  });

  test('CLASS A2 draw: vp = vs routed to the Draw node, categorical complement', () => {
    expect(sql).toContain(`'exact_score_draw'`);
    expect(sql).toContain('a.value_primary = a.value_secondary');
    // The Draw consequent is identified by the authoritative draw_axis stamp
    // (outcome_label-derived) instead of the fragile canonical_subject='draw' string.
    expect(sql).toContain(`b.discriminators->>'draw_axis' = 'draw'`);
    expect(sql).not.toContain(`lower(immutable_unaccent(btrim(b.canonical_subject))) = 'draw'`);
    expect(sql).toContain(`os.set_type = 'categorical'`);
  });

  test('CLASS B over: strict_implication, MATCH-level total only, unit-tolerant, total > line', () => {
    expect(sql).toContain(`'exact_score_total_over'`);
    expect(sql).toContain(`b.event_kind = 'match_total_metric'`);
    expect(sql).toContain(`b.condition_direction = 'above'`);
    expect(sql).toContain('NOT (b.canonical_subject = ANY(b.participants))'); // reject per-team totals
    // unit agreement via the fold-compatible conjunct: a raw case-sensitive
    // equality would over-refuse 'goals' vs 'goal' pairs the TS comparator
    // (foldUnit+unitsEquivalent) already deems identical
    expect(sql).toContain("lower(btrim(a.value_unit)) = lower(btrim(b.value_unit))");
    expect(sql).not.toContain('OR a.value_unit = b.value_unit');
    expect(sql).toContain('(a.value_primary + a.value_secondary) > b.value_primary');
  });

  test('CLASS B under: MUTUAL_EXCLUSION (never strict_implication), total < line, boundary excluded', () => {
    expect(sql).toContain(`'exact_score_total_under'`);
    expect(sql).toContain('(a.value_primary + a.value_secondary) < b.value_primary');
    // the under-side pattern must carry mutual_exclusion (the over-side carries strict_implication)
    expect(sql).toMatch(/'mutual_exclusion', 'exact_score_total_under'/);
    // boundary (==) must NOT appear as an emitted comparison
    expect(sql).not.toContain('(a.value_primary + a.value_secondary) = b.value_primary');
  });

  test('CLASS C BTTS: YES-only strict_implication when both scores >= 1', () => {
    expect(sql).toContain(`'exact_score_btts'`);
    expect(sql).toContain(`b.event_kind = 'both_teams_score'`);
    expect(sql).toContain('a.value_primary >= 1 AND a.value_secondary >= 1');
    expect(sql).toMatch(/'strict_implication', 'exact_score_btts'/);
  });

  test('every class gates on sameFixtureFragment (participants + ordinal + date + scope)', () => {
    // participant-set equality appears in every class
    const partEq = (sql.match(/a\.participants = b\.participants/g) ?? []).length;
    expect(partEq).toBeGreaterThanOrEqual(5); // A, A2, B-over, B-under, C
    // the date gate (two-leg-trap defeat) + ordinal + consequent-scope live in the fragment
    expect(sql).toContain('game_ordinal');
    expect(sql).toContain('::timestamptz');
    expect(sql).toContain("b.metric_scope = 'game'");
  });

  test('first-writer-wins upsert on (antecedent, consequent)', () => {
    expect(sql).toContain(EDGE_CONFLICT_SQL);
  });
});
