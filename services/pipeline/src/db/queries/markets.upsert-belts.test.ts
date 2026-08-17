/**
 * bulkUpsertMarkets / upsertMarket precedence belts.
 *
 * Three structural columns get sync-time values that can be strictly poorer
 * than the stored post-sync verdict:
 *   - grouping_type: sync emits the sentinel 'unknown' for all kalshi and
 *     most PM/Predict rows; Stage-2a MEMBER_STAMP / classifyKalshiEvents
 *     write the real verdict.
 *   - resolution_scope: detectResolutionScope bottoms out at 'unspecified';
 *     the structural arm / Stage-1h backfill write 'regulation' on
 *     text-silent rows.
 *   - category_unified: sync-time classification is title-only for
 *     kalshi/PM; enrichment + Stage-1b LLM are richer.
 *
 * A plain `COALESCE(EXCLUDED.x, markets.x)` would let every re-sync reset
 * those verdicts back to the sentinel. These tests pin the replacement
 * expressions — sentinelFillInSql / enrichedWinsSql — via a read-only
 * truth-table query, evaluating the exact generated SQL with
 * `markets.<col>` / `EXCLUDED.<col>` rewritten to CTE columns.
 *
 * Each belt is pinned on three semantics: richer-kept (stored specific +
 * incoming sentinel/NULL -> stored), new-value-wins (incoming specific ->
 * incoming), null-never-overwrites (incoming NULL -> stored), plus the
 * fill-in case (stored NULL -> incoming, even a sentinel) and the
 * changed-guard invariant (post-precedence value equals stored on belted
 * rows, so they don't churn the change counter).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { query, endPool } from '@arb/db';
import { sentinelFillInSql, enrichedWinsSql } from './markets.js';

afterAll(async () => {
  await endPool();
});

/** Rewrite the production fragment so it can run outside ON CONFLICT. */
function asSelectable(fragment: string, col: string): string {
  return fragment
    .replaceAll(`EXCLUDED.${col}`, 't.incoming')
    .replaceAll(`markets.${col}`, 't.stored');
}

/** Evaluate the fragment for one (stored, incoming) pair — read-only. */
async function evalFragment(
  fragment: string,
  col: string,
  stored: string | null,
  incoming: string | null,
): Promise<string | null> {
  const rows = await query<{ result: string | null }>(
    `WITH t(stored, incoming) AS (VALUES ($1::text, $2::text))
     SELECT ${asSelectable(fragment, col)} AS result FROM t`,
    [stored, incoming],
  );
  return rows[0].result;
}

describe('sentinelFillInSql — grouping_type belt (#11)', () => {
  const frag = sentinelFillInSql('grouping_type', 'unknown');

  test('richer-kept: sentinel never downgrades a classified verdict', async () => {
    expect(await evalFragment(frag, 'grouping_type', 'threshold_series', 'unknown')).toBe('threshold_series');
    expect(await evalFragment(frag, 'grouping_type', 'categorical_exclusive', 'unknown')).toBe('categorical_exclusive');
    expect(await evalFragment(frag, 'grouping_type', 'bundle_nonexclusive', 'unknown')).toBe('bundle_nonexclusive');
  });

  test('new-value-wins: a specific incoming verdict overwrites (native structure is authoritative)', async () => {
    expect(await evalFragment(frag, 'grouping_type', 'unknown', 'categorical_exclusive')).toBe('categorical_exclusive');
    expect(await evalFragment(frag, 'grouping_type', 'threshold_series', 'categorical_exclusive')).toBe('categorical_exclusive');
  });

  test('null-never-overwrites: incoming NULL keeps the stored verdict', async () => {
    expect(await evalFragment(frag, 'grouping_type', 'categorical_exclusive', null)).toBe('categorical_exclusive');
    expect(await evalFragment(frag, 'grouping_type', 'unknown', null)).toBe('unknown');
  });

  test('fill-in: a sentinel may still fill a NULL column (first sync)', async () => {
    expect(await evalFragment(frag, 'grouping_type', null, 'unknown')).toBe('unknown');
    expect(await evalFragment(frag, 'grouping_type', null, null)).toBeNull();
  });
});

