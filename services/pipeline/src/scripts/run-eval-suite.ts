/**
 * Run the cross-platform equivalence eval suite against the live DB.
 *
 * Consumes the JSONL eval files under data/eval/xplat-equivalence/
 * (v1.seed.jsonl + v1.jsonl + v1.todo.jsonl by default — any that exist).
 * Rows without a `label` are tolerated and skipped, so the suite works
 * incrementally as labels accumulate. Records are merged by pair_id; the
 * first labeled occurrence wins (conflicting labels are warned about).
 *
 * Natural-key → current-id resolution happens at RUNTIME: pairs are stored as
 * (platform, platform_event_id) + child platform_ids, never serial ids, so the
 * suite survives RESTART-IDENTITY rebuilds. Sides whose platform_event row is
 * gone are re-resolved through their child markets' platform_ids.
 *
 * Metrics:
 *  (a) Stage-3a candidate recall over labeled positives (equivalent + subset):
 *      does ANY stage3_event_candidates row exist for the pair?
 *  (b) End-to-end question-grain merge precision/recall: positives
 *      (label=equivalent) must share a question; all other labels must NOT.
 *      Also reported at anchor-market grain where anchor_market_pairs exist.
 *  (c) Stage-3b verification verdicts vs labels (pairs with a candidate row):
 *      done on a non-equivalent pair = FP; skipped/failed on an equivalent
 *      pair = FN. Per-status confusion + per-failure-mode breakdown.
 *  (d) Cohen's κ over rows carrying both label and annotator2_label.
 *
 * Read-only: pure SELECTs only (no temp tables needed at this scale).
 *
 * Usage:
 *   npx tsx services/pipeline/src/scripts/run-eval-suite.ts
 *     [--file <path>]... [--assert-min-precision 0.95] [--assert-min-recall 0.5]
 *     [--json]
 *
 * Exit codes: 0 ok; 1 assert failed; 2 no labeled rows / no input files.
 * The assert flags gate the (b) pe-grain question merge metrics for CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, endPool } from '@arb/db';
import {
  LABELS,
  FAILURE_MODES,
  pairIdFor,
  type CandidateStatus,
  type EvalLabel,
  type EvalRecord,
} from './build-eval-sample.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedFile {
  records: EvalRecord[];
  badLines: number;
}

export function parseJsonl(text: string): ParsedFile {
  const records: EvalRecord[] = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const rec = JSON.parse(trimmed) as EvalRecord;
      if (typeof rec?.pair_id !== 'string' || !rec.side_a?.platform || !rec.side_b?.platform) {
        badLines++;
        continue;
      }
      if (rec.label != null && !(LABELS as readonly string[]).includes(rec.label)) {
        badLines++;
        continue;
      }
      records.push(rec);
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

export interface MergeResult {
  merged: EvalRecord[];
  conflicts: number;
}

/** Merge records across files by pair_id. First labeled occurrence wins; an
 * unlabeled duplicate never displaces a labeled one. Two differing non-null
 * labels for one pair_id count as a conflict (first kept). */
export function mergeRecords(fileRecords: ReadonlyArray<EvalRecord[]>): MergeResult {
  const byId = new Map<string, EvalRecord>();
  let conflicts = 0;
  for (const records of fileRecords) {
    for (const rec of records) {
      const prev = byId.get(rec.pair_id);
      if (!prev) {
        byId.set(rec.pair_id, rec);
        continue;
      }
      if (prev.label == null && rec.label != null) {
        byId.set(rec.pair_id, rec);
      } else if (prev.label != null && rec.label != null && prev.label !== rec.label) {
        conflicts++;
      }
    }
  }
  return { merged: [...byId.values()], conflicts };
}

