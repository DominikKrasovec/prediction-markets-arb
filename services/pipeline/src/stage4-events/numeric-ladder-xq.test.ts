/**
 * Shape test for numeric-ladder-xq.ts — asserts the load-bearing guards are
 * present in the generated SQL (no DB; pure string assertions).
 */
import { describe, test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildNumericLadderXqEdgesSql,
  crossEventInstantRefusalSql,
  isCrossEventInstant,
  CROSS_EVENT_GAP_MS,
  undatedGameScopedLadderRefusalSql,
  isUndatedGameScopedLadder,
} from './numeric-ladder-xq.js';

const sql = buildNumericLadderXqEdgesSql();

describe('buildNumericLadderXqEdgesSql', () => {
  test('writes the correct edge_type + pattern label', () => {
    expect(sql).toContain("'strict_implication'");
    expect(sql).toContain("'numeric_ladder_xq'");
  });

  test('is a deterministic algorithmic edge at confidence 1.0', () => {
    // deterministic TRUE + source algorithmic + confidence 1.0 (solver hard-prune contract)
    expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
  });

  test('gates on same-event via sameEventFragment (game_ordinal markers)', () => {
    expect(sql).toContain('game_ordinal');
    expect(sql).toContain('platform_event_id');
  });

  test('enforces same metric / unit / direction', () => {
    expect(sql).toContain('a.condition_metric IS NOT DISTINCT FROM b.condition_metric');
    expect(sql).toContain('a.value_unit       IS NOT DISTINCT FROM b.value_unit');
    expect(sql).toContain('a.condition_direction = b.condition_direction');
  });

  test('requires BOTH legs to share one shape — touch never ladders onto snapshot (audit §6 S3)', () => {
    // Without this conjunct a mixed pair emits touch(K_hi) ⟹ snapshot(K_lo):
    // "reach 200k by D" would falsely imply "above 100k at close on D"
    // (spike intraday, close below). Same-shape is load-bearing.
    expect(sql).toContain('a.condition_shape = b.condition_shape');
  });

  test('restricts to half-line shapes and EXCLUDES between/range_snapshot', () => {
    expect(sql).toContain("'monotonic_threshold','point_in_time'");
    // The condition_shape allowlist must NOT admit interior-bucket shapes
    // (range_snapshot / between). Check the value tokens are not present as
    // quoted SQL literals (comments mentioning them are fine).
    expect(sql).not.toContain("'range_snapshot'");
    expect(sql).not.toContain("'between'");
  });

  test('is NULL-rejecting on value_primary', () => {
    expect(sql).toContain('a.value_primary IS NOT NULL');
    expect(sql).toContain('b.value_primary IS NOT NULL');
  });

  test('applies the single-quantity kind allowlist (no sports / social_media_metric)', () => {
    expect(sql).toContain('a.event_kind = b.event_kind');
    expect(sql).toContain(
      "('price_threshold','crypto_launch_fdv','weather_extreme','election_turnout','approval_rating','player_prop_threshold')",
    );
    // EXCLUDE per-fixture sports + social_media_metric from the ALLOWLIST. The
    // allowlist is the only place an event_kind value gates the rule (admits the
    // pair). social_media_metric must not appear anywhere; match_winner may only
    // appear inside the imported sameEventFragment decisive-REFUSAL tuple (a
    // refusal, not an admission), never in the admit allowlist below.
    expect(sql).not.toContain("'social_media_metric'");
    const allowlist =
      "('price_threshold','crypto_launch_fdv','weather_extreme','election_turnout','approval_rating','player_prop_threshold')";
    expect(allowlist).not.toContain('match_winner');
    expect(allowlist).not.toContain('social_media_metric');
  });

  test('admits player_prop_threshold (R9) but NOT election_margin (deferred)', () => {
    // player props are single terminal scalars per (player, metric, event)
    // and ladder cleanly, so they are in the admit allowlist.
    expect(sql).toContain("'player_prop_threshold'");
    // election_margin must NOT be admitted — its orienting PARTY lives in the title,
    // not a gated field, so laddering by subject alone would fuse opposite-party
    // margins. Deferred pending an upstream party-in-gated-field fix.
    expect(sql).not.toContain("'election_margin'");
  });

  test('M-RECALL-2: the season-wins ladder kind (player_prop_threshold) is in LADDER_KINDS', () => {
    // The new Kalshi season-wins handler (trySeasonWins) emits
    // event_kind='player_prop_threshold' precisely BECAUSE that kind is already
    // admitted here -- so the within-team win>=N ladder edge actually fires. If this
    // kind were ever removed from the allowlist the season-wins recall silently dies.
    expect(sql).toContain("'player_prop_threshold'");
  });

  test('gates on canonical_subject equality (same player)', () => {
    // Without the subject gate two DIFFERENT players sharing metric/unit/event-name
    // could falsely ladder. NULL-tolerant so the non-player kinds are unaffected.
    expect(sql).toContain('a.canonical_subject IS NOT DISTINCT FROM b.canonical_subject');
  });

  test('orients antecedent = stricter threshold (above:>, below:<)', () => {
    expect(sql).toContain("a.condition_direction = 'above' AND a.value_primary > b.value_primary");
    expect(sql).toContain("a.condition_direction = 'below' AND a.value_primary < b.value_primary");
  });

  test('dedupes via ON CONFLICT first-writer-wins', () => {
    expect(sql).toContain(
      EDGE_CONFLICT_SQL,
    );
  });

  test('hashable canonical_event equality is in the JOIN ON (perf)', () => {
    expect(sql).toContain(
      'lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))',
    );
  });

  // Cross-project crypto-FDV identity is gated at Stage 3 (guards.ts
  // cross-subject backstop), so this rule must never re-derive project
  // identity from the raw title.
  test('does NOT re-derive project identity from the raw title (no FDV regex hotfix)', () => {
    expect(sql).not.toContain('FDV');
    expect(sql).not.toContain('substring(a.title');
  });

  // metric_scope gate: a no-op today (LADDER_KINDS excludes the scope-bearing
  // sports totals) but kept so a future sports-total allowlist can't ladder a
  // team-total against a game-total. NULL-tolerant both-known-and-differ.
  test('metric_scope gate: NULL-tolerant both-known-and-differ (future-proofing)', () => {
    expect(sql).toContain(
      'NOT (a.metric_scope IS NOT NULL AND b.metric_scope IS NOT NULL AND a.metric_scope IS DISTINCT FROM b.metric_scope)',
    );
    expect(sql).not.toContain('a.metric_scope IS NOT DISTINCT FROM b.metric_scope');
  });

  test('G1: refuses PROVEN cross-event pairs (both fine instants ≥20h apart)', () => {
    // the gate is wired into the JOIN as NOT (...) so it removes the pair
    expect(sql).toContain(`AND NOT ${crossEventInstantRefusalSql('a', 'b')}`);
    // 20h floor in seconds
    expect(sql).toContain('>= 72000');
    // only fine (minute/hour) instants trigger it; padded day/month/year never do
    expect(sql).toContain("a.condition_date_precision IN ('minute','hour')");
    expect(sql).toContain("b.condition_date_precision IN ('minute','hour')");
    expect(CROSS_EVENT_GAP_MS).toBe(20 * 60 * 60 * 1000);
  });
});

