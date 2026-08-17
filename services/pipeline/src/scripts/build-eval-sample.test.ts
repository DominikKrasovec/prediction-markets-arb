/**
 * Unit tests for the pure helpers of build-eval-sample.ts.
 * Run: bun test services/pipeline/src/scripts/build-eval-sample.test.ts
 * (No DB access — the script's main() is guarded behind a direct-run check.)
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEED,
  EXTRA_QUOTAS,
  FUNNEL_QUOTAS,
  KAPPA_SUBSET_SIZE,
  canonicalSideOrder,
  kindFamily,
  md5hex,
  pairIdFor,
  pairNaturalKey,
  platformPairLabel,
  roundRobinByFamily,
  totalTodoQuota,
} from './build-eval-sample.js';

describe('kindFamily', () => {
  test('maps fixture kinds into the design families', () => {
    expect(kindFamily('match_winner')).toBe('match_winner');
    expect(kindFamily('halftime_leader')).toBe('match_winner');
    expect(kindFamily('match_total_metric')).toBe('totals');
    expect(kindFamily('both_teams_score')).toBe('totals');
    expect(kindFamily('exact_score')).toBe('totals');
    expect(kindFamily('match_spread')).toBe('spreads');
    expect(kindFamily('player_prop_threshold')).toBe('props');
    expect(kindFamily('championship_winner')).toBe('futures');
    expect(kindFamily('stage_advance')).toBe('futures');
  });
  test('non-sports tail and the null/other bucket', () => {
    expect(kindFamily('election_outcome_winner')).toBe('nonsports');
    expect(kindFamily('candle_direction')).toBe('nonsports');
    expect(kindFamily('weather_extreme')).toBe('nonsports');
    expect(kindFamily(null)).toBe('other');
    expect(kindFamily(undefined)).toBe('other');
    expect(kindFamily('other')).toBe('other');
  });
});

describe('pair identity (natural keys)', () => {
  const a = { platform: 'kalshi', platform_event_id: 'kalshi:event:KXEPL1H-26MAY13MCICRY' };
  const b = { platform: 'polymarket', platform_event_id: '465146' };

  test('canonical side order is platform-lexicographic', () => {
    const [x, y] = canonicalSideOrder(b, a);
    expect(x.platform).toBe('kalshi');
    expect(y.platform).toBe('polymarket');
  });

  test('pair_id is orientation-invariant and md5 of the natural key', () => {
    expect(pairIdFor(a, b)).toBe(pairIdFor(b, a));
    expect(pairIdFor(a, b)).toBe(md5hex(pairNaturalKey(a, b)));
    expect(pairIdFor(a, b)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('same-platform pairs order by platform_event_id', () => {
    const k1 = { platform: 'kalshi', platform_event_id: 'B' };
    const k2 = { platform: 'kalshi', platform_event_id: 'A' };
    const [x] = canonicalSideOrder(k1, k2);
    expect(x.platform_event_id).toBe('A');
  });

  test('platformPairLabel sorts', () => {
    expect(platformPairLabel('polymarket', 'kalshi')).toBe('kalshi|polymarket');
    expect(platformPairLabel('kalshi', 'polymarket')).toBe('kalshi|polymarket');
  });
});

describe('quota plan', () => {
  test('todo quotas sum to 600', () => {
    expect(totalTodoQuota()).toBe(600);
  });
  test('PM×Kalshi is the dominant funnel cell group', () => {
    const pmk = FUNNEL_QUOTAS.filter((c) => c.pair === 'kalshi|polymarket').reduce((s, c) => s + c.target, 0);
    for (const pair of new Set(FUNNEL_QUOTAS.map((c) => c.pair))) {
      if (pair === 'kalshi|polymarket') continue;
      const t = FUNNEL_QUOTAS.filter((c) => c.pair === pair).reduce((s, c) => s + c.target, 0);
      expect(pmk).toBeGreaterThan(t);
    }
  });
  test('Limitless and Predict have forced quotas in every status', () => {
    for (const platform of ['limitless', 'predict']) {
      for (const status of ['done', 'skipped', 'failed'] as const) {
        const t = FUNNEL_QUOTAS.filter((c) => c.pair.includes(platform) && c.status === status).reduce(
          (s, c) => s + c.target,
          0,
        );
        expect(t).toBeGreaterThan(0);
      }
    }
  });
  test('hard-negative strata are present', () => {
    expect(EXTRA_QUOTAS.hardneg_band_candidate).toBeGreaterThan(0);
    expect(EXTRA_QUOTAS.hardneg_band_never_candidate).toBeGreaterThan(0);
    expect(EXTRA_QUOTAS.same_day_league_never_candidate).toBeGreaterThan(0);
    expect(KAPPA_SUBSET_SIZE).toBe(150);
  });
});

describe('roundRobinByFamily', () => {
  interface Row {
    id: string;
    family: string;
  }
  const rows: Row[] = [
    { id: 'a1', family: 'A' },
    { id: 'a2', family: 'A' },
    { id: 'a3', family: 'A' },
    { id: 'b1', family: 'B' },
    { id: 'b2', family: 'B' },
    { id: 'c1', family: 'C' },
  ];
  const pick = (quota: number) =>
    roundRobinByFamily(
      rows,
      (r) => r.family,
      (r) => r.id,
      quota,
    );

  test('spreads across families before going deep into one', () => {
    const picked = pick(3);
    expect(picked.map((r) => r.family).sort()).toEqual(['A', 'B', 'C']);
  });

  test('exhausts thin families then keeps filling from the rest', () => {
    const picked = pick(6);
    expect(picked).toHaveLength(6);
    expect(picked.filter((r) => r.family === 'A')).toHaveLength(3);
  });

  test('quota larger than pool returns the whole pool (shortfall reported by caller)', () => {
    expect(pick(50)).toHaveLength(6);
  });

  test('deterministic for a fixed input', () => {
    expect(pick(4).map((r) => r.id)).toEqual(pick(4).map((r) => r.id));
    // round 1 takes the md5-least of each family in family order
    expect(pick(4).map((r) => r.id)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
});

describe('determinism of the seeded order key', () => {
  test('md5hex is stable and seed-sensitive', () => {
    const key = 'kalshi:x||polymarket:y';
    expect(md5hex(`${DEFAULT_SEED}|${key}`)).toBe(md5hex(`${DEFAULT_SEED}|${key}`));
    expect(md5hex(`${DEFAULT_SEED}|${key}`)).not.toBe(md5hex(`other-seed|${key}`));
  });
});