describe('sentinelFillInSql — resolution_scope belt (#10)', () => {
  const frag = sentinelFillInSql('resolution_scope', 'unspecified');

  test("richer-kept: 'unspecified' never overwrites a specific scope (structural-arm stamps stop oscillating)", async () => {
    expect(await evalFragment(frag, 'resolution_scope', 'regulation', 'unspecified')).toBe('regulation');
    expect(await evalFragment(frag, 'resolution_scope', 'incl_overtime', 'unspecified')).toBe('incl_overtime');
    expect(await evalFragment(frag, 'resolution_scope', 'aggregate', 'unspecified')).toBe('aggregate');
  });

  test('new-value-wins: explicit text evidence overwrites (detector-version heal path)', async () => {
    expect(await evalFragment(frag, 'resolution_scope', 'incl_overtime', 'regulation')).toBe('regulation');
    expect(await evalFragment(frag, 'resolution_scope', 'unspecified', 'regulation')).toBe('regulation');
  });

  test('null-never-overwrites: incoming NULL keeps the stored scope', async () => {
    expect(await evalFragment(frag, 'resolution_scope', 'regulation', null)).toBe('regulation');
  });

  test("fill-in: 'unspecified' may fill a NULL column (Stage-1h convergence keeps holding)", async () => {
    expect(await evalFragment(frag, 'resolution_scope', null, 'unspecified')).toBe('unspecified');
  });
});

describe('enrichedWinsSql — category_unified belt (#9)', () => {
  const frag = enrichedWinsSql('category_unified');

  test('richer-kept: a stored (enriched/LLM) label survives a title-only re-sync', async () => {
    // Each pair is a real category flip a title-only re-classification can
    // produce, differing from the richer stored label at a different fee tier.
    expect(await evalFragment(frag, 'category_unified', 'economic', 'geopolitical')).toBe('economic');
    expect(await evalFragment(frag, 'category_unified', 'politics', 'geopolitical')).toBe('politics');
    expect(await evalFragment(frag, 'category_unified', 'crypto', 'technology')).toBe('crypto');
  });

  test('new-value-wins ONLY on fill-in: sync classification lands on still-NULL rows', async () => {
    expect(await evalFragment(frag, 'category_unified', null, 'sports')).toBe('sports');
  });

  test('null-never-overwrites: an unclassifiable title keeps the stored label', async () => {
    expect(await evalFragment(frag, 'category_unified', 'sports', null)).toBe('sports');
    expect(await evalFragment(frag, 'category_unified', null, null)).toBeNull();
  });
});

describe('changed-guard parity — belted rows must not churn the change counter', () => {
  test('post-precedence value equals stored whenever the belt discards the incoming value', async () => {
    const cases: Array<{ frag: string; col: string; stored: string | null; incoming: string | null }> = [
      { frag: sentinelFillInSql('grouping_type', 'unknown'), col: 'grouping_type', stored: 'threshold_series', incoming: 'unknown' },
      { frag: sentinelFillInSql('grouping_type', 'unknown'), col: 'grouping_type', stored: 'categorical_exclusive', incoming: null },
      { frag: sentinelFillInSql('resolution_scope', 'unspecified'), col: 'resolution_scope', stored: 'regulation', incoming: 'unspecified' },
      { frag: enrichedWinsSql('category_unified'), col: 'category_unified', stored: 'economic', incoming: 'geopolitical' },
    ];
    for (const c of cases) {
      // markets.x IS DISTINCT FROM <post-precedence> must be FALSE — the exact
      // clause bulkUpsertMarkets' changed-guard uses.
      const rows = await query<{ is_distinct: boolean }>(
        `WITH t(stored, incoming) AS (VALUES ($1::text, $2::text))
         SELECT t.stored IS DISTINCT FROM (${asSelectable(c.frag, c.col)}) AS is_distinct FROM t`,
        [c.stored, c.incoming],
      );
      expect(rows[0].is_distinct).toBe(false);
    }
  });

  test('a genuine new specific value still trips the guard exactly once', async () => {
    const frag = sentinelFillInSql('grouping_type', 'unknown');
    const rows = await query<{ is_distinct: boolean }>(
      `WITH t(stored, incoming) AS (VALUES ($1::text, $2::text))
       SELECT t.stored IS DISTINCT FROM (${asSelectable(frag, 'grouping_type')}) AS is_distinct FROM t`,
      ['unknown', 'categorical_exclusive'],
    );
    expect(rows[0].is_distinct).toBe(true);
  });
});
