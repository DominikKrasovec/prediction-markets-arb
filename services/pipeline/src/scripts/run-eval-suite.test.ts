/**
 * Unit tests for the pure helpers of run-eval-suite.ts.
 * Run: bun test services/pipeline/src/scripts/run-eval-suite.test.ts
 * (No DB access — the script's main() is guarded behind a direct-run check.)
 */
import { describe, expect, test } from 'bun:test';
import { SCHEMA_VERSION, pairIdFor, type EvalRecord } from './build-eval-sample.js';
import {
  cohenKappa,
  computeMetrics,
  formatRatio,
  mergeRecords,
  parseJsonl,
  type EvaluatedRow,
} from './run-eval-suite.js';

function makeRecord(overrides: Partial<EvalRecord> & { pair_id?: string } = {}): EvalRecord {
  const side_a = {
    platform: 'kalshi',
    platform_event_id: overrides.pair_id ?? 'kalshi:event:X',
    title: 'A title',
    event_kind: 'match_winner',
    grouping_type: null,
    league: null,
    sport: null,
    condition_date: null,
    condition_date_precision: null,
    deadline: null,
    child_count: 1,
    child_markets: [],
  };
  const side_b = { ...side_a, platform: 'polymarket', platform_event_id: '42' };
  const base: EvalRecord = {
    schema_version: SCHEMA_VERSION,
    pair_id: pairIdFor(side_a, side_b),
    side_a,
    side_b,
    context: {
      platform_pair: 'kalshi|polymarket',
      kind_family: 'match_winner',
      stratum: 'funnel_done',
      cosine_distance: 0.2,
      pipeline: {
        candidate_status: 'done',
        llm_reasoning: null,
        same_semantic_event: true,
        semantic_event_id_at_build: 1,
        shared_question_count: 1,
        verdict: 'merged',
      },
      generator: { script: 'test', seed: 'test', generated_at: '2026-06-10T00:00:00Z' },
    },
    label: null,
    failure_modes: [],
    label_source: null,
    labeled_at: null,
    annotator: null,
    annotator2_label: null,
    annotator2: null,
    kappa_subset: false,
    notes: null,
  };
  return { ...base, ...overrides };
}

describe('parseJsonl', () => {
  test('parses records, skips blanks and bad lines', () => {
    const good = JSON.stringify(makeRecord({ label: 'equivalent' }));
    const text = `${good}\n\nnot json\n{"pair_id": 7}\n${good}\n`;
    const { records, badLines } = parseJsonl(text);
    expect(records).toHaveLength(2);
    expect(badLines).toBe(2);
  });
  test('rejects unknown labels but keeps null labels (unlabeled todo rows)', () => {
    const bad = JSON.stringify(makeRecord({ label: 'maybe' as never }));
    const todo = JSON.stringify(makeRecord({ label: null }));
    const { records, badLines } = parseJsonl(`${bad}\n${todo}\n`);
    expect(records).toHaveLength(1);
    expect(records[0].label).toBeNull();
    expect(badLines).toBe(1);
  });
});

describe('mergeRecords', () => {
  test('labeled row wins over unlabeled duplicate regardless of file order', () => {
    const unlabeled = makeRecord({ label: null });
    const labeled = makeRecord({ label: 'equivalent' });
    const m1 = mergeRecords([[unlabeled], [labeled]]);
    expect(m1.merged).toHaveLength(1);
    expect(m1.merged[0].label).toBe('equivalent');
    const m2 = mergeRecords([[labeled], [unlabeled]]);
    expect(m2.merged[0].label).toBe('equivalent');
    expect(m1.conflicts + m2.conflicts).toBe(0);
  });
  test('conflicting labels counted, first kept', () => {
    const a = makeRecord({ label: 'equivalent' });
    const b = makeRecord({ label: 'unrelated' });
    const m = mergeRecords([[a], [b]]);
    expect(m.conflicts).toBe(1);
    expect(m.merged[0].label).toBe('equivalent');
  });
});

describe('cohenKappa', () => {
  test('perfect agreement = 1', () => {
    expect(
      cohenKappa([
        ['x', 'x'],
        ['y', 'y'],
        ['x', 'x'],
      ]),
    ).toBe(1);
  });
  test('known worked example', () => {
    // 2x2: a=20 agree-yes, d=15 agree-no, b=5, c=10  => po=0.7, pe=0.5, kappa=0.4
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 20; i++) pairs.push(['yes', 'yes']);
    for (let i = 0; i < 5; i++) pairs.push(['yes', 'no']);
    for (let i = 0; i < 10; i++) pairs.push(['no', 'yes']);
    for (let i = 0; i < 15; i++) pairs.push(['no', 'no']);
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 10);
  });
  test('empty input = null', () => {
    expect(cohenKappa([])).toBeNull();
  });
});

