import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildMediaReleaseLadderEdgesSql,
  mediaReleaseRungsCtesSql,
  mediaTitleClassSql,
  classifyMediaReleaseTitle,
  mediaLadderImplies,
  MEDIA_LADDER_SHAPES_SQL,
} from './media-release-ladder.js';

const sql = buildMediaReleaseLadderEdgesSql();

// ── pure-TS reference: the LOAD-BEARING title-class belt ──────────────────────

test('classifies the four deterministic title classes', () => {
  expect(classifyMediaReleaseTitle('Will Iceman have at least 90,000 Pure Album Sales on the chart dated June 7?')).toBe('pure');
  expect(classifyMediaReleaseTitle("Will It's Been Awful have at least 50,000 Album Equivalent Units?")).toBe('equivalent');
  expect(classifyMediaReleaseTitle('Will the album have at least 100,000,000 Streams this week?')).toBe('streams');
  expect(classifyMediaReleaseTitle('Will the movie score at least 80% on Rotten Tomatoes?')).toBe('rt_score');
});

test('NEGATIVE: unclassifiable titles refuse (doubt → no edge)', () => {
  // the live 'other' family — quantity definition unknown, fully co-set covered
  expect(classifyMediaReleaseTitle('Will Dinner Party have at least 100,000 Activity (Combined Sales) on the chart?')).toBeNull();
  expect(classifyMediaReleaseTitle('Will the album chart at #1?')).toBeNull();
  expect(classifyMediaReleaseTitle(null)).toBeNull();
  expect(classifyMediaReleaseTitle('')).toBeNull();
});

test('NEGATIVE: a multi-class title is ambiguous → refused (forward belt, 0 live)', () => {
  expect(classifyMediaReleaseTitle('Will X have 50,000 Album Equivalent Units including Streams?')).toBeNull();
  expect(classifyMediaReleaseTitle('Pure Album Sales vs Album Equivalent Units?')).toBeNull();
});

test('THE G3 COUNTEREXAMPLE PINNED: pure and equivalent are DIFFERENT classes', () => {
  // Stage 1 stamps metric='count', unit='units' for BOTH — only this belt
  // separates them. equivalent ≥ pure by definition, so fusing them is fake arb.
  const pure = classifyMediaReleaseTitle('Will Iceman have at least 90,000 Pure Album Sales?');
  const equiv = classifyMediaReleaseTitle('Will Iceman have at least 50,000 Album Equivalent Units?');
  expect(pure).toBe('pure');
  expect(equiv).toBe('equivalent');
  expect(pure).not.toBe(equiv);
  // and the orientation function refuses the cross-class pair in BOTH orders
  expect(mediaLadderImplies('above', pure, equiv, 90000, 50000)).toBe(false);
  expect(mediaLadderImplies('above', equiv, pure, 90000, 50000)).toBe(false);
});

// ── pure-TS reference: chain orientation ──────────────────────────────────────

test('above: the HIGHER threshold is the antecedent, same class only', () => {
  expect(mediaLadderImplies('above', 'rt_score', 'rt_score', 90, 80)).toBe(true);
  // NEGATIVE: reversed orientation is a fabricated arbitrage
  expect(mediaLadderImplies('above', 'rt_score', 'rt_score', 80, 90)).toBe(false);
});

test('below: the LOWER threshold is the antecedent (forward mirror, 0 live)', () => {
  expect(mediaLadderImplies('below', 'rt_score', 'rt_score', 60, 80)).toBe(true);
  expect(mediaLadderImplies('below', 'rt_score', 'rt_score', 80, 60)).toBe(false);
});

test('NEGATIVE: equal thresholds / null classes / odd directions never ladder', () => {
  expect(mediaLadderImplies('above', 'pure', 'pure', 50000, 50000)).toBe(false);
  expect(mediaLadderImplies('above', null, 'pure', 90000, 50000)).toBe(false);
  expect(mediaLadderImplies('above', 'pure', null, 90000, 50000)).toBe(false);
  expect(mediaLadderImplies('between', 'pure', 'pure', 90000, 50000)).toBe(false);
  expect(mediaLadderImplies(null, 'pure', 'pure', 90000, 50000)).toBe(false);
  expect(mediaLadderImplies('above', 'pure', 'pure', null, 50000)).toBe(false);
});

