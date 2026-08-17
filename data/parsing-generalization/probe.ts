/**
 * Parsing-generalization probe (READ-ONLY).
 *
 * Tests the distillation hypothesis: can a cheap classifier trained on the
 * Stage-1 *rules'* outputs (regex/kalshi-deterministic labels) predict the right
 * categorical slot on the titles the rules COULDN'T parse (the LLM-labeled tail)?
 *
 * Features  = markets.embedding (already computed; no GPU, no API call here).
 * Labels    = llm_market_normalizations.<target> (condition_shape | event_kind).
 * Source    = llm_market_normalizations.match_source ('text-deterministic-*' /
 *             'kalshi:*' = rules ; 'llm-*' = the tail).
 *
 * Models: multinomial logistic regression (JS, mini-batch Adam) + kNN via the
 * pgvector HNSW index. No writes to live tables, no schema changes.
 *
 * Usage:
 *   npx tsx data/parsing-generalization/probe.ts stats
 *   npx tsx data/parsing-generalization/probe.ts run --target condition_shape
 *   npx tsx data/parsing-generalization/probe.ts run --target event_kind
 */
import pg from 'pg';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIM = 1536;

// ── label-source SQL predicates ──────────────────────────────────────────────
const RULES_SRC = `(n.match_source LIKE 'text-deterministic-%' OR n.match_source LIKE 'kalshi:%')`;
const LLM_SRC = `(n.match_source LIKE 'llm-%')`;
const ANY_SRC = `(${RULES_SRC} OR ${LLM_SRC})`;

function makePool(): pg.Pool {
  return new pg.Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'prediction_arb',
    user: process.env.PG_USER || 'arb',
    password: process.env.PG_PASSWORD || 'arb_local_dev',
    max: 8,
  });
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function argn(name: string, dflt: number): number {
  const v = arg(name, String(dflt));
  return parseInt(v, 10);
}

const ALLOWED_TARGETS = new Set(['condition_shape', 'event_kind', 'condition_direction', 'temporal_semantics']);

// ── data row ──────────────────────────────────────────────────────────────────
interface Row { x: Float32Array; y: string }

function parseEmb(text: string): Float32Array {
  // text is "[a,b,c,...]"
  const inner = text.slice(1, -1);
  const parts = inner.split(',');
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = parseFloat(parts[i]);
  return out;
}

