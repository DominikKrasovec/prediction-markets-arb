/**
 * Build the labeled cross-platform equivalence eval sample.
 *
 * Generates, deterministically (seeded ORDER BY md5 — see DEFAULT_SEED):
 *   - data/eval/xplat-equivalence/v1.todo.jsonl  — 600 stratified UNLABELED
 *     platform-event pairs with all labeling context inline (titles, child
 *     samples, dates, kinds, distances, current pipeline verdict).
 *   - data/eval/xplat-equivalence/v1.seed.jsonl  — ~150 auto-positive pairs
 *     from market_cross_refs (on-chain conditionId ground truth), pre-labeled
 *     'equivalent'.
 *
 * Stratification:
 *   - funnel core (455): platform pair × Stage-3b status (done/skipped/failed),
 *     PM×Kalshi dominant, forced Limitless/Predict quotas; event-kind-family
 *     round-robin within each cell.
 *   - hard-negative band (45): candidate pairs with cosine distance 0.30–0.45,
 *     same-day-same-league preferred (where the FT/ET, halftime, per-map,
 *     station traps live).
 *   - never-candidate distance band (50): cross-platform pairs at distance
 *     0.351–0.45 with NO stage3_event_candidates row (beyond the ANN gate).
 *   - never-candidate same-day-same-league (50): structurally plausible pairs
 *     the funnel never saw, league round-robin, nearest-first.
 *
 * Determinism: every selection orders by md5(SEED || natural-key). Re-running
 * against the same DB state reproduces the same files byte-for-byte except
 * `generated_at`. Records are keyed by NATURAL KEYS (platform +
 * platform_event_id + child platform_ids) — never serial ids, which
 * RESTART-IDENTITY rebuilds reassign.
 *
 * Read-only: pure SELECTs. Writes only the two JSONL files (refuses to
 * overwrite an existing v1.todo.jsonl / v1.seed.jsonl without --force, so a
 * partially-labeled file can't be clobbered).
 *
 * Usage:
 *   npx tsx services/pipeline/src/scripts/build-eval-sample.ts [--force]
 *     [--seed <string>] [--out-dir <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, endPool } from '@arb/db';

// Shared vocabulary (imported by run-eval-suite.ts and the tests)

export const SCHEMA_VERSION = 1 as const;
export const DEFAULT_SEED = 'xplat-eval-v1';

export const LABELS = [
  'equivalent',
  'subset_a_in_b',
  'subset_b_in_a',
  'related_not_equivalent',
  'unrelated',
] as const;
export type EvalLabel = (typeof LABELS)[number];

export const FAILURE_MODES = [
  'scope_mismatch',
  'period_mismatch',
  'oracle_mismatch',
  'timestamp_mismatch',
  'value_grid_mismatch',
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export type KindFamily =
  | 'match_winner'
  | 'totals'
  | 'spreads'
  | 'props'
  | 'futures'
  | 'nonsports'
  | 'other';

const KIND_TO_FAMILY: Record<string, KindFamily> = {
  match_winner: 'match_winner',
  halftime_leader: 'match_winner',
  match_total_metric: 'totals',
  both_teams_score: 'totals',
  exact_score: 'totals',
  match_spread: 'spreads',
  player_prop_threshold: 'props',
  championship_winner: 'futures',
  stage_advance: 'futures',
};

/** Map an event_kind (either side) to the stratification family. Anything
 * not explicitly sports-structural is the non-sports tail; NULL/'other' is
 * its own bucket so unshaped events stay visible in the quota table. */
export function kindFamily(kind: string | null | undefined): KindFamily {
  if (kind == null || kind === 'other') return 'other';
  const mapped = KIND_TO_FAMILY[kind];
  if (mapped) return mapped;
  return 'nonsports';
}