// ── SQL shape ─────────────────────────────────────────────────────────────────

test('writes a strict_implication / media_release_ladder edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'media_release_ladder'"); // exact label (CHECK constraint)
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('population gate: media_release + half-line shapes + valued rungs + live questions', () => {
  expect(sql).toContain("n.event_kind = 'media_release'");
  expect(MEDIA_LADDER_SHAPES_SQL).toBe(`('monotonic_threshold','point_in_time')`);
  expect(sql).toContain(`n.condition_shape IN ('monotonic_threshold','point_in_time')`);
  expect(sql).toContain('n.value_secondary IS NULL');
  expect(sql).toContain('n.value_primary IS NOT NULL');
  expect(sql).toContain("n.condition_direction IN ('above','below')");
  expect(sql).toContain('q.archived_at IS NULL');
});

test('THE BELT IN SQL: same-class join conjunct + member-grain class column', () => {
  // cross-class admission must be impossible: the chain join REQUIRES b.cls = a.cls
  expect(sql).toContain('b.cls        = a.cls');
  // the class is computed per MEMBER title and is part of the family partition
  expect(sql).toContain("lower(m.title) ~ 'pure album sales'");
  expect(sql).toContain("lower(m.title) ~ 'album equivalent'");
  expect(sql).toContain("lower(m.title) ~ 'streams'");
  expect(sql).toContain("lower(m.title) ~ 'rotten tomatoes'");
  expect(sql).toContain('PARTITION BY ev_key, subj_key, d, dir, unit_key, metric_key, cls');
});

test('THE BELT IN SQL: multi-class titles classify NULL (exactly-one-match CASE)', () => {
  const cls = mediaTitleClassSql('m.title');
  expect(cls).toContain('<> 1 THEN NULL');
  expect(sql).toContain('<> 1 THEN NULL');
});

test('THE BELT IN SQL: unclassifiable members poison the whole question', () => {
  expect(sql).toContain('bool_or(cls IS NULL)');
  expect(sql).toContain('question_id NOT IN (SELECT question_id FROM bad_questions)');
});

test('family key carries the full same-reading tuple (event+subject+date+dir+unit+metric+class)', () => {
  for (const k of ['ev_key', 'subj_key', 'd', 'dir', 'unit_key', 'metric_key', 'cls']) {
    expect(sql).toContain(`b.${k}`);
  }
});

test('over-merge disqualifier: any member disagreement on the reading tuple drops the question', () => {
  expect(sql).toContain('bad_questions');
  expect(sql).toContain('count(DISTINCT (ev_key, subj_key, d, dir, unit_key, metric_key, line, cls)) > 1');
});

test('CHAIN not closure: adjacent dense_rank step only, strictest rung first', () => {
  expect(sql).toContain('dense_rank()');
  expect(sql).toContain('b.rk = a.rk + 1');
  expect(sql).toContain("CASE WHEN dir = 'above' THEN -line ELSE line END");
  // NEGATIVE: no closure join anywhere
  expect(sql).not.toContain('b.rk > a.rk');
});

test('cross-set residue only: explicit NOT-in-same-outcome-set conjunct (G1 doctrine)', () => {
  expect(sql).toContain('outcome_set_slots s1');
  expect(sql).toContain('s1.set_id = s2.set_id');
  expect(sql).toContain('NOT EXISTS');
});

test('NEGATIVE: equal lines never chain (belt on top of the rank step)', () => {
  expect(sql).toContain('b.line <> a.line');
  expect(sql).toContain('b.question_id <> a.question_id');
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('rungs CTE pipeline is exported for the read-only dry-run probe', () => {
  const ctes = mediaReleaseRungsCtesSql();
  expect(ctes).toContain('chain_pairs AS');
  expect(sql).toContain(ctes);
});
