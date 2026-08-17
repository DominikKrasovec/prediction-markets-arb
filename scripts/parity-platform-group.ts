/**
 * Node↔SQL parity check for platform_group_id assignment.
 *
 * `computePlatformGroup()` (Node, sync-time) and the SQL CASE in
 * `getUnfeaturizedMarketsWithGroups` (SQL, Stage 1a backlog) must produce
 * the same group ID for the same raw doc — they're parallel paths into
 * `market_features.platform_group_id` and disagreement causes the
 * "half the parlays get the wrong prefix" bug we hit before.
 *
 * This script:
 *   1. Seeds an in-memory matrix of synthetic raw docs covering every branch
 *      (polymarket negRisk yes/no/empty; kalshi MENTION, SAY, KXMVE family,
 *       normal event, empty; predict slug/empty; limitless; plus boundary cases).
 *   2. Computes the Node result via `computePlatformGroup`.
 *   3. Computes the SQL result via a `WITH … (raw) AS VALUES (…)` query
 *      that runs the identical CASE expression copied from
 *      `getUnfeaturizedMarketsWithGroups`.
 *   4. Compares row-by-row, exits non-zero on any mismatch.
 *
 * Run: `bun run scripts/parity-platform-group.ts`
 *      Exits 0 on full parity, 1 otherwise.
 */
import { query } from '@arb/db';
import { computePlatformGroup } from '../services/pipeline/src/stage1-normalize/platform-groups.js';
import type { Platform } from '@arb/types';

interface Case {
  label: string;
  platform: Platform;
  raw: Record<string, unknown>;
}

// Matrix covering every branch of computePlatformGroup. Keep this list
// growing as new branches land — one row per decision boundary.
const CASES: Case[] = [
  // Polymarket
  { label: 'poly:negRisk-true-with-id',  platform: 'polymarket', raw: { negRisk: true,  negRiskMarketID: 'NR123', eventId: 'E1' } },
  { label: 'poly:negRisk-string-true',   platform: 'polymarket', raw: { negRisk: 'true', negRiskMarketID: 'NR456', eventId: 'E1' } },
  { label: 'poly:negRisk-true-empty-id', platform: 'polymarket', raw: { negRisk: true,  negRiskMarketID: '',       eventId: 'E2' } },
  { label: 'poly:negRisk-true-null-id',  platform: 'polymarket', raw: { negRisk: true,  negRiskMarketID: null,     eventId: 'E2' } },
  { label: 'poly:event-id-only',         platform: 'polymarket', raw: { negRisk: false, eventId: 'E3' } },
  { label: 'poly:event-id-empty',        platform: 'polymarket', raw: { negRisk: false, eventId: '' } },
  { label: 'poly:no-fields',             platform: 'polymarket', raw: {} },

  // Kalshi — bundle prefixes
  { label: 'kalshi:MENTION',     platform: 'kalshi', raw: { event_ticker: 'KXNBAMENTION-26' } },
  { label: 'kalshi:SAY',         platform: 'kalshi', raw: { event_ticker: 'KXTRUMPSAY-26' } },
  { label: 'kalshi:KXMVESPORTS', platform: 'kalshi', raw: { event_ticker: 'KXMVESPORTSMULTI-S20260B6D74E629F' } },
  { label: 'kalshi:KXMVECROSS',  platform: 'kalshi', raw: { event_ticker: 'KXMVECROSSCATEGORY-S2026A1' } },
  { label: 'kalshi:KXMVENBA',    platform: 'kalshi', raw: { event_ticker: 'KXMVENBASINGLEGAME-S202691' } },
  { label: 'kalshi:KXMVEFUTURE', platform: 'kalshi', raw: { event_ticker: 'KXMVEFOOTBALL-FUTURE' } },
  // Mixed-case mention
  { label: 'kalshi:mention-lower', platform: 'kalshi', raw: { event_ticker: 'kxnbamention-26' } },
  // Regular event (no bundle keyword)
  { label: 'kalshi:event-NBAGAME', platform: 'kalshi', raw: { event_ticker: 'KXNBAGAME-26APR22ORLDET' } },
  { label: 'kalshi:event-empty',   platform: 'kalshi', raw: { event_ticker: '' } },
  { label: 'kalshi:event-null',    platform: 'kalshi', raw: { event_ticker: null } },
  { label: 'kalshi:event-missing', platform: 'kalshi', raw: {} },

  // Predict
  { label: 'predict:category-slug',  platform: 'predict', raw: { categorySlug: 'politics-2028' } },
  { label: 'predict:category-empty', platform: 'predict', raw: { categorySlug: '' } },
  { label: 'predict:category-null',  platform: 'predict', raw: { categorySlug: null } },
  { label: 'predict:no-fields',      platform: 'predict', raw: {} },

  // Limitless (always null)
  { label: 'limitless:no-grouping', platform: 'limitless', raw: { eventId: 'should-ignore' } },
];

