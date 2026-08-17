/**
 * Model / vectorizer comparison (READ-ONLY on prod; reads exp.* tables).
 *
 * Compares three featurizations for the categorical-slot classifier, on the
 * EXPANDED label set (prod labels + exp.labels_new rule-derived labels):
 *   - td     : dense embedding of title + desc[:500]   (exp.dataset.embedding)
 *   - title  : dense embedding of TITLE ONLY            (exp.title_embeddings)
 *   - tfidf  : TF-IDF over title tokens                 (computed in JS)
 *
 * Evaluations per featurization: in-distribution (random 80/20) and
 * cross-platform (train non-Kalshi → test Kalshi). Answers: (a) does dropping
 * the description help? (b) would a free lexical TF-IDF rival the dense embedding?
 *
 * Usage:
 *   npx tsx data/parsing-generalization/model.ts --target event_kind
 *   npx tsx data/parsing-generalization/model.ts --target condition_shape
 */
import pg from 'pg';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KS = [1, 5];
function makePool() {
  return new pg.Pool({
    host: process.env.PG_HOST || 'localhost', port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'prediction_arb', user: process.env.PG_USER || 'arb',
    password: process.env.PG_PASSWORD || 'arb_local_dev', max: 4,
  });
}
function arg(n: string, d: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function argn(n: string, d: number) { return parseInt(arg(n, String(d)), 10); }

function foldAscii(s: string): string { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function parseEmb(t: string): Float32Array { const inner = t.slice(1, -1).split(','); const o = new Float32Array(inner.length); for (let i = 0; i < inner.length; i++) o[i] = parseFloat(inner[i]); return o; }

// ── logistic regression (Adam), dimension-parametric ────────────────────────
class LogReg {
  classes: string[]; idx: Map<string, number>; dim: number;
  W: Float32Array; b: Float32Array; mW: Float32Array; vW: Float32Array; mB: Float32Array; vB: Float32Array;
  constructor(classes: string[], dim: number) {
    this.classes = classes; this.dim = dim; this.idx = new Map(classes.map((c, i) => [c, i]));
    const C = classes.length;
    this.W = new Float32Array(C * dim); this.b = new Float32Array(C);
    this.mW = new Float32Array(C * dim); this.vW = new Float32Array(C * dim); this.mB = new Float32Array(C); this.vB = new Float32Array(C);
  }
  private logits(x: Float32Array, z: Float32Array) { const C = this.classes.length, D = this.dim; for (let c = 0; c < C; c++) { let s = this.b[c]; const base = c * D; for (let d = 0; d < D; d++) s += this.W[base + d] * x[d]; z[c] = s; } }
  private softmax(z: Float32Array) { let mx = -Infinity; for (const v of z) if (v > mx) mx = v; let sum = 0; for (let i = 0; i < z.length; i++) { z[i] = Math.exp(z[i] - mx); sum += z[i]; } for (let i = 0; i < z.length; i++) z[i] /= sum; }
  train(X: Float32Array[], Y: string[], epochs = 12, batch = 512, lr = 0.05, l2 = 1e-4): number {
    const t0 = Date.now(); const C = this.classes.length, D = this.dim, n = X.length;
    const order = [...Array(n).keys()]; const z = new Float32Array(C); const gW = new Float32Array(C * D); const gB = new Float32Array(C);
    let step = 0; const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    for (let ep = 0; ep < epochs; ep++) {
      let seed = 12345 + ep; for (let i = n - 1; i > 0; i--) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      for (let s0 = 0; s0 < n; s0 += batch) {
        gW.fill(0); gB.fill(0); const s1 = Math.min(s0 + batch, n); const m = s1 - s0;
        for (let bi = s0; bi < s1; bi++) { const xi = X[order[bi]]; const yi = this.idx.get(Y[order[bi]])!; this.logits(xi, z); this.softmax(z);
          for (let c = 0; c < C; c++) { const g = z[c] - (c === yi ? 1 : 0); gB[c] += g; const base = c * D; for (let d = 0; d < D; d++) gW[base + d] += g * xi[d]; } }
        step++; const bc1 = 1 - Math.pow(b1, step), bc2 = 1 - Math.pow(b2, step);
        for (let k = 0; k < C * D; k++) { const g = gW[k] / m + l2 * this.W[k]; this.mW[k] = b1 * this.mW[k] + (1 - b1) * g; this.vW[k] = b2 * this.vW[k] + (1 - b2) * g * g; this.W[k] -= lr * (this.mW[k] / bc1) / (Math.sqrt(this.vW[k] / bc2) + eps); }
        for (let c = 0; c < C; c++) { const g = gB[c] / m; this.mB[c] = b1 * this.mB[c] + (1 - b1) * g; this.vB[c] = b2 * this.vB[c] + (1 - b2) * g * g; this.b[c] -= lr * (this.mB[c] / bc1) / (Math.sqrt(this.vB[c] / bc2) + eps); } }
    }
    return Date.now() - t0;
  }
  predict(x: Float32Array): string { const C = this.classes.length; const z = new Float32Array(C); this.logits(x, z); let best = 0; for (let c = 1; c < C; c++) if (z[c] > z[best]) best = c; return this.classes[best]; }
}

function evalAcc(model: LogReg, X: Float32Array[], Y: string[]): { acc: number; macroF1: number; majority: number } {
  const n = Y.length; let correct = 0; const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>(), sup = new Map<string, number>(); const cnt = new Map<string, number>();
  for (let i = 0; i < n; i++) { const p = model.predict(X[i]), t = Y[i]; cnt.set(t, (cnt.get(t) ?? 0) + 1); sup.set(t, (sup.get(t) ?? 0) + 1); if (p === t) { correct++; tp.set(t, (tp.get(t) ?? 0) + 1); } else { fp.set(p, (fp.get(p) ?? 0) + 1); fn.set(t, (fn.get(t) ?? 0) + 1); } }
  let maj = 0; for (const v of cnt.values()) if (v > maj) maj = v;
  let f1sum = 0, nc = 0; for (const c of sup.keys()) { const t = tp.get(c) ?? 0, f = fp.get(c) ?? 0, m = fn.get(c) ?? 0; const pr = t + f ? t / (t + f) : 0, rc = t + m ? t / (t + m) : 0; f1sum += pr + rc ? 2 * pr * rc / (pr + rc) : 0; nc++; }
  return { acc: correct / n, macroF1: nc ? f1sum / nc : 0, majority: maj / n };
}

// ── TF-IDF vectorizer (fit on train, transform any) ──────────────────────────
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'be', 'is', 'are', 'at', 'by', 'with', 'this', 'that', 'it', 'as']);
function tokenize(title: string): string[] {
  const toks = foldAscii(title.toLowerCase()).split(/[^a-z0-9$%]+/).filter(t => t.length >= 2 && !STOP.has(t));
  if (/\$/.test(title)) toks.push('__dollar__');
  if (/%/.test(title)) toks.push('__pct__');
  return toks;
}
class Tfidf {
  vocab = new Map<string, number>(); idf: Float32Array = new Float32Array(0); dim = 0;
  fit(titles: string[], maxVocab = 2000) {
    const df = new Map<string, number>(); const N = titles.length;
    for (const t of titles) { for (const tok of new Set(tokenize(t))) df.set(tok, (df.get(tok) ?? 0) + 1); }
    const kept = [...df.entries()].filter(([, d]) => d >= 3 && d <= 0.6 * N).sort((a, b) => b[1] - a[1]).slice(0, maxVocab);
    this.dim = kept.length; this.idf = new Float32Array(this.dim);
    kept.forEach(([tok, d], i) => { this.vocab.set(tok, i); this.idf[i] = Math.log(N / d); });
  }
  transform(title: string): Float32Array {
    const v = new Float32Array(this.dim); const tf = new Map<number, number>();
    for (const tok of tokenize(title)) { const i = this.vocab.get(tok); if (i !== undefined) tf.set(i, (tf.get(i) ?? 0) + 1); }
    let norm = 0; for (const [i, c] of tf) { const w = (1 + Math.log(c)) * this.idf[i]; v[i] = w; norm += w * w; }
    norm = Math.sqrt(norm) || 1; for (let i = 0; i < this.dim; i++) v[i] /= norm; return v;
  }
}

