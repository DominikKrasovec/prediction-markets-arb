/**
 * Pure unit tests for the M-SYNC-1 primary member-markets stamp.
 *
 * classifyThresholdSeriesFromShapes() is DB-backed (no extractable decision logic), so we
 * pin the load-bearing invariants of the stamp SQL statically — NO database, NO mutation.
 * The behavioural proof (5,552 members would flip; 507 threshold_series events would
 * otherwise revert via the populatePlatformEvents MIN()-aggregate) lives in the read-only
 * dry-run COUNTs in the fix report.
 */
import { test, expect } from 'bun:test';
import {
  MEMBER_STAMP_THRESHOLD_SQL,
  PROMOTE_THRESHOLD_SERIES_SQL,
  PROMOTE_DESTINATION_CATEGORICAL_SQL,
  MEMBER_STAMP_CATEGORICAL_SQL,
  PROMOTE_SHAPED_BUNDLE_SQL,
  MEMBER_STAMP_BUNDLE_SQL,
} from './classify-grouping.js';

test('AUD-03: threshold promotion requires single-direction (dir_ab=1) + no non-ladder rung (non_ladder=0)', () => {
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain('agg.dir_ab = 1');
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain('agg.non_ladder = 0');
  // non_ladder counts between/at/NULL-dir and NULL-value rungs
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain("dir NOT IN ('above','below')");
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain('dir IS NULL OR val IS NULL');
});

test('AUD-58: n>=2 admits a 2-rung subject ladder; skeleton-only arm stays n>=3', () => {
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain('agg.n >= 2');
  expect(PROMOTE_THRESHOLD_SERIES_SQL).toContain('(agg.subjects = 1 OR (agg.skeletons = 1 AND agg.n >= 3))');
});

test('AUD-07: destination categorical promotion is scoped, boolean, value-free, multi-yes_sub_title', () => {
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain("SET grouping_type = 'categorical_exclusive'");
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain("shape = 'categorical_outcome'");
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain("metric = 'boolean'");
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain('agg.val_present = 0');
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain('agg.distinct_yst = agg.n');
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain('agg.subjects = 1');
  // never overrides a native verdict / non-Kalshi
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain("pe.grouping_type = 'unknown'");
  expect(PROMOTE_DESTINATION_CATEGORICAL_SQL).toContain("pe.platform = 'kalshi'");
});

test('AUD-07: destination member-stamp mirrors the threshold stamp (idempotent categorical_exclusive)', () => {
  expect(MEMBER_STAMP_CATEGORICAL_SQL).toContain('UPDATE markets m');
  expect(MEMBER_STAMP_CATEGORICAL_SQL).toContain("grouping_type = 'categorical_exclusive'");
  expect(MEMBER_STAMP_CATEGORICAL_SQL).toContain("IS DISTINCT FROM 'categorical_exclusive'");
});

test('member-stamp SQL targets markets.grouping_type = threshold_series', () => {
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('UPDATE markets m');
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain("grouping_type = 'threshold_series'");
});

test('member-stamp SQL joins on (platform, platform_event_id) from the promoted set', () => {
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('m.platform = v.platform');
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('m.platform_event_id = v.peid');
  // both bind params are consumed (platform[] and platform_event_id[])
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('$1::text[]');
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('$2::text[]');
});

test('member-stamp SQL is idempotent (IS DISTINCT FROM guard)', () => {
  // re-running on already-stamped members updates 0 rows.
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain("m.grouping_type IS DISTINCT FROM 'threshold_series'");
});

test('member-stamp SQL never widens beyond the promoted events (no bare UPDATE)', () => {
  // must be scoped by the v(platform,peid) tuple — never an unguarded table-wide UPDATE.
  expect(MEMBER_STAMP_THRESHOLD_SQL).toContain('FROM (SELECT unnest');
  expect(MEMBER_STAMP_THRESHOLD_SQL).not.toContain('WHERE TRUE');
});

// ── P-GROUP (spec §3.7 case c2) shaped-bundle reclassifier ────────────────────

test('P-GROUP c2: shaped-bundle promotion is scoped to unknown, all-shaped, ≥2 children', () => {
  // never overrides a native/threshold/destination verdict; requires proof of shape.
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain("pe.grouping_type = 'unknown'");
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain("SET grouping_type = 'bundle_nonexclusive'");
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain('agg.n >= 2');
  // "mixed → unknown": an unshaped child leaves the event unknown (shaped = n gate).
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain('agg.shaped = agg.n');
});

test('P-GROUP c2a/c2b: bundle iff kind-heterogeneous OR kind-homog co-occurrable', () => {
  // (c2a) ≥2 kinds → can never be one mutex; (c2b) exactly one kind, all in the
  // co-occurrable allowlist (bad_kinds=0). A kind-homog NON-co-occurrable event
  // (bad_kinds>0, a possible winner-mutex) is NOT bundled → stays unknown.
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain('agg.kinds >= 2 OR (agg.kinds = 1 AND agg.bad_kinds = 0)');
  // player-prop bundle → bundle: player_prop_threshold must be in the allowlist ($1).
  expect(PROMOTE_SHAPED_BUNDLE_SQL).toContain('kind <> ALL($1::text[])');
});

test('P-GROUP c2: member-stamp mirrors the threshold stamp (idempotent bundle_nonexclusive)', () => {
  expect(MEMBER_STAMP_BUNDLE_SQL).toContain('UPDATE markets m');
  expect(MEMBER_STAMP_BUNDLE_SQL).toContain("grouping_type = 'bundle_nonexclusive'");
  expect(MEMBER_STAMP_BUNDLE_SQL).toContain("IS DISTINCT FROM 'bundle_nonexclusive'");
  expect(MEMBER_STAMP_BUNDLE_SQL).toContain('FROM (SELECT unnest');
  expect(MEMBER_STAMP_BUNDLE_SQL).not.toContain('WHERE TRUE');
});