// SQL CASE expression copied verbatim from getUnfeaturizedMarketsWithGroups.
// If you change one, change both — that's the whole point of this script.
const SQL_CASE = `
CASE platform
  WHEN 'polymarket' THEN
    CASE
      WHEN (raw->>'negRisk') = 'true'
        AND raw->>'negRiskMarketID' IS NOT NULL
        AND raw->>'negRiskMarketID' <> ''
        THEN 'polymarket:negRisk:' || (raw->>'negRiskMarketID')
      WHEN raw->>'eventId' IS NOT NULL
        AND raw->>'eventId' <> ''
        THEN 'polymarket:event:' || (raw->>'eventId')
      ELSE NULL
    END
  WHEN 'kalshi' THEN
    CASE
      WHEN raw->>'event_ticker' IS NOT NULL
        AND raw->>'event_ticker' <> ''
        AND (raw->>'event_ticker') ~ '(?i)MENTION|SAY|KXMVE'
        THEN 'kalshi:bundle:' || (raw->>'event_ticker')
      WHEN raw->>'event_ticker' IS NOT NULL
        AND raw->>'event_ticker' <> ''
        THEN 'kalshi:event:' || (raw->>'event_ticker')
      ELSE NULL
    END
  WHEN 'predict' THEN
    CASE WHEN raw->>'categorySlug' IS NOT NULL
      AND raw->>'categorySlug' <> ''
      THEN 'predict:category:' || (raw->>'categorySlug')
      ELSE NULL
    END
  ELSE NULL
END
`;

// `raw` arrives via UNNEST as text; the CASE expects jsonb. Cast once.
const sql = `
WITH cases AS (
  SELECT UNNEST($1::text[]) AS label,
         UNNEST($2::text[]) AS platform,
         UNNEST($3::text[])::jsonb AS raw
)
SELECT label, ${SQL_CASE} AS sql_value FROM cases
`;

const labels   = CASES.map((c) => c.label);
const platforms = CASES.map((c) => c.platform);
const rawJson  = CASES.map((c) => JSON.stringify(c.raw));

const rows = await query<{ label: string; sql_value: string | null }>(sql, [labels, platforms, rawJson]);
const sqlMap = new Map(rows.map((r) => [r.label, r.sql_value]));

let mismatches = 0;
for (const c of CASES) {
  const node = computePlatformGroup(c.platform, c.raw).platform_group_id;
  const sqlV = sqlMap.get(c.label) ?? null;
  const ok = node === sqlV;
  if (!ok) mismatches++;
  const mark = ok ? '✓' : '✗ MISMATCH';
  console.log(`${mark} ${c.label.padEnd(35)} node=${String(node).padEnd(45)} sql=${String(sqlV)}`);
}

console.log('');
if (mismatches === 0) {
  console.log(`OK — all ${CASES.length} cases match`);
  process.exit(0);
} else {
  console.error(`FAIL — ${mismatches}/${CASES.length} mismatches`);
  process.exit(1);
}