// ── data loading ─────────────────────────────────────────────────────────────
const targCols = (target: string) => ({ prod: `prod_${target}`, nu: target });
async function loadDense(pool: pg.Pool, table: 'dataset' | 'title', target: string, where: string, cap: number) {
  const { prod, nu } = targCols(target);
  const embExpr = table === 'dataset' ? 'd.embedding::text' : 'te.embedding::text';
  const join = table === 'dataset' ? '' : 'JOIN exp.title_embeddings te ON te.market_id = d.market_id';
  const r = await pool.query<{ y: string; platform: string; emb: string }>(
    `SELECT COALESCE(d.${prod}, l.${nu}) AS y, d.platform, ${embExpr} AS emb
       FROM exp.dataset d LEFT JOIN exp.labels_new l ON l.market_id = d.market_id ${join}
      WHERE COALESCE(d.${prod}, l.${nu}) IS NOT NULL AND ${where}
      ORDER BY md5(d.market_id::text) LIMIT $1`, [cap]);
  return r.rows.map(x => ({ y: x.y, platform: x.platform, x: parseEmb(x.emb) }));
}
async function loadText(pool: pg.Pool, target: string, where: string, cap: number) {
  const { prod, nu } = targCols(target);
  const r = await pool.query<{ y: string; platform: string; title: string }>(
    `SELECT COALESCE(d.${prod}, l.${nu}) AS y, d.platform, d.title
       FROM exp.dataset d LEFT JOIN exp.labels_new l ON l.market_id = d.market_id
      WHERE COALESCE(d.${prod}, l.${nu}) IS NOT NULL AND ${where}
      ORDER BY md5(d.market_id::text) LIMIT $1`, [cap]);
  return r.rows.map(x => ({ y: x.y, platform: x.platform, title: x.title ?? '' }));
}