describe('isCrossEventInstant (G1 TS mirror)', () => {
  const d = (iso: string) => new Date(iso);

  test('REFUSED: Arozarena 4.5 HRs @07-21T04:40Z vs 0.5 HRs @07-22T04:40Z (different games, 24h apart)', () => {
    expect(isCrossEventInstant(d('2026-07-21T04:40:00Z'), 'minute', d('2026-07-22T04:40:00Z'), 'minute')).toBe(true);
  });

  test('REFUSED: season-total @10-03 vs single-game @07-21 (~74d apart)', () => {
    expect(isCrossEventInstant(d('2026-10-03T00:00:00Z'), 'minute', d('2026-07-21T23:00:00Z'), 'minute')).toBe(true);
  });

  test('KEPT: same-instant crypto/player ladder (shared deadline, |Δ|=0)', () => {
    const t = d('2026-12-31T23:59:00Z');
    expect(isCrossEventInstant(t, 'minute', t, 'minute')).toBe(false);
  });

  test('KEPT: UTC-rollover artifact tail (<20h apart) is NOT refused (conservative)', () => {
    // an evening game whose Kalshi minute stamp rolls ~6h past a PM day stamp
    expect(isCrossEventInstant(d('2026-07-18T02:00:00Z'), 'minute', d('2026-07-17T23:00:00Z'), 'minute')).toBe(false);
  });

  test('KEPT: a padded day/month/year deadline on either side never triggers the gate', () => {
    expect(isCrossEventInstant(d('2026-07-21T00:00:00Z'), 'day', d('2026-10-03T00:00:00Z'), 'minute')).toBe(false);
    expect(isCrossEventInstant(d('2026-07-21T00:00:00Z'), 'minute', d('2026-10-03T00:00:00Z'), 'month')).toBe(false);
    expect(isCrossEventInstant(null, 'minute', d('2026-10-03T00:00:00Z'), 'minute')).toBe(false);
  });
});

describe('undatedGameScopedLadderRefusalSql / isUndatedGameScopedLadder (G1 addendum)', () => {
  const d = (iso: string) => new Date(iso);

  test('the game-scoped undated gate is wired into the JOIN as NOT (...)', () => {
    expect(sql).toContain(`AND NOT ${undatedGameScopedLadderRefusalSql('a', 'b')}`);
    // only the per-game kind is gated (deadline/by-date kinds keep coarse dates)
    expect(sql).toContain("a.event_kind IN ('player_prop_threshold')");
  });

  test('REFUSED: a NULL-date player-prop pair (pre-Stage-2a-stamp escape hatch)', () => {
    expect(isUndatedGameScopedLadder('player_prop_threshold', null, null, null, null)).toBe(true);
    expect(isUndatedGameScopedLadder('player_prop_threshold', d('2026-07-21T04:40:00Z'), 'minute', null, null)).toBe(true);
  });

  test('REFUSED: a coarse (year/month) game-scoped instant on either side', () => {
    expect(isUndatedGameScopedLadder('player_prop_threshold', d('2026-01-01T00:00:00Z'), 'year', d('2026-07-21T04:40:00Z'), 'minute')).toBe(true);
  });

  test('KEPT: the same player-prop pair once BOTH minute instants land (builds next cycle)', () => {
    const t = d('2026-07-21T04:40:00Z');
    expect(isUndatedGameScopedLadder('player_prop_threshold', t, 'minute', t, 'minute')).toBe(false);
  });

  test('KEPT: a by-date DEADLINE kind with month precision still builds (deadline ladders unaffected)', () => {
    expect(isUndatedGameScopedLadder('price_threshold', d('2026-12-01T00:00:00Z'), 'month', d('2026-12-01T00:00:00Z'), 'month')).toBe(false);
    expect(isUndatedGameScopedLadder('election_turnout', null, null, null, null)).toBe(false);
  });
});