/** Cohen's κ for two annotators over the same items (categorical labels). */
export function cohenKappa(pairs: ReadonlyArray<[string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  let agree = 0;
  const margin1 = new Map<string, number>();
  const margin2 = new Map<string, number>();
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    margin1.set(x, (margin1.get(x) ?? 0) + 1);
    margin2.set(y, (margin2.get(y) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [cls, c1] of margin1) {
    const c2 = margin2.get(cls) ?? 0;
    pe += (c1 / n) * (c2 / n);
  }
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

export interface EvaluatedRow {
  rec: EvalRecord;
  resolved: boolean;
  hasCandidate: boolean;
  candidateStatus: CandidateStatus | null;
  sharedQuestions: number;
  anchorShared: boolean | null; // null = no anchors in record
  sameSemanticEvent: boolean;
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

function ratio(numerator: number, denominator: number): RatioMetric {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

export interface SuiteMetrics {
  counts: {
    total: number;
    labeled: number;
    unlabeled_skipped: number;
    unresolved: number;
    evaluated: number;
  };
  stage3a: {
    positives: number;
    with_candidate: number;
    recall: RatioMetric;
    equivalent_only_recall: RatioMetric;
  };
  merge: {
    precision: RatioMetric; // TP / merged labeled pairs
    recall: RatioMetric; // merged equivalents / equivalents
    false_positive_pairs: number;
    fp_by_label: Record<string, number>;
    anchor_grain_recall: RatioMetric;
  };
  verification: {
    n: number;
    confusion: Record<string, Record<string, number>>; // status -> label -> n
    fp_rate: RatioMetric; // done & label != equivalent
    fn_rate: RatioMetric; // (skipped|failed) & label = equivalent
  };
  failure_modes: Record<
    string,
    { labeled: number; merge_fp: number; verification_fp: number; verification_fn: number }
  >;
  kappa: { n: number; kappa: number | null };
}

const POSITIVE_FOR_CANDIDATES: ReadonlyArray<EvalLabel> = [
  'equivalent',
  'subset_a_in_b',
  'subset_b_in_a',
];

export function computeMetrics(rows: ReadonlyArray<EvaluatedRow>, allParsed: number, unlabeled: number): SuiteMetrics {
  const labeledRows = rows.filter((r) => r.rec.label != null);
  const evaluated = labeledRows.filter((r) => r.resolved);
  const unresolved = labeledRows.length - evaluated.length;

  // (a) Stage-3a candidate recall
  const candPositives = evaluated.filter((r) => POSITIVE_FOR_CANDIDATES.includes(r.rec.label as EvalLabel));
  const candHits = candPositives.filter((r) => r.hasCandidate);
  const eqOnly = evaluated.filter((r) => r.rec.label === 'equivalent');
  const eqHits = eqOnly.filter((r) => r.hasCandidate);

  // (b) question-grain merge
  const mergedRows = evaluated.filter((r) => r.sharedQuestions > 0);
  const mergeTp = mergedRows.filter((r) => r.rec.label === 'equivalent');
  const mergeFp = mergedRows.filter((r) => r.rec.label !== 'equivalent');
  const equivalents = evaluated.filter((r) => r.rec.label === 'equivalent');
  const mergedEquivalents = equivalents.filter((r) => r.sharedQuestions > 0);
  const fpByLabel: Record<string, number> = {};
  for (const r of mergeFp) fpByLabel[r.rec.label as string] = (fpByLabel[r.rec.label as string] ?? 0) + 1;
  const anchored = equivalents.filter((r) => r.anchorShared !== null);
  const anchoredHit = anchored.filter((r) => r.anchorShared === true);

  // (c) Stage-3b verification
  const withCand = evaluated.filter((r) => r.hasCandidate && r.candidateStatus != null);
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of withCand) {
    const s = r.candidateStatus as string;
    const l = r.rec.label as string;
    confusion[s] = confusion[s] ?? {};
    confusion[s][l] = (confusion[s][l] ?? 0) + 1;
  }
  const done = withCand.filter((r) => r.candidateStatus === 'done');
  const doneFp = done.filter((r) => r.rec.label !== 'equivalent');
  const notDone = withCand.filter((r) => r.candidateStatus !== 'done');
  const notDoneEq = notDone.filter((r) => r.rec.label === 'equivalent');

  // failure-mode breakdown
  const fm: SuiteMetrics['failure_modes'] = {};
  for (const mode of FAILURE_MODES) {
    fm[mode] = { labeled: 0, merge_fp: 0, verification_fp: 0, verification_fn: 0 };
  }
  for (const r of evaluated) {
    for (const mode of r.rec.failure_modes ?? []) {
      if (!fm[mode]) fm[mode] = { labeled: 0, merge_fp: 0, verification_fp: 0, verification_fn: 0 };
      fm[mode].labeled++;
      if (r.sharedQuestions > 0 && r.rec.label !== 'equivalent') fm[mode].merge_fp++;
      if (r.candidateStatus === 'done' && r.rec.label !== 'equivalent') fm[mode].verification_fp++;
      if (r.hasCandidate && r.candidateStatus !== 'done' && r.rec.label === 'equivalent') fm[mode].verification_fn++;
    }
  }

  // (d) κ
  const kappaPairs: Array<[string, string]> = [];
  for (const r of labeledRows) {
    if (r.rec.annotator2_label != null && r.rec.label != null) {
      kappaPairs.push([r.rec.label, r.rec.annotator2_label]);
    }
  }

  return {
    counts: {
      total: allParsed,
      labeled: labeledRows.length,
      unlabeled_skipped: unlabeled,
      unresolved,
      evaluated: evaluated.length,
    },
    stage3a: {
      positives: candPositives.length,
      with_candidate: candHits.length,
      recall: ratio(candHits.length, candPositives.length),
      equivalent_only_recall: ratio(eqHits.length, eqOnly.length),
    },
    merge: {
      precision: ratio(mergeTp.length, mergedRows.length),
      recall: ratio(mergedEquivalents.length, equivalents.length),
      false_positive_pairs: mergeFp.length,
      fp_by_label: fpByLabel,
      anchor_grain_recall: ratio(anchoredHit.length, anchored.length),
    },
    verification: {
      n: withCand.length,
      confusion,
      fp_rate: ratio(doneFp.length, done.length),
      // FN rate: equivalent pairs that reached Stage 3b but were not matched,
      // over all equivalent pairs that have a candidate row.
      fn_rate: ratio(notDoneEq.length, countEquivWithCand(withCand)),
    },
    failure_modes: fm,
    kappa: { n: kappaPairs.length, kappa: cohenKappa(kappaPairs) },
  };
}

function countEquivWithCand(withCand: ReadonlyArray<EvaluatedRow>): number {
  return withCand.filter((r) => r.rec.label === 'equivalent').length;
}

export function formatRatio(m: RatioMetric): string {
  if (m.value == null) return `n/a (0 denominator)`;
  return `${(m.value * 100).toFixed(1)}% (${m.numerator}/${m.denominator})`;
}

// ---------------------------------------------------------------------------
// DB resolution
// ---------------------------------------------------------------------------

async function resolveSides(records: EvalRecord[]): Promise<Map<string, number>> {
  // natural key "platform:peid" -> current platform_events.id
  const keys = new Map<string, { platform: string; peid: string }>();
  for (const rec of records) {
    for (const side of [rec.side_a, rec.side_b]) {
      keys.set(`${side.platform}:${side.platform_event_id}`, {
        platform: side.platform,
        peid: side.platform_event_id,
      });
    }
  }
  const keyList = [...keys.values()];
  const out = new Map<string, number>();
  if (keyList.length === 0) return out;
  const rows = await query<{ id: number; platform: string; platform_event_id: string }>(
    `SELECT pe.id, pe.platform, pe.platform_event_id
     FROM platform_events pe
     JOIN unnest($1::text[], $2::text[]) AS k(platform, peid)
       ON pe.platform = k.platform AND pe.platform_event_id = k.peid`,
    [keyList.map((k) => k.platform), keyList.map((k) => k.peid)],
  );
  for (const r of rows) out.set(`${r.platform}:${r.platform_event_id}`, r.id);

  // Fallback: resolve missing sides through their child markets' platform_ids
  // (covers platform_event_id format drift across rebuilds).
  const missing = records
    .flatMap((rec) => [rec.side_a, rec.side_b])
    .filter((s) => !out.has(`${s.platform}:${s.platform_event_id}`) && s.child_markets?.length > 0);
  if (missing.length > 0) {
    const plat: string[] = [];
    const mid: string[] = [];
    const owner: string[] = [];
    for (const s of missing) {
      for (const c of s.child_markets.slice(0, 3)) {
        plat.push(s.platform);
        mid.push(c.platform_id);
        owner.push(`${s.platform}:${s.platform_event_id}`);
      }
    }
    const rows2 = await query<{ owner: string; pe_id: number | null }>(
      `SELECT k.owner, pe.id AS pe_id
       FROM unnest($1::text[], $2::text[], $3::text[]) AS k(platform, platform_id, owner)
       JOIN markets m ON m.platform = k.platform AND m.platform_id = k.platform_id
       JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id`,
      [plat, mid, owner],
    );
    for (const r of rows2) {
      if (r.pe_id != null && !out.has(r.owner)) out.set(r.owner, r.pe_id);
    }
  }
  return out;
}

async function fetchCandidateRows(
  pairs: Array<{ pairId: string; aId: number; bId: number }>,
): Promise<Map<string, { status: CandidateStatus; candId: number }>> {
  const out = new Map<string, { status: CandidateStatus; candId: number }>();
  if (pairs.length === 0) return out;
  const rows = await query<{ pair_id: string; status: CandidateStatus; cand_id: number }>(
    `
    WITH pairs AS (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]) AS t(pair_id, a_id, b_id))
    SELECT p.pair_id, c.status, c.id AS cand_id
    FROM pairs p
    JOIN stage3_event_candidates c
      ON (c.platform_event_a = p.a_id AND c.platform_event_b = p.b_id)
      OR (c.platform_event_a = p.b_id AND c.platform_event_b = p.a_id)
    `,
    [pairs.map((p) => p.pairId), pairs.map((p) => p.aId), pairs.map((p) => p.bId)],
  );
  for (const r of rows) {
    const prev = out.get(r.pair_id);
    if (!prev || r.cand_id > prev.candId) out.set(r.pair_id, { status: r.status, candId: r.cand_id });
  }
  return out;
}

async function fetchSharedQuestions(
  pairs: Array<{ pairId: string; aId: number; bId: number }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const rows = await query<{ pair_id: string; shared: number }>(
    `
    WITH pairs AS (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]) AS t(pair_id, a_id, b_id))
    SELECT p.pair_id, count(DISTINCT qa.question_id)::int AS shared
    FROM pairs p
    JOIN platform_events pa ON pa.id = p.a_id
    JOIN platform_events pb ON pb.id = p.b_id
    JOIN markets ma ON ma.platform = pa.platform AND ma.platform_event_id = pa.platform_event_id
    JOIN question_members qa ON qa.market_id = ma.id
    JOIN question_members qb ON qb.question_id = qa.question_id
    JOIN markets mb ON mb.id = qb.market_id
      AND mb.platform = pb.platform AND mb.platform_event_id = pb.platform_event_id
    GROUP BY 1
    `,
    [pairs.map((p) => p.pairId), pairs.map((p) => p.aId), pairs.map((p) => p.bId)],
  );
  for (const r of rows) out.set(r.pair_id, r.shared);
  return out;
}

async function fetchAnchorShared(
  anchors: Array<{ pairId: string; aPlatform: string; aMid: string; bPlatform: string; bMid: string }>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (anchors.length === 0) return out;
  const rows = await query<{ pair_id: string; shared: boolean }>(
    `
    WITH anchors AS (
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
        AS t(pair_id, a_platform, a_mid, b_platform, b_mid)
    )
    SELECT a.pair_id, bool_or(
      EXISTS (
        SELECT 1
        FROM markets ma
        JOIN question_members qa ON qa.market_id = ma.id
        JOIN question_members qb ON qb.question_id = qa.question_id
        JOIN markets mb ON mb.id = qb.market_id
        WHERE ma.platform = a.a_platform AND ma.platform_id = a.a_mid
          AND mb.platform = a.b_platform AND mb.platform_id = a.b_mid
      )
    ) AS shared
    FROM anchors a
    GROUP BY 1
    `,
    [
      anchors.map((a) => a.pairId),
      anchors.map((a) => a.aPlatform),
      anchors.map((a) => a.aMid),
      anchors.map((a) => a.bPlatform),
      anchors.map((a) => a.bMid),
    ],
  );
  for (const r of rows) out.set(r.pair_id, r.shared);
  return out;
}

async function fetchSameSemanticEvent(
  pairs: Array<{ pairId: string; aId: number; bId: number }>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (pairs.length === 0) return out;
  const rows = await query<{ pair_id: string; same: boolean }>(
    `
    WITH pairs AS (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]) AS t(pair_id, a_id, b_id))
    SELECT p.pair_id, EXISTS (
      SELECT 1
      FROM semantic_event_platforms sa
      JOIN semantic_event_platforms sb ON sb.semantic_event_id = sa.semantic_event_id
      WHERE sa.platform_event_id = p.a_id AND sb.platform_event_id = p.b_id
    ) AS same
    FROM pairs p
    `,
    [pairs.map((p) => p.pairId), pairs.map((p) => p.aId), pairs.map((p) => p.bId)],
  );
  for (const r of rows) out.set(r.pair_id, r.same);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function parseArgs(argv: string[]): {
  files: string[];
  assertMinPrecision: number | null;
  assertMinRecall: number | null;
  json: boolean;
} {
  const files: string[] = [];
  let assertMinPrecision: number | null = null;
  let assertMinRecall: number | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') files.push(argv[++i]);
    else if (a === '--assert-min-precision') assertMinPrecision = Number(argv[++i]);
    else if (a === '--assert-min-recall') assertMinRecall = Number(argv[++i]);
    else if (a === '--json') json = true;
  }
  return { files, assertMinPrecision, assertMinRecall, json };
}

async function main(): Promise<void> {
  const { files, assertMinPrecision, assertMinRecall, json } = parseArgs(process.argv.slice(2));
  const evalDir = path.join(repoRoot(), 'data', 'eval', 'xplat-equivalence');
  const inputFiles =
    files.length > 0
      ? files.map((f) => path.resolve(f))
      : ['v1.seed.jsonl', 'v1.jsonl', 'v1.todo.jsonl'].map((f) => path.join(evalDir, f)).filter((f) => existsSync(f));
  if (inputFiles.length === 0) {
    console.error(`No input files found (looked in ${evalDir}). Run build-eval-sample.ts first or pass --file.`);
    process.exitCode = 2;
    return;
  }
  console.log(`run-eval-suite: files =`);
  let badLines = 0;
  const perFile: EvalRecord[][] = [];
  for (const f of inputFiles) {
    if (!existsSync(f)) {
      console.error(`  missing: ${f}`);
      process.exitCode = 2;
      return;
    }
    const parsed = parseJsonl(readFileSync(f, 'utf8'));
    badLines += parsed.badLines;
    perFile.push(parsed.records);
    console.log(`  ${f}  (${parsed.records.length} records, ${parsed.badLines} bad lines)`);
  }
  const { merged, conflicts } = mergeRecords(perFile);
  if (conflicts > 0) console.warn(`WARNING: ${conflicts} pair_id(s) carry conflicting labels across files; first kept.`);

  const labeled = merged.filter((r) => r.label != null);
  const unlabeled = merged.length - labeled.length;
  if (labeled.length === 0) {
    console.error('No labeled rows found — nothing to evaluate.');
    process.exitCode = 2;
    return;
  }

  // sanity: recompute pair ids from natural keys (defends against hand-edits)
  let pairIdMismatches = 0;
  for (const r of labeled) {
    if (pairIdFor(r.side_a, r.side_b) !== r.pair_id) pairIdMismatches++;
  }
  if (pairIdMismatches > 0) {
    console.warn(`WARNING: ${pairIdMismatches} labeled record(s) have pair_id != md5(natural keys) — check hand edits.`);
  }

  // natural-key -> current id resolution
  const sideIds = await resolveSides(labeled);
  const resolvedPairs: Array<{ pairId: string; aId: number; bId: number }> = [];
  const rowsByPairId = new Map<string, EvalRecord>();
  for (const r of labeled) {
    rowsByPairId.set(r.pair_id, r);
    const aId = sideIds.get(`${r.side_a.platform}:${r.side_a.platform_event_id}`);
    const bId = sideIds.get(`${r.side_b.platform}:${r.side_b.platform_event_id}`);
    if (aId != null && bId != null) resolvedPairs.push({ pairId: r.pair_id, aId, bId });
  }

  const [candRows, sharedQ, sameSe] = await Promise.all([
    fetchCandidateRows(resolvedPairs),
    fetchSharedQuestions(resolvedPairs),
    fetchSameSemanticEvent(resolvedPairs),
  ]);

  const anchorInputs: Array<{ pairId: string; aPlatform: string; aMid: string; bPlatform: string; bMid: string }> = [];
  for (const r of labeled) {
    for (const a of r.context.anchor_market_pairs ?? []) {
      anchorInputs.push({
        pairId: r.pair_id,
        aPlatform: r.side_a.platform,
        aMid: a.a_platform_id,
        bPlatform: r.side_b.platform,
        bMid: a.b_platform_id,
      });
    }
  }
  const anchorShared = await fetchAnchorShared(anchorInputs);

  const resolvedSet = new Set(resolvedPairs.map((p) => p.pairId));
  const evaluatedRows: EvaluatedRow[] = labeled.map((rec) => {
    const resolved = resolvedSet.has(rec.pair_id);
    const cand = candRows.get(rec.pair_id) ?? null;
    return {
      rec,
      resolved,
      hasCandidate: cand != null,
      candidateStatus: cand?.status ?? null,
      sharedQuestions: sharedQ.get(rec.pair_id) ?? 0,
      anchorShared: rec.context.anchor_market_pairs?.length ? (anchorShared.get(rec.pair_id) ?? false) : null,
      sameSemanticEvent: sameSe.get(rec.pair_id) ?? false,
    };
  });

  const metrics = computeMetrics(evaluatedRows, merged.length, unlabeled);
  if (badLines > 0) console.warn(`WARNING: ${badLines} unparseable line(s) skipped.`);

  if (json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    printMetrics(metrics);
  }

  // asserts (CI gate on the question-grain merge metrics)
  let assertFailed = false;
  if (assertMinPrecision != null) {
    const v = metrics.merge.precision.value;
    if (v == null || v < assertMinPrecision) {
      console.error(`ASSERT FAIL: merge precision ${v == null ? 'n/a' : v.toFixed(3)} < ${assertMinPrecision}`);
      assertFailed = true;
    } else {
      console.log(`assert ok: merge precision ${v.toFixed(3)} >= ${assertMinPrecision}`);
    }
  }
  if (assertMinRecall != null) {
    const v = metrics.merge.recall.value;
    if (v == null || v < assertMinRecall) {
      console.error(`ASSERT FAIL: merge recall ${v == null ? 'n/a' : v.toFixed(3)} < ${assertMinRecall}`);
      assertFailed = true;
    } else {
      console.log(`assert ok: merge recall ${v.toFixed(3)} >= ${assertMinRecall}`);
    }
  }
  if (assertFailed) process.exitCode = 1;
}

function printMetrics(m: SuiteMetrics): void {
  console.log('\n== counts ==');
  console.table([m.counts]);
  console.log('== (a) Stage-3a candidate recall (labeled positives = equivalent + subset) ==');
  console.log(`  any-status candidate row exists: ${formatRatio(m.stage3a.recall)}`);
  console.log(`  equivalent-only:                 ${formatRatio(m.stage3a.equivalent_only_recall)}`);
  console.log('== (b) end-to-end question-grain merge ==');
  console.log(`  precision (merged & equivalent / merged): ${formatRatio(m.merge.precision)}`);
  console.log(`  recall    (equivalent merged / equivalent): ${formatRatio(m.merge.recall)}`);
  console.log(`  merge false positives: ${m.merge.false_positive_pairs} ${JSON.stringify(m.merge.fp_by_label)}`);
  console.log(`  anchor-market-grain recall (where anchors): ${formatRatio(m.merge.anchor_grain_recall)}`);
  console.log('== (c) Stage-3b verification vs labels (pairs with candidate row) ==');
  console.log(`  n = ${m.verification.n}`);
  for (const [status, byLabel] of Object.entries(m.verification.confusion)) {
    console.log(`  ${status}: ${JSON.stringify(byLabel)}`);
  }
  console.log(`  FP rate (done & not equivalent / done):    ${formatRatio(m.verification.fp_rate)}`);
  console.log(`  FN rate (not-done & equivalent / equivalent-with-candidate): ${formatRatio(m.verification.fn_rate)}`);
  console.log('== failure-mode breakdown ==');
  console.table(
    Object.entries(m.failure_modes).map(([mode, v]) => ({ mode, ...v })),
  );
  console.log('== κ (double-annotated subset) ==');
  console.log(
    m.kappa.kappa == null ? `  n=${m.kappa.n} — not computable yet` : `  n=${m.kappa.n}, Cohen's κ = ${m.kappa.kappa.toFixed(3)}`,
  );
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
