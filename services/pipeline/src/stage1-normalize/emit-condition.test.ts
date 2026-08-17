/**
 * Unit suite for the Stage-1 emission door.
 *
 * The load-bearing assertions:
 *   - Parity: every archetype variant's legal temporal set is a subset of
 *     SHAPE_TEMPORAL_VALID[derived shape], so the derivation table can never
 *     drift from the validity table and the PIT+during_period exclusion is
 *     inherited, never re-encoded.
 *   - The door rejects (warn-and-null), never repairs: no silent range swap,
 *     no silent direction strip, no silent unit pass-through.
 *   - bespoke is warn-validated only, requires a >=20-char justification, and
 *     embeds the greppable BESPOKE_EMISSION marker once per (tag, shape).
 *   - EMIT_CONDITION_STRICT=1 turns hard-rule warns into throws; bespoke
 *     emissions still flow through (documented exceptions must survive
 *     strict shadow-diff runs).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  ARCHETYPE_VARIANTS,
  emitCondition,
  validateConditionTuple,
  type EmitSpec,
} from './emit-condition.js';
import { SHAPE_TEMPORAL_VALID } from './shape-temporal-validation.js';
import { foldUnit, MONOTONE_COUNT_UNITS, NONNEGATIVE_COUNT_UNITS } from '../util/condition-shape.js';

let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>>;
beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  delete process.env['EMIT_CONDITION_STRICT'];
});

function warnText(): string {
  return warnSpy.mock.calls.map((c) => c.map((a) => String(a)).join(' ')).join('\n');
}

// ── Spec builders (each test overrides what it exercises) ────────────────────

function thresholdSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'terminal_threshold',
    tag: 'test:threshold',
    eventKind: 'price_threshold',
    metric: 'price',
    direction: 'above',
    value: { primary: 100000, secondary: null, unit: 'USD' },
    ...over,
  };
}

function rangeSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'terminal_range',
    tag: 'test:range',
    eventKind: 'price_threshold',
    metric: 'price',
    value: { primary: 90000, secondary: 100000, unit: 'USD' },
    ...over,
  };
}

function cumulativeSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'cumulative_count',
    tag: 'test:cumulative',
    eventKind: 'other',
    metric: 'count',
    arm: 'range',
    value: { primary: 360, secondary: 379, unit: 'tweets' },
    ...over,
  };
}

function occurrenceSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'event_occurrence',
    tag: 'test:occurrence',
    eventKind: 'other',
    metric: null,
    ...over,
  };
}

function categoricalSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'categorical_selection',
    tag: 'test:categorical',
    eventKind: 'other',
    metric: null,
    outcomeLabel: 'FOMC 25 bps',
    ...over,
  };
}

function bespokeSpec(over: Partial<EmitSpec> = {}): EmitSpec {
  return {
    archetype: 'bespoke',
    tag: 'test:bespoke',
    eventKind: 'other',
    metric: null,
    bespoke: {
      shape: 'categorical_outcome',
      justification: 'path-dependent barrier race awaiting adjudication A3',
    },
    ...over,
  };
}

// ── derivation-table parity — the anti-drift gate ──────────────────────────

describe('ARCHETYPE_VARIANTS × SHAPE_TEMPORAL_VALID parity', () => {
  test('every variant legal temporal set is a SUBSET of SHAPE_TEMPORAL_VALID[shape]', () => {
    for (const [key, v] of Object.entries(ARCHETYPE_VARIANTS)) {
      for (const t of v.temporal) {
        expect(`${key}: ${v.shape}+${t} valid=${SHAPE_TEMPORAL_VALID[v.shape].has(t)}`)
          .toBe(`${key}: ${v.shape}+${t} valid=true`);
      }
      // The default, when non-null, must itself be a legal member.
      if (v.defaultTemporal !== null) {
        expect(v.temporal.has(v.defaultTemporal)).toBe(true);
      }
    }
  });

  test('PIT+during_period is excluded from the source table (inherited, not re-stated)', () => {
    expect(SHAPE_TEMPORAL_VALID.point_in_time.has('during_period')).toBe(false);
    // and no point_in_time variant admits during_period
    for (const v of Object.values(ARCHETYPE_VARIANTS)) {
      if (v.shape === 'point_in_time') expect(v.temporal.has('during_period')).toBe(false);
    }
  });
});

// ── Rule 2: temporal ─────────────────────────────────────────────────────────

describe('emitCondition — temporal validation (rule 2)', () => {
  test('omitted temporal takes the archetype default', () => {
    expect(emitCondition(thresholdSpec())?.temporal_semantics).toBe('on_date');
    expect(emitCondition(rangeSpec())?.temporal_semantics).toBe('on_date');
    expect(
      emitCondition({
        archetype: 'path_touch', tag: 'test:touch', eventKind: 'price_threshold',
        metric: 'price', direction: 'above', value: { primary: 100000, secondary: null, unit: 'USD' },
      })?.temporal_semantics,
    ).toBe('by_date');
    expect(emitCondition(occurrenceSpec())?.temporal_semantics).toBeNull();
  });

  test('terminal_threshold + during_period is rejected (PIT+during_period stays dead)', () => {
    expect(emitCondition(thresholdSpec({ temporal: 'during_period' }))).toBeNull();
    expect(warnText()).toContain('ARCHETYPE_TEMPORAL');
  });

  test('cumulative PIT boundary arm + during_period is rejected (period-end read is on_date)', () => {
    const spec = cumulativeSpec({
      arm: 'above',
      value: { primary: 380, secondary: null, unit: 'tweets' },
      temporal: 'during_period',
    });
    expect(emitCondition(spec)).toBeNull();
  });

  test('terminal_range + during_period is rejected — legal ONLY via cumulative_count', () => {
    // range_snapshot+during_period IS in SHAPE_TEMPORAL_VALID; the archetype
    // table narrows it away for terminal_range.
    expect(SHAPE_TEMPORAL_VALID.range_snapshot.has('during_period')).toBe(true);
    expect(emitCondition(rangeSpec({ temporal: 'during_period' }))).toBeNull();
  });

  test('null temporal rejected where the variant does not allow it', () => {
    expect(emitCondition(thresholdSpec({ temporal: null }))).toBeNull();
  });

  test('null temporal legal for event_occurrence and fixture standalone_binary', () => {
    expect(emitCondition(occurrenceSpec({ temporal: null }))).not.toBeNull();
    const t = emitCondition({
      archetype: 'fixture_outcome', topology: 'standalone_binary',
      tag: 'test:h2h', eventKind: 'match_winner', metric: null, temporal: null,
    });
    expect(t).not.toBeNull();
    expect(t?.condition_shape).toBe('binary_event');
  });
});

// ── Rule 3: direction ────────────────────────────────────────────────────────

describe('emitCondition — direction classes (rule 3)', () => {
  test('terminal_range forces between regardless of input', () => {
    expect(emitCondition(rangeSpec())?.condition_direction).toBe('between');
    expect(emitCondition(rangeSpec({ direction: null }))?.condition_direction).toBe('between');
    expect(emitCondition(rangeSpec({ direction: 'above' }))?.condition_direction).toBe('between');
  });

  test('range condition_value is the between branch lo-hi<unit>, never lo_hi', () => {
    const t = emitCondition(rangeSpec({ direction: null }));
    expect(t?.condition_value).toBe('90000-100000usd');
  });

  test('path_touch rejects at/between/null hard', () => {
    const touch = (direction: EmitSpec['direction']): EmitSpec => ({
      archetype: 'path_touch', tag: 'test:touch', eventKind: 'price_threshold',
      metric: 'price', direction, value: { primary: 100000, secondary: null, unit: 'USD' },
    });
    expect(emitCondition(touch('at'))).toBeNull();
    expect(emitCondition(touch('between'))).toBeNull();
    expect(emitCondition(touch(null))).toBeNull();
    expect(emitCondition(touch('below'))?.condition_shape).toBe('monotonic_threshold');
  });

  test('cumulative boundary arm derives direction from the arm; contradiction rejected', () => {
    const above = cumulativeSpec({ arm: 'above', value: { primary: 380, secondary: null, unit: 'tweets' } });
    expect(emitCondition(above)?.condition_direction).toBe('above');
    expect(emitCondition({ ...above, direction: 'below' })).toBeNull();
  });

  test('event_occurrence rejects a non-null direction (the Limitless-ATH anomaly routes bespoke)', () => {
    expect(emitCondition(occurrenceSpec({ direction: 'above' }))).toBeNull();
    expect(warnText()).toContain('ARCHETYPE_DIRECTION');
  });

  test('categorical_selection admits null | at | above | below only (below = open-bottom signed slot)', () => {
    expect(emitCondition(categoricalSpec({ direction: 'above', value: { primary: 12, secondary: null, unit: 'cuts' } }))).not.toBeNull();
    // cumulative '50+ bps decrease' ⇔ Δ ≤ −50 → below/−50 must pass the door
    expect(emitCondition(categoricalSpec({ direction: 'below', value: { primary: -50, secondary: null, unit: 'bps' } }))).not.toBeNull();
    expect(emitCondition(categoricalSpec({ direction: 'between' }))).toBeNull();
  });
});

// ── Rule 4: value arity ──────────────────────────────────────────────────────

describe('emitCondition — value arity (rule 4)', () => {
  test('terminal_range rejects lo >= hi — NO silent swap at the door', () => {
    expect(emitCondition(rangeSpec({ value: { primary: 100000, secondary: 90000, unit: 'USD' } }))).toBeNull();
    expect(emitCondition(rangeSpec({ value: { primary: 5, secondary: 5, unit: 'USD' } }))).toBeNull();
    expect(warnText()).toContain('VALUE_ARITY');
  });

  test('terminal_range requires both bounds finite', () => {
    expect(emitCondition(rangeSpec({ value: { primary: 90000, secondary: null, unit: 'USD' } }))).toBeNull();
    expect(emitCondition(rangeSpec({ value: { primary: NaN, secondary: 100000, unit: 'USD' } }))).toBeNull();
    expect(emitCondition(rangeSpec({ value: null }))).toBeNull();
  });

  test('arity-1 archetypes reject a non-null secondary and a missing primary', () => {
    expect(emitCondition(thresholdSpec({ value: { primary: 100000, secondary: 200000, unit: 'USD' } }))).toBeNull();
    expect(emitCondition(thresholdSpec({ value: null }))).toBeNull();
    expect(emitCondition(thresholdSpec({ value: { primary: Infinity, secondary: null, unit: 'USD' } }))).toBeNull();
  });

  test('event_occurrence rejects a non-null value_primary', () => {
    expect(emitCondition(occurrenceSpec({ value: { primary: 5, secondary: null, unit: null } }))).toBeNull();
    const ok = emitCondition(occurrenceSpec());
    expect(ok?.value_primary).toBeNull();
    expect(ok?.condition_value).toBeNull(); // null primary ⇒ null condition_value
  });

  test('categorical_selection 2-value (score pair) requires direction null, no lo<hi ordering', () => {
    // Template Z exact-score (2,1): primary > secondary is LEGAL here.
    const z = emitCondition(categoricalSpec({
      outcomeLabel: '2-1',
      value: { primary: 2, secondary: 1, unit: null },
      direction: null,
    }));
    expect(z).not.toBeNull();
    expect(z?.condition_value).toBe('2_1'); // null-direction pair encoding survives for score pairs
    expect(emitCondition(categoricalSpec({
      outcomeLabel: '2-1',
      value: { primary: 2, secondary: 1, unit: null },
      direction: 'at',
    }))).toBeNull();
  });
});

// ── Rule 5: cumulative unit gate ─────────────────────────────────────────────

describe('emitCondition — MONOTONE_COUNT_UNITS hard gate (rule 5; split from NONNEGATIVE)', () => {
  test('count units pass; the unit is folded', () => {
    const t = emitCondition(cumulativeSpec({ value: { primary: 360, secondary: 379, unit: 'Tweets' } }));
    expect(t).not.toBeNull();
    expect(t?.value_unit).toBe('tweets');
    expect(t?.condition_shape).toBe('range_snapshot');
    expect(t?.temporal_semantics).toBe('during_period');
  });

  test('non-count units hard-reject (usd / fahrenheit / rank)', () => {
    for (const unit of ['USD', 'fahrenheit', 'rank', null]) {
      expect(emitCondition(cumulativeSpec({ value: { primary: 1, secondary: 2, unit } }))).toBeNull();
    }
    expect(warnText()).toContain('CUMULATIVE_UNIT');
  });

  test('legacy monotonic open-top arm requires the explicit flag', () => {
    const legacy = emitCondition(cumulativeSpec({
      arm: 'above', legacyMonotonicArm: true,
      value: { primary: 380, secondary: null, unit: 'tweets' },
    }));
    expect(legacy?.condition_shape).toBe('monotonic_threshold');
    expect(legacy?.temporal_semantics).toBe('during_period');
    const modern = emitCondition(cumulativeSpec({
      arm: 'above', value: { primary: 380, secondary: null, unit: 'tweets' },
    }));
    expect(modern?.condition_shape).toBe('point_in_time'); // doc.md rule 1: prefer the snapshot stamp
    expect(modern?.temporal_semantics).toBe('on_date');
  });

  test('missing arm is rejected', () => {
    expect(emitCondition(cumulativeSpec({ arm: undefined }))).toBeNull();
  });

  test("'cases' passes the gate (measles count buckets join INTEGER_GRAIN/MONOTONE)", () => {
    const t = emitCondition(cumulativeSpec({ value: { primary: 2200, secondary: null, unit: 'cases' }, arm: 'above', legacyMonotonicArm: true }));
    expect(t).not.toBeNull();
    expect(t?.condition_shape).toBe('monotonic_threshold');
    expect(t?.temporal_semantics).toBe('during_period');
  });

  test('the MONOTONE/NONNEGATIVE split: identical membership today (semantic future-proofing); follower/subscriber outside BOTH', () => {
    expect([...MONOTONE_COUNT_UNITS].sort()).toEqual([...NONNEGATIVE_COUNT_UNITS].sort());
    for (const u of ['follower', 'followers', 'subscriber', 'subscribers']) {
      expect(MONOTONE_COUNT_UNITS.has(u)).toBe(false);
      expect(NONNEGATIVE_COUNT_UNITS.has(u)).toBe(false);
    }
  });
});

// ── Rule 6 + metric invariants ───────────────────────────────────────────────

describe('emitCondition — unit fold + metric invariants (rule 6)', () => {
  test('value_unit is foldUnit()-ed and fold-stable (the door never canonicalizes)', () => {
    const t = emitCondition(thresholdSpec({ value: { primary: 100000, secondary: null, unit: ' USD ' } }));
    expect(t?.value_unit).toBe('usd');
    expect(foldUnit(t!.value_unit)).toBe(t!.value_unit);
  });

  test("metric percentage requires folded unit 'percent'", () => {
    expect(emitCondition(thresholdSpec({
      metric: 'percentage', value: { primary: 50, secondary: null, unit: 'percent' },
    }))?.condition_value).toBe('>=50percent');
    expect(emitCondition(thresholdSpec({
      metric: 'percentage', value: { primary: 50, secondary: null, unit: 'USD' },
    }))).toBeNull();
    expect(warnText()).toContain('UNIT_PERCENT');
  });

  test('terminal_threshold requires a numeric metric', () => {
    expect(emitCondition(thresholdSpec({ metric: null }))).toBeNull();
    expect(emitCondition(thresholdSpec({ metric: 'boolean' }))).toBeNull();
  });

  test("fixture_margin requires metric 'score' and stamps point_in_time + at_resolution", () => {
    const margin = (over: Partial<EmitSpec> = {}): EmitSpec => ({
      archetype: 'fixture_margin', tag: 'test:spread', eventKind: 'match_spread',
      metric: 'score', direction: 'above', value: { primary: 5.5, secondary: null, unit: 'points' },
      metricScope: 'game', ...over,
    });
    const t = emitCondition(margin());
    expect(t?.condition_shape).toBe('point_in_time');
    expect(t?.temporal_semantics).toBe('at_resolution');
    expect(t?.metric_scope).toBe('game');
    expect(emitCondition(margin({ metric: 'price' }))).toBeNull();
  });
});

// ── fixture_outcome topologies ───────────────────────────────────────────────

describe('emitCondition — fixture_outcome topologies', () => {
  test('standalone_binary → binary_event, arity 0, null direction', () => {
    const t = emitCondition({
      archetype: 'fixture_outcome', topology: 'standalone_binary',
      tag: 'test:h2h', eventKind: 'match_winner', metric: null,
    });
    expect(t?.condition_shape).toBe('binary_event');
    expect(t?.condition_direction).toBeNull();
    expect(emitCondition({
      archetype: 'fixture_outcome', topology: 'standalone_binary',
      tag: 'test:h2h', eventKind: 'match_winner', metric: null,
      value: { primary: 1, secondary: null, unit: null },
    })).toBeNull();
  });

  test('mutex_partition_member → categorical_outcome + at_resolution', () => {
    const t = emitCondition({
      archetype: 'fixture_outcome', topology: 'mutex_partition_member',
      tag: 'test:winner', eventKind: 'match_winner', metric: null, outcomeLabel: 'Team A',
    });
    expect(t?.condition_shape).toBe('categorical_outcome');
    expect(t?.temporal_semantics).toBe('at_resolution');
  });

  test('rank_latch pins monotonic_threshold + metric rank + value 1 (ladders keep monotonic)', () => {
    const t = emitCondition({
      archetype: 'fixture_outcome', topology: 'rank_latch',
      tag: 'test:champ', eventKind: 'championship_winner', metric: null, direction: 'below',
    });
    expect(t?.condition_shape).toBe('monotonic_threshold');
    expect(t?.condition_metric).toBe('rank');
    expect(t?.value_primary).toBe(1);
    // contradictions are rejected, not overridden
    expect(emitCondition({
      archetype: 'fixture_outcome', topology: 'rank_latch',
      tag: 'test:champ', eventKind: 'championship_winner', metric: 'price', direction: 'below',
    })).toBeNull();
    expect(emitCondition({
      archetype: 'fixture_outcome', topology: 'rank_latch',
      tag: 'test:champ', eventKind: 'championship_winner', metric: null, direction: 'above',
    })).toBeNull();
  });

  test('missing topology is rejected', () => {
    expect(emitCondition({
      archetype: 'fixture_outcome', tag: 'test:h2h', eventKind: 'match_winner', metric: null,
    })).toBeNull();
  });
});

// ── Rule 9: outcome_label ────────────────────────────────────────────────────

describe('emitCondition — categorical outcome_label requirement (rule 9)', () => {
  test('categorical_selection requires a non-null, non-empty outcome_label', () => {
    expect(emitCondition(categoricalSpec({ outcomeLabel: null }))).toBeNull();
    expect(emitCondition(categoricalSpec({ outcomeLabel: '  ' }))).toBeNull();
    expect(emitCondition(categoricalSpec())?.outcome_label).toBe('FOMC 25 bps');
    expect(warnText()).toContain('OUTCOME_LABEL');
  });
});

// ── Rule 7: the date three-state ─────────────────────────────────────────────

describe('emitCondition — date three-state + forceNull flags (rule 7)', () => {
  test('date undefined → date_deferred (assembly chain derives)', () => {
    const t = emitCondition(thresholdSpec());
    expect(t?.date_deferred).toBe(true);
    expect(t?.condition_date_force_null).toBe(false);
    expect(t?.condition_date).toBeNull();
    expect(t?.condition_date_precision).toBeNull();
    expect(t?.condition_date_source).toBeNull();
  });

  test('forceNull → condition_date_force_null (FDV precedent: end_date fallback suppressed)', () => {
    const t = emitCondition(thresholdSpec({ date: { forceNull: true } }));
    expect(t?.condition_date_force_null).toBe(true);
    expect(t?.date_deferred).toBe(false);
    expect(t?.condition_date).toBeNull();
  });

  test('explicit ConditionDateSpec travels with precision AND source', () => {
    const t = emitCondition(thresholdSpec({
      date: { iso: '2026-05-17', precision: 'day', source: 'limitless-title-date' },
    }));
    expect(t?.condition_date).toBe('2026-05-17');
    expect(t?.condition_date_precision).toBe('day');
    expect(t?.condition_date_source).toBe('limitless-title-date');
    expect(t?.date_deferred).toBe(false);
    expect(t?.condition_date_force_null).toBe(false);
  });
});

// ── bespoke ──────────────────────────────────────────────────────────────────

describe('emitCondition — bespoke (warn-validated, greppable, pinned)', () => {
  test('justification < 20 chars is rejected', () => {
    expect(emitCondition(bespokeSpec({ bespoke: { shape: 'binary_event', justification: 'too short' } }))).toBeNull();
    expect(warnText()).toContain('BESPOKE_JUSTIFICATION');
  });

  test('emits the caller-supplied shape and the BESPOKE_EMISSION(<tag>) marker', () => {
    const t = emitCondition(bespokeSpec({ tag: 'test:bespoke-marker' }));
    expect(t?.condition_shape).toBe('categorical_outcome');
    expect(warnText()).toContain('BESPOKE_EMISSION(test:bespoke-marker): categorical_outcome');
  });

  test('marker warns once per (tag, shape) per process', () => {
    const spec = bespokeSpec({ tag: 'test:bespoke-once' });
    emitCondition(spec);
    emitCondition(spec);
    const markers = warnSpy.mock.calls
      .map((c) => c.map(String).join(' '))
      .filter((s) => s.includes('BESPOKE_EMISSION(test:bespoke-once)'));
    expect(markers.length).toBe(1);
  });

  test('out-of-table shape×temporal warns AND passes (warnShapePair parity)', () => {
    // categorical_outcome+during_period is in-table, so this exemplar uses a
    // still-invalid pair.
    const t = emitCondition(bespokeSpec({
      tag: 'test:bespoke-out-of-table',
      temporal: 'by_date', // categorical_outcome: at_resolution|during_period only
      bespoke: {
        shape: 'categorical_outcome',
        justification: 'synthetic out-of-table pair for warn-and-pass parity',
      },
    }));
    expect(t).not.toBeNull();
    expect(t?.temporal_semantics).toBe('by_date');
    expect(warnText()).toContain('Invalid shape×temporal: categorical_outcome + by_date (test:bespoke-out-of-table)');
  });

  test('the barrier-race pair is in-table — bespoke emits it warn-free', () => {
    const t = emitCondition(bespokeSpec({
      tag: 'test:bespoke-barrier',
      temporal: 'during_period',
      bespoke: {
        shape: 'categorical_outcome',
        justification: 'AK price barrier-race: path-dependent partition, adjudication A3',
      },
    }));
    expect(t).not.toBeNull();
    expect(t?.temporal_semantics).toBe('during_period');
    expect(warnText()).not.toContain('Invalid shape×temporal: categorical_outcome + during_period');
  });

  test('skips archetype direction/arity gates (Limitless ATH: binary + direction + null value)', () => {
    const t = emitCondition(bespokeSpec({
      tag: 'test:bespoke-ath',
      direction: 'above',
      metric: 'price',
      bespoke: {
        shape: 'binary_event',
        justification: 'dynamic prior-ATH strike, value unknowable at normalization',
      },
    }));
    expect(t).not.toBeNull();
    expect(t?.condition_direction).toBe('above'); // pinned, not silently stripped
    expect(t?.value_primary).toBeNull();
    expect(t?.condition_value).toBeNull(); // proves the direction is not load-bearing for condition_value
  });
});

// ── EMIT_CONDITION_STRICT ────────────────────────────────────────────────────

describe('EMIT_CONDITION_STRICT=1 — warns become throws', () => {
  test('hard-rule violations throw under strict', () => {
    process.env['EMIT_CONDITION_STRICT'] = '1';
    expect(() => emitCondition(rangeSpec({ value: { primary: 100000, secondary: 90000, unit: 'USD' } })))
      .toThrow(/VALUE_ARITY/);
    expect(() => emitCondition(thresholdSpec({ temporal: 'during_period' })))
      .toThrow(/ARCHETYPE_TEMPORAL/);
  });

  test('bespoke emissions still flow through strict runs (pinned exceptions, not blockers)', () => {
    process.env['EMIT_CONDITION_STRICT'] = '1';
    const t = emitCondition(bespokeSpec({ tag: 'test:bespoke-strict', temporal: 'during_period' }));
    expect(t).not.toBeNull();
  });

  test('production default (env unset) is warn-and-null', () => {
    expect(emitCondition(rangeSpec({ value: { primary: 100000, secondary: 90000, unit: 'USD' } }))).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── validateConditionTuple ───────────────────────────────────────────────────

describe('validateConditionTuple — validate-only chokepoint entry', () => {
  const okNorm = {
    condition_shape: 'point_in_time' as const,
    condition_direction: 'above' as const,
    condition_metric: 'price' as const,
    temporal_semantics: 'on_date' as const,
    value_primary: 100000,
    value_secondary: null,
    value_unit: 'USD',
    condition_date: '2026-05-17',
    condition_date_precision: 'day' as const,
  };

  test('valid tuple: silent', () => {
    validateConditionTuple(okNorm, 'text-det', 'template-A');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('shape×temporal warn is byte-compatible with warnShapePair', () => {
    validateConditionTuple(
      { ...okNorm, temporal_semantics: 'during_period' },
      'text-det', 'template-M',
    );
    expect(warnText()).toContain('Invalid shape×temporal: point_in_time + during_period (template-M)');
  });

  test('null shape or temporal is a no-op (warnShapePair parity)', () => {
    validateConditionTuple({ ...okNorm, condition_shape: null }, 'text-det', 'x');
    validateConditionTuple({ ...okNorm, temporal_semantics: null }, 'kalshi-det', 'x');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("'between' with lo >= hi or a missing bound warns; null-direction pairs (Template Z) do not", () => {
    validateConditionTuple({
      ...okNorm, condition_shape: 'range_snapshot', condition_direction: 'between',
      value_primary: 100, value_secondary: 90,
    }, 'text-det', 'bad-range');
    validateConditionTuple({
      ...okNorm, condition_shape: 'range_snapshot', condition_direction: 'between',
      value_secondary: null,
    }, 'text-det', 'bad-range-2');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockClear();
    validateConditionTuple({
      ...okNorm, condition_shape: 'categorical_outcome', condition_direction: null,
      temporal_semantics: 'at_resolution', value_primary: 2, value_secondary: 1, value_unit: null,
      condition_metric: 'score',
    }, 'text-det', 'template-Z');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('percentage metric with a non-percent unit warns', () => {
    validateConditionTuple(
      { ...okNorm, condition_metric: 'percentage', value_unit: 'USD' },
      'kalshi-det', 'pct-check',
    );
    expect(warnText()).toContain('UNIT_PERCENT');
  });

  test('a date without precision warns ("no date without precision")', () => {
    validateConditionTuple(
      { ...okNorm, condition_date_precision: null },
      'text-det', 'date-check',
    );
    expect(warnText()).toContain('DATE_PRECISION');
  });

  test('strict mode throws (tests / shadow-diff)', () => {
    process.env['EMIT_CONDITION_STRICT'] = '1';
    expect(() => validateConditionTuple(
      { ...okNorm, temporal_semantics: 'during_period' },
      'text-det', 'template-M',
    )).toThrow(/Invalid shape×temporal/);
  });
});

// Kinds whose metric is structural (event_kind + canonical_event phrase carry
// it; condition_metric is NULL on both platforms) are exempt from the
// terminal_threshold numeric-metric invariant.
import { test as t2, expect as e2 } from 'bun:test';
t2('terminal_threshold METRICLESS exemption: weather_extreme accepts null metric', () => {
  const tuple = emitCondition({
    archetype: 'terminal_threshold', tag: 'test-weather', eventKind: 'weather_extreme',
    metric: null, direction: 'above', temporal: 'on_date',
    value: { primary: 30, unit: 'celsius' },
  }, 'text-det');
  e2(tuple).not.toBeNull();
  e2(tuple!.condition_shape).toBe('point_in_time');
  e2(tuple!.condition_metric).toBeNull();
});
t2('terminal_threshold still rejects null metric for non-exempt kinds', () => {
  const tuple = emitCondition({
    archetype: 'terminal_threshold', tag: 'test-price', eventKind: 'price_threshold',
    metric: null, direction: 'above', temporal: 'on_date',
    value: { primary: 100, unit: 'usd' },
  }, 'text-det');
  e2(tuple).toBeNull();
});