// ── run one featurization through in-dist + cross-platform ───────────────────
interface Cell { acc: number; macroF1: number; majority: number; trainMs: number; n: number }
function splitInDist<T>(rows: T[]): { tr: T[]; te: T[] } { const tr: T[] = [], te: T[] = []; rows.forEach((r, i) => (i % 5 === 0 ? te : tr).push(r)); return { tr, te }; }

async function main() {
  const target = arg('target', 'event_kind');
  const trainCap = argn('train-cap', 45000);
  const testCap = argn('test-cap', 12000);
  const pool = makePool();
  const results: Record<string, { inDist: Cell; xPlat: Cell }> = {};
  try {
    // ---- dense feature sets ----
    for (const fs of ['td', 'title'] as const) {
      const table = fs === 'td' ? 'dataset' : 'title';
      // in-dist
      const all = await loadDense(pool, table, target, 'TRUE', trainCap + testCap);
      const { tr, te } = splitInDist(all);
      const cls = [...new Set(tr.map(r => r.y))];
      let m = new LogReg(cls, 1536); const ms = m.train(tr.map(r => r.x), tr.map(r => r.y));
      const id = evalAcc(m, te.map(r => r.x), te.map(r => r.y));
      // cross-platform
      const nk = await loadDense(pool, table, target, `d.platform <> 'kalshi'`, trainCap);
      const ka = await loadDense(pool, table, target, `d.platform = 'kalshi'`, testCap);
      const cls2 = [...new Set(nk.map(r => r.y))];
      const m2 = new LogReg(cls2, 1536); const ms2 = m2.train(nk.map(r => r.x), nk.map(r => r.y));
      const xp = evalAcc(m2, ka.map(r => r.x), ka.map(r => r.y));
      results[fs] = {
        inDist: { ...id, trainMs: ms, n: te.length },
        xPlat: { ...xp, trainMs: ms2, n: ka.length },
      };
      console.log(`[${fs}] in-dist acc=${(100 * id.acc).toFixed(1)}% (${ms}ms)  xplat acc=${(100 * xp.acc).toFixed(1)}% (maj ${(100 * xp.majority).toFixed(1)}%)`);
    }
    // ---- tfidf ----
    {
      const all = await loadText(pool, target, 'TRUE', trainCap + testCap);
      const { tr, te } = splitInDist(all);
      const vec = new Tfidf(); vec.fit(tr.map(r => r.title));
      const cls = [...new Set(tr.map(r => r.y))];
      const m = new LogReg(cls, vec.dim); const ms = m.train(tr.map(r => vec.transform(r.title)), tr.map(r => r.y));
      const id = evalAcc(m, te.map(r => vec.transform(r.title)), te.map(r => r.y));
      const nk = await loadText(pool, target, `d.platform <> 'kalshi'`, trainCap);
      const ka = await loadText(pool, target, `d.platform = 'kalshi'`, testCap);
      const vec2 = new Tfidf(); vec2.fit(nk.map(r => r.title));
      const cls2 = [...new Set(nk.map(r => r.y))];
      const m2 = new LogReg(cls2, vec2.dim); const ms2 = m2.train(nk.map(r => vec2.transform(r.title)), nk.map(r => r.y));
      const xp = evalAcc(m2, ka.map(r => vec2.transform(r.title)), ka.map(r => r.y));
      results['tfidf'] = { inDist: { ...id, trainMs: ms, n: te.length }, xPlat: { ...xp, trainMs: ms2, n: ka.length } };
      console.log(`[tfidf dim=${vec.dim}] in-dist acc=${(100 * id.acc).toFixed(1)}% (${ms}ms)  xplat acc=${(100 * xp.acc).toFixed(1)}%`);
    }
  } finally { await pool.end(); }

  const ts = new Date().toISOString();
  const L: string[] = [];
  L.push(`# Model / vectorizer comparison — target=${target}`); L.push('');
  L.push(`- timestamp: \`${ts}\``);
  L.push(`- expanded labels (prod + exp.labels_new), train cap ${trainCap}, test cap ${testCap}, CPU-only`);
  L.push('');
  L.push(`| featurization | in-dist acc | in-dist macro-F1 | x-plat acc | x-plat maj | x-plat macro-F1 | train ms (in-dist) |`);
  L.push(`|---|---|---|---|---|---|---|`);
  const nm: Record<string, string> = { td: 'dense title+desc (current)', title: 'dense title-only', tfidf: 'TF-IDF title' };
  for (const fs of ['td', 'title', 'tfidf']) { const r = results[fs]; L.push(`| ${nm[fs]} | ${(100 * r.inDist.acc).toFixed(1)}% | ${r.inDist.macroF1.toFixed(3)} | ${(100 * r.xPlat.acc).toFixed(1)}% | ${(100 * r.xPlat.majority).toFixed(1)}% | ${r.xPlat.macroF1.toFixed(3)} | ${r.inDist.trainMs} |`); }
  L.push('');
  const md = L.join('\n');
  console.log('\n' + md);
  const base = join(HERE, `results-model-${target}-${ts.replace(/[:.]/g, '-')}`);
  writeFileSync(base + '.md', md); writeFileSync(base + '.json', JSON.stringify({ target, ts, results }, null, 2));
  console.log(`\nwrote ${base}.md`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
