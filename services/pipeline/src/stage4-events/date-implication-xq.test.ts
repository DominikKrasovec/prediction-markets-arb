import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildDateImplicationXqEdgesSql,
  dateImplicationKindGateSql,
  DATE_IMPLICATION_DEBUT_EVENT_SUFFIX,
  DATE_IMPLICATION_KINDS_SQL,
  DATE_IMPLICATION_REFUSED_KINDS_SQL,
  dateImplicationSnapshotRefusalSql,
} from './date-implication-xq.js';

const sql = buildDateImplicationXqEdgesSql();

test('writes a strict_implication / date_implication edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'date_implication'");
  expect(sql).toContain("'algorithmic'");
  // confidence=1.0 + deterministic TRUE so the solver hard-prunes the edge
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('gates on the conservative terminal-once-true allowlist (token_launch bare)', () => {
  expect(DATE_IMPLICATION_KINDS_SQL).toBe(`('token_launch')`);
  expect(sql).toContain('a.event_kind IN ' + DATE_IMPLICATION_KINDS_SQL);
  // 'participation' is admitted only via the debut-date anchor (see next test);
  // the same event_kind also covers non-terminal cases the bare allowlist must exclude.
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('personnel_move');
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('participation');
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('governing_coalition');
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('price_threshold');
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('crypto_launch_fdv');
  expect(DATE_IMPLICATION_KINDS_SQL).not.toContain('stage_advance');
});

test('participation is admitted ONLY via the ": debut date" canonical_event anchor (F4)', () => {
  // The discriminator matches folded text (lower/unaccent/btrim), end-anchored
  // (LIKE with no trailing %): "<Player>: Debut Date" passes but
  // "<Player>: Next Game Played" (same event_kind and temporal_semantics) does not.
  expect(DATE_IMPLICATION_DEBUT_EVENT_SUFFIX).toBe(': debut date');
  const gate = dateImplicationKindGateSql('a');
  expect(gate).toContain(`a.event_kind IN ${DATE_IMPLICATION_KINDS_SQL}`);
  expect(gate).toContain(`a.event_kind = 'participation'`);
  expect(gate).toContain(
    `lower(immutable_unaccent(btrim(a.canonical_event))) LIKE '%: debut date'`,
  );
  expect(sql).toContain(gate);
  expect(sql).not.toContain(`IN ('token_launch','participation')`);
  expect(sql).not.toContain(`IN ('participation')`);
  expect(gate.toLowerCase()).not.toContain('next game');
});

test('requires by-date cumulative temporal semantics on BOTH sides', () => {
  // Requires temporal_semantics='by_date' on both joined questions.
  expect(sql).toContain("qa.temporal_semantics = 'by_date'");
  expect(sql).toContain("qb.temporal_semantics = 'by_date'");
});

test('orients on the per-QUESTION deadline (questions.condition_date), NOT the node_facts pe date', () => {
  // Orders on the per-question deadline (questions.condition_date), not the
  // shared node_facts platform_event date, at the coarser projected grain
  // (condition_date_precision via util/date-grain-sql): a raw ::timestamptz
  // compare on the padded text would misorder a year-precision placeholder
  // date against a real finer-grain date.
  expect(sql).toContain("left(qa.condition_date, CASE GREATEST(CASE qa.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END");
  expect(sql).toMatch(/<\s*left\(qb\.condition_date, CASE GREATEST\(CASE qa\.condition_date_precision/);
  expect(sql).not.toContain('qa.condition_date::timestamptz < qb.condition_date::timestamptz');
  expect(sql).not.toContain('a.condition_date::timestamptz < b.condition_date::timestamptz');
  // Omits the same-event gate: this rule relates different dates.
  expect(sql).not.toContain('game_ordinal');
});

test('same-target / same-subject join with the hashable canonical_event equality', () => {
  expect(sql).toContain(
    'lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))',
  );
  expect(sql).toContain('a.event_kind = b.event_kind');
  expect(sql).toContain('a.canonical_subject IS NOT DISTINCT FROM b.canonical_subject');
  expect(sql).toContain('a.condition_metric  IS NOT DISTINCT FROM b.condition_metric');
  expect(sql).toContain('a.value_primary     IS NOT DISTINCT FROM b.value_primary');
  expect(sql).toContain('a.value_unit        IS NOT DISTINCT FROM b.value_unit');
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(
    EDGE_CONFLICT_SQL,
  );
});

// Snapshot / daily-observation kinds are refused: a daily observation is a
// fresh draw each day, so only cumulative, terminal-once-true kinds may chain.
test('P5: daily-observation kinds are explicitly REFUSED (negative list survives allowlist growth)', () => {
  for (const k of ['weather_observation', 'weather_threshold', 'candle_direction', 'price_snapshot']) {
    expect(DATE_IMPLICATION_REFUSED_KINDS_SQL).toContain(`'${k}'`);
  }
  // The kind gate ANDs the negative list onto the positive allowlist.
  const gate = dateImplicationKindGateSql('a');
  expect(gate).toContain(DATE_IMPLICATION_KINDS_SQL);
  expect(gate).toContain(DATE_IMPLICATION_REFUSED_KINDS_SQL);
  expect(gate.replace(/\s+/g, ' ')).toContain('a.event_kind IS NULL OR a.event_kind NOT IN');
  expect(sql).toContain(DATE_IMPLICATION_REFUSED_KINDS_SQL);
});

test('P5: a SNAPSHOT condition_shape is refused on BOTH sides (shape does not propagate)', () => {
  // Kind equality in the join propagates the kind gate from a to b, but
  // condition_shape does not, so the shape conjunct is applied on both sides.
  expect(sql).toContain(dateImplicationSnapshotRefusalSql('a'));
  expect(sql).toContain(dateImplicationSnapshotRefusalSql('b'));
  // NULL-tolerant: an unshaped row is not evidence of a snapshot.
  expect(dateImplicationSnapshotRefusalSql('a')).toContain('a.condition_shape IS NULL');
});
