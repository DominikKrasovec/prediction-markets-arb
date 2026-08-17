/**
 * Offline regex pattern induction. Runs outside the live pipeline: collects
 * LLM-normalized market titles, groups them by surface skeleton, and asks the
 * LLM to propose a named-capture-group regex per cluster. Each proposal is
 * validated for recall, precision (against other clusters), capture
 * correctness (field_mapping reproduces the known value_primary), and a ReDoS
 * screen. Output is a JSON report; a human folds accepted regexes into
 * kalshi-deterministic.ts / text-deterministic.ts. Pure read + report —
 * nothing here writes runtime state.
 *
 * Run: npx tsx services/pipeline/src/scripts/induce-regex-patterns.ts
 *   --min-cluster-size 30 --max-clusters 40 --output <path>
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve as pathResolve } from 'path';
import { pathToFileURL } from 'url';
import { query, endPool } from '@arb/db';
import { callLLM, loadPromptTemplate } from '@arb/llm';
import { mapWithConcurrency } from '../util/concurrency.js';
import { createLogger } from '@arb/logger';

const promptTemplate = loadPromptTemplate('regex_induction');
const log = createLogger('regex-induction');

type Mode = 'induce' | 'export' | 'validate';
interface CliOpts {
  mode: Mode;
  minClusterSize: number;
  maxClusters: number;
  examplesPerCluster: number;
  negativesPerCluster: number;
  output: string;
  proposals: string | null;
  llmConcurrency: number;
}

function parseArgs(argv: string[]): CliOpts {
  const get = (flag: string, def: string): string => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : def;
  };
  return {
    mode:                (get('--mode', 'induce') as Mode),
    minClusterSize:      parseInt(get('--min-cluster-size', '30')),
    maxClusters:         parseInt(get('--max-clusters', '40')),
    examplesPerCluster:  parseInt(get('--examples-per-cluster', '20')),
    negativesPerCluster: parseInt(get('--negatives-per-cluster', '5')),
    output:              get('--output', 'data/exports/regex-induction-report.json'),
    proposals:           get('--proposals', '') || null,
    llmConcurrency:      parseInt(get('--llm-concurrency', '4')),
  };
}

interface MarketRow {
  market_id: number;
  platform: string;
  title: string;
  canonical_subject: string | null;
  value_primary: number | null;
  value_unit: string | null;
  condition_shape: string | null;
  event_kind: string | null;
  category_unified: string | null;
  resolution_source: string | null;
}

// Collapses letter/digit runs into class placeholders while preserving
// punctuation and stop-words, so two titles with the same surface structure
// cluster together. Numbers → N, letter runs ≥2 chars → WORD.
const STOP_TOKENS = new Set(['will', 'vs', 'v', 'or', 'to', 'by', 'the', 'a', 'an', 'and', 'over', 'under', 'above', 'below', 'on', 'in', 'for', 'of', 'reach', 'reaches', 'beat', 'defeat', 'win', 'wins']);

function skeletonize(title: string): string {
  const trimmed = title.trim();
  const parts: string[] = [];
  let buf = '';
  const flush = () => { if (buf.length > 0) { parts.push(buf); buf = ''; } };
  for (const ch of trimmed) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      buf += ch;
    } else {
      flush();
      if (!/\s/.test(ch)) parts.push(ch);
    }
  }
  flush();

  return parts.map((tok) => {
    if (/^\d+$/.test(tok)) return 'N';
    if (/^\d+\.\d+$/.test(tok)) return 'N.N';
    if (/^[A-Z]{2,6}$/.test(tok)) return 'CAPS';
    const lc = tok.toLowerCase();
    if (STOP_TOKENS.has(lc)) return lc;
    if (/^[a-zA-Z]{2,}$/.test(tok)) return 'WORD';
    if (/^[a-zA-Z]$/.test(tok)) return tok.toLowerCase();
    return tok;
  }).join(' ');
}

interface Cluster {
  skeleton: string;
  members: MarketRow[];
}

async function loadCandidateMarkets(): Promise<MarketRow[]> {
  // Markets the LLM normalized, not claimed by a deterministic extractor
  // (match_source, not resolution_source).
  const rows = await query<MarketRow>(
    `SELECT m.id AS market_id,
            m.platform,
            m.title,
            n.canonical_subject,
            n.value_primary,
            n.value_unit,
            n.condition_shape,
            n.event_kind,
            m.category_unified,
            n.resolution_source
     FROM markets m
     JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE n.confidence >= 0.5
       AND n.canonical_event IS NOT NULL
       AND n.canonical_event <> '__extraction_failed__'
       AND n.condition_shape IS NOT NULL
       AND COALESCE(n.match_source, '') NOT LIKE 'text-deterministic%'
       AND COALESCE(n.match_source, '') NOT LIKE 'kalshi:%'`,
  );
  return rows;
}

function buildClusters(rows: MarketRow[], minSize: number): Cluster[] {
  const m = new Map<string, MarketRow[]>();
  for (const r of rows) {
    const sk = skeletonize(r.title);
    const bucket = m.get(sk);
    if (bucket) bucket.push(r);
    else m.set(sk, [r]);
  }
  const clusters: Cluster[] = [];
  for (const [skeleton, members] of m) {
    if (members.length >= minSize) clusters.push({ skeleton, members });
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters;
}

function sampleNegatives(clusters: Cluster[], excludeIdx: number, count: number): MarketRow[] {
  const out: MarketRow[] = [];
  for (let i = 0; i < clusters.length && out.length < count; i++) {
    if (i === excludeIdx) continue;
    const c = clusters[i];
    out.push(c.members[Math.floor(c.members.length / 2)]);
  }
  return out.slice(0, count);
}

interface InductionResult {
  regex: string;
  flags: string;
  named_groups: string[];
  field_mapping: Record<string, unknown>;
  condition_shape?: string;
  event_kind?: string;
  value_unit_post?: Record<string, number>;
  platforms?: string[];
  category_unified?: string | null;
  expected_match_rate: number;
  notes: string;
}

interface ValidationStats {
  recall: number;
  precision: number;
  matchedExamples: number;
  totalExamples: number;
  matchedNegatives: number;
  totalNegatives: number;
  capturedFields: Record<string, string[]>;
  valueChecked: number;
  valueCorrect: number;
  valueAccuracy: number;
  errors: string[];
}

// Heuristic ReDoS screen: flags nested/adjacent unbounded quantifiers before
// running the regex against a title. Not exhaustive (use RE2 for a hard guarantee).
export function looksCatastrophic(src: string): boolean {
  if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(src)) return true;
  if (/[+*]\s*\)\s*[+*]/.test(src)) return true;
  return false;
}

// Returns null when the mapping doesn't extract a numeric value, so those
// clusters skip the value-accuracy gate rather than failing it.
export function computeCapturedValue(
  groups: Record<string, string | undefined>,
  mapping: Record<string, unknown>,
  post: Record<string, number> | undefined,
): number | null {
  const vKey = mapping.value_primary_raw as string | undefined;
  if (!vKey) return null;
  const raw = groups[vKey];
  if (raw == null) return null;
  const n = parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  let mult = 1;
  const uKey = mapping.value_unit_group as string | undefined;
  const unitStr = uKey ? groups[uKey] : undefined;
  if (post && unitStr) {
    const hit = Object.keys(post).find((k) => k.toLowerCase() === unitStr.toLowerCase());
    if (hit) mult = post[hit];
  }
  return n * mult;
}

function numClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 + 1e-4 * Math.max(Math.abs(a), Math.abs(b));
}

export function isAccepted(v: ValidationStats | null): boolean {
  return !!v && v.recall >= 0.6 && v.precision >= 0.95
    && v.valueAccuracy >= 0.9 && !v.errors.includes('validation_timeout');
}

const VALIDATE_BUDGET_MS = 2000;

function validate(induction: InductionResult, cluster: Cluster, negatives: MarketRow[]): ValidationStats {
  const errors: string[] = [];
  const capturedFields: Record<string, string[]> = {};
  const base = {
    matchedExamples: 0, totalExamples: cluster.members.length,
    matchedNegatives: 0, totalNegatives: negatives.length,
    capturedFields, valueChecked: 0, valueCorrect: 0, valueAccuracy: 1,
  };
  if (!induction.regex || induction.regex.trim() === '') {
    return { recall: 0, precision: 1, ...base, errors: ['empty_regex'] };
  }
  if (looksCatastrophic(induction.regex)) {
    return { recall: 0, precision: 0, ...base, errors: ['catastrophic_regex'] };
  }
  let rx: RegExp;
  try {
    // Strip g/y: stateful lastIndex would corrupt repeated .test() calls.
    rx = new RegExp(induction.regex, (induction.flags ?? 'i').replace(/[gy]/g, ''));
  } catch (err) {
    return { recall: 0, precision: 0, ...base, errors: [`invalid_regex: ${err}`] };
  }
  const started = Date.now();
  let matched = 0;
  let valueChecked = 0;
  let valueCorrect = 0;
  for (const m of cluster.members) {
    if (Date.now() - started > VALIDATE_BUDGET_MS) { errors.push('validation_timeout'); break; }
    const hit = m.title.match(rx);
    if (!hit) continue;
    matched++;
    if (hit.groups) {
      for (const [g, v] of Object.entries(hit.groups)) {
        if (!capturedFields[g]) capturedFields[g] = [];
        if (capturedFields[g].length < 5 && v !== undefined) capturedFields[g].push(v);
      }
      if (m.value_primary != null) {
        const got = computeCapturedValue(hit.groups, induction.field_mapping as Record<string, unknown>, induction.value_unit_post);
        if (got != null) {
          valueChecked++;
          if (numClose(got, m.value_primary)) valueCorrect++;
        }
      }
    }
  }
  let negMatched = 0;
  for (const n of negatives) {
    if (Date.now() - started > VALIDATE_BUDGET_MS) { errors.push('validation_timeout'); break; }
    if (rx.test(n.title)) negMatched++;
  }
  return {
    recall:    cluster.members.length > 0 ? matched / cluster.members.length : 0,
    precision: negatives.length > 0 ? 1 - negMatched / negatives.length : 1,
    matchedExamples: matched,
    totalExamples:   cluster.members.length,
    matchedNegatives: negMatched,
    totalNegatives:   negatives.length,
    capturedFields,
    valueChecked,
    valueCorrect,
    valueAccuracy: valueChecked > 0 ? valueCorrect / valueChecked : 1,
    errors,
  };
}

async function induceForCluster(cluster: Cluster, negatives: MarketRow[], opts: CliOpts): Promise<InductionResult | null> {
  const N = Math.min(opts.examplesPerCluster, cluster.members.length);
  const stride = Math.max(1, Math.floor(cluster.members.length / N));
  const sampled: MarketRow[] = [];
  for (let i = 0; i < cluster.members.length && sampled.length < N; i += stride) {
    sampled.push(cluster.members[i]);
  }

  try {
    const { parsed } = await callLLM<InductionResult>({
      task: 'regex_induction',
      template: promptTemplate,
      vars: {
        count: sampled.length,
        examples: sampled.map((m) => ({
          platform:           m.platform,
          title:              m.title,
          canonical_subject:  m.canonical_subject ?? '',
          value_primary_or_null: m.value_primary == null ? 'null' : m.value_primary.toString(),
          value_unit_or_null:    m.value_unit == null ? 'null' : m.value_unit,
          condition_shape:    m.condition_shape ?? 'null',
          event_kind:         m.event_kind ?? 'null',
          category_unified:   m.category_unified ?? 'null',
        })),
        negatives: negatives.map((n) => ({ title: n.title })),
      },
      context: { clusterSize: cluster.members.length, skeleton: cluster.skeleton },
    });
    if (!parsed) throw new Error('no parsed response');
    return parsed;
  } catch (err) {
    log.warn(`LLM failed for cluster size=${cluster.members.length}: ${err}`);
    return null;
  }
}

function sampleSpread(cluster: Cluster, n: number): MarketRow[] {
  const N = Math.min(n, cluster.members.length);
  if (N <= 0) return [];
  const stride = Math.max(1, Math.floor(cluster.members.length / N));
  const out: MarketRow[] = [];
  for (let i = 0; i < cluster.members.length && out.length < N; i += stride) out.push(cluster.members[i]);
  return out;
}

// A broad negative pool for --mode validate, not LLM-bound.
function sampleNegativesBroad(rows: MarketRow[], cluster: Cluster, count: number): MarketRow[] {
  const pool = rows.filter((r) => skeletonize(r.title) !== cluster.skeleton);
  pool.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  if (pool.length <= count) return pool;
  const stride = Math.max(1, Math.floor(pool.length / count));
  const out: MarketRow[] = [];
  for (let i = 0; i < pool.length && out.length < count; i += stride) out.push(pool[i]);
  return out;
}

interface ReportItem {
  skeleton: string;
  cluster_size: number;
  sampled_titles: string[];
  induction: InductionResult | null;
  validation: ValidationStats | null;
  rejected_reason?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  log.info(`Loading LLM-normalized markets (mode=${opts.mode})...`);
  const rows = await loadCandidateMarkets();
  log.info(`${rows.length} markets in scope (LLM-normalized, confidence ≥ 0.5)`);
  const allClusters = buildClusters(rows, opts.minClusterSize);
  log.info(`${allClusters.length} clusters of size ≥ ${opts.minClusterSize}`);
  const clusters = allClusters.slice(0, opts.maxClusters);

  if (opts.mode === 'export') return runExport(clusters, allClusters, rows, opts);
  if (opts.mode === 'validate') return runValidate(clusters, rows, opts);
  return runInduce(clusters, allClusters, rows, opts);
}

// export: cluster the gap titles and dump examples + negatives to JSON, no
// LLM. A human authors regex proposals from this file, then runs --mode validate.
function runExport(clusters: Cluster[], allClusters: Cluster[], rows: MarketRow[], opts: CliOpts): void {
  const out = clusters.map((c, idx) => ({
    skeleton: c.skeleton,
    cluster_size: c.members.length,
    examples: sampleSpread(c, opts.examplesPerCluster).map((m) => ({
      title: m.title, platform: m.platform,
      canonical_subject: m.canonical_subject, value_primary: m.value_primary,
      value_unit: m.value_unit, condition_shape: m.condition_shape,
      event_kind: m.event_kind, category_unified: m.category_unified,
    })),
    negatives: sampleNegatives(clusters, idx, opts.negativesPerCluster).map((n) => n.title),
  }));
  const outPath = pathResolve(process.cwd(), opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    total_markets_scanned: rows.length,
    clusters_total: allClusters.length,
    clusters_exported: out.length,
    clusters: out,
  }, null, 2));
  log.info(`Exported ${out.length} clusters (NO LLM) → ${outPath}. Author proposals ` +
    `[{ "skeleton", "induction": { regex, flags, named_groups, field_mapping, value_unit_post? } }], ` +
    `then run --mode validate --proposals <file>.`);
}

// validate: runs hand-authored --proposals (JSON array of {skeleton,
// induction}) through the same gates as induce, no LLM.
function runValidate(clusters: Cluster[], rows: MarketRow[], opts: CliOpts): void {
  if (!opts.proposals) throw new Error('--mode validate requires --proposals <file.json>');
  const proposals = JSON.parse(readFileSync(pathResolve(process.cwd(), opts.proposals), 'utf8')) as
    Array<{ skeleton: string; induction: InductionResult }>;
  const bySkeleton = new Map(clusters.map((c) => [c.skeleton, c]));
  const NEG = Math.max(opts.negativesPerCluster, 200);

  const report = proposals.map((p) => {
    const c = bySkeleton.get(p.skeleton);
    if (!c) return { skeleton: p.skeleton, error: 'cluster_not_found_in_current_data', accepted: false, validation: null, induction: p.induction };
    const validation = validate(p.induction, c, sampleNegativesBroad(rows, c, NEG));
    return { skeleton: p.skeleton, cluster_size: c.members.length, accepted: isAccepted(validation), validation, induction: p.induction };
  });
  report.sort((a, b) => (a.accepted === b.accepted ? 0 : a.accepted ? -1 : 1));

  const outPath = pathResolve(process.cwd(), opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: 'validate', proposals_file: opts.proposals, negatives_per_proposal: NEG,
    accepted: report.filter((r) => r.accepted).length,
    report,
  }, null, 2));
  const acc = report.filter((r) => r.accepted).length;
  log.info(`Validated ${report.length} proposals (${acc} accepted: recall≥0.6, precision≥0.95 over ${NEG} negatives, value-accuracy≥0.9) → ${outPath}`);
}

// induce (legacy): DeepSeek proposes per cluster. Prefer export→author→validate.
async function runInduce(clusters: Cluster[], allClusters: Cluster[], rows: MarketRow[], opts: CliOpts): Promise<void> {
  log.info(`Inducing regex for top ${clusters.length} clusters via LLM (legacy proposer)`);
  const reportItems = await mapWithConcurrency(
    clusters.map((c, idx) => ({ c, idx })),
    opts.llmConcurrency,
    async ({ c, idx }): Promise<ReportItem> => {
      const negatives = sampleNegatives(clusters, idx, opts.negativesPerCluster);
      const induction = await induceForCluster(c, negatives, opts);
      if (!induction) {
        return { skeleton: c.skeleton, cluster_size: c.members.length, sampled_titles: c.members.slice(0, 3).map((m) => m.title), induction: null, validation: null, rejected_reason: 'llm_failed' };
      }
      const validation = validate(induction, c, negatives);
      return { skeleton: c.skeleton, cluster_size: c.members.length, sampled_titles: c.members.slice(0, 3).map((m) => m.title), induction, validation };
    },
  );
  reportItems.sort((a, b) => {
    const aGood = isAccepted(a.validation) ? 1 : 0;
    const bGood = isAccepted(b.validation) ? 1 : 0;
    if (aGood !== bGood) return bGood - aGood;
    return b.cluster_size - a.cluster_size;
  });
  const outPath = pathResolve(process.cwd(), opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    total_markets_scanned: rows.length,
    clusters_total: allClusters.length,
    clusters_processed: reportItems.length,
    accepted: reportItems.filter((r) => isAccepted(r.validation)).length,
    report: reportItems,
  }, null, 2));
  const accepted = reportItems.filter((r) => isAccepted(r.validation)).length;
  log.info(`Wrote ${reportItems.length} clusters (${accepted} accepted) → ${outPath}`);
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      log.error('fatal:', err);
      process.exitCode = 1;
    })
    .finally(() => endPool());
}