export function md5hex(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

export interface NaturalSideKey {
  platform: string;
  platform_event_id: string;
}

/** Canonical side order: lexicographic by (platform, platform_event_id), so
 * pair identity is orientation-free. subset_* labels refer to the ORDERED
 * record sides, which this function fixes once at build time. */
export function canonicalSideOrder<T extends NaturalSideKey>(a: T, b: T): [T, T] {
  if (
    a.platform < b.platform ||
    (a.platform === b.platform && a.platform_event_id <= b.platform_event_id)
  ) {
    return [a, b];
  }
  return [b, a];
}

export function pairNaturalKey(a: NaturalSideKey, b: NaturalSideKey): string {
  const [x, y] = canonicalSideOrder(a, b);
  return `${x.platform}:${x.platform_event_id}||${y.platform}:${y.platform_event_id}`;
}

/** Stable record id = md5 of the natural key (seed-independent). */
export function pairIdFor(a: NaturalSideKey, b: NaturalSideKey): string {
  return md5hex(pairNaturalKey(a, b));
}

export function platformPairLabel(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

// Record shape (mirrored by data/eval/xplat-equivalence/schema.json)

export interface EvalSide extends NaturalSideKey {
  title: string | null;
  event_kind: string | null;
  grouping_type: string | null;
  league: string | null;
  sport: string | null;
  condition_date: string | null;
  condition_date_precision: string | null;
  deadline: string | null;
  child_count: number | null;
  child_markets: Array<{ platform_id: string; title: string | null }>;
}

export type CandidateStatus = 'done' | 'skipped' | 'failed';
export type PipelineVerdict =
  | 'merged'
  | 'matched_not_merged'
  | 'candidate_rejected'
  | 'candidate_failed'
  | 'never_candidate';

export interface EvalRecord {
  schema_version: typeof SCHEMA_VERSION;
  pair_id: string;
  side_a: EvalSide;
  side_b: EvalSide;
  context: {
    platform_pair: string;
    kind_family: KindFamily;
    stratum: string;
    cosine_distance: number | null;
    anchor_market_pairs?: Array<{ a_platform_id: string; b_platform_id: string }>;
    pipeline: {
      candidate_status: CandidateStatus | null;
      llm_reasoning: string | null;
      same_semantic_event: boolean;
      semantic_event_id_at_build: number | null;
      shared_question_count: number;
      verdict: PipelineVerdict;
    };
    generator: { script: string; seed: string; generated_at: string };
  };
  label: EvalLabel | null;
  failure_modes: FailureMode[];
  label_source: string | null;
  labeled_at: string | null;
  annotator: string | null;
  annotator2_label: EvalLabel | null;
  annotator2: string | null;
  kappa_subset: boolean;
  notes: string | null;
}

// Quota plan (sums to 600)

export interface FunnelQuotaCell {
  pair: string; // platformPairLabel
  status: CandidateStatus;
  target: number;
}

export const FUNNEL_QUOTAS: ReadonlyArray<FunnelQuotaCell> = [
  { pair: 'kalshi|polymarket', status: 'done', target: 80 },
  { pair: 'kalshi|polymarket', status: 'skipped', target: 80 },
  { pair: 'kalshi|polymarket', status: 'failed', target: 50 },
  { pair: 'polymarket|predict', status: 'done', target: 30 },
  { pair: 'polymarket|predict', status: 'skipped', target: 30 },
  { pair: 'polymarket|predict', status: 'failed', target: 20 },
  { pair: 'kalshi|limitless', status: 'done', target: 15 },
  { pair: 'kalshi|limitless', status: 'skipped', target: 15 },
  { pair: 'kalshi|limitless', status: 'failed', target: 15 },
  { pair: 'kalshi|predict', status: 'done', target: 15 },
  { pair: 'kalshi|predict', status: 'skipped', target: 15 },
  { pair: 'kalshi|predict', status: 'failed', target: 15 },
  { pair: 'limitless|polymarket', status: 'done', target: 15 },
  { pair: 'limitless|polymarket', status: 'skipped', target: 15 },
  { pair: 'limitless|polymarket', status: 'failed', target: 15 },
  { pair: 'limitless|predict', status: 'done', target: 10 },
  { pair: 'limitless|predict', status: 'skipped', target: 10 },
  { pair: 'limitless|predict', status: 'failed', target: 10 },
];

export const EXTRA_QUOTAS = {
  hardneg_band_candidate: 45,
  hardneg_band_never_candidate: 50,
  same_day_league_never_candidate: 50,
} as const;

export const SEED_TARGET = 150;
export const KAPPA_SUBSET_SIZE = 150;

export function totalTodoQuota(): number {
  return (
    FUNNEL_QUOTAS.reduce((s, c) => s + c.target, 0) +
    Object.values(EXTRA_QUOTAS).reduce((s, n) => s + n, 0)
  );
}

/**
 * Deterministic family-balanced pick: group rows by family, sort each group by
 * sortKey, then take one row per family per round (families in alphabetical
 * order) until the quota is met or the pool is exhausted.
 */
export function roundRobinByFamily<T>(
  rows: ReadonlyArray<T>,
  familyOf: (t: T) => string,
  sortKey: (t: T) => string,
  quota: number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const f = familyOf(r);
    let g = groups.get(f);
    if (!g) {
      g = [];
      groups.set(f, g);
    }
    g.push(r);
  }
  const families = [...groups.keys()].sort();
  for (const f of families) {
    groups.get(f)!.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
  }
  const out: T[] = [];
  const cursors = new Map<string, number>(families.map((f) => [f, 0]));
  while (out.length < quota) {
    let progressed = false;
    for (const f of families) {
      if (out.length >= quota) break;
      const g = groups.get(f)!;
      const i = cursors.get(f)!;
      if (i < g.length) {
        out.push(g[i]);
        cursors.set(f, i + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

// DB row shapes

interface PeMetaRow {
  id: number;
  platform: string;
  platform_event_id: string;
  title: string | null;
  event_kind: string | null;
  grouping_type: string | null;
  league_canonical: string | null;
  sport_canonical: string | null;
  condition_date: Date | null;
  condition_date_precision: string | null;
  deadline: Date | null;
  child_count: number | null;
}

interface CandidatePoolRow {
  cand_id: number;
  status: CandidateStatus;
  dist: number | null;
  semantic_event_id: number | null;
  reasoning: string | null;
  a: PeMetaRow;
  b: PeMetaRow;
}

interface SelectedPair {
  stratum: string;
  a: PeMetaRow;
  b: PeMetaRow;
  dist: number | null;
  status: CandidateStatus | null;
  semanticEventId: number | null;
  reasoning: string | null;
  anchorMarketPairs?: Array<{ a_platform_id: string; b_platform_id: string }>;
  label?: EvalLabel;
  labelSource?: string;
}

// Main

function repoRoot(): string {
  // <root>/services/pipeline/src/scripts/build-eval-sample.ts
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (typeof d === 'string') return d;
  return d.toISOString();
}

function dateOnlyOrNull(d: Date | string | null | undefined): string | null {
  const iso = isoOrNull(d);
  return iso ? iso.slice(0, 10) : null;
}

const PE_META_COLS = `
  pe.id, pe.platform, pe.platform_event_id, pe.title, pe.event_kind,
  pe.grouping_type, pe.league_canonical, pe.sport_canonical,
  pe.condition_date, pe.condition_date_precision, pe.deadline, pe.child_count`;

async function fetchCandidatePool(): Promise<CandidatePoolRow[]> {
  interface Raw {
    cand_id: number;
    status: CandidateStatus;
    dist: number | null;
    semantic_event_id: number | null;
    reasoning: string | null;
    [k: string]: unknown;
  }
  const rows = await query<Raw>(`
    SELECT c.id AS cand_id, c.status, c.cosine_distance::float8 AS dist,
           c.semantic_event_id, left(coalesce(c.llm_reasoning, ''), 280) AS reasoning,
           pa.id a_id, pa.platform a_platform, pa.platform_event_id a_peid, pa.title a_title,
           pa.event_kind a_kind, pa.grouping_type a_grouping, pa.league_canonical a_league,
           pa.sport_canonical a_sport, pa.condition_date a_date,
           pa.condition_date_precision a_dateprec, pa.deadline a_deadline, pa.child_count a_children,
           pb.id b_id, pb.platform b_platform, pb.platform_event_id b_peid, pb.title b_title,
           pb.event_kind b_kind, pb.grouping_type b_grouping, pb.league_canonical b_league,
           pb.sport_canonical b_sport, pb.condition_date b_date,
           pb.condition_date_precision b_dateprec, pb.deadline b_deadline, pb.child_count b_children
    FROM stage3_event_candidates c
    JOIN platform_events pa ON pa.id = c.platform_event_a
    JOIN platform_events pb ON pb.id = c.platform_event_b
  `);
  const toMeta = (r: Raw, p: 'a' | 'b'): PeMetaRow => ({
    id: r[`${p}_id`] as number,
    platform: r[`${p}_platform`] as string,
    platform_event_id: r[`${p}_peid`] as string,
    title: r[`${p}_title`] as string | null,
    event_kind: r[`${p}_kind`] as string | null,
    grouping_type: r[`${p}_grouping`] as string | null,
    league_canonical: r[`${p}_league`] as string | null,
    sport_canonical: r[`${p}_sport`] as string | null,
    condition_date: r[`${p}_date`] as Date | null,
    condition_date_precision: r[`${p}_dateprec`] as string | null,
    deadline: r[`${p}_deadline`] as Date | null,
    child_count: r[`${p}_children`] as number | null,
  });
  return rows.map((r) => ({
    cand_id: r.cand_id,
    status: r.status,
    dist: r.dist,
    semantic_event_id: r.semantic_event_id,
    reasoning: r.reasoning || null,
    a: toMeta(r, 'a'),
    b: toMeta(r, 'b'),
  }));
}

async function fetchPeMetaByIds(ids: number[]): Promise<Map<number, PeMetaRow>> {
  if (ids.length === 0) return new Map();
  const rows = await query<PeMetaRow>(
    `SELECT ${PE_META_COLS} FROM platform_events pe WHERE pe.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function fetchPeMetaByNaturalKeys(keys: NaturalSideKey[]): Promise<Map<string, PeMetaRow>> {
  if (keys.length === 0) return new Map();
  const rows = await query<PeMetaRow>(
    `SELECT ${PE_META_COLS}
     FROM platform_events pe
     JOIN unnest($1::text[], $2::text[]) AS k(platform, peid)
       ON pe.platform = k.platform AND pe.platform_event_id = k.peid`,
    [keys.map((k) => k.platform), keys.map((k) => k.platform_event_id)],
  );
  return new Map(rows.map((r) => [`${r.platform}:${r.platform_event_id}`, r]));
}

/** Hard-negative band beyond the ANN gate: cross-platform neighbors at cosine
 * distance 0.351–0.45 with no candidate row, from deterministically chosen
 * anchors. */
async function fetchNeverCandidateBand(seed: string): Promise<Array<{ a_id: number; b_id: number; dist: number }>> {
  return query<{ a_id: number; b_id: number; dist: number }>(
    `
    WITH anchors AS (
      SELECT id, platform, embedding
      FROM platform_events
      WHERE embedding IS NOT NULL
      ORDER BY md5($1 || platform || platform_event_id)
      LIMIT 150
    )
    SELECT a.id AS a_id, nb.id AS b_id, nb.dist
    FROM anchors a
    JOIN LATERAL (
      SELECT pe.id, (pe.embedding <=> a.embedding)::float8 AS dist
      FROM platform_events pe
      WHERE pe.platform <> a.platform
        AND pe.embedding IS NOT NULL
        AND (pe.embedding <=> a.embedding) BETWEEN 0.351 AND 0.45
      ORDER BY pe.embedding <=> a.embedding
      LIMIT 4
    ) nb ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM stage3_event_candidates c
      WHERE (c.platform_event_a = a.id AND c.platform_event_b = nb.id)
         OR (c.platform_event_a = nb.id AND c.platform_event_b = a.id)
    )
    `,
    [seed],
  );
}

/** Same-day-same-league cross-platform pairs the funnel never saw. */
async function fetchSameDayLeagueNeverCandidates(): Promise<
  Array<{ a_id: number; b_id: number; dist: number | null; league: string }>
> {
  return query<{ a_id: number; b_id: number; dist: number | null; league: string }>(`
    SELECT pa.id AS a_id, pb.id AS b_id,
           (pa.embedding <=> pb.embedding)::float8 AS dist,
           pa.league_canonical AS league
    FROM platform_events pa
    JOIN platform_events pb
      ON pb.platform > pa.platform
     AND pb.league_canonical = pa.league_canonical
     AND pb.condition_date::date = pa.condition_date::date
    WHERE pa.league_canonical IS NOT NULL
      AND pa.condition_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM stage3_event_candidates c
        WHERE (c.platform_event_a = pa.id AND c.platform_event_b = pb.id)
           OR (c.platform_event_a = pb.id AND c.platform_event_b = pa.id)
      )
  `);
}

interface CrossRefPair {
  a: NaturalSideKey; // canonical order
  b: NaturalSideKey;
  anchors: Array<{ a_platform_id: string; b_platform_id: string }>;
}

async function fetchCrossRefPairs(): Promise<CrossRefPair[]> {
  const rows = await query<{
    sp: string;
    speid: string;
    smid: string;
    tp: string;
    tpeid: string;
    tmid: string;
  }>(`
    SELECT ms.platform sp, ms.platform_event_id speid, ms.platform_id smid,
           mt.platform tp, mt.platform_event_id tpeid, mt.platform_id tmid
    FROM market_cross_refs x
    JOIN markets ms ON ms.id = x.source_market_id
    JOIN markets mt ON mt.id = x.target_market_id
    WHERE ms.platform_event_id IS NOT NULL AND mt.platform_event_id IS NOT NULL
  `);
  const byPair = new Map<string, CrossRefPair>();
  for (const r of rows) {
    const s: NaturalSideKey = { platform: r.sp, platform_event_id: r.speid };
    const t: NaturalSideKey = { platform: r.tp, platform_event_id: r.tpeid };
    const [a, b] = canonicalSideOrder(s, t);
    const key = pairNaturalKey(a, b);
    let entry = byPair.get(key);
    if (!entry) {
      entry = { a, b, anchors: [] };
      byPair.set(key, entry);
    }
    const sourceIsA = a.platform === s.platform && a.platform_event_id === s.platform_event_id;
    const anchor = sourceIsA
      ? { a_platform_id: r.smid, b_platform_id: r.tmid }
      : { a_platform_id: r.tmid, b_platform_id: r.smid };
    if (
      entry.anchors.length < 10 &&
      !entry.anchors.some(
        (x) => x.a_platform_id === anchor.a_platform_id && x.b_platform_id === anchor.b_platform_id,
      )
    ) {
      entry.anchors.push(anchor);
    }
  }
  return [...byPair.values()];
}

async function fetchChildSamples(
  keys: NaturalSideKey[],
): Promise<Map<string, Array<{ platform_id: string; title: string | null }>>> {
  const out = new Map<string, Array<{ platform_id: string; title: string | null }>>();
  if (keys.length === 0) return out;
  const rows = await query<{ platform: string; platform_event_id: string; platform_id: string; title: string | null }>(
    `
    SELECT platform, platform_event_id, platform_id, title
    FROM (
      SELECT m.platform, m.platform_event_id, m.platform_id, m.title,
             row_number() OVER (PARTITION BY m.platform, m.platform_event_id ORDER BY m.platform_id) AS rn
      FROM markets m
      JOIN unnest($1::text[], $2::text[]) AS k(platform, peid)
        ON m.platform = k.platform AND m.platform_event_id = k.peid
    ) t
    WHERE t.rn <= 6
    ORDER BY platform, platform_event_id, platform_id
    `,
    [keys.map((k) => k.platform), keys.map((k) => k.platform_event_id)],
  );
  for (const r of rows) {
    const key = `${r.platform}:${r.platform_event_id}`;
    let arr = out.get(key);
    if (!arr) {
      arr = [];
      out.set(key, arr);
    }
    arr.push({ platform_id: r.platform_id, title: r.title });
  }
  return out;
}

async function fetchSharedQuestionCounts(
  pairs: Array<{ a_id: number; b_id: number }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const rows = await query<{ a_id: number; b_id: number; shared: number }>(
    `
    WITH pairs AS (SELECT * FROM unnest($1::int[], $2::int[]) AS t(a_id, b_id))
    SELECT p.a_id, p.b_id, count(DISTINCT qa.question_id)::int AS shared
    FROM pairs p
    JOIN platform_events pa ON pa.id = p.a_id
    JOIN platform_events pb ON pb.id = p.b_id
    JOIN markets ma ON ma.platform = pa.platform AND ma.platform_event_id = pa.platform_event_id
    JOIN question_members qa ON qa.market_id = ma.id
    JOIN question_members qb ON qb.question_id = qa.question_id
    JOIN markets mb ON mb.id = qb.market_id
      AND mb.platform = pb.platform AND mb.platform_event_id = pb.platform_event_id
    GROUP BY 1, 2
    `,
    [pairs.map((p) => p.a_id), pairs.map((p) => p.b_id)],
  );
  for (const r of rows) out.set(`${r.a_id}|${r.b_id}`, r.shared);
  return out;
}

async function fetchSemanticEventMemberships(peIds: number[]): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (peIds.length === 0) return out;
  const rows = await query<{ platform_event_id: number; semantic_event_id: number }>(
    `SELECT platform_event_id, semantic_event_id FROM semantic_event_platforms WHERE platform_event_id = ANY($1::int[])`,
    [peIds],
  );
  for (const r of rows) {
    let s = out.get(r.platform_event_id);
    if (!s) {
      s = new Set();
      out.set(r.platform_event_id, s);
    }
    s.add(r.semantic_event_id);
  }
  return out;
}

function verdictFor(
  sharedQuestions: number,
  status: CandidateStatus | null,
): PipelineVerdict {
  if (sharedQuestions > 0) return 'merged';
  if (status === 'done') return 'matched_not_merged';
  if (status === 'skipped') return 'candidate_rejected';
  if (status === 'failed') return 'candidate_failed';
  return 'never_candidate';
}

function sameDaySameLeague(a: PeMetaRow, b: PeMetaRow): boolean {
  return (
    a.league_canonical != null &&
    a.league_canonical === b.league_canonical &&
    a.condition_date != null &&
    b.condition_date != null &&
    dateOnlyOrNull(a.condition_date) === dateOnlyOrNull(b.condition_date)
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx >= 0 ? args[seedIdx + 1] : DEFAULT_SEED;
  const outIdx = args.indexOf('--out-dir');
  const outDir =
    outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(repoRoot(), 'data', 'eval', 'xplat-equivalence');
  const todoPath = path.join(outDir, 'v1.todo.jsonl');
  const seedPath = path.join(outDir, 'v1.seed.jsonl');
  if (!force && (existsSync(todoPath) || existsSync(seedPath))) {
    console.error(
      `Refusing to overwrite ${todoPath} / ${seedPath} (may hold labels in progress). Re-run with --force.`,
    );
    process.exitCode = 2;
    return;
  }
  const generatedAt = new Date().toISOString();
  console.log(`build-eval-sample: seed='${seed}' out=${outDir}`);

  // -- pools ----------------------------------------------------------------
  const poolRows = await fetchCandidatePool();
  // Dedupe to one row per natural pair (keep highest candidate id = latest).
  const candByPair = new Map<string, CandidatePoolRow>();
  for (const r of poolRows) {
    const key = pairNaturalKey(r.a, r.b);
    const prev = candByPair.get(key);
    if (!prev || r.cand_id > prev.cand_id) candByPair.set(key, r);
  }
  console.log(`candidate pool: ${poolRows.length} rows, ${candByPair.size} distinct pairs`);

  const crossRefPairs = await fetchCrossRefPairs();
  const crossRefKeys = new Set(crossRefPairs.map((p) => pairNaturalKey(p.a, p.b)));
  console.log(`cross-ref pe pairs (auto-positives): ${crossRefPairs.length}`);

  const selected: SelectedPair[] = [];
  const selectedKeys = new Set<string>();
  const fillReport: Array<{ stratum: string; cell: string; target: number; filled: number; available: number }> = [];

  const sortKeyOf = (r: CandidatePoolRow): string => md5hex(`${seed}|${pairNaturalKey(r.a, r.b)}`);
  const familyOf = (r: CandidatePoolRow): string => kindFamily(r.a.event_kind ?? r.b.event_kind);

  // -- funnel core (455) ----------------------------------------------------
  for (const cell of FUNNEL_QUOTAS) {
    const cellRows = [...candByPair.values()].filter(
      (r) =>
        r.status === cell.status &&
        platformPairLabel(r.a.platform, r.b.platform) === cell.pair &&
        !crossRefKeys.has(pairNaturalKey(r.a, r.b)) &&
        !selectedKeys.has(pairNaturalKey(r.a, r.b)),
    );
    const picked = roundRobinByFamily(cellRows, familyOf, sortKeyOf, cell.target);
    for (const r of picked) {
      const key = pairNaturalKey(r.a, r.b);
      selectedKeys.add(key);
      selected.push({
        stratum: `funnel_${r.status}`,
        a: r.a,
        b: r.b,
        dist: r.dist,
        status: r.status,
        semanticEventId: r.semantic_event_id,
        reasoning: r.reasoning,
      });
    }
    fillReport.push({
      stratum: `funnel_${cell.status}`,
      cell: cell.pair,
      target: cell.target,
      filled: picked.length,
      available: cellRows.length,
    });
  }

  // -- hard-negative band among candidates (cosine 0.30–0.45) ---------------
  {
    const target = EXTRA_QUOTAS.hardneg_band_candidate;
    const band = [...candByPair.values()].filter(
      (r) =>
        r.dist != null &&
        r.dist >= 0.3 &&
        r.dist <= 0.45 &&
        !crossRefKeys.has(pairNaturalKey(r.a, r.b)) &&
        !selectedKeys.has(pairNaturalKey(r.a, r.b)),
    );
    // Same-day-same-league pairs first (the trap band), then the rest.
    const trap = band.filter((r) => sameDaySameLeague(r.a, r.b)).sort((x, y) => (sortKeyOf(x) < sortKeyOf(y) ? -1 : 1));
    const rest = band.filter((r) => !sameDaySameLeague(r.a, r.b)).sort((x, y) => (sortKeyOf(x) < sortKeyOf(y) ? -1 : 1));
    const picked = [...trap, ...rest].slice(0, target);
    for (const r of picked) {
      selectedKeys.add(pairNaturalKey(r.a, r.b));
      selected.push({
        stratum: 'hardneg_band_candidate',
        a: r.a,
        b: r.b,
        dist: r.dist,
        status: r.status,
        semanticEventId: r.semantic_event_id,
        reasoning: r.reasoning,
      });
    }
    fillReport.push({
      stratum: 'hardneg_band_candidate',
      cell: 'any (same-day-league first)',
      target,
      filled: picked.length,
      available: band.length,
    });
  }

  // -- never-candidate distance band (0.351–0.45) ----------------------------
  {
    const target = EXTRA_QUOTAS.hardneg_band_never_candidate;
    const raw = await fetchNeverCandidateBand(seed);
    const metaIds = [...new Set(raw.flatMap((r) => [r.a_id, r.b_id]))];
    const meta = await fetchPeMetaByIds(metaIds);
    const dedup = new Map<string, { a: PeMetaRow; b: PeMetaRow; dist: number }>();
    for (const r of raw) {
      const a = meta.get(r.a_id);
      const b = meta.get(r.b_id);
      if (!a || !b) continue;
      const key = pairNaturalKey(a, b);
      if (crossRefKeys.has(key) || selectedKeys.has(key) || dedup.has(key)) continue;
      dedup.set(key, { a, b, dist: r.dist });
    }
    const picked = [...dedup.entries()]
      .sort((x, y) => (md5hex(`${seed}|${x[0]}`) < md5hex(`${seed}|${y[0]}`) ? -1 : 1))
      .slice(0, target);
    for (const [key, r] of picked) {
      selectedKeys.add(key);
      selected.push({
        stratum: 'hardneg_band_never_candidate',
        a: r.a,
        b: r.b,
        dist: r.dist,
        status: null,
        semanticEventId: null,
        reasoning: null,
      });
    }
    fillReport.push({
      stratum: 'hardneg_band_never_candidate',
      cell: 'distance 0.351–0.45',
      target,
      filled: picked.length,
      available: dedup.size,
    });
  }

  // -- never-candidate same-day-same-league ----------------------------------
  {
    const target = EXTRA_QUOTAS.same_day_league_never_candidate;
    const raw = await fetchSameDayLeagueNeverCandidates();
    const metaIds = [...new Set(raw.flatMap((r) => [r.a_id, r.b_id]))];
    const meta = await fetchPeMetaByIds(metaIds);
    // League round-robin, nearest-first within league (hardest negatives),
    // md5 tiebreak for determinism.
    type Row = { key: string; a: PeMetaRow; b: PeMetaRow; dist: number | null; league: string };
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const a = meta.get(r.a_id);
      const b = meta.get(r.b_id);
      if (!a || !b) continue;
      const key = pairNaturalKey(a, b);
      if (crossRefKeys.has(key) || selectedKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, a, b, dist: r.dist, league: r.league });
    }
    const picked = roundRobinByFamily(
      rows,
      (r) => r.league,
      (r) => `${(r.dist ?? 9).toFixed(6)}|${md5hex(`${seed}|${r.key}`)}`,
      target,
    );
    for (const r of picked) {
      selectedKeys.add(r.key);
      selected.push({
        stratum: 'same_day_league_never_candidate',
        a: r.a,
        b: r.b,
        dist: r.dist,
        status: null,
        semanticEventId: null,
        reasoning: null,
      });
    }
    fillReport.push({
      stratum: 'same_day_league_never_candidate',
      cell: 'league round-robin, nearest-first',
      target,
      filled: picked.length,
      available: rows.length,
    });
  }

  // -- seed (cross-ref auto-positives) ---------------------------------------
  const seedSelected: SelectedPair[] = [];
  {
    const ordered = [...crossRefPairs].sort((x, y) =>
      md5hex(`${seed}|${pairNaturalKey(x.a, x.b)}`) < md5hex(`${seed}|${pairNaturalKey(y.a, y.b)}`) ? -1 : 1,
    );
    const picked = ordered.slice(0, SEED_TARGET);
    const meta = await fetchPeMetaByNaturalKeys(picked.flatMap((p) => [p.a, p.b]));
    let missingMeta = 0;
    for (const p of picked) {
      const a = meta.get(`${p.a.platform}:${p.a.platform_event_id}`);
      const b = meta.get(`${p.b.platform}:${p.b.platform_event_id}`);
      if (!a || !b) {
        missingMeta++;
        continue;
      }
      const key = pairNaturalKey(a, b);
      const cand = candByPair.get(key) ?? null;
      seedSelected.push({
        stratum: 'cross_ref_seed',
        a,
        b,
        dist: cand?.dist ?? null,
        status: cand?.status ?? null,
        semanticEventId: cand?.semantic_event_id ?? null,
        reasoning: cand?.reasoning ?? null,
        anchorMarketPairs: p.anchors,
        label: 'equivalent',
        labelSource: 'market_cross_refs',
      });
    }
    fillReport.push({
      stratum: 'cross_ref_seed',
      cell: 'market_cross_refs pe pairs',
      target: SEED_TARGET,
      filled: seedSelected.length,
      available: crossRefPairs.length,
    });
    if (missingMeta > 0) console.warn(`seed: ${missingMeta} pairs dropped (platform_event row missing)`);
  }

  // -- enrichment -------------------------------------------------------------
  const all = [...selected, ...seedSelected];
  const allKeys: NaturalSideKey[] = [];
  const keySeen = new Set<string>();
  for (const s of all) {
    for (const side of [s.a, s.b]) {
      const k = `${side.platform}:${side.platform_event_id}`;
      if (!keySeen.has(k)) {
        keySeen.add(k);
        allKeys.push({ platform: side.platform, platform_event_id: side.platform_event_id });
      }
    }
  }
  const childSamples = await fetchChildSamples(allKeys);
  const sharedQ = await fetchSharedQuestionCounts(all.map((s) => ({ a_id: s.a.id, b_id: s.b.id })));
  const seMembership = await fetchSemanticEventMemberships([
    ...new Set(all.flatMap((s) => [s.a.id, s.b.id])),
  ]);

  const toSide = (m: PeMetaRow): EvalSide => ({
    platform: m.platform,
    platform_event_id: m.platform_event_id,
    title: m.title,
    event_kind: m.event_kind,
    grouping_type: m.grouping_type,
    league: m.league_canonical,
    sport: m.sport_canonical,
    condition_date: isoOrNull(m.condition_date),
    condition_date_precision: m.condition_date_precision,
    deadline: dateOnlyOrNull(m.deadline),
    child_count: m.child_count,
    child_markets: childSamples.get(`${m.platform}:${m.platform_event_id}`) ?? [],
  });

  const toRecord = (s: SelectedPair): EvalRecord => {
    const [a, b] = canonicalSideOrder(s.a, s.b);
    const shared = sharedQ.get(`${s.a.id}|${s.b.id}`) ?? 0;
    const seA = seMembership.get(s.a.id) ?? new Set<number>();
    const seB = seMembership.get(s.b.id) ?? new Set<number>();
    const sharedSe = [...seA].filter((x) => seB.has(x));
    const rec: EvalRecord = {
      schema_version: SCHEMA_VERSION,
      pair_id: pairIdFor(a, b),
      side_a: toSide(a),
      side_b: toSide(b),
      context: {
        platform_pair: platformPairLabel(a.platform, b.platform),
        kind_family: kindFamily(a.event_kind ?? b.event_kind),
        stratum: s.stratum,
        cosine_distance: s.dist,
        ...(s.anchorMarketPairs ? { anchor_market_pairs: s.anchorMarketPairs } : {}),
        pipeline: {
          candidate_status: s.status,
          llm_reasoning: s.reasoning,
          same_semantic_event: sharedSe.length > 0,
          semantic_event_id_at_build: sharedSe[0] ?? s.semanticEventId ?? null,
          shared_question_count: shared,
          verdict: verdictFor(shared, s.status),
        },
        generator: { script: 'build-eval-sample.ts', seed, generated_at: generatedAt },
      },
      label: s.label ?? null,
      failure_modes: [],
      label_source: s.labelSource ?? null,
      labeled_at: s.label ? generatedAt : null,
      annotator: null,
      annotator2_label: null,
      annotator2: null,
      kappa_subset: false,
      notes: null,
    };
    return rec;
  };

  const todoRecords = selected.map(toRecord);
  const seedRecords = seedSelected.map(toRecord);

  // κ subset: deterministic 150 of the todo records.
  const kappaIds = new Set(
    todoRecords
      .map((r) => r.pair_id)
      .sort((x, y) => (md5hex(`${seed}|kappa|${x}`) < md5hex(`${seed}|kappa|${y}`) ? -1 : 1))
      .slice(0, KAPPA_SUBSET_SIZE),
  );
  for (const r of todoRecords) r.kappa_subset = kappaIds.has(r.pair_id);

  // -- write ------------------------------------------------------------------
  mkdirSync(outDir, { recursive: true });
  writeFileSync(todoPath, todoRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  writeFileSync(seedPath, seedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`wrote ${todoRecords.length} records -> ${todoPath}`);
  console.log(`wrote ${seedRecords.length} records -> ${seedPath}`);

  // -- quota fill report -------------------------------------------------------
  console.log('\n== quota fill ==');
  console.table(fillReport);
  const shortfalls = fillReport.filter((r) => r.filled < r.target);
  if (shortfalls.length > 0) {
    console.log('SHORTFALLS:');
    for (const s of shortfalls) console.log(`  ${s.stratum} / ${s.cell}: ${s.filled}/${s.target} (available ${s.available})`);
  } else {
    console.log('all quotas filled');
  }
  console.log('\n== kind-family distribution (todo) ==');
  const famCounts = new Map<string, number>();
  for (const r of todoRecords) famCounts.set(r.context.kind_family, (famCounts.get(r.context.kind_family) ?? 0) + 1);
  console.table([...famCounts.entries()].sort().map(([family, n]) => ({ family, n })));
  console.log('\n== verdict distribution (todo) ==');
  const vCounts = new Map<string, number>();
  for (const r of todoRecords) vCounts.set(r.context.pipeline.verdict, (vCounts.get(r.context.pipeline.verdict) ?? 0) + 1);
  console.table([...vCounts.entries()].sort().map(([verdict, n]) => ({ verdict, n })));
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const a = pathToFileURL(path.resolve(entry)).href.replace(/\.(ts|js|mts|mjs)$/, '');
    const b = import.meta.url.replace(/\.(ts|js|mts|mjs)$/, '');
    return a === b;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => void endPool());
}