async function load(pool: pg.Pool, target: string, srcPredicate: string, cap: number): Promise<Row[]> {
  const res = await pool.query<{ emb: string; y: string }>(
    `SELECT m.embedding::text AS emb, n.${target} AS y
       FROM markets m
       JOIN llm_market_normalizations n ON n.market_id = m.id
      WHERE m.embedding IS NOT NULL
        AND n.${target} IS NOT NULL
        AND ${srcPredicate}
      ORDER BY md5(m.id::text)
      LIMIT $1`,
    [cap]);
  return res.rows.map(r => ({ x: parseEmb(r.emb), y: r.y }));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Multinomial logistic regression (mini-batch Adam) — pure JS, CPU.
// ═══════════════════════════════════════════════════════════════════════════
class LogReg {
  classes: string[];
  idx: Map<string, number>;
  W: Float32Array; // C * DIM
  b: Float32Array; // C
  private mW: Float32Array; private vW: Float32Array;
  private mB: Float32Array; private vB: Float32Array;

  constructor(classes: string[]) {
    this.classes = classes;
    this.idx = new Map(classes.map((c, i) => [c, i]));
    const C = classes.length;
    this.W = new Float32Array(C * DIM);
    this.b = new Float32Array(C);
    this.mW = new Float32Array(C * DIM); this.vW = new Float32Array(C * DIM);
    this.mB = new Float32Array(C); this.vB = new Float32Array(C);
  }

  private logits(x: Float32Array, out: Float32Array): void {
    const C = this.classes.length;
    for (let c = 0; c < C; c++) {
      let s = this.b[c];
      const base = c * DIM;
      for (let d = 0; d < DIM; d++) s += this.W[base + d] * x[d];
      out[c] = s;
    }
  }

  private softmax(z: Float32Array): void {
    let mx = -Infinity;
    for (let i = 0; i < z.length; i++) if (z[i] > mx) mx = z[i];
    let sum = 0;
    for (let i = 0; i < z.length; i++) { z[i] = Math.exp(z[i] - mx); sum += z[i]; }
    for (let i = 0; i < z.length; i++) z[i] /= sum;
  }

  /** Train with mini-batch Adam + L2. Returns wall-clock ms. */
  train(rows: Row[], epochs = 12, batch = 512, lr = 0.05, l2 = 1e-4): number {
    const t0 = Date.now();
    const C = this.classes.length;
    const n = rows.length;
    const order = [...Array(n).keys()];
    const z = new Float32Array(C);
    const gW = new Float32Array(C * DIM);
    const gB = new Float32Array(C);
    let step = 0;
    const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;

    for (let ep = 0; ep < epochs; ep++) {
      // shuffle (deterministic-ish LCG so runs are reproducible)
      let seed = 1234567 + ep;
      for (let i = n - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let bStart = 0; bStart < n; bStart += batch) {
        gW.fill(0); gB.fill(0);
        const bEnd = Math.min(bStart + batch, n);
        const m = bEnd - bStart;
        for (let bi = bStart; bi < bEnd; bi++) {
          const row = rows[order[bi]];
          const yi = this.idx.get(row.y)!;
          this.logits(row.x, z);
          this.softmax(z);
          for (let c = 0; c < C; c++) {
            const g = z[c] - (c === yi ? 1 : 0);
            gB[c] += g;
            const base = c * DIM;
            const x = row.x;
            for (let d = 0; d < DIM; d++) gW[base + d] += g * x[d];
          }
        }
        step++;
        const bc1 = 1 - Math.pow(beta1, step);
        const bc2 = 1 - Math.pow(beta2, step);
        // Adam update on W (with L2) and b.
        for (let k = 0; k < C * DIM; k++) {
          let g = gW[k] / m + l2 * this.W[k];
          this.mW[k] = beta1 * this.mW[k] + (1 - beta1) * g;
          this.vW[k] = beta2 * this.vW[k] + (1 - beta2) * g * g;
          this.W[k] -= lr * (this.mW[k] / bc1) / (Math.sqrt(this.vW[k] / bc2) + eps);
        }
        for (let c = 0; c < C; c++) {
          const g = gB[c] / m;
          this.mB[c] = beta1 * this.mB[c] + (1 - beta1) * g;
          this.vB[c] = beta2 * this.vB[c] + (1 - beta2) * g * g;
          this.b[c] -= lr * (this.mB[c] / bc1) / (Math.sqrt(this.vB[c] / bc2) + eps);
        }
      }
    }
    return Date.now() - t0;
  }

  predict(x: Float32Array): string {
    const C = this.classes.length;
    const z = new Float32Array(C);
    this.logits(x, z);
    let best = 0;
    for (let c = 1; c < C; c++) if (z[c] > z[best]) best = c;
    return this.classes[best];
  }

  /** Argmax label + its softmax probability (confidence). */
  predictProba(x: Float32Array): { label: string; conf: number } {
    const C = this.classes.length;
    const z = new Float32Array(C);
    this.logits(x, z);
    this.softmax(z);
    let best = 0;
    for (let c = 1; c < C; c++) if (z[c] > z[best]) best = c;
    return { label: this.classes[best], conf: z[best] };
  }
}

// ── metrics ──────────────────────────────────────────────────────────────────
interface EvalResult {
  n: number;
  accuracy: number;
  macroF1: number;
  majorityBaseline: number;
  unseenClassRate: number; // test labels never seen in train
  perClass: { label: string; support: number; precision: number; recall: number; f1: number }[];
}

function evaluate(preds: string[], truth: string[], trainClasses: Set<string>): EvalResult {
  const n = truth.length;
  let correct = 0;
  const labels = new Set<string>([...preds, ...truth]);
  const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>(), sup = new Map<string, number>();
  for (const l of labels) { tp.set(l, 0); fp.set(l, 0); fn.set(l, 0); sup.set(l, 0); }
  const counts = new Map<string, number>();
  let unseen = 0;
  for (let i = 0; i < n; i++) {
    const p = preds[i], t = truth[i];
    sup.set(t, sup.get(t)! + 1);
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (!trainClasses.has(t)) unseen++;
    if (p === t) { correct++; tp.set(t, tp.get(t)! + 1); }
    else { fp.set(p, fp.get(p)! + 1); fn.set(t, fn.get(t)! + 1); }
  }
  let majMax = 0;
  for (const v of counts.values()) if (v > majMax) majMax = v;
  const perClass = [...labels].map(l => {
    const t = tp.get(l)!, f = fp.get(l)!, m = fn.get(l)!;
    const precision = t + f > 0 ? t / (t + f) : 0;
    const recall = t + m > 0 ? t / (t + m) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    return { label: l, support: sup.get(l)!, precision, recall, f1 };
  }).filter(c => c.support > 0).sort((a, b) => b.support - a.support);
  const macroF1 = perClass.length ? perClass.reduce((s, c) => s + c.f1, 0) / perClass.length : 0;
  return { n, accuracy: correct / n, macroF1, majorityBaseline: majMax / n, unseenClassRate: unseen / n, perClass };
}

// ═══════════════════════════════════════════════════════════════════════════
//  stats
// ═══════════════════════════════════════════════════════════════════════════
async function runStats(pool: pg.Pool): Promise<void> {
  const fam = await pool.query(
    `SELECT CASE
              WHEN match_source LIKE 'text-deterministic-%' THEN 'rules:text-det'
              WHEN match_source LIKE 'kalshi:parlay%'        THEN 'rules:kalshi-parlay'
              WHEN match_source LIKE 'kalshi:%'              THEN 'rules:kalshi'
              WHEN match_source LIKE 'llm-%'                 THEN 'llm'
              WHEN match_source IS NULL                      THEN '(null)'
              ELSE 'other' END AS family,
            count(*) AS n,
            count(*) FILTER (WHERE m.embedding IS NOT NULL) AS embedded
       FROM llm_market_normalizations n
       JOIN markets m ON m.id = n.market_id
      GROUP BY 1 ORDER BY 2 DESC`);
  console.log('label-source families (with embedding coverage):');
  for (const r of fam.rows) console.log(`  ${String(r.family).padEnd(22)} n=${String(r.n).padStart(8)}  embedded=${r.embedded}`);

  for (const target of ['condition_shape', 'event_kind']) {
    console.log(`\n${target} distribution (rules vs llm, embedded only):`);
    const d = await pool.query(
      `SELECT n.${target} AS y,
              count(*) FILTER (WHERE ${RULES_SRC}) AS rules,
              count(*) FILTER (WHERE ${LLM_SRC})   AS llm
         FROM llm_market_normalizations n
         JOIN markets m ON m.id = n.market_id
        WHERE m.embedding IS NOT NULL AND n.${target} IS NOT NULL AND ${ANY_SRC}
        GROUP BY 1 ORDER BY (count(*)) DESC`);
    for (const r of d.rows) console.log(`  ${String(r.y).padEnd(24)} rules=${String(r.rules).padStart(7)}  llm=${r.llm}`);
  }

  const unl = await pool.query(
    `SELECT count(*) AS n FROM markets m
      WHERE m.embedding IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n WHERE n.market_id = m.id)`);
  console.log(`\nembedded markets with NO normalization (coverage prize for a learned model): ${unl.rows[0].n}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  kNN-from-rules (param-free) via pgvector HNSW
// ═══════════════════════════════════════════════════════════════════════════
async function knnCrossPlatform(
  pool: pg.Pool, target: string, testCap: number, k: number,
): Promise<{ n: number; accuracy: number; majorityBaseline: number }> {
  const client = await pool.connect();
  await client.query(`SET enable_seqscan = off`);
  await client.query(`SET hnsw.ef_search = 100`);
  // Test = Kalshi rules-labeled sample; neighbours = NON-Kalshi rules-labeled.
  const test = await pool.query<{ id: number; emb: string; y: string }>(
    `SELECT m.id, m.embedding::text AS emb, n.${target} AS y
       FROM markets m JOIN llm_market_normalizations n ON n.market_id = m.id
      WHERE m.embedding IS NOT NULL AND n.${target} IS NOT NULL AND ${RULES_SRC}
        AND m.platform = 'kalshi'
      ORDER BY md5(m.id::text) LIMIT $1`,
    [testCap]);
  let correct = 0;
  const counts = new Map<string, number>();
  for (const t of test.rows) {
    counts.set(t.y, (counts.get(t.y) ?? 0) + 1);
    const nb = await client.query<{ y: string }>(
      `SELECT n.${target} AS y
         FROM markets m JOIN llm_market_normalizations n ON n.market_id = m.id
        WHERE m.embedding IS NOT NULL AND n.${target} IS NOT NULL AND ${RULES_SRC}
          AND m.platform <> 'kalshi'
        ORDER BY m.embedding <=> $1::vector
        LIMIT $2`,
      [t.emb, k]);
    const vote = new Map<string, number>();
    for (const r of nb.rows) vote.set(r.y, (vote.get(r.y) ?? 0) + 1);
    let best = '', bestN = -1;
    for (const [lab, c] of vote) if (c > bestN) { bestN = c; best = lab; }
    if (best === t.y) correct++;
  }
  client.release();
  let majMax = 0; for (const v of counts.values()) if (v > majMax) majMax = v;
  const n = test.rows.length;
  return { n, accuracy: n ? correct / n : 0, majorityBaseline: n ? majMax / n : 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
//  run
// ═══════════════════════════════════════════════════════════════════════════
function fmtEval(title: string, r: EvalResult, extra = ''): string[] {
  const L: string[] = [];
  L.push(`### ${title}`);
  L.push('');
  L.push(`- n=${r.n}, accuracy=**${(100 * r.accuracy).toFixed(1)}%**, macro-F1=${r.macroF1.toFixed(3)}, ` +
         `majority-baseline=${(100 * r.majorityBaseline).toFixed(1)}%, unseen-class=${(100 * r.unseenClassRate).toFixed(1)}%${extra}`);
  L.push('');
  L.push(`| class | support | precision | recall | f1 |`);
  L.push(`|---|---|---|---|---|`);
  for (const c of r.perClass.slice(0, 12)) {
    L.push(`| ${c.label} | ${c.support} | ${(100 * c.precision).toFixed(0)}% | ${(100 * c.recall).toFixed(0)}% | ${c.f1.toFixed(2)} |`);
  }
  L.push('');
  return L;
}

async function run(pool: pg.Pool, target: string): Promise<void> {
  if (!ALLOWED_TARGETS.has(target)) throw new Error(`--target must be one of ${[...ALLOWED_TARGETS].join(', ')}`);
  const trainCap = argn('train-cap', 40000);
  const testCap = argn('test-cap', 10000);
  const covCap = argn('cov-cap', 5000);
  const knnCap = argn('knn-cap', 1500);
  const k = argn('k', 15);

  // NOTE: the Stage-1 LLM normalization path is currently stripped (0 'llm-*'
  // rows), so the originally-planned rules→LLM-tail cut is not measurable. We
  // test generalization two ways available now: (1) in-distribution ceiling,
  // (2) cross-platform holdout (train non-Kalshi rule-outputs → test Kalshi).
  // Plus a coverage probe on the unlabeled tail the regexes dropped.
  console.log(`Loading data for target=${target} …`);
  const nonKalshi = await load(pool, target, `${RULES_SRC} AND m.platform <> 'kalshi'`, trainCap);
  const kalshi = await load(pool, target, `${RULES_SRC} AND m.platform = 'kalshi'`, testCap);
  console.log(`  non-kalshi rules: ${nonKalshi.length}   kalshi rules: ${kalshi.length}`);

  // ── Eval 1: in-distribution (random 80/20 over all rules-labeled) ──
  const all = [...nonKalshi, ...kalshi];
  // Interleave the two platform pools so the 80/20 slice isn't platform-segregated.
  all.sort((a, b) => (a.y < b.y ? -1 : a.y > b.y ? 1 : 0)); // group then we stride
  const idTrain: Row[] = [], idTest: Row[] = [];
  all.forEach((r, i) => (i % 5 === 0 ? idTest : idTrain).push(r));
  const idClasses = [...new Set(idTrain.map(r => r.y))];
  const idModel = new LogReg(idClasses);
  const idMs = idModel.train(idTrain);
  const idEval = evaluate(idTest.map(r => idModel.predict(r.x)), idTest.map(r => r.y), new Set(idClasses));
  console.log(`[in-dist] train=${idTrain.length} (${idMs}ms, ${idClasses.length} classes) test=${idTest.length} acc=${(100 * idEval.accuracy).toFixed(1)}%`);

  // ── Eval 2: cross-platform generalization (headline) ──
  const xClasses = [...new Set(nonKalshi.map(r => r.y))];
  const xModel = new LogReg(xClasses);
  const xMs = xModel.train(nonKalshi);
  const xEval = evaluate(kalshi.map(r => xModel.predict(r.x)), kalshi.map(r => r.y), new Set(xClasses));
  console.log(`[xplat] train(non-kalshi)=${nonKalshi.length} (${xMs}ms) test(kalshi)=${kalshi.length} acc=${(100 * xEval.accuracy).toFixed(1)}% (majority ${(100 * xEval.majorityBaseline).toFixed(1)}%)`);

  // ── Eval 3: kNN cross-platform (param-free) ──
  console.log(`[knn] ${knnCap} kalshi rows, k=${k} over non-kalshi neighbours …`);
  const knn = await knnCrossPlatform(pool, target, knnCap, k);
  console.log(`[knn] n=${knn.n} acc=${(100 * knn.accuracy).toFixed(1)}% (majority ${(100 * knn.majorityBaseline).toFixed(1)}%)`);

  // ── Eval 4: coverage on the unlabeled tail (no ground truth — confidence only) ──
  const unl = await pool.query<{ emb: string }>(
    `SELECT m.embedding::text AS emb FROM markets m
      WHERE m.embedding IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n WHERE n.market_id = m.id)
      ORDER BY md5(m.id::text) LIMIT $1`, [covCap]);
  const confs = unl.rows.map(r => idModel.predictProba(parseEmb(r.emb)).conf);
  const cov = (thr: number) => confs.filter(c => c >= thr).length / (confs.length || 1);
  console.log(`[coverage] ${confs.length} unlabeled sampled — conf≥0.9: ${(100 * cov(0.9)).toFixed(1)}%  ≥0.7: ${(100 * cov(0.7)).toFixed(1)}%`);

  // ── report ──
  const ts = new Date().toISOString();
  const L: string[] = [];
  L.push(`# Parsing-generalization run — target=${target}`);
  L.push('');
  L.push(`- timestamp: \`${ts}\``);
  L.push(`- non-kalshi rules: ${nonKalshi.length} | kalshi rules: ${kalshi.length} | unlabeled sampled: ${confs.length}`);
  L.push(`- logreg train wall-clock: in-dist ${idMs}ms, cross-platform ${xMs}ms (CPU, no GPU)`);
  L.push(`- ⚠️ Stage-1 LLM path is stripped (0 \`llm-*\` rows) — "rules→LLM-tail" cut not measurable; using cross-platform holdout + coverage instead.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(`| eval | model | n | accuracy | majority | macro-F1 |`);
  L.push(`|---|---|---|---|---|---|`);
  L.push(`| in-distribution | logreg | ${idEval.n} | ${(100 * idEval.accuracy).toFixed(1)}% | ${(100 * idEval.majorityBaseline).toFixed(1)}% | ${idEval.macroF1.toFixed(3)} |`);
  L.push(`| **cross-platform** | logreg | ${xEval.n} | **${(100 * xEval.accuracy).toFixed(1)}%** | ${(100 * xEval.majorityBaseline).toFixed(1)}% | ${xEval.macroF1.toFixed(3)} |`);
  L.push(`| cross-platform | knn(k=${k}) | ${knn.n} | ${(100 * knn.accuracy).toFixed(1)}% | ${(100 * knn.majorityBaseline).toFixed(1)}% | — |`);
  L.push('');
  L.push('## Coverage on the unlabeled tail (regex-dropped markets)');
  L.push('');
  L.push('No ground truth here — this is the in-dist model\'s confidence on markets the regexes left unnormalized. Higher = more of the tail a learned head could confidently auto-label (spot-check before trusting).');
  L.push('');
  L.push(`| max-softmax conf ≥ | share of unlabeled tail |`);
  L.push(`|---|---|`);
  for (const thr of [0.5, 0.7, 0.9, 0.95]) L.push(`| ${thr} | ${(100 * cov(thr)).toFixed(1)}% |`);
  L.push('');
  L.push(...fmtEval('In-distribution (rules-labeled, 80/20 logreg)', idEval));
  L.push(...fmtEval('Cross-platform generalization (train non-Kalshi → test Kalshi, logreg) — HEADLINE', xEval,
    `. unseen-class = Kalshi slots that never appear in non-Kalshi rule-outputs.`));

  const md = L.join('\n');
  console.log('\n' + md);
  const stamp = ts.replace(/[:.]/g, '-');
  const base = join(HERE, `results-${target}-${stamp}`);
  writeFileSync(base + '.md', md);
  writeFileSync(base + '.json', JSON.stringify({
    timestamp: ts, target, trainCap, testCap,
    nonKalshiLoaded: nonKalshi.length, kalshiLoaded: kalshi.length,
    logregTrainMs: { inDist: idMs, crossPlatform: xMs },
    inDistribution: idEval, crossPlatform: xEval, knn,
    coverageUnlabeled: { n: confs.length, ge50: cov(0.5), ge70: cov(0.7), ge90: cov(0.9), ge95: cov(0.95) },
  }, null, 2));
  console.log(`\nwrote ${base}.md and .json`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  unnormalized — diagnose the markets the rules dropped (no normalization row)
// ═══════════════════════════════════════════════════════════════════════════
async function runUnnormalized(pool: pg.Pool): Promise<void> {
  const NO_NORM = `NOT EXISTS (SELECT 1 FROM llm_market_normalizations n WHERE n.market_id = m.id)`;

  const plat = await pool.query(
    `SELECT m.platform, count(*) AS n FROM markets m
      WHERE m.embedding IS NOT NULL AND ${NO_NORM} GROUP BY 1 ORDER BY 2 DESC`);
  console.log('unnormalized embedded markets by platform:');
  for (const r of plat.rows) console.log(`  ${String(r.platform).padEnd(12)} ${r.n}`);

  // Kalshi: cluster by series ticker prefix (KXNBA, KXBTC, …) — highly semantic.
  const kalshi = await pool.query(
    `SELECT split_part(m.platform_id, '-', 1) AS series, count(*) AS n,
            (array_agg(m.title ORDER BY md5(m.title)))[1:8] AS samples
       FROM markets m
      WHERE m.platform = 'kalshi' AND m.embedding IS NOT NULL AND ${NO_NORM}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 60`);
  console.log(`\nKalshi unnormalized by series prefix (top ${kalshi.rows.length}):`);
  for (const r of kalshi.rows.slice(0, 25)) console.log(`  ${String(r.series).padEnd(20)} ${String(r.n).padStart(6)}  e.g. ${r.samples[0]}`);

  // Non-Kalshi: cluster by (platform, category_unified).
  const other = await pool.query(
    `SELECT m.platform, m.category_unified AS category, count(*) AS n,
            (array_agg(m.title ORDER BY md5(m.title)))[1:8] AS samples
       FROM markets m
      WHERE m.platform <> 'kalshi' AND m.embedding IS NOT NULL AND ${NO_NORM}
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`);

  const outPath = join(HERE, 'unnormalized-report.json');
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    platform_breakdown: plat.rows,
    kalshi_series_clusters: kalshi.rows,
    nonkalshi_category_clusters: other.rows,
  }, null, 2));
  console.log(`\nwrote ${outPath} (full clusters + sample titles for analysis)`);
}

async function main() {
  const mode = process.argv[2] ?? 'stats';
  const pool = makePool();
  try {
    if (mode === 'stats') await runStats(pool);
    else if (mode === 'run') await run(pool, arg('target', 'condition_shape'));
    else if (mode === 'unnormalized') await runUnnormalized(pool);
    else { console.error(`unknown mode: ${mode} (use: stats | run | unnormalized)`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
