/**
 * Shape test for the cross-question mutual-exclusion edge rule: asserts the
 * load-bearing guards are present in the generated SQL (no DB needed), so a
 * future edit can't silently drop one.
 */
import { describe, test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildMutualExclusionXqEdgesSql,
  winnerMutexTourGatesSql,
  winnerOrientationGateSql,
  passesWinnerOrientation,
  crossSeriesRefusalSql,
  awardMultiWinnerRefusalSql,
  MULTI_WINNER_AWARD_PREFIXES,
} from './mutual-exclusion-xq.js';

describe('buildMutualExclusionXqEdgesSql', () => {
  const sql = buildMutualExclusionXqEdgesSql();

  test('AUD half-grain: FT/HT gate scans canonical_subject too (not just title)', () => {
    expect(sql).toMatch(/a\.canonical_subject ~\* '[^']*'/);
    expect(sql).toMatch(/b\.canonical_subject ~\* '[^']*'/);
    expect(sql).toMatch(/a\.title ~\* '[^']*'[\s\S]*?a\.canonical_subject ~\* '[^']*'[\s\S]{0,400}?=[\s\S]{0,50}?b\.title ~\* '[^']*'[\s\S]*?b\.canonical_subject ~\* '[^']*'/);
  });

  test('edge_type + pattern label are exactly the mutex labels', () => {
    expect(sql).toContain("'mutual_exclusion'");
    expect(sql).toContain("'cross_question_mutex'");
  });

  test('writes a hard deterministic algorithmic edge at confidence 1.0', () => {
    expect(sql).toContain('TRUE');
    expect(sql).toContain("'algorithmic'");
    expect(sql).toContain('1.0');
  });

  test('restricts to the winner-type exclusive kind allowlist', () => {
    expect(sql).toContain("a.event_kind = b.event_kind");
    expect(sql).toContain("a.event_kind IN ('match_winner','championship_winner')");
  });

  test('gates on the same resolving event (sameEventFragment / game_ordinal)', () => {
    expect(sql).toContain('game_ordinal');
    expect(sql).toContain('platform_event_id');
  });

  test('a.question_id < b.question_id orientation', () => {
    expect(sql).toContain('a.question_id < b.question_id');
  });

  test('distinct outcome subject', () => {
    expect(sql).toContain('a.canonical_subject IS DISTINCT FROM b.canonical_subject');
  });

  test('WP-R4: never mutex two draw slots (NULL-safe draw_axis stamp guard on the winner arm)', () => {
    expect(sql).toContain("COALESCE(a.discriminators->>'draw_axis', '') = 'draw'");
    expect(sql).toContain("COALESCE(b.discriminators->>'draw_axis', '') = 'draw'");
  });

  test('grain gate: same metric + no subject-substring superset', () => {
    expect(sql).toContain('a.condition_metric IS NOT DISTINCT FROM b.condition_metric');
    expect(sql).toContain("a.canonical_subject NOT ILIKE '%' || b.canonical_subject || '%'");
    expect(sql).toContain("b.canonical_subject NOT ILIKE '%' || a.canonical_subject || '%'");
  });

  test('excludes pairs already in one categorical outcome_set', () => {
    expect(sql).toContain('outcome_set_slots');
    expect(sql).toContain('NOT EXISTS');
  });

  test('excludes the candle_direction dead branch', () => {
    expect(sql).toContain("a.event_kind IS DISTINCT FROM 'candle_direction'");
    expect(sql).toContain("b.event_kind IS DISTINCT FROM 'candle_direction'");
  });

  test('cheap hash-join equality key on canonical_event', () => {
    expect(sql).toContain('lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))');
  });

  test('first-writer-wins conflict handling', () => {
    expect(sql).toContain(EDGE_CONFLICT_SQL);
  });

  test('FT/HT grain gate: both sides must agree on the bare-halftime marker', () => {
    expect(sql).toContain('half[- ]?time');
    expect(sql).toContain('draw\\s+at\\s+(the\\s+)?half');
    expect(sql).toMatch(/a\.title ~\* '[^']*'[\s\S]*?a\.canonical_subject ~\* '[^']*'[\s\S]{0,400}?=[\s\S]{0,50}?b\.title ~\* '[^']*'[\s\S]*?b\.canonical_subject ~\* '[^']*'/);
    expect(sql).toContain('\\m1h\\M|\\m2h\\M');
    expect(sql).toContain('\\m(revenue|earnings|eps|gdp|cpi');
  });

  test('metric_scope gate: NULL-tolerant both-known-and-differ (belt-and-suspenders w/ HALF_RX)', () => {
    expect(sql).toContain(
      'NOT (a.metric_scope IS NOT NULL AND b.metric_scope IS NOT NULL AND a.metric_scope IS DISTINCT FROM b.metric_scope)',
    );
    expect(sql).toContain('half[- ]?time');
    expect(sql).not.toContain('a.metric_scope IS NOT DISTINCT FROM b.metric_scope');
  });

  describe('R5b opposite-team spread mutex', () => {
    test('emits a distinct pattern label as a second INSERT (ins_spread)', () => {
      expect(sql).toContain('ins_spread');
      expect(sql).toContain(`'cross_question_mutex_spread'`);
      expect(sql).toContain('(SELECT COUNT(*) FROM ins) + (SELECT COUNT(*) FROM ins_spread)');
    });

    test('restricts to spread × spread', () => {
      expect(sql).toContain(`a.event_kind = 'match_spread' AND b.event_kind = 'match_spread'`);
    });

    test('single-team spreads only (excludes 2-participant handicap folds)', () => {
      expect(sql).toContain('array_length(a.participants, 1) = 1 AND array_length(b.participants, 1) = 1');
    });

    test('keyed on DISTINCT participants[1] (team), NOT canonical_subject — folded + substring belt (G5)', () => {
      expect(sql).toContain(
        'lower(immutable_unaccent(btrim(a.participants[1]))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.participants[1])))',
      );
      const spread = sql.slice(sql.indexOf('ins_spread'), sql.indexOf('ins_half'));
      expect(spread).toContain(
        "lower(immutable_unaccent(btrim(a.participants[1]))) NOT ILIKE '%' || lower(immutable_unaccent(btrim(b.participants[1]))) || '%'",
      );
      expect(spread).toContain(
        "lower(immutable_unaccent(btrim(b.participants[1]))) NOT ILIKE '%' || lower(immutable_unaccent(btrim(a.participants[1]))) || '%'",
      );
    });

    test('does NOT require equal |value_primary| (opposite spreads mutex for all thresholds)', () => {
      expect(sql).not.toContain('ABS(a.value_primary) = ABS(b.value_primary)');
    });

    test('gates on the same resolving fixture (sameEventFragment) + not-already-in-set', () => {
      expect((sql.match(/game_ordinal/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((sql.match(/outcome_set_slots/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    test('DIRECTION BELT: both sides must be direction=above ("wins by over N")', () => {
      const spread = sql.slice(sql.indexOf('ins_spread'), sql.indexOf('ins_half'));
      expect(spread).toContain(`a.condition_direction = 'above' AND b.condition_direction = 'above'`);
    });

    test('KNOWN-DATE GATE: cross-pe pairs need both condition_dates known', () => {
      const spread = sql.slice(sql.indexOf('ins_spread'), sql.indexOf('ins_half'));
      expect(spread).toContain('a.platform_event_id = b.platform_event_id');
      expect(spread).toContain('a.condition_date IS NOT NULL AND b.condition_date IS NOT NULL');
    });

    test('does NOT gate on canonical_subject distinctness (subject embeds the threshold)', () => {
      const spread = sql.slice(sql.indexOf('ins_spread'), sql.indexOf('ins_half'));
      expect(spread).not.toContain('canonical_subject IS DISTINCT FROM');
    });
  });

  describe('R5c halftime_leader mutex', () => {
    const half = sql.slice(sql.indexOf('ins_half'));

    test('emits a distinct pattern label as a third INSERT (ins_half)', () => {
      expect(sql).toContain('ins_half');
      expect(half).toContain(`'cross_question_mutex_halftime'`);
      expect(sql).toContain('(SELECT COUNT(*) FROM ins_half)');
    });

    test('restricts to halftime_leader × halftime_leader (kind = the half discriminator)', () => {
      expect(half).toContain(`a.event_kind = 'halftime_leader' AND b.event_kind = 'halftime_leader'`);
    });

    test('distinct outcome subject + spelling-drift substring belt', () => {
      expect(half).toContain('a.canonical_subject IS DISTINCT FROM b.canonical_subject');
      expect(half).toContain(`a.canonical_subject NOT ILIKE '%' || b.canonical_subject || '%'`);
      expect(half).toContain(`b.canonical_subject NOT ILIKE '%' || a.canonical_subject || '%'`);
    });

    test('Draw≠Tie belt: two labels for one level-at-half outcome are never mutexed', () => {
      expect(half).toContain(`~* '(^|\\s)(draw|tie)$'`);
    });

    test('WP-R4: draw_axis stamp guard generalizes the Draw≠Tie belt to the mislabeled class', () => {
      expect(half).toContain("COALESCE(a.discriminators->>'draw_axis', '') = 'draw'");
      expect(half).toContain("COALESCE(b.discriminators->>'draw_axis', '') = 'draw'");
    });

    test('NULL-tolerant metric/scope gates (both-known-differ, NOT strict equality)', () => {
      expect(half).toContain(
        'NOT (a.condition_metric IS NOT NULL AND b.condition_metric IS NOT NULL AND a.condition_metric IS DISTINCT FROM b.condition_metric)',
      );
      expect(half).toContain(
        'NOT (a.metric_scope IS NOT NULL AND b.metric_scope IS NOT NULL AND a.metric_scope IS DISTINCT FROM b.metric_scope)',
      );
      expect(half).not.toContain('a.condition_metric IS NOT DISTINCT FROM b.condition_metric');
    });

    test('KNOWN-DATE GATE: cross-pe pairs need both condition_dates known', () => {
      expect(half).toContain('a.platform_event_id = b.platform_event_id');
      expect(half).toContain('a.condition_date IS NOT NULL AND b.condition_date IS NOT NULL');
    });

    test('gates on the same resolving fixture (sameEventFragment) + not-already-in-set', () => {
      expect(half).toContain('game_ordinal');
      expect(half).toContain('outcome_set_slots');
    });

    test('winner-kind allowlist of the main INSERT is unchanged (halftime NOT folded in)', () => {
      expect(sql).toContain("a.event_kind IN ('match_winner','championship_winner')");
    });
  });

  describe('winner-arm tour gates (winnerMutexTourGatesSql)', () => {
    const gates = winnerMutexTourGatesSql('a', 'b');

    test('the generated builder SQL embeds the gates in the winner arm', () => {
      expect(sql).toContain(gates);
    });

    test('TOUR-DISJOINT: refuses both-known DIFFERENT tennis tours, championship_winner ONLY', () => {
      expect(gates).toContain("a.event_kind = 'championship_winner'");
      expect(gates).toContain("lower(btrim(a.league)) IN ('atp tour','wta tour')");
      expect(gates).toContain("lower(btrim(b.league)) IN ('atp tour','wta tour')");
      expect(gates).toContain('lower(btrim(a.league)) <> lower(btrim(b.league))');
    });

    test('SQL-SHAPE PIN: Gate-1 carries explicit IS NOT NULL anchors (bothKnownDifferSql idiom)', () => {
      expect(gates).toContain('a.league IS NOT NULL AND b.league IS NOT NULL');
      const gate1 = gates.slice(0, gates.indexOf('ANY-OF-FAMILY'));
      expect(gate1.indexOf('a.league IS NOT NULL')).toBeGreaterThan(gate1.indexOf('AND NOT'));
      expect(gate1.indexOf('a.league IS NOT NULL')).toBeLessThan(gate1.indexOf("IN ('atp tour','wta tour')"));
    });

    describe('Gate-1 3VL truth table (Kleene evaluation of the shipped atoms)', () => {
      type B3 = boolean | null;
      const and3 = (...xs: B3[]): B3 =>
        xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true;
      const not3 = (x: B3): B3 => (x === null ? null : !x);
      const fold = (x: string) => x.trim().toLowerCase();
      const inTours = (x: string | null): B3 =>
        x === null ? null : ['atp tour', 'wta tour'].includes(fold(x));
      const differ = (a: string | null, b: string | null): B3 =>
        a === null || b === null ? null : fold(a) !== fold(b);
      const isNotNull = (x: string | null): B3 => x !== null;

      const newGate1 = (a: string | null, b: string | null): B3 =>
        not3(and3(true, isNotNull(a), isNotNull(b), inTours(a), inTours(b), differ(a, b)));
      const oldGate1 = (a: string | null, b: string | null): B3 =>
        not3(and3(true, inTours(a), inTours(b), differ(a, b)));
      const survives = (g: B3) => g === true;

      test('(NULL, NULL) → gate passes (edge survives); OLD form dropped it', () => {
        expect(newGate1(null, null)).toBe(true);
        expect(survives(newGate1(null, null))).toBe(true);
        expect(oldGate1(null, null)).toBe(null);
        expect(survives(oldGate1(null, null))).toBe(false);
      });

      test('(known tennis, NULL) → gate passes; OLD form dropped it', () => {
        expect(newGate1('ATP Tour', null)).toBe(true);
        expect(oldGate1('ATP Tour', null)).toBe(null);
        expect(oldGate1('Premier League', null)).toBe(true);
        expect(newGate1('Premier League', null)).toBe(true);
      });

      test('(known, known-equal) → gate passes under both forms', () => {
        expect(newGate1('ATP Tour', 'atp tour')).toBe(true);
        expect(oldGate1('ATP Tour', 'atp tour')).toBe(true);
        expect(newGate1('PGA Tour', 'PGA Tour')).toBe(true);
      });

      test('(known, known-differ tennis tours) → REFUSED under both forms (intended semantics kept)', () => {
        expect(newGate1('ATP Tour', 'WTA Tour')).toBe(false);
        expect(survives(newGate1('ATP Tour', 'WTA Tour'))).toBe(false);
        expect(oldGate1('ATP Tour', 'WTA Tour')).toBe(false);
        expect(newGate1('PGA Tour', 'PGA Championship')).toBe(true);
        expect(newGate1('PGA Tour', 'LPGA Tour')).toBe(true);
      });

      test('NEW gate is two-valued on every input (no NULL escapes to the JOIN ON)', () => {
        const vals: (string | null)[] = [null, 'ATP Tour', 'WTA Tour', 'PGA Tour'];
        for (const a of vals)
          for (const b of vals) expect(newGate1(a, b)).not.toBe(null);
      });
    });

    test('EXACT tour membership, not a tour-name prefix (PGA drift trap)', () => {
      expect(gates).not.toMatch(/pga|lpga/i);
      expect(gates).not.toContain('^(atp|wta');
    });

    test('ANY-OF-FAMILY: "<year> grand slam"/"<year> major" championship nodes never mutex', () => {
      expect(gates).toContain("(grand slam|major)$");
      expect(gates).toContain('btrim(lower(a.canonical_event))');
      expect(gates).toContain('btrim(lower(b.canonical_event))');
    });

    test('gates are REFUSALS (AND NOT …) — they can only drop pairs, never mint one', () => {
      expect(gates.split('AND NOT').length - 1).toBe(2);
    });

    test('GATE-2 UNCHANGED: any-of-family refusal keeps its wave-2 semantics byte-exact', () => {
      const gate2Anchor = gates.toLowerCase().indexOf('any-of-family');
      expect(gate2Anchor).toBeGreaterThan(-1);
      const gate2 = gates.slice(gate2Anchor);
      expect(gate2).toContain(`AND NOT (a.event_kind = 'championship_winner'
            AND (btrim(lower(a.canonical_event)) ~ '(grand slam|major)$'
              OR btrim(lower(b.canonical_event)) ~ '(grand slam|major)$'))`);
      expect(gate2).not.toContain('league');
    });
  });
});

describe('winner-arm closure gates (G3/G4c/G6)', () => {
  const sql = buildMutualExclusionXqEdgesSql();

  test('G3: match_winner orientation gate is wired on BOTH sides of the winner arm', () => {
    expect(sql).toContain(`${winnerOrientationGateSql('nf')} AS orientation_ok`);
    expect(sql).toContain('COALESCE(a.orientation_ok, TRUE)');
    expect(sql).toContain('COALESCE(b.orientation_ok, TRUE)');
    expect(winnerOrientationGateSql('a')).toContain("a.event_kind = 'match_winner'");
    expect(winnerOrientationGateSql('a')).toContain('a.canonical_subject = ANY(a.participants)');
  });

  test('G3 TS mirror: REFUSED bare "Match Winner" placeholder, KEPT a named participant', () => {
    expect(passesWinnerOrientation('match_winner', 'Match Winner', ['BetBoom', 'Team Spirit'])).toBe(false);
    expect(passesWinnerOrientation('match_winner', 'BetBoom', ['BetBoom', 'Team Spirit'])).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'Match Winner', null)).toBe(true);
    // EMPTY participants must also pass: SQL `= ANY('{}')` is FALSE, so without this the gate would refuse every no-teams-found match_winner.
    expect(passesWinnerOrientation('match_winner', 'Real Madrid', [])).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'Match Winner', [])).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'Aarhus GF win', ['Aarhus GF', 'Randers FC'])).toBe(true);
    expect(passesWinnerOrientation('match_winner', '3DMAX wins Map 1', ['3DMAX', 'Astralis'])).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'Draw', ['Fulham FC', 'Wolves'])).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'X the Draw', ['A', 'B'], 'draw')).toBe(true);
    expect(passesWinnerOrientation('match_winner', 'Match Winner', ['BetBoom', 'Team Spirit'])).toBe(false);
    expect(passesWinnerOrientation('match_winner', 'Washington Nationals vs. Colorado Rockies', ['Washington Nationals', 'Colorado Rockies'])).toBe(false);
    expect(passesWinnerOrientation('match_winner', 'Nagoya Diamond Dolphins', ['Diamond Dolphins', 'Utsunomiya Brex'])).toBe(true);
    expect(passesWinnerOrientation('championship_winner', 'Argentina', null)).toBe(true);
  });

  test('G4c: cross-series refusal keyed on the inlined mux_nf.series column', () => {
    expect(sql).toContain("split_part(r.raw->>'event_ticker', '-', 1) AS series");
    expect(sql).toContain(crossSeriesRefusalSql('a', 'b'));
    expect(crossSeriesRefusalSql('a', 'b')).toContain('a.series IS NOT NULL AND b.series IS NOT NULL');
    expect(crossSeriesRefusalSql('a', 'b')).toContain('a.series IS DISTINCT FROM b.series');
  });

  test('G6: award multi-winner refusal (Fields/Grammy series prefixes + selection titles)', () => {
    expect(sql).toContain('AS award_multiwinner');
    expect(sql).toContain('COALESCE(a.award_multiwinner, FALSE)');
    expect(sql).toContain('COALESCE(b.award_multiwinner, FALSE)');
    expect(sql).toContain('nobel peace');
    expect(MULTI_WINNER_AWARD_PREFIXES).toContain('KXFIELDS');
    expect(awardMultiWinnerRefusalSql('ksa', 'ksb', 'a', 'b')).toContain("a.title ~* '");
    expect(awardMultiWinnerRefusalSql('ksa', 'ksb', 'a', 'b')).toContain('advance');
  });
});