function evalRow(
  label: EvalRecord['label'],
  opts: Partial<Omit<EvaluatedRow, 'rec'>> & { failureModes?: string[]; annotator2?: EvalRecord['label'] } = {},
): EvaluatedRow {
  const rec = makeRecord({
    label,
    failure_modes: (opts.failureModes ?? []) as EvalRecord['failure_modes'],
    annotator2_label: opts.annotator2 ?? null,
  });
  return {
    rec,
    resolved: opts.resolved ?? true,
    hasCandidate: opts.hasCandidate ?? false,
    candidateStatus: opts.candidateStatus ?? null,
    sharedQuestions: opts.sharedQuestions ?? 0,
    anchorShared: opts.anchorShared ?? null,
    sameSemanticEvent: opts.sameSemanticEvent ?? false,
  };
}

describe('computeMetrics', () => {
  test('candidate recall counts subset labels as positives', () => {
    const rows = [
      evalRow('equivalent', { hasCandidate: true, candidateStatus: 'done', sharedQuestions: 1 }),
      evalRow('subset_a_in_b', { hasCandidate: false }),
      evalRow('unrelated', { hasCandidate: true, candidateStatus: 'skipped' }),
    ];
    const m = computeMetrics(rows, 3, 0);
    expect(m.stage3a.positives).toBe(2);
    expect(m.stage3a.recall.value).toBeCloseTo(0.5);
    expect(m.stage3a.equivalent_only_recall.value).toBeCloseTo(1);
  });

  test('merge precision/recall: equivalent is the only merge-positive', () => {
    const rows = [
      evalRow('equivalent', { sharedQuestions: 1 }), // TP
      evalRow('equivalent', { sharedQuestions: 0 }), // FN
      evalRow('subset_a_in_b', { sharedQuestions: 2, failureModes: ['value_grid_mismatch'] }), // FP (subset must NOT fuse)
      evalRow('unrelated', { sharedQuestions: 0 }), // TN
    ];
    const m = computeMetrics(rows, 4, 0);
    expect(m.merge.precision.value).toBeCloseTo(0.5); // 1 TP / 2 merged
    expect(m.merge.recall.value).toBeCloseTo(0.5); // 1 / 2 equivalents
    expect(m.merge.false_positive_pairs).toBe(1);
    expect(m.merge.fp_by_label['subset_a_in_b']).toBe(1);
    expect(m.failure_modes['value_grid_mismatch'].merge_fp).toBe(1);
  });

  test('verification FP/FN rates over pairs with candidate rows', () => {
    const rows = [
      evalRow('equivalent', { hasCandidate: true, candidateStatus: 'done' }), // verification TP
      evalRow('related_not_equivalent', {
        hasCandidate: true,
        candidateStatus: 'done',
        failureModes: ['oracle_mismatch'],
      }), // verification FP
      evalRow('equivalent', { hasCandidate: true, candidateStatus: 'failed' }), // verification FN
      evalRow('equivalent', { hasCandidate: false }), // no candidate -> excluded from (c)
    ];
    const m = computeMetrics(rows, 4, 0);
    expect(m.verification.n).toBe(3);
    expect(m.verification.fp_rate.value).toBeCloseTo(0.5); // 1 of 2 done
    expect(m.verification.fn_rate.value).toBeCloseTo(0.5); // 1 of 2 equivalent-with-candidate
    expect(m.verification.confusion['done']['related_not_equivalent']).toBe(1);
    expect(m.failure_modes['oracle_mismatch'].verification_fp).toBe(1);
  });

  test('unresolved labeled rows are excluded from metrics but counted', () => {
    const rows = [
      evalRow('equivalent', { resolved: false }),
      evalRow('equivalent', { sharedQuestions: 1 }),
    ];
    const m = computeMetrics(rows, 2, 0);
    expect(m.counts.unresolved).toBe(1);
    expect(m.counts.evaluated).toBe(1);
    expect(m.merge.recall.value).toBeCloseTo(1);
  });

  test('anchor-grain recall only over records carrying anchors', () => {
    const rows = [
      evalRow('equivalent', { anchorShared: true, sharedQuestions: 1 }),
      evalRow('equivalent', { anchorShared: false, sharedQuestions: 1 }),
      evalRow('equivalent', { anchorShared: null, sharedQuestions: 0 }),
    ];
    const m = computeMetrics(rows, 3, 0);
    expect(m.merge.anchor_grain_recall.numerator).toBe(1);
    expect(m.merge.anchor_grain_recall.denominator).toBe(2);
  });

  test('kappa over doubly-annotated rows', () => {
    const rows = [
      evalRow('equivalent', { annotator2: 'equivalent' }),
      evalRow('unrelated', { annotator2: 'unrelated' }),
      evalRow('equivalent', { annotator2: null }),
    ];
    const m = computeMetrics(rows, 3, 0);
    expect(m.kappa.n).toBe(2);
    expect(m.kappa.kappa).toBe(1);
  });
});

describe('formatRatio', () => {
  test('handles zero denominators', () => {
    expect(formatRatio({ numerator: 0, denominator: 0, value: null })).toContain('n/a');
    expect(formatRatio({ numerator: 1, denominator: 2, value: 0.5 })).toBe('50.0% (1/2)');
  });
});
